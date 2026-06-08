/**
 * llm-chat.ts — парсер экспортов диалогов LLM (ChatGPT/Claude/Grok) → sanitized markdown.
 *
 * Порт `ingest/llm_chat.py` ([ADR-0010], [ADR-0011], [ADR-0012]). Первый по приоритету
 * источник наравне с Telegram: сердце вики — концепции/развитие/идеи, а их носитель —
 * переписки со всеми LLM. Читает выгрузку → нормализует → прогоняет КАЖДОЕ тело через
 * fail-closed-sanitizer → пишет одну страницу на разговор в raw/ с provenance-frontmatter,
 * двигая watermark только после успешной записи. Код-тяжёлые сессии → accomplishment-
 * выжимка (НЕ verbatim-код, [ADR-0010]). На write-site ЦЕЛОГО документа — классификатор
 * ([ADR-0011]): диспозиция quarantine/task/normal, карантин побеждает лейн.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

import {
	classifySensitivity,
	filterLogRecord,
	loadPolicy,
	routeLane,
	type Classification,
	type LaneDecision,
	type Policy,
	type SourceMeta,
} from './classifier.js';
import { isMainModule } from '../core/cli.js';
import { failClosedSanitize, SanitizerError } from './sanitizer.js';
import { Watermark } from './watermark.js';

const SOURCE_NAME = 'llm_chat';

const KNOWN_ENGINES: Record<string, string> = {
	chatgpt: 'ChatGPT (OpenAI)',
	claude: 'Claude (Anthropic)',
	grok: 'Grok (xAI)',
};

// --- Нормализованный вид (не зависит от движка) -------------------------------
export interface ChatMessage {
	role: string; // user | assistant | system | tool
	dateIso: string; // ISO-8601 UTC или ''
	body: string; // ещё НЕ санитизирован
	hasCode: boolean;
	codeLines: number;
}

export interface ChatConversation {
	convId: string;
	title: string;
	createdIso: string;
	updatedIso: string;
	messages: ChatMessage[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// --- Нормализация времени/ролей -----------------------------------------------
function isoFromUnixtime(unixtime: unknown): string {
	// Только число (Python TypeError'ит на строке → ''); верхняя граница 9999-12-31
	// в секундах — за ней Python OverflowError → '', а new Date даёт мусорный
	// extended-year ('+275760-...') во frontmatter ([аудит TS-порта]).
	if (typeof unixtime !== 'number' || !Number.isFinite(unixtime) || unixtime <= 0) return '';
	if (unixtime > 253402300799) return '';
	try {
		return new Date(unixtime * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
	} catch {
		return '';
	}
}

function isoFromIsostring(value: unknown): string {
	if (typeof value !== 'string' || !value.trim()) return '';
	const raw = value.trim();
	const hasTz = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(raw);
	// Пробел-разделитель → 'T' (Python fromisoformat принимает пробел); затем
	// naive-время (без TZ, но с временем) форсим в UTC, как Python (.replace(tzinfo=utc)) —
	// иначе new Date трактует его как ЛОКАЛЬНОЕ → результат зависит от TZ хоста.
	const normalized = raw.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/, '$1T$2');
	const candidate = !hasTz && normalized.includes('T') ? normalized + 'Z' : normalized;
	const d = new Date(candidate);
	if (Number.isNaN(d.getTime())) return raw;
	return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normalizeTime(value: unknown): string {
	if (typeof value === 'number') return isoFromUnixtime(value);
	return isoFromIsostring(value);
}

function normalizeRole(rawRole: unknown): string {
	const role = String(rawRole ?? '').trim().toLowerCase();
	if (role === 'user' || role === 'human') return 'user';
	if (role === 'system') return 'system';
	if (role === 'tool' || role === 'function') return 'tool';
	return 'assistant'; // grok/agent/assistant/model/bot
}

// Fenced-код: ```lang ... ``` или ~~~ ... ~~~ (\x60 = backtick, чтобы не путать литералы).
const FENCE_RE = /(?<fence>\x60{3}|~{3})[ \t]*(?<lang>[A-Za-z0-9_+.-]*)[^\n]*\n(?<code>[\s\S]*?)\k<fence>/g;

function countCodeLines(code: string): number {
	return (code.match(/\n/g)?.length ?? 0) + 1;
}

function scanCode(text: string): { hasCode: boolean; codeLines: number } {
	let total = 0;
	let found = false;
	for (const m of text.matchAll(FENCE_RE)) {
		found = true;
		total += countCodeLines(m.groups?.code ?? '');
	}
	return { hasCode: found, codeLines: total };
}

function collapseCode(text: string): string {
	return text.replace(FENCE_RE, (...args) => {
		const groups = args.at(-1) as { lang?: string; code?: string };
		const lang = groups.lang || '?';
		const n = countCodeLines(groups.code ?? '');
		return `[code: ${lang}, ${n} строк]`;
	});
}

// --- Парсер 1: ChatGPT (дерево mapping) ---------------------------------------
function chatgptMessageText(message: Record<string, unknown>): string {
	const content = message.content;
	if (!isRecord(content)) return '';
	const parts = content.parts;
	if (!Array.isArray(parts)) return '';
	const chunks: string[] = [];
	for (const part of parts) {
		if (typeof part === 'string') chunks.push(part);
		else if (part !== null && part !== undefined) chunks.push('[non-text part]');
	}
	return chunks.filter(Boolean).join('\n');
}

function* chatgptLinearMessages(rawMapping: unknown): Generator<Record<string, unknown>> {
	if (!isRecord(rawMapping) || Object.keys(rawMapping).length === 0) return;
	const mapping: Record<string, unknown> = rawMapping;
	let rootId: string | null = null;
	for (const [nodeId, node] of Object.entries(mapping)) {
		if (!isRecord(node)) continue;
		const parent = node.parent;
		if (parent === null || parent === undefined || !(typeof parent === 'string' && parent in mapping)) {
			rootId = nodeId;
			break;
		}
	}
	if (rootId === null) return;
	const seen = new Set<string>();
	let current: string | null = rootId;
	while (current !== null && current in mapping && !seen.has(current)) {
		seen.add(current);
		const nodeVal = mapping[current];
		const node: Record<string, unknown> = isRecord(nodeVal) ? nodeVal : {};
		const msg = node.message;
		if (isRecord(msg)) yield msg;
		const children = node.children;
		if (!Array.isArray(children) || children.length === 0) break;
		current = String(children[children.length - 1]);
	}
}

function topLevelItems(data: unknown): unknown[] {
	if (Array.isArray(data)) return data;
	if (isRecord(data) && Array.isArray(data.conversations)) return data.conversations;
	return [];
}

export function parseChatgpt(data: unknown): ChatConversation[] {
	const conversations: ChatConversation[] = [];
	topLevelItems(data).forEach((conv, idx) => {
		if (!isRecord(conv)) return;
		const messages: ChatMessage[] = [];
		for (const msg of chatgptLinearMessages(conv.mapping ?? {})) {
			const author = isRecord(msg.author) ? msg.author : {};
			const role = normalizeRole(author.role);
			const text = chatgptMessageText(msg);
			if (!text.trim()) continue;
			const { hasCode, codeLines } = scanCode(text);
			messages.push({ role, dateIso: isoFromUnixtime(msg.create_time), body: text, hasCode, codeLines });
		}
		if (!messages.length) return;
		const convId = String(conv.conversation_id || conv.id || `chatgpt-${idx}`);
		conversations.push({
			convId,
			title: String(conv.title || 'Без названия'),
			createdIso: isoFromUnixtime(conv.create_time),
			updatedIso: isoFromUnixtime(conv.update_time),
			messages,
		});
	});
	return conversations;
}

// --- Парсер 2: Claude (плоский chat_messages, ISO-время) ----------------------
function claudeMessageText(message: Record<string, unknown>): string {
	const content = message.content;
	if (Array.isArray(content) && content.length) {
		const chunks: string[] = [];
		for (const block of content) {
			if (!isRecord(block)) continue;
			if (block.type === 'text') chunks.push(String(block.text ?? ''));
			else chunks.push('[non-text block]');
		}
		const joined = chunks.filter(Boolean).join('\n');
		if (joined.trim()) return joined;
	}
	return String(message.text ?? '');
}

export function parseClaude(data: unknown): ChatConversation[] {
	const conversations: ChatConversation[] = [];
	topLevelItems(data).forEach((conv, idx) => {
		if (!isRecord(conv)) return;
		const rawMessages = conv.chat_messages;
		if (!Array.isArray(rawMessages)) return;
		const messages: ChatMessage[] = [];
		for (const msg of rawMessages) {
			if (!isRecord(msg)) continue;
			const role = normalizeRole(msg.sender);
			const text = claudeMessageText(msg);
			if (!text.trim()) continue;
			const { hasCode, codeLines } = scanCode(text);
			messages.push({ role, dateIso: isoFromIsostring(msg.created_at), body: text, hasCode, codeLines });
		}
		if (!messages.length) return;
		const convId = String(conv.uuid || conv.id || `claude-${idx}`);
		conversations.push({
			convId,
			title: String(conv.name || 'Без названия'),
			createdIso: isoFromIsostring(conv.created_at),
			updatedIso: isoFromIsostring(conv.updated_at),
			messages,
		});
	});
	return conversations;
}

// --- Парсер 3: Grok (терпимый к форме) ----------------------------------------
function firstPresent(d: Record<string, unknown>, ...keys: string[]): unknown {
	for (const key of keys) {
		if (key in d && d[key] !== null && d[key] !== '') return d[key];
	}
	return undefined;
}

function grokMessageText(message: Record<string, unknown>): string {
	const raw = firstPresent(message, 'message', 'text', 'body', 'content');
	if (typeof raw === 'string') return raw;
	if (isRecord(raw)) {
		if (typeof raw.text === 'string') return raw.text;
		if (Array.isArray(raw.parts)) return raw.parts.filter((p) => typeof p === 'string').join('\n');
	}
	if (Array.isArray(raw)) return raw.filter((p) => typeof p === 'string').join('\n');
	return '';
}

export function parseGrok(data: unknown): ChatConversation[] {
	const conversations: ChatConversation[] = [];
	topLevelItems(data).forEach((conv, idx) => {
		if (!isRecord(conv)) return;
		const rawMessages = firstPresent(conv, 'messages', 'responses', 'turns');
		if (!Array.isArray(rawMessages)) return;
		const messages: ChatMessage[] = [];
		for (const msg of rawMessages) {
			if (!isRecord(msg)) continue;
			const role = normalizeRole(firstPresent(msg, 'sender', 'role', 'author'));
			const text = grokMessageText(msg);
			if (!text.trim()) continue;
			const { hasCode, codeLines } = scanCode(text);
			messages.push({
				role,
				dateIso: normalizeTime(firstPresent(msg, 'create_time', 'created_at', 'timestamp')),
				body: text,
				hasCode,
				codeLines,
			});
		}
		if (!messages.length) return;
		const convId = String(firstPresent(conv, 'conversation_id', 'id', 'uuid') || `grok-${idx}`);
		conversations.push({
			convId,
			title: String(firstPresent(conv, 'title', 'name') || 'Без названия'),
			createdIso: normalizeTime(firstPresent(conv, 'create_time', 'created_at')),
			updatedIso: normalizeTime(firstPresent(conv, 'update_time', 'updated_at')),
			messages,
		});
	});
	return conversations;
}

const PARSERS: Record<string, (data: unknown) => ChatConversation[]> = {
	chatgpt: parseChatgpt,
	claude: parseClaude,
	grok: parseGrok,
};

export function detectEngine(data: unknown): string | null {
	let sample: unknown = null;
	if (Array.isArray(data) && data.length) sample = data[0];
	else if (isRecord(data)) {
		const convs = data.conversations;
		sample = Array.isArray(convs) && convs.length ? convs[0] : data;
	}
	if (!isRecord(sample)) return null;
	if ('mapping' in sample) return 'chatgpt';
	if ('chat_messages' in sample) return 'claude';
	if ('messages' in sample || 'responses' in sample || 'conversation_id' in sample) return 'grok';
	return null;
}

// --- Извлечение идей/концепций/решений + accomplishment (ADR-0010) ------------
const IDEA_MARKERS = ['идея', 'а что если', 'можно было бы', 'хочу сделать', 'давай попробуем', 'idea', 'what if', 'we could', 'i want to build', "let's try"];
const DECISION_MARKERS = ['решил', 'решение:', 'вывод:', 'итог:', 'договорились', 'выбираем', 'остановимся на', 'decided', 'decision:', 'conclusion', "we'll go with", "let's go with"];
const CONCEPT_MARKERS = ['это означает', 'по сути', 'ключевая мысль', 'принцип', 'паттерн', 'концепция', 'the key idea', 'in essence', 'principle', 'pattern', 'concept'];
const CODE_HEAVY_LINE_THRESHOLD = 30;

function splitSentences(text: string): string[] {
	return text
		.split(/(?<=[.!?;\n])\s+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

interface Markers {
	ideas: string[];
	decisions: string[];
	concepts: string[];
}

function extractMarkers(messages: ChatMessage[]): Markers {
	const buckets: Markers = { ideas: [], decisions: [], concepts: [] };
	const seen = new Set<string>();
	const consider = (sentence: string): void => {
		const low = sentence.toLowerCase();
		let target: keyof Markers | null = null;
		if (DECISION_MARKERS.some((m) => low.includes(m))) target = 'decisions';
		else if (IDEA_MARKERS.some((m) => low.includes(m))) target = 'ideas';
		else if (CONCEPT_MARKERS.some((m) => low.includes(m))) target = 'concepts';
		if (target === null) return;
		const clipped = sentence.length <= 280 ? sentence : sentence.slice(0, 277) + '…';
		const key = `${target}:${clipped.toLowerCase()}`;
		if (seen.has(key)) return;
		seen.add(key);
		if (buckets[target].length < 12) buckets[target].push(clipped);
	};
	for (const msg of messages) for (const sentence of splitSentences(msg.body)) consider(sentence);
	return buckets;
}

function buildAccomplishment(conv: ChatConversation, totalCodeLines: number): string[] {
	const langs: string[] = [];
	for (const msg of conv.messages) {
		for (const m of msg.body.matchAll(FENCE_RE)) {
			const lang = (m.groups?.lang ?? '').trim().toLowerCase();
			if (lang && !langs.includes(lang)) langs.push(lang);
		}
	}
	const langsStr = langs.length ? langs.join(', ') : 'не указаны явно';
	return [
		'## Accomplishment (код-тяжёлая сессия)',
		'',
		`> Сессия code-heavy (~${totalCodeLines} строк кода) → по [ADR-0010](../../docs/adr/0010-wiki-content-model.md) ` +
			'вместо verbatim-кода — выжимка «что сделано». Финализирует и привяжет к навыкам компилятор вики.',
		'',
		`- **Что (X):** ${conv.title || 'Без названия'}`,
		`- **Через что (Y):** ${langsStr}`,
		'- **Навык (Z):** _заполнит компилятор_ (вывести из X/Y и характера задачи).',
		'- **Ключевые решения / уроки:** см. секцию «Решения» ниже (если пусто — компилятор извлечёт из расшифровки).',
		'',
	];
}

// --- Сборка markdown-страницы -------------------------------------------------
function slugify(title: string, convId: string): string {
	let asciiPart = title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
	if (!asciiPart) asciiPart = 'chat';
	const safeId = String(convId).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'id';
	return `${asciiPart.slice(0, 40)}-${safeId.slice(0, 40)}`;
}

function yamlQuote(value: string): string {
	return value.replace(/'/g, "''");
}

/** Собирает markdown страницы разговора. null — если нет сообщений. Бросает SanitizerError. */
export function buildPage(conv: ChatConversation, engine: string, exportName: string): string | null {
	if (!conv.messages.length) return null;

	const totalCodeLines = conv.messages.reduce((s, m) => s + m.codeLines, 0);
	const isCodeHeavy = totalCodeLines >= CODE_HEAVY_LINE_THRESHOLD;
	const markers = extractMarkers(conv.messages);

	// Санитизация выжимок (куски пользовательского текста).
	const safeMarkers: Markers = {
		ideas: markers.ideas.map(failClosedSanitize),
		decisions: markers.decisions.map(failClosedSanitize),
		concepts: markers.concepts.map(failClosedSanitize),
	};

	// Санитизированная расшифровка (код схлопнут ДО sanitizer).
	const transcriptLines: string[] = [];
	let minIso: string | null = null;
	let maxIso: string | null = null;
	for (const msg of conv.messages) {
		const safeBody = failClosedSanitize(collapseCode(msg.body));
		const safeRole = failClosedSanitize(msg.role);
		const stamp = msg.dateIso || '?';
		transcriptLines.push(`- **${safeRole}** _(${stamp})_: ${safeBody}`);
		if (msg.dateIso) {
			if (minIso === null || msg.dateIso < minIso) minIso = msg.dateIso;
			if (maxIso === null || msg.dateIso > maxIso) maxIso = msg.dateIso;
		}
	}

	const dateFrom = minIso || conv.createdIso || '?';
	const dateTo = maxIso || conv.updatedIso || '?';
	const safeTitle = failClosedSanitize(conv.title || 'Без названия');
	const engineHuman = KNOWN_ENGINES[engine] ?? engine;
	const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

	const front = [
		'---',
		`title: 'Диалог LLM — ${yamlQuote(safeTitle)}'`,
		'type: source',
		'status: immutable',
		'source: llm_chat',
		`engine: ${engine}`,
		`conversation_id: '${yamlQuote(String(conv.convId))}'`,
		`exported_from: '${yamlQuote(String(exportName))}'`,
		`date_range: '${dateFrom} — ${dateTo}'`,
		`messages_count: ${conv.messages.length}`,
		`code_heavy: ${isCodeHeavy ? 'true' : 'false'}`,
		`code_lines: ${totalCodeLines}`,
		`extracted_ideas: ${safeMarkers.ideas.length}`,
		`extracted_decisions: ${safeMarkers.decisions.length}`,
		`extracted_concepts: ${safeMarkers.concepts.length}`,
		`ingested_at: ${nowIso}`,
		`last_updated: ${nowIso.slice(0, 10)}`,
		'---',
		'',
		`# Диалог LLM — ${safeTitle}`,
		'',
		`> Immutable снапшот источника (${engineHuman}). Каждое тело прошло fail-closed-sanitizer; ` +
			'код схлопнут до пометок (ADR-0010).',
		`> Диапазон: ${dateFrom} — ${dateTo} · сообщений: ${conv.messages.length} · движок: \`${engine}\`.`,
		'',
	];

	const bodySections: string[] = [];
	if (isCodeHeavy) bodySections.push(...buildAccomplishment(conv, totalCodeLines));

	const renderBucket = (heading: string, items: string[]): void => {
		if (!items.length) return;
		bodySections.push(`## ${heading}`, '', ...items.map((it) => `- ${it}`), '');
	};
	renderBucket('Идеи', safeMarkers.ideas);
	renderBucket('Концепции', safeMarkers.concepts);
	renderBucket('Решения', safeMarkers.decisions);

	bodySections.push('## Расшифровка', '', ...transcriptLines, '');

	return front.join('\n') + bodySections.join('\n') + '\n';
}

