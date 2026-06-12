/**
 * sessions.test.ts — модуль чтения локальных сессий Claude Code ([ADR-0017]).
 *
 * Фикстура — временный каталог: одна папка с `sessions-index.json`, одна — только с
 * транскриптом `*.jsonl`. Проверяем: deny-by-default конфиг, allowlist-фильтр, дедуп
 * индекс↔транскрипт, поиск по префиксу id, хвост диалога и МАСКИРОВАНИЕ секретов на отдачу.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	expandHome,
	findSession,
	formatSessionCard,
	formatSessionList,
	isAllowed,
	listSessions,
	loadSessionsConfig,
	readSessionTail,
	type SessionsConfig,
} from './sessions.js';

// Секрет, который должен быть замаскирован в любом отдаваемом тексте (правило openai_key).
const SECRET = 'sk-ant-' + 'a1b2c3d4e5f6g7h8i9j0k1l2';
const ID_A = 'aaaa1111-0000-0000-0000-000000000001';
const ID_B = 'bbbb2222-0000-0000-0000-000000000002';
const ID_C = 'cccc3333-0000-0000-0000-000000000003';

let root: string;
let cfg: SessionsConfig;

function jsonl(lines: Array<Record<string, unknown>>): string {
	return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'sessions-test-'));

	// Папка с индексом: одна allowed-сессия (с секретом в firstPrompt) + одна denied.
	const work = join(root, 'enc-work');
	mkdirSync(work);
	const transcriptA = join(work, `${ID_A}.jsonl`);
	writeFileSync(
		join(work, 'sessions-index.json'),
		JSON.stringify({
			version: 1,
			originalPath: '/allowed/mpCore',
			entries: [
				{
					sessionId: ID_A,
					fullPath: transcriptA,
					fileMtime: 2000,
					firstPrompt: `почини баг, вот токен ${SECRET}`,
					messageCount: 5,
					gitBranch: 'main',
					projectPath: '/allowed/mpCore',
					isSidechain: false,
				},
				{
					sessionId: ID_B,
					fullPath: join(work, `${ID_B}.jsonl`),
					fileMtime: 3000,
					firstPrompt: 'личное',
					messageCount: 2,
					projectPath: '/denied/foo', // вне allowlist → не показываем
					isSidechain: false,
				},
			],
		}),
	);
	writeFileSync(
		transcriptA,
		jsonl([
			{ type: 'queue-operation', sessionId: ID_A, timestamp: '2026-06-10T10:00:00Z' },
			{
				type: 'user',
				cwd: '/allowed/mpCore',
				sessionId: ID_A,
				message: { role: 'user', content: `почини баг, вот токен ${SECRET}` },
				timestamp: '2026-06-10T10:00:01Z',
			},
			{
				type: 'assistant',
				message: { role: 'assistant', content: [{ type: 'text', text: 'Понял, чиню.' }] },
				timestamp: '2026-06-10T10:00:02Z',
			},
			{
				type: 'user',
				message: { role: 'user', content: 'спасибо' },
				timestamp: '2026-06-10T10:00:03Z',
			},
		]),
	);

	// Папка БЕЗ индекса: только транскрипт; первая запись — queue-operation с cwd:null.
	const plain = join(root, 'enc-plain');
	mkdirSync(plain);
	writeFileSync(
		join(plain, `${ID_C}.jsonl`),
		jsonl([
			{ type: 'queue-operation', cwd: null, sessionId: ID_C, timestamp: '2026-06-10T11:00:00Z' },
			{
				type: 'user',
				cwd: '/allowed/web',
				gitBranch: 'dev',
				sessionId: ID_C,
				message: { role: 'user', content: 'привет' },
				timestamp: '2026-06-10T11:00:01Z',
			},
		]),
	);

	cfg = loadSessionsConfig({ SESSIONS_ENABLED: '1', SESSIONS_ROOT: root, SESSIONS_ALLOWLIST: '/allowed' });
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('loadSessionsConfig', () => {
	it('включается только при SESSIONS_ENABLED=1 И непустом allowlist (deny-by-default)', () => {
		expect(loadSessionsConfig({ SESSIONS_ENABLED: '1', SESSIONS_ALLOWLIST: '/a,/b' }).enabled).toBe(true);
		expect(loadSessionsConfig({ SESSIONS_ENABLED: '1' }).enabled).toBe(false); // нет allowlist
		expect(loadSessionsConfig({ SESSIONS_ALLOWLIST: '/a' }).enabled).toBe(false); // нет флага
		expect(loadSessionsConfig({}).enabled).toBe(false);
	});

	it('парсит allowlist через запятую и раскрывает ~', () => {
		const c = loadSessionsConfig({ SESSIONS_ALLOWLIST: ' /a , ~/b ' });
		expect(c.allowlist).toEqual(['/a', join(homedir(), 'b')]);
	});

	it('root по умолчанию — ~/.claude/projects', () => {
		expect(loadSessionsConfig({}).root).toBe(join(homedir(), '.claude', 'projects'));
	});
});

describe('expandHome / isAllowed', () => {
	it('expandHome раскрывает ~ и ~/x, абсолютный путь не трогает', () => {
		expect(expandHome('~')).toBe(homedir());
		expect(expandHome('~/x')).toBe(join(homedir(), 'x'));
		expect(expandHome('/abs/path')).toBe('/abs/path');
	});

	it('isAllowed: префикс/точное совпадение разрешает, посторонний путь — нет', () => {
		expect(isAllowed('/allowed/mpCore', ['/allowed'])).toBe(true);
		expect(isAllowed('/allowed', ['/allowed'])).toBe(true);
		expect(isAllowed('/allowedX/y', ['/allowed'])).toBe(false); // не /allowed/*
		expect(isAllowed('/denied/foo', ['/allowed'])).toBe(false);
		expect(isAllowed('/anything', [])).toBe(false); // пустой allowlist ⇒ deny
	});
});

describe('listSessions', () => {
	it('берёт allowed-сессии из индекса и из транскрипта, исключает denied, дедуп по id', () => {
		const list = listSessions(cfg);
		const ids = list.map((s) => s.sessionId).sort();
		expect(ids).toEqual([ID_A, ID_C]); // B отфильтрован (вне allowlist)
	});

	it('обогащает метаданные из индекса (messageCount/gitBranch/firstPrompt)', () => {
		const a = listSessions(cfg).find((s) => s.sessionId === ID_A);
		expect(a?.projectPath).toBe('/allowed/mpCore');
		expect(a?.messageCount).toBe(5);
		expect(a?.gitBranch).toBe('main');
	});

	it('для папки без индекса достаёт projectPath из первой записи с cwd (не из queue-operation)', () => {
		const c = listSessions(cfg).find((s) => s.sessionId === ID_C);
		expect(c?.projectPath).toBe('/allowed/web');
		expect(c?.firstPrompt).toBe('привет');
		expect(c?.messageCount).toBeNull();
	});
});

describe('findSession', () => {
	it('находит по однозначному префиксу id', () => {
		expect(findSession(cfg, 'aaaa1111').meta?.sessionId).toBe(ID_A);
	});

	it('возвращает null + пустые кандидаты для несуществующего id', () => {
		const r = findSession(cfg, 'zzzz');
		expect(r.meta).toBeNull();
		expect(r.ambiguous).toEqual([]);
	});
});

describe('readSessionTail + маскирование на отдачу', () => {
	it('возвращает последние текстовые сообщения (queue-operation пропущен)', () => {
		const meta = findSession(cfg, ID_A).meta!;
		const tail = readSessionTail(meta, 6);
		expect(tail.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
		expect(tail.at(-1)?.text).toBe('спасибо');
	});

	it('карточка сессии маскирует секрет из тела диалога', () => {
		const meta = findSession(cfg, ID_A).meta!;
		const card = formatSessionCard(meta, readSessionTail(meta, 6));
		expect(card).not.toContain(SECRET);
		expect(card).toContain('[REDACTED:openai_key]');
	});

	it('список сессий маскирует секрет в firstPrompt', () => {
		const card = formatSessionList(listSessions(cfg), 2, 15);
		expect(card).not.toContain(SECRET);
		expect(card).toContain('[REDACTED:openai_key]');
	});
});
