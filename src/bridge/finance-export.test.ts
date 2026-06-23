/**
 * finance-export.test.ts — тесты экспорта финансовых данных (ADR-0023, ADR-0011).
 *
 * Принципы:
 *   - Все данные синтетические (fake-example, без реальных счетов/сумм/PII).
 *   - Нет реальных сетевых запросов. TelegramClient мокируется.
 *   - Ledger работает с tmp-dir (mkdtempSync → rmSync), path-guard отключён.
 *   - nowFn инъектируется для детерминированного времени.
 *   - Импорт ТОЛЬКО из bridge/finance-export, bridge/telegram (типы), ingest/finance/*.
 *
 * Покрытие:
 *   1. escapeCsvField — экранирование полей CSV (RFC 4180).
 *   2. buildTransactionsCsv — детерминированная сборка CSV из транзакций.
 *   3. buildAccountBalanceRows — выбор последнего снапшота + присоединение счетов.
 *   4. formatAccountsTableText — моноширинная таблица с выравниванием.
 *   5. buildAccountsTablePng — PNG-буфер из строк таблицы.
 *   6. sendTransactionsCsv — тонкий адаптер: вызывает sendDocument с корректным payload.
 *   7. sendAccountsTable — тонкий адаптер: вызывает sendDocument с PNG-payload.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Ledger } from '../ingest/finance/ledger.js';
import { recordFinanceEntry } from '../ingest/finance/record.js';
import type { AccountRecord, SnapshotRecord, TransactionRecord } from '../ingest/finance/types.js';
import type { TelegramClient, InputFile, SendMediaOptions } from './telegram.js';
import {
	buildAccountBalanceRows,
	buildAccountsTablePng,
	buildTransactionsCsv,
	escapeCsvField,
	formatAccountsTableText,
	sendAccountsTable,
	sendTransactionsCsv,
} from './finance-export.js';

// ---------------------------------------------------------------------------
// Утилиты и синтетические фикстуры
// ---------------------------------------------------------------------------

/** Фиксированный момент времени для инъекции nowFn (синтетический). */
const FAKE_NOW = new Date('2026-06-23T10:00:00Z');
const fakeNowFn = () => FAKE_NOW;

/** Создаёт Ledger в tmp-каталоге с отключённым path-guard. */
function makeTmpLedger(): { ledger: Ledger; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), 'finance-export-test-'));
	const ledger = new Ledger({
		financeDir: dir,
		publicRepoRoot: join(tmpdir(), 'fake-public-repo-export'),
	});
	return { ledger, dir };
}

/** Магия PNG: первые 4 байта файла (0x89 'P' 'N' 'G'). */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

/** Проверяет что буфер — валидный PNG. */
function expectValidPng(buf: Buffer | null): void {
	expect(buf).not.toBeNull();
	expect(Buffer.isBuffer(buf)).toBe(true);
	expect(buf!.length).toBeGreaterThan(PNG_MAGIC.length);
	for (let i = 0; i < PNG_MAGIC.length; i++) {
		expect(buf![i]).toBe(PNG_MAGIC[i]);
	}
}

/**
 * Создаёт мок TelegramClient. Записывает sendPhoto/sendDocument вызовы.
 */
function makeMockTelegramClient() {
	const sentDocuments: Array<{ chatId: number; doc: InputFile; opts?: SendMediaOptions }> = [];
	const sentPhotos: Array<{ chatId: number; photo: InputFile; opts?: SendMediaOptions }> = [];

	const mock: TelegramClient = {
		sendMessage: vi.fn(async () => {}),
		sendPhoto: vi.fn(async (chatId: number, photo: InputFile, opts?: SendMediaOptions) => {
			sentPhotos.push({ chatId, photo, opts });
		}),
		sendDocument: vi.fn(async (chatId: number, doc: InputFile, opts?: SendMediaOptions) => {
			sentDocuments.push({ chatId, doc, opts });
		}),
		answerCallbackQuery: vi.fn(async () => {}),
		sendChatAction: vi.fn(async () => {}),
		getMe: vi.fn(async () => ({})),
		getUpdates: vi.fn(async () => []),
		deleteWebhook: vi.fn(async () => {}),
		aclose: vi.fn(async () => {}),
	};

	return { mock, sentDocuments, sentPhotos };
}

