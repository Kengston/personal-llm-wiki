---
title: Каталог routine'ов — плановый слой
type: overview
status: accepted
last_updated: 2026-05-31
sources:
  - ../../docs/research/proactive-scheduling.md
  - ../../docs/adr/0007-engine-spawn-and-scheduler.md
  - ../../docs/adr/0008-engine-claude-native.md
---

# Каталог routine'ов «Второго мозга»

> **routine** — плановый (cron-подобный) триггер, который зовёт движок
> `claude -p --output-format json` (Claude-native, [ADR-0008](../../docs/adr/0008-engine-claude-native.md))
> над приватным контент-репо. Это **плановый** и **событийный** слои из
> [CONTEXT §4](../../CONTEXT.md) (реактивный слой — это [`bridge/`](../../bridge/README.md)).
> Диспетчер всех routine'ов — [`scheduler/routines.py`](../routines.py)
> (`python -m scheduler.routines <name>`); расписания и установка планировщика —
> в [`scheduler/README.md`](../README.md).

## Три слоя исполнения (где живут routine'ы)

```
РЕАКТИВ:    Telegram (owner-only) → bridge → ClaudeEngine (claude -p) → ответ/правка   [bridge/, НЕ здесь]
ПЛАНОВОЕ:   routine по времени (launchd / remote Claude routine) → claude -p → …       [routines.py]
СОБЫТИЙНОЕ: новый файл в raw/ → триггер (WatchPaths / hook) → routine compile          [routines.py]
```

Движок один на все слои (шов `Engine`, дефолт `ClaudeEngine`; `GrokEngine`/
`CodexEngine` — отложенные адаптеры-слоты, [ADR-0008](../../docs/adr/0008-engine-claude-native.md)).
routine'ы спавнят его **через** [`bridge.engine`](../../bridge/README.md) — не
дублируя логику `claude -p` (парсинг JSON, таймаут, resume).

## Каталог (5 routine'ов)

| # | routine | Слой / триггер | Расписание (дефолт) | Что делает | Исходящее |
|---|---|---|---|---|---|
| 1 | `compile` | ПЛАНОВОЕ + СОБЫТИЙНОЕ | ночью 03:30 (+ опц. WatchPaths на `raw/`) | новые источники из `raw/` → страницы `wiki/` (инкрементально, по watermark) | — (правит файлы вики) |
| 2 | `digest` | ПЛАНОВОЕ | утром 08:00 (+ sweep каждые 30 мин) | due-напоминания + дни рождения → один Telegram-дайджест | Telegram (owner) |
| 3 | `lint` | ПЛАНОВОЕ | еженедельно, вс 04:00 | PII/секрет-скан публичного репо + аудит вики (противоречия/stale/orphans) | Telegram (отчёт) + exit≠0 на PII |
| 4 | `research` | ПЛАНОВОЕ | вт и пт 09:00 | пользовательские запросы → web-research «руками» → файл в `wiki/research/` | Telegram (дайджест) + файл |
| 5 | `resurface` | ПЛАНОВОЕ | сб 11:00 | всплытие давно не тронутых идей (мягкий nudge) | Telegram (1–2 строки) |

Расписания — дефолты из plist-шаблонов в этой папке; правь под себя. Все routine'ы
**идемпотентны** (safe-to-run-twice): launchd коалесцирует пропущенные при сне
интервалы в одно wake-событие ([ADR-0007 §2](../../docs/adr/0007-engine-spawn-and-scheduler.md)).

### 1. `compile` — ночная/событийная компиляция

- **Вход:** не скомпилированные источники в `raw/` (курсор — per-source watermark,
  [`ingest/watermark.py`](../../ingest/README.md)).
- **Промпт:** движок читает контракт хранителя ([`compiler/rules.md`](../../compiler/rules.md)
  + [`AGENTS.md`](../../AGENTS.md)) и инкрементально дописывает страницы `wiki/`:
  концепции/идеи/развитие — first-class; код-сессии **сжимаются** в
  accomplishment/capability-выжимку, не verbatim ([ADR-0010](../../docs/adr/0010-wiki-content-model.md)).
- **Гарантии:** маленькие git-diff-правки, противоречия через `superseded` (не
  перезапись), никакого автономного bulk-rewrite ([`compiler/rules.md` §0](../../compiler/rules.md)).
- **Событийный режим:** тот же `compile`, повешенный на `WatchPaths` (`raw/`) —
  компиляция стартует сразу после ингеста, а не ждёт ночи (см. plist-шаблон).
- **Идемпотентность:** watermark двигается после успешной записи.

### 2. `digest` — утренний дайджест + напоминания

- **Реализация:** делегирует в [`scheduler/digest.py`](../digest.py) `run_sweep()`.
- **Поток:** дешёвый детерминированный предчек «что due» ([`reminders.py`](../reminders.py),
  без движка) → если есть due, спавн движка с sweep-промптом → last-mile
  `scan_secrets`-guard → owner-push в Telegram.
- **Идемпотентность:** дедуп по `status`/`last_fired` (см. [`reminders_spec.md`](../reminders_spec.md)).
- **Формат напоминаний** — контракт [`reminders_spec.md`](../reminders_spec.md)
  (поля, kinds `oneoff`/`recurring`/`spaced`, recurrence, дни рождения из вики).

