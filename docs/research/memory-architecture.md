---
title: Память / архитектура знаний
type: audit
status: verified
last_updated: 2026-05-31
sources:
  - https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
  - https://atlan.com/know/llm-wiki-vs-rag-knowledge-base/
  - https://towardsdatascience.com/memweave-zero-infra-ai-agent-memory-with-markdown-and-sqlite-no-vector-database-required/
---

# Память / архитектура знаний

> Направление: архитектура памяти персонального второго мозга — Karpathy LLM-wiki vs RAG/вектор vs knowledge-graph vs agent-memory-фреймворки (2026). Обосновывает [ADR-0002](../adr/0002-no-embedder-pure-karpathy.md).

## Вывод

Для одного пользователя на корпусе ограниченного размера (сотни страниц / десятки тысяч слов) паттерн Карпатого — persistent, LLM-компилируемая, связная markdown-вики с навигацией через `index.md`, **без embedder и без vec-DB** — верный дефолт, и ADR-0002 хорошо подкреплён источниками 2026. Опциональный поздний слой — **лексический SQLite FTS5/BM25** как derived, перестраиваемый индекс над markdown (режим `qmd search` или таблица `chunks_fts` memweave), никогда не вектора — вводится, только когда LLM перестаёт надёжно находить страницы через `index.md`.

## Ключевые находки

### Compile-once, накапливающийся артефакт
Паттерн Карпатого — «компилируй один раз»: LLM читает источник, извлекает факты, обновляет 5–15 entity/concept-страниц, дописывает `log.md`, помечает противоречия на ИНГЕСТЕ — противоположность RAG, который re-retrieve'ит чанки на ЗАПРОСЕ. Это буквальный тезис, принятый ADR-0002. Три слоя: raw (immutable) / wiki (LLM-owned) / schema (CLAUDE.md). Ингест «может затронуть 10–15 страниц вики». (high)

### Сам Карпатый отвергает embedder на нашем масштабе
Index-first-навигация «работает удивительно хорошо на ~100 источниках / сотнях страниц и избегает embedding-based RAG-инфраструктуры»; только «по мере роста вики нужен настоящий поиск», для чего он указывает на `qmd` (BM25/vector-гибрид). Прямо валидирует и дизайн ADR-0002, и его FTS5-trip-wire. (high)

### Эмпирический порог проседания
~50–100K токенов (~100–200 источников / ~400K слов). Дальше `index.md` не влезает в контекст и retrieval-слой становится необходим независимо от формата хранения. Конкретный N для trip-wire ADR-0002. Собственный корпус Карпатого — ~100 статей / ~400K слов. Переключаться на retrieval, когда знание «превышает лимиты контекстного окна», обслуживает «несколько пользователей» или «часто обновляется». (high)

### Lost-in-the-middle / context-rot
Наивное «запихнуть всю вики в контекст» деградирует ДО жёсткого лимита контекста из-за lost-in-the-middle / context-rot — поэтому index-first + точечные чтения страниц (что и делает паттерн) не просто дешевле, а ТОЧНЕЕ, чем дамп всего. Это аргумент ЗА navigate-then-drill-in-дизайн вики. Liu et al «Lost in the Middle» (arXiv 2307.03172): падение точности 30%+ для mid-context. Chroma 2025 «context rot»: 18 frontier-моделей (Claude Opus 4 / Gemini 2.5 / GPT-4.1) — все деградируют. (high)

### Поздний слой — лексический, не векторный
Должен быть LEXICAL-ONLY SQLite FTS5/BM25 над markdown, derived и перестраиваемый (файлы — source of truth), не вектора. Конкретные shipping-реализации: memweave (`chunks` + `chunks_fts` FTS5/BM25, «файлы — source of truth... удалишь индекс — memweave перестроит из файлов») и `qmd search` (чистый BM25/FTS5-режим, `npm i -g @tobilu/qmd`, `qmd collection add ~/notes`, `qmd search "query" --json`, MCP-сервер). BM25 — верный инструмент для нашего контента (имена, точные термины, даты). (high)

### Agent-memory-фреймворки — плохой fit
Они переизобретают вектора. mem0 = bolt-on memory-СЛОЙ (извлекает факты → vec-store → инжектит в промпты; для consumer-чат-ботов, помнящих юзера между сессиями). Letta/MemGPT = полный agent RUNTIME, пейджит контекст как OS-virtual-memory (для автономных long-horizon-агентов). Оба тяжелее нужного и конфликтуют с no-vector/git-diff-инвариантами ADR-0002. (high)

### Basic Memory — ближайший сосед, но перешёл черту
markdown = source-of-truth + SQLite-индекс; структурные строки `- [category] observation` и `- relation_type [[Target]]` для явного knowledge-graph; frontmatter title/type/permalink/tags. НО в 2026 поставляет ГИБРИДНЫЙ full-text + FastEmbed ВЕКТОРНЫЙ поиск — перешёл черту ADR-0002. Заимствовать его observation/relation-грамматику, отвергнуть embedder. (high)

