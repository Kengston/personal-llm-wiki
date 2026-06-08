/**
 * Парность с `ingest/llm_chat.py` ([ADR-0010], [ADR-0011], [ADR-0012]). Парсеры
 * (chatgpt/claude/grok), build_page (санитизация + код-схлоп + accomplishment),
 * диспозиция (normal/quarantine), идемпотентность по watermark. Данные синтетические.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Policy } from './classifier.js';
import { Watermark } from './watermark.js';
import {
	buildPage,
	detectEngine,
	ingest,
	parseChatgpt,
	parseClaude,
	parseGrok,
	routeDisposition,
	type ChatConversation,
} from './llm-chat.js';

const chatgptExport = [
	{
		title: 'Тест',
		create_time: 1717000000,
		mapping: {
			root: { id: 'root', parent: null, children: ['a'], message: null },
			a: {
				id: 'a',
				parent: 'root',
				children: ['b'],
				message: { author: { role: 'user' }, create_time: 1717000001, content: { content_type: 'text', parts: ['Привет'] } },
			},
			b: {
				id: 'b',
				parent: 'a',
				children: [],
				message: { author: { role: 'assistant' }, create_time: 1717000002, content: { content_type: 'text', parts: ['Здравствуй'] } },
			},
		},
	},
];

const claudeExport = [
	{
		uuid: 'u1',
		name: 'Claude чат',
		created_at: '2026-05-31T12:00:00Z',
		chat_messages: [
			{ sender: 'human', created_at: '2026-05-31T12:00:00Z', content: [{ type: 'text', text: 'вопрос' }] },
			{ sender: 'assistant', created_at: '2026-05-31T12:01:00Z', text: 'ответ' },
		],
	},
];

const grokExport = [
	{
		conversation_id: 'g1',
		title: 'Grok',
		messages: [
			{ sender: 'user', message: 'вопрос', create_time: 1717000000 },
			{ sender: 'grok', message: { text: 'ответ' }, create_time: 1717000001 },
		],
	},
];

describe('detectEngine', () => {
	it('по характерным ключам', () => {
		expect(detectEngine(chatgptExport)).toBe('chatgpt');
		expect(detectEngine(claudeExport)).toBe('claude');
		expect(detectEngine(grokExport)).toBe('grok');
		expect(detectEngine([{}])).toBeNull();
	});
});

describe('парсеры', () => {
	it('chatgpt: реконструирует линейную ветку из mapping', () => {
		const convs = parseChatgpt(chatgptExport);
		expect(convs).toHaveLength(1);
		expect(convs[0]?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
		expect(convs[0]?.title).toBe('Тест');
	});

	it('claude: плоский chat_messages, human→user', () => {
		const convs = parseClaude(claudeExport);
		expect(convs[0]?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
		expect(convs[0]?.convId).toBe('u1');
	});

	it('grok: вариативные ключи, grok→assistant', () => {
		const convs = parseGrok(grokExport);
		expect(convs[0]?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
		expect(convs[0]?.messages[1]?.body).toBe('ответ');
	});
});

describe('buildPage', () => {
	const conv = (msgs: { role: string; body: string }[]): ChatConversation => ({
		convId: 'c1',
		title: 'Сессия',
		createdIso: '2026-06-08T10:00:00Z',
		updatedIso: '2026-06-08T10:05:00Z',
		messages: msgs.map((m) => ({ role: m.role, dateIso: '2026-06-08T10:00:00Z', body: m.body, hasCode: false, codeLines: 0 })),
	});

	it('маскирует секрет в расшифровке', () => {
		const md = buildPage(conv([{ role: 'user', body: 'ключ sk-ant-Ab3Cd7Ef1Gh9Ij2Kl5Mn8Op4Qr' }]), 'claude', 'e.json');
		expect(md).not.toContain('sk-ant-Ab3Cd7Ef1Gh9Ij2Kl5Mn8Op4Qr');
		expect(md).toContain('[REDACTED:openai_key]');
	});

	it('код-тяжёлая сессия → accomplishment + схлоп кода', () => {
		const code = 'вот код:\n```python\n' + 'line\n'.repeat(35) + '```';
		const c = conv([{ role: 'assistant', body: code }]);
		c.messages[0]!.codeLines = 36;
		const md = buildPage(c, 'chatgpt', 'e.json') ?? '';
		expect(md).toContain('## Accomplishment');
		expect(md).toContain('[code: python,');
		expect(md).toContain('code_heavy: true');
		expect(md).not.toMatch(/\nline\nline\n/); // verbatim код схлопнут
	});

	it('пустой разговор → null', () => {
		expect(buildPage({ convId: 'x', title: '', createdIso: '', updatedIso: '', messages: [] }, 'grok', 'e.json')).toBeNull();
	});
});

describe('routeDisposition', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'disp-test-'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const conv: ChatConversation = {
		convId: 'c1',
		title: 'Обычная сессия',
		createdIso: '',
		updatedIso: '',
		messages: [{ role: 'user', dateIso: '', body: 'просто разговор про горы', hasCode: false, codeLines: 0 }],
	};

	// Пустая политика изолирует тест от эволюции дефолтной политики. (После [ADR-0013]
	// дат-насыщенная страница и с дефолтной политикой НЕ уходит в карантин — даты
	// больше не считаются телефонами в pii_density.)
	const emptyPolicy: Policy = { policy_version: 't', sensitivity: {}, lanes: { task_triggers: [] } };

	it('normal → пишет в raw/llm_chat/<engine>/, без filter-log', () => {
		const md = buildPage(conv, 'chatgpt', 'e.json') ?? '';
		const written = routeDisposition(dir, conv, 'chatgpt', md, 'e.json', emptyPolicy);
		expect(written).toHaveLength(1);
		expect(written[0]).toContain(join('llm_chat', 'chatgpt'));
		expect(existsSync(join(dir, '.filter-log.jsonl'))).toBe(false);
	});

	it('quarantine (кастом-политика) → raw/.quarantine/<cat>/ + ledger без содержимого', () => {
		const policy: Policy = {
			policy_version: 'test',
			sensitivity: { nsfw: { detect: ['keyword'], keywords: ['карантинмаркер'], action: 'quarantine' } },
			lanes: { task_triggers: [] },
		};
		const qconv: ChatConversation = { ...conv, convId: 'q1', messages: [{ role: 'user', dateIso: '', body: 'тут карантинмаркер и уникальноетелослово', hasCode: false, codeLines: 0 }] };
		const md = buildPage(qconv, 'claude', 'e.json') ?? '';
		const written = routeDisposition(dir, qconv, 'claude', md, 'e.json', policy);
		expect(written[0]).toContain(join('.quarantine', 'nsfw'));
		const ledger = readFileSync(join(dir, '.filter-log.jsonl'), 'utf8');
		expect(ledger).toContain('"category": "nsfw"'); // Python-стиль пробелов (json.dumps)
		expect(ledger).toContain('content_sha256');
		// reason легитимно содержит сматченное keyword (метаданные), но НЕ тело документа.
		expect(ledger).not.toContain('уникальноетелослово');
	});
});

describe('ingest идемпотентность', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'ingest-test-'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('второй ингест того же экспорта → 0 новых (watermark дедуп)', () => {
		const exportPath = join(dir, 'export.json');
		const rawDir = join(dir, 'raw');
		writeFileSync(exportPath, JSON.stringify(chatgptExport), 'utf8');
		expect(ingest(exportPath, rawDir, 'chatgpt')).toBe(1);
		expect(existsSync(Watermark.statePath(rawDir, 'llm_chat'))).toBe(true);
		// После [ADR-0013] обычная страница идёт нормальным путём, не в карантин.
		expect(existsSync(join(rawDir, 'llm_chat', 'chatgpt'))).toBe(true);
		expect(ingest(exportPath, rawDir, 'chatgpt')).toBe(0); // идемпотентно (watermark дедуп)
	});
});
