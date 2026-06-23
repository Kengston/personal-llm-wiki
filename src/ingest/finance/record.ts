/**
 * record.ts — движок записи финансовых записей в леджер (Phase 1, #2 + #10).
 *
 * Отвечает за:
 *   1. Валидацию структурированного ввода (пришёл уже распознанный объект,
 *      НЕ свободный текст — разбор текста делает LLM-слой выше по стеку).
 *   2. Бутстрап счёта: нет AccountRecord с нужным id → создаём его автоматически.
 *      id строится через deterministicId(source + '|' + name + '|' + currency) — опаковый, без PII.
 *   3. Идемпотентность (дедуп): детерминированный id транзакции из компонентов,
 *      если в transactions.jsonl уже есть запись с таким id — пропускаем.
 *   4. Поддержка видов ввода: баланс счёта (snapshot), наличка (cash),
 *      доход (direction:'in'), расход (direction:'out'). Батч: несколько счетов за вызов.
 *   5. Коррекции (#10): voidEntry — сторно, amendEntry — правка, transfer — перевод
 *      между своими счетами (две связанные записи, net-worth не меняется).
 *   6. Возврат структурного результата { written, accounts_touched, balances }
 *      для детерминированного readback в мосте (волна 3).
 *
 * Принципы ([ADR-0018], [ADR-0009]):
 *   - Только чистые функции для арифметики. Зависимости (Ledger, nowFn) — инъекция.
 *   - Append-only: прошлые записи НИКОГДА не мутируются.
 *   - Нет PII в id/name: id = deterministicId(source|name|currency).
 *   - Только синтетические данные в тестах (lint:public зелёный).
 */

import { z } from 'zod';

import { Ledger } from './ledger.js';
import { deterministicId } from './normalize.js';
import type { AccountRecord, SnapshotRecord, TransactionRecord } from './types.js';

// ---------------------------------------------------------------------------
// Входные схемы (валидация ввода)
// ---------------------------------------------------------------------------

/**
 * AccountBootstrapSchema — минимально необходимый набор для нахождения/создания счёта.
 * id НЕ передаётся снаружи — вычисляется детерминированно внутри.
 */
export const AccountBootstrapSchema = z.object({
	/**
	 * source — идентификатор источника (напр. "manual", "sms").
	 * Участвует в построении id счёта.
	 */
	source: z.string().min(1),

	/**
	 * name — человекочитаемое имя счёта (напр. "Кошелёк RUB", "Сбер дебетовый").
	 * Участвует в построении id — без реальных ФИО, только описание счёта.
	 */
	name: z.string().min(1),

	/**
	 * currency — нативная валюта счёта (ISO-4217 или крипто-символ).
	 */
	currency: z.string().min(1).max(10),

	/**
	 * kind — тип счёта. По умолчанию 'checking'.
	 */
	kind: z.enum(['bank', 'ewallet', 'exchange', 'loan', 'cash', 'checking', 'savings']).default('checking'),

	/**
	 * opened_at — дата открытия счёта (ISO). Опционально.
	 */
	opened_at: z.string().optional(),

	/**
	 * meta — дополнительные атрибуты (без PII, без токенов).
	 */
	meta: z.record(z.string(), z.unknown()).optional(),
});

export type AccountBootstrap = z.infer<typeof AccountBootstrapSchema>;

/**
 * SnapshotInputSchema — ввод баланса счёта (snapshotRecord).
 * Используется для обновления баланса без транзакции.
 */
export const SnapshotInputSchema = z.object({
	/**
	 * kind — дискриминант вида ввода.
	 */
	kind: z.literal('snapshot'),

	/**
	 * account — информация о счёте для бутстрапа или поиска.
	 */
	account: AccountBootstrapSchema,

	/**
	 * balance — новый баланс счёта в нативной валюте.
	 */
	balance: z.number().finite(),

	/**
	 * ts — момент снапшота (ISO). Если не указан — берётся nowFn().
	 */
	ts: z.string().optional(),
});

