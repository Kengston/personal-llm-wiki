/**
 * networth.ts — чистая функция расчёта чистого капитала (net worth).
 *
 * Контекст ([ADR-0018], «финансовый модуль», фаза #5):
 *   Net worth = Активы − Обязательства.
 *
 *   Активы:       последний SnapshotRecord ≤ asOf для каждого уникального account_id.
 *   Обязательства: последний CreditRecord ≤ asOf для каждого уникального id
 *                  (берётся по полю balance_ts).
 *
 * МУЛЬТИВАЛЮТНОСТЬ (ADR-0018 «нет единой базовой валюты»):
 *   - perCurrency:              сырые суммы в нативных валютах (без конвертации).
 *   - totalsByDisplayCurrency:  сумма net worth для каждой из displayCurrencies,
 *                               рассчитанная через FX (исторический курс на asOf).
 *   - breakdownByKind:          разбивка активов по типу счёта (cash/bank/savings/...).
 *
 * ГРАЦИОЗНАЯ ОБРАБОТКА НЕДОСТАЮЩИХ КУРСОВ:
 *   Если FxProvider вернул null для пары при конвертации в displayCurrency — позиция
 *   помечается как unconvertible и НЕ включается в totalsByDisplayCurrency. Функция
 *   НЕ бросает, НЕ возвращает NaN. В результат добавляется поле `unconvertible` с
 *   информацией о пропущенных суммах — для прозрачности.
 *
 * ДЕТЕРМИНИЗМ:
 *   - Выбор «последнего снапшота/кредита ≤ asOf» — лексикографически
 *     (ISO-8601 UTC строки сортируются корректно).
 *   - Для снапшотов: сравниваем ts ≤ asOf, берём с максимальным ts.
 *   - Для кредитов: сравниваем balance_ts ≤ asOf, берём с максимальным balance_ts.
 *   - При равных ts — берём последний по порядку в массиве (редуктор с >=).
 *
 * ВАЖНО: модуль — ТОЛЬКО чистые вычисления. Нет импортов Ledger, нет IO,
 * нет сети. Вызывающий код подаёт массивы записей и FxProvider.
 */

import type { FxProvider } from './fx.js';
import type { AccountRecord, CreditRecord, SnapshotRecord } from './types.js';

// ---------------------------------------------------------------------------
// Вспомогательные типы результата
// ---------------------------------------------------------------------------

/**
 * PerCurrencyAmount — сырые суммы в каждой нативной валюте.
 *
 * Положительное значение = чистый актив в этой валюте.
 * Отрицательное = чистое обязательство (кредиты превышают активы).
 *
 * Пример:
 *   { USD: 1500.0, RUB: -450000.0, USDT: 200.0 }
 *   → В USD 1500 активов нетто, по рублю — долг 450 000 ₽.
 */
export type PerCurrencyAmount = Record<string, number>;

/**
 * BreakdownByKind — суммарный баланс активов по типу счёта (kind).
 *
 * Ключ — kind из AccountRecord ('cash', 'bank', 'checking', 'savings',
 * 'exchange', 'ewallet'). Обязательства (loan) учитываются через CreditRecord,
 * поэтому в breakdown попадают только АКТИВЫ.
 *
 * Каждый kind хранит Map<currency, balance> — нативные суммы без конвертации.
 *
 * Пример:
 *   {
 *     cash:     { RUB: 10000.0 },
 *     exchange: { USDT: 300.0, BTC: 0.005 },
 *     savings:  { RUB: 200000.0 },
 *   }
 */
export type BreakdownByKind = Record<string, PerCurrencyAmount>;

/**
 * UnconvertibleItem — одна сумма, которую не удалось сконвертировать.
 *
 * Используется для прозрачной отчётности: пользователь видит, что часть
 * портфеля не вошла в totalsByDisplayCurrency из-за отсутствия курса.
 */
export interface UnconvertibleItem {
	/** Нативная валюта суммы, курс которой не найден. */
	nativeCurrency: string;
	/** Нативная сумма (может быть отрицательной для обязательств). */
	nativeAmount: number;
	/** Целевая display currency, в которую не удалось сконвертировать. */
	targetDisplayCurrency: string;
}

/**
 * NetWorthResult — результат computeNetWorth.
 *
 * Все числа конечны (finite), NaN полностью исключён.
 */
export interface NetWorthResult {
	/**
	 * perCurrency — чистые суммы в каждой нативной валюте (активы − обязательства).
	 *
	 * Пример: { USDT: 300.0, RUB: -450000.0, BTC: 0.005 }
	 * Ключи — только валюты, по которым есть снапшоты или кредиты ≤ asOf.
	 */
	perCurrency: PerCurrencyAmount;

	/**
	 * totalsByDisplayCurrency — чистый капитал, выраженный в каждой из
	 * displayCurrencies через исторический FX на дату asOf.
	 *
	 * Ключ — display currency (например "RUB", "USD", "USDT").
	 * Значение — сумма всех конвертированных позиций.
	 * Позиции, для которых FX-курс недоступен, НЕ включаются (см. unconvertible).
	 */
	totalsByDisplayCurrency: Record<string, number>;

