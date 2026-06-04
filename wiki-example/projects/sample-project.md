---
title: CLI-органайзер заметок (СИНТЕТИКА)
type: project
status: done
last_updated: 2025-02-10
started: 2025-02-01
sources:
  - raw/llm-chats/claude-2025-01-22-cli-tool.md
---

# Проект: CLI-органайзер заметок

> ⚠️ **СИНТЕТИКА.** Выдуманный проект «Ивана Примера» для демонстрации формата `projects/` (accomplishment-запись). Названия, даты и детали — фейковые.
>
> Формат — **accomplishment-стиль** ([ADR-0010](../../docs/adr/0010-wiki-content-model.md)): фиксируем «**что построил предметно**», ключевые решения и уроки — **не verbatim-код**. Полный код/сессия живут в `raw/llm-chats/...`; сюда поднята выжимка, навыки уходят в [capability-profile](../capability-profile.md).

Небольшая личная утилита: захват заметок из терминала в локальные markdown-файлы с тегами и быстрым поиском. Цель — перестать терять мысли «на бегу» без облачных сервисов.

## Что построил (accomplishment)

- [сделал] CLI `note add "<текст>" --tag <t>` → дописывает датированный markdown-файл с frontmatter.
- [сделал] `note find <запрос>` — поиск по тексту и тегам (grep-слой поверх файлов, без БД).
- [сделал] хранилище — папка markdown в git, каждая заметка идемпотентна по id (slug+дата).
- [решение] **без облака и без БД** — простые файлы + git, по тому же духу, что и вика ([ADR-0002](../../docs/adr/0002-no-embedder-pure-karpathy.md)).

## Ключевые решения и уроки

- [урок] плоское файловое хранилище + grep закрывает 90% потребности поиска без индекса — индекс добавлять только при реальной боли.
- [решение] id = `slug+дата` дал дедуп «из коробки» — повторный запуск не плодит дубли (тот же приём, что watermark в ингесте вики).
- [урок] CLI-эргономика важнее фич: один быстрый `add` ценнее десяти флагов.

## Показанные навыки

- backend (Python), дизайн CLI, файловое хранилище, идемпотентность.
- → подняты в [capability-profile.md](../capability-profile.md) одной строкой-выжимкой.

## Статус

`done` (`2025-02-10`). Утилита в личном использовании; дальнейшее развитие — опционально (см. идею-апгрейд в [../growth/sample-growth.md](../growth/sample-growth.md)).

## Связанные

- [../index.md](../index.md) · [../capability-profile.md](../capability-profile.md) · [../growth/sample-growth.md](../growth/sample-growth.md) · [../concepts/sample-concept.md](../concepts/sample-concept.md) · [../ideas/sample-idea-from-chat.md](../ideas/sample-idea-from-chat.md) · [../../docs/adr/0010-wiki-content-model.md](../../docs/adr/0010-wiki-content-model.md)
