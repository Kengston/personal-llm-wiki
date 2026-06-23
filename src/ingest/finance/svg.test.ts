/**
 * svg.test.ts — тесты чистого детерминированного генератора SVG (svg.ts).
 *
 * Принципы (по аналогии с chart.test.ts):
 *   - Все данные синтетические (fake-example, нет PII, нет реальных сумм/счетов).
 *   - Нет сети, нет файловой системы, нет растеризатора (это шаг 3 — finance-render).
 *   - Импорт ТОЛЬКО из ./svg (тестируемый модуль) и ./chart (типы + chartSpec-фикстуры).
 *   - lint:public остаётся зелёным.
 *
 * Покрытие:
 *   1. Каждый тип спеки (line/bar/pie/progress) → валидный SVG c нужными элементами.
 *   2. Пустые/placeholder-данные → валидный SVG без throw (overlay «нет данных»).
 *   3. Детерминированность: один вход → побайтово один выход.
 *   4. XML-безопасность: спецсимволы в лейблах экранируются.
 */

import { describe, expect, it } from 'vitest';

import { renderChartSvg } from './svg.js';
import {
	chartSpec,
	type BalanceEntry,
	type CategoryEntry,
	type DebtEntry,
	type GoalProgressData,
	type TimePoint,
} from './chart.js';

// ---------------------------------------------------------------------------
// Синтетические фикстуры (fake-example, нет PII)
// ---------------------------------------------------------------------------

const fakeNetworth: TimePoint[] = [
	{ ts: '2026-01-01T00:00:00Z', value: 100_000 },
	{ ts: '2026-03-01T00:00:00Z', value: 115_000 },
	{ ts: '2026-06-01T00:00:00Z', value: 130_000 },
];

// Мультивалюта + >5 счетов → chart.ts даёт type:'bar'.
const fakeBalancesBar: BalanceEntry[] = [
	{ label: 'fake-bank RUB', value: 50_000, currency: 'RUB' },
	{ label: 'fake-exchange USDT', value: 1_200, currency: 'USDT' },
	{ label: 'fake-cash EUR', value: 300, currency: 'EUR' },
	{ label: 'fake-savings RUB', value: 80_000, currency: 'RUB' },
	{ label: 'fake-broker USD', value: 2_000, currency: 'USD' },
	{ label: 'fake-wallet RUB', value: -1_500, currency: 'RUB' },
];

// Одна валюта + ≤5 счетов → chart.ts даёт type:'pie'.
const fakeBalancesPie: BalanceEntry[] = [
	{ label: 'fake-bank RUB', value: 50_000, currency: 'RUB' },
	{ label: 'fake-savings RUB', value: 80_000, currency: 'RUB' },
	{ label: 'fake-cash RUB', value: 5_000, currency: 'RUB' },
];

const fakeExpenses: CategoryEntry[] = [
	{ category: 'grocery', amount: 12_000, currency: 'RUB' },
	{ category: 'transport', amount: 4_000, currency: 'RUB' },
	{ category: 'fun', amount: 6_000, currency: 'RUB' },
];

const fakeGoal: GoalProgressData = {
	goal_id: 'fake-emergency-fund',
	label: 'Подушка',
	current: 60_000,
	target: 100_000,
	currency: 'RUB',
	fin_kind: 'save',
};

const fakeSpendCapOver: GoalProgressData = {
	goal_id: 'fake-dining-cap',
	label: 'Лимит на кафе',
	current: 15_000,
	target: 10_000,
	currency: 'RUB',
	fin_kind: 'spend_cap',
};

const fakeDebts: DebtEntry[] = [
	{ label: 'fake-credit-001 RUB', balance: 200_000, currency: 'RUB', rate_pct: 21.5 },
	{ label: 'fake-credit-002 RUB', balance: 50_000, currency: 'RUB', rate_pct: 15 },
];

// ---------------------------------------------------------------------------
// 1. Каждый тип спеки → валидный SVG с нужными элементами
// ---------------------------------------------------------------------------

