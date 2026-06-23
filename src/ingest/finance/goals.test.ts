/**
 * goals.test.ts — тесты компаратора целей и математического движка.
 *
 * Принципы:
 *   - Все данные СИНТЕТИЧЕСКИЕ (fake-example, нет PII, нет реальных сумм/счетов).
 *   - Нет сетевых запросов: FxProvider мокается напрямую.
 *   - Каждая математическая формула проверяется с известными числами (ручная верификация).
 *   - Edge cases: monthsLeft=0, daysRemaining=0, ratePerMonth=0 vs >0,
 *     недостающий FX, cold-start флаг, конфликт целей, gross/net коэффициент.
 *   - lint:public остаётся зелёным: нет захардкоженных API ключей.
 *
 * Покрытие:
 *   1. computeGoalProgress — конвертация, суммирование, missing_fx, cold-start
 *   2. requiredMonthly — линейный режим, аннуитет (ручная верификация), edge cases
 *   3. requiredIncome — поправка gross/net, gap, нет taxCoefficient
 *   4. discretionary — остаток и дневной лимит, daysRemaining=0, available<0
 *   5. feasibility — реализуемая/нереализуемая, newTargetDate, нет remaining
 *   6. whatIf — deltaIncome, deltaExpense, oneTimeDeposit, нулевые сбережения
 *   7. checkGoalConflict — совместимые/несовместимые цели, приоритеты
 */

import { describe, expect, it } from 'vitest';
import type { FxProvider } from './fx.js';
import {
	computeGoalProgress,
	checkGoalConflict,
	discretionary,
	feasibility,
	requiredIncome,
	requiredMonthly,
	whatIf,
} from './goals.js';
import type { FinanceGoal, SnapshotRecord } from './types.js';

// ---------------------------------------------------------------------------
// Хелперы для тестов
// ---------------------------------------------------------------------------

/**
 * makeFx — создаёт мок FxProvider с заданной таблицей курсов.
 *
 * Таблица: { "USD/RUB": 90, "EUR/RUB": 99.5 }
 * Запросы вне таблицы → null (курс недоступен).
 * Тождественная пара (X→X) → 1 (не нужно добавлять в таблицу).
 *
 * @param rateTable — курсы вида { "BASE/QUOTE": rate }
 */
function makeFx(rateTable: Record<string, number>): FxProvider {
	return {
		async rate(base: string, quote: string, _atTsISO: string): Promise<number | null> {
			// Тождественная пара — всегда 1.
			if (base.toUpperCase() === quote.toUpperCase()) return 1;
			// Ищем в таблице.
			const key = `${base.toUpperCase()}/${quote.toUpperCase()}`;
			return rateTable[key] ?? null;
		},
	};
}

/**
 * makeGoal — синтетическая FinanceGoal.
 * Все суммы фиктивны — synthetic-example.
 */
function makeGoal(overrides: Partial<FinanceGoal> = {}): FinanceGoal {
	return {
		id: 'test-goal-001', // synthetic-example
		type: 'finance-goal',
		target_amount: 100000, // synthetic-example
		currency: 'RUB',
		target_date: '2027-01-01T00:00:00Z', // synthetic-example
		fin_kind: 'save',
		...overrides,
	};
}

/**
 * makeSnap — синтетический SnapshotRecord.
 */
function makeSnap(
	account_id: string,
	balance: number,
	currency: string,
	ts = '2026-06-01T10:00:00Z', // synthetic-example
): SnapshotRecord {
	return { ts, account_id, balance, currency };
}

// ---------------------------------------------------------------------------
// 1. computeGoalProgress
// ---------------------------------------------------------------------------

