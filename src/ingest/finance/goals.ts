/**
 * goals.ts — компаратор целей и расчётный математический движок.
 *
 * Контекст ([ADR-0018] финансовый модуль):
 *   Цели (FinanceGoal) — страницы вики в ~/llm-wiki-content/wiki/finance/goals/,
 *   они НЕ хранятся в JSONL-леджере. Прогресс считается по снапшотам счетов
 *   из SnapshotRecord и/или транзакциям с goal_tag.
 *
 * ПРИНЦИПЫ:
 *   - ВСЕ функции — ЧИСТЫЕ (детерминированные). Никаких сайд-эффектов.
 *   - Мультивалютность: суммы в нативных валютах, конвертация — через FxProvider.
 *   - FxProvider.rate() НИКОГДА не бросает (возвращает null при недоступности).
 *     Движок обрабатывает null грациозно — частичный результат с флагом.
 *   - Нет «базовой валюты»: каждая цель имеет СВОЮ целевую валюту.
 *   - Cold-start: мало истории (< MIN_HISTORY_MONTHS) → coarse:true.
 *
 * ЭКСПОРТИРУЕМЫЕ ТИПЫ:
 *   GoalProgress, MonthlyPlan, IncomePlan, DiscretionaryBudget,
 *   FeasibilityResult, WhatIfScenario, WhatIfResult,
 *   GoalConflictResult, MultiGoalPlan
 *
 * ЭКСПОРТИРУЕМЫЕ ФУНКЦИИ:
 *   computeGoalProgress, requiredMonthly, requiredIncome,
 *   discretionary, feasibility, whatIf, checkGoalConflict
 */

import type { FxProvider } from './fx.js';
import type { FinanceGoal, SnapshotRecord } from './types.js';

// ---------------------------------------------------------------------------
// Константы
// ---------------------------------------------------------------------------

/**
 * MIN_HISTORY_MONTHS — минимальное число месяцев истории снапшотов
 * для «уверенной» (не грубой) оценки прогресса.
 * Меньше — ставим coarse:true.
 */
const MIN_HISTORY_MONTHS = 2;

// ---------------------------------------------------------------------------
// Типы результатов
// ---------------------------------------------------------------------------

/**
 * GoalProgress — результат расчёта прогресса по одной цели.
 *
 * Поля:
 *   current  — текущая сумма в валюте цели (может быть частичной если
 *              не удалось сконвертировать все счета)
 *   target   — целевая сумма (из FinanceGoal.target_amount)
 *   pct      — процент выполнения (0..100+, может превышать 100 если цель перевыполнена)
 *   currency — валюта, в которой выражены current и target (= FinanceGoal.currency)
 *   coarse   — true если оценка грубая: мало истории или некоторые курсы недоступны
 *   missing_fx — список валютных пар, для которых курс не найден (причина grubости)
 */
export interface GoalProgress {
	current: number;
	target: number;
	pct: number;
	currency: string;
	coarse: boolean;
	missing_fx: string[]; // пары вида "USD/RUB", для которых курс недоступен
}

/**
 * MonthlyPlan — результат requiredMonthly.
 *
 * required     — сколько откладывать/платить в месяц
 * mode         — 'linear' | 'annuity' — какой алгоритм использован
 * monthsLeft   — защищено: если ≤ 0, возвращается Infinity или safe-значение
 */
export interface MonthlyPlan {
	required: number;
	mode: 'linear' | 'annuity';
	monthsLeft: number;
}

/**
 * IncomePlan — результат requiredIncome.
 *
 * grossRequired — требуемый ВАЛОВЫЙ доход (до налогов/удержаний)
 * netRequired   — требуемый чистый доход (если применён коэффициент)
 * currentIncome — текущий доход (передаётся в функцию)
 * gap           — разрыв: grossRequired − currentIncome (отрицательный = избыток)
 */
