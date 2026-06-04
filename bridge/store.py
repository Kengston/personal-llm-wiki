"""
store.py — персистентность непрерывности диалога.

Одна крошечная SQLite-таблица `chat_sessions(chat_id PK, engine_session_id, updated_at)` —
карта «чат Telegram → сессия движка». Нужна, чтобы продолжать диалог через resume
движка (для дефолтного Claude — `claude -p --resume <session_id>`, [ADR-0008]).
Колонка engine-agnostic: один и тот же столбец хранит session_id любого адаптера
(Claude/Grok/Codex) — store не знает, какой движок включён.

Это НЕ нарушает [ADR-0002] (no embedder/вектора): запрет относится к ВИКИ, а не
к любой служебной БД. Здесь нет ни эмбеддингов, ни семантического поиска — только
key-value-карта chat_id→session_id.

Доступ — через asyncio.to_thread поверх синхронного sqlite3 (драйвер не async, но
операции микроскопические; держим один модульный коннект под lock'ом). Каждый chat_id
дополнительно сериализуется single-flight-локом в worker'е (app.py), так что гонок
за одну сессию нет.

[ADR-0002]: ../docs/adr/0002-no-embedder-pure-karpathy.md
"""

from __future__ import annotations

import asyncio
import sqlite3
import time
from pathlib import Path

import structlog

log = structlog.get_logger(__name__)


# DDL таблицы. chat_id — PK (один чат = одна активная сессия).
_SCHEMA = """
CREATE TABLE IF NOT EXISTS chat_sessions (
    chat_id           INTEGER PRIMARY KEY,   -- id чата Telegram (для 1:1 == user_id)
    engine_session_id TEXT    NOT NULL,      -- session_id движка для resume (любой адаптер)
    updated_at        INTEGER NOT NULL       -- unix-время последнего апдейта (epoch sec)
);
"""


class SessionStore:
    """
    Тонкая обёртка над SQLite-таблицей chat_sessions.

    Async-фасад (get/upsert/reset) поверх синхронного sqlite3: реальные вызовы
    уходят в пул потоков через asyncio.to_thread, чтобы не блокировать event-loop
    FastAPI. Внутренний lock сериализует доступ к единственному коннекту.
    """

    def __init__(self, db_path: str | Path) -> None:
        self._db_path = str(db_path)
        # check_same_thread=False: коннект используется из разных потоков пула,
        # но мы сами сериализуем доступ через self._lock — гонок нет.
        self._conn = sqlite3.connect(self._db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        # WAL — лучше для конкурентного чтения/записи; durable достаточно для карты сессий.
        self._conn.execute("PRAGMA journal_mode=WAL;")
        self._conn.executescript(_SCHEMA)
        self._conn.commit()
        self._lock = asyncio.Lock()
        log.info("store.ready", db_path=self._db_path)

    async def get_session(self, chat_id: int) -> str | None:
        """Вернуть engine_session_id для чата, либо None если диалог ещё не начат."""

        def _query() -> str | None:
            row = self._conn.execute(
                "SELECT engine_session_id FROM chat_sessions WHERE chat_id = ?",
                (chat_id,),
            ).fetchone()
            return row["engine_session_id"] if row else None

        async with self._lock:
            return await asyncio.to_thread(_query)

    async def upsert_session(self, chat_id: int, session_id: str) -> None:
        """
        Сохранить/обновить session_id для чата (UPSERT по chat_id).

        Вызывается после успешного хода движка с актуальным session_id —
        так следующий ход в этом чате пойдёт через resume.
        """
        now = int(time.time())

        def _write() -> None:
            self._conn.execute(
                """
                INSERT INTO chat_sessions (chat_id, engine_session_id, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(chat_id) DO UPDATE SET
                    engine_session_id = excluded.engine_session_id,
                    updated_at        = excluded.updated_at
                """,
                (chat_id, session_id, now),
            )
            self._conn.commit()

        async with self._lock:
            await asyncio.to_thread(_write)
        log.debug("store.upsert", chat_id=chat_id, session_id=session_id)

    async def reset_session(self, chat_id: int) -> None:
        """
        Забыть сессию чата (следующий ход начнёт новую).

        Полезно для команды /reset и как recovery, если resume сломался
        (напр. сессия движка протухла/удалена на диске).
        """

        def _delete() -> None:
            self._conn.execute(
                "DELETE FROM chat_sessions WHERE chat_id = ?", (chat_id,)
            )
            self._conn.commit()

        async with self._lock:
            await asyncio.to_thread(_delete)
        log.info("store.reset", chat_id=chat_id)

    async def close(self) -> None:
        """Закрыть коннект (на shutdown моста)."""
        async with self._lock:
            await asyncio.to_thread(self._conn.close)
        log.info("store.closed")