// --- Запись + диспозиция (ADR-0011) -------------------------------------------
const QUARANTINE_DIRNAME = '.quarantine';
const TASKS_INBOX_PARTS = ['.tasks', 'inbox'];
const FILTER_LEDGER_NAME = '.filter-log.jsonl';

function atomicWriteMd(outDir: string, slug: string, markdown: string): string {
	mkdirSync(outDir, { recursive: true });
	const outPath = join(outDir, `${slug}.md`);
	const tmpPath = `${outPath}.tmp`;
	writeFileSync(tmpPath, markdown, 'utf8');
	renameSync(tmpPath, outPath);
	return outPath;
}

export function writePage(rawDir: string, conv: ChatConversation, engine: string, markdown: string): string {
	const slug = slugify(conv.title || 'chat', conv.convId);
	return atomicWriteMd(join(rawDir, SOURCE_NAME, engine), slug, markdown);
}

function buildSourceMeta(conv: ChatConversation, engine: string, exportName: string): SourceMeta {
	return {
		source: SOURCE_NAME,
		source_class: `${SOURCE_NAME}:${engine}`,
		engine,
		conversation_id: String(conv.convId),
		exported_from: exportName,
	};
}

function privateRepoRoot(rawDir: string): string {
	return dirname(rawDir);
}

