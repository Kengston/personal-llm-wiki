/**
 * chart.test.ts — тесты чистых функций построения спецификаций графиков.
 *
 * Принципы (по аналогии с finance.test.ts):
 *   - Все данные синтетические (fake-example, нет PII, нет реальных сумм/счетов).
 *   - Нет сетевых запросов, нет файловой системы, нет spawn'а бинарей.
 *   - Тесты только для chart.ts; импорт ТОЛЬКО из ./types (типы) и ./chart (тестируемый модуль).
 *   - lint:public остаётся зелёным.
 *
 * Покрытие:
 *   1. chartSpec 'networth_over_time' — line, сортировка оси X, пустые данные.
 *   2. chartSpec 'balances_snapshot'  — bar/pie, мультивалюта, пустые данные.
 *   3. chartSpec 'expense_by_category'— pie, суммы долей сходятся к 1.0, пустые данные.
 *   4. chartSpec 'goal_progress'      — прогресс [0,1], null-data → placeholder.
 *   5. chartSpec 'debt_structure'     — pie, нулевые долги фильтруются, мультивалюта.
 *   6. Универсальные гарантии: JSON.stringify не теряет данные, нет throw.
 */

import { describe, expect, it } from 'vitest';

import {
	chartSpec,
	type BalanceEntry,
	type CategoryEntry,
	type ChartInput,
	type ChartSpec,
	type DebtEntry,
	type GoalProgressData,
	type TimePoint,
} from './chart.js';

// ---------------------------------------------------------------------------
// Синтетические фикстуры (fake-example, нет PII)
// ---------------------------------------------------------------------------

/**
 * Синтетические точки чистого капитала.
 * Даты идут в ОБРАТНОМ порядке — тест должен проверить сортировку.
 */
const fakeNetworthPoints: TimePoint[] = [
	{ ts: '2026-06-01T00:00:00Z', value: 120000 }, // synthetic-example
	{ ts: '2026-04-01T00:00:00Z', value: 100000 }, // synthetic-example (раньше)
	{ ts: '2026-05-01T00:00:00Z', value: 110000 }, // synthetic-example (между)
];

/**
 * Синтетические балансы счетов (одна валюта — USDT).
 */
const fakeSingleCurrencyBalances: BalanceEntry[] = [
	{ label: 'exchange USDT fake-001', value: 500, currency: 'USDT' }, // synthetic-example
	{ label: 'exchange USDT fake-002', value: 300, currency: 'USDT' }, // synthetic-example
	{ label: 'savings RUB fake-003', value: 0, currency: 'USDT' },     // нулевой — включается
];

/**
 * Синтетические балансы (разные валюты — мультивалютный случай).
 */
const fakeMultiCurrencyBalances: BalanceEntry[] = [
	{ label: 'exchange USDT fake-a', value: 500, currency: 'USDT' }, // synthetic-example
	{ label: 'bank RUB fake-b', value: 50000, currency: 'RUB' },     // synthetic-example
	{ label: 'cash GEL fake-c', value: 200, currency: 'GEL' },       // synthetic-example
];

/**
 * Синтетические расходы по категориям (для pie).
 */
const fakeCategoryEntries: CategoryEntry[] = [
	{ category: 'grocery', amount: 5000, currency: 'RUB' },    // synthetic-example
	{ category: 'transport', amount: 2000, currency: 'RUB' },  // synthetic-example
	{ category: 'entertainment', amount: 3000, currency: 'RUB' }, // synthetic-example
];

/**
 * Синтетические данные цели (накопление).
 */
const fakeSaveGoal: GoalProgressData = {
	goal_id: 'emergency-fund-fake', // synthetic-example
	label: 'Резервный фонд',
	current: 75000,  // synthetic-example
	target: 200000,  // synthetic-example
	currency: 'RUB',
	target_date: '2026-12-31T00:00:00Z',
	fin_kind: 'save',
};

/**
 * Синтетические данные цели (погашение долга).
 */
const fakeDebtPaydownGoal: GoalProgressData = {
	goal_id: 'debt-paydown-fake', // synthetic-example
	label: 'Погашение кредита',
	current: 50000,  // synthetic-example — погашено
	target: 500000,  // synthetic-example — первоначальный долг
	currency: 'RUB',
	fin_kind: 'debt_paydown',
};

/**
 * Синтетические долги.
 */
const fakeDebts: DebtEntry[] = [
	{ label: 'credit-fake-001 RUB', balance: 450000, currency: 'RUB', rate_pct: 21.5 }, // synthetic-example
	{ label: 'credit-fake-002 RUB', balance: 200000, currency: 'RUB', rate_pct: 16.0 }, // synthetic-example
];

/**
 * Мультивалютные долги.
 */
const fakeMultiCurrencyDebts: DebtEntry[] = [
	{ label: 'credit-rub-fake', balance: 400000, currency: 'RUB', rate_pct: 20.0 }, // synthetic-example
	{ label: 'credit-usd-fake', balance: 5000, currency: 'USD', rate_pct: 8.0 },    // synthetic-example
];