describe('computeGoalProgress: базовая конвертация', () => {
	it('одна валюта RUB→RUB: pct корректен', async () => {
		// synthetic-example: цель 100 000 RUB, на счёте 40 000 RUB
		const goal = makeGoal({ target_amount: 100000, currency: 'RUB' });
		const snaps: SnapshotRecord[] = [
			makeSnap('acc-001', 40000, 'RUB'), // synthetic-example
		];
		const fx = makeFx({});

		const result = await computeGoalProgress(goal, snaps, fx, '2026-06-01T10:00:00Z');

		expect(result.current).toBeCloseTo(40000);
		expect(result.target).toBe(100000);
		expect(result.pct).toBeCloseTo(40); // 40% выполнения
		expect(result.currency).toBe('RUB');
		expect(result.missing_fx).toHaveLength(0);
	});

	it('конвертация USD→RUB через FX', async () => {
		// synthetic-example: цель 100 000 RUB, на счёте 500 USD; курс 90 RUB/USD.
		// Два снапшота из разных месяцев чтобы избежать cold-start (MIN_HISTORY_MONTHS=2).
		const goal = makeGoal({ target_amount: 100000, currency: 'RUB' });
		const snaps: SnapshotRecord[] = [
			makeSnap('acc-usd', 400, 'USD', '2026-05-01T10:00:00Z'), // synthetic-example (старый месяц)
			makeSnap('acc-usd', 500, 'USD', '2026-06-01T10:00:00Z'), // synthetic-example (новый — последний)
		];
		// Последний снапшот 500 USD * 90 = 45 000 RUB → pct = 45%
		const fx = makeFx({ 'USD/RUB': 90 }); // synthetic-example

		const result = await computeGoalProgress(goal, snaps, fx, '2026-06-01T10:00:00Z');

		expect(result.current).toBeCloseTo(45000);
		expect(result.pct).toBeCloseTo(45);
		expect(result.missing_fx).toHaveLength(0);
		expect(result.coarse).toBe(false);
	});

	it('несколько счетов в разных валютах суммируются', async () => {
		// synthetic-example: 200 USD (= 18 000 RUB) + 50 000 RUB = 68 000 RUB
		// цель 100 000 RUB → pct = 68%
		const goal = makeGoal({ target_amount: 100000, currency: 'RUB' });
		const snaps: SnapshotRecord[] = [
			makeSnap('acc-usd', 200, 'USD', '2026-06-01T10:00:00Z'), // synthetic-example
			makeSnap('acc-rub', 50000, 'RUB', '2026-06-01T10:00:00Z'), // synthetic-example
		];
		const fx = makeFx({ 'USD/RUB': 90 }); // synthetic-example

		const result = await computeGoalProgress(goal, snaps, fx, '2026-06-01T10:00:00Z');

		// 200 * 90 + 50000 = 68000
		expect(result.current).toBeCloseTo(68000);
		expect(result.pct).toBeCloseTo(68);
	});

	it('берётся ПОСЛЕДНИЙ снапшот одного счёта (дедуп)', async () => {
		// synthetic-example: два снапшота одного счёта, берём более новый
		const goal = makeGoal({ target_amount: 100000, currency: 'RUB' });
		const snaps: SnapshotRecord[] = [
			makeSnap('acc-001', 10000, 'RUB', '2026-05-01T10:00:00Z'), // старый — synthetic
			makeSnap('acc-001', 60000, 'RUB', '2026-06-01T10:00:00Z'), // новый — synthetic
		];
		const fx = makeFx({});

		const result = await computeGoalProgress(goal, snaps, fx, '2026-06-15T10:00:00Z');

		// Должен использовать 60 000 (последний снапшот), а не 10 000
		expect(result.current).toBeCloseTo(60000);
		expect(result.pct).toBeCloseTo(60);
	});
});

