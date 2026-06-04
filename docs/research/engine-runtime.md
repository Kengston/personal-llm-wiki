---
title: Движок и headless-runtime
type: audit
status: verified
last_updated: 2026-05-31
sources:
  - https://developers.openai.com/codex/noninteractive
  - https://developers.openai.com/codex/config-reference
  - https://codex.danielvaughan.com/2026/04/24/codex-subscription-api-programmatic-access-gpt-5-5-chatgpt-plan/
---

# Движок и headless-runtime

> ⚠️ Этот research выполнен ДО разворота движка. Решение по движку пересмотрено: см. ADR-0008 (Claude-native), заменяет ADR-0001. Раздел оставлен как обоснование/история.

> Направление исследования: запуск подписочного coding-agent CLI в headless-режиме как долгоживущего движка персонального ассистента (2026). Обосновывает [ADR-0001](../adr/0001-engine-subscription-codex.md) и формализуется в [ADR-0007](../adr/0007-engine-spawn-and-scheduler.md).

## Вывод

Codex CLI — обоснованный выбор движка для «Второго мозга». Headless-поверхность зрелая: `codex exec` запускается неинтерактивно, `--json` даёт поток JSONL-событий, `resume <SESSION_ID>` обеспечивает непрерывность, под ChatGPT-OAuth запросы идут через подписочный backend = **`$0` сверх плана**, ровно как в ADR-0001. Главный архитектурный вывод: **спавнить один короткоживущий процесс на задачу**, не держать резидентный демон.

## Ключевые находки

### Headless-точка входа и поток событий
`codex exec` — headless-точка входа; `--json` превращает stdout в поток JSONL (`thread.started`, `turn.started`/`turn.completed` с объектом `usage`, `item.started`/`completed`/`failed`, `error`). Финальный ответ также можно забрать через `-o/--output-last-message <path>`, а JSON-Schema-ответ навязать через `--output-schema <path>`. Пример: `{"type":"turn.completed","usage":{"input_tokens":24763,...}}`. (high)

### Непрерывность диалога
Непрерывность — `codex exec resume <SESSION_ID> "<next>"` или `codex exec resume --last`. Сессии авто-сохраняются как JSONL под `~/.codex/sessions/YYYY/MM/DD/`. С CLI 0.132.0 (2026-05-20) `codex exec resume` тоже принимает `--output-schema`. (high)

### Stdin-piping
Piping first-class: piped-тело + prompt-arg → prompt = инструкция, piped-контент = контекст; `codex exec -` читает весь prompt из stdin. Полезно для подачи тела Telegram-сообщения или raw/-снапшота как контекста. (high)

### Стоимость под подпиской
Под ChatGPT-OAuth CLI идёт через недокументированный `chatgpt.com/backend-api/codex/responses` и считается против rolling 5ч + недельного окна = **`$0` сверх плана** (без per-token-оплаты). Это ровно cost-модель ADR-0001. (high)

### Конкретные лимиты 2026
Plus ≈ 15–80 GPT-5.5-сообщений / 5ч; Pro $200 (20x) — до ~1600 / 5ч; оба ограничены ещё и недельным окном. Изменение от 2 апреля 2026 перевело учёт с per-message на token/reasoning-time. Проверять живой запас — `/status`. Для одного пользователя необязывающе. (medium)

### Надёжность auth для планировщика
Токены рефрешатся проактивно при активном использовании и реактивно на 401 (refresh-and-retry), обновлённые креды пишутся обратно в `auth.json`. НО ChatGPT-сессия считается stale после ~8 дней без рефреша → нужен браузерный re-login. Наш launchd/cron гоняется раз в несколько часов → токен рефрешится чаще, чем раз в 8 дней — staleness на практике не проблема, но `SETUP.md` должен это флагнуть (после долгих периодов «машина выключена» может понадобиться ручной `codex login`). (high)

