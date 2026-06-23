/**
 * schema.test.ts — тесты схемного слоя финансового модуля (E2–E5, новые типы).
 *
 * Покрытие:
 *   1. Round-trip append+readAll для новых файлов леджера:
 *      budgets, categories, templates, receivables, payables, settings.
 *   2. Path-guard по-прежнему бросает LedgerPathError при записи в публичный путь.
 *   3. AccountRecord.kind — новые значения (cash, checking, savings) валидны.
 *   4. CreditRecord — старый набор полей (без новых опциональных) всё ещё валиден.
 *   5. TransactionRecord — старый набор полей всё ещё валиден.
 *   6. FinanceGoalSchema — парсит корректный фронтматтер, режектит некорректный.
 *
 * Принципы (как в finance.test.ts):
 *   - Все данные синтетические (fake-example, нет PII, нет реальных сумм/имён).
 *   - mkdtempSync → rmSync(recursive) для изоляции каждого теста.
 *   - Импорт ТОЛЬКО из ./types и ./ledger — не цеплять параллельно редактируемые файлы.
 *   - lint:public остаётся зелёным.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Ledger, LedgerPathError } from './ledger.js';
import {
	AccountRecordSchema,
	BudgetRecordSchema,
	CategoryRecordSchema,
	CreditRecordSchema,
	FinanceGoalSchema,
	PayableRecordSchema,
	ReceivableRecordSchema,
	SettingsRecordSchema,
	TemplateRecordSchema,
	TransactionRecordSchema,
} from './types.js';

// ---------------------------------------------------------------------------
// Вспомогательные функции для тестов
// ---------------------------------------------------------------------------

/**
 * makeLedger — создаёт изолированный Ledger в переданном tmp-каталоге.
 * publicRepoRoot за пределами tmpDir → path-guard не срабатывает в нормальных тестах.
 */
function makeLedger(tmpDir: string): Ledger {
	const financeDir = join(tmpDir, 'raw', 'finance');
	return new Ledger({ financeDir, publicRepoRoot: join(tmpDir, 'public-fake') });
}

// ---------------------------------------------------------------------------
// 1. Round-trip: BudgetRecord
// ---------------------------------------------------------------------------