describe('renderChartSvg — типы графиков', () => {
	it('line (networth_over_time): <svg>, <path>, <circle>, <text>', () => {
		const spec = chartSpec({ kind: 'networth_over_time', points: fakeNetworth, currency: 'RUB' });
		const svg = renderChartSvg(spec);

		expect(svg.startsWith('<svg')).toBe(true);
		expect(svg.endsWith('</svg>')).toBe(true);
		// Линия рисуется path-ом, точки — circle, подписи — text.
		expect(svg).toContain('<path');
		expect(svg).toContain('<circle');
		expect(svg).toContain('<text');
		// Заголовок графика присутствует.
		expect(svg).toContain('Чистый капитал');
	});

	it('bar (balances мультивалюта/>5): <svg>, <rect>, <text>', () => {
		const spec = chartSpec({ kind: 'balances_snapshot', entries: fakeBalancesBar });
		expect(spec.type).toBe('bar'); // sanity: chart.ts выбрал bar
		const svg = renderChartSvg(spec);

		expect(svg.startsWith('<svg')).toBe(true);
		// Столбцы — rect; должно быть несколько (фон + бары).
		expect((svg.match(/<rect/g) ?? []).length).toBeGreaterThan(1);
		expect(svg).toContain('<text');
		// Валюта в подписи столбца.
		expect(svg).toContain('USDT');
	});

	it('pie (balances одна валюта ≤5): <svg>, <path> (сектора), легенда', () => {
		const spec = chartSpec({ kind: 'balances_snapshot', entries: fakeBalancesPie });
		expect(spec.type).toBe('pie'); // sanity
		const svg = renderChartSvg(spec);

		expect(svg.startsWith('<svg')).toBe(true);
		// Сектора pie — path с дугой (флаг A в d).
		expect(svg).toContain('<path');
		expect(svg).toContain(' A'); // arc-команда
		// Легенда содержит проценты.
		expect(svg).toContain('%');
	});

	it('pie (expense_by_category): сектора + проценты', () => {
		const spec = chartSpec({ kind: 'expense_by_category', entries: fakeExpenses, currency: 'RUB' });
		const svg = renderChartSvg(spec);

		expect(svg.startsWith('<svg')).toBe(true);
		expect(svg).toContain('<path');
		expect(svg).toContain('grocery');
	});

	it('pie (debt_structure): сектора по долгам', () => {
		const spec = chartSpec({ kind: 'debt_structure', entries: fakeDebts });
		const svg = renderChartSvg(spec);

		expect(svg.startsWith('<svg')).toBe(true);
		expect(svg).toContain('<path');
		expect(svg).toContain('fake-credit-001 RUB');
	});

	it('progress (goal_progress save): <svg>, трек+заливка <rect>, процент', () => {
		const spec = chartSpec({ kind: 'goal_progress', data: fakeGoal });
		expect(spec.type).toBe('progress'); // sanity
		const svg = renderChartSvg(spec);

		expect(svg.startsWith('<svg')).toBe(true);
		// Трек + заливка = минимум 2 rect (плюс фон холста).
		expect((svg.match(/<rect/g) ?? []).length).toBeGreaterThanOrEqual(3);
		// 60000/100000 = 60%.
		expect(svg).toContain('60%');
	});

	it('progress (spend_cap перерасход): процент > 100 из meta.pct', () => {
		const spec = chartSpec({ kind: 'goal_progress', data: fakeSpendCapOver });
		const svg = renderChartSvg(spec);

		expect(svg.startsWith('<svg')).toBe(true);
		// 15000/10000 = 150% — берётся из meta.pct.
		expect(svg).toContain('150%');
		// Цвет перерасхода присутствует.
		expect(svg).toContain('#dc2626');
	});
});

// ---------------------------------------------------------------------------
// 2. Пустые/placeholder-данные → валидный SVG без throw
// ---------------------------------------------------------------------------

