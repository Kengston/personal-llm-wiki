/**
 * networth.test.ts — тесты функции computeNetWorth.
 *
 * Принципы (как в finance.test.ts):
 *   - Все данные СИНТЕТИЧЕСКИЕ: fake-example, нет PII, нет реальных счетов/сумм.
 *   - Нет реальной сети: FxProvider полностью мокируется.
 *   - Нет IO: computeNetWorth — чистая функция, принимает массивы напрямую.
 *   - lint:public остаётся зелёным: нет хардкода API-ключей/токенов.
 *
 * Покрытие:
 *   1. perCurrency — сырые суммы без конвертации (активы − обязательства).
 *   2. totalsByDisplayCurrency — мультивалютный ролл-ап через мок FX.
 *   3. Вычитание кредитов-обязательств из net worth.
 *   4. breakdownByKind — разбивка активов по типу счёта.
 *   5. Недостающий FX-курс → unconvertible, не NaN/не throw.
 *   6. Несколько снапшотов одного счёта — берётся последний ≤ asOf.
 *   7. Снапшоты после asOf игнорируются.
 *   8. Кредиты с balance_ts после asOf игнорируются.
 *   9. Пустые входные данные → нулевой результат без ошибок.
 */

import { describe, expect, it } from 'vitest';

import type { FxProvider } from './fx.js';
import { computeNetWorth } from './networth.js';
import type { AccountRecord, CreditRecord, SnapshotRecord } from './types.js';

// ---------------------------------------------------------------------------
// Вспомогательные фабрики синтетических фикстур
// ---------------------------------------------------------------------------

/**
 * fakeAccount — создаёт синтетическую AccountRecord (fake-example).
 * Поля id/name не содержат PII — только описание счёта.
 */
function fakeAccount(
	id: string,
	kind: AccountRecord['kind'],
	currency: string,
): AccountRecord {
	return {
		id,
		source: 'fake-source', // synthetic-example
		kind,
		name: `Fake Account ${id}`, // synthetic-example
		currency,
	};
}

/**
 * fakeSnapshot — создаёт синтетическую SnapshotRecord (fake-example).
 */
function fakeSnapshot(
	accountId: string,
	balance: number,
	currency: string,
	ts: string,
): SnapshotRecord {
	return {
		ts,
		account_id: accountId,
		balance,
		currency,
	};
}

/**
 * fakeCredit — создаёт синтетическую CreditRecord (fake-example).
 * Суммы и даты выдуманы — synthetic-example.
 */
function fakeCredit(
	id: string,
	balance: number,
	currency: string,
	balanceTs: string,
): CreditRecord {
	return {
		id,
		source: 'manual', // synthetic-example
		principal: balance + 1, // synthetic — principal > balance
		currency,
		balance,
		balance_ts: balanceTs,
		manual: true,
	};
}

// ---------------------------------------------------------------------------
// Мок-провайдер FX с таблицей курсов
// ---------------------------------------------------------------------------

/**
 * TableFxProvider — синтетический FxProvider для тестов.
 *
 * Принимает заранее заданную таблицу курсов. Поддерживает обратные курсы
 * (если base→quote задан, то quote→base = 1/rate). Для тождественных пар X→X = 1.
 * При отсутствии в таблице — возвращает null (грациозно).
 */
class TableFxProvider implements FxProvider {
	/**
	 * Таблица курсов: "BASE/QUOTE" → rate.
	 * Все пары в UPPERCASE.
	 */
	private readonly table: Map<string, number>;

	constructor(rates: Record<string, number>) {
		this.table = new Map(
			Object.entries(rates).map(([key, val]) => [key.toUpperCase(), val]),
		);
	}

	async rate(base: string, quote: string, _atTsISO: string): Promise<number | null> {
		const b = base.toUpperCase();
		const q = quote.toUpperCase();

		// Тождественное: X→X = 1.
		if (b === q) return 1;

		// Прямой курс из таблицы.
		const directKey = `${b}/${q}`;
		if (this.table.has(directKey)) {
			return this.table.get(directKey)!;
		}

		// Обратный курс: если задан Q/B, возвращаем 1/(Q/B) = B/Q.
		const reverseKey = `${q}/${b}`;
		if (this.table.has(reverseKey)) {
			const rev = this.table.get(reverseKey)!;
			if (rev === 0) return null; // защита от деления на 0
			return 1 / rev;
		}

		// Курс не найден — грациозно возвращаем null.
		return null;
	}
}

/**
 * NullFxProvider — провайдер, который всегда возвращает null.
 * Используется для тестирования грациозной обработки недостающих курсов.
 */
