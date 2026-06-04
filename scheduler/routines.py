"""routines.py — КАТАЛОГ плановых routine'ов «Второго мозга» (Claude-native).

ЧТО ЭТО
=======
Единая точка входа проактивного/планового слоя: `python -m scheduler.routines <name>`.
Каждая routine — это короткоживущий запуск официального движка `claude -p
--output-format json` (ADR-0008/0009) с routine-специфичным промптом над ПРИВАТНЫМ
контент-репо, плюс (где нужно) детерминированная Python-обвязка вокруг него
(предчек, last-mile sanitizer-guard, push в Telegram). Полный человекочитаемый
каталог с расписаниями и контрактами — в [routines/README.md](routines/README.md).

ПОЧЕМУ ОДИН МОДУЛЬ-ДИСПЕТЧЕР, А НЕ ПЯТЬ СКРИПТОВ
  Все routine'ы делят один паттерн (загрузить движок через bridge.engine → спавн
  `claude -p` с промптом → опц. push) и одни и те же контракты (sanitizer-guard,
  пути из .env, движок-за-абстракцией). Диспетчер не дублирует спавн: тяжёлые
  routine'ы (digest, lint) делегируют уже написанным модулям, лёгкие (compile,
  research, resurface) зовут общий помощник `_run_engine_routine()`.

ТРИ СЛОЯ ИСПОЛНЕНИЯ (CONTEXT §4)
  • РЕАКТИВ   — Telegram → bridge → движок (это НЕ здесь, это bridge/).
  • ПЛАНОВОЕ  — routine по расписанию (launchd ИЛИ remote Claude routine) →
                `claude -p` → compile / digest+reminders / lint / web-research /
                idea-resurfacing. ← ЭТОТ модуль.
  • СОБЫТИЙНОЕ — новый файл в raw/ → триггер → compile (та же routine `compile`,
                запущенная по событию, а не по времени; см. routines/README.md).

КАТАЛОГ (5 routine'ов, см. routines/README.md):
  compile    — ночью: новые источники из raw/ → страницы wiki/ (ингест-компиляция).
  digest     — утром: due-напоминания + дни рождения → один Telegram-дайджест
               (делегирует scheduler.digest.run_sweep — там предчек + push).
  lint       — еженедельно: противоречия/stale/orphans в вики + PII-скан
               публичного репо (делегирует scheduler.lint_public + движок-ревью).
  research   — по расписанию: пользовательские запросы (research/queries.md) →
               web-research движком → файл в wiki/ + краткий пуш в Telegram.
  resurface  — idea-resurfacing: всплытие «спящих» идей по лесенке Leitner
               (в v1 реализовано записями kind=spaced внутри digest; здесь —
               отдельный лёгкий вариант «выбери идею, которую стоит освежить»).

ДВИЖОК — CLAUDE-NATIVE, НО ПОРТИРУЕМЫЙ
  Спавн движка идёт через scheduler.digest._load_engine() → bridge.engine
  (дефолт `ClaudeEngine`, официальный `claude -p`). `GrokEngine`/`CodexEngine` —
  отложенные адаптеры-слоты: смена движка = смена адаптера в мосте, не правка
  этого модуля (ADR-0008).

ГРАНИЦЫ
  • Движок side-effect-free: единственный исходящий канал — узкий owner-only push
    в Telegram, который делает ЭТОТ модуль ПОСЛЕ выхода движка (минимизация
    blast-radius для lethal-trifecta — ADR-0007 §risks, privacy-security.md).
  • Любой исходящий текст проходит last-mile `scan_secrets` (общий из ingest) —
    ни токен, ни ключ не уйдёт даже в личный чат.
  • bridge.* импортируются ЛЕНИВО (через scheduler.digest) — прогон каталога не
    падает, пока мост ещё ставится.

ЗАПУСК (примеры)
  python -m scheduler.routines --list                 # показать каталог
  python -m scheduler.routines digest                 # боевой утренний дайджест
  python -m scheduler.routines compile                # ночная компиляция
  python -m scheduler.routines research --dry-run     # собрать промпты, не звать движок
  python -m scheduler.routines lint                   # еженедельный линт
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

# Переиспользуем уже написанную обвязку digest.py: загрузчики движка/Telegram,
# last-mile guard, конфиг путей. НЕ дублируем спавн `claude -p` (один шов, ADR-0008).
from scheduler import digest as _digest
from scheduler.digest import Config, assert_no_secrets

# --- логгер (тот же мягкий выбор structlog/stdlib, что в digest.py) ----------
try:  # pragma: no cover - тривиальный выбор логгера
    import structlog

    _log = structlog.get_logger("scheduler.routines")
except Exception:  # pragma: no cover
    _log = _digest._log  # переиспользуем шим-логгер digest.py


# ---------------------------------------------------------------------------
# Конфиг routine'ов (расширяет пути из digest.Config)
# ---------------------------------------------------------------------------


class RoutineConfig(Config):
    """Пути/параметры для всех routine'ов. Наследует reminders/wiki-пути из
    digest.Config и добавляет источники компиляции и файл research-запросов.
    Всё — через env (host-portable, ADR-0005)."""

    def __init__(self) -> None:
        super().__init__()
        # Каталог сырья (immutable raw-снапшоты источников) — вход routine compile.
        self.raw_dir = Path(os.environ.get("RAW_DIR", str(self.content_root / "raw")))
        # Файл пользовательских research-запросов (приватный репо). Каждая строка
        # `- <запрос>` — отдельная тема для планового web-research.
        self.research_queries = Path(
            os.environ.get(
                "RESEARCH_QUERIES",
                str(self.content_root / "research" / "queries.md"),
            )
        )
        # Куда движок кладёт результаты research внутри вики.
        self.research_out_dir = Path(
            os.environ.get("RESEARCH_OUT_DIR", str(self.wiki_dir / "research"))
        )
        # Корень ПУБЛИЧНОГО фреймворк-репо (для PII-скана в routine lint).
        self.public_repo = Path(
            os.environ.get("PUBLIC_REPO", str(Path(__file__).resolve().parent.parent))
        )


# ---------------------------------------------------------------------------
# Общий помощник: спавн движка с routine-промптом (+ опц. owner-push)
# ---------------------------------------------------------------------------


def _run_engine_routine(
    prompt: str,
    *,
    dry_run: bool,
    push_summary: bool,
    label: str,
) -> int:
    """Выполнить «лёгкую» движок-routine: спавн `claude -p` с готовым промптом.

    dry_run=True — напечатать промпт и выйти (проверка без движка/токена).
    push_summary=True — после выхода движка отправить его ответ владельцу в
    Telegram (через last-mile sanitizer-guard). Движок остаётся side-effect-free:
    HTTP-вызов делает ЭТОТ код, не движок (ADR-0007 §risks).

    Возвращает exit-code (0 = ок), как и run_sweep — чтобы launchd/routine видел
    статус, но один упавший движок не валил демона.
    """
    if dry_run:
        print(f"=== DRY RUN [{label}]: промпт для движка ===")
        print(prompt)
        return 0

    # Спавн движка через общий загрузчик digest.py (дефолт ClaudeEngine, ADR-0008).
    try:
        run_engine = _digest._load_engine()
    except ImportError as exc:
        _log.error("engine-unavailable", routine=label, error=str(exc))
        return 2
    try:
        # stateless: session_id=None — плановые routine'ы без диалоговой непрерывности.
        answer, _sid, usage = run_engine(prompt, None)
    except Exception as exc:  # таймаут/лимит/сбой движка — не роняем routine-демона
        _log.error("engine-failed", routine=label, error=str(exc))
        return 3
    _log.info("engine-completed", routine=label, usage=str(usage))

    text = (answer or "").strip()
    if not push_summary:
        # compile/resurface правят файлы вики сами (workspace-write); короткий ответ
        # движка просто логируем — не шлём в Telegram, чтобы не спамить владельца.
        _log.info("routine-done", routine=label, answer_chars=len(text))
        return 0

    if not text or text == "NO_DIGEST":
        _log.info("routine-no-output", routine=label)
        return 0

    # Last-mile sanitizer-guard + owner-push (как в digest.run_sweep).
    assert_no_secrets(text)
    try:
        send = _digest._load_telegram()
        send(text, disable_notification=False)
    except Exception as exc:
        _log.error("telegram-send-failed", routine=label, error=str(exc))
        return 4
    _log.info("routine-pushed", routine=label, chars=len(text))
    return 0


# ---------------------------------------------------------------------------
# Промпт-шаблоны routine'ов (движок-агностичные инструкции; движок = claude -p)
# ---------------------------------------------------------------------------

# routine compile (ночь + событие «новый файл в raw/»). Движок читает контракт
# хранителя (compiler/rules.md + AGENTS.md), берёт НЕ-скомпилированные источники
# из raw/ по watermark и инкрементально дописывает страницы wiki/. Никакого
# bulk-rewrite: маленькие git-diff-правки, противоречия — через superseded
# (compiler/rules.md). Код-сессии сжимаются в accomplishment/capability (ADR-0010).
COMPILE_PROMPT_TEMPLATE = """\
Ты — компилятор персональной LLM-wiki «Второй мозг». Сейчас {now}.