export interface IncomePlan {
	grossRequired: number;
	netRequired: number;
	currentIncome: number;
	gap: number;
}

/**
 * DiscretionaryBudget — результат discretionary.
 *
 * available      — сколько осталось на дискреционные расходы в этом месяце
 * dailyLimit     — дневной лимит (available / daysRemaining)
 *                  Infinity если daysRemaining ≤ 0 (дни кончились, деление защищено)
 */
export interface DiscretionaryBudget {
	available: number;
	dailyLimit: number;
}

/**
 * FeasibilityResult — результат feasibility.
 *
 * feasible       — true если Σ requiredMonthly ≤ avgMonthlySavings
 * shortfall      — нехватка в месяц (0 если feasible)
 * newTargetDate  — реалистичная дата при текущих сбережениях (если !feasible)
 *                  ISO-8601 строка. undefined если feasible или remaining = 0.
 */
export interface FeasibilityResult {
	feasible: boolean;
	shortfall: number;
	newTargetDate?: string;
}

/**
 * WhatIfScenario — входные параметры сценария «что если».
 *
 * Все поля опциональны: указывать только то, что меняется.
 *   deltaIncome      — изменение ежемесячного дохода (+ или −)
 *   deltaExpense     — изменение ежемесячных расходов (+ или −)
 *   oneTimeDeposit   — разовый взнос (прибавляется к текущей сумме немедленно)
 */
export interface WhatIfScenario {
	deltaIncome?: number;
	deltaExpense?: number;
	oneTimeDeposit?: number;
}

/**
 * WhatIfResult — результат пересчёта при изменении сценария.
 *
 * newMonthlySavings — новые ежемесячные сбережения
 * newMonthsToGoal   — сколько месяцев до цели при новом сценарии
 *                     (Infinity если сбережения ≤ 0 и нет разового взноса)
 * newTargetDate     — ориентировочная дата достижения цели (ISO-8601)
 */
export interface WhatIfResult {
	newMonthlySavings: number;
	newMonthsToGoal: number;
	newTargetDate: string;
}

/**
 * GoalConflictResult — результат проверки совместимости нескольких целей.
 *
 * compatible         — true если Σ requiredMonthly ≤ availableSavings
 * totalRequired      — суммарно требуется в месяц
 * availableSavings   — доступно сбережений (параметр)
 * shortfall          — нехватка (0 если compatible)
 * conflictingGoals   — список id целей, которые создают конфликт
 *                      (цели с наибольшими требованиями, превышающие бюджет)
 */
export interface GoalConflictResult {
	compatible: boolean;
	totalRequired: number;
	availableSavings: number;
	shortfall: number;
	conflictingGoals: string[]; // id целей
}

/**
 * GoalWithRequired — цель вместе с её расчётным ежемесячным требованием.
 * Используется в checkGoalConflict и MultiGoalPlan.
 */
export interface GoalWithRequired {
	goal: FinanceGoal;
	requiredMonthlyAmount: number; // уже посчитан requiredMonthly(...)
}

/**
 * MultiGoalPlan — агрегированный план по всем целям.
 *
 * goals            — список целей с их индивидуальными требованиями
 * conflict         — результат проверки совместимости
 * feasibility      — общая реализуемость при текущих сбережениях
 */
export interface MultiGoalPlan {
	goals: GoalWithRequired[];
	conflict: GoalConflictResult;
	feasibilityByGoal: FeasibilityResult[];
}

// ---------------------------------------------------------------------------
// 1. computeGoalProgress
// ---------------------------------------------------------------------------

