---
status: accepted
date: 2026-06-23
---

# ADR-0026 — Финансовый проактив и кнопочные callback-флоу

> Расширяет [ADR-0018](0018-finance-module.md) (финансовый модуль), [ADR-0023](0023-telegram-transport-media-and-callbacks.md) (транспорт: инлайн-кнопки, `sendPhoto`), [ADR-0024](0024-finance-reactive-dispatch.md) (реактивный диспетчер), [ADR-0025](0025-finance-visualization-render.md) (рендер PNG); не supersedes ни одного.

**Контекст.** Реактивный диспетчер ([ADR-0024]) и рендер визуалов ([ADR-0025]) работают по инициативе владельца. Финансовый модуль ([ADR-0018]) требует дополнительного проактивного слоя: кредиты с подходящим платежом должны уведомляться без запроса пользователя, цели — отмечать пересечение порогов прогресса, наличка — периодически опрашиваться. Помимо этого, кредитные уведомления должны давать владельцу возможность немедленно отреагировать прямо из Telegram (кнопки: [Оплачено] / [Отложить] / [Подробнее]), без ввода текстовой команды.

Три проблемы, которые решает этот ADR:

1. **Дублирование проактивных пушей.** Scheduler работает периодически; без дедупа каждый sweep рассылал бы одно и то же кредитное напоминание.
2. **Интеграция кнопочных ответов с леджером.** `callback_query` (ADR-0023) нужно маршрутизировать в конкретный хендлер, записать платёж в append-only леджер, вернуть детерминированный readback — без LLM.
3. **Опрос налички как pending-state.** Проактив задаёт вопрос «сколько наличных?»; реактивный обработчик должен распознать ответ как ответ именно на этот вопрос, а не как произвольную команду.

---

## Решение 1 — Проактивный финансовый свип поверх существующего digest-sweep

**Архитектура.** Новый модуль `src/scheduler/finance-sweep.ts` реализует финансовый свип как **независимый слой поверх** существующего `digest.ts` (ADR-0007). Sweep вызывается из `routines.ts` в тот же цикл, что и дайджест, и при этом:

- **Не мутирует** дайджест-логику — финансовая секция встраивается отдельно через `buildFinanceDigestSection`.
- **Не рассчитывает** ничего самостоятельно — вся арифметика делегирована готовым движкам: `credit.ts` (`creditPaymentsDue`, `isOverdue`), `goals.ts` (`computeGoalProgress`), `chart.ts` (`chartSpec`) и `finance-render.ts` (`renderChartPng`). Sweep — только оркестратор.

**Дедуп через fired-state.** Модуль `src/scheduler/finance-state.ts` хранит реестр уже отправленных пушей (`fired-proactive.json`) — `markFired(dir, key, whenIso)` / `wasFired(dir, key)`. Ключи вида `credit:<id>:<dueDate>:<lead|due>` или `goal:<id>:milestone:<pct>`. Идемпотентность: повторный `markFired` не перезаписывает существующую запись (первый пуш — источник истины). Дедуп per-event, не per-day: напоминание за 5 дней до платежа и напоминание «сегодня» — разные ключи.

**Типы алертов и их триггеры:**

| Тип алерта | Триггер | Ключ дедупа |
|---|---|---|
| `lead` | платёж через `N` дней (окно `creditLeadDays`) | `credit:<id>:<dueDate>:lead` |
| `due` | платёж сегодня | `credit:<id>:<dueDate>:due` |
| `overdue` | `isOverdue(credit, now)` — платёж не зафиксирован | `credit:<id>:<nowDate>:overdue` |
| milestone | `pct >= threshold` (25/50/75/100%) | `goal:<id>:milestone:<threshold>` |
| cash-survey | вечернее окно (cfg.cashSurveyHour ± 1ч) + `cashSurveyIntervalDays` | `cash-survey:<localDate>` |
| idle-nudge | `idleDays >= cfg.idleNudgeDays` без ввода | `idle-nudge:<localDate>` |

**Визуалы только на майлстоунах.** Ежедневный дайджест содержит **только текст** (ASCII прогресс-бар, даты кредитов) — чтобы не спамить PNG каждый день. PNG (`renderChartPng`, ADR-0025) отправляется только при пересечении порогового майлстоуна цели (25/50/75/100%) через отдельный `pushPhotoToOwner`.

**Секрет-гейт.** Все видимые тексты/caption проходят через `roundForDisplay` (огрубление по уровням: <1K без округления, 1K–10K до 100, 10K–100K до 1K, ≥100K до 10K) и `assertNoSecrets` (ADR-0011). В леджере — точные данные; в Telegram — приблизительные.

**Часовой пояс.** Все временны́е вычисления (вечернее окно опроса, дедуп по локальному дню, idle-days) используют `luxon` с `cfg.tz` (IANA), а не UTC — чтобы «вечер по Москве» не становился «ночью по UTC».

---