КОНТЕКСТ: у тебя workspace-write на приватный контент-репо. Перед любой правкой
прочитай контракт хранителя: {rules_path} и {agents_path} (мандат чтения,
анатомия страниц, негативная память, дедуп).

ЗАДАЧА (ночная компиляция / событийный re-compile):
1. Найди НЕ скомпилированные ещё источники в {raw_dir} (ориентируйся на watermark
   per-source; не перечитывай уже учтённое — идемпотентность).
2. Инкрементально обнови/создай страницы в {wiki_dir} строго по {rules_path}:
   - концепции/идеи/развитие — first-class; технические код-сессии СЖИМАЙ в
     accomplishment-выжимку («что предметно сделал», навык) и агрегируй в
     capability-profile — НЕ копируй код verbatim (ADR-0010);
   - новые факты — с массивом claims и источником; противоречия — через
     `status: superseded`, НЕ перезаписью; не воскрешай негативную память;
   - дедуп: ищи существующую страницу человека/идеи перед созданием новой.
3. Каждая правка — маленький ревьюабельный git-diff; блоки `<!-- keep -->` не трогай;
   НИКАКОГО автономного bulk-rewrite (error-propagation, compiler/rules.md §0).
4. Подвинь watermark источников после успешной записи.

ИНВАРИАНТЫ: даты ISO; sanitizer уже прогнан на этапе ингеста — секреты/PII в прозу
не добавляй; обнови `wiki/index.md`, если появились новые страницы.