	/**
	 * breakdownByKind — разбивка АКТИВОВ (не обязательств) по типу счёта.
	 *
	 * Ключ первого уровня — kind счёта ('cash', 'bank', 'exchange' и т.д.).
	 * Ключ второго уровня — нативная валюта счёта.
	 * Значение — баланс по последнему снапшоту ≤ asOf.
	 */
	breakdownByKind: BreakdownByKind;

	/**
	 * unconvertible — суммы, которые не удалось включить в totalsByDisplayCurrency
	 * из-за отсутствия FX-курса.
	 *
	 * Пустой массив = конвертация прошла полностью.
	 * При наличии элементов — totalsByDisplayCurrency частичный (занижен).
	 */
	unconvertible: UnconvertibleItem[];
}

// ---------------------------------------------------------------------------
// Вспомогательные чистые функции
// ---------------------------------------------------------------------------

/**
 * pickLatestSnapshot — выбирает последний снапшот для каждого account_id
 * среди тех, у которых ts ≤ asOf.
 *
 * Детерминировано: при равных ts побеждает запись позже в массиве (>= в редукторе).
 * Снапшоты с ts > asOf полностью игнорируются.
 *
 * @param snapshots - все снапшоты из леджера (порядок произвольный)
 * @param asOf      - момент расчёта (ISO-8601), включительно
 * @returns Map<account_id, SnapshotRecord> — один снапшот на счёт
 */
function pickLatestSnapshot(
	snapshots: SnapshotRecord[],
	asOf: string,
): Map<string, SnapshotRecord> {
	const latest = new Map<string, SnapshotRecord>();

	for (const snap of snapshots) {
		// Игнорируем снапшоты «из будущего» относительно asOf.
		if (snap.ts > asOf) continue;

		const current = latest.get(snap.account_id);
		// Если нет текущего лидера — берём этот снапшот.
		// Если ts нового >= текущего — новый побеждает (>= для детерминизма при равных ts).
		if (current === undefined || snap.ts >= current.ts) {
			latest.set(snap.account_id, snap);
		}
	}

	return latest;
}

/**
 * pickLatestCredit — выбирает последний CreditRecord для каждого credit id
 * среди тех, у которых balance_ts ≤ asOf.
 *
 * Детерминировано: при равных balance_ts побеждает запись позже в массиве.
 * Кредиты с balance_ts > asOf полностью игнорируются.
 *
 * @param credits - все кредиты из леджера
 * @param asOf    - момент расчёта (ISO-8601), включительно
 * @returns Map<credit_id, CreditRecord> — один снапшот на кредит
 */
function pickLatestCredit(
	credits: CreditRecord[],
	asOf: string,
): Map<string, CreditRecord> {
	const latest = new Map<string, CreditRecord>();

	for (const credit of credits) {
		// Игнорируем кредиты с balance_ts из будущего.
		if (credit.balance_ts > asOf) continue;

		const current = latest.get(credit.id);
		if (current === undefined || credit.balance_ts >= current.balance_ts) {
			latest.set(credit.id, credit);
		}
	}

	return latest;
}

/**
 * addToPerCurrency — добавляет amount к словарю perCurrency для currency.
 *
 * Мутирует переданный объект (вспомогательная функция внутри модуля).
 * Используется для накопления сырых сумм без конвертации.
 *
 * @param acc      - аккумулятор PerCurrencyAmount (мутируется)
 * @param currency - нативная валюта
 * @param amount   - сумма (положительная = актив, отрицательная = обязательство)
 */
function addToPerCurrency(acc: PerCurrencyAmount, currency: string, amount: number): void {
	const prev = acc[currency] ?? 0;
	acc[currency] = prev + amount;
}

// ---------------------------------------------------------------------------
// Главная экспортируемая функция
// ---------------------------------------------------------------------------

/**
 * computeNetWorth — вычисляет чистый капитал (net worth) на дату asOf.
 *
 * Алгоритм:
 *   1. Из массива accountSnapshots берём последний снапшот для каждого account_id
 *      с ts ≤ asOf. Это — активы.
 *   2. Из массива credits берём последний снапшот для каждого credit id
 *      с balance_ts ≤ asOf. Остаток долга (balance) — обязательство.
 *   3. perCurrency = Σ активы по валюте − Σ обязательства по валюте.
 *   4. breakdownByKind строится по АКТИВАМ (снапшоты, не кредиты):
 *      для каждого снапшота находим AccountRecord по account_id и группируем по kind.
 *   5. Для каждой displayCurrency:
 *      - конвертируем каждую нативную позицию из perCurrency через FX (на asOf).
 *      - позиции с null-курсом → в unconvertible, не в итог.
 *      - суммируем конвертированные → totalsByDisplayCurrency[dc].
 *
 * ВАЖНО: функция асинхронная из-за FxProvider.rate(). Все остальные шаги синхронны.
 *
 * @param accountSnapshots - все SnapshotRecord из леджера (для текущих счетов)
 * @param credits          - все CreditRecord из леджера (обязательства)
 * @param asOf             - дата/время расчёта (ISO-8601)
 * @param displayCurrencies - список валют для roll-up (напр. ["RUB", "USD", "USDT"])
 * @param fx               - провайдер исторических FX-курсов
 * @param accounts         - описания счетов (для breakdownByKind). Опционально:
 *                           при отсутствии AccountRecord для snapshot — kind = 'unknown'.
 *
 * @returns NetWorthResult — детальный результат без NaN и без исключений.
 */
