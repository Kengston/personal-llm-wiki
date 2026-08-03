/**
 * ledger.ts — спецификация финансового леджера ([ADR-0018]).
 *
 * Механика append-only записи, path-allowlist guard и чтения живёт в общем
 * `src/ingest/ledger.ts` (параметризация по [ADR-0028]); здесь — только то, что
 * специфично для финансов: карта файлов, карта схем и резолвинг каталога.
 * Общий класс не знает слова «финансы», а финансовый модуль не знает, что этим
 * же классом пользуются карьера и воронка поиска работы.
 *
 * Пути по умолчанию:
 *   contentRoot = env.CONTENT_ROOT ?? ~/llm-wiki-content
 *   rawFinanceDir = <contentRoot>/raw/finance/
 *
 * Файлы леджера:
 *   accounts.jsonl      — описания счетов (AccountRecord)
 *   snapshots.jsonl     — снапшоты балансов (SnapshotRecord)
 *   transactions.jsonl  — транзакции (TransactionRecord)
 *   credits.jsonl       — кредиты (CreditRecord)
 *   fx_rates.jsonl      — курсы валют (FxRateRecord)
 *   budgets.jsonl       — бюджеты по категориям (BudgetRecord)
 *   categories.jsonl    — справочник категорий (CategoryRecord)
 *   templates.jsonl     — шаблоны повторяющихся операций (TemplateRecord)
 *   receivables.jsonl   — долги мне (ReceivableRecord)
 *   payables.jsonl      — мои долги (PayableRecord)
 *   settings.jsonl      — настройки модуля (SettingsRecord)
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { Ledger, type LedgerOptions, type LedgerSpec } from '../ledger.js';
import {
	AccountRecordSchema,
	BudgetRecordSchema,
	CategoryRecordSchema,
	CreditRecordSchema,
	FxRateRecordSchema,
	LEDGER_FILES,
	PayableRecordSchema,
	ReceivableRecordSchema,
	SettingsRecordSchema,
	SnapshotRecordSchema,
	TemplateRecordSchema,
	TransactionRecordSchema,
	type AccountRecord,
	type BudgetRecord,
	type CategoryRecord,
	type CreditRecord,
	type FxRateRecord,
	type LedgerFileKey,
	type PayableRecord,
	type ReceivableRecord,
	type SettingsRecord,
	type SnapshotRecord,
	type TemplateRecord,
	type TransactionRecord,
} from './types.js';

// Ошибки и guard — общие для всех модулей данных; реэкспортируем, чтобы
// существующие импорты из finance/ledger.js продолжали работать.
export {
	assertPathAllowed,
	Ledger,
	LedgerPathError,
	LedgerValidationError,
	resolvePublicRepo,
	type LedgerOptions,
	type LedgerSkip,
} from '../ledger.js';

// ---------------------------------------------------------------------------
// Разрешение путей из окружения
// ---------------------------------------------------------------------------

/**
 * resolveFinanceDir — возвращает абсолютный путь к raw/finance/ приватного репо.
 *
 * Порядок поиска:
 *   1. env.FINANCE_RAW_DIR     — явное переопределение для тестов и нестандартных сетапов
 *   2. env.RAW_DIR + '/finance' — raw-каталог из scheduler/config.ts
 *   3. env.CONTENT_ROOT + '/raw/finance'
 *   4. ~/llm-wiki-content/raw/finance  — дефолт по аналогии со scheduler/config.ts
 */
export function resolveFinanceDir(env: NodeJS.ProcessEnv = process.env): string {
	if (env.FINANCE_RAW_DIR) return resolve(env.FINANCE_RAW_DIR);
	if (env.RAW_DIR) return resolve(join(env.RAW_DIR, 'finance'));
	const contentRoot = env.CONTENT_ROOT ?? join(homedir(), 'llm-wiki-content');
	return resolve(join(contentRoot, 'raw', 'finance'));
}

// ---------------------------------------------------------------------------
// Спецификация финансового леджера
// ---------------------------------------------------------------------------

/**
 * Zod-схемы по ключу файла леджера — для универсального append().
 *
 * При добавлении нового типа: (1) добавить схему сюда, (2) добавить тип в
 * FinanceRecordMap ниже, (3) добавить имя файла в LEDGER_FILES (types.ts).
 */
const FINANCE_SCHEMAS = {
	accounts: AccountRecordSchema,
	snapshots: SnapshotRecordSchema,
	transactions: TransactionRecordSchema,
	credits: CreditRecordSchema,
	fx_rates: FxRateRecordSchema,
	// Новые файлы (E4) — аддитивно
	budgets: BudgetRecordSchema,
	categories: CategoryRecordSchema,
	templates: TemplateRecordSchema,
	receivables: ReceivableRecordSchema,
	payables: PayableRecordSchema,
	settings: SettingsRecordSchema,
} as const;

/**
 * Типы записей по ключу файла — для корректных сигнатур append/readAll.
 * Должен быть синхронен с LEDGER_FILES в types.ts и FINANCE_SCHEMAS выше.
 */
export type FinanceRecordMap = {
	accounts: AccountRecord;
	snapshots: SnapshotRecord;
	transactions: TransactionRecord;
	credits: CreditRecord;
	fx_rates: FxRateRecord;
	// Новые типы (E4)
	budgets: BudgetRecord;
	categories: CategoryRecord;
	templates: TemplateRecord;
	receivables: ReceivableRecord;
	payables: PayableRecord;
	settings: SettingsRecord;
};

/**
 * FINANCE_LEDGER — спецификация финансового модуля для общего класса Ledger.
 * Каталог зашит в спеку: леджер, созданный с ней, физически не умеет писать
 * куда-либо, кроме raw/finance/ (и наоборот — карьерный не умеет писать сюда).
 */
export const FINANCE_LEDGER: LedgerSpec<FinanceRecordMap> = {
	files: LEDGER_FILES,
	schemas: FINANCE_SCHEMAS,
	resolveDir: resolveFinanceDir,
};

/** FinanceLedger — леджер, специализированный картой финансовых записей. */
export type FinanceLedger = Ledger<FinanceRecordMap>;

/** Ключ файла финансового леджера. Реэкспорт для существующих импортов. */
export type { LedgerFileKey };

/**
 * createLedger — создаёт финансовый Ledger с переданными опциями.
 * Используется в syncBybit(), мосте и тестах.
 *
 * @param opts — опции (dir, publicRepoRoot, env, onSkip)
 */
export function createLedger(opts: LedgerOptions = {}): FinanceLedger {
	return new Ledger(FINANCE_LEDGER, opts);
}
