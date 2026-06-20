/**
 * finance.test.ts — тесты финансового модуля (normalize, ledger, fx).
 *
 * Принципы:
 *   - Все данные синтетические (FAKE ключи, выдуманные балансы, нет PII).
 *   - Нет реальных сетевых запросов: Bybit и CBR API мокаются через fetchFn.
 *   - Тесты идемпотентны: используют mkdtempSync → rmSync после каждого теста.
 *   - lint:public остаётся зелёным: нет захардкоженных API ключей в assigned-form.
 *
 * Покрытие:
 *   1. normalize — мультимонетный wallet-balance + transaction-log → записи леджера.
 *   2. ledger — round-trip append+readAll в tmp-dir.
 *   3. ledger — path-guard: запись в путь публичного репо → LedgerPathError.
 *   4. fx — identity, stablecoin USDT→USD=1, мокнутый CBR USD→RUB, null на неизвестной паре.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BybitWalletBalanceResult, BybitTransactionLogEntry } from './bybit.js';
import {
	CbrFxProvider,
	ChainedFxProvider,
	IdentityFxProvider,
	StablecoinFxProvider,
	createDefaultFxProvider,
} from './fx.js';
import { Ledger, LedgerPathError } from './ledger.js';
import {
	deterministicId,
	normalizeWalletBalance,
	normalizeTransactionLog,
	parseFloatSafe,
	unixMsToIso,
} from './normalize.js';

// ---------------------------------------------------------------------------
// Синтетические фикстуры Bybit API (FAKE данные, не реальные)
// ---------------------------------------------------------------------------

/**
 * Синтетический ответ getWalletBalance с тремя монетами.
 * Данные полностью фиктивны — fake-example (lint:public проходит).
 */
const fakeWalletBalanceResult: BybitWalletBalanceResult = {
	list: [
		{
			accountType: 'UNIFIED',
			totalWalletBalance: '1234.56', // synthetic-example
			totalEquity: '1234.56',
			coin: [
				{
					coin: 'USDT',
					walletBalance: '500.25', // synthetic-example
					availableToWithdraw: '500.25',
					unrealisedPnl: '0',
					usdValue: '500.25',
					locked: '0',
					bonus: '0',
				},
				{
					coin: 'BTC',
					walletBalance: '0.00234', // synthetic-example
					availableToWithdraw: '0.00234',
					unrealisedPnl: '0',
					usdValue: '150.00',
					locked: '0',
					bonus: '0',
				},
				{
					coin: 'ETH',
					walletBalance: '0', // нулевой баланс — должен попасть в леджер
					availableToWithdraw: '0',
					unrealisedPnl: '0',
					usdValue: '0',
					locked: '0',
					bonus: '0',
				},
			],
		},
	],
};

/**
 * Синтетический лог транзакций (4 записи: deposit, trade, fee, пустой cashFlow).
 * Данные полностью фиктивны — synthetic-example.
 */
