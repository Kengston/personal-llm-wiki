/**
 * finance-intent.test.ts — тесты реактивного шва финансового диспетчера (ADR-0024).
 *
 * Принципы:
 *   - Все данные синтетические (fake-example, без реальных счетов/сумм/PII).
 *   - Нет реальных сетевых запросов, нет реального claude-бинаря.
 *   - Engine мокируется через объект с методом run() → fake EngineResult.
 *   - TelegramClient мокируется (не нужен напрямую, только для BridgeState).
 *   - Ledger работает с tmp-dir (mkdtempSync → rmSync), path-guard отключён через opts.
 *   - nowFn инъектируется для детерминированного времени.
 *
 * Покрытие:
 *   1. extractFinanceIntent: валидный блок → intent; нет блока → null; кривой JSON → null.
 *   2. dispatchFinanceIntent: record/void/transfer → реально пишут в Ledger (tmp-dir).
 *   3. dispatchFinanceIntent: create_goal → создаёт валидную страницу.
 *   4. dispatchFinanceIntent: query → ничего не пишет в Ledger.
 *   5. formatReadback: детерминированный текст по структурному результату.
 *   6. Флоу owner→Engine(mock)→dispatch→readback на 4 примерах.
 *   7. buildFinanceContextSummary: корректная сводка из снапшотов/транзакций.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Ledger } from '../ingest/finance/ledger.js';
import { recordFinanceEntry } from '../ingest/finance/record.js';
import {
	buildFinanceContextSummary,
	dispatchFinanceIntent,
	extractFinanceIntent,
	formatReadback,
	type FinanceIntent,
	type FinanceIntentDeps,
} from './finance-intent.js';

// ---------------------------------------------------------------------------
// Утилиты и синтетические данные
// ---------------------------------------------------------------------------

/** Фиксированный момент времени для инъекции nowFn (синтетический). */
const FAKE_NOW = new Date('2026-06-23T10:00:00Z');
const fakeNowFn = () => FAKE_NOW;

/** Создаёт Ledger в tmp-каталоге с отключённым path-guard (для тестов). */
function makeTmpLedger(): { ledger: Ledger; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), 'finance-intent-test-'));
	const ledger = new Ledger({
		financeDir: dir,
		// publicRepoRoot — заведомо другой путь → path-guard позволит запись в dir.
		publicRepoRoot: join(tmpdir(), 'fake-public-repo'),
	});
	return { ledger, dir };
}

/** Синтетический ответ движка с валидным finance-intent блоком. */
function makeEngineAnswer(intent: FinanceIntent): string {
	const jsonStr = JSON.stringify(intent);
	return `Записал транзакцию.\n\`\`\`finance-intent\n${jsonStr}\n\`\`\`\n\nГотово!`;
}

// ---------------------------------------------------------------------------
// 1. extractFinanceIntent
// ---------------------------------------------------------------------------

