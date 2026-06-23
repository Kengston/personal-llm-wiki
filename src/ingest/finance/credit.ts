/**
 * credit.ts — Чистые функции амортизации и детекта платежей по кредитам.
 *
 * Контекст ([ADR-0018], финмодуль):
 *   - Кредиты хранятся как CreditRecord в леджере (credits.jsonl).
 *   - Этот модуль предоставляет ТОЛЬКО чистые функции — никакого IO, никакой сети.
 *   - LLM-слой и Telegram-слой используют эти функции как строительные блоки
 *     для ответов пользователю и проактивных напоминаний (Phase 2).
 *
 * Поддерживаемые типы кредитов:
 *   - 'annuity'       — аннуитетный: равные платежи каждый месяц, разное соотношение
 *                       тело/проценты (классическая ипотека/авто-кредит).
 *   - 'differentiated'— дифференцированный: тело делится поровну, проценты убывают
 *                       (платёж первого месяца максимальный, последнего — минимальный).
 *
 * Все суммы в НАТИВНОЙ валюте кредита. Конвертация — на стороне вызывающего кода.
 *
 * Точность: float64 достаточна для личных финансов (см. types.ts комментарий).
 * Алгоритмы работают через monthlyRate = rate_pct / 12 / 100.
 *
 * Защита от edge-cases:
 *   - rate_pct = 0 → линейное погашение без процентов.
 *   - term = 1 → один платёж, закрывает весь долг.
 *   - balance = 0 → кредит уже погашен, платежей нет.
 *   - Досрочный/частичный платёж: splitPayment корректно считает остаток.
 */

import type { CreditRecord } from './types.js';

// ---------------------------------------------------------------------------
// Типы результатов
// ---------------------------------------------------------------------------

/**
 * PaymentDue — описание одного предстоящего планового платежа.
 *
 * Возвращается из creditPaymentsDue() для каждого кредита, чей следующий
 * платёж попадает в окно [now, now + windowDays].
 *
 * `balanceAfter` — остаток долга ПОСЛЕ этого платежа (не текущий баланс).
 * Показывается пользователю как «после оплаты останется N ₽».
 */
export interface PaymentDue {
	/** ID кредита из CreditRecord.id */
	credit_id: string;
	/** Сумма планового платежа (в нативной валюте кредита) */
	amount: number;
	/** account_id счёта списания — не храним в CreditRecord, поэтому undefined если не задан */
	account: string | undefined;
	/** Ожидаемая дата платежа (ISO-8601) */
	dueDate: string;
	/** Остаток долга после этого платежа */
	balanceAfter: number;
}

/**
 * SplitPaymentResult — разбивка платежа на тело долга и проценты.
 *
 * Инвариант: principal + interest ≈ paymentAmount (≤ balance при нехватке).
 * `newBalance` — новый остаток долга после платежа.
 */
export interface SplitPaymentResult {
	/** Часть платежа, идущая в погашение тела долга */
	principal: number;
	/** Часть платежа, идущая в оплату процентов */
	interest: number;
	/** Новый остаток долга после платежа */
	newBalance: number;
}

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

/**
 * monthlyRateFromAnnual — переводит годовую ставку в месячную.
 *
 * Формула: r_month = rate_pct / 100 / 12
 * Для rate_pct = 0 возвращает 0 (нет процентов).
 *
 * @param rate_pct — годовая ставка в процентах (напр. 21.5)
 * @returns месячная ставка как доля (напр. 0.01791...)
 */
export function monthlyRateFromAnnual(rate_pct: number): number {
	// Деление на 100 переводит проценты в доли, деление на 12 — год в месяц.
	return rate_pct / 100 / 12;
}