function appendFilterLedger(rawDir: string, record: Record<string, unknown>): void {
	const ledger = join(rawDir, FILTER_LEDGER_NAME);
	mkdirSync(dirname(ledger), { recursive: true });
	// Сортируем ключи через объект (replacer-массив молча выбросил бы ключи вложенных
	// объектов) + Python-стиль пробелов (json.dumps sort_keys, ensure_ascii=False).
	const body = Object.keys(record)
		.sort()
		.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(record[k])}`)
		.join(', ');
	appendFileSync(ledger, `{${body}}\n`, 'utf8'); // O_APPEND — атомарно, как Python open('a')
}

function appendLogLine(path: string, line: string): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, line.endsWith('\n') ? line : line + '\n', 'utf8');
}

function humanFilterLine(outName: string, clf: Classification, lane: LaneDecision, disposition: string): string {
	const day = new Date().toISOString().slice(0, 10);
	const dual = lane.dualRoute ? ' (dual_route)' : '';
	const detail = `${SOURCE_NAME} → ${disposition} · sens=${clf.label}/${clf.action} · lane=${lane.lane}${dual} · ${clf.reason}`;
	return `## [${day}] filter | ${outName} | ${detail}`;
}

function logDisposition(
	rawDir: string,
	outPath: string,
	clf: Classification,
	lane: LaneDecision,
	disposition: string,
	content: string,
	policyVersion: string,
): void {
	const axis = disposition === 'task' || disposition === 'dual_route_knowledge' ? 'lane' : 'sensitivity';
	const rel = relative(rawDir, outPath);
	const relPath = rel.startsWith('..') ? basename(outPath) : rel;
	const record: Record<string, unknown> = {
		...filterLogRecord(relPath, clf, { axis, lane, content, policyVersion }),
		disposition,
	};
	appendFilterLedger(rawDir, record);
	appendLogLine(join(privateRepoRoot(rawDir), 'log.md'), humanFilterLine(basename(outPath), clf, lane, disposition));
}

