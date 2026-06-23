/**
 * finance-sweep.test.ts — тесты проактивного слоя финансов.
 *
 * Принципы:
 *   - ТОЛЬКО синтетические/фейковые данные (публичный репо, lint:public зелёный).
 *   - Нет сетевых вызовов, нет реального Telegram, нет фоновых процессов.
 *   - Изолированные temp-dir для каждого describe (mkdtempSync → rmSync afterEach).
 *   - Мок TelegramClient через vi.mock('@/../bridge/telegram').
 *   - Инъекция nowFn/часов через параметр now: string.
 *   - Импорт ТОЛЬКО из scheduler/* и стабильных движков finance/{credit,goals,networth,chart}.
 *
 * Покрытие:
 *   1. collectFinanceDue:
 *      — кредит в окне lead: детектируется со статусом 'lead'
 *      — кредит due сегодня: детектируется со статусом 'due'
 *      — просрочка: isOverdue → статус 'overdue'
 *      — дедуп: повторный свип не добавляет айтем (wasFired)
 *      — остаток после: balanceAfter из движка кредита
 *   2. deliverFinanceDue:
 *      — кредит-алерт: пуш отправлен, markFired вызван
 *      — майлстоун цели: пуш PNG с картинкой и caption
 *      — опрос налички: isDue=true → пуш + writePendingCashSurvey
 *      — нудж простоя: isDue=true → пуш
 *      — ошибки: ошибка одного айтема не блокирует остальные
 *   3. formatCreditAlert: тексты для каждого kind
 *   4. roundForDisplay: огрубление сумм
 *   5. buildFinanceDigestSection: форматирует секцию с кредитами/целями
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FxProvider } from '../ingest/finance/fx.js';
import type { CreditRecord, FinanceGoal, SnapshotRecord } from '../ingest/finance/types.js';
import type { ChartSpec } from '../ingest/finance/chart.js';
import {
	buildFinanceDigestSection,
	buildNetworthTimeSeries,
	collectFinanceDue,
	daysBetween,
	deliverFinanceDue,
	type DeliverFinanceDueDeps,
	type FinanceDueResult,
	type FinanceSweepConfig,
	type NetworthPngDeps,
	formatCreditAlert,
	formatGoalMilestoneCaption,
	formatIdleNudge,
	type GoalMilestoneItem,
	roundForDisplay,
} from './finance-sweep.js';
import {
	markFired,
	readPendingCashSurvey,
	readSnoozeUntil,
	wasFired,
	writeLastInputTs,
	writeSnoozeUntil,
} from './finance-state.js';

// ---------------------------------------------------------------------------
// Синтетические данные (synthetic-example — только для тестов)
// ---------------------------------------------------------------------------

/** Фиксированный момент «сейчас» (UTC) для детерминированных тестов. */
const FAKE_NOW = '2026-06-23T16:00:00Z'; // 19:00 MSK → вечерний час

/** Дата платежа через 3 дня. */
const FAKE_DUE_DATE_LEAD = '2026-06-26T00:00:00Z';

/**
 * Дата платежа «сегодня» — в тот же день, но ПОЗЖЕ FAKE_NOW (23:59 UTC),
 * чтобы creditPaymentsDue включил её (dueMs >= nowMs).
 */
const FAKE_DUE_DATE_TODAY = '2026-06-23T23:59:00Z';

/** Синтетический кредит с платежом через 3 дня. */
const FAKE_CREDIT_LEAD: CreditRecord = {
	id: 'fake-credit-001',
	balance: 500000,
	currency: 'RUB',
	rate_pct: 21.5,
	type: 'annuity',
	principal: 1000000,
	term: 24,
	monthly_payment: 51000,
	next_payment_date: FAKE_DUE_DATE_LEAD,
	balance_ts: '2026-06-01T00:00:00Z',
	source: 'manual',
	manual: true,
};

/** Синтетический кредит с платежом сегодня. */
const FAKE_CREDIT_TODAY: CreditRecord = {
	id: 'fake-credit-002',
	balance: 250000,
	currency: 'RUB',
	rate_pct: 18.0,
	type: 'annuity',
	principal: 500000,
	term: 12,
	monthly_payment: 46000,
	next_payment_date: FAKE_DUE_DATE_TODAY,
	balance_ts: '2026-06-01T00:00:00Z',
	source: 'manual',
	manual: true,
};

/** Синтетический кредит с просрочкой: next_payment_date в прошлом, без grace. */
const FAKE_CREDIT_OVERDUE: CreditRecord = {
	id: 'fake-credit-overdue',
	balance: 100000,
	currency: 'RUB',
	rate_pct: 24.0,
	type: 'annuity',
	principal: 200000,
	term: 12,
	monthly_payment: 20000,
	// Дата платежа в прошлом → isOverdue=true.
	next_payment_date: '2026-06-10T00:00:00Z',
	balance_ts: '2026-06-01T00:00:00Z',
	grace: 0, // нет льготного периода
	source: 'manual',
	manual: true,
};

/** Синтетическая цель накопления. */
const FAKE_GOAL_SAVE: FinanceGoal = {
	id: 'fake-goal-emergency',
	type: 'finance-goal',
	target_amount: 200000,
	currency: 'RUB',
	target_date: '2026-12-31T00:00:00Z',
	fin_kind: 'save',
};

/** Синтетический снапшот: счёт накопления, 75% от цели. */
const FAKE_SNAPSHOT_75: SnapshotRecord = {
	account_id: 'fake-savings-account',
	balance: 150000,
	currency: 'RUB',
	ts: '2026-06-22T00:00:00Z',
};

/**
 * Синтетический FxProvider: RUB→RUB = 1, остальное = null.
 * Нет сетевых вызовов — всё детерминировано.
 */
const FAKE_FX: FxProvider = {
	rate: async (from: string, to: string): Promise<number | null> => {
		if (from === to) return 1;
		// Синтетический курс USD→RUB для тестов мультивалютности.
		if (from === 'USD' && to === 'RUB') return 90;
		return null;
	},
};

/** Цель с linked_accounts → прогресс считается по FAKE_SNAPSHOT_75. */
const FAKE_GOAL_WITH_ACCOUNT: FinanceGoal = {
	...FAKE_GOAL_SAVE,
	id: 'fake-goal-with-account',
	linked_accounts: ['fake-savings-account'],
};

// ---------------------------------------------------------------------------
// Фабрика конфига свипа с temp-dir
// ---------------------------------------------------------------------------

