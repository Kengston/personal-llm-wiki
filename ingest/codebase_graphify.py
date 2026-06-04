"""codebase_graphify — коннектор кодовых баз через graphify (СТАБ / TODO).

Статус: НЕ реализован в v1. ОСОБЫЙ трек — отличается от остальных коннекторов.

⚠ ВАЖНОЕ ОТЛИЧИЕ (data-ingestion §«graphify», §«Подводные камни»):
- Код — это НЕ PII, поэтому этот трек **МИНУЕТ sanitizer** (в отличие от всех
  остальных источников, где `fail_closed_sanitize` обязателен). Гонять код через
  sanitizer бессмысленно и вредно (искалечит идентификаторы).
- НО: реальный PII в публичных фикстурах/примерах ломает границу двух репо.
  Поэтому артефакты graphify держим в ПРИВАТНОМ репо (`raw/`), а в публичный
  пример кладём только синтетику. `.gitignore` приватного — на рабочий каталог
  `graphify-out/` (как в abcage-wiki .gitignore).

Механизм (по research):
- PyPI-пакет называется **`graphifyy`** (ДВЕ «y» — частая ошибка!), ингестит
  кодовую базу ЛОКАЛЬНО через tree-sitter.
- Выдаёт `graph.json` с узлами/рёбрами и тегами **EXTRACTED** (точно из кода) /
  **INFERRED** (выведено эвристикой).
- В этом проекте также есть скилл `/graphify` (см. ~/.claude/skills/graphify) —
  альтернативный способ построить граф код→сообщество с `graph.html` + `graph.json`
  + аудит-отчётом.

Формат на выходе (когда реализуем): коммитить `graph.json` (артефакт-источник
истины графа) под `raw/code/<repo>/graph.json` приватного репо; рабочий каталог
`graphify-out/` — в `.gitignore`. Никогда не гнать код через sanitizer.

Реализация: запустить `graphifyy` (или скилл /graphify) на путь к репо → собрать
`graph.json` → положить в raw/code/<repo>/ → (опц.) Watermark по git-commit-хэшу
обработанного среза. SANITIZER НЕ ПРИМЕНЯТЬ.
"""

from __future__ import annotations

SOURCE_NAME = "code"


def ingest(*args, **kwargs):  # noqa: D401 — стаб
    """TODO: реализовать код-трек через graphifyy (МИНУЯ sanitizer)."""
    raise NotImplementedError(
        "codebase_graphify-коннектор — стаб. ОСОБЫЙ трек: пакет `graphifyy` "
        "(двойная y) или скилл /graphify строит graph.json локально через "
        "tree-sitter (теги EXTRACTED/INFERRED). Код — НЕ PII → этот трек МИНУЕТ "
        "sanitizer. Коммитить graph.json в raw/code/<repo>/; graphify-out/ — в "
        ".gitignore. См. docs/research/data-ingestion.md."
    )


if __name__ == "__main__":
    raise SystemExit(ingest.__doc__ or "codebase_graphify: стаб, не реализован")