/**
 * computeGoalProgress — прогресс по одной цели на основе снапшотов леджера.
 *
 * Алгоритм:
 *   1. Фильтруем снапшоты по linked_accounts цели (если указаны).
 *      Если linked_accounts не заданы — берём ВСЕ снапшоты (режим «goal_tag»:
 *      в этом режиме caller должен передать уже отфильтрованные снапшоты).
 *   2. Для каждого счёта берём ПОСЛЕДНИЙ снапшот (по ts) как текущий баланс.
 *   3. Конвертируем каждый баланс в валюту цели через исторический FX на asOf.
 *   4. Суммируем. Если какой-то курс недоступен — отмечаем missing_fx и coarse:true.
 *   5. Считаем pct = current / target * 100.
 *
 * Graceful degradation: недоступный курс пропускается (не прибавляется к current),
 * но функция НЕ бросает исключение. Caller видит partial sum + coarse:true.
 *
 * Cold-start: если снапшотов по разным месяцам < MIN_HISTORY_MONTHS → coarse:true.
 *
 * @param goal      — цель из вики-фронтматтера
 * @param snapshots — все SnapshotRecord (или уже отфильтрованные по goal_tag)
 * @param fx        — провайдер курсов (мок или реальный)
 * @param asOf      — момент расчёта (ISO-8601); исторический FX берётся на эту дату
 */
export async function computeGoalProgress(
	goal: FinanceGoal,
	snapshots: SnapshotRecord[],
	fx: FxProvider,
	asOf: string,
): Promise<GoalProgress> {
	// Фильтр: если у цели указаны linked_accounts — берём только их снапшоты.
	// Иначе работаем с тем, что передал caller (они уже отфильтрованы по goal_tag).
	const relevantSnapshots =
		goal.linked_accounts && goal.linked_accounts.length > 0
			? snapshots.filter((s) => goal.linked_accounts!.includes(s.account_id))
			: snapshots;

	// Группируем снапшоты по account_id, берём последний по ts (лексикографический max).
	const latestByAccount = new Map<string, SnapshotRecord>();
	for (const snap of relevantSnapshots) {
		const existing = latestByAccount.get(snap.account_id);
		// Сравниваем ISO-строки лексикографически (UTC timestamps корректно сортируются так).
		if (!existing || snap.ts > existing.ts) {
			latestByAccount.set(snap.account_id, snap);
		}
	}

	// Считаем количество уникальных месяцев для cold-start детектора.
	// Месяц определяется как первые 7 символов ISO ts: "YYYY-MM".
	const uniqueMonths = new Set<string>();
	for (const snap of relevantSnapshots) {
		// Защита: ts минимум "YYYY-MM" = 7 символов.
		if (snap.ts.length >= 7) {
			uniqueMonths.add(snap.ts.slice(0, 7));
		}
	}
	const isColdStart = uniqueMonths.size < MIN_HISTORY_MONTHS;

	// Конвертируем балансы в валюту цели и суммируем.
	let current = 0;
	const missingFx: string[] = [];

	for (const snap of latestByAccount.values()) {
		if (snap.currency === goal.currency) {
			// Нет конвертации — напрямую.
			current += snap.balance;
		} else {
			// Конвертируем через исторический FX на asOf.
			const rate = await fx.rate(snap.currency, goal.currency, asOf);
			if (rate === null) {
				// Курс недоступен — пропускаем этот счёт, помечаем недостающую пару.
				const pair = `${snap.currency}/${goal.currency}`;
				if (!missingFx.includes(pair)) {
					missingFx.push(pair);
				}
			} else {
				current += snap.balance * rate;
			}
		}
	}

	// pct — процент выполнения цели. Защита от деления на 0.
	const pct = goal.target_amount > 0 ? (current / goal.target_amount) * 100 : 0;

	return {
		current,
		target: goal.target_amount,
		pct,
		currency: goal.currency,
		// coarse если: cold-start ИЛИ были недоступные курсы
		coarse: isColdStart || missingFx.length > 0,
		missing_fx: missingFx,
	};
}

// ---------------------------------------------------------------------------
// 2. requiredMonthly
// ---------------------------------------------------------------------------