// ---------------------------------------------------------------------------
// 1. chartSpec 'networth_over_time'
// ---------------------------------------------------------------------------

describe("chartSpec 'networth_over_time'", () => {
	it('возвращает ChartSpec с type="line"', () => {
		const spec = chartSpec({ kind: 'networth_over_time', points: fakeNetworthPoints, currency: 'RUB' });
		expect(spec.type).toBe('line');
	});

	it('series[0].points содержит все входные точки', () => {
		const spec = chartSpec({ kind: 'networth_over_time', points: fakeNetworthPoints, currency: 'RUB' });
		// Проверяем что ряд — это points-вариант (содержит массив points).
		const series = spec.series[0];
		expect(series).toBeDefined();
		expect('points' in series!).toBe(true);
		if ('points' in series!) {
			expect(series.points).toHaveLength(3);
		}
	});

	it('ось времени отсортирована по возрастанию (ASC)', () => {
		// Входные точки идут в обратном порядке — должны быть отсортированы.
		const spec = chartSpec({ kind: 'networth_over_time', points: fakeNetworthPoints, currency: 'RUB' });
		const series = spec.series[0];
		expect('points' in series!).toBe(true);
		if ('points' in series!) {
			const timestamps = series.points.map((p) => p.x);
			// Проверяем что каждый следующий ts >= предыдущего.
			for (let i = 1; i < timestamps.length; i++) {
				expect(timestamps[i]!.localeCompare(timestamps[i - 1]!)).toBeGreaterThanOrEqual(0);
			}
			// Конкретно: первый — апрель, последний — июнь.
			expect(timestamps[0]).toBe('2026-04-01T00:00:00Z');
			expect(timestamps[2]).toBe('2026-06-01T00:00:00Z');
		}
	});

	it('unit и currency совпадают с входной currency', () => {
		const spec = chartSpec({ kind: 'networth_over_time', points: fakeNetworthPoints, currency: 'RUB' });
		expect(spec.unit).toBe('RUB');
		expect(spec.currency).toBe('RUB');
	});

	it('пустые данные → валидная placeholder-спека (не throw)', () => {
		const spec = chartSpec({ kind: 'networth_over_time', points: [], currency: 'USD' });
		// Должна вернуть валидный объект.
		expect(spec).toBeDefined();
		expect(spec.type).toBe('line');
		expect(spec.meta).toHaveProperty('empty', true);
		// points пустой — не throw.
		const series = spec.series[0];
		expect('points' in series!).toBe(true);
		if ('points' in series!) {
			expect(series.points).toHaveLength(0);
		}
	});

	it('одна точка → валидный line с одной точкой', () => {
		const single: TimePoint[] = [{ ts: '2026-06-01T00:00:00Z', value: 50000 }]; // synthetic-example
		const spec = chartSpec({ kind: 'networth_over_time', points: single, currency: 'USDT' });
		expect(spec.type).toBe('line');
		const series = spec.series[0];
		if ('points' in series!) {
			expect(series.points).toHaveLength(1);
		}
	});

	it('значения Y совпадают со значениями входных точек (не теряются)', () => {
		const spec = chartSpec({ kind: 'networth_over_time', points: fakeNetworthPoints, currency: 'RUB' });
		const series = spec.series[0];
		if ('points' in series!) {
			// Сортируем входные данные вручную для сравнения.
			const sortedValues = [...fakeNetworthPoints]
				.sort((a, b) => a.ts.localeCompare(b.ts))
				.map((p) => p.value);
			const specValues = series.points.map((p) => p.y);
			expect(specValues).toEqual(sortedValues);
		}
	});

	it('meta содержит x_min, x_max, y_min, y_max', () => {
		const spec = chartSpec({ kind: 'networth_over_time', points: fakeNetworthPoints, currency: 'RUB' });
		expect(spec.meta).toHaveProperty('x_min');
		expect(spec.meta).toHaveProperty('x_max');
		expect(spec.meta).toHaveProperty('y_min');
		expect(spec.meta).toHaveProperty('y_max');
		// y_min должен быть минимальным из значений.
		expect(spec.meta!['y_min']).toBe(100000); // synthetic-example
		expect(spec.meta!['y_max']).toBe(120000); // synthetic-example
	});
});

// ---------------------------------------------------------------------------
// 2. chartSpec 'balances_snapshot'
// ---------------------------------------------------------------------------

