/**
 * Парность с `scheduler/routines.py` ([ADR-0012]). Реестр, dry-run, делегирование
 * lint в lint-public (без реального движка).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DateTime, Duration } from 'luxon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SchedulerConfig } from './config.js';
import { ROUTINES, runCompile, runLint, runResearch, main } from './routines.js';

const NOW = DateTime.fromISO('2026-06-08T10:00:00+03:00', { setZone: true });

function makeCfg(dir: string, over: Partial<SchedulerConfig> = {}): SchedulerConfig {
	return {
		contentRoot: dir,
		remindersPath: join(dir, 'reminders.md'),
		wikiDir: join(dir, 'wiki'),
		remindersLog: join(dir, 'log.md'),
		rawDir: join(dir, 'raw'),
		filterLog: join(dir, 'raw', '.filter-log.jsonl'),
		tasksLog: join(dir, 'tasks', 'log.md'),
		tasksInbox: join(dir, 'raw', '.tasks', 'inbox'),
		filterWatermark: join(dir, 'raw', '.watermarks', 'filter-digest.txt'),
		filterSamplesPerCategory: 2,
		lookaheadDays: 7,
		graceMinutes: 5,
		quietWhenOnlyUpcoming: true,
		researchQueries: join(dir, 'research', 'queries.md'),
		researchOutDir: join(dir, 'wiki', 'research'),
		publicRepo: dir,
		lookahead: Duration.fromObject({ days: 7 }),
		grace: Duration.fromObject({ minutes: 5 }),
		...over,
	};
}

describe('ROUTINES реестр', () => {
	it('5 routine’ов с именами', () => {
		expect(Object.keys(ROUTINES).sort()).toEqual(['compile', 'digest', 'lint', 'research', 'resurface']);
	});
});

describe('runCompile / runResearch (без движка)', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'routine-test-'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('compile dry-run → 0, печатает промпт', async () => {
		const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		const rc = await runCompile(makeCfg(dir), { now: NOW, dryRun: true });
		spy.mockRestore();
		expect(rc).toBe(0);
	});

	it('research без файла запросов → 0 (движок не зовётся)', async () => {
		const rc = await runResearch(makeCfg(dir), { now: NOW, dryRun: false });
		expect(rc).toBe(0);
	});
});

describe('runLint делегирует lint-public', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'routine-lint-'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('секрет в публичном репо → exit 1 (до движка)', async () => {
		writeFileSync(join(dir, 'leak.ts'), 'const k = "sk-ant-Ab3Cd7Ef1Gh9Ij2Kl5Mn8Op4Qr";\n', 'utf8');
		const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		const rc = await runLint(makeCfg(dir), { now: NOW, dryRun: false });
		spy.mockRestore();
		expect(rc).toBe(1);
	});

	it('чистый публичный репо в dry-run → 0', async () => {
		writeFileSync(join(dir, 'ok.ts'), 'export const y = 1;\n', 'utf8');
		const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		const rc = await runLint(makeCfg(dir), { now: NOW, dryRun: true });
		spy.mockRestore();
		expect(rc).toBe(0);
	});
});

describe('routines CLI --list', () => {
	it('печатает каталог и возвращает 0', async () => {
		const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		const rc = await main(['--list']);
		spy.mockRestore();
		expect(rc).toBe(0);
	});
});