/**
 * requiredMonthly — сколько нужно откладывать/погашать в месяц.
 *
 * Два режима:
 *   1. LINEAR (ratePerMonth отсутствует или = 0):
 *      required = remaining / monthsLeft
 *
 *   2. ANNUITY (ratePerMonth > 0):
 *      Формула будущей стоимости аннуитета (PMT):
 *        required = remaining * r / ((1+r)^n − 1)
 *      где r = ratePerMonth (в долях, 0.005 = 0.5%/мес),
 *          n = monthsLeft.
 *
 *      Пояснение формулы: мы хотим набрать сумму `remaining` за n месяцев
 *      при ежемесячном реинвестировании по ставке r. Это стандартная PMT
 *      для накоплений (sinking fund payment).
 *
 * Защита от monthsLeft ≤ 0:
 *   Возвращаем { required: Infinity, mode, monthsLeft: 0 } — явный сигнал
 *   что цель уже должна была быть достигнута (нельзя платить бесконечно).
 *
 * @param remaining    — оставшаяся сумма до цели (> 0)
 * @param monthsLeft   — оставшихся месяцев (> 0 для финитного результата)
 * @param ratePerMonth — доходность в месяц в долях (напр. 0.005 = 0.5%/мес)
 *                       undefined или 0 → линейный режим
 */
export function requiredMonthly(
	remaining: number,
	monthsLeft: number,
	ratePerMonth?: number,
): MonthlyPlan {
	// Защита: нельзя делить на 0 или отрицательные месяцы.
	if (monthsLeft <= 0) {
		return {
			required: Infinity,
			mode: ratePerMonth && ratePerMonth > 0 ? 'annuity' : 'linear',
			monthsLeft: 0,
		};
	}

	// Если ставка не указана или нулевая — линейный режим.
	if (!ratePerMonth || ratePerMonth === 0) {
		return {
			required: remaining / monthsLeft,
			mode: 'linear',
			monthsLeft,
		};
	}

	// Аннуитетный режим: PMT формула для sinking fund.
	// required = remaining * r / ((1+r)^n − 1)
	const r = ratePerMonth;
	const n = monthsLeft;
	const denominator = Math.pow(1 + r, n) - 1;

	// Защита от числовой нестабильности при очень малом r или n.
	if (denominator === 0 || !Number.isFinite(denominator)) {
		// Вырожденный случай — fallback к линейному.
		return {
			required: remaining / monthsLeft,
			mode: 'linear',
			monthsLeft,
		};
	}

	return {
		required: (remaining * r) / denominator,
		mode: 'annuity',
		monthsLeft,
	};
}

// ---------------------------------------------------------------------------
// 3. requiredIncome
// ---------------------------------------------------------------------------

/**
 * requiredIncome — сколько нужно зарабатывать (валовый доход) для покрытия
 * всех фиксированных расходов, целевых откладываний и буфера.
 *
 * Формула:
 *   netRequired = fixedExpenses + sumRequiredMonthly + buffer
 *   grossRequired = netRequired / taxCoefficient
 *                   (коэффициент < 1 учитывает налоги/вычеты)
 *   gap = grossRequired − currentIncome
 *
 * ВАЖНО: систематическая ошибка «grossовый/чистый».
 *   Если указать только чистый доход (без taxCoefficient), расчёт занижает
 *   реальную потребность — человек получает меньше «на руки» чем нужно.
 *   taxCoefficient = net/gross. Например, НДФЛ 13%: taxCoefficient ≈ 0.87.
 *   Если не указан — принимаем 1 (нет налогов/корректировки).
 *
 * @param fixedExpenses      — фиксированные ежемесячные расходы (аренда, ЖКХ, кредиты)
 * @param sumRequiredMonthly — суммарный ежемесячный взнос по всем целям (Σ requiredMonthly)
 * @param buffer             — буфер безопасности (напр. 10% от дохода или фиксированная сумма)
 * @param opts.currentIncome — текущий доход для расчёта gap (опц., дефолт 0)
 * @param opts.taxCoefficient — доля чистого в валовом (net/gross), 0 < k ≤ 1, дефолт 1
 */
