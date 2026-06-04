"""
engine.py — портируемый шов движка «Второго мозга».

Это центр портируемости моста ([ADR-0008], [ADR-0007]). Весь остальной код
(app.py / scheduler) знает движок ТОЛЬКО через абстрактный контракт `Engine`:

    answer, new_session_id, usage = await engine.run(prompt, session_id)

Сменить движок (Claude → Grok → Codex → локальную модель) — это написать/включить
другой адаптер `Engine`, а НЕ переписывать мост. В v1 дефолт и единственный включённый
адаптер — `ClaudeEngine` (официальный бинарь `claude -p`, ToS-safe — [ADR-0009]).
`GrokEngine` и `CodexEngine` — готовые ОТЛОЖЕННЫЕ адаптеры-слоты: код есть, выбираются
переменной окружения `ENGINE`, включаются осознанно.

Жёсткие правила движка (из docs/research/engine-runtime.md и [ADR-0007]):

- **Spawn-fresh-per-task.** Один короткоживущий процесс движка НА задачу, затем он
  выходит. Никакого резидентного демона: живая сессия рискует упасть на истечении
  токена и не подхватывает обновлённый auth.
- **Resume по chat.** Первый ход чата — без resume; парсим `session_id` из ответа и
  персистим его в store (store.py). Следующий ход того же чата идёт через resume по
  этому id, чтобы движок продолжил диалог.
- **Жёсткий timeout + kill** дочернего процесса; один retry на транзиентную ошибку
  (rate-limit / сеть / timeout) — делает worker в app.py.
- **Движок side-effect-free относительно Telegram.** Отправку ответа делает мост, не
  движок. Движок только думает/правит вики в `WIKI_REPO_PATH`.

Безопасность доступа к подписке ([ADR-0009]): зовём ТОЛЬКО официальный бинарь под
аккаунтом владельца. НИКОГДА не скрейпим и не реюзаем OAuth-токен Claude в своём/
стороннем HTTP-клиенте — это ровно тот паттерн (OpenClaw), который банит Anthropic.

[ADR-0007]: ../docs/adr/0007-engine-spawn-and-scheduler.md
[ADR-0008]: ../docs/adr/0008-engine-claude-native.md
[ADR-0009]: ../docs/adr/0009-tos-safe-engine-access.md
"""

from __future__ import annotations

import asyncio
import json
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

import structlog

log = structlog.get_logger(__name__)


# --------------------------------------------------------------------------- #
# Контракт движка                                                             #
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class EngineResult:
    """
    Результат одного хода движка.

    Поля:
        answer:          финальный текст ответа для отправки в Telegram.
        session_id:      ID сессии движка ПОСЛЕ хода. На первом ходу чата это
                         net-new id (его надо сохранить в store); на resume —
                         тот же id, что пришёл (но возвращаем явно, чтобы не
                         делать предположений об адаптере).
        usage:           сырой объект usage из движка (input/output-токены, cost
                         и т.п.) для учёта лимитов подписки; может быть None.
        is_error:        True, если движок вернул error-результат или ненулевой код
                         выхода. answer тогда содержит человекочитаемое сообщение.
    """

    answer: str
    session_id: str | None
    usage: dict | None = None
    is_error: bool = False


class EngineError(RuntimeError):
    """Транзиентная или фатальная ошибка движка (timeout, ненулевой exit, error-payload)."""

    def __init__(self, message: str, *, transient: bool = False) -> None:
        super().__init__(message)
        # transient=True → worker'у имеет смысл сделать один retry.
        self.transient = transient


class Engine(ABC):
    """
    Абстрактный движок. Единственный контракт, который видит остальной мост.

    Реализация ОБЯЗАНА быть spawn-fresh-per-task: каждый вызов `run()` поднимает
    свежий процесс и даёт ему выйти. Реализация НЕ должна держать состояние между
    вызовами кроме того, что персистится снаружи (session_id в SQLite).
    """

    @abstractmethod
    async def run(self, prompt: str, session_id: str | None = None) -> EngineResult:
        """
        Выполнить один ход.

        Args:
            prompt:     текст инструкции/сообщения пользователя.
            session_id: id предыдущей сессии для непрерывности диалога, либо None
                        для первого хода (тогда движок создаёт новую сессию).

        Returns:
            EngineResult с ответом, (возможно новым) session_id и usage.

        Raises:
            EngineError: на timeout / ненулевой exit / фатальный error-payload.
        """
        raise NotImplementedError


