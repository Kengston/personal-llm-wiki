---
status: accepted
date: 2026-06-23
---

# ADR-0023 — Транспорт Telegram: медиа, инлайн-кнопки, opt-in parse_mode

> Уточняет [ADR-0004](0004-telegram-bridge-reactive-proactive.md) (интерфейс-bridge) и [ADR-0014](0014-telegram-transport-long-polling.md) (long polling); расширяет транспортный шов под [ADR-0018](0018-finance-module.md). Ничего не `superseded`: текстовый контракт и инварианты безопасности сохранены, добавлены новые методы.

**Контекст.** Транспортный клиент Telegram (`src/bridge/telegram.ts`) умел только текст: `sendMessage` (без `parse_mode`) + `sendChatAction`/`getMe`/`getUpdates`/`deleteWebhook`. Планируемый персональный финансовый ассистент ([ADR-0018](0018-finance-module.md)) опирается на то, чего в транспорте нет: **графики** (PNG из matplotlib через `sendPhoto`), **экспорт** (CSV/PDF через `sendDocument`) и **кнопочные флоу** (`[Оплачено]`/`[Отложить]`, селекторы периода, drill-down — инлайн-клавиатуры `reply_markup` + апдейты `callback_query`). Это **фундамент транспорта**, общий для всех фин-фич, а не отдельная фича.

**Решение.** Расширяем `TelegramClient` + `BotApiTelegramClient`, не ломая текстовый путь и инварианты безопасности.

- **Медиа — multipart-загрузка.** `sendPhoto` / `sendDocument` принимают `InputFile` (локальный `path` ИЛИ байты `data` в памяти; имя/MIME выводятся из расширения). Рядом с JSON-методом `call()` — `callMultipart()` (общий таймаут/ok-check вынесены в `handleResponse`); `Content-Type`/boundary ставит сам `fetch` по `FormData`. URL/`file_id` намеренно не поддерживаем — кейс это локальная отдача сгенерированного файла. Подпись режется до лимита caption (1024).
- **Инлайн-клавиатуры.** Опциональный `reply_markup` (тип `InlineKeyboardMarkup`) у `sendMessage`/`sendPhoto`/`sendDocument`. У `sendMessage` клавиатура вешается **только на последний чанк** длинного ответа (кнопки под полным сообщением, без дублей). В JSON-режиме `reply_markup` уходит вложенным объектом, в multipart — строкой JSON.
- **`parse_mode` — opt-in.** По умолчанию НЕ задаётся (ответ движка — произвольный текст, Markdown/HTML легко ловят 400 на случайной разметке). Включается осознанно вызывающим, который сам форматирует валидно. Caveat: при разбиении длинного размеченного текста по строкам entity может порваться на границе чанка — для `parse_mode` держать сообщение в пределах лимита.
- **`callback_query` (нажатие кнопки).** Добавлен в `allowed_updates` (дефолт `getUpdates` и явный вызов в `poller.ts` → `['message', 'callback_query']`; без этого сервер апдейты кнопок не отдаёт). `extractJob` получил ветку `callback_query`; `Job` расширен опциональным `callback: { id, data, messageId? }`. `handleJob` маршрутизирует callback в `handleCallbackQuery`, который гасит «часики» (`answerCallbackQuery`, best-effort) и логирует — **диспетчеризации по `callback_data` ещё нет** (она приходит с фин-фичами). `editMessageMedia`/`editMessageText` (drill-down) сейчас НЕ добавляем — отдельная задача под конкретную фичу.
- **Проактив с картинками.** В `src/scheduler/runner.ts` — `pushPhotoToOwner(photo, { caption })` рядом с `pushToOwner`.

**Инварианты безопасности (сохранены).**
- **Owner-only allow-list ([ADR-0009](0009-tos-safe-engine-access.md)).** `callback_query` гейтится по `from.id` (инициатор нажатия; присутствует всегда, в отличие от опускаемого у старых сообщений `message`). В приватном чате `from.id == chat.id == owner` — корректный single-user-гейт; чужой `from.id` → дроп (`security.foreign_callback_dropped`). Три слоя webhook (nonce/secret-token/owner) не затронуты.
- **Входящий fail-closed.** `failClosedSanitize` на тексте хода — без изменений. `callback_data` сейчас никуда в облако не уходит; инвариант на будущее: когда фичи начнут кормить `callback_data` движку, его данные обязаны пройти `failClosedSanitize` до облака — ровно как текстовый ход ([ADR-0015](0015-capture-write-path-permission-posture.md) §2).
- **Исходящий last-mile guard — на текстовых полях, НЕ на бинаре.** `pushPhotoToOwner` прогоняет `assertNoSecrets` по `caption` и `filename` (видимый текст), но **не** по байтам файла. Обоснование: финансовый контент владельцу — это сам продукт ([ADR-0018](0018-finance-module.md)); приватность — про **публичный** репо ([ADR-0003](0003-two-repos-public-private.md)), а не про личный owner-only канал, который и есть граница blast-radius для lethal-trifecta ([ADR-0007](0007-engine-spawn-and-scheduler.md) §risks). `scanSecrets` по байтам PNG бессмыслен, а по CSV с финданными даёт массовые ложняки (IBAN/суммы — легитимное содержимое).
- **Single-flight per chat.** Callback-джоба идёт через ту же очередь/воркеров; `handleCallbackQuery` пока не зовёт движок, но фич-диспетчеризация обязана сериализоваться `chatLock`'ом, как текстовый ход.

**Альтернативы (отвергнуты).**
- *`parse_mode` включить по умолчанию.* Отвергнуто: произвольный ответ движка ловит 400 на случайной разметке; plain-text — безопасный дефолт.
- *Санитайзить бинарь файла.* Отвергнуто: ложняки на CSV (финданные = легитимный контент), бессмыслица на PNG, противоречит «финансы владельцу = продукт» ([ADR-0018](0018-finance-module.md)).
- *Отдельный тип `Job` под callback.* Отвергнуто: опциональное поле `callback` переиспользует очередь/воркеры/single-flight без дублирования транспорт-нейтрального ядра.
- *Сразу `editMessageMedia`/`editMessageText`.* Отложено: drill-down придёт с конкретной фин-фичей, тогда же — под неё.

**Следствия.**
- Транспорт готов под фин-фичи; следующий слой — диспетчеризация `callback_data` (реестр действий) и `editMessage*` под drill-down.
- Тестовые моки `TelegramClient` (app/poller) и `pushPhotoToOwner` покрыты юнит-тестами (fetch замокан, без живой сети — [memory: workflow-no-live-network]); `build` + `lint:public` + `eslint` + `vitest` зелёные.

## Связанные

- [ADR-0004](0004-telegram-bridge-reactive-proactive.md) · [ADR-0014](0014-telegram-transport-long-polling.md) · [ADR-0007](0007-engine-spawn-and-scheduler.md) · [ADR-0009](0009-tos-safe-engine-access.md) · [ADR-0015](0015-capture-write-path-permission-posture.md) · [ADR-0018](0018-finance-module.md)
- Код: `src/bridge/telegram.ts` · `src/bridge/app.ts` · `src/bridge/poller.ts` · `src/scheduler/runner.ts`