class NullFxProvider implements FxProvider {
	async rate(_base: string, _quote: string, _atTsISO: string): Promise<number | null> {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Синтетические фикстуры (все данные fake-example)
// ---------------------------------------------------------------------------

/**
 * Метка времени «сейчас» для тестов — synthetic-example.
 * Все даты в прошлом относительно реального запуска тестов.
 */
const AS_OF = '2026-06-01T12:00:00Z'; // synthetic-example

/**
 * Синтетические счета (fake-example):
 *   - acc-usd   : exchange, USD
 *   - acc-rub   : bank, RUB
 *   - acc-usdt  : exchange, USDT
 *   - acc-cash  : cash, RUB
 *   - acc-saving: savings, RUB
 */
const ACC_USD = fakeAccount('acc-usd', 'exchange', 'USD');
const ACC_RUB = fakeAccount('acc-rub', 'bank', 'RUB');
const ACC_USDT = fakeAccount('acc-usdt', 'exchange', 'USDT');
const ACC_CASH = fakeAccount('acc-cash', 'cash', 'RUB');
const ACC_SAVING = fakeAccount('acc-saving', 'savings', 'RUB');

/**
 * Синтетические курсы для TableFxProvider (fake-example, не реальные):
 *   USD → RUB = 90    (synthetic)
 *   USDT → USD = 1    (стейблкоин)
 *   GEL → RUB = 33    (synthetic)
 */
const FAKE_FX_TABLE = {
	'USD/RUB': 90.0, // synthetic-example
	'USDT/USD': 1.0, // стейблкоин
	'GEL/RUB': 33.0, // synthetic-example
};

// ---------------------------------------------------------------------------
// 1. perCurrency — сырые суммы без конвертации
// ---------------------------------------------------------------------------

describe('computeNetWorth: perCurrency (сырые суммы)', () => {
	it('один счёт — perCurrency содержит его валюту и баланс', async () => {
		const snapshots = [
			fakeSnapshot('acc-usd', 1500.0, 'USD', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		const result = await computeNetWorth(
			snapshots,
			[],
			AS_OF,
			['RUB'],
			new TableFxProvider(FAKE_FX_TABLE),
			[ACC_USD],
		);

		expect(result.perCurrency['USD']).toBeCloseTo(1500.0); // synthetic-example
	});

	it('несколько счетов в разных валютах — perCurrency содержит все', async () => {
		const snapshots = [
			fakeSnapshot('acc-usd', 1000.0, 'USD', '2026-05-30T10:00:00Z'), // synthetic-example
			fakeSnapshot('acc-rub', 50000.0, 'RUB', '2026-05-30T10:00:00Z'), // synthetic-example
			fakeSnapshot('acc-usdt', 200.0, 'USDT', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		const result = await computeNetWorth(
			snapshots,
			[],
			AS_OF,
			['RUB'],
			new TableFxProvider(FAKE_FX_TABLE),
			[ACC_USD, ACC_RUB, ACC_USDT],
		);

		expect(result.perCurrency['USD']).toBeCloseTo(1000.0); // synthetic-example
		expect(result.perCurrency['RUB']).toBeCloseTo(50000.0); // synthetic-example
		expect(result.perCurrency['USDT']).toBeCloseTo(200.0); // synthetic-example
	});

	it('кредит вычитается из perCurrency той же валюты', async () => {
		// Актив: 10000 RUB на банковском счёте.
		// Обязательство: кредит 3000 RUB.
		// Нетто: 7000 RUB.
		const snapshots = [
			fakeSnapshot('acc-rub', 10000.0, 'RUB', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		const credits = [
			fakeCredit('credit-fake-001', 3000.0, 'RUB', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		const result = await computeNetWorth(
			snapshots,
			credits,
			AS_OF,
			['RUB'],
			new TableFxProvider(FAKE_FX_TABLE),
			[ACC_RUB],
		);

		// perCurrency[RUB] = 10000 - 3000 = 7000.
		expect(result.perCurrency['RUB']).toBeCloseTo(7000.0); // synthetic-example
	});

	it('кредит в другой валюте от счёта — обе валюты в perCurrency', async () => {
		// Актив: 500 USD.
		// Обязательство: кредит 100000 RUB (другая валюта).
		const snapshots = [
			fakeSnapshot('acc-usd', 500.0, 'USD', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		const credits = [
			fakeCredit('credit-fake-002', 100000.0, 'RUB', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		const result = await computeNetWorth(
			snapshots,
			credits,
			AS_OF,
			['RUB'],
			new TableFxProvider(FAKE_FX_TABLE),
			[ACC_USD],
		);

		expect(result.perCurrency['USD']).toBeCloseTo(500.0); // synthetic-example
		expect(result.perCurrency['RUB']).toBeCloseTo(-100000.0); // synthetic-example (чистый долг)
	});

	it('пустые входы — perCurrency пустой, нет ошибок', async () => {
		const result = await computeNetWorth(
			[],
			[],
			AS_OF,
			['RUB', 'USD'],
			new TableFxProvider(FAKE_FX_TABLE),
		);

		expect(result.perCurrency).toEqual({});
		expect(result.unconvertible).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 2. totalsByDisplayCurrency — ролл-ап в отображаемые валюты
// ---------------------------------------------------------------------------

describe('computeNetWorth: totalsByDisplayCurrency (мультивалютный ролл-ап)', () => {
	it('один актив USD → конвертируется в RUB по курсу', async () => {
		// 500 USD × 90 RUB/USD = 45 000 RUB (synthetic-example).
		const snapshots = [
			fakeSnapshot('acc-usd', 500.0, 'USD', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		const result = await computeNetWorth(
			snapshots,
			[],
			AS_OF,
			['RUB'],
			new TableFxProvider(FAKE_FX_TABLE),
			[ACC_USD],
		);

		expect(result.totalsByDisplayCurrency['RUB']).toBeCloseTo(45000.0); // 500 × 90
	});

	it('два счёта в разных валютах → суммируются в одну displayCurrency', async () => {
		// 300 USD × 90 = 27 000 RUB
		// + 50 000 RUB × 1 = 50 000 RUB
		// итого: 77 000 RUB (synthetic-example).
		const snapshots = [
			fakeSnapshot('acc-usd', 300.0, 'USD', '2026-05-30T10:00:00Z'), // synthetic-example
			fakeSnapshot('acc-rub', 50000.0, 'RUB', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		const result = await computeNetWorth(
			snapshots,
			[],
			AS_OF,
			['RUB'],
			new TableFxProvider(FAKE_FX_TABLE),
			[ACC_USD, ACC_RUB],
		);

		// 300 × 90 + 50000 = 77 000.
		expect(result.totalsByDisplayCurrency['RUB']).toBeCloseTo(77000.0); // synthetic-example
	});

	it('ролл-ап в НАБОР валют (несколько displayCurrencies)', async () => {
		// Актив: 1000 USD.
		// displayCurrencies: ["RUB", "USD"].
		// RUB: 1000 × 90 = 90 000.
		// USD: 1000 × 1 = 1000 (identity).
		const snapshots = [
			fakeSnapshot('acc-usd', 1000.0, 'USD', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		const result = await computeNetWorth(
			snapshots,
			[],
			AS_OF,
			['RUB', 'USD'],
			new TableFxProvider(FAKE_FX_TABLE),
			[ACC_USD],
		);

		expect(result.totalsByDisplayCurrency['RUB']).toBeCloseTo(90000.0); // synthetic-example
		expect(result.totalsByDisplayCurrency['USD']).toBeCloseTo(1000.0); // synthetic-example
	});

	it('кредит уменьшает totalsByDisplayCurrency', async () => {
		// Актив: 1000 USD (= 90 000 RUB).
		// Обязательство: кредит 30 000 RUB.
		// Нетто в RUB: 90 000 - 30 000 = 60 000 RUB (synthetic-example).
		const snapshots = [
			fakeSnapshot('acc-usd', 1000.0, 'USD', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		const credits = [
			fakeCredit('credit-fake-003', 30000.0, 'RUB', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		const result = await computeNetWorth(
			snapshots,
			credits,
			AS_OF,
			['RUB'],
			new TableFxProvider(FAKE_FX_TABLE),
			[ACC_USD],
		);

		// 1000 × 90 - 30 000 = 60 000.
		expect(result.totalsByDisplayCurrency['RUB']).toBeCloseTo(60000.0); // synthetic-example
	});

	it('USDT конвертируется через USD → RUB (кросс-курс через таблицу)', async () => {
		// 200 USDT → (USDT/USD=1) → (USD/RUB=90) → 200 × 1 × 90 = 18 000 RUB.
		// Но TableFxProvider ищет USDT/RUB напрямую — нет в таблице.
		// Нужно добавить прямой USDT/RUB или USDT/USD + USD/RUB.
		// Для простоты добавляем USDT/RUB = 90 в таблицу.
		const fxWithUsdtRub = new TableFxProvider({
			...FAKE_FX_TABLE,
			'USDT/RUB': 90.0, // synthetic-example: USDT ≈ USD
		});
		const snapshots = [
			fakeSnapshot('acc-usdt', 200.0, 'USDT', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		const result = await computeNetWorth(
			snapshots,
			[],
			AS_OF,
			['RUB'],
			fxWithUsdtRub,
			[ACC_USDT],
		);

		expect(result.totalsByDisplayCurrency['RUB']).toBeCloseTo(18000.0); // 200 × 90
	});
});

// ---------------------------------------------------------------------------
// 3. breakdownByKind — разбивка активов по типу счёта
// ---------------------------------------------------------------------------

describe('computeNetWorth: breakdownByKind (разбивка по kind)', () => {
	it('счёт cash — попадает в breakdownByKind["cash"]', async () => {
		const snapshots = [
			fakeSnapshot('acc-cash', 5000.0, 'RUB', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		const result = await computeNetWorth(
			snapshots,
			[],
			AS_OF,
			['RUB'],
			new TableFxProvider(FAKE_FX_TABLE),
			[ACC_CASH],
		);

		const cashKind = result.breakdownByKind['cash'];
		expect(cashKind).toBeDefined();
		expect(cashKind?.['RUB']).toBeCloseTo(5000.0); // synthetic-example
	});

	it('разные kind — разделяются в breakdownByKind', async () => {
		// cash: 5000 RUB, bank: 20000 RUB, exchange: 100 USD (synthetic-example).
		const snapshots = [
			fakeSnapshot('acc-cash', 5000.0, 'RUB', '2026-05-30T10:00:00Z'), // synthetic-example
			fakeSnapshot('acc-rub', 20000.0, 'RUB', '2026-05-30T10:00:00Z'), // synthetic-example
			fakeSnapshot('acc-usd', 100.0, 'USD', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		const result = await computeNetWorth(
			snapshots,
			[],
			AS_OF,
			['RUB'],
			new TableFxProvider(FAKE_FX_TABLE),
			[ACC_CASH, ACC_RUB, ACC_USD],
		);

		// cash: 5000 RUB.
		expect(result.breakdownByKind['cash']?.['RUB']).toBeCloseTo(5000.0); // synthetic-example
		// bank: 20000 RUB.
		expect(result.breakdownByKind['bank']?.['RUB']).toBeCloseTo(20000.0); // synthetic-example
		// exchange: 100 USD.
		expect(result.breakdownByKind['exchange']?.['USD']).toBeCloseTo(100.0); // synthetic-example
	});

	it('savings отдельно от bank в breakdownByKind', async () => {
		const snapshots = [
			fakeSnapshot('acc-saving', 100000.0, 'RUB', '2026-05-30T10:00:00Z'), // synthetic-example
			fakeSnapshot('acc-rub', 25000.0, 'RUB', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		const result = await computeNetWorth(
			snapshots,
			[],
			AS_OF,
			['RUB'],
			new TableFxProvider(FAKE_FX_TABLE),
			[ACC_SAVING, ACC_RUB],
		);

		// savings и bank — разные ключи.
		expect(result.breakdownByKind['savings']).toBeDefined();
		expect(result.breakdownByKind['bank']).toBeDefined();
		expect(result.breakdownByKind['savings']?.['RUB']).toBeCloseTo(100000.0); // synthetic-example
		expect(result.breakdownByKind['bank']?.['RUB']).toBeCloseTo(25000.0); // synthetic-example
	});

	it('кредиты не попадают в breakdownByKind (только активы)', async () => {
		const snapshots = [
			fakeSnapshot('acc-rub', 50000.0, 'RUB', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		const credits = [
			fakeCredit('credit-fake-004', 20000.0, 'RUB', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		const result = await computeNetWorth(
			snapshots,
			credits,
			AS_OF,
			['RUB'],
			new TableFxProvider(FAKE_FX_TABLE),
			[ACC_RUB],
		);

		// breakdownByKind должен содержать только активы (50000 RUB).
		// НЕТ ключа 'loan' или минусовых сумм.
		expect(result.breakdownByKind['bank']?.['RUB']).toBeCloseTo(50000.0); // synthetic-example
		// loan не появляется как отдельный kind (кредиты учтены через CreditRecord, не AccountRecord).
		expect(result.breakdownByKind['loan']).toBeUndefined();
	});

	it('снапшот без AccountRecord → kind = "unknown"', async () => {
		const snapshots = [
			fakeSnapshot('acc-unknown-999', 7777.0, 'USD', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		// accounts не передаём — AccountRecord для этого id не будет найден.
		const result = await computeNetWorth(
			snapshots,
			[],
			AS_OF,
			['USD'],
			new TableFxProvider(FAKE_FX_TABLE),
			[], // пустой список accounts
		);

		// Должен создать kind = 'unknown'.
		expect(result.breakdownByKind['unknown']).toBeDefined();
		expect(result.breakdownByKind['unknown']?.['USD']).toBeCloseTo(7777.0); // synthetic-example
	});
});

// ---------------------------------------------------------------------------
// 4. Выбор последнего снапшота ≤ asOf
// ---------------------------------------------------------------------------

describe('computeNetWorth: выбор последнего снапшота ≤ asOf', () => {
	it('несколько снапшотов одного счёта → берётся последний ≤ asOf', async () => {
		// Три снапшота для одного счёта — нужен последний по ts ≤ asOf.
		// asOf = 2026-06-01T12:00:00Z.
		const snapshots = [
			fakeSnapshot('acc-rub', 10000.0, 'RUB', '2026-05-01T10:00:00Z'), // synthetic-example
			fakeSnapshot('acc-rub', 20000.0, 'RUB', '2026-05-20T10:00:00Z'), // synthetic-example ← последний ≤ asOf
			fakeSnapshot('acc-rub', 30000.0, 'RUB', '2026-06-02T10:00:00Z'), // ПОСЛЕ asOf — игнорируется
		];
		const result = await computeNetWorth(
			snapshots,
			[],
			AS_OF,
			['RUB'],
			new TableFxProvider(FAKE_FX_TABLE),
			[ACC_RUB],
		);

		// perCurrency должен отражать баланс 20000 (от 2026-05-20), не 30000 (после asOf).
		expect(result.perCurrency['RUB']).toBeCloseTo(20000.0); // synthetic-example
	});

	it('снапшот ровно в момент asOf включается', async () => {
		// ts = asOf → должен включиться (≤ семантика, включительно).
		const snapshots = [
			fakeSnapshot('acc-rub', 15000.0, 'RUB', AS_OF), // synthetic-example
		];
		const result = await computeNetWorth(
			snapshots,
			[],
			AS_OF,
			['RUB'],
			new TableFxProvider(FAKE_FX_TABLE),
			[ACC_RUB],
		);

		expect(result.perCurrency['RUB']).toBeCloseTo(15000.0); // synthetic-example
	});

	it('снапшот строго после asOf полностью игнорируется', async () => {
		// ts > asOf → счёт отсутствует в результате.
		const snapshots = [
			fakeSnapshot('acc-rub', 99999.0, 'RUB', '2026-06-02T00:00:00Z'), // synthetic-example, ПОСЛЕ asOf
		];
		const result = await computeNetWorth(
			snapshots,
			[],
			AS_OF,
			['RUB'],
			new TableFxProvider(FAKE_FX_TABLE),
			[ACC_RUB],
		);

		// Снапшот не должен учитываться — perCurrency пуст.
		expect(result.perCurrency['RUB']).toBeUndefined();
		expect(result.totalsByDisplayCurrency['RUB']).toBeCloseTo(0); // synthetic-example
	});

	it('несколько счетов — каждый берёт свой последний снапшот', async () => {
		// acc-usd последний снапшот: 800 USD (2026-05-25).
		// acc-rub последний снапшот: 30000 RUB (2026-05-28).
		const snapshots = [
			fakeSnapshot('acc-usd', 500.0, 'USD', '2026-05-10T10:00:00Z'), // synthetic-example
			fakeSnapshot('acc-usd', 800.0, 'USD', '2026-05-25T10:00:00Z'), // synthetic-example ← последний
			fakeSnapshot('acc-rub', 20000.0, 'RUB', '2026-05-15T10:00:00Z'), // synthetic-example
			fakeSnapshot('acc-rub', 30000.0, 'RUB', '2026-05-28T10:00:00Z'), // synthetic-example ← последний
		];
		const result = await computeNetWorth(
			snapshots,
			[],
			AS_OF,
			['RUB'],
			new TableFxProvider(FAKE_FX_TABLE),
			[ACC_USD, ACC_RUB],
		);

		expect(result.perCurrency['USD']).toBeCloseTo(800.0); // synthetic-example
		expect(result.perCurrency['RUB']).toBeCloseTo(30000.0); // synthetic-example
	});
});

// ---------------------------------------------------------------------------
// 5. Грациозная обработка недостающих FX-курсов
// ---------------------------------------------------------------------------

describe('computeNetWorth: недостающий FX → unconvertible (не NaN/не throw)', () => {
	it('NullFxProvider → все суммы в unconvertible, total = 0, нет throw', async () => {
		const snapshots = [
			fakeSnapshot('acc-usd', 1000.0, 'USD', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		// NullFxProvider всегда возвращает null.
		const result = await computeNetWorth(
			snapshots,
			[],
			AS_OF,
			['RUB'],
			new NullFxProvider(),
			[ACC_USD],
		);

		// Сумма не конвертирована → unconvertible содержит запись.
		expect(result.unconvertible.length).toBeGreaterThan(0);
		// total = 0 (нет сконвертированных позиций).
		expect(result.totalsByDisplayCurrency['RUB']).toBeCloseTo(0);
		// Нет NaN.
		expect(Number.isNaN(result.totalsByDisplayCurrency['RUB'])).toBe(false);
	});

	it('частичный курс: одна валюта есть, другая нет → частичный total + unconvertible', async () => {
		// 1000 USD — курс к RUB ЕСТЬ (90).
		// 500 GEL — курса GEL/RUB нет в NullFxProvider.
		// Ожидаем: total RUB = 90000, unconvertible = [GEL запись].
		const gelAccount = fakeAccount('acc-gel', 'bank', 'GEL');
		const snapshots = [
			fakeSnapshot('acc-usd', 1000.0, 'USD', '2026-05-30T10:00:00Z'), // synthetic-example
			fakeSnapshot('acc-gel', 500.0, 'GEL', '2026-05-30T10:00:00Z'), // synthetic-example
		];

		// Провайдер: USD/RUB есть, GEL/RUB — нет.
		const partialFx = new TableFxProvider({
			'USD/RUB': 90.0, // synthetic-example
			// GEL/RUB намеренно отсутствует
		});

		const result = await computeNetWorth(
			snapshots,
			[],
			AS_OF,
			['RUB'],
			partialFx,
			[ACC_USD, gelAccount],
		);

		// USD конвертирован: 1000 × 90 = 90 000.
		expect(result.totalsByDisplayCurrency['RUB']).toBeCloseTo(90000.0); // synthetic-example
		// GEL — в unconvertible.
		const gelUnconvertible = result.unconvertible.find(
			(u) => u.nativeCurrency === 'GEL' && u.targetDisplayCurrency === 'RUB',
		);
		expect(gelUnconvertible).toBeDefined();
		expect(gelUnconvertible!.nativeAmount).toBeCloseTo(500.0); // synthetic-example
	});

	it('unconvertible содержит правильные nativeCurrency, nativeAmount, targetDisplayCurrency', async () => {
		const snapshots = [
			fakeSnapshot('acc-usd', 777.0, 'USD', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		// Конвертация USD → USDT отсутствует в NullFxProvider.
		const result = await computeNetWorth(
			snapshots,
			[],
			AS_OF,
			['USDT'],
			new NullFxProvider(),
			[ACC_USD],
		);

		expect(result.unconvertible).toHaveLength(1);
		const firstUnconvertible = result.unconvertible[0];
		expect(firstUnconvertible).toBeDefined();
		expect(firstUnconvertible?.nativeCurrency).toBe('USD');
		expect(firstUnconvertible?.nativeAmount).toBeCloseTo(777.0); // synthetic-example
		expect(firstUnconvertible?.targetDisplayCurrency).toBe('USDT');
	});

	it('нет NaN нигде в результате при полном отсутствии курсов', async () => {
		const snapshots = [
			fakeSnapshot('acc-usd', 500.0, 'USD', '2026-05-30T10:00:00Z'), // synthetic-example
			fakeSnapshot('acc-rub', 10000.0, 'RUB', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		const result = await computeNetWorth(
			snapshots,
			[],
			AS_OF,
			['EUR', 'GBP'],
			new NullFxProvider(),
			[ACC_USD, ACC_RUB],
		);

		// Все totals должны быть конечными числами (не NaN).
		for (const [, total] of Object.entries(result.totalsByDisplayCurrency)) {
			expect(Number.isNaN(total)).toBe(false);
			expect(Number.isFinite(total)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// 6. Кредиты — выбор последнего ≤ asOf
// ---------------------------------------------------------------------------

describe('computeNetWorth: выбор последнего кредита ≤ asOf', () => {
	it('несколько записей кредита → берётся с наибольшим balance_ts ≤ asOf', async () => {
		// Два снапшота кредита: старый 50000, новый 45000 (после частичного погашения).
		// Должен учитываться 45000 (последний).
		const credits = [
			fakeCredit('credit-fake-005', 50000.0, 'RUB', '2026-05-01T10:00:00Z'), // synthetic-example
			fakeCredit('credit-fake-005', 45000.0, 'RUB', '2026-05-25T10:00:00Z'), // synthetic-example ← последний
		];
		const snapshots = [
			fakeSnapshot('acc-rub', 100000.0, 'RUB', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		const result = await computeNetWorth(
			snapshots,
			credits,
			AS_OF,
			['RUB'],
			new TableFxProvider(FAKE_FX_TABLE),
			[ACC_RUB],
		);

		// 100 000 - 45 000 = 55 000.
		expect(result.perCurrency['RUB']).toBeCloseTo(55000.0); // synthetic-example
	});

	it('кредит с balance_ts после asOf игнорируется', async () => {
		// balance_ts > asOf → кредит не учитывается.
		const credits = [
			fakeCredit('credit-fake-006', 80000.0, 'RUB', '2026-06-05T10:00:00Z'), // ПОСЛЕ asOf
		];
		const snapshots = [
			fakeSnapshot('acc-rub', 50000.0, 'RUB', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		const result = await computeNetWorth(
			snapshots,
			credits,
			AS_OF,
			['RUB'],
			new TableFxProvider(FAKE_FX_TABLE),
			[ACC_RUB],
		);

		// Кредит не учтён → perCurrency[RUB] = 50000.
		expect(result.perCurrency['RUB']).toBeCloseTo(50000.0); // synthetic-example
	});
});

// ---------------------------------------------------------------------------
// 7. Смешанный сценарий — полная интеграция
// ---------------------------------------------------------------------------

describe('computeNetWorth: полный сценарий (несколько счетов + кредиты + FX)', () => {
	it('мультивалютный портфель с кредитом → корректный net worth', async () => {
		/**
		 * Синтетический портфель (fake-example, не реальные данные):
		 *   - acc-cash:   10 000 RUB (наличные)
		 *   - acc-rub:    50 000 RUB (банковский счёт)
		 *   - acc-saving: 100 000 RUB (сбережения)
		 *   - acc-usd:    500 USD (биржа)
		 *   - acc-usdt:   200 USDT (биржа)
		 *   - Кредит:     30 000 RUB
		 *
		 * perCurrency ожидаем:
		 *   RUB: 10000 + 50000 + 100000 - 30000 = 130 000
		 *   USD: 500
		 *   USDT: 200
		 *
		 * Курсы (synthetic):
		 *   USD/RUB = 90, USDT/RUB = 90
		 *
		 * totalsByDisplayCurrency["RUB"]:
		 *   130000 + 500 × 90 + 200 × 90 = 130000 + 45000 + 18000 = 193 000 RUB.
		 */
		const fx = new TableFxProvider({
			'USD/RUB': 90.0, // synthetic-example
			'USDT/RUB': 90.0, // synthetic-example
		});
		const snapshots = [
			fakeSnapshot('acc-cash', 10000.0, 'RUB', '2026-05-30T10:00:00Z'), // synthetic-example
			fakeSnapshot('acc-rub', 50000.0, 'RUB', '2026-05-30T10:00:00Z'), // synthetic-example
			fakeSnapshot('acc-saving', 100000.0, 'RUB', '2026-05-30T10:00:00Z'), // synthetic-example
			fakeSnapshot('acc-usd', 500.0, 'USD', '2026-05-30T10:00:00Z'), // synthetic-example
			fakeSnapshot('acc-usdt', 200.0, 'USDT', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		const credits = [
			fakeCredit('credit-fake-007', 30000.0, 'RUB', '2026-05-30T10:00:00Z'), // synthetic-example
		];
		const accounts = [ACC_CASH, ACC_RUB, ACC_SAVING, ACC_USD, ACC_USDT];

		const result = await computeNetWorth(
			snapshots,
			credits,
			AS_OF,
			['RUB'],
			fx,
			accounts,
		);

		// perCurrency.
		expect(result.perCurrency['RUB']).toBeCloseTo(130000.0); // synthetic-example
		expect(result.perCurrency['USD']).toBeCloseTo(500.0); // synthetic-example
		expect(result.perCurrency['USDT']).toBeCloseTo(200.0); // synthetic-example

		// totalsByDisplayCurrency["RUB"] = 130000 + 45000 + 18000 = 193 000.
		expect(result.totalsByDisplayCurrency['RUB']).toBeCloseTo(193000.0); // synthetic-example

		// Нет unconvertible (все курсы есть).
		expect(result.unconvertible).toHaveLength(0);

		// breakdownByKind.
		expect(result.breakdownByKind['cash']?.['RUB']).toBeCloseTo(10000.0); // synthetic-example
		expect(result.breakdownByKind['bank']?.['RUB']).toBeCloseTo(50000.0); // synthetic-example
		expect(result.breakdownByKind['savings']?.['RUB']).toBeCloseTo(100000.0); // synthetic-example
		expect(result.breakdownByKind['exchange']?.['USD']).toBeCloseTo(500.0); // synthetic-example
		expect(result.breakdownByKind['exchange']?.['USDT']).toBeCloseTo(200.0); // synthetic-example
	});
});

// ---------------------------------------------------------------------------
// Edge-кейсы FX курса <= 0 (блокер: неположительный курс → unconvertible)
// ---------------------------------------------------------------------------

/**
 * ZeroFxProvider — мок-провайдер, всегда возвращающий 0 (некорректный нулевой курс).
 * Используется для тестирования гарда fxRate <= 0 в computeNetWorth.
 */
class ZeroFxProvider implements FxProvider {
	async rate(_base: string, _quote: string, _atTsISO: string): Promise<number | null> {
		return 0; // некорректный нулевой курс — должен трактоваться как unconvertible
	}
}

/**
 * NegativeFxProvider — мок-провайдер, всегда возвращающий -90 (отрицательный курс).
 * Используется для тестирования что отрицательный курс не переворачивает знак net worth.
 */
class NegativeFxProvider implements FxProvider {
	constructor(private readonly rate_val: number) {}
	async rate(_base: string, _quote: string, _atTsISO: string): Promise<number | null> {
		return this.rate_val; // отрицательный курс — должен трактоваться как unconvertible
	}
}

describe('computeNetWorth: FX курс <= 0 → unconvertible (не искажает net worth)', () => {
	/**
	 * Синтетический сценарий: счёт USD с балансом 100 USD (fake-example).
	 * Конвертируем в RUB при некорректном курсе.
	 */
	const accountUsd = fakeAccount('acc-test-usd', 'checking', 'USD');
	const snapUsd = fakeSnapshot('acc-test-usd', 100, 'USD', '2026-06-01T00:00:00Z'); // synthetic-example
	const asOf = '2026-06-01T12:00:00Z'; // synthetic-example

	it('нулевой курс (rate=0): позиция → unconvertible, total не искажён (не NaN, не 0)', async () => {
		// До фикса: rate=0 давало total=0 — позиция молча обнулялась.
		// После: rate=0 → unconvertible, total не включает эту позицию.
		const result = await computeNetWorth(
			[snapUsd],
			[],
			asOf,
			['RUB'],
			new ZeroFxProvider(),
			[accountUsd],
		);

		// Позиция USD должна быть в unconvertible, не в total.
		expect(result.unconvertible.length).toBeGreaterThan(0);
		const unconv = result.unconvertible.find((u) => u.nativeCurrency === 'USD');
		expect(unconv).toBeDefined();
		expect(unconv!.nativeAmount).toBeCloseTo(100, 5); // synthetic-example

		// total должен быть 0 (позиция исключена), не искажён некорректным курсом.
		expect(result.totalsByDisplayCurrency['RUB']).toBeCloseTo(0, 5);

		// Нет NaN в total.
		expect(Number.isNaN(result.totalsByDisplayCurrency['RUB'])).toBe(false);
	});

	it('отрицательный курс (rate=-90): позиция → unconvertible, total не переворачивается', async () => {
		// До фикса: rate=-90 давало total = 100 * (-90) = -9000 — перевёрнутый знак капитала.
		// После: rate<0 → unconvertible, total не включает позицию.
		const result = await computeNetWorth(
			[snapUsd],
			[],
			asOf,
			['RUB'],
			new NegativeFxProvider(-90), // synthetic-example: отрицательный курс
			[accountUsd],
		);

		// Позиция USD → unconvertible.
		const unconv = result.unconvertible.find((u) => u.nativeCurrency === 'USD');
		expect(unconv).toBeDefined();

		// total не должен быть отрицательным из-за инверсии курса.
		expect(result.totalsByDisplayCurrency['RUB']).toBeCloseTo(0, 5);
		// Нет NaN.
		expect(Number.isNaN(result.totalsByDisplayCurrency['RUB'])).toBe(false);
	});

	it('нормальный положительный курс (rate=90) конвертируется корректно', async () => {
		// Контрол: корректный курс 90 USD/RUB → 100 * 90 = 9000 (synthetic-example).
		const result = await computeNetWorth(
			[snapUsd],
			[],
			asOf,
			['RUB'],
			new TableFxProvider({ 'USD/RUB': 90 }), // synthetic-example
			[accountUsd],
		);

		expect(result.totalsByDisplayCurrency['RUB']).toBeCloseTo(9000, 1); // synthetic-example
		expect(result.unconvertible).toHaveLength(0);
	});
});
