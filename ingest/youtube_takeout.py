"""youtube_takeout — коннектор истории YouTube (СТАБ / TODO).

Статус: НЕ реализован в v1 (второй по приоритету источник: Telegram → **YouTube**
→ X → VK → WhatsApp). PII-риск низкий (это собственная история просмотров).

Механизм экспорта (по research):
- **Google Takeout** (takeout.google.com) → выбрать «YouTube and YouTube Music»
  → история → формат **JSON** → архив с `watch-history.json` (и опц.
  `search-history.json`).
- ЛОВУШКИ (data-ingestion §«YouTube Takeout»):
  * `watch-history.json` — ПЛОСКИЙ массив записей.
  * Многие записи ЛИШЕНЫ `titleUrl` (удалённые/приватные видео, не-видео-события)
    → их НАДО фильтровать, иначе засоряют per-channel-статистику.
  * id видео выводить из `titleUrl` (`watch?v=...`); канал — из первого элемента
    `subtitles` (его `name`/`url`).
- РЕКОМЕНДАЦИЯ research: брать JSON-формат (не HTML), скипать записи без
  `titleUrl`, выводить id из `titleUrl` и первого `subtitles`-url.

Формат на выходе (когда реализуем): агрегат под `raw/youtube/` — напр. одна
страница-сводка (топ-каналы, темы) ИЛИ помесячные страницы; provenance-frontmatter,
watermark по `time` (ISO) последней обработанной записи. История — не переписка,
PII-минимальна, но прогон через `sanitizer.fail_closed_sanitize` обязателен
(в заголовках видео может оказаться что угодно).

Реализация: json.load(watch-history.json) → фильтр `titleUrl` → нормализация →
sanitizer → raw/youtube/*.md → Watermark.load(raw_dir, 'youtube').
"""

from __future__ import annotations

SOURCE_NAME = "youtube"


def ingest(*args, **kwargs):  # noqa: D401 — стаб
    """TODO: реализовать ингест YouTube Takeout `watch-history.json`."""
    raise NotImplementedError(
        "youtube_takeout-коннектор — стаб. Источник: Google Takeout → "
        "watch-history.json (формат JSON). Фильтровать записи без titleUrl, "
        "выводить video-id из titleUrl и канал из subtitles[0]. Затем: "
        "sanitizer.fail_closed_sanitize → raw/youtube/*.md → "
        "Watermark.load(raw_dir, 'youtube'). См. docs/research/data-ingestion.md."
    )


if __name__ == "__main__":
    raise SystemExit(ingest.__doc__ or "youtube_takeout: стаб, не реализован")
