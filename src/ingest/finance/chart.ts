/**
 * chart.ts — чистые функции построения спецификаций графиков финансового модуля.
 *
 * Контекст ([ADR-0018], «финасовый модуль», «мультивалютность»):
 *   chartSpec — НЕЙТРАЛЬНАЯ к рендереру сериализуемая спека. Рендер (PNG/SVG/SVGite)
 *   живёт ОТДЕЛЬНО (workflow №2) и выбирает библиотеку сам по полю `type`.
 *
 * Принципы:
 *   1. ВСЕ функции — ЧИСТЫЕ (нет сети, нет файловой системы, нет побочных эффектов).
 *   2. Пустые/нулевые данные → ВАЛИДНАЯ placeholder-спека, НЕ throw.
 *   3. Мультивалютность: суммы в спеке остаются в нативной валюте или в той,
 *      которая уже пришла после FX-конвертации снаружи (chart.ts не фетчит FX).
 *   4. Ось времени всегда сортируется по возрастанию даты.
 *   5. Доли в pie/bar сходятся к 100% (floating-point округление допустимо).
 *
 * Поддерживаемые виды (ChartKind):
 *   - 'networth_over_time'  — линейный график чистого капитала во времени
 *   - 'balances_snapshot'   — bar/pie текущих балансов по счетам
 *   - 'expense_by_category' — pie/bar расходов по категориям
 *   - 'goal_progress'       — прогресс-бар/burndown достижения цели
 *   - 'debt_structure'      — pie структуры долгов
 */

// ---------------------------------------------------------------------------
// Типы входных данных (чистые DTO, без импорта типов леджера напрямую)
// ---------------------------------------------------------------------------

/**
 * TimePoint — точка данных на временной оси.
 * `ts` — ISO-8601 строка (сортировка по ней лексикографически).
 * `value` — значение (число, уже сконвертированное через FX если нужно).
 */
export interface TimePoint {
	/** ISO-8601 метка времени. Пример: "2026-06-01T00:00:00Z". */
	ts: string;
	/** Числовое значение (чистый капитал, баланс и т.п.) */
	value: number;
}

/**
 * BalanceEntry — баланс одного счёта для снапшота.
 * Имя счёта — без PII (synthetic label / kind+currency).
 */
export interface BalanceEntry {
	/** Идентификатор или лейбл счёта (без PII). Пример: "exchange USDT". */
	label: string;
	/** Числовой баланс в нативной (или уже сконвертированной) валюте. */
	value: number;
	/** Нативная валюта счёта. Пример: "USDT", "RUB". */
	currency: string;
}

/**
 * CategoryEntry — сумма расходов/доходов по одной категории.
 */
export interface CategoryEntry {
	/** Slug или display-название категории. Пример: "grocery", "transport". */
	category: string;
	/** Абсолютная сумма (> 0). */
	amount: number;
	/** Валюта суммы. */
	currency: string;
}

/**
 * GoalProgressData — данные о прогрессе цели.
 * Все числа уже в одной валюте (сконвертированы снаружи при необходимости).
 */
export interface GoalProgressData {
	/** Идентификатор цели. Пример: "emergency-fund-2026". */
	goal_id: string;
	/** Человекочитаемое название цели. */
	label: string;
	/** Текущий накопленный объём / текущий прогресс. */
	current: number;
	/** Целевая сумма. */
	target: number;
	/** Валюта. */
	currency: string;
	/** Целевая дата (ISO-8601). Опционально — для burndown. */
	target_date?: string;
	/** Тип цели — определяет семантику current/target для лейбла. */
	fin_kind: 'save' | 'spend_cap' | 'debt_paydown' | 'grow';
}

/**
 * DebtEntry — один элемент структуры долга.
 * Может быть CreditRecord или PayableRecord — chart.ts не различает.
 */
export interface DebtEntry {
	/** Лейбл долга (без PII). Пример: "credit-fake-001 RUB". */
	label: string;
	/** Остаток долга (> 0). */
	balance: number;
	/** Валюта долга. */
	currency: string;
	/** Годовая ставка в процентах (опц.). Пример: 21.5. */
	rate_pct?: number;
}

// ---------------------------------------------------------------------------
// Типы спецификации графика (выходные данные)
// ---------------------------------------------------------------------------

/**
 * ChartSeries — один ряд данных в графике.
 * Для line/bar — points (массив точек).
 * Для pie/прогресс-бар — единственное числовое значение (value).
 */
