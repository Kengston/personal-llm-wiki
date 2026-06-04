"""digest.py — проактивный «sweep»: due-напоминания → digest → push в Telegram.

ЧТО ЭТО
=======
Это одна из плановых routine'ов проактивного слоя (см. routines/README.md —
КАТАЛОГ ROUTINES, routine #2 «утренний дайджест + напоминания»). Запускается по
расписанию: локально через launchd (ru.secondbrain.digest.plist + run_sweep.sh)
ИЛИ как remote Claude routine, работающая над приватным GitHub-репо даже при
спящем Mac (см. routines/README.md и README.md — «два варианта планировщика»).
По ADR-0007 §2 и research/proactive-scheduling.md планировщик — ИДЕМПОТЕНТНЫЙ
SWEEP, не таймер-на-напоминание: один запуск читает ВСЕ due-элементы, составляет
ОДИН Telegram-digest, пушит его владельцу и помечает сработавшие элементы.
launchd коалесцирует пропущенные интервалы в одно событие при пробуждении —
поэтому sweep обязан быть safe-to-run-twice (дедуп по status/last_fired живёт в
reminders.py).

ДВИЖОК — CLAUDE-NATIVE (ADR-0008/0009). Дайджест составляет тот же движок, что и
реактивный мост: официальный бинарь `claude -p --output-format json` за
портируемой абстракцией `Engine` (дефолт `ClaudeEngine`). Мы НЕ дублируем спавн —
переиспользуем bridge.engine (один шов движка на всю систему). `GrokEngine`/
`CodexEngine` — отложенные адаптеры-слоты, sweep их подхватит без правок, если
мост сделает их дефолтом.

ПОТОК (research «Запуск движка как в реактивном мосте»)
  1. ДЕШЁВЫЙ ПРЕДЧЕК (чистый Python, без движка): reminders.collect_due_items()
     парсит приватный reminders/reminders.md + дни рождения из wiki/ и считает,
     что due сегодня/скоро. Если пусто — ВЫХОДИМ, не поднимая движок (экономим
     месячный Agent-SDK-кредит Claude, ADR-0009; research: «дешёвый
     anything-due-предчек перед спавном движка»).
  2. СПАВН ДВИЖКА: если есть due — зовём bridge.engine (та же портируемая
     абстракция `Engine`, что у реактивного моста, ADR-0008) с
     reminder-sweep-промптом. Движок stateless (session_id=None) — проактив без
     диалоговой непрерывности (новая сессия `claude -p` без `--resume`).
     Движок видит уже-посчитанный due-список + читает приватные reminders/wiki и
     СОСТАВЛЯЕТ короткий человеческий digest (приоритезирует, группирует, добавляет
     контекст из вики — «подарок Ивану ещё не куплен»).
  3. PUSH: bridge.telegram отправляет digest владельцу (Bot API sendMessage).
     Движок side-effect-free — HTTP-вызов делает ЭТОТ скрипт после выхода
     `claude -p` (research: «Telegram-вызов делает мост/планировщик, не движок» —
     движок остаётся портируемым и без egress-инструмента; см. lethal-trifecta в
     privacy-security.md / ADR-0007 §risks).
  4. POST-ОБРАБОТКА: помечаем сработавшие reminders (last_fired=now; recurring →
     продвигаем due_at по rrule; spaced → продвигаем ступень Leitner; oneoff →
     status=done) и дописываем строку в reminders/log.md. Это сам движок делает
     через правку файлов (у него workspace-write на приватный репо, ADR-0007), а
     скрипт лишь fallback-журналирует факт пуша.

ГРАНИЦЫ
- Импортируем sanitizer ТОЛЬКО для финальной проверки исходящего текста
  (`scan_secrets`) — last-mile guard, чтобы ни токен, ни ключ не утёк даже в
  личный Telegram-чат. Сам digest — про личные данные (это приватный путь), но
  СЕКРЕТЫ (токены/ключи) в пуш попадать не должны никогда.
- bridge.engine / bridge.telegram импортируются ЛЕНИВО внутри функций: эти модули
  пишет смежный агент параллельно, и мы не хотим, чтобы простой `import digest`
  (или прогон unit-тестов на reminders-логику) падал, если bridge ещё не на диске.
  Контракт, на который мы рассчитываем, задокументирован в _load_engine()/_load_telegram().

ЗАПУСК (примеры)
  python -m scheduler.digest                 # боевой sweep (читает .env, зовёт claude -p)
  python -m scheduler.digest --dry-run       # посчитать due и собрать промпт, но
                                             #   НЕ звать движок и НЕ слать в Telegram
  python -m scheduler.digest --print-due     # только показать due-список (предчек)
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import sys
from pathlib import Path

# Sanitizer — ШАРЕНЫЙ из ingest, НЕ переопределяем (правило брифа). Это last-mile
# guard: ни один секрет не должен уйти в исходящее сообщение.
from ingest.sanitizer import scan_secrets

from scheduler.reminders import DueItem, collect_due_items

# --- structlog (мягкая зависимость) ----------------------------------------
# Мост использует structlog; переиспользуем его, если установлен, иначе тихий
# fallback на stdlib logging, чтобы scheduler запускался даже до установки
# зависимостей моста (правило: реальный, запускаемый код).
try:  # pragma: no cover - тривиальный выбор логгера
    import structlog

    _log = structlog.get_logger("scheduler.digest")
except Exception:  # pragma: no cover
    import logging

    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    class _ShimLogger:
        """Мини-шим под structlog-стиль `log.info("event", key=value, ...)` поверх
        stdlib logging — чтобы digest.py запускался и БЕЗ установленного structlog
        (он — зависимость моста; scheduler должен работать standalone). Рендерим
        kwargs как `key=value` в конец сообщения, как делает structlog-консоль."""

        def __init__(self, name: str) -> None:
            self._inner = logging.getLogger(name)

        def _emit(self, level: int, event: str, **kw: object) -> None:
            if kw:
                extras = " ".join(f"{k}={v!r}" for k, v in kw.items())
                self._inner.log(level, "%s %s", event, extras)
            else:
                self._inner.log(level, "%s", event)

        def info(self, event: str, **kw: object) -> None:
            self._emit(logging.INFO, event, **kw)

        def warning(self, event: str, **kw: object) -> None:
            self._emit(logging.WARNING, event, **kw)

        def error(self, event: str, **kw: object) -> None:
            self._emit(logging.ERROR, event, **kw)

    _log = _ShimLogger("scheduler.digest")


# ---------------------------------------------------------------------------
# Конфиг из окружения (.env приватного репо; см. .env.example там)
# ---------------------------------------------------------------------------


class Config:
    """Пути и параметры sweep. Всё — через env (host-portable, ADR-0005):
    никаких хардкод-путей, чтобы переезд на Mac Mini/VPS не требовал правок кода."""

    def __init__(self) -> None:
        # Корень ПРИВАТНОГО контент-репо (raw/ + wiki/ + reminders/).
        self.content_root = Path(
            os.environ.get("CONTENT_ROOT", str(Path.home() / "llm-wiki-content"))
        )
        self.reminders_path = Path(
            os.environ.get(
                "REMINDERS_PATH", str(self.content_root / "reminders" / "reminders.md")
            )
        )
        self.wiki_dir = Path(
            os.environ.get("WIKI_DIR", str(self.content_root / "wiki"))
        )
        self.reminders_log = Path(
            os.environ.get(
                "REMINDERS_LOG", str(self.content_root / "reminders" / "log.md")
            )
        )
        # Окна due/lookahead — конфигурируемы, дефолты из reminders.py.
        self.lookahead_days = int(os.environ.get("DIGEST_LOOKAHEAD_DAYS", "7"))
        self.grace_minutes = int(os.environ.get("DIGEST_GRACE_MINUTES", "5"))
        # Тихий пуш для low-priority (idea-resurfacing) — research упоминает
        # disable_notification для не-срочного; полностью-upcoming digest шлём тихо.
        self.quiet_when_only_upcoming = (
            os.environ.get("DIGEST_QUIET_UPCOMING", "true").lower() == "true"
        )

    @property
    def lookahead(self) -> dt.timedelta:
        return dt.timedelta(days=self.lookahead_days)

    @property
    def grace(self) -> dt.timedelta:
        return dt.timedelta(minutes=self.grace_minutes)


# ---------------------------------------------------------------------------
# Ленивые загрузчики мостовых компонентов (контракт ADR-0008/0009)
# ---------------------------------------------------------------------------
#
# ПОЧЕМУ ПЕРЕИСПОЛЬЗУЕМ bridge.engine, А НЕ СПАВНИМ claude САМИ:
# движок — ОДИН шов на всю систему (ADR-0008): и реактивный мост, и плановые
# routine'ы зовут официальный бинарь `claude -p --output-format json` через одну
# абстракцию `Engine` (дефолт `ClaudeEngine`). Если бы scheduler спавнил claude
# своим кодом, мы бы задвоили логику парсинга JSON/таймаутов/resume и разошлись
# с мостом при смене адаптера (на `GrokEngine`/`CodexEngine` — отложенные слоты).
# Поэтому грузим то, что экспортит смежный bridge/engine.py, и нормализуем форму.


def _normalize_engine_result(result) -> tuple[str, str | None, object]:
    """Привести результат хода движка к (answer, session_id, usage).

    Мост (ADR-0008) отдаёт dataclass `EngineResult(answer, session_id, usage,
    is_error)`. Но чтобы не зависеть от точной формы экспорта смежного агента,
    принимаем ещё и legacy-кортеж `(answer, session_id, usage)` / объект с полями.
    """
    # Форма 1 (штатная): EngineResult-подобный объект с атрибутом .answer.
    if hasattr(result, "answer"):
        return (
            getattr(result, "answer") or "",
            getattr(result, "session_id", None),
            getattr(result, "usage", None),
        )
    # Форма 2 (legacy): кортеж/список (answer, session_id, usage).
    if isinstance(result, (tuple, list)):
        answer = result[0] if len(result) >= 1 else ""
        session_id = result[1] if len(result) >= 2 else None
        usage = result[2] if len(result) >= 3 else None
        return (answer or "", session_id, usage)
    # Форма 3: движок вернул просто строку-ответ.
    return (str(result or ""), None, None)


def _as_sync_runner(run_callable):
    """Обернуть `Engine.run` (часто КОРУТИНА — мост async, ADR-0008) в простой
    синхронный вызов `runner(prompt, session_id) -> (answer, session_id, usage)`.

    scheduler.digest — синхронный launchd-/routine-скрипт; мост же async. Если
    `.run()` возвращает корутину, гоняем её через `asyncio.run` (свежий event-loop
    на один ход — мы вне работающего loop'а). Иначе зовём как есть."""
    import asyncio
    import inspect

    def _runner(prompt: str, session_id: str | None = None):
        out = run_callable(prompt, session_id)
        if inspect.isawaitable(out):
            out = asyncio.run(out)
        return _normalize_engine_result(out)

    return _runner


def _load_engine():
    """Вернуть синхронный callable движка `runner(prompt, session_id|None)`
    -> (answer, new_session_id, usage). Это шов портируемости ADR-0008: мост и
    планировщик строятся вокруг ОДНОЙ абстракции `Engine`, смена движка
    (Claude → Grok/Codex) — смена адаптера в мосте, не переписывание scheduler.

    Движок v1 — Claude-native: официальный `claude -p --output-format json`
    (ADR-0008/0009). Предпочтения при загрузке смежного `bridge/engine.py`
    (от самого вероятного к fallback'ам):
      1. `build_engine_from_env()` — фабрика моста: соберёт активный движок из
         .env (дефолт `ClaudeEngine`). ПРЕДПОЧТИТЕЛЬНО — единый источник конфига.
      2. класс `ClaudeEngine` (дефолтный адаптер) с `.run(prompt, session_id=None)`.
      3. классы отложенных адаптеров `GrokEngine` / `CodexEngine` (слоты).
      4. модульная функция `run_engine(prompt, session_id=None)` (legacy-форма).
    Так мы устойчивы к тому, как именно смежный агент оформит экспорт, и НЕ
    хардкодим конкретный движок — он определяется конфигом моста.
    """
    from bridge import engine as _engine  # ленивый импорт (см. док модуля)

    # 1. Фабрика моста — предпочтительно: собирает АКТИВНЫЙ движок из .env (дефолт
    #    ClaudeEngine), один источник истины для выбора адаптера.
    if hasattr(_engine, "build_engine_from_env"):
        inst = _engine.build_engine_from_env()  # type: ignore[attr-defined]
        return _as_sync_runner(
            lambda prompt, session_id=None: inst.run(prompt, session_id)
        )

    # 2–3. Прямые классы адаптеров в порядке предпочтения: дефолтный ClaudeEngine,
    #      затем отложенные слоты Grok/Codex (на случай, если фабрики ещё нет).
    for cls_name in ("ClaudeEngine", "GrokEngine", "CodexEngine"):
        cls = getattr(_engine, cls_name, None)
        if cls is not None:
            inst = cls()
            return _as_sync_runner(
                lambda prompt, session_id=None: inst.run(prompt, session_id)
            )

    # 4. Legacy-форма: модульная функция run_engine(prompt, session_id|None).
    if hasattr(_engine, "run_engine"):
        return _as_sync_runner(_engine.run_engine)  # type: ignore[attr-defined]

    raise ImportError(
        "bridge.engine не экспортирует ни build_engine_from_env, ни ClaudeEngine/"
        "GrokEngine/CodexEngine, ни run_engine — проверь контракт ADR-0008 "
        "(Engine.run(prompt, session_id|None) -> EngineResult; дефолт ClaudeEngine)."
    )


def _load_telegram():
    """Вернуть callable отправки в Telegram: send(text, disable_notification=False).

    Принимаем обе формы смежного `bridge/telegram.py`:
      - класс `TelegramClient(...)` с `.send_message(text, ...)`;
      - либо модульная функция `send_message(text, ...)`.
    Клиент сам берёт TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_CHAT_ID из env
    (секреты только в приватном .env — никогда в этом публичном репо).
    """
    from bridge import telegram as _tg  # ленивый импорт

    if hasattr(_tg, "TelegramClient"):
        client = _tg.TelegramClient()  # type: ignore[attr-defined]

        def _send(text: str, disable_notification: bool = False):
            return client.send_message(text, disable_notification=disable_notification)

        return _send
    if hasattr(_tg, "send_message"):
        return _tg.send_message  # type: ignore[attr-defined]
    raise ImportError(
        "bridge.telegram не экспортирует ни TelegramClient, ни send_message."
    )


# ---------------------------------------------------------------------------
# Построение sweep-промпта для движка
# ---------------------------------------------------------------------------


def render_due_list(items: list[DueItem]) -> str:
    """Отрендерить уже-посчитанный due-список в компактный markdown для промпта.
    Движок получает это как ФАКТЫ (детерминированно посчитанные нами), чтобы не
    пересчитывать даты сам и не галлюцинировать — он только формулирует digest."""
    if not items:
        return "_(ничего не due)_"
    lines: list[str] = []
    for it in items:
        when = it.due_at.strftime("%Y-%m-%d %H:%M")
        tag = "СКОРО" if it.upcoming else "СЕГОДНЯ"
        extra = f" — {it.detail}" if it.detail else ""
        lines.append(
            f"- [{tag}] `{it.id}` ({it.kind}, {it.source}): {it.title} @ {when}{extra}"
        )
    return "\n".join(lines)


# Reminder-sweep-промпт. По research/proactive-scheduling.md движку говорим:
# прочитать reminders-файл + вику, взять всё due, составить ОДИН digest, и
# обновить сработавшие записи. Due-список мы УЖЕ посчитали детерминированно и
# передаём как опору — движок приоритезирует/обогащает, но не пересчитывает даты.
SWEEP_PROMPT_TEMPLATE = """\
Ты — проактивный слой персональной LLM-wiki «Второй мозг». Сейчас {now}.

Тебе передан УЖЕ ПОСЧИТАННЫЙ (детерминированно, кодом) список напоминаний,
которые наступают сегодня или в ближайшие {lookahead_days} дн. Это факты —
НЕ пересчитывай даты сам, опирайся на них:

{due_list}

ЗАДАЧА:
1. Прочитай приватные файлы для контекста (у тебя доступ к репозиторию):
   - reminders-файл: {reminders_path}
   - вики о пользователе: {wiki_dir}
   Сопоставь due-элементы с тем, что знаешь из вики (например: подарок ещё не
   выбран? встреча с кем и о чём? идея, которую стоит освежить — почему она важна?).
2. Составь ОДИН короткий дружелюбный дайджест на русском для Telegram:
   - сгруппируй: сначала «сегодня», затем «скоро»;
   - дни рождения/годовщины — с подсказкой к действию (поздравить, подарок);
   - встречи — со временем и сутью;
   - идеи к возврату (spaced) — одной строкой «всплыла идея: …, ещё актуальна?»;
   - НЕ выдумывай элементы, которых нет в списке; если список пуст — верни ровно
     строку `NO_DIGEST`.
   - Telegram-Markdown: **жирный** для заголовков секций; компактно; без длинного
     тире. Уложись примерно в 1200 символов.
3. ОБНОВИ сработавшие записи в reminders-файле (это твоя зона записи):
   - oneoff, который наступил → `status: done`, `last_fired: {now_iso}`;
   - recurring → продвинь `due_at` к следующему вхождению по его `rrule`,
     поставь `last_fired: {now_iso}` (НЕ меняй сам rrule);
   - spaced (idea-resurfacing) → продвинь ступень Leitner [1,3,7,16,35]: увеличь
     `box` на 1 (потолок последней ступени), пересчитай `interval_days` по ступени,
     перезапиши `due_at = {now_iso} + interval_days`, поставь `last_fired`;
   - элементы со статусом `snoozed`, у которых срок ещё не настал — не трогай.
   Двигай `last_fired`/`due_at` ТОЛЬКО у тех, кто реально вошёл в дайджест как
   «сегодня» — это защищает от двойного пуша при повторном запуске (идемпотентность).
4. Допиши в журнал {reminders_log} строку формата:
   `## [{date_iso}] fired | <id-через-запятую> | <однострочное summary дайджеста>`
   (append-only, не переписывай прошлые строки).

ВЕРНИ В ОТВЕТЕ: только сам текст дайджеста (то, что уйдёт в Telegram), без
служебных комментариев. Если дайджест пуст — верни ровно `NO_DIGEST`.

ИНВАРИАНТЫ: даты только ISO; не пиши в reminders секреты/токены; правки —
инкрементальные (обычный git-diff), блоки `<!-- keep -->` не трогай.
"""


def build_sweep_prompt(cfg: Config, items: list[DueItem], now: dt.datetime) -> str:
    """Собрать финальный промпт для движка из конфига + посчитанного due-списка."""
    return SWEEP_PROMPT_TEMPLATE.format(
        now=now.strftime("%Y-%m-%d %H:%M %Z"),
        now_iso=now.isoformat(timespec="minutes"),
        date_iso=now.date().isoformat(),
        lookahead_days=cfg.lookahead_days,
        due_list=render_due_list(items),
        reminders_path=cfg.reminders_path,
        wiki_dir=cfg.wiki_dir,
        reminders_log=cfg.reminders_log,
    )


# ---------------------------------------------------------------------------
# Исходящая гигиена: last-mile sanitizer-проверка
# ---------------------------------------------------------------------------


def assert_no_secrets(text: str) -> None:
    """Fail-closed last-mile guard: если в исходящем тексте детектится секрет —
    НЕ отправляем (raise). Это путь к ВЛАДЕЛЬЦУ (приватный), личные данные тут
    допустимы; но токен/ключ/пароль в сообщении — почти наверняка случайная утечка
    из вики/лога, и его нельзя слать даже в личный чат (defense-in-depth, ADR-0003).
    Переиспользуем общий scan_secrets из ingest (не свой регексп)."""
    offenders = scan_secrets(text)
    if offenders:
        # Не печатаем сами значения секретов в лог — только их количество/типы.
        raise RuntimeError(
            f"digest заблокирован: scan_secrets нашёл {len(offenders)} "
            f"потенциальных секрет(ов) в исходящем тексте — отправка отменена."
        )


# ---------------------------------------------------------------------------
# Точка входа sweep
# ---------------------------------------------------------------------------


def run_sweep(
    cfg: Config | None = None,
    *,
    now: dt.datetime | None = None,
    dry_run: bool = False,
) -> int:
    """Выполнить один проактивный sweep. Возвращает exit-code (0 = ок).

    dry_run=True: посчитать due и собрать промпт, но НЕ звать движок и НЕ слать в
    Telegram (для проверки на машине без `claude`-бинаря/токена — правило: не
    исполнять проектный код в сборке, но скрипт должен быть запускаемым человеком).
    """
    cfg = cfg or Config()
    now = now or dt.datetime.now().astimezone()  # tz-aware локальное «сейчас»

    # --- 1. Дешёвый предчек: что вообще due? (без движка) -------------------
    items = collect_due_items(
        cfg.reminders_path,
        cfg.wiki_dir,
        now=now,
        grace=cfg.grace,
        lookahead=cfg.lookahead,
    )
    strictly_due = [it for it in items if not it.upcoming]
    _log.info(
        "due-precheck",
        total=len(items),
        strictly_due=len(strictly_due),
        upcoming=len(items) - len(strictly_due),
    )

    if not items:
        # Ничего не due — выходим, НЕ поднимая движок (экономия Agent-SDK-кредита
        # Claude, ADR-0009: лишний `claude -p` на каждом 30-мин тике расточителен).
        _log.info("nothing-due, skipping engine spawn")
        return 0

    prompt = build_sweep_prompt(cfg, items, now)

    if dry_run:
        # Печатаем промпт в stdout, чтобы человек/тест увидел, что ушло бы движку.
        print("=== DRY RUN: due-список ===")
        print(render_due_list(items))
        print("\n=== DRY RUN: sweep-промпт для движка ===")
        print(prompt)
        return 0

    # --- 2. Спавн движка (stateless: session_id=None) ----------------------
    try:
        run_engine = _load_engine()
    except ImportError as exc:
        _log.error("engine-unavailable", error=str(exc))
        return 2
    try:
        answer, _new_session_id, usage = run_engine(prompt, None)
    except Exception as exc:  # движок упал/таймаут/лимит — не роняем launchd-демона
        _log.error("engine-failed", error=str(exc))
        return 3
    _log.info("engine-completed", usage=str(usage))

    digest_text = (answer or "").strip()
    if not digest_text or digest_text == "NO_DIGEST":
        # Движок решил, что слать нечего (например, всё оказалось snoozed) — ок.
        _log.info("engine-returned-no-digest")
        return 0

    # --- 3. Last-mile sanitizer-проверка ИСХОДЯЩЕГО ------------------------
    assert_no_secrets(digest_text)

    # --- 4. Push владельцу --------------------------------------------------
    # Тихий пуш, если в дайджесте только «скоро» (низкий приоритет) — research.
    disable_notification = cfg.quiet_when_only_upcoming and not strictly_due
    try:
        send = _load_telegram()
        send(digest_text, disable_notification=disable_notification)
    except Exception as exc:
        _log.error("telegram-send-failed", error=str(exc))
        return 4
    _log.info(
        "digest-sent",
        chars=len(digest_text),
        disable_notification=disable_notification,
    )
    # Пометку last_fired/journal-строку делает сам движок правкой файлов (шаг 3–4
    # промпта). Скрипт намеренно НЕ дублирует запись в reminders.md, чтобы не
    # конфликтовать с диффом движка (один писатель — движок, ADR-0007).
    return 0


def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="scheduler.digest",
        description="Проактивный sweep: due-напоминания → digest → Telegram.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Посчитать due и собрать промпт, но не звать движок и не слать в Telegram.",
    )
    p.add_argument(
        "--print-due",
        action="store_true",
        help="Только показать посчитанный due-список (предчек) и выйти.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_argparser().parse_args(argv)
    cfg = Config()

    if args.print_due:
        now = dt.datetime.now().astimezone()
        items = collect_due_items(
            cfg.reminders_path, cfg.wiki_dir, now=now, grace=cfg.grace, lookahead=cfg.lookahead
        )
        print(render_due_list(items))
        return 0

    return run_sweep(cfg, dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