/** Классифицирует ЦЕЛЫЙ документ и маршрутизирует по диспозиции (ADR-0011). */
export function routeDisposition(
	rawDir: string,
	conv: ChatConversation,
	engine: string,
	markdown: string,
	exportName: string,
	policy?: Policy,
): string[] {
	const pol = policy ?? loadPolicy();
	const policyVersion = String(pol.policy_version ?? '');
	const sourceMeta = buildSourceMeta(conv, engine, exportName);

	const clf = classifySensitivity(markdown, sourceMeta, pol);
	const lane = routeLane(markdown, sourceMeta, pol);

	const slug = slugify(conv.title || 'chat', conv.convId);
	const isQuarantine = clf.action === 'quarantine' || clf.action === 'quarantine_and_redact';
	const written: string[] = [];

	// 1. КАРАНТИН ПОБЕЖДАЕТ ЛЕЙН.
	if (isQuarantine) {
		const cat = clf.label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'uncategorized';
		const outPath = atomicWriteMd(join(rawDir, QUARANTINE_DIRNAME, cat), slug, markdown);
		written.push(outPath);
		logDisposition(rawDir, outPath, clf, lane, 'quarantine', markdown, policyVersion);
		return written;
	}

	// 2. ЛЕЙН «ЗАДАЧА».
	if (lane.lane === 'task') {
		const taskDir = join(rawDir, ...TASKS_INBOX_PARTS);
		const taskPath = atomicWriteMd(taskDir, slug, markdown);
		written.push(taskPath);
		const day = new Date().toISOString().slice(0, 10);
		appendLogLine(
			join(privateRepoRoot(rawDir), 'tasks', 'log.md'),
			`- [ ] [${day}] ${basename(taskPath)} · из ${SOURCE_NAME} · ${lane.reason}`,
		);
		logDisposition(rawDir, taskPath, clf, lane, 'task', markdown, policyVersion);

		if (lane.dualRoute) {
			const normalPath = writePage(rawDir, conv, engine, markdown);
			written.push(normalPath);
			logDisposition(rawDir, normalPath, clf, lane, 'dual_route_knowledge', markdown, policyVersion);
		}
		return written;
	}

	// 3. ОБЫЧНЫЙ raw/.
	const outPath = writePage(rawDir, conv, engine, markdown);
	written.push(outPath);
	if (clf.action !== 'normal' || lane.dualRoute) {
		logDisposition(rawDir, outPath, clf, lane, clf.action !== 'normal' ? clf.action : 'knowledge', markdown, policyVersion);
	}
	return written;
}

