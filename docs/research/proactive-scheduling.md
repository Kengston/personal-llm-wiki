---
title: Проактив и планирование
type: audit
status: verified
last_updated: 2026-05-31
sources:
  - https://www.manpagez.com/man/5/launchd.plist/
  - https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html
  - https://dateutil.readthedocs.io/en/stable/rrule.html
---

# Проактив и планирование

> Направление: проактивные напоминания и планирование на macOS (v1). Обосновывает проактивную часть [ADR-0004](../adr/0004-telegram-bridge-reactive-proactive.md) и оговорку [ADR-0005](../adr/0005-host-v1-macbook-portable.md); формат reminders и sweep-планировщик фиксируются в [ADR-0007](../adr/0007-engine-spawn-and-scheduler.md).

## Вывод

Правильный планировщик — **launchd (LaunchAgent), не cron**: при сне через запланированное время задача launchd `StartCalendarInterval`/`StartInterval` срабатывает один раз вскоре после пробуждения, а cron молча скипает слот до следующего дня. launchd **коалесцирует** несколько пропущенных интервалов в одно событие при пробуждении — что здесь идеально, потому что запланированная задача должна НЕ пушить N напоминаний, а запускать один идемпотентный «sweep», читающий все due-элементы из reminders-файла + вики, составляющий один Telegram-digest и помечающий элементы done (watermark). Это делает коалесцирование на пробуждении фичей, а не багом, и совпадает с ADR-0005 (v1 работает только когда MacBook бодрствует).

## Ключевые находки

### launchd, не cron
man-страница `launchd.plist`: для `StartInterval` и `StartCalendarInterval` — «если система спит, задача будет запущена при следующем пробуждении компьютера». Вторичные источники подтверждают: cron «пожимает плечами и скипает» задачу, запланированную во сне. cron на macOS поддерживается, но deprecated в пользу launchd. (high)

### launchd КОАЛЕСЦИРУЕТ пропущенные интервалы
man-`launchd.plist`, дословно: «если несколько интервалов прошли до пробуждения компьютера, эти события будут коалесцированы в одно событие при пробуждении». Заявлено для обоих `StartInterval` и `StartCalendarInterval`. Делает идемпотентный «sweep all due → один digest»-дизайн верным, а не «один launch на напоминание». (high)

### launchd различает сон и выключение
Пропущенный `StartCalendarInterval` запускается после ПРОБУЖДЕНИЯ, но слот, пропущенный при полностью ВЫКЛЮЧЕННОМ Mac, НЕ запускается на следующей загрузке (без `RunAtLoad`). v1-catch-up покрывает сон, не выключение. Совпадает с оговоркой ADR-0005 «только когда MacBook бодрствует». (high)

### LaunchAgent — верный scope для v1
LaunchAgent (в `~/Library/LaunchAgents`, в GUI-сессии юзера) — верно для v1: работает как залогиненный юзер, дотягивается до сети и keychain/codex-login, не нужен sudo. LaunchDaemon (root, `/Library/LaunchDaemons`) — для будущего always-on/headless-хоста (24/7-доступность, работа при заблокированном экране — фаза Mac Mini). Современная регистрация — `launchctl bootstrap gui/$(id -u) <plist>`; `launchctl load` — legacy. (high)

### Запуск движка как в реактивном мосте
launchd спавнит wrapper, запускающий `codex exec` (подписка, ADR-0001) с «reminder-sweep»-промптом; Codex читает due-элементы, составляет digest, wrapper (или Codex через tool) POST'ит в Telegram `sendMessage`. Telegram-пуш — однострочный HTTP-вызов с bot-token + chat_id: `curl -s -X POST https://api.telegram.org/bot<TOKEN>/sendMessage -d chat_id=<ID> -d text='...'` (поддерживает `parse_mode=Markdown`, `disable_notification`). Webhook не нужен для исходящих. (high)

### «Машина спит» — не бороться
v1 полагается на catch-up-on-wake + утренний digest. Опциональные митигации: `caffeinate -s` (предотвращает system-sleep, даёт display-sleep, держит сеть) вокруг рабочих часов, и `pmset repeat wakeorpoweron <DAYS> HH:MM:SS` для пробуждения под фиксированный daily-digest. `pmset`: только ОДНА repeat-схема, нужен sudo; парить с launchd-job сразу после wake-времени. (high)