describe('computeGoalProgress: missing_fx и coarse', () => {
	it('недоступный курс → missing_fx заполнен, coarse:true', async () => {
		// synthetic-example: счёт в EUR, цель в RUB — курс EUR/RUB недоступен
		const goal = makeGoal({ target_amount: 100000, currency: 'RUB' });
		const snaps: SnapshotRecord[] = [
			makeSnap('acc-eur', 500, 'EUR'), // synthetic-example — курс недоступен
		];
		const fx = makeFx({}); // пустая таблица — нет EUR/RUB

		const result = await computeGoalProgress(goal, snaps, fx, '2026-06-01T10:00:00Z');

		// Пропускаем счёт с недоступным курсом
		expect(result.current).toBeCloseTo(0);
		expect(result.coarse).toBe(true);
		expect(result.missing_fx).toContain('EUR/RUB');
	});

	it('частичный результат: один счёт конвертирован, другой — нет', async () => {
		// synthetic-example: USD счёт конвертируется, EUR — нет
		const goal = makeGoal({ target_amount: 100000, currency: 'RUB' });
		const snaps: SnapshotRecord[] = [
			makeSnap('acc-usd', 500, 'USD', '2026-06-01T10:00:00Z'), // synthetic-example
			makeSnap('acc-eur', 100, 'EUR', '2026-06-01T10:00:00Z'), // synthetic-example — нет курса
		];
		const fx = makeFx({ 'USD/RUB': 90 }); // только USD/RUB

		const result = await computeGoalProgress(goal, snaps, fx, '2026-06-01T10:00:00Z');

		// Только USD: 500 * 90 = 45 000 RUB (EUR пропущен)
		expect(result.current).toBeCloseTo(45000);
		expect(result.coarse).toBe(true);
		expect(result.missing_fx).toContain('EUR/RUB');
		expect(result.missing_fx).not.toContain('USD/RUB'); // USD нашёлся
	});
});

describe('computeGoalProgress: cold-start', () => {
	it('один уникальный месяц → coarse:true (cold-start)', async () => {
		// synthetic-example: все снапшоты в одном месяце — мало истории
		const goal = makeGoal({ target_amount: 100000, currency: 'RUB' });
		const snaps: SnapshotRecord[] = [
			makeSnap('acc-001', 30000, 'RUB', '2026-06-01T00:00:00Z'), // synthetic-example
			makeSnap('acc-001', 35000, 'RUB', '2026-06-15T00:00:00Z'), // тот же месяц
		];
		const fx = makeFx({});

		const result = await computeGoalProgress(goal, snaps, fx, '2026-06-20T00:00:00Z');

		expect(result.coarse).toBe(true);
	});

	it('два разных месяца → coarse:false при наличии курсов', async () => {
		// synthetic-example: снапшоты в двух разных месяцах — достаточно истории
		const goal = makeGoal({ target_amount: 100000, currency: 'RUB' });
		const snaps: SnapshotRecord[] = [
			makeSnap('acc-001', 20000, 'RUB', '2026-05-01T00:00:00Z'), // synthetic-example
			makeSnap('acc-001', 40000, 'RUB', '2026-06-01T00:00:00Z'), // synthetic-example
		];
		const fx = makeFx({});

		const result = await computeGoalProgress(goal, snaps, fx, '2026-06-20T00:00:00Z');

		expect(result.coarse).toBe(false);
	});

	it('пустые снапшоты → current=0, coarse:true (нет истории)', async () => {
		const goal = makeGoal({ target_amount: 100000, currency: 'RUB' });
		const fx = makeFx({});

		const result = await computeGoalProgress(goal, [], fx, '2026-06-01T10:00:00Z');

		expect(result.current).toBe(0);
		expect(result.pct).toBe(0);
		expect(result.coarse).toBe(true);
	});
});

describe('computeGoalProgress: linked_accounts фильтрация', () => {
	it('только linked_accounts включаются в расчёт', async () => {
		// synthetic-example: цель привязана к одному счёту из двух
		const goal = makeGoal({
			target_amount: 100000,
			currency: 'RUB',
			linked_accounts: ['acc-savings'], // только этот счёт
		});
		const snaps: SnapshotRecord[] = [
			makeSnap('acc-savings', 50000, 'RUB', '2026-06-01T00:00:00Z'), // synthetic-example
			makeSnap('acc-current', 200000, 'RUB', '2026-06-01T00:00:00Z'), // НЕ привязан
		];
		const fx = makeFx({});

		const result = await computeGoalProgress(goal, snaps, fx, '2026-06-20T00:00:00Z');

		// Только acc-savings: 50 000, не 250 000
		expect(result.current).toBeCloseTo(50000);
		expect(result.pct).toBeCloseTo(50);
	});
});

