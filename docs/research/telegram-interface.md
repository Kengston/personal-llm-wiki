---
title: Telegram-интерфейс
type: audit
status: verified
last_updated: 2026-05-31
sources:
  - https://core.telegram.org/bots/api
  - https://core.telegram.org/bots/webhooks
  - https://www.promptquorum.com/power-local-llm/local-whisper-stt-comparison-2026
---

# Telegram-интерфейс

> Направление: Telegram-интерфейс персонального бота «Второй мозг» в 2026 — Bot API vs userbot; webhook vs long-poll; ингест текст/голос/форварды; проактивные пуши; безопасность; capture-UX; Whisper-транскрипция; выбор библиотеки для тонкого FastAPI-моста. Обосновывает [ADR-0004](../adr/0004-telegram-bridge-reactive-proactive.md).

## Вывод

Для single-owner «второго мозга» Bot API (не userbot/MTProto) — верный и уже принятый выбор (ADR-0004): нативно поддерживает входящие webhook, исходящие сообщения, голосовые, форварды, с куда меньшим ToS/ban-риском, чем self-account-userbot. Единственное реальное ограничение проактива — «бот не может начать диалог» — здесь не проблема: владелец один раз шлёт `/start`, мост запоминает `chat_id`, дальше планировщик шлёт пуши вечно. Webhook (не long-poll) за тем же Cloudflare Tunnel. Безопасность — три дешёвых слоя.

## Ключевые находки

### Bot API, не userbot — верно и принято
ADR-0004 фиксирует интерфейс как Telegram-бот через тонкий мост, выбранный за входящие webhook + исходящие + голос (под будущий Whisper). Bot API не нужен логин по номеру и несёт минимальный ToS/ban-риск; userbot автоматизирует реальный человеческий аккаунт (выше ban-риск). Userbot/MTProto окупился бы, только если нужно читать историю live или превышать лимиты бота — ни то ни другое не применимо (history-ингест — через JSON-экспорт per OQ-1). (high)

### «Бот не может начать диалог» НЕ блокирует напоминания
Бот не может начать диалог; юзер должен написать первым. Стандартный workaround: владелец шлёт `/start` один раз, ловим `chat.id`, храним, дальше `sendMessage(chat_id=...)` в любой момент. Для single-owner — одноразовый setup-шаг (записать `OWNER_CHAT_ID` в `.env`), после чего launchd/cron-планировщик пушит напоминания unprompted. (high)

### Webhook, не long-poll; secret_token
Только один из webhook/getUpdates активен одновременно: «вы не сможете получать updates через getUpdates, пока установлен webhook». `setWebhook` поддерживает `secret_token` (1–256 символов, только `A-Z a-z 0-9 _ -`), верифицируемый через заголовок `X-Telegram-Bot-Api-Secret-Token`. Webhook точно ложится на топологию CF-Tunnel из pachca-плана (без public IP/port-forward). `allowed_updates` позволяет подписаться только на message; `max_connections` дефолт 40 (ставим 1–2 для личного бота). (high)

### Безопасность = три слоя
(1) `secret_token`-заголовок (constant-time-сравнение через `hmac.compare_digest`, >32-символьный high-entropy-секрет — против timing-атак); (2) allow-list на `chat_id` владельца (дропать любой update, где `effective_chat.id != OWNER_CHAT_ID` — фаза-7 pachca-плана «whitelist channels/users» ремапнута на одного владельца); (3) bot-token/nonce в пути webhook (unsolicited POST → 404). (high)

### Голосовые → OGG/Opus → getFile → локальный Whisper
`Message.voice` имеет `file_id`, `duration`, `mime_type`; голос = Ogg/Opus (.oga); скачивание = `getFile(file_id)` затем `download_to_drive()`. Cloud `api.telegram.org` лимитит download 20MB (≈15–20 мин при ~163 kbps), upload 50MB. Self-hosted `tdlib/telegram-bot-api`-сервер (Docker) поднимает до ~2000MB и даёт local-path/`file://`-доступ. Для коротких capture-заметок 20MB хватает. (high)

### whisper.cpp + Metal бьёт faster-whisper на Apple Silicon
Бенчмарк 2026: whisper.cpp+Metal — ~10× реалтайма large-v3 на M5 Pro, ~7× на M3 Air, boot <300ms, без Python-зависимости; faster-whisper НЕТ Metal-поддержки, CPU-only ~3× реалтайма на Mac. Для коротких заметок рекомендуется Whisper `small` (~3.4% WER English, ~2GB RAM, ~6× реалтайма). Build: `git clone whisper.cpp; make WHISPER_COREML=1; download-ggml-model.sh small`. Локально (без per-token-стоимости), матчит $0-этику; OQ-2 помечает голос как позднюю фазу. (high)

