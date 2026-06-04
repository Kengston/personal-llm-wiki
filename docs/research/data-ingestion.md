---
title: Ингест данных и парсеры
type: audit
status: verified
last_updated: 2026-05-31
sources:
  - https://core.telegram.org/import-export
  - https://github.com/Pustur/whatsapp-chat-parser
  - https://github.com/safishamsi/graphify
---

# Ингест данных и парсеры

> Направление: ингест личных источников (переписки, история, посты, кодовые базы) в `raw/` через fail-closed-sanitizer. Обосновывает CONTEXT §6 OQ-1 (приоритет источников) и инварианты read-only/watermark/sanitizer.

## Вывод

Telegram JSON-экспорт `result.json` — лучший первый источник; парсить `text_entities`, не полиморфное поле `text`. Порядок источников (OQ-1) подтверждён: Telegram → YouTube → X → VK → WhatsApp. Парсеры — stdlib-only в `ingest`; вендорить парсер только для WhatsApp (невидимые управляющие символы + iOS-vs-Android-форматы). Нормализация — в immutable `raw/`, затем markdown с provenance-frontmatter + watermark, всё за fail-closed-sanitizer. graphify (кодовые базы) — параллельный трек, минующий sanitizer (код — не PII).

## Ключевые находки

### Telegram — лучший первый источник
Telegram JSON-экспорт `result.json` — лучший первый источник; парсить `text_entities`, не полиморфное поле `text`. Источник: Telegram core import-export schema. (high)

### YouTube Takeout
`watch-history.json` — плоский массив; многие записи лишены `titleUrl` и должны фильтроваться. Источник: реальный сэмпл GustavoMF31. (high)

### X-архив
`tweets.js` обёрнут в JS `window.YTD.tweets.part0`; срезать префикс, потом `json.loads`; DM — PII-риск. Источник: tweetarchivist. (high)

### WhatsApp
`_chat.txt` имеет форматы iOS vs Android и невидимые LRM (U+200E) и NNBSP (U+202F); использовать поддерживаемый парсер. Источник: Pustur-парсер. (medium)

### VK
Нет чистого JSON-экспорта; предпочесть API, а не windows-1251 HTML GDPR-архив. Источник: zenwarr. (medium)

### graphify
PyPI-пакет `graphifyy` ингестит кодовые базы локально через tree-sitter; выдаёт `graph.json` с тегами EXTRACTED/INFERRED. Источник: graphify README. (high)

### Порядок ингеста
Telegram → YouTube → X → VK → WhatsApp; graphify — параллельный трек, минующий sanitizer. Источник: CONTEXT OQ-1. (high)

### Нормализация
В immutable `raw/`, затем markdown с provenance-frontmatter и watermark, за fail-closed-sanitizer. Источник: abcage CLAUDE.md. (high)

## Сравнение источников

| Источник | Формат экспорта | Ключевая ловушка парсинга | Путь v1 | PII-риск |
|---|---|---|---|---|
| **Telegram** (первый) | `result.json` (штатный) | `text` полиморфно → парсить `text_entities`; UTF-16-офсеты; большой файл OOM'ит `json.load` | stdlib | средний |
| YouTube | Takeout `watch-history.json` | плоский массив; записи без `titleUrl` | stdlib | низкий |
| X | архив `tweets.js` | JS-обёртка `window.YTD.tweets.part0`; DM в `direct-messages.js` | stdlib (срезать префикс) | высокий (DM) |
| VK | windows-1251 HTML GDPR-архив | нет чистого JSON; кодировка не UTF-8 | API > HTML | средний |
| WhatsApp | `_chat.txt` | невидимые LRM/NNBSP + iOS-vs-Android + локали дат | вендорить парсер | средний |
| Код (graphify) | `graph.json` (tree-sitter) | n/a — **минует sanitizer** | `graphifyy` | n/a (код) |

## Рекомендации

- **Stdlib-only парсеры в `ingest`;** вендорить парсер только для WhatsApp.
- **Telegram:** парсить `text_entities`, watermark от `id` плюс `date_unixtime`, выделять service-сообщения.
- **YouTube:** взять JSON, скипать записи без `titleUrl`, выводить id из `titleUrl` и первого `subtitles`-url.
- **X:** срезать `window.YTD`-префикс, использовать `expanded_url`, в карантин `direct-messages.js` и `account.js`.
- **VK:** предпочесть API, а не windows-1251 HTML-архив; одна md-страница на диалог с `peer_id`.
- **Порядок:** Telegram, YouTube, X, VK, WhatsApp; доказать sanitizer сначала на Telegram.
- **graphify:** подключить как отдельный код-трек (`graphifyy`); коммитить `graph.json`; `.gitignore` на `graphify-out`; никогда не гнать код через sanitizer.

## Подводные камни

- Полиморфизм Telegram `text` крашит наивную string-обработку; предпочесть `text_entities`; UTF-16-офсеты.
- Невидимые WhatsApp LRM и NNBSP плюс iOS-vs-Android-формат и locale-даты ломают regex.
- YouTube non-video-записи загрязняют per-channel-статистику; X-счётчики обнулены и DM легко утекают.
- VK GDPR-архив HTML — windows-1251, не UTF-8; большой Telegram `result.json` OOM'ит наивный `json.load`.
- graphify — это `graphifyy` (double-y) и минует sanitizer; реальный PII в публичных фикстурах ломает границу двух репо.

## Открытые вопросы

- VK v1-путь: HTML-архив vs VK API?
- Держать WhatsApp в v1 или отложить?
- Транскрибировать медиа faster-whisper или скипнуть в v1?
- Ингестить приватные DM или только публичный контент?

## Связанные

- [README.md](README.md) · [../../CONTEXT.md](../../CONTEXT.md) · [privacy-security.md](privacy-security.md) · [memory-architecture.md](memory-architecture.md)