// ---------------------------------------------------------------------------
// 2. requiredMonthly
// ---------------------------------------------------------------------------

describe('requiredMonthly: линейный режим', () => {
	it('базовый расчёт: remaining/monthsLeft', () => {
		// synthetic-example: 120 000 оставшихся за 12 месяцев = 10 000/мес
		const plan = requiredMonthly(120000, 12);

		expect(plan.required).toBeCloseTo(10000);
		expect(plan.mode).toBe('linear');
		expect(plan.monthsLeft).toBe(12);
	});

	it('ratePerMonth=0 → линейный режим', () => {
		// synthetic-example: явная нулевая ставка → не аннуитет
		const plan = requiredMonthly(60000, 6, 0);

		expect(plan.required).toBeCloseTo(10000);
		expect(plan.mode).toBe('linear');
	});

	it('monthsLeft=1 → remaining сразу', () => {
		// synthetic-example: 1 месяц = весь оставшийся платёж
		const plan = requiredMonthly(50000, 1);

		expect(plan.required).toBeCloseTo(50000);
	});
});

describe('requiredMonthly: аннуитетный режим', () => {
	it('ручная верификация аннуитета (n=12, r=0.005)', () => {
		// Ручная проверка формулы:
		//   r = 0.005 (0.5% в месяц ≈ 6% годовых)
		//   n = 12 месяцев
		//   remaining = 120 000 (synthetic-example)
		//
		// PMT = 120000 * 0.005 / ((1.005)^12 − 1)
		//     = 600 / (1.06167781... − 1)
		//     = 600 / 0.06167781...
		//     ≈ 9729.91
		//
		// Проверяем с допуском 1 единица (floating point).
		const r = 0.005;
		const n = 12;
		const remaining = 120000; // synthetic-example

		const plan = requiredMonthly(remaining, n, r);
		const expectedPmt = (remaining * r) / (Math.pow(1 + r, n) - 1);

		expect(plan.required).toBeCloseTo(expectedPmt, 2);
		expect(plan.mode).toBe('annuity');
	});

	it('аннуитет меньше линейного при положительной доходности', () => {
		// synthetic-example: с доходностью нужно откладывать МЕНЬШЕ чем без неё
		const remaining = 100000; // synthetic-example
		const n = 24;
		const linearPlan = requiredMonthly(remaining, n);
		const annuityPlan = requiredMonthly(remaining, n, 0.005);

		// Аннуитетный PMT < линейного (доходность «помогает»)
		expect(annuityPlan.required).toBeLessThan(linearPlan.required);
	});

	it('n=1 аннуитет = remaining (один платёж)', () => {
		// synthetic-example: при n=1 и r>0, (1+r)^1 − 1 = r → PMT = remaining*r/r = remaining
		const remaining = 50000; // synthetic-example
		const plan = requiredMonthly(remaining, 1, 0.01);

		expect(plan.required).toBeCloseTo(remaining, 0); // 50 000 ± 1
	});
});

describe('requiredMonthly: edge cases', () => {
	it('monthsLeft=0 → Infinity и mode правильный', () => {
		const plan = requiredMonthly(100000, 0);

		expect(plan.required).toBe(Infinity);
		expect(plan.mode).toBe('linear');
		expect(plan.monthsLeft).toBe(0);
	});

	it('monthsLeft=0 с ставкой → Infinity, mode=annuity', () => {
		const plan = requiredMonthly(100000, 0, 0.005);

		expect(plan.required).toBe(Infinity);
		expect(plan.mode).toBe('annuity');
		expect(plan.monthsLeft).toBe(0);
	});

	it('monthsLeft отрицательный → Infinity', () => {
		const plan = requiredMonthly(100000, -5);

		expect(plan.required).toBe(Infinity);
	});
});

// ---------------------------------------------------------------------------
// 3. requiredIncome
// ---------------------------------------------------------------------------

