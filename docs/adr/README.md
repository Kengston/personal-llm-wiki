---
title: Индекс ADR — архитектурные решения «Второго мозга»
type: index
status: in-progress
last_updated: 2026-06-07
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

## Сквозные темы

- **Движок.** [0001](0001-engine-subscription-codex.md) (superseded) → [0008](0008-engine-claude-native.md) (Claude-native, engine-portable) + [0009](0009-tos-safe-engine-access.md) (ToS-safe доступ) + спавн-паттерн в [0007](0007-engine-spawn-and-scheduler.md).
- **Память и контент.** [0002](0002-no-embedder-pure-karpathy.md) (без вектора) + [0010](0010-wiki-content-model.md) (типы страниц, правило сжатия кода).
- **Репозитории и хостинг.** [0003](0003-two-repos-public-private.md) (public/private split) + [0006](0006-github-account-kengston.md) (аккаунт) + [0005](0005-host-v1-macbook-portable.md) (host) + remote-routine-апгрейд в [0007](0007-engine-spawn-and-scheduler.md).
- **Интерфейс и проактив.** [0004](0004-telegram-bridge-reactive-proactive.md) (Telegram-bridge) + формат reminders/sweep в [0007](0007-engine-spawn-and-scheduler.md).
- **Фильтрация и приватность.** [0011](0011-relevance-sensitivity-filter.md) (чувствительность on-device до облака + релевантность на compile + лейн задач) опирается на границу двух репо [0003](0003-two-repos-public-private.md) (приватные лексиконы/карантин — только в приватном репо) и no-embedder/no-cloud-vector [0002](0002-no-embedder-pure-karpathy.md) (Tier-1 детерминированный, без ML; Tier-2 ML — отложен).

## Связанные

- [../../CONTEXT.md](../../CONTEXT.md) · [../../index.md](../../index.md) · [../../log.md](../../log.md) · [../research/README.md](../research/README.md) · [../architecture/architecture.md](../architecture/architecture.md) · [../../README.md](../../README.md)
