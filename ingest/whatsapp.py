"""whatsapp — коннектор WhatsApp (СТАБ / TODO).

Статус: НЕ реализован в v1 (последний в порядке ингеста; возможно отложить —
см. открытый вопрос research «держать WhatsApp в v1 или отложить?»).

Механизм экспорта (по research):
- В чате WhatsApp: «Ещё → Экспорт чата» → `_chat.txt` (+ опц. медиа) в ZIP.
- ЛОВУШКИ (data-ingestion §«Подводные камни»):
  * Два РАЗНЫХ формата строк: **iOS** (`[ДД.ММ.ГГ, ЧЧ:ММ:СС] Имя: текст`) и
    **Android** (`ДД.ММ.ГГ, ЧЧ:ММ - Имя: текст`).
  * **Невидимые управляющие символы**: LRM `U+200E` и NNBSP `U+202F` внутри строк
    — ломают наивный regex. (Sanitizer их уже вычищает через NFKC+blacklist, но
    парсер строк ДОЛЖЕН учитывать их при разборе даты/автора.)
  * Локали дат (ДД.ММ.ГГ vs ММ/ДД/ГГ) зависят от телефона.
- РЕКОМЕНДАЦИЯ research: это ЕДИНСТВЕННЫЙ источник, для которого стоит ВЕНДОРИТЬ
  готовый парсер (напр. логику `Pustur/whatsapp-chat-parser`), а не писать regex
  с нуля — слишком много краевых случаев формата.

Формат на выходе (когда реализуем): одна md-страница на чат под `raw/whatsapp/`,
provenance-frontmatter, watermark по индексу/дате последней строки. КАЖДОЕ тело —
через `sanitizer.fail_closed_sanitize`.

Реализация: вендорить парсер `_chat.txt` → нормализовать в ParsedMessage-эквивалент
→ контракт как в `telegram_export.py` с `Watermark.load(raw_dir, 'whatsapp')`.
"""

from __future__ import annotations

SOURCE_NAME = "whatsapp"


def ingest(*args, **kwargs):  # noqa: D401 — стаб
    """TODO: реализовать ингест WhatsApp `_chat.txt` (вендорить парсер формата)."""
    raise NotImplementedError(
        "whatsapp-коннектор — стаб. Источник: экспорт чата → _chat.txt. "
        "Вендорить готовый парсер (iOS/Android-форматы + невидимые LRM/NNBSP), "
        "не писать regex с нуля. Затем: sanitizer.fail_closed_sanitize на каждом "
        "теле → raw/whatsapp/<chat>.md → Watermark.load(raw_dir, 'whatsapp'). "
        "См. docs/research/data-ingestion.md."
    )


if __name__ == "__main__":
    raise SystemExit(ingest.__doc__ or "whatsapp: стаб, не реализован")
