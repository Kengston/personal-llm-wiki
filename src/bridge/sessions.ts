/**
 * sessions.ts — чтение/поиск локальных сессий Claude Code для Telegram ([ADR-0017]).
 *
 * Источник — каталог `~/.claude/projects/<encoded-cwd>/`, который ведёт сам Claude
 * Code: пер-проектные транскрипты `*.jsonl` + (в свежем формате) `sessions-index.json`
 * с метаданными (`sessionId`, `projectPath`, `firstPrompt`, `messageCount`, `fileMtime`).
 *
 * ВСЁ ЛОКАЛЬНО ([ADR-0017] Решение 1): этот модуль только ПАРСИТ файлы на диске —
 * никакого облака, никакой выгрузки проектов. Движок (продолжение `/resume`) тоже
 * локальный бинарь `claude` в cwd проекта; в сеть уходит лишь контекст хода на инференс.
 *
 * Границы:
 *  - **Охват — deny-by-default** ([ADR-0017] Решение 5): показываем только сессии, чей
 *    `projectPath` лежит под `SESSIONS_ALLOWLIST`-префиксом. Пустой allowlist ⇒ ничего.
 *  - **Маскирование на отдачу** ([ADR-0011]): любой текст сессии, уходящий в Telegram,
 *    проходит `sanitizeText()` (маскирует секреты/PII, НЕ блокирует — read не должен
 *    падать на сессии, где когда-то светился токен). Это display-путь; инъекцию для
 *    `/resume` маскирует `failClosedSanitize` в app.ts (write-path, [ADR-0015] §2).
 *
 * Дешевизна листинга: для папок без индекса метаданные берём из ГОЛОВЫ транскрипта
 * (первые 64 КБ через readSync), а не читаем 600 МБ целиком. Полный файл читаем только
 * на `/session <id>` (хвост диалога) — один файл на команду.
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

import { childLogger } from '../core/logger.js';
import { sanitizeText } from '../ingest/sanitizer.js';

const log = childLogger('bridge.sessions');

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// --------------------------------------------------------------------------- //
// Конфигурация                                                                //
// --------------------------------------------------------------------------- //

export interface SessionsConfig {
	enabled: boolean; // SESSIONS_ENABLED=1 И непустой allowlist
	root: string; // каталог проектов Claude Code (дефолт ~/.claude/projects)
	allowlist: string[]; // абсолютные префиксы-пути проектов (deny-by-default: пусто ⇒ ничего)
	listLimit: number; // сколько сессий показывать в /sessions
	tailMessages: number; // сколько последних сообщений показывать в /session
}

/** Развернуть ведущий `~` в домашний каталог (значения allowlist/root пишут через ~). */
export function expandHome(p: string): string {
	if (p === '~') return homedir();
	if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
	return p;
}

/**
 * Собрать конфиг сессий из окружения. Реальные пути allowlist задаёт ПРИВАТНЫЙ `.env`
 * ([ADR-0003]); в публичном фреймворке дефолт — выключено (пустой allowlist).
 */
export function loadSessionsConfig(env: NodeJS.ProcessEnv = process.env): SessionsConfig {
	const root = resolve(
		expandHome((env.SESSIONS_ROOT ?? '').trim() || join(homedir(), '.claude', 'projects')),
	);
	const allowlist = (env.SESSIONS_ALLOWLIST ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => resolve(expandHome(s)));
	const listLimit = Number(env.SESSIONS_LIST_LIMIT ?? '15') || 15;
	const tailMessages = Number(env.SESSIONS_TAIL_MESSAGES ?? '6') || 6;
	// Включено ТОЛЬКО при явном флаге И непустом allowlist (deny-by-default, [ADR-0017]).
	const enabled = env.SESSIONS_ENABLED === '1' && allowlist.length > 0;
	return { enabled, root, allowlist, listLimit, tailMessages };
}