## Решение 2 — Callback-протокол кнопок кредитного уведомления

**Формат callback_data.** Telegram ограничивает `callback_data` ≤ 64 байт. Используется компактный префиксный формат:

```
fin:paid:<credit_id>    — [✅ Оплачено]
fin:snooze:<credit_id>  — [⏰ Отложить]
fin:detail:<credit_id>  — [📊 Подробнее]
```

`credit_id` обрезается до 50 символов для гарантированного соблюдения лимита (стандартный `deterministicId` = 32 символа, обрезания нет). Префикс `fin:` используется в `app.ts` для маршрутизации: `data.startsWith('fin:')` → `dispatchFinanceCallback`.

**Owner-gate.** `callback_query.from.id` ОБЯЗАН совпадать с `ownerChatId` (ADR-0009 single-user, ADR-0007 owner-only blast-radius). Чужой `from.id` → тихий дроп (не раскрываем существование бота).

**answerCallbackQuery.** Вызывается **всегда** первым — до начала любой тяжёлой работы. Это гасит «часики» в Telegram UI (иначе спиннер крутится ~30 с до таймаута). При owner-reject тоже вызывается best-effort.

**Хендлеры:**

- **[Оплачено] → `handlePaid`:** вызывает `recordCreditPayment(creditId, 'auto', {ledger, nowFn})` — чистый append-only в `credits.jsonl` (новый снапшот) и `transactions.jsonl`. Возвращает `CreditPaymentResult`; `formatCreditPaymentReadback` строит детерминированный текст подтверждения (без LLM). После успешной записи следующий sweep не найдёт просрочку (баланс обновлён).

- **[Отложить] → `handleSnooze`:** реализует отсрочку двумя совместными шагами:
  1. `writeSnoozeUntil(stateDir, 'credit:<id>', snoozeUntil)` — записывает «молчать до начала следующего дня UTC». Sweep проверяет snooze-гейт числовым сравнением ms (`new Date(now).getTime() < new Date(snoozeUntil).getTime()`); пока snooze активен — кредит пропускается. Анти-спам: даже при частом свипе алерт в день нажатия не повторяется.
  2. `unmarkFiredByPrefix(stateDir, 'credit:<id>:')` — снимает все fired-метки кредита. Это гарантирует **перевыход завтра**: после истечения snooze fired будет false → sweep дойдёт до snooze-гейта → snooze истёк → clearSnoozeUntil + markFired + алерт. Без unmark кредит остался бы в fired-реестре и readback «отложено до завтра» был бы ложью.
  - readback: детерминированный текст «Напоминание отложено до <дата>» с реальной датой snoozeUntil.
  - *(Ранний вариант: unmarkFiredByPrefix без snooze-гейта — отвергнут: немедленный повтор при частом свипе; snooze-until-alone без unmark — отвергнут: перевыхода не было бы. Принятое решение: оба механизма вместе.)*

- **[Подробнее] → `handleDetail`:** читает последний снапшот кредита из леджера, строит текстовую сводку + PNG-график структуры долга (`chartSpec({kind: 'debt_structure', ...})` → `renderChartPng` → `sendPhoto`). Ошибка PNG — не фатальна: отправляется только текст (graceful fallback).

**Арифметика в чистых функциях.** `handlePaid` не считает ничего сам — `recordCreditPayment` делегирует `splitPayment(credit, amount)` из `credit.ts` (тело/проценты), `addMonthsToIso` для следующей даты платежа. Хендлер = тонкий оркестратор.

**Независимость ошибок.** Ошибка одного хендлера (кредит не найден, кредит уже погашен, ошибка рендера PNG) не блокирует обработку остальных callback'ов. Каждый хендлер оборачивается в try/catch с fallback-текстом в Telegram.

---

## Решение 3 — Опрос налички через pending-state

**Проблема.** Проактив отправляет вопрос «сколько наличных?» — но когда владелец отвечает числом, реактивный обработчик должен знать, что этот ответ — именно на тот вопрос (а не просто случайное число в чате).

**Решение.** `finance-state.ts` хранит маркер `pending-cash-survey.json` (`PendingCashSurvey`: `account?`, `currency?`, `sinceIso`). Жизненный цикл:

1. Проактивный свип (`deliverFinanceDue`) — отправляет вопрос → `writePendingCashSurvey(stateDir, {sinceIso: now})`.
2. Реактивный обработчик (C3 в `finance-intent.ts` / `app.ts`) — при получении нового числового ответа проверяет `readPendingCashSurvey(stateDir)`. Если маркер есть → интерпретирует ответ как cash-снапшот с контекстом из маркера → `recordFinanceEntry` → `clearPendingCashSurvey(stateDir)`.
3. Маркер null → обычная обработка входящего.

