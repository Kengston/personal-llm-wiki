/**
 * store.ts — персистентность непрерывности диалога (chat_id → session_id движка).
 *
 * Порт `bridge/store.py` ([ADR-0012]). Одна крошечная таблица
 * `chat_sessions(chat_id PK, engine_session_id, updated_at)`. Колонка
 * engine-agnostic: хранит session_id любого адаптера (Claude/Grok/Codex).
 *
 * НЕ нарушает [ADR-0002] (no embedder/вектора): запрет — про ВИКИ, а не про любую
 * служебную БД. Здесь только key-value chat_id→session_id.
 *
 * Бэкенд — встроенный синхронный `node:sqlite` ([ADR-0012]): драйвер синхронный и
 * быстрый, event-loop однопоточный, а каждый chat_id сериализуется Mutex'ом в
 * воркере (app.ts) — поэтому async/lock-обвязка Python тут не нужна. Стор за
 * интерфейсом → бэкенд при желании меняется одним файлом.
 */
import { createRequire } from 'node:module';

import type { DatabaseSync as DatabaseSyncClass } from 'node:sqlite';

// node:sqlite — экспериментальный билтин Node 24+. Грузим через createRequire,
// чтобы бандлеры (vite под vitest) не резолвили его статически как файл-модуль.
// Типы берём type-only импортом (стирается компилятором, в рантайм не попадает).
const nodeRequire = createRequire(import.meta.url);
let DatabaseSync: typeof DatabaseSyncClass;
try {
	({ DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: typeof DatabaseSyncClass });
} catch (exc) {
	// node:sqlite стабилен с Node 24 (с 22.5 — за флагом --experimental-sqlite).
	throw new Error(
		`node:sqlite недоступен — нужен Node >=24 (или >=22.5 с --experimental-sqlite). ` +
			`Текущая версия: ${process.version}. См. setup/SETUP.md.`,
		{ cause: exc },
	);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_sessions (
    chat_id           INTEGER PRIMARY KEY,
    engine_session_id TEXT    NOT NULL,
    updated_at        INTEGER NOT NULL
);
`;

interface SessionRow {
	engine_session_id: string;
}

export class SessionStore {
	private readonly db: DatabaseSyncClass;

	constructor(dbPath: string) {
		this.db = new DatabaseSync(dbPath);
		// WAL — лучше для конкурентного чтения/записи; durable достаточно.
		this.db.exec('PRAGMA journal_mode=WAL;');
		this.db.exec(SCHEMA);
	}

	/** engine_session_id чата, либо null если диалог ещё не начат. */
	getSession(chatId: number): string | null {
		const row = this.db
			.prepare('SELECT engine_session_id FROM chat_sessions WHERE chat_id = ?')
			.get(chatId) as SessionRow | undefined;
		return row ? row.engine_session_id : null;
	}

	/** UPSERT session_id чата — следующий ход пойдёт через resume. */
	upsertSession(chatId: number, sessionId: string): void {
		this.db
			.prepare(
				`INSERT INTO chat_sessions (chat_id, engine_session_id, updated_at)
				 VALUES (?, ?, ?)
				 ON CONFLICT(chat_id) DO UPDATE SET
				     engine_session_id = excluded.engine_session_id,
				     updated_at        = excluded.updated_at`,
			)
			.run(chatId, sessionId, Math.floor(Date.now() / 1000));
	}

	/** Забыть сессию чата (команда /reset, recovery при протухшем resume). */
	resetSession(chatId: number): void {
		this.db.prepare('DELETE FROM chat_sessions WHERE chat_id = ?').run(chatId);
	}

	/** Закрыть коннект (на shutdown моста). */
	close(): void {
		this.db.close();
	}
}