// --- Загрузка + главный конвейер ----------------------------------------------
export function loadExport(path: string): unknown {
	return JSON.parse(readFileSync(path, 'utf8'));
}

/** Полный ингест одного экспорта. Возвращает число записанных разговоров. */
export function ingest(exportJson: string, rawDir: string, engine?: string): number {
	const data = loadExport(exportJson);

	let eng = engine;
	if (!eng) {
		const detected = detectEngine(data);
		if (!detected) {
			throw new Error('не удалось определить движок экспорта — укажите явно --engine {chatgpt|claude|grok}');
		}
		eng = detected;
		process.stdout.write(`авто-определён движок: ${eng}\n`);
	}
	if (!(eng in PARSERS)) {
		throw new Error(`неизвестный движок ${JSON.stringify(eng)} (ожидался chatgpt|claude|grok)`);
	}

	process.stdout.write(`ingest llm_chat (${eng}): ${exportJson} -> ${rawDir}\n`);
	const conversations = PARSERS[eng]!(data);
	if (!conversations.length) {
		process.stdout.write('в экспорте не найдено разговоров — нечего ингестить\n');
		return 0;
	}

	const wm = Watermark.load(rawDir, SOURCE_NAME);
	const seenIds = new Set<string>(
		Array.isArray(wm.cursor['seen_conversation_ids']) ? (wm.cursor['seen_conversation_ids'] as string[]) : [],
	);
	const policy = loadPolicy();
	const exportName = basename(exportJson);
	let totalWritten = 0;
	const newIds: string[] = [];

	for (const conv of conversations) {
		const markerId = `${eng}:${conv.convId}`;
		if (seenIds.has(markerId)) continue;

		let markdown: string | null;
		try {
			markdown = buildPage(conv, eng, exportName);
		} catch (exc) {
			if (exc instanceof SanitizerError) {
				process.stderr.write(`  [SKIP] разговор ${conv.convId} — sanitizer abort: ${exc.message} (файл не записан)\n`);
				continue;
			}
			throw exc;
		}

		if (!markdown) {
			newIds.push(markerId);
			continue;
		}

		const writtenPaths = routeDisposition(rawDir, conv, eng, markdown, exportName, policy);
		newIds.push(markerId);
		totalWritten += 1;
		for (const outPath of writtenPaths) {
			process.stdout.write(`  [write] ${outPath} (${conv.messages.length} сообщений)\n`);
		}
	}

	if (newIds.length) {
		const merged = [...new Set([...seenIds, ...newIds])].sort();
		wm.advance({ seen_conversation_ids: merged, last_engine: eng });
		wm.save();
		process.stdout.write(`watermark llm_chat -> известных разговоров: ${merged.length}\n`);
	} else {
		process.stdout.write('новых разговоров нет — watermark не двигаем\n');
	}

	process.stdout.write(`итог: записано разговоров ${totalWritten}\n`);
	return totalWritten;
}