/**
 * TransactionInputSchema — ввод одной транзакции (доход / расход / наличка).
 *
 * Включает тип 'cash' — запись наличных в любой валюте (VND, ₽ и т.д.),
 * который тоже является транзакцией, но счёт auto-bootstraps с kind='cash'.
 */
export const TransactionInputSchema = z.object({
	/**
	 * kind — дискриминант вида ввода.
	 */
	kind: z.literal('transaction'),

	/**
	 * account — информация о счёте.
	 */
	account: AccountBootstrapSchema,

	/**
	 * amount — сумма транзакции в нативной валюте (всегда > 0).
	 */
	amount: z.number().finite().positive(),

	/**
	 * currency — валюта транзакции (может отличаться от счёта при конвертации; обычно совпадает).
	 */
	currency: z.string().min(1).max(10),

	/**
	 * direction — направление: 'in' (зачисление) / 'out' (списание).
	 */
	direction: z.enum(['in', 'out']),

	/**
	 * ts — момент транзакции (ISO). Если не указан — берётся nowFn().
	 */
	ts: z.string().optional(),

	/**
	 * category — категория (опц.). Примеры: "grocery", "salary", "transfer".
	 */
	category: z.string().optional(),

	/**
	 * note — заметка без PII (опц.). Участвует в дедупе.
	 */
	note: z.string().optional(),

	/**
	 * tags — произвольные теги (опц.).
	 */
	tags: z.array(z.string()).optional(),

	/**
	 * goal_tag — ссылка на цель из вики (опц.).
	 */
	goal_tag: z.string().optional(),

	/**
	 * is_subscription — периодический платёж (опц.).
	 */
	is_subscription: z.boolean().optional(),
});

/**
 * VoidInputSchema — аннулирование (сторно) уже записанной транзакции.
 * Прошлую запись НЕ мутируем — append-only: создаём новую с void_id.
 */
export const VoidInputSchema = z.object({
	/**
	 * kind — дискриминант вида ввода.
	 */
	kind: z.literal('void'),

	/**
	 * account — информация о счёте (нужна для поиска/бутстрапа).
	 */
	account: AccountBootstrapSchema,

	/**
	 * void_id — id транзакции, которую аннулируем.
	 */
	void_id: z.string().min(1),

	/**
	 * amount — сумма сторно-записи (обычно та же что у оригинала, > 0).
	 */
	amount: z.number().finite().positive(),

	/**
	 * currency — валюта сторно-записи.
	 */
	currency: z.string().min(1).max(10),

	/**
	 * direction — направление сторно: обратное оригиналу.
	 * ('in' если оригинал был 'out', и наоборот — для возврата средств)
	 */
	direction: z.enum(['in', 'out']),

	/**
	 * ts — момент записи сторно (ISO). Если не указан — берётся nowFn().
	 */
	ts: z.string().optional(),

	/**
	 * note — причина аннулирования (опц., без PII).
	 */
	note: z.string().optional(),
});

/**
 * AmendInputSchema — правка (поправка) уже записанной транзакции.
 * Append-only: создаём новую запись с amended_id; читатель берёт последнюю.
 */
export const AmendInputSchema = z.object({
	/**
	 * kind — дискриминант вида ввода.
	 */
	kind: z.literal('amend'),

	/**
	 * account — информация о счёте.
	 */
	account: AccountBootstrapSchema,

	/**
	 * amended_id — id транзакции, которую исправляем.
	 */
	amended_id: z.string().min(1),

	/**
	 * amount — исправленная сумма (> 0).
	 */
	amount: z.number().finite().positive(),

	/**
	 * currency — исправленная валюта.
	 */
	currency: z.string().min(1).max(10),

	/**
	 * direction — исправленное направление.
	 */
	direction: z.enum(['in', 'out']),

	/**
	 * ts — момент записи правки (ISO). Если не указан — берётся nowFn().
	 */
	ts: z.string().optional(),

	/**
	 * category — исправленная категория (опц.).
	 */
	category: z.string().optional(),

	/**
	 * note — заметка к правке (опц., без PII).
	 */
	note: z.string().optional(),
});

