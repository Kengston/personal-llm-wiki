"""
app.py — FastAPI-мост Telegram ↔ движок (дефолт Claude) для «Второго мозга».

Реактивный слой исполнения ([ADR-0004], [ADR-0008]): Telegram → bridge → движок.
Ремап проверенного pachca-codex-bridge-plan на Telegram. Поток:

    Telegram → CF Tunnel → POST /telegram/webhook/<nonce>
        → 3 слоя безопасности (secret-token header / owner chat_id / nonce в пути)
        → кладём update в asyncio.Queue, СРАЗУ отвечаем 200 (webhook не должен ждать движок)
        → worker берёт из очереди, single-flight на chat_id:
              session_id = store.get_session(chat_id)
              answer, new_sid, usage = engine.run(prompt, session_id)  # claude -p --output-format json
              store.upsert_session(chat_id, new_sid)
              telegram.send_message(chat_id, answer)

Почему очередь и быстрый 200: ход движка занимает секунды-десятки секунд; если
держать webhook открытым всё это время — Telegram отвалится по timeout и будет
ретраить update (дубли). Поэтому: принять → подтвердить → обработать асинхронно →
запушить ответ.

Безопасность (три слоя, docs/research/telegram-interface.md). Слой №2 — это и есть
жёсткий single-user-инвариант из [ADR-0009]: задачи движку шлёт ТОЛЬКО владелец:
  (1) заголовок `X-Telegram-Bot-Api-Secret-Token` — constant-time-сравнение
      (hmac.compare_digest) с TELEGRAM_WEBHOOK_SECRET;
  (2) hard allow-list: дропаем любой update, где chat.id != TELEGRAM_OWNER_CHAT_ID;
  (3) nonce/секрет в пути webhook — несовпадение → 404 (unsolicited POST отсекается).

[ADR-0004]: ../docs/adr/0004-telegram-bridge-reactive-proactive.md
[ADR-0008]: ../docs/adr/0008-engine-claude-native.md
[ADR-0009]: ../docs/adr/0009-tos-safe-engine-access.md
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass

import structlog
from fastapi import FastAPI, Header, Path, Request, Response, status

from engine import Engine, EngineError, build_engine_from_env
from store import SessionStore
from telegram import BotApiTelegramClient, TelegramClient

# --------------------------------------------------------------------------- #
# Логирование (structlog)                                                     #
# --------------------------------------------------------------------------- #


def _configure_logging() -> None:
    """
    Настроить structlog: структурированные логи в stdout (JSON в проде, иначе консоль).
    launchd перехватывает stdout/stderr в файлы (см. plist) — отдельная ротация не нужна.
    """
    log_json = os.environ.get("LOG_JSON", "1") == "1"
    renderer = (
        structlog.processors.JSONRenderer()
        if log_json
        else structlog.dev.ConsoleRenderer()
    )
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            renderer,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


_configure_logging()
log = structlog.get_logger("bridge.app")


# --------------------------------------------------------------------------- #
# Конфиг из окружения                                                         #
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class Settings:
    """Конфигурация моста из переменных окружения (.env загружается на старте)."""

    bot_token: str            # TELEGRAM_BOT_TOKEN — токен Bot API (исходящие)
    owner_chat_id: int        # TELEGRAM_OWNER_CHAT_ID — единственный разрешённый чат
    webhook_secret: str       # TELEGRAM_WEBHOOK_SECRET — secret-token header + nonce пути
    db_path: str              # путь к SQLite chat_sessions
    max_queue: int            # размер буфера asyncio.Queue
    workers: int              # число воркеров (для personal-use хватает 1–2)

    @classmethod
    def from_env(cls) -> "Settings":
        # Обязательные значения — без них мост не имеет смысла; падаем явно на старте.
        bot_token = _require_env("TELEGRAM_BOT_TOKEN")
        webhook_secret = _require_env("TELEGRAM_WEBHOOK_SECRET")
        owner_raw = _require_env("TELEGRAM_OWNER_CHAT_ID")
        try:
            owner_chat_id = int(owner_raw)
        except ValueError as exc:
            raise RuntimeError(
                f"TELEGRAM_OWNER_CHAT_ID должен быть числом, получено {owner_raw!r}"
            ) from exc
        return cls(
            bot_token=bot_token,
            owner_chat_id=owner_chat_id,
            webhook_secret=webhook_secret,
            db_path=os.environ.get("BRIDGE_DB_PATH", "chat_sessions.sqlite"),
            max_queue=int(os.environ.get("BRIDGE_QUEUE_SIZE", "100")),
            workers=int(os.environ.get("BRIDGE_WORKERS", "1")),
        )


def _require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(
            f"Не задана обязательная переменная окружения {name}. "
            f"Скопируй .env.example → .env и заполни (см. setup/SETUP.md)."
        )
    return value


# --------------------------------------------------------------------------- #
# Единица работы в очереди                                                    #
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class Job:
    """Распарсенная задача из webhook'а: чей чат и какой текст обрабатываем."""

    chat_id: int
    text: str


