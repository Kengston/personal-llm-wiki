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

> Реализация — **TypeScript** (Node 22, strict ESM), порт с Python ([ADR-0012](../docs/adr/0012-language-typescript-port.md)): luxon (tz-aware время) + rrule (recurrence) + pino. Исходники под `src/scheduler/`, запускается собранный `dist/scheduler/*.js` (`pnpm build`).

| Файл | Назначение |
|---|---|
| [`src/scheduler/routines.ts`](../src/scheduler/routines.ts) | **Диспетчер каталога routine'ов** (`node dist/scheduler/routines.js <name>`): compile / digest / lint / research / resurface. Спавн движка — через [`src/bridge/engine.ts`](../bridge/README.md) (дефолт `ClaudeEngine`), не дублируя `claude -p`. |
| [`routines/`](routines/README.md) | [КАТАЛОГ ROUTINES](routines/README.md) (расписания, контракты, слои) + plist-шаблоны `ru.secondbrain.{compile,lint,research,resurface}.plist`. |
| [`src/scheduler/digest.ts`](../src/scheduler/digest.ts) | routine `digest`: предчек «что due» → спавн движка (`claude -p`) → push в Telegram (через [`src/bridge/telegram.ts`](../bridge/README.md)). Last-mile sanitizer-guard. |
| [`src/scheduler/reminders.ts`](../src/scheduler/reminders.ts) | Детерминированный парсер `reminders.md` + движок «что due» (чистый TS, без движка/сети — unit-testable). Дни рождения из вики. Лесенка Leitner для idea-resurfacing. |
| [`reminders_spec.md`](reminders_spec.md) | Спецификация формата `reminders.md` (поля, kinds, recurrence, lifecycle). Контракт движок ⇄ sweep. |
| [`src/scheduler/lint-public.ts`](../src/scheduler/lint-public.ts) | Guard публичного репо: `exit 1`, если найдены секреты/реальные PII. Импортит `scanSecrets` из [`src/ingest/sanitizer.ts`](../src/ingest/sanitizer.ts). Для pre-commit/CI и routine `lint`. |
| [`run_routine.sh`](run_routine.sh) | Generic-обёртка для launchd: грузит `.env`, `caffeinate` на время запуска, зовёт `node dist/scheduler/routines.js <ROUTINE>`. |
| [`run_sweep.sh`](run_sweep.sh) | Обёртка специально под routine `digest` (исторический алиас `run_routine.sh digest`): грузит `.env`, `caffeinate`, `node dist/scheduler/digest.js`. |
| [`ru.secondbrain.digest.plist`](ru.secondbrain.digest.plist) | LaunchAgent routine `digest`: 30-мин `StartInterval` + утренний `StartCalendarInterval` 08:00 + `RunAtLoad`. Шаблон с `__PUBLIC_REPO__`. |

## Как это работает (routine `digest` — sweep)

```
launchd (LaunchAgent)  ИЛИ  remote Claude routine
   │  каждые 30 мин + 08:00 + при load/wake
   ▼
run_routine.sh digest  ──грузит .env, caffeinate──►  node dist/scheduler/digest.js
   (или run_sweep.sh)                                       │
   1. ПРЕДЧЕК (чистый TS, БЕЗ движка):                       │
      reminders.collectDueItems()  ◄──────────── reminders.md + wiki/ (дни рождения)
      ничего не due → ВЫХОД (не жжём Agent-SDK-кредит Claude, ADR-0009)
                                                            │ есть due
   2. СПАВН ДВИЖКА (stateless, sessionId=null):              ▼
      bridge/engine → ClaudeEngine.run(sweepPrompt) ──► claude -p --output-format json
      движок: читает reminders+wiki, составляет дайджест, обновляет сработавшие записи
                                                            │
   3. LAST-MILE GUARD: assertNoSecrets(digest)               │  (scanSecrets из src/ingest/sanitizer.ts)
                                                            ▼
   4. PUSH: bridge/telegram.sendMessage(digest) ──► Telegram владельцу (Bot API)
```

Ключевой принцип ([ADR-0007 §2](../docs/adr/0007-engine-spawn-and-scheduler.md)):
**идемпотентный sweep, а не таймер-на-напоминание.** launchd при пробуждении из
сна запускает пропущенную задачу (cron — скипает) и *коалесцирует* несколько
пропущенных интервалов в одно событие. Поэтому один запуск читает ВСЕ due-элементы
и составляет ОДИН дайджест; дедуп от коалесцированного двойного запуска — в коде
(`status`/`last_fired`, см. [`src/scheduler/reminders.ts`](../src/scheduler/reminders.ts) `alreadyFiredToday`).