**Гашение через реактив, не через sweеp.** Маркер удаляется только после успешного подтверждения ввода владельцем. Sweep не гасит маркер сам (иначе при следующем sweep'е до ответа владельца вопрос «зависнет» без маркера). Тайм-аут (если ответа нет несколько дней) — вне scope данного ADR; допустимо повторное writePendingCashSurvey при следующем периодическом опросе.

**Хранение состояния.** `finance-state.ts` хранит три слоя: pending-cash-survey, fired-реестр, last-input watermark. Каталог — `CONTENT_ROOT/.finance-state/` (мутабельный, вне `raw/`, path-guard леджера на него не распространяется). Разрешение: `FINANCE_STATE_DIR` env → `CONTENT_ROOT/.finance-state/` → `~/llm-wiki-content/.finance-state/`.

---

## Инварианты (не нарушать)

- Вся арифметика — в движках (`credit.ts`, `goals.ts`, `networth.ts`), а не в свипе или хендлерах.
- Append-only леджер: `recordCreditPayment` пишет НОВЫЙ снапшот кредита; прошлый не мутируется (ADR-0018).
- Owner-only: `callback_query.from.id == ownerChatId`; чужой — тихий дроп (ADR-0007/0009).
- `answerCallbackQuery` — всегда, до тяжёлой работы.
- `callback_data` ≤ 64 байт — компактный префиксный формат, credit_id обрезается до 50 символов.
- Секрет-гейт: точные числа — в леджере; в caption/текст — `roundForDisplay` + `assertNoSecrets` (ADR-0011).
- PNG только на майлстоунах и в `handleDetail`; ежедневный дайджест — только текст.
- Все временны́е вычисления — через `luxon` с инъектируемой tz (не `getUTCHours()`).
- Нет сети, нет spawn, нет фоновых процессов; рендер — локальная либа (ADR-0025).
- Только синтетические/fake-данные в коде и тестах (публичный репо, `lint:public` обязан проходить).

## Альтернативы (отвергнуты)

- *Дедуп по дате (раз в сутки, единый ключ).* Потеря семантики: напоминание «за 5 дней» и «сегодня» — один и тот же день, но разные события. Per-event ключ точнее.
- *Pending-state через reminders.md.* Reminders — иммутабельные страницы вики (commit-flow), не подходят для мутабельного межпроцессного флага; отдельный JSON-файл проще и быстрее.
- *LLM для readback [Оплачено].* Нарушает ADR-0015 (LLM не пишет в леджер) и добавляет latency; детерминированный форматтер надёжнее и тестируемее.
- *Отложить = markFired с новым ключом завтрашней даты.* Хрупко: дата платежа не меняется, sweep найдёт кредит в окне по старой дате. Отвергнуто.
- *Отложить = только `unmarkFiredByPrefix` (без snooze-гейта).* Снимает fired → ближайший же sweep (если он чаще раза в сутки) немедленно пересылает напоминание. Нарушает ожидание «молчать до завтра». Отвергнуто.
- *Отложить = только `writeSnoozeUntil` (без unmark fired).* Snooze молчит до завтра, но fired-метка остаётся → когда snooze истёк, fired=true → sweep не фаярит → перевыхода нет, readback лжёт. Отвергнуто. **Принятое решение: оба шага вместе** — snooze-гейт даёт тишину сегодня, unmarkFired даёт перевыход завтра.
- *Секция финансов в PNG в дайджесте.* Нагружает дайджест медиа-файлом каждый день; текстовый ASCII-прогресс + даты платежей достаточны для ежедневного пульса.

## Следствия

- Новые файлы `src/scheduler/finance-sweep.ts` (свип: `collectFinanceDue`, `deliverFinanceDue`, `buildFinanceDigestSection`) + тест `finance-sweep.test.ts`.
- Новый файл `src/scheduler/finance-state.ts` (три слоя состояния) + тест `finance-state.test.ts`.
- Новый файл `src/bridge/finance-callbacks.ts` (диспетчер кнопок) + тест `finance-callbacks.test.ts`.
- Новый файл `src/ingest/finance/credit-payment.ts` (запись платежа в леджер) + тест в `finance.test.ts`.
- Расширение `src/bridge/app.ts`: маршрутизация `callback_query` с `fin:`-префиксом → `dispatchFinanceCallback`.
- Расширение `src/scheduler/routines.ts`: вызов финансового свипа в цикле дайджеста.

## Связанные

- [ADR-0018](0018-finance-module.md) · [ADR-0023](0023-telegram-transport-media-and-callbacks.md) · [ADR-0024](0024-finance-reactive-dispatch.md) · [ADR-0025](0025-finance-visualization-render.md) · [ADR-0011](0011-relevance-sensitivity-filter.md) · [ADR-0009](0009-tos-safe-engine-access.md) · [ADR-0007](0007-engine-spawn-and-scheduler.md) · [ADR-0015](0015-capture-write-path-permission-posture.md)
- Код: `src/scheduler/finance-sweep.ts` · `src/scheduler/finance-state.ts` · `src/bridge/finance-callbacks.ts` · `src/ingest/finance/credit-payment.ts`