ВЕРНИ В ОТВЕТЕ: одну короткую строку-сводку «скомпилировано: N источников, +M
страниц, обновлено K» (для лога routine). Сам контент — в файлах, не в ответе.
"""

# routine lint (еженедельно). Две части: (а) детерминированный PII/секрет-скан
# публичного репо делает Python (lint_public, см. run_lint ниже), (б) движок
# проводит СОДЕРЖАТЕЛЬНЫЙ аудит ВИКИ — противоречия, протухшее, orphan-страницы —
# и чинит мягко (status, superseded, ссылки), без bulk-rewrite (compiler/rules.md §0).
LINT_PROMPT_TEMPLATE = """\
Ты — линтёр-хранитель персональной LLM-wiki «Второй мозг». Сейчас {now}.

КОНТЕКСТ: workspace-write на приватный контент-репо. Контракт — {rules_path}.

ЗАДАЧА (еженедельный лёгкий аудит вики, БЕЗ bulk-rewrite):
1. Противоречия: страницы с конфликтующими claim'ами — пометь младший
   `status: superseded` со ссылкой на актуальный (НЕ перезаписывай факты).
2. Протухшее (stale): страницы с давним `last_updated` и явно устаревшим фактом —
   `status: stale`; не удаляй.
3. Orphans: страницы без входящих ссылок / отсутствующие в `wiki/index.md` —
   допиши ссылку в index.md и в релевантные `## Связанные`.
4. Битые относительные ссылки — почини путь.
Делай ТОЧЕЧНЫЕ правки (маленькие git-diff). Спорные случаи НЕ трогай — вынеси
строкой в ответ для ручного решения владельцем.

ВЕРНИ В ОТВЕТЕ: короткий отчёт «противоречий: N, stale: M, orphans: K,
битых ссылок: L; на ручное решение: …». Этот текст уйдёт владельцу в Telegram.
"""

# routine research (по расписанию). Движок берёт пользовательские запросы и для
# каждого делает web-research (через web/computer-MCP — «руки» Claude, ADR-0008),
# пишет структурированный конспект файлом в wiki/research/ и возвращает короткую
# сводку для пуша. Egress (Telegram) — наш, не движка.
RESEARCH_PROMPT_TEMPLATE = """\
Ты — research-ассистент персональной LLM-wiki «Второй мозг». Сейчас {now}.

ПОЛЬЗОВАТЕЛЬСКИЕ ЗАПРОСЫ (из {queries_path}, по одному на строку):
{queries_block}

ЗАДАЧА (плановый web-research):
1. Для каждого запроса проведи web-research своими «руками» (web/computer-MCP):
   собери актуальные факты из надёжных источников, сверь, отметь даты.
