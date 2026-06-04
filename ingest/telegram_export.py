"""telegram_export — парсер Telegram Desktop `result.json` → sanitized markdown.

Первый и главный источник (CONTEXT §6 OQ-1; [docs/research/data-ingestion.md]
(../docs/research/data-ingestion.md)): штатный JSON-экспорт Telegram Desktop —
самый богатый и единственный с официальным экспортом. Пишет одну markdown-страницу
на диалог в приватный `raw/` с provenance-frontmatter, прогоняя КАЖДОЕ тело
сообщения через fail-closed-sanitizer и двигая watermark только после успешной
записи.

Критичные уроки research (учтены ниже):
- Парсить `text_entities` (массив `{type,text}`), НЕ полиморфное поле `text`
  (оно бывает строкой ИЛИ массивом строк+entity-объектов → наивная обработка
  падает). См. data-ingestion §«Подводные камни».
- Watermark по `id` плюс `date_unixtime` (монотонный числовой курсор).
- Выделять service-сообщения (`type: "service"`, поле `action`) отдельно от
  обычных.
- Большой `result.json` может OOM'ить наивный `json.load`. v1 — честный
  `json.load` (просто и надёжно для типичных экспортов); для гигантских файлов
  оставлен хук `--ijson` (см. README) — это сознательный trade-off, не заглушка.
- raw/ — immutable снапшот; перезапись страницы — только при идемпотентном
  ре-ингесте того же экспорта, новые сообщения дописываются.

Зависимости: только stdlib. Совместимость: Python 3.9+.

CLI:
    python3 -m ingest.telegram_export /path/to/result.json
    python3 -m ingest.telegram_export result.json --raw-dir /path/to/llm-wiki-content/raw
Env (если флаги не заданы):
    LLM_WIKI_RAW_DIR   — каталог raw/ приватного репо (куда писать)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

# Импорт sanitizer'а как части пакета ingest. Sanitizer — ЕДИНСТВЕННЫЙ владелец
# маскирования; здесь его НЕ переопределяем (DRY: тот же модуль использует
# scheduler/lint_public.py). Поддерживаем оба способа запуска (как пакет и как
# одиночный файл).
try:
    from .sanitizer import fail_closed_sanitize, SanitizerError
except ImportError:  # запуск как одиночный скрипт: python3 ingest/telegram_export.py
    from sanitizer import fail_closed_sanitize, SanitizerError  # type: ignore
try:
    from .watermark import Watermark
except ImportError:
    from watermark import Watermark  # type: ignore


SOURCE_NAME = "telegram"


# ---------------------------------------------------------------------------
# Извлечение плоского текста из text_entities (обход полиморфного `text`).
# ---------------------------------------------------------------------------

def extract_text(message: Dict[str, Any]) -> str:
    """Собирает плоский текст сообщения из `text_entities`.

    `text_entities` — массив объектов `{type, text, ...}`; конкатенация их `text`
    даёт исходный плоский текст без разметки. Это надёжнее полиморфного `text`
    (строка ИЛИ массив строк+объектов). Фолбэк на `text`, если entities пусты.
    """
    entities = message.get("text_entities")
    if isinstance(entities, list) and entities:
        parts: List[str] = []
        for ent in entities:
            if isinstance(ent, dict):
                parts.append(str(ent.get("text", "")))
            elif isinstance(ent, str):  # на всякий случай
                parts.append(ent)
        return "".join(parts)

    # Фолбэк: полиморфное `text`.
    raw_text = message.get("text", "")
    if isinstance(raw_text, str):
        return raw_text
    if isinstance(raw_text, list):
        parts = []
        for chunk in raw_text:
            if isinstance(chunk, str):
                parts.append(chunk)
            elif isinstance(chunk, dict):
                parts.append(str(chunk.get("text", "")))
        return "".join(parts)
    return ""


def describe_media(message: Dict[str, Any]) -> Optional[str]:
    """Краткая пометка о вложении (без скачивания файла — read-only к источнику).

    Возвращает напр. "[media: photo]" / "[media: voice_message]" / "[file: <имя>]"
    или None, если медиа нет. Имена файлов тоже идут через sanitizer выше по стеку.
    """
    if message.get("photo"):
        return "[media: photo]"
    media_type = message.get("media_type")
    if media_type:
        return "[media: %s]" % media_type
    if message.get("file"):
        # Имя файла может содержать PII — отдадим как текст, его санитизирует writer.
        name = message.get("file_name") or os.path.basename(str(message.get("file")))
        return "[file: %s]" % name
    if message.get("poll"):
        return "[poll]"
    if message.get("location_information"):
        return "[location]"
    return None


# ---------------------------------------------------------------------------
# Нормализация одного сообщения в строку markdown.
# ---------------------------------------------------------------------------

@dataclass
class ParsedMessage:
    """Нормализованное сообщение, готовое к санитизации и записи."""
    id: int
    date_unixtime: int
    date_iso: str
    sender: str
    is_service: bool
    body: str            # ещё НЕ санитизирован — маскируется в writer


def _to_int(value: Any, default: int = 0) -> int:
    """Безопасное приведение к int (id/date_unixtime приходят строками/числами)."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _iso_from_unixtime(unixtime: int, fallback: str) -> str:
    """ISO 8601 (UTC) из unix-времени; при сбое — исходное поле `date`."""
    if unixtime > 0:
        return datetime.fromtimestamp(unixtime, tz=timezone.utc).isoformat(timespec="seconds")
    return fallback