// --- CLI ----------------------------------------------------------------------
function resolveRawDir(argValue: string | undefined, env: NodeJS.ProcessEnv): string {
	const raw = argValue || env.LLM_WIKI_RAW_DIR;
	if (!raw) {
		throw new Error(
			'не задан каталог raw/: укажите --raw-dir ИЛИ переменную окружения LLM_WIKI_RAW_DIR ' +
				'(путь к raw/ приватного репо llm-wiki-content)',
		);
	}
	return raw;
}

export function main(argv: string[] = process.argv.slice(2)): number {
	const exportJson = argv.find((a) => !a.startsWith('--'));
	if (!exportJson) {
		process.stderr.write('usage: node dist/ingest/llm-chat.js <conversations.json> [--engine ...] [--raw-dir ...]\n');
		return 2;
	}
	const engineIdx = argv.indexOf('--engine');
	const engine = engineIdx !== -1 ? argv[engineIdx + 1] : undefined;
	const rawIdx = argv.indexOf('--raw-dir');
	const rawDirArg = rawIdx !== -1 ? argv[rawIdx + 1] : undefined;

	if (!existsSync(exportJson)) {
		process.stderr.write(`файл не найден: ${exportJson}\n`);
		return 2;
	}
	const rawDir = resolveRawDir(rawDirArg, process.env);
	ingest(exportJson, rawDir, engine);
	return 0;
}

if (isMainModule(import.meta.filename)) {
	process.exit(main());
}