### Pure-local vec-второй-мозг существует, но не наш путь
Reor (LanceDB + локальные embeddings, авто-связывает заметки по cosine) и Khoj (self-hostable, Obsidian-плагин, Ollama-local) разумны для НЕкурируемых, больших, search-first-куч заметок — но жертвуют прозрачностью, синтезом и contradiction-flagging вики. Это лагерь «RAG wins», не курируемая agent-maintained-вика. (high)

### Best-practice инкрементального ингеста
Подтверждено практиком на 77 страницах: ингестить ОДИН источник за раз с человеком в петле; batch снижает качество; каждый источник должен раскрываться в 5–15 кросс-линкованных страниц; кросс-линкинг — где паттерн реально бьёт RAG. Schema-файл (AGENTS.md/CLAUDE.md) — «самый важный компонент»; без него вывод неконсистентный. (high)

### Contradiction-handling
LLM-as-judge на ингесте + помечать superseded-факты INVALID (audit trail), а не удалять + приоритет recent; append-only БЕЗ freshness/TTL — «ловушка». Совпадает с claim/confidence/negative-memory-концептами abcage-wiki + lint. Для нас git-история уже даёт audit trail и recency. (medium)

### Два провала, против которых проектировать
(1) ERROR PROPAGATION — неверное раннее саммари/линк расползается по базе, нужен непрерывный lint + человеческое ревью; (2) SELF-REFERENCE FAILURE — агент «регулярно» забывает читать свои страницы перед ответом и не само-улучшается без явного указания. Аргумент за мандат в rules-файле читать вики + scheduled-lint, не автономию. (high)

### Тактики масштабирования index.md до FTS5
Держать one-line-саммари КОНКРЕТНЫМИ (расплывчатые → LLM берёт не ту страницу — реальный провал Nguyen на 77 стр.); шардить индекс по категории/домену; frontmatter-теги для дешёвого grep/Dataview-префильтра. Дают существенный запас под ~100-страничную отметку без новой инфраструктуры. (medium)

### Tension: wikilinks vs наш house style
Сообщество пушит dual-link ([[wikilinks]] И markdown) + гибридный векторный поиск — против нашего house style (relative markdown + `## Связанные`, no-embedder). Пуш wikilinks обусловлен Obsidian-graph-view, не нуждой LLM — Codex парсит relative-markdown-ссылки нормально. **Остаёмся на relative-markdown; не принимать dual-linking/вектора только потому, что туториалы так делают.** (medium)

## Сравнение подходов

| Подход | Прозрачность / git-diff | Синтез + противоречия | Инфраструктура | Когда выигрывает | Вектора? |
|---|---|---|---|---|---|
| **Markdown LLM-wiki (ADR-0002)** | максимальная (каждый факт — git-diff-строка) | да (на ингесте, lint) | ноль | один юзер, курируемый, ограниченный, audit-first | нет |
| RAG / vec-store (Reor, Khoj) | низкая (непрозрачные чанки) | нет (re-retrieve) | vec-DB + embedder | большой/мультидоменный/high-churn/мульти-юзер | да |
| mem0 (memory-слой) | низкая | частично | vec-store | consumer-чат-боты, кросс-сессионная память | да |
| Letta/MemGPT (runtime) | низкая | частично | OS-style runtime | автономные long-horizon-агенты | да |
| Basic Memory (сосед) | высокая (markdown+SQLite) | частично | SQLite + FastEmbed | как наш, но **с** гибридным вектором | **да** |
| qmd `search` (поздний слой) | высокая (derived BM25) | n/a (только поиск) | SQLite FTS5 | когда `index.md` перестаёт хватать | нет |

## Рекомендации

