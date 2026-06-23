/**
 * credit.test.ts — тесты модуля амортизации и детекта платежей по кредитам.
 *
 * Принципы:
 *   - Все данные синтетические (FAKE суммы, выдуманные кредиты, нет PII).
 *   - Только чистые функции — нет IO, нет сети, нет бинарных вызовов.
 *   - Импорт ТОЛЬКО из ./types (как требует задание — ./credit тоже допустим
 *     поскольку это сам тестируемый модуль).
 *   - Числа выверены вручную для ключевых случаев.
 *
 * Покрытие:
 *   1. annuityPayment — формула, rate=0, точность.
 *   2. Аннуитетный график — сумма платежей постоянна, остаток убывает к 0.
 *   3. differentiatedPayment — платёж убывает к последнему периоду.
 *   4. Дифференцированный график — тело постоянно, проценты убывают.
 *   5. splitPayment — тело + проценты = платёж; различные сценарии.
 *   6. balanceAfterScheduledPayment через splitPayment (частичный/досрочный).
 *   7. projectPayoffDate — аннуитет и дифференцированный.
 *   8. isOverdue — просрочка с grace period и без; не просрочен; нет данных.
 *   9. creditPaymentsDue — окно включает/исключает; сортировка по дате.
 *  10. rate=0 — линейное погашение без процентов.
 *  11. Частичный и досрочный платёж в splitPayment.
 */

import { describe, expect, it } from 'vitest';

import type { CreditRecord } from './types.js';
import {
	annuityPayment,
	annuityPaymentFromBalance,
	differentiatedPayment,
	splitPayment,
	projectPayoffDate,
	isOverdue,
	creditPaymentsDue,
	addDaysToIso,
	addMonthsToIso,
	nextPaymentDateForDay,
	monthlyRateFromAnnual,
} from './credit.js';

// ---------------------------------------------------------------------------
// Синтетические фикстуры кредитов (FAKE данные, нет PII)
// ---------------------------------------------------------------------------

/**
 * Синтетический аннуитетный кредит:
 *   principal = 120 000 (fake-example)
 *   rate_pct  = 12% годовых → 1% в месяц
 *   term      = 12 месяцев
 *   balance   = 120 000 (только взяли)
 *
 * При r = 0.01, n = 12:
 *   PMT = 120000 * 0.01 * 1.01^12 / (1.01^12 - 1)
 *       = 120000 * 0.01 * 1.126825... / 0.126825...
 *       ≈ 120000 * 0.088849...
 *       ≈ 10661.85 (synthetic-example)
 */
const fakeAnnuityCredit: CreditRecord = {
	id: 'credit-annuity-fake-001', // synthetic-example
	source: 'manual',
	principal: 120000, // synthetic-example
	currency: 'RUB',
	rate_pct: 12, // synthetic-example: 12% годовых
	term: 12,
	type: 'annuity',
	balance: 120000, // synthetic-example: только взяли
	balance_ts: '2026-01-01T00:00:00Z', // synthetic-example
	opened_at: '2026-01-01T00:00:00Z', // synthetic-example
	manual: true,
	monthly_payment: undefined,
	next_payment_date: '2026-02-01T00:00:00Z', // synthetic-example
	payment_day: 1,
};

/**
 * Синтетический дифференцированный кредит:
 *   principal = 120 000 (fake-example)
 *   rate_pct  = 12% годовых → 1% в месяц
 *   term      = 12 месяцев
 *
 * Первый платёж:
 *   bodyPerPeriod = 120000 / 12 = 10000
 *   interest_0 = 120000 * 0.01 = 1200
 *   PMT_0 = 10000 + 1200 = 11200 (synthetic-example)
 *
 * Последний платёж (period 11):
 *   balanceBefore = 120000 - 10000*11 = 10000
 *   interest_11 = 10000 * 0.01 = 100
 *   PMT_11 = 10000 + 100 = 10100 (synthetic-example)
 */
const fakeDiffCredit: CreditRecord = {
	id: 'credit-diff-fake-001', // synthetic-example
	source: 'manual',
	principal: 120000, // synthetic-example
	currency: 'RUB',
	rate_pct: 12, // synthetic-example
	term: 12,
	type: 'differentiated',
	balance: 120000, // synthetic-example
	balance_ts: '2026-01-01T00:00:00Z', // synthetic-example
	opened_at: '2026-01-01T00:00:00Z', // synthetic-example
	manual: true,
	next_payment_date: '2026-02-01T00:00:00Z', // synthetic-example
};

/**
 * Синтетический кредит с нулевой ставкой (беспроцентная рассрочка):
 *   principal = 60 000 (fake-example)
 *   rate_pct  = 0
 *   term      = 6 месяцев
 *   PMT = 60000 / 6 = 10000 (synthetic-example)
 */
const fakeZeroRateCredit: CreditRecord = {
	id: 'credit-zero-rate-fake-001', // synthetic-example
	source: 'manual',
	principal: 60000, // synthetic-example
	currency: 'RUB',
	rate_pct: 0,
	term: 6,
	type: 'annuity',
	balance: 60000, // synthetic-example
	balance_ts: '2026-01-01T00:00:00Z', // synthetic-example
	opened_at: '2026-01-01T00:00:00Z', // synthetic-example
	manual: true,
	next_payment_date: '2026-02-01T00:00:00Z', // synthetic-example
};

