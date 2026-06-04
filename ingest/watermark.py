"""Watermark — per-source курсор «дочитано до» для идемпотентного ингеста.

Инвариант (CONTEXT §3): курсор источника двигается ТОЛЬКО после успешной
записи → повторный ингест того же экспорта не плодит дубли и не пере-маскирует
уже записанное. Каждый источник (telegram/vk/whatsapp/youtube/x) держит свой
JSON-файл курсора.

Хранилище — простой JSON на диск, рядом с приватным `raw/` (путь задаёт
вызывающий: аргумент или env). Формат файла (один источник):

    {
      "source": "telegram",
      "cursor": {                     # произвольный для источника «прогресс»
        "last_message_id": 84231,
        "last_date_unixtime": 1717100000
      },
      "updated_at": "2026-05-31T12:00:00+00:00",
      "runs": 3                        # счётчик успешных продвижений (аудит)
    }

Зависимости: только stdlib. Совместимость: Python 3.9+.

Использование (паттерн «advance-only-after-write»):

    wm = Watermark.load(state_dir, "telegram")
    if wm.is_seen_message(msg_id):        # уже за курсором — пропустить
        continue
    ... записать сообщение в raw/ ...
    wm.advance(last_message_id=msg_id, last_date_unixtime=ts)
    # ВАЖНО: wm.save() вызывать ТОЛЬКО после успешной записи всех файлов.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional


# Имя поддиректории под курсоры внутри state-dir. Держим отдельно от raw/,
# чтобы курсоры (служебные) не путались с immutable-снапшотами.
WATERMARK_SUBDIR = ".watermarks"


def _utcnow_iso() -> str:
    """Текущее UTC-время в ISO 8601 с таймзоной (house style: ISO-даты)."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class Watermark:
    """Курсор одного источника. Мутируется в памяти через advance(), на диск
    попадает только явным save() — чтобы соблюсти «advance-only-after-write»."""

    source: str                                   # имя источника: telegram | vk | ...
    path: Path                                    # путь к JSON-файлу курсора
    cursor: Dict[str, Any] = field(default_factory=dict)  # произвольный прогресс
    updated_at: Optional[str] = None              # ISO-время последнего save()
    runs: int = 0                                 # счётчик успешных продвижений

    # ---- загрузка / расположение ----

    @staticmethod
    def state_path(state_dir: os.PathLike | str, source: str) -> Path:
        """Путь к файлу курсора для источника внутри state_dir/.watermarks/."""
        return Path(state_dir) / WATERMARK_SUBDIR / ("%s.json" % source)

    @classmethod
    def load(cls, state_dir: os.PathLike | str, source: str) -> "Watermark":
        """Читает курсор источника; если файла нет — возвращает пустой (runs=0).

        Битый/нечитаемый JSON трактуем как «курсора нет» (fail-safe: лучше
        пере-проиграть экспорт идемпотентно, чем упасть на старте). Дедуп всё
        равно защитит от дублей, если источник идемпотентно сравнивается по id.
        """
        path = cls.state_path(state_dir, source)
        if not path.exists():
            return cls(source=source, path=path)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            # Не падаем: стартуем с чистого курсора (idempotent re-ingest спасёт).
            return cls(source=source, path=path)
        return cls(
            source=data.get("source", source),
            path=path,
            cursor=dict(data.get("cursor", {})),
            updated_at=data.get("updated_at"),
            runs=int(data.get("runs", 0)),
        )

    # ---- продвижение (в памяти) ----

    def advance(self, **cursor_fields: Any) -> None:
        """Обновляет поля курсора В ПАМЯТИ (не пишет на диск).

        Принимает произвольные поля прогресса источника, напр.:
            wm.advance(last_message_id=84231, last_date_unixtime=1717100000)
        На диск изменения попадут только при save() — после успешной записи raw/.
        """
        for key, value in cursor_fields.items():
            self.cursor[key] = value

    def is_seen_message(self, message_id: Any) -> bool:
        """True, если message_id <= last_message_id курсора (уже ингестирован).

        Хелпер для источников с монотонным числовым id (Telegram). Работает
        только если в курсоре есть `last_message_id`; иначе всё «новое».
        """
        last = self.cursor.get("last_message_id")
        if last is None or message_id is None:
            return False
        try:
            return int(message_id) <= int(last)
        except (TypeError, ValueError):
            return False

    # ---- сохранение (атомарно, advance-only-after-write) ----

    def save(self) -> None:
        """Атомарно пишет курсор на диск. Вызывать ТОЛЬКО после успешной записи
        всех raw/-файлов соответствующего прогона (инвариант идемпотентности).

        Атомарность: пишем во временный файл в той же директории и делаем
        os.replace() — частично записанный курсор не появится даже при сбое
        посреди записи.
        """
        self.runs += 1
        self.updated_at = _utcnow_iso()
        payload = {
            "source": self.source,
            "cursor": self.cursor,
            "updated_at": self.updated_at,
            "runs": self.runs,
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Временный файл в той же папке → os.replace атомарен на том же томе.
        fd, tmp_name = tempfile.mkstemp(
            dir=str(self.path.parent), prefix=self.path.name + ".", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False, indent=2, sort_keys=True)
                fh.write("\n")
            os.replace(tmp_name, self.path)
        except Exception:
            # Чистим временный файл, чтобы не оставить мусор; ошибку пробрасываем.
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise


# ---------------------------------------------------------------------------
# __main__ — самотест (во временной директории, без побочных эффектов в репо).
# ---------------------------------------------------------------------------

def _selftest() -> int:
    import shutil

    print("watermark selftest\n")
    failures = 0
    tmp = Path(tempfile.mkdtemp(prefix="wm-selftest-"))
    try:
        # Пустой курсор на старте.
        wm = Watermark.load(tmp, "telegram")
        assert wm.runs == 0 and wm.cursor == {}, "новый курсор должен быть пустым"
        assert not wm.is_seen_message(1), "пустой курсор ничего не видел"
        print("  [ok]   пустой курсор")

        # Продвижение + сохранение.
        wm.advance(last_message_id=100, last_date_unixtime=1717100000)
        wm.save()
        assert wm.runs == 1, "runs должен стать 1 после save"
        print("  [ok]   advance + save")

        # Перечитали — состояние сохранилось.
        wm2 = Watermark.load(tmp, "telegram")
        assert wm2.cursor.get("last_message_id") == 100, "курсор не перечитался"
        assert wm2.is_seen_message(50), "id ниже курсора — уже виден"
        assert wm2.is_seen_message(100), "id == курсор — уже виден"
        assert not wm2.is_seen_message(101), "id выше курсора — новый"
        print("  [ok]   перечитка + дедуп по id")

        # Битый JSON → fail-safe пустой курсор.
        path = Watermark.state_path(tmp, "broken")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{ это не json", encoding="utf-8")
        wm3 = Watermark.load(tmp, "broken")
        assert wm3.cursor == {}, "битый JSON → чистый курсор"
        print("  [ok]   битый JSON -> чистый курсор")

    except AssertionError as exc:
        failures += 1
        print("  [FAIL] %s" % exc)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    print("ИТОГ: %s" % ("все проверки прошли" if not failures else "%d упало" % failures))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(_selftest())
