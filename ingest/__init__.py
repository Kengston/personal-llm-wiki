"""ingest — слой ингеста личных источников в приватный `raw/`.

Публичные модули:
- `sanitizer`        — маскер секретов/PII (write-path, fail-closed). КОРОНА.
                       Владелец маскирования; переиспользуется scheduler/lint.
- `classifier`       — Tier-1 фильтр чувствительности (ось A) + роутер «задача vs
                       знание» (ADR-0011). Sibling к sanitizer: fail-TO-quarantine,
                       маршрутизирует ЦЕЛЫЙ документ; reader'ы raw/ зовут
                       `should_skip_raw_path` (P0-1 dot-exclusion).
- `watermark`        — per-source JSON-курсор для идемпотентного ре-ингеста.
- `llm_chat`         — парсер экспортов диалогов LLM (ChatGPT/Claude/Grok) →
                       sanitized markdown + выжимка идей/решений; код-сессии →
                       accomplishment-сводка (ADR-0010).
- `telegram_export`  — парсер Telegram Desktop result.json → sanitized markdown.
- connector-стабы    — vk, whatsapp, youtube_takeout, x_archive, codebase_graphify.

Все парсеры stdlib-only; коннекторы read-only к источникам; sanitizer гоняется
ДО любой записи в raw/. См. ingest/README.md и docs/research/data-ingestion.md.
"""

# Публичный re-export классификатора (ADR-0011): чтобы коннекторы и читатели raw/
# импортировали из пакета `ingest`, не лазая в подмодуль. Контракт — в
# ingest/classifier.py; здесь только реэкспорт, без реализации. Импорт обёрнут,
# чтобы запуск одиночным файлом (python3 ingest/llm_chat.py) не падал на пакете.
try:  # pragma: no cover - удобный фасад, поведение даёт сам classifier.py
    from .classifier import (
        classify_sensitivity,
        route_lane,
        should_skip_raw_path,
        filter_log_record,
        load_policy,
        Classification,
        LaneDecision,
    )

    __all__ = [
        "classify_sensitivity",
        "route_lane",
        "should_skip_raw_path",
        "filter_log_record",
        "load_policy",
        "Classification",
        "LaneDecision",
    ]
except Exception:  # noqa: BLE001 - пакет должен импортироваться даже без classifier
    __all__ = []