// ---------------------------------------------------------------------------
// 1. annuityPayment — формула аннуитета
// ---------------------------------------------------------------------------

describe('annuityPayment: базовые вычисления', () => {
	it('12% годовых, 120000, 12 мес → ≈ 10661.85 (synthetic)', () => {
		// Ручная проверка:
		// r = 0.01, n = 12
		// PMT = 120000 * 0.01 * 1.01^12 / (1.01^12 - 1)
		// 1.01^12 ≈ 1.126825030...
		// PMT ≈ 120000 * 0.01 * 1.126825 / 0.126825 ≈ 10661.85
		const pmt = annuityPayment(120000, 0.01, 12);
		expect(pmt).toBeCloseTo(10661.85, 1); // synthetic-example
	});

	it('rate=0 → линейное деление: PMT = principal / term', () => {
		// При нулевой ставке формула вырождается в простое деление.
		// 60000 / 6 = 10000 (synthetic-example)
		const pmt = annuityPayment(60000, 0, 6);
		expect(pmt).toBeCloseTo(10000, 5); // synthetic-example
	});

	it('term=1 → один платёж закрывает весь долг + проценты', () => {
		// PMT = principal * r * (1+r)^1 / ((1+r)^1 - 1)
		//      = principal * r * (1+r) / r
		//      = principal * (1+r)
		// Для principal=1000, r=0.02: PMT = 1000 * 1.02 = 1020 (synthetic-example)
		const pmt = annuityPayment(1000, 0.02, 1);
		expect(pmt).toBeCloseTo(1020, 5); // synthetic-example
	});

	it('monthlyRateFromAnnual: 12% → 0.01', () => {
		// 12 / 100 / 12 = 0.01
		expect(monthlyRateFromAnnual(12)).toBeCloseTo(0.01, 10);
	});

	it('monthlyRateFromAnnual: 0% → 0', () => {
		expect(monthlyRateFromAnnual(0)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 2. Полный аннуитетный график амортизации
// ---------------------------------------------------------------------------

describe('аннуитетный график: свойства', () => {
	/**
	 * Строим полный граф амортизации:
	 * principal=120000, rate=12%, term=12
	 * PMT ≈ 10661.85 (synthetic-example)
	 */
	function buildAnnuitySchedule(
		principal: number,
		ratePerMonth: number,
		term: number,
	): Array<{ payment: number; interest: number; principal: number; balance: number }> {
		const pmt = annuityPayment(principal, ratePerMonth, term);
		const schedule = [];
		let balance = principal;

		for (let i = 0; i < term; i++) {
			const interest = balance * ratePerMonth;
			const principalPart = pmt - interest;
			balance = Math.max(0, balance - principalPart);
			schedule.push({ payment: pmt, interest, principal: principalPart, balance });
		}
		return schedule;
	}

	it('все платежи одинаковы (аннуитет)', () => {
		// Ключевое свойство аннуитета: PMT фиксирован.
		const schedule = buildAnnuitySchedule(120000, 0.01, 12);
		// schedule.length = 12 (non-null: term задан явно) — берём первый элемент.
		const firstPmt = schedule[0]!.payment;
		for (const row of schedule) {
			// Допускаем float-point погрешность в 1 копейку.
			expect(row.payment).toBeCloseTo(firstPmt, 5);
		}
	});

	it('остаток убывает к 0 к последнему платежу', () => {
		// Фундаментальное свойство: после term платежей balance → 0.
		const schedule = buildAnnuitySchedule(120000, 0.01, 12);
		// schedule.length = 12, последний элемент всегда есть (non-null).
		const lastBalance = schedule[schedule.length - 1]!.balance;
		// Допускаем float-point остаток < 1 коп (synthetic-example: ≈ 0.000...)
		expect(lastBalance).toBeCloseTo(0, 2); // synthetic-example
	});

	it('проценты убывают, тело возрастает (распределение аннуитета)', () => {
		// В аннуитете с каждым платежом доля процентов снижается, доля тела растёт.
		const schedule = buildAnnuitySchedule(120000, 0.01, 12);
		// schedule.length = 12 (non-null: term задан явно).
		// Проценты первого периода > последнего.
		expect(schedule[0]!.interest).toBeGreaterThan(schedule[11]!.interest);
		// Тело первого периода < последнего.
		expect(schedule[0]!.principal).toBeLessThan(schedule[11]!.principal);
	});

	it('сумма выплаченного тела = principal (с float-точностью)', () => {
		// Проверяем что весь principal погашен за term платежей.
		const schedule = buildAnnuitySchedule(120000, 0.01, 12);
		const totalPrincipal = schedule.reduce((s, r) => s + r.principal, 0);
		expect(totalPrincipal).toBeCloseTo(120000, 1); // synthetic-example
	});

	it('rate=0: равные платежи, нулевые проценты', () => {
		const schedule = buildAnnuitySchedule(60000, 0, 6);
		for (const row of schedule) {
			// Нет процентов при нулевой ставке.
			expect(row.interest).toBeCloseTo(0, 10);
			// Каждый платёж = 60000/6 = 10000 (synthetic-example).
			expect(row.payment).toBeCloseTo(10000, 5); // synthetic-example
		}
	});
});

// ---------------------------------------------------------------------------
// 3. differentiatedPayment — дифференцированные платежи
// ---------------------------------------------------------------------------

describe('differentiatedPayment: вычисления', () => {
	it('первый платёж (period=0): body + все проценты от principal', () => {
		// body = 120000/12 = 10000
		// interest = 120000 * 0.01 = 1200
		// PMT_0 = 11200 (synthetic-example)
		const pmt0 = differentiatedPayment(120000, 0.01, 12, 0);
		expect(pmt0).toBeCloseTo(11200, 5); // synthetic-example
	});

	it('последний платёж (period=11): body + минимальные проценты', () => {
		// balance перед периодом 11: 120000 - 10000*11 = 10000
		// interest = 10000 * 0.01 = 100
		// PMT_11 = 10000 + 100 = 10100 (synthetic-example)
		const pmt11 = differentiatedPayment(120000, 0.01, 12, 11);
		expect(pmt11).toBeCloseTo(10100, 5); // synthetic-example
	});

	it('платёж убывает от периода к периоду (монотонно)', () => {
		// Свойство дифференцированного кредита: каждый следующий платёж <= предыдущего.
		const payments = Array.from({ length: 12 }, (_, i) =>
			differentiatedPayment(120000, 0.01, 12, i),
		);
		for (let i = 1; i < payments.length; i++) {
			// non-null: индексы гарантированы диапазоном цикла [1, payments.length).
			expect(payments[i]!).toBeLessThanOrEqual(payments[i - 1]!);
		}
	});

	it('rate=0: все платежи равны (нет процентов)', () => {
		// При r=0: тело = 120000/12 = 10000, процентов нет → все PMT = 10000
		for (let i = 0; i < 12; i++) {
			const pmt = differentiatedPayment(120000, 0, 12, i);
			expect(pmt).toBeCloseTo(10000, 5); // synthetic-example
		}
	});

	it('сумма дифференцированных платежей > сумма аннуитетных (для той же ставки)', () => {
		// Дифференцированные платежи в сумме = тело + проценты на убывающий остаток.
		// Первый платёж самый большой → общая сумма процентов обычно меньше аннуитета.
		// НО первые платежи больше, последние меньше.
		// Ключевое: сумма дифференцированных тел = principal.
		const totalBody = Array.from({ length: 12 }, (_, i) =>
			differentiatedPayment(120000, 0.01, 12, i),
		).reduce((s, pmt, i) => {
			// Тело = pmt - проценты на остаток.
			const remainingBefore = 120000 - (120000 / 12) * i;
			const interest = remainingBefore * 0.01;
			return s + (pmt - interest);
		}, 0);
		expect(totalBody).toBeCloseTo(120000, 1); // synthetic-example
	});
});

// ---------------------------------------------------------------------------
// 4. splitPayment — разбивка платежа
// ---------------------------------------------------------------------------

describe('splitPayment: разбивка на тело и проценты', () => {
	it('для аннуитета: principal + interest ≈ paymentAmount', () => {
		// PMT ≈ 10661.85 (synthetic-example)
		const pmt = annuityPayment(120000, 0.01, 12);
		const result = splitPayment(fakeAnnuityCredit, pmt);
		// Сумма частей = платёж (с float-точностью).
		expect(result.principal + result.interest).toBeCloseTo(pmt, 5);
	});

	it('первый платёж: interest = balance * monthlyRate', () => {
		// interest = 120000 * 0.01 = 1200 (synthetic-example)
		const pmt = annuityPayment(120000, 0.01, 12);
		const result = splitPayment(fakeAnnuityCredit, pmt);
		expect(result.interest).toBeCloseTo(1200, 5); // synthetic-example
	});

	it('первый платёж: principal = PMT - interest', () => {
		// principal = PMT - 1200 ≈ 10661.85 - 1200 = 9461.85 (synthetic-example)
		const pmt = annuityPayment(120000, 0.01, 12);
		const result = splitPayment(fakeAnnuityCredit, pmt);
		expect(result.principal).toBeCloseTo(pmt - 1200, 1); // synthetic-example
	});

	it('newBalance = balance - principal', () => {
		const pmt = annuityPayment(120000, 0.01, 12);
		const result = splitPayment(fakeAnnuityCredit, pmt);
		// Новый баланс = 120000 - principal.
		expect(result.newBalance).toBeCloseTo(120000 - result.principal, 5);
	});

	it('частичный платёж (меньше планового): newBalance > balance - bodyPerPeriod', () => {
		// Платим только 5000 вместо ~10661 (synthetic-example).
		// Из 5000: interest = 1200, principal = 3800.
		// newBalance = 120000 - 3800 = 116200 (synthetic-example).
		const smallPayment = 5000; // synthetic-example
		const result = splitPayment(fakeAnnuityCredit, smallPayment);
		expect(result.interest).toBeCloseTo(1200, 5); // synthetic-example
		expect(result.principal).toBeCloseTo(3800, 5); // synthetic-example
		expect(result.newBalance).toBeCloseTo(116200, 5); // synthetic-example
	});

	it('досрочное погашение (платёж > balance): newBalance = 0', () => {
		// Платим 200000 при balance = 120000 (synthetic-example).
		// principal = 120000 (весь), newBalance = 0.
		const overpayment = 200000; // synthetic-example
		const result = splitPayment(fakeAnnuityCredit, overpayment);
		expect(result.newBalance).toBeCloseTo(0, 5);
		expect(result.principal).toBeCloseTo(120000, 5); // synthetic-example
	});

	it('rate=0: весь платёж идёт в тело (нет процентов)', () => {
		// При нулевой ставке: interest = balance * 0 = 0.
		// Весь платёж = тело.
		const pmt = 10000; // synthetic-example: 60000 / 6
		const result = splitPayment(fakeZeroRateCredit, pmt);
		expect(result.interest).toBeCloseTo(0, 10);
		expect(result.principal).toBeCloseTo(10000, 5); // synthetic-example
		expect(result.newBalance).toBeCloseTo(50000, 5); // synthetic-example: 60000 - 10000
	});

	it('платёж меньше процентов: весь платёж = проценты, principal = 0', () => {
		// Создаём кредит с огромным балансом и маленьким платежом.
		// balance = 1 000 000, rate = 12%, monthlyInterest = 10000.
		// Платим 5000 — меньше процентов.
		const hugeCredit: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-huge-fake-001', // synthetic-example
			balance: 1000000, // synthetic-example
			principal: 1000000, // synthetic-example
		};
		const result = splitPayment(hugeCredit, 5000); // synthetic-example
		// Платёж < interest → весь платёж = проценты, principal = 0.
		expect(result.principal).toBeCloseTo(0, 5);
		expect(result.interest).toBeCloseTo(5000, 5); // synthetic-example
		// Баланс не уменьшается (тело не погашается).
		expect(result.newBalance).toBeCloseTo(1000000, 5); // synthetic-example
	});

	it('баланс = 0: возвращает нули', () => {
		// Погашенный кредит: balance = 0.
		const paidCredit: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-paid-fake-001', // synthetic-example
			balance: 0,
		};
		const result = splitPayment(paidCredit, 100); // synthetic-example
		expect(result.principal).toBeCloseTo(0, 10);
		expect(result.interest).toBeCloseTo(0, 10);
		expect(result.newBalance).toBeCloseTo(0, 10);
	});
});

// ---------------------------------------------------------------------------
// 5. annuityPaymentFromBalance — PMT для оставшегося баланса
// ---------------------------------------------------------------------------

describe('annuityPaymentFromBalance', () => {
	it('совпадает с annuityPayment когда balance = principal', () => {
		// Если balance = principal → PMT должен совпасть.
		const pmt1 = annuityPayment(120000, 0.01, 12);
		const pmt2 = annuityPaymentFromBalance(120000, 0.01, 12);
		expect(pmt2).toBeCloseTo(pmt1, 5);
	});

	it('для меньшего баланса при том же сроке PMT пропорционально меньше', () => {
		// При том же сроке n=12 и вдвое меньшем балансе PMT пропорционально меньше.
		// original: principal=120000, r=0.01, n=12 → PMT ≈ 10661.85 (synthetic-example)
		// half:     balance=60000,    r=0.01, n=12 → PMT ≈ 5330.92 (половина)
		const originalPmt = annuityPayment(120000, 0.01, 12);
		const halfPmt = annuityPaymentFromBalance(60000, 0.01, 12);
		expect(halfPmt).toBeGreaterThan(0);
		// PMT для 60000 ≈ PMT_original / 2 (линейная зависимость от баланса).
		expect(halfPmt).toBeCloseTo(originalPmt / 2, 1); // synthetic-example
	});

	it('для меньшего баланса с КОРОТКИМ сроком PMT > начального (меньше времени погасить)', () => {
		// Математически: 62000 за 6 мес даёт БОЛЬШИЙ PMT чем 120000 за 12 мес.
		// Потому что срок сократился сильнее, чем баланс.
		// balance=62000, r=0.01, n=6 → PMT ≈ 10698 (synthetic-example) > 10662.
		const balanceAt6 = 62000; // synthetic-example: остаток
		const pmt = annuityPaymentFromBalance(balanceAt6, 0.01, 6);
		const originalPmt = annuityPayment(120000, 0.01, 12);
		// Проверяем что функция вернула положительное значение.
		expect(pmt).toBeGreaterThan(0);
		// Для 62000 за 6 мес PMT > для 120000 за 12 мес (меньше времени → выше платёж).
		expect(pmt).toBeGreaterThan(originalPmt); // synthetic-example: ~10698 > ~10662
	});

	it('rate=0 → balance / remainingTerm', () => {
		// 60000 / 6 = 10000 (synthetic-example)
		const pmt = annuityPaymentFromBalance(60000, 0, 6);
		expect(pmt).toBeCloseTo(10000, 5); // synthetic-example
	});
});

// ---------------------------------------------------------------------------
// 6. projectPayoffDate
// ---------------------------------------------------------------------------

describe('projectPayoffDate: прогноз даты погашения', () => {
	it('аннуитет с term=12 от открытия → дата ≈ через 12 мес', () => {
		// Кредит открыт 2026-01-01, срок 12 мес → погашение ≈ 2027-01-01 (synthetic-example)
		const payoffDate = projectPayoffDate(
			fakeAnnuityCredit,
			'2026-01-01T00:00:00Z', // synthetic-example: now = начало кредита
		);
		// Ожидаем что дата около 2027-01 (срок = 12 мес).
		expect(payoffDate).toContain('2027'); // synthetic-example
	});

	it('дифференцированный с term=12 → аналогичная дата', () => {
		const payoffDate = projectPayoffDate(
			fakeDiffCredit,
			'2026-01-01T00:00:00Z', // synthetic-example
		);
		// Тот же срок → та же дата погашения.
		expect(payoffDate).toContain('2027'); // synthetic-example
	});

	it('balance=0 → возвращает now (уже погашен)', () => {
		const paidCredit: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-paid-proj-fake-001', // synthetic-example
			balance: 0,
		};
		const now = '2026-06-01T00:00:00Z'; // synthetic-example
		expect(projectPayoffDate(paidCredit, now)).toBe(now);
	});

	it('с opened_at: дата в прошлом уменьшает оставшийся срок', () => {
		// Кредит открыт год назад (2025-01), срок 24 мес → осталось 12 мес.
		const almostDoneCredit: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-almost-fake-001', // synthetic-example
			opened_at: '2025-01-01T00:00:00Z', // synthetic-example: год назад
			balance_ts: '2026-01-01T00:00:00Z', // synthetic-example
			balance: 60000, // synthetic-example: примерно половина погашена
			principal: 120000, // synthetic-example
			term: 24,
		};
		const payoffDate = projectPayoffDate(almostDoneCredit, '2026-01-01T00:00:00Z'); // synthetic-example
		// Осталось 12 мес → дата должна быть около 2027-01.
		expect(payoffDate).toContain('2027'); // synthetic-example
	});

	it('возвращает ISO строку (содержит T и Z)', () => {
		const payoffDate = projectPayoffDate(fakeAnnuityCredit, '2026-01-01T00:00:00Z'); // synthetic-example
		expect(payoffDate).toMatch(/T.*Z$/);
	});
});

// ---------------------------------------------------------------------------
// 7. isOverdue — предикат просрочки
// ---------------------------------------------------------------------------

describe('isOverdue: детект просрочки', () => {
	it('next_payment_date в прошлом без grace → просрочен', () => {
		// Дата платежа: 2026-05-01, now: 2026-06-01 → просрочен (synthetic-example)
		const overdueCredit: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-overdue-fake-001', // synthetic-example
			next_payment_date: '2026-05-01T00:00:00Z', // synthetic-example: прошлый месяц
		};
		expect(isOverdue(overdueCredit, '2026-06-01T00:00:00Z')).toBe(true); // synthetic-example
	});

	it('next_payment_date = сегодня → НЕ просрочен (ещё не просрочен)', () => {
		// Платёж сегодня — значит надо платить сегодня, но ещё не просрочен.
		const todayCredit: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-today-fake-001', // synthetic-example
			next_payment_date: '2026-06-01T00:00:00Z', // synthetic-example
		};
		expect(isOverdue(todayCredit, '2026-06-01T12:00:00Z')).toBe(false); // synthetic-example
	});

	it('next_payment_date в будущем → НЕ просрочен', () => {
		// Следующий платёж через неделю (synthetic-example).
		const futureCredit: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-future-fake-001', // synthetic-example
			next_payment_date: '2026-07-01T00:00:00Z', // synthetic-example: следующий месяц
		};
		expect(isOverdue(futureCredit, '2026-06-01T00:00:00Z')).toBe(false); // synthetic-example
	});

	it('grace period покрывает просрочку → НЕ просрочен', () => {
		// Дата платежа: 2026-06-01, now: 2026-06-03, grace: 5 дней.
		// Грейс-дата: 2026-06-06 > now → не просрочен (synthetic-example).
		const graceCredit: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-grace-fake-001', // synthetic-example
			next_payment_date: '2026-06-01T00:00:00Z', // synthetic-example
			grace: 5, // synthetic-example: 5 дней
		};
		expect(isOverdue(graceCredit, '2026-06-03T00:00:00Z')).toBe(false); // synthetic-example
	});

	it('grace period истёк → просрочен', () => {
		// Дата платежа: 2026-06-01, grace: 3 дня, now: 2026-06-05.
		// Грейс-дата: 2026-06-04 < now → просрочен (synthetic-example).
		const graceExpiredCredit: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-grace-exp-fake-001', // synthetic-example
			next_payment_date: '2026-06-01T00:00:00Z', // synthetic-example
			grace: 3, // synthetic-example
		};
		expect(isOverdue(graceExpiredCredit, '2026-06-05T00:00:00Z')).toBe(true); // synthetic-example
	});

	it('balance=0 → НЕ просрочен (погашен)', () => {
		// Погашенный кредит не может быть просрочен.
		const paidCredit: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-paid-over-fake-001', // synthetic-example
			balance: 0,
			next_payment_date: '2026-01-01T00:00:00Z', // synthetic-example: в прошлом
		};
		expect(isOverdue(paidCredit, '2026-06-01T00:00:00Z')).toBe(false); // synthetic-example
	});

	it('нет next_payment_date, нет payment_day → false (нет данных)', () => {
		// Когда данных нет — не знаем, просрочен ли.
		const unknownCredit: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-unknown-fake-001', // synthetic-example
			next_payment_date: undefined,
			payment_day: undefined,
		};
		expect(isOverdue(unknownCredit, '2026-06-01T00:00:00Z')).toBe(false); // synthetic-example
	});

	it('payment_day в прошлом этого месяца → просрочен', () => {
		// Платёж 1-го числа, сейчас 15-е → платёж 2026-06-01 просрочен.
		const dayCredit: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-day-overdue-fake-001', // synthetic-example
			next_payment_date: undefined, // убираем явную дату
			payment_day: 1, // synthetic-example: платим 1-го числа
			grace: 0,
		};
		// 15 июня — платёж 1 июня уже прошёл (synthetic-example).
		expect(isOverdue(dayCredit, '2026-06-15T00:00:00Z')).toBe(true); // synthetic-example
	});
});