describe('renderChartSvg — пустые данные (graceful, без throw)', () => {
	it('пустой line → валидный SVG с overlay «Нет данных»', () => {
		const spec = chartSpec({ kind: 'networth_over_time', points: [], currency: 'RUB' });
		const svg = renderChartSvg(spec);
		expect(svg.startsWith('<svg')).toBe(true);
		expect(svg.endsWith('</svg>')).toBe(true);
		expect(svg).toContain('Нет данных');
	});

	it('пустой balances (pie placeholder) → валидный SVG', () => {
		const spec = chartSpec({ kind: 'balances_snapshot', entries: [] });
		const svg = renderChartSvg(spec);
		expect(svg.startsWith('<svg')).toBe(true);
		expect(svg).toContain('Нет данных');
	});

	it('пустой expense → валидный SVG', () => {
		const spec = chartSpec({ kind: 'expense_by_category', entries: [], currency: 'RUB' });
		const svg = renderChartSvg(spec);
		expect(svg.startsWith('<svg')).toBe(true);
		expect(svg).toContain('Нет данных');
	});

	it('null goal → progress placeholder, валидный SVG', () => {
		const spec = chartSpec({ kind: 'goal_progress', data: null });
		const svg = renderChartSvg(spec);
		expect(svg.startsWith('<svg')).toBe(true);
		expect(svg).toContain('Нет данных');
	});

	it('пустой debt → валидный SVG', () => {
		const spec = chartSpec({ kind: 'debt_structure', entries: [] });
		const svg = renderChartSvg(spec);
		expect(svg.startsWith('<svg')).toBe(true);
		expect(svg).toContain('Нет данных');
	});

	it('все долги нулевые (закрытые) → placeholder без throw', () => {
		const closed: DebtEntry[] = [{ label: 'fake-closed RUB', balance: 0, currency: 'RUB' }];
		const spec = chartSpec({ kind: 'debt_structure', entries: closed });
		const svg = renderChartSvg(spec);
		expect(svg.startsWith('<svg')).toBe(true);
		expect(svg).toContain('Нет данных');
	});
});

// ---------------------------------------------------------------------------
// 3. Детерминированность
// ---------------------------------------------------------------------------

describe('renderChartSvg — детерминированность', () => {
	it('один и тот же line-spec → побайтово один и тот же SVG', () => {
		const spec = chartSpec({ kind: 'networth_over_time', points: fakeNetworth, currency: 'RUB' });
		expect(renderChartSvg(spec)).toBe(renderChartSvg(spec));
	});

	it('один и тот же pie-spec → побайтово один и тот же SVG', () => {
		const spec = chartSpec({ kind: 'expense_by_category', entries: fakeExpenses, currency: 'RUB' });
		expect(renderChartSvg(spec)).toBe(renderChartSvg(spec));
	});

	it('один и тот же progress-spec → побайтово один и тот же SVG', () => {
		const spec = chartSpec({ kind: 'goal_progress', data: fakeGoal });
		expect(renderChartSvg(spec)).toBe(renderChartSvg(spec));
	});
});

// ---------------------------------------------------------------------------
// 4. XML-безопасность (экранирование лейблов)
// ---------------------------------------------------------------------------

describe('renderChartSvg — XML-безопасность', () => {
	it('спецсимволы в лейбле счёта экранируются (нет голого <,>,&)', () => {
		const tricky: BalanceEntry[] = [
			{ label: 'fake <A> & "B" RUB', value: 10_000, currency: 'RUB' },
			{ label: 'fake C RUB', value: 5_000, currency: 'RUB' },
		];
		const spec = chartSpec({ kind: 'balances_snapshot', entries: tricky });
		const svg = renderChartSvg(spec);
		// Экранированные сущности присутствуют.
		expect(svg).toContain('&lt;A&gt;');
		expect(svg).toContain('&amp;');
		expect(svg).toContain('&quot;');
		// Голый лейбл с угловыми скобками не просочился в разметку.
		expect(svg).not.toContain('<A>');
	});
});
