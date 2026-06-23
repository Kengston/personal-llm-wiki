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
	/**
	 * Расширенный набор kind (аддитивно, обратно совместимо):
	 *   - 'cash'     — наличные деньги (физически, ручной ввод, kind=cash)
	 *   - 'checking' — расчётный (текущий) банковский счёт
	 *   - 'savings'  — сберегательный банковский счёт / депозит
	 * Старые записи с 'bank'|'ewallet'|'exchange'|'loan' продолжают валидироваться.
	 */
	kind: z.enum(['bank', 'ewallet', 'exchange', 'loan', 'cash', 'checking', 'savings']),

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

	// ── Аддитивные поля (опциональные, обратно совместимые) ──────────────────
	// Старые записи без этих полей продолжают валидироваться.

	/**
	 * tags — произвольные теги для группировки и поиска.
	 * Примеры: ["grocery", "recurring"], ["salary"], ["transfer-internal"].
	 */
	tags: z.array(z.string()).optional(),

	/**
	 * transfer_id — идентификатор перевода между своими счетами.
	 * Две записи с одним transfer_id (in + out) — это внутренний перевод.
	 * Позволяет фильтровать их при подсчёте расходов/доходов.
	 */
	transfer_id: z.string().optional(),

	/**
	 * void_id — id транзакции, которую эта запись аннулирует (сторно).
	 * Append-only механизм отмены: вместо правки старой записи создаём новую
	 * с void_id = id отменённой. Обе записи остаются в леджере.
	 */
	void_id: z.string().optional(),

	/**
	 * amended_id — id транзакции, которую эта запись исправляет (поправка).
	 * Аналог void_id, но для частичных исправлений (изменение категории,
	 * суммы после уточнения). Reader берёт последнюю с данным amended_id.
	 */
	amended_id: z.string().optional(),

	/**
	 * source — источник записи.
	 *   - 'manual'   — введено вручную (тир 4, ADR-0018); дефолт.
	 *   - 'bybit'    — синк с Bybit.
	 *   - 'sms'      — распознано из SMS-уведомления банка.
	 *   - 'import'   — загружено из CSV/OFX/QIF экспорта.
	 * Default 'manual' — старые записи без поля валидируются (optional).
	 */
	source: z.enum(['manual', 'bybit', 'sms', 'import']).default('manual').optional(),

	/**
	 * is_subscription — транзакция является периодической подпиской.
	 * Флаг для отдельного учёта recurring-расходов в бюджете.
	 */
	is_subscription: z.boolean().optional(),

	/**
	 * goal_tag — ссылка на цель (FinanceGoal.id), к которой относится транзакция.
	 * Позволяет считать прогресс достижения цели накоплением/погашением.
	 */
	goal_tag: z.string().optional(),
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

	// ── Поля амортизации и напоминаний (аддитивные, опциональные) ────────────
	// Все новые поля опциональны — старые записи без них продолжают валидироваться.

	/**
	 * monthly_payment — ежемесячный платёж в нативной валюте.
	 * Для аннуитетного кредита — фиксированная сумма.
	 * Для дифференцированного — сумма первого платежа или текущего.
	 */
	monthly_payment: z.number().finite().positive().optional(),

	/**
	 * next_payment_date — дата следующего планового платежа (ISO-8601).
	 * Используется для напоминаний. Обновляется при каждом ручном вводе.
	 */
	next_payment_date: isoTimestamp.optional(),

	/**
	 * payment_day — день месяца планового платежа (1–31).
	 * Альтернатива next_payment_date для регулярных платежей без точной даты.
	 * Оба поля могут сосуществовать.
	 */
	payment_day: z.number().int().min(1).max(31).optional(),

	/**
	 * term — срок кредита в месяцах.
	 * Например, 24 = двухлетний кредит.
	 */
	term: z.number().int().positive().optional(),

	/**
	 * type — тип платежей по кредиту.
	 *   - 'annuity'       — аннуитетный (равные платежи каждый месяц)
	 *   - 'differentiated'— дифференцированный (убывающие платежи)
	 */
	type: z.enum(['annuity', 'differentiated']).optional(),

	/**
	 * penalty_rate — штрафная ставка при просрочке, % годовых. Опционально.
	 * Например, 36 = 36% годовых на просроченную часть.
	 */
	penalty_rate: z.number().finite().nonnegative().optional(),

	/**
	 * grace — льготный период в днях (grace period).
	 * Банки часто дают 3–5 дней без штрафа после даты платежа.
	 */
	grace: z.number().int().nonnegative().optional(),

	/**
	 * credit_limit — кредитный лимит (для кредитных карт и овердрафтов).
	 * Отличается от principal: лимит — максимально доступная сумма,
	 * principal — фактически выданная (израсходованная).
	 */
	credit_limit: z.number().finite().positive().optional(),
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
// 6. BudgetRecord — бюджет на период (месяц/квартал/год).
// ---------------------------------------------------------------------------