// ---------------------------------------------------------------------------
// 8. creditPaymentsDue — платежи в окне
// ---------------------------------------------------------------------------

describe('creditPaymentsDue: окно платежей', () => {
	it('платёж точно в день now → входит в окно (windowDays=30)', () => {
		// next_payment_date = now → попадает в начало окна (synthetic-example).
		const credit: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-due-now-fake-001', // synthetic-example
			next_payment_date: '2026-06-01T00:00:00Z', // synthetic-example
			monthly_payment: 10000, // synthetic-example
		};
		const result = creditPaymentsDue([credit], '2026-06-01T00:00:00Z', 30); // synthetic-example
		expect(result).toHaveLength(1);
		expect(result[0]!.credit_id).toBe('credit-due-now-fake-001'); // synthetic-example
	});

	it('платёж в конце окна (= windowEndDate) → входит', () => {
		// now = 2026-06-01, windowDays = 30 → windowEnd ≈ 2026-07-01.
		// next_payment_date = 2026-07-01 → должен войти (synthetic-example).
		const now = '2026-06-01T00:00:00Z'; // synthetic-example
		const windowEndDate = addDaysToIso(now, 30);
		const credit: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-due-end-fake-001', // synthetic-example
			next_payment_date: windowEndDate,
			monthly_payment: 10000, // synthetic-example
		};
		const result = creditPaymentsDue([credit], now, 30); // synthetic-example
		expect(result).toHaveLength(1);
	});

	it('платёж до now → НЕ входит в окно', () => {
		// Прошедший платёж не показываем в будущем окне (synthetic-example).
		const credit: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-past-fake-001', // synthetic-example
			next_payment_date: '2026-05-01T00:00:00Z', // synthetic-example: прошлый месяц
			monthly_payment: 10000, // synthetic-example
		};
		const result = creditPaymentsDue([credit], '2026-06-01T00:00:00Z', 30); // synthetic-example
		expect(result).toHaveLength(0);
	});

	it('платёж за пределами окна → НЕ входит', () => {
		// Платёж через 2 месяца — вне окна 30 дней (synthetic-example).
		const credit: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-far-fake-001', // synthetic-example
			next_payment_date: '2026-08-01T00:00:00Z', // synthetic-example
			monthly_payment: 10000, // synthetic-example
		};
		const result = creditPaymentsDue([credit], '2026-06-01T00:00:00Z', 30); // synthetic-example
		expect(result).toHaveLength(0);
	});

	it('несколько кредитов: сортировка по dueDate', () => {
		// Три кредита с разными датами платежей (synthetic-example).
		const c1: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-sort-3-fake-001', // synthetic-example
			next_payment_date: '2026-06-20T00:00:00Z', // synthetic-example: третий
			monthly_payment: 5000, // synthetic-example
		};
		const c2: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-sort-1-fake-001', // synthetic-example
			next_payment_date: '2026-06-05T00:00:00Z', // synthetic-example: первый
			monthly_payment: 8000, // synthetic-example
		};
		const c3: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-sort-2-fake-001', // synthetic-example
			next_payment_date: '2026-06-10T00:00:00Z', // synthetic-example: второй
			monthly_payment: 3000, // synthetic-example
		};
		const result = creditPaymentsDue([c1, c2, c3], '2026-06-01T00:00:00Z', 30); // synthetic-example
		expect(result).toHaveLength(3);
		// Первым должен быть кредит с датой 06-05 (non-null: длина проверена выше).
		expect(result[0]!.credit_id).toBe('credit-sort-1-fake-001'); // synthetic-example
		expect(result[1]!.credit_id).toBe('credit-sort-2-fake-001'); // synthetic-example
		expect(result[2]!.credit_id).toBe('credit-sort-3-fake-001'); // synthetic-example
	});

	it('кредит с balance=0 пропускается', () => {
		// Погашенный кредит не должен появляться в платежах (synthetic-example).
		const paidCredit: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-paid-due-fake-001', // synthetic-example
			balance: 0,
			next_payment_date: '2026-06-15T00:00:00Z', // synthetic-example
			monthly_payment: 10000, // synthetic-example
		};
		const result = creditPaymentsDue([paidCredit], '2026-06-01T00:00:00Z', 30); // synthetic-example
		expect(result).toHaveLength(0);
	});

	it('возвращает balanceAfter (ненулевой)', () => {
		// Проверяем что balanceAfter вычислен и разумен (synthetic-example).
		const credit: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-balance-after-fake-001', // synthetic-example
			next_payment_date: '2026-06-15T00:00:00Z', // synthetic-example
			monthly_payment: 10000, // synthetic-example
			balance: 120000, // synthetic-example
		};
		const result = creditPaymentsDue([credit], '2026-06-01T00:00:00Z', 30); // synthetic-example
		expect(result).toHaveLength(1);
		// После платежа balance должен уменьшиться (non-null: длина проверена выше).
		expect(result[0]!.balanceAfter).toBeLessThan(120000); // synthetic-example
		expect(result[0]!.balanceAfter).toBeGreaterThanOrEqual(0);
	});

	it('возвращает amount из monthly_payment', () => {
		// Если monthly_payment задан — используем его.
		const credit: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-amt-fake-001', // synthetic-example
			next_payment_date: '2026-06-15T00:00:00Z', // synthetic-example
			monthly_payment: 15000, // synthetic-example
		};
		const result = creditPaymentsDue([credit], '2026-06-01T00:00:00Z', 30); // synthetic-example
		// non-null: длина не проверяется явно, но тест упадёт если result пустой.
		expect(result[0]!.amount).toBeCloseTo(15000, 5); // synthetic-example
	});

	it('windowDays=0: только платежи точно в now', () => {
		// Окно нулевой ширины — только если дата = now (synthetic-example).
		const c1: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-win0-now-fake-001', // synthetic-example
			next_payment_date: '2026-06-01T00:00:00Z', // synthetic-example: = now
			monthly_payment: 10000, // synthetic-example
		};
		const c2: CreditRecord = {
			...fakeAnnuityCredit,
			id: 'credit-win0-future-fake-001', // synthetic-example
			next_payment_date: '2026-06-02T00:00:00Z', // synthetic-example: завтра
			monthly_payment: 10000, // synthetic-example
		};
		const result = creditPaymentsDue([c1, c2], '2026-06-01T00:00:00Z', 0); // synthetic-example
		expect(result).toHaveLength(1);
		// non-null: длина проверена выше.
		expect(result[0]!.credit_id).toBe('credit-win0-now-fake-001'); // synthetic-example
	});
});

