---
title: Пробежать 10 км до конца квартала (СИНТЕТИКА)
type: growth
status: active
last_updated: 2025-01-15
target_date: 2025-03-31
progress: 0.3
---

# Цель: пробежать 10 км до конца квартала

> ⚠️ **СИНТЕТИКА.** Выдуманная цель для демонстрации формата `growth/` (измеримая цель со сроком). Все даты и метрики — фейковые.

Измеримая **цель** — частный случай `growth/` ([ADR-0010](../../docs/adr/0010-wiki-content-model.md): развитие/маркеры/цели в одном бакете): пробежать 10 км без остановки к **`2025-03-31`**. Старт — `2025-01-15`, текущая дистанция комфортного бега — 3 км. Широкая траектория роста (без жёсткой метрики) — в [growth/sample-growth.md](sample-growth.md); это её измеримый «срез».

## Метрика и срок

- [маркер] дистанция за один забег без остановки, в км — источник истины для `progress`
- [старт] `2025-01-15` — 3 км
- [цель] `2025-03-31` — 10 км (`target_date`)
- [план] +1 км каждые ~10 дней, 3 пробежки в неделю

## Чекпоинты

- [ ] `2025-02-01` — 5 км
- [ ] `2025-02-20` — 7 км
- [ ] `2025-03-10` — 9 км
- [ ] `2025-03-31` — 10 км (цель)

## Прогресс

- `2025-01-15` — 3 км, заведена цель (`progress: 0.3`), см. [журнал](../journal/2025-01-15.md).

## Напоминания

Еженедельный чек прогресса оформлен как `kind=recurring` (`FREQ=WEEKLY;BYDAY=SU`) в файле reminders — см. [../reminders/example.md](../reminders/example.md). Дедлайн `2025-03-31` движок видит из поля `target_date` этой страницы (single source of truth, [ADR-0007](../../docs/adr/0007-engine-spawn-and-scheduler.md)).

## Связанные

- [../index.md](../index.md) · [sample-growth.md](sample-growth.md) · [../journal/2025-01-15.md](../journal/2025-01-15.md) · [../reminders/example.md](../reminders/example.md) · [../../docs/adr/0010-wiki-content-model.md](../../docs/adr/0010-wiki-content-model.md) · [../../docs/adr/0007-engine-spawn-and-scheduler.md](../../docs/adr/0007-engine-spawn-and-scheduler.md)
