/**
 * normalize.ts — маппинг ответов Bybit API → записи леджера.
 *
 * Принципы нормализации ([ADR-0018]):
 *
 *   1. НАТИВНАЯ ВАЛЮТА: каждый AccountRecord и SnapshotRecord создаётся в
 *      монете кармана (BTC, USDT, ETH …). Никаких конвертаций — balance нативный.
 *
 *   2. ДЕТЕРМИНИРОВАННЫЕ ID: `account_id` строится как SHA-256(source + ":" + coin)
 *      → непрозрачная строка без PII, без случайности, идемпотентна при повторных sync'ах.
 *
 *   3. БЕЗ PII: поле `name` содержит только "Bybit UNIFIED <COIN>" — без адресов
 *      кошельков, email, телефонов. Поле `meta` содержит только accountType.
 *
 *   4. DIRECTION из знака: `cashFlow` в Bybit — строка со знаком ("+0.001" или "-0.5").
 *      Положительный → 'in', отрицательный → 'out'. Если cashFlow пуст — смотрим
 *      `change`. Если нет ни того ни другого — пропускаем транзакцию (невозможно
 *      определить направление).
 *
 *   5. НУЛЕВЫЕ БАЛАНСЫ: монеты с walletBalance == 0 создают AccountRecord и
 *      SnapshotRecord (история важна — монета могла быть активна ранее).
 *      Фильтрацию "только ненулевые" делает вышестоящий код при отображении.
 */

import { createHash } from 'node:crypto';

import type {
	BybitAccount,
	BybitTransactionLogEntry,
	BybitWalletBalanceResult,
} from './bybit.js';
import type { AccountRecord, FxRateRecord, SnapshotRecord, TransactionRecord } from './types.js';

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

/**
 * deterministicId — детерминированный непрозрачный идентификатор.
 * SHA-256(input) → первые 16 байт в hex = 32 символа.
 * Достаточно уникален для леджера, без PII.
 *
 * @param input — строка-ключ (напр. "bybit:USDT")
 * @returns 32-символьный hex-digest
 */
export function deterministicId(input: string): string {
	return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 32);
}

/**
 * parseFloatSafe — парсит строку Bybit в число.
 * Пустая строка / "null" / undefined → 0.
 * NaN → 0 (Bybit иногда возвращает пустые строки для неактивных монет).
 *
 * @param value — строка из ответа Bybit
 * @returns число (конечное)
 */