### Форварды — first-class
`Message.forward_origin` (Bot API 7.x / python-telegram-bot v20.8) — `MessageOrigin` типа user / hidden-user / chat / channel; тот же message-handler видит `forward_origin`, мост ингестит форвард-текст/голос прямо в `raw/`. Caveat: privacy-restricted-отправитель даёт только «hidden user» (без id); service/protected-content-сообщения форвардить нельзя. (high)

### Библиотека: raw httpx для ~150-LOC, aiogram как fallback
aiogram 3.28.2 (2026-05-10, Python 3.10–3.14, asyncio+aiohttp, встроенная webhook-`secret_token`-верификация) vs python-telegram-bot 22.7 (sync+async, tornado для webhook); aiogram 3 — чище async-fit. Но для ~150-LOC-моста, который в основном `sendMessage` + `getFile`, **вызов Bot API напрямую через httpx** (`await client.post(f'https://api.telegram.org/bot{TOKEN}/sendMessage', json=...)`) избегает второго event-loop/dispatcher внутри FastAPI и остаётся dependency-light; тянуться к aiogram — когда нужны типизированные модели / FSM / фильтры. (high)

### Мост ремапит pachca-codex-bridge-plan 1:1
Дельты Telegram: (a) HMAC `X-Pachca-Signature` → `secret_token`-заголовок; (b) Pachca `message.new` → `setWebhook` + `allowed_updates=['message']`; (c) channel-whitelist → один `OWNER_CHAT_ID`; (d) `POST /chats/{id}/messages` → `POST /bot<token>/sendMessage`; (e) добавить voice-ветку `getFile`→whisper.cpp→транскрипт. Latency-бюджет: codex cold start 2–4с + LLM 5–15с ≈ 7–20с/ответ (приемлемо; слать `sendChatAction "typing"` + короткий ack). (high)

## Сравнение Bot API vs userbot

| Критерий | Bot API (выбран, ADR-0004) | Userbot (MTProto/Telethon) |
|---|---|---|
| Логин | bot token, без номера | номер телефона (реальный аккаунт) |
| ToS / риск бана | минимальный | высокий (автоматизация человека) |
| Входящие webhook | да | нет (только polling) |
| Исходящие пуши | да (после `/start`) | да |
| Чтение истории «вживую» | нет | да |
| Голосовые / форварды | да (нативно) | да |
| Когда оправдан | **наш случай** | только live-история / превышение лимитов бота |

## Рекомендации

- **Bot API + webhook + Cloudflare Tunnel** — оставить ADR-0004 как есть; не userbot/MTProto (history-ингест через JSON-экспорт per OQ-1).
- **Три слоя безопасности, всё в мосте:** (1) сравнить `X-Telegram-Bot-Api-Secret-Token` через `hmac.compare_digest` с ≥32-символьным random `TG_WEBHOOK_SECRET`; (2) жёстко дропать update, где `effective_chat.id != OWNER_CHAT_ID` (лог+игнор, без ответа); (3) bot-token/nonce в пути webhook. `allowed_updates=['message']`, `max_connections=1`.
- **Снять `chat_id` владельца один раз:** `SETUP.md` инструктирует юзера послать `/start`, потом прочитать `getUpdates` (или залогировать первый update) → взять `chat.id` → записать `OWNER_CHAT_ID` в `.env`. Один шаг включает все проактивные пуши.
- **Пропустить bot-фреймворк в v1:** реализовать мост как ~150 LOC FastAPI + httpx на raw Bot API (`getMe`, `getFile`, `sendMessage`, `sendChatAction`). Зависимости минимальны, абстракция движка чистая. aiogram 3.28.2 — задокументированный fallback при нужде в типизированных моделях/FSM/фильтрах; держать `TelegramClient`-шов для локальной замены.
- **Голос:** ветка `Message.voice` — `getFile` → скачать `.oga` → (ffmpeg в 16kHz wav при нужде) → локальный whisper.cpp (Metal, `small`) → подать транскрипт как набранную заметку. За feature-flag (OQ-2 откладывает голос); **не** OpenAI Whisper API (ломает $0/local). Задокументировать cloud-`getFile`-лимит 20MB и self-hosted-escape-hatch (Docker, ~2GB) для длинных записей.
- **Форварды = capture-жест:** если `forward_origin` установлен — ингестить форвард-текст/голос в `raw/` (синтетический пример в публичном репо) и ack коротким подтверждением.
- **UX-роутинг:** голое сообщение = «capture в вику», вопрос (хвостовой `?`/вопросительное) = Q&A, плюс явные `/note`, `/q`, `/remind`, `/due`. Слать `sendChatAction "typing"` сразу + короткое «принял, думаю…» (маскирует 7–20с-латентность codex); ответ полным текстом (без edit-streaming).
- **Публичная гигиена:** код моста и `TelegramClient`-stub — в ПУБЛИЧНЫЙ репо только с синтетическими примерами (fake-token `123456:AA-FAKE`, `OWNER_CHAT_ID=111111111`, «Иван Пример»); реальные token/secret/chat_id — ТОЛЬКО в приватном `.env` (`TG_BOT_TOKEN`, `TG_WEBHOOK_SECRET`, `OWNER_CHAT_ID`). Install/login/setWebhook — человеческие инструкции в `setup/SETUP.md`.

