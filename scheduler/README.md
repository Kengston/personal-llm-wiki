---
title: scheduler — плановый и событийный слой
type: overview
status: accepted
last_updated: 2026-05-31
sources:
  - ../docs/research/proactive-scheduling.md
  - ../docs/adr/0007-engine-spawn-and-scheduler.md
  - ../docs/adr/0008-engine-claude-native.md
---

# `scheduler/` — плановый и событийный слой «Второго мозга»

> Проактивная часть системы — **плановый** и **событийный** слои из
> [CONTEXT §4](../CONTEXT.md) (реактивный делает [`bridge/`](../bridge/README.md)).
> По расписанию (или по событию) зовёт движок `claude -p --output-format json`
> (Claude-native, [ADR-0008](../docs/adr/0008-engine-claude-native.md)) над приватным
> репо: компилирует вики, шлёт утренний дайджест + напоминания, линтит, делает
> web-research, освежает идеи. Полный перечень — [КАТАЛОГ ROUTINES](routines/README.md).
> Плюс линт-guard, держащий публичный репо чистым от PII/секретов. Обоснование —
> [research/proactive-scheduling.md](../docs/research/proactive-scheduling.md), решения —
> [ADR-0007](../docs/adr/0007-engine-spawn-and-scheduler.md),
> [ADR-0008](../docs/adr/0008-engine-claude-native.md),
> [ADR-0009](../docs/adr/0009-tos-safe-engine-access.md).

## Что здесь лежит

| Файл | Назначение |
|---|---|
| [`routines.py`](routines.py) | **Диспетчер каталога routine'ов** (`python -m scheduler.routines <name>`): compile / digest / lint / research / resurface. Спавн движка — через [`bridge/engine.py`](../bridge/README.md) (дефолт `ClaudeEngine`), не дублируя `claude -p`. |
| [`routines/`](routines/README.md) | [КАТАЛОГ ROUTINES](routines/README.md) (расписания, контракты, слои) + plist-шаблоны `ru.secondbrain.{compile,lint,research,resurface}.plist`. |
| [`digest.py`](digest.py) | routine `digest`: предчек «что due» → спавн движка (`claude -p`) → push в Telegram (через [`bridge/telegram.py`](../bridge/README.md)). Last-mile sanitizer-guard. |
| [`reminders.py`](reminders.py) | Детерминированный парсер `reminders.md` + движок «что due» (чистый Python, без движка/сети — unit-testable). Дни рождения из вики. Лесенка Leitner для idea-resurfacing. |
| [`reminders_spec.md`](reminders_spec.md) | Спецификация формата `reminders.md` (поля, kinds, recurrence, lifecycle). Контракт движок ⇄ sweep. |
| [`lint_public.py`](lint_public.py) | Guard публичного репо: `exit 1`, если найдены секреты/реальные PII. Импортит `ingest.sanitizer.scan_secrets`. Для pre-commit/CI и routine `lint`. |
| [`run_routine.sh`](run_routine.sh) | Generic-обёртка для launchd: грузит `.env`, активирует venv, `caffeinate` на время запуска, зовёт `python -m scheduler.routines <ROUTINE>`. |
| [`run_sweep.sh`](run_sweep.sh) | Обёртка специально под routine `digest` (исторический алиас `run_routine.sh digest`): грузит `.env`, `caffeinate`, `python -m scheduler.digest`. |
| [`ru.secondbrain.digest.plist`](ru.secondbrain.digest.plist) | LaunchAgent routine `digest`: 30-мин `StartInterval` + утренний `StartCalendarInterval` 08:00 + `RunAtLoad`. Шаблон с `__PUBLIC_REPO__`. |

## Как это работает (routine `digest` — sweep)

```
launchd (LaunchAgent)  ИЛИ  remote Claude routine
   │  каждые 30 мин + 08:00 + при load/wake
   ▼
run_routine.sh digest  ──gruzит .env, caffeinate──►  python -m scheduler.digest
   (или run_sweep.sh)                                       │
   1. ПРЕДЧЕК (чистый Python, БЕЗ движка):                   │
      reminders.collect_due_items()  ◄──────────── reminders.md + wiki/ (дни рождения)
      ничего не due → ВЫХОД (не жжём Agent-SDK-кредит Claude, ADR-0009)
                                                            │ есть due
   2. СПАВН ДВИЖКА (stateless, session_id=None):             ▼
      bridge.engine → ClaudeEngine.run(sweep_prompt) ──► claude -p --output-format json
      движок: читает reminders+wiki, составляет дайджест, обновляет сработавшие записи
                                                            │
   3. LAST-MILE GUARD: assert_no_secrets(digest)             │  (ingest.sanitizer.scan_secrets)
                                                            ▼
   4. PUSH: bridge.telegram.send_message(digest) ──► Telegram владельцу (Bot API)
```