describe('requiredIncome: базовый расчёт', () => {
	it('без taxCoefficient: grossRequired = fixedExpenses + goals + buffer', () => {
		// synthetic-example: аренда 30 000 + взносы по целям 15 000 + буфер 5 000 = 50 000
		const plan = requiredIncome(30000, 15000, 5000);

		expect(plan.grossRequired).toBeCloseTo(50000);
		expect(plan.netRequired).toBeCloseTo(50000); // без налогов = net = gross
		expect(plan.currentIncome).toBe(0); // дефолт
	});

	it('gap = grossRequired − currentIncome (положительный = нехватка)', () => {
		// synthetic-example: нужно 80 000, получаем 60 000 → gap = 20 000
		const plan = requiredIncome(50000, 20000, 10000, { currentIncome: 60000 });

		expect(plan.grossRequired).toBeCloseTo(80000);
		expect(plan.gap).toBeCloseTo(20000);
	});

	it('отрицательный gap = избыток', () => {
		// synthetic-example: нужно 50 000, получаем 100 000 → gap = -50 000 (избыток)
		const plan = requiredIncome(30000, 10000, 10000, { currentIncome: 100000 });

		expect(plan.gap).toBeLessThan(0);
		expect(plan.gap).toBeCloseTo(-50000);
	});
});

describe('requiredIncome: taxCoefficient поправка', () => {
	it('НДФЛ 13%: grossRequired выше чем netRequired', () => {
		// synthetic-example: НДФЛ 13% → taxCoefficient = 0.87
		// net = 50 000 → gross = 50 000 / 0.87 ≈ 57 471
		const plan = requiredIncome(30000, 15000, 5000, { taxCoefficient: 0.87 });

		expect(plan.netRequired).toBeCloseTo(50000);
		expect(plan.grossRequired).toBeCloseTo(50000 / 0.87, 0);
		expect(plan.grossRequired).toBeGreaterThan(plan.netRequired);
	});

	it('taxCoefficient=1: gross = net', () => {
		// synthetic-example: нет налогов
		const plan = requiredIncome(30000, 10000, 5000, { taxCoefficient: 1 });

		expect(plan.grossRequired).toBeCloseTo(plan.netRequired);
	});

	it('taxCoefficient=0 (невалидный): fallback к 1', () => {
		// synthetic-example: нулевой коэффициент игнорируется (защита от деления на 0)
		const plan = requiredIncome(30000, 10000, 5000, { taxCoefficient: 0 });

		expect(plan.grossRequired).toBeCloseTo(45000); // как при taxCoefficient=1
	});

	it('taxCoefficient разный — разные gross при одинаковом net', () => {
		// synthetic-example: два коэффициента — разный gross
		const plan87 = requiredIncome(30000, 10000, 0, { taxCoefficient: 0.87 });
		const plan70 = requiredIncome(30000, 10000, 0, { taxCoefficient: 0.70 });

		// 70% — более жёсткий налог → нужен больший валовый доход
		expect(plan70.grossRequired).toBeGreaterThan(plan87.grossRequired);
	});
});

// ---------------------------------------------------------------------------
// 4. discretionary
// ---------------------------------------------------------------------------