### Анти-паттерн: долгоживущий демон
**Не держать один долгоживущий codex-процесс через истечение токена.** Open-баг #17041 (заведён 2026-04-07, CLI 0.118.0, всё ещё open): живая сессия падает после истечения токена (401, умирает после 5 reconnect-попыток) и не подхватывает извне-обновлённый `auth.json`. Наша модель spawn-fresh-per-task полностью это обходит; это причина **избегать резидентного демона**. (high)

### ToS-позиция
Серая зона, склоняющаяся к разрешительной для нашего случая. CLI — Apache-2.0 (форкается); мейнтейнер OpenAI отказался благословлять commercial/programmatic-паттерны («я инженер, не юрист»), но указал на прецедент OpenCode; позиция OpenAI — пользователи «могут использовать Codex и свою ChatGPT-подписку где угодно», с рекомендацией API-ключей для **production**. Backend-эндпоинт недокументирован и «может меняться без уведомления». Совпадает с CONTEXT §6 OQ-5: низкий риск для личного single-use, мониторить лимиты/дрейф эндпоинта. (medium)

### Ключи config.toml для моста/планировщика
`model` (напр. `"gpt-5.5"`), `model_reasoning_effort` (minimal..xhigh), `approval_policy`/`--ask-for-approval never` для unattended-запусков, `sandbox_mode` (read-only | workspace-write | danger-full-access) с `sandbox_workspace_write.network_access` и `.writable_roots`, `forced_login_method="chatgpt"` (запереть подписочный auth), `cli_auth_credentials_store` (file|keyring|auto), `[mcp_servers.*]`, именованные `profile`, `history.persistence`. Для движка нужен non-interactive: `--ask-for-approval never` + ограниченный sandbox (workspace-write на репо вики через `writable_roots`, сеть только если коннектору нужно). (high)

### Footgun `--ephemeral`
Ephemeral-запуски не персистятся и не resume'ятся; хуже — `codex exec resume <id>` на ephemeral-thread **молча стартует НОВЫЙ thread** (#15538) вместо ошибки. Для реактив/диалог-пути ОБЯЗАТЕЛЬНО использовать персистентные сессии (без `--ephemeral`) и хранить реальный `session_id`; `--ephemeral` — только для stateless one-shot проактивных пушей, где непрерывность не нужна. (high)

## Портируемость движка

### Claude Code — ближайший аналог
`claude -p "..."`, `--output-format text|json|stream-json` (stream-json нужен `--verbose`), `--resume <session_id>`/`--continue`, `--json-schema`, `--allowedTools`/`--permission-mode`; `session_id` берут из `--output-format json | jq -r '.session_id'`. Session-id ОБЯЗАНЫ быть реальными UUID. Маппится почти 1:1 на нашу `run_engine()`. (high)

### Два события 2026 ослабляют Claude как дроп-ин
(1) 2026-01-09 Anthropic выкатил server-side-блокировки, убившие подписочный OAuth для third-party-инструментов (OpenCode/Cline/Roo), позже — юридические требования; (2) с 2026-06-15 даже first-party `claude -p`/Agent-SDK на подписочных планах тянет из ОТДЕЛЬНОГО месячного «Agent SDK credit», не из интерактивных лимитов. «Просто переключусь на Claude по моей подписке» — не бесплатный латеральный переход. (high)

### OpenCode — рабочий fallback
`opencode run "..." --format json` (или `-p ... -f json`), парсится через jq (`select type==text`/`step_finish` для cost+tokens); resume — `opencode run --session <id>` (single-shot на процесс, как у нас); `opencode serve` даёт HTTP API. После Anthropic-fallout OpenAI официально расширил поддержку подписки на OpenCode/OpenHands/Roo — может крутиться на той же ChatGPT-подписке. (medium)