# --------------------------------------------------------------------------- #
# Базовый spawn-помощник (общий для всех subprocess-адаптеров)                 #
# --------------------------------------------------------------------------- #


class _SubprocessEngine(Engine):
    """
    Общий механизм spawn-fresh-per-task поверх asyncio-subprocess.

    Конкретные адаптеры (`ClaudeEngine`, `CodexEngine`, `GrokEngine`) задают:
        - argv (как собрать командную строку для нового хода и для resume);
        - как распарсить stdout процесса в (answer, session_id, usage).

    Здесь — общая обвязка: запуск процесса, сбор stdout/stderr, жёсткий timeout с
    terminate→kill, классификация ошибок на транзиентные/фатальные. Это убирает
    дублирование между адаптерами и держит правила [ADR-0007] в одном месте.
    """

    # Жёсткий timeout на один ход, секунды. По истечении дочерний процесс убивается.
    timeout_seconds: float = 180.0

    # ---- что обязан реализовать конкретный адаптер ---- #

    def _build_argv(self, prompt: str, session_id: str | None) -> list[str]:
        """Собрать argv для нового хода (session_id is None) или resume."""
        raise NotImplementedError

    def _parse_output(
        self, stdout_text: str, prior_session_id: str | None
    ) -> tuple[str, str | None, dict | None]:
        """Распарсить stdout процесса → (answer, session_id, usage)."""
        raise NotImplementedError

    def _child_env(self) -> dict[str, str]:
        """
        Окружение дочернего процесса. По умолчанию — копия текущего; адаптеры
        переопределяют, чтобы вычистить опасные ключи (напр. API-ключи).
        """
        return dict(os.environ)

    def _missing_binary_hint(self) -> str:
        """Человекочитаемая подсказка, если бинарь движка не найден в PATH."""
        return "Бинарь движка не найден. Проверь установку и переменную *_BIN (см. setup/SETUP.md)."

    # ----------------------------- run ------------------------------------ #

    async def run(self, prompt: str, session_id: str | None = None) -> EngineResult:
        argv = self._build_argv(prompt, session_id)
        log.info(
            "engine.spawn",
            engine=type(self).__name__,
            resume=bool(session_id),
            session_id=session_id,
            argv_head=argv[:3],  # не логируем сам prompt (может быть приватным)
        )

        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=self._child_env(),
            )
        except FileNotFoundError as exc:
            # Бинаря нет в PATH/*_BIN — это конфигурационная (нетранзиентная) ошибка.
            raise EngineError(self._missing_binary_hint(), transient=False) from exc

        # Гоняем чтение stdout/stderr и ожидание выхода под общим timeout.
        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(), timeout=self.timeout_seconds
            )
        except asyncio.TimeoutError as exc:
            # Жёстко убиваем зависший процесс (spawn-fresh: не оставляем демонов).
            await self._terminate(proc)
            raise EngineError(
                f"движок не ответил за {self.timeout_seconds:.0f}с — ход прерван.",
                transient=True,
            ) from exc

        stdout_text = stdout_bytes.decode("utf-8", errors="replace")
        stderr_text = stderr_bytes.decode("utf-8", errors="replace").strip()
        return_code = proc.returncode

        # Ненулевой код выхода → ошибка. Транзиентность — эвристикой по stderr.
        if return_code != 0:
            transient = self._looks_transient(stderr_text)
            log.warning(
                "engine.nonzero_exit",
                engine=type(self).__name__,
                return_code=return_code,
                stderr=stderr_text[:500],
                transient=transient,
            )
            raise EngineError(
                f"движок завершился с кодом {return_code}: {stderr_text[:300]}",
                transient=transient,
            )

        # Парсинг stdout — забота конкретного адаптера.
        answer, new_session_id, usage = self._parse_output(stdout_text, session_id)
        if not answer:
            # Пустой ответ — деградируем мягко, не валим мост.
            answer = "(движок вернул пустой ответ)"
            log.warning("engine.empty_answer", engine=type(self).__name__)

        log.info(
            "engine.done",
            engine=type(self).__name__,
            session_id=new_session_id,
            answer_chars=len(answer),
            usage=usage,
        )
        return EngineResult(
            answer=answer, session_id=new_session_id, usage=usage, is_error=False
        )

    # ----------------------------- helpers -------------------------------- #

    @staticmethod
    def _looks_transient(stderr_text: str) -> bool:
        """
        Грубая эвристика: похожа ли ошибка на транзиентную (стоит retry).

        rate-limit / 429 / timeout / temporarily / connection → транзиентно.
        auth / login / not found / config → нетранзиентно (retry не поможет).
        """
        low = stderr_text.lower()
        transient_markers = (
            "rate limit",
            "429",
            "timeout",
            "timed out",
            "temporarily",
            "connection",
            "stream",
            "overloaded",
            "503",
            "502",
        )
        fatal_markers = ("auth", "login", "not found", "no such", "config", "unauthorized")
        if any(m in low for m in fatal_markers):
            return False
        return any(m in low for m in transient_markers)

    @staticmethod
    async def _terminate(proc: asyncio.subprocess.Process) -> None:
        """Аккуратно прибить дочерний процесс: terminate → подождать → kill."""
        if proc.returncode is not None:
            return
        try:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
        except ProcessLookupError:  # pragma: no cover - процесс уже умер
            pass