2. На каждый запрос создай/обнови файл-конспект в {research_out_dir}:
   frontmatter (`title`, `type: research`, `status: active`, `last_updated`,
   `sources:` со ссылками), затем сжатый разбор + вывод. Свяжи с релевантными
   страницами вики (`## Связанные`), если они есть.
3. НЕ копируй простыни — конспектируй; различай факт и мнение; цитируй источники.

ВЕРНИ В ОТВЕТЕ: короткий дайджест на русском (по 1–2 строки на запрос: главный
вывод + ссылка на файл-конспект). Telegram-Markdown, до ~1500 символов. Если
запросов нет — верни ровно `NO_DIGEST`. Этот текст уйдёт владельцу в Telegram.

ИНВАРИАНТЫ: даты ISO; в конспекты не пиши секреты/токены; правки инкрементальные.
"""

# routine resurface (idea-resurfacing, лёгкий вариант). Базовый механизм всплытия
# — записи kind=spaced в reminders.md (лесенка Leitner [1,3,7,16,35]), их выводит
# routine digest. Эта отдельная routine — для «подтолкнуть» возврат к идее: движок
# выбирает давно не тронутую идею из wiki/ideas/ и формулирует короткий вопрос.
RESURFACE_PROMPT_TEMPLATE = """\
Ты — слой idea-resurfacing персональной LLM-wiki «Второй мозг». Сейчас {now}.

КОНТЕКСТ: workspace-write на приватный контент-репо. Идеи живут в {wiki_dir}/ideas/.

ЗАДАЧА:
1. Просмотри идеи в {wiki_dir}/ideas/ и выбери 1–2 давно не тронутые (старый
   `last_updated`), которые СТОИТ освежить (ещё актуальны, не помечены drop/done).
2. Для каждой сформулируй одну дружелюбную строку «всплыла идея: <название> —
   <почему важна / следующий маленький шаг>, ещё актуальна?».
3. Если по идее уже есть spaced-reminder — не дублируй (она всплывёт через digest);
   выбирай только идеи БЕЗ активного spaced-напоминания.