/**
 * TransferInputSchema — перевод между своими счетами.
 * Создаёт ДВЕ связанные транзакции (out с источника + in на получатель)
 * с общим transfer_id. Net-worth не меняется (внутренний перевод).
 */
export const TransferInputSchema = z.object({
	/**
	 * kind — дискриминант вида ввода.
	 */
	kind: z.literal('transfer'),

	/**
	 * from_account — счёт-источник (откуда списываем).
	 */
	from_account: AccountBootstrapSchema,

	/**
	 * to_account — счёт-получатель (куда зачисляем).
	 */
	to_account: AccountBootstrapSchema,

	/**
	 * amount — сумма перевода в исходной валюте (> 0).
	 */
	amount: z.number().finite().positive(),

	/**
	 * currency — валюта перевода (нативная для from_account).
	 */
	currency: z.string().min(1).max(10),

	/**
	 * ts — момент перевода (ISO). Если не указан — берётся nowFn().
	 */
	ts: z.string().optional(),

	/**
	 * note — заметка к переводу (опц., без PII).
	 */
	note: z.string().optional(),
});

/**
 * RecordInput — дискриминированный union всех видов ввода.
 * Батч: передаём массив RecordInput[] для записи нескольких счетов за один вызов.
 */
export type RecordInput =
	| z.infer<typeof SnapshotInputSchema>
	| z.infer<typeof TransactionInputSchema>
	| z.infer<typeof VoidInputSchema>
	| z.infer<typeof AmendInputSchema>
	| z.infer<typeof TransferInputSchema>;

// ---------------------------------------------------------------------------
// Зависимости (инъекция для тестов)
// ---------------------------------------------------------------------------

/**
 * RecordDeps — зависимости для recordFinanceEntry.
 *
 * Разделение: чистая бизнес-логика (accountId, txId, дедуп) — в функциях;
 * I/O (Ledger, время) — через инъекцию.
 */
export interface RecordDeps {
	/**
	 * ledger — экземпляр Ledger для чтения и записи JSONL-файлов.
	 * В тестах: Ledger с tmp-каталогом (mkdtempSync).
	 */
	ledger: Ledger;

	/**
	 * nowFn — функция получения текущего времени.
	 * По умолчанию: () => new Date(). В тестах: фиксированный момент.
	 */
	nowFn?: () => Date;
}

// ---------------------------------------------------------------------------
// Возвращаемый результат
// ---------------------------------------------------------------------------

/**
 * BalanceSummary — последний снапшот баланса по конкретному счёту.
 * Используется в results.balances для детерминированного readback.
 */
export interface BalanceSummary {
	/** account_id — id счёта. */
	account_id: string;
	/** currency — нативная валюта. */
	currency: string;
	/** balance — последний известный баланс (из последнего SnapshotRecord). */
	balance: number;
	/** ts — момент последнего снапшота. */
	ts: string;
}

/**
 * RecordResult — структурный результат recordFinanceEntry.
 *
 * written — все записи, добавленные в леджер за этот вызов.
 * accounts_touched — id счетов, к которым были добавлены записи.
 * balances — последние балансы по touched-счетам (из снапшотов).
 */
export interface RecordResult {
	/**
	 * written — записанные объекты в порядке записи.
	 * Тип unknown чтобы избежать импорта всех типов — caller-side приводит к нужному.
	 */
	written: Array<AccountRecord | SnapshotRecord | TransactionRecord>;

	/**
	 * accounts_touched — уникальные id счетов, затронутых за вызов.
	 */
	accounts_touched: string[];

	/**
	 * balances — суммарные снапшоты балансов по touched-счетам.
	 * Если за вызов не писали снапшот — берём последний из леджера.
	 */
	balances: BalanceSummary[];
}

// ---------------------------------------------------------------------------
// Вспомогательные чистые функции
// ---------------------------------------------------------------------------

