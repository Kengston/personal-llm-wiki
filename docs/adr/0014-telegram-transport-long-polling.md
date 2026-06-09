---
status: accepted
date: 2026-06-09
---

# ADR-0014 — Транспорт Telegram: long polling по умолчанию (webhook остаётся опцией)

**Контекст.** [ADR-0004] выбрал Bot API в режиме **webhook**: входящий HTTPS-эндпоинт
за Cloudflare Tunnel ([SETUP] Phase 5) с тремя слоями защиты (nonce пути + secret-token
заголовок + owner allow-list). Это требует **домена под управлением Cloudflare** (туннелю
нужна своя зона) — деньги (~$1–12/год) и постоянная зависимость от туннеля/edge-хоста.
Многоагентный ресёрч (2026-06-09, 6 агентов, перепроверено чтением кода) сопоставил
варианты против планки безопасности проекта (CONTEXT §3): для single-user-бота на ноутбуке
за NAT **webhook не даёт ничего, чего не даёт long polling, но добавляет публичную
поверхность и стоимость.**

**Решение.** Транспорт по умолчанию — **long polling** (`getUpdates`): мост сам опрашивает
`api.telegram.org` **исходящими** запросами. Режим выбирается флагом
`BRIDGE_MODE=polling|webhook` (дефолт `polling`). Webhook **сохранён** опцией (флаг + код +
тесты) — на случай, если когда-нибудь понадобится push.

Почему polling по планке проекта (CONTEXT §3, [ADR-0009]) **строго лучше** webhook:

- **Inbound attack surface = 0.** Нет входящего HTTP-эндпоинта вообще — только исходящий
  TLS к уже доверенному Telegram. (Webhook держит world-reachable хост на edge Cloudflare —
  потому в `app.ts` и нужны три слоя защиты.) `/health` остаётся, но **только на 127.0.0.1**
  (loopback, для launchd-диагностики), извне недоступен.
- **Owner allow-list переносится 1:1.** Слой №2 ([ADR-0009]) живёт в `extractJob` (`app.ts`),
  а не в HTTP-роуте; поллер зовёт тот же `extractJob` → чужой `chat_id` дропается так же
  (`security.foreign_chat_dropped`).
- **На один секрет меньше.** `TELEGRAM_WEBHOOK_SECRET` (secret-token + nonce) применим только
  ко входящему вебхуку; в polling не нужен → опционален.
- **Меньше движущихся частей и $0.** Нет домена, туннеля, `cloudflared`, ephemeral-URL и их
  точек отказа. Бонус: пока ноут спит, Telegram копит апдейты до 24ч — после пробуждения
  поллер забирает пачкой (webhook на время сна доставку терял).

Реализация (`src/bridge/`): `getUpdates`/`deleteWebhook` в `telegram.ts` (свой увеличенный
таймаут long-poll + внешний `AbortSignal` для быстрого shutdown); новый `poller.ts` (цикл
`getUpdates → extractJob → queue.putNowait`, backpressure — тот же `QueueFull`); `store.ts`
персистит offset (таблица `bridge_meta`) → меньше повторов хода после рестарта; `main.ts`
ветвится по режиму, в polling делает один `deleteWebhook` до старта (иначе getUpdates → 409).
Транспорт-нейтральное ядро (`extractJob`/`queue`/`store`/`engine`/воркеры) — без изменений.

**Следствия.** Phase 5 ([SETUP]) для дефолтного пути **не нужна**: ни домена, ни `cloudflared`,
ни `setWebhook` — мост стартует и сам опрашивает Telegram. Webhook-путь остаётся доступным
опционально (`BRIDGE_MODE=webhook` + домен/туннель). Семантика `at-least-once` — та же, что у
webhook-ретраев Telegram (движок и `/reset` к повтору толерантны); persistent offset сужает
окно повтора. **Уточняет [ADR-0004]** (webhook → опция, не дефолт); не отменяет [ADR-0009]
(тот же owner-allow-list, ToS-safe официальный движок, single-user).

## Связанные

- [0004](0004-telegram-bridge-reactive-proactive.md) · [0009](0009-tos-safe-engine-access.md) · [0012](0012-language-typescript-port.md) · [../../setup/SETUP.md](../../setup/SETUP.md) · [../../CONTEXT.md](../../CONTEXT.md)
