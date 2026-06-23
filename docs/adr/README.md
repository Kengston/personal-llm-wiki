---
title: Индекс ADR — архитектурные решения «Второго мозга»
type: index
status: in-progress
last_updated: 2026-06-10
---

# Индекс ADR — «Второй мозг»

> Каталог architecture decision records проекта. Каждый ADR — короткое, дорого-обратимое решение с контекстом, альтернативами и следствиями. Решения кристаллизуются через `/grill-with-docs` (см. [CONTEXT.md](../../CONTEXT.md), [log.md](../../log.md)). Формат записи: статус во frontmatter, «## Связанные»-футер, относительные ссылки.

**Engine-pivot 2026-05-31.** Движок развёрнут с Codex на **Claude-native** ([ADR-0008](0008-engine-claude-native.md)) при ToS-безопасном доступе через официальный бинарь ([ADR-0009](0009-tos-safe-engine-access.md)) и уточнённой контент-модели ([ADR-0010](0010-wiki-content-model.md)). [ADR-0001](0001-engine-subscription-codex.md) (Codex primary) — **superseded**. Engine-агностичные решения (0002–0005, формат reminders/sweep в 0007) от разворота не зависят.

## Статусы

- **accepted** — действует.
- **superseded by ADR-NNNN** — заменён более поздним решением (исторический контекст сохранён).

## Каталог

| ADR | Решение (одной строкой) | Статус |
| --- | --- | --- |
| [0001](0001-engine-subscription-codex.md) | Движок — подписочный Codex CLI (не per-token API, не локальная модель). | **superseded by [0008](0008-engine-claude-native.md)** |
| [0002](0002-no-embedder-pure-karpathy.md) | Без embedder и векторной базы: чистый Karpathy LLM-wiki, ранжирует сам LLM-клиент через `index.md`. | accepted |
| [0003](0003-two-repos-public-private.md) | Два репозитория: публичный фреймворк-портфолио vs приватный контент (личные данные). | accepted |
| [0004](0004-telegram-bridge-reactive-proactive.md) | Интерфейс — Telegram-bridge: реактивные ответы + проактивные напоминания. | accepted |
| [0005](0005-host-v1-macbook-portable.md) | Хостинг v1 — текущий MacBook; код host-portable (апгрейд к remote routines). | accepted |
| [0006](0006-github-account-kengston.md) | Публичный репо на личном GitHub-аккаунте; создание через `gh auth login`. | accepted |
| [0007](0007-engine-spawn-and-scheduler.md) | Spawn-fresh-per-task, идемпотентный sweep (launchd + remote routine), формат `reminders.md`, принятие рисков ToS/prompt-injection. | accepted (updated 2026-05-31) |
| [0008](0008-engine-claude-native.md) | Движок v1 — **Claude-native** (`claude -p --output-format json`), engine-portable; Grok/Codex — отложенные адаптеры-слоты. | accepted |
| [0009](0009-tos-safe-engine-access.md) | ToS-безопасный доступ: только официальный бинарь, single-user allow-list, OAuth-токен не реюзать в стороннем клиенте. | accepted |
| [0010](0010-wiki-content-model.md) | Контент-модель вики: концепции/развитие/идеи-first; код-сессии → accomplishment/capability-выжимка, не verbatim. | accepted |
| [0011](0011-relevance-sensitivity-filter.md) | Фильтр контента: чувствительность (NSFW/приватное, on-device до облака) + релевантность (на compile) — две ортогональные оси + роутер «задача vs знание». | accepted |
| [0012](0012-language-typescript-port.md) | Язык реализации — порт Python→TypeScript (идиоматичный, in-place, engine-portable сохранён); инварианты несёт поведение, не язык; ничего не superseded. | accepted |
| [0013](0013-pii-density-valid-phones.md) | Фикс pii_density: считаем только валидные телефоны (10–15 цифр) — даты ISO больше не триггерят others_pii-карантин (осознанное расхождение с Python). | accepted |
| [0014](0014-telegram-transport-long-polling.md) | Транспорт Telegram — **long polling** по умолчанию (исходящий `getUpdates`, ноль inbound, $0, без домена/туннеля); webhook сохранён опцией. Уточняет [0004](0004-telegram-bridge-reactive-proactive.md). | accepted |
| [0015](0015-capture-write-path-permission-posture.md) | Capture-write-path: движок пишет файлы (`acceptEdits`, **без shell**), коммит per-turn делает **мост**; capture-текст маскируется до движка. Уточняет [0007](0007-engine-spawn-and-scheduler.md), ничего не superseded. | accepted |
| [0016](0016-bot-persona-configurable-system-prompt.md) | Персона бота — настраиваемый системный промпт реактивного моста (`--append-system-prompt`, регистр-aware); контент **личный** (приватный `persona.md`), фреймворк = generic-дефолт + `persona.example.md`. | accepted |
| [0017](0017-telegram-session-read-and-continue.md) | Telegram читает/продолжает локальные сессии Claude Code (`~/.claude/projects/`): отдельная полоса (cwd = проект, без персоны/вики), local-first (в сеть — только контекст хода), чтение без облака, `SESSIONS_ALLOWLIST` deny-by-default. Уточняет [0007](0007-engine-spawn-and-scheduler.md)/[0015](0015-capture-write-path-permission-posture.md), ничего не superseded. | accepted |
| [0018](0018-finance-module.md) | Финансовый модуль: append-only леджер в приватном `raw/finance/`, мультивалютность (нативная валюта + `fx_rate` на момент синка), `finance-goal` с вычисляемым из леджера прогрессом. | accepted |
| [0019](0019-knowledge-library-external-methodology.md) | Категория `knowledge/<topic>/` — внешняя source-attributed методология рядом с about-owner `wiki/` (Карпатый-механика, помеченные противоречия источников); портативный knowledge-package. | accepted |
| [0020](0020-knowledge-library-fidelity-and-risk-tagging.md) | `knowledge/` хранит чужой метод с полной точностью + `risk:`-тегами и нейтральной рамкой, без эндорсмента; движок подаёт как claims источника, не директиву. | accepted |
| [0021](0021-growth-target-date-scanned-into-reminders.md) | Дедлайны growth-страниц (`target_date`) сканируются в дайджест по образцу `birthdaysFromWiki` (единый источник даты цели). Уточняет [0007](0007-engine-spawn-and-scheduler.md). | accepted |
| [0022](0022-knowledge-package-ingest-frontmatter-normalization.md) | Ингест knowledge-package нормализует frontmatter под контракт хранителя (sources/claims/status object-форма; `confidence` опц. для knowledge-claims; мирроринг + идемпотентность по версии). Уточняет [0019](0019-knowledge-library-external-methodology.md). | accepted |
| [0023](0023-telegram-transport-media-and-callbacks.md) | Транспорт Telegram расширен под фин-модуль: `sendPhoto`/`sendDocument` (multipart), инлайн-кнопки (`reply_markup` + `callback_query`, owner-gate по `from.id`), opt-in `parse_mode`; исходящий guard на caption/filename, не на бинаре. Уточняет [0004](0004-telegram-bridge-reactive-proactive.md)/[0014](0014-telegram-transport-long-polling.md). | accepted |
| [0024](0024-finance-reactive-dispatch.md) | Финансовый реактивный диспетчер: движок эмитит `finance-intent` JSON-блок, бридж детерминированно диспетчеризует в чистые функции (`recordFinanceEntry`/`computeNetWorth`/etc.); readback детерминирован; query через пред-счёт финансового контекста. Расширяет [0018](0018-finance-module.md)/[0015](0015-capture-write-path-permission-posture.md)/[0016](0016-bot-persona-configurable-system-prompt.md). | accepted |
| [0025](0025-finance-visualization-render.md) | Рендер финвизуалов — Node-side `chartSpec → SVG → PNG` (`@resvg/resvg-js`, без shell/сети/браузера), НЕ движок-через-shell; SVG-вёрстка чистая/детерминированная (`svg.ts`), растеризация — тонкий адаптер (`finance-render.ts`). Расширяет [0018](0018-finance-module.md)/[0023](0023-telegram-transport-media-and-callbacks.md)/[0015](0015-capture-write-path-permission-posture.md). | accepted |
| [0026](0026-finance-proactive-and-callbacks.md) | Финансовый проактив и кнопочные callback-флоу: (1) свип кредит-напоминаний/майлстоунов/опроса налички/нуджа поверх digest-sweep с дедупом через fired-state; (2) callback-протокол кнопок `fin:paid/snooze/detail` (компактный ≤64 байт, owner-only, answerCallbackQuery, [Оплачено]→append-only снапшот); (3) pending-state опроса налички (проактив ставит, реактив гасит). Расширяет [0018](0018-finance-module.md)/[0023](0023-telegram-transport-media-and-callbacks.md)/[0024](0024-finance-reactive-dispatch.md)/[0025](0025-finance-visualization-render.md). | accepted |