// ---------------------------------------------------------------------------
// 1. escapeCsvField — RFC 4180 экранирование
// ---------------------------------------------------------------------------

describe('escapeCsvField', () => {
	it('простая строка → без изменений', () => {
		expect(escapeCsvField('grocery')).toBe('grocery');
		expect(escapeCsvField('salary')).toBe('salary');
		expect(escapeCsvField('2026-06-23T10:00:00Z')).toBe('2026-06-23T10:00:00Z');
	});

	it('undefined/null/пустая строка → пустая строка', () => {
		expect(escapeCsvField(undefined)).toBe('');
		expect(escapeCsvField(null)).toBe('');
		expect(escapeCsvField('')).toBe('');
	});

	it('строка с запятой → оборачивается в кавычки', () => {
		expect(escapeCsvField('a,b')).toBe('"a,b"');
		expect(escapeCsvField('one,two,three')).toBe('"one,two,three"');
	});

	it('строка с кавычками → кавычки дублируются', () => {
		expect(escapeCsvField('say "hello"')).toBe('"say ""hello"""');
	});

	it('строка с переводом строки → оборачивается в кавычки', () => {
		const result = escapeCsvField('line1\nline2');
		expect(result).toBe('"line1\nline2"');
	});

	it('строка с кавычками и запятой → корректное RFC-4180', () => {
		expect(escapeCsvField('"value", with comma')).toBe('"""value"", with comma"');
	});
});

// ---------------------------------------------------------------------------
// 2. buildTransactionsCsv — детерминированность
// ---------------------------------------------------------------------------

describe('buildTransactionsCsv', () => {
	it('пустой массив → только заголовок (без trailing newline)', () => {
		const csv = buildTransactionsCsv([]);
		// Только header, нет строк данных.
		const lines = csv.split('\n');
		// Заголовок должен содержать ключевые поля.
		expect(lines[0]).toContain('id');
		expect(lines[0]).toContain('ts');
		expect(lines[0]).toContain('amount');
		expect(lines[0]).toContain('currency');
		expect(lines[0]).toContain('direction');
		// Нет строк данных.
		expect(lines.length).toBe(1);
	});

	it('одна транзакция → header + одна строка данных', () => {
		// Синтетическая транзакция-запись.
		const fakeTx: TransactionRecord = {
			id: 'fake-tx-001',
			ts: '2026-06-23T10:00:00Z',
			account_id: 'fake-account-001',
			direction: 'out',
			amount: 1500,
			currency: 'RUB',
			category: 'grocery',
		};

		const csv = buildTransactionsCsv([fakeTx]);
		const lines = csv.split('\n');

		// Header + одна строка.
		expect(lines).toHaveLength(2);
		// Строка данных содержит все ключевые поля.
		expect(lines[1]).toContain('fake-tx-001');
		expect(lines[1]).toContain('1500');
		expect(lines[1]).toContain('RUB');
		expect(lines[1]).toContain('out');
		expect(lines[1]).toContain('grocery');
	});

	it('несколько транзакций → отсортированы по ts ASC', () => {
		const txs: TransactionRecord[] = [
			{
				id: 'fake-tx-c',
				ts: '2026-06-23T12:00:00Z',
				account_id: 'fake-acc',
				direction: 'out',
				amount: 300,
				currency: 'RUB',
			},
			{
				id: 'fake-tx-a',
				ts: '2026-06-21T10:00:00Z',
				account_id: 'fake-acc',
				direction: 'in',
				amount: 5000,
				currency: 'RUB',
			},
			{
				id: 'fake-tx-b',
				ts: '2026-06-22T10:00:00Z',
				account_id: 'fake-acc',
				direction: 'out',
				amount: 200,
				currency: 'RUB',
			},
		];

		const csv = buildTransactionsCsv(txs);
		const lines = csv.split('\n').slice(1); // без header

		// Должны идти в порядке ts ASC: 21 → 22 → 23.
		expect(lines[0]).toContain('fake-tx-a');
		expect(lines[1]).toContain('fake-tx-b');
		expect(lines[2]).toContain('fake-tx-c');
	});

	it('детерминированность: одни данные → одна строка (two calls)', () => {
		const txs: TransactionRecord[] = [
			{
				id: 'fake-determ-tx',
				ts: '2026-06-23T09:00:00Z',
				account_id: 'fake-acc',
				direction: 'out',
				amount: 999,
				currency: 'USDT',
			},
		];

		const csv1 = buildTransactionsCsv(txs);
		const csv2 = buildTransactionsCsv(txs);
		expect(csv1).toBe(csv2);
	});

	it('поле category с запятой → экранируется корректно', () => {
		const tx: TransactionRecord = {
			id: 'fake-comma-tx',
			ts: '2026-06-23T10:00:00Z',
			account_id: 'fake-acc',
			direction: 'out',
			amount: 100,
			currency: 'RUB',
			category: 'food, drinks',
		};

		const csv = buildTransactionsCsv([tx]);
		const dataLine = csv.split('\n')[1]!;
		// category должна быть в кавычках (RFC 4180).
		expect(dataLine).toContain('"food, drinks"');
	});

	it('не мутирует входной массив (проверка порядка оригинала)', () => {
		const txs: TransactionRecord[] = [
			{
				id: 'fake-mut-b',
				ts: '2026-06-22T10:00:00Z',
				account_id: 'acc',
				direction: 'out',
				amount: 10,
				currency: 'RUB',
			},
			{
				id: 'fake-mut-a',
				ts: '2026-06-21T10:00:00Z',
				account_id: 'acc',
				direction: 'in',
				amount: 20,
				currency: 'RUB',
			},
		];

		// Сохраняем оригинальный порядок.
		const origOrder = txs.map((t) => t.id);
		buildTransactionsCsv(txs);
		// Массив не должен быть мутирован.
		expect(txs.map((t) => t.id)).toEqual(origOrder);
	});
});

