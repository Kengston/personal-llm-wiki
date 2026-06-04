# compiler/rules.md — контракт хранителя вики

> Детальный контракт, который **движок** (Claude Code, официальный бинарь `claude -p`, [ADR-0008](../docs/adr/0008-engine-claude-native.md)/[ADR-0009](../docs/adr/0009-tos-safe-engine-access.md)) исполняет, ведя **личную** вики в приватном репо `llm-wiki-content` (`raw/ + wiki/ + reminders/`). Высокоуровневая схема и workflow — в [AGENTS.md](../AGENTS.md); этот файл уточняет **как именно** редактируются страницы и кодирует **контент-модель** [ADR-0010](../docs/adr/0010-wiki-content-model.md). Здесь, в публичном репо, файл — спецификация-контракт (портфолио). Все примеры — **синтетические** («Иван Пример»), без реальных данных.
>
> **Перед любой правкой вики прочитай этот файл и [AGENTS.md](../AGENTS.md).** Schema-файл — самый высоко-leverage артефакт паттерна: без него вывод движка неконсистентен ([research/memory-architecture.md](../docs/research/memory-architecture.md)).

## 0. Два провала, против которых написан этот контракт

Эмпирика паттерна ([research/memory-architecture.md](../docs/research/memory-architecture.md)) даёт два режима отказа, которые этот файл обязан предотвращать:

1. **Error-propagation** — одно неверное раннее саммари/связь расползается по базе. Защита: маленькие ревьюабельные коммиты (git-diff на каждый ход), периодический lint, **никаких** автономных bulk-rewrite, противоречия через `superseded` (не перезапись).
2. **Self-reference failure** — движок «регулярно» забывает прочитать собственную вику перед ответом и не само-улучшается. Защита: **мандат** §1.

## 1. Мандат чтения (выполнять всегда)

- **Перед ответом/правкой** — прочитать `wiki/index.md`, затем релевантные страницы (`index.md` → нужные файлы → их `## Связанные`/`sources`). Не отвечать «по памяти движка».
- **Перед предложением нового claim'а** про сущность — перечитать секцию **негативной памяти** этой страницы (§7): не воскрешать отвергнутое.
- **Перед созданием новой страницы человека/идеи/концепции/проекта** — поискать существующую (дедуп, §8): не плодить дубли «Иван Пример» и «И. Пример».

## 2. Обязанности sanitizer (write-path, fail-closed)

Sanitizer — общий модуль [ingest/sanitizer.py](../ingest/sanitizer.py) с публичным интерфейсом `sanitize_text(text: str) -> str` (маскирует), `scan_secrets(text: str) -> list[str]` (детектит секреты, для линта) и `fail_closed_sanitize(text: str) -> str` (write-path: при сбое `SanitizerError`). Инвариант [CONTEXT §3](../CONTEXT.md)/[AGENTS.md](../AGENTS.md).

- **Маскируем ДО записи.** Любой текст из источника (ingest) **и** из входящего Telegram-сообщения (capture) проходит `sanitize_text()` **до** записи в `raw/` или `wiki/`. Маскируются: токены/ключи API, пароли, телефоны, email, прочие секреты-паттерны (полный список — в самом модуле, он — единственный владелец правил маскирования; **здесь не дублируем**).
- **Fail-closed.** Если `sanitize_text()` бросил исключение — **запись отменяется целиком** (не пишем частично-обработанный текст). Лучше потерять ход, чем записать сырой секрет.
- **Не маскируем дважды и не «чиним» вручную.** Движок не пишет собственных regex-маскировок в страницах — только вызывает модуль. Если паттерн пропущен — это баг `sanitizer.py` (завести `> ⚠ OPEN:`), а не повод хардкодить замену в прозе.
- **Чужие секреты тоже PII.** В личную вику не пишем секреты/токены/пароли даже свои (crown-jewel в прозу не выносим — [ADR-0009](../docs/adr/0009-tos-safe-engine-access.md) «приватность движка»): им место в `.env`, не в тексте, который читает облачный движок.
- **Граница публичного репо.** Любой пример, попадающий в **этот** (публичный) репо, обязан пройти `scan_secrets()` и быть синтетическим. Страж — [scheduler/lint_public.py](../scheduler/) (exit≠0 при находке).
- **Исключение — код.** Трек `codebase_graphify` (граф кодовых баз) **минует** sanitizer (код — не PII), но его артефакты не коммитятся в публичный репо без отдельной проверки на секреты-в-коде. **Важно:** это про *структуру* кода (граф), а не про выжимку — accomplishment-записи в `wiki/projects/` (§3.5) пишутся прозой про *что сделано*, и сами секретов содержать не должны.