# --------------------------------------------------------------------------- #
# Состояние приложения (живёт в app.state)                                    #
# --------------------------------------------------------------------------- #


class BridgeState:
    """
    Собранные на старте зависимости моста + примитивы конкуренции.

    - engine / store / telegram — внедряемые компоненты (легко подменить в тестах).
    - queue — буфер входящих job'ов (webhook кладёт, воркеры разбирают).
    - chat_locks — single-flight на chat_id: гарантирует, что два сообщения в одном
      чате не гоняются за одной сессией одновременно (рекомендация engine-runtime.md).
    """

    def __init__(
        self,
        settings: Settings,
        engine: Engine,
        store: SessionStore,
        telegram: TelegramClient,
    ) -> None:
        self.settings = settings
        self.engine = engine
        self.store = store
        self.telegram = telegram
        self.queue: asyncio.Queue[Job] = asyncio.Queue(maxsize=settings.max_queue)
        self._chat_locks: dict[int, asyncio.Lock] = {}
        self._worker_tasks: list[asyncio.Task] = []

    def chat_lock(self, chat_id: int) -> asyncio.Lock:
        """Вернуть (создав при необходимости) lock single-flight для чата."""
        lock = self._chat_locks.get(chat_id)
        if lock is None:
            lock = asyncio.Lock()
            self._chat_locks[chat_id] = lock
        return lock


# --------------------------------------------------------------------------- #
# Воркер очереди                                                              #
# --------------------------------------------------------------------------- #


async def _worker(state: BridgeState, worker_id: int) -> None:
    """
    Бесконечный воркер: берёт Job из очереди и обрабатывает.

    Несколько воркеров разбирают РАЗНЫЕ чаты конкурентно (очередь не блокирует);
    внутри ОДНОГО чата ход сериализуется chat_lock'ом. Любая ошибка одного job'а
    не роняет воркер — логируем и едем дальше.
    """
    log.info("worker.started", worker_id=worker_id)
    while True:
        job = await state.queue.get()
        try:
            await _handle_job(state, job)
        except Exception:  # noqa: BLE001 - воркер обязан пережить любой сбой job'а
            log.exception("worker.job_failed", chat_id=job.chat_id)
        finally:
            state.queue.task_done()


async def _handle_job(state: BridgeState, job: Job) -> None:
    """
    Обработать один Job: показать «печатает…», прогнать движок (с 1 retry),
    сохранить сессию, отправить ответ. single-flight на chat_id.
    """
    # Команда /reset — забыть сессию (recovery, если resume сломался).
    if job.text.strip() == "/reset":
        await state.store.reset_session(job.chat_id)
        await state.telegram.send_message(job.chat_id, "Контекст диалога сброшен.")
        return

    # Индикатор «печатает…» сразу — маскирует латентность движка (секунды-десятки).
    await state.telegram.send_chat_action(job.chat_id, "typing")

    async with state.chat_lock(job.chat_id):
        # Берём текущую сессию чата (None → первый ход, движок создаст новую).
        session_id = await state.store.get_session(job.chat_id)
        try:
            result = await _run_engine_with_retry(state.engine, job.text, session_id)
        except EngineError as exc:
            # Дружелюбный ответ вместо stack-trace; деталь — в логах.
            log.warning("engine.failed", chat_id=job.chat_id, error=str(exc))
            await state.telegram.send_message(
                job.chat_id,
                "Не удалось обработать сообщение (движок недоступен или превышен "
                "лимит). Попробуй ещё раз чуть позже.",
            )
            return

        # Сохраняем (возможно новый) session_id, чтобы следующий ход шёл через resume.
        if result.session_id:
            await state.store.upsert_session(job.chat_id, result.session_id)

    # Отправку делаем ВНЕ chat_lock — сеть к Telegram не должна держать сессию.
    await state.telegram.send_message(job.chat_id, result.answer)
    log.info(
        "job.done",
        chat_id=job.chat_id,
        usage=result.usage,
        answer_chars=len(result.answer),
    )


