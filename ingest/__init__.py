"""ingest — слой ингеста личных источников в приватный `raw/`.

Публичные модули:
- `sanitizer`        — маскер секретов/PII (write-path, fail-closed). КОРОНА.
                       Владелец маскирования; переиспользуется scheduler/lint.
- `watermark`        — per-source JSON-курсор для идемпотентного ре-ингеста.
- `llm_chat`         — парсер экспортов диалогов LLM (ChatGPT/Claude/Grok) →
                       sanitized markdown + выжимка идей/решений; код-сессии →
                       accomplishment-сводка (ADR-0010).
- `telegram_export`  — парсер Telegram Desktop result.json → sanitized markdown.
- connector-стабы    — vk, whatsapp, youtube_takeout, x_archive, codebase_graphify.

Все парсеры stdlib-only; коннекторы read-only к источникам; sanitizer гоняется
ДО любой записи в raw/. См. ingest/README.md и docs/research/data-ingestion.md.
"""
