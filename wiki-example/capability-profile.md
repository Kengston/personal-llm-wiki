---
title: Профиль капабилити — на что способен (СИНТЕТИКА)
type: capability-profile
status: in-progress
last_updated: 2025-02-10
sources:
  - raw/llm-chats/claude-2025-01-22-cli-tool.md
  - projects/sample-project.md
---

# Профиль капабилити — на что я способен

> ⚠️ **СИНТЕТИКА.** Выдуманный профиль «Ивана Примера» для демонстрации формата `capability-profile`. Все навыки, проекты и даты — фейковые.
>
> Это **деривативная** страница ([ADR-0010](../docs/adr/0010-wiki-content-model.md)): агрегат «что я умею» из код-сессий и проектов. По правилу сжатия кода — здесь **не verbatim-код**, а выжимка: построил X через Y → показывает навык Z. Полные технические детали остаются в `raw/`/`sources/`, сюда поднимается итог. Источник записей — accomplishment-страницы из [projects/](projects/sample-project.md) и выгрузки LLM-чатов.

Профиль того, на что владелец способен предметно — чтобы «Второй мозг» мог отвечать на «делал ли я когда-нибудь X?», «какой у меня уровень в Y?» и подбирать релевантный прошлый опыт.

## Навыки (с уровнем и пруфом)

Машиночитаемые observation-строки `[навык] описание — уровень — пруф`:

- [backend] Python-сервисы и тонкие API-мосты — уверенно — [projects/sample-project.md](projects/sample-project.md)
- [data-ingestion] парсинг экспортов и нормализация в markdown — уверенно — компилятор примера-вики
- [automation] плановые задачи (launchd/cron, идемпотентные sweep'ы) — средне — [projects/sample-project.md](projects/sample-project.md)
- [privacy-eng] sanitizer fail-closed, маскирование PII/секретов — средне — write-path примера
- [frontend] верстка/типографика — базово — личный интерес, без боевых проектов

## Что реализовывал (свод по projects/)

- **CLI-органайзер заметок** (`2025-02`) — построил локальный инструмент захвата заметок в markdown с тегами и поиском; навыки: backend, дизайн CLI, файловое хранилище. Подробно (accomplishment-стиль) — [projects/sample-project.md](projects/sample-project.md).

> По мере появления новых проектов компилятор дописывает сюда одну строку-выжимку на проект (что построил → какой навык), а полную запись кладёт в `projects/`.

## Сильные стороны / зоны роста

- **Сильное:** доводить локальные утилиты до рабочего состояния; аккуратность с приватностью данных.
- **Зона роста:** живые интеграции (мессенджеры/браузер-автоматизация) — пока на уровне планов, не боевого опыта (ср. roadmap «рук»).

<!-- keep -->
Личная заметка (агенту не трогать): не раздувать профиль — только то, что реально делал; гипотетическое и «хочу научиться» держать в [growth/sample-growth.md](growth/sample-growth.md), не здесь.
<!-- /keep -->

## Связанные

- [index.md](index.md) · [projects/sample-project.md](projects/sample-project.md) · [growth/sample-growth.md](growth/sample-growth.md) · [concepts/sample-concept.md](concepts/sample-concept.md) · [../docs/adr/0010-wiki-content-model.md](../docs/adr/0010-wiki-content-model.md)