# --------------------------------------------------------------------------- #
# Адаптер Claude (v1, ДЕФОЛТНЫЙ и единственный включённый)                     #
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class ClaudeEngine(_SubprocessEngine):
    """
    Дефолтный движок на ОФИЦИАЛЬНОМ Claude Code в headless-режиме ([ADR-0008]).

    Собирает argv вида:
        # первый ход чата (новая сессия):
        claude -p "<prompt>" --output-format json --cwd <wiki_repo> [-m <model>]
        # продолжение диалога (resume по chat):
        claude -p "<prompt>" --output-format json --cwd <wiki_repo> --resume <session_id> [-m <model>]

    Разбор флагов:
        -p "<prompt>"           headless ("print"): один ход, процесс выходит — ровно
                                наша модель spawn-fresh-per-task.
        --output-format json    единый JSON-объект результата в stdout: из него берём
                                поле `result` (финальный текст) и `session_id`.
        --cwd <wiki_repo>       рабочая директория = приватная вики (raw/ + wiki/),
                                чтобы движок видел и правил контент-репо.
        --resume <session_id>   продолжить сохранённую сессию этого чата. Для самого
                                свежего диалога альтернатива — `--continue` (см.
                                continue_latest), но по chat надёжнее именно --resume <id>.
        -m <model>              опционально запиненная модель.

    ⚠ ToS-safe доступ ([ADR-0009]): зовём ТОЛЬКО официальный бинарь `claude` под
    аккаунтом владельца. НИКОГДА не вытаскиваем и не переиспользуем OAuth-токен в
    своём HTTP-клиенте (банится; это паттерн OpenClaw — он допустим только на стороне
    Grok, см. GrokEngine). Single-user — мост хардкодит allow-list owner chat_id (app.py).

    💸 Стоимость ([ADR-0009]): с 15.06.2026 скриптовый `claude -p` под подпиской тянет
    из месячного Agent-SDK-кредита (на Max-5x ~$100/мес), сверх — по API-ставкам.
    Для персонального масштаба щедро, но не бесконечно → human-in-the-loop + умеренные
    расписания (см. scheduler/), не 24/7-долбёжка.
    """

    # Путь к бинарю claude (из env CLAUDE_BIN; по умолчанию "claude" из PATH).
    claude_bin: str = "claude"
    # Рабочая директория движка = приватный контент-репо (env WIKI_REPO_PATH).
    wiki_repo_path: str = "."
    # Запиненная модель. None → не передавать -m (берётся дефолт Claude Code).
    model: str | None = None
    # Жёсткий timeout на один ход, секунды.
    timeout_seconds: float = 180.0
    # Если True — использовать `--continue` (самый свежий диалог в cwd) вместо
    # `--resume <id>`. По умолчанию False: по chat_id надёжнее адресовать сессию явно.
    continue_latest: bool = False
    # Дополнительные argv-флаги (escape hatch: напр. ["--permission-mode","plan"]
    # или ["--allowedTools","Read Edit"] для ограничения «рук» движка на write-path).
    extra_args: list[str] = field(default_factory=list)

    def _build_argv(self, prompt: str, session_id: str | None) -> list[str]:
        """Собрать argv для `claude -p` (новый ход) или с `--resume`/`--continue`."""
        argv = [
            self.claude_bin,
            "-p",
            prompt,
            "--output-format",
            "json",
            # Рабочая директория = приватная вики. Claude Code понимает --cwd;
            # это держит контент-репо рабочей папкой движка без cd снаружи.
            "--cwd",
            self.wiki_repo_path,
        ]
        if self.model:
            argv += ["-m", self.model]

        # Resume-путь: продолжаем сессию этого чата.
        if session_id:
            if self.continue_latest:
                # `--continue` берёт самый свежий диалог в cwd (без явного id).
                argv += ["--continue"]
            else:
                # Явная адресация сессии по сохранённому id — предпочтительно для
                # 1:1-чата (детерминированно, не зависит от «свежести»).
                argv += ["--resume", session_id]

        argv += self.extra_args
        return argv

    def _child_env(self) -> dict[str, str]:
        """
        Окружение дочернего `claude`. Наследуем текущее (там OAuth-сессия владельца,
        которой пользуется официальный бинарь). Ничего лишнего не подмешиваем и
        НИКОГДА не передаём сырой токен — это работа самого бинаря.
        """
        return dict(os.environ)

    def _missing_binary_hint(self) -> str:
        return (
            f"claude-бинарь не найден: {self.claude_bin!r}. Установи официальный "
            f"Claude Code и/или поправь CLAUDE_BIN (см. setup/SETUP.md). "
            f"Реюз OAuth-токена в стороннем клиенте запрещён ([ADR-0009])."
        )

    def _parse_output(
        self, stdout_text: str, prior_session_id: str | None
    ) -> tuple[str, str | None, dict | None]:
        """
        Распарсить единый JSON-результат `claude -p --output-format json`.

        Ожидаемая форма (result-объект):
            {
              "type": "result",
              "subtype": "success",
              "result": "<финальный текст ответа>",
              "session_id": "<uuid сессии>",
              "is_error": false,
              "usage": {...}, "total_cost_usd": ...
            }

        Берём `result` как ответ, `session_id` для resume, `usage` для учёта лимитов.
        Если json не распарсился — мягко падаем назад на сырой stdout как текст.
        """
        text = stdout_text.strip()
        if not text:
            return "", prior_session_id, None

        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            # Не JSON (например, бинарь напечатал plain-text) — отдаём как есть,
            # session_id сохраняем прежний (resume продолжит работать).
            log.warning("engine.claude.non_json_stdout", head=text[:200])
            return text, prior_session_id, None

        # Если вернулся список событий (на случай иных режимов) — ищем result-объект.
        if isinstance(payload, list):
            payload = next(
                (e for e in payload if isinstance(e, dict) and e.get("type") == "result"),
                payload[-1] if payload else {},
            )
        if not isinstance(payload, dict):
            return text, prior_session_id, None

        # session_id из ответа; если его нет — сохраняем прежний.
        session_id = payload.get("session_id") or prior_session_id

        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else None

        # Движок мог отметить ошибку прямо в result-объекте — всплываем как транзиентную.
        if payload.get("is_error"):
            message = payload.get("result") or payload.get("error") or "claude вернул is_error"
            raise EngineError(str(message), transient=True)

        answer = payload.get("result")
        if not isinstance(answer, str):
            answer = ""
        return answer.strip(), session_id, usage