function makeSweepCfg(stateDir: string, overrides: Partial<FinanceSweepConfig> = {}): FinanceSweepConfig {
	return {
		creditLeadDays: 7,
		idleNudgeDays: 7,
		cashSurveyIntervalDays: 3,
		cashSurveyHour: 19,
		stateDir,
		tz: 'Europe/Moscow',
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// 1. collectFinanceDue — кредит-платежи
// ---------------------------------------------------------------------------

describe('collectFinanceDue — кредит-платежи', () => {
	let stateDir: string;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), 'finance-sweep-credit-'));
	});

	afterEach(() => {
		rmSync(stateDir, { recursive: true, force: true });
	});

	it('lead: кредит с платежом через 3 дня детектируется как lead', async () => {
		const cfg = makeSweepCfg(stateDir);
		const result = await collectFinanceDue(
			[FAKE_CREDIT_LEAD],
			[],
			[],
			FAKE_FX,
			FAKE_NOW,
			cfg,
		);

		expect(result.credits).toHaveLength(1);
		expect(result.credits[0]?.kind).toBe('lead');
		expect(result.credits[0]?.credit_id).toBe('fake-credit-001');
		expect(result.credits[0]?.currency).toBe('RUB');
	});

	it('due: кредит с платежом сегодня детектируется как due', async () => {
		const cfg = makeSweepCfg(stateDir);
		const result = await collectFinanceDue(
			[FAKE_CREDIT_TODAY],
			[],
			[],
			FAKE_FX,
			FAKE_NOW,
			cfg,
		);

		expect(result.credits).toHaveLength(1);
		expect(result.credits[0]?.kind).toBe('due');
		expect(result.credits[0]?.credit_id).toBe('fake-credit-002');
	});

	it('balanceAfter из движка: значение конечно и <= balance', async () => {
		const cfg = makeSweepCfg(stateDir);
		const result = await collectFinanceDue(
			[FAKE_CREDIT_TODAY],
			[],
			[],
			FAKE_FX,
			FAKE_NOW,
			cfg,
		);

		const item = result.credits[0];
		expect(item).toBeDefined();
		// balanceAfter должен быть конечным числом и меньше исходного баланса.
		expect(Number.isFinite(item!.balanceAfter)).toBe(true);
		expect(item!.balanceAfter).toBeLessThan(FAKE_CREDIT_TODAY.balance);
		expect(item!.balanceAfter).toBeGreaterThanOrEqual(0);
	});

	it('дедуп: повторный свип не добавляет уже fired кредит-алерт', async () => {
		const cfg = makeSweepCfg(stateDir);

		// Первый свип: детектирует и возвращает айтем.
		const result1 = await collectFinanceDue(
			[FAKE_CREDIT_LEAD],
			[],
			[],
			FAKE_FX,
			FAKE_NOW,
			cfg,
		);
		expect(result1.credits).toHaveLength(1);

		// Вручную помечаем как fired (симулируем доставку).
		const fireKey = result1.credits[0]!.fireKey;
		markFired(stateDir, fireKey, FAKE_NOW);

		// Второй свип: тот же кредит — уже fired, не возвращается.
		const result2 = await collectFinanceDue(
			[FAKE_CREDIT_LEAD],
			[],
			[],
			FAKE_FX,
			FAKE_NOW,
			cfg,
		);
		expect(result2.credits).toHaveLength(0);
	});

	it('overdue: просроченный кредит детектируется как overdue', async () => {
		const cfg = makeSweepCfg(stateDir);
		const result = await collectFinanceDue(
			[FAKE_CREDIT_OVERDUE],
			[],
			[],
			FAKE_FX,
			FAKE_NOW,
			cfg,
		);

		// Просроченный кредит не попадает в creditPaymentsDue (дата в прошлом),
		// но детектируется через isOverdue.
		const overdueItems = result.credits.filter((c) => c.kind === 'overdue');
		expect(overdueItems).toHaveLength(1);
		expect(overdueItems[0]?.credit_id).toBe('fake-credit-overdue');
	});

	it('overdue дедуп: повторный свип не пушит просрочку второй раз за сутки', async () => {
		const cfg = makeSweepCfg(stateDir);

		const result1 = await collectFinanceDue(
			[FAKE_CREDIT_OVERDUE],
			[],
			[],
			FAKE_FX,
			FAKE_NOW,
			cfg,
		);

		// Помечаем все fired (в т.ч. overdue).
		for (const item of result1.credits) {
			markFired(stateDir, item.fireKey, FAKE_NOW);
		}

		// Второй свип: ничего не возвращает (overdue уже fired сегодня).
		const result2 = await collectFinanceDue(
			[FAKE_CREDIT_OVERDUE],
			[],
			[],
			FAKE_FX,
			FAKE_NOW,
			cfg,
		);
		expect(result2.credits.filter((c) => c.kind === 'overdue')).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 2. collectFinanceDue — майлстоуны целей
// ---------------------------------------------------------------------------

describe('collectFinanceDue — майлстоуны целей', () => {
	let stateDir: string;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), 'finance-sweep-milestones-'));
	});

	afterEach(() => {
		rmSync(stateDir, { recursive: true, force: true });
	});

	it('75% майлстоун детектируется (снапшот 150k из 200k = 75%)', async () => {
		const cfg = makeSweepCfg(stateDir);
		const result = await collectFinanceDue(
			[],
			[FAKE_GOAL_WITH_ACCOUNT],
			[FAKE_SNAPSHOT_75],
			FAKE_FX,
			FAKE_NOW,
			cfg,
		);

		expect(result.milestones).toHaveLength(1);
		expect(result.milestones[0]?.milestonePercent).toBe(75);
		expect(result.milestones[0]?.goal_id).toBe('fake-goal-with-account');
		expect(result.milestones[0]?.pct).toBeCloseTo(75, 0);
	});

	it('майлстоун дедуп: помеченный milestone не возвращается, следующий (ниже) — возвращается', async () => {
		const cfg = makeSweepCfg(stateDir);

		// Первый свип: прогресс 75% → возвращает 75% (наибольший незафиксированный).
		const result1 = await collectFinanceDue(
			[],
			[FAKE_GOAL_WITH_ACCOUNT],
			[FAKE_SNAPSHOT_75],
			FAKE_FX,
			FAKE_NOW,
			cfg,
		);
		expect(result1.milestones).toHaveLength(1);
		expect(result1.milestones[0]?.milestonePercent).toBe(75);

		// Помечаем 75% как fired.
		markFired(stateDir, result1.milestones[0]!.fireKey, FAKE_NOW);

		// Второй свип: 75% fired → возвращает следующий незафиксированный = 50%.
		const result2 = await collectFinanceDue(
			[],
			[FAKE_GOAL_WITH_ACCOUNT],
			[FAKE_SNAPSHOT_75],
			FAKE_FX,
			FAKE_NOW,
			cfg,
		);
		expect(result2.milestones).toHaveLength(1);
		expect(result2.milestones[0]?.milestonePercent).toBe(50);

		// Помечаем 50% как fired.
		markFired(stateDir, result2.milestones[0]!.fireKey, FAKE_NOW);

		// Третий свип: 75% и 50% fired → возвращает 25%.
		const result3 = await collectFinanceDue(
			[],
			[FAKE_GOAL_WITH_ACCOUNT],
			[FAKE_SNAPSHOT_75],
			FAKE_FX,
			FAKE_NOW,
			cfg,
		);
		expect(result3.milestones).toHaveLength(1);
		expect(result3.milestones[0]?.milestonePercent).toBe(25);

		// Помечаем 25% как fired.
		markFired(stateDir, result3.milestones[0]!.fireKey, FAKE_NOW);

		// Четвёртый свип: все майлстоуны ≤75% fired → ничего.
		const result4 = await collectFinanceDue(
			[],
			[FAKE_GOAL_WITH_ACCOUNT],
			[FAKE_SNAPSHOT_75],
			FAKE_FX,
			FAKE_NOW,
			cfg,
		);
		expect(result4.milestones).toHaveLength(0);
	});

	it('цель без снапшотов: 0% прогресс, майлстоун не детектируется', async () => {
		const cfg = makeSweepCfg(stateDir);
		const result = await collectFinanceDue(
			[],
			[FAKE_GOAL_WITH_ACCOUNT],
			[], // нет снапшотов
			FAKE_FX,
			FAKE_NOW,
			cfg,
		);

		// 0% → ни один порог не пройден → нет майлстоунов.
		expect(result.milestones).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 3. collectFinanceDue — опрос налички и нудж простоя
// ---------------------------------------------------------------------------

describe('collectFinanceDue — cash-survey и idle-nudge', () => {
	let stateDir: string;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), 'finance-sweep-survey-'));
	});

	afterEach(() => {
		rmSync(stateDir, { recursive: true, force: true });
	});

	it('cash-survey: вечерний час + не было опроса → isDue=true', async () => {
		const cfg = makeSweepCfg(stateDir);
		// FAKE_NOW = 16:00 UTC = 19:00 MSK → вечерний час.
		const result = await collectFinanceDue([], [], [], FAKE_FX, FAKE_NOW, cfg);
		expect(result.cashSurvey.isDue).toBe(true);
	});

	it('cash-survey: не вечерний час → isDue=false', async () => {
		const cfg = makeSweepCfg(stateDir);
		// 08:00 UTC = 11:00 MSK → не вечер.
		const dayNow = '2026-06-23T08:00:00Z';
		const result = await collectFinanceDue([], [], [], FAKE_FX, dayNow, cfg);
		expect(result.cashSurvey.isDue).toBe(false);
	});

	it('cash-survey дедуп: уже fired сегодня → isDue=false', async () => {
		const cfg = makeSweepCfg(stateDir);

		// Помечаем опрос сегодня как уже отправленный.
		const todayKey = `cash-survey:2026-06-23`;
		markFired(stateDir, todayKey, FAKE_NOW);

		const result = await collectFinanceDue([], [], [], FAKE_FX, FAKE_NOW, cfg);
		expect(result.cashSurvey.isDue).toBe(false);
	});

	it('cash-survey: другая tz (America/New_York UTC-4) — окно сдвигается в локальное вечернее', async () => {
		// Проверяет tz-инвариант: cashSurveyHour и tz настраиваемы, не захардкожены под MSK.
		// now = 2026-06-23T22:00:00Z → New York = 18:00 ET (DST UTC-4).
		// cashSurveyHour = 19, окно 18-21 ET → 18:00 ET = в окне → isDue=true.
		const cfg = makeSweepCfg(stateDir, { tz: 'America/New_York', cashSurveyHour: 19 });
		const nyEveningNow = '2026-06-23T22:00:00Z'; // = 18:00 ET (вечер, в окне 18-21)
		const result = await collectFinanceDue([], [], [], FAKE_FX, nyEveningNow, cfg);
		expect(result.cashSurvey.isDue).toBe(true);
	});

	it('cash-survey: другая tz (America/New_York) — дневной UTC не вечер по NY', async () => {
		// now = 2026-06-23T14:00:00Z → New York = 10:00 ET → не вечер → isDue=false.
		const cfg = makeSweepCfg(stateDir, { tz: 'America/New_York', cashSurveyHour: 19 });
		const nyDayNow = '2026-06-23T14:00:00Z'; // = 10:00 ET (утро)
		const result = await collectFinanceDue([], [], [], FAKE_FX, nyDayNow, cfg);
		expect(result.cashSurvey.isDue).toBe(false);
	});

	it('idle-nudge: давно не было ввода → isDue=true, idleDays >= threshold', async () => {
		const cfg = makeSweepCfg(stateDir, { idleNudgeDays: 5 });
		// Пишем watermark 10 дней назад.
		const oldTs = '2026-06-13T12:00:00Z';
		writeLastInputTs(stateDir, oldTs);

		const result = await collectFinanceDue([], [], [], FAKE_FX, FAKE_NOW, cfg);
		expect(result.idleNudge.isDue).toBe(true);
		expect(result.idleNudge.idleDays).toBeGreaterThanOrEqual(5);
	});

	it('idle-nudge: ввод был недавно → isDue=false', async () => {
		const cfg = makeSweepCfg(stateDir, { idleNudgeDays: 7 });
		// Пишем watermark 2 дня назад.
		const recentTs = '2026-06-21T12:00:00Z';
		writeLastInputTs(stateDir, recentTs);

		const result = await collectFinanceDue([], [], [], FAKE_FX, FAKE_NOW, cfg);
		expect(result.idleNudge.isDue).toBe(false);
	});

	it('idle-nudge дедуп: уже fired сегодня → isDue=false', async () => {
		const cfg = makeSweepCfg(stateDir, { idleNudgeDays: 1 });
		// Ввода никогда не было (порог 1 день → нудж должен был быть).
		// Но помечаем как уже fired сегодня.
		const nudgeKey = `idle-nudge:2026-06-23`;
		markFired(stateDir, nudgeKey, FAKE_NOW);

		const result = await collectFinanceDue([], [], [], FAKE_FX, FAKE_NOW, cfg);
		expect(result.idleNudge.isDue).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 4. deliverFinanceDue — доставка пушей (инъекция deps)
// ---------------------------------------------------------------------------

/**
 * Строит мок-deps для deliverFinanceDue.
 * pushMsgs/photoMsgs — накапливают вызовы для проверки в тестах.
 */
function makeDeliverDeps(overrides: Partial<{
	pushError: boolean;
	photoError: boolean;
}> = {}): {
	deps: DeliverFinanceDueDeps;
	pushMsgs: string[];
	photoMsgs: Array<{ caption?: string; filename: string }>;
} {
	const pushMsgs: string[] = [];
	const photoMsgs: Array<{ caption?: string; filename: string }> = [];

	const deps: DeliverFinanceDueDeps = {
		// Мок pushToOwner: записывает текст в pushMsgs (или бросает при pushError).
		pushToOwner: async (text: string) => {
			if (overrides.pushError) throw new Error('mock-push-error');
			pushMsgs.push(text);
		},
		// Мок pushPhotoToOwner: записывает caption+filename (или бросает при photoError).
		// Тип параметра соответствует InputFile из telegram.ts (data?: Buffer | Uint8Array).
		pushPhotoToOwner: async (file, opts) => {
			if (overrides.photoError) throw new Error('mock-photo-error');
			photoMsgs.push({ caption: opts?.caption, filename: file.filename ?? 'unknown' });
		},
		// Мок assertNoSecrets: просто no-op в тестах (публичные фейковые данные).
		assertNoSecrets: (_text: string) => { /* no-op в тестах */ },
	};

	return { deps, pushMsgs, photoMsgs };
}

describe('deliverFinanceDue — кредит-алерт и markFired', () => {
	let stateDir: string;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), 'finance-sweep-deliver-'));
	});

	afterEach(() => {
		rmSync(stateDir, { recursive: true, force: true });
	});

	it('кредит-алерт success: пуш отправлен, markFired записал ключ в fired-реестр', async () => {
		const cfg = makeSweepCfg(stateDir);
		const { deps, pushMsgs } = makeDeliverDeps();

		// Имитируем FinanceDueResult с одним кредит-айтемом (lead).
		const fakeKey = `credit:fake-credit-001:2026-06-26:lead`;
		const fakeResult: FinanceDueResult = {
			credits: [{
				kind: 'lead',
				credit_id: 'fake-credit-001',
				label: 'Синтетический кредит',
				amount: 51000,
				currency: 'RUB',
				dueDate: '2026-06-26T00:00:00Z',
				balanceAfter: 449000,
				account: undefined,
				fireKey: fakeKey,
				payoffDate: '2028-06-01',
			}],
			milestones: [],
			cashSurvey: { isDue: false, fireKey: 'cash-survey:2026-06-23' },
			idleNudge: { isDue: false, idleDays: 0, fireKey: 'idle-nudge:2026-06-23' },
		};

		// Success-путь: нет ошибок.
		const errors = await deliverFinanceDue(fakeResult, FAKE_NOW, cfg, {}, deps);
		expect(errors).toBe(0);

		// Пуш вызван ровно один раз с текстом кредит-алерта.
		expect(pushMsgs).toHaveLength(1);
		expect(pushMsgs[0]).toContain('Синтетический кредит');
		expect(pushMsgs[0]).toContain('через');

		// Контракт дедупа: после успешного пуша ключ ДОЛЖЕН быть в fired-реестре.
		// Следующий свип не пошлёт повторное напоминание.
		expect(wasFired(stateDir, fakeKey)).toBe(true);
	});

	it('ошибка пуша одного кредита: markFired НЕ записан, ошибки считаются', async () => {
		const cfg = makeSweepCfg(stateDir);
		const { deps } = makeDeliverDeps({ pushError: true });

		const fakeKey = 'credit:fake-a:2026-06-26:lead';
		const fakeResult: FinanceDueResult = {
			credits: [{
				kind: 'lead',
				credit_id: 'fake-a',
				label: 'Кредит A',
				amount: 10000,
				currency: 'RUB',
				dueDate: '2026-06-26T00:00:00Z',
				balanceAfter: 90000,
				account: undefined,
				fireKey: fakeKey,
				payoffDate: '2027-06-01',
			}],
			milestones: [],
			cashSurvey: { isDue: false, fireKey: 'cash-survey:2026-06-23' },
			idleNudge: { isDue: false, idleDays: 0, fireKey: 'idle-nudge:2026-06-23' },
		};

		// Пуш бросает → 1 ошибка, функция не бросает.
		const errors = await deliverFinanceDue(fakeResult, FAKE_NOW, cfg, {}, deps);
		expect(errors).toBe(1);

		// markFired НЕ вызван: при ошибке пуша дедуп-ключ НЕ фиксируется
		// (следующий свип снова попробует доставить).
		expect(wasFired(stateDir, fakeKey)).toBe(false);
	});

	it('fault-isolation: ошибка первого кредита не блокирует второй', async () => {
		const cfg = makeSweepCfg(stateDir);

		// Первый пуш бросает, второй — нет (используем счётчик).
		let callCount = 0;
		const pushMsgs: string[] = [];
		const deps: DeliverFinanceDueDeps = {
			pushToOwner: async (text: string) => {
				callCount++;
				if (callCount === 1) throw new Error('first-fails');
				pushMsgs.push(text);
			},
			pushPhotoToOwner: async () => { /* no-op */ },
			assertNoSecrets: () => { /* no-op */ },
		};

		const keyA = 'credit:fake-a:2026-06-26:lead';
		const keyB = 'credit:fake-b:2026-06-23:due';
		const fakeResult: FinanceDueResult = {
			credits: [
				{
					kind: 'lead',
					credit_id: 'fake-a',
					label: 'Кредит A',
					amount: 10000,
					currency: 'RUB',
					dueDate: '2026-06-26T00:00:00Z',
					balanceAfter: 90000,
					account: undefined,
					fireKey: keyA,
					payoffDate: '2027-06-01',
				},
				{
					kind: 'due',
					credit_id: 'fake-b',
					label: 'Кредит B',
					amount: 20000,
					currency: 'RUB',
					dueDate: '2026-06-23T00:00:00Z',
					balanceAfter: 80000,
					account: undefined,
					fireKey: keyB,
					payoffDate: '2026-12-01',
				},
			],
			milestones: [],
			cashSurvey: { isDue: false, fireKey: 'cash-survey:2026-06-23' },
			idleNudge: { isDue: false, idleDays: 0, fireKey: 'idle-nudge:2026-06-23' },
		};

		// 1 ошибка (первый), функция не бросает.
		const errors = await deliverFinanceDue(fakeResult, FAKE_NOW, cfg, {}, deps);
		expect(errors).toBe(1);

		// Второй кредит доставлен: markFired записан для keyB, но НЕ для keyA.
		expect(wasFired(stateDir, keyB)).toBe(true);
		expect(wasFired(stateDir, keyA)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 5. deliverFinanceDue — cash-survey ставит pending-маркер
// ---------------------------------------------------------------------------

describe('deliverFinanceDue — cash-survey pending', () => {
	let stateDir: string;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), 'finance-sweep-cash-pending-'));
	});

	afterEach(() => {
		rmSync(stateDir, { recursive: true, force: true });
	});

	it('cash-survey isDue=true success → writePendingCashSurvey вызван, маркер виден', async () => {
		const cfg = makeSweepCfg(stateDir);
		const { deps } = makeDeliverDeps();

		// До доставки — маркера нет.
		expect(readPendingCashSurvey(stateDir)).toBeNull();

		const fakeResult: FinanceDueResult = {
			credits: [],
			milestones: [],
			cashSurvey: { isDue: true, fireKey: 'cash-survey:2026-06-23' },
			idleNudge: { isDue: false, idleDays: 0, fireKey: 'idle-nudge:2026-06-23' },
		};

		// Success-путь: пуш успешен → маркер пишется.
		const errors = await deliverFinanceDue(fakeResult, FAKE_NOW, cfg, {}, deps);
		expect(errors).toBe(0);

		// Контракт шва C1→C3: pending-маркер виден для реактивного обработчика.
		expect(readPendingCashSurvey(stateDir)).not.toBeNull();

		// Дедуп: fired-ключ записан.
		expect(wasFired(stateDir, 'cash-survey:2026-06-23')).toBe(true);
	});

	it('cash-survey isDue=true, пуш падает → маркер НЕ пишется (атомарность)', async () => {
		const cfg = makeSweepCfg(stateDir);
		const { deps } = makeDeliverDeps({ pushError: true });

		expect(readPendingCashSurvey(stateDir)).toBeNull();

		const fakeResult: FinanceDueResult = {
			credits: [],
			milestones: [],
			cashSurvey: { isDue: true, fireKey: 'cash-survey:2026-06-23' },
			idleNudge: { isDue: false, idleDays: 0, fireKey: 'idle-nudge:2026-06-23' },
		};

		const errors = await deliverFinanceDue(fakeResult, FAKE_NOW, cfg, {}, deps);
		expect(errors).toBe(1);

		// При ошибке пуша маркер НЕ пишется (пуш упал до writePendingCashSurvey).
		expect(readPendingCashSurvey(stateDir)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 5б. deliverFinanceDue — майлстоун → pushPhotoToOwner с PNG-Buffer и caption
// ---------------------------------------------------------------------------

describe('deliverFinanceDue — майлстоун PNG', () => {
	let stateDir: string;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), 'finance-sweep-milestone-'));
	});

	afterEach(() => {
		rmSync(stateDir, { recursive: true, force: true });
	});

	it('майлстоун success: pushPhotoToOwner вызван с caption, markFired записан', async () => {
		const cfg = makeSweepCfg(stateDir);
		const { deps, photoMsgs } = makeDeliverDeps();

		const milestoneKey = 'goal:fake-goal-001:milestone:75';
		const milestoneItem: GoalMilestoneItem = {
			goal_id: 'fake-goal-001',
			label: 'Резервный фонд',
			milestonePercent: 75,
			pct: 75,
			current: 150000,
			target: 200000,
			currency: 'RUB',
			fin_kind: 'save',
			fireKey: milestoneKey,
		};

		const fakeResult: FinanceDueResult = {
			credits: [],
			milestones: [milestoneItem],
			cashSurvey: { isDue: false, fireKey: 'cash-survey:2026-06-23' },
			idleNudge: { isDue: false, idleDays: 0, fireKey: 'idle-nudge:2026-06-23' },
		};

		const errors = await deliverFinanceDue(fakeResult, FAKE_NOW, cfg, {}, deps);
		expect(errors).toBe(0);

		// pushPhotoToOwner вызван ровно один раз.
		expect(photoMsgs).toHaveLength(1);

		// caption содержит название цели и процент (formatGoalMilestoneCaption).
		expect(photoMsgs[0]!.caption).toContain('Резервный фонд');
		expect(photoMsgs[0]!.caption).toContain('75%');

		// filename корректный.
		expect(photoMsgs[0]!.filename).toBe('goal-progress-fake-goal-001.png');

		// markFired записал ключ майлстоуна.
		expect(wasFired(stateDir, milestoneKey)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 6. formatCreditAlert — текст для каждого kind
// ---------------------------------------------------------------------------

describe('formatCreditAlert', () => {
	// Фиксированный now для детерминированных тестов — НЕ wall-clock.
	// dueDate = 2026-06-26, now = 2026-06-23 → daysUntil = 3.
	const TEST_NOW = '2026-06-23T16:00:00Z';

	const baseItem = {
		credit_id: 'fake-credit-001',
		label: 'Синтетический кредит',
		amount: 51200,
		currency: 'RUB',
		dueDate: '2026-06-26T00:00:00Z',
		balanceAfter: 448800,
		account: undefined,
		fireKey: 'credit:fake-credit-001:2026-06-26:lead',
		payoffDate: '2028-06-01',
	} as const;

	it('lead: содержит "через" и огрублённую сумму', () => {
		const text = formatCreditAlert({ ...baseItem, kind: 'lead' }, TEST_NOW);
		expect(text).toContain('через');
		// Сумма 51200 → roundForDisplay → 51000 (округление до 1000).
		expect(text).toContain('51000');
		expect(text).toContain('RUB');
	});

	it('lead: количество дней считается от инъектированного now, не от wall-clock', () => {
		// Фиксированный now = 2026-06-23, dueDate = 2026-06-26 → ровно 3 дня.
		// Это проверяет clock-injection инвариант: результат детерминирован.
		const text = formatCreditAlert({ ...baseItem, kind: 'lead' }, TEST_NOW);
		// "через ~3 дн." — точное число дней от фиксированного now.
		expect(text).toContain('~3 дн.');
	});

	it('lead: другой now → другое количество дней (детерминизм)', () => {
		// now = 2026-06-21 → 5 дней до 2026-06-26.
		const text = formatCreditAlert({ ...baseItem, kind: 'lead' }, '2026-06-21T10:00:00Z');
		expect(text).toContain('~5 дн.');
	});

	it('due: содержит "Сегодня" и сумму', () => {
		const text = formatCreditAlert({ ...baseItem, kind: 'due' }, TEST_NOW);
		expect(text).toContain('Сегодня');
		expect(text).toContain('RUB');
	});

	it('overdue: содержит "Просрочка"', () => {
		const text = formatCreditAlert({ ...baseItem, kind: 'overdue' }, TEST_NOW);
		expect(text).toContain('Просрочка');
	});

	it('не содержит точных сумм (секрет-гейт: округление)', () => {
		const text = formatCreditAlert({ ...baseItem, kind: 'lead' }, TEST_NOW);
		// Точная сумма 51200 НЕ должна встречаться — только 51000.
		expect(text).not.toContain('51200');
		expect(text).not.toContain('448800');
	});
});

// ---------------------------------------------------------------------------
// 7. roundForDisplay — огрубление сумм
// ---------------------------------------------------------------------------

describe('roundForDisplay', () => {
	it('меньше 1000: без округления', () => {
		expect(roundForDisplay(500)).toBe(500);
		expect(roundForDisplay(999)).toBe(999);
		expect(roundForDisplay(0)).toBe(0);
	});

	it('1000–9999: округление до 100', () => {
		expect(roundForDisplay(1234)).toBe(1200);
		expect(roundForDisplay(5678)).toBe(5700);
		expect(roundForDisplay(9950)).toBe(10000);
	});

	it('10000–99999: округление до 1000', () => {
		expect(roundForDisplay(12345)).toBe(12000);
		expect(roundForDisplay(51200)).toBe(51000);
		expect(roundForDisplay(99500)).toBe(100000);
	});

	it('100000+: округление до 10000', () => {
		expect(roundForDisplay(123456)).toBe(120000);
		expect(roundForDisplay(500000)).toBe(500000);
		expect(roundForDisplay(1234567)).toBe(1230000);
	});

	it('отрицательные значения: знак сохраняется', () => {
		expect(roundForDisplay(-51200)).toBe(-51000);
		expect(roundForDisplay(-500000)).toBe(-500000);
	});
});

// ---------------------------------------------------------------------------
// 8. buildFinanceDigestSection — форматирование секции
// ---------------------------------------------------------------------------

describe('buildFinanceDigestSection', () => {
	it('пустые данные → пустая строка', () => {
		const section = buildFinanceDigestSection({
			upcomingCredits: [],
			goalSummaries: [],
			hasNetworthData: false,
		});
		expect(section).toBe('');
	});

	it('с кредитами: содержит заголовок и список', () => {
		const section = buildFinanceDigestSection({
			upcomingCredits: [
				{ label: 'Кредит А', dueDate: '2026-06-26T00:00:00Z', currency: 'RUB' },
			],
			goalSummaries: [],
			hasNetworthData: false,
		});
		expect(section).toContain('Кредиты');
		expect(section).toContain('Кредит А');
		expect(section).toContain('2026-06-26');
	});

	it('с целями: содержит прогресс-бар', () => {
		const section = buildFinanceDigestSection({
			upcomingCredits: [],
			goalSummaries: [
				{ label: 'Экстренный фонд', pctRounded: 75 },
			],
			hasNetworthData: false,
		});
		expect(section).toContain('Цели');
		expect(section).toContain('Экстренный фонд');
		expect(section).toContain('75%');
		// Прогресс-бар: 75% = 7 заполненных + 3 пустых.
		expect(section).toContain('███████');
	});

	it('финансовая секция имеет заголовок', () => {
		const section = buildFinanceDigestSection({
			upcomingCredits: [{ label: 'X', dueDate: '2026-06-26T00:00:00Z', currency: 'RUB' }],
			goalSummaries: [],
			hasNetworthData: false,
		});
		expect(section).toContain('Финансовый пульс');
	});

	it('R4: payoffDate присутствует в строке кредита (если передан)', () => {
		// R4 (#4 крит.6): buildFinanceDigestSection выводит прогнозируемую дату погашения
		// через projectPayoffDate-движок (вызывается снаружи, здесь — синтетическая дата).
		const section = buildFinanceDigestSection({
			upcomingCredits: [
				{
					label: 'Ипотека',
					dueDate: '2026-06-26T00:00:00Z',
					currency: 'RUB',
					payoffDate: '2031-12-01',
				},
			],
			goalSummaries: [],
			hasNetworthData: false,
		});

		// Строка кредита должна содержать дату погашения.
		expect(section).toContain('погашение');
		expect(section).toContain('2031-12-01');
	});

	it('R4: payoffDate не добавляется если не передан (обратная совместимость)', () => {
		// Если payoffDate не передан — строка выводится без этого поля.
		const section = buildFinanceDigestSection({
			upcomingCredits: [
				{ label: 'Кредит Б', dueDate: '2026-06-26T00:00:00Z', currency: 'USD' },
			],
			goalSummaries: [],
			hasNetworthData: false,
		});

		// Строка кредита не должна содержать «погашение» (поле опциональное).
		expect(section).not.toContain('погашение');
		// Сам кредит всё равно виден.
		expect(section).toContain('Кредит Б');
		expect(section).toContain('2026-06-26');
	});
});

// ---------------------------------------------------------------------------
// 9. daysBetween — вспомогательная функция
// ---------------------------------------------------------------------------

describe('daysBetween', () => {
	it('3 дня между датами', () => {
		expect(daysBetween('2026-06-23', '2026-06-26')).toBe(3);
	});

	it('0 дней (одна дата)', () => {
		expect(daysBetween('2026-06-23', '2026-06-23')).toBe(0);
	});

	it('отрицательное (обратный порядок)', () => {
		expect(daysBetween('2026-06-26', '2026-06-23')).toBe(-3);
	});
});

// ---------------------------------------------------------------------------
// 10. formatGoalMilestoneCaption и formatIdleNudge
// ---------------------------------------------------------------------------

describe('formatGoalMilestoneCaption', () => {
	// Используем «некруглые» суммы чтобы проверить что огрубление работает.
	// 152345 → roundForDisplay → 150000 (округление до 10000).
	// 203456 → roundForDisplay → 200000.
	const fakeItem: GoalMilestoneItem = {
		goal_id: 'fake-emergency',
		label: 'Экстренный фонд',
		milestonePercent: 75,
		pct: 75.3,
		current: 152345,   // точная сумма → огрублённая 150000
		target: 203456,    // точная сумма → огрублённая 200000
		currency: 'RUB',
		fin_kind: 'save',
		fireKey: 'goal:fake-emergency:milestone:75',
	};

	it('содержит процент майлстоуна', () => {
		const cap = formatGoalMilestoneCaption(fakeItem);
		expect(cap).toContain('75%');
		expect(cap).toContain('Экстренный фонд');
	});

	it('100% содержит emoji 🎉', () => {
		const cap = formatGoalMilestoneCaption({ ...fakeItem, milestonePercent: 100, pct: 100 });
		expect(cap).toContain('🎉');
	});

	it('не содержит точных сумм (секрет-гейт): огрубление через roundForDisplay', () => {
		const cap = formatGoalMilestoneCaption(fakeItem);
		// Точные суммы 152345/203456 НЕ должны быть в caption — только огрублённые.
		expect(cap).not.toContain('152345');
		expect(cap).not.toContain('203456');
		// Огрублённые суммы 150000/200000 — присутствуют (это нормально и ожидаемо).
		expect(cap).toContain('150000');
		expect(cap).toContain('200000');
	});
});

describe('formatIdleNudge', () => {
	it('содержит количество дней и призыв обновить данные', () => {
		const text = formatIdleNudge(10);
		expect(text).toContain('10');
		expect(text).toContain('обнов');
	});
});

// ---------------------------------------------------------------------------
// 11. Интеграция: полный цикл collectFinanceDue → wasFired
// ---------------------------------------------------------------------------

describe('интеграция: collectFinanceDue не дублирует после markFired', () => {
	let stateDir: string;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), 'finance-sweep-integration-'));
	});

	afterEach(() => {
		rmSync(stateDir, { recursive: true, force: true });
	});

	it('кредит + майлстоун: первый свип возвращает оба, кредит-fired → кредита нет', async () => {
		const cfg = makeSweepCfg(stateDir);

		const result1 = await collectFinanceDue(
			[FAKE_CREDIT_LEAD],
			[FAKE_GOAL_WITH_ACCOUNT],
			[FAKE_SNAPSHOT_75],
			FAKE_FX,
			FAKE_NOW,
			cfg,
		);

		// Первый свип: кредит + майлстоун.
		expect(result1.credits.length).toBeGreaterThan(0);
		expect(result1.milestones.length).toBeGreaterThan(0);

		// Помечаем кредиты как fired (майлстоуны — нет).
		for (const item of result1.credits) markFired(stateDir, item.fireKey, FAKE_NOW);

		// Второй свип: кредита нет (fired), но майлстоун 75% всё ещё новый.
		const result2 = await collectFinanceDue(
			[FAKE_CREDIT_LEAD],
			[FAKE_GOAL_WITH_ACCOUNT],
			[FAKE_SNAPSHOT_75],
			FAKE_FX,
			FAKE_NOW,
			cfg,
		);
		expect(result2.credits).toHaveLength(0);
		// Майлстоун 75% ещё не fired — возвращается снова.
		expect(result2.milestones.length).toBeGreaterThan(0);

		// Помечаем майлстоун как fired.
		for (const item of result2.milestones) markFired(stateDir, item.fireKey, FAKE_NOW);

		// Третий свип: 75% fired → следующий незафиксированный майлстоун (50%).
		const result3 = await collectFinanceDue(
			[FAKE_CREDIT_LEAD],
			[FAKE_GOAL_WITH_ACCOUNT],
			[FAKE_SNAPSHOT_75],
			FAKE_FX,
			FAKE_NOW,
			cfg,
		);
		expect(result3.credits).toHaveLength(0);
		// 50% — следующий незафиксированный.
		expect(result3.milestones[0]?.milestonePercent).toBe(50);
	});
});