## 3. Анатомия страницы по типам (контент-модель [ADR-0010](../docs/adr/0010-wiki-content-model.md))

Все страницы — markdown + YAML-frontmatter. **Общие поля frontmatter:** `title`, `type`, `status` (`draft|active|verified|stale|superseded|archived`), `last_updated` (ISO). Содержательные страницы заканчиваются `## Связанные` (relative-ссылки). Страницы с фактами держат массив `claims:` (§4).

Файлы именуются `kebab-case` латиницей по транслиту (`people/ivan-primer.md`) — стабильно для ссылок; человеко-имя живёт в `title`.

**Сердце вики — концепции, развитие, идеи** про владельца ([ADR-0010](../docs/adr/0010-wiki-content-model.md)). Техническое — **сильное, но сжатое и вторичное**: важно не *как* написан код, а *что* предметно сделано. Типы: `idea` · `concept` · `growth` · `person` · `project` · `capability-profile` · `journal` (+ служебные `profile`, `index`).

### 3.1. `type: idea` → `wiki/ideas/<slug>.md`

Идея, замысел, «вернуться подумать». Якорь для spaced-возврата (Leitner) и для связки с людьми/концепциями/развитием.

```markdown
---
title: Идея — приложение для учёта растений
type: idea
status: active            # active | parked | done | dropped
last_updated: 2026-05-31
tags: [pet-project, mobile]
spaced_review: rem_5b1c   # опц. id reminder'а на возврат к идее (§5, kind: spaced)
sources:
  - ../../raw/llm-chat/claude-2026-05-31.md
---

# Идея — приложение для учёта растений

Суть, мотивация, открытые вопросы. Что блокирует, следующий шаг.

## Связанные
- [concepts/sample-concept.md](../concepts/sample-concept.md) · [growth/sample-goal.md](../growth/sample-goal.md)
```

### 3.2. `type: concept` → `wiki/concepts/<slug>.md`

Концепция или ментальная модель, которую я усвоил/выработал (принцип, подход, framework мышления). Сердце вики «про развитие» — отделяет *понятое* от *задуманного* (idea) и *сделанного* (project).

```markdown
---
title: Концепция — spaced repetition как двигатель привычек
type: concept
status: active
last_updated: 2026-05-31
tags: [learning, productivity]
sources:
  - ../../raw/llm-chat/chatgpt-2026-05-20.md
claims:
  - {id: claim_2d4e, text: "Лесенка интервалов [1,3,7,16,35] стабильнее фиксированной", confidence: 0.7, status: active, sources: [../../raw/llm-chat/chatgpt-2026-05-20.md]}
---

# Концепция — spaced repetition как двигатель привычек

Что это, откуда пришло, как я это применяю. Связь с идеями/проектами, где использовал.

## Связанные
- [ideas/sample-idea.md](../ideas/sample-idea.md) · [growth/sample-goal.md](../growth/sample-goal.md)
```

### 3.3. `type: growth` → `wiki/growth/<slug>.md`

Развитие: цель, маркер, привычка, веха («научиться X», «закрепить привычку Y»). Источник дедлайн-напоминаний и трекинга прогресса. (Заменяет прежний `goals/` — шире: не только измеримые цели, но и маркеры роста.)

