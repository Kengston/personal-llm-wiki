/**
 * writeback.test.ts — commitIfDirty: коммитит «грязное» дерево, пропускает чистое,
 * не падает на битом пути (ADR-0015 R1). Реальный временный git-репозиторий.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commitIfDirty } from './writeback.js';

let repo: string;

function git(args: string[]): string {
	return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), 'sb-writeback-'));
	git(['init', '-q']);
	git(['config', 'user.email', 'test@example.invalid']);
	git(['config', 'user.name', 'Test']);
	writeFileSync(join(repo, 'seed.md'), 'seed\n');
	git(['add', '-A']);
	git(['commit', '-q', '-m', 'seed']);
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe('commitIfDirty', () => {
	it('грязное дерево → коммит создан (+1 в истории), всё застейджено', async () => {
		writeFileSync(join(repo, 'wiki-idea.md'), '# идея\n');
		const before = Number(git(['rev-list', '--count', 'HEAD']).trim());
		const committed = await commitIfDirty(repo, 'note: capture via telegram');
		expect(committed).toBe(true);
		expect(Number(git(['rev-list', '--count', 'HEAD']).trim())).toBe(before + 1);
		expect(git(['log', '-1', '--pretty=%s']).trim()).toBe('note: capture via telegram');
		expect(git(['status', '--porcelain']).trim()).toBe('');
	});

	it('чистое дерево (query-ход) → коммита нет', async () => {
		const before = git(['rev-list', '--count', 'HEAD']).trim();
		const committed = await commitIfDirty(repo, 'note: nothing');
		expect(committed).toBe(false);
		expect(git(['rev-list', '--count', 'HEAD']).trim()).toBe(before);
	});

	it('битый путь репо → false, без исключения', async () => {
		const committed = await commitIfDirty(join(repo, 'does-not-exist'), 'x');
		expect(committed).toBe(false);
	});
});