Ключевой принцип ([ADR-0007 §2](../docs/adr/0007-engine-spawn-and-scheduler.md)):
**идемпотентный sweep, а не таймер-на-напоминание.** launchd при пробуждении из
сна запускает пропущенную задачу (cron — скипает) и *коалесцирует* несколько
пропущенных интервалов в одно событие. Поэтому один запуск читает ВСЕ due-элементы
и составляет ОДИН дайджест; дедуп от коалесцированного двойного запуска — в коде
(`status`/`last_fired`, см. [`reminders.py`](reminders.py) `_already_fired_today`).

> Остальные routine'ы (`compile`/`lint`/`research`/`resurface`) идут тем же
> паттерном через [`routines.py`](routines.py): спавн `claude -p` через
> `bridge.engine` (+ опц. owner-push через тот же last-mile guard). Их триггеры,
> расписания и промпт-контракты — в [КАТАЛОГЕ ROUTINES](routines/README.md).

## Как вычисляется «due»

Полностью детерминированно в [`reminders.py`](reminders.py) (см.
[`reminders_spec.md`](reminders_spec.md) — раздел «Как вычисляется due»). Кратко:
элемент в дайджест «сегодня», если он живой (`pending`/`snoozed`), `due_at <= now +
grace` (5 мин) и не стрелял сегодня. В пределах `lookahead` (7 дн) — попадает в
секцию «скоро» (превью, без пометки `last_fired`). Recurring без явного `due_at`
выводится из `rrule` (`next_occurrence` через `python-dateutil`). Дни рождения —
из frontmatter person-страниц вики, не дублируются в `reminders.md`.

Это «дешёвый anything-due-предчек перед спавном движка» из research: гонять
`claude -p` вхолостую на каждом 30-мин тике расточительно для месячного
Agent-SDK-кредита Claude ([ADR-0009](../docs/adr/0009-tos-safe-engine-access.md)).

## Зависимости и контракты

- **`ingest.sanitizer.scan_secrets(text) -> list[str]`** — общий детектор секретов.
  `digest.py`/`routines.py` зовут его как last-mile guard перед push; `lint_public.py`
  — как основу guard'а публичного репо. **Не переопределяем** (один sanitizer на
  write-path — инвариант [CONTEXT §3](../CONTEXT.md)).
- **`bridge.engine`** — движок за портируемой абстракцией `Engine`
  (`run(prompt, session_id|None) -> EngineResult`), дефолт **`ClaudeEngine`**
  (официальный `claude -p`, [ADR-0008](../docs/adr/0008-engine-claude-native.md)).
  `digest.py` загружает его устойчиво: предпочитает фабрику `build_engine_from_env()`,
  затем классы `ClaudeEngine`/`GrokEngine`/`CodexEngine` (отложенные слоты), затем
  legacy-функцию `run_engine` — и нормализует результат (async-корутина / `EngineResult`
  / кортеж) в `(answer, session_id, usage)`. Так scheduler не хардкодит движок —
  его выбирает конфиг моста.
- **`bridge.telegram`** — клиент Bot API с `send_message(text,
  disable_notification=...)`. Токен/`OWNER_CHAT_ID` — из приватного `.env`.
- **`python-dateutil`** — единственная внешняя hard-зависимость
  (`rrulestr`/`rrule` для recurrence). YAML парсим мини-парсером без PyYAML
  (формат `reminders.md` плоский). См. [`pyproject.toml`](pyproject.toml) моста
  или установку в [setup/SETUP.md](../setup/SETUP.md).

> `bridge.*` импортируются **лениво** внутри функций `digest.py` — чтобы прогон
> логики `reminders.py`/`lint_public.py` не падал, пока мост ещё устанавливается.

## Запуск вручную