export function requiredIncome(
	fixedExpenses: number,
	sumRequiredMonthly: number,
	buffer: number,
	opts: {
		currentIncome?: number;
		taxCoefficient?: number;
	} = {},
): IncomePlan {
	const currentIncome = opts.currentIncome ?? 0;
	// Защита: taxCoefficient должен быть в (0, 1]. При нулевом или отрицательном — игнорируем.
	const taxCoef =
		opts.taxCoefficient && opts.taxCoefficient > 0 && opts.taxCoefficient <= 1
			? opts.taxCoefficient
			: 1;

	// Требуемый ЧИСТЫЙ доход (то, что нужно получать «на руки» или иметь доступным).
	const netRequired = fixedExpenses + sumRequiredMonthly + buffer;

	// Требуемый ВАЛОВЫЙ доход (до налогов).
	const grossRequired = netRequired / taxCoef;

	// gap: сколько не хватает (или сколько лишнего) относительно текущего дохода.
	// Отрицательный gap = текущий доход уже покрывает потребность.
	const gap = grossRequired - currentIncome;

	return {
		grossRequired,
		netRequired,
		currentIncome,
		gap,
	};
}

// ---------------------------------------------------------------------------
// 4. discretionary
// ---------------------------------------------------------------------------

/**
 * discretionary — сколько осталось на дискреционные расходы в текущем месяце.
 *
 * Алгоритм:
 *   available = income − sumRequiredMonthly − obligatoryPayments − spent
 *   dailyLimit = available / daysRemaining
 *
 * Защита:
 *   - daysRemaining ≤ 0: dailyLimit = 0 (дни месяца кончились, нет смысла лимитировать)
 *   - available < 0: бюджет уже превышен; dailyLimit = 0
 *
 * @param income               — доход за месяц (чистый или валовый — единый выбор caller'а)
 * @param sumRequiredMonthly   — суммарный взнос по целям
 * @param obligatoryPayments   — обязательные платежи (кредиты, аренда и т.п.)
 * @param opts.spent           — уже потрачено на дискреционные расходы в этом месяце
 * @param opts.daysRemaining   — дней до конца месяца (опц., дефолт 1)
 */
export function discretionary(
	income: number,
	sumRequiredMonthly: number,
	obligatoryPayments: number,
	opts: {
		spent?: number;
		daysRemaining?: number;
	} = {},
): DiscretionaryBudget {
	const spent = opts.spent ?? 0;
	const daysRemaining = opts.daysRemaining ?? 1;

	// Доступно для дискреционных расходов всего в месяц (до вычета уже потраченного).
	const availableRaw = income - sumRequiredMonthly - obligatoryPayments;

	// Оставшийся лимит = всего − уже потрачено.
	const available = availableRaw - spent;

	// Дневной лимит: защита от daysRemaining ≤ 0 и отрицательного available.
	let dailyLimit: number;
	if (daysRemaining <= 0 || available <= 0) {
		dailyLimit = 0;
	} else {
		dailyLimit = available / daysRemaining;
	}

	return { available, dailyLimit };
}

// ---------------------------------------------------------------------------
// 5. feasibility
// ---------------------------------------------------------------------------

/**
 * feasibility — реализуема ли цель при текущем темпе сбережений?
 *
 * Сравнивает суммарный требуемый ежемесячный взнос (sumRequiredMonthly) с
 * историческим средним ежемесячным сбережением (avgMonthlySavings).
 *
 * Если feasible:
 *   shortfall = 0, newTargetDate = undefined.
 *
 * Если !feasible:
 *   shortfall = sumRequiredMonthly − avgMonthlySavings
 *   newTargetDate = ориентировочная дата при текущем темпе.
 *     Формула: n = ceil(remaining / avgMonthlySavings)
 *     дата = nowTs + n месяцев.
 *     Если avgMonthlySavings ≤ 0 — цель недостижима: newTargetDate = undefined.
 *
 * @param avgMonthlySavings  — среднее сбережение в месяц за историю
 * @param sumRequiredMonthly — суммарный ежемесячный взнос по всем целям
 * @param opts.remaining     — оставшаяся сумма до цели (для расчёта newTargetDate)
 * @param opts.nowTs         — текущая дата (ISO-8601, для расчёта newTargetDate)
 */
