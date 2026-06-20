/**
 * types.ts — Zod-схемы и выведенные TypeScript-типы для append-only JSONL-леджера.
 *
 * Контекст ([ADR-0018]): леджер хранится в приватном репо `llm-wiki-content` под
 * `raw/finance/`. Ни одна схема не содержит данных владельца — только структуру.
 *
 * МУЛЬТИВАЛЮТНОСТЬ. Каждая сумма хранится в НАТИВНОЙ валюте источника. Поле
 * `currency` — свободная строка: ISO-4217 (USD, EUR, RUB, GEL) или крипто-символ
 * (USDT, BTC, ETH, TON и т.д.). Захардкоженного списка валют НЕТ — новые работают
 * без правки кода. FX-конвертация — только для roll-up отображения, и только по
 * `fx_rates.jsonl`; хранение всегда нативное.
 *
 * ТОЧНОСТЬ ЧИСЕЛNumber (IEEE-754 float64). Обоснование: у нас нет биржевой
 * точности; float64 даёт 15-16 значащих цифр, чего достаточно для любого
 * реального баланса в рублях/USD/крипто. Для крипто (сатоши / wei) документируем
 * что значение в НАТИВНЫХ единицах источника (напр. Bybit возвращает BTC как
 * "0.00012345") — float64 это хранит точно. Если в будущем потребуется integer
 * minor-units, схему расширяем добавлением поля `amount_raw_str: string`, не
 * ломая существующие записи (append-only).
 *
 * МЕТКИ ВРЕМЕНИ — строки ISO-8601 с timezone (UTC рекомендован): "2026-06-13T10:00:00Z".
 * Строка, а не Date: леджер — append-only JSONL (текст), движок на Python/TS читает его
 * одинаково. Поля с суффиксом `_at` — момент события; `_ts` — момент снапшота/фиксации.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Базовые типы
// ---------------------------------------------------------------------------

/**
 * isoTimestamp — ISO-8601 дата/время как строка. Мы не парсим zod-ом в Date,
 * чтобы: (1) сохранить timezone из источника, (2) не зависеть от часового пояса хоста,
 * (3) JSONL читается одинаково на любом языке.
 */
const isoTimestamp = z.string().min(1).describe('ISO-8601 timestamp, e.g. "2026-06-13T10:00:00Z"');

/**
 * currency — свободная строка: ISO-4217 или крипто-символ.
 * Примеры: "USD", "RUB", "GEL", "EUR", "USDT", "BTC", "ETH", "TON".
 * Минимум 1 символ, максимум 10 (USDT, crypto, нет длиннее).
 * Верхний регистр рекомендован (Bybit отдаёт UPPERCASE) — но НЕ валидируем жёстко,
 * чтобы не ломаться на нестандартных символах.
 */
const currency = z.string().min(1).max(10).describe('ISO-4217 code or crypto symbol, e.g. "USD", "USDT", "BTC"');

// ---------------------------------------------------------------------------
// 1. AccountRecord — описание счёта/кошелька/биржевого кармана.
// ---------------------------------------------------------------------------

/**
 * AccountRecord описывает один финансовый счёт. Каждый источник данных порождает
 * свои AccountRecord'ы при первом sync'е (или обновляет при изменениях — но
 * леджер append-only, дедуп по id делает reader).
 *
 * Поле `id`:  детерминированный непрозрачный идентификатор. Коннектор строит его
 * хэшом из source + coin/account_no — без PII.
 *
 * Поле `kind` классифицирует тип счёта для roll-up'ов и отображения:
 *   - 'bank'     — банковский счёт (расчётный, сберегательный)
 *   - 'ewallet'  — электронный кошелёк (YooMoney, Qiwi и пр.)
 *   - 'exchange' — биржевый карман (Bybit UNIFIED spot/futures по монете)
 *   - 'loan'     — кредит/займ (баланс = остаток долга)
 *
 * Поле `meta` — произвольный словарь для source-specific атрибутов (напр.
 * биржевый accountType, тип сети для крипто-адреса). Не валидируем содержимое.
 */
export const AccountRecordSchema = z.object({
	/**
	 * id — детерминированный непрозрачный идентификатор счёта.
	 * Строится коннектором как хэш(source + coin/iban): нет PII, идемпотентно.
	 */
	id: z.string().min(1),

	/**
	 * source — идентификатор коннектора/источника (напр. "bybit", "yoomoney").
	 * Позволяет фильтровать записи по источнику при roll-up.
	 */
	source: z.string().min(1),

	/**
	 * kind — тип счёта для категоризации.
	 */
	kind: z.enum(['bank', 'ewallet', 'exchange', 'loan']),

	/**
	 * name — человекочитаемое имя счёта (напр. "Bybit USDT UNIFIED").
	 * Никаких реальных имён владельца — только описание счёта.
	 */
	name: z.string().min(1),

	/**
	 * currency — нативная валюта счёта.
	 */
	currency,

	/**
	 * opened_at — дата открытия счёта (ISO). Опционально — не все источники дают.
	 */
	opened_at: isoTimestamp.optional(),

	/**
	 * meta — source-specific атрибуты. Не содержит токенов или PII.
	 * Примеры: { accountType: "UNIFIED", marginMode: "ISOLATED" }.
	 */
	meta: z.record(z.string(), z.unknown()).optional(),
});

