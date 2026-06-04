---
title: Пример reminders (СИНТЕТИКА)
type: reminders
status: in-progress
last_updated: 2025-01-15
---

# Пример reminders

> ⚠️ **СИНТЕТИКА.** Выдуманные напоминания для демонстрации формата `scheduler`. Все id, даты и тексты — фейковые.
>
> Это иллюстрация файла `reminders/reminders.md` из приватного репо `llm-wiki-content`. Формат фиксирован в [ADR-0007](../../docs/adr/0007-engine-spawn-and-scheduler.md): **append-only список YAML-frontmatter-блоков**, один блок на напоминание. `scheduler` делает идемпотентный sweep (launchd), берёт всё с `due_at <= now`, шлёт один Telegram-digest и обновляет `status`/`last_fired`. **Только ISO 8601 с таймзоной**; относительные даты не персистим — исходная фраза хранится в `nl_source` для аудита.

## Поля

- `id` — стабильный slug + дата (для дедупа sweep'а).
- `title` — короткий текст для Telegram-digest.
- `kind` — `oneoff` | `recurring` | `spaced`.
- `due_at` — ISO 8601 **с таймзоной** (когда сработать).
- `rrule` — iCal RRULE, опц., для `recurring` (calendar-ready по построению).
- `nl_source` — исходная фраза «напомни …» дословно (только аудит, не источник истины).
- `status` — `pending` | `done` | `snoozed`.
- `last_fired` — ISO, когда движок последний раз пушнул (дедуп коалесцированного sweep'а).
- `created` — ISO, когда заведено.
- Для `spaced`: `box` (текущая ступень), `interval_days` (лесенка Leitner `[1,3,7,16,35]`), `ease` (опц., для будущего SM-2).

---

## Активные напоминания

Один-разовое (one-off) — связано с [Иваном Примером](../people/ivan-primer.md):

```yaml
- id: buy-gift-ivan-2025-05-24
  title: "Купить подарок Ивану к дню рождения (деревянные миплы / зёрна светлой обжарки)"
  kind: oneoff
  due_at: 2025-05-24T10:00:00+03:00
  nl_source: "напомни купить подарок Ивану за неделю до его дня рождения"
  status: pending
  last_fired: null
  created: 2025-01-15T20:30:00+03:00
```

Повторяющееся (recurring) — еженедельный чек [цели по бегу](../growth/sample-goal.md):

```yaml
- id: weekly-run-check-2025-01-15
  title: "Проверить прогресс по цели «10 км»: какая сейчас дистанция?"
  kind: recurring
  due_at: 2025-01-19T19:00:00+03:00      # ближайшее воскресенье 19:00
  rrule: "FREQ=WEEKLY;BYDAY=SU"
  nl_source: "напоминай по воскресеньям вечером проверять прогресс по бегу"
  status: pending
  last_fired: null
  created: 2025-01-15T20:31:00+03:00
```

Spaced-resurfacing — возврат к [идее про лампу-будильник](../ideas/sample-idea.md):

```yaml
- id: resurface-idea-sunrise-lamp-2025-01-15
  title: "Всплытие идеи: лампа-будильник с рассветом — ещё актуально?"
  kind: spaced
  due_at: 2025-01-16T09:00:00+03:00      # box 0 → +1 день от created
  nl_source: "иногда напоминай мне про идею с лампой-будильником"
  status: pending
  last_fired: null
  created: 2025-01-15T20:32:00+03:00
  box: 0                                  # индекс ступени в лесенке
  interval_days: [1, 3, 7, 16, 35]        # Leitner; на «ещё актуально» box++
  ease: 2.5                               # задел под SM-2, в v1 не используется
```

<!-- keep -->
Заметка владельца (агенту не трогать): после ДР Ивана `2025-05-31` напоминание `buy-gift-ivan-2025-05-24` можно закрывать вручную, если подарок куплен раньше.
<!-- /keep -->

## Дни рождения — НЕ дублировать сюда

День рождения Ивана (`1990-05-31`) живёт в поле `birthday` страницы [../people/ivan-primer.md](../people/ivan-primer.md). `scheduler` сканирует вики и выводит yearly-напоминание **динамически** (`FREQ=YEARLY;BYMONTH=5;BYMONTHDAY=31`) — заводить отдельную recurring-запись здесь не нужно (single source of truth, [ADR-0007](../../docs/adr/0007-engine-spawn-and-scheduler.md)).

## Лог срабатываний (append-only)

Формат `## [YYYY-MM-DD] fired | <ids> | <краткое содержание digest>` — по образцу house style abcage-wiki. (Пока пусто — sweep ещё ни разу не срабатывал в этом синтетическом примере.)

## Связанные

- [../index.md](../index.md) · [../people/ivan-primer.md](../people/ivan-primer.md) · [../growth/sample-goal.md](../growth/sample-goal.md) · [../ideas/sample-idea.md](../ideas/sample-idea.md) · [../../docs/adr/0007-engine-spawn-and-scheduler.md](../../docs/adr/0007-engine-spawn-and-scheduler.md) · [../../scheduler/](../../scheduler/)