/**
 * annuityPayment — вычисляет фиксированный ежемесячный аннуитетный платёж.
 *
 * Формула: PMT = principal * r / (1 - (1 + r)^(-term))
 * где r = monthlyRate.
 *
 * При r = 0 (нулевая ставка): PMT = principal / term (линейное деление).
 *
 * Эта функция вычисляет ИЗНАЧАЛЬНЫЙ платёж по начальному principal, а не
 * по текущему balance. Если balance отличается от principal (кредит частично
 * погашен), используй annuityPaymentFromBalance().
 *
 * @param principal   — начальная сумма кредита
 * @param ratePerMonth — месячная ставка (0.01791 = 21,5%/12/100)
 * @param term         — срок в месяцах
 * @returns ежемесячный платёж
 */
export function annuityPayment(principal: number, ratePerMonth: number, term: number): number {
	// Edge-case: нулевая ставка → просто делим тело на срок.
	if (ratePerMonth === 0) {
		return principal / term;
	}

	// Классическая формула аннуитета:
	//   PMT = P * r * (1 + r)^n / ((1 + r)^n - 1)
	// Эквивалентно: PMT = P * r / (1 - (1+r)^(-n))
	const onePlusR = 1 + ratePerMonth;
	const onePlusRPowN = Math.pow(onePlusR, term);

	return (principal * ratePerMonth * onePlusRPowN) / (onePlusRPowN - 1);
}

/**
 * annuityPaymentFromBalance — аннуитетный платёж для оставшегося баланса.
 *
 * Используется когда balance != principal (кредит уже частично погашен,
 * или мы вычисляем платёж с середины срока). Остаток срока в месяцах
 * передаётся явно.
 *
 * При rate = 0 → balance / remainingTermMonths.
 *
 * @param balance           — текущий остаток долга
 * @param ratePerMonth      — месячная ставка
 * @param remainingTermMonths— оставшийся срок в месяцах
 * @returns ежемесячный аннуитетный платёж для этого баланса
 */
export function annuityPaymentFromBalance(
	balance: number,
	ratePerMonth: number,
	remainingTermMonths: number,
): number {
	if (ratePerMonth === 0) {
		return balance / remainingTermMonths;
	}
	const onePlusR = 1 + ratePerMonth;
	const onePlusRPowN = Math.pow(onePlusR, remainingTermMonths);
	return (balance * ratePerMonth * onePlusRPowN) / (onePlusRPowN - 1);
}

/**
 * differentiatedPayment — вычисляет платёж дифференцированного кредита
 * на указанный номер периода (0-based).
 *
 * Алгоритм дифференцированного кредита:
 *   - Тело долга делится равномерно: bodyPerPeriod = principal / term
 *   - Проценты считаются на остаток долга: interestThisMonth = balance * ratePerMonth
 *   - Остаток перед n-м периодом: remainingBalance = principal - bodyPerPeriod * periodIndex
 *   - Платёж: bodyPerPeriod + remainingBalance * ratePerMonth
 *
 * При rate = 0 → все платежи одинаковы (= principal / term).
 *
 * @param principal    — начальная сумма кредита (для расчёта тела на период)
 * @param ratePerMonth — месячная ставка
 * @param term         — полный срок в месяцах
 * @param periodIndex  — номер периода (0 = первый, term-1 = последний)
 * @returns сумма платежа на этот период
 */
export function differentiatedPayment(
	principal: number,
	ratePerMonth: number,
	term: number,
	periodIndex: number,
): number {
	// Тело за один месяц: principal равномерно делится на term месяцев.
	const bodyPerPeriod = principal / term;

	// Остаток долга ПЕРЕД данным периодом.
	const remainingBefore = principal - bodyPerPeriod * periodIndex;

	if (ratePerMonth === 0) {
		// Нет процентов — платёж = только тело.
		return bodyPerPeriod;
	}

	// Проценты на остаток долга этого месяца.
	const interest = remainingBefore * ratePerMonth;

	return bodyPerPeriod + interest;
}

// ---------------------------------------------------------------------------
// Разбивка платежа на тело/проценты
// ---------------------------------------------------------------------------