# --------------------------------------------------------------------------- #
# Адаптер Codex (ОТЛОЖЕННЫЙ слот — портируемость, не v1)                       #
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class CodexEngine(_SubprocessEngine):
    """
    ОТЛОЖЕННЫЙ адаптер на подписочном Codex CLI (`codex exec`) — слот портируемости.

    NB: НЕ дефолт v1 (у владельца нет ChatGPT-подписки — [ADR-0008], который
    supersedes [ADR-0001]). Код оставлен рабочим слотом: включается `ENGINE=codex`,
    добавляется конфигом без переписывания моста. Не промоутить Codex как основной.

    Собирает argv вида:
        # первый ход чата (новая сессия):
        codex exec --json --skip-git-repo-check --cd <wiki_repo>
                   [-m <model>] -a never "<prompt>"
        # продолжение диалога (resume):
        codex exec resume <session_id> --json --skip-git-repo-check --cd <wiki_repo>
                   [-m <model>] -a never "<prompt>"

    Замечания по флагам (см. engine-runtime.md):
        --json                  поток JSONL-событий в stdout (thread.started,
                                turn.completed{usage}, error, ...).
        resume <session_id>     непрерывность; НЕ ставим --ephemeral рядом (баг #15538:
                                молча форкает новый thread).
        --skip-git-repo-check   приватный контент-репо — git, но не полагаемся на это.
        --cd <wiki_repo>        рабочая директория = приватная вики (raw/ + wiki/).
        -a never                approval_policy=never для unattended-запуска.
        -m <model>              опционально запиненная модель.

    Подписочный auth и sandbox закрепляются в ~/.codex/config.toml
    (forced_login_method="chatgpt", sandbox_mode="workspace-write",
    writable_roots=[<wiki_repo>], network_access=false) — это делает человек на сетапе.
    """

    # Путь к бинарю codex (из env CODEX_BIN; по умолчанию "codex" из PATH).
    codex_bin: str = "codex"
    wiki_repo_path: str = "."
    model: str | None = None
    timeout_seconds: float = 180.0
    extra_args: list[str] = field(default_factory=list)

    def _build_argv(self, prompt: str, session_id: str | None) -> list[str]:
        """Собрать argv для `codex exec` / `codex exec resume`."""
        common = [
            "--json",
            "--skip-git-repo-check",
            "--cd",
            self.wiki_repo_path,
            "-a",
            "never",
        ]
        if self.model:
            common += ["-m", self.model]
        common += self.extra_args

        if session_id:
            # Resume-путь: codex exec resume <sid> <common...> "<prompt>".
            # ВАЖНО: без --ephemeral (иначе #15538 молча форкнет новый thread).
            return [self.codex_bin, "exec", "resume", session_id, *common, prompt]
        # Первый ход чата: новая сессия, session_id появится в thread.started.
        return [self.codex_bin, "exec", *common, prompt]

    def _child_env(self) -> dict[str, str]:
        """
        Гарантируем, что в окружении дочернего codex нет OPENAI_API_KEY (иначе codex
        может молча уйти в per-token биллинг). forced_login_method="chatgpt" в
        config.toml — основной замок, это второй пояс.
        """
        child_env = dict(os.environ)
        child_env.pop("OPENAI_API_KEY", None)
        return child_env

    def _missing_binary_hint(self) -> str:
        return (
            f"codex-бинарь не найден: {self.codex_bin!r} (адаптер ОТЛОЖЕН). "
            f"Установи Codex CLI и/или поправь CODEX_BIN, либо используй ENGINE=claude."
        )

    def _parse_output(
        self, stdout_text: str, prior_session_id: str | None
    ) -> tuple[str, str | None, dict | None]:
        """
        Распарсить поток JSONL `codex exec --json` построчно.

        Действуем на: thread.started (новый session_id), turn.completed (usage и
        финальный текст ассистента), error (всплываем как транзиентную ошибку).
        """
        session_id: str | None = prior_session_id
        usage: dict | None = None
        answer_parts: list[str] = []

        for raw_line in stdout_text.splitlines():
            line = raw_line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                # codex иногда печатает не-JSON строки (баннеры) — игнорируем.
                continue
            if not isinstance(event, dict):
                continue

            etype = event.get("type")
            if etype == "thread.started":
                # Новый/подтверждённый id сессии (ключ session_id или thread_id).
                sid = event.get("session_id") or event.get("thread_id")
                if sid:
                    session_id = sid
            elif etype == "turn.completed":
                u = event.get("usage")
                if isinstance(u, dict):
                    usage = u
            elif etype == "error":
                message = event.get("message") or event.get("error") or "codex вернул error"
                raise EngineError(str(message), transient=True)
            elif etype in {"item.completed", "assistant", "message"}:
                # Накапливаем текстовые куски ответа ассистента (форма зависит от
                # версии CLI: text / content / message.content).
                chunk = (
                    event.get("text")
                    or event.get("content")
                    or (event.get("message") or {}).get("content")
                )
                if isinstance(chunk, str):
                    answer_parts.append(chunk)

        return "\n".join(p for p in answer_parts if p).strip(), session_id, usage


