/**
 * credit-payment.test.ts — тесты recordCreditPayment.
 *
 * Проверяем:
 *   1. Разбивка тело/проценты через splitPayment.
 *   2. Новый снапшот кредита (balance убыл, прошлый снапшот цел — append-only).
 *   3. Сдвиг next_payment_date на 1 период (addMonthsToIso).
 *   4. Round-trip с temp-dir + path-guard.
 *   5. Ошибки: кредит не найден, уже погашен.
 *
 * Инварианты:
 *   - Только синтетические/фейковые данные (synthetic-example) — lint:public зелёный.
 *   - Мок nowFn через инъекцию.
 *   - Temp-dir для леджера + path-guard с фейковым publicRepoRoot.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Ledger } from './ledger.js';
import type { CreditRecord } from './types.js';
import { recordCreditPayment } from './credit-payment.js';
import { splitPayment } from './credit.js';

// ---------------------------------------------------------------------------
// Синтетические данные для тестов (БЕЗ реальных данных)
// ---------------------------------------------------------------------------

/** Синтетический аннуитетный кредит для тестов. */
const SYNTHETIC_CREDIT: CreditRecord = {
	id: 'synthetic-credit-001',
	source: 'manual',
	principal: 100_000,
	currency: 'RUB',
	rate_pct: 12, // 12% годовых = 1% в месяц
	balance: 80_000, // остаток 80 000 RUB
	balance_ts: '2026-01-01T00:00:00Z',
	manual: true,
	monthly_payment: 2_000, // плановый платёж
	next_payment_date: '2026-07-01T00:00:00Z',
	type: 'annuity',
	term: 60,
};

/** Синтетический кредит без monthly_payment (auto = balance + проценты). */
const SYNTHETIC_CREDIT_NO_MONTHLY: CreditRecord = {
	id: 'synthetic-credit-002',
	source: 'manual',
	principal: 50_000,
	currency: 'USD',
	rate_pct: 24, // 24% годовых = 2% в месяц
	balance: 10_000,
	balance_ts: '2026-01-01T00:00:00Z',
	manual: true,
	// monthly_payment НЕ задан
	next_payment_date: '2026-07-01T00:00:00Z',
};

// ---------------------------------------------------------------------------
// Фикстуры
// ---------------------------------------------------------------------------

let ledgerDir: string;
let publicFakeDir: string;
let ledger: Ledger;

beforeEach(() => {
	// Создаём изолированный temp-dir для каждого теста.
	ledgerDir = mkdtempSync(join(tmpdir(), 'credit-payment-test-'));
	publicFakeDir = mkdtempSync(join(tmpdir(), 'fake-public-'));
	ledger = new Ledger({ financeDir: ledgerDir, publicRepoRoot: publicFakeDir });
});

afterEach(() => {
	rmSync(ledgerDir, { recursive: true, force: true });
	rmSync(publicFakeDir, { recursive: true, force: true });
});

// Фиксированное время для тестов (инъекция).
const fixedNow = new Date('2026-06-23T10:00:00Z');
const nowFn = () => fixedNow;

// ---------------------------------------------------------------------------
// Тесты: основная логика
// ---------------------------------------------------------------------------

describe('recordCreditPayment — разбивка тело/проценты', () => {
	it('разбивает платёж на тело и проценты корректно (сравниваем с splitPayment)', () => {
		// Записываем синтетический кредит в леджер.
		ledger.append('credits', SYNTHETIC_CREDIT);

		const result = recordCreditPayment('synthetic-credit-001', 2_000, { ledger, nowFn });

		// Сравниваем с чистой функцией splitPayment (эталон).
		const expected = splitPayment(SYNTHETIC_CREDIT, 2_000);

		expect(result.principal).toBeCloseTo(expected.principal, 5);
		expect(result.interest).toBeCloseTo(expected.interest, 5);
		expect(result.newBalance).toBeCloseTo(expected.newBalance, 5);
		expect(result.paymentAmount).toBe(2_000);
		expect(result.currency).toBe('RUB');
	});

	it('проценты = balance * monthlyRate = 80000 * 0.01 = 800 RUB', () => {
		ledger.append('credits', SYNTHETIC_CREDIT);

		const result = recordCreditPayment('synthetic-credit-001', 2_000, { ledger, nowFn });

		// monthlyRate = 12% / 12 / 100 = 0.01
		// interest = 80000 * 0.01 = 800
		// principal = 2000 - 800 = 1200
		// newBalance = 80000 - 1200 = 78800
		expect(result.interest).toBeCloseTo(800, 2);
		expect(result.principal).toBeCloseTo(1200, 2);
		expect(result.newBalance).toBeCloseTo(78_800, 2);
	});
});