/**
 * BudgetRecord — запись бюджета на определённый период и категорию.
 *
 * Append-only: при изменении лимита добавляем новую запись — не правим старую.
 * Читатель берёт последнюю запись по (category + period_start).
 *
 * Мультивалютность: бюджет задаётся в конкретной валюте.
 * Для сравнения фактических расходов в другой валюте — через FX.
 */
export const BudgetRecordSchema = z.object({
	/**
	 * id — детерминированный идентификатор (хэш от category + period_start + currency).
	 */
	id: z.string().min(1),

	/**
	 * category — категория расходов, к которой применяется бюджет.
	 * Например, "grocery", "transport", "entertainment".
	 */
	category: z.string().min(1),

	/**
	 * period_start — начало периода бюджета (ISO, первый день месяца/квартала/года).
	 * Например, "2026-06-01T00:00:00Z" для июня 2026.
	 */
	period_start: isoTimestamp,

	/**
	 * period_end — конец периода бюджета (ISO, последний момент периода, exclusive).
	 * Например, "2026-07-01T00:00:00Z" для июня 2026.
	 */
	period_end: isoTimestamp,

	/**
	 * limit_amount — лимит расходов за период в нативной валюте.
	 */
	limit_amount: z.number().finite().positive(),

	/**
	 * currency — валюта лимита.
	 */
	currency,

	/**
	 * ts — момент создания/обновления этой записи бюджета.
	 */
	ts: isoTimestamp,

	/**
	 * note — произвольная заметка к бюджету. Опционально.
	 */
	note: z.string().optional(),
});

export type BudgetRecord = z.infer<typeof BudgetRecordSchema>;

// ---------------------------------------------------------------------------
// 7. CategoryRecord — справочник категорий транзакций.
// ---------------------------------------------------------------------------

/**
 * CategoryRecord — описание категории расходов/доходов.
 *
 * Справочник позволяет хранить иерархию категорий и их атрибуты.
 * Append-only: переименование/изменение = новая запись с тем же id.
 */
export const CategoryRecordSchema = z.object({
	/**
	 * id — строковый slug-идентификатор категории (напр. "grocery", "salary").
	 * Уникален. Используется в TransactionRecord.category и BudgetRecord.category.
	 */
	id: z.string().min(1),

	/**
	 * name — отображаемое название категории (напр. "Продукты", "Зарплата").
	 */
	name: z.string().min(1),

	/**
	 * parent_id — id родительской категории для иерархии. Опционально.
	 * Пример: "grocery" → parent_id: "food". Корневые категории без parent_id.
	 */
	parent_id: z.string().optional(),

	/**
	 * direction — к каким транзакциям применяется категория.
	 *   - 'in'   — только доходы (зарплата, дивиденды)
	 *   - 'out'  — только расходы (продукты, аренда)
	 *   - 'both' — и доходы и расходы (переводы, конвертация)
	 */
	direction: z.enum(['in', 'out', 'both']),

	/**
	 * ts — момент создания/обновления записи категории.
	 */
	ts: isoTimestamp,

	/**
	 * icon — опциональный Unicode-символ или идентификатор иконки для UI.
	 */
	icon: z.string().optional(),
});

export type CategoryRecord = z.infer<typeof CategoryRecordSchema>;

// ---------------------------------------------------------------------------
// 8. TemplateRecord — шаблон повторяющейся операции (recurring transaction).
// ---------------------------------------------------------------------------

/**
 * TemplateRecord — шаблон для создания регулярных транзакций.
 *
 * Примеры: ежемесячная аренда, подписки, зарплата.
 * Движок (Phase 2) читает шаблоны и предлагает/создаёт транзакции по расписанию.
 *
 * Поле `rrule` — iCalendar RRULE строка (совместимо с библиотекой rrule из package.json).
 * Пример: "FREQ=MONTHLY;BYMONTHDAY=1" = 1-го числа каждого месяца.
 */
