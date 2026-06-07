"""promote.py — READ-ONLY обзор карантина + ОДНОШАГОВЫЙ логируемый re-promote.

НАЗНАЧЕНИЕ (ADR-0011 §8b/§11, routine #6 `quarantine-review`)
============================================================
Маленький детерминированный (stdlib-only) хелпер для routine `quarantine-review`:

  • `--list`     — собрать из ledger raw/.filter-log.jsonl ОЧЕРЕДЬ НА РЕВЬЮ:
                   по категориям, с sanitized-однострочниками (путь-basename,
                   reason, score, sha256-префикс). Метаданные-онли.
  • `--promote ID` — ОДИН ЛОГИРУЕМЫЙ ШАГ возврата ложного срабатывания из
                   карантина: дописать в ledger строку-решение `re-promote` +
                   человекочитаемую строку в log.md. Это escape-hatch для
                   false-positive (карантин предпочитает ложно-положительные →
                   дешёвый возврат ОБЯЗАТЕЛЕН, ADR-0011).

КОНТРАКТ БЕЗОПАСНОСТИ (P0-2, изоляция инъекций — ЖЁСТКО)
  • Скрипт НИКОГДА не открывает ТЕЛО карантина (raw/.quarantine/**) и файлы
    raw/.tasks/**. Единственный вход — append-only ledger raw/.filter-log.jsonl,
    где лежат ТОЛЬКО метаданные (категория/action/reason/score/content_sha256/
    raw_path), сформированные ingest.classifier.filter_log_record БЕЗ содержимого.
    Карантинный документ мог прийти из недоверенного источника и содержать
    prompt-injection — поэтому ревьюим его ОТПЕЧАТОК, не текст.

КОНТРАКТ ИММУТАБЕЛЬНОСТИ (raw/ — append-only, ADR-0011)
  • re-promote — это НЕ перемещение и НЕ хард-удаление файла. raw/ иммутабелен;
    «вернуть из карантина» = дописать в ledger ДИСПОЗИЦИЮ-РЕВЕРС (`re-promote`,
    action `normal`), которую читатели compile/query трактуют как «этот документ
    (по sha256/raw_path) очищен к промоушену, несмотря на исходный карантин».
    Физический файл карантина остаётся на месте (аудит сохраняется).

  • P0-1: при любом обходе дерева (нет в этом скрипте по дефолту — мы читаем
    один ledger-файл) прогоняем пути через ingest.classifier.should_skip_raw_path.

ЗАПУСК (по ПУТИ, не `-m`: каталог `quarantine-review` с дефисом — не Python-модуль;
запускаем файл напрямую, как run_routine.sh запускает свои обёртки по пути)
  python scheduler/routines/quarantine-review/promote.py --list
  python scheduler/routines/quarantine-review/promote.py --list --since 2026-06-01
  python scheduler/routines/quarantine-review/promote.py --promote <event-id> \
        --note "ложное срабатывание: финансовый план, не чужие персданные"

  (event-id печатается в --list; это короткий префикс sha256 + порядковый номер.)

Сам routine `quarantine-review` (движок claude -p) зовёт `--list`, формирует
владельцу очередь-на-ревью в Telegram и, по одобрению владельца, исполняет
`--promote` как ОДИН шаг. Промпт и установка — README.md рядом + plist.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path

# Переиспускаем единый аудит-контракт из классификатора (НЕ переопределяем формат
# записи), с stdlib-fallback'ом, чтобы скрипт оставался запускаемым даже без ingest
# на пути (то же правило мягкого импорта, что в digest.py/reminders.py).
try:
    from ingest.classifier import filter_log_record, should_skip_raw_path  # type: ignore
except Exception:  # pragma: no cover - ingest может быть не на пути
    filter_log_record = None  # type: ignore

    def should_skip_raw_path(path: str | Path) -> bool:  # type: ignore[misc]
        return any(part.startswith(".") for part in Path(path).parts)


# Действия, считающиеся КАРАНТИНОМ (исключены из compile, требуют ревью). Должно
# совпадать с digest.render_filter_review и контрактом relevance-policy.md.
_QUARANTINE_ACTIONS = {"quarantine", "quarantine_and_redact"}


def _content_root() -> Path:
    return Path(os.environ.get("CONTENT_ROOT", str(Path.home() / "llm-wiki-content")))


def _raw_dir() -> Path:
    return Path(os.environ.get("RAW_DIR", str(_content_root() / "raw")))


def _filter_log_path() -> Path:
    return Path(os.environ.get("FILTER_LOG", str(_raw_dir() / ".filter-log.jsonl")))


def _log_md_path() -> Path:
    """Человекочитаемый журнал диспозиций фильтра (verb `filter`/`re-promote`).
    Лежит рядом с tasks/log.md в контент-репо; путь конфигурируем."""
    return Path(
        os.environ.get("FILTER_LOG_MD", str(_content_root() / "tasks" / "log.md"))
    )


def _event_id(rec: dict, idx: int) -> str:
    """Короткий стабильный id события для CLI: префикс sha256 + порядковый номер.
    Без sha256 (старая запись) — fallback на индекс. Не светит содержимое."""
    sha = str(rec.get("content_sha256", ""))
    # «sha256:abcd1234...» → «abcd1234»
    short = sha.split(":", 1)[-1][:8] if sha else "nohash"
    return f"{short}-{idx}"


def _parse_ts(rec: dict) -> dt.datetime | None:
    ts_raw = rec.get("ts")
    if not isinstance(ts_raw, str):
        return None
    try:
        ts = dt.datetime.fromisoformat(ts_raw)
    except ValueError:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=dt.timezone.utc)
    return ts


def read_ledger(path: Path, *, since: dt.datetime | None = None) -> list[dict]:
    """Прочитать ledger-строки (метаданные-онли), новее `since`. Битые строки
    тихо пропускаем (один кривой JSON не должен глушить ревью)."""
    if not path.exists():
        return []
    out: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(rec, dict):
            continue
        if since is not None:
            ts = _parse_ts(rec)
            if ts is not None and ts <= since:
                continue
        out.append(rec)
    return out


def _already_promoted(events: list[dict]) -> set[str]:
    """sha256-отпечатки, по которым УЖЕ был re-promote (чтобы --list не показывал
    их снова как «в карантине»). Идемпотентность ревью."""
    promoted: set[str] = set()
    for rec in events:
        if rec.get("axis") == "re-promote" or rec.get("reason", "").startswith("re-promote"):
            sha = str(rec.get("content_sha256", ""))
            if sha:
                promoted.add(sha)
    return promoted


def list_quarantine(path: Path, *, since: dt.datetime | None = None) -> list[tuple[str, dict]]:
    """Вернуть ОЧЕРЕДЬ НА РЕВЬЮ: список (event_id, record) для записей в карантине,
    по которым ещё НЕ было re-promote. Метаданные-онли."""
    events = read_ledger(path, since=since)
    promoted = _already_promoted(events)
    queue: list[tuple[str, dict]] = []
    for idx, rec in enumerate(events):
        if str(rec.get("action", "")) not in _QUARANTINE_ACTIONS:
            continue
        sha = str(rec.get("content_sha256", ""))
        if sha and sha in promoted:
            continue  # уже возвращён — не в очереди
        queue.append((_event_id(rec, idx), rec))
    return queue


def render_queue(queue: list[tuple[str, dict]]) -> str:
    """Текстовая очередь-на-ревью (для движка/человека). Тела не читаются."""
    if not queue:
        return "_(карантин пуст — ревьюить нечего)_"
    # Группируем по категории для читаемости.
    by_cat: dict[str, list[tuple[str, dict]]] = {}
    for eid, rec in queue:
        by_cat.setdefault(str(rec.get("category", "?")), []).append((eid, rec))
    lines = [f"Очередь на ревью карантина: {len(queue)} (метаданные, тела не читаются)"]
    for cat, items in sorted(by_cat.items()):
        lines.append(f"  [{cat}] — {len(items)}")
        for eid, rec in items:
            name = Path(str(rec.get("raw_path", ""))).name or "?"
            reason = str(rec.get("reason", ""))[:60]
            score = rec.get("score")
            sha = str(rec.get("content_sha256", ""))[:14]
            score_s = f" score={score}" if score is not None else ""
            lines.append(f"    • {eid}: `{name}` · {reason}{score_s} · {sha}")
    lines.append("")
    lines.append("Re-promote ложного срабатывания (один логируемый шаг):")
    lines.append("  python scheduler/routines/quarantine-review/promote.py "
                 "--promote <id> --note \"<причина>\"")
    return "\n".join(lines)


def promote(event_id: str, *, note: str, log_path: Path, md_path: Path,
            now: dt.datetime | None = None) -> int:
    """ОДИН ЛОГИРУЕМЫЙ ШАГ re-promote: найти событие карантина по id (через ledger,
    метаданные-онли), дописать в ledger строку-реверс `re-promote` (action=normal)
    + человекочитаемую строку в md. НЕ перемещает/не удаляет файл (иммутабельность).

    Возвращает exit-code (0 = ок, 1 = id не найден).
    """
    now = now or dt.datetime.now(dt.timezone.utc)
    queue_all = read_ledger(log_path)  # всё, не только карантин — ищем по id
    target: dict | None = None
    for idx, rec in enumerate(queue_all):
        if _event_id(rec, idx) == event_id:
            target = rec
            break
    if target is None:
        print(f"re-promote: событие id={event_id!r} не найдено в ledger", file=sys.stderr)
        return 1

    sha = str(target.get("content_sha256", ""))
    raw_path = str(target.get("raw_path", ""))
    cat = str(target.get("category", "?"))

    # Строка-реверс в ledger. Если есть общий filter_log_record — НЕ зовём его
    # (он завязан на Classification и добавил бы content-sha из нового content);
    # тут мы ПЕРЕНОСИМ уже-имеющийся sha исходного документа, без чтения тела.
    reverse = {
        "ts": now.isoformat(),
        "raw_path": raw_path,
        "axis": "re-promote",
        "category": cat,
        "action": "normal",  # очищен к промоушену, несмотря на исходный карантин
        "tier": target.get("tier"),
        "reason": f"re-promote:{note}"[:200] if note else "re-promote",
        "score": None,
        "policy_version": target.get("policy_version", ""),
        "content_sha256": sha,  # сверка по отпечатку исходного документа
        "promoted_from_event": event_id,
    }
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(reverse, ensure_ascii=False) + "\n")
    except OSError as exc:
        print(f"re-promote: не удалось дописать ledger: {exc}", file=sys.stderr)
        return 2

    # Человекочитаемая строка журнала (verb re-promote — расширение verb filter).
    human = (
        f"## [{now.date().isoformat()}] re-promote | {cat} | "
        f"`{Path(raw_path).name}` ({sha[:14]}) | {note or 'false-positive'}\n"
    )
    try:
        md_path.parent.mkdir(parents=True, exist_ok=True)
        with md_path.open("a", encoding="utf-8") as fh:
            fh.write(human)
    except OSError as exc:
        print(f"re-promote: ledger обновлён, но log.md не записан: {exc}", file=sys.stderr)
        # ledger — источник истины; md — для глаз. Не считаем фаталом.

    print(f"re-promote OK: {event_id} [{cat}] `{Path(raw_path).name}` → action=normal "
          f"(ledger дописан, файл карантина НЕ тронут — иммутабельность).")
    return 0


def _parse_since(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        ts = dt.datetime.fromisoformat(value)
    except ValueError:
        print(f"--since: не ISO-дата: {value!r}", file=sys.stderr)
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=dt.timezone.utc)
    return ts


def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="quarantine-review/promote.py",
        description="READ-ONLY обзор карантина + одношаговый логируемый re-promote "
                    "(ADR-0011 §8b/§11; метаданные-онли, тела не читаются).",
    )
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--list", action="store_true",
                   help="Показать очередь на ревью карантина (метаданные-онли).")
    g.add_argument("--promote", metavar="EVENT_ID",
                   help="Вернуть событие из карантина одним логируемым шагом.")
    p.add_argument("--since", metavar="ISO",
                   help="Для --list: показывать только события новее этой ISO-даты.")
    p.add_argument("--note", default="",
                   help="Для --promote: причина возврата (идёт в ledger и log.md).")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_argparser().parse_args(argv)
    log_path = _filter_log_path()

    if args.list:
        queue = list_quarantine(log_path, since=_parse_since(args.since))
        print(render_queue(queue))
        return 0

    # --promote
    return promote(
        args.promote,
        note=args.note,
        log_path=log_path,
        md_path=_log_md_path(),
    )


if __name__ == "__main__":
    sys.exit(main())