describe('extractFinanceIntent', () => {
	it('валидный блок record_balance → корректный intent', () => {
		const answer = `Записал баланс.
\`\`\`finance-intent
{"type":"record_balance","account":{"source":"manual","name":"Fake Wallet RUB","currency":"RUB","kind":"checking"},"balance":50000}
\`\`\`
Всё записано!`;

		const intent = extractFinanceIntent(answer);
		expect(intent).not.toBeNull();
		expect(intent!.type).toBe('record_balance');
		if (intent?.type === 'record_balance') {
			expect(intent.balance).toBe(50000);
			expect(intent.account.currency).toBe('RUB');
			expect(intent.account.name).toBe('Fake Wallet RUB');
		}
	});

	it('валидный блок record_expense → intent с категорией', () => {
		const answer = makeEngineAnswer({
			type: 'record_expense',
			account: { source: 'manual', name: 'Fake Account USD', currency: 'USD', kind: 'checking' },
			amount: 42.5,
			currency: 'USD',
			category: 'grocery',
			note: 'Supermarket',
		});

		const intent = extractFinanceIntent(answer);
		expect(intent).not.toBeNull();
		expect(intent!.type).toBe('record_expense');
		if (intent?.type === 'record_expense') {
			expect(intent.amount).toBe(42.5);
			expect(intent.category).toBe('grocery');
		}
	});

	it('нет блока finance-intent → null (обычный текстовый ответ)', () => {
		const answer = 'Привет! Как дела? Никаких финансов здесь нет.';
		expect(extractFinanceIntent(answer)).toBeNull();
	});

	it('пустой ответ → null', () => {
		expect(extractFinanceIntent('')).toBeNull();
	});

	it('блок с невалидным JSON → null (безопасный graceful fallback)', () => {
		const answer = '```finance-intent\n{это не json!!!\n```';
		expect(extractFinanceIntent(answer)).toBeNull();
	});

	it('блок с валидным JSON но невалидной схемой → null', () => {
		// type = unknown_type не входит в discriminated union
		const answer = '```finance-intent\n{"type":"unknown_type","foo":"bar"}\n```';
		expect(extractFinanceIntent(answer)).toBeNull();
	});

	it('блок с пустым телом → null', () => {
		const answer = '```finance-intent\n\n```';
		expect(extractFinanceIntent(answer)).toBeNull();
	});

	it('валидный блок query с query_kind=net_worth → intent', () => {
		const answer = '```finance-intent\n{"type":"query","query_kind":"net_worth"}\n```';
		const intent = extractFinanceIntent(answer);
		expect(intent?.type).toBe('query');
		if (intent?.type === 'query') {
			expect(intent.query_kind).toBe('net_worth');
		}
	});

	it('валидный блок create_goal → intent со slug', () => {
		const answer = makeEngineAnswer({
			type: 'create_goal',
			goal_id: 'fake-fund-2026',
			title: 'Fake Emergency Fund',
			target_amount: 100000,
			currency: 'RUB',
			target_date: '2026-12-31',
			fin_kind: 'save',
		});
		const intent = extractFinanceIntent(answer);
		expect(intent?.type).toBe('create_goal');
		if (intent?.type === 'create_goal') {
			expect(intent.goal_id).toBe('fake-fund-2026');
			expect(intent.fin_kind).toBe('save');
		}
	});
});

// ---------------------------------------------------------------------------
// 2. dispatchFinanceIntent — record/void/transfer пишут в Ledger
// ---------------------------------------------------------------------------