export type ChartSeries =
	| {
			/** Лейбл ряда (отображается в легенде). */
			label: string;
			/** Массив точек {x, y} для line/bar графиков. */
			points: Array<{ x: string; y: number }>;
			/** Валюта ряда (опц.). */
			currency?: string;
	  }
	| {
			/** Лейбл сегмента pie/значение прогресса. */
			label: string;
			/** Единственное числовое значение (для pie-сегментов, прогресс-бар). */
			value: number;
			/** Доля от 0 до 1 (для pie). Опционально — рассчитывается из value. */
			share?: number;
			/** Валюта (опц.). */
			currency?: string;
	  };

/**
 * ChartSpec — полная сериализуемая спецификация графика.
 * Нейтральна к рендереру: рендер выбирает библиотеку сам по полю `type`.
 */
export interface ChartSpec {
	/** Тип графика — подсказка рендереру. */
	type: 'line' | 'bar' | 'pie' | 'progress';
	/** Заголовок графика (человекочитаемый). */
	title: string;
	/** Ряды данных. Пустой массив допустим (placeholder). */
	series: ChartSeries[];
	/**
	 * unit — единица оси Y для line/bar (напр. "RUB", "USD", "USDT").
	 * Для pie/progress — опционально.
	 */
	unit?: string;
	/** Валюта отображения (дублирует unit для семантической ясности). */
	currency?: string;
	/** Произвольные мета-данные для рендерера (легенды, подписи осей, ...). */
	meta?: Record<string, unknown>;
}

/**
 * ChartKind — вид графика. Определяет алгоритм построения спеки.
 */
export type ChartKind =
	| 'networth_over_time'
	| 'balances_snapshot'
	| 'expense_by_category'
	| 'goal_progress'
	| 'debt_structure';

// ---------------------------------------------------------------------------
// Вспомогательные чистые функции
// ---------------------------------------------------------------------------

/**
 * sortByTs — сортирует массив TimePoint по полю `ts` (лексикографически, ASC).
 *
 * ISO-8601 строки сортируются лексикографически корректно при одном timezone.
 * Оригинальный массив НЕ мутируется (создаётся копия через spread).
 *
 * @param points — массив точек (не мутируется)
 * @returns новый отсортированный массив
 */
function sortByTs(points: TimePoint[]): TimePoint[] {
	// Spread создаёт поверхностную копию — не мутируем входной массив.
	return [...points].sort((a, b) => a.ts.localeCompare(b.ts));
}

/**
 * computeShares — для каждого значения вычисляет долю (0..1) от суммы всех значений.
 *
 * Если сумма = 0 (пустые данные), все доли = 0 (нет деления на ноль).
 *
 * @param values — числовые значения (все >= 0)
 * @returns массив долей той же длины
 */
function computeShares(values: number[]): number[] {
	const total = values.reduce((acc, v) => acc + v, 0);
	if (total === 0) {
		// Все доли нулевые — placeholder для пустого pie.
		return values.map(() => 0);
	}
	return values.map((v) => v / total);
}

/**
 * placeholderLine — создаёт пустую line-спеку с нулевым рядом.
 * Используется для пустых данных networth_over_time.
 *
 * @param title — заголовок
 * @param currency — валюта оси Y
 */
function placeholderLine(title: string, currency: string): ChartSpec {
	return {
		type: 'line',
		title,
		series: [
			{
				label: 'Чистый капитал',
				// Пустой points[] — рендерер нарисует пустую ось.
				points: [],
				currency,
			},
		],
		unit: currency,
		currency,
		meta: { empty: true, reason: 'no_data' },
	};
}

/**
 * placeholderPie — создаёт пустую pie-спеку с одним placeholder-сегментом.
 * Используется для пустых данных balances_snapshot / expense_by_category / debt_structure.
 *
 * @param title — заголовок
 */
function placeholderPie(title: string): ChartSpec {
	return {
		type: 'pie',
		title,
		series: [
			{
				label: 'Нет данных',
				value: 0,
				share: 0,
			},
		],
		meta: { empty: true, reason: 'no_data' },
	};
}

/**
 * placeholderProgress — создаёт пустую progress-спеку.
 * Используется для пустых данных goal_progress.
 *
 * @param title — заголовок
 */
function placeholderProgress(title: string): ChartSpec {
	return {
		type: 'progress',
		title,
		series: [
			{
				label: 'Прогресс',
				value: 0,
				share: 0,
			},
		],
		meta: { empty: true, reason: 'no_data' },
	};
}

// ---------------------------------------------------------------------------
// Построители спек по виду графика
// ---------------------------------------------------------------------------