describe('recordCreditPayment — новый снапшот кредита (append-only)', () => {
	it('старый снапшот сохранён, новый добавлен (баланс убыл)', () => {
		ledger.append('credits', SYNTHETIC_CREDIT);

		// Перед платежом: один снапшот.
		const beforeCredits = ledger.readAll('credits');
		expect(beforeCredits).toHaveLength(1);
		expect(beforeCredits[0]!.balance).toBe(80_000);

		recordCreditPayment('synthetic-credit-001', 2_000, { ledger, nowFn });

		// После платежа: два снапшота (прошлый цел + новый).
		const afterCredits = ledger.readAll('credits');
		expect(afterCredits).toHaveLength(2);

		// Старый снапшот НЕ изменился.
		const oldSnap = afterCredits[0]!;
		expect(oldSnap.balance).toBe(80_000);
		expect(oldSnap.balance_ts).toBe('2026-01-01T00:00:00Z');

		// Новый снапшот с обновлённым балансом.
		const newSnap = afterCredits[1]!;
		expect(newSnap.balance).toBeCloseTo(78_800, 2);
		expect(newSnap.balance_ts).toBe('2026-06-23T10:00:00Z');
	});

	it('возвращает prevBalance = 80000 (до платежа)', () => {
		ledger.append('credits', SYNTHETIC_CREDIT);
		const result = recordCreditPayment('synthetic-credit-001', 2_000, { ledger, nowFn });
		expect(result.prevBalance).toBe(80_000);
	});

	it('credit_id в результате совпадает с id кредита', () => {
		ledger.append('credits', SYNTHETIC_CREDIT);
		const result = recordCreditPayment('synthetic-credit-001', 2_000, { ledger, nowFn });
		expect(result.credit_id).toBe('synthetic-credit-001');
	});
});

describe('recordCreditPayment — сдвиг next_payment_date', () => {
	it('сдвигает next_payment_date на 1 месяц (addMonthsToIso)', () => {
		ledger.append('credits', SYNTHETIC_CREDIT);

		// Исходная дата: 2026-07-01.
		const result = recordCreditPayment('synthetic-credit-001', 2_000, { ledger, nowFn });

		// После сдвига: 2026-08-01.
		expect(result.nextPaymentDate.startsWith('2026-08-01')).toBe(true);
	});

	it('новый CreditRecord содержит обновлённую next_payment_date', () => {
		ledger.append('credits', SYNTHETIC_CREDIT);

		recordCreditPayment('synthetic-credit-001', 2_000, { ledger, nowFn });

		const allCredits = ledger.readAll('credits');
		const newSnap = allCredits.at(-1)!;
		expect(newSnap.next_payment_date?.startsWith('2026-08-01')).toBe(true);
	});

	it('когда next_payment_date не задана — вычисляет от nowTs', () => {
		const creditNoDate: CreditRecord = {
			...SYNTHETIC_CREDIT,
			id: 'synthetic-credit-no-date',
			next_payment_date: undefined, // специально убираем
		};
		ledger.append('credits', creditNoDate);

		const result = recordCreditPayment('synthetic-credit-no-date', 2_000, { ledger, nowFn });

		// nowTs = 2026-06-23, +1 мес = 2026-07-23.
		expect(result.nextPaymentDate.startsWith('2026-07-23')).toBe(true);
	});
});

describe('recordCreditPayment — mode auto', () => {
	it("'auto' берёт monthly_payment = 2000", () => {
		ledger.append('credits', SYNTHETIC_CREDIT);

		const result = recordCreditPayment('synthetic-credit-001', 'auto', { ledger, nowFn });
		expect(result.paymentAmount).toBe(2_000);
	});

	it("'auto' без monthly_payment = balance + interest", () => {
		ledger.append('credits', SYNTHETIC_CREDIT_NO_MONTHLY);

		const result = recordCreditPayment('synthetic-credit-002', 'auto', { ledger, nowFn });

		// balance = 10000, rate_pct = 24 → monthlyRate = 24/12/100 = 0.02
		// auto = balance + balance * monthlyRate = 10000 + 200 = 10200
		expect(result.paymentAmount).toBeCloseTo(10_200, 2);
	});
});