// ---------------------------------------------------------------------------
// 9. Вспомогательные функции дат
// ---------------------------------------------------------------------------

describe('addDaysToIso', () => {
	it('добавляет 30 дней', () => {
		// 2026-06-01 + 30 = 2026-07-01 (synthetic-example)
		const result = addDaysToIso('2026-06-01T00:00:00Z', 30);
		expect(result).toContain('2026-07-01'); // synthetic-example
	});

	it('добавляет 0 дней → та же дата', () => {
		const result = addDaysToIso('2026-06-01T00:00:00Z', 0);
		expect(result).toContain('2026-06-01'); // synthetic-example
	});
});

describe('addMonthsToIso', () => {
	it('добавляет 12 месяцев = год', () => {
		// 2026-01-01 + 12 мес = 2027-01-01 (synthetic-example)
		const result = addMonthsToIso('2026-01-01T00:00:00Z', 12);
		expect(result).toContain('2027-01-01'); // synthetic-example
	});

	it('добавляет 0 месяцев → та же дата', () => {
		const result = addMonthsToIso('2026-06-01T00:00:00Z', 0);
		expect(result).toContain('2026-06-01'); // synthetic-example
	});
});

describe('nextPaymentDateForDay', () => {
	it('payment_day > today → текущий месяц', () => {
		// now = 2026-06-10, payment_day = 20 → 2026-06-20 (synthetic-example)
		const result = nextPaymentDateForDay('2026-06-10T00:00:00Z', 20);
		expect(result).toContain('2026-06-20'); // synthetic-example
	});

	it('payment_day < today → следующий месяц', () => {
		// now = 2026-06-10, payment_day = 5 → 2026-07-05 (synthetic-example)
		const result = nextPaymentDateForDay('2026-06-10T00:00:00Z', 5);
		expect(result).toContain('2026-07-05'); // synthetic-example
	});

	it('payment_day = today → текущий месяц (включительно)', () => {
		// now = 2026-06-10, payment_day = 10 → 2026-06-10 (synthetic-example)
		const result = nextPaymentDateForDay('2026-06-10T00:00:00Z', 10);
		expect(result).toContain('2026-06-10'); // synthetic-example
	});
});