## Сквозные темы

- **Движок.** [0001](0001-engine-subscription-codex.md) (superseded) → [0008](0008-engine-claude-native.md) (Claude-native, engine-portable) + [0009](0009-tos-safe-engine-access.md) (ToS-safe доступ) + спавн-паттерн в [0007](0007-engine-spawn-and-scheduler.md) + permission-постура capture-write-path (`acceptEdits`, коммитит мост) в [0015](0015-capture-write-path-permission-posture.md).
- **Память и контент.** [0002](0002-no-embedder-pure-karpathy.md) (без вектора) + [0010](0010-wiki-content-model.md) (типы страниц, правило сжатия кода).
- **Репозитории и хостинг.** [0003](0003-two-repos-public-private.md) (public/private split) + [0006](0006-github-account-kengston.md) (аккаунт) + [0005](0005-host-v1-macbook-portable.md) (host) + remote-routine-апгрейд в [0007](0007-engine-spawn-and-scheduler.md).
- **Интерфейс и проактив.** [0004](0004-telegram-bridge-reactive-proactive.md) (Telegram-bridge) + транспорт по умолчанию — long polling [0014](0014-telegram-transport-long-polling.md) (webhook → опция) + транспорт-расширение под медиа/инлайн-кнопки/opt-in `parse_mode` [0023](0023-telegram-transport-media-and-callbacks.md) + формат reminders/sweep в [0007](0007-engine-spawn-and-scheduler.md) + чтение/продолжение локальных сессий Claude Code из Telegram (отдельная полоса, local-first) в [0017](0017-telegram-session-read-and-continue.md).
- **Фильтрация и приватность.** [0011](0011-relevance-sensitivity-filter.md) (чувствительность on-device до облака + релевантность на compile + лейн задач) опирается на границу двух репо [0003](0003-two-repos-public-private.md) (приватные лексиконы/карантин — только в приватном репо) и no-embedder/no-cloud-vector [0002](0002-no-embedder-pure-karpathy.md) (Tier-1 детерминированный, без ML; Tier-2 ML — отложен).

## Связанные

- [../../CONTEXT.md](../../CONTEXT.md) · [../../index.md](../../index.md) · [../../log.md](../../log.md) · [../research/README.md](../research/README.md) · [../architecture/architecture.md](../architecture/architecture.md) · [../../README.md](../../README.md)