```bash
# из корня публичного репо, с PYTHONPATH=.
export PYTHONPATH="$PWD"

# каталог routine'ов (что вообще можно запустить):
python -m scheduler.routines --list

# любая routine через диспетчер (--dry-run = собрать промпт, не звать движок):
python -m scheduler.routines compile --dry-run
python -m scheduler.routines research --dry-run
python -m scheduler.routines lint            # PII-скан публичного репо + аудит вики

# routine digest напрямую (эквивалент `routines digest`):
python -m scheduler.digest --print-due       # только показать due-список (предчек)
python -m scheduler.digest --dry-run         # собрать sweep-промпт, не звать движок
python -m scheduler.digest                   # боевой sweep (нужен claude + Telegram-токен в .env)

# линт публичного репо (CI/pre-commit) — отдельно от routine lint:
python -m scheduler.lint_public
python -m scheduler.lint_public --files path/to/changed.md  # только staged-файлы
```

## Два варианта планировщика

routine'ы движок-агностичны по триггеру: один и тот же `claude -p`-промпт можно
запускать **локально** (launchd) или **удалённо** (remote Claude routine). Выбор —
это [CONTEXT §6 OQ-3](../CONTEXT.md): начинаем с launchd, апгрейд — remote routines.

### Вариант A — локальный launchd (рекомендация для v1)

Просто, приватно, без внешних сервисов; **но работает, только пока MacBook
бодрствует** ([ADR-0005](../docs/adr/0005-host-v1-macbook-portable.md): v1 — не always-on).
LaunchAgent (не LaunchDaemon): GUI-юзер → есть сеть и `claude login`-сессия, sudo
не нужен. Полные шаги — [setup/SETUP.md](../setup/SETUP.md); суть на примере `digest`:

1. В нужном plist-шаблоне заменить `__PUBLIC_REPO__` на абсолютный путь к репо
   (`digest` — [`ru.secondbrain.digest.plist`](ru.secondbrain.digest.plist);
   остальные — [`routines/`](routines/README.md):
   `ru.secondbrain.{compile,lint,research,resurface}.plist`).