describe('recordCreditPayment — транзакция в леджере', () => {
	it('записывает транзакцию credit_payment в transactions.jsonl', () => {
		ledger.append('credits', SYNTHETIC_CREDIT);

		const result = recordCreditPayment('synthetic-credit-001', 2_000, { ledger, nowFn });

		const transactions = ledger.readAll('transactions');
		expect(transactions).toHaveLength(1);

		const tx = transactions[0]!;
		expect(tx.id).toBe(result.txId);
		expect(tx.amount).toBe(2_000);
		expect(tx.currency).toBe('RUB');
		expect(tx.direction).toBe('out');
		expect(tx.category).toBe('credit_payment');
		expect(tx.ts).toBe('2026-06-23T10:00:00Z');
	});

	it('txId детерминирован: повторный вызов с теми же данными и временем = тот же id', () => {
		ledger.append('credits', SYNTHETIC_CREDIT);

		// Первый вызов.
		const r1 = recordCreditPayment('synthetic-credit-001', 2_000, { ledger, nowFn });
		const txId1 = r1.txId;

		// Для второго вызова нужен новый кредит (первый уже погашен на 1200).
		// Создаём новый ledger с тем же кредитом, но другим id.
		const ledger2 = new Ledger({ financeDir: mkdtempSync(join(tmpdir(), 'credit-tx-test-')), publicRepoRoot: publicFakeDir });
		const creditCopy: CreditRecord = { ...SYNTHETIC_CREDIT, id: 'synthetic-credit-001' };
		ledger2.append('credits', creditCopy);

		const r2 = recordCreditPayment('synthetic-credit-001', 2_000, {
			ledger: ledger2,
			nowFn, // тот же nowFn → тот же ts → тот же id
		});

		expect(r2.txId).toBe(txId1);
		// Cleanup
		rmSync((ledger2 as unknown as { financeDir: string }).financeDir, { recursive: true, force: true });
	});
});

describe('recordCreditPayment — ошибки', () => {
	it('бросает Error если кредит не найден', () => {
		// Леджер пуст — кредита нет.
		expect(() =>
			recordCreditPayment('nonexistent-credit', 1_000, { ledger, nowFn }),
		).toThrow(/не найден/);
	});

	it('бросает Error если кредит уже погашен (balance = 0)', () => {
		const paidCredit: CreditRecord = { ...SYNTHETIC_CREDIT, balance: 0 };
		ledger.append('credits', paidCredit);

		expect(() =>
			recordCreditPayment('synthetic-credit-001', 1_000, { ledger, nowFn }),
		).toThrow(/погашен/);
	});

	it('бросает Error если paymentAmount <= 0', () => {
		ledger.append('credits', SYNTHETIC_CREDIT);

		expect(() =>
			recordCreditPayment('synthetic-credit-001', 0, { ledger, nowFn }),
		).toThrow(/> 0/);

		expect(() =>
			recordCreditPayment('synthetic-credit-001', -500, { ledger, nowFn }),
		).toThrow(/> 0/);
	});
});

describe('recordCreditPayment — path-guard', () => {
	it('path-guard: запись в допустимый каталог не бросает (round-trip)', () => {
		ledger.append('credits', SYNTHETIC_CREDIT);

		// Не должен бросить LedgerPathError.
		expect(() =>
			recordCreditPayment('synthetic-credit-001', 2_000, { ledger, nowFn }),
		).not.toThrow();

		// И транзакция записана.
		expect(ledger.readAll('transactions')).toHaveLength(1);
	});

	it('path-guard: Ledger с неверным publicRepoRoot бросает LedgerPathError при записи транзакции', () => {
		// Сначала записываем кредит в ХОРОШИЙ ledger (нормальный publicRepoRoot).
		ledger.append('credits', SYNTHETIC_CREDIT);

		// Создаём ledger2 с тем же financeDir, но с publicRepoRoot = ledgerDir → запись ЗАПРЕЩЕНА.
		const badLedger = new Ledger({
			financeDir: ledgerDir,
			publicRepoRoot: ledgerDir, // ← financeDir совпадает с publicRepoRoot → LedgerPathError
		});
		// Кредит уже записан в ledgerDir (goodLedger), badLedger может его прочитать.
		// Но при попытке записать транзакцию → path-guard бросает LedgerPathError.

		let thrownName = '';
		try {
			recordCreditPayment('synthetic-credit-001', 2_000, { ledger: badLedger, nowFn });
		} catch (e) {
			thrownName = (e as Error).name ?? '';
		}
		expect(thrownName).toBe('LedgerPathError');
	});
});
