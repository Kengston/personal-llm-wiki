"""llm_chat — парсер экспортов диалогов LLM (ChatGPT / Claude / Grok) → sanitized markdown.

Первый по приоритету источник наравне с Telegram (CONTEXT §6 OQ-1; [ADR-0010]
(../docs/adr/0010-wiki-content-model.md)): сердце вики — концепции, развитие и
идеи, а основной их носитель — это **переписки со всеми LLM**, которыми владелец
пользуется. Коннектор читает выгрузку диалогов, нормализует её в единый вид,
прогоняет КАЖДОЕ тело сообщения через fail-closed-sanitizer и пишет одну
markdown-страницу на разговор в приватный `raw/` с provenance-frontmatter, двигая
watermark только после успешной записи (как `telegram_export.py`).

Чем этот коннектор отличается от мессенджер-коннекторов (ADR-0010, «правило
сжатия»): диалоги с LLM — это не просто переписка, а сырьё для идей/концепций/
решений и для деривативного `capability-profile`. Поэтому, помимо санитизированной
расшифровки, коннектор делает выжимку:
- из любой сессии — извлекает кандидатов в **идеи / концепции / решения**
  (по эвристическим маркерам в тексте; точное разбиение на страницы делает уже
  компилятор вики, здесь мы только размечаем сырьё во frontmatter и в секции);
- из **код-тяжёлой** сессии — вместо verbatim-кода пишет «**accomplishment**»-сводку
  («построил X через Y, демонстрирует навык Z, ключевые решения/уроки»). Код в
  `wiki/` не нужен (ADR-0010): важно не *как* написан код, а *что* предметно
  сделано. Полная расшифровка остаётся в `raw/`, но code-блоки в ней схлопываются
  до пометки `[code: <язык>, <N> строк]`, чтобы и сырьё не несло простыни кода и
  потенциальных секретов.

================================================================================
ФОРМАТЫ ЭКСПОРТА (по одному парсеру на движок; все три — stdlib-only JSON)
================================================================================

1) ChatGPT (OpenAI) — `conversations.json`
   - Экспорт: ChatGPT → Settings → Data controls → Export data → письмо со ссылкой
     на ZIP → внутри `conversations.json` (плюс `chat.html`, `user.json` и пр.).
   - Структура: ВЕРХНИЙ УРОВЕНЬ — массив разговоров. Каждый разговор:
       {
         "title": "...",
         "create_time": 1700000000.0,        # unix-секунды (float)
         "update_time": 1700000100.0,
         "mapping": {                          # ДЕРЕВО узлов, НЕ плоский список!
           "<node-id>": {
             "id": "<node-id>",
             "parent": "<parent-id> | null",
             "children": ["<id>", ...],
             "message": {                      # бывает null (корневой/системный узел)
               "author": {"role": "user|assistant|system|tool"},
               "create_time": 1700000000.0,
               "content": {
                 "content_type": "text|code|multimodal_text|...",
                 "parts": ["строка", {...}, ...]   # для text — массив строк
               }
             }
           }, ...
         }
       }
   - ЛОВУШКИ:
     * `mapping` — это ДЕРЕВО (родитель/дети), а не список. Линейную ветку надо
       реконструировать: от корня (узел без parent) идти по `children`. Ветвления
       (regenerate/edit) дают несколько детей — берём основную ветку (последний
       ребёнок — самый свежий вариант; этого достаточно для выжимки).
     * `message` бывает `null` (системные/корневые узлы) — пропускать.
     * `content.parts` для текста — массив; нетекстовые части (dict: изображения,
       tool-call'ы) сворачиваем в пометку `[non-text part]`.
     * Роль `system`/`tool` — служебная; в расшифровку помечаем, в выжимку не берём.

2) Claude (Anthropic) — `conversations.json` (из официального Data Export)
   - Экспорт: Claude → Settings → Privacy / Account → Export data → ZIP с
     `conversations.json` (диалоги) и `projects.json` (проекты/артефакты).
   - Структура: ВЕРХНИЙ УРОВЕНЬ — массив разговоров. Каждый разговор:
       {
         "uuid": "...",
         "name": "...",                        # заголовок (бывает пустым)
         "created_at": "2026-05-31T12:00:00Z", # ISO-8601, НЕ unixtime
         "updated_at": "2026-05-31T12:30:00Z",
         "chat_messages": [                     # ПЛОСКИЙ список по порядку
           {
             "uuid": "...",
             "sender": "human|assistant",       # NB: "human", не "user"
             "created_at": "2026-05-31T12:00:00Z",
             "text": "...",                     # уже собранный текст (бывает "")
             "content": [                        # современный формат — массив блоков
               {"type": "text", "text": "..."},
               {"type": "tool_use", ...}, ...
             ]
           }, ...
         ]
       }
   - ЛОВУШКИ:
     * Время — ISO-строки (`created_at`), а не unixtime; парсим через
       `datetime.fromisoformat` (с заменой висячего 'Z' на '+00:00').
     * Текст брать из массива `content` (блоки `{type:"text"}`); если его нет —
       фолбэк на плоское `text`. Нетекстовые блоки (`tool_use`/`tool_result`/
       изображения) → пометка `[non-text block]`.
     * Роль зовётся `human` (а не `user`) — нормализуем к "user".

3) Grok (xAI) — `conversations.json` (export из аккаунта; форма устаканивается)
   - Экспорт: Grok / X-аккаунт → настройки данных → выгрузка диалогов Grok.
     Формат на 2026 ещё подвижен, поэтому парсер написан ТЕРПИМО к форме.
   - Ожидаемая структура (приближение): ВЕРХНИЙ УРОВЕНЬ — массив (или объект с
     ключом `conversations`) разговоров. Каждый разговор:
       {
         "conversation_id": "...",
         "title": "...",
         "create_time": 1700000000,            # бывает unix-секунды ИЛИ ISO-строка
         "messages": [                          # ПЛОСКИЙ список
           {
             "message_id": "...",
             "sender": "user|grok|assistant|agent",  # вариативно
             "create_time": 1700000000,
             "message": "..." | {"text": "..."} ,    # строка ИЛИ объект с text
           }, ...
         ]
       }
   - ЛОВУШКИ:
     * Имена ключей вариативны (`messages`/`responses`, `message`/`text`/`body`,
       `sender`/`role`/`author`). Парсер берёт первый существующий из синонимов.
     * `create_time` бывает и unixtime, и ISO — нормализуем обе формы.
     * Роль «grok»/«agent» нормализуем к "assistant".
   - Связь с движками (ADR-0008/0009): Grok как движок в этой системе — ОТЛОЖЕННЫЙ
     адаптер; но его ЧАТЫ всё равно ингестим уже в v1 (контент-модель не зависит
     от выбора движка — ADR-0010 «чаты со ВСЕМИ LLM»). Парсер здесь — про экспорт
     данных, а не про вызов модели.

================================================================================

Инварианты (как у всех коннекторов ingest):
- Read-only к источнику; `raw/` — immutable снапшот.
- Sanitizer — в write-path, fail-closed: КАЖДОЕ тело и каждое имя автора проходят
  `fail_closed_sanitize` ДО записи; abort → файл не пишется, watermark не двигается.
- Watermark двигается только после успешной записи (advance-only-after-write);
  дедуп по стабильному id разговора → повторный ингест того же экспорта идемпотентен.

Зависимости: только stdlib. Совместимость: Python 3.9+.

CLI:
    python3 -m ingest.llm_chat /path/to/conversations.json --engine chatgpt
    python3 -m ingest.llm_chat claude_export.json --engine claude --raw-dir ~/llm-wiki-content/raw
    python3 -m ingest.llm_chat grok_export.json --engine grok
Авто-определение движка, если --engine не задан (по характерным ключам формата):
    python3 -m ingest.llm_chat /path/to/conversations.json
Env (если --raw-dir не задан):
    LLM_WIKI_RAW_DIR   — каталог raw/ приватного репо (куда писать)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

# Sanitizer и watermark — части пакета ingest. Sanitizer — ЕДИНСТВЕННЫЙ владелец
# маскирования (DRY: тот же модуль у scheduler/lint_public.py); здесь не дублируем.
# Поддерживаем оба способа запуска (как пакет и как одиночный файл) — как в
# telegram_export.py.
try:
    from .sanitizer import fail_closed_sanitize, SanitizerError
except ImportError:  # запуск одиночным скриптом: python3 ingest/llm_chat.py
    from sanitizer import fail_closed_sanitize, SanitizerError  # type: ignore
try:
    from .watermark import Watermark
except ImportError:
    from watermark import Watermark  # type: ignore


SOURCE_NAME = "llm_chat"

# Движки, чьи экспорты мы умеем парсить. Значение — человекочитаемое имя для
# frontmatter/заголовка. Ключ — то, что приходит в --engine и в slug файла.
KNOWN_ENGINES = {
    "chatgpt": "ChatGPT (OpenAI)",
    "claude": "Claude (Anthropic)",
    "grok": "Grok (xAI)",
}


# ---------------------------------------------------------------------------
# Единый нормализованный вид (не зависит от движка) — как ParsedMessage в
# telegram_export, плюс контейнер разговора.
# ---------------------------------------------------------------------------

@dataclass
class ChatMessage:
    """Одно нормализованное сообщение диалога, готовое к санитизации и записи."""
    role: str            # user | assistant | system | tool (нормализовано)
    date_iso: str        # ISO-8601 (UTC), либо "" если время неизвестно
    body: str            # текст; ещё НЕ санитизирован — маскируется в writer
    has_code: bool       # был ли в исходном теле fenced-код (для эвристики)
    code_lines: int      # сколько строк кода (для accomplishment-эвристики)


@dataclass
class ChatConversation:
    """Нормализованный разговор: метаданные + список сообщений по порядку."""
    conv_id: str                 # стабильный id разговора (для дедупа/имени файла)
    title: str                   # заголовок (может быть пустым → 'Без названия')
    created_iso: str             # ISO начала (или "")
    updated_iso: str             # ISO последнего изменения (или "")
    messages: List[ChatMessage] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Общие хелперы нормализации времени и ролей.
# ---------------------------------------------------------------------------

def _iso_from_unixtime(unixtime: float) -> str:
    """ISO-8601 (UTC) из unix-секунд; пустая строка при некорректном значении."""
    try:
        if unixtime and unixtime > 0:
            return datetime.fromtimestamp(float(unixtime), tz=timezone.utc).isoformat(
                timespec="seconds"
            )
    except (TypeError, ValueError, OSError, OverflowError):
        pass
    return ""


def _iso_from_isostring(value: Any) -> str:
    """Нормализует ISO-строку (в т.ч. с висячим 'Z') к ISO-8601 UTC.

    Claude отдаёт время как `2026-05-31T12:00:00Z`; `fromisoformat` в 3.9 не ест
    суффикс 'Z', поэтому заменяем его на '+00:00'. При неудаче возвращаем как есть
    (строка всё равно информативна), а пустое/не-строку → "".
    """
    if not isinstance(value, str) or not value.strip():
        return ""
    raw = value.strip()
    candidate = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    try:
        dt = datetime.fromisoformat(candidate)
        if dt.tzinfo is None:  # наивное время трактуем как UTC
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat(timespec="seconds")
    except ValueError:
        return raw  # не распарсилось — отдаём исходную строку, не падаем


def _normalize_time(value: Any) -> str:
    """Универсально нормализует время: unix-число → ISO, ISO-строка → ISO.

    Grok-экспорт даёт `create_time` то числом, то строкой — этот хелпер скрывает
    разницу за одним вызовом.
    """
    if isinstance(value, (int, float)):
        return _iso_from_unixtime(value)
    return _iso_from_isostring(value)


def _normalize_role(raw_role: Any) -> str:
    """Сводит вариативные имена ролей к {user, assistant, system, tool}.

    ChatGPT: user/assistant/system/tool. Claude: human/assistant. Grok:
    user/grok/assistant/agent. Всё, что не похоже на пользователя/служебное,
    считаем ответом ассистента.
    """
    role = str(raw_role or "").strip().lower()
    if role in ("user", "human"):
        return "user"
    if role in ("system",):
        return "system"
    if role in ("tool", "function"):
        return "tool"
    # grok / agent / assistant / model / bot → assistant
    return "assistant"


# Fenced-код в markdown: ```lang ... ``` (или ~~~). Используется и для подсчёта
# код-строк (эвристика accomplishment), и для схлопывания кода в расшифровке.
_FENCE_RE = re.compile(
    r"(?P<fence>```|~~~)[ \t]*(?P<lang>[A-Za-z0-9_+.-]*)[^\n]*\n"
    r"(?P<code>.*?)(?P=fence)",
    re.DOTALL,
)


def _scan_code(text: str) -> Tuple[bool, int]:
    """Есть ли в тексте fenced-код и сколько в сумме строк кода.

    Нужна для эвристики «код-тяжёлая сессия» (ADR-0010): если кода много —
    эмитим accomplishment-выжимку вместо verbatim.
    """
    total = 0
    found = False
    for m in _FENCE_RE.finditer(text):
        found = True
        total += m.group("code").count("\n") + 1
    return found, total


def _collapse_code(text: str) -> str:
    """Схлопывает каждый fenced-код-блок в пометку `[code: <язык>, <N> строк]`.

    ADR-0010: в `raw/` (как и в вики) код verbatim не нужен — важно ЧТО сделано.
    Схлопывание заодно убирает потенциальные секреты внутри код-блоков ещё до
    sanitizer (defense-in-depth), хотя sanitizer всё равно отработает следом.
    """
    def repl(m: "re.Match[str]") -> str:
        lang = m.group("lang") or "?"
        n = m.group("code").count("\n") + 1
        return "[code: %s, %d строк]" % (lang, n)

    return _FENCE_RE.sub(repl, text)


# ---------------------------------------------------------------------------
# Парсер 1 — ChatGPT (conversations.json: дерево mapping).
# ---------------------------------------------------------------------------

def _chatgpt_message_text(message: Dict[str, Any]) -> str:
    """Собирает текст из ChatGPT-узла. `content.parts` — массив строк/объектов;
    нетекстовые части (dict) сворачиваем в `[non-text part]`."""
    content = message.get("content")
    if not isinstance(content, dict):
        return ""
    parts = content.get("parts")
    if not isinstance(parts, list):
        return ""
    chunks: List[str] = []
    for part in parts:
        if isinstance(part, str):
            chunks.append(part)
        elif part is not None:
            chunks.append("[non-text part]")
    return "\n".join(c for c in chunks if c)


def _chatgpt_linear_messages(mapping: Dict[str, Any]) -> Iterable[Dict[str, Any]]:
    """Реконструирует линейную ветку диалога из дерева `mapping`.

    Идём от корня (узел без `parent`) вниз по `children`; на ветвлениях берём
    последнего ребёнка (самый свежий вариант regenerate/edit). Узлы без `message`
    (системные/корневые) пропускаем на уровне выдачи.
    """
    if not isinstance(mapping, dict) or not mapping:
        return

    # Корень: узел, у которого parent отсутствует/None и который есть в mapping.
    root_id: Optional[str] = None
    for node_id, node in mapping.items():
        if not isinstance(node, dict):
            continue
        parent = node.get("parent")
        if parent is None or parent not in mapping:
            root_id = node_id
            break
    if root_id is None:
        return

    seen = set()  # страховка от циклов в битом экспорте
    current: Optional[str] = root_id
    while current and current in mapping and current not in seen:
        seen.add(current)
        node = mapping.get(current) or {}
        msg = node.get("message")
        if isinstance(msg, dict):
            yield msg
        children = node.get("children") or []
        if not isinstance(children, list) or not children:
            break
        current = children[-1]  # самая свежая ветка


def parse_chatgpt(data: Any) -> List[ChatConversation]:
    """Парсит ChatGPT `conversations.json` (массив разговоров с деревом mapping)."""
    conversations: List[ChatConversation] = []
    items = data if isinstance(data, list) else data.get("conversations", []) if isinstance(data, dict) else []
    for idx, conv in enumerate(items):
        if not isinstance(conv, dict):
            continue
        mapping = conv.get("mapping", {})
        messages: List[ChatMessage] = []
        for msg in _chatgpt_linear_messages(mapping):
            author = msg.get("author") or {}
            role = _normalize_role(author.get("role") if isinstance(author, dict) else None)
            text = _chatgpt_message_text(msg)
            if not text.strip():
                continue
            has_code, code_lines = _scan_code(text)
            messages.append(
                ChatMessage(
                    role=role,
                    date_iso=_iso_from_unixtime(msg.get("create_time")),
                    body=text,
                    has_code=has_code,
                    code_lines=code_lines,
                )
            )
        if not messages:
            continue
        conv_id = str(conv.get("conversation_id") or conv.get("id") or "chatgpt-%d" % idx)
        conversations.append(
            ChatConversation(
                conv_id=conv_id,
                title=str(conv.get("title") or "Без названия"),
                created_iso=_iso_from_unixtime(conv.get("create_time")),
                updated_iso=_iso_from_unixtime(conv.get("update_time")),
                messages=messages,
            )
        )
    return conversations


# ---------------------------------------------------------------------------
# Парсер 2 — Claude (conversations.json: плоский chat_messages, ISO-время).
# ---------------------------------------------------------------------------

def _claude_message_text(message: Dict[str, Any]) -> str:
    """Текст Claude-сообщения: из массива `content` (блоки {type:'text'}),
    фолбэк на плоское `text`. Нетекстовые блоки → `[non-text block]`."""
    content = message.get("content")
    if isinstance(content, list) and content:
        chunks: List[str] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                chunks.append(str(block.get("text", "")))
            else:
                chunks.append("[non-text block]")
        joined = "\n".join(c for c in chunks if c)
        if joined.strip():
            return joined
    # Фолбэк: плоское поле text.
    return str(message.get("text", "") or "")


def parse_claude(data: Any) -> List[ChatConversation]:
    """Парсит Claude `conversations.json` (массив разговоров, плоский chat_messages)."""
    conversations: List[ChatConversation] = []
    items = data if isinstance(data, list) else data.get("conversations", []) if isinstance(data, dict) else []
    for idx, conv in enumerate(items):
        if not isinstance(conv, dict):
            continue
        raw_messages = conv.get("chat_messages")
        if not isinstance(raw_messages, list):
            continue
        messages: List[ChatMessage] = []
        for msg in raw_messages:
            if not isinstance(msg, dict):
                continue
            role = _normalize_role(msg.get("sender"))
            text = _claude_message_text(msg)
            if not text.strip():
                continue
            has_code, code_lines = _scan_code(text)
            messages.append(
                ChatMessage(
                    role=role,
                    date_iso=_iso_from_isostring(msg.get("created_at")),
                    body=text,
                    has_code=has_code,
                    code_lines=code_lines,
                )
            )
        if not messages:
            continue
        conv_id = str(conv.get("uuid") or conv.get("id") or "claude-%d" % idx)
        conversations.append(
            ChatConversation(
                conv_id=conv_id,
                title=str(conv.get("name") or "Без названия"),
                created_iso=_iso_from_isostring(conv.get("created_at")),
                updated_iso=_iso_from_isostring(conv.get("updated_at")),
                messages=messages,
            )
        )
    return conversations


# ---------------------------------------------------------------------------
# Парсер 3 — Grok (терпимый к вариативной форме экспорта).
# ---------------------------------------------------------------------------

def _first_present(d: Dict[str, Any], *keys: str) -> Any:
    """Возвращает значение первого присутствующего ключа из синонимов.

    Grok-формат подвижен (messages/responses, message/text/body, sender/role/author)
    — этот хелпер делает парсер устойчивым к перестановке имён.
    """
    for key in keys:
        if key in d and d[key] not in (None, ""):
            return d[key]
    return None


def _grok_message_text(message: Dict[str, Any]) -> str:
    """Текст Grok-сообщения: поле бывает строкой ИЛИ объектом с `text`/`parts`."""
    raw = _first_present(message, "message", "text", "body", "content")
    if isinstance(raw, str):
        return raw
    if isinstance(raw, dict):
        if isinstance(raw.get("text"), str):
            return raw["text"]
        parts = raw.get("parts")
        if isinstance(parts, list):
            return "\n".join(str(p) for p in parts if isinstance(p, str))
    if isinstance(raw, list):  # массив строк/кусков
        return "\n".join(str(p) for p in raw if isinstance(p, str))
    return ""


def parse_grok(data: Any) -> List[ChatConversation]:
    """Парсит Grok-экспорт (плоский список сообщений; вариативные ключи)."""
    conversations: List[ChatConversation] = []
    items = data if isinstance(data, list) else data.get("conversations", []) if isinstance(data, dict) else []
    for idx, conv in enumerate(items):
        if not isinstance(conv, dict):
            continue
        raw_messages = _first_present(conv, "messages", "responses", "turns")
        if not isinstance(raw_messages, list):
            continue
        messages: List[ChatMessage] = []
        for msg in raw_messages:
            if not isinstance(msg, dict):
                continue
            role = _normalize_role(_first_present(msg, "sender", "role", "author"))
            text = _grok_message_text(msg)
            if not text.strip():
                continue
            has_code, code_lines = _scan_code(text)
            messages.append(
                ChatMessage(
                    role=role,
                    date_iso=_normalize_time(_first_present(msg, "create_time", "created_at", "timestamp")),
                    body=text,
                    has_code=has_code,
                    code_lines=code_lines,
                )
            )
        if not messages:
            continue
        conv_id = str(_first_present(conv, "conversation_id", "id", "uuid") or "grok-%d" % idx)
        conversations.append(
            ChatConversation(
                conv_id=conv_id,
                title=str(_first_present(conv, "title", "name") or "Без названия"),
                created_iso=_normalize_time(_first_present(conv, "create_time", "created_at")),
                updated_iso=_normalize_time(_first_present(conv, "update_time", "updated_at")),
                messages=messages,
            )
        )
    return conversations


# Реестр парсеров по движку.
_PARSERS = {
    "chatgpt": parse_chatgpt,
    "claude": parse_claude,
    "grok": parse_grok,
}


def detect_engine(data: Any) -> Optional[str]:
    """Авто-определяет движок по характерным ключам формата (если --engine не задан).

    - ChatGPT: у разговора есть `mapping` (дерево узлов).
    - Claude: у разговора есть `chat_messages`.
    - Grok: есть `messages`/`responses` И/ИЛИ `conversation_id` без mapping/chat_messages.
    Возвращает имя движка или None (тогда требуем явный --engine).
    """
    sample = None
    if isinstance(data, list) and data:
        sample = data[0]
    elif isinstance(data, dict):
        convs = data.get("conversations")
        if isinstance(convs, list) and convs:
            sample = convs[0]
        else:
            sample = data
    if not isinstance(sample, dict):
        return None
    if "mapping" in sample:
        return "chatgpt"
    if "chat_messages" in sample:
        return "claude"
    if any(k in sample for k in ("messages", "responses", "conversation_id")):
        return "grok"
    return None


# ---------------------------------------------------------------------------
# Извлечение идей/концепций/решений + accomplishment-эвристика (ADR-0010).
# ---------------------------------------------------------------------------

# Эвристические маркеры. НЕ претендуют на семантику — это разметка СЫРЬЯ: точное
# разбиение на страницы ideas/concepts/decisions делает компилятор вики (LLM).
# Маркеры подобраны под двуязычный (ru/en) обиход владельца.
_IDEA_MARKERS = (
    "идея", "а что если", "можно было бы", "хочу сделать", "давай попробуем",
    "idea", "what if", "we could", "i want to build", "let's try",
)
_DECISION_MARKERS = (
    "решил", "решение:", "вывод:", "итог:", "договорились", "выбираем", "остановимся на",
    "decided", "decision:", "conclusion", "we'll go with", "let's go with",
)
_CONCEPT_MARKERS = (
    "это означает", "по сути", "ключевая мысль", "принцип", "паттерн", "концепция",
    "the key idea", "in essence", "principle", "pattern", "concept",
)

# Порог «код-тяжёлой» сессии: суммарно строк кода во всех ответах. Выше — эмитим
# accomplishment-сводку вместо опоры на расшифровку.
_CODE_HEAVY_LINE_THRESHOLD = 30


def _split_sentences(text: str) -> List[str]:
    """Грубое разбиение на «реплики-предложения» для поиска маркеров.

    Не лингвистика: режем по переводам строк и точкам/!/?/; — достаточно, чтобы
    выдернуть короткие фразы-кандидаты, не таща абзацы целиком.
    """
    rough = re.split(r"(?<=[.!?;\n])\s+", text)
    return [s.strip() for s in rough if s.strip()]


def _extract_markers(messages: List[ChatMessage]) -> Dict[str, List[str]]:
    """Собирает фразы-кандидаты в идеи/решения/концепции по маркерам.

    Дедупит и ограничивает количество, чтобы секция-выжимка не распухла. Возвращает
    {'ideas': [...], 'decisions': [...], 'concepts': [...]} (любой может быть пуст).
    """
    buckets: Dict[str, List[str]] = {"ideas": [], "decisions": [], "concepts": []}
    seen: set = set()

    def consider(sentence: str) -> None:
        low = sentence.lower()
        target = None
        if any(m in low for m in _DECISION_MARKERS):
            target = "decisions"
        elif any(m in low for m in _IDEA_MARKERS):
            target = "ideas"
        elif any(m in low for m in _CONCEPT_MARKERS):
            target = "concepts"
        if target is None:
            return
        # Нормализуем для дедупа; режем слишком длинные хвосты.
        clipped = sentence if len(sentence) <= 280 else sentence[:277] + "…"
        key = (target, clipped.lower())
        if key in seen:
            return
        seen.add(key)
        if len(buckets[target]) < 12:  # потолок на каждый bucket
            buckets[target].append(clipped)

    for msg in messages:
        # Идеи/решения ищем во всех ролях (и в вопросах пользователя, и в ответах).
        for sentence in _split_sentences(msg.body):
            consider(sentence)
    return buckets


def _build_accomplishment(conv: ChatConversation, total_code_lines: int) -> List[str]:
    """Строит accomplishment-сводку для код-тяжёлой сессии (ADR-0010).

    Формат «построил X через Y, демонстрирует навык Z, ключевые решения/уроки».
    Здесь мы НЕ зовём LLM — даём компилятору заготовку: что за сессия, объём кода,
    языки, и вытащенные маркеры решений. Точную прозу/навыки финализирует компилятор
    вики при сборке `capability-profile`/`projects/` (точка приложения LLM — там).
    """
    # Языки fenced-блоков — грубый сигнал «через что» (Y).
    langs: List[str] = []
    for msg in conv.messages:
        for m in _FENCE_RE.finditer(msg.body):
            lang = (m.group("lang") or "").strip().lower()
            if lang and lang not in langs:
                langs.append(lang)
    langs_str = ", ".join(langs) if langs else "не указаны явно"

    lines = [
        "## Accomplishment (код-тяжёлая сессия)",
        "",
        "> Сессия code-heavy (~%d строк кода) → по [ADR-0010]"
        "(../../docs/adr/0010-wiki-content-model.md) вместо verbatim-кода — выжимка "
        "«что сделано». Финализирует и привяжет к навыкам компилятор вики." % total_code_lines,
        "",
        "- **Что (X):** %s" % (conv.title or "Без названия"),
        "- **Через что (Y):** %s" % langs_str,
        "- **Навык (Z):** _заполнит компилятор_ (вывести из X/Y и характера задачи).",
        "- **Ключевые решения / уроки:** см. секцию «Решения» ниже (если пусто — "
        "компилятор извлечёт из расшифровки).",
        "",
    ]
    return lines


# ---------------------------------------------------------------------------
# Сборка markdown-страницы разговора (frontmatter + выжимка + расшифровка).
# ---------------------------------------------------------------------------

def _slugify(title: str, conv_id: str) -> str:
    """Безопасное техническое имя файла (как в telegram_export).

    Заголовок диалога может содержать личное → в slug оставляем только латиницу/
    цифры/дефис, кириллицу/прочее не транслитим, а схлопываем; хвостом — conv_id
    для уникальности. Сам `title` во frontmatter санитизируется отдельно.
    """
    ascii_part = re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-").lower()
    if not ascii_part:
        ascii_part = "chat"
    # conv_id тоже чистим под файловую систему.
    safe_id = re.sub(r"[^A-Za-z0-9._-]+", "-", str(conv_id)).strip("-") or "id"
    return "%s-%s" % (ascii_part[:40], safe_id[:40])


def _yaml_quote(value: str) -> str:
    """Экранирует строку для одинарных кавычек YAML (удваивает ')."""
    return value.replace("'", "''")


def build_page(
    conv: ChatConversation,
    engine: str,
    export_name: str,
) -> Optional[str]:
    """Собирает markdown-страницу одного разговора.

    Возвращает markdown или None (если после фильтрации не осталось сообщений).
    КАЖДОЕ тело и роль/заголовок проходят `fail_closed_sanitize`: при abort
    исключение поднимается наверх и страница НЕ записывается (fail-closed).

    Состав страницы (ADR-0010):
      frontmatter → [accomplishment, если код-тяжёлая] → идеи/концепции/решения →
      санитизированная расшифровка (код в ней схлопнут до пометки).
    """
    if not conv.messages:
        return None

    # --- 1. Эвристики ДО санитизации (по исходному тексту: маркеры/код) ---
    total_code_lines = sum(m.code_lines for m in conv.messages)
    is_code_heavy = total_code_lines >= _CODE_HEAVY_LINE_THRESHOLD
    markers = _extract_markers(conv.messages)

    # --- 2. Санитизация выжимок (маркеры — это куски пользовательского текста!) ---
    # Каждый кандидат-маркер проходит fail-closed-sanitizer, как и тела сообщений.
    def sanitize_list(items: List[str]) -> List[str]:
        return [fail_closed_sanitize(s) for s in items]

    safe_markers = {k: sanitize_list(v) for k, v in markers.items()}

    # --- 3. Санитизированная расшифровка (код схлопнут ДО sanitizer) ---
    transcript_lines: List[str] = []
    min_iso: Optional[str] = None
    max_iso: Optional[str] = None
    for msg in conv.messages:
        # Код схлопываем в пометку ещё до sanitizer (ADR-0010 + меньше шансов
        # протащить секрет), затем обязательная fail-closed-санитизация тела.
        collapsed = _collapse_code(msg.body)
        safe_body = fail_closed_sanitize(collapsed)
        # Роль — служебная метка, но прогоним через sanitizer для единообразия
        # (на случай экзотических значений роли в кривом экспорте).
        safe_role = fail_closed_sanitize(msg.role)
        stamp = msg.date_iso or "?"
        transcript_lines.append("- **%s** _(%s)_: %s" % (safe_role, stamp, safe_body))
        if msg.date_iso:
            min_iso = msg.date_iso if min_iso is None else min(min_iso, msg.date_iso)
            max_iso = msg.date_iso if max_iso is None else max(max_iso, msg.date_iso)

    # Диапазон дат: из сообщений, фолбэк на created/updated разговора.
    date_from = min_iso or conv.created_iso or "?"
    date_to = max_iso or conv.updated_iso or "?"

    # Заголовок тоже может нести личное → санитизируем.
    safe_title = fail_closed_sanitize(conv.title or "Без названия")
    engine_human = KNOWN_ENGINES.get(engine, engine)

    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")

    # --- 4. Frontmatter (provenance + разметка сырья для компилятора) ---
    front: List[str] = [
        "---",
        "title: 'Диалог LLM — %s'" % _yaml_quote(safe_title),
        "type: source",
        "status: immutable",
        "source: llm_chat",
        "engine: %s" % engine,
        "conversation_id: '%s'" % _yaml_quote(str(conv.conv_id)),
        "exported_from: '%s'" % _yaml_quote(str(export_name)),
        "date_range: '%s — %s'" % (date_from, date_to),
        "messages_count: %d" % len(conv.messages),
        "code_heavy: %s" % ("true" if is_code_heavy else "false"),
        "code_lines: %d" % total_code_lines,
        # Счётчики кандидатов — компилятору сигнал, что добывать со страницы.
        "extracted_ideas: %d" % len(safe_markers["ideas"]),
        "extracted_decisions: %d" % len(safe_markers["decisions"]),
        "extracted_concepts: %d" % len(safe_markers["concepts"]),
        "ingested_at: %s" % now_iso,
        "last_updated: %s" % now_iso[:10],
        "---",
        "",
        "# Диалог LLM — %s" % safe_title,
        "",
        "> Immutable снапшот источника (%s). Каждое тело прошло fail-closed-sanitizer; "
        "код схлопнут до пометок (ADR-0010)." % engine_human,
        "> Диапазон: %s — %s · сообщений: %d · движок: `%s`."
        % (date_from, date_to, len(conv.messages), engine),
        "",
    ]

    body_sections: List[str] = []

    # --- 5. Accomplishment (только для код-тяжёлых сессий) ---
    if is_code_heavy:
        body_sections.extend(_build_accomplishment(conv, total_code_lines))

    # --- 6. Идеи / Концепции / Решения (выжимка-сырьё для компилятора) ---
    def render_bucket(heading: str, items: List[str]) -> None:
        if not items:
            return
        body_sections.append("## %s" % heading)
        body_sections.append("")
        body_sections.extend("- %s" % it for it in items)
        body_sections.append("")

    render_bucket("Идеи", safe_markers["ideas"])
    render_bucket("Концепции", safe_markers["concepts"])
    render_bucket("Решения", safe_markers["decisions"])

    # --- 7. Полная санитизированная расшифровка ---
    body_sections.append("## Расшифровка")
    body_sections.append("")
    body_sections.extend(transcript_lines)
    body_sections.append("")

    return "\n".join(front) + "\n".join(body_sections) + "\n"


# ---------------------------------------------------------------------------
# Запись страницы в raw/ (атомарно) — как в telegram_export.
# ---------------------------------------------------------------------------

def write_page(raw_dir: Path, conv: ChatConversation, engine: str, markdown: str) -> Path:
    """Пишет страницу разговора под raw/llm_chat/<engine>/<slug>.md (атомарно).

    raw/ — immutable: при ре-ингесте того же экспорта watermark отсечёт уже
    виденные conv_id, так что повторный прогон сюда не дойдёт (пустой результат).
    Группируем по подпапке движка, чтобы chatgpt/claude/grok не путались.
    """
    out_dir = raw_dir / SOURCE_NAME / engine
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = _slugify(conv.title or "chat", conv.conv_id)
    out_path = out_dir / ("%s.md" % slug)

    # Атомарная запись: временный файл + replace.
    tmp_path = out_path.with_suffix(".md.tmp")
    tmp_path.write_text(markdown, encoding="utf-8")
    os.replace(tmp_path, out_path)
    return out_path


# ---------------------------------------------------------------------------
# Загрузка + главный конвейер.
# ---------------------------------------------------------------------------

def load_export(path: Path) -> Any:
    """Читает экспорт JSON целиком (v1). Большие выгрузки — потоковый разбор как
    документированное расширение (см. README, аналогично telegram --ijson хуку)."""
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def ingest(export_json: Path, raw_dir: Path, engine: Optional[str] = None) -> int:
    """Полный ингест одного экспорта диалогов в raw_dir. Возвращает число
    записанных разговоров.

    Watermark источника `llm_chat` хранит множество уже виденных conv_id (по
    движкам) → повторный ингест того же экспорта идемпотентен. Курсор двигается
    ТОЛЬКО после успешной записи всех страниц прогона (advance-only-after-write).
    """
    data = load_export(export_json)

    # Движок: из аргумента или авто-детект по форме.
    if engine is None:
        engine = detect_engine(data)
        if engine is None:
            raise SystemExit(
                "не удалось определить движок экспорта — укажите явно "
                "--engine {chatgpt|claude|grok}"
            )
        print("авто-определён движок: %s" % engine)
    if engine not in _PARSERS:
        raise SystemExit("неизвестный движок %r (ожидался chatgpt|claude|grok)" % engine)

    print("ingest llm_chat (%s): %s -> %s" % (engine, export_json, raw_dir))

    conversations = _PARSERS[engine](data)
    if not conversations:
        print("в экспорте не найдено разговоров — нечего ингестить")
        return 0

    # Watermark: множество виденных conv_id (по движкам). Дедуп по нему.
    wm = Watermark.load(raw_dir, SOURCE_NAME)
    seen_ids = set(wm.cursor.get("seen_conversation_ids", []))

    export_name = export_json.name
    total_written = 0
    new_ids: List[str] = []

    for conv in conversations:
        marker_id = "%s:%s" % (engine, conv.conv_id)
        if marker_id in seen_ids:
            continue  # уже ингестировали этот разговор ранее — идемпотентно пропускаем

        try:
            markdown = build_page(conv, engine, export_name)
        except SanitizerError as exc:
            # Fail-closed: санитайзер не гарантировал чистоту → страницу НЕ пишем,
            # conv_id НЕ помечаем виденным (повтор попробует снова). Логируем без
            # самого тела (не раскрываем содержимое в stderr).
            print(
                "  [SKIP] разговор %s — sanitizer abort: %s (файл не записан)"
                % (conv.conv_id, exc),
                file=sys.stderr,
            )
            continue

        if not markdown:
            # Пустой разговор после фильтрации — помечаем виденным, чтобы не
            # перебирать его каждый раз, но файл не пишем.
            new_ids.append(marker_id)
            continue

        out_path = write_page(raw_dir, conv, engine, markdown)
        new_ids.append(marker_id)
        total_written += 1
        print("  [write] %s (%d сообщений)" % (out_path, len(conv.messages)))

    # Двигаем watermark ТОЛЬКО если что-то реально обработали (advance-after-write).
    if new_ids:
        merged = sorted(seen_ids.union(new_ids))
        wm.advance(seen_conversation_ids=merged, last_engine=engine)
        wm.save()
        print("watermark llm_chat -> известных разговоров: %d" % len(merged))
    else:
        print("новых разговоров нет — watermark не двигаем")

    print("итог: записано разговоров %d" % total_written)
    return total_written


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _resolve_raw_dir(arg_value: Optional[str]) -> Path:
    """Каталог raw/ из --raw-dir или env LLM_WIKI_RAW_DIR. Без него — ошибка
    (путь к приватному репо НЕ угадываем; как в telegram_export)."""
    raw = arg_value or os.environ.get("LLM_WIKI_RAW_DIR")
    if not raw:
        raise SystemExit(
            "не задан каталог raw/: укажите --raw-dir ИЛИ переменную окружения "
            "LLM_WIKI_RAW_DIR (путь к raw/ приватного репо llm-wiki-content)"
        )
    return Path(raw).expanduser()


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="ingest.llm_chat",
        description="Парсинг экспортов диалогов LLM (ChatGPT/Claude/Grok) → "
        "sanitized markdown в raw/ (+ выжимка идей/решений, accomplishment для кода).",
    )
    parser.add_argument("export_json", help="путь к экспортированному conversations.json")
    parser.add_argument(
        "--engine",
        choices=sorted(_PARSERS.keys()),
        default=None,
        help="движок экспорта (chatgpt|claude|grok); если не задан — авто-детект",
    )
    parser.add_argument(
        "--raw-dir",
        default=None,
        help="каталог raw/ приватного репо (или env LLM_WIKI_RAW_DIR)",
    )
    args = parser.parse_args(argv)

    export_path = Path(args.export_json).expanduser()
    if not export_path.exists():
        raise SystemExit("файл не найден: %s" % export_path)

    raw_dir = _resolve_raw_dir(args.raw_dir)
    ingest(export_path, raw_dir, engine=args.engine)
    return 0


if __name__ == "__main__":
    sys.exit(main())