// ---------------------------------------------------------------------------
// 3. buildAccountBalanceRows — снапшоты + счета
// ---------------------------------------------------------------------------

describe('buildAccountBalanceRows', () => {
	it('пустые снапшоты → пустой массив', () => {
		const rows = buildAccountBalanceRows([], [], '2026-06-23T10:00:00Z');
		expect(rows).toHaveLength(0);
	});

	it('один снапшот → одна строка с name из AccountRecord', () => {
		const snapshots: SnapshotRecord[] = [
			{
				ts: '2026-06-23T09:00:00Z',
				account_id: 'fake-acc-rub',
				balance: 50000,
				currency: 'RUB',
			},
		];
		const accounts: AccountRecord[] = [
			{
				id: 'fake-acc-rub',
				source: 'manual',
				kind: 'checking',
				name: 'Fake RUB Account',
				currency: 'RUB',
			},
		];

		const rows = buildAccountBalanceRows(snapshots, accounts, '2026-06-23T10:00:00Z');

		expect(rows).toHaveLength(1);
		expect(rows[0]!.name).toBe('Fake RUB Account');
		expect(rows[0]!.balance).toBe(50000);
		expect(rows[0]!.currency).toBe('RUB');
		expect(rows[0]!.kind).toBe('checking');
	});

	it('два снапшота одного счёта → берётся последний (по ts)', () => {
		const snapshots: SnapshotRecord[] = [
			{ ts: '2026-06-10T10:00:00Z', account_id: 'acc-old', balance: 100, currency: 'USD' },
			{ ts: '2026-06-23T10:00:00Z', account_id: 'acc-old', balance: 200, currency: 'USD' },
		];

		const rows = buildAccountBalanceRows(snapshots, [], '2026-06-23T12:00:00Z');

		// Только одна строка, баланс — 200 (последний снапшот).
		expect(rows).toHaveLength(1);
		expect(rows[0]!.balance).toBe(200);
	});

	it('снапшот после asOf → не включается', () => {
		const snapshots: SnapshotRecord[] = [
			{ ts: '2026-06-24T10:00:00Z', account_id: 'future-acc', balance: 999, currency: 'RUB' },
		];

		// asOf = 23 июня, снапшот 24 июня → не берётся.
		const rows = buildAccountBalanceRows(snapshots, [], '2026-06-23T10:00:00Z');
		expect(rows).toHaveLength(0);
	});

	it('нет AccountRecord для account_id → fallback к account_id как name', () => {
		const snapshots: SnapshotRecord[] = [
			{ ts: '2026-06-23T10:00:00Z', account_id: 'orphan-acc-id', balance: 100, currency: 'USDT' },
		];

		// accounts пустой — имя = account_id (fallback).
		const rows = buildAccountBalanceRows(snapshots, [], '2026-06-23T12:00:00Z');

		expect(rows[0]!.name).toBe('orphan-acc-id');
		expect(rows[0]!.kind).toBe('unknown');
	});

	it('результат отсортирован по kind, затем по name', () => {
		const snapshots: SnapshotRecord[] = [
			{ ts: '2026-06-23T10:00:00Z', account_id: 'acc-2', balance: 100, currency: 'RUB' },
			{ ts: '2026-06-23T10:00:00Z', account_id: 'acc-1', balance: 200, currency: 'RUB' },
			{ ts: '2026-06-23T10:00:00Z', account_id: 'acc-3', balance: 300, currency: 'USDT' },
		];
		const accounts: AccountRecord[] = [
			{ id: 'acc-1', source: 'manual', kind: 'savings', name: 'Fake Savings', currency: 'RUB' },
			{ id: 'acc-2', source: 'manual', kind: 'checking', name: 'Fake Checking', currency: 'RUB' },
			{ id: 'acc-3', source: 'manual', kind: 'exchange', name: 'Fake Exchange', currency: 'USDT' },
		];

		const rows = buildAccountBalanceRows(snapshots, accounts, '2026-06-23T12:00:00Z');

		// Сортировка: checking < exchange < savings (лексикографически).
		expect(rows[0]!.kind).toBe('checking');
		expect(rows[1]!.kind).toBe('exchange');
		expect(rows[2]!.kind).toBe('savings');
	});
});