# --------------------------------------------------------------------------- #
# Адаптер Grok (ОТЛОЖЕННЫЙ слот — advisor-голос для A/B жизненных советов)      #
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class GrokEngine(_SubprocessEngine):
    """
    ОТЛОЖЕННЫЙ адаптер на Grok (xAI) — слот портируемости ([ADR-0008]).

    Зачем вообще: Grok — опциональный advisor-голос для A/B жизненных советов
    (его уникальная ценность — субъективное доверие владельца, релевантна сердцу
    вики про развитие). НЕ дефолт v1: как web/computer-агент и компилятор он слабее
    Claude и не переиспользует оплаченный Max. Включается `ENGINE=grok` осознанно.

    Два бэкенда (env GROK_BACKEND):
      • "grok-build-cli" (по умолчанию) — ОФИЦИАЛЬНЫЙ Grok Build CLI:
            grok -p "<prompt>" --output-format json [--resume <session_id>]
        Форма зеркалит ClaudeEngine (headless print + JSON-результат).
      • "openclaw" — сторонний харнесс OpenClaw поверх Grok:
            openclaw run "<prompt>" --json [--session <session_id>]

    ⚠⚠ ВАЖНО про OpenClaw ([ADR-0009]): OpenClaw допустим ТОЛЬКО на Grok-стороне —
    xAI его санкционирует. На стороне Claude OpenClaw ЗАПРЕЩЁН (Anthropic банит
    сторонние OAuth-харнессы, реюзающие подписочный токен). Поэтому openclaw-бэкенд
    живёт исключительно здесь, в GrokEngine, и НИКОГДА не должен использоваться для
    Claude. ClaudeEngine ходит только официальным бинарём `claude`.
    """

    # Бэкенд: "grok-build-cli" (официальный) или "openclaw" (санкционирован xAI для Grok).
    backend: str = "grok-build-cli"
    # Бинарь официального Grok Build CLI (env GROK_BIN).
    grok_bin: str = "grok"
    # Бинарь OpenClaw (env OPENCLAW_BIN), используется ТОЛЬКО при backend="openclaw".
    openclaw_bin: str = "openclaw"
    # Рабочая директория движка = приватный контент-репо (env WIKI_REPO_PATH).
    wiki_repo_path: str = "."
    model: str | None = None
    timeout_seconds: float = 180.0
    extra_args: list[str] = field(default_factory=list)

    def _build_argv(self, prompt: str, session_id: str | None) -> list[str]:
        """Собрать argv в зависимости от выбранного бэкенда Grok."""
        if self.backend == "openclaw":
            # OpenClaw-бэкенд — допустим ТОЛЬКО для Grok ([ADR-0009]).
            argv = [self.openclaw_bin, "run", prompt, "--json"]
            if session_id:
                argv += ["--session", session_id]
            if self.model:
                argv += ["--model", self.model]
            return argv + self.extra_args

        # По умолчанию — официальный Grok Build CLI (форма как у claude -p).
        argv = [self.grok_bin, "-p", prompt, "--output-format", "json"]
        if self.model:
            argv += ["-m", self.model]
        if session_id:
            argv += ["--resume", session_id]
        return argv + self.extra_args

    def _missing_binary_hint(self) -> str:
        which = self.openclaw_bin if self.backend == "openclaw" else self.grok_bin
        return (
            f"grok-бинарь не найден: {which!r} (адаптер ОТЛОЖЕН, backend={self.backend!r}). "
            f"Установи Grok Build CLI/OpenClaw и/или поправь GROK_BIN/OPENCLAW_BIN, "
            f"либо используй ENGINE=claude."
        )

    def _parse_output(
        self, stdout_text: str, prior_session_id: str | None
    ) -> tuple[str, str | None, dict | None]:
        """
        Распарсить JSON-результат Grok. Оба бэкенда отдают JSON в stdout; ищем
        text/result + session_id + usage по нескольким возможным ключам (форма
        зависит от версии бэкенда). При невалидном JSON — сырой текст как ответ.
        """
        text = stdout_text.strip()
        if not text:
            return "", prior_session_id, None
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            log.warning("engine.grok.non_json_stdout", backend=self.backend, head=text[:200])
            return text, prior_session_id, None

        # Поток событий (openclaw) → берём последний/result-объект.
        if isinstance(payload, list):
            payload = next(
                (e for e in payload if isinstance(e, dict) and e.get("type") in {"result", "text"}),
                payload[-1] if payload else {},
            )
        if not isinstance(payload, dict):
            return text, prior_session_id, None

        session_id = payload.get("session_id") or payload.get("session") or prior_session_id
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else None
        if payload.get("is_error"):
            message = payload.get("result") or payload.get("error") or "grok вернул is_error"
            raise EngineError(str(message), transient=True)

        answer = payload.get("result") or payload.get("text") or ""
        if not isinstance(answer, str):
            answer = ""
        return answer.strip(), session_id, usage


