---
title: Ингест — слой загрузки источников
type: overview
status: in-progress
last_updated: 2026-06-08
sources:
  - ../docs/research/data-ingestion.md
  - ../docs/research/privacy-security.md
  - ../docs/adr/0011-relevance-sensitivity-filter.md
  - ../docs/adr/0012-language-typescript-port.md
---

# Ингест — слой загрузки источников

> Загружает личные источники (переписки, история, посты, кодовые базы) в приватный `raw/` через **fail-closed-sanitizer**. Только этот слой пишет в `raw/`; sanitizer гоняется ДО первой записи (CONTEXT §3). Публичный репо НЕ содержит `raw/` — он держит только этот код + синтетический пример ([ADR-0003](../docs/adr/0003-two-repos-public-private.md)).

## Что внутри

> Реализация — **TypeScript** (Node 24, strict ESM), порт с Python ([ADR-0012](../docs/adr/0012-language-typescript-port.md)). Исходники под `src/ingest/`, запускается собранный `dist/ingest/*.js` (`pnpm build`). Текст-ядро — на встроенных `RegExp` / `String.normalize('NFKC')` / `node:crypto` (идиоматичный выбор инструмента; инвариант несёт **поведение** + тесты, не число зависимостей — [ADR-0012](../docs/adr/0012-language-typescript-port.md)).

| Файл | Роль |
|---|---|
| [`src/ingest/sanitizer.ts`](../src/ingest/sanitizer.ts) | **Корона.** Маскер секретов/PII в write-path (fail-closed). Владелец маскирования; переиспользуется [`src/scheduler/lint-public.ts`](../src/scheduler/). |
| [`src/ingest/classifier.ts`](../src/ingest/classifier.ts) | **Tier-1 фильтр чувствительности + роутер «задача vs знание»** ([ADR-0011](../docs/adr/0011-relevance-sensitivity-filter.md)). Sibling к sanitizer (не внутри): fail-**to-quarantine**, маршрутизирует **целый** документ. Детерминированный, без ML/embedder. Реализован. |
| [`src/ingest/watermark.ts`](../src/ingest/watermark.ts) | Per-source JSON-курсор «дочитано до» → идемпотентный ре-ингест. |
| [`src/ingest/llm-chat.ts`](../src/ingest/llm-chat.ts) | Парсер экспортов диалогов **ChatGPT / Claude / Grok** → sanitized markdown + выжимка идей/концепций/решений; код-сессии → accomplishment-сводка ([ADR-0010](../docs/adr/0010-wiki-content-model.md)). Реализован. |
| [`src/ingest/telegram-export.ts`](../src/ingest/telegram-export.ts) | Парсер Telegram Desktop `result.json` → sanitized markdown. Реализован. |

**Отложенные коннекторы (в TS-порт пока НЕ перенесены — [ADR-0012](../docs/adr/0012-language-typescript-port.md)).** Это **запланированные** будущие модули, не существующие файлы: VK, WhatsApp, YouTube Takeout, архив X/Twitter и код-трек `codebase`-graphify (последний — **минует sanitizer**, код не PII). В v1 реальны только два коннектора выше.

## Инварианты (не нарушать)

- **Read-only к источникам.** Коннекторы только читают экспорт, никогда не пишут в источник; `raw/` — immutable снапшот.
- **Sanitizer — в write-path, fail-closed.** КАЖДОЕ тело сообщения и имя отправителя проходят `failClosedSanitize` ДО записи. Если санитайзер не может гарантировать чистоту — бросается `SanitizerError`, файл НЕ пишется, watermark НЕ двигается.
- **Classifier — параллельный контракт, fail-to-quarantine ([ADR-0011](../docs/adr/0011-relevance-sensitivity-filter.md)).** Sibling к sanitizer (НЕ внутри — противоположная семантика отказа): чувствительность маршрутизирует **целый** документ, не маскирует подстроки. Зовётся на **write-site целого документа** (не в per-message цикле). Карантин предпочитает ложно-**положительные** (`raw/` хранит → дёшево); хард-delete нет. Карантин **побеждает** лейн задач. Каждая ненормальная диспозиция → строка в `raw/.filter-log.jsonl` (`filterLogRecord` — **только метаданные/хэш, НИКОГДА содержимое**) + человеко-строка в `log.md` (verb `filter`).
- **`raw/` иммутабелен, dot-папки исключены из промоушна (P0-1).** `raw/.quarantine/` и `raw/.tasks/` — поддиректории внутри `raw/`. ЛЮБОЙ читатель `raw/` (compile/query/digest/resurface) обязан фильтровать пути через `shouldSkipRawPath` — рекурсивный обход каталога НЕ пропускает dot-папки сам (нужна явная проверка, что часть пути начинается с «.»).
- **Watermark двигается только после успешной записи** → повторный ингест того же экспорта идемпотентен (дубли отсекаются по `last_message_id`).
- **Код — не PII** и идёт **отдельным треком, минуя sanitizer** (`codebase`-коннектор — отложен, [ADR-0012](../docs/adr/0012-language-typescript-port.md)).
- **Sanitizer не дублировать.** Единственный владелец маскирования — [`src/ingest/sanitizer.ts`](../src/ingest/sanitizer.ts); и ингест, и линт публичного репо импортируют его.