export const TemplateRecordSchema = z.object({
	/**
	 * id — уникальный идентификатор шаблона.
	 */
	id: z.string().min(1),

	/**
	 * name — название шаблона (напр. "Аренда квартиры", "Netflix подписка").
	 */
	name: z.string().min(1),

	/**
	 * amount — сумма транзакции в нативной валюте (> 0).
	 */
	amount: z.number().finite().positive(),

	/**
	 * currency — валюта шаблона.
	 */
	currency,

	/**
	 * direction — направление: 'in' (доход) или 'out' (расход).
	 */
	direction: z.enum(['in', 'out']),

	/**
	 * category — категория транзакции (ссылка на CategoryRecord.id). Опционально.
	 */
	category: z.string().optional(),

	/**
	 * account_id — счёт, по которому будет создана транзакция. Опционально.
	 * Если не указан — пользователь выбирает при подтверждении.
	 */
	account_id: z.string().optional(),

	/**
	 * rrule — правило повторения в формате iCalendar RRULE.
	 * Примеры:
	 *   "FREQ=MONTHLY;BYMONTHDAY=1"   — ежемесячно 1-го числа
	 *   "FREQ=WEEKLY;BYDAY=MO"         — каждый понедельник
	 *   "FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=15" — 15 января каждый год
	 */
	rrule: z.string().min(1),

	/**
	 * active — активен ли шаблон. false = приостановлен (не удалён — append-only).
	 */
	active: z.boolean(),

	/**
	 * ts — момент создания/обновления записи шаблона.
	 */
	ts: isoTimestamp,

	/**
	 * tags — опциональные теги для фильтрации и группировки шаблонов.
	 */
	tags: z.array(z.string()).optional(),

	/**
	 * note — произвольная заметка. Опционально.
	 */
	note: z.string().optional(),
});

export type TemplateRecord = z.infer<typeof TemplateRecordSchema>;

// ---------------------------------------------------------------------------
// 9. ReceivableRecord — долг мне (кто-то должен мне деньги).
// ---------------------------------------------------------------------------

/**
 * ReceivableRecord — запись о дебиторской задолженности (долге мне).
 *
 * Append-only: обновление состояния (частичное погашение, закрытие) = новая запись.
 * Читатель берёт последнюю запись по id.
 *
 * Без PII: debtor — описание без реального ФИО (напр. "friend-abc" или "business-xyz").
 */
export const ReceivableRecordSchema = z.object({
	/**
	 * id — уникальный идентификатор задолженности.
	 */
	id: z.string().min(1),

	/**
	 * debtor — непрозрачный идентификатор/псевдоним должника. Без PII.
	 */
	debtor: z.string().min(1),

	/**
	 * amount — сумма задолженности в нативной валюте (> 0).
	 */
	amount: z.number().finite().positive(),

	/**
	 * currency — валюта долга.
	 */
	currency,

	/**
	 * created_at — дата возникновения долга (ISO).
	 */
	created_at: isoTimestamp,

	/**
	 * due_date — ожидаемая дата возврата (ISO). Опционально.
	 */
	due_date: isoTimestamp.optional(),

	/**
	 * status — текущее состояние задолженности.
	 *   - 'open'     — открыта, ещё не погашена
	 *   - 'partial'  — частично погашена
	 *   - 'closed'   — полностью погашена
	 *   - 'disputed' — оспаривается
	 */
	status: z.enum(['open', 'partial', 'closed', 'disputed']),

	/**
	 * ts — момент создания/обновления этой записи (для дедупликации).
	 */
	ts: isoTimestamp,

	/**
	 * note — опциональная заметка без PII (напр. "за обед 2026-05-15").
	 */
	note: z.string().optional(),
});

export type ReceivableRecord = z.infer<typeof ReceivableRecordSchema>;

// ---------------------------------------------------------------------------
// 10. PayableRecord — мой долг (я должен кому-то деньги).
// ---------------------------------------------------------------------------

/**
 * PayableRecord — запись о кредиторской задолженности (мой долг кому-то).
 *
 * Аналогична ReceivableRecord, но с обратной стороны: creditor = кредитор.
 * Append-only; без PII — creditor псевдоним без реального ФИО.
 *
 * Отличие от CreditRecord: CreditRecord — банковский кредит с амортизацией.
 * PayableRecord — неформальный долг (друг, коллега, предоплата поставщику).
 */