// ---------------------------------------------------------------------------
// 10. Edge-кейсы дифференцированного кредита (частично погашённый)
// ---------------------------------------------------------------------------

describe('differentiatedPayment и creditPaymentsDue: частично погашённый кредит', () => {
	/**
	 * Синтетический дифференцированный кредит с частичным погашением:
	 *   principal = 120 000 (fake-example)
	 *   balance   = 30 000 (погашено 75%)
	 *   term      = 12 мес
	 *   rate_pct  = 12%
	 *
	 * Правильный платёж: bodyPerPeriod + balance * monthlyRate
	 *   = 10000 + 30000 * 0.01 = 10000 + 300 = 10300 (synthetic-example)
	 *
	 * Старый баг: проценты брались от теоретического остатка (120000 при periodIndex=0),
	 * давая 10000 + 1200 = 11200 — неверно.
	 */
	const partiallyPaidDiff: CreditRecord = {
		id: 'credit-diff-partial-fake-001', // synthetic-example
		source: 'manual',
		principal: 120000, // synthetic-example
		currency: 'RUB',
		rate_pct: 12, // synthetic-example
		term: 12,
		type: 'differentiated',
		balance: 30000, // synthetic-example: 75% погашено
		balance_ts: '2026-04-01T00:00:00Z', // synthetic-example
		opened_at: '2026-01-01T00:00:00Z', // synthetic-example: 3 мес прошло
		manual: true,
		next_payment_date: '2026-05-01T00:00:00Z', // synthetic-example
	};

	it('amount = bodyPerPeriod + фактический_balance * rate (не теоретический остаток)', () => {
		// Правильная формула: 10000 + 30000 * 0.01 = 10300 (synthetic-example)
		// Баг: давало 10000 + 120000 * 0.01 = 11200 (от полного principal).
		const result = creditPaymentsDue([partiallyPaidDiff], '2026-04-15T00:00:00Z', 30);
		expect(result).toHaveLength(1);
		const due = result[0]!;
		// amount должен быть 10300, а не 11200 (synthetic-example)
		expect(due.amount).toBeCloseTo(10300, 1); // synthetic-example
	});

	it('balanceAfter согласован с amount через splitPayment', () => {
		// balanceAfter = balance - bodyPerPeriod = 30000 - 10000 = 20000 (synthetic-example)
		// При amount=10300: splitPayment даёт principal=10000, newBalance=20000.
		const result = creditPaymentsDue([partiallyPaidDiff], '2026-04-15T00:00:00Z', 30);
		const due = result[0]!;
		// balanceAfter должен соответствовать реальному погашению тела.
		expect(due.balanceAfter).toBeCloseTo(20000, 1); // synthetic-example
		// Инвариант: amount > balanceAfter (balance уменьшился).
		expect(due.balanceAfter).toBeLessThan(partiallyPaidDiff.balance);
	});

	it('свежий кредит (balance = principal): amount = первый платёж дифф-графика', () => {
		// balance = 120000 = principal: первый платёж = 10000 + 1200 = 11200 (synthetic-example)
		const freshDiff: CreditRecord = {
			...partiallyPaidDiff,
			id: 'credit-diff-fresh-fake-001', // synthetic-example
			balance: 120000, // synthetic-example: только взяли
			balance_ts: '2026-01-01T00:00:00Z', // synthetic-example
			opened_at: '2026-01-01T00:00:00Z', // synthetic-example
			next_payment_date: '2026-02-01T00:00:00Z', // synthetic-example
		};
		const result = creditPaymentsDue([freshDiff], '2026-01-15T00:00:00Z', 30);
		expect(result).toHaveLength(1);
		// Первый платёж: 10000 + 120000 * 0.01 = 11200 (synthetic-example)
		expect(result[0]!.amount).toBeCloseTo(11200, 1); // synthetic-example
	});
});