export function feasibility(
	avgMonthlySavings: number,
	sumRequiredMonthly: number,
	opts: {
		remaining?: number;
		nowTs?: string;
	} = {},
): FeasibilityResult {
	const feasible = avgMonthlySavings >= sumRequiredMonthly;

	if (feasible) {
		return { feasible: true, shortfall: 0 };
	}

	const shortfall = sumRequiredMonthly - avgMonthlySavings;

	// Рассчитываем реалистичную дату если переданы remaining и nowTs.
	if (
		opts.remaining !== undefined &&
		opts.remaining > 0 &&
		opts.nowTs &&
		avgMonthlySavings > 0
	) {
		const monthsNeeded = Math.ceil(opts.remaining / avgMonthlySavings);
		const newDate = addMonthsToIso(opts.nowTs, monthsNeeded);
		return { feasible: false, shortfall, newTargetDate: newDate };
	}

	return { feasible: false, shortfall };
}

// ---------------------------------------------------------------------------
// 6. whatIf
// ---------------------------------------------------------------------------

/**
 * whatIf — пересчёт сроков и сбережений при изменении условий.
 *
 * Сценарий может включать:
 *   - deltaIncome: изменение ежемесячного дохода (+/-). Увеличивает/уменьшает сбережения.
 *   - deltaExpense: изменение ежемесячных расходов (+/-). Уменьшает/увеличивает сбережения.
 *   - oneTimeDeposit: разовый взнос, немедленно уменьшающий оставшуюся сумму.
 *
 * @param scenario            — изменения в сценарии
 * @param currentMonthlySavings — текущие ежемесячные сбережения
 * @param remaining           — оставшаяся сумма до цели (до разового взноса)
 * @param nowTs               — текущая дата (ISO-8601)
 */
export function whatIf(
	scenario: WhatIfScenario,
	currentMonthlySavings: number,
	remaining: number,
	nowTs: string,
): WhatIfResult {
	// Новые ежемесячные сбережения после изменений.
	const deltaIncome = scenario.deltaIncome ?? 0;
	const deltaExpense = scenario.deltaExpense ?? 0;
	const oneTimeDeposit = scenario.oneTimeDeposit ?? 0;

	// Доходы растут → сбережения растут; расходы растут → сбережения падают.
	const newMonthlySavings = currentMonthlySavings + deltaIncome - deltaExpense;

	// Оставшаяся сумма уменьшается на разовый взнос.
	const newRemaining = Math.max(0, remaining - oneTimeDeposit);

	// Сколько месяцев до цели при новом сценарии.
	let newMonthsToGoal: number;
	if (newRemaining <= 0) {
		// Цель уже достигнута разовым взносом.
		newMonthsToGoal = 0;
	} else if (newMonthlySavings <= 0) {
		// Сбережения нулевые или отрицательные — цель недостижима.
		newMonthsToGoal = Infinity;
	} else {
		newMonthsToGoal = Math.ceil(newRemaining / newMonthlySavings);
	}

	const newTargetDate =
		Number.isFinite(newMonthsToGoal)
			? addMonthsToIso(nowTs, newMonthsToGoal)
			: addMonthsToIso(nowTs, 9999); // Символически далёкая дата при Infinity

	return {
		newMonthlySavings,
		newMonthsToGoal,
		newTargetDate,
	};
}

// ---------------------------------------------------------------------------
// 7. checkGoalConflict
// ---------------------------------------------------------------------------