/**
 * makeAccountId — детерминированный id счёта.
 * Формула: deterministicId(source + '|' + name + '|' + currency).
 * Непрозрачный hex-32, без PII (name = описание счёта, не ФИО).
 *
 * @param source   — источник (напр. "manual", "sms")
 * @param name     — имя счёта (напр. "Кошелёк RUB")
 * @param currency — нативная валюта счёта
 * @returns 32-символьный hex-digest
 */
export function makeAccountId(source: string, name: string, currency: string): string {
	return deterministicId(`${source}|${name}|${currency}`);
}

/**
 * makeTxId — детерминированный id транзакции из составных компонентов.
 * Обеспечивает идемпотентность: одинаковый ввод → один и тот же id → дедуп.
 *
 * Компоненты: ts|account_id|amount|currency|direction|note (note опц.).
 * Выбор компонентов: достаточен для уникальности реальных транзакций;
 * при совпадении всех полей — это дубль.
 *
 * @param ts         — момент транзакции (ISO)
 * @param accountId  — id счёта
 * @param amount     — сумма (> 0)
 * @param currency   — валюта
 * @param direction  — 'in' / 'out'
 * @param note       — заметка (опц., если есть — включается в хэш)
 * @returns 32-символьный hex-digest
 */
export function makeTxId(
	ts: string,
	accountId: string,
	amount: number,
	currency: string,
	direction: 'in' | 'out',
	note?: string,
): string {
	const noteStr = note ?? '';
	return deterministicId(`${ts}|${accountId}|${amount}|${currency}|${direction}|${noteStr}`);
}

/**
 * nowIsoLocal — текущий момент в ISO-8601 UTC без миллисекунд.
 * Переиспользует паттерн из normalize.ts.
 */
function nowIsoLocal(nowFn: () => Date): string {
	return nowFn()
		.toISOString()
		.replace(/\.\d{3}Z$/, 'Z');
}

/**
 * ensureAccount — проверяет, есть ли AccountRecord с данным id в леджере;
 * если нет — создаёт и записывает его (бутстрап).
 *
 * Чистый по логике: решение о создании принимается на основе readAll,
 * без скрытого состояния. Мутация — только через ledger.append.
 *
 * @param ledger        — экземпляр Ledger
 * @param accountId     — вычисленный id (deterministicId)
 * @param bootstrap     — данные для создания счёта при бутстрапе
 * @param written       — аккумулятор записанных объектов (мутируется)
 * @returns true если счёт был создан, false если уже существовал
 */
function ensureAccount(
	ledger: Ledger,
	accountId: string,
	bootstrap: AccountBootstrap,
	written: Array<AccountRecord | SnapshotRecord | TransactionRecord>,
): boolean {
	// Читаем все существующие accounts.jsonl и ищем по id.
	const existing = ledger.readAll('accounts');
	const found = existing.some((a) => a.id === accountId);

	if (found) {
		// Счёт уже существует — бутстрап не нужен.
		return false;
	}

	// Счёт не найден — создаём AccountRecord.
	const accountRecord: AccountRecord = {
		id: accountId,
		source: bootstrap.source,
		kind: bootstrap.kind ?? 'checking',
		name: bootstrap.name,
		currency: bootstrap.currency,
		...(bootstrap.opened_at ? { opened_at: bootstrap.opened_at } : {}),
		...(bootstrap.meta ? { meta: bootstrap.meta } : {}),
	};

	ledger.append('accounts', accountRecord);
	written.push(accountRecord);
	return true;
}

/**
 * isDuplicateTx — проверяет, есть ли в transactions.jsonl запись с данным id.
 * Реализует гарантию идемпотентности: одинаковый вызов с теми же данными
 * не добавляет дубль в леджер.
 *
 * @param ledger — экземпляр Ledger
 * @param txId   — детерминированный id транзакции
 * @returns true если дубль найден
 */
function isDuplicateTx(ledger: Ledger, txId: string): boolean {
	// Линейный поиск — приемлемо для личного финансового леджера (< 10k записей).
	// При необходимости можно кэшировать Set<id> при создании Ledger.
	const existing = ledger.readAll('transactions');
	return existing.some((t) => t.id === txId);
}