/**
 * buildNetworthOverTime — строит line-спеку чистого капитала во времени.
 *
 * Входные данные должны уже быть сконвертированы в единую валюту отображения
 * (FX-конвертация — не задача chart.ts). Ось X — время (ISO), ось Y — значение.
 *
 * @param points — точки {ts, value}, МОГУТ прийти в произвольном порядке
 * @param currency — валюта отображения (для подписи оси и unit)
 * @returns ChartSpec с типом 'line'
 */
function buildNetworthOverTime(points: TimePoint[], currency: string): ChartSpec {
	if (points.length === 0) {
		// Пустые данные — валидная placeholder-спека, не throw.
		return placeholderLine('Чистый капитал', currency);
	}

	// Сортируем по времени (ASC) — ось X всегда возрастает.
	const sorted = sortByTs(points);

	// Санитизация: фильтруем точки с NaN/Infinity в value.
	// Гарантия docstring #2: «сериализуется через JSON.stringify без потерь».
	// JSON.stringify(NaN) = null — тихая порча данных на round-trip. Фильтруем заранее.
	const sanitized = sorted.filter((p) => Number.isFinite(p.value));

	if (sanitized.length === 0) {
		// Все точки были non-finite — возвращаем placeholder.
		return placeholderLine('Чистый капитал', currency);
	}

	return {
		type: 'line',
		title: 'Чистый капитал',
		series: [
			{
				label: 'Чистый капитал',
				// Преобразуем TimePoint → {x, y} для рендерера.
				points: sanitized.map((p) => ({ x: p.ts, y: p.value })),
				currency,
			},
		],
		unit: currency,
		currency,
		meta: {
			// Диапазон дат для подписи оси X.
			x_min: sanitized[0]!.ts,
			x_max: sanitized[sanitized.length - 1]!.ts,
			// Экстремумы для autoscale оси Y. Все значения конечны — Math.min/max безопасны.
			y_min: Math.min(...sanitized.map((p) => p.value)),
			y_max: Math.max(...sanitized.map((p) => p.value)),
		},
	};
}

/**
 * buildBalancesSnapshot — строит bar/pie текущих балансов счетов.
 *
 * Поддерживает мультивалютный ввод: если все записи в одной валюте —
 * ставим `currency` в спеку; если в разных — `currency` = undefined,
 * рендерер сам читает валюту из каждого series[i].currency.
 *
 * Нулевые балансы включаются (счёт существует → должен быть виден в спеке).
 *
 * @param entries — балансы счетов
 * @returns ChartSpec с типом 'bar' (основной) или 'pie' (если одна валюта)
 */
function buildBalancesSnapshot(entries: BalanceEntry[]): ChartSpec {
	if (entries.length === 0) {
		return placeholderPie('Балансы счетов');
	}

	// Определяем, одна ли валюта в данных (для выбора типа и unit).
	const currencies = [...new Set(entries.map((e) => e.currency))];
	const isSingleCurrency = currencies.length === 1;
	const sharedCurrency = isSingleCurrency ? currencies[0]! : undefined;

	// Для pie вычисляем доли (только если одна валюта — иначе несравнимо).
	const values = entries.map((e) => Math.abs(e.value));
	const shares = isSingleCurrency ? computeShares(values) : entries.map(() => 0);

	const series: ChartSeries[] = entries.map((entry, i) => ({
		label: entry.label,
		value: entry.value,
		share: shares[i],
		currency: entry.currency,
	}));

	return {
		// bar — основной тип для мультивалютного или > 5 счетов; pie — для 1 валюты / ≤5 счетов.
		type: isSingleCurrency && entries.length <= 5 ? 'pie' : 'bar',
		title: 'Балансы счетов',
		series,
		unit: sharedCurrency,
		currency: sharedCurrency,
		meta: {
			// total_abs — сумма абсолютных значений (для pie-пропорций, всегда >= 0).
			// net_total — нетто сумма со знаком (правильный финансовый итог).
			// Разделены чтобы рендерер использовал нужную семантику:
			//   pie/доли → total_abs; надпись «итого на счетах» → net_total.
			total_abs: isSingleCurrency ? values.reduce((acc, v) => acc + v, 0) : null,
			net_total: isSingleCurrency ? entries.reduce((acc, e) => acc + e.value, 0) : null,
			currencies,
		},
	};
}

/**
 * buildExpenseByCategory — строит pie/bar расходов по категориям.
 *
 * Доли в pie сходятся к 1.0 (floating-point погрешность допустима < 1e-9).
 * Категории с нулевой суммой всё равно включаются (для полноты картины).
 *
 * @param entries — расходы по категориям
 * @param currency — валюта отображения (все суммы в ней, FX снаружи)
 * @returns ChartSpec с типом 'pie'
 */
