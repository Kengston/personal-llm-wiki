---
title: Позиционирование портфолио
type: audit
status: verified
last_updated: 2026-05-31
sources:
  - https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
  - https://github.com/logancyang/obsidian-copilot
  - https://github.blog/developer-skills/github/include-diagrams-markdown-files-mermaid/
---

# Позиционирование портфолио

> Направление: позиционирование open-source-репо персонального LLM-wiki / second-brain-фреймворка (2026). Влияет на публичный README, выбор лицензии, структуру демо. Не противоречит ADR; кандидат на решение лицензии — возможный ADR-0007-смежный пункт.

## Вывод

Ниша персональных LLM-wiki в 2026 переполнена, но позиция защитима: каждый крупный аналог (Khoj, Reor, Basic Memory, obsidian-copilot) — RAG/embedding-based, ровно то, что паттерн Карпатого (и ADR-0002) сознательно отвергает — так что «без embedder, чистый паттерн Карпатого, LLM делает ранжирование» — реальный citable-дифференциатор, не маркетинг. Ещё три дифференциатора (подписочный движок за $0, Telegram-интерфейс, ПРОАКТИВНЫЕ push-напоминания) почти отсутствуют у аналогов, а «cost-оптимизация + local/self-hosted + no vendor lock-in» — ровно то, что награждает HN/AI-сообщество в этом цикле.

## Ключевые находки

### Все аналоги на embeddings — «без embedder» citable
Каждый крупный аналог (Khoj, Reor, Basic Memory, obsidian-copilot, logseq-copilot) построен на embeddings/vector-search — «no embedder, the LLM does the ranking» — реальный citable-дифференциатор, а не недостающая фича. ADR-0002 явно отвергает embedder, следуя паттерну Карпатого, где LLM делает семантическое ранжирование. (high)

### AGPL-3.0 — норма ниши
AGPL-3.0 — de-facto-лицензия персональной-second-brain-OSS-ниши (Khoj, Reor, Basic Memory, obsidian-copilot — ВСЕ AGPL-3.0); выбор сигналит, что ты изучил поле. MIT/Apache-2.0 максимизирует reuse/adoption портфолио. Выбрать осознанно и сказать почему одной строкой в README. (high)

### AGENTS.md + CLAUDE.md — credibility-сигнал 2026
Поставка ОБОИХ в корне репо — credibility-сигнал 2026: показывает, что репо сам agent-maintained. obsidian-copilot (7.1k звёзд) поставляет ОБА; Basic Memory — AGENTS.md. Karpathy называет schema-файл «critical control file». План проекта уже мандатит AGENTS.md primary (Codex) + CLAUDE.md, отсылающий к нему — матчит поле, surface'ить как фичу. (high)

### Credible-README-архетип ниши
Фиксированный скелет: tagline → What/Why-пара → above-the-fold-демо → feature-list → quickstart → architecture → FAQ → license/contributing. Общий хребет — «Why» перед «How», демо у верха, FAQ + license внизу. (high)

### Above-the-fold-демо обязательно
Стандарт ниши — анимированный GIF или короткий (~20–30с) mp4 одной реальной интеракции. Посетители решают за ~10 секунд. Идеальное демо для нас — Telegram screen-record: послать факт → увидеть git-diff страницы вики → позже получить проактивное напоминание. (high)

### Демо-тулинг
Лучший terminal/CLI-демо-тулинг 2026 — `charmbracelet/vhs` (scriptable `.tape`-файлы, CI-reproducible, high FPS); asciinema + agg — альтернатива для true-terminal-сессий. Для Telegram-UI screen-recording → GIF уместнее terminal-recorder'а. (high)

### Mermaid — для архитектуры
GitHub рендерит mermaid нативно в README (триплет-бэктик `mermaid`-блок), он diffable и AI-era-стандарт. Использовать `flowchart`, не deprecated `graph`. ASCII-pipeline из CONTEXT.md перерисовать в Mermaid: Telegram → CF Tunnel → FastAPI bridge → `codex exec` → wiki + reminders, плюс проактивный launchd/cron-loop как второй flow. (high)

### GitHub-discoverability
Драйвится repo-name + description + topics; добавить до 20 lowercase-hyphen-топиков, вести description primary-keyword'ом, имя keyword-rich. Сет топиков Basic Memory — сильный шаблон: python, markdown, productivity, ai, mcp, obsidian, knowledge-management, claude, privacy-first, knowledge-graph, local-first, llm. (high)