## Куда пишем (каталог `raw/`)

Путь к `raw/` приватного репо `llm-wiki-content` задаётся **флагом** или **переменной окружения** — мы НЕ угадываем путь:

```bash
# сначала сборка: pnpm build  (запускаем скомпилированный dist/)

# вариант 1: флаг
node dist/ingest/llm-chat.js conversations.json --engine claude --raw-dir ~/llm-wiki-content/raw
node dist/ingest/telegram-export.js result.json --raw-dir ~/llm-wiki-content/raw

# вариант 2: env (удобно для launchd/cron)
export LLM_WIKI_RAW_DIR=~/llm-wiki-content/raw
node dist/ingest/llm-chat.js conversations.json --engine chatgpt
node dist/ingest/telegram-export.js result.json
```

Структура на выходе:

```
raw/
├── .watermarks/            # служебные курсоры (один JSON на источник)
│   ├── llm_chat.json       # множество виденных conversation_id (по движкам)
│   └── telegram.json
├── .quarantine/            # ADR-0011: целые чувствительные доки (NSFW/чужие персданные/токсик)
│   └── <категория>/        #   исключено из compile/query/digest/resurface (dot-папка)
├── .tasks/                 # ADR-0011: лейн реактивных чор (билеты/покупки)
│   └── inbox/              #   исключено из compile, как карантин; видимая строка → tasks/log.md
├── .filter-log.jsonl       # ADR-0011: append-only ledger диспозиций (метаданные/хэш, НЕ содержимое)
├── llm_chat/
│   ├── chatgpt/
│   │   └── <slug>-<conv_id>.md  # одна страница на разговор, provenance-frontmatter
│   ├── claude/
│   │   └── <slug>-<conv_id>.md
│   └── grok/
│       └── <slug>-<conv_id>.md
└── telegram/
    └── <slug>-<chat_id>.md  # одна страница на диалог, provenance-frontmatter
```

> **Карантин/`.tasks/` — поддеревья ВНУТРИ иммутабельного `raw/`** (не отдельный каталог). Они начинаются с точки, поэтому `shouldSkipRawPath` исключает их из любого читателя `raw/` (рекурсивный обход каталога сам dot-папки НЕ пропускает). Финансы/здоровье/право **НЕ** карантинятся — они хранятся как обычное знание в `raw/<источник>/`, sanitizer лишь маскирует опасные подстроки (карты/IBAN).

> Запускать из корня публичного репо после `pnpm build`: `node dist/ingest/telegram-export.js <result.json> [--raw-dir ...]` (и аналогично `node dist/ingest/llm-chat.js ...`). Имена source-каталогов (`llm_chat/`, `telegram/`) и курсоров (`.watermarks/*.json`) при порте на TS **не менялись** — структура `raw/` стабильна.

## Рекомендованный порядок ингеста

Порядок (CONTEXT §6 OQ-1, подтверждён research и [ADR-0010](../docs/adr/0010-wiki-content-model.md)) — от самого богатого/ценного к сложному. **LLM-чаты + Telegram первыми**: сердце вики — концепции/развитие/идеи, а их главный носитель — переписки со всеми LLM (ADR-0010); Telegram рядом, чтобы заодно доказать sanitizer на реальном объёме до остальных.