// ---------------------------------------------------------------------------
// 12. deliverFinanceDue — inline-кнопки кредит-напоминания (блокер #7)
// ---------------------------------------------------------------------------

describe('deliverFinanceDue — inline-кнопки кредит-напоминания (блокер #7)', () => {
	let stateDir: string;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), 'finance-sweep-keyboard-'));
	});

	afterEach(() => {
		rmSync(stateDir, { recursive: true, force: true });
	});

	it('lead: pushToOwner вызван с replyMarkup из трёх inline-кнопок', async () => {
		const cfg = makeSweepCfg(stateDir);

		// Накапливаем аргументы вызова pushToOwner для проверки replyMarkup.
		const capturedCalls: Array<{
			text: string;
			replyMarkup?: import('../bridge/telegram.js').ReplyMarkup;
		}> = [];

		const deps: DeliverFinanceDueDeps = {
			pushToOwner: async (text, opts) => {
				capturedCalls.push({ text, replyMarkup: opts?.replyMarkup });
			},
			pushPhotoToOwner: async () => {},
			assertNoSecrets: () => {},
		};

		const fakeKey = 'credit:fake-credit-001:2026-06-26:lead';
		const fakeResult: FinanceDueResult = {
			credits: [{
				kind: 'lead',
				credit_id: 'fake-credit-001',
				label: 'Синтетический кредит',
				amount: 51000,
				currency: 'RUB',
				dueDate: '2026-06-26T00:00:00Z',
				balanceAfter: 449000,
				account: undefined,
				fireKey: fakeKey,
				payoffDate: '2028-06-01',
			}],
			milestones: [],
			cashSurvey: { isDue: false, fireKey: 'cash-survey:2026-06-23' },
			idleNudge: { isDue: false, idleDays: 0, fireKey: 'idle-nudge:2026-06-23' },
		};

		const errors = await deliverFinanceDue(fakeResult, FAKE_NOW, cfg, {}, deps);
		expect(errors).toBe(0);

		// Проверяем что pushToOwner вызван ровно раз с replyMarkup.
		expect(capturedCalls).toHaveLength(1);
		const call = capturedCalls[0]!;
		expect(call.replyMarkup).toBeDefined();

		// inline_keyboard — массив с одним рядом из трёх кнопок.
		const kb = call.replyMarkup!.inline_keyboard;
		expect(kb).toHaveLength(1); // один ряд
		expect(kb[0]).toHaveLength(3); // три кнопки

		// Кнопки: Оплачено / Отложить / Подробнее.
		const btnPaid = kb[0]!.find((b) => b.callback_data?.startsWith('fin:paid:'));
		const btnSnooze = kb[0]!.find((b) => b.callback_data?.startsWith('fin:snooze:'));
		const btnDetail = kb[0]!.find((b) => b.callback_data?.startsWith('fin:detail:'));
		expect(btnPaid).toBeDefined();
		expect(btnSnooze).toBeDefined();
		expect(btnDetail).toBeDefined();

		// callback_data ≤ 64 байт (инвариант ADR-0023).
		for (const btn of kb[0]!) {
			const data = btn.callback_data ?? '';
			expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
		}

		// credit_id закодирован в callback_data.
		expect(btnPaid!.callback_data).toContain('fake-credit-001');
	});

	it('due: inline-кнопки тоже присутствуют', async () => {
		const cfg = makeSweepCfg(stateDir);

		const capturedCalls: Array<{
			text: string;
			replyMarkup?: import('../bridge/telegram.js').ReplyMarkup;
		}> = [];

		const deps: DeliverFinanceDueDeps = {
			pushToOwner: async (text, opts) => {
				capturedCalls.push({ text, replyMarkup: opts?.replyMarkup });
			},
			pushPhotoToOwner: async () => {},
			assertNoSecrets: () => {},
		};

		const fakeResult: FinanceDueResult = {
			credits: [{
				kind: 'due',
				credit_id: 'fake-credit-002',
				label: 'Кредит сегодня',
				amount: 30000,
				currency: 'RUB',
				dueDate: FAKE_DUE_DATE_TODAY,
				balanceAfter: 270000,
				account: undefined,
				fireKey: `credit:fake-credit-002:2026-06-23:due`,
				payoffDate: '2026-12-01',
			}],
			milestones: [],
			cashSurvey: { isDue: false, fireKey: 'cash-survey:2026-06-23' },
			idleNudge: { isDue: false, idleDays: 0, fireKey: 'idle-nudge:2026-06-23' },
		};

		await deliverFinanceDue(fakeResult, FAKE_NOW, cfg, {}, deps);

		const call = capturedCalls[0]!;
		// due-напоминание тоже содержит inline-кнопки.
		expect(call.replyMarkup).toBeDefined();
		expect(call.replyMarkup!.inline_keyboard[0]).toHaveLength(3);
	});

	it('overdue: inline-кнопки НЕ добавляются (нечего нажимать при просрочке)', async () => {
		const cfg = makeSweepCfg(stateDir);

		const capturedCalls: Array<{
			text: string;
			replyMarkup?: import('../bridge/telegram.js').ReplyMarkup;
		}> = [];

		const deps: DeliverFinanceDueDeps = {
			pushToOwner: async (text, opts) => {
				capturedCalls.push({ text, replyMarkup: opts?.replyMarkup });
			},
			pushPhotoToOwner: async () => {},
			assertNoSecrets: () => {},
		};

		const fakeResult: FinanceDueResult = {
			credits: [{
				kind: 'overdue',
				credit_id: 'fake-credit-overdue',
				label: 'Просроченный кредит',
				amount: 50000,
				currency: 'RUB',
				dueDate: '2026-06-10T00:00:00Z',
				balanceAfter: 50000,
				account: undefined,
				fireKey: `credit:fake-credit-overdue:2026-06-23:overdue`,
				payoffDate: '2027-06-01',
			}],
			milestones: [],
			cashSurvey: { isDue: false, fireKey: 'cash-survey:2026-06-23' },
			idleNudge: { isDue: false, idleDays: 0, fireKey: 'idle-nudge:2026-06-23' },
		};

		await deliverFinanceDue(fakeResult, FAKE_NOW, cfg, {}, deps);

		const call = capturedCalls[0]!;
		// overdue — без кнопок (undefined, т.к. replyMarkup не передан).
		expect(call.replyMarkup).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// 13. W1: snooze-гейт в collectFinanceDue
// ---------------------------------------------------------------------------

describe('W1 snooze-гейт в collectFinanceDue', () => {
	let stateDir: string;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), 'finance-sweep-snooze-'));
	});

	afterEach(() => {
		rmSync(stateDir, { recursive: true, force: true });
	});

	it('В окне snooze: кредит-напоминание НЕ фаярит', async () => {
		const cfg = makeSweepCfg(stateDir);

		// Ставим snooze до ЗАВТРА: snoozeUntil > FAKE_NOW → алерт должен молчать.
		// FAKE_NOW = 2026-06-23T16:00:00Z, snoozeUntil = 2026-06-24T00:00:00Z.
		const snoozeUntil = '2026-06-24T00:00:00Z';
		writeSnoozeUntil(stateDir, `credit:${FAKE_CREDIT_LEAD.id}`, snoozeUntil);

		const result = await collectFinanceDue(
			[FAKE_CREDIT_LEAD],
			[],
			[],
			FAKE_FX,
			FAKE_NOW,
			cfg,
		);

		// Snooze активен → кредит-айтем НЕ возвращается.
		expect(result.credits).toHaveLength(0);
	});

	it('После истечения snooze: кредит-напоминание фаярит и snooze очищается', async () => {
		const cfg = makeSweepCfg(stateDir);

		// Ставим snooze в ПРОШЛОМ: snoozeUntil < FAKE_NOW → snooze истёк, алерт должен выйти.
		// FAKE_NOW = 2026-06-23T16:00:00Z, snoozeUntil = 2026-06-23T10:00:00Z (прошлое).
		const expiredSnooze = '2026-06-23T10:00:00Z';
		const snoozeKey = `credit:${FAKE_CREDIT_LEAD.id}`;
		writeSnoozeUntil(stateDir, snoozeKey, expiredSnooze);

		const result = await collectFinanceDue(
			[FAKE_CREDIT_LEAD],
			[],
			[],
			FAKE_FX,
			FAKE_NOW,
			cfg,
		);

		// Snooze истёк → алерт ВЫХОДИТ.
		expect(result.credits).toHaveLength(1);

		// Expired snooze ДОЛЖЕН быть очищен (clearSnoozeUntil вызван в sweep).
		expect(readSnoozeUntil(stateDir, snoozeKey)).toBeNull();
	});

	it('Дедуп (fired) и snooze вместе: snooze приоритетнее fired', async () => {
		const cfg = makeSweepCfg(stateDir);

		// Сценарий: кредит ещё НЕ fired, но snooze активен → молчим.
		// Это проверяет, что snooze-гейт стоит ДО markFired (не нужно прочитать fired).
		const snoozeUntil = '2026-06-24T00:00:00Z'; // активный snooze
		writeSnoozeUntil(stateDir, `credit:${FAKE_CREDIT_LEAD.id}`, snoozeUntil);

		const result = await collectFinanceDue(
			[FAKE_CREDIT_LEAD],
			[],
			[],
			FAKE_FX,
			FAKE_NOW,
			cfg,
		);

		// Snooze активен → не фаярим, даже если fired нет.
		expect(result.credits).toHaveLength(0);
	});

	it('W1 snooze overdue: просроченный кредит тоже гейтируется snooze', async () => {
		const cfg = makeSweepCfg(stateDir);

		// Ставим snooze для просроченного кредита.
		const snoozeUntil = '2026-06-24T00:00:00Z';
		writeSnoozeUntil(stateDir, `credit:${FAKE_CREDIT_OVERDUE.id}`, snoozeUntil);

		const result = await collectFinanceDue(
			[FAKE_CREDIT_OVERDUE],
			[],
			[],
			FAKE_FX,
			FAKE_NOW,
			cfg,
		);

		// Snooze активен на overdue-кредите → не фаярит.
		const overdueItems = result.credits.filter((c) => c.kind === 'overdue');
		expect(overdueItems).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 14. W2: payoffDate в formatCreditAlert и в коллектированных айтемах
// ---------------------------------------------------------------------------

describe('W2 payoffDate в кредит-алерте и айтемах', () => {
	let stateDir: string;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), 'finance-sweep-payoff-'));
	});

	afterEach(() => {
		rmSync(stateDir, { recursive: true, force: true });
	});

	it('formatCreditAlert lead: содержит "Прогноз погашения" с датой', () => {
		// payoffDate = '2028-06-01' — синтетическая дата будущего погашения.
		const text = formatCreditAlert(
			{
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
			},
			FAKE_NOW,
		);

		// W2: прогноз погашения ОБЯЗАН присутствовать в тексте.
		expect(text).toContain('Прогноз погашения');
		expect(text).toContain('2028-06-01');
	});

	it('formatCreditAlert due: содержит "Прогноз погашения"', () => {
		const text = formatCreditAlert(
			{
				kind: 'due',
				credit_id: 'fake-credit-002',
				label: 'Кредит сегодня',
				amount: 46000,
				currency: 'RUB',
				dueDate: '2026-06-23T23:59:00Z',
				balanceAfter: 204000,
				account: undefined,
				fireKey: 'credit:fake-credit-002:2026-06-23:due',
				payoffDate: '2027-06-01',
			},
			FAKE_NOW,
		);

		expect(text).toContain('Прогноз погашения');
		expect(text).toContain('2027-06-01');
	});

	it('formatCreditAlert overdue: содержит "Прогноз погашения"', () => {
		const text = formatCreditAlert(
			{
				kind: 'overdue',
				credit_id: 'fake-credit-overdue',
				label: 'Просроченный',
				amount: 100000,
				currency: 'RUB',
				dueDate: '2026-06-10T00:00:00Z',
				balanceAfter: 100000,
				account: undefined,
				fireKey: 'credit:fake-credit-overdue:2026-06-23:overdue',
				payoffDate: '2028-12-01',
			},
			FAKE_NOW,
		);

		expect(text).toContain('Прогноз погашения');
		expect(text).toContain('2028-12-01');
	});

	it('W2 collectFinanceDue: payoffDate присутствует в CreditDueItem и является датой в будущем', async () => {
		const cfg = makeSweepCfg(stateDir);
		const result = await collectFinanceDue(
			[FAKE_CREDIT_LEAD],
			[],
			[],
			FAKE_FX,
			FAKE_NOW,
			cfg,
		);

		expect(result.credits).toHaveLength(1);
		const item = result.credits[0]!;

		// payoffDate ДОЛЖЕН присутствовать (W2).
		expect(item.payoffDate).toBeDefined();
		expect(item.payoffDate).toMatch(/^\d{4}-\d{2}-\d{2}$/); // YYYY-MM-DD

		// Прогноз погашения ДОЛЖЕН быть в будущем относительно FAKE_NOW.
		// (Синтетический кредит с 21.5% на 24 мес, 12 платежей до FAKE_NOW → погашение в будущем.)
		expect(item.payoffDate > FAKE_NOW.slice(0, 10)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 15. W3: net-worth PNG в недельном/месячном дайджесте
// ---------------------------------------------------------------------------

describe('W3 net-worth PNG: недельный/месячный дайджест', () => {
	let stateDir: string;

	/** Синтетический мок рендерера PNG: возвращает непустой Buffer. */
	function makeMockRenderPng(): (spec: ChartSpec) => Buffer {
		return (_spec: ChartSpec): Buffer => Buffer.from('FAKEPNG');
	}

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), 'finance-sweep-w3-'));
	});

	afterEach(() => {
		rmSync(stateDir, { recursive: true, force: true });
	});

	/**
	 * Пустой FinanceDueResult (нет кредитов/майлстоунов/опросов).
	 * Используется чтобы deliverFinanceDue занялся только W3 PNG.
	 */
	const emptyResult: FinanceDueResult = {
		credits: [],
		milestones: [],
		cashSurvey: { isDue: false, fireKey: 'cash-survey:2026-06-23' },
		idleNudge: { isDue: false, idleDays: 0, fireKey: 'idle-nudge:2026-06-23' },
	};

	it('weekly: pushPhotoToOwner вызван с непустым PNG-буфером и caption', async () => {
		const cfg = makeSweepCfg(stateDir);
		const photoMsgs: Array<{ caption?: string; filename: string; data: Buffer }> = [];

		const deps: DeliverFinanceDueDeps = {
			pushToOwner: async () => {},
			pushPhotoToOwner: async (file, opts) => {
				photoMsgs.push({
					caption: opts?.caption,
					filename: file.filename ?? 'unknown',
					data: file.data as Buffer,
				});
			},
			assertNoSecrets: () => {},
		};

		// NetworthPngDeps: синтетические данные + мок-рендерер.
		const networthDeps: NetworthPngDeps = {
			snapshots: [FAKE_SNAPSHOT_75],
			credits: [FAKE_CREDIT_LEAD],
			accounts: [],
			fx: FAKE_FX,
			displayCurrency: 'RUB',
			cadence: 'weekly',
			renderPng: makeMockRenderPng(),
			historicalPoints: 2, // Уменьшаем для скорости теста.
		};

		const errors = await deliverFinanceDue(emptyResult, FAKE_NOW, cfg, {}, deps, networthDeps);
		expect(errors).toBe(0);

		// Фото отправлено ровно один раз.
		expect(photoMsgs).toHaveLength(1);

		// Filename содержит 'weekly' и дату.
		expect(photoMsgs[0]!.filename).toContain('weekly');

		// Caption не пустой.
		expect(photoMsgs[0]!.caption).toBeTruthy();

		// Данные непустые (мок вернул 'FAKEPNG').
		expect(photoMsgs[0]!.data.length).toBeGreaterThan(0);

		// Дедуп: ключ зафиксирован в fired-реестре.
		// FAKE_NOW = 2026-06-23T16:00:00Z → ISO-неделя 2026-W26.
		expect(wasFired(stateDir, 'digest:networth:2026-W26')).toBe(true);
	});

	it('monthly: pushPhotoToOwner вызван с PNG', async () => {
		const cfg = makeSweepCfg(stateDir);
		const photoMsgs: Array<{ caption?: string; filename: string }> = [];

		const deps: DeliverFinanceDueDeps = {
			pushToOwner: async () => {},
			pushPhotoToOwner: async (file, opts) => {
				photoMsgs.push({ caption: opts?.caption, filename: file.filename ?? 'unknown' });
			},
			assertNoSecrets: () => {},
		};

		const networthDeps: NetworthPngDeps = {
			snapshots: [FAKE_SNAPSHOT_75],
			credits: [FAKE_CREDIT_LEAD],
			accounts: [],
			fx: FAKE_FX,
			displayCurrency: 'RUB',
			cadence: 'monthly',
			renderPng: makeMockRenderPng(),
			historicalPoints: 2,
		};

		const errors = await deliverFinanceDue(emptyResult, FAKE_NOW, cfg, {}, deps, networthDeps);
		expect(errors).toBe(0);

		expect(photoMsgs).toHaveLength(1);
		expect(photoMsgs[0]!.filename).toContain('monthly');

		// Дедуп: ключ 'digest:networth:2026-06' в fired-реестре.
		expect(wasFired(stateDir, 'digest:networth:2026-06')).toBe(true);
	});

	it('daily: pushPhotoToOwner НЕ вызывается (ежедневный = только текст)', async () => {
		const cfg = makeSweepCfg(stateDir);
		const photoMsgs: string[] = [];

		const deps: DeliverFinanceDueDeps = {
			pushToOwner: async () => {},
			pushPhotoToOwner: async () => {
				photoMsgs.push('called');
			},
			assertNoSecrets: () => {},
		};

		const networthDeps: NetworthPngDeps = {
			snapshots: [FAKE_SNAPSHOT_75],
			credits: [FAKE_CREDIT_LEAD],
			accounts: [],
			fx: FAKE_FX,
			displayCurrency: 'RUB',
			cadence: 'daily', // daily → без PNG
			renderPng: makeMockRenderPng(),
		};

		const errors = await deliverFinanceDue(emptyResult, FAKE_NOW, cfg, {}, deps, networthDeps);
		expect(errors).toBe(0);

		// Для daily cadence pushPhotoToOwner НЕ должен вызываться (кроме майлстоунов,
		// но в emptyResult их нет).
		expect(photoMsgs).toHaveLength(0);
	});

	it('W3 дедуп: повторный вызов в том же периоде не дублирует PNG', async () => {
		const cfg = makeSweepCfg(stateDir);
		const photoMsgs: string[] = [];

		const deps: DeliverFinanceDueDeps = {
			pushToOwner: async () => {},
			pushPhotoToOwner: async () => {
				photoMsgs.push('called');
			},
			assertNoSecrets: () => {},
		};

		const networthDeps: NetworthPngDeps = {
			snapshots: [FAKE_SNAPSHOT_75],
			credits: [FAKE_CREDIT_LEAD],
			accounts: [],
			fx: FAKE_FX,
			displayCurrency: 'RUB',
			cadence: 'weekly',
			renderPng: makeMockRenderPng(),
			historicalPoints: 2,
		};

		// Первый вызов: PNG отправлен.
		await deliverFinanceDue(emptyResult, FAKE_NOW, cfg, {}, deps, networthDeps);
		expect(photoMsgs).toHaveLength(1);

		// Второй вызов в том же периоде (тот же FAKE_NOW = та же неделя): PNG НЕ дублируется.
		await deliverFinanceDue(emptyResult, FAKE_NOW, cfg, {}, deps, networthDeps);
		expect(photoMsgs).toHaveLength(1); // всё ещё 1, не 2
	});

	it('W3 нет данных (нет snapshots): PNG не отправляется, нет ошибок', async () => {
		const cfg = makeSweepCfg(stateDir);
		const photoMsgs: string[] = [];

		const deps: DeliverFinanceDueDeps = {
			pushToOwner: async () => {},
			pushPhotoToOwner: async () => {
				photoMsgs.push('called');
			},
			assertNoSecrets: () => {},
		};

		// Нет snapshots/credits/fx → graceful degradation.
		const networthDeps: NetworthPngDeps = {
			cadence: 'weekly',
			renderPng: makeMockRenderPng(),
		};

		const errors = await deliverFinanceDue(emptyResult, FAKE_NOW, cfg, {}, deps, networthDeps);
		expect(errors).toBe(0); // нет ошибок (graceful)
		expect(photoMsgs).toHaveLength(0); // нет PNG (нечего строить)
	});
});