```markdown
---
title: Выучить «Прелюдию» Рахманинова
type: growth
status: active            # active | achieved | paused | dropped
last_updated: 2026-05-31
target_date: 2026-12-31   # ISO; опц.; источник дедлайн-напоминания
progress: 0.2             # 0..1, опц.
sources:
  - ../../raw/telegram/journal-2026-05-31.md
---

# Выучить «Прелюдию» Рахманинова

Зачем, как мерю прогресс, журнал вех (датированные строки).

## Прогресс
- 2026-05-31 — разобрал первые 8 тактов.

## Связанные
- [ideas/sample-idea.md](../ideas/sample-idea.md) · [concepts/sample-concept.md](../concepts/sample-concept.md)
```

### 3.4. `type: person` → `wiki/people/<slug>.md`

Человек в моей жизни. Якорь для дней рождения, подарков, отношений, контекста разговоров.

```markdown
---
title: Иван Пример
type: person
status: active
last_updated: 2026-05-31
aliases: [Ваня, И. Пример]          # для дедупа и матчинга в ingest
relations: [друг, бывший коллега]    # как связан со мной
birthday: 1990-04-12                 # ISO; источник проактивных напоминаний (день рождения)
sources:
  - ../../raw/telegram/ivan-primer-2026-05.md
claims:
  - {id: claim_7a1c, text: "Любит односолодовый виски (Islay)", confidence: 0.8, status: active, sources: [../../raw/telegram/ivan-primer-2026-05.md]}
  - {id: claim_3f90, text: "Переехал в Казань весной 2026", confidence: 0.6, status: active, sources: [../../raw/telegram/ivan-primer-2026-05.md]}
---

# Иван Пример

Связная проза: кто это, как познакомились, ключевой контекст. Факты — по claim'ам (`claim_7a1c`: виски → идея подарка).

## Идеи подарков
- Бутылка Islay-виски (`claim_7a1c`).

## ❌ Негативная память
<!-- сюда — отвергнутые/опровергнутые гипотезы, см. §7 -->

## Связанные
- [profile.md](../profile.md) · [ideas/sample-idea.md](../ideas/sample-idea.md)
```

### 3.5. `type: project` → `wiki/projects/<slug>.md` — accomplishment-запись (правило сжатия кода)

**Ключевое правило контент-модели ([ADR-0010](../docs/adr/0010-wiki-content-model.md)).** Код и технические сессии **НЕ пишем verbatim** в вику. Project-страница — это **accomplishment-запись**: *что предметно построено*, *какой навык показан*, *какие ключевые решения/уроки*. Полные технические детали (код, граф, длинные диалоги) остаются в `raw/` (sources); в `wiki/` идёт **выжимка**.

Из код-сессии / технического диалога движок извлекает:
- **Что построил** — предметно, в одной-двух фразах («построил X через Y для задачи Z»), не листинги.
- **Навык** — какая способность этим продемонстрирована (для агрегата в `capability-profile`, §3.6).
- **Решения/уроки** — ключевые архитектурные развилки и что из них вынес.
- **`sources:`** — ссылка на полные детали в `raw/` (экспорт чата, `graph.json`-трек). Сам код в прозу не копируем.

```markdown
---
title: Проект — Telegram-мост «Второй мозг»
type: project
status: active            # active | shipped | parked | dropped
last_updated: 2026-05-31
tags: [python, fastapi, integration]
skills: [backend-integration, async-python, api-design]   # фид в capability-profile
sources:
  - ../../raw/llm-chat/claude-2026-05-29.md   # полный технический диалог (детали — здесь)
claims:
  - {id: claim_8e21, text: "Построил тонкий FastAPI-мост Telegram↔движок с owner-allow-list", confidence: 0.9, status: verified, sources: [../../raw/llm-chat/claude-2026-05-29.md]}
---

# Проект — Telegram-мост «Второй мозг»

**Что построил.** Тонкий webhook-мост (FastAPI), который принимает сообщения owner-only-чата и спавнит движок одним коротким процессом на задачу.

**Навык.** Backend-интеграция, async-Python, дизайн узкого безопасного API-шва (single-user allow-list).

**Ключевые решения.**
- Spawn-fresh-per-task вместо резидентного демона — каждый ход crash-safe.
- Движок за абстракцией `Engine` → дроп-ин смена backend'а.

**Уроки.** Узкий исходящий канал (один Telegram-пуш) сильно сужает blast radius prompt-injection.

## Связанные
- [capability-profile.md](../capability-profile.md) · [concepts/sample-concept.md](../concepts/sample-concept.md)
```

