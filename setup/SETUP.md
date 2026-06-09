---
title: SETUP — активация «Второго мозга» (runbook)
type: overview
status: in-progress
last_updated: 2026-05-31
sources:
  - ../CONTEXT.md
  - ../docs/adr/0008-engine-claude-native.md
  - ../docs/adr/0009-tos-safe-engine-access.md
  - ../docs/adr/0010-wiki-content-model.md
  - ../docs/adr/0004-telegram-bridge-reactive-proactive.md
  - ../docs/adr/0006-github-account-kengston.md
  - ../docs/adr/0007-engine-spawn-and-scheduler.md
  - ../docs/research/README.md
---

# SETUP — активация «Второго мозга»

> Пошаговый **runbook**, который человек проходит руками один раз, чтобы поднять систему «с нуля до живого бота». v1 — **Claude-native**: движок = официальный бинарь `claude -p` под подпиской **Claude Max** ([ADR-0008](../docs/adr/0008-engine-claude-native.md)). Фазы идут по порядку: каждая зависит от предыдущей.
>
> **English-primary intent:** this is the human activation runbook. Steps and commands are explicit; Russian notes (`RU:` / inline) explain the *why* drawn from the ADRs and research. Skip nothing in Phase 1–3 — the rest builds on them.
>
> **Почему это runbook, а не скрипт.** Половина шагов — браузерный/интерактивный вход (`claude` sign-in, `gh auth login`), создание бота у @BotFather, выдача токенов. Их **нельзя** автоматизировать в фоне ([ADR-0004](../docs/adr/0004-telegram-bridge-reactive-proactive.md), [ADR-0007](../docs/adr/0007-engine-spawn-and-scheduler.md)). Поэтому — чек-лист, а не `install.sh`.

> ### 🔒 ToS-комплаенс (прочти до Phase 1) — [ADR-0009](../docs/adr/0009-tos-safe-engine-access.md)
> Движок запускается **ТОЛЬКО через официальный бинарь** `claude` (`claude -p ... --output-format json`), под собственным аккаунтом владельца. Это явно разрешённый Anthropic режим («ordinary individual use»).
> - **Никогда** не скрейпь и не переиспользуй OAuth-токен подписки в своём/стороннем HTTP-клиенте — именно это Anthropic банила в Jan–Apr 2026 (паттерн **OpenClaw** и т.п.). Мост спавнит бинарь → safe by construction.
> - **Single-user.** Мост жёстко allow-list'ит **один** Telegram `chat_id` (владельца) и дропает всё остальное. Мультиюзер = нарушение account-sharing.
> - **Human-in-the-loop / умеренные расписания**, не агрессивный 24/7-долбёж (не бан, но триггерит недельные лимиты).
> - **Стоимость:** с **15.06.2026** скриптовый `claude -p` / Agent SDK на подписке тянет из месячного **Agent-SDK-кредита** (~$100/мес на Max-5x). Для одного пользователя щедро, не бесконечно.
> - Grok/Codex как сторонние движки — **отложены** (опциональный appendix внизу). OpenClaw допустим **только** на Grok-стороне (xAI-санкционирован), **никогда** на Claude.

## Карта фаз

| # | Фаза | Где | ~Время | Блокирует |
|---|---|---|---|---|
| 0 | Prerequisites (Homebrew, Node 24 + pnpm, FileVault) | mac | ~10 мин | всё |
| 1 | Движок: Claude Code + sign-in под Max + проверка `claude -p` | mac | ~15 мин | 4, 6, 7 |
| 2 | `gh` + два репозитория (public/private) + push | mac + GitHub | ~25 мин | 4 |
| 3 | Telegram-бот: @BotFather → token + `chat_id` → `.env` (`ENGINE=claude`) | Telegram | ~20 мин | 4, 5, 6, 7 |
| 4 | Bridge: зависимости + запуск + `/health` | mac | ~20 мин | 5 |
| 5 | _(опц., только `BRIDGE_MODE=webhook`)_ Cloudflare Tunnel + `setWebhook` | mac + CF | ~20 мин | — |
| 6 | launchd: автозапуск bridge + плановые routines (+ опц. remote Claude routine) | mac | ~20 мин | 7 (плановое) |
| 7 | End-to-end тесты (реактив + capture + плановое) | тестируем | ~30 мин | — |
| 8 | Первый ингест: экспорт LLM-чатов (ChatGPT/Claude/Grok) + Telegram → `raw/` | mac | ~40 мин | — |

> **Бюджет: `$0`** сверх уже оплаченной подписки **Claude Max** ([ADR-0008](../docs/adr/0008-engine-claude-native.md)) — с поправкой на Agent-SDK-кредит после 15.06.2026 ([ADR-0009](../docs/adr/0009-tos-safe-engine-access.md)). Cloudflare Tunnel — бесплатный тариф. Telegram Bot API — бесплатно.

---

## Конвенции этого документа

- `[ ]` — отметь галочку, когда шаг выполнен и **проверен** (не «запустил», а «увидел ожидаемый вывод»).
- Команды даны для **macOS / zsh**. Пути — абсолютные либо относительно корня репо.
- Два корня репозиториев фигурируют постоянно:
  - **PUBLIC** (фреймворк-портфолио): `~/llm-wiki` → GitHub `Kengston/personal-llm-wiki` (`--public`).
  - **PRIVATE** (личный контент + секреты): `~/llm-wiki-content` → GitHub `Kengston/llm-wiki-content` (`--private`).
- Секреты живут **только** в gitignored `.env`-файлах ([ADR-0003](../docs/adr/0003-two-repos-public-private.md)): мост (`dist/bridge/main.js`) грузит `.env` из **корня PUBLIC-репо** через `dotenv-flow` (файл gitignored — токены в git не попадают, [ADR-0012](../docs/adr/0012-language-typescript-port.md)); shell-обёртки планового слоя (`run_sweep.sh`/`run_routine.sh`) дополнительно подгружают **приватный** `~/llm-wiki-content/.env`. В коммиты PUBLIC-репо — ни одного реального токена/телефона/`chat_id`/email.
- Имена сервисов launchd: `ru.secondbrain.bridge` (мост) и `ru.secondbrain.digest` (плановый дайджест+напоминания).

> RU: имена env-переменных ниже совпадают с `.env.example` (в корне PUBLIC-репо) и тем, что читают `src/bridge/` и `src/scheduler/`: `ENGINE`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, `WIKI_REPO_PATH`, `BRIDGE_PORT`. Не переименовывай — иначе код их не найдёт.

---

## Phase 0 — Prerequisites (Homebrew, Node 24 + pnpm, FileVault)

> Базовый инструментарий. Claude Code (`claude`) и `gh` — ещё нет (поставим в фазах 1–2). И сам Claude Code (npm-пакет), и фреймворк («Второй мозг» — **TypeScript/Node 24**, [ADR-0012](../docs/adr/0012-language-typescript-port.md)) требуют **Node.js 24** и пакетный менеджер **pnpm**.