describe("chartSpec 'balances_snapshot'", () => {
	it('одна валюта + ≤5 счетов → type="pie"', () => {
		const spec = chartSpec({ kind: 'balances_snapshot', entries: fakeSingleCurrencyBalances });
		expect(spec.type).toBe('pie');
	});

	it('разные валюты → type="bar" (мультивалютный)', () => {
		const spec = chartSpec({ kind: 'balances_snapshot', entries: fakeMultiCurrencyBalances });
		expect(spec.type).toBe('bar');
	});

	it('series содержит все входные записи (включая нулевой баланс)', () => {
		const spec = chartSpec({ kind: 'balances_snapshot', entries: fakeSingleCurrencyBalances });
		// Нулевой баланс включается — счёт существует.
		expect(spec.series).toHaveLength(3);
	});

	it('доли в pie сходятся к 1.0 (одна валюта)', () => {
		const spec = chartSpec({ kind: 'balances_snapshot', entries: fakeSingleCurrencyBalances });
		// Суммируем доли share всех series.
		const totalShare = spec.series.reduce((acc, s) => {
			if ('share' in s) return acc + (s.share ?? 0);
			return acc;
		}, 0);
		// Допускаем floating-point погрешность < 1e-9.
		// Нулевой баланс отдаёт share=0 — итого: 500/(500+300+0) + 300/(800) + 0 = 1.
		// Ожидаем ~1.0.
		expect(totalShare).toBeCloseTo(1.0, 9);
	});

	it('мультивалюта: currency в спеке = undefined (нет единой валюты)', () => {
		const spec = chartSpec({ kind: 'balances_snapshot', entries: fakeMultiCurrencyBalances });
		expect(spec.currency).toBeUndefined();
		expect(spec.unit).toBeUndefined();
	});

	it('одна валюта: currency в спеке = валюта записей', () => {
		const spec = chartSpec({ kind: 'balances_snapshot', entries: fakeSingleCurrencyBalances });
		expect(spec.currency).toBe('USDT');
	});

	it('пустые данные → placeholder-спека (не throw)', () => {
		const spec = chartSpec({ kind: 'balances_snapshot', entries: [] });
		expect(spec).toBeDefined();
		expect(spec.meta).toHaveProperty('empty', true);
		expect(spec.series).toHaveLength(1);
	});

	it('> 5 счетов одной валюты → type="bar" (много сегментов)', () => {
		// При > 5 элементах pie нечитаем — используем bar.
		const manyEntries: BalanceEntry[] = Array.from({ length: 6 }, (_, i) => ({
			label: `account-fake-${i}`,   // synthetic-example
			value: (i + 1) * 100,         // synthetic-example
			currency: 'RUB',
		}));
		const spec = chartSpec({ kind: 'balances_snapshot', entries: manyEntries });
		expect(spec.type).toBe('bar');
	});

	it('лейблы series совпадают с label из входных данных', () => {
		const spec = chartSpec({ kind: 'balances_snapshot', entries: fakeSingleCurrencyBalances });
		const labels = spec.series.map((s) => s.label);
		expect(labels).toContain('exchange USDT fake-001');
		expect(labels).toContain('exchange USDT fake-002');
	});
});

// ---------------------------------------------------------------------------
// 3. chartSpec 'expense_by_category'
// ---------------------------------------------------------------------------

