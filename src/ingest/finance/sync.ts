/**
 * sync.ts — оркестратор синхронизации Bybit → леджер.
 *
 * Экспортирует `syncBybit(deps)` — чистую функцию с явными зависимостями
 * (http-клиент, env, ledger, fx). Диспетчер планировщика/routine вызовет её
 * в Phase 2 (--source bybit); сейчас она не подключена к routines.ts.
 *
 * CLI-обёртка внизу файла: `node dist/ingest/finance/sync.js --dry-run` работает
 * только если заданы BYBIT_API_KEY и BYBIT_API_SECRET в окружении. Без них
 * выводит инструкцию и выходит без ошибки.
 *
 * ПОРЯДОК SYNC:
 *   1. getWalletBalance() → normalizeWalletBalance() → append accounts + snapshots.
 *   2. getTransactionLog() → normalizeTransactionLog() → append transactions.
 *   3. Для каждой уникальной монеты: rate(coin→USD) + rate(USD→RUB) → append fx_rates.
 *   4. Возвращает SyncResult с количеством записанных объектов.
 *
 * ИДЕМПОТЕНТНОСТЬ: леджер append-only — повторный sync добавит дубли снапшотов/fx_rates.
 * Это нормально: читатель берёт последний по `ts`. Транзакции — по `raw_ref` дедуп
 * делает reader (или future dedup-pass). Добавление dedup-по-raw_ref в самом sync'е
 * оставлено как Phase 2 (readAll + Set check перед append'ом).
 */

import { childLogger } from '../../core/logger.js';
import { BybitClient, type BybitClientConfig } from './bybit.js';
import { createDefaultFxProvider, type FxProvider } from './fx.js';
import { createLedger, type Ledger, type LedgerOptions } from './ledger.js';
import { makeFxRateRecord, normalizeTransactionLog, normalizeWalletBalance, nowIso } from './normalize.js';
import { isMainModule } from '../../core/cli.js';

const log = childLogger('finance.sync');

// ---------------------------------------------------------------------------
// Зависимости синка
// ---------------------------------------------------------------------------

/**
 * SyncDeps — явные зависимости syncBybit().
 * Все поля опциональны — defaults для прод-запуска; переопределяются в тестах.
 */
export interface SyncDeps {
	/** Bybit API клиент. По умолчанию создаётся из process.env. */
	bybitClient?: BybitClient;
	/** Окружение (для BybitClient и Ledger). По умолчанию process.env. */
	env?: NodeJS.ProcessEnv;
	/** Ledger для записи. По умолчанию создаётся из env. */
	ledger?: Ledger;
	/** FX-провайдер. По умолчанию createDefaultFxProvider(). */
	fxProvider?: FxProvider;
	/** Конфигурация HTTP-клиента (инъекция fetchFn для тестов). */
	bybitConfig?: BybitClientConfig;
	/** Конфигурация леджера (переопределение путей для тестов). */
	ledgerOptions?: LedgerOptions;
	/** Если true — не записывать в леджер (только логировать). Для тестов/dry-run. */
	dryRun?: boolean;
	/** Инъекция функции текущего времени (для детерминированных тестов). */
	nowFn?: () => Date;
}

/**
 * SyncResult — итог одного прогона syncBybit().
 */
export interface SyncResult {
	/** Количество записанных AccountRecord. */
	accountsWritten: number;
	/** Количество записанных SnapshotRecord. */
	snapshotsWritten: number;
	/** Количество записанных TransactionRecord. */
	transactionsWritten: number;
	/** Количество записанных FxRateRecord. */
	fxRatesWritten: number;
	/** Момент начала синка (ISO). */
	syncTs: string;
	/** Список ошибок (не фатальных: sync завершился, но часть данных пропущена). */
	warnings: string[];
}

// ---------------------------------------------------------------------------
// Ядро синка
// ---------------------------------------------------------------------------

/**
 * syncBybit — оркестратор: Bybit API → леджер.
 *
 * Вызывается будущим диспетчером routines.ts (Phase 2). Сейчас — standalone функция
 * с явными зависимостями (dependency injection pattern как в bridge/engine.ts).
 *
 * @param deps — зависимости (http-клиент, env, ledger, fx); все опциональны
 * @returns SyncResult — статистика записи
 */