- [ ] **0.1 Homebrew установлен.** Проверь:
  ```bash
  brew --version
  ```
  Если команды нет — поставь (официальный установщик):
  ```bash
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  ```
  После установки на Apple Silicon добавь brew в PATH (установщик подскажет точные строки), затем перезапусти терминал.

- [ ] **0.2 Node.js 24 + pnpm присутствуют** (нужны и для Claude Code, и для самого фреймворка bridge/ingest/scheduler — [ADR-0012](../docs/adr/0012-language-typescript-port.md)).
  ```bash
  node --version     # ожидаем v24.x; если нет — brew install node
  pnpm --version     # если нет — brew install pnpm  (или: corepack enable && corepack prepare pnpm@latest --activate)
  ```
  RU: pnpm — пакетный менеджер house-style владельца (зеркалит `abcage-mcp-hub`). Зависимости фреймворка и его сборку (`dist/`) ставим в фазе 4 (`pnpm install && pnpm build`).

- [ ] **0.3 FileVault включён** (шифрование диска at-rest — baseline-контроль приватности, см. [privacy-security](../docs/research/privacy-security.md)).
  ```bash
  fdesetup status   # ожидаем: FileVault is On.
  ```
  RU: если `FileVault is Off` — включи через **System Settings → Privacy & Security → FileVault → Turn On**. На свежем Mac он **opt-in**; без него кража ноутбука раскрывает весь приватный репо в открытом виде. CLI-`fdesetup enable` с паролями deprecated на macOS 10.15+ — используй UI.

- [ ] **0.4 Каталоги репозиториев на месте.** Этот runbook предполагает, что код фреймворка уже лежит в `~/llm-wiki`. Приватный каталог создадим в фазе 2. Проверь:
  ```bash
  ls ~/llm-wiki/bridge ~/llm-wiki/ingest ~/llm-wiki/scheduler
  ```

---

## Phase 1 — Движок: Claude Code + sign-in под Max + проверка `claude -p`

> Движок v1 — официальный **Claude Code** под подпиской **Claude Max** ([ADR-0008](../docs/adr/0008-engine-claude-native.md), [ADR-0009](../docs/adr/0009-tos-safe-engine-access.md)). Он закрывает все три роли системы: интерактивный мозг (реактив), «руки» (web/computer-агент через MCP), компилятор вики (плановые правки md). **Никаких** API-ключей и стороннего реюза токена — только официальный бинарь.

