---
title: bridge — мост Telegram ↔ движок (Claude)
type: overview
status: in-progress
last_updated: 2026-05-31
---

# bridge

Тонкий **мост Telegram ↔ движок** для личного «Второго мозга». Дефолтный движок —
**официальный Claude Code** (`claude -p --output-format json`), ToS-safe под
подпиской владельца ([ADR-0008](../docs/adr/0008-engine-claude-native.md),
[ADR-0009](../docs/adr/0009-tos-safe-engine-access.md)). Ремап проверенного
[`pachca-codex-bridge-plan`](../../PhpstormProjects/pachca-codex-bridge-plan.html)
с Pachca на Telegram ([ADR-0004](../docs/adr/0004-telegram-bridge-reactive-proactive.md)).

Это **реактивный слой** исполнения из трёх (см. [§ Три слоя](#три-слоя-исполнения)).
Задача моста узкая: **принять webhook → прогнать движок → отправить ответ в Telegram**.
Никакого ризонинга, никакой работы с вики — это делает движок, которому мост
указывает на приватный контент-репо (`WIKI_REPO_PATH`). Движок спрятан за
портируемой абстракцией `Engine`: дефолт `ClaudeEngine`, а `GrokEngine` и
`CodexEngine` — готовые **отложенные адаптеры-слоты** (включаются переменной `ENGINE`
без переписывания моста).

> Это **публичный фреймворк-репо**: реальные токены/секреты/chat_id сюда не попадают
> ([ADR-0003](../docs/adr/0003-two-repos-public-private.md)). Все примеры — фейковые.

## Поток одного сообщения

```
Пользователь → Telegram → CF Tunnel → POST /telegram/webhook/<nonce>
   │
   ├─ 3 слоя безопасности (secret-token header / owner chat_id / nonce в пути)
   ├─ кладём update в asyncio.Queue, СРАЗУ отвечаем 200  (не ждём движок)
   │
   └─ worker (single-flight на chat_id):
        session_id      = store.get_session(chat_id)          # SQLite
        answer, new_sid = engine.run(prompt, session_id)      # spawn-fresh claude -p --json
        store.upsert_session(chat_id, new_sid)
        telegram.send_message(chat_id, answer)                 # Bot API
```

Webhook отвечает 200 **сразу** после постановки в очередь: ход движка занимает
секунды-десятки секунд, а если держать webhook открытым — Telegram отвалится по
timeout и заретраит update (дубли). Поэтому: принять → подтвердить → обработать
асинхронно → запушить ответ.

## Три слоя исполнения

Мост — это **реактивный** слой. Полная картина ([ADR-0008](../docs/adr/0008-engine-claude-native.md),
[CONTEXT §4](../CONTEXT.md)):

| Слой | Триггер | Кто зовёт движок | Где |
|---|---|---|---|
| **РЕАКТИВ** | сообщение в Telegram (owner-only) | bridge → `claude -p` | **этот модуль** |
| **ПЛАНОВОЕ** | routine / launchd по расписанию | `claude -p` → compile вики / дайджест+напоминания / lint / web-research / resurfacing идей | [`scheduler/`](../scheduler/README.md) |
| **СОБЫТИЙНОЕ** | новый source-файл в `raw/` | trigger → compile | [`scheduler/`](../scheduler/README.md) |

Плановый слой в v1 — локальный `launchd`; апгрейд до 24/7 — **remote Claude routines**:
они срабатывают **даже при спящем Mac** (работают над приватным GitHub-репо), в
отличие от локального `launchd` ([ADR-0005](../docs/adr/0005-host-v1-macbook-portable.md)).

## Компоненты

| Файл | Что делает |
|---|---|
| [`app.py`](app.py) | FastAPI: `POST /telegram/webhook/{nonce}` (3 слоя безопасности) + `GET /health`; `asyncio.Queue`-воркер с single-flight на `chat_id`; жизненный цикл и сборка зависимостей. |
| [`engine.py`](engine.py) | **Шов портируемости.** Абстрактный `Engine` + дефолтный `ClaudeEngine` (spawn `claude -p "<prompt>" --output-format json [--resume <sid>]`, парсинг JSON, timeout+kill). Отложенные слоты `GrokEngine` (grok-build-cli / openclaw) и `CodexEngine`. Выбор — env `ENGINE`. |
| [`store.py`](store.py) | SQLite `chat_sessions(chat_id PK, engine_session_id, updated_at)` — карта чат→сессия движка для непрерывности диалога (`resume`). Engine-agnostic. |
| [`telegram.py`](telegram.py) | Клиент Bot API на сыром `httpx` (`sendMessage` с чанкингом >4096, `sendChatAction`, `getMe`). Абстракция `TelegramClient` для подмены. |
| [`pyproject.toml`](pyproject.toml) | Зависимости: `fastapi`, `uvicorn`, `httpx`, `structlog`. |
| [`.env.example`](.env.example) | Шаблон окружения (`ENGINE`, `CLAUDE_BIN`, токены/пути) — копируется в `.env`. Только фейковые плейсхолдеры. |
| [`ru.secondbrain.bridge.plist`](ru.secondbrain.bridge.plist) | LaunchAgent: автозапуск + автоперезапуск моста на macOS. |

## Контракт движка (портируемость)

Весь мост знает движок только через одну функцию ([ADR-0008](../docs/adr/0008-engine-claude-native.md),
[ADR-0007](../docs/adr/0007-engine-spawn-and-scheduler.md)):

```python
answer, new_session_id, usage = await engine.run(prompt, session_id)
```

Сменить/добавить движок = написать адаптер `Engine` и ветку в `build_engine_from_env()`,
а не переписывать мост. Выбор адаптера — переменной `ENGINE` (по умолчанию `claude`).

### `ClaudeEngine` — дефолт v1

Spawn-fresh-per-task поверх **официального бинаря** `claude` ([ADR-0008]):

```bash
# первый ход чата:
claude -p "<prompt>" --output-format json --cwd <wiki_repo>
# продолжение диалога этого чата (resume):
claude -p "<prompt>" --output-format json --cwd <wiki_repo> --resume <session_id>
```

- **`-p` (print/headless)** — один ход, процесс выходит (наша модель spawn-fresh).
- **`--output-format json`** — единый JSON-результат в stdout: берём `result`
  (финальный текст) и `session_id`; `usage`/`total_cost_usd` — для учёта лимитов.
- **Resume по chat** — следующий ход чата идёт через `--resume <session_id>`
  (по сохранённому id; альтернатива `--continue` — самый свежий диалог в cwd).
- **`--cwd <wiki_repo>`** — рабочая папка движка = приватная вика (`raw/` + `wiki/`).
- Жёсткий **timeout + kill** дочернего процесса; **один retry** на транзиентную
  ошибку (rate-limit / сеть / timeout) делает worker.

> ⚠ **ToS-safe доступ ([ADR-0009]).** Мост зовёт ТОЛЬКО официальный бинарь `claude`
> под аккаунтом владельца. **НИКОГДА** не скрейпим и не реюзаем OAuth-токен Claude в
> своём/стороннем HTTP-клиенте — это ровно тот паттерн (OpenClaw), который банит
> Anthropic. **Стоимость:** с 15.06.2026 скриптовый `claude -p` тянет из месячного
> Agent-SDK-кредита (на Max-5x ~$100/мес), сверх — по API-ставкам → human-in-the-loop
> + умеренные расписания, не 24/7-долбёжка.

### Отложенные слоты (опционально, не v1)

- **`GrokEngine`** (`ENGINE=grok`) — опциональный **advisor-голос** для A/B жизненных
  советов ([ADR-0008]). Два бэкенда (`GROK_BACKEND`): официальный **grok-build-cli**
  (`grok -p --output-format json`) и **openclaw** (`openclaw run … --json`).
  ⚠ **OpenClaw допустим ТОЛЬКО для Grok** (санкционирован xAI); на стороне Claude он
  **запрещён** ([ADR-0009]) — поэтому openclaw-бэкенд живёт исключительно в `GrokEngine`.
- **`CodexEngine`** (`ENGINE=codex`) — слот портируемости на `codex exec`
  (supersedes [ADR-0001](../docs/adr/0001-engine-subscription-codex.md)). Отложен: у
  владельца нет ChatGPT-подписки. Не промоутить как основной движок.

## Модель безопасности (три слоя)

Все три проверяются в `POST /telegram/webhook/{nonce}` (см. [telegram-interface.md](../docs/research/telegram-interface.md)):

1. **secret-token header** — `X-Telegram-Bot-Api-Secret-Token` сравнивается с
   `TELEGRAM_WEBHOOK_SECRET` через `hmac.compare_digest` (constant-time, против timing-атак).
2. **hard allow-list владельца** — update, где `chat.id != TELEGRAM_OWNER_CHAT_ID`,
   жёстко дропается (лог + игнор, без ответа). Это **single-user-инвариант** из
   [ADR-0009](../docs/adr/0009-tos-safe-engine-access.md): задачи движку шлёт ТОЛЬКО
   владелец (мультиюзер = нарушение ToS-доступа к подписке).
3. **nonce в пути** — секрет в `…/webhook/<nonce>`; несовпадение → `404`
   (unsolicited POST не отличит существующий эндпоинт от несуществующего).

`TELEGRAM_WEBHOOK_SECRET` используется и как заголовок (слой 1), и как nonce пути
(слой 3) — одно высокоэнтропийное значение из `secrets.token_urlsafe(32)`.

## Запуск (кратко)

Полный интерактивный runbook — в [setup/SETUP.md](../setup/SETUP.md) (установка
официального `claude` + `claude login`, бот у @BotFather, `setWebhook`, Cloudflare
Tunnel, загрузка LaunchAgent). Локально для разработки:

```bash
# из папки bridge/
python3 -m venv .venv && source .venv/bin/activate
pip install -e .            # ставит fastapi/uvicorn/httpx/structlog
cp .env.example .env        # затем заполнить .env реальными значениями (ENGINE=claude)
# .env подхватится автоматически, если установить extra: pip install -e ".[dotenv]"
# и запускать через обёртку, либо экспортировать переменные в окружение вручную.
uvicorn app:app --host 127.0.0.1 --port 8080
curl http://127.0.0.1:8080/health
```

`GET /health` возвращает статус моста, проверку связи с Telegram (`getMe`), размер
очереди и число воркеров — используется launchd/UptimeRobot и smoke-тестом из SETUP.

## Эфемерное vs стабильное

Мост — это интерфейс. Эфемерные команды (вопрос, заметка, `/reset`) идут через него
в движок; **стабильное знание** оседает в вики (концепции/развитие/идеи-first —
[ADR-0010](../docs/adr/0010-wiki-content-model.md)), а **напоминания** — в `reminders/`
(проактивный путь обслуживает [`scheduler/`](../scheduler/README.md), не мост). Это
разделение из [CONTEXT §2](../CONTEXT.md) удерживает доверие к базе.

## Связанные

- [../docs/adr/0008-engine-claude-native.md](../docs/adr/0008-engine-claude-native.md) ·
  [../docs/adr/0009-tos-safe-engine-access.md](../docs/adr/0009-tos-safe-engine-access.md) ·
  [../docs/adr/0010-wiki-content-model.md](../docs/adr/0010-wiki-content-model.md)
- [../docs/adr/0004-telegram-bridge-reactive-proactive.md](../docs/adr/0004-telegram-bridge-reactive-proactive.md) ·
  [../docs/adr/0007-engine-spawn-and-scheduler.md](../docs/adr/0007-engine-spawn-and-scheduler.md)
- [../docs/research/engine-runtime.md](../docs/research/engine-runtime.md) ·
  [../docs/research/telegram-interface.md](../docs/research/telegram-interface.md)
- [../setup/SETUP.md](../setup/SETUP.md) · [../scheduler/README.md](../scheduler/README.md) · [../CONTEXT.md](../CONTEXT.md)