const fakeTxEntries: BybitTransactionLogEntry[] = [
	{
		id: 'tx-fake-001', // synthetic-example
		symbol: '',
		side: '',
		funding: '0',
		orderLinkId: '',
		orderId: '',
		transactionTime: '1718000000000', // 2024-06-10T11:33:20Z — synthetic
		type: 'TRANSFER_IN',
		qty: '0',
		cashFlow: '200.00', // приход
		change: '200.00',
		cashBalance: '700.25',
		fee: '0',
		bonusChange: '0',
		size: '0',
		feeRate: '0',
		tradePrice: '0',
		tradeId: '',
		currency: 'USDT',
		category: '',
	},
	{
		id: 'tx-fake-002', // synthetic-example
		symbol: 'BTCUSDT',
		side: 'Buy',
		funding: '0',
		orderLinkId: 'ord-fake-99',
		orderId: 'ord-fake-99',
		transactionTime: '1718000100000', // 2024-06-10T11:35:00Z — synthetic
		type: 'TRADE',
		qty: '0.001',
		cashFlow: '-68.50', // расход USDT на покупку BTC
		change: '-68.50',
		cashBalance: '631.75',
		fee: '0.069',
		bonusChange: '0',
		size: '0.001',
		feeRate: '0.001',
		tradePrice: '68500',
		tradeId: 'trade-fake-99',
		currency: 'USDT',
		category: 'spot',
	},
	{
		id: 'tx-fake-003', // synthetic-example: нулевой cashFlow и change → должен пропуститься
		symbol: '',
		side: '',
		funding: '0',
		orderLinkId: '',
		orderId: '',
		transactionTime: '1718000200000',
		type: 'SETTLEMENT',
		qty: '0',
		cashFlow: '0',
		change: '0',
		cashBalance: '631.75',
		fee: '0',
		bonusChange: '0',
		size: '0',
		feeRate: '0',
		tradePrice: '0',
		tradeId: '',
		currency: 'USDT',
		category: '',
	},
	{
		id: 'tx-fake-004', // synthetic-example: приход BTC
		symbol: 'BTCUSDT',
		side: 'Sell',
		funding: '0',
		orderLinkId: '',
		orderId: '',
		transactionTime: '1718000300000',
		type: 'TRADE',
		qty: '0.0012',
		cashFlow: '82.20', // приход USDT от продажи BTC
		change: '82.20',
		cashBalance: '713.95',
		fee: '0.082',
		bonusChange: '0',
		size: '0.0012',
		feeRate: '0.001',
		tradePrice: '68500',
		tradeId: 'trade-fake-100',
		currency: 'USDT',
		category: 'spot',
	},
];

// ---------------------------------------------------------------------------
// Фиктивный ответ CBR (synthetic-example — не реальный курс)
// ---------------------------------------------------------------------------

/**
 * Синтетический ответ ЦБ РФ. Курсы выдуманы — example only.
 * USD/RUB ≈ 90 — grossly synthetic, ЦБ не дают такие числа в поле Value.
 */
const fakeCbrResponse = {
	Date: '2026-06-13T00:00:00+03:00', // synthetic-example
	Valute: {
		USD: {
			CharCode: 'USD',
			Nominal: 1,
			Value: 90.0, // synthetic-example — не реальный курс
		},
		EUR: {
			CharCode: 'EUR',
			Nominal: 1,
			Value: 99.5, // synthetic-example
		},
		GEL: {
			CharCode: 'GEL',
			Nominal: 1,
			Value: 33.0, // synthetic-example
		},
	},
};

// ---------------------------------------------------------------------------
// 1. Тесты normalize
// ---------------------------------------------------------------------------

describe('normalize: deterministicId', () => {
	it('идентично для одного входа', () => {
		expect(deterministicId('bybit:UNIFIED:USDT')).toBe(deterministicId('bybit:UNIFIED:USDT'));
	});

	it('различно для разных входов', () => {
		expect(deterministicId('bybit:UNIFIED:USDT')).not.toBe(deterministicId('bybit:UNIFIED:BTC'));
	});

	it('возвращает 32 символа hex', () => {
		const id = deterministicId('test');
		expect(id).toHaveLength(32);
		expect(/^[0-9a-f]+$/.test(id)).toBe(true);
	});
});

describe('normalize: parseFloatSafe', () => {
	it('парсит обычное число', () => {
		expect(parseFloatSafe('500.25')).toBe(500.25);
	});

	it('пустая строка → 0', () => {
		expect(parseFloatSafe('')).toBe(0);
	});

	it('"null" строка → 0', () => {
		expect(parseFloatSafe('null')).toBe(0);
	});

	it('undefined → 0', () => {
		expect(parseFloatSafe(undefined)).toBe(0);
	});

	it('отрицательное число', () => {
		expect(parseFloatSafe('-68.50')).toBe(-68.5);
	});
});

describe('normalize: unixMsToIso', () => {
	it('конвертирует unix ms строку в ISO', () => {
		// 1718000000000 = 2024-06-10T11:33:20Z (synthetic timestamp)
		const iso = unixMsToIso('1718000000000');
		expect(iso).toMatch(/^2024-06-10T/);
		expect(iso).toMatch(/Z$/);
	});

	it('пустая строка → пустая строка', () => {
		expect(unixMsToIso('')).toBe('');
	});

	it('undefined → пустая строка', () => {
		expect(unixMsToIso(undefined)).toBe('');
	});
});