// ---------------------------------------------------------------------------
// 4. formatAccountsTableText — моноширинная таблица с выравниванием
// ---------------------------------------------------------------------------

describe('formatAccountsTableText', () => {
	it('пустые строки → "(нет данных)"', () => {
		expect(formatAccountsTableText([])).toBe('(нет данных)');
	});

	it('одна строка → header + separator + data line', () => {
		const rows = [
			{ name: 'Fake Account', currency: 'RUB', balance: 50000, kind: 'checking' },
		];
		const table = formatAccountsTableText(rows);
		const lines = table.split('\n');

		// Должно быть: header, separator, data.
		expect(lines.length).toBeGreaterThanOrEqual(3);
		// Header содержит имена колонок.
		expect(lines[0]).toContain('ТИП');
		expect(lines[0]).toContain('СЧЁТ');
		expect(lines[0]).toContain('ВАЛЮТА');
		expect(lines[0]).toContain('БАЛАНС');
		// Separator из дефисов.
		expect(lines[1]).toMatch(/^[-\s]+$/);
		// Строка данных содержит значения.
		expect(lines[2]).toContain('checking');
		expect(lines[2]).toContain('Fake Account');
		expect(lines[2]).toContain('RUB');
		expect(lines[2]).toContain('50000');
	});

	it('все строки одинаковой длины в колонке (выравнивание пробелами)', () => {
		const rows = [
			{ name: 'Short', currency: 'RUB', balance: 100, kind: 'cash' },
			{ name: 'Very Long Account Name', currency: 'USD', balance: 9999, kind: 'checking' },
		];
		const table = formatAccountsTableText(rows);
		const lines = table.split('\n');

		// Header и строки данных должны иметь одинаковую длину (±1 для дробных чисел).
		// Принцип: строки отличаются только данными, а не выравниванием.
		// Проверяем что header и data-строки — одного порядка длины.
		const headerLen = lines[0]!.length;
		const dataLines = lines.slice(2);
		for (const line of dataLines) {
			// Длина каждой строки данных должна совпадать с длиной header (±1).
			expect(Math.abs(line.length - headerLen)).toBeLessThanOrEqual(1);
		}
	});

	it('дробный баланс → форматируется с 2 знаками', () => {
		const rows = [
			{ name: 'Fake Crypto', currency: 'USDT', balance: 42.5, kind: 'exchange' },
		];
		const table = formatAccountsTableText(rows);
		expect(table).toContain('42.50');
	});

	it('целый баланс → без дробной части', () => {
		const rows = [
			{ name: 'Fake RUB', currency: 'RUB', balance: 100000, kind: 'checking' },
		];
		const table = formatAccountsTableText(rows);
		// Нет ".00" для целых.
		expect(table).not.toContain('100000.00');
		expect(table).toContain('100000');
	});
});