### NL-парсинг — лучше движком на capture-time
Codex нормализует в ISO `due_at` + опц. iCal `RRULE` на capture-time (у него уже контекст сообщения). Детерминированный fallback/валидатор — `python-dateutil` `rrule`/`rrulestr` (надмножество iCalendar RRULE, парсит/эмитит RFC-строки) + `dateparser` (парсит локализованные относительные даты «in 3 days», вкл. русский). Держит NL-поверхность гибкой при детерминированной calendar-compatible-записи. (high)

### kvh/recurrent — опционально
Конвертит NL-recurring-фразы («every year on Dec 25», «every other friday for 5 times») прямо в iCal DTSTART/RRULE для dateutil — привлекательно, но фактически unmaintained (нет недавних релизов) и зависит от parsedatetime; держать ОПЦИОНАЛЬНО и пинить версию, или скипнуть в пользу Codex-side-парсинга + dateutil. Maintained-зависимость — bear/parsedatetime (Python 3.9-tested), не старый форк kvh. (medium)

### Idea-resurfacing — лесенка SM-2/Leitner
Хранить box/interval-поля на записи reminder. Рекомендуемая фиксированная лесенка для LLM-wiki: 1 → 3 → 7 → 16 → 35 дней (или Leitner 1/2/4/7/14); полный SM-2 с ease-factor (дефолт 2.5) — несколько строк, если позже нужно адаптивное spacing. «Вся scheduling-логика — в нескольких строках кода». (high)

### v1 = автономный reminders-файл, не CalDAV
CONTEXT OQ-3 явно: «Календарь ... vs автономный reminders-файл — стартуем с автономного». Поскольку recurrence хранится как iCal RRULE, поздний one-way-экспорт в `.ics` (или CalDAV PUT / Google Calendar API insert) — чистый add-on без переделки формата. dateutil/recurrent эмитят стандартный iCal RRULE — тот же грамматик, что потребляют `.ics`/CalDAV/Google Calendar, так что автономный файл calendar-ready by construction. (high)

## Рекомендации