export type AccountRecord = z.infer<typeof AccountRecordSchema>;

// ---------------------------------------------------------------------------
// 2. SnapshotRecord — баланс счёта на момент синка.
// ---------------------------------------------------------------------------

/**
 * SnapshotRecord — один снапшот баланса конкретного счёта.
 *
 * Логика: при каждом sync'е коннектор записывает текущий баланс как
 * новый SnapshotRecord. Никакого "обновления" — только append.
 * Читатель берёт последний снапшот по `account_id + ts`.
 *
 * Поле `balance` — НАТИВНОЕ значение в `currency`. float64-точность достаточна
 * (см. комментарий в начале файла).
 */
export const SnapshotRecordSchema = z.object({
	/**
	 * ts — момент синка (не время обновления баланса на бирже, а время нашего запроса).
	 */
	ts: isoTimestamp,

	/**
	 * account_id — ссылка на AccountRecord.id.
	 */
	account_id: z.string().min(1),

	/**
	 * balance — текущий баланс в нативной валюте счёта.
	 * Для кредитов — остаток долга (всегда >= 0).
	 */
	balance: z.number().finite(),

	/**
	 * currency — нативная валюта баланса (дублируем из AccountRecord для
	 * self-contained чтения без join'а).
	 */
	currency,
});

export type SnapshotRecord = z.infer<typeof SnapshotRecordSchema>;

// ---------------------------------------------------------------------------
// 3. TransactionRecord — одна операция (приход/расход).
// ---------------------------------------------------------------------------

/**
 * TransactionRecord — одна финансовая операция.
 *
 * `direction` — 'in' (зачисление) или 'out' (списание), определяется коннектором
 * по знаку суммы или типу транзакции источника. `amount` ВСЕГДА > 0 (направление
 * кодирует `direction`).
 *
 * `category` — опциональная категория (напр. "deposit", "withdrawal",
 * "trade", "fee", "funding"). Коннектор ставит категорию из типа транзакции
 * источника; классификатор бюджета — отдельный модуль (Phase 2).
 *
 * `counterparty` — опционально, без PII. Для биржи — пустая строка или код пары.
 * Для банков (тир уведомлений) — название контрагента из СМС-шаблона.
 *
 * `raw_ref` — непрозрачная ссылка на оригинальную запись в источнике
 * (transactionId Bybit, orderId). Для дедупликации при повторных sync'ах.
 */
export const TransactionRecordSchema = z.object({
	/**
	 * id — детерминированный непрозрачный идентификатор транзакции.
	 * Строится коннектором (напр. хэш(source + raw_ref) или raw_ref напрямую).
	 */
	id: z.string().min(1),

	/**
	 * ts — момент транзакции в источнике (UTC ISO).
	 */
	ts: isoTimestamp,

	/**
	 * account_id — ссылка на AccountRecord.id.
	 */
	account_id: z.string().min(1),

	/**
	 * amount — абсолютная сумма транзакции в нативной валюте (> 0).
	 * Знак кодирует поле `direction`.
	 */
	amount: z.number().finite().positive(),

	/**
	 * currency — нативная валюта транзакции.
	 */
	currency,

	/**
	 * direction — направление потока: 'in' зачисление, 'out' списание.
	 */
	direction: z.enum(['in', 'out']),

	/**
	 * category — категория транзакции (от источника или нормализованная).
	 * Опционально. Примеры: "deposit", "withdrawal", "trade_fee", "funding".
	 */
	category: z.string().optional(),

	/**
	 * counterparty — имя/код контрагента без PII.
	 * Для биржи — торговая пара, для банка — тип контрагента из шаблона.
	 */
	counterparty: z.string().optional(),

	/**
	 * raw_ref — оригинальный идентификатор записи в источнике (transactionId,
	 * orderId и т.п.). Нужен для дедупликации при повторных запросах.
	 */
	raw_ref: z.string().optional(),
});

export type TransactionRecord = z.infer<typeof TransactionRecordSchema>;

// ---------------------------------------------------------------------------
// 4. CreditRecord — снапшот кредита/займа.
// ---------------------------------------------------------------------------

