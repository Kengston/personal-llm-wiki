/**
 * ledger.ts — append-only JSONL-леджер для финансовых записей.
 *
 * Реализует запись и чтение 5 типов записей ([ADR-0018]) из приватного репо
 * `llm-wiki-content/raw/finance/`. Принципы:
 *
 *   1. APPEND-ONLY: файлы никогда не перезаписываются целиком — только дозаписываются.
 *      Это обеспечивает исторический audit trail и совместимость с git.
 *
 *   2. ВАЛИДАЦИЯ ПЕРЕД ЗАПИСЬЮ: каждая запись валидируется zod-схемой до append'а.
 *      Невалидная запись → исключение, файл не изменяется.
 *
 *   3. PATH-ALLOWLIST GUARD (критический, обязателен по ADR-0018):
 *      Перед любой записью проверяем, что целевой путь:
 *        (а) находится ВНУТРИ `<CONTENT_ROOT>/raw/finance/`
 *        (б) НЕ находится под корнем публичного репо (`<PUBLIC_REPO>/`)
 *      Нарушение → LedgerPathError (запись не происходит).
 *      Это runtime-барьер против случайного коммита финансовых данных в публичный репо.
 *
 *   4. БЕЗ СЕКРЕТОВ: в записях нет ни токенов, ни PII (банковских номеров, адресов).
 *      Формат хранения — числовые балансы + детерминированные id-хэши.
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

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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

// ---------------------------------------------------------------------------
// Ошибки
// ---------------------------------------------------------------------------

/**
 * LedgerPathError — выбрасывается при нарушении path-allowlist guard'а.
 * Означает, что вызывающий пытается записать финансовые данные в недопустимый
 * путь (публичный репо или за пределами CONTENT_ROOT/raw/finance/).
 */
export class LedgerPathError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LedgerPathError';
	}
}

/**
 * LedgerValidationError — выбрасывается при провале zod-валидации записи.
 */
export class LedgerValidationError extends Error {
	constructor(
		message: string,
		public readonly cause: unknown,
	) {
		super(message);
		this.name = 'LedgerValidationError';
	}
}

// ---------------------------------------------------------------------------
// Path-allowlist guard (критический)
// ---------------------------------------------------------------------------

/**
 * assertPathAllowed — критический guard перед любой записью.
 *
 * Правила:
 *   1. `targetPath` должен находиться ВНУТРИ `allowedDir` (raw/finance).
 *   2. `targetPath` НЕ должен находиться внутри `publicRepoRoot`.
 *
 * Оба пути резолвятся в realpath через `resolve()` (убирает `..`, симлинки
 * на стадии проверки — resolve не следует симлинкам, но нормализует сегменты).
 * Нарушение → LedgerPathError; файл не трогается.
 *
 * @param targetPath   — абсолютный путь к файлу леджера (куда пишем)
 * @param allowedDir   — обязательный prefix-каталог (raw/finance)
 * @param publicRepoRoot — корень публичного репо (запрещённый prefix)
 */
export function assertPathAllowed(targetPath: string, allowedDir: string, publicRepoRoot: string): void {
	// Нормализуем пути (resolve убирает ../, ./, лишние слэши).
	// Добавляем trailing-separator, чтобы /foo/bar не совпало с /foo/barbaz.
	const normalTarget = resolve(targetPath);
	const normalAllowed = resolve(allowedDir) + '/';
	const normalPublic = resolve(publicRepoRoot) + '/';

	// Правило 1: targetPath должен начинаться с allowedDir.
	if (!normalTarget.startsWith(normalAllowed)) {
		throw new LedgerPathError(
			`Финансовые данные можно записывать только под ${normalAllowed}. ` +
				`Получен путь: ${normalTarget}. ` +
				'Проверьте переменную CONTENT_ROOT и вызов Ledger.',
		);
	}

	// Правило 2: targetPath НЕ должен лежать под публичным репо.
	if (normalTarget.startsWith(normalPublic)) {
		throw new LedgerPathError(
			`ЗАПРЕЩЕНО: целевой путь находится под корнем публичного репо (${normalPublic}). ` +
				`Путь: ${normalTarget}. ` +
				'Финансовые данные никогда не должны попадать в публичный репо ([ADR-0003], [ADR-0018]).',
		);
	}
}

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

/**
 * resolvePublicRepo — возвращает абсолютный путь к публичному репо.
 *
 * Порядок:
 *   1. env.PUBLIC_REPO — явное переопределение (совпадает с scheduler/config.ts)
 *   2. import.meta.dirname/../../../ — т.е. корень пакета (src/ingest/finance → ../../..)
 */
export function resolvePublicRepo(env: NodeJS.ProcessEnv = process.env): string {
	if (env.PUBLIC_REPO) return resolve(env.PUBLIC_REPO);
	// dist/ingest/finance/ledger.js → ../../.. → корень пакета
	// src/ingest/finance/ledger.ts  → ../../.. → корень пакета (через tsc outDir)
	return resolve(import.meta.dirname, '..', '..', '..');
}

// ---------------------------------------------------------------------------
// Ядро леджера
// ---------------------------------------------------------------------------

/**
 * Zod-схемы по ключу файла леджера — для универсального appendRecord().
 *
 * При добавлении нового типа: (1) добавить схему сюда, (2) добавить тип в
 * RecordTypeMap ниже. Остальной код Ledger (append/readAll) подхватит автоматически.
 */
