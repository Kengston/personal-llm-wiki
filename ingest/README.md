---
title: Ингест — слой загрузки источников
type: overview
status: in-progress
last_updated: 2026-05-31
sources:
  - ../docs/research/data-ingestion.md
  - ../docs/research/privacy-security.md
---

# Ингест — слой загрузки источников

> Загружает личные источники (переписки, история, посты, кодовые базы) в приватный `raw/` через **fail-closed-sanitizer**. Только этот слой пишет в `raw/`; sanitizer гоняется ДО первой записи (CONTEXT §3). Публичный репо НЕ содержит `raw/` — он держит только этот код + синтетический пример ([ADR-0003](../docs/adr/0003-two-repos-public-private.md)).

## Что внутри

| Файл | Роль |
|---|---|
| [`sanitizer.py`](sanitizer.py) | **Корона.** Маскер секретов/PII в write-path (fail-closed). Владелец маскирования; переиспользуется [`scheduler/lint_public.py`](../scheduler/). |
| [`watermark.py`](watermark.py) | Per-source JSON-курсор «дочитано до» → идемпотентный ре-ингест. |
| [`llm_chat.py`](llm_chat.py) | Парсер экспортов диалогов **ChatGPT / Claude / Grok** → sanitized markdown + выжимка идей/концепций/решений; код-сессии → accomplishment-сводка ([ADR-0010](../docs/adr/0010-wiki-content-model.md)). Реализован. |
| [`telegram_export.py`](telegram_export.py) | Парсер Telegram Desktop `result.json` → sanitized markdown. Реализован. |
| [`vk.py`](vk.py) | Коннектор VK — **стаб** (TODO). |
| [`whatsapp.py`](whatsapp.py) | Коннектор WhatsApp — **стаб** (TODO). |
| [`youtube_takeout.py`](youtube_takeout.py) | Коннектор YouTube Takeout — **стаб** (TODO). |
| [`x_archive.py`](x_archive.py) | Коннектор архива X/Twitter — **стаб** (TODO). |
| [`codebase_graphify.py`](codebase_graphify.py) | Код-трек через `graphifyy` — **стаб** (TODO), **минует sanitizer**. |

Все парсеры — **stdlib-only** (research: «stdlib-only парсеры в `ingest`»; вендорить парсер только для WhatsApp). Совместимо с системным `python3` (3.9+).

## Инварианты (не нарушать)

- **Read-only к источникам.** Коннекторы только читают экспорт, никогда не пишут в источник; `raw/` — immutable снапшот.
- **Sanitizer — в write-path, fail-closed.** КАЖДОЕ тело сообщения и имя отправителя проходят `sanitizer.fail_closed_sanitize` ДО записи. Если санитайзер не может гарантировать чистоту — поднимается `SanitizerError`, файл НЕ пишется, watermark НЕ двигается.
- **Watermark двигается только после успешной записи** → повторный ингест того же экспорта идемпотентен (дубли отсекаются по `last_message_id`).
- **Код — не PII** и идёт **отдельным треком, минуя sanitizer** (`codebase_graphify`).
- **Sanitizer не дублировать.** Единственный владелец маскирования — [`sanitizer.py`](sanitizer.py); и ингест, и линт публичного репо импортируют его.

## Куда пишем (каталог `raw/`)

Путь к `raw/` приватного репо `llm-wiki-content` задаётся **флагом** или **переменной окружения** — мы НЕ угадываем путь:

```bash
# вариант 1: флаг
python3 -m ingest.llm_chat conversations.json --engine claude --raw-dir ~/llm-wiki-content/raw
python3 -m ingest.telegram_export result.json --raw-dir ~/llm-wiki-content/raw

# вариант 2: env (удобно для launchd/cron)
export LLM_WIKI_RAW_DIR=~/llm-wiki-content/raw
python3 -m ingest.llm_chat conversations.json --engine chatgpt
python3 -m ingest.telegram_export result.json
```

Структура на выходе:

