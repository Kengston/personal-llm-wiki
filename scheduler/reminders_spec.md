---
title: Формат напоминаний (reminders)
type: concept
status: accepted
last_updated: 2026-05-31
sources:
  - ../docs/research/proactive-scheduling.md
  - ../docs/adr/0007-engine-spawn-and-scheduler.md
---

# Формат напоминаний (reminders)

> Спецификация формата файла `reminders/reminders.md` — источника истины для
> проактивного слоя «Второго мозга». Этот документ — контракт между движком
> (который пишет/обновляет записи на capture-time) и детерминированным sweep'ом
> ([`reminders.ts`](../src/scheduler/reminders.ts) + [`digest.ts`](../src/scheduler/digest.ts), который их читает).
> Фиксируется [ADR-0007 §3](../docs/adr/0007-engine-spawn-and-scheduler.md);
> обоснование — [research/proactive-scheduling.md](../docs/research/proactive-scheduling.md).

## Где лежит

Источник истины — **приватный** репо `llm-wiki-content`:

```
llm-wiki-content/
└── reminders/
    ├── reminders.md      # append-only список YAML-блоков (этот формат)
    ├── log.md            # append-only журнал срабатываний sweep
    └── <id>.md           # опц. отдельный файл, если заметка к напоминанию растёт
```

Публичный фреймворк-репо `personal-llm-wiki` держит только **синтетический**
labelled-пример ([`wiki-example/reminders/example.md`](../wiki-example/reminders/example.md))
— ни одного реального напоминания (граница двух репо,
[ADR-0003](../docs/adr/0003-two-repos-public-private.md)).

## Структура файла

`reminders.md` — это **append-only список YAML-frontmatter-блоков**, по одному
блоку на напоминание, разделённых строкой `---`. Первый блок может быть
markdown-преамбулой (заголовок файла) — парсер её игнорирует (нет распознанных
полей). Пример:

```markdown
# Reminders (пример — синтетические данные)

---
id: birthday-ivan-primer-2026
title: День рождения Ивана Примера
kind: recurring
due_at: 2026-06-15T09:00:00+03:00
rrule: FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=15
nl_source: "напомни про др Ивана каждый год 15 июня утром"
status: pending
created: 2026-05-31T12:00:00+03:00
---
id: gift-ivan-primer-2026
title: Купить подарок Ивану
kind: oneoff
due_at: 2026-06-10T10:00:00+03:00
nl_source: "напомни выбрать подарок Ивану за 5 дней до др"
status: pending
created: 2026-05-31T12:00:00+03:00
---
id: idea-memex-resurface
title: Идея — перечитать про Memex и связать с проектом
kind: spaced
due_at: 2026-06-03T19:00:00+03:00
nl_source: "напоминай иногда вернуться к идее про Memex"
status: pending
box: 1
interval_days: 3
created: 2026-05-31T19:00:00+03:00
---
```

## Поля блока

| Поле | Обяз. | Тип / формат | Описание |
|---|---|---|---|
| `id` | да | slug-строка (`kind-subject-year`) | Стабильный идентификатор для дедупа и команд `/done <id>` / `snooze <id>`. Не меняется. |
| `title` | да | строка | Человекочитаемый заголовок — идёт в Telegram-дайджест. |
| `kind` | да | `oneoff` \| `recurring` \| `spaced` | Тип жизненного цикла (см. ниже). |
| `due_at` | да | **ISO 8601 с таймзоной** | Время СЛЕДУЮЩЕГО срабатывания. Для recurring/spaced — next occurrence (движок продвигает его после каждого пуша). |
| `rrule` | только recurring | iCal RRULE (RFC 5545) без префикса | Правило повторения, напр. `FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=15`. |
| `nl_source` | рекомендуется | строка (в кавычках) | Исходная фраза «напомни …» **дословно** — для аудита. Парсер её НЕ интерпретирует. |
| `status` | да | `pending` \| `done` \| `snoozed` | Жив (pending/snoozed) или выключен (done). |
| `last_fired` | авто | ISO 8601 | Когда запись последний раз вошла в дайджест. Ставит движок. Основа дедупа. |
| `created` | да | ISO 8601 | Когда создано. Служит `dtstart` для расчёта recurrence. |
| `box` | только spaced | int `0..4` | Индекс ступени лесенки Leitner. |
| `interval_days` | только spaced | int | Текущий интервал (дублирует ступень для читаемости). |
| `ease` | опц. (spaced) | float | Ease-factor на будущее (SM-2). v1 не использует. |

> ⚠ **ISO-даты только.** Относительные/NL-даты («через 3 дня», «завтра») в полях
> `due_at`/`created`/`last_fired` **запрещены** — они допустимы лишь внутри
> `nl_source` как аудит-след. Если персистить относительную дату как
> source-of-truth, повторная оценка файла позже молча сдвинет каждый срок
> ([research](../docs/research/proactive-scheduling.md), «подводные камни»).

> ⚠ **Таймзона обязательна.** `due_at` хранится с явным offset
> (`+03:00`/`Z`). Sweep сравнивает в той же tz. Naive-local-время мисфайрит на
> переходах DST и на полночь-edge-кейсах дней рождения. `python-dateutil`
> корректен только на tz-aware значениях.

## Три вида напоминаний (`kind`)

### `oneoff` — одноразовое
Сработало один раз → движок ставит `status: done`. Пример: «купить подарок к
10 июня». Поле `rrule` не используется.