/** True, если projectPath лежит под одним из allowlist-префиксов. Пусто ⇒ false. */
export function isAllowed(projectPath: string, allowlist: string[]): boolean {
	if (!projectPath || allowlist.length === 0) return false;
	const p = resolve(projectPath);
	return allowlist.some((prefix) => p === prefix || p.startsWith(prefix + sep));
}

// --------------------------------------------------------------------------- //
// Модель метаданных сессии                                                    //
// --------------------------------------------------------------------------- //

export interface SessionMeta {
	sessionId: string;
	projectPath: string; // реальный cwd сессии — ключ для allowlist и для cwd `/resume`
	transcriptPath: string | null; // путь к .jsonl, если известен (для чтения хвоста)
	firstPrompt: string; // первое сообщение владельца (заголовок); сырое, маскируем на отдачу
	messageCount: number | null;
	modifiedMs: number;
	gitBranch: string | null;
}

export interface TailMessage {
	role: string; // 'user' | 'assistant'
	text: string; // сырой текст; маскируем на отдачу
}

export interface FindResult {
	meta: SessionMeta | null; // однозначно найдено
	ambiguous: SessionMeta[]; // несколько кандидатов по префиксу (для подсказки)
}

// --------------------------------------------------------------------------- //
// Низкоуровневое чтение транскриптов                                          //
// --------------------------------------------------------------------------- //

/** Прочитать первые maxBytes файла без загрузки целиком (для дешёвого листинга). */
function readHead(path: string, maxBytes = 65536): string {
	let fd: number | null = null;
	try {
		fd = openSync(path, 'r');
		const buf = Buffer.allocUnsafe(maxBytes);
		const n = readSync(fd, buf, 0, maxBytes, 0);
		return buf.toString('utf8', 0, n);
	} catch {
		return '';
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

/** Распарсить одну строку JSONL → объект-запись или null (битая/пустая строка). */
function parseLine(line: string): Record<string, unknown> | null {
	const t = line.trim();
	if (!t) return null;
	try {
		const v: unknown = JSON.parse(t);
		return isRecord(v) ? v : null;
	} catch {
		return null;
	}
}

/**
 * Достать человекочитаемый текст из `message.content` (строка ИЛИ массив блоков
 * text/tool_use/tool_result). Инструменты сворачиваем в компактную метку, чтобы не
 * вываливать tool-output (и его секреты/шум) в Telegram.
 */
function parseContentText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			if (!isRecord(block)) continue;
			if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
			else if (block.type === 'tool_use')
				parts.push(`[инструмент: ${typeof block.name === 'string' ? block.name : 'tool'}]`);
			else if (block.type === 'tool_result') parts.push('[результат инструмента]');
		}
		return parts.join(' ').trim();
	}
	return '';
}

// --------------------------------------------------------------------------- //
// Источники метаданных: индекс + fallback на транскрипт                       //
// --------------------------------------------------------------------------- //

/** Метаданные из `sessions-index.json` папки (авторитетный свежий формат). */
function parseIndex(folderPath: string): SessionMeta[] {
	let raw: string;
	try {
		raw = readFileSync(join(folderPath, 'sessions-index.json'), 'utf8');
	} catch {
		return []; // нет индекса — не ошибка, попробуем транскрипты
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		log.warn({ folderPath }, 'sessions.index_parse_failed');
		return [];
	}
	const entries = isRecord(parsed) && Array.isArray(parsed.entries) ? parsed.entries : [];
	const out: SessionMeta[] = [];
	for (const e of entries) {
		if (!isRecord(e)) continue;
		const sessionId = typeof e.sessionId === 'string' ? e.sessionId : '';
		const projectPath = typeof e.projectPath === 'string' ? e.projectPath : '';
		if (!sessionId || !projectPath) continue;
		const modifiedMs =
			typeof e.fileMtime === 'number'
				? e.fileMtime
				: typeof e.modified === 'string'
					? Date.parse(e.modified) || 0
					: 0;
		out.push({
			sessionId,
			projectPath,
			transcriptPath: typeof e.fullPath === 'string' ? e.fullPath : null,
			firstPrompt: typeof e.firstPrompt === 'string' ? e.firstPrompt : '',
			messageCount: typeof e.messageCount === 'number' ? e.messageCount : null,
			modifiedMs,
			gitBranch: typeof e.gitBranch === 'string' ? e.gitBranch : null,
		});
	}
	return out;
}

