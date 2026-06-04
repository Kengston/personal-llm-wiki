---
title: Индекс репозитория — «Второй мозг» (публичный фреймворк)
type: index
status: in-progress
last_updated: 2026-05-31
---

# Индекс — «Второй мозг» (публичный фреймворк-репо)

> Каталог **публичного** репозитория `personal-llm-wiki`: код фреймворка, концепт-доки, research, ADR, sanitized-пример вики. Здесь **только фреймворк** — ни одного личного факта, токена или email ([ADR-0003](docs/adr/0003-two-repos-public-private.md), [CONTEXT §2](CONTEXT.md)). Настоящая вика про владельца живёт в **приватном** репо `llm-wiki-content`, который никогда не публикуется.
>
> Движок v1 — **Claude-native** (официальный бинарь `claude -p --output-format json`), engine-portable ([ADR-0008](docs/adr/0008-engine-claude-native.md), [ADR-0009](docs/adr/0009-tos-safe-engine-access.md)). Это репо-карта для людей и для движка: читать первым, потом — релевантный файл.

## Старт (читать первым)

- [README.md](README.md) — обзор проекта, быстрый старт, состав фреймворка.
- [CONTEXT.md](CONTEXT.md) — живой контекст: что строим, терминология, инварианты, три слоя исполнения.
- [CLAUDE.md](CLAUDE.md) — инструкции движку (Claude Code) при работе в этом репо.
- [AGENTS.md](AGENTS.md) — контракт агентов-сборщиков (engine-portable).
- [setup/SETUP.md](setup/SETUP.md) — установка и настройка (бинарь движка, bridge, расписания, приватность).

## Решения (ADR)

- [docs/adr/README.md](docs/adr/README.md) — **индекс всех ADR 0001–0010** с одностроками и статусами. Ключевое: engine-pivot Codex→Claude-native ([ADR-0008](docs/adr/0008-engine-claude-native.md)/[ADR-0009](docs/adr/0009-tos-safe-engine-access.md)/[ADR-0010](docs/adr/0010-wiki-content-model.md)); [ADR-0001](docs/adr/0001-engine-subscription-codex.md) superseded.

## Исследование (research)

- [docs/research/README.md](docs/research/README.md) — сводный research-доклад по 7 направлениям.
- [docs/research/engine-runtime.md](docs/research/engine-runtime.md) — рантайм движка, спавн-семантики, resume.
- [docs/research/memory-architecture.md](docs/research/memory-architecture.md) — память-как-markdown, trip-wire компакции.
- [docs/research/data-ingestion.md](docs/research/data-ingestion.md) — ingest, watermark, инкрементальная подгрузка.
- [docs/research/telegram-interface.md](docs/research/telegram-interface.md) — Telegram-bridge как интерфейс.
- [docs/research/proactive-scheduling.md](docs/research/proactive-scheduling.md) — проактив, sweep, расписания.
- [docs/research/privacy-security.md](docs/research/privacy-security.md) — приватность, ToS, prompt-injection / lethal trifecta.
- [docs/research/portfolio-positioning.md](docs/research/portfolio-positioning.md) — позиционирование публичного портфолио.

## Архитектура

- [docs/architecture/architecture.md](docs/architecture/architecture.md) — полная архитектура: три слоя (реактив / плановое / событийное), компоненты, потоки данных.

## Код фреймворка

- [bridge/](bridge/) — тонкий Telegram↔движок мост (FastAPI, owner-only allow-list). Абстракция `Engine` с дефолтом `ClaudeEngine`: [bridge/engine.py](bridge/engine.py), [bridge/app.py](bridge/app.py), [bridge/telegram.py](bridge/telegram.py), [bridge/store.py](bridge/store.py) (SQLite `chat→session`), [bridge/README.md](bridge/README.md), LaunchAgent-plist [bridge/ru.secondbrain.bridge.plist](bridge/ru.secondbrain.bridge.plist).
- [ingest/](ingest/) — коннекторы источников + sanitizer (fail-closed) + watermark: [ingest/sanitizer.py](ingest/sanitizer.py), [ingest/watermark.py](ingest/watermark.py), [ingest/telegram_export.py](ingest/telegram_export.py), [ingest/youtube_takeout.py](ingest/youtube_takeout.py), [ingest/x_archive.py](ingest/x_archive.py), [ingest/vk.py](ingest/vk.py), [ingest/whatsapp.py](ingest/whatsapp.py), [ingest/codebase_graphify.py](ingest/codebase_graphify.py), [ingest/README.md](ingest/README.md).
- [scheduler/](scheduler/) — плановый слой: идемпотентный sweep, дайджест, lint публичного репо: [scheduler/reminders.py](scheduler/reminders.py), [scheduler/reminders_spec.md](scheduler/reminders_spec.md), [scheduler/digest.py](scheduler/digest.py), [scheduler/lint_public.py](scheduler/lint_public.py) (скан PII/секретов), [scheduler/run_sweep.sh](scheduler/run_sweep.sh), [scheduler/README.md](scheduler/README.md), digest-plist [scheduler/ru.secondbrain.digest.plist](scheduler/ru.secondbrain.digest.plist).
- [compiler/rules.md](compiler/rules.md) — контракт компиляции вики: типы страниц, правило сжатия кода → accomplishment ([ADR-0010](docs/adr/0010-wiki-content-model.md)).

## Пример вики (sanitized)

- [wiki-example/index.md](wiki-example/index.md) — **синтетический** пример личной вики («Иван Пример», выдуманные даты/id) — иллюстрация формата для зрителей портфолио, БЕЗ единого реального факта.

## Журнал

- [log.md](log.md) — хронологический append-only журнал решений и операций над фреймворком.

## Связанные

- [README.md](README.md) · [CONTEXT.md](CONTEXT.md) · [docs/adr/README.md](docs/adr/README.md) · [docs/research/README.md](docs/research/README.md) · [docs/architecture/architecture.md](docs/architecture/architecture.md) · [log.md](log.md)