1. **LLM-чаты** — `conversations.json` из ChatGPT / Claude / Grok. Реализован (`src/ingest/llm-chat.ts`). PII-риск средний (личные диалоги); код в выжимке схлопывается. Главный источник идей/концепций/решений и `capability-profile`.
2. **Telegram** — `result.json` (штатный JSON). Реализован (`src/ingest/telegram-export.ts`). PII-риск средний.
3. **YouTube** — Google Takeout `watch-history.json`. PII-риск низкий. **Планируется** (в TS-порт не перенесён — [ADR-0012](../docs/adr/0012-language-typescript-port.md)).
4. **X / Twitter** — архив `tweets.js`. PII-риск высокий (DM — в карантин). **Планируется.**
5. **VK** — VK API (предпочтительно) или cp1251 HTML-архив. PII-риск средний. **Планируется.**
6. **WhatsApp** — `_chat.txt` (вендорить парсер). PII-риск средний; можно отложить. **Планируется.**

> **Инкрементальность (ADR-0010).** LLM-чаты подгружаются не разово, а постоянно: новые выгрузки прогоняются тем же коннектором, watermark отсекает уже виденные `conversation_id` → доходят только новые разговоры. Это штатный режим, а не разовый импорт.

Параллельно (вне очереди, **минуя sanitizer**):

- **Код** — `codebase`-коннектор через `graphifyy`/скилл `/graphify` → `graph.json`. **Планируется** (в TS-порт не перенесён — [ADR-0012](../docs/adr/0012-language-typescript-port.md)).

## Как экспортировать каждый источник

### 1. LLM-чаты — ChatGPT / Claude / Grok (реализован)

Один коннектор, три формата экспорта (все — `conversations.json`). Полное описание каждого формата и его ловушек — в шапке-комментарии [`src/ingest/llm-chat.ts`](../src/ingest/llm-chat.ts).

- **ChatGPT (OpenAI):** Settings → Data controls → **Export data** → письмо со ссылкой на ZIP → внутри `conversations.json`. Ловушка: `mapping` — это **дерево** узлов (parent/children), а не плоский список; парсер реконструирует линейную ветку.
- **Claude (Anthropic):** Settings → Privacy/Account → **Export data** → ZIP с `conversations.json`. Ловушка: время — **ISO-строки** (`created_at`), роль зовётся `human` (нормализуется к `user`); текст — из массива `content` блоков `{type:"text"}`.
- **Grok (xAI):** выгрузка диалогов из аккаунта. Форма на 2026 подвижна → парсер **терпим** к синонимам ключей (`messages`/`responses`, `message`/`text`, `sender`/`role`) и к `create_time` числом ИЛИ строкой. Чаты Grok ингестим уже в v1, хотя сам Grok-**движок** — отложенный адаптер ([ADR-0008](../docs/adr/0008-engine-claude-native.md)): контент-модель не зависит от выбора движка.
- Запустить (после `pnpm build`; движок можно не указывать — авто-детект по форме):
  ```bash
  export LLM_WIKI_RAW_DIR=~/llm-wiki-content/raw
  node dist/ingest/llm-chat.js ~/Downloads/chatgpt-export/conversations.json --engine chatgpt
  node dist/ingest/llm-chat.js ~/Downloads/claude-export/conversations.json    # авто-детект
  node dist/ingest/llm-chat.js ~/Downloads/grok-export/conversations.json --engine grok
  ```
- Что на выходе (ADR-0010): на разговор — страница в `raw/llm_chat/<движок>/` с frontmatter, **выжимкой идей/концепций/решений** (по эвристическим маркерам) и санитизированной расшифровкой, где **код схлопнут** до `[code: <язык>, <N> строк]`. Для **код-тяжёлых** сессий (≥30 строк кода) добавляется секция **Accomplishment** («что построил, через что, навык, решения/уроки») — заготовка для `capability-profile`, которую финализирует компилятор вики. Повторный прогон того же экспорта — no-op (watermark по `conversation_id`).

**Большие экспорты.** Как и Telegram, v1 читает `conversations.json` целиком (`JSON.parse`) — надёжно для типичных выгрузок; потоковый разбор гигантских файлов — то же документированное расширение (заменить `loadExport()`), остальной конвейер не меняется.

### 2. Telegram (реализован)