describe('dispatchFinanceIntent — запись в Ledger', () => {
	let dir: string;
	let ledger: Ledger;
	let deps: FinanceIntentDeps;

	beforeEach(() => {
		const tmp = makeTmpLedger();
		dir = tmp.dir;
		ledger = tmp.ledger;
		deps = { ledger, nowFn: fakeNowFn };
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('record_balance → записывает SnapshotRecord в Ledger', async () => {
		const intent: FinanceIntent = {
			type: 'record_balance',
			account: { source: 'manual', name: 'Fake Bank RUB', currency: 'RUB', kind: 'checking' },
			balance: 75000,
		};

		const result = await dispatchFinanceIntent(intent, deps);

		// Проверяем что снапшот записан.
		const snapshots = ledger.readAll('snapshots');
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]!.balance).toBe(75000);
		expect(snapshots[0]!.currency).toBe('RUB');

		// Проверяем структуру результата.
		expect(result.intent.type).toBe('record_balance');
		expect(result.balances).toHaveLength(1);
		expect(result.balances[0]!.balance).toBe(75000);
		expect(result.queryContext).toBeNull();
		expect(result.goalPage).toBeNull();
	});

	it('record_cash → записывает снапшот со счётом kind=cash', async () => {
		const intent: FinanceIntent = {
			type: 'record_cash',
			account: { source: 'manual', name: 'Fake Cash USD', currency: 'USD', kind: 'cash' },
			balance: 200,
		};

		await dispatchFinanceIntent(intent, deps);

		const accounts = ledger.readAll('accounts');
		// Счёт должен быть создан автоматически (bootstrap)
		expect(accounts[0]!.kind).toBe('cash');
		expect(accounts[0]!.currency).toBe('USD');

		const snapshots = ledger.readAll('snapshots');
		expect(snapshots[0]!.balance).toBe(200);
	});

	it('record_income → записывает TransactionRecord direction:in', async () => {
		const intent: FinanceIntent = {
			type: 'record_income',
			account: { source: 'manual', name: 'Fake Salary Account', currency: 'RUB', kind: 'checking' },
			amount: 80000,
			currency: 'RUB',
			category: 'salary',
		};

		const result = await dispatchFinanceIntent(intent, deps);

		const txs = ledger.readAll('transactions');
		expect(txs).toHaveLength(1);
		expect(txs[0]!.direction).toBe('in');
		expect(txs[0]!.amount).toBe(80000);
		expect(txs[0]!.category).toBe('salary');

		expect(result.summary).toContain('+80000 RUB');
		expect(result.summary).toContain('salary');
	});

	it('record_expense → записывает TransactionRecord direction:out', async () => {
		const intent: FinanceIntent = {
			type: 'record_expense',
			account: { source: 'manual', name: 'Fake Card', currency: 'RUB', kind: 'checking' },
			amount: 1500,
			currency: 'RUB',
			category: 'grocery',
		};

		await dispatchFinanceIntent(intent, deps);

		const txs = ledger.readAll('transactions');
		expect(txs[0]!.direction).toBe('out');
		expect(txs[0]!.amount).toBe(1500);
	});

	it('transfer → записывает ДВЕ связанные записи (out + in)', async () => {
		const intent: FinanceIntent = {
			type: 'transfer',
			from_account: { source: 'manual', name: 'Fake Account A', currency: 'RUB', kind: 'checking' },
			to_account: { source: 'manual', name: 'Fake Account B', currency: 'RUB', kind: 'savings' },
			amount: 10000,
			currency: 'RUB',
		};

		const result = await dispatchFinanceIntent(intent, deps);

		const txs = ledger.readAll('transactions');
		// Два аккаунта + 2 транзакции (out + in)
		expect(txs).toHaveLength(2);
		const outTx = txs.find((t) => t.direction === 'out');
		const inTx = txs.find((t) => t.direction === 'in');
		expect(outTx).toBeDefined();
		expect(inTx).toBeDefined();
		// Обе транзакции связаны одним transfer_id
		expect(outTx!.transfer_id).toBe(inTx!.transfer_id);
		expect(outTx!.transfer_id).toBeTruthy();

		expect(result.summary).toContain('10000 RUB');
		expect(result.summary).toContain('Fake Account A');
		expect(result.summary).toContain('Fake Account B');
	});

	it('void → записывает сторно-транзакцию с void_id', async () => {
		// Сначала создаём транзакцию.
		recordFinanceEntry(
			{
				kind: 'transaction',
				account: { source: 'manual', name: 'Fake Void Account', currency: 'RUB', kind: 'checking' },
				amount: 500,
				currency: 'RUB',
				direction: 'out',
				note: 'fake-note',
			},
			{ ledger, nowFn: fakeNowFn },
		);

		// Читаем id первой транзакции.
		const txsBefore = ledger.readAll('transactions');
		expect(txsBefore).toHaveLength(1);
		const originalTxId = txsBefore[0]!.id;

		// Теперь аннулируем её.
		const intent: FinanceIntent = {
			type: 'void',
			account: { source: 'manual', name: 'Fake Void Account', currency: 'RUB', kind: 'checking' },
			void_id: originalTxId,
			amount: 500,
			currency: 'RUB',
			direction: 'in', // обратное направление для сторно
		};

		await dispatchFinanceIntent(intent, deps);

		const txsAfter = ledger.readAll('transactions');
		// Оригинал + сторно = 2 записи (append-only).
		expect(txsAfter).toHaveLength(2);
		const voidTx = txsAfter.find((t) => t.void_id);
		expect(voidTx).toBeDefined();
		expect(voidTx!.void_id).toBe(originalTxId);
	});

	it('edit (amend) → записывает исправленную транзакцию с amended_id', async () => {
		// Создаём оригинальную транзакцию.
		recordFinanceEntry(
			{
				kind: 'transaction',
				account: { source: 'manual', name: 'Fake Edit Account', currency: 'RUB', kind: 'checking' },
				amount: 1500,
				currency: 'RUB',
				direction: 'out',
				note: 'original',
			},
			{ ledger, nowFn: fakeNowFn },
		);
		const txsBefore = ledger.readAll('transactions');
		const originalId = txsBefore[0]!.id;

		// Исправляем сумму.
		const intent: FinanceIntent = {
			type: 'edit',
			account: { source: 'manual', name: 'Fake Edit Account', currency: 'RUB', kind: 'checking' },
			amended_id: originalId,
			amount: 1200, // исправленная сумма
			currency: 'RUB',
			direction: 'out',
			note: 'corrected amount',
		};

		await dispatchFinanceIntent(intent, deps);

		const txsAfter = ledger.readAll('transactions');
		expect(txsAfter).toHaveLength(2); // оригинал + правка
		const amendTx = txsAfter.find((t) => t.amended_id);
		expect(amendTx!.amended_id).toBe(originalId);
		expect(amendTx!.amount).toBe(1200);
	});
});

