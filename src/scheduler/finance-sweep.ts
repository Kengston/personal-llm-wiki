/**
 * finance-sweep.ts — ПРОАКТИВНЫЙ слой финансов: свип кредитов, целей, налички, простоя.
 *
 * Контекст ([ADR-0018] финмодуль, [ADR-0024] реактивный dispatch,
 *   [ADR-0011] финансы=знание/redact, [ADR-0007] owner-only blast-radius):
 *
 *   Этот модуль реализует «волну 2» проактивного финансового слоя:
 *     — Кредит-напоминания (#4): платёж за N дней (lead) и в день платежа (due),
 *       алерт просрочки (overdue) если платёж не зафиксирован. Дедуп по fired-реестру.
 *     — Майлстоуны целей (#8): при пересечении 25/50/75/100% → PNG-картинка прогресса.
 *     — Опрос налички (#8): ~раз в 3 дня вечером → вопрос + маркер pending-cash-survey.
 *     — Нудж простоя (#8): если данных не было N дней → «обнови данные».
 *
 * ПРИНЦИПЫ (строго соблюдать):
 *   - ВСЯ арифметика — из готовых движков (credit.ts, goals.ts, networth.ts).
 *     Ничего не пересчитываем сами. chart.ts даёт chartSpec → renderChartPng PNG.
 *   - Мультивалютность: суммы в нативных валютах, без единой «базовой».
 *   - Дедуп через finance-state.wasFired/markFired — не спамить каждый свип.
 *   - Финчисла в тексте/caption — огрублять через roundForDisplay (секрет-гейт ADR-0011).
 *   - ТОЛЬКО синтетические/фейковые данные в тестах (публичный репо).
 *   - Нет сетевых вызовов, нет фоновых процессов, нет реальных данных владельца.
 *   - Подробные комментарии на русском, стиль соседних модулей.
 */

import { DateTime } from 'luxon';
import type { GoalProgressData, TimePoint } from '../ingest/finance/chart.js';
import { chartSpec } from '../ingest/finance/chart.js';
import { creditPaymentsDue, isOverdue, projectPayoffDate } from '../ingest/finance/credit.js';
import { computeGoalProgress } from '../ingest/finance/goals.js';
import { computeNetWorth } from '../ingest/finance/networth.js';
import type { FxProvider } from '../ingest/finance/fx.js';
import type { AccountRecord, CreditRecord, FinanceGoal, SnapshotRecord } from '../ingest/finance/types.js';
import { renderChartPng } from '../bridge/finance-render.js';
import {
	clearSnoozeUntil,
	markFired,
	readLastInputTs,
	readSnoozeUntil,
	wasFired,
	writePendingCashSurvey,
} from './finance-state.js';
import { assertNoSecrets, pushPhotoToOwner, pushToOwner } from './runner.js';
import { buildCreditReminderKeyboard } from '../bridge/finance-callbacks.js';

// ---------------------------------------------------------------------------
// Конфигурация свипа
// ---------------------------------------------------------------------------

/**
 * FinanceSweepConfig — параметры проактивного свипа финансов.
 *
 * Все числа с дефолтами — кастомизируются через SchedulerConfig или env.
 */
export interface FinanceSweepConfig {
	/** Кредит-платежи: окно «lead» в днях (алертируем заранее). По умолчанию 5. */
	creditLeadDays: number;
	/** Порог простоя в днях: если давно не было ввода — нудж. По умолчанию 7. */
	idleNudgeDays: number;
	/** Интервал опроса налички в днях (~раз в 3 дня). По умолчанию 3. */
	cashSurveyIntervalDays: number;
	/** Час суток (local) для вечернего опроса налички (18–21). По умолчанию 19. */
	cashSurveyHour: number;
	/** Каталог state (finance-state). */
	stateDir: string;
	/** Таймзона пользователя (IANA). По умолчанию 'Europe/Moscow'. */
	tz: string;
}

/**
 * DigestCadence — каденция дайджеста (daily / weekly / monthly).
 *
 * Используется W3: недельная и месячная каденции прикладывают PNG net-worth.
 */
export type DigestCadence = 'daily' | 'weekly' | 'monthly';

/** Майлстоун-пороги целей (пересечение снизу вверх → пуш). */
export const GOAL_MILESTONES = [25, 50, 75, 100] as const;
export type GoalMilestone = (typeof GOAL_MILESTONES)[number];

// ---------------------------------------------------------------------------
// Структурные due-айтемы (результат collectFinanceDue)
// ---------------------------------------------------------------------------

/**
 * CreditDueItem — один кредит-платёж, попавший в окно свипа.
 *
 * Хранит всё необходимое для формирования текста пуша:
 *   kind: 'lead' — платёж через N дней (заблаговременное предупреждение)
 *         'due'  — платёж сегодня
 *         'overdue' — просрочен (платёж не зафиксирован за период)
 */
export interface CreditDueItem {
	/** Тип алерта: заранее / сегодня / просрочка. */
	kind: 'lead' | 'due' | 'overdue';
	/** ID кредита (из CreditRecord.id). */
	credit_id: string;
	/** Название кредита (если задано). */
	label: string;
	/** Сумма планового платежа в нативной валюте. */
	amount: number;
	/** Нативная валюта кредита. */
	currency: string;
	/** Ожидаемая дата платежа (ISO-8601). */
	dueDate: string;
	/** Остаток долга ПОСЛЕ этого платежа. */
	balanceAfter: number;
	/** Счёт списания (опц., из CreditRecord). */
	account?: string;
	/** Ключ дедупа для fired-реестра (≤ 64 байт). */
	fireKey: string;
	/**
	 * payoffDate — прогнозируемая дата полного погашения (ISO-8601, первые 10 символов).
	 *
	 * W2 (#4 крит.6): добавлено для отображения в кредит-алерте и дайджесте.
	 * Вычисляется через projectPayoffDate(credit, now) из credit.ts.
	 * Огрубление не требуется (это дата, не сумма).
	 */
	payoffDate: string;
}

