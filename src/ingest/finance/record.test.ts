/**
 * record.test.ts — тесты движка recordFinanceEntry.
 *
 * Принципы:
 *   - Все данные синтетические (fake-example, нет реальных сумм/счетов/имён/PII).
 *   - Нет реальных сетевых запросов (нет FX, нет Telegram, нет Bybit).
 *   - Каждый тест создаёт изолированный tmpDir (mkdtempSync) и удаляет его в afterEach.
 *   - Инъекция nowFn для детерминированного времени.
 *   - Проверка path-guard: попытка писать в публичный репо → LedgerPathError.
 *   - Только импорты из ./types, ./ledger, ./normalize (НЕ другие новые движки).
 *
 * Покрытие:
 *   1. Бутстрап нового счёта: opaque id (32-hex), без PII.
 *   2. Мульти-счёт за один вызов (батч).
 *   3. Наличка cash в VND — счёт auto-bootstrap с kind='cash'.
 *   4. Доход (direction:'in') и расход (direction:'out').
 *   5. Дедуп: идентичный ввод → одна запись в transactions.jsonl.
 *   6. void: сторно — прошлая запись цела, добавлена сторно с void_id.
 *   7. amend: правка — прошлая запись цела, добавлена правка с amended_id.
 *   8. transfer: два счёта → две связанные записи с общим transfer_id.
 *   9. path-guard: zapись в публичный репо → LedgerPathError.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Ledger, LedgerPathError } from './ledger.js';
import { deterministicId } from './normalize.js';
import {
	makeAccountId,
	makeTxId,
	recordFinanceEntry,
	type RecordDeps,
} from './record.js';

// ---------------------------------------------------------------------------
// Вспомогательные фикстуры (все данные синтетические)
// ---------------------------------------------------------------------------

/**
 * Фиксированный момент времени для детерминированных тестов.
 * Synthetic-example — не реальный момент.
 */
const FAKE_TS = '2026-01-15T12:00:00Z'; // synthetic-example

/**
 * nowFn-заглушка: всегда возвращает фиксированный момент.
 * Инъекция вместо реальных часов.
 */
const fakeNow = () => new Date(FAKE_TS);

// ---------------------------------------------------------------------------
// Фабрика тестовых зависимостей
// ---------------------------------------------------------------------------

/**
 * makeDeps — создаёт { ledger, nowFn } для теста в изолированном tmpDir.
 *
 * @param tmpDir      — корень временного каталога (mkdtempSync)
 * @param nowOverride — кастомный nowFn (по умолчанию fakeNow)
 * @returns RecordDeps + путь к financeDir для проверок
 */
function makeDeps(tmpDir: string, nowOverride?: () => Date): { deps: RecordDeps; financeDir: string } {
	const financeDir = join(tmpDir, 'raw', 'finance');
	// publicRepoRoot снаружи tmpDir → path-guard не срабатывает на корректных тестах.
	const ledger = new Ledger({
		financeDir,
		publicRepoRoot: join(tmpDir, 'public-fake-repo'),
	});
	return {
		deps: { ledger, nowFn: nowOverride ?? fakeNow },
		financeDir,
	};
}

// ---------------------------------------------------------------------------
// Блок 1: Бутстрап нового счёта
// ---------------------------------------------------------------------------

