# Лог примерной вики (СИНТЕТИКА)

> ⚠️ **СИНТЕТИЧЕСКИЕ ДЕМО-ДАННЫЕ.** Все записи, даты и факты ниже выдуманы — это иллюстрация формата `log.md`, не реальная история.

Хронологический append-only журнал. Префикс `## [YYYY-MM-DD] <verb> | <scope> | <detail>` (домашний формат LLM-wiki) — парсится грепом: `grep "^## \[" log.md | tail -5`. Свежие записи — сверху.

Verbs: `ingest` · `query` · `lint` · `note` · `decision` · `fired`.

---

## [2025-01-20] lint | проверка связности примерной вики | 0 орфанов, 0 битых ссылок

Периодический проход по [index.md](index.md): у каждой страницы есть `## Связанные` и входящая ссылка из индекса; относительные ссылки резолвятся; `last_updated` совпадает с последней правкой. Орфанов нет. Напоминание про устаревание не сработало (корпус свежий).

## [2025-01-16] fired | scheduler sweep | resurface-idea-sunrise-lamp-2025-01-15

Проактивный sweep (launchd) выявил due-напоминание `kind=spaced` box 0 → пушнул в Telegram «всплытие идеи: лампа-будильник — ещё актуально?». Владелец ответил «ещё актуально» → box продвинут 0→1, следующий `due_at` = +3 дня. Подробности формата — [reminders/example.md](reminders/example.md).

## [2025-01-15] query | «что подарить Ивану на ДР?» | ответ из people/ivan-primer.md

Запрос из Telegram. Прочитал [index.md](index.md) → [people/ivan-primer.md](people/ivan-primer.md): собрал идеи подарков (деревянные миплы — из `keep`-заметки, зёрна светлой обжарки, дополнение к Spirit Island) с учётом негатив-факта «не ест острое». Ответ-стоящего-хранения не возникло — новую страницу не заводил.

## [2025-01-15] ingest | дневник 2025-01-15 | +3 страницы, +1 reminder

Захвачена дневниковая запись [journal/2025-01-15.md](journal/2025-01-15.md). Извлечено и разнесено по правилу «вика ↔ reminders» ([CONTEXT §2](../CONTEXT.md)):
- стабильное → вика: новая идея [ideas/sample-idea.md](ideas/sample-idea.md), старт цели [growth/sample-goal.md](growth/sample-goal.md), апдейт [people/ivan-primer.md](people/ivan-primer.md) (февральская игротека);
- эфемерное / due → reminders: one-off «подарок Ивану», spaced «всплытие идеи про лампу» ([reminders/example.md](reminders/example.md));
- индекс [index.md](index.md) обновлён.

## [2024-11-03] ingest | знакомство с Иваном Примером | +1 person

Из синтетического Telegram-снапшота `raw/telegram/ivan-primer-2024-11-03.md` заведена страница [people/ivan-primer.md](people/ivan-primer.md): контакт, день рождения `1990-05-31` (→ frontmatter `birthday`, источник истины для yearly-напоминания), предпочтения (настолки, фильтр-кофе), негатив-факт (не ест острое). Добавлена в [index.md](index.md).