// ---------------------------------------------------------------------------
// 5. buildAccountsTablePng — PNG-буфер из строк таблицы
// ---------------------------------------------------------------------------

describe('buildAccountsTablePng', () => {
	it('пустые строки → null (нет данных для PNG)', () => {
		const result = buildAccountsTablePng([]);
		expect(result).toBeNull();
	});

	it('строки с балансами → валидный PNG-буфер', () => {
		const rows = [
			{ name: 'Fake Bank RUB', currency: 'RUB', balance: 100000, kind: 'checking' },
			{ name: 'Fake Crypto USDT', currency: 'USDT', balance: 300, kind: 'exchange' },
		];
		const png = buildAccountsTablePng(rows);
		expectValidPng(png);
	});

	it('одна строка → валидный PNG (не падает на одном элементе)', () => {
		const rows = [
			{ name: 'Fake Single', currency: 'GEL', balance: 500, kind: 'cash' },
		];
		const png = buildAccountsTablePng(rows);
		expectValidPng(png);
	});

	it('нулевой баланс → PNG строится (счёт с нулём существует)', () => {
		const rows = [
			{ name: 'Fake Zero', currency: 'RUB', balance: 0, kind: 'savings' },
		];
		const png = buildAccountsTablePng(rows);
		// buildAccountsTablePng не фильтрует нули (это балансы счетов, не расходы).
		expectValidPng(png);
	});
});

// ---------------------------------------------------------------------------
// 6. sendTransactionsCsv — тонкий адаптер
// ---------------------------------------------------------------------------