### 3. `lint` — еженедельный аудит чистоты и связности

- **Часть (а), детерминированная:** [`scheduler/lint_public.py`](../lint_public.py)
  сканирует ПУБЛИЧНЫЙ репо на секреты/PII (импортит **`ingest.sanitizer.scan_secrets`**
  — один детектор на write-path). Находка → `exit≠0` (блокирует, как в CI/pre-commit).
- **Часть (б), движок:** `claude -p` проводит содержательный аудит ВИКИ —
  противоречия (`superseded`), протухшее (`stale`), orphan-страницы (дописать в
  `index.md`), битые ссылки — точечными правками, спорное выносит в отчёт.
- **Исходящее:** отчёт владельцу в Telegram + ненулевой код, если PII-скан нашёл утечку.

### 4. `research` — плановый web-research

- **Вход:** пользовательские запросы из приватного `research/queries.md`
  (markdown-список `- <запрос>`; путь — env `RESEARCH_QUERIES`).
- **Промпт:** на каждый запрос движок делает web-research своими **«руками»**
  (web/computer-MCP — [ADR-0008](../../docs/adr/0008-engine-claude-native.md)),
  пишет структурированный конспект файлом в `wiki/research/` (frontmatter +
  `sources:`) и возвращает короткий дайджест.
- **Исходящее:** дайджест владельцу в Telegram (по 1–2 строки на запрос + ссылка
  на файл-конспект) + сам файл в вики.
- **Нет запросов → выходим без спавна** (экономим Agent-SDK-кредит, [ADR-0009](../../docs/adr/0009-tos-safe-engine-access.md)).

### 5. `resurface` — idea-resurfacing

- **База:** всплытие реализовано записями `kind: spaced` в `reminders.md` (лесенка
  Leitner `[1, 3, 7, 16, 35]` дней, [`reminders.py`](../reminders.py) `LEITNER_LADDER`),
  которые **уже** выводит routine `digest`. Это основной путь.
- **Эта routine** — дополнительный лёгкий слой для идей БЕЗ spaced-напоминания:
  движок выбирает давно не тронутую идею из `wiki/ideas/` и шлёт один дружелюбный
  вопрос «ещё актуальна?». Файлы не меняет (мягкий nudge). Если spaced-механизма
  в `digest` достаточно — эту routine можно не устанавливать.

## Два варианта планировщика (резюме)

Подробности и пошаговая установка — в [`scheduler/README.md`](../README.md). Кратко:

- **Локальный launchd (рекомендация для v1).** Plist-шаблоны `ru.secondbrain.*.plist`
  в этой папке (`compile`/`lint`/`research`/`resurface`) + `ru.secondbrain.digest.plist`
  в [`scheduler/`](../). Просто и приватно, но **работает, только пока MacBook бодрствует**.
- **Remote Claude routines (апгрейд к 24/7).** Те же промпты, запускаемые удалённой
  Claude-routine **над приватным GitHub-репо** — срабатывают, **даже когда Mac спит
  или выключен**. Это путь к настоящему always-on без Mac Mini/LaunchDaemon
  ([ADR-0005](../../docs/adr/0005-host-v1-macbook-portable.md), [CONTEXT §6 OQ-3](../../CONTEXT.md)).

## Безопасность routine'ов (инвариант)

- **Движок side-effect-free.** Единственный исходящий канал — узкий owner-only push
  в Telegram, который делает [`routines.py`](../routines.py)/[`digest.py`](../digest.py)
  **после** выхода движка, а не сам движок. Минимизация blast-radius для
  lethal-trifecta ([ADR-0007 §risks](../../docs/adr/0007-engine-spawn-and-scheduler.md),
  [privacy-security.md](../../docs/research/privacy-security.md)).
- **Last-mile guard.** Любой исходящий текст проходит общий `scan_secrets` из
  [`ingest.sanitizer`](../../ingest/README.md) — ни токен, ни ключ не уйдёт даже в
  личный чат.
- **ToS-safe (ADR-0009).** Только официальный `claude -p`; никакого реюза OAuth-токена
  в стороннем клиенте; single-user (owner-only). Grok-адаптер при появлении гоняется
  через Grok Build CLI или OpenClaw — последний допустим **только** для Grok, никогда
  для Claude.

## Связанные

- [../README.md](../README.md) · [../routines.py](../routines.py) · [../run_routine.sh](../run_routine.sh) · [../digest.py](../digest.py) · [../lint_public.py](../lint_public.py) · [../reminders_spec.md](../reminders_spec.md)
- [../../docs/adr/0008-engine-claude-native.md](../../docs/adr/0008-engine-claude-native.md) · [../../docs/adr/0009-tos-safe-engine-access.md](../../docs/adr/0009-tos-safe-engine-access.md) · [../../docs/adr/0010-wiki-content-model.md](../../docs/adr/0010-wiki-content-model.md) · [../../docs/adr/0007-engine-spawn-and-scheduler.md](../../docs/adr/0007-engine-spawn-and-scheduler.md)
- [../../docs/research/proactive-scheduling.md](../../docs/research/proactive-scheduling.md) · [../../CONTEXT.md](../../CONTEXT.md)