def parse_message(message: Dict[str, Any]) -> Optional[ParsedMessage]:
    """Нормализует одно сообщение Telegram. None — если запись бесполезна
    (пустое не-сервисное сообщение без текста и медиа)."""
    msg_type = message.get("type", "message")
    is_service = msg_type == "service"

    mid = _to_int(message.get("id"))
    unixtime = _to_int(message.get("date_unixtime"))
    date_iso = _iso_from_unixtime(unixtime, str(message.get("date", "")))

    if is_service:
        # Service-сообщение: вместо текста — действие (вступил, закрепил и т.п.).
        actor = message.get("actor") or message.get("from") or "система"
        action = message.get("action", "service")
        body = "%s: %s" % (action, actor)
        return ParsedMessage(mid, unixtime, date_iso, str(actor), True, body)

    sender = str(message.get("from") or message.get("author") or "неизвестно")
    text = extract_text(message)
    media = describe_media(message)

    # Склеиваем текст и пометку о медиа.
    body_parts = [p for p in (text.strip(), media) if p]
    body = " ".join(body_parts).strip()

    # Метки ответа/пересылки (полезный контекст, но без рекурсивного раскрытия).
    if message.get("reply_to_message_id"):
        body = "(ответ на #%s) %s" % (_to_int(message["reply_to_message_id"]), body)
    if message.get("forwarded_from"):
        body = "(переслано от %s) %s" % (message["forwarded_from"], body)

    if not body:
        return None  # пустышка (напр. только стикер без media_type) — пропускаем

    return ParsedMessage(mid, unixtime, date_iso, sender, False, body)


# ---------------------------------------------------------------------------
# Загрузка result.json + итерация по чатам.
# ---------------------------------------------------------------------------

def iter_chats(export: Dict[str, Any]) -> Iterable[Dict[str, Any]]:
    """Отдаёт чат-объекты из обоих контейнеров: `chats.list` и `left_chats.list`.

    Структура: top-level `chats` → `{ "list": [ {id,name,type,messages}, ... ] }`.
    Если экспортирован один диалог («Saved Messages» / личный чат), верхний
    уровень сам может быть чат-объектом (есть `messages`) — обрабатываем и это.
    """
    if "messages" in export and "chats" not in export:
        # Экспорт одного диалога: верхний уровень — сам чат.
        yield export
        return
    for container_key in ("chats", "left_chats"):
        container = export.get(container_key)
        if isinstance(container, dict):
            for chat in container.get("list", []):
                if isinstance(chat, dict):
                    yield chat


def load_export(path: Path) -> Dict[str, Any]:
    """Читает result.json целиком (v1). Большие файлы — см. README (--ijson хук).

    json.load на типичном экспорте надёжен; для гигантских дампов потоковый
    разбор оставлен как документированное расширение, чтобы не усложнять v1.
    """
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


# ---------------------------------------------------------------------------
# Сборка markdown-страницы диалога (provenance frontmatter + сообщения).
# ---------------------------------------------------------------------------

def _slugify(name: str, chat_id: Any) -> str:
    """Безопасное имя файла из названия чата. Имя чата может быть PII (ФИО) →
    в slug оставляем только транслит-безопасные символы, но это всё ещё может
    раскрыть контакт. Поэтому в имя файла кладём СЛАБЫЙ slug + chat_id, а сам
    `chat` во frontmatter санитизируется как и всё остальное.

    Здесь slug чисто технический (латиница/цифры/дефис); кириллицу не транслитим,
    а заменяем на 'chat', чтобы файловая система и git были предсказуемы и чтобы
    имя файла само по себе не несло читаемого контакта.
    """
    ascii_part = re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-").lower()
    if not ascii_part:
        ascii_part = "chat"
    return "%s-%s" % (ascii_part[:40], chat_id)