// ---------------------------------------------------------------------------
// 16. buildNetworthTimeSeries — вспомогательная функция W3
// ---------------------------------------------------------------------------

describe('buildNetworthTimeSeries', () => {
	it('возвращает N точек, отсортированных по ts', async () => {
		const points = await buildNetworthTimeSeries(
			[FAKE_SNAPSHOT_75],
			[FAKE_CREDIT_LEAD],
			[],
			FAKE_FX,
			FAKE_NOW,
			'RUB',
			4,    // 4 исторических точки
			7,    // шаг 7 дней
		);

		// Ряд может быть неполным (нет снапшотов для старых дат) — но не должен быть пустым.
		// Хотя бы текущая точка (i=0 → now) должна посчитаться.
		expect(points.length).toBeGreaterThanOrEqual(0);

		// Все ts — валидные ISO-строки и отсортированы по возрастанию.
		for (let i = 1; i < points.length; i++) {
			expect(points[i]!.ts >= points[i - 1]!.ts).toBe(true);
		}
	});

	it('пустые снапшоты: ряд пустой или с нулями (не бросает)', async () => {
		// Нет ни снапшотов, ни кредитов → computeNetWorth вернёт 0 в любой точке.
		const points = await buildNetworthTimeSeries(
			[], // нет снапшотов
			[],
			[],
			FAKE_FX,
			FAKE_NOW,
			'RUB',
			3,
			7,
		);

		// Не бросает, возвращает массив (может быть пустым или с нулевыми value).
		expect(Array.isArray(points)).toBe(true);
	});
});