### `recurring` — повторяющееся
Повторяется по `rrule`. После срабатывания движок **продвигает `due_at`** к
следующему вхождению (детерминированно, через [`reminders.ts`](../src/scheduler/reminders.ts)
`next_occurrence`, не пере-парсингом NL) и ставит `last_fired`. Сам `rrule` не
меняется. Примеры RRULE из коробки:

| Намерение | RRULE | `kind` |
|---|---|---|
| Каждый год 15 июня | `FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=15` | recurring |
| Каждый понедельник | `FREQ=WEEKLY;BYDAY=MO` (+ время в `due_at`) | recurring |
| Каждые 2 недели, 5 раз | `FREQ=WEEKLY;INTERVAL=2;COUNT=5` | recurring |
| «через 3 дня» (разово) | — (без rrule) | oneoff |

Формат **calendar-ready by construction**: так как recurrence хранится как iCal
RRULE, поздний one-way-экспорт в `.ics` / CalDAV / Google Calendar — чистый
add-on без переделки формата ([CONTEXT §6 OQ-3](../CONTEXT.md) — стартуем с
автономного файла).

### `spaced` — idea-resurfacing (интервальный возврат к идее)
Идея всплывает по лесенке **Leitner `[1, 3, 7, 16, 35]` дней**
([`reminders.ts`](../src/scheduler/reminders.ts) `LEITNER_LADDER`). На каждом всплытии движок
продвигает `box` на 1 (потолок — последняя ступень), пересчитывает
`interval_days` по ступени и ставит `due_at = now + interval_days`. Пользователь
в Telegram реагирует: «ещё актуальна» (всплывёт снова позже) / «drop» →
`status: done`. Полный SM-2 с `ease` — позже, если понадобится адаптивное
spacing.

## Как вычисляется «due» (что покажет sweep)

Детерминированно, в [`reminders.ts`](../src/scheduler/reminders.ts) `computeDue()`. Элемент
попадает в дайджест **«сегодня»**, если:

1. `status` ∈ {`pending`, `snoozed`} (живой), И
2. `due_at <= now + grace` (grace-окно по умолчанию 5 мин — ловит «вот-вот»
   между тиками sweep), И
3. запись **не стреляла сегодня** (дедуп: `last_fired.date() != now.date()`) —
   защита от коалесцированного двойного запуска launchd
   ([research](../docs/research/proactive-scheduling.md): launchd сливает
   пропущенные интервалы в одно wake-событие).

Дополнительно элемент с `due_at <= now + lookahead` (по умолчанию 7 дн) попадает
в секцию **«скоро»** дайджеста, но НЕ помечается `last_fired` (превью, не
срабатывание).

## Дни рождения — из вики, не дублируются в reminders

Дни рождения и годовщины **не заводятся** отдельными `recurring`-записями.
Источник истины — структурные поля person-страниц вики (single source of truth,
без дублирования; [research](../docs/research/proactive-scheduling.md), открытый
вопрос — закрыт в пользу вики). Sweep сканирует `wiki/` на frontmatter-поля и
выводит yearly-напоминание динамически:

```markdown
---
title: Иван Пример
type: person
birthday: 06-15          # MM-DD (год опц.: 1990-06-15 → считаем «исполняется N»)
anniversary: 2015-09-01  # годовщина (напр. знакомства)
---
```

Поддерживаемые поля: `birthday`, `anniversary`, `birth_date`, `named_day`.
Формат значения — `MM-DD` или `YYYY-MM-DD` (год → вычисление «исполняется N
лет»). Реализация — [`reminders.ts`](../src/scheduler/reminders.ts) `birthdaysFromWiki()`.

## Жизненный цикл записи

```
        create (движок на capture-time)
                  │
                  ▼
            status: pending ──────────────┐
                  │                        │ snooze <id> 2d
       due_at <= now (sweep)               ▼
                  │                   status: snoozed
                  ▼                  (due_at сдвинут)
        ┌──── вошёл в дайджест ────┐         │
        │ oneoff → status: done    │◄────────┘ (срок снова настал)
        │ recurring → due_at++rrule│
        │ spaced → box++, due_at++ │
        └──────────────────────────┘
                  │
                  ▼
       строка в reminders/log.md:
   ## [YYYY-MM-DD] fired | <ids> | <summary>
```

## Кто пишет / кто читает

- **Пишет** записи и обновляет `due_at`/`status`/`last_fired`/`box` — **движок**
  (Claude-native, `claude -p`, [ADR-0008](../docs/adr/0008-engine-claude-native.md)),
  на capture-time (новая заметка из Telegram) и на sweep-time (после пуша). У
  движка workspace-write на приватный репо
  ([ADR-0007](../docs/adr/0007-engine-spawn-and-scheduler.md)). Один писатель —
  чтобы не конфликтовать диффами.
- **Читает** (детерминированно, без движка) — [`reminders.ts`](../src/scheduler/reminders.ts):
  предчек «что due» перед спавном движка, чтобы зря не жечь месячный
  Agent-SDK-кредит Claude
  ([ADR-0009](../docs/adr/0009-tos-safe-engine-access.md)).

## Связанные

- [README.md](README.md) · [reminders.ts](../src/scheduler/reminders.ts) · [digest.ts](../src/scheduler/digest.ts) · [../docs/adr/0007-engine-spawn-and-scheduler.md](../docs/adr/0007-engine-spawn-and-scheduler.md) · [../docs/research/proactive-scheduling.md](../docs/research/proactive-scheduling.md) · [../wiki-example/reminders/example.md](../wiki-example/reminders/example.md)