describe('record: бутстрап нового счёта', () => {
	let tmpDir: string;
	let deps: RecordDeps;
	let ledger: Ledger;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'record-bootstrap-'));
		const result = makeDeps(tmpDir);
		deps = result.deps;
		ledger = deps.ledger;
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('первая запись создаёт AccountRecord (бутстрап)', () => {
		// До вызова счетов нет.
		expect(ledger.readAll('accounts')).toHaveLength(0);

		recordFinanceEntry(
			{
				kind: 'transaction',
				account: {
					source: 'manual',
					name: 'Fake Wallet RUB', // synthetic-example
					currency: 'RUB',
					kind: 'checking',
				},
				amount: 100, // synthetic-example
				currency: 'RUB',
				direction: 'in',
			},
			deps,
		);

		// После вызова — создан один счёт.
		const accounts = ledger.readAll('accounts');
		expect(accounts).toHaveLength(1);
	});

	it('id счёта — opaque hex-32, без PII (имён/номеров)', () => {
		recordFinanceEntry(
			{
				kind: 'transaction',
				account: {
					source: 'manual',
					name: 'Fake Savings Account', // synthetic-example — без реального ФИО
					currency: 'USD',
					kind: 'savings',
				},
				amount: 250, // synthetic-example
				currency: 'USD',
				direction: 'out',
			},
			deps,
		);

		const accounts = ledger.readAll('accounts');
		expect(accounts).toHaveLength(1);
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		const { id } = accounts[0]!;

		// id — ровно 32 символа hex (sha256[:32]).
		expect(id).toHaveLength(32);
		expect(id).toMatch(/^[0-9a-f]{32}$/);

		// id не содержит человекочитаемого имени счёта — opaque.
		expect(id).not.toContain('Fake');
		expect(id).not.toContain('Savings');
		expect(id).not.toContain('manual');
	});

	it('id счёта детерминированный: повторный вызов — тот же id', () => {
		const accountSpec = {
			source: 'manual',
			name: 'Fake Wallet EUR', // synthetic-example
			currency: 'EUR',
			kind: 'checking' as const,
		};

		// Вычисляем ожидаемый id напрямую через makeAccountId.
		const expectedId = makeAccountId('manual', 'Fake Wallet EUR', 'EUR');

		recordFinanceEntry(
			{
				kind: 'transaction',
				account: accountSpec,
				amount: 50, // synthetic-example
				currency: 'EUR',
				direction: 'in',
			},
			deps,
		);

		const accounts = ledger.readAll('accounts');
		expect(accounts[0]!.id).toBe(expectedId);
	});

	it('повторный вызов с тем же счётом НЕ дублирует AccountRecord', () => {
		const accountSpec = {
			source: 'manual',
			name: 'Fake Checking GEL', // synthetic-example
			currency: 'GEL',
			kind: 'checking' as const,
		};

		const input = {
			kind: 'transaction' as const,
			account: accountSpec,
			amount: 75, // synthetic-example
			currency: 'GEL',
			direction: 'in' as const,
		};

		// Два разных вызова с разным ts (разное nowFn) → разные txId, но счёт один.
		recordFinanceEntry(input, { ...deps, nowFn: () => new Date('2026-01-15T10:00:00Z') });
		recordFinanceEntry(
			{ ...input, amount: 80 }, // synthetic-example — другой amount чтобы txId различался
			{ ...deps, nowFn: () => new Date('2026-01-15T11:00:00Z') },
		);

		// Счёт создан один раз.
		const accounts = ledger.readAll('accounts');
		expect(accounts).toHaveLength(1);
	});

	it('бутстрап создаёт счёт с переданным kind', () => {
		recordFinanceEntry(
			{
				kind: 'snapshot',
				account: {
					source: 'manual',
					name: 'Fake Deposit RUB', // synthetic-example
					currency: 'RUB',
					kind: 'savings',
				},
				balance: 10000, // synthetic-example
			},
			deps,
		);

		const accounts = ledger.readAll('accounts');
		expect(accounts).toHaveLength(1);
		expect(accounts[0]!.kind).toBe('savings');
	});
});

// ---------------------------------------------------------------------------
// Блок 2: Мульти-счёт за один вызов (батч)
// ---------------------------------------------------------------------------