- [ ] **1.1 Установить Claude Code.** Официальный путь — npm-пакет:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude --version
  ```
  RU: если предпочитаешь нативный установщик Anthropic (`curl ... | bash`) — он тоже официален; главное **не** ставить сторонние обёртки/харнессы поверх подписочного токена ([ADR-0009](../docs/adr/0009-tos-safe-engine-access.md)).

- [ ] **1.2 Войти под подпиской Claude Max (НЕ по API-ключу).**
  ```bash
  claude     # интерактивный старт; выбери "Subscription" / Claude account и пройди вход в браузере
  ```
  Войди тем аккаунтом, на котором оплачен **Max**. Это кладёт OAuth-креды локально, запросы идут через подписочный backend = **`$0` сверх плана** (с поправкой на Agent-SDK-кредит после 15.06.2026).

  > ⚠️ **Не** входи API-ключом и **не** держи `ANTHROPIC_API_KEY` в окружении при подписочном режиме — иначе Claude Code может уйти в per-token-биллинг и сломать `$0`-инвариант (проверка в 1.5). **Никогда** не вытаскивай этот OAuth-токен в свой HTTP-клиент — это банённый паттерн OpenClaw ([ADR-0009](../docs/adr/0009-tos-safe-engine-access.md)).

- [ ] **1.3 Проверить headless-режим (главная проверка движка).** Это **точно** та команда, которую спавнит мост:
  ```bash
  claude -p "hi" --output-format json
  ```
  Ожидаем валидный JSON-объект. Достань из него поле с текстом ответа и `session_id` (Node уже стоит из фазы 0):
  ```bash
  claude -p "скажи hi одним словом" --output-format json \
    | node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync(0,'utf8')),null,2))"
  ```
  RU: мост парсит этот JSON → берёт текст результата для отправки в Telegram и `session_id` (валидный UUID) для непрерывности диалога. Непрерывность достигается флагом `--resume <session_id>` (или `--continue` для последней сессии в каталоге) на следующем ходу — см. `src/bridge/engine.ts` (`ClaudeEngine`).

- [ ] **1.4 Проверить resume (непрерывность диалога).** Сохрани id из ответа 1.3 и продолжи им сессию:
  ```bash
  SID=$(claude -p "запомни число 7" --output-format json \
    | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).session_id)")
  claude -p "какое число я просил запомнить?" --output-format json --resume "$SID" \
    | node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync(0,'utf8')),null,2))"
  ```
  Ожидаем: ответ содержит «7» → значит `--resume <id>` работает (это фундамент реактивного диалога в фазе 7).

- [ ] **1.5 (Проверка $0-замка).** Убедись, что в окружении нет API-ключа, который мог бы перебить подписку:
  ```bash
  env | grep -i ANTHROPIC_API_KEY   # ожидаем: пусто
  ```
  RU: про обучение на контенте Claude-подписка отличается от потребительских chat-аккаунтов, но crown-jewel-секреты (банковские пароли, полные номера карт, гос-ID) в прозу `wiki/` **всё равно не пишем** — она целиком уходит движку. Такие вещи — только в `.env`, никогда в страницах ([CONTEXT §3](../CONTEXT.md), [ADR-0010](../docs/adr/0010-wiki-content-model.md)).

---

## Phase 2 — `gh` + два репозитория + push

> Машина уже авторизована в GitHub как **«Kengston»** по SSH ([ADR-0006](../docs/adr/0006-github-account-kengston.md)). `gh` нужен, чтобы **создать** удалённые репозитории (SSH умеет только push в уже существующий).

- [ ] **2.1 Установить GitHub CLI.**
  ```bash
  brew install gh
  gh --version
  ```

- [ ] **2.2 Залогиниться как «Kengston».**
  ```bash
  gh auth login
  ```
  Выбирай: **GitHub.com** → **HTTPS** или **SSH** (SSH уже настроен — можно «Login with a web browser») → в браузере войди **аккаунтом Kengston**. Проверь:
  ```bash
  gh auth status      # должен показать аккаунт Kengston
  ```

- [ ] **2.3 Создать и запушить PUBLIC-репо** (фреймворк-портфолио).
  ```bash
  gh repo create personal-llm-wiki --public \
    --source ~/llm-wiki --remote origin --push \
    --description "Personal LLM-wiki second brain (Karpathy pattern): Claude-native engine + Telegram bridge, no embedder."
  ```
  > ⚠️ **Перед** этим убедись, что в `~/llm-wiki` нет личных данных (это и есть инвариант двух репо). Быстрый локальный линт PII/секретов — фаза 8 / `pnpm lint:public` (`src/scheduler/lint-public.ts`). Если ещё нет коммита: `git -C ~/llm-wiki init && git -C ~/llm-wiki add -A && git -C ~/llm-wiki commit -m "init framework"` перед `gh repo create`.

- [ ] **2.4 Подготовить PRIVATE-каталог** (личный контент). Если каталога ещё нет — создай скелет по целевому layout:
  ```bash
  mkdir -p ~/llm-wiki-content/raw ~/llm-wiki-content/wiki ~/llm-wiki-content/reminders
  cd ~/llm-wiki-content && git init
  ```
  Файлы `README.md`, `CLAUDE.md`, `.gitignore`, `wiki/index.md`, `reminders/` и `log.md` поставляются заготовками — убедись, что они на месте (`ls ~/llm-wiki-content`).
  RU: рабочий контекст движка для приватного репо держим в `CLAUDE.md` (Claude Code читает его как memory-файл из рабочего каталога) — это Claude-native аналог прежнего `AGENTS.md`.

- [ ] **2.5 Создать `.env` из примера и заполнить позже** (значения появятся в фазах 3 и 5). Шаблон `.env.example` лежит в **корне** публичного репо. Мост грузит `.env` из корня PUBLIC-репо (`dotenv-flow`, [ADR-0012](../docs/adr/0012-language-typescript-port.md)) — этот `.env` **gitignored**, реальные токены в коммиты не попадают:
  ```bash
  cp ~/llm-wiki/.env.example ~/llm-wiki/.env            # для моста (корень PUBLIC, gitignored)
  cp ~/llm-wiki/.env.example ~/llm-wiki-content/.env    # для планового слоя (run_sweep.sh читает приватный .env)
  ```
  Проверь, что **оба** `.env` **игнорируются** git'ом:
  ```bash
  cd ~/llm-wiki         && git check-ignore .env   # должен напечатать: .env
  cd ~/llm-wiki-content && git check-ignore .env   # должен напечатать: .env
  ```
  > ⚠️ Если `.env` НЕ игнорируется — останови всё и поправь `.gitignore` (`.env`, `.env.*`, `*.sqlite`, `.DS_Store`). Секрет, попавший в git-историю, персистит во всех клонах/форках навсегда. В PUBLIC-репо `.env` именно gitignored (см. `.gitignore`: `.env` + `!.env.example`).

- [ ] **2.6 Создать и запушить PRIVATE-репо** (`--private`).
  ```bash
  cd ~/llm-wiki-content && git add -A && git commit -m "init private content"
  gh repo create llm-wiki-content --private \
    --source ~/llm-wiki-content --remote origin --push \
    --description "PRIVATE personal content for the second brain. Never make public."
  ```
  > RU: оба репо — на аккаунте Kengston; различает их только флаг `--public` / `--private`. Приватный репо ещё и носитель состояния для **remote Claude routines** (фаза 6): они работают над ним даже при спящем Mac ([ADR-0005](../docs/adr/0005-host-v1-macbook-portable.md), [CONTEXT §4](../CONTEXT.md)).

---

## Phase 3 — Telegram-бот: token + owner `chat_id` → `.env`

> Bot API (не userbot) — принятый выбор ([ADR-0004](../docs/adr/0004-telegram-bridge-reactive-proactive.md)): входящие webhook + исходящие пуши + голосовые, минимальный ToS-риск.

- [ ] **3.1 Создать бота у @BotFather.** В Telegram открой [@BotFather](https://t.me/BotFather):
  ```
  /newbot
  → имя (display): Второй мозг
  → username: <что_угодно>_secondbrain_bot   (должен заканчиваться на "bot")
  ```
  @BotFather вернёт **HTTP API token** вида `123456789:AA...` — это `TELEGRAM_BOT_TOKEN`.

- [ ] **3.2 Записать token в `.env`** приватного репо:
  ```
  # ~/llm-wiki-content/.env
  TELEGRAM_BOT_TOKEN=123456789:AAyour-real-token-here
  ```
  > ⚠️ Токен бота даёт полный контроль над ботом. Только в `.env` (gitignored). Никогда — в PUBLIC-репо. (В коде/примерах используется заведомо фейковый `123456789:AA-FAKE-EXAMPLE-TOKEN-DO-NOT-USE`.)

- [ ] **3.3 Узнать свой owner `chat_id`.** Открой бота **«Второй мозг»** и нажми **Start** (`/start`) — это обязательно: бот не может написать первым, пока ты не написал ему ([telegram-interface](../docs/research/telegram-interface.md)). Затем узнай свой numeric id одним из способов:
  - **Проще:** напиши [@userinfobot](https://t.me/userinfobot) `/start` — он вернёт твой `Id`.
  - **Через API** (после того как ты нажал Start у *своего* бота):
    ```bash
    source ~/llm-wiki-content/.env
    curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates" \
      | node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync(0,'utf8')),null,2))"
    ```
    Возьми `result[].message.chat.id`.
  > RU: для приватного 1:1-чата `chat.id == from.id` — одной константы хватает. (Если позже добавишь бота в группу — там id отличается; v1 рассчитан на личный чат.)

- [ ] **3.4 Записать owner `chat_id` в `.env`:**
  ```
  TELEGRAM_OWNER_CHAT_ID=111111111
  ```
  RU: это включает **все** проактивные пуши — планировщик отныне может слать в этот чат когда угодно. И это же — **allow-list безопасности single-user** ([ADR-0009](../docs/adr/0009-tos-safe-engine-access.md)): мост дропает любой апдейт, чей `chat_id` ≠ этот.

- [ ] **3.5 Сгенерировать webhook-secret** (фаза 5 поставит его в `setWebhook`):
  ```bash
  node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
  ```
  Запиши результат в `.env`:
  ```
  TELEGRAM_WEBHOOK_SECRET=<вставь_сгенерированную_строку>
  ```
  > ⚠️ Charset секрета для Telegram ограничен `A-Z a-z 0-9 _ -` (1–256 символов). `base64url` (`randomBytes(32).toString('base64url')`) это удовлетворяет. Длина ≥32 — против timing-атак (мост сравнивает заголовок через `crypto.timingSafeEqual`, [ADR-0012](../docs/adr/0012-language-typescript-port.md)).

- [ ] **3.6 Выбрать движок и указать путь к приватному репо в `.env`.** Дефолт v1 — Claude (эти поля нужны мосту → впиши их в `.env` корня PUBLIC-репо; те же — в приватный `.env` для планового слоя):
  ```
  # .env (корень ~/llm-wiki; для планового слоя — ~/llm-wiki-content/.env)
  ENGINE=claude
  CLAUDE_BIN=claude
  WIKI_REPO_PATH=/Users/ЗАМЕНИ_МЕНЯ/llm-wiki-content   # echo ~/llm-wiki-content
  ENGINE_TIMEOUT_SEC=180
  BRIDGE_PORT=8080
  ```
  RU: `ENGINE=claude` выбирает `ClaudeEngine` (фабрика `buildEngineFromEnv` в `src/bridge/engine.ts`), который спавнит `claude -p "<prompt>" --output-format json [--resume <sid>]` через `node:child_process` (без shell) с рабочим каталогом `WIKI_REPO_PATH`. Значения Grok/Codex (`ENGINE=grok|codex`) — отложенные, см. appendix.

- [ ] **3.7 Проверить токен бота:**
  ```bash
  source ~/llm-wiki-content/.env
  curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" \
    | node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync(0,'utf8')),null,2))"
  ```
  Ожидаем `"ok": true` и username твоего бота.

---

## Phase 4 — Bridge: зависимости + сборка + запуск + `/health`

> Тонкий **Fastify**-мост (~150 LOC, TypeScript — [ADR-0012](../docs/adr/0012-language-typescript-port.md)): webhook → движок → ответ в Telegram. Спавнит **один короткоживущий** `claude -p`-процесс на сообщение через `node:child_process` ([ADR-0007](../docs/adr/0007-engine-spawn-and-scheduler.md), [ADR-0008](../docs/adr/0008-engine-claude-native.md)), не держит резидентный демон. Owner-only allow-list ([ADR-0009](../docs/adr/0009-tos-safe-engine-access.md)).

- [ ] **4.1 Поставить зависимости и собрать фреймворк.** Из **корня** публичного репо:
  ```bash
  cd ~/llm-wiki
  pnpm install              # ставит зависимости (Fastify/pino/zod/luxon/rrule/dotenv-flow + dev)
  pnpm build                # tsc → dist/ (то, что реально запускает мост и launchd)
  ```
  RU: `pnpm` ставит зависимости в `node_modules` локально; `pnpm build` компилирует `src/*.ts` → `dist/*.js`. В фазе 6 launchd-плист зовёт уже собранный `node dist/bridge/main.js`. Сам `claude` ставится глобально (фаза 1) и должен быть в `PATH` того окружения, под которым стартует launchd.

- [ ] **4.2 Заполнить `.env` моста.** Мост (`dist/bridge/main.js`) грузит `.env` из **корня PUBLIC-репо** через `dotenv-flow` (cwd = корень репо). Файл уже создан в фазе 2.5 (`~/llm-wiki/.env`, gitignored) — убедись, что в нём заполнены `TELEGRAM_*`, `ENGINE=claude`, `WIKI_REPO_PATH` (фазы 3.2–3.6):
  ```bash
  cd ~/llm-wiki && node -e "require('dotenv-flow').config({silent:true}); console.log('ENGINE=',process.env.ENGINE,'OWNER=',!!process.env.TELEGRAM_OWNER_CHAT_ID)"
  ```
  RU: отдельно экспортировать переменные не нужно — `dotenv-flow` подхватит `.env` из cwd при старте моста.

- [ ] **4.3 Запустить мост вручную** (foreground, для проверки):
  ```bash
  cd ~/llm-wiki
  pnpm start                # = node dist/bridge/main.js (порт из BRIDGE_PORT)
  # для разработки с авто-перезапуском: pnpm dev  (= tsx watch src/bridge/main.ts)
  ```
  RU: порт `8080` берётся из `BRIDGE_PORT` в `.env`; согласуй с тем, что прописано в `bridge/README.md` и в config Cloudflare (фаза 5).

- [ ] **4.4 Проверить `/health`** (в **другом** терминале):
  ```bash
  curl -s http://127.0.0.1:8080/health
  ```
  Ожидаем `200 OK` (напр. `{"status":"ok"}`). Если падает — смотри pino-вывод в терминале моста (`LOG_JSON=0` даёт человекочитаемый pino-pretty).

  > ⚠️ Мост — асинхронный: `claude -p` гоняется неблокирующе с timeout (`ENGINE_TIMEOUT_SEC`, ~120–240с), чтобы Telegram-webhook не отвалился. Пока вебхук не настроен (фаза 5), мост просто живёт и отвечает на `/health`.

---

## Phase 5 — Cloudflare Tunnel + `setWebhook` с secret

> Публичный HTTPS-эндпоинт для входящего webhook без проброса портов и публичного IP. cloudflared делает только **исходящие** соединения — нет inbound-attack-surface ([privacy-security](../docs/research/privacy-security.md)).

> ### ⚡ С [ADR-0014](../docs/adr/0014-telegram-transport-long-polling.md): дефолтный транспорт — **long polling**, и эта фаза **НЕОБЯЗАТЕЛЬНА**
> При `BRIDGE_MODE=polling` (дефолт) мост сам опрашивает Telegram исходящими `getUpdates` — **ни домена, ни `cloudflared`, ни `setWebhook` не нужно**, а inbound attack surface = 0. Просто запусти мост (Phase 4) и переходи к Phase 6–7 (E2E работает и для polling). Шаги 5.1–5.7 ниже нужны **только** если ты осознанно выбрал `BRIDGE_MODE=webhook` (push-режим, требует домена под Cloudflare + `TELEGRAM_WEBHOOK_SECRET`).

- [ ] **5.1 Установить cloudflared.**
  ```bash
  brew install cloudflared
  cloudflared --version
  ```

- [ ] **5.2 Залогиниться и создать туннель.**
  ```bash
  cloudflared tunnel login            # откроет браузер, выбери свой домен в Cloudflare
  cloudflared tunnel create secondbrain
  ```
  Команда `create` напечатает **Tunnel UUID** и путь к credentials-файлу (`~/.cloudflared/<UUID>.json`).

- [ ] **5.3 Привязать DNS-имя к туннелю** (нужен домен в Cloudflare):
  ```bash
  cloudflared tunnel route dns secondbrain bridge.ТВОЙ-ДОМЕН.ru
  ```

- [ ] **5.4 Настроить ingress.** Создай `~/.cloudflared/config.yml`:
  ```yaml
  tunnel: <UUID-из-шага-5.2>
  credentials-file: /Users/ЗАМЕНИ_МЕНЯ/.cloudflared/<UUID>.json
  ingress:
    - hostname: bridge.ТВОЙ-ДОМЕН.ru
      service: http://127.0.0.1:8080      # порт моста (BRIDGE_PORT) из фазы 4
    - service: http_status:404
  ```

- [ ] **5.5 Поднять туннель** (мост из фазы 4 должен быть запущен):
  ```bash
  cloudflared tunnel run secondbrain
  ```
  Smoke-тест из внешней сети (телефон по мобильному интернету или другой хост):
  ```bash
  curl -s https://bridge.ТВОЙ-ДОМЕН.ru/health   # ожидаем 200 OK
  ```

- [ ] **5.6 Зарегистрировать webhook в Telegram** — с secret-токеном и только событиями `message`:
  ```bash
  source ~/llm-wiki-content/.env
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
    -d "url=https://bridge.ТВОЙ-ДОМЕН.ru/telegram/webhook" \
    -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
    -d "max_connections=1" \
    --data-urlencode 'allowed_updates=["message"]' \
    | node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync(0,'utf8')),null,2))"
  ```
  RU: путь `/telegram/webhook` — согласуй с тем, что слушает `src/bridge/app.ts`. `secret_token` Telegram будет слать в заголовке `X-Telegram-Bot-Api-Secret-Token`, мост его проверяет. `max_connections=1` — для личного бота достаточно.

- [ ] **5.7 Проверить регистрацию webhook:**
  ```bash
  curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo" \
    | node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync(0,'utf8')),null,2))"
  ```
  Ожидаем `"url"` = твой туннель и `"pending_update_count": 0` (или малое число), без `last_error_message`.

  > ⚠️ Webhook и `getUpdates` **взаимоисключающи**. Если в фазе 3 ты дёргал `getUpdates` — это ок, он не оставляет состояния; но если позже запустишь polling для дебага, сначала `deleteWebhook`, иначе молча сломаешь живой webhook.

---

## Phase 6 — launchd: автозапуск bridge + плановые routines

> Три слоя исполнения ([CONTEXT §4](../CONTEXT.md)): **РЕАКТИВ** (Telegram→мост→движок, фазы 3–5), **ПЛАНОВОЕ** (routine→`claude -p`→compile/дайджест/lint/web-research/resurfacing идей), **СОБЫТИЙНОЕ** (новый файл в `raw/`→compile). Локально плановое держит **launchd** (LaunchAgent), не cron: при пробуждении из сна запускает пропущенную задачу и коалесцирует пропуски — идеально для идемпотентного «sweep» ([ADR-0007](../docs/adr/0007-engine-spawn-and-scheduler.md), [proactive-scheduling](../docs/research/proactive-scheduling.md)).

- [ ] **6.1 Заполнить плейсхолдеры в плистах.** Шаблоны лежат в `bridge/` и `scheduler/` (`ru.secondbrain.bridge.plist`, `ru.secondbrain.digest.plist`) с метками вида `__NODE_BIN__` / `__REPO_DIR__` / `__PUBLIC_REPO__` — подставь абсолютные пути (свой `$HOME`, путь к `node`, корень публичного репо с `dist/`). Bridge-плист запускает `node dist/bridge/main.js` (cwd = корень репо, откуда грузится `.env`); digest-плист зовёт `scheduler/run_sweep.sh`. Затем скопируй в `~/Library/LaunchAgents/`:
  ```bash
  cp ~/llm-wiki/bridge/ru.secondbrain.bridge.plist ~/Library/LaunchAgents/
  cp ~/llm-wiki/scheduler/ru.secondbrain.digest.plist ~/Library/LaunchAgents/
  ```
  RU: проверь синтаксис плистов до загрузки:
  ```bash
  plutil -lint ~/Library/LaunchAgents/ru.secondbrain.bridge.plist
  plutil -lint ~/Library/LaunchAgents/ru.secondbrain.digest.plist
  ```
  > ⚠️ launchd запускает агенты в урезанном окружении. Убедись, что `claude` доступен по абсолютному пути или что плист добавляет нужный `PATH` (где лежит глобальный npm-бинарь) в `EnvironmentVariables` — иначе движок не найдётся.

- [ ] **6.2 Загрузить агенты** (современный синтаксис `bootstrap`, не legacy `load`):
  ```bash
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ru.secondbrain.bridge.plist
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ru.secondbrain.digest.plist
  ```
  Проверить, что зарегистрированы:
  ```bash
  launchctl list | grep secondbrain
  ```
  RU: если меняешь плист после загрузки — сначала `launchctl bootout gui/$(id -u) <plist>`, потом снова `bootstrap`.

- [ ] **6.3 (Если мост уже крутился руками из фазы 4)** — останови ручной `pnpm start` (`node dist/bridge/main.js`) и `cloudflared`, чтобы не было двойного слушателя на порту. Теперь их поднимает launchd (`ru.secondbrain.bridge` стартует мост; туннель оформи отдельным агентом или оставь `cloudflared tunnel run` под launchd по `cloudflared service install` — см. `bridge/README.md`).

- [ ] **6.4 (Опционально) Sleep-политика для локального планового.** v1 на ноутбуке ловит только **сон**, не выключение ([ADR-0005](../docs/adr/0005-host-v1-macbook-portable.md)). Усиления:
  ```bash
  # разбудить Mac под утренний дайджест (одна repeat-схема, нужен sudo):
  sudo pmset repeat wakeorpoweron MTWRFSU 08:55:00
  ```
  RU: `caffeinate -s` (предотвратить system-sleep) wrapper уже включён в `scheduler/run_sweep.sh` **вокруг** sweep — не держи `caffeinate` 24/7, посадишь батарею. Слот, пропущенный при полностью **выключенном** Mac, локальный launchd не отыграет.

- [ ] **6.5 (Опционально, рекомендуется) Remote Claude routine — апгрейд до 24/7-проактива.** Чтобы дайджест/напоминания/idea-resurfacing срабатывали **даже когда Mac спит или выключен**, заведи remote Claude routine, которая работает над **приватным GitHub-репо** (`Kengston/llm-wiki-content`), а не над локальной ФС:
  - дай routine доступ к приватному репо (read/write), задай расписание (напр. утренний дайджест, еженедельный lint, web-research);
  - промпт routine: «прочитай `reminders/` + дни рождения из `wiki/`, собери один дайджест из due-записей, отправь владельцу, помечай сработавшее» — тот же идемпотентный sweep, что и локальный, но stateless и серверный;
  - исходящий пуш в Telegram routine делает тем же owner-only способом (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_OWNER_CHAT_ID` как секреты routine).

  RU: это рекомендованный апгрейд из [CONTEXT §4 / §6 OQ-3](../CONTEXT.md): remote routine не зависит от состояния ноутбука (данные живут в приватном репо), поэтому закрывает слабое место launchd — пропуск слота при выключенной машине. Локальный `ru.secondbrain.digest` и remote routine можно держать вместе только если они **не задвоят** пуш (дедуп по `status`/`last_fired` в `reminders/`); проще — оставить что-то одно для проактива. ToS-рамки те же ([ADR-0009](../docs/adr/0009-tos-safe-engine-access.md)): официальный Claude, single-user, умеренное расписание.

---

## Phase 7 — End-to-end тесты

> Проверяем три тракта: реактивный Q&A, capture-в-вику, плановый дайджест. Мост (фаза 4) + туннель (фаза 5) + агенты (фаза 6) должны быть подняты.

- [ ] **7.1 Реактив: вопрос → ответ.** В чате с ботом напиши:
  ```
  привет, ты живой?
  ```
  Ожидаем: короткий ack/`typing`, затем текстовый ответ за ~7–20с (cold start `claude -p` + LLM). В логах моста — событие завершения хода с объектом `usage`.

- [ ] **7.2 Реактив: непрерывность диалога** (`--resume` работает). Следом:
  ```
  а что я только что спросил?
  ```
  Ожидаем: бот помнит предыдущее сообщение → значит SQLite-карта `chat_id→session_id` и `claude -p --resume <sid>` работают.
  > ⚠️ Если бот «забывает» — проверь, что мост передаёт реальный `session_id` (валидный UUID) из JSON-вывода первого хода в `--resume`, а не пустую строку. Resume — только по `session_id`, который вернул `--output-format json` (см. фаза 1.4).

- [ ] **7.3 Capture: заметка → запись в вику.** Кинь факт (без вопросительного знака — это «capture»-жест):
  ```
  Идея: сделать локальную транскрипцию голосовых через whisper.cpp
  ```
  Ожидаем: ack «принял». Проверь, что движок дописал страницу в приватный репо:
  ```bash
  cd ~/llm-wiki-content && git log --oneline -5 && git show --stat HEAD
  ```
  RU: каждый ход движка — обычный git-diff (ревьюится, откатывается). Блоки `<!-- keep -->` движок не трогает. По контент-модели ([ADR-0010](../docs/adr/0010-wiki-content-model.md)) идея ложится в `ideas/`, а не в простыню кода.

- [ ] **7.4 Безопасность: чужой чат дропается** (single-user allow-list, [ADR-0009](../docs/adr/0009-tos-safe-engine-access.md)). (Опционально, если есть второй Telegram-аккаунт.) Напиши боту с другого аккаунта — ожидаем **молчание** (мост дропает апдейт, чей `chat_id` ≠ `TELEGRAM_OWNER_CHAT_ID`, и логирует это без ответа).

- [ ] **7.5 Плановое: вручную дёрнуть sweep** (не ждать расписания). Запусти агент немедленно:
  ```bash
  launchctl kickstart -k gui/$(id -u)/ru.secondbrain.digest
  ```
  Ожидаем: в Telegram приходит дайджест (если есть due-напоминания) **или** тихий no-op (если due нет). Проверь журнал планировщика:
  ```bash
  cat ~/llm-wiki-content/reminders/log.md   # строка вида: ## [YYYY-MM-DD] fired | <ids> | <summary>
  ```
  RU: чтобы гарантированно увидеть пуш — заранее заведи одно due-напоминание на «сейчас» в `~/llm-wiki-content/reminders/reminders.md` (формат — в [`scheduler/reminders_spec.md`](../scheduler/reminders_spec.md): `due_at` в ISO 8601 с таймзоной). Sweep идемпотентен: повторный запуск не задвоит уже сработавшее (дедуп по `status`/`last_fired`).

- [ ] **7.6 (Контроль лимитов/`$0`).** Проверь живой запас лимитов подписки:
  ```bash
  claude   # внутри интерактивной сессии: /status (или /cost)
  ```
  RU: для одного пользователя лимиты Max необязывающи, но при болтливом боте мост ответит «лимит, попробуй позже» вместо stack-trace. С 15.06.2026 следи **отдельно** за Agent-SDK-кредитом ([ADR-0009](../docs/adr/0009-tos-safe-engine-access.md)): скриптовый `claude -p` тянет из него, а не из интерактивных лимитов.

---

## Phase 8 — Первый ингест: LLM-чаты + Telegram → `raw/`

> По контент-модели ([ADR-0010](../docs/adr/0010-wiki-content-model.md), [CONTEXT §6 OQ-1](../CONTEXT.md)) сердце вики — концепции/развитие/идеи, а лучшие первые источники — **экспорты твоих чатов со ВСЕМИ LLM** (ChatGPT/Claude/Grok) и **Telegram-экспорт**. Ингест идёт через **fail-closed sanitizer** в immutable `raw/`. Дальше — постоянная инкрементальная подгрузка по watermark.

- [ ] **8.1 Экспортировать чаты LLM.** Скачай свои истории (везде, где они есть):
  - **ChatGPT:** Settings → Data Controls → **Export data** → письмо со ссылкой на `conversations.json` (внутри zip).
  - **Claude:** Settings → Privacy / Account → **Export data** → архив с диалогами (JSON).
  - **Grok / X:** экспорт диалогов Grok или X-archive, если пользуешься.
  RU: точные форматы парсит коннектор `src/ingest/llm-chat.ts` (по [ADR-0010](../docs/adr/0010-wiki-content-model.md)); коннекторы YouTube/X/VK/WhatsApp в TS-порт пока **не перенесены** — это запланированные будущие модули ([ADR-0012](../docs/adr/0012-language-typescript-port.md)).

- [ ] **8.2 Экспортировать данные из Telegram Desktop.** В **десктопном** клиенте (не мобильном): **Settings → Advanced → Export Telegram data** (или по конкретному чату: ⋮ → **Export chat history**). Формат — **Machine-readable JSON**. Получишь каталог с `result.json`.

- [ ] **8.3 Сухой прогон sanitizer** (убедиться, что маскер жив — он fail-closed). После `pnpm build` дёрни скомпилированный модуль (синтетический ввод):
  ```bash
  cd ~/llm-wiki
  node --input-type=module -e "import('./dist/ingest/sanitizer.js').then(m => console.log(m.scanSecrets('token=ghp_FAKE1234567890 phone +7 999 123-45-67')))"
  ```
  Ожидаем непустой список найденных секретов → значит детекция работает. (Полный набор векторов — `pnpm test`, vitest: `src/ingest/sanitizer.test.ts`, в т.ч. кириллические boundary-кейсы — [ADR-0012](../docs/adr/0012-language-typescript-port.md).)
  > ⚠️ Если sanitizer падает — ингест **отменяется** (fail-closed): ни одного немаскированного байта не должно попасть в `raw/`/git. Это инвариант ([CONTEXT §3](../CONTEXT.md)).

- [ ] **8.4 Запустить ингест** Telegram-экспорта → sanitized markdown в `raw/` (после `pnpm build`):
  ```bash
  cd ~/llm-wiki
  node dist/ingest/telegram-export.js /путь/к/экспорту/result.json --raw-dir ~/llm-wiki-content/raw
  ```
  RU: точные флаги — в `ingest/README.md`. Парсер берёт `text_entities` (не полиморфное `text`), пишет provenance-frontmatter и двигает watermark **после** успешной записи → повторный ингест идемпотентен. Для LLM-чатов используй коннектор `node dist/ingest/llm-chat.js ... --engine <chatgpt|claude|grok>` (см. `ingest/README.md`).

- [ ] **8.5 Проверить результат.**
  ```bash
  ls ~/llm-wiki-content/raw
  cd ~/llm-wiki-content && git add raw && git status
  ```
  Глазами просмотри пару файлов: токены/телефоны/emails должны быть замаскированы (`[REDACTED]` / mask). Затем коммить в **приватный** репо.

- [ ] **8.6 Скормить движку для построения вики.** В Telegram-чате с ботом (или плановой compile-routine) попроси разобрать свежий `raw/` в страницы `wiki/` — движок дочитает от watermark и инкрементально заполнит `ideas/`/`concepts/`/`growth/`/`people/`/`projects/` ([ADR-0010](../docs/adr/0010-wiki-content-model.md)). Проверь git-diff приватного репо.

  > RU: код/технические сессии **не пишем verbatim** — извлекаем «что предметно сделал» → агрегируется в `capability-profile` ([ADR-0010](../docs/adr/0010-wiki-content-model.md)). graphify по кодовым базам (`codebase`-коннектор — **запланирован**, в TS-порт пока не перенесён, [ADR-0012](../docs/adr/0012-language-typescript-port.md)) пойдёт **отдельным** треком, **минуя** sanitizer (код — не PII). Дальнейшие источники (YouTube Takeout → X archive → VK → WhatsApp) — те же шаги через будущие коннекторы в `src/ingest/`.

---

## Troubleshooting

> Подобрано из research-доклада ([engine-runtime](../docs/research/engine-runtime.md), [proactive-scheduling](../docs/research/proactive-scheduling.md), [telegram-interface](../docs/research/telegram-interface.md), [privacy-security](../docs/research/privacy-security.md)) и ADR-0008/0009.

### Движок / Claude Code

- **`claude -p` падает с auth-ошибкой / «not logged in» / нет ответа.** Повтори вход под подпиской:
  ```bash
  claude   # /login (или повторный sign-in во flow); выбери Subscription / Claude Max
  ```
  RU: при **активном** использовании (мост + sweep) сессия рефрешится сама; проблема всплывает после долгого простоя или смены аккаунта.
- **Подозрение на per-token-биллинг (нарушение `$0`).** Убедись, что в окружении **нет** `ANTHROPIC_API_KEY` (фаза 1.5) и что вход сделан под подпиской, а не ключом. С 15.06.2026 скриптовый `claude -p` тянет из **Agent-SDK-кредита** — это ожидаемо ([ADR-0009](../docs/adr/0009-tos-safe-engine-access.md)), но следи за его остатком (`/status`).
- **Бот «забывает» контекст между сообщениями.** Мост обязан брать `session_id` из JSON-вывода (`--output-format json`) первого хода и передавать его в `--resume <session_id>` на следующем (фаза 1.4). Пустой/невалидный id → каждый ход стартует новую сессию.
- **`claude`-бинарь не найден из launchd.** launchd-окружение урезано. Пропиши абсолютный путь к `claude` или добавь его каталог в `PATH` через `EnvironmentVariables` плиста (фаза 6.1).
- **⚠️ Не пытайся «ускорить» движок, вытащив OAuth-токен в свой HTTP-клиент.** Это банённый паттерн (OpenClaw) и прямое нарушение [ADR-0009](../docs/adr/0009-tos-safe-engine-access.md). Только официальный бинарь `claude`.

### Плановое / машина уснула

- **Дайджест не пришёл вовремя.** Локальный launchd ловит **сон** (запускает пропущенную задачу при пробуждении и коалесцирует пропуски), но **не выключение** ([ADR-0005](../docs/adr/0005-host-v1-macbook-portable.md)). Если Mac был полностью выключен в момент `due` — слот не отыграется. Митигации: `RunAtLoad=true` в плисте + опц. `sudo pmset repeat wakeorpoweron ...` + **remote Claude routine** (фаза 6.5) как 24/7-обход.
- **Дайджест задвоился.** Sweep дедуплит по `status`/`last_fired`. Если двоит — проверь, что `run_sweep.sh` помечает сработавшие напоминания и что в `reminders.md` нет двух записей с одним смыслом. **Особый случай:** одновременно работают локальный `ru.secondbrain.digest` **и** remote routine — оставь что-то одно для проактива или убедись, что оба пишут общий `status` в приватном репо.
- **Агент launchd не стартует.** `launchctl list | grep secondbrain` → если код выхода ненулевой, смотри `StandardErrorPath` из плиста. Частые причины: неправильный абсолютный путь к интерпретатору/`.env`/`claude`, плист не прошёл `plutil -lint`, LaunchAgent работает только пока пользователь залогинен в GUI.
- **`caffeinate` высадил батарею.** Не держи его постоянно — он должен оборачивать **только** sweep (`caffeinate <command>`), а не висеть демоном.

### Telegram / webhook

- **Бот молчит на сообщения.** Проверь `getWebhookInfo` (`last_error_message`, `pending_update_count`). Частые причины: туннель не поднят (`curl https://.../health` извне), мост лежит (`launchctl list`), `secret_token` в `setWebhook` не совпадает с `TELEGRAM_WEBHOOK_SECRET` в `.env` (мост вернёт 403/дропнет), или твой `chat_id` ≠ `TELEGRAM_OWNER_CHAT_ID` (мост дропает по allow-list).
- **«chat not found» / 403 при проактивном пуше.** Ты не нажал `/start` у бота, либо позже заблокировал его. Бот не может писать первым — открой чат и нажми Start.
- **Поставил webhook, но раньше поллил `getUpdates`.** Они взаимоисключающи. `deleteWebhook` перед polling, и заново `setWebhook` после.
- **`setWebhook` отверг secret.** Charset ограничен `A-Z a-z 0-9 _ -`. Используй `randomBytes(32).toString('base64url')` (фаза 3.5); `+`,`/`,`=` из обычного base64 не пройдут.
- **Cloudflare Access блокирует webhook.** Если включил Zero-Trust Access на hostname — интерактивный логин убьёт доставку webhook. Нужен service-token / bypass-правило, скоупленное на путь `/telegram/webhook`.

### Лимиты / rate limits

- **Бот отвечает «лимит, попробуй позже».** Упёрся в окно подписки Max (5ч / неделя) или в Agent-SDK-кредит. Проверь живой запас: `claude` → `/status`. Мост делает backoff на limit-ошибке, а не долбёжку. Для одного пользователя лимиты необязывающи; болтливый сценарий — повод для дешёвого «anything due?»-предчека перед спавном движка.
- **Слишком много спавнов от sweep.** 30-мин `StartInterval` = до ~48 `claude -p`/день даже когда ничего не due. Под подпиской приемлемо, но `scheduler` делает дешёвый детерминированный предчек «есть ли due?» (`reminders.ts`, без движка/сети) **до** спавна движка, экономя лимиты/кредит.

### Граница двух репо / утечки

- **Подозрение, что личное попало в PUBLIC-репо.** Прогони локальный линт (он импортирует `scanSecrets` из `src/ingest/sanitizer.ts` и фейлится на находке):
  ```bash
  cd ~/llm-wiki && pnpm build && node dist/scheduler/lint-public.js --root .
  # короче (после сборки): pnpm lint:public
  ```
  RU: первичная гарантия — **граница двух репо** (PUBLIC физически не содержит `raw/`/`wiki/`), sanitizer/линт — бэкстопы. В PUBLIC-репо — **ни одного** реального email/телефона/`chat_id`/токена; любой пример синтетический («Иван Пример», фейковые даты/id). Если секрет уже в git-истории — его мало удалить: надо **ротировать** и переписать историю (она immutable во всех клонах).

---

## Готово

Когда все галочки Phase 0–7 проставлены — «Второй мозг» живой: реактивные ответы и capture в Telegram (`claude -p` через мост) + плановые пуши по расписанию (launchd и/или remote Claude routine). Phase 8 — первое наполнение реальными данными (LLM-чаты + Telegram).

Дальнейшее (по мере появления железа/нужды): полный переход на **remote Claude routines** для 24/7-проактива ([CONTEXT §4 / OQ-3](../CONTEXT.md)), голосовые через whisper.cpp ([OQ-2](../CONTEXT.md)), calendar-sync ([OQ-3](../CONTEXT.md)), остальные коннекторы ингеста, опциональный **Grok-advisor** (appendix ниже, [OQ-4](../CONTEXT.md)).

---

## Appendix A — (Опционально) добавить Grok-advisor-адаптер позже

> Grok — **отложенный** опциональный advisor-голос (A/B жизненных советов), его единственная уникальная ценность — субъективное доверие владельца, релевантна сердцу вики про развитие ([ADR-0008](../docs/adr/0008-engine-claude-native.md), [CONTEXT §6 OQ-4](../CONTEXT.md)). v1 на нём **не** строится; этот appendix — на будущее.

- [ ] **A.1 Выбрать backend Grok.** Два допустимых пути:
  - **Grok Build CLI** (официальный бинарь): `grok -p "<prompt>" --output-format json` — форма 1:1 с `claude -p`, парсим текст результата + session-id, resume по session-флагу.
  - **OpenClaw → Grok.** OpenClaw **xAI-санкционирован именно для Grok** ([ADR-0009](../docs/adr/0009-tos-safe-engine-access.md)). ⚠️ Это разрешено **только** на Grok-стороне; для Claude OpenClaw **забанен** — там исключительно официальный `claude`.
- [ ] **A.2 Реализовать адаптер `GrokEngine`** в `src/bridge/engine.ts` по образцу `ClaudeEngine` (тот же контракт `engine.run() → { answer, sessionId, usage }`, spawn-fresh-per-task). Слот уже зарезервирован.
- [ ] **A.3 Включить через `.env`:** `ENGINE=grok` + `GROK_BIN=grok` (или конфиг OpenClaw-бэкенда). Дальше — как двух-мозговый роутер (Claude-doer + Grok-advisor), если решишь A/B-советы; роутер тривиально доращивается ([ADR-0008](../docs/adr/0008-engine-claude-native.md)).

## Appendix B — (Опционально, отложено) Codex-адаптер

> Codex был primary в [ADR-0001](../docs/adr/0001-engine-subscription-codex.md), **superseded** разворотом на Claude-native ([ADR-0008](../docs/adr/0008-engine-claude-native.md)): у владельца **нет** ChatGPT-подписки. Адаптер сохранён как отложенный портируемый слот — на случай, если ChatGPT-подписка появится или понадобится engine-portability.

- [ ] **B.1 Установить Codex CLI:** `brew install codex` (или cask), `codex --version`.
- [ ] **B.2 Войти под подпиской ChatGPT** (НЕ по API-ключу): `codex login` → «Sign in with ChatGPT» на Plus/Pro-аккаунте. Никакого `OPENAI_API_KEY` в окружении.
- [ ] **B.3 Запереть конфиг** `~/.codex/config.toml`: `forced_login_method="chatgpt"`, `approval_policy="never"`, `sandbox_mode="workspace-write"`, `writable_roots=["<приватный_репо>"]`, `network_access=false` ([ADR-0007](../docs/adr/0007-engine-spawn-and-scheduler.md)).
- [ ] **B.4 ВЫКЛЮЧИТЬ обучение модели** на твоём контенте **до** первого ингеста: ChatGPT → Settings → Data Controls → off «Improve the model for everyone» (consumer-аккаунт обучается по умолчанию; ~30-дн abuse-retention даже после opt-out — true ZDR только Enterprise).
- [ ] **B.5 Включить через `.env`:** `ENGINE=codex` + `CODEX_BIN=codex` + `CODEX_MODEL=<модель>`. Адаптер `CodexEngine` в `src/bridge/engine.ts` спавнит `codex exec [resume <sid>] --json ...` (resume только через `codex exec resume`, **никогда** `--ephemeral` на resume-пути — баг #15538).

> RU: при Codex-бэкенде проверка `$0` в фазе 1.5 меняется на `env | grep -i OPENAI_API_KEY` (ожидаем пусто), а проверка живого запаса в 7.6 — на `codex` → `/status`. Всё остальное в runbook'е (репо, Telegram, туннель, launchd, ингест) от движка не зависит.

## Связанные

- [../CONTEXT.md](../CONTEXT.md) · [../README.md](../README.md) · [../AGENTS.md](../AGENTS.md) · [../compiler/rules.md](../compiler/rules.md)
- [../bridge/README.md](../bridge/README.md) · [../ingest/README.md](../ingest/README.md) · [../scheduler/README.md](../scheduler/README.md)
- ADR: [0008](../docs/adr/0008-engine-claude-native.md) · [0009](../docs/adr/0009-tos-safe-engine-access.md) · [0010](../docs/adr/0010-wiki-content-model.md) · [0004](../docs/adr/0004-telegram-bridge-reactive-proactive.md) · [0005](../docs/adr/0005-host-v1-macbook-portable.md) · [0006](../docs/adr/0006-github-account-kengston.md) · [0007](../docs/adr/0007-engine-spawn-and-scheduler.md)
- Research: [engine-runtime](../docs/research/engine-runtime.md) · [telegram-interface](../docs/research/telegram-interface.md) · [proactive-scheduling](../docs/research/proactive-scheduling.md) · [privacy-security](../docs/research/privacy-security.md) · [data-ingestion](../docs/research/data-ingestion.md)
</content>
</invoke>