export const PayableRecordSchema = z.object({
	/**
	 * id — уникальный идентификатор задолженности.
	 */
	id: z.string().min(1),

	/**
	 * creditor — непрозрачный идентификатор/псевдоним кредитора. Без PII.
	 */
	creditor: z.string().min(1),

	/**
	 * amount — сумма долга в нативной валюте (> 0).
	 */
	amount: z.number().finite().positive(),

	/**
	 * currency — валюта долга.
	 */
	currency,

	/**
	 * created_at — дата возникновения долга (ISO).
	 */
	created_at: isoTimestamp,

	/**
	 * due_date — ожидаемая дата погашения (ISO). Опционально.
	 */
	due_date: isoTimestamp.optional(),

	/**
	 * status — текущее состояние задолженности.
	 *   - 'open'     — открыта, ещё не погашена
	 *   - 'partial'  — частично погашена
	 *   - 'closed'   — полностью погашена
	 */
	status: z.enum(['open', 'partial', 'closed']),

	/**
	 * ts — момент создания/обновления этой записи.
	 */
	ts: isoTimestamp,

	/**
	 * note — опциональная заметка без PII.
	 */
	note: z.string().optional(),
});

export type PayableRecord = z.infer<typeof PayableRecordSchema>;

// ---------------------------------------------------------------------------
// 11. SettingsRecord — настройки финансового модуля.
// ---------------------------------------------------------------------------

/**
 * SettingsRecord — глобальные настройки финансового модуля.
 *
 * Append-only: при изменении настроек добавляем новую запись.
 * Читатель берёт последнюю запись — она и есть актуальные настройки.
 *
 * НЕТ "базовой валюты" (per ADR-0018): display_currencies — НАБОР отображаемых
 * валют для roll-up. Все суммы хранятся нативно.
 */
export const SettingsRecordSchema = z.object({
	/**
	 * ts — момент сохранения настроек (ключ для поиска последней версии).
	 */
	ts: isoTimestamp,

	/**
	 * display_currencies — набор валют для roll-up отображения (без "базовой").
	 * Пример: ["RUB", "USD", "USDT"]. Порядок = порядок отображения.
	 * LLM показывает балансы в каждой из этих валют через FX-конвертацию.
	 */
	display_currencies: z.array(currency).min(1),

	/**
	 * tz — часовой пояс пользователя (IANA timezone string).
	 * Используется для форматирования дат в ответах LLM.
	 * Пример: "Europe/Moscow", "Asia/Tbilisi", "UTC".
	 */
	tz: z.string().min(1),

	/**
	 * thresholds — пороги для правил и напоминаний.
	 * Минимально-достаточный набор, всё опционально:
	 *
	 *   low_balance_alert: { amount, currency } — предупреждать при балансе < amount
	 *   budget_warn_pct: число 0–100 — процент исчерпания бюджета для предупреждения
	 *     (напр. 80 = предупреждать при достижении 80% лимита)
	 *   fx_staleness_hours: максимальный возраст курса в часах перед "устарел"
	 *
	 * Расширяемый словарь — новые пороги добавляются без правки схемы.
	 */
	thresholds: z
		.object({
			/**
			 * low_balance_alert — порог низкого баланса для уведомлений.
			 * Если суммарный баланс в указанной валюте ниже amount — LLM предупреждает.
			 */
			low_balance_alert: z
				.object({
					amount: z.number().finite().nonnegative(),
					currency,
				})
				.optional(),

			/**
			 * budget_warn_pct — процент исчерпания бюджета для предупреждения (0–100).
			 * Пример: 80 = предупреждать когда потрачено >= 80% лимита.
			 */
			budget_warn_pct: z.number().finite().min(0).max(100).optional(),

			/**
			 * fx_staleness_hours — максимальный возраст FX-курса в часах.
			 * По умолчанию — 24 часа (не хранится в схеме, логика в движке).
			 */
			fx_staleness_hours: z.number().finite().positive().optional(),
		})
		.optional(),
});

export type SettingsRecord = z.infer<typeof SettingsRecordSchema>;

// ---------------------------------------------------------------------------
// 12. FinanceGoalSchema — схема фронтматтера страниц type:'finance-goal'.
// ---------------------------------------------------------------------------