/**
 * GoalMilestoneItem — майлстоун цели, пересечённый в текущем свипе.
 */
export interface GoalMilestoneItem {
	/** ID цели. */
	goal_id: string;
	/** Название цели (label). */
	label: string;
	/** Порог, пересечённый снизу вверх: 25/50/75/100. */
	milestonePercent: GoalMilestone;
	/** Текущий прогресс (0–100+). */
	pct: number;
	/** Текущая сумма. */
	current: number;
	/** Целевая сумма. */
	target: number;
	/** Валюта. */
	currency: string;
	/** fin_kind для chart. */
	fin_kind: GoalProgressData['fin_kind'];
	/** Ключ дедупа для fired-реестра. */
	fireKey: string;
}

/**
 * CashSurveyItem — сигнал к запуску опроса налички.
 * Если isDue=true, свип должен отправить вопрос и поставить pending-маркер.
 */
export interface CashSurveyItem {
	isDue: boolean;
	/** Ключ дедупа (по дате last-опроса, не fired-реестр — используем watermark). */
	fireKey: string;
}

/**
 * IdleNudgeItem — сигнал к отправке нуджа «обнови данные».
 */
export interface IdleNudgeItem {
	isDue: boolean;
	/** Сколько дней простоя. */
	idleDays: number;
	/** Ключ дедупа. */
	fireKey: string;
}

/**
 * FinanceDueResult — полный результат collectFinanceDue.
 * Кластер-1 передаёт эти данные в deliverFinanceDue для отправки пушей.
 */
export interface FinanceDueResult {
	credits: CreditDueItem[];
	milestones: GoalMilestoneItem[];
	cashSurvey: CashSurveyItem;
	idleNudge: IdleNudgeItem;
}

/**
 * PushToOwnerFn — тип функции pushToOwner с поддержкой replyMarkup.
 *
 * Мок в тестах принимает те же параметры что и реальная функция runner.ts.
 * Отдельный тип нужен чтобы: (1) тесты могли проверить, что replyMarkup передан;
 * (2) тип не ломается при добавлении опциональных полей в pushToOwner.
 */
export type PushToOwnerFn = (
	text: string,
	opts?: {
		disableNotification?: boolean;
		env?: NodeJS.ProcessEnv;
		replyMarkup?: import('../bridge/telegram.js').ReplyMarkup;
	}
) => Promise<void>;

/**
 * DeliverFinanceDueDeps — инъектируемые зависимости для deliverFinanceDue.
 *
 * Паттерн deps-injection (как в finance-callbacks.ts) позволяет тестировать
 * success-путь без реального Telegram:
 *   — мок pushToOwner/pushPhotoToOwner проверяет, что пуш вызван с нужным текстом;
 *   — мок assertNoSecrets проверяет секрет-гейт на видимом тексте;
 *   — markFired/writePendingCashSurvey — реальные (работают с temp-dir).
 *
 * Дефолтные значения = реальные функции из runner.ts (обратная совместимость).
 */
export interface DeliverFinanceDueDeps {
	/** pushToOwner — отправка текста владельцу (с опциональным replyMarkup). */
	pushToOwner?: PushToOwnerFn;
	/** pushPhotoToOwner — отправка PNG владельцу. */
	pushPhotoToOwner?: typeof pushPhotoToOwner;
	/** assertNoSecrets — секрет-гейт на текст. */
	assertNoSecrets?: typeof assertNoSecrets;
}

/**
 * NetworthPngDeps — зависимости для построения net-worth PNG в недельном/месячном дайджесте.
 *
 * W3 (#8 крит.3): недельный/месячный дайджест прикладывает PNG динамики net-worth.
 * Передаются вместе с DeliverFinanceDueDeps в deliverFinanceDue.
 */
export interface NetworthPngDeps {
	/**
	 * snapshots — все снапшоты из леджера для вычисления исторического net-worth.
	 * Если не переданы — PNG не строится (graceful degradation).
	 */
	snapshots?: SnapshotRecord[];
	/**
	 * credits — все кредиты для computeNetWorth (обязательства).
	 * Если не переданы — PNG не строится.
	 */
	credits?: CreditRecord[];
	/**
	 * accounts — описания счетов (для breakdownByKind).
	 * Опционально: при отсутствии kind='unknown'.
	 */
	accounts?: AccountRecord[];
	/**
	 * fx — провайдер курсов валют.
	 * Если не передан — PNG не строится.
	 */
	fx?: FxProvider;
	/**
	 * displayCurrency — валюта для отображения net-worth на графике.
	 * Дефолт: 'RUB'.
	 */
	displayCurrency?: string;
	/**
	 * cadence — каденция дайджеста (daily/weekly/monthly).
	 * Если 'weekly' или 'monthly' — PNG строится.
	 * Если 'daily' или не передано — PNG не строится (ежедневный = только текст).
	 */
	cadence?: DigestCadence;
	/**
	 * renderPng — инъекция рендерера PNG (для тестов без реального @resvg).
	 * Дефолт: renderChartPng из bridge/finance-render.
	 */
	renderPng?: typeof renderChartPng;
	/**
	 * historicalPoints — количество исторических точек для ряда net-worth.
	 * Дефолт: 8 (покрывает ~2 месяца или 8 недель). Используем снапшоты
	 * за последние N периодов с шагом 1 неделя/1 месяц.
	 */
	historicalPoints?: number;
}

// ---------------------------------------------------------------------------
// Вспомогательные утилиты
// ---------------------------------------------------------------------------