## Подводные камни

- Webhook и getUpdates взаимоисключающи — если поллишь для дебага, сначала `deleteWebhook`; повторный `run_polling` молча ломает живой webhook.
- Бот реально не может DM произвольному `user_id`, который не стартовал его («chat not found»/forbidden) — проактив РАБОТАЕТ только после одноразового `/start`; если владелец позже блокирует бота, send падает с 403 «bot was blocked by the user».
- Cloud-`getFile`-download капнут 20MB (~15–20 мин голоса), upload 50MB — длинные голосовые нужен self-hosted Bot API-сервер; не считать безлимитом.
- faster-whisper НЕТ Metal/GPU на macOS, CPU-only (~3× реалтайма) — выбор на MacBook оставляет ~3× на столе vs whisper.cpp+Metal; 4-bit GGML-квантизация whisper.cpp может бить по точности на длинном/шумном аудио (предпочесть INT8/q5 или `small`/`large-v3`).
- Charset `secret_token` ограничен `A-Z a-z 0-9 _ -` (1–256) — base64/url-unsafe-секрет с `+`,`/`,`=` будет отвергнут `setWebhook`; генерить `secrets.token_urlsafe` и при нужде strip/replace.
- Не гонять aiogram-Dispatcher/aiohttp-сервер И uvicorn-loop FastAPI наивно в одном процессе — монтировать handler aiogram в FastAPI (`feed_update`) или получишь два конкурирующих сетапа; главная причина, почему raw httpx проще для тонкого моста.
- `forward_origin` может быть «hidden user» (только имя, без id), когда исходный отправитель ограничивает форвард-privacy; service/protected-content форвардить нельзя — capture-логика должна терпеть отсутствие origin-метаданных.
- ToS/rate-limit-watch (OQ-5): подписочный codex-backend имеет ChatGPT-rate-limits (~50–80 msg/3h на Plus per pachca-план); болтливый бот может упереться — добавить rate-limiting в мост и всплывать дружелюбное «лимит, попробуй позже» вместо stack-trace.

## Открытые вопросы

- Whisper-упаковка на MacBook: шеллить prebuilt whisper.cpp-бинарь (проще, матчит «no pip install code»-правило — юзер билдит per SETUP.md) vs pywhispercpp-биндинги vs крошечный локальный HTTP-сервис транскрипции? Склоняемся к шелл-аут whisper.cpp-бинарю.
- Идентичность владельца: достаточно ли одного `OWNER_CHAT_ID`, или мост должен пинить ещё `from_user.id` (на случай добавления бота в группу)? Для приватного 1:1-чата `chat_id == user_id`, одной константы хватает, но задокументировать групповой случай.
- Проактивная доставка при спящем Mac (ADR-0005): «due, но машина была off»-напоминания стрелять поздно на пробуждении или скипать? Влияет на scheduler/reminders-дизайн, не на Telegram-слой.
- Принять self-hosted `tdlib/telegram-bot-api`-сервер сейчас (2GB-файлы + local-path, убирает 20MB-голосовой-потолок) или остаться на cloud `api.telegram.org` для v1 (проще, без Docker)?

## Связанные

- [README.md](README.md) · [../adr/0004-telegram-bridge-reactive-proactive.md](../adr/0004-telegram-bridge-reactive-proactive.md) · [engine-runtime.md](engine-runtime.md) · [proactive-scheduling.md](proactive-scheduling.md) · [privacy-security.md](privacy-security.md)