function buildExpenseByCategory(entries: CategoryEntry[], currency: string): ChartSpec {
	if (entries.length === 0) {
		return placeholderPie('Расходы по категориям');
	}

	// Используем абсолютные значения для вычисления долей pie.
	// Возвраты/рефанды могут иметь отрицательный amount — без abs получаем:
	//   доли > 1 (превышают 100%) и отрицательные (бессмысленны для pie).
	// Math.abs гарантирует корректные доли в [0, 1].
	const values = entries.map((e) => Math.abs(e.amount));
	const shares = computeShares(values);

	const series: ChartSeries[] = entries.map((entry, i) => ({
		label: entry.category,
		value: entry.amount,
		share: shares[i],
		currency: entry.currency,
	}));

	return {
		type: 'pie',
		title: 'Расходы по категориям',
		series,
		unit: currency,
		currency,
		meta: {
			// Итого для подписи в центре pie или под графиком.
			total: values.reduce((acc, v) => acc + v, 0),
		},
	};
}

/**
 * buildGoalProgress — строит progress-бар или burndown достижения финансовой цели.
 *
 * Семантика current/target зависит от fin_kind:
 *   - 'save' / 'grow'        — накоплено / нужно накопить (прогресс зажат [0,1])
 *   - 'debt_paydown'         — погашено / первоначальный долг (прогресс зажат [0,1])
 *   - 'spend_cap'            — потрачено / лимит; перерасход сигнализируется явно:
 *                              progress может быть > 1, в meta появляется over_amount.
 *
 * Для spend_cap НЕ зажимаем progress в [0,1] — иначе перерасход маскируется
 * (пользователь видит «100%, remaining 0» вместо «потрачено 150%, превышение на N»).
 * Прогресс save/grow/debt_paydown зажат в [0,1] (100% = цель достигнута).
 *
 * Если target = 0 → прогресс = 0 (нет деления на ноль).
 *
 * @param data — данные о цели
 * @returns ChartSpec с типом 'progress'
 */
function buildGoalProgress(data: GoalProgressData | null): ChartSpec {
	if (!data) {
		return placeholderProgress('Прогресс цели');
	}

	const { goal_id, label, current, target, currency, target_date, fin_kind } = data;

	// Защита от деления на ноль и некорректных значений.
	const safeCurrent = Math.max(0, current);
	const safeTarget = Math.max(0, target);

	// Прогресс: для spend_cap НЕ зажимаем вверху — нужен сигнал перерасхода.
	// Для остальных типов зажимаем в [0, 1] (100% = полное выполнение).
	const rawProgress = safeTarget > 0 ? safeCurrent / safeTarget : 0;
	const progress = fin_kind === 'spend_cap' ? rawProgress : Math.min(1, rawProgress);

	// Перерасход spend_cap: сумма сверх лимита.
	const overAmount = fin_kind === 'spend_cap' ? Math.max(0, safeCurrent - safeTarget) : 0;
	const isOverspent = overAmount > 0;

	// Лейбл прогресса зависит от типа цели.
	const progressLabel =
		fin_kind === 'spend_cap'
			? isOverspent
				? `Перерасход: ${safeCurrent} / ${safeTarget} ${currency} (превышение: +${overAmount})`
				: `Потрачено: ${safeCurrent} / ${safeTarget} ${currency}`
			: fin_kind === 'debt_paydown'
				? `Погашено: ${safeCurrent} / ${safeTarget} ${currency}`
				: `Накоплено: ${safeCurrent} / ${safeTarget} ${currency}`;

	return {
		type: 'progress',
		title: `Прогресс: ${label}`,
		series: [
			{
				label: progressLabel,
				value: progress,
				share: Math.min(1, progress), // share для pie всегда в [0,1]
				currency,
			},
		],
		currency,
		meta: {
			goal_id,
			fin_kind,
			current: safeCurrent,
			target: safeTarget,
			// Процент выполнения (0–100+) — для spend_cap может быть > 100 при перерасходе.
			pct: Math.round(progress * 100),
			// Остаток до цели (для spend_cap — оставшийся лимит; 0 при перерасходе).
			remaining: Math.max(0, safeTarget - safeCurrent),
			// Для spend_cap: явный сигнал перерасхода.
			...(fin_kind === 'spend_cap' && isOverspent ? { over_amount: overAmount } : {}),
			...(target_date ? { target_date } : {}),
		},
	};
}

