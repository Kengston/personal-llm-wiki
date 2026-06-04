"""vk — коннектор ВКонтакте (СТАБ / TODO).

Статус: НЕ реализован в v1. Это сознательный стаб (см. порядок ингеста:
Telegram → YouTube → X → VK → WhatsApp, [docs/research/data-ingestion.md]
(../docs/research/data-ingestion.md)).

Механизм экспорта (по research):
- У VK НЕТ чистого JSON-экспорта переписок. Доступны два пути:
  1. **GDPR-архив** «Защита персональных данных» → ZIP с HTML-страницами диалогов.
     ЛОВУШКА: кодировка **windows-1251**, НЕ UTF-8; HTML, а не структурированный
     JSON; парсить через `html.parser` + декодирование cp1251.
  2. **VK API** (`messages.getHistory`, `messages.getConversations`) с user-token.
     Предпочтительнее: структурированный JSON, пагинация по `offset`.
- РЕКОМЕНДАЦИЯ research: предпочесть API, а не windows-1251 HTML-архив.

Формат на выходе (когда реализуем): одна md-страница на диалог под `raw/vk/`,
provenance-frontmatter с `peer_id`, watermark по `message_id`/дате. КАЖДОЕ тело —
через `sanitizer.fail_closed_sanitize` (тот же модуль, не переопределять).

Открытый вопрос (research): v1-путь — HTML-архив vs VK API? — закрыть при
реализации.

Реализация: повторить контракт `telegram_export.py`:
    extract_text(msg) -> str          # из VK-структуры сообщения
    parse_message(msg) -> ParsedMessage
    ingest(source, raw_dir) -> int    # с Watermark.load(raw_dir, "vk")
"""

from __future__ import annotations

SOURCE_NAME = "vk"


def ingest(*args, **kwargs):  # noqa: D401 — стаб
    """TODO: реализовать ингест VK (API предпочтительнее cp1251-HTML-архива)."""
    raise NotImplementedError(
        "vk-коннектор — стаб. Путь v1: предпочесть VK API (messages.getHistory) "
        "структурированному JSON; альтернатива — GDPR HTML-архив в windows-1251. "
        "Реализовать по контракту ingest/telegram_export.py: парсинг → "
        "sanitizer.fail_closed_sanitize на каждом теле → raw/vk/<peer_id>.md → "
        "Watermark.load(raw_dir, 'vk'). См. docs/research/data-ingestion.md."
    )


if __name__ == "__main__":
    raise SystemExit(ingest.__doc__ or "vk: стаб, не реализован")