### Reward-функция сообщества 2026
cost-оптимизация + local/self-hosted + no vendor lock-in; штраф — hype без demonstrable-results («AI slop»-скептицизм). Прямо благоволит подписочному-движку ($0-marginal) и engine-portable-абстракции. «Credibility требует demonstrable results, а не обещаний; reproducible methodology и transparency — ключ». (medium)

### Четыре дифференциатора почти отсутствуют у аналогов
Чистая позиционирующая фраза: «единственный, кто embedder-free (чистый Карпатый), крутится на flat-rate-подписочном-движке, живёт в Telegram и проактивен (пушит напоминания), а не только реактивен». Khoj/Reor/Basic Memory/obsidian-copilot — все реактивны и embedding-based; никто не центрирует Telegram (у Khoj WhatsApp, не проактивный планировщик); никто не использует подписочный CLI-движок как ядро. Проактив — сильнейшая уникальная ось. (medium)

### Синтетическая пример-вика — высший credibility-артефакт
Браузабельная, явно-labelled синтетическая пример-вика — единственный высший-leverage-credibility-артефакт: даёт рекрутёру УВИДЕТЬ формат вывода и bookkeeping агента без личных данных, превращая абстрактный «фреймворк» в конкретное демо. Пример обязан использовать явно-fake-имена («Иван Пример») per hard-rules проекта. (high)

### Граница двух репо — featured-решение
Public/private-split — featured-security/design-решение, не скрытое: сигналит data-handling-зрелость, fail-closed-sanitizer — portfolio-grade-инженерная-деталь. Рекрутёры, читающие AI-проект, обрабатывающий личные сообщения, ищут именно это; «как гарантируем ноль PII-утечек в публичный репо» как README-секция — дифференциатор vs аналоги, не грапплящие с personal-data-egress. (medium)

## Сравнение с аналогами

| Проект | Embedder? | Стоимость движка | Интерфейс | Проактив? | Лицензия |
|---|---|---|---|---|---|
| **Второй мозг (наш)** | **нет** (Карпатый) | **$0** (подписка) | **Telegram** | **да** (push) | TBD |
| Khoj | да | API-ключ / Ollama | web/WhatsApp/Obsidian | нет | AGPL-3.0 |
| Reor | да (LanceDB) | API-ключ / Ollama | desktop-app | нет | AGPL-3.0 |
| Basic Memory | да (FastEmbed) | через MCP-клиент | Claude/MCP | нет | AGPL-3.0 |
| obsidian-copilot | да | API-ключ | Obsidian-плагин | нет | AGPL-3.0 |

## Рекомендации

- **README-аутлайн (публичный, English-primary + 2–3 строки русского интро):** (1) logo/title + one-line-tagline; (2) badges-ряд [license, last-commit, made-with-Codex/AGENTS.md, Telegram, кастомный «no-embedder»-badge]; (3) 20–30с-демо-GIF above-the-fold (Telegram: заметка → git-diff страницы → позже проактивное напоминание); (4) «Why» (anti-RAG-фрейминг: знание накапливается, не re-retrieve'ится); (5) «What it is» (абзац + позиционирующая фраза); (6) «How it's different»-таблица vs Khoj/Reor/Basic Memory (колонки: embedder?, engine cost, interface, proactive?); (7) Architecture (Mermaid-flowchart: реактив + проактив); (8) Quickstart (→ `setup/SETUP.md`, 4 команды); (9) «See the example wiki» → `wiki-example/` со скриншотом; (10) Design decisions (→ `docs/adr/`, граница двух репо + fail-closed-sanitizer + no-embedder); (11) Project status / non-goals / limitations (честно: v1 Mac-only, single-user, ToS-серая-зона); (12) Roadmap; (13) Contributing + AGENTS.md-note; (14) License; (15) Credits (паттерн Карпатого + Memex).
- **Кандидаты имени репо (keyword-rich, hyphenated; держать выбранный `Kengston/personal-llm-wiki` primary):** топ — `personal-llm-wiki` (уже выбран, матчит термин Карпатого, максимально discoverable). Альтернативы: `llm-wiki-brain`, `second-brain-llm-wiki`, `karpathy-wiki-agent`. Избегать чистого codename (транслитерации «Второй мозг») как slug — убивает поиск; держать «Второй мозг» как display-name бота и project-title в README, не URL.
- **Вести дифференциаторами в порядке (сильнейший первый):** 1) no-embedder / чистый Карпатый (единственный в поле — самый защитимый); 2) проактив (уникальная ось); 3) $0-подписочный-движок + engine-portable (матчит cost/anti-lock-in-зейтгейст 2026); 4) Telegram-нативность. Сжать в одну фразу у верха README.
- **Badges & topics:** ~12–15 топиков по образцу Basic Memory: llm, knowledge-management, second-brain, personal-knowledge-base, markdown, knowledge-graph, local-first, privacy-first, telegram-bot, codex, agents, llm-wiki, karpathy, fastapi, python. Кастомный shields.io-badge «no embedder · pure Karpathy pattern». Social-preview-image — архитектурная диаграмма.
- **Credibility / anti-«AI-slop»-ходы:** (a) браузабельная синтетическая пример-вика с реальной git-историей (несколько коммитов «агент ведёт вики») — proof over promise; (b) явная «Non-goals & limitations»-секция (no SaaS, single-user, v1 Mac-only, ToS-caveat) — честность читается как компетентность; (c) полный ADR-trail (0001–0006 + добавить 0007) — инженерное суждение; (d) quickstart реально runnable из `setup/SETUP.md`; (e) fail-closed-sanitizer + граница двух репо как «как гарантируем ноль PII-утечки».
- **Архитектурная диаграмма:** перерисовать ASCII-pipeline CONTEXT.md в Mermaid `flowchart LR` (Telegram → Cloudflare Tunnel → FastAPI bridge → `codex exec --json --resume` → wiki/ + raw/ + reminders/ → ответ), плюс второй малый flow для проактива (launchd/cron → codex → Telegram-push). mmdc-экспортированный PNG — social-preview. Одна строка `ARCHITECTURE.md` / `docs/architecture/`, расширяющая её инвариантами.
- **Демо-тулинг:** записать Telegram-интеракцию screen-capture → оптимизированный GIF (<5MB, ~12fps) above-the-fold; если показываешь и CLI-ингест-путь, скриптовать `charmbracelet/vhs` (`.tape`, CI-reproducible). Хостить GIF in-repo (`assets/`/`docs/`), чтобы пережил форки.