async def _run_engine_with_retry(engine: Engine, prompt: str, session_id: str | None):
    """
    Один прогон движка с ОДНИМ retry на транзиентную ошибку (engine-runtime.md).

    Нетранзиентные ошибки (нет бинаря, auth, конфиг) — пробрасываем сразу: retry
    не поможет. На транзиентной (rate-limit/timeout/сеть) — короткий backoff и ещё
    одна попытка.
    """
    try:
        return await engine.run(prompt, session_id)
    except EngineError as exc:
        if not exc.transient:
            raise
        log.info("engine.retry", reason=str(exc))
        await asyncio.sleep(2.0)  # короткий backoff, не долбёжка
        return await engine.run(prompt, session_id)


# --------------------------------------------------------------------------- #
# Парсинг update Telegram                                                     #
# --------------------------------------------------------------------------- #


def _extract_job(update: dict, owner_chat_id: int) -> Job | None:
    """
    Вытащить Job из Telegram update.

    Возвращает None (update игнорируется), если:
      - это не текстовое сообщение (в v1 обрабатываем только текст; voice — OQ-2);
      - chat.id != owner_chat_id (слой №2 — hard allow-list владельца, single-user);
      - текст пустой.

    Поддерживаем message и edited_message; берём message.text (для voice/forward —
    позднее, см. telegram-interface.md).
    """
    message = update.get("message") or update.get("edited_message")
    if not isinstance(message, dict):
        return None

    chat = message.get("chat") or {}
    chat_id = chat.get("id")
    if not isinstance(chat_id, int):
        return None

    # Слой безопасности №2 — HARD allow-list владельца ([ADR-0009], single-user):
    # любой чужой chat_id жёстко дропаем (лог + игнор, без ответа). Это инвариант
    # «задачи движку шлёт только владелец»: мультиюзер = нарушение ToS-доступа к
    # подписке. Сравнение строгое по owner_chat_id из TELEGRAM_OWNER_CHAT_ID.
    if chat_id != owner_chat_id:
        log.warning("security.foreign_chat_dropped", chat_id=chat_id)
        return None

    text = message.get("text")
    if not isinstance(text, str) or not text.strip():
        # Не-текст (voice/photo/forward без текста) — в v1 не обрабатываем.
        return None

    return Job(chat_id=chat_id, text=text.strip())


