/**
 * watermark.ts — per-source курсор «дочитано до» для идемпотентного ингеста.
 *
 * Порт `ingest/watermark.py` ([ADR-0012]). Инвариант (CONTEXT §3): курсор
 * источника двигается ТОЛЬКО после успешной записи → повторный ингест того же
 * экспорта не плодит дубли. Каждый источник держит свой JSON-файл курсора.
 *
 * Паттерн «advance-only-after-write»:
 *   const wm = Watermark.load(stateDir, 'telegram');
 *   if (wm.isSeenMessage(msgId)) continue;     // уже за курсором — пропустить
 *   ... записать сообщение в raw/ ...
 *   wm.advance({ last_message_id: msgId, last_date_unixtime: ts });
 *   wm.save();  // ТОЛЬКО после успешной записи всех файлов
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Поддиректория под курсоры внутри state-dir (отдельно от immutable raw/).
const WATERMARK_SUBDIR = '.watermarks';

/** Рекурсивно сортирует ключи объекта (детерминированный on-disk JSON, как Python sort_keys). */
function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(value as Record<string, unknown>).sort()) {
			out[k] = sortKeys((value as Record<string, unknown>)[k]);
		}
		return out;
	}
	return value;
}

export class Watermark {
	source: string;
	path: string;
	cursor: Record<string, unknown>;
	updatedAt: string | null;
	runs: number;

	constructor(
		source: string,
		path: string,
		cursor: Record<string, unknown> = {},
		updatedAt: string | null = null,
		runs = 0,
	) {
		this.source = source;
		this.path = path;
		this.cursor = cursor;
		this.updatedAt = updatedAt;
		this.runs = runs;
	}

	/** Путь к файлу курсора для источника внутри state_dir/.watermarks/. */
	static statePath(stateDir: string, source: string): string {
		return join(stateDir, WATERMARK_SUBDIR, `${source}.json`);
	}

	/**
	 * Читает курсор источника; если файла нет или JSON битый — пустой курсор
	 * (fail-safe: лучше идемпотентно пере-проиграть экспорт, чем упасть на старте).
	 */
	static load(stateDir: string, source: string): Watermark {
		const path = Watermark.statePath(stateDir, source);
		if (!existsSync(path)) return new Watermark(source, path);
		let data: Record<string, unknown>;
		try {
			data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
		} catch {
			return new Watermark(source, path);
		}
		const cursor = data['cursor'];
		return new Watermark(
			typeof data['source'] === 'string' ? data['source'] : source,
			path,
			cursor && typeof cursor === 'object' ? { ...(cursor as Record<string, unknown>) } : {},
			typeof data['updated_at'] === 'string' ? data['updated_at'] : null,
			Number(data['runs'] ?? 0),
		);
	}

	/** Обновляет поля курсора В ПАМЯТИ (не пишет на диск). */
	advance(fields: Record<string, unknown>): void {
		for (const [key, value] of Object.entries(fields)) this.cursor[key] = value;
	}

	/** True, если message_id <= last_message_id курсора (уже ингестирован). */
	isSeenMessage(messageId: unknown): boolean {
		const last = this.cursor['last_message_id'];
		if (last === null || last === undefined || messageId === null || messageId === undefined) {
			return false;
		}
		const a = Number(messageId);
		const b = Number(last);
		if (Number.isNaN(a) || Number.isNaN(b)) return false;
		return a <= b;
	}

	/**
	 * Атомарно пишет курсор на диск (temp + rename). Вызывать ТОЛЬКО после успешной
	 * записи всех raw/-файлов прогона (инвариант идемпотентности).
	 */
	save(): void {
		this.runs += 1;
		this.updatedAt = new Date().toISOString();
		const payload = {
			source: this.source,
			cursor: this.cursor,
			updated_at: this.updatedAt,
			runs: this.runs,
		};
		mkdirSync(dirname(this.path), { recursive: true });
		// Временный файл в той же папке → rename атомарен на том же томе.
		const tmp = `${this.path}.${process.pid}.${this.runs}.tmp`;
		try {
			writeFileSync(tmp, JSON.stringify(sortKeys(payload), null, 2) + '\n', 'utf8');
			renameSync(tmp, this.path);
		} catch (e) {
			try {
				unlinkSync(tmp);
			} catch {
				// игнор: временный файл мог не создаться
			}
			throw e;
		}
	}
}