def build_page(
    chat: Dict[str, Any],
    export_meta: Dict[str, Any],
    wm: Watermark,
) -> Tuple[Optional[str], int, Optional[int], Optional[int]]:
    """Собирает markdown-страницу одного диалога.

    Возвращает (markdown | None, n_written, max_id, max_unixtime). None — если
    в диалоге нет НОВЫХ сообщений (за watermark). КАЖДОЕ тело санитизируется
    через fail_closed_sanitize: если санитайзер не может гарантировать чистоту —
    исключение поднимается наверх и весь файл НЕ записывается (fail-closed).
    """
    chat_name = str(chat.get("name") or "Без названия")
    chat_id = chat.get("id", "unknown")
    chat_type = str(chat.get("type", "personal_chat"))
    messages = chat.get("messages", [])
    if not isinstance(messages, list):
        return None, 0, None, None

    rendered_lines: List[str] = []
    n_written = 0
    max_id: Optional[int] = None
    max_unixtime: Optional[int] = None
    min_date_iso: Optional[str] = None
    max_date_iso: Optional[str] = None

    for raw_msg in messages:
        if not isinstance(raw_msg, dict):
            continue
        parsed = parse_message(raw_msg)
        if parsed is None:
            continue

        # Дедуп/идемпотентность: пропускаем всё, что уже за watermark по id.
        if wm.is_seen_message(parsed.id):
            continue

        # ---- КРИТИЧНО: санитизация в write-path, fail-closed ----
        # Маскируем И тело, И имя отправителя (sender может быть ФИО/контакт).
        safe_body = fail_closed_sanitize(parsed.body)
        safe_sender = fail_closed_sanitize(parsed.sender)

        marker = "·service" if parsed.is_service else ""
        rendered_lines.append(
            "- **%s** _(%s%s, #%d)_: %s"
            % (safe_sender, parsed.date_iso, (" " + marker) if marker else "", parsed.id, safe_body)
        )

        n_written += 1
        max_id = parsed.id if max_id is None else max(max_id, parsed.id)
        if parsed.date_unixtime > 0:
            max_unixtime = (
                parsed.date_unixtime
                if max_unixtime is None
                else max(max_unixtime, parsed.date_unixtime)
            )
        if parsed.date_iso:
            min_date_iso = parsed.date_iso if min_date_iso is None else min(min_date_iso, parsed.date_iso)
            max_date_iso = parsed.date_iso if max_date_iso is None else max(max_date_iso, parsed.date_iso)

    if n_written == 0:
        return None, 0, None, None

    # Имя чата во frontmatter тоже санитизируем (может быть контакт-ФИО).
    safe_chat_name = fail_closed_sanitize(chat_name)

    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    frontmatter = [
        "---",
        "title: 'Переписка Telegram — %s'" % safe_chat_name.replace("'", "''"),
        "type: source",
        "status: immutable",
        "source: telegram",
        "chat: '%s'" % safe_chat_name.replace("'", "''"),
        "chat_id: %s" % chat_id,
        "chat_type: %s" % chat_type,
        "exported_from: '%s'" % str(export_meta.get("name", "")).replace("'", "''"),
        "date_range: '%s — %s'" % (min_date_iso or "?", max_date_iso or "?"),
        "messages_count: %d" % n_written,
        "ingested_at: %s" % now_iso,
        "last_updated: %s" % now_iso[:10],
        "---",
        "",
        "# Переписка Telegram — %s" % safe_chat_name,
        "",
        "> Immutable снапшот источника. Каждое тело прошло fail-closed-sanitizer.",
        "> Диапазон: %s — %s · сообщений: %d · chat_id: `%s`."
        % (min_date_iso or "?", max_date_iso or "?", n_written, chat_id),
        "",
        "## Сообщения",
        "",
    ]
    body = "\n".join(frontmatter) + "\n".join(rendered_lines) + "\n"
    return body, n_written, max_id, max_unixtime


# ---------------------------------------------------------------------------
# Запись страницы в raw/ (атомарно).
# ---------------------------------------------------------------------------