/**
 * CreditRecord — один снапшот состояния кредита.
 *
 * Как и SnapshotRecord — append-only; читатель берёт последний по `id + balance_ts`.
 *
 * Кредиты часто не имеют API (российские банки) — поле `manual: true` означает,
 * что запись внесена вручную (тир 4 по ADR-0018). `manual: false` — автоматический
 * sync через white API.
 *
 * `rate_pct` — годовая ставка в процентах (опц., напр. 21.5 означает 21,5% годовых).
 */
export const CreditRecordSchema = z.object({
	/**
	 * id — непрозрачный идентификатор кредита (детерминированный хэш или ручной slug).
	 */
	id: z.string().min(1),

	/**
	 * source — коннектор или "manual" для ручного ввода.
	 */
	source: z.string().min(1),

	/**
	 * principal — первоначальная сумма кредита в нативной валюте.
	 */
	principal: z.number().finite().positive(),

	/**
	 * currency — валюта кредита.
	 */
	currency,

	/**
	 * rate_pct — годовая ставка в процентах. Опционально.
	 * 21.5 → 21,5% годовых.
	 */
	rate_pct: z.number().finite().nonnegative().optional(),

	/**
	 * opened_at — дата открытия кредита (ISO). Опционально.
	 */
	opened_at: isoTimestamp.optional(),

	/**
	 * due_at — дата погашения кредита (ISO). Опционально.
	 */
	due_at: isoTimestamp.optional(),

	/**
	 * balance — текущий остаток долга в нативной валюте (≥ 0).
	 */
	balance: z.number().finite().nonnegative(),

	/**
	 * balance_ts — момент, когда зафиксирован текущий остаток (ISO).
	 */
	balance_ts: isoTimestamp,

	/**
	 * manual — true если запись внесена вручную, false — автоматический sync.
	 */
	manual: z.boolean(),
});

export type CreditRecord = z.infer<typeof CreditRecordSchema>;

// ---------------------------------------------------------------------------
// 5. FxRateRecord — курс обмена для исторической точности.
// ---------------------------------------------------------------------------

/**
 * FxRateRecord — курс пары валют на момент sync'а.
 *
 * Каждый sync фиксирует курс для пересчёта нативных балансов в отображаемые
 * валюты. Храним исторически (append-only) — так можно восстановить стоимость
 * портфеля на любую дату.
 *
 * Пример: { ts: "2026-06-13T10:00:00Z", base: "USD", quote: "RUB", rate: 81.5, source: "cbr" }
 * означает: 1 USD = 81.5 RUB на этот момент по данным ЦБ РФ.
 *
 * `source` — провайдер курса (напр. "cbr", "bybit", "manual", "identity").
 * Позволяет аудитировать откуда взят курс при несоответствии.
 */
export const FxRateRecordSchema = z.object({
	/**
	 * ts — момент фиксации курса (UTC ISO).
	 */
	ts: isoTimestamp,

	/**
	 * base — базовая валюта (числитель), напр. "USD".
	 */
	base: currency,

	/**
	 * quote — валюта котировки (знаменатель), напр. "RUB".
	 * rate = цена одной единицы base в quote.
	 */
	quote: currency,

	/**
	 * rate — число единиц quote за одну единицу base.
	 * Всегда > 0. Пример: base=USD, quote=RUB, rate=81.5 → $1 = 81.5 ₽.
	 */
	rate: z.number().finite().positive(),

	/**
	 * source — провайдер курса: "cbr", "bybit", "identity", "manual" и т.п.
	 */
	source: z.string().min(1),
});

export type FxRateRecord = z.infer<typeof FxRateRecordSchema>;

// ---------------------------------------------------------------------------
// Дискриминированный union всех типов леджера
// ---------------------------------------------------------------------------

/**
 * Все 5 типов записей в одном union — для универсального reader'а,
 * который читает разнотипный JSONL без знания конкретных файлов.
 *
 * Каждый тип имеет отличительный набор полей (дискриминация по наличию
 * ключевых полей). Formal discriminant не добавляем — не нарушаем ADR-0018
 * о минимальном леджере; тип определяется по файлу (accounts.jsonl → AccountRecord).
 */
export type LedgerRecord = AccountRecord | SnapshotRecord | TransactionRecord | CreditRecord | FxRateRecord;

/** Имена файлов леджера — константа для ledger.ts и тестов. */
export const LEDGER_FILES = {
	accounts: 'accounts.jsonl',
	snapshots: 'snapshots.jsonl',
	transactions: 'transactions.jsonl',
	credits: 'credits.jsonl',
	fx_rates: 'fx_rates.jsonl',
} as const;

export type LedgerFileKey = keyof typeof LEDGER_FILES;