const SCHEMAS = {
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
 * Должен быть синхронен с LEDGER_FILES в types.ts и SCHEMAS выше.
 */
type RecordTypeMap = {
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
 * LedgerOptions — зависимости, которые можно переопределить в тестах.
 */
export interface LedgerOptions {
	/** Каталог raw/finance/ (куда писать). По умолчанию resolveFinanceDir(). */
	financeDir?: string;
	/** Корень публичного репо (запрещённый prefix). По умолчанию resolvePublicRepo(). */
	publicRepoRoot?: string;
	/** Окружение для резолвинга путей. По умолчанию process.env. */
	env?: NodeJS.ProcessEnv;
}

/**
 * Ledger — класс для append-only записи и чтения JSONL-леджера.
 *
 * Создание:
 *   const ledger = new Ledger();                         // пути из env
 *   const ledger = new Ledger({ financeDir: '/tmp/...' }); // для тестов
 *
 * Запись:
 *   ledger.append('accounts', record);     // валидирует + записывает
 *
 * Чтение:
 *   const accounts = ledger.readAll('accounts');
 */
export class Ledger {
	private readonly financeDir: string;
	private readonly publicRepoRoot: string;

	constructor(opts: LedgerOptions = {}) {
		const env = opts.env ?? process.env;
		// FinanceDir: или явный аргумент, или из окружения.
		this.financeDir = opts.financeDir ?? resolveFinanceDir(env);
		// PublicRepoRoot: или явный аргумент, или из окружения.
		this.publicRepoRoot = opts.publicRepoRoot ?? resolvePublicRepo(env);
	}

	/**
	 * filePath — возвращает абсолютный путь к файлу леджера для данного ключа.
	 * Не создаёт каталог — только вычисляет путь.
	 */
	filePath(key: LedgerFileKey): string {
		return join(this.financeDir, LEDGER_FILES[key]);
	}

	/**
	 * append — валидирует запись zod-схемой и дозаписывает одну JSON-строку в JSONL.
	 *
	 * Порядок действий:
	 *   1. Path-allowlist guard (LedgerPathError при нарушении).
	 *   2. Zod-валидация (LedgerValidationError при несоответствии схеме).
	 *   3. mkdirSync (идемпотентно, recursive).
	 *   4. appendFileSync — атомарная дозапись одной строки (O_APPEND семантика).
	 *
	 * Ошибка на любом шаге → исключение, файл не изменяется.
	 *
	 * @param key    — ключ файла леджера ('accounts' | 'snapshots' | ...)
	 * @param record — запись для валидации и сохранения
	 */
	append<K extends LedgerFileKey>(key: K, record: RecordTypeMap[K]): void {
		const targetPath = this.filePath(key);

		// ── Шаг 1: path-allowlist guard ──────────────────────────────────────────
		assertPathAllowed(targetPath, this.financeDir, this.publicRepoRoot);

		// ── Шаг 2: zod-валидация ─────────────────────────────────────────────────
		const schema = SCHEMAS[key];
		const result = schema.safeParse(record);
		if (!result.success) {
			throw new LedgerValidationError(
				`Запись не прошла валидацию схемы '${key}': ${result.error.message}`,
				result.error,
			);
		}

		// ── Шаг 3: создаём каталог если нужно ───────────────────────────────────
		mkdirSync(this.financeDir, { recursive: true });

		// ── Шаг 4: append одной JSON-строки ──────────────────────────────────────
		// JSON.stringify без форматирования → компактный JSONL (одна запись = одна строка).
		// Сохраняем validated data (result.data), а не исходный record,
		// чтобы strip unknown-полей (zod по умолчанию делает strip).
		appendFileSync(targetPath, JSON.stringify(result.data) + '\n', { encoding: 'utf8', flag: 'a' });
	}

	/**
	 * readAll — читает весь файл леджера и парсит каждую строку.
	 *
	 * Возвращает только валидные записи. Невалидные или пустые строки
	 * молча пропускаются (warn в stderr) — чтобы не ломаться при ручных правках
	 * или частично записанных строках.
	 *
	 * @param key — ключ файла леджера
	 * @returns массив записей (возможно пустой если файл не существует)
	 */
	readAll<K extends LedgerFileKey>(key: K): RecordTypeMap[K][] {
		const filePath = this.filePath(key);

		// Файл может не существовать (первый sync) — возвращаем пустой массив.
		if (!existsSync(filePath)) return [];

		const content = readFileSync(filePath, 'utf8');
		const schema = SCHEMAS[key];
		const results: RecordTypeMap[K][] = [];

		for (const line of content.split('\n')) {
			const trimmed = line.trim();
			// Пустые строки — нормально (хвостовой \n у каждой записи).
			if (!trimmed) continue;

			let raw: unknown;
			try {
				raw = JSON.parse(trimmed);
			} catch (e) {
				// Непарсируемая строка — предупреждаем, пропускаем.
				process.stderr.write(`[ledger] ${key}: не удалось распарсить строку JSON: ${String(e)}\n`);
				continue;
			}

			const parsed = schema.safeParse(raw);
			if (!parsed.success) {
				// Невалидная запись — предупреждаем, пропускаем.
				process.stderr.write(`[ledger] ${key}: пропущена невалидная запись: ${parsed.error.message}\n`);
				continue;
			}

			results.push(parsed.data as RecordTypeMap[K]);
		}

		return results;
	}
}

// ---------------------------------------------------------------------------
// Фабрика-синглтон (convenience)
// ---------------------------------------------------------------------------

/**
 * createLedger — создаёт Ledger с переданными опциями.
 * Используется в syncBybit() и будущих коннекторах.
 *
 * @param opts — опции (financeDir, publicRepoRoot, env)
 */
export function createLedger(opts: LedgerOptions = {}): Ledger {
	return new Ledger(opts);
}