> Остальные routine'ы (`compile`/`lint`/`research`/`resurface`) идут тем же
> паттерном через [`src/scheduler/routines.ts`](../src/scheduler/routines.ts): спавн `claude -p` через
> `bridge/engine` (+ опц. owner-push через тот же last-mile guard). Их триггеры,
> расписания и промпт-контракты — в [КАТАЛОГЕ ROUTINES](routines/README.md).

## Как вычисляется «due»

Полностью детерминированно в [`src/scheduler/reminders.ts`](../src/scheduler/reminders.ts) (см.
[`reminders_spec.md`](reminders_spec.md) — раздел «Как вычисляется due»). Кратко:
элемент в дайджест «сегодня», если он живой (`pending`/`snoozed`), `due_at <= now +
grace` (5 мин) и не стрелял сегодня. В пределах `lookahead` (7 дн) — попадает в
секцию «скоро» (превью, без пометки `last_fired`). Recurring без явного `due_at`
выводится из `rrule` (`rrulestr` из пакета `rrule`, tz-aware время — через luxon). Дни рождения —
из frontmatter person-страниц вики, не дублируются в `reminders.md`.

Это «дешёвый anything-due-предчек перед спавном движка» из research: гонять
`claude -p` вхолостую на каждом 30-мин тике расточительно для месячного
Agent-SDK-кредита Claude ([ADR-0009](../docs/adr/0009-tos-safe-engine-access.md)).

## Зависимости и контракты

- **`scanSecrets(text) -> string[]`** (из [`src/ingest/sanitizer.ts`](../src/ingest/sanitizer.ts)) — общий детектор секретов.
  `digest.ts`/`routines.ts` зовут его (через `assertNoSecrets` в [`src/scheduler/runner.ts`](../src/scheduler/runner.ts)) как last-mile guard перед push; `lint-public.ts`
  — как основу guard'а публичного репо. **Не переопределяем** (один sanitizer на
  write-path — инвариант [CONTEXT §3](../CONTEXT.md)).
- **`bridge/engine`** — движок за портируемой абстракцией `Engine`
  (`run(prompt, sessionId|null) -> EngineResult`), дефолт **`ClaudeEngine`**
  (официальный `claude -p`, [ADR-0008](../docs/adr/0008-engine-claude-native.md)).
  Scheduler спавнит его через [`src/scheduler/runner.ts`](../src/scheduler/runner.ts) (`spawnEngine`), который
  строит движок фабрикой `buildEngineFromEnv()` (выбор по env `ENGINE`: `ClaudeEngine`
  по умолчанию, `GrokEngine`/`CodexEngine` — отложенные слоты) и нормализует
  `EngineResult` в `(answer, sessionId, usage)`. Так scheduler не хардкодит движок —
  его выбирает конфиг моста.
- **`bridge/telegram`** — клиент Bot API с `sendMessage(text, {
  disableNotification })`. Токен/`OWNER_CHAT_ID` — из приватного `.env`.
- **`rrule`** + **`luxon`** — внешние hard-зависимости (`rrulestr` для recurrence,
  `DateTime` для tz-aware времени). YAML-блоки `reminders.md` парсим вручную (формат
  плоский). Полный список зависимостей — в [`package.json`](../package.json) корня репо;
  установка — `pnpm install` (см. [setup/SETUP.md](../setup/SETUP.md)).

> `bridge/*` импортируются **лениво** внутри функций `digest.ts`/`runner.ts` — чтобы прогон
> логики `reminders.ts`/`lint-public.ts` не падал, пока мост ещё устанавливается.

## Запуск вручную