/** Метаданные из ГОЛОВЫ транскрипта (для папок без индекса). */
function deriveFromJsonl(jsonlPath: string): SessionMeta | null {
	const sessionId = basename(jsonlPath).replace(/\.jsonl$/, '');
	let mtimeMs: number;
	try {
		mtimeMs = statSync(jsonlPath).mtimeMs;
	} catch {
		return null;
	}
	let projectPath = '';
	let firstPrompt = '';
	let gitBranch: string | null = null;
	// Первая запись часто queue-operation с cwd:null — поэтому ищем первую запись С cwd.
	for (const line of readHead(jsonlPath).split('\n')) {
		const rec = parseLine(line);
		if (!rec) continue;
		if (!projectPath && typeof rec.cwd === 'string' && rec.cwd) projectPath = rec.cwd;
		if (!gitBranch && typeof rec.gitBranch === 'string' && rec.gitBranch) gitBranch = rec.gitBranch;
		if (!firstPrompt && rec.type === 'user' && isRecord(rec.message)) {
			const txt = parseContentText(rec.message.content);
			if (txt) firstPrompt = txt;
		}
		if (projectPath && firstPrompt) break;
	}
	if (!projectPath) return null; // проект не определён → в листинг не берём
	return {
		sessionId,
		projectPath,
		transcriptPath: jsonlPath,
		firstPrompt,
		messageCount: null,
		modifiedMs: mtimeMs,
		gitBranch,
	};
}

// --------------------------------------------------------------------------- //
// Публичный интерфейс: листинг / поиск / хвост                                //
// --------------------------------------------------------------------------- //

/** Все allowlisted-сессии, новейшие сверху. Индекс приоритетнее транскрипта; дедуп по id. */
export function listSessions(cfg: SessionsConfig): SessionMeta[] {
	let folders: string[];
	try {
		folders = readdirSync(cfg.root, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => join(cfg.root, d.name));
	} catch (err) {
		log.warn({ root: cfg.root, err: String(err) }, 'sessions.root_unreadable');
		return [];
	}

	const byId = new Map<string, SessionMeta>();
	for (const folder of folders) {
		// 1) индекс — авторитетно.
		for (const m of parseIndex(folder)) {
			if (isAllowed(m.projectPath, cfg.allowlist)) byId.set(m.sessionId, m);
		}
		// 2) транскрипты, не покрытые индексом.
		let files: string[];
		try {
			files = readdirSync(folder).filter((f) => f.endsWith('.jsonl'));
		} catch {
			files = [];
		}
		for (const f of files) {
			const sid = f.replace(/\.jsonl$/, '');
			if (byId.has(sid)) continue;
			const m = deriveFromJsonl(join(folder, f));
			if (m && isAllowed(m.projectPath, cfg.allowlist)) byId.set(m.sessionId, m);
		}
	}
	return [...byId.values()].sort((a, b) => b.modifiedMs - a.modifiedMs);
}

/** Найти сессию по полному id или однозначному префиксу. Иначе — список кандидатов. */
export function findSession(cfg: SessionsConfig, idOrPrefix: string): FindResult {
	const q = idOrPrefix.trim().toLowerCase();
	if (!q) return { meta: null, ambiguous: [] };
	const all = listSessions(cfg);
	const exact = all.find((s) => s.sessionId.toLowerCase() === q);
	if (exact) return { meta: exact, ambiguous: [] };
	const matches = all.filter((s) => s.sessionId.toLowerCase().startsWith(q));
	if (matches.length === 1) return { meta: matches[0] ?? null, ambiguous: [] };
	return { meta: null, ambiguous: matches.slice(0, 8) };
}