describe('record: батч — несколько счетов за один вызов', () => {
	let tmpDir: string;
	let deps: RecordDeps;
	let ledger: Ledger;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'record-batch-'));
		const result = makeDeps(tmpDir);
		deps = result.deps;
		ledger = deps.ledger;
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('батч из двух транзакций создаёт два счёта и две транзакции', () => {
		const result = recordFinanceEntry(
			[
				{
					kind: 'transaction',
					account: {
						source: 'manual',
						name: 'Fake Wallet A', // synthetic-example
						currency: 'USD',
						kind: 'checking',
					},
					amount: 100, // synthetic-example
					currency: 'USD',
					direction: 'in',
				},
				{
					kind: 'transaction',
					account: {
						source: 'manual',
						name: 'Fake Wallet B', // synthetic-example
						currency: 'EUR',
						kind: 'checking',
					},
					amount: 50, // synthetic-example
					currency: 'EUR',
					direction: 'out',
				},
			],
			deps,
		);

		// Два счёта созданы (бутстрап).
		expect(ledger.readAll('accounts')).toHaveLength(2);
		// Два transactions.
		expect(ledger.readAll('transactions')).toHaveLength(2);
		// accounts_touched содержит оба id.
		expect(result.accounts_touched).toHaveLength(2);
	});

	it('батч: один существующий счёт + один новый → одна AccountRecord создана', () => {
		// Создаём первый счёт заранее через snapshot.
		recordFinanceEntry(
			{
				kind: 'snapshot',
				account: { source: 'manual', name: 'Fake Existing', currency: 'RUB', kind: 'checking' },
				balance: 5000, // synthetic-example
			},
			deps,
		);

		// Батч: первый — существующий, второй — новый.
		recordFinanceEntry(
			[
				{
					kind: 'transaction',
					account: { source: 'manual', name: 'Fake Existing', currency: 'RUB', kind: 'checking' },
					amount: 200, // synthetic-example
					currency: 'RUB',
					direction: 'out',
				},
				{
					kind: 'transaction',
					account: { source: 'manual', name: 'Fake New Account', currency: 'USD', kind: 'checking' },
					amount: 10, // synthetic-example
					currency: 'USD',
					direction: 'in',
				},
			],
			deps,
		);

		// Всего должно быть 2 счёта (не 3).
		expect(ledger.readAll('accounts')).toHaveLength(2);
	});

	it('результат содержит accounts_touched для всех счетов батча', () => {
		const result = recordFinanceEntry(
			[
				{
					kind: 'snapshot',
					account: { source: 'manual', name: 'Fake Account X', currency: 'RUB', kind: 'checking' },
					balance: 1000, // synthetic-example
				},
				{
					kind: 'snapshot',
					account: { source: 'manual', name: 'Fake Account Y', currency: 'USD', kind: 'checking' },
					balance: 200, // synthetic-example
				},
			],
			deps,
		);

		expect(result.accounts_touched).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// Блок 3: Наличка cash в VND
// ---------------------------------------------------------------------------

describe('record: наличка cash в VND', () => {
	let tmpDir: string;
	let deps: RecordDeps;
	let ledger: Ledger;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'record-cash-vnd-'));
		const result = makeDeps(tmpDir);
		deps = result.deps;
		ledger = deps.ledger;
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('наличка VND создаёт счёт kind=cash', () => {
		recordFinanceEntry(
			{
				kind: 'transaction',
				account: {
					source: 'manual',
					name: 'Fake Cash VND', // synthetic-example
					currency: 'VND',
					kind: 'cash', // явный cash
				},
				amount: 500000, // synthetic-example (500k VND ≈ $20, синтетика)
				currency: 'VND',
				direction: 'out',
			},
			deps,
		);

		const accounts = ledger.readAll('accounts');
		expect(accounts).toHaveLength(1);
		expect(accounts[0]!.kind).toBe('cash');
		expect(accounts[0]!.currency).toBe('VND');
	});

	it('транзакция VND корректно записана с direction out', () => {
		recordFinanceEntry(
			{
				kind: 'transaction',
				account: {
					source: 'manual',
					name: 'Fake Cash VND', // synthetic-example
					currency: 'VND',
					kind: 'cash',
				},
				amount: 200000, // synthetic-example
				currency: 'VND',
				direction: 'out',
			},
			deps,
		);

		const txs = ledger.readAll('transactions');
		expect(txs).toHaveLength(1);
		expect(txs[0]!.direction).toBe('out');
		expect(txs[0]!.currency).toBe('VND');
		expect(txs[0]!.amount).toBe(200000);
	});

	it('наличка в ₽ (RUB) с kind=cash', () => {
		recordFinanceEntry(
			{
				kind: 'transaction',
				account: {
					source: 'manual',
					name: 'Fake Cash Wallet', // synthetic-example
					currency: 'RUB',
					kind: 'cash',
				},
				amount: 3000, // synthetic-example
				currency: 'RUB',
				direction: 'in',
			},
			deps,
		);

		const accounts = ledger.readAll('accounts');
		expect(accounts[0]!.kind).toBe('cash');
		expect(accounts[0]!.currency).toBe('RUB');
	});
});

// ---------------------------------------------------------------------------
// Блок 4: Доход (in) и расход (out)
// ---------------------------------------------------------------------------

describe('record: доход и расход', () => {
	let tmpDir: string;
	let deps: RecordDeps;
	let ledger: Ledger;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'record-inout-'));
		const result = makeDeps(tmpDir);
		deps = result.deps;
		ledger = deps.ledger;
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('direction:in записывается верно', () => {
		recordFinanceEntry(
			{
				kind: 'transaction',
				account: { source: 'manual', name: 'Fake Income Account', currency: 'USD', kind: 'checking' },
				amount: 1000, // synthetic-example
				currency: 'USD',
				direction: 'in',
				category: 'salary',
			},
			deps,
		);

		const txs = ledger.readAll('transactions');
		expect(txs).toHaveLength(1);
		expect(txs[0]!.direction).toBe('in');
		expect(txs[0]!.amount).toBe(1000);
		expect(txs[0]!.category).toBe('salary');
	});

	it('direction:out записывается верно', () => {
		recordFinanceEntry(
			{
				kind: 'transaction',
				account: { source: 'manual', name: 'Fake Expense Account', currency: 'RUB', kind: 'checking' },
				amount: 350, // synthetic-example
				currency: 'RUB',
				direction: 'out',
				category: 'grocery',
			},
			deps,
		);

		const txs = ledger.readAll('transactions');
		expect(txs).toHaveLength(1);
		expect(txs[0]!.direction).toBe('out');
		expect(txs[0]!.amount).toBe(350);
		expect(txs[0]!.category).toBe('grocery');
	});

	it('snapshot записывает баланс без транзакции', () => {
		recordFinanceEntry(
			{
				kind: 'snapshot',
				account: { source: 'manual', name: 'Fake Savings', currency: 'USD', kind: 'savings' },
				balance: 4500, // synthetic-example
			},
			deps,
		);

		// Снапшот есть, транзакций нет.
		expect(ledger.readAll('snapshots')).toHaveLength(1);
		expect(ledger.readAll('transactions')).toHaveLength(0);

		const snaps = ledger.readAll('snapshots');
		expect(snaps[0]!.balance).toBe(4500);
		expect(snaps[0]!.currency).toBe('USD');
	});

	it('результат balances содержит последний снапшот', () => {
		// Записываем два снапшота — balances должен вернуть последний.
		recordFinanceEntry(
			{
				kind: 'snapshot',
				account: { source: 'manual', name: 'Fake Balance Account', currency: 'RUB', kind: 'checking' },
				balance: 1000, // synthetic-example
				ts: '2026-01-01T10:00:00Z', // synthetic-example
			},
			deps,
		);

		const result = recordFinanceEntry(
			{
				kind: 'snapshot',
				account: { source: 'manual', name: 'Fake Balance Account', currency: 'RUB', kind: 'checking' },
				balance: 1500, // synthetic-example — новый баланс
				ts: '2026-01-15T12:00:00Z', // synthetic-example — позже
			},
			deps,
		);

		// balances[0].balance = последний снапшот = 1500.
		expect(result.balances).toHaveLength(1);
		expect(result.balances[0]!.balance).toBe(1500);
	});
});