describe('sendTransactionsCsv', () => {
	let dir: string;
	let ledger: Ledger;

	beforeEach(() => {
		const tmp = makeTmpLedger();
		dir = tmp.dir;
		ledger = tmp.ledger;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('пустой леджер → sendDocument вызван с header-only CSV', async () => {
		const { mock, sentDocuments } = makeMockTelegramClient();

		const count = await sendTransactionsCsv(ledger, mock, 42, fakeNowFn);

		// Транзакций нет.
		expect(count).toBe(0);
		// sendDocument вызван один раз.
		expect(sentDocuments).toHaveLength(1);

		const doc = sentDocuments[0]!;
		expect(doc.chatId).toBe(42);
		expect(doc.doc.filename).toBe('transactions.csv');
		expect(doc.doc.contentType).toBe('text/csv');

		// Payload — непустой буфер (header CSV).
		expect(Buffer.isBuffer(doc.doc.data)).toBe(true);
		expect(doc.doc.data!.length).toBeGreaterThan(0);

		// Caption не содержит точных сумм (secret-gate).
		expect(doc.opts?.caption).toContain('0 записей');
		expect(doc.opts?.caption).toContain('2026-06-23');
	});

	it('леджер с транзакциями → CSV содержит корректные данные', async () => {
		// Записываем транзакции через record.ts.
		const account = { source: 'manual', name: 'Fake Export Account', currency: 'RUB', kind: 'checking' as const };
		recordFinanceEntry(
			{
				kind: 'transaction',
				account,
				amount: 80000,
				currency: 'RUB',
				direction: 'in',
				category: 'salary',
			},
			{ ledger, nowFn: fakeNowFn },
		);
		recordFinanceEntry(
			{
				kind: 'transaction',
				account,
				amount: 1500,
				currency: 'RUB',
				direction: 'out',
				category: 'grocery',
			},
			{ ledger, nowFn: fakeNowFn },
		);

		const { mock, sentDocuments } = makeMockTelegramClient();

		const count = await sendTransactionsCsv(ledger, mock, 99, fakeNowFn);

		expect(count).toBe(2);
		expect(sentDocuments).toHaveLength(1);

		const doc = sentDocuments[0]!;
		// Decode CSV из буфера.
		const csvContent = doc.doc.data!.toString('utf-8');
		expect(csvContent).toContain('salary');
		expect(csvContent).toContain('grocery');
		expect(csvContent).toContain('80000');
		expect(csvContent).toContain('1500');

		// Caption содержит количество (secret-gate: не суммы).
		expect(doc.opts?.caption).toContain('2 записей');
	});
});

// ---------------------------------------------------------------------------
// 7. sendAccountsTable — тонкий адаптер
// ---------------------------------------------------------------------------

describe('sendAccountsTable', () => {
	let dir: string;
	let ledger: Ledger;

	beforeEach(() => {
		const tmp = makeTmpLedger();
		dir = tmp.dir;
		ledger = tmp.ledger;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('пустой леджер → sendDocument НЕ вызван, возвращает false', async () => {
		const { mock } = makeMockTelegramClient();

		const sent = await sendAccountsTable(ledger, mock, 42, fakeNowFn);

		expect(sent).toBe(false);
		expect(mock.sendDocument).not.toHaveBeenCalled();
	});

	it('леджер со снапшотами → sendDocument вызван с PNG-payload', async () => {
		// Записываем снапшоты.
		recordFinanceEntry(
			{
				kind: 'snapshot',
				account: { source: 'manual', name: 'Fake Table RUB', currency: 'RUB', kind: 'checking' },
				balance: 75000,
			},
			{ ledger, nowFn: fakeNowFn },
		);
		recordFinanceEntry(
			{
				kind: 'snapshot',
				account: { source: 'manual', name: 'Fake Table USDT', currency: 'USDT', kind: 'exchange' },
				balance: 150,
			},
			{ ledger, nowFn: fakeNowFn },
		);

		const { mock, sentDocuments } = makeMockTelegramClient();

		const sent = await sendAccountsTable(ledger, mock, 123, fakeNowFn);

		expect(sent).toBe(true);
		expect(sentDocuments).toHaveLength(1);

		const doc = sentDocuments[0]!;
		expect(doc.chatId).toBe(123);
		expect(doc.doc.filename).toBe('accounts.png');
		expect(doc.doc.contentType).toBe('image/png');

		// Payload — валидный PNG.
		expectValidPng(doc.doc.data as Buffer);

		// Caption без точных балансов (secret-gate: только количество счетов и дата).
		expect(doc.opts?.caption).toContain('2 счетов');
		expect(doc.opts?.caption).toContain('2026-06-23');
	});

	it('caption не содержит точных балансов (secret-gate ADR-0011)', async () => {
		// Записываем снапшот с конкретным балансом.
		recordFinanceEntry(
			{
				kind: 'snapshot',
				account: { source: 'manual', name: 'Fake Secret Gate Account', currency: 'RUB', kind: 'checking' },
				balance: 127456,
			},
			{ ledger, nowFn: fakeNowFn },
		);

		const { mock, sentDocuments } = makeMockTelegramClient();
		await sendAccountsTable(ledger, mock, 1, fakeNowFn);

		const caption = sentDocuments[0]!.opts?.caption ?? '';
		// Caption не должен содержать точный баланс 127456.
		expect(caption).not.toContain('127456');
		// Только количество счетов и дата.
		expect(caption).toContain('1 счетов');
	});
});

// ---------------------------------------------------------------------------
// 8. E2E: Ledger → buildTransactionsCsv детерминизм при полном цикле записи
// ---------------------------------------------------------------------------

describe('E2E детерминизм CSV при записи через Ledger', () => {
	let dir: string;
	let ledger: Ledger;

	beforeEach(() => {
		const tmp = makeTmpLedger();
		dir = tmp.dir;
		ledger = tmp.ledger;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('одни и те же транзакции → CSV не изменяется между вызовами', () => {
		const account = {
			source: 'manual',
			name: 'Fake Determinism Account',
			currency: 'RUB',
			kind: 'checking' as const,
		};
		recordFinanceEntry(
			{
				kind: 'transaction',
				account,
				amount: 25000,
				currency: 'RUB',
				direction: 'in',
				category: 'salary',
				ts: '2026-06-01T09:00:00Z',
			},
			{ ledger, nowFn: fakeNowFn },
		);

		const csv1 = buildTransactionsCsv(ledger.readAll('transactions'));
		const csv2 = buildTransactionsCsv(ledger.readAll('transactions'));

		// Детерминизм: два последовательных вызова → одинаковый результат.
		expect(csv1).toBe(csv2);
		// Содержит нашу транзакцию.
		expect(csv1).toContain('salary');
		expect(csv1).toContain('25000');
	});
});