/**
 * checkGoalConflict — проверяет совместимость нескольких целей при доступных сбережениях.
 *
 * Алгоритм:
 *   1. Сортируем цели по приоритету (меньше = важнее, undefined → конец списка).
 *   2. Суммируем requiredMonthly по всем целям.
 *   3. Если Σ ≤ availableSavings → compatible:true.
 *   4. Если Σ > availableSavings → compatible:false.
 *      conflictingGoals = цели «снизу» по приоритету, которые выбиваются за бюджет.
 *
 * Пример конфликта: есть 50 000 ₽/мес, цели требуют 60 000 ₽ — нехватка 10 000.
 * Конфликтующие цели — те с наименьшим приоритетом (последние в очереди).
 *
 * @param goalsWithRequired — список целей с их расчётными ежемесячными требованиями
 * @param availableSavings  — сколько денег доступно для откладывания в месяц
 */
export function checkGoalConflict(
	goalsWithRequired: GoalWithRequired[],
	availableSavings: number,
): GoalConflictResult {
	// Суммируем общие требования.
	const totalRequired = goalsWithRequired.reduce((sum, g) => sum + g.requiredMonthlyAmount, 0);
	const shortfall = Math.max(0, totalRequired - availableSavings);
	const compatible = shortfall === 0;

	if (compatible) {
		return {
			compatible: true,
			totalRequired,
			availableSavings,
			shortfall: 0,
			conflictingGoals: [],
		};
	}

	// Определяем конфликтующие цели: сортируем по приоритету (меньше = выше приоритет),
	// затем «срезаем» снизу — цели с наименьшим приоритетом до тех пор, пока нехватка
	// не будет объяснена.
	const sorted = [...goalsWithRequired].sort((a, b) => {
		const pa = a.goal.priority ?? Number.MAX_SAFE_INTEGER;
		const pb = b.goal.priority ?? Number.MAX_SAFE_INTEGER;
		return pa - pb; // ascending: низкий номер = высокий приоритет
	});

	// Идём с конца (наименее приоритетные) и собираем конфликтующие.
	const conflictingGoals: string[] = [];
	let accumulated = 0;
	for (let i = sorted.length - 1; i >= 0; i--) {
		const item = sorted[i];
		if (!item) continue;
		accumulated += item.requiredMonthlyAmount;
		conflictingGoals.push(item.goal.id);
		if (accumulated >= shortfall) break;
	}

	return {
		compatible: false,
		totalRequired,
		availableSavings,
		shortfall,
		conflictingGoals,
	};
}

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

/**
 * addMonthsToIso — добавляет n месяцев к ISO-8601 дате.
 *
 * Работает через Date объект — не требует внешних зависимостей.
 * Обрабатывает корректно переходы через год (например, декабрь + 1 = январь следующего года).
 *
 * @param isoTs — ISO-8601 дата (YYYY-MM-DD или полный timestamp)
 * @param months — число месяцев (целое, >= 0)
 * @returns ISO-8601 строка без времени: "YYYY-MM-DD"
 */
function addMonthsToIso(isoTs: string, months: number): string {
	// Берём только дату (первые 10 символов) для избежания timezone-артефактов.
	const datePart = isoTs.length >= 10 ? isoTs.slice(0, 10) : isoTs;

	// Парсим как UTC полночь чтобы избежать смещения дня из-за timezone.
	const d = new Date(`${datePart}T00:00:00Z`);

	// Если дата невалидна — возвращаем пустую строку (graceful).
	if (isNaN(d.getTime())) return '';

	// Добавляем месяцы: setUTCMonth обрабатывает overflow автоматически.
	d.setUTCMonth(d.getUTCMonth() + months);

	// Форматируем обратно в YYYY-MM-DD.
	const yyyy = d.getUTCFullYear();
	const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
	const dd = String(d.getUTCDate()).padStart(2, '0');

	return `${yyyy}-${mm}-${dd}`;
}