```
raw/
├── .watermarks/            # служебные курсоры (один JSON на источник)
│   ├── llm_chat.json       # множество виденных conversation_id (по движкам)
│   └── telegram.json
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

> Запускать модулем (`python3 -m ingest.telegram_export ...`) из корня публичного репо, чтобы работал импорт пакета `ingest`. Можно и одиночным файлом (`python3 ingest/telegram_export.py ...`) — модуль поддерживает оба способа.

## Рекомендованный порядок ингеста

Порядок (CONTEXT §6 OQ-1, подтверждён research и [ADR-0010](../docs/adr/0010-wiki-content-model.md)) — от самого богатого/ценного к сложному. **LLM-чаты + Telegram первыми**: сердце вики — концепции/развитие/идеи, а их главный носитель — переписки со всеми LLM (ADR-0010); Telegram рядом, чтобы заодно доказать sanitizer на реальном объёме до остальных.

1. **LLM-чаты** — `conversations.json` из ChatGPT / Claude / Grok. Реализован. PII-риск средний (личные диалоги); код в выжимке схлопывается. Главный источник идей/концепций/решений и `capability-profile`.
2. **Telegram** — `result.json` (штатный JSON). Реализован. PII-риск средний.
3. **YouTube** — Google Takeout `watch-history.json`. PII-риск низкий.
4. **X / Twitter** — архив `tweets.js`. PII-риск высокий (DM — в карантин).
5. **VK** — VK API (предпочтительно) или cp1251 HTML-архив. PII-риск средний.
6. **WhatsApp** — `_chat.txt` (вендорить парсер). PII-риск средний; можно отложить.

> **Инкрементальность (ADR-0010).** LLM-чаты подгружаются не разово, а постоянно: новые выгрузки прогоняются тем же коннектором, watermark отсекает уже виденные `conversation_id` → доходят только новые разговоры. Это штатный режим, а не разовый импорт.

Параллельно (вне очереди, **минуя sanitizer**):

- **Код** — `codebase_graphify` через `graphifyy`/скилл `/graphify` → `graph.json`.

## Как экспортировать каждый источник

### 1. LLM-чаты — ChatGPT / Claude / Grok (реализован)

Один коннектор, три формата экспорта (все — `conversations.json`, stdlib-only JSON). Полное описание каждого формата и его ловушек — в docstring [`llm_chat.py`](llm_chat.py).

- **ChatGPT (OpenAI):** Settings → Data controls → **Export data** → письмо со ссылкой на ZIP → внутри `conversations.json`. Ловушка: `mapping` — это **дерево** узлов (parent/children), а не плоский список; парсер реконструирует линейную ветку.
- **Claude (Anthropic):** Settings → Privacy/Account → **Export data** → ZIP с `conversations.json`. Ловушка: время — **ISO-строки** (`created_at`), роль зовётся `human` (нормализуется к `user`); текст — из массива `content` блоков `{type:"text"}`.
- **Grok (xAI):** выгрузка диалогов из аккаунта. Форма на 2026 подвижна → парсер **терпим** к синонимам ключей (`messages`/`responses`, `message`/`text`, `sender`/`role`) и к `create_time` числом ИЛИ строкой. Чаты Grok ингестим уже в v1, хотя сам Grok-**движок** — отложенный адаптер ([ADR-0008](../docs/adr/0008-engine-claude-native.md)): контент-модель не зависит от выбора движка.
- Запустить (движок можно не указывать — авто-детект по форме):
  ```bash
  export LLM_WIKI_RAW_DIR=~/llm-wiki-content/raw
  python3 -m ingest.llm_chat ~/Downloads/chatgpt-export/conversations.json --engine chatgpt
  python3 -m ingest.llm_chat ~/Downloads/claude-export/conversations.json    # авто-детект
  python3 -m ingest.llm_chat ~/Downloads/grok-export/conversations.json --engine grok
  ```
- Что на выходе (ADR-0010): на разговор — страница в `raw/llm_chat/<движок>/` с frontmatter, **выжимкой идей/концепций/решений** (по эвристическим маркерам) и санитизированной расшифровкой, где **код схлопнут** до `[code: <язык>, <N> строк]`. Для **код-тяжёлых** сессий (≥30 строк кода) добавляется секция **Accomplishment** («что построил, через что, навык, решения/уроки») — заготовка для `capability-profile`, которую финализирует компилятор вики. Повторный прогон того же экспорта — no-op (watermark по `conversation_id`).

**Большие экспорты.** Как и Telegram, v1 читает `conversations.json` целиком (`json.load`) — надёжно для типичных выгрузок; потоковый разбор гигантских файлов — то же документированное расширение (заменить `load_export()`), остальной конвейер не меняется.

### 2. Telegram (реализован)

1. **Telegram Desktop** (не мобильный) → ⋮ → **Settings → Advanced → Export Telegram data**.
2. Снять лишние галки (медиа можно не выгружать — парсер ставит пометку `[media: ...]` без файлов), формат — **Machine-readable JSON**.
3. Экспорт создаст папку с `result.json`.
4. Запустить:
   ```bash
   export LLM_WIKI_RAW_DIR=~/llm-wiki-content/raw
   python3 -m ingest.telegram_export ~/Downloads/Telegram\ Desktop/DataExport_*/result.json
   ```
5. Проверить созданные страницы в `raw/telegram/`. Повторный запуск того же файла — no-op (watermark).

**Большие экспорты.** v1 читает `result.json` целиком (`json.load`) — надёжно для типичных дампов. Если файл гигантский и не влезает в память, потоковый разбор (`ijson`) — документированное расширение: заменить `load_export()` на потоковую итерацию по `chats.list[].messages[]`, остальной конвейер не меняется. Это сознательный trade-off v1, а не недоделка.

### 3. YouTube (стаб)

- **takeout.google.com** → только «YouTube and YouTube Music» → история → формат **JSON** → скачать архив → `watch-history.json`.
- Ловушка: записи без `titleUrl` фильтровать; id видео — из `titleUrl`, канал — из `subtitles[0]`. См. docstring [`youtube_takeout.py`](youtube_takeout.py).

### 4. X / Twitter (стаб)

- **X → Settings → Your account → Download an archive of your data** → ZIP → `data/tweets.js`.
- Ловушка: файлы обёрнуты в `window.YTD.tweets.part0 = [...]` — срезать префикс до `[`, потом `json.loads`. `direct-messages.js`/`account.js` — **в карантин** (высокий PII). См. docstring [`x_archive.py`](x_archive.py).

### 5. VK (стаб)

- Предпочтительно — **VK API** (`messages.getHistory`) с user-token (структурированный JSON).
- Альтернатива — **GDPR-архив** «Защита персональных данных» (HTML в **windows-1251**, не UTF-8). См. docstring [`vk.py`](vk.py).

### 6. WhatsApp (стаб)

- В чате → **Ещё → Экспорт чата** → `_chat.txt` (+ опц. медиа).
- Ловушки: два формата (**iOS** vs **Android**), невидимые **LRM `U+200E`** / **NNBSP `U+202F`**, локали дат. **Вендорить готовый парсер**, не писать regex с нуля. См. docstring [`whatsapp.py`](whatsapp.py).

### Код (стаб, отдельный трек)

- Пакет **`graphifyy`** (две «y»!) или скилл `/graphify` строит `graph.json` локально (tree-sitter, теги EXTRACTED/INFERRED). **Код не гоняется через sanitizer.** Рабочий каталог `graphify-out/` — в `.gitignore`. См. docstring [`codebase_graphify.py`](codebase_graphify.py).

## Sanitizer — публичный интерфейс

Стабильный контракт (на него опирается линт публичного репо — не менять сигнатуры без согласования):

```python
from ingest.sanitizer import sanitize_text, scan_secrets, fail_closed_sanitize, SanitizerError

sanitize_text(text)        # -> str   маскирует секреты И PII, возвращает чистый текст
scan_secrets(text)         # -> list  только СЕКРЕТЫ (ярус-1), без мутации; для линта
fail_closed_sanitize(text) # -> str   write-path: при любом сбое raise SanitizerError
```

Два яруса ([docs/research/privacy-security.md](../docs/research/privacy-security.md)):

- **Ярус-1 — секреты** (block-on-detect): regex известных форматов (Telegram bot token, OpenAI `sk-`, JWT, Bearer/Basic, PEM-ключи, GitHub/AWS/Google/Slack/Stripe, `password=...`, URL-credentials) **плюс энтропия Шеннона** для неизвестных high-entropy-блобов (base64 ≥ 4.5, hex ≥ 3.0, токены ≥ 20 символов). Находка → `[REDACTED:<type>]`. Сбой → abort записи.
- **Ярус-2 — PII** (mask-but-never-block): email, телефоны, карты, IBAN, IP, crypto-адреса. Имена/локации НЕ детектируются (NER лоссов; гарантия «ноль личного в публичном» — это граница двух репо + только синтетические примеры, а не детекция имён).

Самотесты (синтетика, без побочных эффектов):

```bash
python3 -m ingest.sanitizer    # 16 проверок маскирования
python3 -m ingest.watermark    # 4 проверки идемпотентности курсора
```

## Связанные

- [../docs/research/data-ingestion.md](../docs/research/data-ingestion.md) · [../docs/research/privacy-security.md](../docs/research/privacy-security.md) · [../docs/adr/0003-two-repos-public-private.md](../docs/adr/0003-two-repos-public-private.md) · [../docs/adr/0007-engine-spawn-and-scheduler.md](../docs/adr/0007-engine-spawn-and-scheduler.md) · [../CONTEXT.md](../CONTEXT.md) · [../compiler/rules.md](../compiler/rules.md) · [../scheduler/](../scheduler/)
