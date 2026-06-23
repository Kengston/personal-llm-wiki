---
status: accepted
date: 2026-06-23
---

# ADR-0024 — Финансовый реактивный диспетчер: finance-intent JSON-блок

> Расширяет [ADR-0018](0018-finance-module.md) (финансовый модуль), [ADR-0015](0015-capture-write-path-permission-posture.md) (capture-write-path), [ADR-0016](0016-bot-persona-configurable-system-prompt.md) (системный промпт); не supersedes ни одного.

**Контекст.** Реактивный мост (bridge/app.ts) принимает сообщения владельца и прогоняет через движок (claude -p). Для финансовых операций (ввод баланса, расход, доход, наличка, перевод, создание цели, вопрос «сколько потратил / могу ли позволить») нужен путь из владелец → ответ → запись в леджер → readback в Telegram. Проблема: движок — текстовый (LLM), а леджер требует структурированного ввода и детерминированной арифметики. Нельзя доверять LLM арифметику или запись напрямую (нарушение ADR-0015, принцип «вся арифметика в чистых функциях»).

**Решение.** Протокол «finance-intent JSON-блок»:

1. **Движок инструктируется** (через `--append-system-prompt`, [ADR-0016]) при финансовом вводе/запросе вернуть РОВНО ОДИН fenced-блок:
   ```
   ```finance-intent
   {"type": "<тип>", ...поля...}
   ```
   ```
   После блока — обычный текст (подтверждение, пояснение). Без финансового контекста — блок не нужен.

2. **`extractFinanceIntent(engineAnswer)`** — детерминированный парсер: ищет блок регекспом, парсит JSON, валидирует через zod (`FinanceIntentSchema`). Нет блока → null (обычный ответ проходит как есть). Невалидный JSON/schema → null (graceful fallback, не роняет ход).

3. **`dispatchFinanceIntent(intent, deps)`** — детерминированный диспетчер: по `type` зовёт ГОТОВЫЕ чистые функции из `record.ts` (`recordFinanceEntry`), для `create_goal` — пишет markdown-страницу в `goalsDir`, для `query` — читает агрегаты из леджера (`computeNetWorth`-логика, фильтр транзакций). Возвращает структурный `DispatchResult`. Query-интент НИЧЕГО не пишет в леджер.

4. **`formatReadback(result)`** — детерминированный текст подтверждения для Telegram. LLM здесь НЕ нужен: счёт/сумма/валюта + текущие балансы в нативных валютах. Арифметика — уже сделана в чистых функциях.

5. **Query-режим** («сколько потратил на еду в мае / какой net-worth / могу ли позволить»): бридж ПРЕД-СЧИТЫВАЕТ детерминированный финансовый контекст (`buildFinanceContextSummary`) из леджера и подаёт его в системный промпт. Движок опирается на готовые данные. Запись в леджер не происходит.

6. **Страницы `finance-goal`**: создаются как markdown с YAML-фронтматтером (`FinanceGoalSchema`). Числа в вики-прозе — ОГРУБЛЁННЫЕ (корзинами, [ADR-0011] secret-gate); точные — только в леджере. Идемпотентны (повторный `create_goal` не перезаписывает).

7. **Подключение**: в `handleJob` (app.ts) после `engine.run()` — `extractFinanceIntent(res.answer)` → при intent: `dispatchFinanceIntent` → `formatReadback` (заменяет `res.answer`). При ошибке диспетчера: лог + ответ движка проходит как есть (не роняет ход).

**Виды intent**: `record_balance | record_cash | record_income | record_expense | create_goal | edit | void | transfer | query`.

**Инварианты (не нарушать):**
- Вся арифметика — в чистых функциях (record.ts / networth.ts / goals.ts), не в диспетчере.
- Query-intent: только чтение, ноль записей.
- Path-guard Ledger: запись только под `CONTENT_ROOT/raw/finance/`, никогда в публичный репо ([ADR-0018]).
- Мультивалютность: нативные валюты хранятся as-is, конвертация только через FxProvider (не в диспетчере).
- Нет PII в коде/тестах: только синтетические/fake-данные.

**Альтернативы (отвергнуты):**
- *Function-calling / tool-use движка.* Усложняет engine-контракт (сейчас `run(prompt) → {answer, sessionId}`), не нужен для single-user; протокол fenced-блока проще и engine-portable.
- *LLM пишет в леджер напрямую.* Нарушает ADR-0015 (capture-write-path: движок не коммитит) и ADR-0018 (арифметика в чистых функциях); риск prompt-injection в JSONL.
- *Парсить весь ответ движка как JSON.* Ломает текстовые ответы; fenced-блок позволяет смешивать финансовый dispatch и обычный разговор.

**Следствия:**
- Новый файл `src/bridge/finance-intent.ts` (диспетчер, форматтер, агрегация контекста).
- Расширение `src/bridge/prompt.ts` (FINANCE_INTENT_INSTRUCTION, appendFinanceInstruction).
- Расширение `src/bridge/app.ts` (BridgeState.financeLedger/financeGoalsDir, handleJob диспетчеризация).
- Тесты `src/bridge/finance-intent.test.ts` (мок Engine без реального claude, tmp-dir Ledger).
- Создание доп. полей в main.ts при деплое (CONTENT_ROOT → financeLedger, WIKI_REPO_PATH/goals → financeGoalsDir).

## Связанные

- [ADR-0015](0015-capture-write-path-permission-posture.md) · [ADR-0016](0016-bot-persona-configurable-system-prompt.md) · [ADR-0018](0018-finance-module.md) · [ADR-0011](0011-relevance-sensitivity-filter.md)
- Код: `src/bridge/finance-intent.ts` · `src/bridge/prompt.ts` · `src/bridge/app.ts`