- **Оставить ADR-0002 как написан** — прямо одобрен gist Карпатого и практиками 2026. Добавить в ADR «Evidence»-абзац с порогом ~50–100K-токенов / ~100–200-источников и context-rot-исследованием, чтобы trip-wire имел конкретный sourced-N вместо расплывчатого «N страниц».
- **Сделать FTS5-trip-wire НАБЛЮДАЕМЫМ:** логировать в `log.md` выбранные страницы каждого запроса; триггер — «LLM берёт не ту/никакую страницу > X% последних запросов ИЛИ `index.md` > ~40–50K токенов». До этого — ноль поисковой инфраструктуры.
- **Когда придёт день FTS5:** реализовать как DERIVED, перестраиваемый лексический индекс над `wiki/*.md` — зеркалить схему memweave `chunks`+`chunks_fts(FTS5, BM25)` или шеллить `qmd search --json`. markdown — source of truth; `.sqlite` — throwaway-кэш (`.gitignore`). Явно запретить `sqlite-vec`/FastEmbed.
- **Заимствовать ГРАММАТИКУ Basic Memory, не движок:** структурные observation/relation-строки (напр. `- [предпочтение] ...`, `- знаком_с [[Иван Пример]]`) внутри страниц для machine-parseable-relations под будущий FTS-слой, при сохранении relative-markdown `## Связанные` как канонического кросс-линка. **Не** переходить на `[[wikilinks]]`/dual-linking (это нужда Obsidian-вьюера, ломает house style).
- **Кодифицировать два провала в `compiler/rules.md`:** (1) МАНДАТ «перед ответом прочитай `index.md`, потом релевантную страницу(ы)» — агенты «регулярно» пропускают свою вики; (2) каждый ингест прогоняет lint-чеклист (орфаны, противоречия, stale-claims) и ДОписывает ответ-стоящий-хранения как страницу. Schema-файл — самый высоко-leverage-артефакт.
- **Contradiction-handling:** на ингесте LLM-as-judge сравнивает новый claim со страницами; конфликт → пометить старую строку superseded (напр. `status: superseded` или зачёркнутый claim с датой), приоритет recent. Опираться на git-историю как audit-trail/rollback — даёт mem0/SSGM-grade-governance бесплатно (преимущество markdown для portfolio-README).
- **Против error-propagation:** маленькие ревьюабельные коммиты (инвариант ADR) + периодический lint READ-ONLY-suggest-then-human-approve, никогда автономные bulk-rewrite.
- **Масштабирование index.md до FTS5:** one-line-саммари КОНКРЕТНЫМИ, шардить `index.md` по домену (люди / идеи / предпочтения / цели), frontmatter-теги для ripgrep-префильтра — запас до ~100-страничного потолка без инфраструктуры.
- **В публичном портфолио честно:** WIN-зона (single-user, курируемый, ограниченный, audit-first) И LOSE-зона (большой/мультидоменный/high-churn/мульти-юзер → RAG) с порогом токенов. Честная «когда НЕ использовать» — множитель доверия, упреждает критику «убил ли Карпатый RAG?».

## Подводные камни

- НЕ следовать молча популярному совету туториалов добавить гибридный ВЕКТОРНЫЙ поиск (sqlite-vec/FastEmbed) — это прямо нарушает ADR-0002. Опциональный слой — BM25/FTS5 ТОЛЬКО.
- НЕ переходить на `[[wikilinks]]`/dual-linking на основании community-«best practice» — это бенефит Obsidian-graph-view, не понимания LLM, и ломает house style. Codex читает relative-ссылки нормально.
- Порог ~50–100K-токенов / ~100–200-статей — community/blog-цифра, не контролируемый бенчмарк — порядок-величины-планирования, не евангелие; реальный сигнал — наблюдаемый wrong-page-rate в `log.md`.
- Append-only БЕЗ recency/supersession — задокументированная ловушка: stale-факты накапливаются. Личная вика не исключение — git-recency + явная пометка superseded + lint.
- Два провала укусят на практике и легко недо-забюджетить: error-propagation и забывание читать свою вику. Оба — в rules-файле + lint, не «само рассосётся».
- НЕ давать вики поглощать эфемерные данные («встреча в 15:00 завтра») — CONTEXT §2 предупреждает, что это «убивает доверие к базе»; эфемерное — в scheduler/reminders.
- Не пере-индексироваться на бенчмарки agent-memory (mem0 «+26% vs OpenAI», Letta episodic coherence): они меряют chatbot/agent-recall по логам диалогов — другая задача, не курируемая git-versioned-база.

## Открытые вопросы

- При каком конкретном размере `index.md` (в токенах) ИМЕННО движок этого юзера (Codex под подпиской) начинает мис-пикать страницы? Измерять на реальной вики — 40–50K-токенов — заимствовано, не измерено на Codex.
- Принимать ли структурные observation/relation-строки (грамматика Basic Memory) сейчас для forward-compat с FTS5, или отложить, чтобы не плодить преждевременную структуру? Trade-off future-parseability vs present-readability.
- Меняет ли `--resume`-контекст Codex расклад lost-in-the-middle (может перечитывать страницы каждый ход)? Engine-specific; быстрая эмпирическая проверка до сайзинга `index.md`.
- Для проактивного reminders-пути — приемлема ли крошечная SQLite (даты/TTL) сейчас, хотя это «база», учитывая что ADR-0002 запрещает только embedder/вектора для ВИКИ? Скорее да (reminders != знание), но явная строка в [ADR-0007](../adr/0007-engine-spawn-and-scheduler.md) во избежание двусмысленности.
- Может ли lightweight `qmd`-as-MCP-зависимость конфликтовать с инвариантом портируемости движка (Codex vs Claude Code)? qmd даёт MCP-сервер, но установка (npm/bun, GGUF-download) добавляет движущуюся часть.

## Связанные

- [README.md](README.md) · [../adr/0002-no-embedder-pure-karpathy.md](../adr/0002-no-embedder-pure-karpathy.md) · [data-ingestion.md](data-ingestion.md) · [portfolio-positioning.md](portfolio-positioning.md)
