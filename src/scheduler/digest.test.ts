/**
 * Парность с `scheduler/digest.py` ([ADR-0012]). Детерминированные части: фильтр-
 * аудит (метаданные-онли), watermark, due-precheck, dry-run, exit-коды. Реальный
 * движок не спавним.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DateTime, Duration } from 'luxon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SchedulerConfig } from './config.js';
import {
	collectFilterReview,
	countPendingChores,
	readFilterEvents,
	renderDueList,
	renderFilterReview,
	runSweep,
} from './digest.js';
import { assertNoSecrets } from './runner.js';

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
		upcomingWatermark: join(dir, 'raw', '.watermarks', 'upcoming-digest.txt'),
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

describe('renderDueList', () => {
	it('пустой → плейсхолдер', () => {
		expect(renderDueList([])).toBe('_(ничего не due)_');
	});
	it('формат с тегами СЕГОДНЯ/СКОРО', () => {
		const out = renderDueList([
			{ id: 'a', title: 'Дело', kind: 'oneoff', dueAt: NOW, source: 'reminders', detail: '', upcoming: false },
			{ id: 'b', title: 'ДР', kind: 'birthday', dueAt: NOW, source: 'wiki:p.md', detail: 'исполняется 30', upcoming: true },
		]);
		expect(out).toContain('[СЕГОДНЯ] `a`');
		expect(out).toContain('[СКОРО] `b`');
		expect(out).toContain('— исполняется 30');
	});
});

describe('readFilterEvents', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'digest-test-'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('парсит JSONL, пропускает битые строки, фильтрует по since', () => {
		const log = join(dir, 'ledger.jsonl');
		writeFileSync(
			log,
			[
				'{"ts":"2026-06-08T08:00:00+03:00","category":"nsfw","action":"quarantine"}',
				'{ битый json',
				'{"ts":"2026-06-08T09:30:00+03:00","category":"toxic","action":"quarantine"}',
			].join('\n'),
			'utf8',
		);
		const all = readFilterEvents(log, null);
		expect(all).toHaveLength(2);
		const since = readFilterEvents(log, DateTime.fromISO('2026-06-08T09:00:00+03:00', { setZone: true }));
		expect(since).toHaveLength(1);
		expect(since[0]?.category).toBe('toxic');
	});

	it('нет файла → пусто', () => {
		expect(readFilterEvents(join(dir, 'нет.jsonl'))).toEqual([]);
	});
});

describe('countPendingChores', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'chores-test-'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('считает файлы, пропускает вложенные dot-папки (P0-1)', () => {
		const inbox = join(dir, 'inbox');
		mkdirSync(inbox, { recursive: true });
		writeFileSync(join(inbox, 'a.md'), 'x', 'utf8');
		writeFileSync(join(inbox, 'b.md'), 'y', 'utf8');
		mkdirSync(join(inbox, '.hidden'), { recursive: true });
		writeFileSync(join(inbox, '.hidden', 'c.md'), 'z', 'utf8');
		expect(countPendingChores(inbox)).toBe(2);
	});

	it('нет inbox → 0', () => {
		expect(countPendingChores(join(dir, 'нет'))).toBe(0);
	});
});

describe('renderFilterReview (метаданные-онли)', () => {
	it('группирует карантин по категории + сэмплы + чоры', () => {
		const events = [
			{ category: 'nsfw', action: 'quarantine', raw_path: 'raw/x1.md', reason: 'source_class=adult' },
			{ category: 'nsfw', action: 'quarantine', raw_path: 'raw/x2.md', reason: 'domain' },
			{ category: 'others_pii', action: 'quarantine_and_redact', raw_path: 'raw/y.md' },
			{ lane: 'task', action: 'normal' },
		];
		const out = renderFilterReview(events, 3, 2);
		expect(out).toContain('В карантин: **3** (nsfw:2, others_pii:1)');
		expect(out).toContain('[nsfw]');
		expect(out).toContain('**1** обработано');
		expect(out).toContain('**3** ждёт');
	});

	it('нечего показывать → пустая строка', () => {
		expect(renderFilterReview([], 0, 2)).toBe('');
	});

	it('НЕ содержит содержимого (только метаданные)', () => {
		const events = [{ category: 'nsfw', action: 'quarantine', raw_path: 'raw/secret-body.md', content_sha256: 'sha256:abcdef0123' }];
		const out = renderFilterReview(events, 0, 2);
		expect(out).toContain('secret-body.md');
		expect(out).not.toContain('content_sha256');
	});
});

describe('collectFilterReview — watermark', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'wm-digest-test-'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('двигает watermark после показа → второй вызов пуст', () => {
		const cfg = makeCfg(dir);
		mkdirSync(cfg.rawDir, { recursive: true });
		writeFileSync(
			cfg.filterLog,
			'{"ts":"2026-06-08T09:00:00+03:00","category":"nsfw","action":"quarantine","raw_path":"raw/x.md"}\n',
			'utf8',
		);
		const first = collectFilterReview(cfg, NOW, true);
		expect(first).toContain('В карантин');
		const second = collectFilterReview(cfg, NOW.plus({ minutes: 30 }), true);
		expect(second).toBe(''); // событие уже за watermark'ом
	});
});

describe('assertNoSecrets', () => {
	it('бросает на секрете', () => {
		expect(() => assertNoSecrets('тут sk-ant-Ab3Cd7Ef1Gh9Ij2Kl5Mn8Op4Qr ключ')).toThrow();
	});
	it('чистый текст — ок', () => {
		expect(() => assertNoSecrets('обычный дайджест про дела')).not.toThrow();
	});
});

describe('runSweep — exit-коды без реального движка', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'sweep-test-'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('ничего не due и нет фильтр-событий → 0 (движок не спавнится)', async () => {
		const cfg = makeCfg(dir);
		expect(await runSweep(cfg, { now: NOW })).toBe(0);
	});

	it('dry-run с due-элементом → 0, движок не зовётся', async () => {
		const cfg = makeCfg(dir);
		writeFileSync(
			cfg.remindersPath,
			['---', 'id: t', 'due_at: 2026-06-08T10:02:00+03:00', 'status: pending'].join('\n'),
			'utf8',
		);
		const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		const rc = await runSweep(cfg, { now: NOW, dryRun: true });
		spy.mockRestore();
		expect(rc).toBe(0);
	});

	it('движок недоступен (нет WIKI_REPO_PATH) → exit 2', async () => {
		const cfg = makeCfg(dir);
		writeFileSync(
			cfg.remindersPath,
			['---', 'id: t', 'due_at: 2026-06-08T10:02:00+03:00', 'status: pending'].join('\n'),
			'utf8',
		);
		const saved = process.env.WIKI_REPO_PATH;
		delete process.env.WIKI_REPO_PATH;
		try {
			expect(await runSweep(cfg, { now: NOW })).toBe(2);
		} finally {
			if (saved !== undefined) process.env.WIKI_REPO_PATH = saved;
		}
	});

	// Регресс: «только-скоро» (нет строго-due) не должен спамить каждый 5-мин sweep.
	const UPCOMING = ['---', 'id: u', 'due_at: 2026-06-10T10:00:00+03:00', 'status: pending'].join('\n');

	it('только-скоро + watermark уже сегодня → 0 без спавна движка', async () => {
		const cfg = makeCfg(dir);
		writeFileSync(cfg.remindersPath, UPCOMING, 'utf8');
		mkdirSync(dirname(cfg.upcomingWatermark), { recursive: true });
		writeFileSync(cfg.upcomingWatermark, NOW.toUTC().toISO() ?? '', 'utf8');
		const saved = process.env.WIKI_REPO_PATH;
		delete process.env.WIKI_REPO_PATH; // движок недоступен: если бы спавнился — был бы exit 2
		try {
			expect(await runSweep(cfg, { now: NOW })).toBe(0);
		} finally {
			if (saved !== undefined) process.env.WIKI_REPO_PATH = saved;
		}
	});

	it('только-скоро без watermark (первый за сутки) → доходит до движка (exit 2)', async () => {
		const cfg = makeCfg(dir);
		writeFileSync(cfg.remindersPath, UPCOMING, 'utf8');
		const saved = process.env.WIKI_REPO_PATH;
		delete process.env.WIKI_REPO_PATH;
		try {
			expect(await runSweep(cfg, { now: NOW })).toBe(2);
		} finally {
			if (saved !== undefined) process.env.WIKI_REPO_PATH = saved;
		}
	});
});