/**
 * FinanceGoalSchema — схема валидации YAML-фронтматтера страниц вики типа 'finance-goal'.
 *
 * Цели (FinanceGoal) — это СТРАНИЦЫ вики, не файлы леджера.
 * Хранятся в ~/llm-wiki-content/wiki/finance/goals/ как Markdown с YAML-фронтматтером.
 * Этот файл (types.ts) — в публичном репо, схема валидации — тоже публичная.
 *
 * Связь с леджером: TransactionRecord.goal_tag ссылается на FinanceGoal.id.
 *
 * Принципы:
 *   - target_amount + currency в нативной валюте (нет "базовой валюты").
 *   - fin_kind классифицирует цель для алгоритмов расчёта прогресса.
 *   - linked_accounts — список account_id из леджера (опц., для автосчёта прогресса).
 */
export const FinanceGoalSchema = z.object({
	/**
	 * id — уникальный идентификатор цели (slug).
	 * Пример: "emergency-fund-2026", "debt-paydown-credit-001".
	 * На него ссылается TransactionRecord.goal_tag.
	 */
	id: z.string().min(1),

	/**
	 * type — тип страницы (всегда 'finance-goal' для этой схемы).
	 * Поле-дискриминант для парсера фронтматтера вики.
	 */
	type: z.literal('finance-goal'),

	/**
	 * target_amount — целевая сумма в нативной валюте.
	 * Для 'save' и 'grow' — накопить эту сумму.
	 * Для 'spend_cap' — не тратить больше этой суммы за период.
	 * Для 'debt_paydown' — погасить долг на эту сумму.
	 */
	target_amount: z.number().finite().positive(),

	/**
	 * currency — валюта цели (ISO-4217 или крипто-символ).
	 */
	currency,

	/**
	 * target_date — целевая дата достижения (ISO-8601, например "2026-12-31").
	 */
	target_date: isoTimestamp,

	/**
	 * fin_kind — вид финансовой цели, определяет алгоритм расчёта прогресса:
	 *   - 'save'         — накопление (увеличить баланс до target_amount)
	 *   - 'spend_cap'    — ограничение расходов (не превысить target_amount за период)
	 *   - 'debt_paydown' — погашение долга (снизить balance кредита до 0 или target_amount)
	 *   - 'grow'         — рост активов (portfolio value >= target_amount)
	 */
	fin_kind: z.enum(['save', 'spend_cap', 'debt_paydown', 'grow']),

	/**
	 * linked_accounts — список account_id из леджера, используемых для
	 * автоматического расчёта прогресса. Опционально.
	 * Если не указан — прогресс считается только по транзакциям с goal_tag.
	 */
	linked_accounts: z.array(z.string()).optional(),

	/**
	 * priority — приоритет цели (целое число, меньше = выше приоритет).
	 * Используется при отображении списка целей пользователю. Опционально.
	 */
	priority: z.number().int().nonnegative().optional(),
});

export type FinanceGoal = z.infer<typeof FinanceGoalSchema>;

// ---------------------------------------------------------------------------
// Дискриминированный union всех типов леджера
// ---------------------------------------------------------------------------

/**
 * Все типы записей в одном union — для универсального reader'а,
 * который читает разнотипный JSONL без знания конкретных файлов.
 *
 * Каждый тип имеет отличительный набор полей (дискриминация по наличию
 * ключевых полей). Formal discriminant не добавляем — не нарушаем ADR-0018
 * о минимальном леджере; тип определяется по файлу (accounts.jsonl → AccountRecord).
 *
 * FinanceGoalSchema не входит в LedgerRecord — цели хранятся как страницы вики,
 * а не в JSONL-файлах леджера.
 */
export type LedgerRecord =
	| AccountRecord
	| SnapshotRecord
	| TransactionRecord
	| CreditRecord
	| FxRateRecord
	| BudgetRecord
	| CategoryRecord
	| TemplateRecord
	| ReceivableRecord
	| PayableRecord
	| SettingsRecord;

/** Имена файлов леджера — константа для ledger.ts и тестов. */
export const LEDGER_FILES = {
	accounts: 'accounts.jsonl',
	snapshots: 'snapshots.jsonl',
	transactions: 'transactions.jsonl',
	credits: 'credits.jsonl',
	fx_rates: 'fx_rates.jsonl',
	// Новые файлы (E4) — аддитивно
	budgets: 'budgets.jsonl',
	categories: 'categories.jsonl',
	templates: 'templates.jsonl',
	receivables: 'receivables.jsonl',
	payables: 'payables.jsonl',
	settings: 'settings.jsonl',
} as const;

export type LedgerFileKey = keyof typeof LEDGER_FILES;