/**
 * buildDebtStructure — строит pie структуры долгов.
 *
 * Долги могут быть в разных валютах (мультивалютность). Если все в одной —
 * вычисляем доли. Если в разных — доли = 0 (несравнимы без FX).
 *
 * Нулевые остатки долга (закрытые кредиты) не включаются в спеку —
 * они не формируют «структуру долга».
 *
 * @param entries — список долгов (balance > 0)
 * @returns ChartSpec с типом 'pie'
 */
function buildDebtStructure(entries: DebtEntry[]): ChartSpec {
	if (entries.length === 0) {
		return placeholderPie('Структура долгов');
	}

	// Фильтруем нулевые остатки — закрытые долги не входят в pie.
	const active = entries.filter((e) => e.balance > 0);
	if (active.length === 0) {
		return placeholderPie('Структура долгов');
	}

	// Определяем мультивалютность.
	const currencies = [...new Set(active.map((e) => e.currency))];
	const isSingleCurrency = currencies.length === 1;
	const sharedCurrency = isSingleCurrency ? currencies[0]! : undefined;

	const values = active.map((e) => e.balance);
	const shares = isSingleCurrency ? computeShares(values) : active.map(() => 0);

	const series: ChartSeries[] = active.map((entry, i) => ({
		label: entry.label,
		value: entry.balance,
		share: shares[i],
		currency: entry.currency,
	}));

	// Итоговая сумма долга (только для одной валюты).
	const total = isSingleCurrency ? values.reduce((acc, v) => acc + v, 0) : null;

	// Средневзвешенная ставка (если есть данные о ставках, только для одной валюты).
	let avgRate: number | null = null;
	if (isSingleCurrency && active.every((e) => e.rate_pct !== undefined)) {
		const totalDebt = values.reduce((acc, v) => acc + v, 0);
		if (totalDebt > 0) {
			avgRate = active.reduce((acc, e, i) => acc + (e.rate_pct ?? 0) * values[i]! / totalDebt, 0);
		}
	}

	return {
		type: 'pie',
		title: 'Структура долгов',
		series,
		unit: sharedCurrency,
		currency: sharedCurrency,
		meta: {
			total,
			currencies,
			...(avgRate !== null ? { avg_rate_pct: Math.round(avgRate * 100) / 100 } : {}),
		},
	};
}

// ---------------------------------------------------------------------------
// Главная точка входа — chartSpec
// ---------------------------------------------------------------------------

/**
 * Объединённый тип входных данных для chartSpec (дискриминация по kind).
 */
export type ChartInput =
	| { kind: 'networth_over_time'; points: TimePoint[]; currency: string }
	| { kind: 'balances_snapshot'; entries: BalanceEntry[] }
	| { kind: 'expense_by_category'; entries: CategoryEntry[]; currency: string }
	| { kind: 'goal_progress'; data: GoalProgressData | null }
	| { kind: 'debt_structure'; entries: DebtEntry[] };

/**
 * chartSpec — ЧИСТАЯ функция, строит сериализуемую спецификацию графика.
 *
 * Гарантии:
 *   1. Никогда не бросает исключение (в том числе при пустых данных).
 *   2. Возвращаемый объект сериализуется через JSON.stringify без потерь.
 *   3. Детерминирован: одни и те же входные данные → одна и та же спека.
 *   4. Не делает сетевых запросов, не читает файлы, не зависит от времени.
 *
 * @param input — дискриминированный union с kind и данными
 * @returns ChartSpec — сериализуемая спека, нейтральная к рендереру
 *
 * @example
 * // Линейный график чистого капитала
 * const spec = chartSpec({
 *   kind: 'networth_over_time',
 *   points: [
 *     { ts: '2026-01-01T00:00:00Z', value: 100000 },
 *     { ts: '2026-06-01T00:00:00Z', value: 120000 },
 *   ],
 *   currency: 'RUB',
 * });
 * // spec.type === 'line'
 * // spec.series[0].points.length === 2
 */
export function chartSpec(input: ChartInput): ChartSpec {
	switch (input.kind) {
		case 'networth_over_time':
			// Исторические данные уже сконвертированы через FX снаружи — chart.ts не фетчит.
			return buildNetworthOverTime(input.points, input.currency);

		case 'balances_snapshot':
			// Мультивалютный ввод допустим — обработка внутри buildBalancesSnapshot.
			return buildBalancesSnapshot(input.entries);

		case 'expense_by_category':
			// Все суммы уже в одной currency (конвертировал вызывающий код).
			return buildExpenseByCategory(input.entries, input.currency);

		case 'goal_progress':
			// data может быть null — buildGoalProgress вернёт placeholder.
			return buildGoalProgress(input.data);

		case 'debt_structure':
			// Мультивалютный ввод допустим.
			return buildDebtStructure(input.entries);
	}
}