1. **Telegram Desktop** (не мобильный) → ⋮ → **Settings → Advanced → Export Telegram data**.
2. Снять лишние галки (медиа можно не выгружать — парсер ставит пометку `[media: ...]` без файлов), формат — **Machine-readable JSON**.
3. Экспорт создаст папку с `result.json`.
4. Запустить (после `pnpm build`):
   ```bash
   export LLM_WIKI_RAW_DIR=~/llm-wiki-content/raw
   node dist/ingest/telegram-export.js ~/Downloads/Telegram\ Desktop/DataExport_*/result.json
   ```
5. Проверить созданные страницы в `raw/telegram/`. Повторный запуск того же файла — no-op (watermark).

**Большие экспорты.** v1 читает `result.json` целиком (`JSON.parse`) — надёжно для типичных дампов. Если файл гигантский и не влезает в память, потоковый разбор — документированное расширение: заменить `loadExport()` на потоковую итерацию по `chats.list[].messages[]`, остальной конвейер не меняется. Это сознательный trade-off v1, а не недоделка.

> §§3–6 и «Код» — **отложенные** коннекторы (в TS-порт пока НЕ перенесены, [ADR-0012](../docs/adr/0012-language-typescript-port.md)). Инструкции по экспорту и ловушки форматов сохранены как заготовка для будущих модулей `src/ingest/<name>.ts`.

### 3. YouTube (планируется)

- **takeout.google.com** → только «YouTube and YouTube Music» → история → формат **JSON** → скачать архив → `watch-history.json`.
- Ловушка: записи без `titleUrl` фильтровать; id видео — из `titleUrl`, канал — из `subtitles[0]`. (Будущий модуль `src/ingest/youtube-takeout.ts`.)

### 4. X / Twitter (планируется)

- **X → Settings → Your account → Download an archive of your data** → ZIP → `data/tweets.js`.
- Ловушка: файлы обёрнуты в `window.YTD.tweets.part0 = [...]` — срезать префикс до `[`, потом `JSON.parse`. `direct-messages.js`/`account.js` — **в карантин** (высокий PII). (Будущий модуль `src/ingest/x-archive.ts`.)

### 5. VK (планируется)

- Предпочтительно — **VK API** (`messages.getHistory`) с user-token (структурированный JSON).
- Альтернатива — **GDPR-архив** «Защита персональных данных» (HTML в **windows-1251**, не UTF-8). (Будущий модуль `src/ingest/vk.ts`.)

### 6. WhatsApp (планируется)

- В чате → **Ещё → Экспорт чата** → `_chat.txt` (+ опц. медиа).
- Ловушки: два формата (**iOS** vs **Android**), невидимые **LRM `U+200E`** / **NNBSP `U+202F`**, локали дат. **Вендорить готовый парсер**, не писать regex с нуля. (Будущий модуль `src/ingest/whatsapp.ts`.)

### Код (планируется, отдельный трек)

- Пакет **`graphifyy`** (две «y»!) или скилл `/graphify` строит `graph.json` локально (tree-sitter, теги EXTRACTED/INFERRED). **Код не гоняется через sanitizer.** Рабочий каталог `graphify-out/` — в `.gitignore`. (Будущий модуль `src/ingest/codebase-graphify.ts`.)

## Sanitizer — публичный интерфейс

Стабильный контракт (на него опирается линт публичного репо — не менять сигнатуры без согласования):

```ts
import { sanitizeText, scanSecrets, failClosedSanitize, SanitizerError } from '../src/ingest/sanitizer.js';

sanitizeText(text)        // -> string    маскирует секреты И PII, возвращает чистый текст
scanSecrets(text)         // -> string[]  только СЕКРЕТЫ (ярус-1), без мутации; для линта
failClosedSanitize(text)  // -> string    write-path: при любом сбое throw SanitizerError
```

Два яруса ([docs/research/privacy-security.md](../docs/research/privacy-security.md)):

- **Ярус-1 — секреты** (block-on-detect): regex известных форматов (Telegram bot token, OpenAI `sk-`, JWT, Bearer/Basic, PEM-ключи, GitHub/AWS/Google/Slack/Stripe, `password=...`, URL-credentials) **плюс энтропия Шеннона** для неизвестных high-entropy-блобов (base64 ≥ 4.5, hex ≥ 3.0, токены ≥ 20 символов). Находка → `[REDACTED:<type>]`. Сбой → abort записи.
- **Ярус-2 — PII** (mask-but-never-block): email, телефоны, карты, IBAN, IP, crypto-адреса. Имена/локации НЕ детектируются (NER лоссов; гарантия «ноль личного в публичном» — это граница двух репо + только синтетические примеры, а не детекция имён).