/**
 * buildBalances — собирает последние BalanceSummary по набору account_id.
 * Читает все снапшоты и берёт последний по ts для каждого счёта.
 *
 * @param ledger          — экземпляр Ledger
 * @param accountIds      — набор id счетов
 * @returns массив BalanceSummary (по одному на каждый id у которого есть снапшот)
 */
function buildBalances(ledger: Ledger, accountIds: string[]): BalanceSummary[] {
	// Читаем все снапшоты из леджера (включая только что записанные).
	const allSnapshots = ledger.readAll('snapshots');

	// Группируем по account_id и берём последний по ts.
	const latest = new Map<string, SnapshotRecord>();
	for (const snap of allSnapshots) {
		if (!accountIds.includes(snap.account_id)) continue;

		const prev = latest.get(snap.account_id);
		// Сравниваем ts как строки — ISO-8601 лексикографически сортируем корректно
		// (при условии UTC и одинакового формата).
		if (!prev || snap.ts > prev.ts) {
			latest.set(snap.account_id, snap);
		}
	}

	// Формируем результирующий массив.
	const result: BalanceSummary[] = [];
	for (const id of accountIds) {
		const snap = latest.get(id);
		if (snap) {
			result.push({
				account_id: id,
				currency: snap.currency,
				balance: snap.balance,
				ts: snap.ts,
			});
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Обработчики видов ввода
// ---------------------------------------------------------------------------

/**
 * processSnapshot — обрабатывает ввод вида 'snapshot' (обновление баланса).
 *
 * Порядок:
 *   1. Валидируем вход через SnapshotInputSchema.parse() — применяем дефолты,
 *      отсеиваем не-finite/некорректные поля.
 *   2. Вычисляем accountId из source|name|currency.
 *   3. Бутстрап счёта если нужно.
 *   4. Записываем SnapshotRecord.
 */
function processSnapshot(
	input: z.infer<typeof SnapshotInputSchema>,
	ledger: Ledger,
	nowFn: () => Date,
	written: Array<AccountRecord | SnapshotRecord | TransactionRecord>,
	touchedIds: Set<string>,
): void {
	// Валидируем вход: применяем дефолты схемы, выбрасываем если поля некорректны.
	// parse() бросает ZodError с подробным сообщением при невалидных данных.
	const parsed = SnapshotInputSchema.parse(input);

	// Вычисляем id счёта (детерминированно, без PII).
	const accountId = makeAccountId(parsed.account.source, parsed.account.name, parsed.account.currency);

	// Бутстрап: создаём счёт если нет.
	ensureAccount(ledger, accountId, parsed.account, written);
	touchedIds.add(accountId);

	// Записываем снапшот баланса.
	const ts = parsed.ts ?? nowIsoLocal(nowFn);
	const snapshot: SnapshotRecord = {
		ts,
		account_id: accountId,
		balance: parsed.balance,
		currency: parsed.account.currency,
	};

	ledger.append('snapshots', snapshot);
	written.push(snapshot);
}

/**
 * processTransaction — обрабатывает ввод вида 'transaction' (доход/расход/наличка).
 *
 * Порядок:
 *   1. Валидируем вход через TransactionInputSchema.parse().
 *   2. Вычисляем accountId.
 *   3. Бутстрап счёта.
 *   4. Вычисляем txId (детерминированный дедуп).
 *   5. Проверяем дубль — если есть, пропускаем запись (идемпотентность).
 *   6. Записываем TransactionRecord.
 */
function processTransaction(
	input: z.infer<typeof TransactionInputSchema>,
	ledger: Ledger,
	nowFn: () => Date,
	written: Array<AccountRecord | SnapshotRecord | TransactionRecord>,
	touchedIds: Set<string>,
): void {
	// Входная валидация: amount > 0, currency min 1, дефолты применяются.
	const parsed = TransactionInputSchema.parse(input);

	const accountId = makeAccountId(parsed.account.source, parsed.account.name, parsed.account.currency);

	// Бутстрап.
	ensureAccount(ledger, accountId, parsed.account, written);
	touchedIds.add(accountId);

	// Момент транзакции.
	const ts = parsed.ts ?? nowIsoLocal(nowFn);

	// Детерминированный id транзакции (дедуп по компонентам).
	const txId = makeTxId(ts, accountId, parsed.amount, parsed.currency, parsed.direction, parsed.note);

	// Проверка дубля — не пишем повторно.
	if (isDuplicateTx(ledger, txId)) {
		// Дубль: возвращаем без записи. Это ожидаемый идемпотентный сценарий.
		return;
	}

	// Строим TransactionRecord.
	const tx: TransactionRecord = {
		id: txId,
		ts,
		account_id: accountId,
		amount: parsed.amount,
		currency: parsed.currency,
		direction: parsed.direction,
		source: 'manual',
		...(parsed.category ? { category: parsed.category } : {}),
		...(parsed.note ? { counterparty: parsed.note } : {}),
		...(parsed.tags ? { tags: parsed.tags } : {}),
		...(parsed.goal_tag ? { goal_tag: parsed.goal_tag } : {}),
		...(parsed.is_subscription !== undefined ? { is_subscription: parsed.is_subscription } : {}),
	};

	ledger.append('transactions', tx);
	written.push(tx);
}

/**
 * processVoid — обрабатывает ввод вида 'void' (сторно транзакции).
 *
 * Append-only: прошлую транзакцию НЕ мутируем.
 * Создаём новую запись с void_id = id аннулируемой транзакции.
 * Дедуп по: ts|accountId|amount|currency|direction + суффикс void:{void_id}.
 */
function processVoid(
	input: z.infer<typeof VoidInputSchema>,
	ledger: Ledger,
	nowFn: () => Date,
	written: Array<AccountRecord | SnapshotRecord | TransactionRecord>,
	touchedIds: Set<string>,
): void {
	// Входная валидация: void_id непустой, amount > 0, currency min 1.
	const parsed = VoidInputSchema.parse(input);

	const accountId = makeAccountId(parsed.account.source, parsed.account.name, parsed.account.currency);

	// Бутстрап счёта (на случай если счёт был пересоздан).
	ensureAccount(ledger, accountId, parsed.account, written);
	touchedIds.add(accountId);

	const ts = parsed.ts ?? nowIsoLocal(nowFn);

	// id сторно-записи включает суффикс void для уникальности и дедупа.
	// Формула: deterministicId(ts|accountId|amount|currency|direction|void:{void_id}).
	const txId = makeTxId(
		ts,
		accountId,
		parsed.amount,
		parsed.currency,
		parsed.direction,
		`void:${parsed.void_id}`,
	);

	// Идемпотентность: если уже записано сторно с таким id — пропускаем.
	if (isDuplicateTx(ledger, txId)) {
		return;
	}

	const tx: TransactionRecord = {
		id: txId,
		ts,
		account_id: accountId,
		amount: parsed.amount,
		currency: parsed.currency,
		direction: parsed.direction,
		source: 'manual',
		void_id: parsed.void_id,
		...(parsed.note ? { counterparty: parsed.note } : {}),
	};

	ledger.append('transactions', tx);
	written.push(tx);
}

/**
 * processAmend — обрабатывает ввод вида 'amend' (правка транзакции).
 *
 * Append-only: создаём новую запись с amended_id.
 * Читатель берёт последнюю запись с данным amended_id как актуальную.
 */
function processAmend(
	input: z.infer<typeof AmendInputSchema>,
	ledger: Ledger,
	nowFn: () => Date,
	written: Array<AccountRecord | SnapshotRecord | TransactionRecord>,
	touchedIds: Set<string>,
): void {
	// Входная валидация: amended_id непустой, amount > 0, currency min 1.
	const parsed = AmendInputSchema.parse(input);

	const accountId = makeAccountId(parsed.account.source, parsed.account.name, parsed.account.currency);

	ensureAccount(ledger, accountId, parsed.account, written);
	touchedIds.add(accountId);

	const ts = parsed.ts ?? nowIsoLocal(nowFn);

	// id правки включает суффикс amend для уникальности.
	const txId = makeTxId(
		ts,
		accountId,
		parsed.amount,
		parsed.currency,
		parsed.direction,
		`amend:${parsed.amended_id}`,
	);

	if (isDuplicateTx(ledger, txId)) {
		return;
	}

	const tx: TransactionRecord = {
		id: txId,
		ts,
		account_id: accountId,
		amount: parsed.amount,
		currency: parsed.currency,
		direction: parsed.direction,
		source: 'manual',
		amended_id: parsed.amended_id,
		...(parsed.category ? { category: parsed.category } : {}),
		...(parsed.note ? { counterparty: parsed.note } : {}),
	};

	ledger.append('transactions', tx);
	written.push(tx);
}

/**
 * processTransfer — обрабатывает перевод между своими счетами.
 *
 * Создаёт ДВЕ связанные записи с общим transfer_id:
 *   - out с from_account (списание в нативной валюте from_account)
 *   - in на to_account (зачисление в нативной валюте to_account)
 *
 * ГАРД: перевод между счетами с РАЗНЫМИ валютами запрещён без явного fx_rate.
 * Причина: мультивалютный инвариант — каждая сумма в нативной валюте счёта.
 * Без to_amount/fx_rate невозможно правильно записать in-ногу в валюте получателя.
 * Решение: для кросс-валютных переводов используйте два отдельных вызова
 * (out + in в разных валютах) или передайте корректные currency для каждого счёта
 * (убедитесь, что from_account.currency === input.currency === to_account.currency).
 *
 * Net-worth при переводе в одной валюте НЕ меняется — внутренний перевод.
 * Обе записи должны быть отфильтрованы при подсчёте доходов/расходов
 * (по наличию transfer_id).
 */
function processTransfer(
	input: z.infer<typeof TransferInputSchema>,
	ledger: Ledger,
	nowFn: () => Date,
	written: Array<AccountRecord | SnapshotRecord | TransactionRecord>,
	touchedIds: Set<string>,
): void {
	// Входная валидация: amount > 0, currency min 1.
	const parsed = TransferInputSchema.parse(input);

	// ГАРД кросс-валютности: from_account, to_account и input.currency
	// обязаны совпадать. Иначе in-нога будет записана в чужой валюте,
	// что нарушает инвариант «каждая сумма в нативной валюте счёта» (ADR-0018).
	if (
		parsed.from_account.currency !== parsed.currency ||
		parsed.to_account.currency !== parsed.currency
	) {
		throw new Error(
			`Кросс-валютный transfer не поддерживается без to_amount/fx_rate: ` +
			`from=${parsed.from_account.currency}, to=${parsed.to_account.currency}, ` +
			`transfer_currency=${parsed.currency}. ` +
			`Используйте два отдельных вызова (out + in) или убедитесь что все валюты совпадают.`,
		);
	}

	const fromAccountId = makeAccountId(
		parsed.from_account.source,
		parsed.from_account.name,
		parsed.from_account.currency,
	);
	const toAccountId = makeAccountId(
		parsed.to_account.source,
		parsed.to_account.name,
		parsed.to_account.currency,
	);

	// Бутстрап обоих счетов.
	ensureAccount(ledger, fromAccountId, parsed.from_account, written);
	ensureAccount(ledger, toAccountId, parsed.to_account, written);
	touchedIds.add(fromAccountId);
	touchedIds.add(toAccountId);

	const ts = parsed.ts ?? nowIsoLocal(nowFn);

	// transfer_id — общий идентификатор для связки двух записей.
	// Строится детерминированно из компонентов перевода.
	const transferId = deterministicId(
		`transfer|${ts}|${fromAccountId}|${toAccountId}|${parsed.amount}|${parsed.currency}`,
	);

	// id записи out (списание с from_account в нативной валюте from_account).
	const outTxId = makeTxId(ts, fromAccountId, parsed.amount, parsed.currency, 'out', `transfer:${transferId}`);
	// id записи in (зачисление на to_account в нативной валюте to_account = той же валюте).
	const inTxId = makeTxId(ts, toAccountId, parsed.amount, parsed.currency, 'in', `transfer:${transferId}`);

	// Дедуп out-записи.
	if (!isDuplicateTx(ledger, outTxId)) {
		const outTx: TransactionRecord = {
			id: outTxId,
			ts,
			account_id: fromAccountId,
			amount: parsed.amount,
			currency: parsed.currency,
			direction: 'out',
			source: 'manual',
			transfer_id: transferId,
			category: 'transfer',
			...(parsed.note ? { counterparty: parsed.note } : {}),
		};
		ledger.append('transactions', outTx);
		written.push(outTx);
	}

	// Дедуп in-записи.
	if (!isDuplicateTx(ledger, inTxId)) {
		const inTx: TransactionRecord = {
			id: inTxId,
			ts,
			account_id: toAccountId,
			// in-нога записывается в нативной валюте получателя.
			// Гард выше гарантирует: to_account.currency === parsed.currency.
			amount: parsed.amount,
			currency: parsed.currency,
			direction: 'in',
			source: 'manual',
			transfer_id: transferId,
			category: 'transfer',
			...(parsed.note ? { counterparty: parsed.note } : {}),
		};
		ledger.append('transactions', inTx);
		written.push(inTx);
	}
}

// ---------------------------------------------------------------------------
// Главная функция
// ---------------------------------------------------------------------------

/**
 * recordFinanceEntry — главный движок записи финансовых записей в леджер.
 *
 * Принимает один или несколько RecordInput (батч), обрабатывает каждый
 * по соответствующему обработчику и возвращает структурный результат.
 *
 * ВХОД — уже распознанная СТРУКТУРА (не парсим свободный текст — это делает
 * LLM-слой выше). Caller обязан передать корректный RecordInput.
 *
 * @param inputs — один RecordInput или массив (батч).
 * @param deps   — зависимости: { ledger, nowFn? }
 * @returns RecordResult — { written, accounts_touched, balances }
 *
 * Гарантии:
 *   - Идемпотентность транзакций: повторный вызов с теми же данными НЕ дублирует.
 *   - Append-only: прошлые записи НИКОГДА не мутируются.
 *   - Path-guard: неправильный путь → LedgerPathError (от Ledger).
 */
export function recordFinanceEntry(inputs: RecordInput | RecordInput[], deps: RecordDeps): RecordResult {
	// Нормализуем в массив для единообразной обработки батча.
	const inputList = Array.isArray(inputs) ? inputs : [inputs];

	const { ledger } = deps;
	// nowFn по умолчанию: текущий момент UTC.
	const nowFn = deps.nowFn ?? (() => new Date());

	// Аккумуляторы результата.
	const written: Array<AccountRecord | SnapshotRecord | TransactionRecord> = [];
	const touchedIds = new Set<string>();

	// Обрабатываем каждый элемент батча по дискриминанту kind.
	for (const input of inputList) {
		switch (input.kind) {
			case 'snapshot':
				processSnapshot(input, ledger, nowFn, written, touchedIds);
				break;
			case 'transaction':
				processTransaction(input, ledger, nowFn, written, touchedIds);
				break;
			case 'void':
				processVoid(input, ledger, nowFn, written, touchedIds);
				break;
			case 'amend':
				processAmend(input, ledger, nowFn, written, touchedIds);
				break;
			case 'transfer':
				processTransfer(input, ledger, nowFn, written, touchedIds);
				break;
			default: {
				// Исчерпывающий switch — TypeScript покажет ошибку если новый kind не обработан.
				const exhaustive: never = input;
				throw new Error(`Неизвестный kind: ${String((exhaustive as RecordInput).kind)}`);
			}
		}
	}

	// Строим итоговый массив id (Set → Array).
	const accounts_touched = [...touchedIds];

	// Собираем балансы по затронутым счетам из снапшотов леджера.
	const balances = buildBalances(ledger, accounts_touched);

	return { written, accounts_touched, balances };
}
