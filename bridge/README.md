---
title: bridge — мост Telegram ↔ движок (Claude)
type: overview
status: in-progress
last_updated: 2026-06-08
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

> **⚡ Транспорт по умолчанию — long polling** ([ADR-0014](../docs/adr/0014-telegram-transport-long-polling.md)):
> мост сам опрашивает Telegram исходящими `getUpdates` (`BRIDGE_MODE=polling`) — **без webhook,
> домена и туннеля**, inbound attack surface = 0; `/health` слушает только `127.0.0.1`. Схема
> и «три слоя» ниже описывают **опциональный** webhook-режим (`BRIDGE_MODE=webhook`).

## Поток одного сообщения

```
Пользователь → Telegram → CF Tunnel → POST /telegram/webhook/<nonce>
   │
   ├─ 3 слоя безопасности (secret-token header / owner chat_id / nonce в пути)
   ├─ кладём update во внутреннюю очередь, СРАЗУ отвечаем 200  (не ждём движок)
   │
   └─ worker (single-flight на chat_id):
        sessionId       = store.getSession(chatId)            // node:sqlite
        { answer, sessionId: newSid } = engine.run(prompt, sessionId)  // spawn-fresh claude -p --json
        store.upsertSession(chatId, newSid)
        telegram.sendMessage(chatId, answer)                  // Bot API
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

> Реализация — **TypeScript** (Node 24, strict ESM), порт с Python ([ADR-0012](../docs/adr/0012-language-typescript-port.md), зеркалит house-style `abcage-mcp-hub`): Fastify + pino + zod + `node:sqlite` + dotenv-flow. Исходники под `src/bridge/`, запускается собранный `dist/bridge/main.js` (`pnpm build`).

| Файл | Что делает |
|---|---|
| [`src/bridge/app.ts`](../src/bridge/app.ts) | **Fastify**-приложение: `GET /health` (всегда) + `POST /telegram/webhook/{nonce}` (3 слоя безопасности, только webhook-режим). Сборка зависимостей и жизненный цикл. |
| [`src/bridge/poller.ts`](../src/bridge/poller.ts) | **Long-poll цикл** `getUpdates` (polling-режим по умолчанию, [ADR-0014](../docs/adr/0014-telegram-transport-long-polling.md)): переиспользует `extractJob`/очередь/воркеры, персистит offset; прерывается `AbortSignal` на shutdown. |
| [`src/bridge/queue.ts`](../src/bridge/queue.ts) | Внутренняя очередь входящих + воркер с single-flight на `chat_id` (СРАЗУ отвечаем 200, ход движка — асинхронно). |
| [`src/bridge/engine.ts`](../src/bridge/engine.ts) | **Шов портируемости.** Абстрактный `Engine` + дефолтный `ClaudeEngine` (spawn `claude -p "<prompt>" --output-format json [--resume <sid>]` через `node:child_process` **без shell**, парсинг JSON, timeout+kill). Отложенные слоты `GrokEngine` (grok-build-cli / openclaw) и `CodexEngine`. Выбор — env `ENGINE` (фабрика `buildEngineFromEnv`). |
| [`src/bridge/store.ts`](../src/bridge/store.ts) | Стор `chat_sessions(chat_id PK, engine_session_id, updated_at)` на встроенном `node:sqlite` за интерфейсом `SessionStore` — карта чат→сессия движка для непрерывности (`resume`). Engine-agnostic; бэкенд — свап одного файла ([ADR-0012](../docs/adr/0012-language-typescript-port.md)). |
| [`src/bridge/telegram.ts`](../src/bridge/telegram.ts) | Клиент Bot API на встроенном `fetch` (`sendMessage` с чанкингом >4096, `sendChatAction`, `getMe`). Абстракция `TelegramClient` для подмены. |
| [`src/bridge/config.ts`](../src/bridge/config.ts) | Конфиг из окружения с zod-валидацией (`loadSettings`): обязательные Telegram-секреты, числовые `BRIDGE_*`. |
| [`src/bridge/main.ts`](../src/bridge/main.ts) | Точка входа (`dist/bridge/main.js`): грузит `.env` через `dotenv-flow` из cwd, собирает зависимости, поднимает Fastify. |
| [`../src/core/logger.ts`](../src/core/logger.ts) | pino-логгер (`LOG_JSON=0` → человекочитаемый pino-pretty). |
| [`.env.example`](../.env.example) | Шаблон окружения в **корне** репо (`ENGINE`, `CLAUDE_BIN`, токены/пути) — копируется в gitignored `.env`. Только фейковые плейсхолдеры. |
| [`ru.secondbrain.bridge.plist`](ru.secondbrain.bridge.plist) | LaunchAgent: автозапуск + автоперезапуск моста (`node dist/bridge/main.js`) на macOS. |

## Контракт движка (портируемость)

Весь мост знает движок только через один метод ([ADR-0008](../docs/adr/0008-engine-claude-native.md),
[ADR-0007](../docs/adr/0007-engine-spawn-and-scheduler.md)):

```ts
const { answer, sessionId, usage } = await engine.run(prompt, sessionId);
```

Сменить/добавить движок = написать адаптер `Engine` и ветку в `buildEngineFromEnv()`,
а не переписывать мост. Выбор адаптера — переменной `ENGINE` (по умолчанию `claude`).

### `ClaudeEngine` — дефолт v1

Spawn-fresh-per-task поверх **официального бинаря** `claude` ([ADR-0008]):

```bash
# первый ход чата (рабочая директория = приватная вика, задаётся cwd спавна):
claude -p "<prompt>" --output-format json
# продолжение диалога этого чата (resume):
claude -p "<prompt>" --output-format json --resume <session_id>
```

- **`-p` (print/headless)** — один ход, процесс выходит (наша модель spawn-fresh).
- **`--output-format json`** — единый JSON-результат в stdout: берём `result`
  (финальный текст) и `session_id`; `usage`/`total_cost_usd` — для учёта лимитов.
- **Resume по chat** — следующий ход чата идёт через `--resume <session_id>`
  (по сохранённому id; альтернатива `--continue` — самый свежий диалог в cwd).
- **Рабочая папка движка** = приватная вика (`raw/` + `wiki/`) — задаётся через `cwd` спавна (`workingDir()`), НЕ флагом: у официального `claude` нет `--cwd` ([ADR-0014](../docs/adr/0014-telegram-transport-long-polling.md)).
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
   `TELEGRAM_WEBHOOK_SECRET` через `crypto.timingSafeEqual` (constant-time, против timing-атак).
2. **hard allow-list владельца** — update, где `chat.id != TELEGRAM_OWNER_CHAT_ID`,
   жёстко дропается (лог + игнор, без ответа). Это **single-user-инвариант** из
   [ADR-0009](../docs/adr/0009-tos-safe-engine-access.md): задачи движку шлёт ТОЛЬКО
   владелец (мультиюзер = нарушение ToS-доступа к подписке).
3. **nonce в пути** — секрет в `…/webhook/<nonce>`; несовпадение → `404`
   (unsolicited POST не отличит существующий эндпоинт от несуществующего).

`TELEGRAM_WEBHOOK_SECRET` используется и как заголовок (слой 1), и как nonce пути
(слой 3) — одно высокоэнтропийное значение из `crypto.randomBytes(32).toString('base64url')`.

## Запуск (кратко)

Полный интерактивный runbook — в [setup/SETUP.md](../setup/SETUP.md) (установка
официального `claude` + `claude login`, бот у @BotFather, `setWebhook`, Cloudflare
Tunnel, загрузка LaunchAgent). Локально для разработки:

```bash
# из корня публичного репо (~/llm-wiki)
pnpm install                # ставит Fastify/pino/zod/luxon/rrule/dotenv-flow (+ dev)
pnpm build                  # tsc → dist/
cp .env.example .env        # затем заполнить .env реальными значениями (ENGINE=claude)
# .env грузится автоматически: main.ts вызывает dotenv-flow из cwd (корень репо).
pnpm start                  # = node dist/bridge/main.js (порт из BRIDGE_PORT)
# для разработки с авто-перезапуском: pnpm dev  (= tsx watch src/bridge/main.ts)
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