// ---------------------------------------------------------------------------
// 3. dispatchFinanceIntent — create_goal пишет валидную страницу
// ---------------------------------------------------------------------------

describe('dispatchFinanceIntent — create_goal', () => {
	let dir: string;
	let ledger: Ledger;
	let goalsDir: string;

	beforeEach(() => {
		const tmp = makeTmpLedger();
		dir = tmp.dir;
		ledger = tmp.ledger;
		// Отдельный tmp-каталог для страниц целей.
		goalsDir = mkdtempSync(join(tmpdir(), 'finance-goals-test-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(goalsDir, { recursive: true, force: true });
	});

	it('create_goal → создаёт markdown-страницу с YAML-фронтматтером', async () => {
		const { readFileSync, existsSync } = await import('node:fs');

		const intent: FinanceIntent = {
			type: 'create_goal',
			goal_id: 'fake-emergency-fund',
			title: 'Fake Emergency Fund',
			target_amount: 100000,
			currency: 'RUB',
			target_date: '2026-12-31',
			fin_kind: 'save',
			priority: 1,
		};

		const result = await dispatchFinanceIntent(intent, { ledger, nowFn: fakeNowFn, goalsDir });

		// Проверяем что страница создана.
		expect(result.goalPage).not.toBeNull();
		const filePath = result.goalPage!.filePath;
		expect(existsSync(filePath)).toBe(true);

		// Читаем и проверяем содержимое.
		const content = readFileSync(filePath, 'utf8');
		expect(content).toContain('id: fake-emergency-fund');
		expect(content).toContain('type: finance-goal');
		expect(content).toContain('target_amount: 100000');
		expect(content).toContain('currency: RUB');
		expect(content).toContain('fin_kind: save');
		// Заголовок в теле.
		expect(content).toContain('# Fake Emergency Fund');
		// Числа в вики-прозе огрублены (100000 → ~100000).
		expect(content).toContain('~100000 RUB');

		// Леджер не затронут (create_goal не пишет в леджер).
		const txs = ledger.readAll('transactions');
		const snaps = ledger.readAll('snapshots');
		expect(txs).toHaveLength(0);
		expect(snaps).toHaveLength(0);
	});

	it('create_goal без goalsDir → null (graceful, не бросает)', async () => {
		const intent: FinanceIntent = {
			type: 'create_goal',
			goal_id: 'fake-goal-no-dir',
			title: 'Fake Goal',
			target_amount: 50000,
			currency: 'USD',
			target_date: '2027-01-01',
			fin_kind: 'grow',
		};

		// goalsDir не задан → goalPage = null, не бросает.
		const result = await dispatchFinanceIntent(intent, { ledger, nowFn: fakeNowFn });
		expect(result.goalPage).toBeNull();
	});

	it('create_goal идемпотентен: повторный вызов не перезаписывает', async () => {
		const { writeFileSync, readFileSync } = await import('node:fs');

		const intent: FinanceIntent = {
			type: 'create_goal',
			goal_id: 'fake-idem-goal',
			title: 'Fake Idempotent Goal',
			target_amount: 30000,
			currency: 'GEL',
			target_date: '2026-09-01',
			fin_kind: 'save',
		};

		// Первый вызов.
		const r1 = await dispatchFinanceIntent(intent, { ledger, nowFn: fakeNowFn, goalsDir });
		expect(r1.goalPage).not.toBeNull();
		const filePath = r1.goalPage!.filePath;

		// Перезаписываем файл вручную (имитируем ручное редактирование).
		writeFileSync(filePath, '# custom content', { encoding: 'utf8' });

		// Второй вызов — файл уже существует, не должен перезаписать.
		const r2 = await dispatchFinanceIntent(intent, { ledger, nowFn: fakeNowFn, goalsDir });
		expect(r2.goalPage).not.toBeNull();
		const content = readFileSync(filePath, 'utf8');
		// Содержимое осталось ручным (не перезаписано).
		expect(content).toBe('# custom content');
	});
});

// ---------------------------------------------------------------------------
// 4. dispatchFinanceIntent — query НИЧЕГО не пишет в Ledger
// ---------------------------------------------------------------------------

describe('dispatchFinanceIntent — query (read-only)', () => {
	let dir: string;
	let ledger: Ledger;
	let deps: FinanceIntentDeps;

	beforeEach(() => {
		const tmp = makeTmpLedger();
		dir = tmp.dir;
		ledger = tmp.ledger;
		deps = { ledger, nowFn: fakeNowFn };
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('query net_worth → не пишет в леджер, возвращает queryContext', async () => {
		// Предварительно записываем снапшот через recordFinanceEntry (read-only query не пишет).
		recordFinanceEntry(
			{
				kind: 'snapshot',
				account: { source: 'manual', name: 'Fake Query Account', currency: 'USDT', kind: 'exchange' },
				balance: 300,
			},
			{ ledger, nowFn: fakeNowFn },
		);

		const snapshotsBefore = ledger.readAll('snapshots');
		expect(snapshotsBefore).toHaveLength(1);

		const intent: FinanceIntent = { type: 'query', query_kind: 'net_worth' };
		const result = await dispatchFinanceIntent(intent, deps);

		// Леджер не изменился (query — read-only).
		const snapshotsAfter = ledger.readAll('snapshots');
		expect(snapshotsAfter).toHaveLength(1);
		const txsAfter = ledger.readAll('transactions');
		expect(txsAfter).toHaveLength(0);

		// queryContext содержит данные.
		expect(result.queryContext).not.toBeNull();
		expect(result.queryContext!.balanceSummaries).toHaveLength(1);
		expect(result.queryContext!.balanceSummaries[0]!.currency).toBe('USDT');
		expect(result.queryContext!.balanceSummaries[0]!.total).toBe(300);
		expect(result.queryContext!.netWorthPerCurrency['USDT']).toBe(300);
	});

	it('query spending → фильтрует транзакции по категории и периоду', async () => {
		// Записываем несколько транзакций через recordFinanceEntry.
		const account = { source: 'manual', name: 'Fake Spending Account', currency: 'RUB', kind: 'checking' as const };

		recordFinanceEntry(
			{ kind: 'transaction', account, amount: 1500, currency: 'RUB', direction: 'out', category: 'grocery', ts: '2026-05-15T10:00:00Z' },
			{ ledger, nowFn: fakeNowFn },
		);
		recordFinanceEntry(
			{ kind: 'transaction', account, amount: 500, currency: 'RUB', direction: 'out', category: 'transport', ts: '2026-05-20T10:00:00Z' },
			{ ledger, nowFn: fakeNowFn },
		);
		recordFinanceEntry(
			{ kind: 'transaction', account, amount: 2000, currency: 'RUB', direction: 'out', category: 'grocery', ts: '2026-05-25T10:00:00Z' },
			{ ledger, nowFn: fakeNowFn },
		);

		const intent: FinanceIntent = {
			type: 'query',
			query_kind: 'spending',
			category: 'grocery',
			period_start: '2026-05-01T00:00:00Z',
			period_end: '2026-06-01T00:00:00Z',
		};

		const result = await dispatchFinanceIntent(intent, deps);

		// Леджер не изменился.
		const txsAfter = ledger.readAll('transactions');
		expect(txsAfter).toHaveLength(3);

		// Только grocery за май = 1500 + 2000 = 3500.
		const grocerySpend = result.queryContext!.spendingByCategory.find(
			(s) => s.category === 'grocery',
		);
		expect(grocerySpend).toBeDefined();
		expect(grocerySpend!.amount).toBe(3500);
		expect(grocerySpend!.currency).toBe('RUB');
	});

	it('query feasibility → возвращает discretionaryInfo', async () => {
		// Записываем снапшот баланса.
		recordFinanceEntry(
			{
				kind: 'snapshot',
				account: { source: 'manual', name: 'Fake Feasibility Account', currency: 'RUB', kind: 'checking' },
				balance: 100000,
			},
			{ ledger, nowFn: fakeNowFn },
		);

		const intent: FinanceIntent = {
			type: 'query',
			query_kind: 'feasibility',
			amount: 50000,
			currency: 'RUB',
			question: 'могу ли позволить поездку?',
		};

		const result = await dispatchFinanceIntent(intent, deps);

		expect(result.queryContext!.discretionaryInfo).not.toBeNull();
		// 100000 >= 50000 → хватает.
		expect(result.queryContext!.discretionaryInfo).toContain('хватает');

		// Не пишет в леджер.
		expect(ledger.readAll('transactions')).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 5. formatReadback — детерминированный текст
// ---------------------------------------------------------------------------

describe('formatReadback', () => {
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

	it('record_balance → строка с суммой и валютой', async () => {
		const intent: FinanceIntent = {
			type: 'record_balance',
			account: { source: 'manual', name: 'Fake Readback Account', currency: 'USD', kind: 'checking' },
			balance: 1000,
		};
		const result = await dispatchFinanceIntent(intent, { ledger, nowFn: fakeNowFn });
		const text = formatReadback(result);

		expect(typeof text).toBe('string');
		expect(text.length).toBeGreaterThan(0);
		// Должен содержать название счёта и валюту.
		expect(text).toContain('Fake Readback Account');
		expect(text).toContain('USD');
		expect(text).toContain('1000');
	});

	it('query net_worth → содержит «Чистый капитал»', async () => {
		// Записываем снапшот.
		recordFinanceEntry(
			{
				kind: 'snapshot',
				account: { source: 'manual', name: 'Fake NW Account', currency: 'USDT', kind: 'exchange' },
				balance: 500,
			},
			{ ledger, nowFn: fakeNowFn },
		);

		const intent: FinanceIntent = { type: 'query', query_kind: 'net_worth' };
		const result = await dispatchFinanceIntent(intent, { ledger, nowFn: fakeNowFn });
		const text = formatReadback(result);

		expect(text).toContain('Чистый капитал');
		expect(text).toContain('USDT');
		expect(text).toContain('500');
	});

	it('create_goal → содержит название цели', async () => {
		const goalsDir = mkdtempSync(join(tmpdir(), 'finance-fmt-goals-'));
		try {
			const intent: FinanceIntent = {
				type: 'create_goal',
				goal_id: 'fake-fmt-goal',
				title: 'Fake Format Goal',
				target_amount: 50000,
				currency: 'RUB',
				target_date: '2027-06-01',
				fin_kind: 'save',
			};
			const result = await dispatchFinanceIntent(intent, { ledger, nowFn: fakeNowFn, goalsDir });
			const text = formatReadback(result);

			expect(text).toContain('fake-fmt-goal');
			expect(text).toContain('50000 RUB');
		} finally {
			rmSync(goalsDir, { recursive: true, force: true });
		}
	});

	it('transfer → содержит оба счёта', async () => {
		const intent: FinanceIntent = {
			type: 'transfer',
			from_account: { source: 'manual', name: 'Fake From', currency: 'RUB', kind: 'checking' },
			to_account: { source: 'manual', name: 'Fake To', currency: 'RUB', kind: 'savings' },
			amount: 25000,
			currency: 'RUB',
		};
		const result = await dispatchFinanceIntent(intent, { ledger, nowFn: fakeNowFn });
		const text = formatReadback(result);

		expect(text).toContain('Fake From');
		expect(text).toContain('Fake To');
		expect(text).toContain('25000 RUB');
	});
});

// ---------------------------------------------------------------------------
// 6. End-to-end флоу: Engine(mock) → extractFinanceIntent → dispatch → readback
// ---------------------------------------------------------------------------

describe('E2E флоу: mock Engine → finance-intent → readback', () => {
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

	/**
	 * Имитирует обработку одного хода: движок возвращает fake answer →
	 * extractFinanceIntent → dispatchFinanceIntent → formatReadback.
	 * Реального claude-бинаря НЕТ.
	 */
	async function simulateTurn(fakeEngineAnswer: string): Promise<string> {
		const intent = extractFinanceIntent(fakeEngineAnswer);
		if (!intent) {
			// Нет финансового интента — возвращаем ответ как есть.
			return fakeEngineAnswer;
		}
		const result = await dispatchFinanceIntent(intent, { ledger, nowFn: fakeNowFn });
		return formatReadback(result);
	}

	it('сценарий: ввод баланса счёта', async () => {
		const fakeAnswer = makeEngineAnswer({
			type: 'record_balance',
			account: { source: 'manual', name: 'Fake E2E Bank', currency: 'RUB', kind: 'checking' },
			balance: 150000,
		});

		const readback = await simulateTurn(fakeAnswer);

		// Снапшот записан.
		expect(ledger.readAll('snapshots')).toHaveLength(1);
		// Readback содержит подтверждение.
		expect(readback).toContain('150000 RUB');
	});

	it('сценарий: запись наличных (cash)', async () => {
		const fakeAnswer = makeEngineAnswer({
			type: 'record_cash',
			account: { source: 'manual', name: 'Fake Cash Wallet', currency: 'USD', kind: 'cash' },
			balance: 250,
		});

		const readback = await simulateTurn(fakeAnswer);

		const snaps = ledger.readAll('snapshots');
		expect(snaps[0]!.balance).toBe(250);
		expect(readback).toContain('250 USD');
	});

	it('сценарий: доход (income)', async () => {
		const fakeAnswer = makeEngineAnswer({
			type: 'record_income',
			account: { source: 'manual', name: 'Fake Income Account', currency: 'RUB', kind: 'checking' },
			amount: 90000,
			currency: 'RUB',
			category: 'salary',
			note: 'fake-salary-june',
		});

		const readback = await simulateTurn(fakeAnswer);

		const txs = ledger.readAll('transactions');
		expect(txs[0]!.direction).toBe('in');
		expect(txs[0]!.amount).toBe(90000);
		expect(readback).toContain('90000 RUB');
		expect(readback).toContain('salary');
	});

	it('сценарий: запрос net-worth (query, нет записи)', async () => {
		// Предварительно заполняем леджер.
		recordFinanceEntry(
			{
				kind: 'snapshot',
				account: { source: 'manual', name: 'Fake NW E2E', currency: 'USDT', kind: 'exchange' },
				balance: 400,
			},
			{ ledger, nowFn: fakeNowFn },
		);

		const fakeAnswer = makeEngineAnswer({ type: 'query', query_kind: 'net_worth' });
		const snapshotsBefore = ledger.readAll('snapshots').length;

		const readback = await simulateTurn(fakeAnswer);

		// Query не пишет.
		expect(ledger.readAll('snapshots')).toHaveLength(snapshotsBefore);
		expect(ledger.readAll('transactions')).toHaveLength(0);

		// Readback содержит net-worth информацию.
		expect(readback).toContain('USDT');
		expect(readback).toContain('400');
	});

	it('сценарий: обычный текстовый ответ (нет интента) → передаётся как есть', async () => {
		const plainAnswer = 'Привет! Я помню, что ты спрашивал про Париж. Вот информация...';
		const result = await simulateTurn(plainAnswer);
		// Нет интента → возвращаем as-is.
		expect(result).toBe(plainAnswer);
		// Леджер пустой.
		expect(ledger.readAll('snapshots')).toHaveLength(0);
		expect(ledger.readAll('transactions')).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 7. buildFinanceContextSummary
// ---------------------------------------------------------------------------

describe('buildFinanceContextSummary', () => {
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

	it('пустой леджер → null', () => {
		const result = buildFinanceContextSummary(ledger, fakeNowFn);
		expect(result).toBeNull();
	});

	it('леджер со снапшотами → строка с балансами', () => {
		recordFinanceEntry(
			{
				kind: 'snapshot',
				account: { source: 'manual', name: 'Fake Context Account', currency: 'RUB', kind: 'checking' },
				balance: 50000,
			},
			{ ledger, nowFn: fakeNowFn },
		);

		const summary = buildFinanceContextSummary(ledger, fakeNowFn);

		expect(summary).not.toBeNull();
		expect(summary).toContain('50000 RUB');
		expect(summary).toContain('[Финансовый контекст');
		expect(summary).toContain('[/Финансовый контекст]');
	});

	it('несколько валют → все отображены в сводке', () => {
		// Два снапшота в разных валютах.
		recordFinanceEntry(
			{
				kind: 'snapshot',
				account: { source: 'manual', name: 'Fake RUB', currency: 'RUB', kind: 'checking' },
				balance: 100000,
			},
			{ ledger, nowFn: fakeNowFn },
		);
		recordFinanceEntry(
			{
				kind: 'snapshot',
				account: { source: 'manual', name: 'Fake USDT', currency: 'USDT', kind: 'exchange' },
				balance: 200,
			},
			{ ledger, nowFn: fakeNowFn },
		);

		const summary = buildFinanceContextSummary(ledger, fakeNowFn);

		expect(summary).toContain('100000 RUB');
		expect(summary).toContain('200 USDT');
	});

	it('траты за текущий месяц → попадают в сводку', () => {
		// Записываем снапшот и расход в том же месяце что FAKE_NOW (2026-06).
		recordFinanceEntry(
			{
				kind: 'snapshot',
				account: { source: 'manual', name: 'Fake Monthly Account', currency: 'RUB', kind: 'checking' },
				balance: 30000,
			},
			{ ledger, nowFn: fakeNowFn },
		);
		recordFinanceEntry(
			{
				kind: 'transaction',
				account: { source: 'manual', name: 'Fake Monthly Account', currency: 'RUB', kind: 'checking' },
				amount: 5000,
				currency: 'RUB',
				direction: 'out',
				category: 'grocery',
				ts: '2026-06-10T10:00:00Z', // в пределах месяца FAKE_NOW
			},
			{ ledger, nowFn: fakeNowFn },
		);

		const summary = buildFinanceContextSummary(ledger, fakeNowFn);

		expect(summary).toContain('grocery');
		expect(summary).toContain('5000 RUB');
	});
});

// ---------------------------------------------------------------------------
// 8. Path-guard в createGoalPage (ADR-0011/ADR-0018)
// ---------------------------------------------------------------------------

describe('createGoalPage — path-guard публичного репо', () => {
	let ledgerDir: string;
	let ledger: Ledger;

	beforeEach(() => {
		const tmp = makeTmpLedger();
		ledgerDir = tmp.dir;
		ledger = tmp.ledger;
	});

	afterEach(() => {
		rmSync(ledgerDir, { recursive: true, force: true });
	});

	it('goalsDir под публичным репо → страница НЕ создаётся (path-guard сработал)', async () => {
		// goalsDir намеренно указан КАК ПОДКАТАЛОГ publicRepoRoot → path-guard должен запретить запись.
		// Создаём fake «публичный репо» в tmpdir (не реальный llm-wiki).
		const fakePublicRoot = mkdtempSync(join(tmpdir(), 'fake-pub-root-'));
		// goalsDir — подкаталог «публичного репо» (нарушение инварианта ADR-0011).
		const goalsUnderPublic = join(fakePublicRoot, 'wiki', 'finance', 'goals');

		try {
			const intent: FinanceIntent = {
				type: 'create_goal',
				goal_id: 'fake-blocked-goal',
				title: 'Fake Blocked Goal',
				target_amount: 200000,
				currency: 'RUB',
				target_date: '2027-01-01',
				fin_kind: 'save',
			};

			// Передаём publicRepoRoot явно — guard должен сработать и вернуть null.
			const result = await dispatchFinanceIntent(intent, {
				ledger,
				nowFn: fakeNowFn,
				goalsDir: goalsUnderPublic,
				publicRepoRoot: fakePublicRoot,
			});

			// Страница НЕ создана (path-guard заблокировал).
			expect(result.goalPage).toBeNull();
		} finally {
			rmSync(fakePublicRoot, { recursive: true, force: true });
		}
	});

	it('goalsDir под приватным репо → страница создаётся нормально', async () => {
		// goalsDir — подкаталог нашего tmp-каталога (отдельно от «публичного репо»).
		const fakePublicRoot = mkdtempSync(join(tmpdir(), 'fake-pub-ok-root-'));
		const goalsOk = mkdtempSync(join(tmpdir(), 'goals-ok-'));

		try {
			const intent: FinanceIntent = {
				type: 'create_goal',
				goal_id: 'fake-allowed-goal',
				title: 'Fake Allowed Goal',
				target_amount: 50000,
				currency: 'RUB',
				target_date: '2027-06-01',
				fin_kind: 'save',
			};

			// goalsDir — вне fakePublicRoot → guard разрешает запись.
			const result = await dispatchFinanceIntent(intent, {
				ledger,
				nowFn: fakeNowFn,
				goalsDir: goalsOk,
				publicRepoRoot: fakePublicRoot,
			});

			// Страница создана.
			expect(result.goalPage).not.toBeNull();
			expect(result.goalPage!.goalId).toBe('fake-allowed-goal');
		} finally {
			rmSync(fakePublicRoot, { recursive: true, force: true });
			rmSync(goalsOk, { recursive: true, force: true });
		}
	});
});
