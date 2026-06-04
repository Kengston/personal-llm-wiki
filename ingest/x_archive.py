"""x_archive — коннектор архива X / Twitter (СТАБ / TODO).

Статус: НЕ реализован в v1 (третий по приоритету: Telegram → YouTube → **X** →
VK → WhatsApp). PII-риск ВЫСОКИЙ из-за личных сообщений (DM).

Механизм экспорта (по research):
- X: Settings → «Download an archive of your data» → ZIP с папкой `data/`.
- Ключевые файлы: `tweets.js` (твиты), `direct-messages.js` (ЛС), `account.js`.
- ЛОВУШКИ (data-ingestion §«X-архив»):
  * Файлы — НЕ чистый JSON: обёрнуты в JS-присваивание
    `window.YTD.tweets.part0 = [ ... ]`. НАДО срезать префикс до первого `[`,
    затем `json.loads` остатка.
  * Счётчики (likes/retweets) в архиве часто обнулены — не полагаться на них.
  * `direct-messages.js` — это ЛС: высокий PII-риск, легко утекают.
- РЕКОМЕНДАЦИЯ research: срезать `window.YTD`-префикс; для ссылок использовать
  `expanded_url` (а не t.co); `direct-messages.js` и `account.js` — В КАРАНТИН
  (обрабатывать осторожно/опционально, не в публичный пример никогда).

Формат на выходе (когда реализуем): страница(ы) под `raw/x/` — твиты отдельно от
DM; provenance-frontmatter; watermark по tweet `id_str`/дате. КАЖДОЕ тело — через
`sanitizer.fail_closed_sanitize`; DM — отдельным, явно помеченным потоком.

Открытый вопрос (research): ингестить приватные DM или только публичный контент?
— закрыть политикой при реализации.

Реализация: прочитать файл как текст → срезать `... = ` префикс → json.loads →
нормализация (expanded_url) → sanitizer → raw/x/*.md →
Watermark.load(raw_dir, 'x'). DM — отдельная ветка с явным карантином.
"""

from __future__ import annotations

SOURCE_NAME = "x"


def ingest(*args, **kwargs):  # noqa: D401 — стаб
    """TODO: реализовать ингест архива X (`tweets.js`; DM — в карантин)."""
    raise NotImplementedError(
        "x_archive-коннектор — стаб. Источник: архив X → data/tweets.js (JS-обёртка "
        "window.YTD.tweets.part0 = [...]; срезать префикс до '[' и json.loads). "
        "Использовать expanded_url; direct-messages.js/account.js — в карантин. "
        "Затем: sanitizer.fail_closed_sanitize → raw/x/*.md → "
        "Watermark.load(raw_dir, 'x'). См. docs/research/data-ingestion.md."
    )


if __name__ == "__main__":
    raise SystemExit(ingest.__doc__ or "x_archive: стаб, не реализован")