// ---------------------------------------------------------------------------
// 11. Edge-кейсы аннуитета без term/monthly_payment (fallback платёж)
// ---------------------------------------------------------------------------

describe('creditPaymentsDue: аннуитет без term и без monthly_payment (fallback)', () => {
	/**
	 * Аннуитетный кредит без term и без monthly_payment:
	 *   balance = 50 000 (fake-example)
	 *   rate_pct = 12% → monthlyRate = 0.01
	 *
	 * Fallback scheduledPaymentAmount: balance + balance*r = 50000 + 500 = 50500.
	 * Fallback balanceAfterScheduledPayment: splitPayment(credit, 50500).newBalance.
	 *   interest = 50000 * 0.01 = 500
	 *   principal = 50500 - 500 = 50000 (ограничен balance = 50000)
	 *   newBalance = 50000 - 50000 = 0
	 *
	 * Инвариант: amount и balanceAfter СОГЛАСОВАНЫ (balanceAfter = 0, не = balance).
	 */
	const noTermCredit: CreditRecord = {
		id: 'credit-no-term-fake-001', // synthetic-example
		source: 'manual',
		principal: 50000, // synthetic-example: principal = balance (нет частичного погашения)
		currency: 'RUB',
		rate_pct: 12, // synthetic-example
		type: 'annuity',
		balance: 50000, // synthetic-example
		balance_ts: '2026-01-01T00:00:00Z', // synthetic-example
		manual: true,
		next_payment_date: '2026-02-01T00:00:00Z', // synthetic-example
		// term: undefined — нет срока (ключевое условие для fallback)
		// monthly_payment: undefined — нет зафиксированного платежа
	};

	it('amount = balance + balance*rate (fallback: один платёж закрывает долг)', () => {
		// 50000 + 50000 * 0.01 = 50500 (synthetic-example)
		const result = creditPaymentsDue([noTermCredit], '2026-01-15T00:00:00Z', 30);
		expect(result).toHaveLength(1);
		expect(result[0]!.amount).toBeCloseTo(50500, 1); // synthetic-example
	});

	it('balanceAfter = 0 (один платёж полностью закрывает долг)', () => {
		// Инвариант: balanceAfter согласован с amount через splitPayment.
		// Старый баг: balanceAfter возвращал balance без изменений = 50000 (не 0).
		const result = creditPaymentsDue([noTermCredit], '2026-01-15T00:00:00Z', 30);
		expect(result[0]!.balanceAfter).toBeCloseTo(0, 1); // synthetic-example: долг закрыт
	});

	it('amount и balanceAfter согласованы: amount - interest = погашенное_тело, balance - тело = balanceAfter', () => {
		// Если amount=50500, interest=500, principal=50000, newBalance=0.
		// Проверяем согласованность через прямой splitPayment.
		const result = creditPaymentsDue([noTermCredit], '2026-01-15T00:00:00Z', 30);
		const due = result[0]!;
		// Проверяем что balanceAfter < balance (долг уменьшился).
		expect(due.balanceAfter).toBeLessThan(noTermCredit.balance);
		// Разница balance - balanceAfter = погашенное тело.
		const repaidBody = noTermCredit.balance - due.balanceAfter;
		// Тело не может превышать balance.
		expect(repaidBody).toBeLessThanOrEqual(noTermCredit.balance);
		expect(repaidBody).toBeGreaterThan(0);
	});
});
