---
title: Индекс — пример личной вики (СИНТЕТИКА)
type: index
status: in-progress
last_updated: 2025-01-20
---

# Индекс — пример личной вики

> ⚠️ **СИНТЕТИЧЕСКИЕ ДЕМО-ДАННЫЕ. НЕ настоящие.**
> Все имена, даты, идентификаторы, дни рождения и переписки на этих страницах **выдуманы** (например, «Иван Пример», `2025-01-15`). Это иллюстрация формата для зрителей портфолио — как личный «Второй мозг» хранит знание о владельце, БЕЗ единого реального факта. Настоящая вика живёт в **приватном** репозитории `llm-wiki-content` (см. [CONTEXT §2](../CONTEXT.md)), который **никогда** не публикуется. Контракт ведения — [compiler/rules.md](../compiler/rules.md), движок — Claude-native ([ADR-0008](../docs/adr/0008-engine-claude-native.md), [AGENTS.md](../AGENTS.md)).

Каталог всех страниц этой примерной вики. **Читать первым** при ответе на вопрос (паттерн LLM-Wiki Карпатого, [ADR-0002](../docs/adr/0002-no-embedder-pure-karpathy.md)): сначала индекс → потом релевантные страницы → потом ответ. One-line-саммари держим **конкретными**, чтобы движок брал нужную страницу. Типы страниц — по контент-модели [ADR-0010](../docs/adr/0010-wiki-content-model.md) (концепции/развитие/идеи-first, код → accomplishment/capability-выжимка).

## Как устроена эта вика (демо-карта)

```
wiki-example/
├── index.md                 # этот каталог (читать первым)
├── log.md                   # хронологический append-only журнал (ingest/query/lint/...)
├── capability-profile.md    # деривативный профиль «на что способен» (ADR-0010)
├── people/                  # люди: факты, дни рождения, идеи подарков, как познакомились
│   └── ivan-primer.md
├── projects/                # accomplishment-записи «что построил» (ADR-0010)
│   └── sample-project.md
├── concepts/                # усвоенные ментальные модели/принципы (ADR-0010)
│   └── sample-concept.md
├── growth/                  # развитие: направления, маркеры, цели со сроком (ADR-0010)
│   ├── sample-growth.md     # широкая траектория роста + маркеры
│   └── sample-goal.md       # измеримая цель со сроком (бывш. goals/)
├── ideas/                   # идеи и заметки на подумать (часть — на spaced-resurfacing)
│   ├── sample-idea.md
│   └── sample-idea-from-chat.md   # идея, извлечённая из LLM-чата
├── journal/                 # датированные дневниковые записи (одна на день)
│   └── 2025-01-15.md
├── reminders/               # пример due-напоминания (формат scheduler, ADR-0007)
│   └── example.md
└── knowledge/               # категория-СОСЕД: внешняя source-attributed методология (ADR-0019), НЕ про владельца
    └── sourdough-baking/    # синтетический нейтральный топик
        ├── index.md         # каталог-маршрутизатор топика (type: knowledge-index)
        └── starter-refresh.md  # страница метода с sources: + risk: grey
```

## Профиль капабилити
- [capability-profile.md](capability-profile.md) — «на что способен» (выдуман): деривативная выжимка навыков-с-пруфом из проектов и LLM-чатов ([ADR-0010](../docs/adr/0010-wiki-content-model.md)) — не verbatim-код, а «построил X → навык Z».

## Люди
- [people/ivan-primer.md](people/ivan-primer.md) — Иван Пример (выдуман): познакомились на демо-конференции `2024-11-03`, день рождения `1990-05-31`, любит настольные игры и фильтр-кофе; идеи подарков + связка с напоминанием о ДР.

## Проекты
- [projects/sample-project.md](projects/sample-project.md) — «CLI-органайзер заметок» (выдуман): accomplishment-запись «что построил предметно» + уроки ([ADR-0010](../docs/adr/0010-wiki-content-model.md)); навыки подняты в capability-profile.

## Концепции
- [concepts/sample-concept.md](concepts/sample-concept.md) — «Плоский файл побеждает базу» (выдумана): усвоенная ментальная модель «откладывай сложность до реальной боли» ([ADR-0010](../docs/adr/0010-wiki-content-model.md)) — отделяет *понятое* от *задуманного* и *сделанного*.

## Развитие
- [growth/sample-growth.md](growth/sample-growth.md) — «Освоить живые интеграции» (выдумано): широкая траектория роста, маркеры прогресса, следующий шаг ([ADR-0010](../docs/adr/0010-wiki-content-model.md)).
- [growth/sample-goal.md](growth/sample-goal.md) — «Пробежать 10 км до конца квартала» (выдумана): измеримая цель со сроком `2025-03-31` и чекпоинтами — частный «срез» `growth/` (бывш. `goals/`, [ADR-0010](../docs/adr/0010-wiki-content-model.md)).

## Идеи
- [ideas/sample-idea.md](ideas/sample-idea.md) — «Лампа-будильник с рассветом» (выдумана): идея на подумать, поставлена на spaced-resurfacing (лесенка Leitner `[1,3,7,16,35]`).
- [ideas/sample-idea-from-chat.md](ideas/sample-idea-from-chat.md) — «Тег-автодополнение для CLI-заметок» (выдумана): идея, **извлечённая из LLM-чата** — демо инкрементального ингеста чатов ([ADR-0010](../docs/adr/0010-wiki-content-model.md)).

## Дневник
- [journal/2025-01-15.md](journal/2025-01-15.md) — запись за `2025-01-15` (выдумана): как прошёл день, что зафиксировать в вику, что — в напоминания.

## Напоминания (proactive)
- [reminders/example.md](reminders/example.md) — пример «купить подарок Ивану» (выдуман): one-off due-напоминание в формате [scheduler](../scheduler/) ([ADR-0007](../docs/adr/0007-engine-spawn-and-scheduler.md)). Эфемерное — здесь, не в вики-прозе ([CONTEXT §2](../CONTEXT.md)).

## Базы знаний (knowledge)
<!-- мост в категорию-сосед knowledge/ (§3a контракта, ADR-0019); index-first маршрутизация (§1). knowledge/ — внешняя source-attributed методология, НЕ про владельца. -->
- [knowledge/sourdough-baking/index.md](knowledge/sourdough-baking/index.md) — «Закваска и хлеб» (выдумано, synthetic-example): внешняя методология из источника с атрибуцией (`sources:`) + демо risk-дисциплины (одна страница несёт `risk: grey` + секцию «Риски и оговорки») ([ADR-0019](../docs/adr/0019-knowledge-library-external-methodology.md), [ADR-0020](../docs/adr/0020-knowledge-library-fidelity-and-risk-tagging.md)).

## Журнал
- [log.md](log.md) — хронология операций над этой примерной викой (что ингестили, что спрашивали, что линтили).

## Связанные

- [../README.md](../README.md) · [../CONTEXT.md](../CONTEXT.md) · [../compiler/rules.md](../compiler/rules.md) · [../AGENTS.md](../AGENTS.md) · [../scheduler/](../scheduler/) · [log.md](log.md)