Самотесты (синтетика, без побочных эффектов):

```bash
pnpm exec vitest run src/ingest/sanitizer.test.ts    # проверки маскирования
pnpm exec vitest run src/ingest/watermark.test.ts    # проверки идемпотентности курсора
```

## Classifier — публичный интерфейс

Параллельный контракт sanitizer ([ADR-0011](../docs/adr/0011-relevance-sensitivity-filter.md)). Где **sanitizer** маскирует подстроки fail-closed, **classifier** решает диспозицию **целого** документа fail-to-quarantine и маршрутизирует «задачу vs знание». Политика — JSON-блок из [`compiler/relevance-policy.md`](../compiler/relevance-policy.md) + приватный `.filter-policy.local.json`-override (граница двух репо: лексиконы/имена — только приватно). Сигнатуры стабильны (на них опираются compile/digest — не менять без согласования):

```ts
import {
  classifySensitivity, routeLane, shouldSkipRawPath, filterLogRecord, loadPolicy,
} from '../src/ingest/classifier.js';

loadPolicy()                                    // -> Policy   JSON-блок политики + приватный override
classifySensitivity(text, sourceMeta, policy)   // -> Classification {label, action, tier, reason, score} — НИКОГДА не текст
routeLane(text, sourceMeta, policy)             // -> LaneDecision {lane, dualRoute, reason}
shouldSkipRawPath(path)                          // -> boolean  P0-1: true, если любая часть пути начинается с "."
filterLogRecord(rawPath, clf, { axis, lane, content, policyVersion })  // -> ledger-запись (sha256, НЕ содержимое)
```

Две оси + роутер ([ADR-0011](../docs/adr/0011-relevance-sensitivity-filter.md)):

- **Ось A — чувствительность** (здесь, on-device, ДО облака). Tier-1 детерминированный: `source_class` + `domain_blocklist` + (opt-in) `lexicon` + `pii_density`. БЕЗ ML, БЕЗ embedder (Tier-2 ML — отложен).
- **Диспозиции.** `quarantine`/`quarantine_and_redact` → весь док в `raw/.quarantine/<категория>/`, исключён из compile. `keep_redact_spans`/`leave_in_raw`/`normal` → обычный `raw/` (sanitizer уже замаскировал опасные подстроки), просто **логируем**. Финансы/здоровье/право по дефолту = `keep_redact_spans` (хранятся как знание, НЕ карантинятся).
- **Роутер «задача vs знание»** консервативен в сторону знания: диверт в `raw/.tasks/inbox/` + строка в `tasks/log.md` только при форме «императив + объект»; на сомнении — **дуал-роут** (и task-log, и видимо для compile), чтобы не терять ростовой сигнал. **Карантин побеждает лейн** (чувствительная чора → карантин, не в `.tasks/`).
- **Ось B — релевантность/важность** — НЕ здесь, а на compile-шаге (промоутить-vs-settle-vs-leave-in-raw); egress там уже оплачен.

Самотест (синтетика «Иван Пример», без побочных эффектов):

```bash
pnpm exec vitest run src/ingest/classifier.test.ts    # дым-тест классификации + роутера на синтетике
```

## Связанные

- [../docs/research/data-ingestion.md](../docs/research/data-ingestion.md) · [../docs/research/privacy-security.md](../docs/research/privacy-security.md) · [../docs/adr/0003-two-repos-public-private.md](../docs/adr/0003-two-repos-public-private.md) · [../docs/adr/0007-engine-spawn-and-scheduler.md](../docs/adr/0007-engine-spawn-and-scheduler.md) · [../docs/adr/0011-relevance-sensitivity-filter.md](../docs/adr/0011-relevance-sensitivity-filter.md) · [../compiler/relevance-policy.md](../compiler/relevance-policy.md) · [../CONTEXT.md](../CONTEXT.md) · [../compiler/rules.md](../compiler/rules.md) · [../scheduler/](../scheduler/)