describe('discretionary: базовый расчёт', () => {
	it('available = income − goals − obligatory − spent', () => {
		// synthetic-example:
		//   доход 100 000, взносы 15 000, обязательные 30 000, потрачено 10 000
		//   available = 100 000 − 15 000 − 30 000 − 10 000 = 45 000
		const budget = discretionary(100000, 15000, 30000, { spent: 10000, daysRemaining: 15 });

		expect(budget.available).toBeCloseTo(45000);
	});

	it('dailyLimit = available / daysRemaining', () => {
		// synthetic-example: available = 45 000, daysRemaining = 15 → 3 000/день
		const budget = discretionary(100000, 15000, 30000, { spent: 10000, daysRemaining: 15 });

		expect(budget.dailyLimit).toBeCloseTo(3000);
	});

	it('daysRemaining=0 → dailyLimit=0 (защита деления)', () => {
		// synthetic-example: месяц закончился — лимит нулевой
		const budget = discretionary(100000, 15000, 30000, { spent: 0, daysRemaining: 0 });

		expect(budget.dailyLimit).toBe(0);
	});

	it('daysRemaining отрицательный → dailyLimit=0', () => {
		const budget = discretionary(100000, 15000, 30000, { spent: 0, daysRemaining: -5 });

		expect(budget.dailyLimit).toBe(0);
	});

	it('available < 0 (бюджет превышен) → dailyLimit=0', () => {
		// synthetic-example: потратили больше чем осталось — лимит 0
		const budget = discretionary(100000, 15000, 30000, { spent: 80000, daysRemaining: 5 });

		// available = 100 000 − 15 000 − 30 000 − 80 000 = −25 000
		expect(budget.available).toBeLessThan(0);
		expect(budget.dailyLimit).toBe(0);
	});

	it('defaults: spent=0, daysRemaining=1', () => {
		// synthetic-example: без опций — дефолты не вызывают ошибок
		const budget = discretionary(60000, 10000, 20000);

		// available = 60 000 − 10 000 − 20 000 − 0 = 30 000
		expect(budget.available).toBeCloseTo(30000);
		// dailyLimit = 30 000 / 1 = 30 000 (дефолт daysRemaining=1)
		expect(budget.dailyLimit).toBeCloseTo(30000);
	});
});

// ---------------------------------------------------------------------------
// 5. feasibility
// ---------------------------------------------------------------------------

describe('feasibility: реализуемые цели', () => {
	it('avgSavings >= sumRequired → feasible:true, shortfall=0', () => {
		// synthetic-example: накапливаем 20 000/мес, нужно 15 000 → выполнимо
		const result = feasibility(20000, 15000);

		expect(result.feasible).toBe(true);
		expect(result.shortfall).toBe(0);
		expect(result.newTargetDate).toBeUndefined();
	});

	it('avgSavings = sumRequired (граница) → feasible:true', () => {
		// synthetic-example: ровно совпадает → выполнимо
		const result = feasibility(15000, 15000);

		expect(result.feasible).toBe(true);
	});
});