/**
 * splitPayment — разбивает платёж на тело долга и проценты.
 *
 * Логика (применима и для аннуитета, и для дифференцированного):
 *   1. Проценты за текущий месяц: interest = balance * ratePerMonth
 *   2. Тело = paymentAmount - interest (не может быть < 0)
 *   3. Если paymentAmount <= interest → весь платёж идёт в проценты (экстрим)
 *   4. Тело не может превышать текущий balance
 *   5. newBalance = balance - principal
 *
 * Для досрочного погашения (paymentAmount > balance + interest):
 *   principal = balance (погашаем всё тело), interest = balance * rate,
 *   newBalance = 0.
 *
 * @param credit        — снапшот кредита (берётся balance и rate_pct)
 * @param paymentAmount — сумма платежа (может быть меньше или больше планового)
 * @returns { principal, interest, newBalance }
 */
export function splitPayment(credit: CreditRecord, paymentAmount: number): SplitPaymentResult {
	const balance = credit.balance;
	const ratePerMonth = monthlyRateFromAnnual(credit.rate_pct ?? 0);

	// Проценты за этот месяц на текущий остаток.
	const interestThisMonth = balance * ratePerMonth;

	// Тело долга в этом платеже: то, что осталось после уплаты процентов.
	// Не может быть отрицательным (если платёж меньше процентов).
	let principal = Math.max(0, paymentAmount - interestThisMonth);

	// Тело не превышает текущий баланс (при досрочном погашении).
	principal = Math.min(principal, balance);

	// Проценты фактически уплаченные: что взяли из платежа под проценты.
	// Если платёж меньше процентов — все деньги уходят в проценты.
	// Но реально уплачены только те проценты, что "поместились" в платёж.
	const interestPaid = Math.min(interestThisMonth, paymentAmount);

	// Новый баланс после выплаты тела.
	// Math.max(0) защищает от float-point ошибок на последнем платеже.
	const newBalance = Math.max(0, balance - principal);

	return {
		principal,
		interest: interestPaid,
		newBalance,
	};
}

// ---------------------------------------------------------------------------
// Расчёт остатка после платежа (для creditPaymentsDue)
// ---------------------------------------------------------------------------

/**
 * balanceAfterPayment — вычисляет остаток долга после одного планового платежа.
 *
 * Используется в creditPaymentsDue для поля balanceAfter.
 *
 * Для аннуитета: balance_new = balance*(1+r) - PMT
 * Для дифференцированного: balance_new = balance - (principal/term)
 * При r=0: balance_new = balance - PMT (линейно)
 *
 * @param credit — снапшот кредита
 * @returns остаток после следующего планового платежа
 */
function balanceAfterScheduledPayment(credit: CreditRecord): number {
	const balance = credit.balance;

	if (balance <= 0) return 0;

	// Вычисляем плановую сумму платежа (единственный источник истины).
	// Это гарантирует согласованность: amount и balanceAfter считаются из одного источника.
	const amount = scheduledPaymentAmount(credit);

	// splitPayment правильно разбивает платёж на тело/проценты и вычисляет newBalance
	// на основе ФАКТИЧЕСКОГО credit.balance — для любого типа кредита.
	// Это устраняет рассинхрон между scheduledPaymentAmount и предыдущей логикой,
	// которая для аннуитета без данных возвращала balance (не меняя остаток),
	// тогда как scheduledPaymentAmount возвращал balance + interest (закрывает всё).
	const { newBalance } = splitPayment(credit, amount);
	return newBalance;
}

// ---------------------------------------------------------------------------
// Главная функция: платежи в окне
// ---------------------------------------------------------------------------

