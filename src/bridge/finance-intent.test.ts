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
 *   8. [Новое] Реактивная доставка PNG: query с уместным запросом → sendPhoto вызван.
 *   9. [Новое] Query ничего не пишет + sendPhoto не нужен без telegramClient.
 *  10. [Новое] Pending-cash flow: ответ числом + активный маркер → record_cash + clearPendingCashSurvey.
 *  11. [Новое] tryParsePendingCashAnswer: правильно парсит/игнорирует входящие числа.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Ledger } from '../ingest/finance/ledger.js';
import { recordFinanceEntry } from '../ingest/finance/record.js';
import {
	writePendingCashSurvey,
	readPendingCashSurvey,
} from '../scheduler/finance-state.js';
import type { TelegramClient, InputFile, SendMediaOptions } from './telegram.js';
import {
	buildFinanceContextSummary,
	dispatchFinanceIntent,
	extractFinanceIntent,
	formatReadback,
	tryParsePendingCashAnswer,
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

// ---------------------------------------------------------------------------
// 9. Реактивная доставка PNG-графика (sendPhoto) при query-интентах
// ---------------------------------------------------------------------------

/**
 * Создаёт мок TelegramClient для тестов реактивной доставки.
 * Записывает все вызовы sendPhoto/sendDocument в массивы для проверки.
 */
function makeMockTelegramClient() {
	const sentPhotos: Array<{ chatId: number; photo: InputFile; opts?: SendMediaOptions }> = [];
	const sentDocuments: Array<{ chatId: number; doc: InputFile; opts?: SendMediaOptions }> = [];
	const sentMessages: Array<{ chatId: number; text: string }> = [];

	const mock: TelegramClient = {
		sendMessage: vi.fn(async (chatId: number, text: string) => {
			sentMessages.push({ chatId, text });
		}),
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

	return { mock, sentPhotos, sentDocuments, sentMessages };
}

/** Магия PNG: первые 4 байта файла. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

/** Проверяет что data — валидный PNG-буфер (магия + непустой). */
function expectValidPngData(data: Buffer | Uint8Array | undefined): void {
	expect(data).toBeDefined();
	const buf = Buffer.isBuffer(data) ? data : Buffer.from(data!);
	expect(buf.length).toBeGreaterThan(PNG_MAGIC.length);
	for (let i = 0; i < PNG_MAGIC.length; i++) {
		expect(buf[i]).toBe(PNG_MAGIC[i]);
	}
}

describe('dispatchFinanceIntent — реактивная доставка PNG (sendPhoto)', () => {
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

	it('query net_worth со снапшотами + telegramClient → sendPhoto вызван с непустым PNG', async () => {
		// Предварительно записываем снапшоты в нескольких валютах.
		recordFinanceEntry(
			{
				kind: 'snapshot',
				account: { source: 'manual', name: 'Fake RUB Account', currency: 'RUB', kind: 'checking' },
				balance: 80000,
			},
			{ ledger, nowFn: fakeNowFn },
		);
		recordFinanceEntry(
			{
				kind: 'snapshot',
				account: { source: 'manual', name: 'Fake USDT Account', currency: 'USDT', kind: 'exchange' },
				balance: 300,
			},
			{ ledger, nowFn: fakeNowFn },
		);

		const { mock, sentPhotos } = makeMockTelegramClient();

		const intent: FinanceIntent = { type: 'query', query_kind: 'net_worth' };
		const result = await dispatchFinanceIntent(intent, {
			ledger,
			nowFn: fakeNowFn,
			telegramClient: mock,
			ownerChatId: 42,
		});

		// Результат: chartPngSent = true, query не пишет.
		expect(result.chartPngSent).toBe(true);
		expect(result.queryContext).not.toBeNull();

		// sendPhoto должен быть вызван ровно один раз.
		expect(sentPhotos).toHaveLength(1);
		expect(sentPhotos[0]!.chatId).toBe(42);

		// Проверяем что payload — непустой валидный PNG.
		expectValidPngData(sentPhotos[0]!.photo.data);

		// Имя файла — осмысленное.
		expect(sentPhotos[0]!.photo.filename).toBe('balances.png');

		// Caption — без точных чисел (secret-gate: только огрублённые).
		expect(sentPhotos[0]!.opts?.caption).toBeTruthy();
		expect(typeof sentPhotos[0]!.opts?.caption).toBe('string');

		// Леджер не изменился (query read-only).
		expect(ledger.readAll('snapshots')).toHaveLength(2);
		expect(ledger.readAll('transactions')).toHaveLength(0);
	});

	it('query spending + траты → sendPhoto с pie расходов', async () => {
		const account = {
			source: 'manual',
			name: 'Fake Spend Account',
			currency: 'RUB',
			kind: 'checking' as const,
		};

		// Добавляем снапшот и несколько расходов.
		recordFinanceEntry(
			{ kind: 'snapshot', account, balance: 50000 },
			{ ledger, nowFn: fakeNowFn },
		);
		recordFinanceEntry(
			{
				kind: 'transaction',
				account,
				amount: 2000,
				currency: 'RUB',
				direction: 'out',
				category: 'grocery',
				ts: '2026-06-01T10:00:00Z',
			},
			{ ledger, nowFn: fakeNowFn },
		);
		recordFinanceEntry(
			{
				kind: 'transaction',
				account,
				amount: 800,
				currency: 'RUB',
				direction: 'out',
				category: 'transport',
				ts: '2026-06-05T10:00:00Z',
			},
			{ ledger, nowFn: fakeNowFn },
		);

		const { mock, sentPhotos } = makeMockTelegramClient();

		const intent: FinanceIntent = {
			type: 'query',
			query_kind: 'spending',
			period_start: '2026-06-01T00:00:00Z',
			period_end: '2026-07-01T00:00:00Z',
		};

		const result = await dispatchFinanceIntent(intent, {
			ledger,
			nowFn: fakeNowFn,
			telegramClient: mock,
			ownerChatId: 99,
		});

		expect(result.chartPngSent).toBe(true);
		expect(sentPhotos).toHaveLength(1);
		// PNG из расходов — называется spending.png.
		expect(sentPhotos[0]!.photo.filename).toBe('spending.png');
		expectValidPngData(sentPhotos[0]!.photo.data);
	});

	it('query net_worth БЕЗ telegramClient → chartPngSent=false, sendPhoto НЕ вызван', async () => {
		// Записываем снапшот.
		recordFinanceEntry(
			{
				kind: 'snapshot',
				account: { source: 'manual', name: 'Fake NW', currency: 'RUB', kind: 'checking' },
				balance: 60000,
			},
			{ ledger, nowFn: fakeNowFn },
		);

		// telegramClient НЕ передаём — ожидаем graceful skip.
		const intent: FinanceIntent = { type: 'query', query_kind: 'net_worth' };
		const result = await dispatchFinanceIntent(intent, { ledger, nowFn: fakeNowFn });

		expect(result.chartPngSent).toBe(false);
		// queryContext всё равно заполнен (читаем данные всегда).
		expect(result.queryContext).not.toBeNull();
		expect(result.queryContext!.balanceSummaries).toHaveLength(1);
	});

	it('query net_worth с пустым леджером → chartPngSent=false (нет данных для PNG)', async () => {
		const { mock } = makeMockTelegramClient();

		const intent: FinanceIntent = { type: 'query', query_kind: 'net_worth' };
		const result = await dispatchFinanceIntent(intent, {
			ledger,
			nowFn: fakeNowFn,
			telegramClient: mock,
			ownerChatId: 1,
		});

		// Пустой леджер — нет данных для балансов → PNG не строится.
		expect(result.chartPngSent).toBe(false);
		// sendPhoto НЕ вызван.
		expect(mock.sendPhoto).not.toHaveBeenCalled();
	});

	it('query feasibility → chartPngSent=false (нет уместного графика)', async () => {
		// feasibility не имеет подходящего снапшот-графика — проверяем что не падаем.
		recordFinanceEntry(
			{
				kind: 'snapshot',
				account: { source: 'manual', name: 'Fake Feasib', currency: 'RUB', kind: 'checking' },
				balance: 100000,
			},
			{ ledger, nowFn: fakeNowFn },
		);

		const { mock } = makeMockTelegramClient();

		const intent: FinanceIntent = {
			type: 'query',
			query_kind: 'feasibility',
			amount: 50000,
			currency: 'RUB',
		};

		const result = await dispatchFinanceIntent(intent, {
			ledger,
			nowFn: fakeNowFn,
			telegramClient: mock,
			ownerChatId: 1,
		});

		// feasibility — нет PNG.
		expect(result.chartPngSent).toBe(false);
		expect(mock.sendPhoto).not.toHaveBeenCalled();
		// queryContext с discretionaryInfo по-прежнему работает.
		expect(result.queryContext!.discretionaryInfo).toContain('хватает');
	});

	it('record_expense → chartPngSent=false (запись, не query)', async () => {
		// Для record-интентов PNG не отправляется — только для query.
		const { mock } = makeMockTelegramClient();

		const intent: FinanceIntent = {
			type: 'record_expense',
			account: { source: 'manual', name: 'Fake Exp', currency: 'RUB', kind: 'checking' },
			amount: 500,
			currency: 'RUB',
			category: 'transport',
		};

		const result = await dispatchFinanceIntent(intent, {
			ledger,
			nowFn: fakeNowFn,
			telegramClient: mock,
			ownerChatId: 1,
		});

		expect(result.chartPngSent).toBe(false);
		expect(mock.sendPhoto).not.toHaveBeenCalled();
		// Транзакция записана.
		expect(ledger.readAll('transactions')).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// 10. Pending-cash flow: ответ числом → record_cash + clearPendingCashSurvey
// ---------------------------------------------------------------------------

describe('dispatchFinanceIntent — pending-cash survey flow', () => {
	let dir: string;
	let ledger: Ledger;
	let stateDir: string;

	beforeEach(() => {
		const tmp = makeTmpLedger();
		dir = tmp.dir;
		ledger = tmp.ledger;
		// Отдельный tmp-каталог для finance-state (pending cash survey).
		stateDir = mkdtempSync(join(tmpdir(), 'finance-state-test-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(stateDir, { recursive: true, force: true });
	});

	it('record_cash + активный pending маркер → pendingCashHandled=true + маркер удалён', async () => {
		// C1 ставит маркер (имитируем что проактив спросил «сколько наличных?»).
		writePendingCashSurvey(stateDir, {
			account: 'Fake Cash Wallet',
			currency: 'RUB',
			sinceIso: '2026-06-23T09:00:00Z',
		});

		// Проверяем что маркер стоит.
		expect(readPendingCashSurvey(stateDir)).not.toBeNull();

		// Пользователь отвечает числом — C3 диспетчеризует как record_cash.
		const intent: FinanceIntent = {
			type: 'record_cash',
			account: { source: 'manual', name: 'Fake Cash Wallet', currency: 'RUB', kind: 'cash' },
			balance: 3000,
		};

		const deps: FinanceIntentDeps = {
			ledger,
			nowFn: fakeNowFn,
			financeStateDir: stateDir,
		};

		const result = await dispatchFinanceIntent(intent, deps);

		// Запись произошла.
		const snapshots = ledger.readAll('snapshots');
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]!.balance).toBe(3000);

		// Pending маркер погашен.
		expect(result.pendingCashHandled).toBe(true);
		expect(readPendingCashSurvey(stateDir)).toBeNull();
	});

	it('record_cash БЕЗ активного pending маркера → pendingCashHandled=false', async () => {
		// Маркер НЕ установлен.
		expect(readPendingCashSurvey(stateDir)).toBeNull();

		const intent: FinanceIntent = {
			type: 'record_cash',
			account: { source: 'manual', name: 'Fake Cash No Pending', currency: 'USD', kind: 'cash' },
			balance: 100,
		};

		const result = await dispatchFinanceIntent(intent, {
			ledger,
			nowFn: fakeNowFn,
			financeStateDir: stateDir,
		});

		// Запись произошла, но pending не было.
		expect(ledger.readAll('snapshots')).toHaveLength(1);
		expect(result.pendingCashHandled).toBe(false);
	});

	it('record_cash без financeStateDir → pendingCashHandled=false (graceful)', async () => {
		// financeStateDir не передан — graceful skip, без ошибок.
		const intent: FinanceIntent = {
			type: 'record_cash',
			account: { source: 'manual', name: 'Fake Cash No State', currency: 'RUB', kind: 'cash' },
			balance: 500,
		};

		const result = await dispatchFinanceIntent(intent, {
			ledger,
			nowFn: fakeNowFn,
			// financeStateDir намеренно не передан.
		});

		// Всё работает, pendingCashHandled=false (нет stateDir).
		expect(result.pendingCashHandled).toBe(false);
		expect(ledger.readAll('snapshots')).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// 11. tryParsePendingCashAnswer — парсинг числового ответа на pending опрос
// ---------------------------------------------------------------------------

describe('tryParsePendingCashAnswer', () => {
	let stateDir: string;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), 'finance-pending-parse-test-'));
	});

	afterEach(() => {
		rmSync(stateDir, { recursive: true, force: true });
	});

	it('нет активного маркера → null (не pending-ответ)', () => {
		const result = tryParsePendingCashAnswer('1500', stateDir);
		expect(result).toBeNull();
	});

	it('есть маркер + целое число → { survey, amount }', () => {
		writePendingCashSurvey(stateDir, {
			account: 'Fake Cash',
			currency: 'RUB',
			sinceIso: '2026-06-23T10:00:00Z',
		});

		const result = tryParsePendingCashAnswer('4500', stateDir);
		expect(result).not.toBeNull();
		expect(result!.amount).toBe(4500);
		expect(result!.survey.currency).toBe('RUB');
	});

	it('есть маркер + дробное число с запятой → корректный amount', () => {
		writePendingCashSurvey(stateDir, {
			currency: 'USD',
			sinceIso: '2026-06-23T10:00:00Z',
		});

		const result = tryParsePendingCashAnswer('42,50', stateDir);
		expect(result).not.toBeNull();
		expect(result!.amount).toBeCloseTo(42.5);
	});

	it('есть маркер + текст (не число) → null', () => {
		writePendingCashSurvey(stateDir, {
			sinceIso: '2026-06-23T10:00:00Z',
		});

		const result = tryParsePendingCashAnswer('не помню точно', stateDir);
		expect(result).toBeNull();
	});

	it('есть маркер + пустая строка → null', () => {
		writePendingCashSurvey(stateDir, {
			sinceIso: '2026-06-23T10:00:00Z',
		});

		expect(tryParsePendingCashAnswer('', stateDir)).toBeNull();
		expect(tryParsePendingCashAnswer('   ', stateDir)).toBeNull();
	});

	it('есть маркер + отрицательное число → null (баланс не может быть отрицательным)', () => {
		writePendingCashSurvey(stateDir, {
			sinceIso: '2026-06-23T10:00:00Z',
		});

		// Отрицательный баланс наличных не имеет смысла.
		const result = tryParsePendingCashAnswer('-500', stateDir);
		expect(result).toBeNull();
	});

	it('есть маркер + ноль → корректно (нуль наличных возможен)', () => {
		writePendingCashSurvey(stateDir, {
			sinceIso: '2026-06-23T10:00:00Z',
		});

		const result = tryParsePendingCashAnswer('0', stateDir);
		expect(result).not.toBeNull();
		expect(result!.amount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 12. create_credit — первый CreditRecord-снапшот пишется в credits.jsonl (блокер #4)
// ---------------------------------------------------------------------------

describe('dispatchFinanceIntent — create_credit (блокер #4)', () => {
	let dir: string;
	let ledger: Ledger;
	let stateDir: string;

	beforeEach(() => {
		const tmp = makeTmpLedger();
		dir = tmp.dir;
		ledger = tmp.ledger;
		stateDir = mkdtempSync(join(tmpdir(), 'credit-state-test-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(stateDir, { recursive: true, force: true });
	});

	it('create_credit → пишет первый CreditRecord в credits.jsonl', async () => {
		// Синтетический кредит (все данные фейковые).
		const intent: FinanceIntent = {
			type: 'create_credit',
			credit_id: 'fake-mortgage-2026',
			label: 'Синтетическая ипотека',
			principal: 3000000,
			currency: 'RUB',
			rate_pct: 14.0,
			monthly_payment: 35000,
			payment_day: 15,
			credit_type: 'annuity',
		};

		const result = await dispatchFinanceIntent(intent, {
			ledger,
			nowFn: fakeNowFn,
			financeStateDir: stateDir,
		});

		// Проверяем что запись появилась в credits.jsonl.
		const credits = ledger.readAll('credits');
		expect(credits).toHaveLength(1);
		expect(credits[0]!.id).toBe('fake-mortgage-2026');
		expect(credits[0]!.principal).toBe(3000000);
		expect(credits[0]!.currency).toBe('RUB');
		expect(credits[0]!.rate_pct).toBe(14.0);
		expect(credits[0]!.monthly_payment).toBe(35000);
		expect(credits[0]!.payment_day).toBe(15);
		// balance по умолчанию = principal (не задан balance явно).
		expect(credits[0]!.balance).toBe(3000000);
		expect(credits[0]!.manual).toBe(true);

		// summary содержит ключевые данные.
		expect(result.summary).toContain('fake-mortgage-2026');
		expect(result.summary).toContain('3000000 RUB');
		expect(result.summary).toContain('14% годовых');
		expect(result.summary).toContain('35000 RUB/мес');
		expect(result.summary).toContain('День платежа: 15');

		// balances пустой (credit-запись — не snapshot-счёт).
		expect(result.balances).toHaveLength(0);
		// goalPage и queryContext — null (не применимы).
		expect(result.goalPage).toBeNull();
		expect(result.queryContext).toBeNull();
	});

	it('create_credit с явным balance (частично погашен) → balance в снапшоте', async () => {
		const intent: FinanceIntent = {
			type: 'create_credit',
			credit_id: 'fake-car-loan',
			label: 'Синтетический автокредит',
			principal: 800000,
			currency: 'RUB',
			balance: 600000, // уже погашено 200k
			next_payment_date: '2026-07-05T00:00:00Z',
			credit_type: 'differentiated',
		};

		await dispatchFinanceIntent(intent, { ledger, nowFn: fakeNowFn });

		const credits = ledger.readAll('credits');
		expect(credits).toHaveLength(1);
		// balance явно задан (600000), не principal.
		expect(credits[0]!.balance).toBe(600000);
		expect(credits[0]!.principal).toBe(800000);
		expect(credits[0]!.next_payment_date).toBe('2026-07-05T00:00:00Z');
	});

	it('create_credit обновляет idle watermark (writeLastInputTs)', async () => {
		const { readLastInputTs } = await import('../scheduler/finance-state.js');

		// Watermark изначально пустой.
		expect(readLastInputTs(stateDir)).toBeNull();

		const intent: FinanceIntent = {
			type: 'create_credit',
			credit_id: 'fake-idle-credit',
			label: 'Тест idle watermark',
			principal: 100000,
			currency: 'RUB',
			credit_type: 'annuity',
		};

		await dispatchFinanceIntent(intent, {
			ledger,
			nowFn: fakeNowFn,
			financeStateDir: stateDir,
		});

		// Watermark должен обновиться (writeLastInputTs вызван в create_credit).
		const ts = readLastInputTs(stateDir);
		expect(ts).not.toBeNull();
		// Проверяем что это строка с датой (ISO-формат).
		expect(ts).toContain('2026-06-23');
	});

	it('extractFinanceIntent: create_credit без обязательных полей → null (zod отклоняет)', () => {
		// Невалидный JSON: нет credit_id/principal/currency → zod-валидация провалится.
		const badJson = JSON.stringify({ type: 'create_credit' });
		const answer = `\`\`\`finance-intent\n${badJson}\n\`\`\``;
		const extracted = extractFinanceIntent(answer);
		// zod-валидация не прошла (нет credit_id/principal/currency) → null.
		expect(extracted).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 13. writeLastInputTs после record* (блокер #8 idle watermark)
// ---------------------------------------------------------------------------

describe('dispatchFinanceIntent — idle watermark writeLastInputTs (блокер #8)', () => {
	let dir: string;
	let ledger: Ledger;
	let stateDir: string;

	beforeEach(() => {
		const tmp = makeTmpLedger();
		dir = tmp.dir;
		ledger = tmp.ledger;
		stateDir = mkdtempSync(join(tmpdir(), 'idle-watermark-test-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(stateDir, { recursive: true, force: true });
	});

	it('record_income + financeStateDir → watermark обновляется', async () => {
		const { readLastInputTs } = await import('../scheduler/finance-state.js');
		expect(readLastInputTs(stateDir)).toBeNull();

		const intent: FinanceIntent = {
			type: 'record_income',
			account: { source: 'manual', name: 'Fake Income', currency: 'RUB', kind: 'checking' },
			amount: 50000,
			currency: 'RUB',
			category: 'salary',
		};

		await dispatchFinanceIntent(intent, {
			ledger,
			nowFn: fakeNowFn,
			financeStateDir: stateDir,
		});

		// Watermark обновлён.
		const ts = readLastInputTs(stateDir);
		expect(ts).not.toBeNull();
		expect(ts).toContain('2026-06-23');
	});

	it('record_expense + financeStateDir → watermark обновляется', async () => {
		const { readLastInputTs } = await import('../scheduler/finance-state.js');

		const intent: FinanceIntent = {
			type: 'record_expense',
			account: { source: 'manual', name: 'Fake Expense', currency: 'RUB', kind: 'checking' },
			amount: 1000,
			currency: 'RUB',
			category: 'grocery',
		};

		await dispatchFinanceIntent(intent, {
			ledger,
			nowFn: fakeNowFn,
			financeStateDir: stateDir,
		});

		expect(readLastInputTs(stateDir)).not.toBeNull();
	});

	it('record_balance + financeStateDir → watermark обновляется', async () => {
		const { readLastInputTs } = await import('../scheduler/finance-state.js');

		const intent: FinanceIntent = {
			type: 'record_balance',
			account: { source: 'manual', name: 'Fake Balance', currency: 'USD', kind: 'bank' },
			balance: 2500,
		};

		await dispatchFinanceIntent(intent, {
			ledger,
			nowFn: fakeNowFn,
			financeStateDir: stateDir,
		});

		expect(readLastInputTs(stateDir)).not.toBeNull();
	});

	it('query → watermark НЕ обновляется (query read-only)', async () => {
		const { readLastInputTs } = await import('../scheduler/finance-state.js');
		expect(readLastInputTs(stateDir)).toBeNull();

		// Предзаполняем снапшот чтобы query имел данные.
		recordFinanceEntry(
			{
				kind: 'snapshot',
				account: { source: 'manual', name: 'Fake Q', currency: 'RUB', kind: 'checking' },
				balance: 10000,
			},
			{ ledger, nowFn: fakeNowFn },
		);

		const intent: FinanceIntent = { type: 'query', query_kind: 'net_worth' };
		await dispatchFinanceIntent(intent, {
			ledger,
			nowFn: fakeNowFn,
			financeStateDir: stateDir,
		});

		// query не пишет — watermark по-прежнему null.
		expect(readLastInputTs(stateDir)).toBeNull();
	});

	it('record_income без financeStateDir → graceful (не бросает)', async () => {
		// financeStateDir не передан — записи нет, но исключений тоже.
		const intent: FinanceIntent = {
			type: 'record_income',
			account: { source: 'manual', name: 'Fake Income No State', currency: 'RUB', kind: 'checking' },
			amount: 20000,
			currency: 'RUB',
		};

		await expect(
			dispatchFinanceIntent(intent, { ledger, nowFn: fakeNowFn }),
		).resolves.not.toThrow();

		// Транзакция всё равно записана.
		expect(ledger.readAll('transactions')).toHaveLength(1);
	});
});