// ---------------------------------------------------------------------------
// Блок 5: Дедуп идентичного ввода
// ---------------------------------------------------------------------------

describe('record: дедуп — идентичный ввод не дублируется', () => {
	let tmpDir: string;
	let deps: RecordDeps;
	let ledger: Ledger;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'record-dedup-'));
		const result = makeDeps(tmpDir);
		deps = result.deps;
		ledger = deps.ledger;
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('два идентичных вызова → одна транзакция в transactions.jsonl', () => {
		// Фиксированный nowFn: одинаковое ts → одинаковый txId → дедуп.
		const identicalInput = {
			kind: 'transaction' as const,
			account: { source: 'manual', name: 'Fake Dedup Account', currency: 'RUB', kind: 'checking' as const },
			amount: 500, // synthetic-example
			currency: 'RUB',
			direction: 'out' as const,
			note: 'fake-dedup-note', // synthetic-example
		};

		recordFinanceEntry(identicalInput, deps);
		recordFinanceEntry(identicalInput, deps); // второй вызов — дубль

		// Только одна транзакция должна быть в леджере.
		const txs = ledger.readAll('transactions');
		expect(txs).toHaveLength(1);
	});

	it('один вызов с одинаковым ts → тот же txId (детерминизм)', () => {
		// Проверяем что makeTxId детерминирован.
		const accountId = makeAccountId('manual', 'Fake Account', 'USD');
		const ts = FAKE_TS; // synthetic-example
		const id1 = makeTxId(ts, accountId, 123, 'USD', 'in', 'test-note');
		const id2 = makeTxId(ts, accountId, 123, 'USD', 'in', 'test-note');
		expect(id1).toBe(id2);
	});

	it('разные note → разные txId (нет ложного дедупа)', () => {
		const accountId = makeAccountId('manual', 'Fake Account', 'USD');
		const ts = FAKE_TS;
		const id1 = makeTxId(ts, accountId, 100, 'USD', 'out', 'note-alpha');
		const id2 = makeTxId(ts, accountId, 100, 'USD', 'out', 'note-beta');
		expect(id1).not.toBe(id2);
	});

	it('разные amount → разные txId', () => {
		const accountId = makeAccountId('manual', 'Fake Account', 'RUB');
		const ts = FAKE_TS;
		const id1 = makeTxId(ts, accountId, 100, 'RUB', 'in');
		const id2 = makeTxId(ts, accountId, 200, 'RUB', 'in');
		expect(id1).not.toBe(id2);
	});
});

// ---------------------------------------------------------------------------
// Блок 6: void — сторно
// ---------------------------------------------------------------------------