> **Граница raw ↔ wiki.** Если хочется «сохранить весь код, чтобы не потерять» — это `raw/` (immutable, sources), **не** project-страница. Project-страница отвечает на вопрос «что я умею и что делал», а не «дай мне исходник». Простыня кода в `wiki/` — анти-паттерн ([ADR-0010](../docs/adr/0010-wiki-content-model.md)).

### 3.6. `wiki/capability-profile.md` (`type: capability-profile`) — деривативный профиль

Агрегированная страница «**на что я способен**»: сводит навыки из всех `projects/` (поле `skills:`) в связную картину компетенций. **Деривативна** — обновляется при появлении/изменении project-записи (ingest §4 / lint §9), не редактируется в отрыве от них. Это техническая «сила» вики по [ADR-0010](../docs/adr/0010-wiki-content-model.md): не код, а карта способностей.

```markdown
---
title: Capability-profile — на что я способен
type: capability-profile
status: active
last_updated: 2026-05-31
---

# На что я способен

Сводка компетенций, выведенная из проектов (источник истины по «что сделал» — страницы `projects/`).

## Backend / интеграции
- Async-Python, FastAPI, дизайн узких безопасных API-швов — [Telegram-мост](projects/sample-project.md).

## Связанные
- [projects/sample-project.md](projects/sample-project.md) · [index.md](index.md)
```

### 3.7. `type: journal` → `wiki/journal/YYYY-MM-DD.md`

Одна страница на дату. Дневниковые мысли/события, не дотягивающие до отдельной сущности. **Append-only внутри дня** (новые записи дописываются, старые не переписываются). Из journal движок при lint поднимает устойчивое в idea/concept/growth/person/project-страницы (§9).

```markdown
---
title: Журнал — 2026-05-31
type: journal
status: active
last_updated: 2026-05-31
---

# 2026-05-31

- Кофе с [Иваном](../people/ivan-primer.md); обсудили идею про растения (→ [идея](../ideas/sample-idea.md)).
- Мысль: попробовать вставать раньше (кандидат в [growth](../growth/sample-goal.md)).

## Связанные
- [index.md](../index.md)
```

### 3.8. `wiki/profile.md` (`type: profile`) и `wiki/index.md` (`type: index`)