# --------------------------------------------------------------------------- #
# Жизненный цикл приложения                                                   #
# --------------------------------------------------------------------------- #


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Старт/останов моста: собрать зависимости, поднять воркеры, на shutdown — закрыть.

    Зависимости можно переопределить ДО старта (тесты): положить готовый
    BridgeState в app.state.bridge — тогда фабрики из окружения не вызываются.
    """
    state: BridgeState | None = getattr(app.state, "bridge", None)
    if state is None:
        settings = Settings.from_env()
        state = BridgeState(
            settings=settings,
            engine=build_engine_from_env(),
            store=SessionStore(settings.db_path),
            telegram=BotApiTelegramClient(settings.bot_token),
        )
        app.state.bridge = state

    # Поднимаем пул воркеров очереди.
    for i in range(max(1, state.settings.workers)):
        task = asyncio.create_task(_worker(state, i), name=f"bridge-worker-{i}")
        state._worker_tasks.append(task)
    log.info(
        "bridge.started",
        workers=len(state._worker_tasks),
        owner_chat_id=state.settings.owner_chat_id,
    )

    try:
        yield
    finally:
        # Аккуратный shutdown: отменяем воркеры, закрываем store/telegram.
        for task in state._worker_tasks:
            task.cancel()
        for task in state._worker_tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
        await state.store.close()
        await state.telegram.aclose()
        log.info("bridge.stopped")


app = FastAPI(title="Второй мозг — Telegram×Claude bridge", lifespan=lifespan)


# --------------------------------------------------------------------------- #
# Эндпоинты                                                                   #
# --------------------------------------------------------------------------- #


@app.get("/health")
async def health() -> dict:
    """
    Health-чек: жив ли мост + видит ли он Telegram (getMe) + сколько в очереди.

    Используется launchd/UptimeRobot и smoke-тестом из setup/SETUP.md.
    Деградирует мягко: если getMe не прошёл — status=degraded, но 200 (мост жив).
    """
    state: BridgeState | None = getattr(app.state, "bridge", None)
    if state is None:
        return {"status": "starting"}

    telegram_ok = True
    bot_username: str | None = None
    try:
        me = await state.telegram.get_me()
        bot_username = me.get("username")
    except Exception as exc:  # noqa: BLE001 - health не должен падать
        telegram_ok = False
        log.warning("health.telegram_unreachable", error=str(exc))

    return {
        "status": "ok" if telegram_ok else "degraded",
        "telegram_ok": telegram_ok,
        "bot": bot_username,
        "queue_size": state.queue.qsize(),
        "workers": len(state._worker_tasks),
    }


@app.post("/telegram/webhook/{nonce}")
async def telegram_webhook(
    request: Request,
    nonce: str = Path(..., description="Секрет в пути URL (слой безопасности №3)"),
    x_telegram_bot_api_secret_token: str | None = Header(default=None),
) -> Response:
    """
    Входящий webhook Telegram. Три слоя безопасности, затем — в очередь.

    Возвращает 200 СРАЗУ после постановки в очередь (не ждём движок), иначе Telegram
    отвалится по timeout и заретраит update. На отвергнутых по безопасности запросах
    отдаём 404 (не палим существование эндпоинта).
    """
    state: BridgeState = app.state.bridge
    secret = state.settings.webhook_secret

    # Слой №3: nonce в пути. Несовпадение → 404 (unsolicited POST отсекается).
    if not hmac.compare_digest(nonce, secret):
        log.warning("security.bad_path_nonce")
        return Response(status_code=status.HTTP_404_NOT_FOUND)

    # Слой №1: secret-token header (constant-time-сравнение против timing-атак).
    if x_telegram_bot_api_secret_token is None or not hmac.compare_digest(
        x_telegram_bot_api_secret_token, secret
    ):
        log.warning("security.bad_secret_token")
        return Response(status_code=status.HTTP_404_NOT_FOUND)

    # Тело update.
    try:
        update = await request.json()
    except Exception:  # noqa: BLE001 - кривой JSON → молча игнор (200, без ретраев)
        log.warning("webhook.bad_json")
        return Response(status_code=status.HTTP_200_OK)

    # Слой №2 (allow-list владельца) + парсинг применяются здесь.
    job = _extract_job(update, state.settings.owner_chat_id)
    if job is None:
        # Не наш чат / не текст / пусто — тихо подтверждаем (Telegram не ретраит).
        return Response(status_code=status.HTTP_200_OK)

    # Ставим в очередь без блокировки. Если очередь переполнена — не вешаем webhook:
    # логируем backpressure и всё равно отвечаем 200 (дроп лучше, чем лавина ретраев).
    try:
        state.queue.put_nowait(job)
    except asyncio.QueueFull:
        log.error("webhook.queue_full", chat_id=job.chat_id)
        # Best-effort уведомление владельца, что мост перегружен.
        try:
            await state.telegram.send_message(
                job.chat_id, "Я сейчас перегружен, попробуй через минуту."
            )
        except Exception:  # noqa: BLE001
            pass
        return Response(status_code=status.HTTP_200_OK)

    return Response(status_code=status.HTTP_200_OK)