2. Скопировать в `~/Library/LaunchAgents/<label>.plist`.
3. Зарегистрировать современным способом (не legacy `launchctl load`):
   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ru.secondbrain.digest.plist
   launchctl kickstart -k gui/$(id -u)/ru.secondbrain.digest   # прогнать сразу
   ```
4. Снять с регистрации: `launchctl bootout gui/$(id -u)/ru.secondbrain.digest`.

Те же 4 шага — для каждого routine-plist (подставь его Label). Дайджест держит два
триггера в одном plist (30-мин sweep + 08:00); compile/lint/research/resurface —
по `StartCalendarInterval` (правь расписание под себя).

### Вариант B — remote Claude routines (апгрейд к 24/7)

Те же промпты, но запускаемые **удалённой Claude-routine над приватным
GitHub-репо** — срабатывают, **даже когда Mac спит или выключен**. Это закрывает
осознанное ограничение launchd (пропущенный при сне/выключении слот) **без**
покупки Mac Mini / перехода на LaunchDaemon — настоящий always-on-проактив
([CONTEXT §4](../CONTEXT.md), [ADR-0005](../docs/adr/0005-host-v1-macbook-portable.md)).

Условия (важно): remote-routine оперирует данными в **приватном GitHub-репо**
`llm-wiki-content` (push результата правок туда), а не на локальной FS; всё так же
**ToS-safe** — официальный `claude` под аккаунтом владельца, single-user, без
реюза OAuth-токена в стороннем клиенте ([ADR-0009](../docs/adr/0009-tos-safe-engine-access.md)).
Telegram-push остаётся нашим шагом после выхода движка (egress — узкий owner-only).

**Рекомендация v1:** launchd (вариант A) для всего; перевести на remote routines
(вариант B) первым делом `compile`/`research`/`resurface` (им не нужна локальная FS),
когда понадобится проактив при спящем Mac. `digest` тоже переносим (он читает
`reminders/` + `wiki/` из того же приватного репо).

## Заметки про сон, пробуждение и батарею (из research)

- **catch-up-on-wake — основной механизм v1.** launchd запускает пропущенный
  при сне `StartInterval`/`StartCalendarInterval` вскоре после пробуждения и
  коалесцирует пропуски в одно событие. Это делает «sweep all due → один дайджест»
  верным дизайном, а не багом. Совпадает с оговоркой
  [ADR-0005](../docs/adr/0005-host-v1-macbook-portable.md): v1 работает, только
  когда MacBook бодрствует.
- **`RunAtLoad` покрывает post-boot gap** (login после загрузки), который
  wake-catch-up не покрывает. Но слот, пропущенный при **полностью выключенном**
  Mac, launchd не отыгрывает — это осознанное ограничение варианта A (локальный
  launchd). Его снимает **вариант B (remote Claude routines)**: они работают над
  приватным GitHub-репо даже при спящем/выключенном Mac (см. «Два варианта
  планировщика») — без Mac Mini / LaunchDaemon.
- **`caffeinate` — только вокруг запуска, не 24/7.** [`run_routine.sh`](run_routine.sh)
  / [`run_sweep.sh`](run_sweep.sh) оборачивают запуск в `caffeinate -s` на время
  выполнения и отпускают сразу. Permanent `caffeinate` посадит батарею MacBook — не делаем.
- **Опциональное усиление (ручной opt-in, в SETUP.md, НЕ автоматизируем):**
  `sudo pmset repeat wakeorpoweron MTWRFSU 07:55:00` — Mac просыпается ~5 мин до
  утреннего 08:00-дайджеста. `pmset` допускает только ОДНУ repeat-схему и требует
  sudo; конфликтует с другими power-схемами — поэтому ручной opt-in, не часть кода.

## Безопасность исходящего

- **Last-mile guard.** Перед push `digest.py`/`routines.py` гоняют `scan_secrets`
  по исходящему тексту и **отменяют отправку**, если найден секрет — даже в личный
  чат владельца (токен/ключ в сообщении ≈ случайная утечка из вики/лога).
- **Движок без egress-инструмента.** Telegram-вызов делает ЭТОТ слой после выхода
  `claude -p`, а не сам движок — движок остаётся side-effect-free и портируемым.
  Единственный исходящий канал — узкий owner-only push. Это минимизация blast
  radius для lethal-trifecta (приватные данные + недоверенный ингест + внешняя
  коммуникация); 100%-защиты от prompt-injection нет
  ([ADR-0007 §risks](../docs/adr/0007-engine-spawn-and-scheduler.md),
  [ADR-0009](../docs/adr/0009-tos-safe-engine-access.md),
  [privacy-security.md](../docs/research/privacy-security.md)).

## `lint_public.py` в pre-commit / CI

Guard границы двух репо ([ADR-0003](../docs/adr/0003-two-repos-public-private.md)).
Пример pre-commit-хука (`.git/hooks/pre-commit` или `.pre-commit-config.yaml`):

```bash
#!/usr/bin/env bash
# проверяем только staged-файлы — быстро
staged=$(git diff --cached --name-only --diff-filter=ACM)
[ -z "$staged" ] && exit 0
PYTHONPATH="$PWD" python -m scheduler.lint_public --files $staged
```

В CI — гонять по всему дереву (`python -m scheduler.lint_public`) плюс отдельный
gitleaks-job (полная история) — research: «pre-commit одного мало, нужен CI».
Линт уважает синтетические маркеры (`synthetic-example`, «Пример», `example.com`,
fake-токен `123456:AA…`) и освобождает [`wiki-example/`](../wiki-example/) +
`.env.example` от PII-паттерн-проверки (но не от `scan_secrets` — настоящий секрет
недопустим даже там).

## Связанные

- [routines/README.md](routines/README.md) · [routines.py](routines.py) · [run_routine.sh](run_routine.sh) · [reminders_spec.md](reminders_spec.md) · [reminders.py](reminders.py) · [digest.py](digest.py) · [lint_public.py](lint_public.py)
- [../docs/research/proactive-scheduling.md](../docs/research/proactive-scheduling.md) · [../docs/adr/0007-engine-spawn-and-scheduler.md](../docs/adr/0007-engine-spawn-and-scheduler.md) · [../docs/adr/0008-engine-claude-native.md](../docs/adr/0008-engine-claude-native.md) · [../docs/adr/0009-tos-safe-engine-access.md](../docs/adr/0009-tos-safe-engine-access.md)
- [../bridge/README.md](../bridge/README.md) · [../setup/SETUP.md](../setup/SETUP.md)