describe('record: void — сторно транзакции', () => {
	let tmpDir: string;
	let deps: RecordDeps;
	let ledger: Ledger;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'record-void-'));
		const result = makeDeps(tmpDir);
		deps = result.deps;
		ledger = deps.ledger;
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('void добавляет новую запись с void_id; оригинальная цела', () => {
		const account = { source: 'manual', name: 'Fake Void Account', currency: 'RUB', kind: 'checking' as const };

		// Записываем оригинальную транзакцию.
		recordFinanceEntry(
			{
				kind: 'transaction',
				account,
				amount: 999, // synthetic-example
				currency: 'RUB',
				direction: 'out',
			},
			deps,
		);

		const txsBefore = ledger.readAll('transactions');
		expect(txsBefore).toHaveLength(1);
		const originalId = txsBefore[0]!.id;

		// Записываем сторно.
		recordFinanceEntry(
			{
				kind: 'void',
				account,
				void_id: originalId,
				amount: 999, // synthetic-example — та же сумма
				currency: 'RUB',
				direction: 'in', // обратное направление
				note: 'fake-void-reason', // synthetic-example
			},
			{ ...deps, nowFn: () => new Date('2026-01-16T10:00:00Z') }, // другой ts чтобы id различался
		);

		const txsAfter = ledger.readAll('transactions');
		// Теперь 2 записи: оригинал + сторно.
		expect(txsAfter).toHaveLength(2);

		// Находим сторно-запись по void_id.
		const voidTx = txsAfter.find((t) => t.void_id !== undefined);
		expect(voidTx).toBeDefined();
		expect(voidTx!.void_id).toBe(originalId);
		expect(voidTx!.direction).toBe('in');

		// Оригинальная запись не изменилась.
		const originalTx = txsAfter.find((t) => t.id === originalId);
		expect(originalTx).toBeDefined();
		expect(originalTx!.void_id).toBeUndefined();
	});

	it('повторный void с теми же данными — дедуп (одна сторно-запись)', () => {
		const account = { source: 'manual', name: 'Fake Void Dedup', currency: 'USD', kind: 'checking' as const };
		const voidTs = () => new Date('2026-01-16T09:00:00Z');

		// Оригинал.
		recordFinanceEntry(
			{ kind: 'transaction', account, amount: 77, currency: 'USD', direction: 'in' },
			deps,
		);
		const originalId = ledger.readAll('transactions')[0]!.id;

		// Два идентичных вызова void с одинаковым ts.
		const voidInput = {
			kind: 'void' as const,
			account,
			void_id: originalId,
			amount: 77, // synthetic-example
			currency: 'USD',
			direction: 'out' as const,
		};
		recordFinanceEntry(voidInput, { ...deps, nowFn: voidTs });
		recordFinanceEntry(voidInput, { ...deps, nowFn: voidTs }); // дубль

		// Всего транзакций: оригинал + 1 сторно (не 3).
		expect(ledger.readAll('transactions')).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// Блок 7: amend — правка транзакции
// ---------------------------------------------------------------------------

describe('record: amend — правка транзакции', () => {
	let tmpDir: string;
	let deps: RecordDeps;
	let ledger: Ledger;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'record-amend-'));
		const result = makeDeps(tmpDir);
		deps = result.deps;
		ledger = deps.ledger;
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('amend добавляет запись с amended_id; оригинальная цела', () => {
		const account = { source: 'manual', name: 'Fake Amend Account', currency: 'USD', kind: 'checking' as const };

		// Оригинал с неверной суммой.
		recordFinanceEntry(
			{
				kind: 'transaction',
				account,
				amount: 100, // synthetic-example — ошибочная сумма
				currency: 'USD',
				direction: 'out',
			},
			deps,
		);

		const txsBefore = ledger.readAll('transactions');
		const originalId = txsBefore[0]!.id;

		// Правка с исправленной суммой.
		recordFinanceEntry(
			{
				kind: 'amend',
				account,
				amended_id: originalId,
				amount: 120, // synthetic-example — исправленная сумма
				currency: 'USD',
				direction: 'out',
				category: 'shopping',
			},
			{ ...deps, nowFn: () => new Date('2026-01-17T08:00:00Z') },
		);

		const txsAfter = ledger.readAll('transactions');
		// Оригинал + правка = 2 записи.
		expect(txsAfter).toHaveLength(2);

		// Правка содержит amended_id.
		const amendTx = txsAfter.find((t) => t.amended_id !== undefined);
		expect(amendTx).toBeDefined();
		expect(amendTx!.amended_id).toBe(originalId);
		expect(amendTx!.amount).toBe(120);
		expect(amendTx!.category).toBe('shopping');

		// Оригинал не изменился: сумма 100, нет amended_id.
		const origTx = txsAfter.find((t) => t.id === originalId);
		expect(origTx!.amount).toBe(100);
		expect(origTx!.amended_id).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Блок 8: transfer — перевод между счетами
// ---------------------------------------------------------------------------

describe('record: transfer — перевод между счетами', () => {
	let tmpDir: string;
	let deps: RecordDeps;
	let ledger: Ledger;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'record-transfer-'));
		const result = makeDeps(tmpDir);
		deps = result.deps;
		ledger = deps.ledger;
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('transfer создаёт две транзакции (out + in) с общим transfer_id', () => {
		recordFinanceEntry(
			{
				kind: 'transfer',
				from_account: {
					source: 'manual',
					name: 'Fake Source Account', // synthetic-example
					currency: 'RUB',
					kind: 'checking',
				},
				to_account: {
					source: 'manual',
					name: 'Fake Destination Account', // synthetic-example
					currency: 'RUB',
					kind: 'savings',
				},
				amount: 5000, // synthetic-example
				currency: 'RUB',
				note: 'fake-transfer-note', // synthetic-example
			},
			deps,
		);

		const txs = ledger.readAll('transactions');
		// Ровно две записи.
		expect(txs).toHaveLength(2);

		const outTx = txs.find((t) => t.direction === 'out');
		const inTx = txs.find((t) => t.direction === 'in');

		expect(outTx).toBeDefined();
		expect(inTx).toBeDefined();

		// Обе записи имеют одинаковый transfer_id.
		expect(outTx!.transfer_id).toBeDefined();
		expect(inTx!.transfer_id).toBeDefined();
		expect(outTx!.transfer_id).toBe(inTx!.transfer_id);
	});

	it('transfer: source account — out, destination account — in', () => {
		const fromAccount = { source: 'manual', name: 'Fake From', currency: 'USD', kind: 'checking' as const };
		const toAccount = { source: 'manual', name: 'Fake To', currency: 'USD', kind: 'savings' as const };

		const fromId = makeAccountId('manual', 'Fake From', 'USD');
		const toId = makeAccountId('manual', 'Fake To', 'USD');

		recordFinanceEntry(
			{
				kind: 'transfer',
				from_account: fromAccount,
				to_account: toAccount,
				amount: 200, // synthetic-example
				currency: 'USD',
			},
			deps,
		);

		const txs = ledger.readAll('transactions');
		const outTx = txs.find((t) => t.direction === 'out');
		const inTx = txs.find((t) => t.direction === 'in');

		// out с from_account, in с to_account.
		expect(outTx!.account_id).toBe(fromId);
		expect(inTx!.account_id).toBe(toId);
	});

	it('transfer: оба счёта создаются (бутстрап)', () => {
		recordFinanceEntry(
			{
				kind: 'transfer',
				from_account: { source: 'manual', name: 'Fake Transfer From', currency: 'RUB', kind: 'checking' },
				to_account: { source: 'manual', name: 'Fake Transfer To', currency: 'RUB', kind: 'cash' },
				amount: 1000, // synthetic-example
				currency: 'RUB',
			},
			deps,
		);

		// Два счёта созданы.
		expect(ledger.readAll('accounts')).toHaveLength(2);
	});

	it('transfer дедуп: повторный вызов с теми же данными — по-прежнему 2 записи', () => {
		const transferInput = {
			kind: 'transfer' as const,
			from_account: { source: 'manual', name: 'Fake Dedup From', currency: 'GEL', kind: 'checking' as const },
			to_account: { source: 'manual', name: 'Fake Dedup To', currency: 'GEL', kind: 'savings' as const },
			amount: 300, // synthetic-example
			currency: 'GEL',
		};

		recordFinanceEntry(transferInput, deps);
		recordFinanceEntry(transferInput, deps); // дубль

		// Дедуп: по-прежнему 2 транзакции (out + in), не 4.
		expect(ledger.readAll('transactions')).toHaveLength(2);
	});

	it('accounts_touched содержит оба счёта перевода', () => {
		// Обе валюты совпадают (гард: кросс-валютный transfer запрещён без fx_rate).
		const result = recordFinanceEntry(
			{
				kind: 'transfer',
				from_account: { source: 'manual', name: 'Fake Touched From', currency: 'USD', kind: 'checking' },
				to_account: { source: 'manual', name: 'Fake Touched To', currency: 'USD', kind: 'savings' },
				amount: 150, // synthetic-example
				currency: 'USD',
			},
			deps,
		);

		expect(result.accounts_touched).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// Блок 9: path-guard — запись в публичный репо запрещена
// ---------------------------------------------------------------------------

describe('record: path-guard защита публичного репо', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'record-pathguard-'));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('LedgerPathError если financeDir внутри publicRepoRoot', () => {
		// Намеренно создаём badLedger: financeDir под publicRepoRoot.
		const publicRoot = join(tmpDir, 'public-repo');
		const financeDir = join(publicRoot, 'raw', 'finance'); // ← ВНУТРИ публичного!

		const badLedger = new Ledger({ financeDir, publicRepoRoot: publicRoot });
		const badDeps: RecordDeps = { ledger: badLedger, nowFn: fakeNow };

		expect(() =>
			recordFinanceEntry(
				{
					kind: 'transaction',
					account: { source: 'manual', name: 'Fake Guard Test', currency: 'RUB', kind: 'checking' },
					amount: 1, // synthetic-example
					currency: 'RUB',
					direction: 'in',
				},
				badDeps,
			),
		).toThrow(LedgerPathError);
	});

	it('сообщение ошибки содержит "публичного репо"', () => {
		const publicRoot = join(tmpDir, 'public-repo');
		const financeDir = join(publicRoot, 'raw', 'finance');

		const badLedger = new Ledger({ financeDir, publicRepoRoot: publicRoot });
		const badDeps: RecordDeps = { ledger: badLedger, nowFn: fakeNow };

		let thrown: LedgerPathError | null = null;
		try {
			recordFinanceEntry(
				{
					kind: 'snapshot',
					account: { source: 'manual', name: 'Fake Guard Snap', currency: 'USD', kind: 'savings' },
					balance: 0, // synthetic-example
				},
				badDeps,
			);
		} catch (e) {
			if (e instanceof LedgerPathError) thrown = e;
		}

		expect(thrown).toBeInstanceOf(LedgerPathError);
		expect(thrown!.message).toContain('публичного репо');
	});
});

// ---------------------------------------------------------------------------
// Блок 10: корректность возвращаемого результата
// ---------------------------------------------------------------------------

describe('record: структура возвращаемого результата', () => {
	let tmpDir: string;
	let deps: RecordDeps;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'record-result-'));
		const result = makeDeps(tmpDir);
		deps = result.deps;
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('written содержит все записанные объекты', () => {
		// snapshot пишет AccountRecord + SnapshotRecord → written.length = 2.
		const result = recordFinanceEntry(
			{
				kind: 'snapshot',
				account: { source: 'manual', name: 'Fake Result Account', currency: 'USD', kind: 'checking' },
				balance: 100, // synthetic-example
			},
			deps,
		);

		// 1 AccountRecord (бутстрап) + 1 SnapshotRecord = 2.
		expect(result.written).toHaveLength(2);
	});

	it('written пуст при дедупе', () => {
		const input = {
			kind: 'transaction' as const,
			account: { source: 'manual', name: 'Fake Dedup Written', currency: 'RUB', kind: 'checking' as const },
			amount: 42, // synthetic-example
			currency: 'RUB',
			direction: 'in' as const,
		};

		recordFinanceEntry(input, deps); // первый вызов — пишет
		const second = recordFinanceEntry(input, deps); // дубль — ничего нового

		// При дедупе транзакция не добавлена, счёт уже существует → written пуст.
		expect(second.written).toHaveLength(0);
	});

	it('accounts_touched непустой при успешной записи', () => {
		const result = recordFinanceEntry(
			{
				kind: 'transaction',
				account: { source: 'manual', name: 'Fake Touched Account', currency: 'EUR', kind: 'checking' },
				amount: 75, // synthetic-example
				currency: 'EUR',
				direction: 'out',
			},
			deps,
		);

		expect(result.accounts_touched).toHaveLength(1);
		// id — opaque hex-32.
		expect(result.accounts_touched[0]!).toMatch(/^[0-9a-f]{32}$/);
	});

	it('balances содержит последний снапшот счёта если он был записан', () => {
		const result = recordFinanceEntry(
			{
				kind: 'snapshot',
				account: { source: 'manual', name: 'Fake Balance Check', currency: 'USDT', kind: 'exchange' },
				balance: 88.5, // synthetic-example
			},
			deps,
		);

		expect(result.balances).toHaveLength(1);
		expect(result.balances[0]!.balance).toBeCloseTo(88.5);
		expect(result.balances[0]!.currency).toBe('USDT');
	});

	it('deterministicId используется корректно: source|name|currency', () => {
		// Проверяем, что makeAccountId совпадает с ручным deterministicId.
		const source = 'manual';
		const name = 'Fake Manual Check'; // synthetic-example
		const currency = 'RUB';

		const expected = deterministicId(`${source}|${name}|${currency}`);
		const actual = makeAccountId(source, name, currency);

		expect(actual).toBe(expected);
	});
});

// ---------------------------------------------------------------------------
// Блок 11: negative-тесты входной валидации (ZodError на невалидный ввод)
// ---------------------------------------------------------------------------

describe('record: входная валидация — reject на невалидные данные', () => {
	let tmpDir: string;
	let deps: RecordDeps;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'record-validation-'));
		const result = makeDeps(tmpDir);
		deps = result.deps;
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('snapshot: отрицательный balance отклоняется (finite — не ограничение схемы, но проверяем NaN)', () => {
		// SnapshotInputSchema.balance = z.number().finite() — допускает отрицательные.
		// NaN/Infinity — должны отклоняться.
		expect(() =>
			recordFinanceEntry(
				{
					kind: 'snapshot',
					account: { source: 'manual', name: 'Fake Snap Nan', currency: 'RUB', kind: 'checking' },
					balance: NaN, // невалидный — не finite
				},
				deps,
			),
		).toThrow(); // ZodError: not finite
	});

	it('snapshot: Infinity balance отклоняется', () => {
		expect(() =>
			recordFinanceEntry(
				{
					kind: 'snapshot',
					account: { source: 'manual', name: 'Fake Snap Inf', currency: 'RUB', kind: 'checking' },
					balance: Infinity, // невалидный — not finite
				},
				deps,
			),
		).toThrow();
	});

	it('transaction: отрицательный amount отклоняется (схема требует positive)', () => {
		// TransactionInputSchema.amount = z.number().finite().positive() → -1 отклоняется.
		expect(() =>
			recordFinanceEntry(
				{
					kind: 'transaction',
					account: { source: 'manual', name: 'Fake Tx Neg', currency: 'RUB', kind: 'checking' },
					amount: -500, // невалидный — не positive
					currency: 'RUB',
					direction: 'out',
				},
				deps,
			),
		).toThrow();
	});

	it('transaction: нулевой amount отклоняется (схема требует positive)', () => {
		expect(() =>
			recordFinanceEntry(
				{
					kind: 'transaction',
					account: { source: 'manual', name: 'Fake Tx Zero', currency: 'RUB', kind: 'checking' },
					amount: 0, // невалидный — не positive (> 0)
					currency: 'RUB',
					direction: 'in',
				},
				deps,
			),
		).toThrow();
	});

	it('void: пустой void_id отклоняется (min(1))', () => {
		// VoidInputSchema.void_id = z.string().min(1) → пустая строка отклоняется.
		expect(() =>
			recordFinanceEntry(
				{
					kind: 'void',
					account: { source: 'manual', name: 'Fake Void Empty', currency: 'RUB', kind: 'checking' },
					void_id: '', // невалидный — пустая строка
					amount: 100, // synthetic-example
					currency: 'RUB',
					direction: 'in',
				},
				deps,
			),
		).toThrow();
	});

	it('amend: пустой amended_id отклоняется (min(1))', () => {
		// AmendInputSchema.amended_id = z.string().min(1) → пустая строка отклоняется.
		expect(() =>
			recordFinanceEntry(
				{
					kind: 'amend',
					account: { source: 'manual', name: 'Fake Amend Empty', currency: 'USD', kind: 'checking' },
					amended_id: '', // невалидный — пустая строка
					amount: 200, // synthetic-example
					currency: 'USD',
					direction: 'out',
				},
				deps,
			),
		).toThrow();
	});

	it('transaction: пустая currency отклоняется (min(1))', () => {
		// TransactionInputSchema.currency = z.string().min(1) → пустая строка отклоняется.
		expect(() =>
			recordFinanceEntry(
				{
					kind: 'transaction',
					account: { source: 'manual', name: 'Fake Tx NoCurrency', currency: 'RUB', kind: 'checking' },
					amount: 100, // synthetic-example
					currency: '', // невалидный — пустая строка
					direction: 'in',
				},
				deps,
			),
		).toThrow();
	});
});