describe('feasibility: нереализуемые цели', () => {
	it('avgSavings < sumRequired → feasible:false, shortfall > 0', () => {
		// synthetic-example: нужно 20 000, есть только 15 000 → нехватка 5 000
		const result = feasibility(15000, 20000);

		expect(result.feasible).toBe(false);
		expect(result.shortfall).toBeCloseTo(5000);
	});

	it('с remaining и nowTs → рассчитывает newTargetDate', () => {
		// synthetic-example:
		//   remaining = 60 000, savings = 15 000/мес → 4 месяца
		//   nowTs = 2026-06-01 → targetDate ≈ 2026-10-01
		const result = feasibility(15000, 20000, {
			remaining: 60000, // synthetic-example
			nowTs: '2026-06-01T00:00:00Z', // synthetic-example
		});

		expect(result.newTargetDate).toBeDefined();
		// 60 000 / 15 000 = 4 месяца → 2026-10-01
		expect(result.newTargetDate).toBe('2026-10-01');
	});

	it('avgSavings=0 → нет newTargetDate (недостижимо)', () => {
		// synthetic-example: нет сбережений — новый срок неизвестен
		const result = feasibility(0, 10000, {
			remaining: 50000, // synthetic-example
			nowTs: '2026-06-01T00:00:00Z', // synthetic-example
		});

		expect(result.feasible).toBe(false);
		expect(result.newTargetDate).toBeUndefined();
	});

	it('без remaining → нет newTargetDate', () => {
		// synthetic-example: нет данных об остатке — не считаем новый срок
		const result = feasibility(10000, 20000);

		expect(result.newTargetDate).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// 6. whatIf
// ---------------------------------------------------------------------------

describe('whatIf: изменение дохода/расхода', () => {
	it('deltaIncome увеличивает сбережения', () => {
		// synthetic-example: текущие сбережения 10 000, +5 000 дохода → 15 000/мес
		const result = whatIf(
			{ deltaIncome: 5000 }, // synthetic-example
			10000, // synthetic-example
			120000, // synthetic-example
			'2026-06-01T00:00:00Z', // synthetic-example
		);

		expect(result.newMonthlySavings).toBeCloseTo(15000);
		// 120 000 / 15 000 = 8 месяцев
		expect(result.newMonthsToGoal).toBe(8);
	});

	it('deltaExpense уменьшает сбережения', () => {
		// synthetic-example: текущие 10 000, расходы +3 000 → 7 000/мес
		const result = whatIf(
			{ deltaExpense: 3000 }, // synthetic-example
			10000, // synthetic-example
			70000, // synthetic-example
			'2026-06-01T00:00:00Z', // synthetic-example
		);

		expect(result.newMonthlySavings).toBeCloseTo(7000);
		// 70 000 / 7 000 = 10 месяцев
		expect(result.newMonthsToGoal).toBe(10);
	});

	it('oneTimeDeposit уменьшает remaining', () => {
		// synthetic-example: разовый взнос 40 000 при remaining 100 000 → остаток 60 000
		const result = whatIf(
			{ oneTimeDeposit: 40000 }, // synthetic-example
			10000, // synthetic-example
			100000, // synthetic-example
			'2026-06-01T00:00:00Z', // synthetic-example
		);

		// newRemaining = 60 000 / 10 000 = 6 месяцев
		expect(result.newMonthsToGoal).toBe(6);
	});

	it('oneTimeDeposit >= remaining → цель достигнута (newMonthsToGoal=0)', () => {
		// synthetic-example: взнос покрывает весь остаток
		const result = whatIf(
			{ oneTimeDeposit: 200000 }, // synthetic-example — больше remaining
			10000, // synthetic-example
			100000, // synthetic-example
			'2026-06-01T00:00:00Z', // synthetic-example
		);

		expect(result.newMonthsToGoal).toBe(0);
	});

	it('нулевые сбережения после изменений → newMonthsToGoal=Infinity', () => {
		// synthetic-example: delta уводит сбережения в ноль
		const result = whatIf(
			{ deltaExpense: 15000 }, // synthetic-example — больше текущих сбережений
			10000, // synthetic-example
			50000, // synthetic-example
			'2026-06-01T00:00:00Z', // synthetic-example
		);

		// newMonthlySavings = 10 000 − 15 000 = −5 000 → Infinity
		expect(result.newMonthlySavings).toBeCloseTo(-5000);
		expect(result.newMonthsToGoal).toBe(Infinity);
	});

	it('newTargetDate сдвигается при изменении дохода', () => {
		// synthetic-example: 120 000, старый срок 12 месяцев, с доп доходом — быстрее
		const resultBefore = whatIf(
			{},
			10000, // synthetic-example
			120000, // synthetic-example
			'2026-06-01T00:00:00Z', // synthetic-example
		);
		const resultAfter = whatIf(
			{ deltaIncome: 10000 }, // synthetic-example — удваиваем сбережения
			10000, // synthetic-example
			120000, // synthetic-example
			'2026-06-01T00:00:00Z', // synthetic-example
		);

		// После удвоения — срок вдвое меньше
		expect(resultAfter.newMonthsToGoal).toBeLessThan(resultBefore.newMonthsToGoal);
	});
});

// ---------------------------------------------------------------------------
// 7. checkGoalConflict
// ---------------------------------------------------------------------------

describe('checkGoalConflict: совместимые цели', () => {
	it('Σ requiredMonthly ≤ available → compatible:true', () => {
		// synthetic-example: три цели, общая потребность 25 000, доступно 30 000
		const goals = [
			{ goal: makeGoal({ id: 'goal-a', priority: 1 }), requiredMonthlyAmount: 10000 },
			{ goal: makeGoal({ id: 'goal-b', priority: 2 }), requiredMonthlyAmount: 8000 },
			{ goal: makeGoal({ id: 'goal-c', priority: 3 }), requiredMonthlyAmount: 7000 },
		];

		const result = checkGoalConflict(goals, 30000); // synthetic-example

		expect(result.compatible).toBe(true);
		expect(result.totalRequired).toBeCloseTo(25000);
		expect(result.shortfall).toBe(0);
		expect(result.conflictingGoals).toHaveLength(0);
	});

	it('ровно совпадает → compatible:true', () => {
		// synthetic-example: Σ = available = 20 000
		const goals = [
			{ goal: makeGoal({ id: 'goal-a' }), requiredMonthlyAmount: 12000 },
			{ goal: makeGoal({ id: 'goal-b' }), requiredMonthlyAmount: 8000 },
		];

		const result = checkGoalConflict(goals, 20000); // synthetic-example

		expect(result.compatible).toBe(true);
	});
});

describe('checkGoalConflict: конфликт целей', () => {
	it('Σ > available → compatible:false, shortfall > 0', () => {
		// synthetic-example: нужно 35 000, есть 25 000 → нехватка 10 000
		const goals = [
			{ goal: makeGoal({ id: 'goal-a', priority: 1 }), requiredMonthlyAmount: 15000 },
			{ goal: makeGoal({ id: 'goal-b', priority: 2 }), requiredMonthlyAmount: 12000 },
			{ goal: makeGoal({ id: 'goal-c', priority: 3 }), requiredMonthlyAmount: 8000 },
		];

		const result = checkGoalConflict(goals, 25000); // synthetic-example

		expect(result.compatible).toBe(false);
		expect(result.shortfall).toBeCloseTo(10000);
		expect(result.totalRequired).toBeCloseTo(35000);
	});

	it('конфликтующие цели — наименее приоритетные', () => {
		// synthetic-example: goal-c (priority=3) должна в списке конфликтующих
		const goals = [
			{ goal: makeGoal({ id: 'goal-a', priority: 1 }), requiredMonthlyAmount: 15000 },
			{ goal: makeGoal({ id: 'goal-b', priority: 2 }), requiredMonthlyAmount: 12000 },
			{ goal: makeGoal({ id: 'goal-c', priority: 3 }), requiredMonthlyAmount: 8000 },
		];

		const result = checkGoalConflict(goals, 25000); // synthetic-example

		// Нехватка 10 000: goal-c (8 000) не покрывает полностью 10 000,
		// поэтому берём и goal-b (12 000) — итого накоплено 20 000 >= 10 000
		expect(result.conflictingGoals).toContain('goal-c');
	});

	it('цели без приоритета (priority=undefined) — последними в очереди', () => {
		// synthetic-example: цель без приоритета конфликтует первой
		const goals = [
			{ goal: makeGoal({ id: 'goal-a', priority: 1 }), requiredMonthlyAmount: 10000 },
			{
				goal: makeGoal({ id: 'goal-no-prio' /* priority: undefined */ }),
				requiredMonthlyAmount: 5000,
			},
		];

		const result = checkGoalConflict(goals, 12000); // synthetic-example — нехватка 3 000

		// goal-no-prio наименее приоритетна → конфликтует
		expect(result.conflictingGoals).toContain('goal-no-prio');
	});

	it('одна цель конфликтует', () => {
		// synthetic-example: единственная цель и нет денег
		const goals = [{ goal: makeGoal({ id: 'only-goal' }), requiredMonthlyAmount: 20000 }];

		const result = checkGoalConflict(goals, 10000); // synthetic-example

		expect(result.compatible).toBe(false);
		expect(result.shortfall).toBeCloseTo(10000);
		expect(result.conflictingGoals).toContain('only-goal');
	});

	it('пустой список целей → compatible:true, totalRequired=0', () => {
		// synthetic-example: нет целей — нет конфликтов
		const result = checkGoalConflict([], 30000);

		expect(result.compatible).toBe(true);
		expect(result.totalRequired).toBe(0);
		expect(result.conflictingGoals).toHaveLength(0);
	});
});
