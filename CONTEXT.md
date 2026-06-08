---
title: CONTEXT — личный «Второй мозг» (personal LLM-wiki)
type: overview
status: in-progress
last_updated: 2026-06-07
---

# CONTEXT — Второй мозг

> Живой контекст проекта: что строим, какими словами называем, какие решения зафиксированы. «Истина для агентов и людей». Обновляется по мере кристаллизации решений (через `/grill-with-docs` → [ADR](docs/adr/)). Гриллинг-итерации от 2026-05-31 (включая разворот движка Codex→Claude-native) — в [docs/adr/](docs/adr/) и [log.md](log.md).
>
> Паттерн-первоисточник: Karpathy LLM-Wiki + Vannevar Bush Memex. Прообразы реализации — корпоративный `abcage-wiki` (тот же автор) и план `pachca-codex-bridge-plan` (ремап мессенджер↔агент).

## 1. Что строим (одним абзацем)

`Второй мозг` — личный ИИ-ассистент как **персональная LLM-wiki** по паттерну Карпатого (репозиторий markdown + git, **без векторной базы**), которую инкрементально ведёт **агентный CLI (Claude Code)**. Сердце вики — **концепции, развитие, идеи** про владельца (техническое — сильное, но сжатое: «что я сделал», а не код verbatim — [ADR-0010](docs/adr/0010-wiki-content-model.md)). Интерфейс — **Telegram-бот «Второй мозг»**: реактивные ответы + проактивные напоминания + агентные действия («руки»: web/computer). Два репозитория: публичный фреймворк-портфолио (`personal-llm-wiki`, без личных данных) + приватный контент (`llm-wiki-content`).

## 2. Границы (что это и что НЕ это)

- **Публичный репо** (`personal-llm-wiki`, this) — **ТОЛЬКО фреймворк** (TypeScript, Node 24 — [ADR-0012](docs/adr/0012-language-typescript-port.md)): код `src/bridge`/`src/ingest`/`src/scheduler`, `compiler/rules`, концепт-доки, research, **sanitized-пример** вики, README/SETUP. **Ни одного** личного факта, токена, email, имени-контакта. Гард — `.gitignore` + `src/scheduler/lint-public.ts` (`pnpm lint:public`, скан PII/секретов перед коммитом).
- **Приватный репо** (`llm-wiki-content`) — личные данные: `raw/` (sanitized снапшоты, в т.ч. экспорты LLM-чатов), `wiki/` (страницы обо мне), `reminders/`. Секреты — только в `.env` (gitignored).
- **В вики только СТАБИЛЬНОЕ** знание (идеи, концепции, люди, цели, capability-profile). Эфемерное («во сколько встреча завтра») — в `scheduler/reminders`, не размазываем по прозе.
- Это **НЕ** SaaS и **НЕ** многопользовательский продукт: один пользователь, своя машина, личное автоматизирование своего же аккаунта ([ADR-0009](docs/adr/0009-tos-safe-engine-access.md)).

## 3. Ключевые инварианты (не нарушать)

- **Движок — Claude-native, официальный бинарь** (`claude -p --output-format json`), single-user ([ADR-0008](docs/adr/0008-engine-claude-native.md), [ADR-0009](docs/adr/0009-tos-safe-engine-access.md)). Никогда не реюзать OAuth-токен в стороннем клиенте. Bridge **engine-portable**: `GrokEngine`/`CodexEngine` — отложенные адаптеры-слоты.
- **Read-only к источникам; `raw/` immutable.**
- **Sanitizer в write-path (fail-closed):** маскируем токены/пароли/телефоны/emails ДО записи в `raw/` и ДО любого попадания в публичный репо.
- **Фильтр контента — две оси + роутер задач ([ADR-0011](docs/adr/0011-relevance-sensitivity-filter.md), [compiler/relevance-policy.md](compiler/relevance-policy.md)).** Sibling к sanitizer (не внутри: секреты fail-closed/abort, чувствительность fail-to-quarantine). **Ось A — чувствительность** (`src/ingest/classifier.ts`, on-device, ДО облака; v1 — Tier-1 детерминированный, без ML/embedder). **Ось B — релевантность/важность** на compile (промоутить-vs-settle-vs-leave-in-raw). Плюс **роутер «задача vs знание»** (консервативен в сторону знания; на сомнении — дуал-роут, чтобы не терять ростовой сигнал). **Финансы/здоровье/право — ХРАНИМ как знание** (`keep_redact_spans`: sanitizer маскирует карты/IBAN), а НЕ карантиним; карантин — для NSFW/чужих персданных/токсика. Карантин **побеждает** лейн.
- **`raw/.quarantine/` и `raw/.tasks/` — поддиректории ВНУТРИ иммутабельного `raw/`.** Карантин (целый чувствительный док) и лейн задач (`raw/.tasks/inbox/` + `tasks/log.md`) исключены из промоушна в `wiki/` (compile/query/digest/resurface) **явным пропуском dot-папок** через `shouldSkipRawPath` (рекурсивный обход сам их НЕ пропускает — нужна явная проверка, что какая-либо часть пути начинается с «.»). «drop» = «не промоутить», хард-delete нет (`raw/` иммутабелен). Каждая ненормальная диспозиция → строка в `raw/.filter-log.jsonl` (приватный репо, **только метаданные/хэш, НИКОГДА содержимое**) + человеко-строка в `log.md` (verb `filter`). Ревью карантина и дайджест читают **лог/метаданные, не тела** (изоляция инъекций).
- **Инкрементально:** агент дописывает; каждый коммит — git-diff; блоки `<!-- keep -->` не трогаем.
- **Без embedder/векторной базы** ([ADR-0002](docs/adr/0002-no-embedder-pure-karpathy.md)) — ранжирует сам LLM-клиент; поиск через `index.md` (+ опц. FTS5 позже).
- **Watermark на источник** двигается после успешной записи → идемпотентность.
- **Контент-модель ([ADR-0010](docs/adr/0010-wiki-content-model.md)):** концепции/развитие/идеи-first; код-сессии → accomplishment/capability-выжимка, не verbatim.
- **Публичное ≠ приватное:** линт публичного репо проверяет отсутствие PII/секретов.