- **`profile.md`** — страница обо мне: устойчивые предпочтения, факты, привычки, ценности (claim'ы как у person). Сюда capture кладёт «я предпочитаю…», «я работаю в…».
- **`index.md`** — каталог всех страниц по категориям (ideas/concepts/growth/people/projects/journal + capability-profile). **Читается первым** (§1). One-line-саммари — **конкретные** (расплывчатые → движок берёт не ту страницу, реальный провал — [research/memory-architecture.md](../docs/research/memory-architecture.md)). Формат — §10.

> **Провенанс источников.** Отдельных entity-страниц `type: source` в вики **нет** (контент-модель [ADR-0010](../docs/adr/0010-wiki-content-model.md) их не вводит): провенанс живёт во frontmatter-поле `sources:` каждой страницы (пути в `raw/`) и в самих `raw/`-файлах (provenance-frontmatter: `source`, `exported_at`, watermark-cursor). Watermark-курсоры — служебные, в [ingest/watermark.py](../ingest/) и `raw/.watermarks/`, не в `wiki/`.

## 4. Анатомия claim'а

Стабильный факт — атомарный `claim` во frontmatter (наследует `abcage-wiki`, упрощено для личного: без trust-score/agreement-механики хаба).

- **Поля:** `id` (`claim_<4hex>`, генерит движок), `text` (факт одной фразой), `sources` (список путей в `raw/`/внешних ref), `confidence` (0..1, оценка движка), `status` (`active|verified|stale|rejected|superseded`).
- **`id` стабилен** при обновлении факта: меняются `text`/`confidence`/`status`/`last_updated`, **не** `id`. Уникальность `id` — **в пределах страницы** (cross-page коллизии ок, изоляция через путь).
- **`verified`** — факт подтверждён ≥2 независимыми источниками **или** явным подтверждением от меня в Telegram. Иначе `active`.
- **Граница «вики vs эфемерное» (жёстко).** В claim **не** кладём текучее: «во сколько встреча завтра», «какой счёт в игре», «сколько сейчас задач». Такое — в `reminders/` (§5) или вовсе не персистится. Смешение убивает доверие к базе ([CONTEXT §2](../CONTEXT.md)).
- **Опц. observation/relation-строки** (грамматика Basic Memory, [research/memory-architecture.md](../docs/research/memory-architecture.md)) в теле страницы для будущего FTS-слоя: `- [предпочтение] любит виски` / `- знаком_с [ivan-primer](people/ivan-primer.md)`. Канонический кросс-линк всё равно `## Связанные` (не переходим на `[[wikilinks]]`).

## 5. Reminders — извлечение и формат

Эфемерное/со сроком живёт **не в вики**, а в `reminders/reminders.md` приватного репо — append-only YAML-frontmatter-блоки ([ADR-0007](../docs/adr/0007-engine-spawn-and-scheduler.md), автономный файл, **не** CalDAV/Google в v1).

**Когда движок заводит reminder** (из capture/ingest): в тексте есть дата/срок/повтор/«напомни»/«не забыть»/день рождения/дедлайн цели.

**Поля блока:**

```yaml
- id: rem_8c1d              # rem_<4hex>
  title: "Поздравить Ивана с днём рождения"
  kind: oneoff             # oneoff | recurring | spaced
  due_at: 2027-04-12T09:00:00+03:00   # ISO-8601 С ТАЙМЗОНОЙ (обязательно)
  rrule: "FREQ=YEARLY"     # iCal RRULE, опц. (для recurring)
  nl_source: "напомни поздравить Ваню на др"   # исходная фраза, для аудита (после sanitize)
  status: pending          # pending | done | snoozed | cancelled
  last_fired: null         # ISO, проставляет плановый слой после пуша
  created: 2026-05-31
  # для kind: spaced (возврат к идее, лесенка Leitner):
  # box: 1                 # текущая ступень
  # interval_days: 1       # из лесенки [1, 3, 7, 16, 35]
  # ease: 2.5
```

**Правила:**
- **ISO-даты только.** Относительные («завтра», «через неделю», «на др») движок **резолвит в ISO на момент capture** (опираясь на текущую дату из контекста/`<system>`), в `due_at` пишет уже абсолют. В `nl_source` сохраняем исходную фразу — для аудита.
- **Таймзона обязательна** в `due_at` (иначе плановый слой не знает, когда «утро»).
- **Связь с вики.** День рождения дублируется как `birthday:` в person-странице (§3.4) — плановый слой читает оба; дедлайн маркера развития — как `target_date:` в growth (§3.3). Reminder и вики-поле не должны расходиться (lint, §9).
- **`recurring`** продвигается по `rrule`; **`spaced`** — по лесенке Leitner `[1,3,7,16,35]` (для resurfacing идей). Дедуп — через `status`/`last_fired` (коалесцированный двойной sweep launchd/routine не должен задвоить — [ADR-0007](../docs/adr/0007-engine-spawn-and-scheduler.md)).
- Reminders **не редактируются движком ретроактивно** кроме `status`/`last_fired`/продвижения recurring/spaced. Отменили — `status: cancelled` (не удаляем строку).

## 6. Маркеры human-edit `<!-- keep -->`

Блок, который правил человек, движок **не перезаписывает**.

```markdown
<!-- keep -->
Текст, который агент не трогает (моя формулировка, мои нюансы).
<!-- /keep -->
```

- Внутри блока движок только **читает** (учитывает в reasoning), не модифицирует.
- Факт внутри устарел/противоречит новому → движок дописывает claim/абзац **снаружи** блока, ссылаясь на него (например, новый `claim` со `status: active`, старый — оставлен в `<!-- keep -->` как есть). Никогда не лезть внутрь `<!-- keep -->`.

## 7. Обработка противоречий (никогда не перезаписывать молча)

Новый факт конфликтует с существующим claim'ом — на ингесте/capture движок действует как LLM-as-judge ([research/memory-architecture.md](../docs/research/memory-architecture.md)):

1. **Приоритет recent**, но **старый claim не удаляем** — помечаем `status: superseded`, добавляем новый `claim` со `status: active` (тот же `id`-неймспейс страницы, новый `id`). git-история = audit-trail и откат.
2. Если какой факт верен — неясно → новый claim `status: active` + маркер `> ⚠ OPEN: <в чём конфликт>` на странице **и** дубль строкой в `log.md`. Закрыли вопрос (подтверждение от меня / второй источник) → правим на месте, пишем `decision`-строку в `log.md`, конфликтующий claim → `superseded` или `rejected`.
3. **Негативная память.** Отвергнутый/опровергнутый факт переносится в секцию `## ❌ Негативная память` страницы со `status: rejected`, причиной и датой — **не удаляется**. Движок **обязан** перечитывать её (§1) перед новыми claim'ами про сущность, чтобы не воскрешать (ловушка append-only-без-supersession — [research/memory-architecture.md](../docs/research/memory-architecture.md)).

```markdown
## ❌ Негативная память
- {id: claim_9b22, text: "Иван переехал в Москву", rejected_at: 2026-05-28, reason: "перепутал, на самом деле Казань (claim_3f90)"}
```

## 8. Создать vs обновить страницу; дедуп; куда что филим

- **Обновить**, если сущность уже есть (нашлась по `title`/`aliases`/slug в `index.md`). Дописываем claim/абзац инкрементально.
- **Создать**, если сущности нет. Минимальный frontmatter + ≥1 claim (где применимо) + `## Связанные` + строка в `index.md`. Один источник обычно раскрывается в 5–15 кросс-линкованных правок (норма паттерна), не одну мега-страницу и не россыпь огрызков.
- **Куда филить (классификация по контент-модели [ADR-0010](../docs/adr/0010-wiki-content-model.md)):** факт о человеке → `people/`; замысел/«подумать» → `ideas/`; усвоенная модель/принцип → `concepts/`; цель/маркер/привычка → `growth/`; **что предметно построил** → `projects/` (+ обновить `capability-profile.md`, §3.6); предпочтение обо мне → `profile.md`; недотянувшая мысль дня → `journal/`; дата/срок → `reminders/` (§5). Технический диалог → выжимка в `projects/`, полные детали — в `raw/` (§3.5), **не** код в прозу.
- **Дедуп людей/идей/концепций (обязателен).** Перед созданием person — искать по `aliases`/имени; нашёл вариант («Ваня» ↔ «Иван Пример») → дополнить существующую, имя-вариант внести в `aliases:`, **не** плодить вторую. То же для идей и концепций (похожая формулировка → одна страница, не дубль).
- **Кросс-линки — где паттерн бьёт RAG.** Создавая/обновляя страницу, связывай её с релевантными (человек ↔ идея ↔ концепция ↔ маркер развития ↔ проект ↔ journal-день) через `## Связанные`. Орфан без входящих ссылок — сигнал линту (§9).

## 8a. LLM-чат-экспорт → правки вики (главный источник, [ADR-0010](../docs/adr/0010-wiki-content-model.md))

Экспорт чатов со **всеми LLM** (ChatGPT/Claude/Grok) — основной источник контент-модели, с **постоянной инкрементальной подгрузкой** по watermark ([research/data-ingestion.md](../docs/research/data-ingestion.md)). Конвейер (в приватном репо, через ingest-workflow [AGENTS.md](../AGENTS.md)):

1. `llm_chat`-коннектор (`ingest/`) парсит экспорт → каждое сообщение через `sanitize_text()` → пишет в `raw/llm-chat/<provider>-<date>.md` с provenance-frontmatter. Это **полные** детали (источник истины), сюда же ложится код целиком.
2. Движок читает **дельту** `raw/llm-chat/` (от watermark) + `wiki/index.md`. Сепарирует диалог по контент-модели:
   - **замысел/«хочу сделать»** → `ideas/`;
   - **усвоенный принцип/ментальная модель** (что я понял в ходе диалога) → `concepts/`;
   - **намерение учиться/маркер роста** → `growth/`;
   - **технический/код-диалог** → **accomplishment-выжимка** в `projects/` по §3.5 (что построил / навык / решения / уроки), `sources:` → этот `raw/`-файл; код в прозу **не** копируем;
   - **эфемерное со сроком** → `reminders/` (§5).
3. Обновить `capability-profile.md`, если появилась/изменилась project-запись (§3.6).
4. Кросс-линки `## Связанные`, обновить `index.md`, дописать `log.md` (`ingest` verb), сдвинуть watermark.

> **Анти-паттерн.** «Сохранить весь чат в `wiki/` как есть» — нет: сырой диалог → `raw/`; в `wiki/` — только сепарированные идеи/концепции/маркеры/accomplishment-выжимки. Иначе вика тонет в технических простынях вместо моделирования «на что я способен» ([ADR-0010](../docs/adr/0010-wiki-content-model.md)).

## 9. Lint личной вики (плановый, READ-ONLY → suggest → human-approve)

Периодический проход (не на запросе). Движок **предлагает** правки, не применяет bulk автономно (§0, error-propagation):

- **Противоречия** между claim'ами (внутри и между страницами) — пометить `> ⚠ OPEN:`/предложить `superseded`.
- **Stale:** `last_updated`/`last_verified` давно в прошлом; `target_date`/`due_at` reminder'а прошёл, а `status` не закрыт; growth `active` без движения в `## Прогресс`.
- **Орфаны** без входящих ссылок; недостающие `## Связанные`.
- **Открытые `> ⚠ OPEN:`** без движения; закрытые вопросы, не отражённые правкой.
- **Дубли** людей/идей/концепций (похожие `title`/`aliases`) → предложить слияние.
- **Расхождение reminder ↔ вики:** `birthday`/`target_date` в странице не совпадает с `due_at` reminder'а.
- **Поднятие из journal:** устойчивое, осевшее в journal-днях, → предложить вынести в idea/concept/growth/person/project.
- **Дрейф capability-profile:** в `projects/` появились/изменились `skills:`, не отражённые в `capability-profile.md` → предложить пересборку деривативной страницы (§3.6).
- **(Наблюдаемость trip-wire ADR-0002)** при росте корпуса логировать в `log.md`, какие страницы движок выбирал на запрос; устойчивый wrong-page-rate / `index.md` > ~40–50K токенов → сигнал к лексическому FTS5 (не вектора — [research/memory-architecture.md](../docs/research/memory-architecture.md)).

Линт **публичного** репо — отдельный, кодовый: [scheduler/lint_public.py](../scheduler/) (`scan_secrets`, exit≠0). См. [AGENTS.md](../AGENTS.md).

## 10. Upkeep `index.md` и `log.md`

**`index.md`** — каталог, читается первым (§1, §3.8). После любой правки, создающей/переименовывающей/архивирующей страницу — синхронно обновить (категории по контент-модели [ADR-0010](../docs/adr/0010-wiki-content-model.md)):

```markdown
## Идеи
- [Приложение для учёта растений](ideas/plant-tracker.md) — pet-project, на паузе.

## Концепции
- [Spaced repetition как двигатель привычек](concepts/spaced-repetition.md) — применяю к обучению и к resurfacing идей.

## Развитие
- [Прелюдия Рахманинова](growth/rachmaninoff-prelude.md) — к концу 2026, прогресс 20%.

## Люди
- [Иван Пример](people/ivan-primer.md) — друг, бывший коллега; др 12 апр.   # саммари КОНКРЕТНОЕ

## Проекты
- [Telegram-мост «Второй мозг»](projects/secondbrain-bridge.md) — async-Python, FastAPI, owner-allow-list.

## Профиль способностей
- [capability-profile.md](capability-profile.md) — сводка компетенций из проектов.
```

При росте — шардить `index.md` по категориям (ideas/concepts/growth/people/projects/journal), frontmatter-теги для дешёвого `ripgrep`-префильтра.

**`log.md`** — append-only журнал. Каждая операция (ingest/capture/query-с-записью/proactive/lint/decision) дописывает строку:

```
## [YYYY-MM-DD] <verb> | <scope> | <итог>
```

Verbs: `ingest` · `note` (capture) · `query` · `audit` (proactive digest) · `lint` · `decision` · `scaffold`. Грепается: `grep "^## \[" log.md | tail`. Историю **не** переписываем — только дописываем (закрытие `> ⚠ OPEN:` фиксируем новой `decision`-строкой).

## 11. Что движок НЕ делает (запреты)

- Не пишет git/не пушит/не устанавливает зависимости (это ручные шаги [setup/SETUP.md](../setup/SETUP.md) и нормальный git-flow человека).
- **Не реюзает OAuth-токен Claude** в сторонний/самописный HTTP-клиент (паттерн OpenClaw — забанен для Claude, [ADR-0009](../docs/adr/0009-tos-safe-engine-access.md)); движок — только официальный бинарь `claude`. OpenClaw допустим **исключительно** на стороне отложенного `GrokEngine`.
- Не трогает `<!-- keep -->`-блоки и не редактирует ADR (0001–0010 зафиксированы).
- Не пишет эфемерное/секреты в прозу вики (§4, §2); не копирует код verbatim в `wiki/` (§3.5, §8a — код → `raw/`, выжимка → `projects/`).
- Не делает автономный bulk-rewrite (§0); правки — маленькими git-diff'ами.
- Не использует generic «fetch any URL»/shell-инструмент бесконтрольно; единственный исходящий канал реактива/проактива — Telegram-пуш владельцу ([ADR-0007](../docs/adr/0007-engine-spawn-and-scheduler.md), lethal trifecta). «Руки» (web/computer через MCP) — узко и осознанно.
- Не обслуживает чужие `chat_id` — single-user, allow-list владельца ([ADR-0009](../docs/adr/0009-tos-safe-engine-access.md)).
- Не добавляет embedder/векторный индекс ([ADR-0002](../docs/adr/0002-no-embedder-pure-karpathy.md)).

## Связанные

- [AGENTS.md](../AGENTS.md) · [CLAUDE.md](../CLAUDE.md) · [CONTEXT.md](../CONTEXT.md)
- [docs/adr/0008-engine-claude-native.md](../docs/adr/0008-engine-claude-native.md) · [docs/adr/0009-tos-safe-engine-access.md](../docs/adr/0009-tos-safe-engine-access.md) · [docs/adr/0010-wiki-content-model.md](../docs/adr/0010-wiki-content-model.md)
- [docs/adr/0002-no-embedder-pure-karpathy.md](../docs/adr/0002-no-embedder-pure-karpathy.md) · [docs/adr/0007-engine-spawn-and-scheduler.md](../docs/adr/0007-engine-spawn-and-scheduler.md)
- [docs/research/memory-architecture.md](../docs/research/memory-architecture.md) · [docs/research/data-ingestion.md](../docs/research/data-ingestion.md)
- [ingest/sanitizer.py](../ingest/sanitizer.py) · [ingest/watermark.py](../ingest/) · [scheduler/lint_public.py](../scheduler/)