- **v1-планировщик = launchd LaunchAgent с идемпотентным SWEEP**, не per-reminder-таймеры. Один plist `com.secondbrain.reminders.plist` в `~/Library/LaunchAgents` с ОБОИМИ: `StartInterval` (напр. 1800с = каждые 30 мин, чтобы пробуждение у due-времени триггерило) И запись `StartCalendarInterval` для фиксированного утреннего digest (напр. Hour 9, Minute 0). `RunAtLoad=true`, чтобы стрелял и на login/load (покрывает post-boot-gap, который wake-catch-up не покрывает). plist запускает wrapper-скрипт (`ProgramArguments`), вызывающий движок.
- **Wrapper `scheduler/run_sweep.sh`:** подгрузить `.env` из приватного репо, затем `caffeinate -s codex exec --json <reminder-sweep-prompt>`. Sweep-промпт говорит Codex: прочитать reminders-файл + сканировать вику на due-дни-рождения/годовщины, взять всё с `due_at <= now` (+ небольшое grace-окно), составить ОДИН Telegram-digest, push через Bot API, потом обновить каждый сработавший reminder (set `last_fired`, продвинуть recurrence/spaced-rep-интервал, или mark done). Держать вызов движка за тем же портируемым spawn-абстракцией, что реактивный мост (ADR-0001).
- **Push = Telegram `sendMessage`.** Либо Codex вызывает как tool, либо wrapper после того, как Codex записал digest-файл. Минимум: `curl -s -X POST https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage -d chat_id=$TELEGRAM_CHAT_ID --data-urlencode text="$DIGEST" -d parse_mode=Markdown`. Token + chat_id в `.env` (gitignored); никогда в публичном репо. `disable_notification` для low-priority-idea-resurfacing.
- **Формат reminders (v1, в `llm-wiki-content/reminders/`):** один файл `reminders/reminders.md` как append-only-список YAML-frontmatter-блоков (один блок на reminder), с опц. per-reminder-файлами `reminders/<id>.md`, если заметка растёт. Поля: `id` (slug+date), `title`, `kind` (oneoff|recurring|spaced), `due_at` (ISO 8601 с таймзоной), `rrule` (iCal RRULE, опц., для recurring), `nl_source` (исходный «remind me ...»-текст, для аудита), `status` (pending|done|snoozed), `last_fired` (ISO), `created` (ISO), для spaced: `box`/`interval_days`/`ease`. Зеркалить house style abcage-wiki: ISO `YYYY-MM-DD(THH:MM)` (без относительных дат), `<!-- keep -->`-маркеры, `index.md`-каталог + `reminders/log.md` append-only-журнал («## [YYYY-MM-DD] fired | <ids> | <digest summary>»).
- **NL-парсинг split:** Codex нормализует NL→запись на capture-time (пишет `due_at` + `rrule` + хранит `nl_source` дословно). Добавить маленький детерминированный python-хелпер `scheduler/parse.py` на `python-dateutil` (`rrulestr`/`rrule` для recurrence-математики, `str(rrule)` для эмита iCal) + `dateparser` (для «in 3 days», поддерживает ru). `kvh/recurrent` — ОПЦИОНАЛЬНО (пинить версию; stale/parsedatetime), не на критическом пути. Sweep считает «next due» из rrule детерминированно; не ре-парсит NL на каждом тике.
- **Recurring-примеры из коробки:** «every year on May 31» → `FREQ=YEARLY;BYMONTH=5;BYMONTHDAY=31` (дни рождения/годовщины; их можно выводить прямо из birthday-поля person-страниц вики, так что sweep сканирует и вику, не только reminders-файл). «remind me in 3 days» → `kind=oneoff`, `due_at=now+3d`. «every Monday 9:00» → `FREQ=WEEKLY;BYDAY=MO` + DTSTART-время. После срабатывания recurring — продвинуть `due_at` к следующему rrule-occurrence; one-off → `status=done`.
- **Idea-resurfacing = `kind=spaced`** с фиксированной Leitner-лесенкой `interval_days` в `[1,3,7,16,35]`. На каждом surfacing юзер реагирует в Telegram (напр. «still relevant» продвигает box, «drop» → `status=done`). Несколько строк сейчас; полный SM-2 ease-factor — только если адаптивное spacing понадобится.
- **Sleep-policy для v1 (в `setup/SETUP.md` как человеческие шаги, не автоматизировать установки):** принять catch-up-on-wake как основное; `StartInterval` 30 мин + утренний `StartCalendarInterval` + `RunAtLoad` покрывают большинство. ОПЦИОНАЛЬНОЕ усиление: (a) `sudo pmset repeat wakeorpoweron MTWRFSU 08:55:00` (Mac просыпается ~5 мин до 09:00-digest); (b) `caffeinate -s` только вокруг sweep, не 24/7 (батарея). Явно note ОГРАНИЧЕНИЕ: слот, пропущенный при полностью ВЫКЛЮЧЕННОМ Mac, не отыграется (ловится только сон) — настоящий always-on — фаза Mac Mini/LaunchDaemon (ADR-0005, OQ-4).
- **Calendar-sync остаётся ОТЛОЖЕННЫМ (OQ-3),** но формат calendar-ready: поскольку recurrence — iCal RRULE, поздний `scheduler/export_ics.py` эмитит read-only `.ics` (один VEVENT на reminder, RRULE дословно) для подписки в Apple/Google Calendar — lowest-friction-interop. Two-way CalDAV/Google Calendar API — отдельный ADR.
- **Написать файлы (фреймворк-репо, реальный код + доки, без stubs):** `scheduler/com.secondbrain.reminders.plist` (шаблон с `__PLACEHOLDERS__`), `scheduler/run_sweep.sh` (env-load + caffeinate + codex exec + push), `scheduler/parse.py` (dateutil/dateparser-хелперы + крошечная spaced-rep-лесенка, unit-testable pure-функции), СИНТЕТИЧЕСКИЙ пример reminders под `wiki-example/` (fake-имена «Иван Пример», fake-даты), человеческие setup-шаги в `setup/SETUP.md` (`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.secondbrain.reminders.plist`; опц. pmset/caffeinate). [ADR-0007](../adr/0007-engine-spawn-and-scheduler.md) фиксирует решение.

## Подводные камни

- НЕ моделировать «один launchd-job на напоминание» и не полагаться на launchd replay'ить каждый пропущенный слот — он коалесцирует в одно wake-событие. Единственный надёжный дизайн — частый идемпотентный sweep, читающий ВСЕ due-элементы и safe-to-run-twice (использовать `status`/`last_fired` для дедупа, чтобы коалесцированный double-fire не задвоил пуш).
- launchd ловит сон, но НЕ полное выключение (off-at-scheduled-time-задачи не отыгрываются на загрузке без `RunAtLoad`). Не обещать 24/7-проактив на MacBook; это ровно оговорка ADR-0005. `RunAtLoad` помогает login-after-boot, но не восстановит digest, чьё время прошло при выключенной машине.
- Per-user LaunchAgent работает, только пока юзер залогинен в GUI; LaunchDaemon (root) не имеет `codex login`/keychain юзера и может не дотянуться до сети так же — держать v1 как LaunchAgent, отложить LaunchDaemon на always-on-хост.
- `pmset repeat` допускает только ОДНУ repeating-wake-схему и нужен sudo; ставить из cron/launchd неуклюже. Держать как ручной опциональный opt-in (одно daily-пробуждение под утренний digest), предупредить о конфликте с другими power-схемами.
- `kvh/recurrent` фактически unmaintained и тянет parsedatetime; делать hard-зависимостью рискует Python-3/packaging-поломкой. Держать NL→RRULE на стороне Codex + maintained `python-dateutil` + `dateparser`; если recurrent вообще используется — пинить точную версию и изолировать.
- Никогда не персистить относительные/NL-даты («in 3 days») как source-of-truth — хранить разрешённый ISO `due_at` + rrule, исходную фразу только как `nl_source` для аудита. Иначе ре-оценка файла позже молча сдвинет каждую due-дату. Матчит «ISO only»-правило abcage-wiki.
- Корректность таймзон: хранить `due_at` С явным offset/таймзоной, sweep сравнивает в той же tz; DST-сдвиги и «every year on May 31»/birthday-at-midnight-edge-кейсы мисфайрят при naive-local-времени. python-dateutil справляется, только если кормить tz-aware-datetime.
- Держать reminders-файл и Bot-token в ПРИВАТНОМ репо / `.env` соответственно; публичный фреймворк-репо — только синтетический labelled-пример reminders (fake-имена/даты), sanitizer в write-path, чтобы реальный birthday/phone не утёк в git (ADR-0003).
- `caffeinate` 24/7 высадит батарею MacBook и побьёт «fine for v1»-позицию; скоупить на длительность sweep (`caffeinate <command>`) или явные рабочие часы, не permanent-демон.

## Открытые вопросы

- Дни рождения/годовщины — структурные поля на person-страницах вики (sweep выводит «every year on» динамически) ИЛИ явные recurring-записи в reminders-файле? Рекомендация: выводить из person-страниц (single source of truth, без дублирования), sweep генерит yearly-reminder — но нужно решение по схеме person-страницы.
- Как юзер ДЕЙСТВУЕТ на проактивный пинг из Telegram (snooze / done / advance spaced-rep box)? Связывает проактивный планировщик с inbound-обработкой реактивного моста; нужна маленькая command-грамматика («/done <id>», «snooze 2d») или free-text, интерпретируемый движком.
- Точная cadence sweep vs батарея/квота: 30-мин `StartInterval` = до ~48 `codex exec`-запусков/день даже когда ничего не due — приемлемо под flat ChatGPT-подпиской (ADR-0001), но стоит дешёвого «anything due?»-предчека (plain Python, без вызова движка) перед спавном Codex, чтобы экономить rate-limits.
- Когда выпускаться из автономного файла в настоящий calendar-sync и какой target (read-only `.ics`-подписка vs two-way CalDAV vs Google Calendar API) — отложить до будущего ADR, когда формат поживёт; iCal-RRULE-native-формат держит все три открытыми.

## Связанные

- [README.md](README.md) · [../adr/0004-telegram-bridge-reactive-proactive.md](../adr/0004-telegram-bridge-reactive-proactive.md) · [../adr/0005-host-v1-macbook-portable.md](../adr/0005-host-v1-macbook-portable.md) · [../adr/0007-engine-spawn-and-scheduler.md](../adr/0007-engine-spawn-and-scheduler.md) · [engine-runtime.md](engine-runtime.md)