```bash
# из корня публичного репо; сначала сборка: pnpm build  (запускаем скомпилированный dist/)

# каталог routine'ов (что вообще можно запустить):
node dist/scheduler/routines.js --list

# любая routine через диспетчер (--dry-run = собрать промпт, не звать движок):
node dist/scheduler/routines.js compile --dry-run
node dist/scheduler/routines.js research --dry-run
node dist/scheduler/routines.js lint            # PII-скан публичного репо + аудит вики

# routine digest напрямую (эквивалент `routines digest`):
node dist/scheduler/digest.js --print-due       # только показать due-список (предчек)
node dist/scheduler/digest.js --dry-run         # собрать sweep-промпт, не звать движок
node dist/scheduler/digest.js                   # боевой sweep (нужен claude + Telegram-токен в .env)

# линт публичного репо (CI/pre-commit) — отдельно от routine lint:
node dist/scheduler/lint-public.js              # (или pnpm lint:public)
node dist/scheduler/lint-public.js --files path/to/changed.md  # только staged-файлы
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
  / [`run_sweep.sh`](run_sweep.sh) оборачивают запуск (`node dist/scheduler/*.js`) в
  `caffeinate -s` на время выполнения и отпускают сразу. Permanent `caffeinate`
  посадит батарею MacBook — не делаем.
- **Опциональное усиление (ручной opt-in, в SETUP.md, НЕ автоматизируем):**
  `sudo pmset repeat wakeorpoweron MTWRFSU 07:55:00` — Mac просыпается ~5 мин до
  утреннего 08:00-дайджеста. `pmset` допускает только ОДНУ repeat-схему и требует
  sudo; конфликтует с другими power-схемами — поэтому ручной opt-in, не часть кода.

## Безопасность исходящего

- **Last-mile guard.** Перед push `digest.ts`/`routines.ts` гоняют `scanSecrets`
  (через `assertNoSecrets`) по исходящему тексту и **отменяют отправку**, если найден
  секрет — даже в личный чат владельца (токен/ключ в сообщении ≈ случайная утечка
  из вики/лога).
- **Движок без egress-инструмента.** Telegram-вызов делает ЭТОТ слой после выхода
  `claude -p`, а не сам движок — движок остаётся side-effect-free и портируемым.
  Единственный исходящий канал — узкий owner-only push. Это минимизация blast
  radius для lethal-trifecta (приватные данные + недоверенный ингест + внешняя
  коммуникация); 100%-защиты от prompt-injection нет
  ([ADR-0007 §risks](../docs/adr/0007-engine-spawn-and-scheduler.md),
  [ADR-0009](../docs/adr/0009-tos-safe-engine-access.md),
  [privacy-security.md](../docs/research/privacy-security.md)).

## `lint-public.ts` в pre-commit / CI

Guard границы двух репо ([ADR-0003](../docs/adr/0003-two-repos-public-private.md)).
Пример pre-commit-хука (`.git/hooks/pre-commit` или `.pre-commit-config.yaml`) —
запускает уже собранный `dist/` (`pnpm build`):

```bash
#!/usr/bin/env bash
# проверяем только staged-файлы — быстро
staged=$(git diff --cached --name-only --diff-filter=ACM)
[ -z "$staged" ] && exit 0
node dist/scheduler/lint-public.js --files $staged
```

В CI — гонять по всему дереву (`node dist/scheduler/lint-public.js --root .`, или
`pnpm lint:public`) плюс отдельный gitleaks-job (полная история) — research:
«pre-commit одного мало, нужен CI».
Линт уважает синтетические маркеры (`synthetic-example`, «Пример», `example.com`,
fake-токен `123456:AA…`) и освобождает [`wiki-example/`](../wiki-example/) +
`.env.example` от PII-паттерн-проверки (но не от `scanSecrets` — настоящий секрет
недопустим даже там).

## Связанные

- [routines/README.md](routines/README.md) · [src/scheduler/routines.ts](../src/scheduler/routines.ts) · [run_routine.sh](run_routine.sh) · [reminders_spec.md](reminders_spec.md) · [src/scheduler/reminders.ts](../src/scheduler/reminders.ts) · [src/scheduler/digest.ts](../src/scheduler/digest.ts) · [src/scheduler/lint-public.ts](../src/scheduler/lint-public.ts)
- [../docs/research/proactive-scheduling.md](../docs/research/proactive-scheduling.md) · [../docs/adr/0007-engine-spawn-and-scheduler.md](../docs/adr/0007-engine-spawn-and-scheduler.md) · [../docs/adr/0008-engine-claude-native.md](../docs/adr/0008-engine-claude-native.md) · [../docs/adr/0009-tos-safe-engine-access.md](../docs/adr/0009-tos-safe-engine-access.md)
- [../bridge/README.md](../bridge/README.md) · [../setup/SETUP.md](../setup/SETUP.md)
