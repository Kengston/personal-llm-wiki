# CLAUDE.md — точка входа движка (читай AGENTS.md)

> **Движок этого проекта — Claude Code** (официальный бинарь `claude -p --output-format json`, [ADR-0008](docs/adr/0008-engine-claude-native.md)/[ADR-0009](docs/adr/0009-tos-safe-engine-access.md)). `Claude Code` читает **этот** `CLAUDE.md` первым — поэтому он указывает на каноническую схему. Единый источник истины по структуре, конвенциям и workflow — **[AGENTS.md](AGENTS.md)** (его же читают отложенные движки `GrokEngine`/`CodexEngine` ради портируемости — [ADR-0008](docs/adr/0008-engine-claude-native.md)).

**Не дублируй правила здесь.** Единственный источник истины по структуре двух репозиториев, движку (Claude Code, ToS-safe официальный бинарь, single-user owner-allow-list), трём слоям исполнения (реактив / плановое / событийное), конвенциям (frontmatter, relative-ссылки, ISO-даты, `## Связанные`, `<!-- keep -->`), инвариантам и workflow (ingest / query / capture / proactive / lint) — **[AGENTS.md](AGENTS.md)**. Детальный контракт правки страниц вики (контент-модель [ADR-0010](docs/adr/0010-wiki-content-model.md): анатомия типов `ideas/concepts/growth/people/projects/capability-profile/journal`, правило сжатия код-сессий в accomplishment-записи, как экспорт LLM-чата и заметка из Telegram становятся правками, как извлекаются reminders, обязанности sanitizer, writeback, create-vs-update, обработка противоречий) — **[compiler/rules.md](compiler/rules.md)**.

## Что прочитать перед работой

1. **[AGENTS.md](AGENTS.md)** — схема: движок Claude Code (ToS-safe), структура двух репо (публичный фреймворк ≠ приватный контент), три слоя исполнения, конвенции, инварианты, workflow.
2. **[compiler/rules.md](compiler/rules.md)** — детальный контракт хранителя вики и контент-модель (читать перед любой правкой страниц).
3. **[CONTEXT.md](CONTEXT.md)** — живой контекст: что строим, §3 инварианты, §6 открытые вопросы.
4. **[docs/adr/](docs/adr/)** — зафиксированные решения. Движок: [ADR-0008](docs/adr/0008-engine-claude-native.md) (Claude-native, supersedes [ADR-0001](docs/adr/0001-engine-subscription-codex.md) — Codex), [ADR-0009](docs/adr/0009-tos-safe-engine-access.md) (ToS-safe доступ), [ADR-0010](docs/adr/0010-wiki-content-model.md) (контент-модель). 0001–0007 не переписывать; новые — 0011+. Codex как primary-движок **не возвращаем**.

## Связанные

- [AGENTS.md](AGENTS.md) · [compiler/rules.md](compiler/rules.md) · [CONTEXT.md](CONTEXT.md) · [README.md](README.md)
- [docs/adr/0008-engine-claude-native.md](docs/adr/0008-engine-claude-native.md) · [docs/adr/0009-tos-safe-engine-access.md](docs/adr/0009-tos-safe-engine-access.md) · [docs/adr/0010-wiki-content-model.md](docs/adr/0010-wiki-content-model.md)