describe('schema: BudgetRecord — round-trip append + readAll', () => {
	let tmpDir: string;
	let ledger: Ledger;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'schema-budget-'));
		ledger = makeLedger(tmpDir);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('корректная запись проходит валидацию и читается обратно', () => {
		// synthetic-example: бюджет на "продукты" за июнь 2026
		const budget = {
			id: 'budget-fake-2026-06-grocery',
			category: 'grocery',
			period_start: '2026-06-01T00:00:00Z',
			period_end: '2026-07-01T00:00:00Z',
			limit_amount: 15000, // synthetic-example
			currency: 'RUB',
			ts: '2026-06-01T09:00:00Z',
		};
		ledger.append('budgets', budget);
		const records = ledger.readAll('budgets');
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject(budget);
	});

	it('несколько записей сохраняются в порядке вставки', () => {
		// synthetic-example: два разных бюджета
		const b1 = {
			id: 'budget-fake-food-june',
			category: 'food',
			period_start: '2026-06-01T00:00:00Z',
			period_end: '2026-07-01T00:00:00Z',
			limit_amount: 20000, // synthetic-example
			currency: 'RUB',
			ts: '2026-06-01T09:00:00Z',
		};
		const b2 = {
			id: 'budget-fake-transport-june',
			category: 'transport',
			period_start: '2026-06-01T00:00:00Z',
			period_end: '2026-07-01T00:00:00Z',
			limit_amount: 5000, // synthetic-example
			currency: 'RUB',
			ts: '2026-06-01T09:01:00Z',
			note: 'synthetic-example note',
		};
		ledger.append('budgets', b1);
		ledger.append('budgets', b2);
		const records = ledger.readAll('budgets');
		expect(records).toHaveLength(2);
		expect(records[0]?.id).toBe('budget-fake-food-june');
		expect(records[1]?.id).toBe('budget-fake-transport-june');
	});

	it('BudgetRecordSchema не принимает отрицательный лимит', () => {
		const result = BudgetRecordSchema.safeParse({
			id: 'bad-budget',
			category: 'food',
			period_start: '2026-06-01T00:00:00Z',
			period_end: '2026-07-01T00:00:00Z',
			limit_amount: -100, // нарушение: positive()
			currency: 'RUB',
			ts: '2026-06-01T09:00:00Z',
		});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 2. Round-trip: CategoryRecord
// ---------------------------------------------------------------------------

describe('schema: CategoryRecord — round-trip append + readAll', () => {
	let tmpDir: string;
	let ledger: Ledger;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'schema-category-'));
		ledger = makeLedger(tmpDir);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('корректная запись проходит и читается обратно', () => {
		// synthetic-example: категория "продукты питания"
		const cat = {
			id: 'grocery',
			name: 'Продукты', // synthetic-example label
			direction: 'out' as const,
			ts: '2026-06-01T00:00:00Z',
		};
		ledger.append('categories', cat);
		const records = ledger.readAll('categories');
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject(cat);
	});

	it('запись с parent_id и icon проходит валидацию', () => {
		// synthetic-example: подкатегория
		const cat = {
			id: 'cafe',
			name: 'Кафе',
			parent_id: 'food',
			direction: 'out' as const,
			ts: '2026-06-01T00:00:00Z',
			icon: '☕',
		};
		ledger.append('categories', cat);
		const records = ledger.readAll('categories');
		expect(records[0]?.parent_id).toBe('food');
	});

	it('direction "both" валиден', () => {
		const result = CategoryRecordSchema.safeParse({
			id: 'transfer',
			name: 'Перевод',
			direction: 'both',
			ts: '2026-06-01T00:00:00Z',
		});
		expect(result.success).toBe(true);
	});

	it('невалидный direction режектится', () => {
		const result = CategoryRecordSchema.safeParse({
			id: 'bad',
			name: 'Bad',
			direction: 'unknown', // не входит в enum
			ts: '2026-06-01T00:00:00Z',
		});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 3. Round-trip: TemplateRecord
// ---------------------------------------------------------------------------

describe('schema: TemplateRecord — round-trip append + readAll', () => {
	let tmpDir: string;
	let ledger: Ledger;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'schema-template-'));
		ledger = makeLedger(tmpDir);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('корректная запись проходит и читается обратно', () => {
		// synthetic-example: шаблон ежемесячной подписки
		const tpl = {
			id: 'tpl-fake-subscription-001',
			name: 'Fake Subscription Example', // synthetic-example
			amount: 299, // synthetic-example
			currency: 'RUB',
			direction: 'out' as const,
			rrule: 'FREQ=MONTHLY;BYMONTHDAY=1',
			active: true,
			ts: '2026-06-01T00:00:00Z',
		};
		ledger.append('templates', tpl);
		const records = ledger.readAll('templates');
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject(tpl);
	});

	it('шаблон с tags и note проходит валидацию', () => {
		// synthetic-example: шаблон с дополнительными полями
		const tpl = {
			id: 'tpl-fake-rent-002',
			name: 'Fake Rent Example',
			amount: 30000, // synthetic-example
			currency: 'RUB',
			direction: 'out' as const,
			rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
			active: true,
			ts: '2026-06-01T00:00:00Z',
			tags: ['housing', 'recurring'],
			note: 'synthetic-example rent note',
		};
		ledger.append('templates', tpl);
		const records = ledger.readAll('templates');
		expect(records[0]?.tags).toContain('recurring');
	});

	it('пустой rrule режектится', () => {
		const result = TemplateRecordSchema.safeParse({
			id: 'tpl-bad',
			name: 'Bad Template',
			amount: 100,
			currency: 'RUB',
			direction: 'out',
			rrule: '', // нарушение: min(1)
			active: true,
			ts: '2026-06-01T00:00:00Z',
		});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 4. Round-trip: ReceivableRecord
// ---------------------------------------------------------------------------

describe('schema: ReceivableRecord — round-trip append + readAll', () => {
	let tmpDir: string;
	let ledger: Ledger;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'schema-receivable-'));
		ledger = makeLedger(tmpDir);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('корректная запись проходит и читается обратно', () => {
		// synthetic-example: кто-то должен мне денег
		const rec = {
			id: 'recv-fake-001',
			debtor: 'friend-abc', // synthetic-example, без PII
			amount: 5000, // synthetic-example
			currency: 'RUB',
			created_at: '2026-05-01T00:00:00Z',
			status: 'open' as const,
			ts: '2026-06-01T00:00:00Z',
		};
		ledger.append('receivables', rec);
		const records = ledger.readAll('receivables');
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject(rec);
	});

	it('статус "closed" с due_date проходит валидацию', () => {
		// synthetic-example: закрытый долг
		const rec = {
			id: 'recv-fake-002',
			debtor: 'colleague-xyz',
			amount: 1500,
			currency: 'RUB',
			created_at: '2026-04-01T00:00:00Z',
			due_date: '2026-05-01T00:00:00Z',
			status: 'closed' as const,
			ts: '2026-06-01T00:00:00Z',
			note: 'synthetic-example closed note',
		};
		const result = ReceivableRecordSchema.safeParse(rec);
		expect(result.success).toBe(true);
	});

	it('невалидный статус режектится', () => {
		const result = ReceivableRecordSchema.safeParse({
			id: 'recv-bad',
			debtor: 'someone',
			amount: 100,
			currency: 'RUB',
			created_at: '2026-06-01T00:00:00Z',
			status: 'unknown', // не входит в enum
			ts: '2026-06-01T00:00:00Z',
		});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 5. Round-trip: PayableRecord
// ---------------------------------------------------------------------------

describe('schema: PayableRecord — round-trip append + readAll', () => {
	let tmpDir: string;
	let ledger: Ledger;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'schema-payable-'));
		ledger = makeLedger(tmpDir);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('корректная запись проходит и читается обратно', () => {
		// synthetic-example: я должен деньги
		const pay = {
			id: 'pay-fake-001',
			creditor: 'vendor-abc', // synthetic-example, без PII
			amount: 10000, // synthetic-example
			currency: 'RUB',
			created_at: '2026-06-01T00:00:00Z',
			status: 'open' as const,
			ts: '2026-06-01T00:00:00Z',
		};
		ledger.append('payables', pay);
		const records = ledger.readAll('payables');
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject(pay);
	});

	it('статус "partial" валиден', () => {
		const result = PayableRecordSchema.safeParse({
			id: 'pay-fake-002',
			creditor: 'vendor-xyz',
			amount: 3000,
			currency: 'USD',
			created_at: '2026-06-01T00:00:00Z',
			status: 'partial',
			ts: '2026-06-01T00:00:00Z',
		});
		expect(result.success).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 6. Round-trip: SettingsRecord
// ---------------------------------------------------------------------------

describe('schema: SettingsRecord — round-trip append + readAll', () => {
	let tmpDir: string;
	let ledger: Ledger;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'schema-settings-'));
		ledger = makeLedger(tmpDir);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('минимальная запись (без thresholds) проходит и читается обратно', () => {
		// synthetic-example: базовые настройки
		const settings = {
			ts: '2026-06-01T00:00:00Z',
			display_currencies: ['RUB', 'USD', 'USDT'],
			tz: 'Europe/Moscow',
		};
		ledger.append('settings', settings);
		const records = ledger.readAll('settings');
		expect(records).toHaveLength(1);
		expect(records[0]?.display_currencies).toContain('RUB');
		expect(records[0]?.tz).toBe('Europe/Moscow');
	});

	it('полная запись с thresholds проходит валидацию', () => {
		// synthetic-example: настройки с порогами
		const result = SettingsRecordSchema.safeParse({
			ts: '2026-06-01T00:00:00Z',
			display_currencies: ['RUB', 'USD'],
			tz: 'Asia/Tbilisi',
			thresholds: {
				low_balance_alert: {
					amount: 5000, // synthetic-example
					currency: 'RUB',
				},
				budget_warn_pct: 80,
				fx_staleness_hours: 24,
			},
		});
		expect(result.success).toBe(true);
	});

	it('пустой список display_currencies режектится (min(1))', () => {
		const result = SettingsRecordSchema.safeParse({
			ts: '2026-06-01T00:00:00Z',
			display_currencies: [], // нарушение: min(1)
			tz: 'UTC',
		});
		expect(result.success).toBe(false);
	});

	it('budget_warn_pct > 100 режектится', () => {
		const result = SettingsRecordSchema.safeParse({
			ts: '2026-06-01T00:00:00Z',
			display_currencies: ['RUB'],
			tz: 'UTC',
			thresholds: {
				budget_warn_pct: 150, // нарушение: max(100)
			},
		});
		expect(result.success).toBe(false);
	});

	it('несколько append → readAll возвращает все (последнюю выбирает читатель)', () => {
		// synthetic-example: обновление настроек (append-only)
		const s1 = {
			ts: '2026-06-01T00:00:00Z',
			display_currencies: ['RUB'],
			tz: 'UTC',
		};
		const s2 = {
			ts: '2026-06-02T00:00:00Z',
			display_currencies: ['RUB', 'USD'],
			tz: 'Europe/Moscow',
		};
		ledger.append('settings', s1);
		ledger.append('settings', s2);
		const records = ledger.readAll('settings');
		// Оба хранятся (append-only) — читатель сам берёт последнюю
		expect(records).toHaveLength(2);
		expect(records[1]?.tz).toBe('Europe/Moscow');
	});
});

// ---------------------------------------------------------------------------
// 7. Path-guard по-прежнему работает для новых файлов
// ---------------------------------------------------------------------------

describe('schema: path-guard для новых типов файлов', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'schema-guard-'));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('LedgerPathError при записи budgets в публичный путь', () => {
		// financeDir ВНУТРИ publicRepoRoot — должен бросить LedgerPathError
		const publicRoot = join(tmpDir, 'public-repo');
		const financeDir = join(publicRoot, 'raw', 'finance');
		const badLedger = new Ledger({ financeDir, publicRepoRoot: publicRoot });

		expect(() =>
			badLedger.append('budgets', {
				id: 'budget-guard-test',
				category: 'food',
				period_start: '2026-06-01T00:00:00Z',
				period_end: '2026-07-01T00:00:00Z',
				limit_amount: 1000,
				currency: 'RUB',
				ts: '2026-06-01T00:00:00Z',
			}),
		).toThrow(LedgerPathError);
	});

	it('LedgerPathError при записи settings в публичный путь', () => {
		const publicRoot = join(tmpDir, 'public-repo');
		const financeDir = join(publicRoot, 'raw', 'finance');
		const badLedger = new Ledger({ financeDir, publicRepoRoot: publicRoot });

		expect(() =>
			badLedger.append('settings', {
				ts: '2026-06-01T00:00:00Z',
				display_currencies: ['RUB'],
				tz: 'UTC',
			}),
		).toThrow(LedgerPathError);
	});

	it('нет ошибки для корректных путей (finance вне public)', () => {
		// synthetic-example: нормальный кейс — finance в content-repo
		const contentRoot = join(tmpDir, 'content-repo');
		const financeDir = join(contentRoot, 'raw', 'finance');
		const publicRoot = join(tmpDir, 'public-repo'); // отдельное поддерево

		const goodLedger = new Ledger({ financeDir, publicRepoRoot: publicRoot });

		expect(() =>
			goodLedger.append('settings', {
				ts: '2026-06-01T00:00:00Z',
				display_currencies: ['RUB'],
				tz: 'UTC',
			}),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// 8. AccountRecord.kind — новые значения
// ---------------------------------------------------------------------------

describe('schema: AccountRecord.kind — расширенный enum', () => {
	it('kind="cash" валиден', () => {
		const result = AccountRecordSchema.safeParse({
			id: 'acc-fake-cash-001',
			source: 'manual',
			kind: 'cash',
			name: 'Cash Wallet Fake', // synthetic-example
			currency: 'RUB',
		});
		expect(result.success).toBe(true);
	});

	it('kind="checking" валиден', () => {
		const result = AccountRecordSchema.safeParse({
			id: 'acc-fake-checking-001',
			source: 'manual',
			kind: 'checking',
			name: 'Checking Account Fake',
			currency: 'RUB',
		});
		expect(result.success).toBe(true);
	});

	it('kind="savings" валиден', () => {
		const result = AccountRecordSchema.safeParse({
			id: 'acc-fake-savings-001',
			source: 'manual',
			kind: 'savings',
			name: 'Savings Account Fake',
			currency: 'RUB',
		});
		expect(result.success).toBe(true);
	});

	it('старые kind (bank, ewallet, exchange, loan) по-прежнему валидны', () => {
		// Проверяем обратную совместимость — старые записи не должны ломаться
		for (const kind of ['bank', 'ewallet', 'exchange', 'loan'] as const) {
			const result = AccountRecordSchema.safeParse({
				id: `acc-fake-${kind}-001`,
				source: 'test',
				kind,
				name: `Fake ${kind} Account`,
				currency: 'RUB',
			});
			expect(result.success).toBe(true);
		}
	});

	it('невалидный kind режектится', () => {
		const result = AccountRecordSchema.safeParse({
			id: 'acc-bad',
			source: 'test',
			kind: 'crypto-wallet', // нет в enum
			name: 'Bad Kind',
			currency: 'RUB',
		});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 9. CreditRecord — обратная совместимость (старые поля без новых)
// ---------------------------------------------------------------------------

describe('schema: CreditRecord — обратная совместимость', () => {
	it('старый набор полей (без амортизации) всё ещё валиден', () => {
		// synthetic-example: запись в стиле Phase-0 (без новых опциональных полей)
		const result = CreditRecordSchema.safeParse({
			id: 'credit-legacy-fake-001',
			source: 'manual',
			principal: 200000, // synthetic-example
			currency: 'RUB',
			rate_pct: 19.9, // synthetic-example
			opened_at: '2025-03-01T00:00:00Z',
			balance: 180000, // synthetic-example
			balance_ts: '2026-06-01T00:00:00Z',
			manual: true,
			// NB: нет monthly_payment, term, type, penalty_rate, grace, credit_limit
		});
		expect(result.success).toBe(true);
	});

	it('новые поля амортизации валидируются корректно', () => {
		// synthetic-example: запись с полным набором полей амортизации
		const result = CreditRecordSchema.safeParse({
			id: 'credit-full-fake-001',
			source: 'manual',
			principal: 500000, // synthetic-example
			currency: 'RUB',
			rate_pct: 21.5,
			opened_at: '2025-01-01T00:00:00Z',
			due_at: '2027-01-01T00:00:00Z', // дата ПОЛНОГО погашения
			balance: 450000,
			balance_ts: '2026-06-01T00:00:00Z',
			manual: true,
			monthly_payment: 25000,
			next_payment_date: '2026-07-01T00:00:00Z',
			payment_day: 1,
			term: 24, // 2 года
			type: 'annuity',
			penalty_rate: 36.0,
			grace: 5,
		});
		expect(result.success).toBe(true);
	});

	it('credit_limit опционален и проходит валидацию', () => {
		const result = CreditRecordSchema.safeParse({
			id: 'credit-card-fake-001',
			source: 'manual',
			principal: 50000,
			currency: 'RUB',
			balance: 20000,
			balance_ts: '2026-06-01T00:00:00Z',
			manual: true,
			credit_limit: 100000, // кредитный лимит карты
			type: 'annuity',
		});
		expect(result.success).toBe(true);
	});

	it('невалидный type (не annuity|differentiated) режектится', () => {
		const result = CreditRecordSchema.safeParse({
			id: 'credit-bad',
			source: 'manual',
			principal: 100000,
			currency: 'RUB',
			balance: 90000,
			balance_ts: '2026-06-01T00:00:00Z',
			manual: true,
			type: 'balloon', // нет в enum
		});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 10. TransactionRecord — обратная совместимость
// ---------------------------------------------------------------------------

describe('schema: TransactionRecord — обратная совместимость', () => {
	it('старый набор полей (без новых опциональных) всё ещё валиден', () => {
		// synthetic-example: старая запись без tags/transfer_id/source и т.п.
		const result = TransactionRecordSchema.safeParse({
			id: 'tx-legacy-fake-001',
			ts: '2026-06-10T12:00:00Z',
			account_id: 'acc-fake-001',
			amount: 500, // synthetic-example
			currency: 'USDT',
			direction: 'in',
			category: 'deposit',
			raw_ref: 'tx-orig-fake-001',
			// NB: нет tags, transfer_id, void_id, amended_id, source, is_subscription, goal_tag
		});
		expect(result.success).toBe(true);
	});

	it('новые поля (tags, transfer_id, source, goal_tag) проходят валидацию', () => {
		// synthetic-example: расширенная запись с новыми полями
		const result = TransactionRecordSchema.safeParse({
			id: 'tx-new-fake-001',
			ts: '2026-06-10T12:00:00Z',
			account_id: 'acc-fake-001',
			amount: 1500,
			currency: 'RUB',
			direction: 'out',
			category: 'grocery',
			tags: ['weekly-shop', 'recurring'],
			source: 'manual',
			is_subscription: false,
			goal_tag: 'emergency-fund-2026',
		});
		expect(result.success).toBe(true);
	});

	it('transfer_id + void_id опциональны и независимы', () => {
		const result = TransactionRecordSchema.safeParse({
			id: 'tx-transfer-fake-001',
			ts: '2026-06-10T12:00:00Z',
			account_id: 'acc-fake-002',
			amount: 10000,
			currency: 'RUB',
			direction: 'out',
			transfer_id: 'transfer-fake-abc', // перевод между своими счетами
		});
		expect(result.success).toBe(true);
	});

	it('невалидный source режектится', () => {
		const result = TransactionRecordSchema.safeParse({
			id: 'tx-bad-source',
			ts: '2026-06-10T12:00:00Z',
			account_id: 'acc-fake-001',
			amount: 100,
			currency: 'RUB',
			direction: 'in',
			source: 'telegram', // нет в enum
		});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 11. FinanceGoalSchema — валидация фронтматтера страниц вики
// ---------------------------------------------------------------------------

describe('schema: FinanceGoalSchema — фронтматтер страниц type:finance-goal', () => {
	it('корректный фронтматтер (save) парсится успешно', () => {
		// synthetic-example: цель накопления подушки безопасности
		const result = FinanceGoalSchema.safeParse({
			id: 'emergency-fund-fake-2026',
			type: 'finance-goal',
			target_amount: 300000, // synthetic-example
			currency: 'RUB',
			target_date: '2026-12-31T23:59:59Z',
			fin_kind: 'save',
		});
		expect(result.success).toBe(true);
	});

	it('fin_kind="debt_paydown" с linked_accounts парсится', () => {
		// synthetic-example: цель погашения кредита
		const result = FinanceGoalSchema.safeParse({
			id: 'debt-paydown-fake-credit-001',
			type: 'finance-goal',
			target_amount: 450000, // synthetic-example
			currency: 'RUB',
			target_date: '2027-01-01T00:00:00Z',
			fin_kind: 'debt_paydown',
			linked_accounts: ['credit-fake-001'], // ссылка на CreditRecord.id
			priority: 1,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.linked_accounts).toContain('credit-fake-001');
		}
	});

	it('fin_kind="spend_cap" валиден', () => {
		const result = FinanceGoalSchema.safeParse({
			id: 'spend-cap-fake-food-2026',
			type: 'finance-goal',
			target_amount: 20000,
			currency: 'RUB',
			target_date: '2026-12-31T00:00:00Z',
			fin_kind: 'spend_cap',
		});
		expect(result.success).toBe(true);
	});

	it('fin_kind="grow" валиден', () => {
		const result = FinanceGoalSchema.safeParse({
			id: 'portfolio-grow-fake-2027',
			type: 'finance-goal',
			target_amount: 5000, // synthetic-example в USDT
			currency: 'USDT',
			target_date: '2027-01-01T00:00:00Z',
			fin_kind: 'grow',
		});
		expect(result.success).toBe(true);
	});

	it('неверный type (не "finance-goal") режектится', () => {
		const result = FinanceGoalSchema.safeParse({
			id: 'bad-goal',
			type: 'account', // не 'finance-goal'
			target_amount: 100000,
			currency: 'RUB',
			target_date: '2026-12-31T00:00:00Z',
			fin_kind: 'save',
		});
		expect(result.success).toBe(false);
	});

	it('неверный fin_kind режектится', () => {
		const result = FinanceGoalSchema.safeParse({
			id: 'bad-goal-kind',
			type: 'finance-goal',
			target_amount: 100000,
			currency: 'RUB',
			target_date: '2026-12-31T00:00:00Z',
			fin_kind: 'invest', // нет в enum
		});
		expect(result.success).toBe(false);
	});

	it('target_amount <= 0 режектится (positive())', () => {
		const result = FinanceGoalSchema.safeParse({
			id: 'bad-amount',
			type: 'finance-goal',
			target_amount: -1000, // нарушение: positive()
			currency: 'RUB',
			target_date: '2026-12-31T00:00:00Z',
			fin_kind: 'save',
		});
		expect(result.success).toBe(false);
	});

	it('отсутствие обязательного поля (id) режектится', () => {
		const result = FinanceGoalSchema.safeParse({
			// нет id
			type: 'finance-goal',
			target_amount: 100000,
			currency: 'RUB',
			target_date: '2026-12-31T00:00:00Z',
			fin_kind: 'save',
		});
		expect(result.success).toBe(false);
	});

	it('priority < 0 режектится (nonnegative())', () => {
		const result = FinanceGoalSchema.safeParse({
			id: 'bad-priority',
			type: 'finance-goal',
			target_amount: 100000,
			currency: 'RUB',
			target_date: '2026-12-31T00:00:00Z',
			fin_kind: 'save',
			priority: -1, // нарушение: nonnegative()
		});
		expect(result.success).toBe(false);
	});
});
