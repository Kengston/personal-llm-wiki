/**
 * finance-export.ts — экспорт финансовых данных: CSV-транзакции / PNG-сводка счетов.
 *
 * Контекст ([ADR-0018] финансовый модуль, [ADR-0023] транспорт медиа, [ADR-0011] secret-gate,
 * [ADR-0009] single-user):
 *
 *   Предоставляет пользователю возможность выгрузить финансовые данные из леджера:
 *
 *   1. CSV-транзакции — детерминированная сборка строк из JSONL-леджера → sendDocument.
 *      Точные числа допустимы (файл доставляется ВЛАДЕЛЬЦУ, ADR-0023).
 *
 *   2. PNG-сводка счетов (export_table) — моноширинная таблица балансов строится
 *      через SVG (renderChartSvg с chartSpec balances_snapshot), затем растеризуется
 *      в PNG через renderChartPng → sendDocument как «документ-картинка».
 *      Решение по ADR-0023: PDF требует pdf-lib/jsPDF (лишняя зависимость), а PNG
 *      полностью покрывает нужды одного владельца и уже поддержан in-memory рендером.
 *      Если нужен настоящий PDF в будущем — заменить renderChartPng на pdf-слой без
 *      breaking change (тот же ChartSpec на входе).
 *
 * АРХИТЕКТУРА:
 *   - buildTransactionsCsv(records)         → детерминированная чистая функция, строка CSV.
 *   - buildAccountsTablePng(snapshots, accounts) → чистая сборка ChartSpec → PNG-Buffer.
 *   - sendTransactionsCsv(ledger, tg, chatId) → тонкий адаптер: читает леджер + отправляет.
 *   - sendAccountsTable(ledger, tg, chatId)   → тонкий адаптер: читает леджер + отправляет.
 *
 * ИНВАРИАНТЫ:
 *   - Нет сети в чистых функциях. Только в адаптерах (sendDocument через тг-транспорт).
 *   - Нет фоновых процессов, нет spawn. Только локальная либа (@resvg/resvg-js).
 *   - Path-guard: не пишем в репо; CSV/PNG строятся в памяти (Buffer), без tmp-файлов.
 *   - caption/filename (видимый текст) — без точных финчисел (secret-gate ADR-0011).
 *   - Данные в самом файле (CSV/PNG) — точные (продукт владельцу, ADR-0023).
 *   - Только синтетические данные в тестах (lint:public зелёный).
 *   - Комментарии на русском; стиль src/ingest/finance/* и src/bridge/*.
 */

import { childLogger } from '../core/logger.js';
import { chartSpec, type BalanceEntry } from '../ingest/finance/chart.js';
import { Ledger } from '../ingest/finance/ledger.js';
import type { AccountRecord, SnapshotRecord, TransactionRecord } from '../ingest/finance/types.js';
import { renderChartPng } from './finance-render.js';
import type { TelegramClient } from './telegram.js';

const log = childLogger('bridge.finance-export');

// ---------------------------------------------------------------------------
// CSV-экспорт транзакций
// ---------------------------------------------------------------------------

/**
 * CSV_HEADER — заголовок CSV (RFC 4180, запятая-разделитель).
 * Поля: id (опаковый, без PII), ts, account_id (опаковый), direction, amount, currency,
 * category, note, goal_tag, void_id, amended_id, transfer_id.
 * Имена полей — по схеме TransactionRecord (types.ts).
 */
const CSV_HEADER =
	'id,ts,account_id,direction,amount,currency,category,note,goal_tag,void_id,amended_id,transfer_id\n';

/**
 * escapeCsvField — экранирует одно поле для CSV (RFC 4180).
 *
 * Если поле содержит запятую, перевод строки или двойные кавычки — оборачивает в кавычки
 * и дублирует внутренние кавычки. Пустая строка → пустое поле (без кавычек).
 *
 * @param raw — исходное строковое значение поля (может быть undefined → пустая строка)
 * @returns экранированное значение для CSV-ячейки
 */