export async function syncBybit(deps: SyncDeps = {}): Promise<SyncResult> {
	// Резолвим зависимости.
	const env = deps.env ?? process.env;
	const nowFn = deps.nowFn ?? (() => new Date());
	const syncTs = nowIso(nowFn);
	const dryRun = deps.dryRun ?? false;

	const bybitClient = deps.bybitClient ?? new BybitClient({ ...(deps.bybitConfig ?? {}), env });
	const ledger = deps.ledger ?? createLedger({ ...(deps.ledgerOptions ?? {}), env });
	const fxProvider = deps.fxProvider ?? createDefaultFxProvider();

	const result: SyncResult = {
		accountsWritten: 0,
		snapshotsWritten: 0,
		transactionsWritten: 0,
		fxRatesWritten: 0,
		syncTs,
		warnings: [],
	};

	// ── Шаг 1: Wallet balance → accounts + snapshots ─────────────────────────
	log.info({ syncTs, dryRun }, 'bybit sync: getWalletBalance');

	let balanceResult;
	try {
		balanceResult = await bybitClient.getWalletBalance();
	} catch (e) {
		// Ошибка чтения баланса — критично, прерываем sync.
		// Ключи НИКОГДА не попадают в сообщение ошибки (BybitClient это гарантирует).
		const msg = `getWalletBalance провалился: ${String(e)}`;
		log.error({ err: String(e) }, msg);
		result.warnings.push(msg);
		return result;
	}

	const { accounts, snapshots } = normalizeWalletBalance(balanceResult, syncTs);
	log.info({ coins: accounts.length }, 'нормализовано монет');

	// Записываем accounts + snapshots.
	for (const account of accounts) {
		if (!dryRun) ledger.append('accounts', account);
		result.accountsWritten++;
	}
	for (const snapshot of snapshots) {
		if (!dryRun) ledger.append('snapshots', snapshot);
		result.snapshotsWritten++;
	}

	// ── Шаг 2: Transaction log → transactions ────────────────────────────────
	log.info({ syncTs }, 'bybit sync: getTransactionLog');

	let txEntries: import('./bybit.js').BybitTransactionLogEntry[];
	try {
		txEntries = await bybitClient.getTransactionLog();
	} catch (e) {
		// Транзакции не критичны — предупреждаем, но продолжаем (балансы уже записаны).
		const msg = `getTransactionLog провалился: ${String(e)}`;
		log.warn({ err: String(e) }, msg);
		result.warnings.push(msg);
		txEntries = [];
	}

	const transactions = normalizeTransactionLog(txEntries);
	log.info({ txCount: transactions.length }, 'нормализовано транзакций');

	for (const tx of transactions) {
		if (!dryRun) ledger.append('transactions', tx);
		result.transactionsWritten++;
	}

	// ── Шаг 3: FX-курсы для каждой уникальной монеты ────────────────────────
	// Собираем уникальные монеты из accounts (снапшот монет текущего sync'а).
	const coins = [...new Set(accounts.map((a) => a.currency))];

	for (const coin of coins) {
		// Пара coin/USD (для биржевой стоимости).
		await appendFxRate(coin, 'USD', fxProvider, syncTs, ledger, result, dryRun);
		// Пара USD/RUB (для отображения в рублях).
		await appendFxRate('USD', 'RUB', fxProvider, syncTs, ledger, result, dryRun);
	}

	log.info(
		{
			accounts: result.accountsWritten,
			snapshots: result.snapshotsWritten,
			transactions: result.transactionsWritten,
			fxRates: result.fxRatesWritten,
			warnings: result.warnings.length,
		},
		'bybit sync завершён',
	);

	return result;
}

/**
 * appendFxRate — получает курс и записывает FxRateRecord.
 * При null-результате (курс недоступен) — добавляет предупреждение, не падает.
 */
async function appendFxRate(
	base: string,
	quote: string,
	fxProvider: FxProvider,
	syncTs: string,
	ledger: Ledger,
	result: SyncResult,
	dryRun: boolean,
): Promise<void> {
	// Одинаковые валюты — курс 1, не пишем (IdentityFxProvider обработает при запросе).
	if (base.toUpperCase() === quote.toUpperCase()) return;

	let rate: number | null;
	try {
		rate = await fxProvider.rate(base, quote, syncTs);
	} catch {
		rate = null;
	}

	if (rate === null) {
		result.warnings.push(`курс ${base}/${quote} недоступен — fx_rate не записан`);
		return;
	}

	const record = makeFxRateRecord(base, quote, rate, 'default', syncTs);
	if (!dryRun) ledger.append('fx_rates', record);
	result.fxRatesWritten++;
}

// ---------------------------------------------------------------------------
// CLI (опциональный, guard на env)
// ---------------------------------------------------------------------------

/**
 * main — точка входа CLI. Запускается только если BYBIT_API_KEY задан.
 * Без ключей выводит инструкцию и выходит с кодом 0 (не ошибка).
 *
 * Пример:
 *   BYBIT_API_KEY=xxx BYBIT_API_SECRET=yyy node dist/ingest/finance/sync.js
 *   node dist/ingest/finance/sync.js --dry-run   # выведет план без записи
 */
async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
	const dryRun = argv.includes('--dry-run');

	// Guard: без ключей — выводим инструкцию, не ошибку.
	const hasKey = !!(process.env.BYBIT_API_KEY?.trim());
	const hasSecret = !!(process.env.BYBIT_API_SECRET?.trim());

	if (!hasKey || !hasSecret) {
		process.stdout.write(
			'Bybit sync: BYBIT_API_KEY и BYBIT_API_SECRET не заданы — ничего не делаем.\n' +
				'Задайте их в .env приватного репо llm-wiki-content (никогда в публичном репо).\n',
		);
		return 0;
	}

	try {
		const result = await syncBybit({ dryRun });
		if (dryRun) {
			process.stdout.write('[dry-run] sync завершён без записи:\n');
		}
		process.stdout.write(
			`accounts: ${result.accountsWritten}, snapshots: ${result.snapshotsWritten}, ` +
				`transactions: ${result.transactionsWritten}, fx_rates: ${result.fxRatesWritten}\n`,
		);
		if (result.warnings.length > 0) {
			for (const w of result.warnings) process.stderr.write(`[warn] ${w}\n`);
		}
		return 0;
	} catch (e) {
		process.stderr.write(`[error] syncBybit: ${String(e)}\n`);
		return 1;
	}
}

if (isMainModule(import.meta.filename)) {
	void main().then((code) => process.exit(code));
}