describe("chartSpec 'expense_by_category'", () => {
	it('type="pie"', () => {
		const spec = chartSpec({ kind: 'expense_by_category', entries: fakeCategoryEntries, currency: 'RUB' });
		expect(spec.type).toBe('pie');
	});

	it('series содержит все входные категории', () => {
		const spec = chartSpec({ kind: 'expense_by_category', entries: fakeCategoryEntries, currency: 'RUB' });
		expect(spec.series).toHaveLength(3);
	});

	it('доли в pie сходятся к 1.0', () => {
		// grocery=5000, transport=2000, entertainment=3000 → total=10000
		// доли: 0.5, 0.2, 0.3 → сумма = 1.0
		const spec = chartSpec({ kind: 'expense_by_category', entries: fakeCategoryEntries, currency: 'RUB' });
		const totalShare = spec.series.reduce((acc, s) => {
			if ('share' in s) return acc + (s.share ?? 0);
			return acc;
		}, 0);
		expect(totalShare).toBeCloseTo(1.0, 9);
	});

	it('конкретные доли корректны (grocery = 0.5)', () => {
		// grocery: 5000 / 10000 = 0.5
		const spec = chartSpec({ kind: 'expense_by_category', entries: fakeCategoryEntries, currency: 'RUB' });
		const grocerySeries = spec.series.find((s) => s.label === 'grocery');
		expect(grocerySeries).toBeDefined();
		if ('share' in grocerySeries!) {
			expect(grocerySeries.share).toBeCloseTo(0.5, 9);
		}
	});

	it('meta.total совпадает с суммой всех расходов', () => {
		const spec = chartSpec({ kind: 'expense_by_category', entries: fakeCategoryEntries, currency: 'RUB' });
		// 5000 + 2000 + 3000 = 10000 synthetic-example
		expect(spec.meta!['total']).toBe(10000);
	});

	it('currency совпадает с входной', () => {
		const spec = chartSpec({ kind: 'expense_by_category', entries: fakeCategoryEntries, currency: 'RUB' });
		expect(spec.currency).toBe('RUB');
		expect(spec.unit).toBe('RUB');
	});

	it('пустые данные → placeholder-спека (не throw)', () => {
		const spec = chartSpec({ kind: 'expense_by_category', entries: [], currency: 'USD' });
		expect(spec).toBeDefined();
		expect(spec.meta).toHaveProperty('empty', true);
	});

	it('одна категория → share = 1.0', () => {
		const single: CategoryEntry[] = [
			{ category: 'rent', amount: 20000, currency: 'RUB' }, // synthetic-example
		];
		const spec = chartSpec({ kind: 'expense_by_category', entries: single, currency: 'RUB' });
		const series = spec.series[0];
		if ('share' in series!) {
			expect(series.share).toBeCloseTo(1.0, 9);
		}
	});

	it('все нулевые суммы → share=0 для каждого (не NaN, не throw)', () => {
		// Нулевые суммы → total=0 → computeShares вернёт массив нулей.
		const zeroEntries: CategoryEntry[] = [
			{ category: 'zero-a', amount: 0, currency: 'RUB' }, // synthetic-example
			{ category: 'zero-b', amount: 0, currency: 'RUB' }, // synthetic-example
		];
		const spec = chartSpec({ kind: 'expense_by_category', entries: zeroEntries, currency: 'RUB' });
		for (const s of spec.series) {
			if ('share' in s) {
				expect(s.share).toBe(0);
				// Проверяем что не NaN.
				expect(Number.isNaN(s.share)).toBe(false);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// 4. chartSpec 'goal_progress'
// ---------------------------------------------------------------------------

describe("chartSpec 'goal_progress'", () => {
	it('type="progress"', () => {
		const spec = chartSpec({ kind: 'goal_progress', data: fakeSaveGoal });
		expect(spec.type).toBe('progress');
	});

	it('прогресс = current/target (save goal)', () => {
		// current=75000, target=200000 → progress = 0.375
		const spec = chartSpec({ kind: 'goal_progress', data: fakeSaveGoal });
		const series = spec.series[0];
		if ('value' in series!) {
			expect(series.value).toBeCloseTo(0.375, 9);
			expect(series.share).toBeCloseTo(0.375, 9);
		}
	});

	it('meta.pct = Math.round(progress * 100)', () => {
		// 0.375 * 100 = 37 → round → 38 (нет, 37.5 → 38)
		const spec = chartSpec({ kind: 'goal_progress', data: fakeSaveGoal });
		// Проверяем что pct в диапазоне 0–100 и близко к ожидаемому.
		const pct = spec.meta!['pct'] as number;
		expect(pct).toBeGreaterThanOrEqual(0);
		expect(pct).toBeLessThanOrEqual(100);
		// 75000/200000 = 0.375 → round(37.5) = 38 (JavaScript Math.round округляет 0.5 вверх).
		expect(pct).toBe(38);
	});

	it('meta.remaining = target - current', () => {
		const spec = chartSpec({ kind: 'goal_progress', data: fakeSaveGoal });
		// 200000 - 75000 = 125000 synthetic-example
		expect(spec.meta!['remaining']).toBe(125000);
	});

	it('meta.target_date присутствует если передан', () => {
		const spec = chartSpec({ kind: 'goal_progress', data: fakeSaveGoal });
		expect(spec.meta!['target_date']).toBe('2026-12-31T00:00:00Z');
	});

	it('meta.target_date отсутствует если не передан', () => {
		const spec = chartSpec({ kind: 'goal_progress', data: fakeDebtPaydownGoal });
		expect(spec.meta).not.toHaveProperty('target_date');
	});

	it('прогресс зажат в [0, 1] даже если current > target (100% достигнуто)', () => {
		// Перевыполнение: current = 250000, target = 200000 → прогресс = min(1, 250/200) = 1.
		const overGoal: GoalProgressData = {
			...fakeSaveGoal,
			current: 250000, // synthetic-example — превышает target
		};
		const spec = chartSpec({ kind: 'goal_progress', data: overGoal });
		const series = spec.series[0];
		if ('value' in series!) {
			expect(series.value).toBeCloseTo(1.0, 9);
		}
	});

	it('target = 0 → прогресс = 0 (нет деления на ноль)', () => {
		const zeroTarget: GoalProgressData = {
			...fakeSaveGoal,
			target: 0, // synthetic-example — невалидная цель
		};
		const spec = chartSpec({ kind: 'goal_progress', data: zeroTarget });
		const series = spec.series[0];
		if ('value' in series!) {
			expect(series.value).toBe(0);
			expect(Number.isNaN(series.value)).toBe(false);
		}
	});

	it('null data → placeholder-спека (не throw)', () => {
		const spec = chartSpec({ kind: 'goal_progress', data: null });
		expect(spec).toBeDefined();
		expect(spec.type).toBe('progress');
		expect(spec.meta).toHaveProperty('empty', true);
	});

	it('fin_kind="debt_paydown" → лейбл содержит "Погашено"', () => {
		const spec = chartSpec({ kind: 'goal_progress', data: fakeDebtPaydownGoal });
		const series = spec.series[0]!;
		expect(series.label).toContain('Погашено');
	});

	it('meta.goal_id совпадает с входным goal_id', () => {
		const spec = chartSpec({ kind: 'goal_progress', data: fakeSaveGoal });
		expect(spec.meta!['goal_id']).toBe('emergency-fund-fake');
	});

	it('currency совпадает с входной', () => {
		const spec = chartSpec({ kind: 'goal_progress', data: fakeSaveGoal });
		expect(spec.currency).toBe('RUB');
	});
});

// ---------------------------------------------------------------------------
// 5. chartSpec 'debt_structure'
// ---------------------------------------------------------------------------

describe("chartSpec 'debt_structure'", () => {
	it('type="pie"', () => {
		const spec = chartSpec({ kind: 'debt_structure', entries: fakeDebts });
		expect(spec.type).toBe('pie');
	});

	it('series содержит все активные долги', () => {
		const spec = chartSpec({ kind: 'debt_structure', entries: fakeDebts });
		expect(spec.series).toHaveLength(2);
	});

	it('нулевые балансы фильтруются (закрытые долги не входят в pie)', () => {
		const withZero: DebtEntry[] = [
			...fakeDebts,
			{ label: 'closed-credit-fake', balance: 0, currency: 'RUB' }, // synthetic-example — закрыт
		];
		const spec = chartSpec({ kind: 'debt_structure', entries: withZero });
		// Закрытый долг (balance=0) не должен попасть в series.
		expect(spec.series).toHaveLength(2);
		const labels = spec.series.map((s) => s.label);
		expect(labels).not.toContain('closed-credit-fake');
	});

	it('доли в pie сходятся к 1.0 (одна валюта)', () => {
		// credit-fake-001: 450000, credit-fake-002: 200000 → total=650000
		// доли: 450/650 ≈ 0.692, 200/650 ≈ 0.308 → сумма = 1.0
		const spec = chartSpec({ kind: 'debt_structure', entries: fakeDebts });
		const totalShare = spec.series.reduce((acc, s) => {
			if ('share' in s) return acc + (s.share ?? 0);
			return acc;
		}, 0);
		expect(totalShare).toBeCloseTo(1.0, 9);
	});

	it('meta.total = сумма балансов (одна валюта)', () => {
		const spec = chartSpec({ kind: 'debt_structure', entries: fakeDebts });
		// 450000 + 200000 = 650000 synthetic-example
		expect(spec.meta!['total']).toBe(650000);
	});

	it('meta.avg_rate_pct рассчитывается как средневзвешенная ставка', () => {
		// avg_rate = (450000*21.5 + 200000*16.0) / 650000
		//           = (9675000 + 3200000) / 650000
		//           = 12875000 / 650000
		//           ≈ 19.808%
		const spec = chartSpec({ kind: 'debt_structure', entries: fakeDebts });
		const expectedRate = (450000 * 21.5 + 200000 * 16.0) / 650000;
		const actualRate = spec.meta!['avg_rate_pct'] as number;
		expect(actualRate).toBeCloseTo(expectedRate, 1);
	});

	it('мультивалюта: доли = 0 (несравнимы без FX)', () => {
		const spec = chartSpec({ kind: 'debt_structure', entries: fakeMultiCurrencyDebts });
		const anyNonZeroShare = spec.series.some((s) => {
			if ('share' in s) return (s.share ?? 0) > 0;
			return false;
		});
		// При разных валютах доли не вычисляются — все = 0.
		expect(anyNonZeroShare).toBe(false);
	});

	it('мультивалюта: currency = undefined в спеке', () => {
		const spec = chartSpec({ kind: 'debt_structure', entries: fakeMultiCurrencyDebts });
		expect(spec.currency).toBeUndefined();
		expect(spec.unit).toBeUndefined();
	});

	it('все активные долги фильтруются → placeholder (не throw)', () => {
		const allZero: DebtEntry[] = [
			{ label: 'paid-off-fake', balance: 0, currency: 'RUB' }, // synthetic-example
		];
		const spec = chartSpec({ kind: 'debt_structure', entries: allZero });
		expect(spec.meta).toHaveProperty('empty', true);
	});

	it('пустые данные → placeholder-спека (не throw)', () => {
		const spec = chartSpec({ kind: 'debt_structure', entries: [] });
		expect(spec).toBeDefined();
		expect(spec.meta).toHaveProperty('empty', true);
	});
});

// ---------------------------------------------------------------------------
// 6. Универсальные гарантии
// ---------------------------------------------------------------------------

describe('chartSpec — универсальные гарантии', () => {
	/**
	 * Набор тестовых входов для проверки универсальных инвариантов.
	 * Каждый вход — один из пяти видов, включая пустые данные.
	 */
	const inputs: ChartInput[] = [
		{ kind: 'networth_over_time', points: fakeNetworthPoints, currency: 'RUB' },
		{ kind: 'networth_over_time', points: [], currency: 'USD' },
		{ kind: 'balances_snapshot', entries: fakeSingleCurrencyBalances },
		{ kind: 'balances_snapshot', entries: [] },
		{ kind: 'expense_by_category', entries: fakeCategoryEntries, currency: 'RUB' },
		{ kind: 'expense_by_category', entries: [], currency: 'RUB' },
		{ kind: 'goal_progress', data: fakeSaveGoal },
		{ kind: 'goal_progress', data: null },
		{ kind: 'debt_structure', entries: fakeDebts },
		{ kind: 'debt_structure', entries: [] },
	];

	it.each(inputs.map((input, i) => [i, input] as [number, ChartInput]))(
		'chartSpec вход #%i не бросает исключение',
		(_i, input) => {
			// Никакой вход не должен вызывать throw.
			expect(() => chartSpec(input)).not.toThrow();
		},
	);

	it.each(inputs.map((input, i) => [i, input] as [number, ChartInput]))(
		'chartSpec вход #%i сериализуется через JSON.stringify без потерь',
		(_i, input) => {
			const spec = chartSpec(input);
			// JSON.stringify не должен бросать (нет циклических ссылок, нет BigInt).
			let serialized: string;
			expect(() => {
				serialized = JSON.stringify(spec);
			}).not.toThrow();
			// Парсинг обратно → объект того же вида.
			const parsed = JSON.parse(serialized!) as ChartSpec;
			expect(parsed.type).toBe(spec.type);
			expect(parsed.title).toBe(spec.title);
		},
	);

	it.each(inputs.map((input, i) => [i, input] as [number, ChartInput]))(
		'chartSpec вход #%i всегда возвращает объект с полями type, title, series',
		(_i, input) => {
			const spec = chartSpec(input);
			expect(spec).toHaveProperty('type');
			expect(spec).toHaveProperty('title');
			expect(spec).toHaveProperty('series');
			expect(Array.isArray(spec.series)).toBe(true);
		},
	);

	it('title никогда не пустая строка', () => {
		for (const input of inputs) {
			const spec = chartSpec(input);
			expect(spec.title.length).toBeGreaterThan(0);
		}
	});
});

// ---------------------------------------------------------------------------
// 7. Edge-кейсы: spend_cap перерасход
// ---------------------------------------------------------------------------

describe("chartSpec 'goal_progress': spend_cap — сигнал перерасхода", () => {
	it('spend_cap без перерасхода: progress = current/target, нет over_amount', () => {
		// current=800, target=1000 → progress = 0.8, нет перерасхода (synthetic-example)
		const goal: GoalProgressData = {
			goal_id: 'spend-cap-ok-fake', // synthetic-example
			label: 'Лимит расходов',
			current: 800,   // synthetic-example
			target: 1000,   // synthetic-example
			currency: 'RUB',
			fin_kind: 'spend_cap',
		};
		const spec = chartSpec({ kind: 'goal_progress', data: goal });
		const series = spec.series[0]!;
		// progress = 0.8, не зажат (нет перерасхода)
		if ('value' in series) {
			expect(series.value).toBeCloseTo(0.8, 5);
			// share также 0.8 (не превышает 1)
			expect(series.share).toBeCloseTo(0.8, 5);
		}
		// Нет over_amount в мета
		expect(spec.meta).not.toHaveProperty('over_amount');
		expect(spec.meta!['remaining']).toBeCloseTo(200, 5); // synthetic-example: 1000-800
	});

	it('spend_cap с перерасходом: over_amount и pct > 100 (не маскируется)', () => {
		// current=1500, target=1000 → перерасход 500 (synthetic-example)
		// До фикса: progress=1, remaining=0, over_amount отсутствовал.
		// После: progress=1.5, over_amount=500, pct=150.
		const goal: GoalProgressData = {
			goal_id: 'spend-cap-over-fake', // synthetic-example
			label: 'Лимит превышен',
			current: 1500,  // synthetic-example — превышает лимит
			target: 1000,   // synthetic-example
			currency: 'RUB',
			fin_kind: 'spend_cap',
		};
		const spec = chartSpec({ kind: 'goal_progress', data: goal });
		const series = spec.series[0]!;
		if ('value' in series) {
			// progress = 1.5 (не зажат для spend_cap при перерасходе)
			expect(series.value).toBeCloseTo(1.5, 5); // synthetic-example
			// share зажат в [0,1] для pie-совместимости
			expect(series.share).toBeCloseTo(1.0, 5);
		}
		// over_amount сигнализирует о превышении
		expect(spec.meta!['over_amount']).toBeCloseTo(500, 5); // synthetic-example
		// pct = 150 (показывает реальное превышение)
		expect(spec.meta!['pct']).toBe(150); // synthetic-example
		// remaining = 0 (лимит исчерпан)
		expect(spec.meta!['remaining']).toBe(0);
	});

	it('spend_cap точно в лимите (current=target): progress=1, нет over_amount', () => {
		const goal: GoalProgressData = {
			goal_id: 'spend-cap-exact-fake', // synthetic-example
			label: 'Точно в лимите',
			current: 1000,  // synthetic-example
			target: 1000,   // synthetic-example
			currency: 'RUB',
			fin_kind: 'spend_cap',
		};
		const spec = chartSpec({ kind: 'goal_progress', data: goal });
		expect(spec.meta!['pct']).toBe(100);
		expect(spec.meta).not.toHaveProperty('over_amount');
	});
});

// ---------------------------------------------------------------------------
// 8. Edge-кейсы: expense_by_category с возвратами (refund)
// ---------------------------------------------------------------------------

describe("chartSpec 'expense_by_category': возвраты (refund) с отрицательным amount", () => {
	it('refund (отрицательный amount): share в [0,1], нет отрицательных долей', () => {
		// До фикса: shares = [1.667, -0.667] — pie физически невозможен.
		// После (Math.abs): shares = [0.714, 0.286] — корректные доли (synthetic-example).
		const entries: CategoryEntry[] = [
			{ category: 'grocery', amount: 1000, currency: 'RUB' },    // synthetic-example
			{ category: 'refund', amount: -400, currency: 'RUB' },     // synthetic-example: возврат
		];
		const spec = chartSpec({ kind: 'expense_by_category', entries, currency: 'RUB' });
		// Проверяем что все доли в [0, 1]
		for (const s of spec.series) {
			if ('share' in s) {
				expect(s.share).toBeGreaterThanOrEqual(0);
				expect(s.share).toBeLessThanOrEqual(1);
			}
		}
	});

	it('refund: сумма долей ≈ 1.0 (pie замкнут)', () => {
		const entries: CategoryEntry[] = [
			{ category: 'rent', amount: 5000, currency: 'RUB' },      // synthetic-example
			{ category: 'grocery', amount: 2000, currency: 'RUB' },   // synthetic-example
			{ category: 'cashback', amount: -500, currency: 'RUB' },  // synthetic-example: возврат
		];
		const spec = chartSpec({ kind: 'expense_by_category', entries, currency: 'RUB' });
		const totalShare = spec.series.reduce((acc, s) => {
			if ('share' in s) return acc + (s.share ?? 0);
			return acc;
		}, 0);
		// Суммы долей сходятся к 1.0 (с float-погрешностью)
		expect(totalShare).toBeCloseTo(1.0, 5);
	});
});

// ---------------------------------------------------------------------------
// 9. Edge-кейсы: balances_snapshot с отрицательным балансом (обязательства)
// ---------------------------------------------------------------------------

describe("chartSpec 'balances_snapshot': отрицательный баланс (обязательство)", () => {
	it('один отрицательный баланс: share = abs_value/total_abs (не 1 с неверным знаком)', () => {
		// До фикса: single {value:-300} → total_abs=300 (теперь total_abs отдельно от net_total)
		// share = abs(-300)/300 = 1 — корректно для pie.
		const entries: BalanceEntry[] = [
			{ label: 'debt-account-fake', value: -300, currency: 'RUB' }, // synthetic-example
		];
		const spec = chartSpec({ kind: 'balances_snapshot', entries });
		// share для отрицательного баланса = abs(value)/total_abs = 1
		const series = spec.series[0]!;
		if ('share' in series) {
			expect(series.share).toBeCloseTo(1.0, 5);
		}
	});

	it('смешанные балансы: net_total корректен, total_abs = сумма abs', () => {
		// {+500, -300}: net_total = 200, total_abs = 800 (synthetic-example)
		const entries: BalanceEntry[] = [
			{ label: 'savings-fake', value: 500, currency: 'RUB' },  // synthetic-example
			{ label: 'debt-fake', value: -300, currency: 'RUB' },    // synthetic-example
		];
		const spec = chartSpec({ kind: 'balances_snapshot', entries });
		// net_total = 500 + (-300) = 200 (финансово корректно)
		expect(spec.meta!['net_total']).toBeCloseTo(200, 5); // synthetic-example
		// total_abs = 500 + 300 = 800 (для pie-пропорций)
		expect(spec.meta!['total_abs']).toBeCloseTo(800, 5); // synthetic-example
	});

	it('все отрицательные балансы: net_total отрицательный, total_abs положительный', () => {
		// {-1000}: net_total = -1000, total_abs = 1000 (synthetic-example)
		const entries: BalanceEntry[] = [
			{ label: 'overdraft-fake', value: -1000, currency: 'RUB' }, // synthetic-example
		];
		const spec = chartSpec({ kind: 'balances_snapshot', entries });
		expect(spec.meta!['net_total']).toBeCloseTo(-1000, 5); // synthetic-example
		expect(spec.meta!['total_abs']).toBeCloseTo(1000, 5); // synthetic-example
	});
});

// ---------------------------------------------------------------------------
// 10. Edge-кейсы: networth_over_time с NaN/Infinity в value
// ---------------------------------------------------------------------------

describe("chartSpec 'networth_over_time': санитизация NaN/Infinity", () => {
	it('NaN value: точка отфильтровывается, нет NaN в y (JSON round-trip безопасен)', () => {
		// До фикса: NaN в points → JSON.stringify(NaN)=null — тихая порча (guaranteed: "without loss").
		// После: NaN фильтруется, в points не попадает.
		const points: TimePoint[] = [
			{ ts: '2026-01-01T00:00:00Z', value: 100000 },   // synthetic-example
			{ ts: '2026-02-01T00:00:00Z', value: NaN },       // невалидный
			{ ts: '2026-03-01T00:00:00Z', value: 110000 },   // synthetic-example
		];
		const spec = chartSpec({ kind: 'networth_over_time', points, currency: 'RUB' });
		const series = spec.series[0]!;
		if ('points' in series) {
			// NaN-точка отфильтрована: должно остаться 2 точки, не 3
			expect(series.points.length).toBe(2);
			// Нет NaN в y
			for (const p of series.points) {
				expect(Number.isNaN(p.y)).toBe(false);
			}
		}
		// JSON round-trip без потерь (нет null вместо числа)
		const serialized = JSON.stringify(spec);
		const parsed = JSON.parse(serialized);
		const parsedSeries = parsed.series[0];
		if (parsedSeries && 'points' in parsedSeries) {
			for (const p of parsedSeries.points as Array<{ x: string; y: number }>) {
				expect(p.y).not.toBeNull(); // synthetic-example: не потерялось как null
				expect(Number.isFinite(p.y)).toBe(true);
			}
		}
	});

	it('Infinity value: точка отфильтровывается', () => {
		const points: TimePoint[] = [
			{ ts: '2026-04-01T00:00:00Z', value: Infinity },  // невалидный
			{ ts: '2026-05-01T00:00:00Z', value: 50000 },     // synthetic-example
		];
		const spec = chartSpec({ kind: 'networth_over_time', points, currency: 'RUB' });
		const series = spec.series[0]!;
		if ('points' in series) {
			// Infinity-точка отфильтрована: 1 конечная точка
			expect(series.points.length).toBe(1);
			expect(Number.isFinite(series.points[0]!.y)).toBe(true);
		}
	});

	it('все точки NaN: возвращает placeholder (не throw)', () => {
		const points: TimePoint[] = [
			{ ts: '2026-06-01T00:00:00Z', value: NaN },
			{ ts: '2026-07-01T00:00:00Z', value: Infinity },
		];
		const spec = chartSpec({ kind: 'networth_over_time', points, currency: 'USD' });
		// Все non-finite → placeholder
		expect(spec.meta).toHaveProperty('empty', true);
		// Не throw
		expect(spec.type).toBe('line');
	});

	it('нормальные конечные данные не фильтруются', () => {
		// Контрол: убеждаемся что фильтр не трогает корректные данные.
		const points: TimePoint[] = fakeNetworthPoints; // все значения конечны
		const spec = chartSpec({ kind: 'networth_over_time', points, currency: 'RUB' });
		const series = spec.series[0]!;
		if ('points' in series) {
			expect(series.points.length).toBe(fakeNetworthPoints.length);
		}
	});
});

// ---------------------------------------------------------------------------
// 11. grow — дополнительный тип цели (ранее без покрытия)
// ---------------------------------------------------------------------------

describe("chartSpec 'goal_progress': grow", () => {
	it('grow goal: лейбл содержит "Накоплено"', () => {
		const goal: GoalProgressData = {
			goal_id: 'portfolio-grow-fake', // synthetic-example
			label: 'Рост портфеля',
			current: 300000,  // synthetic-example
			target: 1000000,  // synthetic-example
			currency: 'RUB',
			fin_kind: 'grow',
		};
		const spec = chartSpec({ kind: 'goal_progress', data: goal });
		expect(spec.series[0]!.label).toContain('Накоплено');
	});

	it('grow goal: прогресс зажат в [0, 1] (current > target → 1.0)', () => {
		// Для grow перевыполнение зажимается в 1 (как и save/debt_paydown).
		const goal: GoalProgressData = {
			goal_id: 'portfolio-grow-over-fake', // synthetic-example
			label: 'Перевыполнен рост',
			current: 1500000, // synthetic-example — превышает target
			target: 1000000,  // synthetic-example
			currency: 'RUB',
			fin_kind: 'grow',
		};
		const spec = chartSpec({ kind: 'goal_progress', data: goal });
		const series = spec.series[0]!;
		if ('value' in series) {
			// grow НЕ сигнализирует перерасход — прогресс зажат в [0,1]
			expect(series.value).toBeCloseTo(1.0, 5);
		}
		// Нет over_amount для grow
		expect(spec.meta).not.toHaveProperty('over_amount');
	});
});