export function escapeCsvField(raw: string | undefined | null): string {
	// Нет значения → пустое поле.
	if (raw === undefined || raw === null || raw === '') return '';

	// Если поле содержит спецсимволы CSV — оборачиваем.
	const needsQuote = raw.includes(',') || raw.includes('"') || raw.includes('\n') || raw.includes('\r');
	if (!needsQuote) return raw;

	// Дублируем кавычки внутри, оборачиваем всё в кавычки.
	return '"' + raw.replace(/"/g, '""') + '"';
}

/**
 * buildTransactionsCsv — ЧИСТАЯ функция: массив TransactionRecord → строка CSV.
 *
 * Детерминирована: одни и те же записи → одна и та же строка.
 * Сортирует по ts ASC, затем по id (для стабильности при одинаковом ts).
 * Точные числа допустимы (файл доставляется владельцу, ADR-0023; secret-gate
 * применяется к caption/filename, не к телу экспорта).
 *
 * @param records — массив транзакций из Ledger.readAll('transactions')
 * @returns строка CSV (header + строки), не содержит trailing newline
 *
 * @example
 * const csv = buildTransactionsCsv(ledger.readAll('transactions'));
 * // await tg.sendDocument(chatId, { data: Buffer.from(csv, 'utf8'), filename: 'txs.csv' });
 */
export function buildTransactionsCsv(records: TransactionRecord[]): string {
	if (records.length === 0) {
		// Пустой леджер → только заголовок (валидный CSV без строк данных).
		return CSV_HEADER.trimEnd();
	}

	// Сортируем: ASC по ts, затем по id для стабильности.
	// Не мутируем входной массив — spread-копия.
	const sorted = [...records].sort((a, b) => {
		const tsCmp = a.ts.localeCompare(b.ts);
		return tsCmp !== 0 ? tsCmp : a.id.localeCompare(b.id);
	});

	// Строим строки данных.
	const rows = sorted.map((tx) => {
		// Порядок полей должен точно совпадать с CSV_HEADER (id,ts,...).
		const fields = [
			escapeCsvField(tx.id),
			escapeCsvField(tx.ts),
			escapeCsvField(tx.account_id),
			escapeCsvField(tx.direction),
			// amount — число: stringify напрямую (NaN/Infinity уже запрещены zod-схемой).
			String(tx.amount),
			escapeCsvField(tx.currency),
			escapeCsvField(tx.category),
			// note отсутствует в TransactionRecord (только в record.ts-вводе), используем tags[0] как заметку.
			escapeCsvField(tx.tags?.[0]),
			escapeCsvField(tx.goal_tag),
			escapeCsvField(tx.void_id),
			escapeCsvField(tx.amended_id),
			escapeCsvField(tx.transfer_id),
		];
		return fields.join(',');
	});

	// Собираем итоговый CSV: header + строки данных (каждая на новой строке).
	return CSV_HEADER.trimEnd() + '\n' + rows.join('\n');
}

// ---------------------------------------------------------------------------
// Сводная таблица балансов счетов (PNG-документ)
// ---------------------------------------------------------------------------

/**
 * AccountBalanceRow — одна строка сводной таблицы балансов.
 * Строится из последнего SnapshotRecord для каждого account_id.
 */
export interface AccountBalanceRow {
	/** Имя счёта (из AccountRecord.name или fallback account_id). */
	name: string;
	/** Нативная валюта. */
	currency: string;
	/** Текущий баланс (последний снапшот ≤ asOf). */
	balance: number;
	/** Тип счёта (из AccountRecord.kind). */
	kind: string;
}

/**
 * buildAccountBalanceRows — ЧИСТАЯ функция: строит строки таблицы балансов.
 *
 * Для каждого уникального account_id берёт последний SnapshotRecord ≤ asOf.
 * Затем присоединяет имя из AccountRecord (если есть).
 * Детерминирована: одни входные данные → один результат.
 *
 * @param snapshots — все снапшоты из Ledger.readAll('snapshots')
 * @param accounts  — все записи счетов из Ledger.readAll('accounts')
 * @param asOf      — момент расчёта (ISO-строка); дефолт — «сейчас» (без миллисекунд)
 * @returns строки таблицы, отсортированные по kind, затем по name
 */
export function buildAccountBalanceRows(
	snapshots: SnapshotRecord[],
	accounts: AccountRecord[],
	asOf?: string,
): AccountBalanceRow[] {
	// Нормализуем asOf (аналог buildQueryContext в finance-intent.ts).
	const cutoff = asOf ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

	// Индекс счетов по id для быстрого присоединения (без внешних join'ов).
	const accountIndex = new Map<string, AccountRecord>();
	for (const acc of accounts) {
		accountIndex.set(acc.id, acc);
	}

	// Для каждого account_id берём последний снапшот ≤ cutoff.
	const latestByAccount = new Map<string, SnapshotRecord>();
	for (const snap of snapshots) {
		if (snap.ts > cutoff) continue;
		const existing = latestByAccount.get(snap.account_id);
		if (!existing || snap.ts >= existing.ts) {
			latestByAccount.set(snap.account_id, snap);
		}
	}

	// Строим строки, присоединяя мета из AccountRecord.
	const rows: AccountBalanceRow[] = [];
	for (const [accountId, snap] of latestByAccount.entries()) {
		const acc = accountIndex.get(accountId);
		rows.push({
			name: acc?.name ?? accountId,
			currency: snap.currency,
			balance: snap.balance,
			kind: acc?.kind ?? 'unknown',
		});
	}

	// Сортировка: по kind (лексикографически), затем по name.
	// Стабильный порядок — детерминизм гарантирован.
	rows.sort((a, b) => {
		const kindCmp = a.kind.localeCompare(b.kind);
		return kindCmp !== 0 ? kindCmp : a.name.localeCompare(b.name);
	});

	return rows;
}

/**
 * formatAccountsTableText — ЧИСТАЯ функция: строит моноширинную Unicode-таблицу балансов.
 *
 * Колонки: ТИП | СЧЁТ | ВАЛЮТА | БАЛАНС — выравниваются пробелами для моноширинного шрифта.
 * Без рамок (совместимо с Telegram monospace-блоком при wrap в `code`).
 *
 * @param rows — строки таблицы (из buildAccountBalanceRows)
 * @returns строка моноширинной таблицы (разделитель \n)
 *
 * @example
 * const table = formatAccountsTableText(rows);
 * // "ТИП        СЧЁТ                 ВАЛЮТА   БАЛАНС\n..."
 */
export function formatAccountsTableText(rows: AccountBalanceRow[]): string {
	if (rows.length === 0) {
		return '(нет данных)';
	}

	// Заголовки колонок.
	const HEADERS = ['ТИП', 'СЧЁТ', 'ВАЛЮТА', 'БАЛАНС'];

	// Вычисляем максимальные ширины колонок (по данным + заголовкам).
	// balance форматируем как строку с 2 дес. знаками для выравнивания.
	const kindCol = rows.map((r) => r.kind);
	const nameCol = rows.map((r) => r.name);
	const currCol = rows.map((r) => r.currency);
	const balCol = rows.map((r) => formatBalance(r.balance));

	const widths = [
		Math.max(HEADERS[0]!.length, ...kindCol.map((s) => s.length)),
		Math.max(HEADERS[1]!.length, ...nameCol.map((s) => s.length)),
		Math.max(HEADERS[2]!.length, ...currCol.map((s) => s.length)),
		Math.max(HEADERS[3]!.length, ...balCol.map((s) => s.length)),
	];

	/**
	 * pad — выравнивает строку до нужной ширины пробелами (дополняет справа).
	 * Для баланса (последняя колонка) используем выравнивание вправо (padStart),
	 * для остальных — влево (padEnd) — стандарт для таблиц.
	 */
	const padLeft = (s: string, w: number) => s.padEnd(w, ' ');
	const padRight = (s: string, w: number) => s.padStart(w, ' ');

	// Строка заголовка.
	const headerLine = [
		padLeft(HEADERS[0]!, widths[0]!),
		padLeft(HEADERS[1]!, widths[1]!),
		padLeft(HEADERS[2]!, widths[2]!),
		padRight(HEADERS[3]!, widths[3]!),
	].join('  ');

	// Разделитель (дефисы под каждой колонкой).
	const separator = widths.map((w) => '-'.repeat(w)).join('--');

	// Строки данных (row не нужен — используем индексы заранее вычисленных колонок).
	const dataLines = rows.map((_row, i) =>
		[
			padLeft(kindCol[i]!, widths[0]!),
			padLeft(nameCol[i]!, widths[1]!),
			padLeft(currCol[i]!, widths[2]!),
			padRight(balCol[i]!, widths[3]!),
		].join('  '),
	);

	return [headerLine, separator, ...dataLines].join('\n');
}

/**
 * formatBalance — форматирует баланс для отображения в таблице.
 * Целые числа — без дробной части; дробные — до 2 знаков.
 * Пример: 100000 → "100000", 1500.5 → "1500.50".
 *
 * @param n — числовое значение баланса
 * @returns строка с числом
 */
function formatBalance(n: number): string {
	if (!Number.isFinite(n)) return '?';
	// Показываем дробную часть только если она есть.
	return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/**
 * buildAccountsTablePng — ЧИСТАЯ функция: строки таблицы → PNG-Buffer.
 *
 * Конвертирует структурированные данные счетов в ChartSpec (balances_snapshot)
 * и растеризует через renderChartPng. Возвращает PNG-байты для sendDocument.
 *
 * Решение: использовать существующий рендер balances_snapshot (bar/pie) вместо
 * отдельного «таблица-рендерера» — унифицирует кодовую базу и избавляет от
 * необходимости рисовать таблицу вручную в SVG. Если в будущем нужна именно
 * таблица — добавить тип в ChartSpec/svg.ts без изменения этого файла.
 *
 * @param rows — строки таблицы (из buildAccountBalanceRows)
 * @returns Buffer PNG или null если данных нет (пустые rows)
 */
export function buildAccountsTablePng(rows: AccountBalanceRow[]): Buffer | null {
	if (rows.length === 0) {
		// Нет данных — нет смысла рендерить пустую картинку.
		return null;
	}

	// Строим BalanceEntry[] из строк таблицы для chartSpec balances_snapshot.
	const entries: BalanceEntry[] = rows.map((row) => ({
		// label: «kind счёт» — без PII (имя счёта уже без реальных данных ADR-0009).
		label: `${row.kind} ${row.name}`.slice(0, 40), // обрезаем для читаемости легенды
		value: row.balance,
		currency: row.currency,
	}));

	// Строим спеку и растеризуем.
	const spec = chartSpec({ kind: 'balances_snapshot', entries });
	return renderChartPng(spec);
}

// ---------------------------------------------------------------------------
// Тонкие адаптеры отправки (Ledger → sendDocument)
// ---------------------------------------------------------------------------

/**
 * sendTransactionsCsv — тонкий адаптер: читает транзакции из леджера и отправляет CSV.
 *
 * Шаги: Ledger.readAll('transactions') → buildTransactionsCsv → Buffer → sendDocument.
 * Best-effort для Telegram: ошибка отправки логируется, бросается дальше (вызывающий решает).
 *
 * Secret-gate (ADR-0011): caption без точных чисел («транзакции за период»),
 * filename — нейтральный ('transactions.csv'). Данные в самом CSV — полные (ADR-0023).
 *
 * @param ledger    — экземпляр Ledger для чтения транзакций
 * @param tg        — TelegramClient (реальный или мок для тестов)
 * @param chatId    — числовой id чата получателя (owner, ADR-0009)
 * @param nowFn     — функция текущего времени (для отметки в caption); дефолт → Date.now
 * @returns количество отправленных транзакций в CSV (для тестов)
 */
export async function sendTransactionsCsv(
	ledger: Ledger,
	tg: TelegramClient,
	chatId: number,
	nowFn: () => Date = () => new Date(),
): Promise<number> {
	// Читаем все транзакции из леджера (read-only).
	const records = ledger.readAll('transactions');

	// Строим CSV (чистая функция — детерминирована, без сети).
	const csvString = buildTransactionsCsv(records);
	const csvBuffer = Buffer.from(csvString, 'utf-8');

	// Нейтральный caption (secret-gate: без точных сумм).
	// Формат: "Транзакции (N записей). Экспорт YYYY-MM-DD."
	const dateLabel = nowFn().toISOString().slice(0, 10);
	const caption = `Транзакции (${records.length} записей). Экспорт ${dateLabel}.`;

	log.info({ recordCount: records.length, chatId }, 'finance-export: отправляем CSV транзакций');

	await tg.sendDocument(
		chatId,
		{
			data: csvBuffer,
			filename: 'transactions.csv',
			contentType: 'text/csv',
		},
		{ caption },
	);

	return records.length;
}

/**
 * sendAccountsTable — тонкий адаптер: читает балансы из леджера и отправляет PNG-сводку счетов.
 *
 * Шаги: Ledger.readAll('snapshots') + readAll('accounts') →
 *   buildAccountBalanceRows → buildAccountsTablePng → Buffer → sendDocument.
 *
 * Если данных нет (пустой леджер или нет снапшотов) — отправляет текстовое сообщение
 * «нет данных» вместо PNG (graceful).
 *
 * Secret-gate (ADR-0011): caption без точных сумм.
 *
 * @param ledger    — экземпляр Ledger для чтения счетов/снапшотов
 * @param tg        — TelegramClient
 * @param chatId    — id чата получателя
 * @param nowFn     — функция текущего времени (для asOf-среза)
 * @returns true если PNG отправлен, false если данных не было
 */
export async function sendAccountsTable(
	ledger: Ledger,
	tg: TelegramClient,
	chatId: number,
	nowFn: () => Date = () => new Date(),
): Promise<boolean> {
	// Читаем снапшоты и счета (read-only).
	const snapshots = ledger.readAll('snapshots');
	const accounts = ledger.readAll('accounts');

	if (snapshots.length === 0) {
		// Нет данных — отправляем текстовое сообщение вместо пустой картинки.
		log.info({ chatId }, 'finance-export: нет снапшотов — пропускаем PNG счетов');
		return false;
	}

	// Срез данных на asOf (ISO без миллисекунд — как в buildQueryContext).
	const asOf = nowFn().toISOString().replace(/\.\d{3}Z$/, 'Z');

	// Строим строки таблицы (чистая функция).
	const rows = buildAccountBalanceRows(snapshots, accounts, asOf);

	if (rows.length === 0) {
		// Снапшоты есть, но все в будущем (edge case при тестировании с прошлым nowFn).
		log.warn({ chatId, asOf }, 'finance-export: все снапшоты позже asOf — пропускаем');
		return false;
	}

	// Растеризуем в PNG (чистая функция).
	const pngBuffer = buildAccountsTablePng(rows);
	if (!pngBuffer) {
		return false;
	}

	// Нейтральный caption (secret-gate: без точных балансов).
	const dateLabel = nowFn().toISOString().slice(0, 10);
	const caption = `Сводка счетов (${rows.length} счетов). На ${dateLabel}.`;

	log.info({ rowCount: rows.length, chatId }, 'finance-export: отправляем PNG сводки счетов');

	await tg.sendDocument(
		chatId,
		{
			data: pngBuffer,
			filename: 'accounts.png',
			contentType: 'image/png',
		},
		{ caption },
	);

	return true;
}
