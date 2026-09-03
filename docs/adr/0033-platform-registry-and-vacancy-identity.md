---
status: proposed
date: 2026-09-03
---

# ADR-0033 — Площадка как сущность реестра: `platform` / `external_id` / `applied_via` на вакансии и отклике, детерминированные id

> Расширяет [ADR-0029](0029-company-discovery-and-network-access.md) (`company_source`, дедуп по домену), [ADR-0030](0030-jobsearch-funnel-reporting.md) (воронка) и [ADR-0031](0031-hh-channel.md) (hh как канал). Заменяет правило D4 «новый канал добычи только отдельным ADR» на «новая площадка = страница реестра + строка в enum».

**Контекст.** Площадка сегодня размазана по трём полям и двум репозиториям. `company_source` (168 `manual`) не различает ~25 разных ATS; `submission_channel` в 409 из 436 записей `direct`; `vacancy_ref` хранит то URL, то `tag:id`, причём ashby/greenhouse/lever/icims встречаются обоими способами. У hh есть код-адаптер на 29KB, у LinkedIn механика живёт прозой в скилле на 150 строк и в `references/platforms.md`. Добавление hh потребовало ADR, модуль, правку enum и правку двух SKILL.md. Дубль enum в `jobsearch-intent.ts` без `hh` пережил [ADR-0031](0031-hh-channel.md) §1. 34 записи с `company_source: linkedin` молча выпадают из воронки, потому что значения нет в словаре, хотя семантически оно верно (живой поиск в LinkedIn, а не файл экспорта). Компания Rho живёт под двумя id. Владелец хочет добавлять площадки так, чтобы хранилище их «запоминало».

**Решение.**

### 1. Площадка = страница реестра `wiki/jobsearch/platforms/<id>.md`

Frontmatter: `id`, `kind: aggregator|network|ats|company_site|email`, `status`, `since` (точка отсечения воронки), `search: dom-live|guest-api|export-file|none`, `adapter` (имя модуля в движке или `none`), `external_id` (правило), `vacancy_url` (шаблон), `submit: platform|external|both`, `order` (обход в рутине), `geo_order`. Тело: как искать, как подавать, ловушки, датированные решения. Скиллы читают реестр и не хранят механику площадок у себя. Стартовый реестр: `hh`, `linkedin`, `ashby`, `greenhouse`, `lever`, `join`, `smartrecruiters`, `workable`, `icims`, `site` (длинный хвост карьерных страниц), `email`.

### 2. Поля вакансии и отклика

`platform` (где найдена), `external_id` (буквенный префикс без разделителя, как в [ADR-0031](0031-hh-channel.md) §4), `url` (без query), `applied_via` (где отправлена форма). Все четыре из реестра. `company_source` остаётся полем «как компания попала в воронку» и расширяется: `manual`, `linkedin_export`, `web_search` плюс любой id площадки с `kind: aggregator|network`. Значение `linkedin` легализуется, 34 записи не переписываются. `submission_channel` (referral / direct / inbound) остаётся: это отношение, а не форма.

### 3. Словарь в одном месте, реестр ⊆ enum

`PLATFORM_IDS` и `COMPANY_SOURCES = [...NON_PLATFORM_SOURCES, ...PLATFORM_IDS]` в `companies.ts`; `jobsearch-intent.ts` импортирует их, собственных литералов не держит. Lint хранилища проверяет: каждый `id` реестра есть в enum и каждый id enum имеет страницу. Валидация остаётся fail-closed: словарь в данных вместо enum отвергнут, потому что именно enum поймал бы 34 битые записи, если бы путь записи его проходил ([ADR-0035](0035-ledger-single-write-path.md)).

### 4. Идентификаторы

`company.id = slug(site_domain)`; `opportunity.id = <platform>-<external_id>`; `application.id = <platform>-<external_id>` при известном внешнем id, иначе прежний id; повторный отклик на ту же вакансию получает суффикс `-r2`. События ссылаются на `application.id`.

### 5. Миграция

Один скрипт в движке: dry-run с отчётом (карта алиасов id, коллизии, разбор `vacancy_ref` по домену или тегу в `platform`/`external_id`/`url`, домены ATS → `applied_via`, неизвестные → `site`), затем запись. Инвариант: число записей 436 / 444 / 510 и счётчики стадий воронки до и после совпадают; целостность отклики↔события полная. История файлов остаётся в git.

### 6. Адаптер: только где нужен разбор DOM

Площадка с `search: dom-live` или `guest-api` получает модуль `src/ingest/jobsearch/platforms/<adapter>.ts` по образцу `hh.ts`: экстрактор → zod-схема карточки → `map*Cards` в записи. LinkedIn-адаптер пишется следующей фазой, чтобы паттерн подтвердился дважды; до этого его механика лежит в теле страницы реестра.

**Рассмотрено и отвергнуто.** Декларативный профиль площадки с селекторами и интерпретатор: живой DOM чужого сайта не описывается без собственного мини-языка, который дороже адаптера. Оставить `vacancy_ref` и компенсировать на чтение: каждая новая площадка добавляла бы третий формат строки.

**Следствия.** Добавить площадку = одна страница в реестре + одна строка в `PLATFORM_IDS` + адаптер, если поиск идёт по DOM. Правило D4 ([ADR-0029](0029-company-discovery-and-network-access.md) §2) в части «только через ADR» снято; ADR нужен, когда площадка требует нового транспорта (как hh в [ADR-0031](0031-hh-channel.md) §2).

## Связанные

- [ADR-0029](0029-company-discovery-and-network-access.md) · [ADR-0030](0030-jobsearch-funnel-reporting.md) · [ADR-0031](0031-hh-channel.md) · [ADR-0035](0035-ledger-single-write-path.md)
- [Глоссарий подсистемы](../jobsearch-domain-glossary.md) · [Гайд](../jobsearch-guide.md)