ВЕРНИ В ОТВЕТЕ: эти 1–2 строки (то, что уйдёт владельцу в Telegram), или ровно
`NO_DIGEST`, если освежать нечего. Файлы вики не меняй — это мягкий nudge.
"""


# ---------------------------------------------------------------------------
# Реализации routine'ов
# ---------------------------------------------------------------------------


def _now_str(now: dt.datetime) -> str:
    return now.strftime("%Y-%m-%d %H:%M %Z")


def run_compile(cfg: RoutineConfig, *, now: dt.datetime, dry_run: bool) -> int:
    """routine compile — ночная/событийная компиляция raw/ → wiki/. Правит файлы
    сам движок (workspace-write); в Telegram НЕ пушим (push_summary=False)."""
    prompt = COMPILE_PROMPT_TEMPLATE.format(
        now=_now_str(now),
        raw_dir=cfg.raw_dir,
        wiki_dir=cfg.wiki_dir,
        rules_path=cfg.public_repo / "compiler" / "rules.md",
        agents_path=cfg.public_repo / "AGENTS.md",
    )
    return _run_engine_routine(prompt, dry_run=dry_run, push_summary=False, label="compile")


def run_digest(cfg: RoutineConfig, *, now: dt.datetime, dry_run: bool) -> int:
    """routine digest — утренний дайджест + напоминания. ДЕЛЕГИРУЕТ в
    scheduler.digest.run_sweep (там дешёвый предчек что-due, спавн движка только
    если есть due, last-mile guard и owner-push). Здесь не дублируем логику."""
    return _digest.run_sweep(cfg, now=now, dry_run=dry_run)


def run_lint(cfg: RoutineConfig, *, now: dt.datetime, dry_run: bool) -> int:
    """routine lint — еженедельно. Сначала ДЕТЕРМИНИРОВАННЫЙ PII/секрет-скан
    публичного репо (scheduler.lint_public — exit≠0 при находке секрета/PII), затем
    движок проводит содержательный аудит ВИКИ (противоречия/stale/orphans)."""
    # (а) PII/секрет-скан публичного репо — чистый Python, без движка.
    from scheduler import lint_public

    offences = lint_public.lint(cfg.public_repo.resolve())
    if offences:
        # Нашли секрет/PII в публичном репо — это блокирующая находка. Печатаем и
        # выходим НЕнулевым: routine отметит сбой, владелец чинит границу репо.
        print(
            f"FAIL: публичный репо НЕ чист — {len(offences)} нарушение(й) (см. lint_public):",
            file=sys.stderr,
        )
        for off in offences:
            print("  " + off.render(cfg.public_repo.resolve()), file=sys.stderr)
        if not dry_run:
            return 1

    # (б) Содержательный аудит вики движком.
    prompt = LINT_PROMPT_TEMPLATE.format(
        now=_now_str(now),
        rules_path=cfg.public_repo / "compiler" / "rules.md",
    )
    rc = _run_engine_routine(prompt, dry_run=dry_run, push_summary=True, label="lint")
    # Если PII-скан нашёл проблему в dry_run — всё равно сигналим её кодом 1.
    return 1 if offences else rc


def _read_research_queries(path: Path) -> list[str]:
    """Прочитать пользовательские research-запросы. Формат — markdown-список:
    строки `- <запрос>` (или `* <запрос>`). Пустой/отсутствующий файл = нет тем."""
    if not path.exists():
        return []
    queries: list[str] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line.startswith(("- ", "* ")):
            q = line[2:].strip()
            if q:
                queries.append(q)
    return queries


def run_research(cfg: RoutineConfig, *, now: dt.datetime, dry_run: bool) -> int:
    """routine research — плановый web-research пользовательских запросов. Движок
    делает research «руками» (web/computer-MCP), пишет конспекты в wiki/research/
    и возвращает дайджест → owner-push. Нет запросов → выходим без спавна."""
    queries = _read_research_queries(cfg.research_queries)
    if not queries:
        _log.info("research-no-queries", path=str(cfg.research_queries))
        return 0
    queries_block = "\n".join(f"- {q}" for q in queries)
    prompt = RESEARCH_PROMPT_TEMPLATE.format(
        now=_now_str(now),
        queries_path=cfg.research_queries,
        queries_block=queries_block,
        research_out_dir=cfg.research_out_dir,
    )
    return _run_engine_routine(prompt, dry_run=dry_run, push_summary=True, label="research")


def run_resurface(cfg: RoutineConfig, *, now: dt.datetime, dry_run: bool) -> int:
    """routine resurface — мягкий idea-resurfacing-nudge. Базовое всплытие идёт
    через spaced-записи в digest; эта routine — отдельный лёгкий «всплыви идею»."""
    prompt = RESURFACE_PROMPT_TEMPLATE.format(
        now=_now_str(now),
        wiki_dir=cfg.wiki_dir,
    )
    return _run_engine_routine(prompt, dry_run=dry_run, push_summary=True, label="resurface")


# ---------------------------------------------------------------------------
# Реестр routine'ов (имя → реализация + краткое описание для --list)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Routine:
    name: str
    runner: Callable[..., int]
    summary: str  # одна строка для --list / каталога


ROUTINES: dict[str, Routine] = {
    "compile": Routine(
        "compile",
        run_compile,
        "ночь/событие: новые источники raw/ → страницы wiki/ (инкрементально)",
    ),
    "digest": Routine(
        "digest",
        run_digest,
        "утро: due-напоминания + дни рождения → один Telegram-дайджест",
    ),
    "lint": Routine(
        "lint",
        run_lint,
        "еженедельно: PII-скан публичного репо + аудит вики (противоречия/stale/orphans)",
    ),
    "research": Routine(
        "research",
        run_research,
        "по расписанию: research/queries.md → web-research → wiki/research/ + Telegram",
    ),
    "resurface": Routine(
        "resurface",
        run_resurface,
        "idea-resurfacing: всплытие спящих идей (база — spaced-записи в digest)",
    ),
}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="scheduler.routines",
        description="Диспетчер плановых routine'ов «Второго мозга» (Claude-native, ADR-0008).",
    )
    p.add_argument(
        "routine",
        nargs="?",
        choices=sorted(ROUTINES),
        help="Какую routine запустить (см. --list).",
    )
    p.add_argument("--list", action="store_true", help="Показать каталог routine'ов и выйти.")
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Собрать промпт/посчитать вход, но НЕ звать движок и НЕ слать в Telegram.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_argparser().parse_args(argv)

    if args.list or not args.routine:
        print("Каталог routine'ов «Второго мозга» (Claude-native, claude -p):\n")
        for name in sorted(ROUTINES):
            print(f"  {name:<10} — {ROUTINES[name].summary}")
        print(
            "\nЗапуск: python -m scheduler.routines <name> [--dry-run]\n"
            "Расписания и два варианта планировщика (launchd / remote routines): "
            "scheduler/routines/README.md"
        )
        return 0 if args.list else 2

    cfg = RoutineConfig()
    now = dt.datetime.now().astimezone()
    return ROUTINES[args.routine].runner(cfg, now=now, dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
