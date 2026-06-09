# Лог фреймворка — «Второй мозг»

> Хронологический append-only журнал решений и операций над **публичным фреймворк-репо**. Префикс `## [YYYY-MM-DD] <verb> | <scope> | <detail>` (домашний формат LLM-wiki) — парсится грепом: `grep "^## \[" log.md | tail -5`. Свежие записи — сверху. Личных данных здесь нет ([CONTEXT §2](CONTEXT.md)).

Verbs: `decision` · `note` · `ingest` · `query` · `lint` · `fired`.

---

## [2026-06-09] decision | lang | Порт фреймворка Python→TypeScript (ADR-0012, ADR-0013)

Behavior-preserving порт публичного фреймворка (bridge/ingest/scheduler/lint) на **TypeScript** (Node 24, strict ESM), зеркалит house-style `abcage-mcp-hub`. Python удалён (остаётся в git-истории). Язык **не несущий** — все ADR-инварианты держит поведение + тесты, не язык/число зависимостей.
- **Стек** ([ADR-0012](docs/adr/0012-language-typescript-port.md)) — Fastify + pino + zod + dotenv-flow + `node:sqlite` (встроенный, отсюда Node ≥24) + luxon + rrule + vitest, пакетный менеджер `pnpm`. Исходники в `src/`, сборка в `dist/` (`pnpm build`).
- **Фикс pii_density** ([ADR-0013](docs/adr/0013-pii-density-valid-phones.md)) — считаются только валидные телефоны (10–15 цифр); дат-насыщенные страницы больше не уходят в ложный `others_pii`-карантин (правка унаследованного из Python flaw, осознанная дивергенция).
- **Харднинг из 45-агентного аудита** — устойчивый CLI main-guard (`realpathSync` — чинит молчаливый no-op `lint-public` под симлинком/пробелом в пути), int-усечение порогов, naive-timestamp в UTC, атомарные ledger-append'ы, диагностика смерти процесса по сигналу, `'*'`-content-type парсер (security-проверки в хендлере, 404 вместо 415).
- **Проверки** — 183 теста зелёные (vitest), `typecheck`/`lint`/`build` чисто, gate `lint-public` exit 0; dist-смоук под реальным `node dist` (поймал CJS-interop `rrule`, который vitest маскировал). Запушено в публичный репо (`main`), обновлены description + topics на GitHub.
- Обновлены живые доки: [AGENTS.md](AGENTS.md), [CONTEXT.md](CONTEXT.md), [README.md](README.md), [index.md](index.md), [docs/architecture/architecture.md](docs/architecture/architecture.md), компонентные README, [setup/SETUP.md](setup/SETUP.md); ADR 0001–0011 заморожены как исторические. ADR-индекс — [docs/adr/README.md](docs/adr/README.md).

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