# --------------------------------------------------------------------------- #
# Фабрика движка из окружения                                                 #
# --------------------------------------------------------------------------- #


def build_engine_from_env() -> Engine:
    """
    Собрать движок из переменных окружения. Используется app.py на старте.

    Выбор движка — переменной ENGINE (по умолчанию "claude"):
        ENGINE=claude   → ClaudeEngine  (дефолт, единственный включённый в v1)
        ENGINE=grok     → GrokEngine    (ОТЛОЖЕН: advisor-голос; GROK_BACKEND/GROK_BIN/OPENCLAW_BIN)
        ENGINE=codex    → CodexEngine   (ОТЛОЖЕН: нет ChatGPT-подписки; CODEX_BIN/CODEX_MODEL)

    Общие переменные:
        WIKI_REPO_PATH       рабочая директория = приватный контент-репо (обязателен).
        ENGINE_TIMEOUT_SEC   жёсткий timeout на ход (по умолчанию 180).

    Сменить/добавить движок — добавить ветку здесь и реализовать адаптер `Engine`;
    остальной мост не меняется (шов портируемости — [ADR-0008]).
    """
    wiki_repo = os.environ.get("WIKI_REPO_PATH", "").strip()
    if not wiki_repo:
        raise EngineError(
            "WIKI_REPO_PATH не задан — движку некуда указывать (приватный контент-репо). "
            "См. .env.example / setup/SETUP.md.",
            transient=False,
        )

    engine_name = (os.environ.get("ENGINE") or "claude").strip().lower()
    timeout = float(os.environ.get("ENGINE_TIMEOUT_SEC", "180"))

    # --- Дефолт: Claude (официальный бинарь, ToS-safe — [ADR-0009]) --- #
    if engine_name == "claude":
        return ClaudeEngine(
            claude_bin=(os.environ.get("CLAUDE_BIN") or "claude").strip() or "claude",
            wiki_repo_path=wiki_repo,
            model=(os.environ.get("CLAUDE_MODEL") or "").strip() or None,
            timeout_seconds=timeout,
            # CLAUDE_CONTINUE_LATEST=1 → использовать --continue вместо --resume <id>.
            continue_latest=os.environ.get("CLAUDE_CONTINUE_LATEST", "0") == "1",
        )

    # --- Отложенный: Grok (advisor-голос) --- #
    if engine_name == "grok":
        log.warning("engine.deferred_selected", engine="grok")
        return GrokEngine(
            backend=(os.environ.get("GROK_BACKEND") or "grok-build-cli").strip(),
            grok_bin=(os.environ.get("GROK_BIN") or "grok").strip() or "grok",
            openclaw_bin=(os.environ.get("OPENCLAW_BIN") or "openclaw").strip() or "openclaw",
            wiki_repo_path=wiki_repo,
            model=(os.environ.get("GROK_MODEL") or "").strip() or None,
            timeout_seconds=timeout,
        )

    # --- Отложенный: Codex (нет ChatGPT-подписки) --- #
    if engine_name == "codex":
        log.warning("engine.deferred_selected", engine="codex")
        return CodexEngine(
            codex_bin=(os.environ.get("CODEX_BIN") or "codex").strip() or "codex",
            wiki_repo_path=wiki_repo,
            model=(os.environ.get("CODEX_MODEL") or "").strip() or None,
            timeout_seconds=timeout,
        )

    raise EngineError(
        f"Неизвестный ENGINE={engine_name!r}. Допустимо: claude (дефолт), grok, codex.",
        transient=False,
    )