/**
 * roundForDisplay — огрубляет число для отображения в тексте/caption.
 *
 * Секрет-гейт ([ADR-0011]): точные финчисла остаются в леджере (приватный репо);
 * в Telegram-подписи отправляем приблизительные значения.
 *
 * Правила огрубления:
 *   < 1 000  → без округления (мелкие суммы)
 *   < 10 000 → до 100
 *   < 100 000 → до 1 000
 *   ≥ 100 000 → до 10 000
 *
 * @param value   — точное числовое значение
 * @returns огрублённое значение (меньше точности → меньше риск утечки точных данных)
 */
export function roundForDisplay(value: number): number {
	const abs = Math.abs(value);
	const sign = value < 0 ? -1 : 1;

	// Мелкие суммы: до 1000 — без округления.
	if (abs < 1_000) return value;

	// 1 000–9 999: округляем до 100.
	if (abs < 10_000) return sign * Math.round(abs / 100) * 100;

	// 10 000–99 999: округляем до 1 000.
	if (abs < 100_000) return sign * Math.round(abs / 1_000) * 1_000;

	// 100 000+: округляем до 10 000.
	return sign * Math.round(abs / 10_000) * 10_000;
}

/**
 * daysBetween — количество полных дней между двумя ISO-датами (UTC).
 *
 * @param fromIso — начало (ISO-8601)
 * @param toIso   — конец (ISO-8601)
 * @returns положительное если to > from, отрицательное если to < from
 */
export function daysBetween(fromIso: string, toIso: string): number {
	const fromMs = new Date(fromIso).getTime();
	const toMs = new Date(toIso).getTime();
	// Math.round: компенсируем DST-смещение (час туда-сюда на стыке).
	return Math.round((toMs - fromMs) / (1000 * 60 * 60 * 24));
}

/**
 * isoDateOnly — берёт первые 10 символов ISO-строки (YYYY-MM-DD).
 * Используется для сравнения дат без времени.
 */
