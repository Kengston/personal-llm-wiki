# Schema: «Второй мозг» — персональная LLM-wiki

Этот репозиторий — **фреймворк персональной LLM-wiki, построенной по паттерну [LLM Wiki](https://github.com/) (Andrej Karpathy) + Memex (Vannevar Bush)**: LLM-агент **инкрементально ведёт** persistent markdown-вики обо мне, а не re-retrieve'ит знание из чанков на каждый запрос. **Без векторной базы, без embedder** ([ADR-0002](docs/adr/0002-no-embedder-pure-karpathy.md)). Эта схема — конфиг, который делает агента (**движок** = Claude Code, официальный бинарь `claude`, [ADR-0008](docs/adr/0008-engine-claude-native.md)/[ADR-0009](docs/adr/0009-tos-safe-engine-access.md)) дисциплинированным хранителем вики.

> **Этот файл — каноническая схема движка, читается первым.** Он описывает структуру репозиториев и базовые workflow (ingest / query / capture / lint / proactive). Детальный контракт правки страниц — в [compiler/rules.md](compiler/rules.md): анатомия каждого типа страницы (контент-модель [ADR-0010](docs/adr/0010-wiki-content-model.md)), правило сжатия код-сессий в accomplishment-записи, как экспорт LLM-чата и заметка из Telegram становятся правками вики, как извлекаются reminders, обязанности sanitizer, правила writeback. **Перед любой правкой вики прочитай оба файла.** `Claude Code` читает `CLAUDE.md` → он указывает сюда; параллельный `AGENTS.md` держим для портируемости на отложенные движки ([ADR-0008](docs/adr/0008-engine-claude-native.md): `GrokEngine`/`CodexEngine` — слоты).

## Что это за репозиторий (важно не перепутать)

Проект — **два git-репозитория с жёсткой границей** «код ≠ данные» ([ADR-0003](docs/adr/0003-two-repos-public-private.md)):

- **Этот репо — `personal-llm-wiki` (ПУБЛИЧНЫЙ, портфолио).** Только **фреймворк**: правила (`compiler/`), код моста (`bridge/`), ингест (`ingest/`), планировщик (`scheduler/`), концепт-доки (`docs/`), **синтетический обезличенный пример** вики (`wiki-example/`), README/SETUP. **Ни одного** личного факта, токена, имени-контакта, телефона, message-id. Любой пример — синтетический и помеченный (имена вида «Иван Пример», фейковые даты/id).
- **Личные данные живут в другом репо — `llm-wiki-content` (ПРИВАТНЫЙ).** Там `raw/` (immutable обезличенные снапшоты источников — в т.ч. экспорты LLM-чатов), `wiki/` (страницы обо мне), `reminders/`. Секреты — только в `.env` (gitignored). **Этот** AGENTS.md в публичном репо НЕ работает над личными данными; в приватном репо лежит свой `CLAUDE.md`/`AGENTS.md`, указывающий движок на `raw/ + wiki/ + reminders/`.

Когда движок ведёт **личную** вики — он работает в `llm-wiki-content/` по правилам [compiler/rules.md](compiler/rules.md). Когда движок (или человек) трогает **этот** репо — он строит/чинит фреймворк, и сюда **никогда** не попадают личные данные (страж — [scheduler/lint_public.py](scheduler/), импортирует `ingest.sanitizer.scan_secrets`).

## Движок: Claude Code (официальный бинарь), $0 сверх Max

Движок, ведущий вики, — **Claude Code в headless-режиме** (`claude -p "<prompt>" --output-format json`), под уже оплаченной подпиской **Claude Max**, не per-token-API-ключом ([ADR-0008](docs/adr/0008-engine-claude-native.md)). Один движок закрывает **все три роли**: интерактивный мозг (Telegram-реактив), «руки» (web/computer-агент через MCP — динамические сайты, research), компилятор вики (плановые правки десятков md-файлов). С учётом Agent-SDK-кредита ([ADR-0009](docs/adr/0009-tos-safe-engine-access.md), с 15.06.2026) это **$0 сверх Max** на персональном масштабе.

**ToS-безопасность — жёсткое правило ([ADR-0009](docs/adr/0009-tos-safe-engine-access.md)):**
- Движок вызывается **только официальным бинарём** `claude` под аккаунтом владельца. Это явно разрешённый Consumer Terms режим («ordinary individual use»).
- **НИКОГДА** не скрейпить/реюзать OAuth-токен Claude в свой/сторонний HTTP-клиент — это ровно паттерн **OpenClaw**, который Anthropic банит. Для Claude OpenClaw запрещён.
- **Single-user:** мост **жёстко allow-листит** собственный Telegram `chat_id` владельца и **дропает всё остальное**. Мультиюзер = нарушение account-sharing.
- **Human-in-the-loop / умеренные расписания**, не 24/7 always-on на локальной машине (триггерит недельные лимиты). 24/7-проактив — через remote Claude routines (см. ниже), не через бесконечный локальный демон.

**Портируемость моста ([ADR-0008](docs/adr/0008-engine-claude-native.md)).** Весь мост знает движок только через абстракцию `Engine` (`bridge/engine.py`); дефолт — `ClaudeEngine`. **`GrokEngine`** и **`CodexEngine`** — готовые **отложенные адаптеры-слоты** (опционально, добавляются конфигом без переписывания):
- `CodexEngine` — `codex exec` (бывший primary [ADR-0001](docs/adr/0001-engine-subscription-codex.md), теперь DEFERRED-портативный адаптер).
- `GrokEngine` — backend'ы: **grok-build-cli** (`grok -p --output-format json`) и **openclaw**. ⚠ OpenClaw допустим **только** на Grok-стороне (xAI-санкционирован), **никогда** на Claude ([ADR-0009](docs/adr/0009-tos-safe-engine-access.md)). Grok — опциональный отложенный **advisor-голос** (A/B жизненных советов), не closed capability-gap.

## Структура публичного репо

```
personal-llm-wiki/
├── CLAUDE.md             # тонкое зеркало для Claude Code: «читай AGENTS.md» — движок видит его первым
├── AGENTS.md             # эта каноническая схема (движок, структура, конвенции, workflows)
├── CONTEXT.md            # живой контекст: что строим, инварианты, §6 открытые вопросы (НЕ перезаписывать)
├── README.md             # портфолио-навигация (English-primary + короткое RU-интро)
├── compiler/
│   └── rules.md          # детальный контракт хранителя вики (контент-модель ADR-0010, code→accomplishment, capture→правки, reminders, sanitizer, writeback)
├── bridge/               # Telegram ↔ движок: FastAPI webhook + HMAC + restrict-to-owner, SQLite chat→session, Engine-runner (дефолт ClaudeEngine), Bot API client
├── ingest/               # sanitizer.py (общий маскер PII/секретов), telegram_export.py, llm_chat-коннектор (экспорты ChatGPT/Claude/Grok), watermark.py, коннектор-СТАБЫ (vk/whatsapp/youtube/x/codebase)
├── scheduler/            # плановое (routine/launchd): reminders+digest → Telegram, lint_public.py (страж PII в этом репо), launchd-плисты
├── wiki-example/         # СИНТЕТИЧЕСКИЙ пример личной вики (index, log, people/ideas/concepts/growth/projects/journal/reminders) — всё фейк и помечено
├── setup/SETUP.md        # ручной runbook активации (claude/gh install, login, бот, tunnel, launchd/routines, первый E2E)
└── docs/
    ├── adr/              # пронумерованные ADR (0001 SUPERSEDED Codex; 0008–0010 — Claude-native/ToS/контент-модель; не переписывать, можно ДОБАВЛЯТЬ 0011+)
    ├── architecture/     # architecture.md (mermaid, data-flow, три слоя исполнения, ремап Pachca→Telegram, threat-model/privacy)
    └── research/         # research-доклад (7 направлений) — обоснование решений
```

## Структура приватного репо (`llm-wiki-content`, отдельно — личные данные)

```
llm-wiki-content/
├── CLAUDE.md             # персональный конфиг движка: указывает на raw/ + wiki/ + reminders/ этого репо
├── .env                  # секреты (gitignored): TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_CHAT_ID, WEBHOOK_SECRET, …
├── raw/                  # immutable обезличенные снапшоты источников (md + provenance-frontmatter) + полные технич. детали код-сессий
├── wiki/                 # страницы обо мне — то, что ведёт движок (index.md + ideas/concepts/growth/people/projects/journal + capability-profile.md + profile.md)
├── reminders/            # reminders.md (append-only YAML-блоки) + README (формат) + синтетический пример
└── log.md                # append-only журнал операций над личной вики
```

> **Карта типов страниц личной вики** (контент-модель [ADR-0010](docs/adr/0010-wiki-content-model.md), детали — [compiler/rules.md §3](compiler/rules.md)). Сердце вики — **концепции, развитие, идеи** про владельца; техническое сильное, но **сжатое и вторичное**:
> - `wiki/ideas/` — идеи/замыслы/«вернуться подумать» (spaced-возврат);
> - `wiki/concepts/` — концепции и ментальные модели, которые я усвоил/выработал;
> - `wiki/growth/` — развитие: маркеры, цели, привычки, вехи (бывш. `goals`);
> - `wiki/people/` — люди;
> - `wiki/projects/` — **accomplishment-записи** («что предметно построил», не код verbatim);
> - `wiki/capability-profile.md` — деривативный профиль «на что я способен» (агрегат из `projects/`);
> - `wiki/journal/YYYY-MM-DD.md` — дневниковые заметки по дням;
> - плюс корневой `wiki/index.md` (каталог) и `wiki/profile.md` (я: предпочтения, факты).
>
> Полные технические детали код-сессий остаются в `raw/` (sources); в `wiki/` идёт **выжимка** ([ADR-0010](docs/adr/0010-wiki-content-model.md), правило сжатия — [compiler/rules.md §3.5–§3.6](compiler/rules.md)). Эфемерное («встреча завтра в 15:00») в вики **не пишем** — оно идёт в `reminders/` ([CONTEXT §2](CONTEXT.md), [ADR-0007](docs/adr/0007-engine-spawn-and-scheduler.md)).

## Conventions (house style — соблюдать на каждой странице)

Наследуют корпоративный `abcage-wiki` (тот же автор), адаптированы под личный контекст.

- **Frontmatter** на каждой странице вики: `title`, `type` (`idea|concept|growth|person|project|capability-profile|journal|profile|index`), `status` (`draft|active|verified|stale|superseded|archived`), `last_updated` (ISO `YYYY-MM-DD`), при наличии `sources:` (список путей в `raw/` или внешних ref). Для страниц с фактами — массив `claims:` (анатомия — [compiler/rules.md §4](compiler/rules.md)).
- **Ссылки — markdown relative** (`[текст](../people/ivan-primer.md)`), **не** `[[wikilinks]]` — для совместимости с инструментами и чтобы движок парсил их штатно. Каждая содержательная страница заканчивается секцией `## Связанные` с исходящими ссылками. (Почему не wikilinks — [research/memory-architecture.md](docs/research/memory-architecture.md): это нужда Obsidian-вьюера, не движка.)
- **Даты — ISO `YYYY-MM-DD`** (и ISO-8601 с таймзоной для `due_at` в reminders). **Относительные («вчера», «через неделю») в персист НЕ пишем** — движок резолвит их в ISO на момент `capture`, опираясь на дату из контекста/`<system>`.
- **Идентификаторы** (источники, tools, поля, id claim'ов/reminders) — в backticks при первом упоминании: `claim_4f2a`, `rem_8c1d`, `text_entities`, `TELEGRAM_OWNER_CHAT_ID`.
- **Маркеры human-edit `<!-- keep -->`.** Блок, который правил человек, движок **не перезаписывает** — только читает и учитывает в reasoning. Если факт внутри устарел — движок дописывает новый claim/абзац **снаружи** блока (детали — [compiler/rules.md §6](compiler/rules.md)).
- **Противоречия и открытые вопросы** — маркер `> ⚠ OPEN:` на странице + дубль строкой в `log.md`. Закрыли вопрос — **правим на месте** и пишем `decision`-строку в лог (не затираем историю молча). Противоречие факта — через `superseded`, не удалением (см. ниже и [compiler/rules.md §7](compiler/rules.md)).
- **Решения проекта** живут как **ADR** в [docs/adr/](docs/adr/) (Proposed/Accepted/Superseded — не удаляем, помечаем `Superseded by ADR-NNNN`). ADR 0001–0007 зафиксированы; разворот движка Codex→Claude-native — в 0008–0010 ([ADR-0001](docs/adr/0001-engine-subscription-codex.md) SUPERSEDED). Новые добавляем как 0011+; Codex как primary-движок **нигде не возвращаем**.
- **Проза — русская**; код-комментарии — RU или EN; портфолио-README — English-primary + короткое RU-интро.

## Инварианты (НЕ нарушать — наследуют [CONTEXT §3](CONTEXT.md))

1. **Read-only к источникам.** `raw/` immutable; коннекторы (`ingest/`) **никогда** не пишут в источник, только читают экспорт.
2. **Sanitizer — в write-path, fail-closed.** Любой текст из источника проходит `ingest.sanitizer.sanitize_text(text)` **ДО** записи в `raw/`, и весь публичный репо проверяется `ingest.sanitizer.scan_secrets(text)` **ДО** коммита. Маскер упал / нашёл секрет — **запись/коммит отменяется** (обязанности — [compiler/rules.md §2](compiler/rules.md)).
3. **Инкрементально, не поверх.** Движок **дописывает**; каждый ход — обычный git-diff (ревьюится, откатывается). Блоки `<!-- keep -->` не трогаем. **Никаких** автономных bulk-rewrite (защита от error-propagation — [research/memory-architecture.md](docs/research/memory-architecture.md)).
4. **Без embedder / vec-DB** ([ADR-0002](docs/adr/0002-no-embedder-pure-karpathy.md)). Семантическое ранжирование делает сам движок, читая `index.md` → нужные страницы. Маленькая SQLite (`chat→session` в `bridge`, опц. даты reminders) — это **не** нарушение (ADR-0002 запрещает векторный индекс для ВИКИ, не любую БД).
5. **Watermark на источник** ([ingest/watermark.py](ingest/)) двигается **только после успешной записи** → повторный ингест идемпотентен.
6. **Движок spawn-fresh-per-task** ([ADR-0007](docs/adr/0007-engine-spawn-and-scheduler.md)): один короткоживущий процесс `claude -p` на задачу; реактив — `--resume <session_id>` (или `--continue`), проактив/плановое — stateless (новая сессия). Финальный текст и `session_id` берём из JSON (`--output-format json`). Движок вызывается **только** официальным бинарём, **никогда** реюзом OAuth-токена ([ADR-0009](docs/adr/0009-tos-safe-engine-access.md)).
7. **Публичное ≠ приватное.** В этот репо личные данные не попадают; страж — [scheduler/lint_public.py](scheduler/) (exit≠0 при находке PII/секрета).
8. **Минимизация blast radius** ([ADR-0007](docs/adr/0007-engine-spawn-and-scheduler.md), [research/privacy-security.md](docs/research/privacy-security.md)): least-privilege инструменты движка, единственный исходящий канал в реактиве — узкий Telegram-пуш владельцу; **никакого** generic «shell, выполни что угодно». «Руки» (web/computer через MCP) включаются осознанно и узко (lethal trifecta: приватные данные + недоверенный ингест + внешняя связь).
9. **Single-user.** Реактивный путь обслуживает **только** allow-листнутый `chat_id` владельца ([ADR-0009](docs/adr/0009-tos-safe-engine-access.md)); чужие сообщения мост дропает до движка.

## Три слоя исполнения (как движок просыпается)

Движок дёргается тремя путями ([CONTEXT §4](CONTEXT.md), [docs/architecture/](docs/architecture/)). Все три спавнят `claude -p` (spawn-fresh-per-task, инвариант 6):

- **РЕАКТИВ** — `Telegram (owner-only) → Bridge → ClaudeEngine (claude -p --output-format json) → ответ/правка вики`. Запрос/заметка от владельца. Непрерывность диалога — `--resume <session_id>` из SQLite `chat_id→session_id`. Workflow — query / capture (ниже).
- **ПЛАНОВОЕ (SCHEDULED)** — `routine (Claude routine / launchd) → claude -p → задача → Telegram`. Stateless. Задачи: **compile вики** (ночью, из дельты `raw/`), **дайджест+напоминания** (утром), **lint** (еженедельно), **плановый web-research**, **resurfacing идей** (spaced). Workflow — ingest / proactive / lint (ниже).
- **СОБЫТИЙНОЕ (EVENT)** — `новый source в raw/ → trigger → compile`. Появился новый обезличенный снапшот источника → движок поднимает дельту в вики (тот же ingest-workflow).

> **Remote Claude routines vs локальный launchd ([ADR-0005](docs/adr/0005-host-v1-macbook-portable.md), [CONTEXT §4](CONTEXT.md)).** v1 плановое — локальный `launchd` (LaunchAgent, идемпотентный sweep, [ADR-0007](docs/adr/0007-engine-spawn-and-scheduler.md)): работает, только когда Mac не спит. **Апгрейд к 24/7** — remote Claude routines: они срабатывают **даже при спящем Mac**, потому что работают над приватным **GitHub**-репо `llm-wiki-content` (не над локальной ФС). Это «облачный» слой того же планового исполнения — пишет те же git-diff'ы в ту же вику. Локальный launchd остаётся fallback'ом для машин без remote-routines.

## Workflow: ingest (новый источник → `raw/` → правки вики)

Когда приходит новый экспорт источника. Приоритет ([CONTEXT §6 OQ-1](CONTEXT.md), [research/data-ingestion.md](docs/research/data-ingestion.md)): **LLM-чаты (ChatGPT/Claude/Grok) + Telegram-экспорт первыми**, дальше YouTube → X → VK → WhatsApp. **Постоянная инкрементальная подгрузка** по watermark, один источник за раз (batch снижает качество). Делается **в приватном репо**:

1. Коннектор из `ingest/` читает экспорт → каждый фрагмент через **`sanitize_text()`** → пишет markdown в `raw/<source>/...` с provenance-frontmatter (`source`, `exported_at`, `range`, watermark-cursor). Sanitizer fail-closed (инвариант 2). Код-источник (`codebase_graphify`) — отдельным треком, минует sanitizer (код — не PII).
2. Движок читает **дельту** `raw/` (от прошлого watermark) и `wiki/index.md`. Извлекает стабильные **идеи / концепции / маркеры развития / людей**; из код-сессий и технических диалогов — **accomplishment-выжимку** («что предметно сделал, какой навык, ключевые решения», не код verbatim — [compiler/rules.md §3.5](compiler/rules.md)). Эфемерное (встречи, «сделать к завтра») → в `reminders/`, не в прозу вики.
3. **Обновляет затронутые страницы** `wiki/` инкрементально (один источник обычно раскрывается в 5–15 кросс-линкованных правок). Создать vs обновить страницу, дедуп людей/идей — [compiler/rules.md §8](compiler/rules.md).
4. **Accomplishment → capability-profile.** Если из источника поднялась project-запись — обновить деривативную `wiki/capability-profile.md` (агрегат «на что способен», [compiler/rules.md §3.6](compiler/rules.md)).
5. **Противоречие** с существующим claim → пометить старый `superseded` (не удалять), приоритет recent; конфликт-вопрос — `> ⚠ OPEN:` (детали — [compiler/rules.md §7](compiler/rules.md)).
6. Обновить `wiki/index.md` (новые/изменённые страницы) и `wiki/profile.md` при новых предпочтениях.
7. Дописать строку в `log.md`: `## [YYYY-MM-DD] ingest | <source>/<scope> | <итог>`.
8. **Сдвинуть watermark** источника — только после успешной записи (инвариант 5) → следующая подгрузка идёт с этой точки.

## Workflow: query (вопрос в Telegram → ответ по вики)

**Мандат (агенты регулярно это пропускают — [research/memory-architecture.md](docs/research/memory-architecture.md) «self-reference failure»):** перед ответом **обязательно** прочитать `wiki/index.md`, затем релевантные страницы.

1. Прочитать `wiki/index.md` → найти релевантные страницы (one-line-саммари там — конкретные).
2. Прочитать страницы + их `sources`/`## Связанные`. Перечитать **негативную память** по теме, чтобы не воскрешать отвергнутое.
3. Синтезировать ответ, опираясь на claim'ы (цитировать по смыслу/`id`). Не уверен — сказать прямо, не выдумывать (личная вика — источник правды обо мне). Вопрос про «что я умею / делал раньше» — отвечать из `capability-profile.md` + `projects/`.
4. **Нетривиальный, стоящий хранения вывод — зафиксировать** правкой страницы (новый claim/абзац/новая страница) + строкой в `log.md` (`query` verb). Так знание компаундится, а не теряется.
5. Если в вопросе есть факт-обновление обо мне («я теперь работаю в X», «у Ивана родился сын») — это **capture** (ниже), не только ответ.

## Workflow: capture (заметка/идея/факт из Telegram → правки вики)

Реактивный путь, когда сообщение — не вопрос, а **заметка** («запиши идею…», «Иван любит виски», «хочу выучить рахманинова»). Сообщение — **только** от allow-листнутого владельца (инвариант 9):

1. Прогнать текст сообщения через **`sanitize_text()`** перед любой записью (инвариант 2) — даже из Telegram сюда может попасть чужой токен/телефон.
2. Классифицировать по контент-модели ([ADR-0010](docs/adr/0010-wiki-content-model.md)): факт о человеке → `wiki/people/`; идея/замысел → `wiki/ideas/`; концепция/ментальная модель → `wiki/concepts/`; цель/маркер развития → `wiki/growth/`; «что построил» → `wiki/projects/` (+ обновить `capability-profile.md`); предпочтение обо мне → `wiki/profile.md`; дневниковая мысль → `wiki/journal/YYYY-MM-DD.md`; **дата/дело со сроком → reminder** (ниже).
3. Создать или дополнить страницу (анатомия по типу — [compiler/rules.md §3](compiler/rules.md)); проставить `## Связанные`; обновить `index.md`.
4. **Извлечь reminders**, если в заметке есть дата/срок/повтор/«напомни» → завести блок в `reminders/reminders.md` (формат — [compiler/rules.md §5](compiler/rules.md), [ADR-0007](docs/adr/0007-engine-spawn-and-scheduler.md)). Относительные даты резолвим в ISO **на момент capture**.
5. Дописать `log.md` (`note` verb). Ответить в Telegram кратким подтверждением (что и куда записано).

## Workflow: proactive (плановое → digest → Telegram)

Не на запросе. Плановый слой (routine / launchd, идемпотентный sweep — [ADR-0007](docs/adr/0007-engine-spawn-and-scheduler.md)) периодически спавнит stateless `claude -p`:

1. Прочитать `reminders/reminders.md` (due по `due_at`/`rrule`) **и** даты из `wiki/` (дни рождения людей, `target_date` маркеров развития).
2. Собрать **один** digest за прогон (коалесцируем пропущенные интервалы — launchd/routine может разбудить пачку).
3. Push в Telegram владельцу (Bot API, единственный исходящий канал реактива/проактива).
4. Пометить отработанные reminders (`status`/`last_fired`) — дедуп, чтобы двойной запуск не задвоил пуш. Для `recurring` — продвинуть по `rrule`; для `spaced` — по лесенке Leitner (resurfacing идей).
5. Дописать `log.md` (`note`/`audit` verb): что ушло в digest.

## Workflow: lint (плановый проход, не на запросе)

Два линта — **личной вики** и **публичного репо**:

- **Личная вика** (движок, периодически): противоречия между claim'ами; stale (`last_updated`/`last_verified` против реальности); орфаны без входящих ссылок; недостающие `## Связанные`; открытые `> ⚠ OPEN:` без движения; дубли людей/идей; reminders в прошлом без `status`; устойчивый факт, осевший в `journal/`, → предложить вынести в idea/concept/growth/people/project. Результат — READ-ONLY suggest-then-human-approve, **не** автономный bulk-rewrite. Детали — [compiler/rules.md §9](compiler/rules.md).
- **Публичный репо** ([scheduler/lint_public.py](scheduler/)): рекурсивный скан этого репо на PII/секреты через `ingest.sanitizer.scan_secrets`; exit≠0 при находке (хук/CI перед коммитом). Это страж границы двух репо (инвариант 7).

## Связанные

- [CONTEXT.md](CONTEXT.md) · [compiler/rules.md](compiler/rules.md) · [CLAUDE.md](CLAUDE.md) · [README.md](README.md) · [setup/SETUP.md](setup/SETUP.md)
- [docs/adr/0008-engine-claude-native.md](docs/adr/0008-engine-claude-native.md) · [docs/adr/0009-tos-safe-engine-access.md](docs/adr/0009-tos-safe-engine-access.md) · [docs/adr/0010-wiki-content-model.md](docs/adr/0010-wiki-content-model.md)
- [docs/adr/](docs/adr/) · [docs/research/](docs/research/) · [docs/architecture/](docs/architecture/)