## 4. Архитектура (резюме) — три слоя исполнения

```
РЕАКТИВ:   Telegram (owner-only) → Bridge → ClaudeEngine (claude -p --json) → ответ/правка вики
ПЛАНОВОЕ:  routine (Claude routine / launchd) → claude -p → compile вики / дайджест / lint / web-research → Telegram
СОБЫТИЙНОЕ: новый source в raw/ → trigger → compile
```

- **Движок:** Claude Code (официальный бинарь) = интерактивный мозг + «руки» (web/computer-агент через MCP) + компилятор вики.
- **Стек фреймворка:** **TypeScript** (Node 24, strict ESM) — порт с Python ([ADR-0012](docs/adr/0012-language-typescript-port.md), зеркалит `abcage-mcp-hub`): Fastify + pino + zod + dotenv-flow + `node:sqlite` + luxon + rrule + vitest, `pnpm`. Исходники в `src/`, сборка в `dist/` (`pnpm build`). Язык **не несущий** — инварианты держит поведение + тесты, не язык/число зависимостей.
- **Bridge:** тонкий **Fastify**-мост (~150 строк), owner-only allow-list, абстракция `Engine` (дефолт `ClaudeEngine`).
- **Routines/triggers-слой:** плановое — compile/ingest (ночью), дайджест+напоминания (утром), lint (еженедельно), плановый web-research, resurfacing идей. **Remote Claude routines** срабатывают даже при спящем Mac (работают над приватным GitHub-репо) — апгрейд к `launchd`-локальному ([ADR-0005](docs/adr/0005-host-v1-macbook-portable.md)).
- **Память:** LLM-wiki (markdown). Источники: заметки + **чаты со всеми LLM** (инкрементально) + позже мессенджеры.
- **Grok** — опциональный отложенный advisor-голос (A/B жизненных советов), добавляется адаптером.

## 5. Терминология (короткий якорь)

- **Второй мозг** — вся система (движок + вики + бот + routines). _Avoid_: «бот» (это только интерфейс).
- **Движок** — Claude Code (официальный CLI), ведёт вики и действует. _Avoid_: «модель», «API».
- **Bridge** — мост Telegram ↔ движок. **Engine / адаптер** — `ClaudeEngine` (дефолт), `GrokEngine`/`CodexEngine` (слоты).
- **routine** — плановый cron-триггер (Claude routine или launchd), зовущий движок.
- **`raw/` / `wiki/` / `compiler/`** — сырьё (immutable) / страницы / правила.
- **capability-profile** — деривативная страница «на что я способен» (выжимка из код-сессий).
- **публичный фреймворк-репо** (`personal-llm-wiki`) vs **приватный контент-репо** (`llm-wiki-content`).

## 6. ⚠️ Открытые вопросы

- **OQ-1. Приоритет источников.** Рекомендация: **LLM-чаты + Telegram-экспорт первыми**, дальше YouTube Takeout → X archive → VK → WhatsApp.
- **OQ-2. Голосовые заметки** (локальный Whisper) — позже.
- **OQ-3. Планировщик:** v1 — локальный `launchd`; апгрейд — remote Claude routines для 24/7-проактива (данные в приватном GitHub-репо).
- **OQ-4. Grok-адаптер:** когда добавим advisor-голос и A/B жизненных советов.
- **OQ-5. Капабилити-руки** (browser/computer/messenger MCP) — фазовый roadmap, с анти-бот/ToS-оговорками (Facebook/Messenger — серая зона).
- **OQ-6. Tier-2 ML-классификатор чувствительности** ([ADR-0011](docs/adr/0011-relevance-sensitivity-filter.md)) — **отложен** в отдельный будущий ADR: локальная модель тянет тяжёлую ML-зависимость в лёгкое детерминированное ingest-ядро (триггер [ADR-0002](docs/adr/0002-no-embedder-pure-karpathy.md) — это FTS5, а не нейросеть), требует калибровки на RU-данных. v1 — только Tier-1 детерминированный (после TS-порта — на встроенных `RegExp`/`String.normalize`, [ADR-0012](docs/adr/0012-language-typescript-port.md): инвариант несёт поведение, не число зависимостей).

## Связанные

- [docs/adr/](docs/adr/) · [README.md](README.md) · [AGENTS.md](AGENTS.md) · [compiler/rules.md](compiler/rules.md) · [docs/research/](docs/research/) · [setup/SETUP.md](setup/SETUP.md)