describe('normalize: normalizeWalletBalance', () => {
	const syncTs = '2026-06-13T10:00:00Z'; // synthetic-example

	it('создаёт AccountRecord для каждой монеты', () => {
		const { accounts } = normalizeWalletBalance(fakeWalletBalanceResult, syncTs);
		expect(accounts).toHaveLength(3);
		const coins = accounts.map((a) => a.currency);
		expect(coins).toContain('USDT');
		expect(coins).toContain('BTC');
		expect(coins).toContain('ETH');
	});

	it('все account kind = "exchange"', () => {
		const { accounts } = normalizeWalletBalance(fakeWalletBalanceResult, syncTs);
		for (const acc of accounts) {
			expect(acc.kind).toBe('exchange');
		}
	});

	it('все account source = "bybit"', () => {
		const { accounts } = normalizeWalletBalance(fakeWalletBalanceResult, syncTs);
		for (const acc of accounts) {
			expect(acc.source).toBe('bybit');
		}
	});

	it('id детерминированный и непустой', () => {
		const { accounts } = normalizeWalletBalance(fakeWalletBalanceResult, syncTs);
		const usdtAcc = accounts.find((a) => a.currency === 'USDT');
		expect(usdtAcc).toBeDefined();
		expect(usdtAcc!.id).toBe(deterministicId('bybit:UNIFIED:USDT'));
	});

	it('id не содержит PII (нет email, телефонов, адресов кошельков)', () => {
		const { accounts } = normalizeWalletBalance(fakeWalletBalanceResult, syncTs);
		for (const acc of accounts) {
			// id — 32 символа hex, нет спецсимволов email/phone
			expect(acc.id).toMatch(/^[0-9a-f]{32}$/);
		}
	});

	it('создаёт SnapshotRecord для каждой монеты с правильным балансом', () => {
		const { snapshots } = normalizeWalletBalance(fakeWalletBalanceResult, syncTs);
		expect(snapshots).toHaveLength(3);

		const usdtSnap = snapshots.find((s) => s.currency === 'USDT');
		expect(usdtSnap).toBeDefined();
		expect(usdtSnap!.balance).toBeCloseTo(500.25);
		expect(usdtSnap!.ts).toBe(syncTs);
	});

	it('нулевой баланс ETH включается в снапшот', () => {
		const { snapshots } = normalizeWalletBalance(fakeWalletBalanceResult, syncTs);
		const ethSnap = snapshots.find((s) => s.currency === 'ETH');
		expect(ethSnap).toBeDefined();
		expect(ethSnap!.balance).toBe(0);
	});

	it('account_id снапшота совпадает с id аккаунта', () => {
		const { accounts, snapshots } = normalizeWalletBalance(fakeWalletBalanceResult, syncTs);
		for (const snap of snapshots) {
			const acc = accounts.find((a) => a.id === snap.account_id);
			expect(acc).toBeDefined();
		}
	});

	it('meta не содержит wallet address (нет PII)', () => {
		const { accounts } = normalizeWalletBalance(fakeWalletBalanceResult, syncTs);
		for (const acc of accounts) {
			if (acc.meta) {
				expect(acc.meta).not.toHaveProperty('walletAddress');
				expect(acc.meta).not.toHaveProperty('depositAddress');
			}
		}
	});
});