export function parseFloatSafe(value: string | undefined): number {
	if (!value || value === 'null') return 0;
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

/**
 * nowIso — текущий момент в ISO-8601 UTC.
 * Инъекция nowFn позволяет фиксировать время в тестах.
 */
export function nowIso(nowFn: () => Date = () => new Date()): string {
	return nowFn().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * unixMsToIso — конвертирует unix timestamp в мс (строка Bybit) в ISO-8601.
 * Некорректное значение → empty string (не бросаем — транзакция без времени
 * лучше потерянной транзакции).
 */
export function unixMsToIso(unixMs: string | undefined): string {
	if (!unixMs) return '';
	const n = Number(unixMs);
	if (!Number.isFinite(n) || n <= 0) return '';
	try {
		return new Date(n).toISOString().replace(/\.\d{3}Z$/, 'Z');
	} catch {
		return '';
	}
}

// ---------------------------------------------------------------------------
// Нормализация wallet-balance
// ---------------------------------------------------------------------------

/**
 * NormalizedBalanceResult — результат нормализации одного аккаунта Bybit.
 * Одна монета → один AccountRecord + один SnapshotRecord.
 */
export interface NormalizedBalanceResult {
	accounts: AccountRecord[];
	snapshots: SnapshotRecord[];
}

/**
 * normalizeWalletBalance — маппинг BybitWalletBalanceResult → AccountRecord[] + SnapshotRecord[].
 *
 * Для каждой монеты в каждом аккаунте:
 *   - AccountRecord: id=deterministicId("bybit:"+coin), source="bybit",
 *     kind='exchange', name="Bybit UNIFIED <COIN>", currency=coin, meta.accountType.
 *   - SnapshotRecord: ts=syncTs, account_id=тот же id, balance=walletBalance, currency=coin.
 *
 * @param result  — ответ Bybit getWalletBalance()
 * @param syncTs  — ISO timestamp момента синка (из nowIso())
 * @param source  — идентификатор источника (по умолчанию "bybit")
 * @returns { accounts, snapshots }
 */
export function normalizeWalletBalance(
	result: BybitWalletBalanceResult,
	syncTs: string,
	source = 'bybit',
): NormalizedBalanceResult {
	const accounts: AccountRecord[] = [];
	const snapshots: SnapshotRecord[] = [];

	for (const account of result.list) {
		normalizeAccount(account, syncTs, source, accounts, snapshots);
	}

	return { accounts, snapshots };
}

/**
 * normalizeAccount — обрабатывает один BybitAccount.
 * Мутирует переданные массивы accounts/snapshots (append-стиль).
 */
function normalizeAccount(
	account: BybitAccount,
	syncTs: string,
	source: string,
	accounts: AccountRecord[],
	snapshots: SnapshotRecord[],
): void {
	// Тип аккаунта из ответа Bybit (UNIFIED, SPOT, CONTRACT...).
	const accountType = account.accountType ?? 'UNIFIED';

	for (const coin of account.coin) {
		// Пропускаем записи без имени монеты — не должно происходить, но защищаемся.
		if (!coin.coin) continue;

		const coinSymbol = coin.coin; // "USDT", "BTC", "ETH", ...
		const balance = parseFloatSafe(coin.walletBalance);

		// Детерминированный id: source + accountType + coin → уникален, без PII.
		// Включаем accountType на случай разных аккаунтов одной монеты (SPOT vs UNIFIED).
		const accountId = deterministicId(`${source}:${accountType}:${coinSymbol}`);

		// AccountRecord — описание кармана.
		const accountRecord: AccountRecord = {
			id: accountId,
			source,
			kind: 'exchange',
			name: `Bybit ${accountType} ${coinSymbol}`,
			currency: coinSymbol,
			meta: {
				accountType,
				// Не включаем walletAddress / depositAddress — это PII-адрес кошелька.
			},
		};
		accounts.push(accountRecord);

		// SnapshotRecord — текущий баланс.
		const snapshotRecord: SnapshotRecord = {
			ts: syncTs,
			account_id: accountId,
			balance,
			currency: coinSymbol,
		};
		snapshots.push(snapshotRecord);
	}
}

// ---------------------------------------------------------------------------
// Нормализация transaction-log
// ---------------------------------------------------------------------------

/**
 * normalizeTransactionLog — маппинг BybitTransactionLogEntry[] → TransactionRecord[].
 *
 * Для каждой записи:
 *   - id = deterministicId("bybit:tx:" + entry.id)
 *   - ts = unixMsToIso(entry.transactionTime) (может быть пустым)
 *   - account_id = deterministicId("bybit:UNIFIED:" + entry.currency)
 *   - amount = abs(cashFlow или change) — всегда положительное
 *   - currency = entry.currency
 *   - direction = 'in' если cashFlow/change > 0, 'out' если < 0
 *   - category = entry.type (TRANSFER_IN, TRADE, FEE и т.д.)
 *   - counterparty = entry.symbol если есть (торговая пара, не PII)
 *   - raw_ref = entry.id (оригинальный ID Bybit для дедупликации)
 *
 * Записи, у которых невозможно определить direction (нулевой cashFlow и change),
 * молча пропускаются — не аппендим непонятные записи в леджер.
 *
 * @param entries  — лог транзакций из getTransactionLog()
 * @param source   — идентификатор источника (по умолчанию "bybit")
 * @param accountType — тип аккаунта для построения account_id (по умолчанию "UNIFIED")
 * @returns массив TransactionRecord
 */
export function normalizeTransactionLog(
	entries: BybitTransactionLogEntry[],
	source = 'bybit',
	accountType = 'UNIFIED',
): TransactionRecord[] {
	const transactions: TransactionRecord[] = [];

	for (const entry of entries) {
		const tx = normalizeTransactionEntry(entry, source, accountType);
		if (tx) transactions.push(tx);
	}

	return transactions;
}

/**
 * normalizeTransactionEntry — маппинг одной транзакции.
 * Возвращает null если направление не определить (cashFlow = 0 и change = 0).
 */
function normalizeTransactionEntry(
	entry: BybitTransactionLogEntry,
	source: string,
	accountType: string,
): TransactionRecord | null {
	// Монета транзакции обязательна.
	if (!entry.currency) return null;

	// Основной источник суммы — cashFlow (приток/отток в валюте счёта).
	// Если пуст — используем change (изменение баланса монеты).
	const cashFlowRaw = parseFloatSafe(entry.cashFlow);
	const changeRaw = parseFloatSafe(entry.change);

	// Ненулевой cashFlow приоритетнее change.
	const signedAmount = cashFlowRaw !== 0 ? cashFlowRaw : changeRaw;

	// Нулевое или не определённое изменение → пропускаем запись.
	if (signedAmount === 0) return null;

	const amount = Math.abs(signedAmount);
	const direction: 'in' | 'out' = signedAmount > 0 ? 'in' : 'out';

	// account_id строится по той же формуле что в normalizeAccount.
	const accountId = deterministicId(`${source}:${accountType}:${entry.currency}`);

	// id транзакции: детерминированный хэш из entry.id.
	// entry.id уникален в Bybit → хэш тоже уникален.
	const txId = deterministicId(`${source}:tx:${entry.id}`);

	// Метка времени из transactionTime (unix ms строка).
	const ts = unixMsToIso(entry.transactionTime);

	// counterparty — торговая пара, не PII.
	const counterparty = entry.symbol || undefined;

	// category — тип транзакции из Bybit (TRADE, FEE, TRANSFER_IN, ...).
	const category = entry.type || undefined;

	return {
		id: txId,
		ts: ts || new Date(0).toISOString(), // fallback: epoch если ts пуст
		account_id: accountId,
		amount,
		currency: entry.currency,
		direction,
		category,
		counterparty,
		raw_ref: entry.id || undefined,
	};
}

// ---------------------------------------------------------------------------
// Заглушка для FxRateRecord
// ---------------------------------------------------------------------------

/**
 * makeFxRateRecord — создаёт FxRateRecord для записи в леджер.
 * Вызывается из syncBybit() после получения курса от FxProvider.
 *
 * @param base     — базовая валюта ("USD")
 * @param quote    — валюта котировки ("RUB")
 * @param rate     — курс (> 0)
 * @param source   — провайдер ("cbr", "identity", ...)
 * @param ts       — момент фиксации (ISO)
 */
export function makeFxRateRecord(
	base: string,
	quote: string,
	rate: number,
	source: string,
	ts: string,
): FxRateRecord {
	return { ts, base, quote, rate, source };
}