/**
 * creditPaymentsDue — платежи по кредитам, попадающие в окно [now, now + windowDays].
 *
 * Для каждого кредита проверяем:
 *   1. Есть ли поле next_payment_date (прямая дата).
 *   2. Если нет — пробуем вычислить из payment_day: ближайший day-of-month >= today.
 *   3. Если дата попадает в [now, now + windowDays] → добавляем в результат.
 *   4. Кредиты с balance = 0 пропускаются (уже погашены).
 *
 * @param credits    — массив снапшотов кредитов (из ledger.readAll('credits'))
 * @param now        — текущий момент как ISO-8601 строка
 * @param windowDays — ширина окна в днях (включительно)
 * @returns массив PaymentDue, отсортированный по dueDate
 */
export function creditPaymentsDue(
	credits: CreditRecord[],
	now: string,
	windowDays: number,
): PaymentDue[] {
	const results: PaymentDue[] = [];

	// Конец окна: now + windowDays суток.
	const windowEndIso = addDaysToIso(now, windowDays);

	for (const credit of credits) {
		// Пропускаем погашённые кредиты.
		if (credit.balance <= 0) continue;

		// Определяем дату следующего платежа.
		let dueDate: string | undefined;

		if (credit.next_payment_date) {
			// Приоритет: явно зафиксированная дата следующего платежа.
			dueDate = credit.next_payment_date;
		} else if (credit.payment_day !== undefined) {
			// Вычисляем ближайшую дату с нужным днём месяца >= now.
			dueDate = nextPaymentDateForDay(now, credit.payment_day);
		}

		if (!dueDate) continue;

		// Проверяем: дата попадает в окно [now, windowEnd] включительно.
		// Используем Date.getTime() вместо строкового сравнения — это защищает от
		// формата 'Z' vs '.000Z': "2026-06-01T00:00:00Z" > "2026-06-01T00:00:00.000Z"
		// лексикографически (Z > .), хотя моменты идентичны.
		const dueMs = new Date(dueDate).getTime();
		const nowMs = new Date(now).getTime();
		const windowEndMs = new Date(windowEndIso).getTime();
		if (dueMs < nowMs || dueMs > windowEndMs) continue;

		// Считаем сумму платежа.
		const amount = scheduledPaymentAmount(credit);

		// Считаем остаток после платежа.
		const balanceAfter = balanceAfterScheduledPayment(credit);

		results.push({
			credit_id: credit.id,
			amount,
			account: undefined, // CreditRecord не хранит account_id списания
			dueDate,
			balanceAfter,
		});
	}

	// Сортируем по дате платежа (ближайшие — первые).
	results.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));

	return results;
}

/**
 * scheduledPaymentAmount — возвращает сумму планового платежа для кредита.
 *
 * Приоритет:
 *   1. credit.monthly_payment (явно зафиксировано в записи)
 *   2. Вычисляем аннуитетный или дифференцированный платёж из параметров
 *   3. Если данных недостаточно — возвращаем balance (один платёж закрывает всё)
 *
 * @param credit — снапшот кредита
 * @returns сумма планового платежа
 */
function scheduledPaymentAmount(credit: CreditRecord): number {
	if (credit.monthly_payment) {
		return credit.monthly_payment;
	}

	const r = monthlyRateFromAnnual(credit.rate_pct ?? 0);
	const balance = credit.balance;

	if (credit.type === 'differentiated' && credit.term && credit.principal) {
		// Дифференцированный кредит: тело = principal/term (фиксировано), проценты на ФАКТИЧЕСКИЙ balance.
		//
		// ВАЖНО: ранее здесь был баг — проценты брались от теоретического остатка по расписанию
		// (через periodIndex + differentiatedPayment), а не от фактического credit.balance.
		// Это давало неверную сумму для частично погашённых кредитов и рассинхронизировало
		// amount с balanceAfter (который считался через splitPayment от credit.balance).
		//
		// Правильная формула: amount = bodyPerPeriod + balance * monthlyRate.
		// Согласована со splitPayment (который тоже считает проценты от credit.balance).
		const bodyPerPeriod = credit.principal / credit.term;
		const interest = balance * r;
		return bodyPerPeriod + interest;
	}

	if (credit.type === 'annuity' && credit.term && credit.principal) {
		const remainingTerm = estimateRemainingTermMonths(credit);
		if (remainingTerm > 0) {
			return annuityPaymentFromBalance(balance, r, remainingTerm);
		}
	}

	// Fallback: если есть term, считаем аннуитет из оставшихся данных.
	if (credit.term) {
		const remainingTerm = estimateRemainingTermMonths(credit);
		if (remainingTerm > 0) {
			return annuityPaymentFromBalance(balance, r, remainingTerm);
		}
	}

	// Совсем нет данных (нет term, нет monthly_payment) — один платёж закрывает всё.
	// balanceAfter для этого случая вычисляется через splitPayment (см. balanceAfterScheduledPayment),
	// что гарантирует согласованность: splitPayment(credit, amount).newBalance = 0.
	return balance + balance * r;
}