// ---------------------------------------------------------------------------
// Блок 12: кросс-валютный transfer — гард
// ---------------------------------------------------------------------------

describe('record: кросс-валютный transfer — гард на несовпадение валют', () => {
	let tmpDir: string;
	let deps: RecordDeps;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'record-xfer-guard-'));
		const result = makeDeps(tmpDir);
		deps = result.deps;
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('transfer USD→RUB (разные валюты счетов) бросает Error (не UB)', () => {
		// Гард: from_account.currency=USD, to_account.currency=RUB ≠ transfer.currency=USD.
		// Без гарда in-нога была бы записана в USD на RUB-счёт — нарушение мультивалютного инварианта.
		expect(() =>
			recordFinanceEntry(
				{
					kind: 'transfer',
					from_account: { source: 'manual', name: 'Fake USD Source', currency: 'USD', kind: 'checking' },
					to_account: { source: 'manual', name: 'Fake RUB Dest', currency: 'RUB', kind: 'checking' },
					amount: 100, // synthetic-example
					currency: 'USD', // валюта исходника
				},
				deps,
			),
		).toThrow();
	});

	it('transfer RUB→RUB (одинаковые валюты) проходит без ошибки', () => {
		// Одновалютный перевод: from_account.currency === to_account.currency === currency.
		expect(() =>
			recordFinanceEntry(
				{
					kind: 'transfer',
					from_account: { source: 'manual', name: 'Fake RUB From', currency: 'RUB', kind: 'checking' },
					to_account: { source: 'manual', name: 'Fake RUB To', currency: 'RUB', kind: 'savings' },
					amount: 500, // synthetic-example
					currency: 'RUB',
				},
				deps,
			),
		).not.toThrow();
	});

	it('transfer USD→RUB: in-нога НЕ записывается (нет записей в транзакциях)', () => {
		// Убеждаемся, что при броске Error никаких записей не создаётся (транзакционность).
		try {
			recordFinanceEntry(
				{
					kind: 'transfer',
					from_account: { source: 'manual', name: 'Fake USD Src2', currency: 'USD', kind: 'checking' },
					to_account: { source: 'manual', name: 'Fake RUB Dst2', currency: 'RUB', kind: 'checking' },
					amount: 200, // synthetic-example
					currency: 'USD',
				},
				deps,
			);
		} catch {
			// ожидаемый throw
		}
		// Гард бросает ДО записи → транзакций нет.
		expect(deps.ledger.readAll('transactions')).toHaveLength(0);
	});
});