### Локальный Ollama — только stub
Qwen2.5-Coder-32B / Qwen3-Coder — `$0` + максимум приватности, но не v1-ready: Qwen2.5-Coder-32B соперничает с GPT-4o на code-бенчмарках, но нужен 32B-capable-машина; агентный tool-calling хрупкий (модели возвращают tool-call'ы как JSON в поле `content`, а не структурно → харнесс их не исполняет); дефолтный контекст Ollama 4096 токенов надо поднять до ≥64K. Верное решение — оставить labelled-stub за `run_engine()`, ровно как в ADR-0001. (medium)

### Headless-установка автоматизируема, кроме одного логина
`CODEX_NON_INTERACTIVE=1` включает non-interactive install-скрипты (changelog 2026-05-21, CLI 0.133.0), `codex login --device-auth` покрывает headless/remote sign-in (beta), `codex doctor` даёт диагностику (0.135.0, 2026-05-28). Единственный неизбежный человеческий шаг — браузерный OAuth-логин → в `setup/SETUP.md` per ADR-0004, не в автоматику. (high)

## Рекомендации

- **Паттерн спавна (мост + планировщик):** спавнить ОДИН короткоживущий `codex exec` НА задачу и дать ему выйти — никогда не резидентный демон. Обходит баг живой-сессии-401 (#17041), держит каждый ход идемпотентным и crash-safe.
- **Реактивный ход (Telegram):** `codex exec resume <session_id> --json --skip-git-repo-check --cd <wiki_repo> -m gpt-5.5 -a never "<msg>"`, где `session_id` из SQLite-карты `chat_id->session_id` (проверенный паттерн pachca-codex-bridge). На ПЕРВОМ сообщении чата — `codex exec --json ...` (без resume), парсить `thread.started` → новый `session_id`, персистить. Не использовать `--ephemeral` (resume на ephemeral молча форкает, #15538).
- **Проактивный пуш (launchd/cron):** stateless `codex exec --json -o /tmp/out.json -a never --cd <wiki_repo> "..."`; здесь `--ephemeral` ок. Telegram Bot API-вызов делает мост/планировщик (не codex) после выхода процесса — движок остаётся side-effect-free и портируемым.
- **Поток JSONL читать построчно** (не блокировать на всём выводе): игнорировать `item.*`/reasoning кроме логирования, действовать на `turn.completed` (брать `usage` для учёта лимитов), всплывать `error`. Финальный ответ — через `-o <file>` (проще, чем парсить JSONL).
- **Оборачивать каждый спавн:** asyncio/subprocess неблокирующе, жёсткий timeout (120–240с) с kill ребёнка, single-flight на `chat_id` (lock/queue, чтобы два сообщения в чате не гонялись за одной сессией), один ограниченный retry на transient-`error`/non-zero-exit. На 429/limit-`error` — backoff и ответ юзеру «лимит», а не долбёжка.
- **Закрепить auth + sandbox в `~/.codex/config.toml`:** `forced_login_method="chatgpt"`, `approval_policy="never"`, `sandbox_mode="workspace-write"` с `writable_roots=["<llm-wiki-content>"]` и `network_access=false`, если коннектору не нужен egress.
- **Движок за единой `run_engine(prompt, session_id|None) -> (answer, new_session_id, usage)`** (один модуль, ~1 функция), argv собирается из конфига. Это шов портируемости ADR-0001: смена на `claude -p`/`opencode run` — смена адаптера, не переписывание моста. Поставить Claude/OpenCode/Ollama как labelled-stub-адаптеры в публичном репо.
- **Шаги `SETUP.md` (только человек):** установить codex + gh (Bash brew-строки как инструкции); одноразовый `codex login` (note: сессия stale после ~8 дней idle и после долгого off → re-`codex login`); создать Telegram bot token; запустить Cloudflare Tunnel; создать launchd-plist. Использовать `CODEX_NON_INTERACTIVE=1` для install-скрипта и `codex doctor` как health-check.
- **Reliability-guardrails планировщика:** перед проактивным запуском опционально парсить последний `turn.completed.usage` для детекта «limit reached»; держать heartbeat/last-success-файл; сделать launchd-job `RunAtLoad`+interval, чтобы он догонял на пробуждении (ADR-0005).
- **Подписочный backend — best-effort, не SLA:** логировать каждый `error`-payload, мониторить дрейф эндпоинта, держать usage сильно под caps. Конкретная митигация CONTEXT §6 OQ-5.

## Подводные камни

- Долгоживущий codex-демон = ловушка: резидентный процесс умирает на истечении токена (401, 5 неудачных reconnect) и не подхватывает обновлённый `auth.json` (#17041, open). Всегда спавнить свежий процесс на задачу.
- `--ephemeral` + resume молча форкает новый thread (#15538) и теряет диалог. Никогда не использовать `--ephemeral` на реактив/resume-пути.
- Забыть `forced_login_method="chatgpt"` → Codex может уйти в API-key-auth (если в env есть `OPENAI_API_KEY`) и молча биллить per-token — прямое нарушение $0 ADR-0001.
- Переписывать `auth.json` из сохранённого секрета на каждом запуске = выбросить токены, которые Codex только что рефрешнул, и сломать сессию. Создать раз через `codex login`, дальше дать Codex рефрешить in-place.
- `--dangerously-bypass-approvals-and-sandbox` / `danger-full-access` ради «чтобы просто работало» даёт агенту неограниченный shell/сеть на Mac. Использовать `approval_policy=never` + scoped `workspace-write`.
- Считать подписочный путь стабильным public API: это недокументированный `chatgpt.com/backend-api/codex/responses`, может ломаться без уведомления; не строить хрупкий парсинг на недокументированных формах ответов.
- Ставить на Claude-подписочный fallback: Anthropic блокирует third-party-харнесс-OAuth (с 2026-01-09), и с 2026-06-15 даже first-party `claude -p` тянет из отдельного метеред-credit.
- Поставлять Ollama/Qwen-local как рабочий v1-движок: tool-calling ненадёжен, нужен контекст ≥64K и железо 32B-класса. Оставить stub per ADR-0001.
- Блокировать FastAPI-мост на полном codex-процессе (webhook Telegram отвалится по timeout). Гонять codex async/неблокирующе с timeout и отвечать позже.
- Хардкодить числа лимитов как гарантии: лимиты 2026 token/reasoning-based, варьируются; трекать реальный `turn.completed.usage` / `/status`.

## Открытые вопросы

- Точные текущие caps Plus vs Pro (5ч И неделя) для конкретной запиненной модели — измерять эмпирически через `turn.completed.usage` / `/status` после установки.
- Полностью ли `forced_login_method="chatgpt"` предотвращает любой молчаливый API-key-fallback в `codex exec`-автоматике, или env-`OPENAI_API_KEY` может перебить — быстрая локальная проверка на сетапе.
- Пинить ли реактивному мосту `model_reasoning_effort` low/medium (дешевле, под лимитами, быстрее) vs high (лучше правки вики) — тюнинг после наблюдения реального usage.
- Поведение при долгом off на macOS: после сна за пределами ~8-дн staleness (или рестартов ОС) — авто-recover или жёсткий ручной `codex login`? Влияет на робастность unattended-проактива (ADR-0005).
- Добавлять ли явный [ADR-0007](../adr/0007-engine-spawn-and-scheduler.md) с паттерном спавна + контрактом адаптера + принятием риска эндпоинта — **да, добавлен** (бриф разрешает 0007+).

## Связанные

- [README.md](README.md) · [../adr/0001-engine-subscription-codex.md](../adr/0001-engine-subscription-codex.md) · [../adr/0007-engine-spawn-and-scheduler.md](../adr/0007-engine-spawn-and-scheduler.md) · [telegram-interface.md](telegram-interface.md) · [proactive-scheduling.md](proactive-scheduling.md)