describe('normalize: normalizeTransactionLog', () => {
	it('пропускает записи с нулевым cashFlow и change', () => {
		// tx-fake-003 имеет cashFlow=0 и change=0 → должен быть пропущен
		const txs = normalizeTransactionLog(fakeTxEntries);
		expect(txs).toHaveLength(3); // 4 записи минус 1 нулевая = 3
	});

	it('direction="in" для положительного cashFlow', () => {
		const txs = normalizeTransactionLog(fakeTxEntries);
		const deposit = txs.find((t) => t.raw_ref === 'tx-fake-001');
		expect(deposit).toBeDefined();
		expect(deposit!.direction).toBe('in');
		expect(deposit!.amount).toBeCloseTo(200.0);
	});

	it('direction="out" для отрицательного cashFlow', () => {
		const txs = normalizeTransactionLog(fakeTxEntries);
		const trade = txs.find((t) => t.raw_ref === 'tx-fake-002');
		expect(trade).toBeDefined();
		expect(trade!.direction).toBe('out');
		expect(trade!.amount).toBeCloseTo(68.5); // abs(-68.50)
	});

	it('amount всегда положительное', () => {
		const txs = normalizeTransactionLog(fakeTxEntries);
		for (const tx of txs) {
			expect(tx.amount).toBeGreaterThan(0);
		}
	});

	it('категория из type поля Bybit', () => {
		const txs = normalizeTransactionLog(fakeTxEntries);
		const deposit = txs.find((t) => t.raw_ref === 'tx-fake-001');
		expect(deposit!.category).toBe('TRANSFER_IN');
	});

	it('counterparty = символ пары для торговых транзакций', () => {
		const txs = normalizeTransactionLog(fakeTxEntries);
		const trade = txs.find((t) => t.raw_ref === 'tx-fake-002');
		expect(trade!.counterparty).toBe('BTCUSDT');
	});

	it('raw_ref = оригинальный id Bybit', () => {
		const txs = normalizeTransactionLog(fakeTxEntries);
		const deposit = txs.find((t) => t.raw_ref === 'tx-fake-001');
		expect(deposit!.raw_ref).toBe('tx-fake-001');
	});

	it('id детерминированный (не raw_ref, а хэш)', () => {
		const txs = normalizeTransactionLog(fakeTxEntries);
		const deposit = txs.find((t) => t.raw_ref === 'tx-fake-001');
		// id — 32 символа hex
		expect(deposit!.id).toMatch(/^[0-9a-f]{32}$/);
		// id != raw_ref
		expect(deposit!.id).not.toBe('tx-fake-001');
	});

	it('пустой лог → пустой массив', () => {
		expect(normalizeTransactionLog([])).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 2. Тесты ledger (round-trip + path guard)
// ---------------------------------------------------------------------------

describe('ledger: round-trip append + readAll', () => {
	let tmpDir: string;
	let ledger: Ledger;

	beforeEach(() => {
		// Создаём временную директорию — изолирует каждый тест.
		tmpDir = mkdtempSync(join(tmpdir(), 'ledger-test-'));
		const financeDir = join(tmpDir, 'raw', 'finance');
		// publicRepoRoot за пределами tmpDir → path guard не срабатывает.
		ledger = new Ledger({ financeDir, publicRepoRoot: join(tmpDir, 'public-fake') });
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('append AccountRecord → readAll возвращает его обратно', () => {
		const account = {
			id: deterministicId('test:UNIFIED:USDT'),
			source: 'bybit',
			kind: 'exchange' as const,
			name: 'Bybit UNIFIED USDT', // synthetic-example
			currency: 'USDT',
			meta: { accountType: 'UNIFIED' },
		};
		ledger.append('accounts', account);
		const records = ledger.readAll('accounts');
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject(account);
	});

	it('append SnapshotRecord → readAll возвращает его обратно', () => {
		const snap = {
			ts: '2026-06-13T10:00:00Z', // synthetic-example
			account_id: deterministicId('test:UNIFIED:USDT'),
			balance: 500.25, // synthetic-example
			currency: 'USDT',
		};
		ledger.append('snapshots', snap);
		const records = ledger.readAll('snapshots');
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject(snap);
	});

	it('append TransactionRecord → readAll', () => {
		const tx = {
			id: deterministicId('bybit:tx:tx-fake-001'),
			ts: '2024-06-10T11:33:20Z', // synthetic-example
			account_id: deterministicId('bybit:UNIFIED:USDT'),
			amount: 200.0, // synthetic-example
			currency: 'USDT',
			direction: 'in' as const,
			category: 'TRANSFER_IN',
			raw_ref: 'tx-fake-001', // synthetic-example
		};
		ledger.append('transactions', tx);
		const records = ledger.readAll('transactions');
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject(tx);
	});

	it('append FxRateRecord → readAll', () => {
		const fx = {
			ts: '2026-06-13T10:00:00Z', // synthetic-example
			base: 'USD',
			quote: 'RUB',
			rate: 90.0, // synthetic-example
			source: 'cbr',
		};
		ledger.append('fx_rates', fx);
		const records = ledger.readAll('fx_rates');
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject(fx);
	});

	it('CreditRecord append → readAll', () => {
		const credit = {
			id: 'credit-fake-001', // synthetic-example
			source: 'manual',
			principal: 500000, // synthetic-example
			currency: 'RUB',
			rate_pct: 21.5, // synthetic-example
			opened_at: '2025-01-01T00:00:00Z', // synthetic-example
			balance: 450000, // synthetic-example
			balance_ts: '2026-06-13T10:00:00Z', // synthetic-example
			manual: true,
		};
		ledger.append('credits', credit);
		const records = ledger.readAll('credits');
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject(credit);
	});

	it('несколько append → readAll возвращает все в порядке добавления', () => {
		const ts = '2026-06-13T10:00:00Z'; // synthetic-example
		for (let i = 0; i < 3; i++) {
			ledger.append('snapshots', {
				ts,
				account_id: deterministicId(`fake:${i}`),
				balance: i * 100, // synthetic-example
				currency: 'USDT',
			});
		}
		const records = ledger.readAll('snapshots');
		expect(records).toHaveLength(3);
	});

	it('readAll несуществующего файла → пустой массив (не ошибка)', () => {
		// Файл ещё не создан — должен вернуть [] без исключения.
		expect(ledger.readAll('accounts')).toHaveLength(0);
	});

	it('ValidationError при записи невалидной записи', () => {
		expect(() =>
			ledger.append('accounts', {
				id: '', // пустой id — нарушает минимум 1 символ
				source: 'bybit',
				kind: 'exchange',
				name: 'test',
				currency: 'USDT',
			}),
		).toThrow();
	});
});

describe('ledger: path-guard защита публичного репо', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'ledger-guard-test-'));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('LedgerPathError если financeDir = publicRepoRoot (одно дерево)', () => {
		// Создаём ledger где financeDir ВНУТРИ publicRepoRoot — должен бросить.
		const publicRoot = join(tmpDir, 'public-repo');
		const financeDir = join(publicRoot, 'raw', 'finance'); // ← ВНУТРИ публичного!

		const badLedger = new Ledger({ financeDir, publicRepoRoot: publicRoot });

		expect(() =>
			badLedger.append('fx_rates', {
				ts: '2026-06-13T10:00:00Z', // synthetic-example
				base: 'USD',
				quote: 'RUB',
				rate: 90.0, // synthetic-example
				source: 'cbr',
			}),
		).toThrow(LedgerPathError);
	});

	it('LedgerPathError с понятным сообщением о публичном репо', () => {
		const publicRoot = join(tmpDir, 'public-repo');
		const financeDir = join(publicRoot, 'raw', 'finance');
		const badLedger = new Ledger({ financeDir, publicRepoRoot: publicRoot });

		let thrown: LedgerPathError | null = null;
		try {
			badLedger.append('fx_rates', {
				ts: '2026-06-13T10:00:00Z', // synthetic-example
				base: 'USD',
				quote: 'RUB',
				rate: 90.0, // synthetic-example
				source: 'cbr',
			});
		} catch (e) {
			if (e instanceof LedgerPathError) thrown = e;
		}

		expect(thrown).toBeInstanceOf(LedgerPathError);
		expect(thrown!.message).toContain('публичного репо');
	});

	it('LedgerPathError если целевой путь вне allowedDir', async () => {
		// financeDir указывает внутри tmpDir, но записываем в другой tmpDir — симулируем
		// через подмену financeDir на путь вне allowedDir.
		// (Через assertPathAllowed напрямую.)
		const { assertPathAllowed } = await import('./ledger.js');
		const allowedDir = join(tmpDir, 'raw', 'finance');
		const publicRoot = join(tmpDir, 'public-fake');
		const badTarget = join(tmpDir, 'elsewhere', 'accounts.jsonl');

		expect(() => assertPathAllowed(badTarget, allowedDir, publicRoot)).toThrow(LedgerPathError);
	});

	it('нет ошибки если пути корректны (finance НЕ под public)', () => {
		// Нормальный случай: financial data в content-repo, public-repo — в стороне.
		const contentRoot = join(tmpDir, 'content-repo');
		const financeDir = join(contentRoot, 'raw', 'finance');
		const publicRoot = join(tmpDir, 'public-repo'); // другое поддерево

		const goodLedger = new Ledger({ financeDir, publicRepoRoot: publicRoot });

		// Не должно бросать.
		expect(() =>
			goodLedger.append('fx_rates', {
				ts: '2026-06-13T10:00:00Z', // synthetic-example
				base: 'USD',
				quote: 'RUB',
				rate: 90.0, // synthetic-example
				source: 'cbr',
			}),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// 3. Тесты fx провайдеров
// ---------------------------------------------------------------------------

describe('fx: IdentityFxProvider', () => {
	const provider = new IdentityFxProvider();

	it('USD→USD = 1', async () => {
		expect(await provider.rate('USD', 'USD', '2026-06-13T10:00:00Z')).toBe(1);
	});

	it('usdt→USDT = 1 (нечувствителен к регистру)', async () => {
		expect(await provider.rate('usdt', 'USDT', '2026-06-13T10:00:00Z')).toBe(1);
	});

	it('USD→RUB = null', async () => {
		expect(await provider.rate('USD', 'RUB', '2026-06-13T10:00:00Z')).toBeNull();
	});
});

describe('fx: StablecoinFxProvider', () => {
	const provider = new StablecoinFxProvider();

	it('USDT→USD = 1', async () => {
		expect(await provider.rate('USDT', 'USD', '2026-06-13T10:00:00Z')).toBe(1);
	});

	it('USD→USDT = 1', async () => {
		expect(await provider.rate('USD', 'USDT', '2026-06-13T10:00:00Z')).toBe(1);
	});

	it('USDC→USDT = 1 (стейблкоин→стейблкоин)', async () => {
		expect(await provider.rate('USDC', 'USDT', '2026-06-13T10:00:00Z')).toBe(1);
	});

	it('USDT→RUB = null (не обрабатывает кросс с рублём)', async () => {
		expect(await provider.rate('USDT', 'RUB', '2026-06-13T10:00:00Z')).toBeNull();
	});

	it('BTC→USD = null', async () => {
		expect(await provider.rate('BTC', 'USD', '2026-06-13T10:00:00Z')).toBeNull();
	});
});

describe('fx: CbrFxProvider с мокнутым fetch', () => {
	/**
	 * Создаём мок fetch, возвращающий синтетический ответ ЦБ РФ.
	 * Без реального сетевого запроса.
	 */
	function makeMockFetch(body: unknown): typeof fetch {
		return async (_url: RequestInfo | URL, _init?: RequestInit) => {
			return {
				ok: true,
				status: 200,
				json: async () => body,
			} as unknown as Response;
		};
	}

	it('USD→RUB из CBR данных', async () => {
		const provider = new CbrFxProvider({ fetchFn: makeMockFetch(fakeCbrResponse) });
		const rate = await provider.rate('USD', 'RUB', '2026-06-13T10:00:00Z');
		// synthetic-example: USD.Value = 90.0, Nominal = 1
		expect(rate).toBeCloseTo(90.0);
	});

	it('RUB→USD = обратный курс', async () => {
		const provider = new CbrFxProvider({ fetchFn: makeMockFetch(fakeCbrResponse) });
		const rate = await provider.rate('RUB', 'USD', '2026-06-13T10:00:00Z');
		expect(rate).toBeCloseTo(1 / 90.0);
	});

	it('EUR→RUB из CBR данных', async () => {
		const provider = new CbrFxProvider({ fetchFn: makeMockFetch(fakeCbrResponse) });
		const rate = await provider.rate('EUR', 'RUB', '2026-06-13T10:00:00Z');
		// synthetic-example: EUR.Value = 99.5
		expect(rate).toBeCloseTo(99.5);
	});

	it('USD→EUR через кросс-курс', async () => {
		const provider = new CbrFxProvider({ fetchFn: makeMockFetch(fakeCbrResponse) });
		const rate = await provider.rate('USD', 'EUR', '2026-06-13T10:00:00Z');
		// synthetic-example: USD/RUB = 90, EUR/RUB = 99.5 → USD/EUR = 90/99.5
		expect(rate).toBeCloseTo(90 / 99.5);
	});

	it('неизвестная валюта (XYZ) → null', async () => {
		const provider = new CbrFxProvider({ fetchFn: makeMockFetch(fakeCbrResponse) });
		const rate = await provider.rate('XYZ', 'RUB', '2026-06-13T10:00:00Z');
		expect(rate).toBeNull();
	});

	it('ошибка сети → null (не бросает)', async () => {
		const failFetch: typeof fetch = async () => {
			throw new Error('network error synthetic-example');
		};
		const provider = new CbrFxProvider({ fetchFn: failFetch });
		const rate = await provider.rate('USD', 'RUB', '2026-06-13T10:00:00Z');
		expect(rate).toBeNull();
	});

	it('HTTP !ok → null', async () => {
		const errorFetch: typeof fetch = async () => {
			return { ok: false, status: 503, json: async () => ({}) } as unknown as Response;
		};
		const provider = new CbrFxProvider({ fetchFn: errorFetch });
		const rate = await provider.rate('USD', 'RUB', '2026-06-13T10:00:00Z');
		expect(rate).toBeNull();
	});
});

describe('fx: ChainedFxProvider', () => {
	it('первый ненулевой ответ побеждает', async () => {
		const chain = new ChainedFxProvider([
			new IdentityFxProvider(), // USD→USD=1
			new StablecoinFxProvider(),
		]);
		// USD→USD — IdentityFxProvider даст 1.
		expect(await chain.rate('USD', 'USD', '2026-06-13T10:00:00Z')).toBe(1);
	});

	it('цепочка переходит к следующему при null', async () => {
		// IdentityFxProvider вернёт null для USD→RUB, StablecoinFxProvider тоже null,
		// CbrFxProvider даст курс из мока.
		function makeMockFetch(body: unknown): typeof fetch {
			return async () => ({ ok: true, status: 200, json: async () => body } as unknown as Response);
		}
		const chain = new ChainedFxProvider([
			new IdentityFxProvider(),
			new StablecoinFxProvider(),
			new CbrFxProvider({ fetchFn: makeMockFetch(fakeCbrResponse) }),
		]);
		const rate = await chain.rate('USD', 'RUB', '2026-06-13T10:00:00Z');
		expect(rate).toBeCloseTo(90.0); // synthetic-example
	});

	it('null если ни один провайдер не дал курс', async () => {
		const chain = new ChainedFxProvider([new IdentityFxProvider()]);
		// IdentityFxProvider вернёт null для USD→RUB.
		expect(await chain.rate('USD', 'RUB', '2026-06-13T10:00:00Z')).toBeNull();
	});
});

describe('fx: createDefaultFxProvider', () => {
	it('USDT→USDT = 1 (identity)', async () => {
		const provider = createDefaultFxProvider();
		expect(await provider.rate('USDT', 'USDT', '2026-06-13T10:00:00Z')).toBe(1);
	});

	it('USDT→USD = 1 (stablecoin)', async () => {
		const provider = createDefaultFxProvider();
		expect(await provider.rate('USDT', 'USD', '2026-06-13T10:00:00Z')).toBe(1);
	});

	it('USDC→USDT = 1 (stablecoin cross)', async () => {
		const provider = createDefaultFxProvider();
		expect(await provider.rate('USDC', 'USDT', '2026-06-13T10:00:00Z')).toBe(1);
	});
});