/** Последние n текстовых сообщений сессии (читает транскрипт целиком — один файл/команду). */
export function readSessionTail(meta: SessionMeta, n: number): TailMessage[] {
	const path = meta.transcriptPath;
	if (!path) return [];
	let raw: string;
	try {
		raw = readFileSync(path, 'utf8');
	} catch {
		return [];
	}
	const msgs: TailMessage[] = [];
	for (const line of raw.split('\n')) {
		const rec = parseLine(line);
		if (!rec) continue;
		if ((rec.type === 'user' || rec.type === 'assistant') && isRecord(rec.message)) {
			const role = typeof rec.message.role === 'string' ? rec.message.role : String(rec.type);
			const text = parseContentText(rec.message.content);
			if (text) msgs.push({ role, text });
		}
	}
	return msgs.slice(-Math.max(1, n));
}

// --------------------------------------------------------------------------- //
// Форматирование для Telegram (всё отображаемое — через sanitizeText)         //
// --------------------------------------------------------------------------- //

/** Схлопнуть пробелы и обрезать до max символов с многоточием. */
function clip(s: string, max: number): string {
	const one = s.replace(/\s+/g, ' ').trim();
	return one.length <= max ? one : one.slice(0, max - 1) + '…';
}

/** Абсолютная дата-время локально (без зависимостей; luxon тут избыточен). */
function fmtTime(ms: number): string {
	if (!ms) return '—';
	const d = new Date(ms);
	const pad = (x: number): string => String(x).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const shortId = (id: string): string => id.slice(0, 8);

export function formatSessionList(sessions: SessionMeta[], total: number, limit: number): string {
	if (sessions.length === 0) {
		return 'Сессий не нашёл. Проверь SESSIONS_ENABLED=1 и SESSIONS_ALLOWLIST в приватном .env.';
	}
	const lines = sessions.map((s) => {
		const cnt = s.messageCount != null ? `, ${s.messageCount} сообщ.` : '';
		const prompt = clip(sanitizeText(s.firstPrompt || '(без первого сообщения)'), 90);
		return `• ${shortId(s.sessionId)} · ${basename(s.projectPath)} · ${fmtTime(s.modifiedMs)}${cnt}\n  ${prompt}`;
	});
	const head = `Сессии (${sessions.length}${total > limit ? ` из ${total}` : ''}):`;
	const foot = '\nЧитать: /session <id> · Продолжить: /resume <id> <сообщение>';
	return [head, ...lines].join('\n') + foot;
}

export function formatSessionCard(meta: SessionMeta, tail: TailMessage[]): string {
	const head = [
		`Сессия ${shortId(meta.sessionId)} — ${basename(meta.projectPath)}`,
		`Проект: ${meta.projectPath}`,
		meta.gitBranch ? `Ветка: ${meta.gitBranch}` : null,
		`Изменена: ${fmtTime(meta.modifiedMs)}${meta.messageCount != null ? ` · ${meta.messageCount} сообщ.` : ''}`,
	]
		.filter(Boolean)
		.join('\n');
	const body = tail.length
		? tail
				.map((m) => `${m.role === 'user' ? '[ты]' : '[claude]'} ${clip(sanitizeText(m.text), 400)}`)
				.join('\n\n')
		: '(хвост диалога недоступен — транскрипт не найден; метаданные из индекса)';
	const foot = `\nПродолжить: /resume ${shortId(meta.sessionId)} <сообщение>`;
	return `${head}\n\n${body}\n${foot}`;
}

/** Подсказка при неоднозначном/пустом совпадении по id. */
export function formatAmbiguous(idOrPrefix: string, ambiguous: SessionMeta[]): string {
	if (ambiguous.length === 0) {
		return `Сессию «${idOrPrefix}» не нашёл среди разрешённых. Список: /sessions`;
	}
	const lines = ambiguous.map(
		(s) => `• ${shortId(s.sessionId)} · ${basename(s.projectPath)} · ${fmtTime(s.modifiedMs)}`,
	);
	return [`Под «${idOrPrefix}» подходит несколько — уточни id:`, ...lines].join('\n');
}