## Подводные камни

- НЕ давать реальным личным данным, контакту, телефону, message-id, токену попасть в публичный репо — пример-вика ОБЯЗАНА использовать явно-fake-имена («Иван Пример») и fake-даты/id; это самое жёсткое правило проекта и его credibility-linchpin.
- Избегать clever-но-opaque-codename как slug — убивает GitHub/Google-discoverability. Держать метафору «Второй мозг» как display-name; URL — keyword-rich.
- Не over-claim'ить «always-on»/«autonomous» — v1 работает только когда MacBook бодрствует (ADR-0005). Завышение availability приглашает «AI slop / не работает»-скептицизм, который HN наказывает; заявить ограничение прямо.
- Не хоронить no-embedder-решение как недостающую фичу — фреймить оффенсивно как тезис Карпатого, с цитатой, иначе ревьюеры прочтут как «не смогли сделать поиск».
- Подписочный-Codex-as-backend ToS-серая-зона (CONTEXT OQ-5) должна быть честно в limitations; подача как production-grade для мульти-юзера — credibility-own-goal.
- Не копировать AGPL-3.0 рефлекторно только потому, что ниша использует — для чистого портфолио permissive-лицензия может лучше служить adoption; решить осознанно и сказать почему (молчаливый выбор лицензии выглядит небрежно).
- Избегать screenshot-only-демо, если GIF/видео возможно — статика underperform'ит; но и избегать over-long (>40с)-видео. Одна tight реальная интеракция.
- Не давать README стать Russian-only — аудитория портфолио международная; English-primary + короткое русское интро per house style, иначе режешь discoverability вдвое.

## Открытые вопросы

- Выбор лицензии ПУБЛИЧНОГО репо: AGPL-3.0 (niche-consistent, anti-closed-fork) vs MIT/Apache-2.0 (max reuse/adoption портфолио) — нужно явное решение (кандидат ADR-0007-смежный пункт).
- Публиковать демо-GIF как Telegram-screen-record-only, или парить с vhs-скриптованным CLI-ингест-клипом, показывающим `codex exec`, пишущий страницу вики (последнее «engineering-credible» для developer-аудитории)?
- Насколько агрессивно опираться на ассоциацию с Карпатым в ИМЕНИ репо (`karpathy-wiki-agent`) — бустит discoverability через его trending-термин, но рискует выглядеть derivative vs оригинальное имя; README-credit может быть достаточно.
- Поставлять синтетическую пример-вику с сфабрикованной multi-commit-git-историей (убедительнее «паттерн работает») или один чистый коммит (проще, меньше риска выглядеть staged) — влияет на то, как ляжет claim «оно само себя ведёт».

## Связанные

- [README.md](README.md) · [../../CONTEXT.md](../../CONTEXT.md) · [memory-architecture.md](memory-architecture.md) · [engine-runtime.md](engine-runtime.md)