/**
 * estimateRemainingTermMonths — оценка оставшегося срока в месяцах.
 *
 * Если есть opened_at и term → считаем по прошедшим месяцам.
 * Если нет opened_at → возвращаем term целиком (пессимистичная оценка).
 * Если нет term → возвращает 0 (неизвестно).
 *
 * Используем ISO строки: берём первые 7 символов (YYYY-MM) для сравнения.
 *
 * @param credit — снапшот кредита
 * @returns оставшийся срок в месяцах (>= 0)
 */
function estimateRemainingTermMonths(credit: CreditRecord): number {
	if (!credit.term) return 0;

	if (!credit.opened_at) {
		// Нет даты открытия — возвращаем полный срок.
		return credit.term;
	}

	// Считаем прошедшие месяцы: (balance_ts - opened_at) / мес.
	// Упрощённо через год/месяц из ISO строки.
	const openedYear = parseInt(credit.opened_at.slice(0, 4), 10);
	const openedMonth = parseInt(credit.opened_at.slice(5, 7), 10);

	const nowYear = parseInt(credit.balance_ts.slice(0, 4), 10);
	const nowMonth = parseInt(credit.balance_ts.slice(5, 7), 10);

	const elapsedMonths = (nowYear - openedYear) * 12 + (nowMonth - openedMonth);
	const remaining = credit.term - elapsedMonths;

	// Не меньше 1 месяца (есть ещё долг — значит хотя бы один платёж остался).
	return Math.max(1, remaining);
}

// ---------------------------------------------------------------------------
// Прогноз даты погашения
// ---------------------------------------------------------------------------

/**
 * projectPayoffDate — прогнозирует дату полного погашения кредита.
 *
 * Алгоритм:
 *   - Для аннуитета: оставшихся месяцев = estimateRemainingTermMonths.
 *   - Для дифференцированного: аналогично.
 *   - Если monthly_payment задан — вычисляем явно через количество платежей:
 *       n = ceil(balance / (payment - interest_first))  — упрощённо.
 *   - Дата = now + оставшийся_срок_месяцев.
 *
 * Для точного расчёта (когда balance !== principal * f(n)) используем
 * итерационный подход: симулируем платежи до balance = 0.
 *
 * @param credit — снапшот кредита
 * @param now    — текущий момент (ISO-8601)
 * @returns прогнозируемая дата погашения (ISO-8601, первый день последнего месяца)
 */