export async function computeNetWorth(
	accountSnapshots: SnapshotRecord[],
	credits: CreditRecord[],
	asOf: string,
	displayCurrencies: string[],
	fx: FxProvider,
	accounts: AccountRecord[] = [],
): Promise<NetWorthResult> {
	// ── Шаг 1: выбираем последние снапшоты активов ≤ asOf ───────────────────
	const latestSnapshots = pickLatestSnapshot(accountSnapshots, asOf);

	// ── Шаг 2: выбираем последние кредиты (обязательства) ≤ asOf ───────────
	const latestCredits = pickLatestCredit(credits, asOf);

	// ── Шаг 3: строим perCurrency (активы − обязательства) ──────────────────
	const perCurrency: PerCurrencyAmount = {};

	// Суммируем активы (снапшоты).
	for (const snap of latestSnapshots.values()) {
		addToPerCurrency(perCurrency, snap.currency, snap.balance);
	}

	// Вычитаем обязательства (кредиты).
	for (const credit of latestCredits.values()) {
		// balance кредита — остаток долга (≥ 0), поэтому вычитаем.
		addToPerCurrency(perCurrency, credit.currency, -credit.balance);
	}

	// ── Шаг 4: строим breakdownByKind (только активы, не кредиты) ───────────
	//
	// Создаём быстрый маппинг account_id → AccountRecord для поиска kind.
	const accountMap = new Map<string, AccountRecord>(accounts.map((a) => [a.id, a]));

	const breakdownByKind: BreakdownByKind = {};

	for (const snap of latestSnapshots.values()) {
		// Определяем kind счёта. Если AccountRecord не передан — используем 'unknown'.
		const account = accountMap.get(snap.account_id);
		const kind = account?.kind ?? 'unknown';

		// Инициализируем запись для kind если ещё нет.
		if (!breakdownByKind[kind]) {
			breakdownByKind[kind] = {};
		}

		addToPerCurrency(breakdownByKind[kind], snap.currency, snap.balance);
	}

	// ── Шаг 5: конвертируем perCurrency в каждую displayCurrency через FX ────
	//
	// Для каждой displayCurrency:
	//   - Итерируем по парам (nativeCurrency, amount) из perCurrency.
	//   - Запрашиваем FX-курс (nativeCurrency → displayCurrency) на asOf.
	//   - При null — добавляем в unconvertible (не NaN, не 0).
	//   - При числе — конвертируем и суммируем.

	const totalsByDisplayCurrency: Record<string, number> = {};
	const unconvertible: UnconvertibleItem[] = [];

	// Собираем уникальные нативные валюты для батч-запросов.
	const nativeCurrencies = Object.keys(perCurrency);

	for (const dc of displayCurrencies) {
		let total = 0;

		for (const nativeCurrency of nativeCurrencies) {
			// Используем ?? 0 для noUncheckedIndexedAccess: мы итерируем Object.keys,
			// поэтому ключ всегда существует — undefined теоретически невозможен.
			const nativeAmount = perCurrency[nativeCurrency] ?? 0;

			// Если сумма нулевая — пропускаем конвертацию (0 в любой валюте = 0).
			// Это экономит обращения к FX и избегает false-unconvertible при нулях.
			if (nativeAmount === 0) {
				continue;
			}

			// Запрашиваем FX-курс. FxProvider.rate() НИКОГДА не бросает — только null.
			let fxRate: number | null;
			try {
				fxRate = await fx.rate(nativeCurrency, dc, asOf);
			} catch {
				// Дополнительная защита на случай нарушения инварианта провайдером.
				fxRate = null;
			}

			if (fxRate === null || !Number.isFinite(fxRate) || fxRate <= 0) {
				// Курс недоступен или некорректен — помечаем как unconvertible.
				// Инвариант: курс обязан быть строго > 0 (как в FxRateRecordSchema и ChainedFxProvider).
				// fxRate <= 0 (ноль или отрицательный) — логически невозможный курс,
				// использование его в арифметике даёт неверный знак/величину net worth.
				// Не добавляем в total — итог будет частичным, позиция видна в unconvertible.
				unconvertible.push({
					nativeCurrency,
					nativeAmount,
					targetDisplayCurrency: dc,
				});
				continue;
			}

			// Конвертируем: nativeAmount × fxRate = displayAmount.
			// Сохраняем знак (отрицательные суммы = обязательства в нативной валюте).
			total += nativeAmount * fxRate;
		}

		totalsByDisplayCurrency[dc] = total;
	}

	return {
		perCurrency,
		totalsByDisplayCurrency,
		breakdownByKind,
		unconvertible,
	};
}