function isoDateOnly(iso: string): string {
	return iso.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Главная аналитическая функция: collectFinanceDue
// ---------------------------------------------------------------------------

/**
 * collectFinanceDue — собирает все due-айтемы финансового свипа.
 *
 * Чистая (почти: читает fired-реестр и watermark из stateDir) функция,
 * которая принимает данные леджера и возвращает структурированные айтемы.
 * НИКАКИХ пушей здесь — только анализ.
 *
 * Алгоритм:
 *   1. Кредит-платежи: creditPaymentsDue(credits, now, windowDays) за 2 периода:
 *        - lead-окно: [now+1, now+leadDays] — заблаговременно за N дней;
 *        - due-окно: [now, now] — сегодняшний платёж;
 *        - overdue: isOverdue(credit, now) — просрочка.
 *      Дедуп: wasFired(stateDir, fireKey) / markFired.
 *   2. Майлстоуны: computeGoalProgress(goal, snapshots, fx, now) для каждой цели.
 *      Если pct пересёк 25/50/75/100 снизу → GoalMilestoneItem.
 *   3. Опрос налички: ~раз в 3 дня вечером (часовой фильтр по UTC-hour).
 *      Дедуп: wasFired(stateDir, cashKey) за сутки.
 *   4. Нудж простоя: readLastInputTs → если давно не было ввода.
 *      Дедуп: wasFired(stateDir, nudgeKey) за сутки.
 *
 * @param credits   — кредиты из ledger.readAll('credits')
 * @param goals     — цели из wiki (FinanceGoal[])
 * @param snapshots — снапшоты балансов из ledger.readAll('snapshots')
 * @param fx        — провайдер курсов (мок или реальный)
 * @param now       — текущий момент (ISO-8601)
 * @param cfg       — конфиг свипа
 * @returns FinanceDueResult со всеми due-айтемами (без side-эффектов пушей)
 */
export async function collectFinanceDue(
	credits: CreditRecord[],
	goals: FinanceGoal[],
	snapshots: SnapshotRecord[],
	fx: FxProvider,
	now: string,
	cfg: FinanceSweepConfig,
): Promise<FinanceDueResult> {
	const nowDate = isoDateOnly(now);

	// ── 1. Кредит-платежи ─────────────────────────────────────────────────────

	const creditItems: CreditDueItem[] = [];

	// lead-окно: платежи за [now, now+leadDays] — полное окно включая сегодня.
	// Фактически creditPaymentsDue возвращает [now, now+windowDays].
	const duePayments = creditPaymentsDue(credits, now, cfg.creditLeadDays);

	for (const payment of duePayments) {
		// Находим исходный CreditRecord для метаданных (label, currency).
		const credit = credits.find((c) => c.id === payment.credit_id);
		if (!credit) continue;

		// Определяем тип алерта: due = платёж сегодня, lead = заранее.
		const daysUntil = daysBetween(nowDate, isoDateOnly(payment.dueDate));
		const alertKind: 'due' | 'lead' = daysUntil <= 0 ? 'due' : 'lead';

		// Формируем ключ дедупа (≤ 64 байт: 'credit:' + id + ':' + date + ':' + kind).
		const fireKey = `credit:${payment.credit_id}:${isoDateOnly(payment.dueDate)}:${alertKind}`;

		// Дедуп fired: если уже отправляли этот алерт — пропускаем.
		if (wasFired(cfg.stateDir, fireKey)) continue;

		// Snooze-гейт (W1): если пользователь нажал [Отложить] — проверяем
		// что snooze истёк (now >= snoozeUntil). Если нет — молчим.
		// Ключ snooze: 'credit:<id>' (без суффикса даты/типа).
		const snoozeKey = `credit:${payment.credit_id}`;
		const snoozeUntil = readSnoozeUntil(cfg.stateDir, snoozeKey);
		// R3: сравниваем по числовому timestamp (ms), а не лексикографически.
		// Строковое сравнение ISO-дат хрупко к смещениям (+03:00 vs Z): '2026-06-24+03'
		// лексикографически < '2026-06-24T01:00:00Z', хотя по смыслу позже.
		if (snoozeUntil !== null && new Date(now).getTime() < new Date(snoozeUntil).getTime()) {
			// Snooze ещё активен — пропускаем этот айтем.
			continue;
		}
		// Snooze истёк (или не задан): если snooze был — очищаем (уборка реестра).
		if (snoozeUntil !== null) {
			clearSnoozeUntil(cfg.stateDir, snoozeKey);
		}

		// W2: прогнозируемая дата погашения через готовый движок (не пересчитываем сами).
		const payoffDate = projectPayoffDate(credit, now).slice(0, 10);

		creditItems.push({
			kind: alertKind,
			credit_id: payment.credit_id,
			// Используем id как label если name не задано в CreditRecord.
			// CreditRecord может не иметь поля name — берём id как fallback.
			label: (credit as CreditRecord & { name?: string }).name ?? payment.credit_id,
			amount: payment.amount,
			currency: credit.currency,
			dueDate: payment.dueDate,
			balanceAfter: payment.balanceAfter,
			account: payment.account,
			fireKey,
			payoffDate,
		});
	}

	// Проверяем просрочки: кредиты с isOverdue=true.
	for (const credit of credits) {
		if (!isOverdue(credit, now)) continue;

		// Ключ просрочки: привязан к дате NOW (предупреждаем раз в сутки).
		const fireKey = `credit:${credit.id}:${nowDate}:overdue`;

		// Дедуп по дате: не спамим каждый свип.
		if (wasFired(cfg.stateDir, fireKey)) continue;

		// Snooze-гейт для overdue: тот же ключ 'credit:<id>'.
		const snoozeKeyOvd = `credit:${credit.id}`;
		const snoozeUntilOvd = readSnoozeUntil(cfg.stateDir, snoozeKeyOvd);
		// R3: числовое сравнение (аналогично lead/due выше — хрупкость лексикографии).
		if (snoozeUntilOvd !== null && new Date(now).getTime() < new Date(snoozeUntilOvd).getTime()) {
			// Snooze ещё активен — не фаярим overdue.
			continue;
		}
		if (snoozeUntilOvd !== null) {
			clearSnoozeUntil(cfg.stateDir, snoozeKeyOvd);
		}

		// W2: прогнозируемая дата погашения для overdue.
		const payoffDateOvd = projectPayoffDate(credit, now).slice(0, 10);

		creditItems.push({
			kind: 'overdue',
			credit_id: credit.id,
			label: (credit as CreditRecord & { name?: string }).name ?? credit.id,
			amount: credit.balance,
			currency: credit.currency,
			// Используем balance_ts как приблизительную дату просрочки.
			dueDate: credit.next_payment_date ?? credit.balance_ts,
			balanceAfter: credit.balance,
			account: undefined,
			fireKey,
			payoffDate: payoffDateOvd,
		});
	}

	// ── 2. Майлстоуны целей ───────────────────────────────────────────────────

	const milestoneItems: GoalMilestoneItem[] = [];

	for (const goal of goals) {
		// Считаем прогресс через готовый движок.
		const progress = await computeGoalProgress(goal, snapshots, fx, now);

		// Ищем НАИБОЛЬШИЙ пройденный незафиксированный майлстоун.
		// Итерируем от большего к меньшему — берём максимальный, который ещё не fired.
		// Это гарантирует, что при первом свипе отправится самый высокий достигнутый порог.
		const sortedDesc = [...GOAL_MILESTONES].sort((a, b) => b - a) as GoalMilestone[];

		for (const threshold of sortedDesc) {
			// Пересечение снизу: progress.pct >= threshold (пройден).
			if (progress.pct < threshold) continue;

			// Ключ дедупа: фиксируем конкретный порог (не повторять).
			const fireKey = `goal:${goal.id}:milestone:${threshold}`;

			// Дедуп: если уже отправляли этот майлстоун — пропускаем (ищем следующий).
			if (wasFired(cfg.stateDir, fireKey)) continue;

			// Определяем fin_kind для chart из типа цели.
			// FinanceGoal.fin_kind: 'save' | 'spend_cap' | 'debt_paydown' | 'grow'
			const fin_kind = goal.fin_kind as GoalProgressData['fin_kind'];

			milestoneItems.push({
				goal_id: goal.id,
				label: goal.id,
				milestonePercent: threshold,
				pct: progress.pct,
				current: progress.current,
				target: progress.target,
				currency: progress.currency,
				fin_kind,
				fireKey,
			});

			// Отправляем только ОДИН (наибольший незафиксированный) майлстоун за свип.
			// Следующий sweep зафиксирует его и перейдёт к следующему по убыванию.
			break;
		}
	}

	// ── 3. Опрос налички ──────────────────────────────────────────────────────

	// Вечерний час для опроса налички — вычисляем через luxon в cfg.tz.
	// Репо-стандарт: luxon tz-aware (как digest.ts/reminders.ts); getUTCHours() — антипаттерн.
	// cfg.cashSurveyHour — целевой час (дефолт 19). Окно: [cashSurveyHour - 1, cashSurveyHour + 2].
	// Пример: tz=Europe/Moscow(UTC+3), cashSurveyHour=19 → опрос в 18-21 MSK.
	//         tz=America/New_York(UTC-4 летом), cashSurveyHour=19 → опрос в 18-21 ET.
	const nowLocal = DateTime.fromISO(now, { zone: 'utc' }).setZone(cfg.tz);
	const localHour = nowLocal.hour;
	const surveyWindowStart = Math.max(0, cfg.cashSurveyHour - 1);
	const surveyWindowEnd = Math.min(23, cfg.cashSurveyHour + 2);
	const isEveningHour = localHour >= surveyWindowStart && localHour <= surveyWindowEnd;

	// Дата дедупа — локальный календарный день (cfg.tz), не UTC-срез.
	// Это предотвращает off-by-one: пользователь в UTC-5 в 23:00 локальных = 04:00 UTC
	// следующего дня → UTC-дата была бы «завтра», а локальная = «сегодня» (правильно).
	const nowLocalDate = nowLocal.toFormat('yyyy-MM-dd');

	// Ключ дедупа по локальному дню (раз в cashSurveyIntervalDays дней).
	const cashSurveyKey = `cash-survey:${nowLocalDate}`;

	// Проверяем: уже отправляли сегодня?
	const cashSurveyFiredToday = wasFired(cfg.stateDir, cashSurveyKey);

	// Дополнительно проверяем предыдущие N-1 дней — через luxon (корректный локальный день).
	let cashSurveyFiredRecently = cashSurveyFiredToday;
	if (!cashSurveyFiredToday) {
		for (let d = 1; d < cfg.cashSurveyIntervalDays; d++) {
			const pastDate = nowLocal.minus({ days: d }).toFormat('yyyy-MM-dd');
			const pastKey = `cash-survey:${pastDate}`;
			if (wasFired(cfg.stateDir, pastKey)) {
				cashSurveyFiredRecently = true;
				break;
			}
		}
	}

	const cashSurveyDue = !cashSurveyFiredRecently && isEveningHour;

	// ── 4. Нудж простоя ───────────────────────────────────────────────────────

	// Читаем watermark последнего ввода.
	const lastInputTs = readLastInputTs(cfg.stateDir);

	// Ключ нуджа по локальному дню (раз в сутки, как и cash-survey).
	const nudgeKey = `idle-nudge:${nowLocalDate}`;
	const nudgeFiredToday = wasFired(cfg.stateDir, nudgeKey);

	let idleDays = 0;
	let idleNudgeDue = false;

	if (!nudgeFiredToday) {
		if (lastInputTs === null) {
			// Никогда не было ввода — считаем максимальный порог.
			idleDays = cfg.idleNudgeDays + 1;
			idleNudgeDue = true;
		} else {
			// Считаем дни простоя.
			idleDays = daysBetween(isoDateOnly(lastInputTs), nowDate);
			idleNudgeDue = idleDays >= cfg.idleNudgeDays;
		}
	}

	return {
		credits: creditItems,
		milestones: milestoneItems,
		cashSurvey: {
			isDue: cashSurveyDue,
			fireKey: cashSurveyKey,
		},
		idleNudge: {
			isDue: idleNudgeDue,
			idleDays,
			fireKey: nudgeKey,
		},
	};
}

// ---------------------------------------------------------------------------
// Доставка пушей: deliverFinanceDue
// ---------------------------------------------------------------------------

/**
 * buildNetworthTimeSeries — строит ряд точек net-worth для PNG-графика.
 *
 * W3: берём исторические срезы снапшотов (по N точек, шаг = 1 неделя или 1 месяц)
 * и для каждой точки вызываем computeNetWorth. Результат — массив {ts, value}
 * в displayCurrency.
 *
 * Алгоритм:
 *   1. Берём now как конечную точку. Генерируем N точек назад с шагом stepDays.
 *   2. Для каждой точки asOf вызываем computeNetWorth(snapshots, credits, asOf, [dc], fx).
 *   3. Берём totalsByDisplayCurrency[dc] как значение (0 если не конвертируется).
 *   4. Возвращаем отсортированный по ts массив TimePoint.
 *
 * ВАЖНО: чистая асинхронная функция, нет IO. Данные снапшотов/кредитов
 * передаются извне (инъекция).
 *
 * @param snapshots       — снапшоты из леджера
 * @param credits         — кредиты из леджера
 * @param accounts        — описания счетов (опц.)
 * @param fx              — провайдер курсов
 * @param now             — текущий момент (ISO-8601)
 * @param displayCurrency — валюта отображения
 * @param pointCount      — количество исторических точек
 * @param stepDays        — шаг между точками в днях (7 = недельный, 30 = месячный)
 * @returns массив TimePoint (может быть пустым если нет данных)
 */
export async function buildNetworthTimeSeries(
	snapshots: SnapshotRecord[],
	credits: CreditRecord[],
	accounts: AccountRecord[],
	fx: FxProvider,
	now: string,
	displayCurrency: string,
	pointCount: number,
	stepDays: number,
): Promise<TimePoint[]> {
	// Генерируем N точек в прошлое с шагом stepDays.
	// Точки — от самой старой (now - (N-1)*step) до now.
	const points: TimePoint[] = [];

	for (let i = pointCount - 1; i >= 0; i--) {
		// Вычисляем asOf как now - i*stepDays.
		const asOf = new Date(now);
		asOf.setUTCDate(asOf.getUTCDate() - i * stepDays);
		const asOfIso = asOf.toISOString();

		try {
			// Вызываем готовый движок net-worth (не пересчитываем сами).
			const nw = await computeNetWorth(
				snapshots,
				credits,
				asOfIso,
				[displayCurrency],
				fx,
				accounts,
			);

			// Берём total в displayCurrency (0 если нет данных/курса).
			const value = nw.totalsByDisplayCurrency[displayCurrency] ?? 0;

			points.push({ ts: asOfIso, value });
		} catch {
			// Ошибка одной точки не ломает весь ряд — пропускаем.
			// (Например, нет снапшотов за этот период.)
		}
	}

	// Сортируем по ts (строковая лексикографическая сортировка ISO работает корректно).
	return points.sort((a, b) => a.ts.localeCompare(b.ts));
}

/**
 * deliverFinanceDue — доставляет проактивные пуши по due-айтемам финансов.
 *
 * Вызывается ПОСЛЕ collectFinanceDue. Для каждого due-айтема:
 *   1. Форматирует текст/caption (огрублённые числа — секрет-гейт).
 *   2. assertNoSecrets на видимый текст.
 *   3. Пушит через pushToOwner (текст) или pushPhotoToOwner (PNG-картинка для майлстоунов).
 *   4. markFired(stateDir, fireKey, now) — фиксирует отправку в реестре.
 *   5. Для cash-survey: writePendingCashSurvey(stateDir, ...).
 *
 * Доставка КАЖДОГО айтема независима: ошибка одного не блокирует остальные
 * (собираем ошибки, возвращаем их количество).
 *
 * @param result        — результат collectFinanceDue
 * @param now           — текущий момент (ISO-8601, для markFired)
 * @param cfg           — конфиг свипа (stateDir)
 * @param env           — переменные окружения (для Telegram-клиента, опц.)
 * @param deps          — инъектируемые зависимости (для тестов без реального Telegram)
 * @param networthDeps  — данные и настройки для W3 net-worth PNG (опц.)
 * @returns количество ошибок доставки (0 = всё ок)
 */
export async function deliverFinanceDue(
	result: FinanceDueResult,
	now: string,
	cfg: FinanceSweepConfig,
	env: NodeJS.ProcessEnv = process.env,
	deps: DeliverFinanceDueDeps = {},
	networthDeps: NetworthPngDeps = {},
): Promise<number> {
	let errors = 0;

	// Резолвим зависимости: дефолт = реальные функции из runner.ts.
	// При инъекции из тестов используются моки (без реального Telegram).
	const _pushToOwner = deps.pushToOwner ?? pushToOwner;
	const _pushPhotoToOwner = deps.pushPhotoToOwner ?? pushPhotoToOwner;
	const _assertNoSecrets = deps.assertNoSecrets ?? assertNoSecrets;

	// ── 1. Кредит-напоминания ─────────────────────────────────────────────────

	for (const item of result.credits) {
		try {
			// Передаём now явно — инвариант clock-injection (не new Date() внутри форматтера).
			const text = formatCreditAlert(item, now);
			// Секрет-гейт: assertNoSecrets на видимый текст (caption/filename, ADR-0011).
			_assertNoSecrets(text);

			// Строим инлайн-клавиатуру [Оплачено]/[Отложить]/[Подробнее] (блокер #7).
			// Кнопки уместны только для lead/due (просрочка — overdue — без кнопок,
			// нажать [Оплачено] на уже просроченном означало бы пост-фактум, что сбивает
			// логику creditPaymentsDue; пусть оплачивают через диалог или [Оплачено] в due).
			const replyMarkup = (item.kind === 'lead' || item.kind === 'due')
				? buildCreditReminderKeyboard(item.credit_id)
				: undefined;

			await _pushToOwner(text, { env, replyMarkup });
			// Фиксируем успешную отправку в реестре.
			markFired(cfg.stateDir, item.fireKey, now);
		} catch (err) {
			// Ошибка одного алерта не блокирует остальные.
			process.stderr.write(`[finance-sweep] кредит-алерт ошибка: ${String(err)}\n`);
			errors++;
		}
	}

	// ── 2. Майлстоуны целей (PNG-картинка) ────────────────────────────────────

	for (const item of result.milestones) {
		try {
			// Строим спеку прогресс-бара (огрублённые числа в label — секрет-гейт).
			const progressData: GoalProgressData = {
				goal_id: item.goal_id,
				label: item.label,
				// Огрубляем current/target для встроенного label в SVG.
				current: roundForDisplay(item.current),
				target: roundForDisplay(item.target),
				currency: item.currency,
				fin_kind: item.fin_kind,
			};

			const spec = chartSpec({ kind: 'goal_progress', data: progressData });
			const png = renderChartPng(spec);

			// Caption: краткий текст с огрублёнными числами.
			const caption = formatGoalMilestoneCaption(item);
			_assertNoSecrets(caption);

			await _pushPhotoToOwner(
				{ data: png, filename: `goal-progress-${item.goal_id}.png` },
				{ caption, env },
			);
			markFired(cfg.stateDir, item.fireKey, now);
		} catch (err) {
			process.stderr.write(`[finance-sweep] майлстоун-пуш ошибка: ${String(err)}\n`);
			errors++;
		}
	}

	// ── 3. Опрос налички ──────────────────────────────────────────────────────

	if (result.cashSurvey.isDue) {
		try {
			const text =
				'💰 Сколько наличных сейчас? Ответь одним числом (и валютой, если не рубли). Например: 5000 или 200 USD';
			_assertNoSecrets(text);
			await _pushToOwner(text, { env });

			// Записываем маркер pending-cash-survey (C3-реактив подхватит ответ).
			writePendingCashSurvey(cfg.stateDir, {
				sinceIso: now,
				// currency не указываем — C3 определит по ответу пользователя.
			});
			// Фиксируем отправку в реестре (дедуп на следующие sweeps).
			markFired(cfg.stateDir, result.cashSurvey.fireKey, now);
		} catch (err) {
			process.stderr.write(`[finance-sweep] cash-survey ошибка: ${String(err)}\n`);
			errors++;
		}
	}

	// ── 4. Нудж простоя ───────────────────────────────────────────────────────

	if (result.idleNudge.isDue) {
		try {
			const text = formatIdleNudge(result.idleNudge.idleDays);
			_assertNoSecrets(text);
			await _pushToOwner(text, { env });
			markFired(cfg.stateDir, result.idleNudge.fireKey, now);
		} catch (err) {
			process.stderr.write(`[finance-sweep] idle-nudge ошибка: ${String(err)}\n`);
			errors++;
		}
	}

	// ── 5. Net-worth PNG для недельного/месячного дайджеста (W3) ─────────────
	//
	// #8 крит.3: «Недельный/месячный дайджест ИНОГДА прикладывает картинку».
	// Ежедневный — ТОЛЬКО текст (нет PNG). Дедуп через fired-стор с period-ключом.
	//
	// Каденция weekly/monthly → строим PNG с рядом net-worth по времени:
	//   1. Вычисляем ключ периода: 'digest:networth:YYYY-Www' или 'digest:networth:YYYY-MM'.
	//   2. Если уже fired в этом периоде — пропускаем (дедуп).
	//   3. buildNetworthTimeSeries → chartSpec('networth_over_time') → renderChartPng.
	//   4. pushPhotoToOwner с огрублённым caption.
	//   5. markFired по ключу периода.

	const { cadence, snapshots, credits: nwCredits, accounts, fx, displayCurrency = 'RUB', historicalPoints = 8, renderPng: renderPngFn } = networthDeps;

	if (cadence === 'weekly' || cadence === 'monthly') {
		try {
			// Вычисляем ключ периода (tz-aware через luxon, UTC для детерминизма).
			const nowDt = DateTime.fromISO(now, { zone: 'utc' });
			const periodKey = cadence === 'weekly'
				? `digest:networth:${nowDt.toFormat("kkkk-'W'WW")}` // ISO-week: 2026-W25
				: `digest:networth:${nowDt.toFormat('yyyy-MM')}`;    // месяц: 2026-06

			// Дедуп: уже отправляли в этом периоде — пропускаем.
			if (wasFired(cfg.stateDir, periodKey)) {
				// Дедуп сработал — не отправляем.
			} else if (snapshots && nwCredits && fx) {
				// Данные переданы — строим ряд net-worth.
				const stepDays = cadence === 'weekly' ? 7 : 30;
				const timeSeries = await buildNetworthTimeSeries(
					snapshots,
					nwCredits,
					accounts ?? [],
					fx,
					now,
					displayCurrency,
					historicalPoints,
					stepDays,
				);

				// Строим спеку через готовый chartSpec.
				const spec = chartSpec({
					kind: 'networth_over_time',
					points: timeSeries,
					currency: displayCurrency,
				});

				// Рендерим PNG (инъекция рендерера для тестов без @resvg).
				const _renderPng = renderPngFn ?? renderChartPng;
				const png = _renderPng(spec);

				// Caption с огрублёнными числами (секрет-гейт).
				// Последняя точка ряда = текущий net-worth.
				const lastPoint = timeSeries.at(-1);
				const lastValue = lastPoint ? roundForDisplay(lastPoint.value) : null;
				const periodLabel = cadence === 'weekly' ? 'неделя' : 'месяц';
				const caption = lastValue !== null
					? `Динамика капитала за ${periodLabel}: ~${lastValue} ${displayCurrency}`
					: `Динамика капитала за ${periodLabel}`;
				_assertNoSecrets(caption);

				await _pushPhotoToOwner(
					{ data: png, filename: `networth-${cadence}-${now.slice(0, 10)}.png` },
					{ caption, env },
				);

				// Фиксируем отправку (дедуп на весь период).
				markFired(cfg.stateDir, periodKey, now);
			}
		} catch (err) {
			process.stderr.write(`[finance-sweep] networth-png ошибка: ${String(err)}\n`);
			errors++;
		}
	}

	return errors;
}

// ---------------------------------------------------------------------------
// Форматтеры текстов (огрублённые числа, без PII)
// ---------------------------------------------------------------------------

/**
 * formatCreditAlert — форматирует текст кредит-напоминания для Telegram.
 *
 * Использует огрублённые числа (roundForDisplay) — секрет-гейт.
 * Кредитор/счёт не раскрываем (без PII).
 *
 * ВАЖНО: now — инъектируемый параметр (тот же, что передаётся в deliverFinanceDue/collectFinanceDue).
 * Запрещено читать системные часы внутри этой функции (нарушение инварианта clock-injection,
 * ломает детерминизм dry-run, replay и тестов с FAKE_NOW).
 *
 * @param item — CreditDueItem с данными платежа
 * @param now  — текущий момент ISO-8601 (инъектируется, НЕ new Date())
 * @returns текст для отправки в Telegram (без markdown, просто текст)
 */
export function formatCreditAlert(item: CreditDueItem, now: string): string {
	// Огрубляем суммы для секрет-гейта.
	const amtDisplay = roundForDisplay(item.amount);
	const balDisplay = roundForDisplay(item.balanceAfter);
	const cur = item.currency;

	// W2: прогнозируемая дата погашения (дата, не сумма → огрубление не нужно).
	const payoffStr = item.payoffDate ?? '';

	switch (item.kind) {
		case 'lead': {
			// Предупреждение заранее.
			// Считаем дни до платежа от инъектированного now (не от wall-clock).
			const daysUntil = daysBetween(isoDateOnly(now), isoDateOnly(item.dueDate));
			return (
				`Напоминание: кредит «${item.label}» — платёж через ~${daysUntil} дн.\n` +
				`Сумма: ~${amtDisplay} ${cur}\n` +
				`Остаток после: ~${balDisplay} ${cur}` +
				(payoffStr ? `\nПрогноз погашения: ${payoffStr}` : '')
			);
		}
		case 'due':
			// Платёж сегодня.
			return (
				`Сегодня платёж по кредиту «${item.label}»\n` +
				`Сумма: ~${amtDisplay} ${cur}\n` +
				`Остаток после: ~${balDisplay} ${cur}` +
				(payoffStr ? `\nПрогноз погашения: ${payoffStr}` : '')
			);
		case 'overdue':
			// Просрочка.
			return (
				`Просрочка! Кредит «${item.label}» — платёж не зафиксирован.\n` +
				`Остаток: ~${amtDisplay} ${cur}` +
				(payoffStr ? `\nПрогноз погашения: ${payoffStr}` : '')
			);
	}
}

/**
 * formatGoalMilestoneCaption — caption для PNG-картинки майлстоуна цели.
 *
 * Огрублённые числа — секрет-гейт.
 *
 * @param item — GoalMilestoneItem
 * @returns caption строка (≤ 1024 символов для Telegram sendPhoto)
 */
export function formatGoalMilestoneCaption(item: GoalMilestoneItem): string {
	const pctStr = Math.round(item.pct);
	const cur = item.currency;
	// Секрет-гейт: огрубляем суммы ДО записи в caption.
	const curDisplay = roundForDisplay(item.current);
	const tgtDisplay = roundForDisplay(item.target);

	// Эмодзи-маркеры прогресса (не секретные данные, просто оформление).
	const emoji = item.milestonePercent === 100 ? '🎉' : '📈';

	return (
		`${emoji} Цель «${item.label}» — ${item.milestonePercent}% пройдено!\n` +
		`Прогресс: ${pctStr}% (~${curDisplay} из ~${tgtDisplay} ${cur})`
	);
}

/**
 * formatIdleNudge — текст нуджа при длительном простое.
 *
 * @param idleDays — количество дней без финансового ввода
 * @returns текст нуджа
 */
export function formatIdleNudge(idleDays: number): string {
	// Простой, понятный нудж без финансовых данных.
	return (
		`Финансы: ${idleDays} дн. без обновлений.\n` +
		'Запиши доходы/расходы или обнови снапшоты счетов чтобы поддерживать актуальность данных.'
	);
}

// ---------------------------------------------------------------------------
// Секция финансов для дайджеста (buildFinanceDigestSection)
// ---------------------------------------------------------------------------

/**
 * FinanceDigestData — данные финансового пульса для встройки в дайджест.
 *
 * Содержит огрублённую сводку (без точных чисел — секрет-гейт ADR-0011):
 *   - ближайшие кредит-платежи;
 *   - прогресс целей (процент, без точной суммы);
 *   - статус net-worth (только наличие, не точная сумма).
 */
export interface FinanceDigestData {
	/** Ближайшие кредит-платежи из due-айтемов. */
	upcomingCredits: Array<{
		label: string;
		dueDate: string;
		currency: string;
		/**
		 * payoffDate — прогнозируемая дата полного погашения (YYYY-MM-DD, опц.).
		 *
		 * R4 (#4 крит.6): добавлено для отображения в текстовом дайджесте.
		 * Берётся из CreditDueItem.payoffDate (вычислен через projectPayoffDate).
		 * Если не задан — строка с датой не выводится.
		 */
		payoffDate?: string;
	}>;
	/** Прогресс целей (огрублённый процент). */
	goalSummaries: Array<{ label: string; pctRounded: number }>;
	/** Есть ли данные net-worth (true = данные присутствуют, сумма не раскрывается). */
	hasNetworthData: boolean;
}

/**
 * buildFinanceDigestSection — форматирует секцию финансов для ежедневного дайджеста.
 *
 * Возвращает текстовый блок для встройки в buildSweepPrompt или прямой отправки.
 * Ежедневный дайджест — ТОЛЬКО ТЕКСТ (без PNG, чтобы не спамить картинками).
 * PNG отправляются в отдельных майлстоун-пушах (deliverFinanceDue).
 *
 * Секрет-гейт: никаких точных сумм — только проценты и огрублённые числа.
 *
 * @param data — финансовые данные для секции
 * @returns строка-секция для дайджеста (пустая строка если нечего показывать)
 */
export function buildFinanceDigestSection(data: FinanceDigestData): string {
	const lines: string[] = [];

	// Ближайшие кредит-платежи.
	if (data.upcomingCredits.length > 0) {
		lines.push('**Кредиты (ближайшие платежи):**');
		for (const c of data.upcomingCredits) {
			const dateStr = isoDateOnly(c.dueDate);
			// R4 (#4 крит.6): добавляем прогнозируемую дату погашения в дайджест.
			// projectPayoffDate — готовый движок (не пересчитываем сами).
			// payoffDate передаётся из CreditDueItem (уже вычислен в collectFinanceDue).
			// Формат: slice(0,10) = YYYY-MM-DD.
			const payoffStr = c.payoffDate ? `, погашение: ${isoDateOnly(c.payoffDate)}` : '';
			lines.push(`— «${c.label}»: ${dateStr} (${c.currency})${payoffStr}`);
		}
	}

	// Прогресс целей.
	if (data.goalSummaries.length > 0) {
		lines.push('**Цели:**');
		for (const g of data.goalSummaries) {
			const bar = makeProgressBar(g.pctRounded);
			lines.push(`— «${g.label}»: ${g.pctRounded}% ${bar}`);
		}
	}

	if (lines.length === 0) return '';

	// Заголовок секции финансов.
	return ['**💰 Финансовый пульс:**', ...lines].join('\n');
}

/**
 * makeProgressBar — ASCII прогресс-бар для текстового дайджеста.
 *
 * @param pct — процент (0–100+)
 * @returns строка вида "[████░░░░░░]"
 */
function makeProgressBar(pct: number): string {
	const clamped = Math.min(100, Math.max(0, pct));
	const filled = Math.round(clamped / 10);
	const empty = 10 - filled;
	return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
}