def write_page(raw_dir: Path, chat: Dict[str, Any], markdown: str) -> Path:
    """Пишет страницу диалога под raw/telegram/<slug>.md (атомарно).

    raw/ — immutable: при ре-ингесте того же экспорта файл идемпотентно
    перезаписывается тем же содержимым (watermark отсечёт уже виденные id, так
    что новый прогон того же файла даёт пустой результат и сюда не дойдёт).
    """
    out_dir = raw_dir / SOURCE_NAME
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = _slugify(str(chat.get("name") or "chat"), chat.get("id", "unknown"))
    out_path = out_dir / ("%s.md" % slug)

    # Атомарная запись через временный файл + replace.
    tmp_path = out_path.with_suffix(".md.tmp")
    tmp_path.write_text(markdown, encoding="utf-8")
    os.replace(tmp_path, out_path)
    return out_path


# ---------------------------------------------------------------------------
# Главный конвейер.
# ---------------------------------------------------------------------------

def ingest(result_json: Path, raw_dir: Path) -> int:
    """Полный ингест одного result.json в raw_dir. Возвращает число записанных
    сообщений суммарно. Watermark двигается ТОЛЬКО после успешной записи всех
    страниц прогона (advance-only-after-write)."""
    print("ingest telegram: %s -> %s" % (result_json, raw_dir))

    export = load_export(result_json)
    export_meta = {"name": export.get("name", "")}

    # Один watermark на весь источник telegram. Курсор — максимальный id/unixtime
    # по всем диалогам прогона.
    wm = Watermark.load(raw_dir, SOURCE_NAME)
    run_max_id = wm.cursor.get("last_message_id")
    run_max_unixtime = wm.cursor.get("last_date_unixtime")

    total_written = 0
    pages_written = 0

    for chat in iter_chats(export):
        try:
            markdown, n, max_id, max_unixtime = build_page(chat, export_meta, wm)
        except SanitizerError as exc:
            # Fail-closed: санитайзер не гарантировал чистоту → НЕ пишем этот файл,
            # курсор НЕ двигаем. Сообщаем и продолжаем со следующим диалогом.
            print(
                "  [SKIP] чат %r — sanitizer abort: %s (файл не записан)"
                % (chat.get("name"), exc),
                file=sys.stderr,
            )
            continue

        if not markdown:
            continue  # нет новых сообщений в этом диалоге

        out_path = write_page(raw_dir, chat, markdown)
        pages_written += 1
        total_written += n
        print("  [write] %s (%d сообщений)" % (out_path, n))

        # Копим максимум курсора по успешно записанным страницам.
        if max_id is not None:
            run_max_id = max_id if run_max_id is None else max(int(run_max_id), max_id)
        if max_unixtime is not None:
            run_max_unixtime = (
                max_unixtime
                if run_max_unixtime is None
                else max(int(run_max_unixtime), max_unixtime)
            )

    # Двигаем watermark ТОЛЬКО если что-то реально записали (advance-after-write).
    if pages_written > 0:
        wm.advance(last_message_id=run_max_id, last_date_unixtime=run_max_unixtime)
        wm.save()
        print(
            "watermark telegram -> last_message_id=%s last_date_unixtime=%s"
            % (run_max_id, run_max_unixtime)
        )
    else:
        print("новых сообщений нет — watermark не двигаем")

    print("итог: страниц %d, сообщений %d" % (pages_written, total_written))
    return total_written


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _resolve_raw_dir(arg_value: Optional[str]) -> Path:
    """Каталог raw/ из --raw-dir или env LLM_WIKI_RAW_DIR. Без него — ошибка
    (мы НЕ должны угадывать путь к приватному репо)."""
    raw = arg_value or os.environ.get("LLM_WIKI_RAW_DIR")
    if not raw:
        raise SystemExit(
            "не задан каталог raw/: укажите --raw-dir ИЛИ переменную окружения "
            "LLM_WIKI_RAW_DIR (путь к raw/ приватного репо llm-wiki-content)"
        )
    return Path(raw).expanduser()


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="ingest.telegram_export",
        description="Парсинг Telegram Desktop result.json → sanitized markdown в raw/.",
    )
    parser.add_argument("result_json", help="путь к экспортированному result.json")
    parser.add_argument(
        "--raw-dir",
        default=None,
        help="каталог raw/ приватного репо (или env LLM_WIKI_RAW_DIR)",
    )
    args = parser.parse_args(argv)

    result_path = Path(args.result_json).expanduser()
    if not result_path.exists():
        raise SystemExit("файл не найден: %s" % result_path)

    raw_dir = _resolve_raw_dir(args.raw_dir)
    ingest(result_path, raw_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
