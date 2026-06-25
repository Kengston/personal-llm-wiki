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
	buildFinanceSectionForDigest,
	collectFilterReview,
	countPendingChores,
	readFilterEvents,
	renderDueList,
	renderFilterReview,
	runSweep,
} from './digest.js';
import type { FinanceDueResult } from './finance-sweep.js';
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

// ---------------------------------------------------------------------------
// Финанс-секция для дайджеста (buildFinanceSectionForDigest) — ADR-0018 волна 2
// ---------------------------------------------------------------------------

describe('buildFinanceSectionForDigest', () => {
	it('null → пустая строка (финансовый свип не запускался)', () => {
		expect(buildFinanceSectionForDigest(null)).toBe('');
	});

	it('пустой FinanceDueResult → пустая строка (нет данных для показа)', () => {
		const emptyResult: FinanceDueResult = {
			credits: [],
			milestones: [],
			cashSurvey: { isDue: false, fireKey: 'cash-survey:2026-06-08' },
			idleNudge: { isDue: false, idleDays: 0, fireKey: 'idle-nudge:2026-06-08' },
		};
		expect(buildFinanceSectionForDigest(emptyResult)).toBe('');
	});

	it('с кредит-айтемами lead/due: секция содержит заголовок и дату', () => {
		const result: FinanceDueResult = {
			credits: [{
				kind: 'lead',
				credit_id: 'fake-credit-001',
				label: 'Синтетический кредит',
				amount: 51000,
				currency: 'RUB',
				dueDate: '2026-06-26T00:00:00Z',
				balanceAfter: 449000,
				account: undefined,
				fireKey: 'credit:fake-credit-001:2026-06-26:lead',
				payoffDate: '2028-06-01',
			}],
			milestones: [],
			cashSurvey: { isDue: false, fireKey: 'cash-survey:2026-06-08' },
			idleNudge: { isDue: false, idleDays: 0, fireKey: 'idle-nudge:2026-06-08' },
		};

		const section = buildFinanceSectionForDigest(result);
		expect(section).toContain('Финансовый пульс');
		expect(section).toContain('Кредиты');
		expect(section).toContain('Синтетический кредит');
		expect(section).toContain('2026-06-26');
		// Фиксируем проводку payoffDate → дайджест-текст (R4 ADR-0026 §крит.6).
		// Ранее .map() не передавал c.payoffDate → «погашение» исчезало из секции.
		expect(section).toContain('погашение');
		expect(section).toContain('2028-06-01');
	});

	it('с майлстоун-айтемом: секция содержит прогресс цели в процентах', () => {
		const result: FinanceDueResult = {
			credits: [],
			milestones: [{
				goal_id: 'fake-goal-emergency',
				label: 'Экстренный фонд',
				milestonePercent: 75,
				pct: 75.3,
				current: 150000,
				target: 200000,
				currency: 'RUB',
				fin_kind: 'save',
				fireKey: 'goal:fake-goal-emergency:milestone:75',
			}],
			cashSurvey: { isDue: false, fireKey: 'cash-survey:2026-06-08' },
			idleNudge: { isDue: false, idleDays: 0, fireKey: 'idle-nudge:2026-06-08' },
		};

		const section = buildFinanceSectionForDigest(result);
		expect(section).toContain('Цели');
		expect(section).toContain('Экстренный фонд');
		expect(section).toContain('75%');
	});

	it('overdue-кредиты НЕ включаются в секцию (отдельный срочный пуш)', () => {
		const result: FinanceDueResult = {
			credits: [{
				kind: 'overdue',
				credit_id: 'fake-overdue',
				label: 'Просроченный кредит',
				amount: 20000,
				currency: 'RUB',
				dueDate: '2026-06-10T00:00:00Z',
				balanceAfter: 100000,
				account: undefined,
				fireKey: 'credit:fake-overdue:2026-06-08:overdue',
				payoffDate: '2027-06-01',
			}],
			milestones: [],
			cashSurvey: { isDue: false, fireKey: 'cash-survey:2026-06-08' },
			idleNudge: { isDue: false, idleDays: 0, fireKey: 'idle-nudge:2026-06-08' },
		};

		// overdue-айтемы отдельным срочным пушем, не в дайджест-секцию.
		expect(buildFinanceSectionForDigest(result)).toBe('');
	});

	it('регресс: пустой FinanceDueResult → финсекция пуста → дайджест-промпт НЕ содержит ФИНАНСОВЫЙ ПУЛЬС', async () => {
		// Проверяет что при пустом финансовом состоянии (нет кредитов, нет майлстоунов)
		// финансовый блок НЕ вставляется в sweep-промпт и НЕ меняет дайджест.
		// Регресс-инвариант: пользователь без финданных получает тот же дайджест, что был бы без финансов.
		let dir: string = '';
		try {
			dir = mkdtempSync(join(tmpdir(), 'digest-empty-finance-test-'));
			const cfg = makeCfg(dir);
			const emptyFinDue: FinanceDueResult = {
				credits: [],
				milestones: [],
				cashSurvey: { isDue: false, fireKey: 'cash-survey:2026-06-08' },
				idleNudge: { isDue: false, idleDays: 0, fireKey: 'idle-nudge:2026-06-08' },
			};

			// Пишем due-напоминание чтобы sweep не отсеялся на шаге «нечего due».
			writeFileSync(
				cfg.remindersPath,
				['---', 'id: t', 'due_at: 2026-06-08T10:02:00+03:00', 'status: pending'].join('\n'),
				'utf8',
			);

			const written: string[] = [];
			const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
				written.push(String(s));
				return true;
			});

			await runSweep(cfg, { now: NOW, dryRun: true, finDue: emptyFinDue });
			spy.mockRestore();

			const combined = written.join('');
			// Пустой finDue → финансовый блок НЕ добавляется в промпт.
			expect(combined).not.toContain('ФИНАНСОВЫЙ ПУЛЬС');
		} finally {
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	it('регресс: runSweep БЕЗ опции finDue (как в проде routines.ts/main) → промпт без ФИНАНСОВЫЙ ПУЛЬС', async () => {
		// Пиннит ТЕКУЩЕЕ безопасное прод-поведение: и runDigest (routines.ts:169),
		// и digest.ts main зовут runSweep(cfg, { now, dryRun }) — БЕЗ ключа finDue вообще.
		// Тогда opts.finDue ?? null === null → buildFinanceSectionForDigest(null) === '' →
		// финблок не вставляется. Это значит, что проактивный финансовый пульс сейчас «тёмный»:
		// у обычного бота (без явной передачи finDue) дайджест не меняется от наличия финансов.
		// Отличается от соседнего теста тем, что finDue не передаётся СОВСЕМ (а не =null) —
		// фиксируем форму прод-вызова, а не один частный аргумент.
		let dir: string = '';
		try {
			dir = mkdtempSync(join(tmpdir(), 'digest-no-findue-test-'));
			const cfg = makeCfg(dir);

			// Пишем due-напоминание чтобы sweep не отсеялся на шаге «нечего due» и реально дошёл до промпта.
			writeFileSync(
				cfg.remindersPath,
				['---', 'id: t', 'due_at: 2026-06-08T10:02:00+03:00', 'status: pending'].join('\n'),
				'utf8',
			);

			const written: string[] = [];
			const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
				written.push(String(s));
				return true;
			});

			// КЛЮЧЕВОЕ: опции ровно как в проде — без finDue.
			await runSweep(cfg, { now: NOW, dryRun: true });
			spy.mockRestore();

			const combined = written.join('');
			// Прод-вызов без finDue → финансовая секция отсутствует в дайджест-промпте.
			expect(combined).not.toContain('ФИНАНСОВЫЙ ПУЛЬС');
		} finally {
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	it('регресс: finDue=null → финсекция пуста → дайджест-промпт без ФИНАНСОВЫЙ ПУЛЬС', async () => {
		// Проверяет что finDue=null (финансовый свип не запускался) → дайджест без финсекции.
		let dir: string = '';
		try {
			dir = mkdtempSync(join(tmpdir(), 'digest-null-finance-test-'));
			const cfg = makeCfg(dir);

			writeFileSync(
				cfg.remindersPath,
				['---', 'id: t', 'due_at: 2026-06-08T10:02:00+03:00', 'status: pending'].join('\n'),
				'utf8',
			);

			const written: string[] = [];
			const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
				written.push(String(s));
				return true;
			});

			await runSweep(cfg, { now: NOW, dryRun: true, finDue: null });
			spy.mockRestore();

			const combined = written.join('');
			// null finDue → buildFinanceSectionForDigest('') → финблок не вставляется.
			expect(combined).not.toContain('ФИНАНСОВЫЙ ПУЛЬС');
		} finally {
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	it('runSweep с finDue — финанс-блок встраивается в промпт (dry-run)', async () => {
		let dir: string = '';
		try {
			dir = mkdtempSync(join(tmpdir(), 'digest-finance-test-'));
			const cfg = makeCfg(dir);
			const finDue: FinanceDueResult = {
				credits: [{
					kind: 'lead',
					credit_id: 'fake-credit-dryrun',
					label: 'Кредит для dry-run',
					amount: 51000,
					currency: 'RUB',
					dueDate: '2026-06-26T00:00:00Z',
					balanceAfter: 449000,
					account: undefined,
					fireKey: 'credit:fake-credit-dryrun:2026-06-26:lead',
					payoffDate: '2028-06-01',
				}],
				milestones: [],
				cashSurvey: { isDue: false, fireKey: 'cash-survey:2026-06-08' },
				idleNudge: { isDue: false, idleDays: 0, fireKey: 'idle-nudge:2026-06-08' },
			};

			// Пишем due-напоминание чтобы sweep не отсеялся на шаге «нечего due».
			writeFileSync(
				cfg.remindersPath,
				['---', 'id: t', 'due_at: 2026-06-08T10:02:00+03:00', 'status: pending'].join('\n'),
				'utf8',
			);

			// dry-run пишет промпт в stdout — проверяем что финанс-блок там есть.
			const written: string[] = [];
			const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
				written.push(String(s));
				return true;
			});

			await runSweep(cfg, { now: NOW, dryRun: true, finDue });
			spy.mockRestore();

			const combined = written.join('');
			expect(combined).toContain('ФИНАНСОВЫЙ ПУЛЬС');
		} finally {
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});
});