export function projectPayoffDate(credit: CreditRecord, now: string): string {
	if (credit.balance <= 0) {
		// Уже погашен — возвращаем текущий момент.
		return now;
	}

	const r = monthlyRateFromAnnual(credit.rate_pct ?? 0);
	const balance = credit.balance;

	// Пытаемся вычислить через оставшийся срок.
	const remainingMonths = estimateRemainingTermMonths(credit);
	if (remainingMonths > 0) {
		return addMonthsToIso(now, remainingMonths);
	}

	// Если нет term — итерируемся по платежам.
	// Получаем плановый платёж.
	const pmt = scheduledPaymentAmount(credit);
	if (pmt <= 0) return now;

	// Итерационная симуляция: не более 1200 итераций (100 лет) как защита.
	let currentBalance = balance;
	let months = 0;
	const MAX_ITER = 1200;

	while (currentBalance > 0 && months < MAX_ITER) {
		const interest = currentBalance * r;
		const principalPart = Math.max(0, pmt - interest);

		if (principalPart <= 0) {
			// Платёж не покрывает даже проценты — кредит не погасится этим платежом.
			// Возвращаем далёкую дату как сигнал.
			return addMonthsToIso(now, MAX_ITER);
		}

		currentBalance = Math.max(0, currentBalance - principalPart);
		months++;
	}

	return addMonthsToIso(now, months);
}

// ---------------------------------------------------------------------------
// Предикат просрочки
// ---------------------------------------------------------------------------

/**
 * isOverdue — проверяет, просрочен ли плановый платёж по кредиту.
 *
 * Условия просрочки:
 *   1. next_payment_date задана И next_payment_date < now (прошлое).
 *   2. Учитывается grace period: фактическая просрочка = next_payment_date + grace дней < now.
 *   3. Если next_payment_date не задана, но задан payment_day:
 *      вычисляем ПРОШЕДШУЮ дату (предыдущий payment_day) и сравниваем с now.
 *
 * Если данных для определения нет — возвращает false (неизвестно = не просрочен).
 *
 * @param credit — снапшот кредита
 * @param now    — текущий момент (ISO-8601)
 * @returns true если платёж просрочен (с учётом grace period)
 */
export function isOverdue(credit: CreditRecord, now: string): boolean {
	if (credit.balance <= 0) {
		// Погашенный кредит — не просрочен.
		return false;
	}

	const graceDays = credit.grace ?? 0;

	if (credit.next_payment_date) {
		// Прибавляем grace period к дате платежа.
		// Если сейчас позже (дата + grace) → просрочка.
		const gracedDate = addDaysToIso(credit.next_payment_date, graceDays);
		// Сравниваем только даты (первые 10 символов ISO), не время.
		return now.slice(0, 10) > gracedDate.slice(0, 10);
	}

	if (credit.payment_day !== undefined) {
		// Вычисляем предыдущую дату платежа (ближайший payment_day в прошлом или текущем месяце).
		const prevDueDate = prevPaymentDateForDay(now, credit.payment_day);
		const gracedDate = addDaysToIso(prevDueDate, graceDays);
		return now.slice(0, 10) > gracedDate.slice(0, 10);
	}

	// Нет данных о дате платежа — не можем определить просрочку.
	return false;
}

// ---------------------------------------------------------------------------
// Вспомогательные функции для работы с датами (без зависимостей)
// ---------------------------------------------------------------------------

/**
 * addDaysToIso — добавляет N дней к ISO-8601 дате и возвращает новую ISO строку.
 *
 * Работает через Date arithmetic (UTC).
 * Возвращает дату в формате "YYYY-MM-DDTХХ:ХХ:ХХZ" (UTC).
 *
 * @param isoDate — исходная дата (ISO-8601)
 * @param days    — количество дней для добавления (может быть отрицательным)
 * @returns новая ISO-8601 дата в UTC
 */
export function addDaysToIso(isoDate: string, days: number): string {
	const d = new Date(isoDate);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString();
}

/**
 * addMonthsToIso — добавляет N месяцев к ISO-8601 дате и возвращает новую ISO строку.
 *
 * Используется для расчёта дат погашения.
 * При добавлении месяцев к 31-му числу может сдвинуть дату (напр. 31 янв + 1 мес = 28/29 фев).
 * Это стандартное поведение Date.setUTCMonth.
 *
 * @param isoDate — исходная дата (ISO-8601)
 * @param months  — количество месяцев для добавления
 * @returns новая ISO-8601 дата в UTC
 */
