/**
 * telegram-export.ts — парсер Telegram Desktop `result.json` → sanitized markdown.
 *
 * Порт `ingest/telegram_export.py` ([ADR-0012]). Главный источник: штатный JSON-
 * экспорт Telegram Desktop. Пишет одну страницу на диалог в raw/ с provenance-
 * frontmatter, прогоняя КАЖДОЕ тело через fail-closed-sanitizer и двигая watermark
 * только после успешной записи.
 *
 * Уроки research: парсим `text_entities` (НЕ полиморфное `text`); watermark по id +
 * date_unixtime; service-сообщения отдельно; raw/ immutable.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { isMainModule } from '../core/cli.js';
import { failClosedSanitize, SanitizerError } from './sanitizer.js';
import { Watermark } from './watermark.js';

const SOURCE_NAME = 'telegram';

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// --- Извлечение плоского текста из text_entities ------------------------------
export function extractText(message: Record<string, unknown>): string {
	const entities = message.text_entities;
	if (Array.isArray(entities) && entities.length) {
		const parts: string[] = [];
		for (const ent of entities) {
			if (isRecord(ent)) parts.push(String(ent.text ?? ''));
			else if (typeof ent === 'string') parts.push(ent);
		}
		return parts.join('');
	}
	const rawText = message.text;
	if (typeof rawText === 'string') return rawText;
	if (Array.isArray(rawText)) {
		const parts: string[] = [];
		for (const chunk of rawText) {
			if (typeof chunk === 'string') parts.push(chunk);
			else if (isRecord(chunk)) parts.push(String(chunk.text ?? ''));
		}
		return parts.join('');
	}
	return '';
}

function describeMedia(message: Record<string, unknown>): string | null {
	if (message.photo) return '[media: photo]';
	if (message.media_type) return `[media: ${String(message.media_type)}]`;
	if (message.file) {
		const name = message.file_name || basename(String(message.file));
		return `[file: ${name}]`;
	}
	if (message.poll) return '[poll]';
	if (message.location_information) return '[location]';
	return null;
}

// --- Нормализация сообщения ---------------------------------------------------
export interface ParsedMessage {
	id: number;
	dateUnixtime: number;
	dateIso: string;
	sender: string;
	isService: boolean;
	body: string; // ещё НЕ санитизирован
}

function toInt(value: unknown, def = 0): number {
	const n = typeof value === 'number' ? value : parseInt(String(value), 10);
	return Number.isFinite(n) ? Math.trunc(n) : def;
}

function isoFromUnixtime(unixtime: number, fallback: string): string {
	if (unixtime > 0) return new Date(unixtime * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
	return fallback;
}

export function parseMessage(message: Record<string, unknown>): ParsedMessage | null {
	const msgType = message.type ?? 'message';
	const isService = msgType === 'service';

	const mid = toInt(message.id);
	const unixtime = toInt(message.date_unixtime);
	const dateIso = isoFromUnixtime(unixtime, String(message.date ?? ''));

	if (isService) {
		const actor = message.actor || message.from || 'система';
		const action = message.action ?? 'service';
		return { id: mid, dateUnixtime: unixtime, dateIso, sender: String(actor), isService: true, body: `${action}: ${actor}` };
	}

	const sender = String(message.from || message.author || 'неизвестно');
	const text = extractText(message);
	const media = describeMedia(message);

	let body = [text.trim(), media].filter(Boolean).join(' ').trim();
	if (message.reply_to_message_id) body = `(ответ на #${toInt(message.reply_to_message_id)}) ${body}`;
	if (message.forwarded_from) body = `(переслано от ${String(message.forwarded_from)}) ${body}`;

	if (!body) return null;
	return { id: mid, dateUnixtime: unixtime, dateIso, sender, isService: false, body };
}

// --- Загрузка + итерация по чатам ---------------------------------------------
export function* iterChats(exportData: Record<string, unknown>): Generator<Record<string, unknown>> {
	if ('messages' in exportData && !('chats' in exportData)) {
		yield exportData;
		return;
	}
	for (const containerKey of ['chats', 'left_chats']) {
		const container = exportData[containerKey];
		if (isRecord(container) && Array.isArray(container.list)) {
			for (const chat of container.list) {
				if (isRecord(chat)) yield chat;
			}
		}
	}
}

export function loadExport(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

// --- Сборка страницы ----------------------------------------------------------
function slugify(name: string, chatId: unknown): string {
	let asciiPart = name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
	if (!asciiPart) asciiPart = 'chat';
	return `${asciiPart.slice(0, 40)}-${chatId}`;
}

export interface BuildPageResult {
	markdown: string | null;
	nWritten: number;
	maxId: number | null;
	maxUnixtime: number | null;
}

/** Собирает страницу диалога. markdown=null, если нет НОВЫХ сообщений. Бросает SanitizerError. */
export function buildPage(
	chat: Record<string, unknown>,
	exportMeta: { name: string },
	wm: Watermark,
): BuildPageResult {
	const chatName = String(chat.name || 'Без названия');
	const chatId = chat.id ?? 'unknown';
	const chatType = String(chat.type ?? 'personal_chat');
	const messages = chat.messages;
	if (!Array.isArray(messages)) return { markdown: null, nWritten: 0, maxId: null, maxUnixtime: null };

	const renderedLines: string[] = [];
	let nWritten = 0;
	let maxId: number | null = null;
	let maxUnixtime: number | null = null;
	let minDateIso: string | null = null;
	let maxDateIso: string | null = null;

	for (const rawMsg of messages) {
		if (!isRecord(rawMsg)) continue;
		const parsed = parseMessage(rawMsg);
		if (parsed === null) continue;
		if (wm.isSeenMessage(parsed.id)) continue;

		// КРИТИЧНО: санитизация в write-path, fail-closed (тело И отправитель).
		const safeBody = failClosedSanitize(parsed.body);
		const safeSender = failClosedSanitize(parsed.sender);
		const marker = parsed.isService ? ' ·service' : '';
		renderedLines.push(`- **${safeSender}** _(${parsed.dateIso}${marker}, #${parsed.id})_: ${safeBody}`);

		nWritten += 1;
		maxId = maxId === null ? parsed.id : Math.max(maxId, parsed.id);
		if (parsed.dateUnixtime > 0) {
			maxUnixtime = maxUnixtime === null ? parsed.dateUnixtime : Math.max(maxUnixtime, parsed.dateUnixtime);
		}
		if (parsed.dateIso) {
			if (minDateIso === null || parsed.dateIso < minDateIso) minDateIso = parsed.dateIso;
			if (maxDateIso === null || parsed.dateIso > maxDateIso) maxDateIso = parsed.dateIso;
		}
	}

	if (nWritten === 0) return { markdown: null, nWritten: 0, maxId: null, maxUnixtime: null };

	const safeChatName = failClosedSanitize(chatName);
	const q = (s: string): string => s.replace(/'/g, "''");
	const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
	const frontmatter = [
		'---',
		`title: 'Переписка Telegram — ${q(safeChatName)}'`,
		'type: source',
		'status: immutable',
		'source: telegram',
		`chat: '${q(safeChatName)}'`,
		`chat_id: ${chatId}`,
		`chat_type: ${chatType}`,
		`exported_from: '${q(String(exportMeta.name ?? ''))}'`,
		`date_range: '${minDateIso || '?'} — ${maxDateIso || '?'}'`,
		`messages_count: ${nWritten}`,
		`ingested_at: ${nowIso}`,
		`last_updated: ${nowIso.slice(0, 10)}`,
		'---',
		'',
		`# Переписка Telegram — ${safeChatName}`,
		'',
		'> Immutable снапшот источника. Каждое тело прошло fail-closed-sanitizer.',
		`> Диапазон: ${minDateIso || '?'} — ${maxDateIso || '?'} · сообщений: ${nWritten} · chat_id: \`${chatId}\`.`,
		'',
		'## Сообщения',
		'',
	];
	const markdown = frontmatter.join('\n') + renderedLines.join('\n') + '\n';
	return { markdown, nWritten, maxId, maxUnixtime };
}

export function writePage(rawDir: string, chat: Record<string, unknown>, markdown: string): string {
	const outDir = join(rawDir, SOURCE_NAME);
	mkdirSync(outDir, { recursive: true });
	const slug = slugify(String(chat.name || 'chat'), chat.id ?? 'unknown');
	const outPath = join(outDir, `${slug}.md`);
	const tmpPath = `${outPath}.tmp`;
	writeFileSync(tmpPath, markdown, 'utf8');
	renameSync(tmpPath, outPath);
	return outPath;
}

// --- Главный конвейер ---------------------------------------------------------
export function ingest(resultJson: string, rawDir: string): number {
	process.stdout.write(`ingest telegram: ${resultJson} -> ${rawDir}\n`);

	const exportData = loadExport(resultJson);
	const exportMeta = { name: String(exportData.name ?? '') };

	const wm = Watermark.load(rawDir, SOURCE_NAME);
	let runMaxId = wm.cursor['last_message_id'] as number | undefined;
	let runMaxUnixtime = wm.cursor['last_date_unixtime'] as number | undefined;

	let totalWritten = 0;
	let pagesWritten = 0;

	for (const chat of iterChats(exportData)) {
		let result: BuildPageResult;
		try {
			result = buildPage(chat, exportMeta, wm);
		} catch (exc) {
			if (exc instanceof SanitizerError) {
				process.stderr.write(`  [SKIP] чат ${JSON.stringify(chat.name)} — sanitizer abort: ${exc.message} (файл не записан)\n`);
				continue;
			}
			throw exc;
		}

		if (!result.markdown) continue;

		const outPath = writePage(rawDir, chat, result.markdown);
		pagesWritten += 1;
		totalWritten += result.nWritten;
		process.stdout.write(`  [write] ${outPath} (${result.nWritten} сообщений)\n`);

		if (result.maxId !== null) {
			runMaxId = runMaxId === undefined ? result.maxId : Math.max(Number(runMaxId), result.maxId);
		}
		if (result.maxUnixtime !== null) {
			runMaxUnixtime = runMaxUnixtime === undefined ? result.maxUnixtime : Math.max(Number(runMaxUnixtime), result.maxUnixtime);
		}
	}

	if (pagesWritten > 0) {
		wm.advance({ last_message_id: runMaxId, last_date_unixtime: runMaxUnixtime });
		wm.save();
		process.stdout.write(`watermark telegram -> last_message_id=${runMaxId} last_date_unixtime=${runMaxUnixtime}\n`);
	} else {
		process.stdout.write('новых сообщений нет — watermark не двигаем\n');
	}

	process.stdout.write(`итог: страниц ${pagesWritten}, сообщений ${totalWritten}\n`);
	return totalWritten;
}

// --- CLI ----------------------------------------------------------------------
export function main(argv: string[] = process.argv.slice(2)): number {
	const resultJson = argv.find((a) => !a.startsWith('--'));
	if (!resultJson) {
		process.stderr.write('usage: node dist/ingest/telegram-export.js <result.json> [--raw-dir ...]\n');
		return 2;
	}
	const rawIdx = argv.indexOf('--raw-dir');
	const rawDirArg = rawIdx !== -1 ? argv[rawIdx + 1] : undefined;
	const rawDir = rawDirArg || process.env.LLM_WIKI_RAW_DIR;
	if (!rawDir) {
		process.stderr.write('не задан каталог raw/: укажите --raw-dir ИЛИ env LLM_WIKI_RAW_DIR\n');
		return 2;
	}
	if (!existsSync(resultJson)) {
		process.stderr.write(`файл не найден: ${resultJson}\n`);
		return 2;
	}
	ingest(resultJson, rawDir);
	return 0;
}

if (isMainModule(import.meta.filename)) {
	process.exit(main());
}
