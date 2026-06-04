# Лог фреймворка — «Второй мозг»

> Хронологический append-only журнал решений и операций над **публичным фреймворк-репо**. Префикс `## [YYYY-MM-DD] <verb> | <scope> | <detail>` (домашний формат LLM-wiki) — парсится грепом: `grep "^## \[" log.md | tail -5`. Свежие записи — сверху. Личных данных здесь нет ([CONTEXT §2](CONTEXT.md)).

Verbs: `decision` · `note` · `ingest` · `query` · `lint` · `fired`.

---

## [2026-05-31] decision | engine | Codex→Claude-native pivot (ADR-0008/0009/0010); routines layer; LLM-chat ingest

Гриллинг-итерации зафиксировали разворот движка: v1 — **Claude-native** вместо Codex. Принято:
- **Движок** ([ADR-0008](docs/adr/0008-engine-claude-native.md)) — официальный бинарь `claude -p --output-format json`, engine-portable; `GrokEngine`/`CodexEngine` — отложенные адаптеры-слоты. [ADR-0001](docs/adr/0001-engine-subscription-codex.md) (Codex primary) → **superseded**.
- **ToS-доступ** ([ADR-0009](docs/adr/0009-tos-safe-engine-access.md)) — только официальный бинарь, single-user allow-list на свой Telegram `chat_id`, OAuth-токен **не реюзать** в стороннем клиенте (паттерн OpenClaw забанен для Claude; допустим только для Grok). Agent-SDK-кредит с 15.06.2026.
- **Контент-модель** ([ADR-0010](docs/adr/0010-wiki-content-model.md)) — концепции/развитие/идеи-first; код-сессии → accomplishment/capability-выжимка (не verbatim); инкрементальный ingest чатов со всеми LLM.
- **Слой routines** — плановое исполнение (compile/ingest, дайджест+напоминания, lint, web-research, resurfacing): локальный launchd + апгрейд на **remote Claude routines** (24/7 над приватным GitHub-репо, даже при спящем Mac).
- [ADR-0007](docs/adr/0007-engine-spawn-and-scheduler.md) reconciled на Claude (spawn-fresh-per-task, idempotent-sweep, формат reminders — engine-агностичны и остаются); снят неприменимый риск «Codex-backend ToS».
- Обновлены [CONTEXT.md](CONTEXT.md), индекс ADR [docs/adr/README.md](docs/adr/README.md), репо-каталог [index.md](index.md).

## Связанные

- [CONTEXT.md](CONTEXT.md) · [index.md](index.md) · [docs/adr/README.md](docs/adr/README.md) · [README.md](README.md)