export function addMonthsToIso(isoDate: string, months: number): string {
	const d = new Date(isoDate);
	d.setUTCMonth(d.getUTCMonth() + months);
	return d.toISOString();
}

/**
 * nextPaymentDateForDay — вычисляет ближайшую будущую дату (>= now) с указанным днём месяца.
 *
 * Если в текущем месяце payment_day >= today_day → берём этот месяц.
 * Если payment_day уже прошёл в этом месяце → берём следующий месяц.
 * Если день > последнего дня месяца → берём последний день месяца (напр. 31 фев → 28/29 фев).
 *
 * @param now        — текущий момент (ISO-8601)
 * @param paymentDay — день месяца (1–31)
 * @returns ISO-8601 дата следующего платежа (время 00:00:00Z)
 */
export function nextPaymentDateForDay(now: string, paymentDay: number): string {
	const nowDate = new Date(now);
	const todayDay = nowDate.getUTCDate();
	const year = nowDate.getUTCFullYear();
	const month = nowDate.getUTCMonth(); // 0-based

	// Пробуем текущий месяц.
	if (paymentDay >= todayDay) {
		const candidate = new Date(Date.UTC(year, month, paymentDay));
		// Date.UTC автоматически корректирует дни > последнего дня месяца
		// (напр. 31 фев → 3 мар). Проверяем что получили тот же месяц.
		if (candidate.getUTCMonth() === month) {
			return candidate.toISOString();
		}
		// Если месяц поехал (день > количества дней в месяце) → используем последний день.
		const lastDay = new Date(Date.UTC(year, month + 1, 0));
		return lastDay.toISOString();
	}

	// День уже прошёл — берём следующий месяц.
	const nextMonth = month + 1;
	const candidate = new Date(Date.UTC(year, nextMonth, paymentDay));
	// Проверяем overflow (напр. 31 марта → апрель не имеет 31).
	const expectedMonth = ((month + 1) % 12 + 12) % 12;
	if (candidate.getUTCMonth() !== expectedMonth) {
		// Берём последний день следующего месяца.
		const lastDay = new Date(Date.UTC(year, nextMonth + 1, 0));
		return lastDay.toISOString();
	}
	return candidate.toISOString();
}

/**
 * prevPaymentDateForDay — вычисляет ближайшую прошедшую дату платежа (для isOverdue).
 *
 * Если payment_day <= today_day → это текущий месяц.
 * Если payment_day > today_day → предыдущий месяц.
 *
 * @param now        — текущий момент (ISO-8601)
 * @param paymentDay — день месяца (1–31)
 * @returns ISO-8601 дата предыдущего/текущего планового платежа
 */
export function prevPaymentDateForDay(now: string, paymentDay: number): string {
	const nowDate = new Date(now);
	const todayDay = nowDate.getUTCDate();
	const year = nowDate.getUTCFullYear();
	const month = nowDate.getUTCMonth();

	if (paymentDay <= todayDay) {
		// Платёж в этом месяце (возможно сегодня или ранее).
		const candidate = new Date(Date.UTC(year, month, paymentDay));
		if (candidate.getUTCMonth() === month) {
			return candidate.toISOString();
		}
		// Overflow → последний день текущего месяца.
		return new Date(Date.UTC(year, month + 1, 0)).toISOString();
	}

	// Платёж ещё не наступил в этом месяце → ищем в предыдущем.
	const prevMonth = month - 1; // может стать -1 (декабрь предыдущего года)
	const candidate = new Date(Date.UTC(year, prevMonth, paymentDay));
	// Проверяем overflow.
	const expectedMonth = ((month - 1) % 12 + 12) % 12;
	if (candidate.getUTCMonth() !== expectedMonth) {
		return new Date(Date.UTC(year, prevMonth + 1, 0)).toISOString();
	}
	return candidate.toISOString();
}
