/**
 * finance-render.test.ts — СМОУК-тест тонкого адаптера растеризации (finance-render.ts).
 *
 * Принципы (по аналогии с telegram.test.ts / chart.test.ts):
 *   - Все данные синтетические (fake-example, нет PII).
 *   - Нет сети, нет спавна — растеризатор @resvg/resvg-js работает локально.
 *   - Импорт ТОЛЬКО из ./finance-render (тестируемый) и ../ingest/finance/chart (фикстуры).
 *   - Это смоук: проверяем, что PNG РЕАЛЬНО рендерится (магия + непустой буфер),
 *     детальная вёрстка покрыта в svg.test.ts (чистый слой).
 *
 * Покрытие:
 *   1. Простая спека → Buffer, начинается с PNG-магии (0x89 0x50 0x4E 0x47), непустой.
 *   2. Разные типы графиков растеризуются без throw.
 *   3. Пустая/placeholder-спека тоже даёт валидный PNG (graceful).
 */

import { describe, expect, it } from 'vitest';

import { renderChartPng } from './finance-render.js';
import {
	chartSpec,
	type BalanceEntry,
	type CategoryEntry,
	type GoalProgressData,
	type TimePoint,
} from '../ingest/finance/chart.js';

// Магия PNG: первые 4 байта файла (0x89 'P' 'N' 'G').
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

/** Проверка, что буфер — валидный PNG (магия + непустой). */
function expectValidPng(buf: Buffer): void {
	expect(Buffer.isBuffer(buf)).toBe(true);
	expect(buf.length).toBeGreaterThan(PNG_MAGIC.length);
	for (let i = 0; i < PNG_MAGIC.length; i++) {
		expect(buf[i]).toBe(PNG_MAGIC[i]);
	}
}

// ---------------------------------------------------------------------------
// Синтетические фикстуры
// ---------------------------------------------------------------------------

const fakeNetworth: TimePoint[] = [
	{ ts: '2026-01-01T00:00:00Z', value: 100_000 },
	{ ts: '2026-06-01T00:00:00Z', value: 130_000 },
];

const fakeBalancesPie: BalanceEntry[] = [
	{ label: 'fake-bank RUB', value: 50_000, currency: 'RUB' },
	{ label: 'fake-savings RUB', value: 80_000, currency: 'RUB' },
];

const fakeExpenses: CategoryEntry[] = [
	{ category: 'grocery', amount: 12_000, currency: 'RUB' },
	{ category: 'transport', amount: 4_000, currency: 'RUB' },
];

const fakeGoal: GoalProgressData = {
	goal_id: 'fake-emergency-fund',
	label: 'Подушка',
	current: 60_000,
	target: 100_000,
	currency: 'RUB',
	fin_kind: 'save',
};

// ---------------------------------------------------------------------------
// 1. Базовый смоук: PNG реально рендерится
// ---------------------------------------------------------------------------

describe('renderChartPng — смоук растеризации', () => {
	it('progress-спека → валидный PNG (магия + непустой буфер)', () => {
		const png = renderChartPng(chartSpec({ kind: 'goal_progress', data: fakeGoal }));
		expectValidPng(png);
	});

	it('line-спека (networth) → валидный PNG', () => {
		const png = renderChartPng(
			chartSpec({ kind: 'networth_over_time', points: fakeNetworth, currency: 'RUB' }),
		);
		expectValidPng(png);
	});

	it('pie-спека (balances) → валидный PNG', () => {
		const png = renderChartPng(chartSpec({ kind: 'balances_snapshot', entries: fakeBalancesPie }));
		expectValidPng(png);
	});

	it('pie-спека (expense) → валидный PNG', () => {
		const png = renderChartPng(
			chartSpec({ kind: 'expense_by_category', entries: fakeExpenses, currency: 'RUB' }),
		);
		expectValidPng(png);
	});
});

// ---------------------------------------------------------------------------
// 2. Опции разрешения
// ---------------------------------------------------------------------------

describe('renderChartPng — опции', () => {
	it('кастомная ширина → валидный PNG (рендерится без throw)', () => {
		const png = renderChartPng(chartSpec({ kind: 'goal_progress', data: fakeGoal }), {
			width: 640,
		});
		expectValidPng(png);
	});
});

// ---------------------------------------------------------------------------
// 3. Пустая/placeholder-спека тоже растеризуется (graceful)
// ---------------------------------------------------------------------------

describe('renderChartPng — пустые данные', () => {
	it('пустой line (placeholder) → валидный PNG без throw', () => {
		const png = renderChartPng(
			chartSpec({ kind: 'networth_over_time', points: [], currency: 'RUB' }),
		);
		expectValidPng(png);
	});

	it('null goal (placeholder) → валидный PNG без throw', () => {
		const png = renderChartPng(chartSpec({ kind: 'goal_progress', data: null }));
		expectValidPng(png);
	});
});
