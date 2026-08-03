/**
 * funnel.ts — метрики воронки откликов ([ADR-0030], Решение 2).
 *
 * Всё — чистые функции над прочитанным леджером: без БД, без LLM, без кэша. Снимок
 * пересчитывается на каждый запрос: сотни строк, fold — доли миллисекунды, а инвалидация
 * кэша стоила бы дороже самой работы.
 *
 * **Статистическая честность — часть решения, а не украшение.** Личный поиск работы это
 * десятки откликов, а не десятки тысяч. Дашборд, который на двадцати наблюдениях рисует
 * проценты и тренды, производит ложную уверенность и меняет поведение владельца в неверную
 * сторону — это дороже, чем отсутствие графика. Отсюда форма `Rate`: значение НИКОГДА не
 * ходит без `n`, при `n < 10` процент в разрезе не показывается, при `n < 100` вместо точки
 * даётся интервал Уилсона, при пустом знаменателе — прочерк, а не «0 %».
 *
 * В расчёт конверсий входят ТОЛЬКО события `kind: stage_change`, и фильтр стоит ОДНОЙ
 * строкой на входе, а не размазан по каждой метрике: иначе переписка сама себе рисует
 * конверсию, а `ghostAfterDays` обнуляется каждым напоминанием о себе.
 */

import {
	foldAll,
	type ApplicationEvent,
	type ApplicationRecord,
	type ApplicationStage,
} from './events.js';

/**
 * Rate — доля с обязательным контекстом.
 * `value: null` означает «нет данных» (пустой знаменатель) — это валидный ответ.
 */
export interface Rate {
	value: number | null;
	numerator: number;
	denominator: number;
	/** Размер знаменателя. Рендер не имеет права показать значение, не показав `n`. */
	n: number;
	/** `n < 10` — в разрезе показываем только абсолютные числа. */
	lowN: boolean;
	/** Доверительный интервал Уилсона 95 % при `0 < n < 100`. */
	ci: { low: number; high: number } | null;
}

/** Длительность в днях: медиана и p75, НЕ среднее. */
export interface DurationStat {
	median: number | null;
	p75: number | null;
	n: number;
}

/** Порог, ниже которого в разрезе не показываем процент. */
const LOW_N = 10;
/** Порог, ниже которого показываем интервал, а не точку. */
const CI_N = 100;
/** Порог, ниже которого тренды не рисуются вовсе. */
export const TREND_N = 30;

/** z для 95 %. */
const Z = 1.96;

/**
 * wilson — доверительный интервал Уилсона для доли.
 *
 * Десяток строк арифметики без зависимостей. Он честно показывает, что при 22 откликах
 * «18 %» означает примерно «от 7 % до 39 %», и снимает соблазн сравнивать сегменты.
 */
export function wilson(x: number, n: number, z = Z): { low: number; high: number } {
	if (n <= 0) return { low: 0, high: 0 };
	const p = x / n;
	const denom = 1 + (z * z) / n;
	const center = (p + (z * z) / (2 * n)) / denom;
	const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
	return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

/** rate — собирает долю вместе со всем контекстом, который обязан её сопровождать. */
export function rate(numerator: number, denominator: number): Rate {
	if (denominator <= 0) {
		return { value: null, numerator, denominator, n: 0, lowN: true, ci: null };
	}
	return {
		value: numerator / denominator,
		numerator,
		denominator,
		n: denominator,
		lowN: denominator < LOW_N,
		ci: denominator < CI_N ? wilson(numerator, denominator) : null,
	};
}

/** quantile — линейная интерполяция по отсортированному массиву. */
function quantile(sorted: number[], q: number): number | null {
	if (sorted.length === 0) return null;
	if (sorted.length === 1) return sorted[0]!;
	const pos = (sorted.length - 1) * q;
	const lower = Math.floor(pos);
	const upper = Math.ceil(pos);
	if (lower === upper) return sorted[lower]!;
	return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (pos - lower);
}

/**
 * durationStat — медиана и p75.
 * Среднего здесь нет намеренно: один ответ через три месяца сдвигает среднее так, что оно
 * перестаёт описывать типичный случай.
 */
export function durationStat(values: number[]): DurationStat {
	const sorted = [...values].sort((a, b) => a - b);
	return { median: quantile(sorted, 0.5), p75: quantile(sorted, 0.75), n: sorted.length };
}

/** daysBetween — разница в днях между двумя ISO-моментами. */
function daysBetween(fromIso: string, toIso: string): number {
	return (Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000;
}

/** Пары стадий, по которым считаются конверсии. Плюс сквозная applied→offer. */
export const CONVERSION_PAIRS: ReadonlyArray<readonly [ApplicationStage, ApplicationStage]> = [
	['applied', 'replied'],
	['replied', 'screening'],
	['screening', 'interview'],
	['interview', 'offer'],
	['applied', 'offer'],
];

/** Ключ конверсии в отчёте: `applied→replied`. */
export function conversionKey(from: ApplicationStage, to: ApplicationStage): string {
	return `${from}→${to}`;
}

/** Завершённые воронки: они не «молчат», они закончились — в знаменатель игнора не идут. */
const TERMINAL_STAGES: ReadonlySet<string> = new Set(['offer', 'rejected', 'withdrawn', 'ghosted']);

/** Один разрез: доля дошедших до ответа и до оффера. */
export interface SegmentStat {
	replied: Rate;
	offer: Rate;
}

export interface FunnelReport {
	as_of: string;
	total: number;
	/** Сколько откликов СЕЙЧАС на каждой стадии (последняя из `stage_change`). */
	byStage: Partial<Record<ApplicationStage, number>>;
	/** Сколько откликов КОГДА-ЛИБО достигали стадии — знаменатели конверсий. */
	reachedStage: Partial<Record<ApplicationStage, number>>;
	conversions: Record<string, Rate>;
	/** Время до первого ответа: `min(replied|screening|rejected) − applied_at`. */
	ttfrDays: DurationStat;
	/** Срок до оффера по завершённым воронкам. */
	timeToOfferDays: DurationStat;
	/** Доля игнора. Свежие отклики из знаменателя исключены. */
	ghost: Rate;
	breakdowns: {
		company_source: Record<string, SegmentStat>;
		submission_channel: Record<string, SegmentStat>;
		variant_id: Record<string, SegmentStat>;
	};
	/** Группировка исходов по нормализованному справочнику причин. */
	reasons: Record<string, number>;
	/** Разрешено ли вообще рисовать тренд (`n >= 30`). */
	trendAllowed: boolean;
	/** Оговорка о покрытии (D11): показатели покрывают только подключённые источники. */
	sourceCoverage: string;
}

export interface FunnelOptions {
	/** Момент, на который считаем. Аргумент, а не часы внутри — отчёт воспроизводим. */
	asOf: string;
	/** Сколько дней молчания считать игнором. */
	ghostAfterDays: number;
	/** Перечень подключённых источников для оговорки о покрытии. */
	connectedSources: string[];
}

/**
 * computeFunnel — снимок воронки. Пересчитывается на каждый запрос.
 *
 * @param applications — записи откликов
 * @param events       — весь поток событий (фильтр `stage_change` стоит внутри, на входе)
 * @param opts         — момент отчёта, порог игнора, подключённые источники
 */
export function computeFunnel(
	applications: ApplicationRecord[],
	events: ApplicationEvent[],
	opts: FunnelOptions,
): FunnelReport {
	// ЕДИНСТВЕННЫЙ фильтр касаний — здесь. Дальше по коду `touchpoint` не существует,
	// поэтому «забыть исключить касание» в отдельной метрике физически невозможно.
	const stageEvents = events.filter((e) => e.kind === 'stage_change');
	const states = foldAll(applications, stageEvents);

	const byStage: Partial<Record<ApplicationStage, number>> = {};
	const reachedStage: Partial<Record<ApplicationStage, number>> = {};
	const reasons: Record<string, number> = {};
	const ttfr: number[] = [];
	const toOffer: number[] = [];

	let ghostNumerator = 0;
	let ghostDenominator = 0;

	// Заявка сама по себе — факт стадии `applied`; отдельного события для этого не требуем.
	const firstAtOf = (app: ApplicationRecord, stage: ApplicationStage): string | undefined => {
		const state = states.get(app.id);
		if (stage === 'applied') return state?.firstAt.applied ?? app.applied_at;
		return state?.firstAt[stage];
	};

	for (const app of applications) {
		const state = states.get(app.id);
		if (!state) continue;

		const current = state.stage ?? 'applied';
		byStage[current] = (byStage[current] ?? 0) + 1;

		for (const stage of new Set<ApplicationStage>(['applied', ...state.stagesReached])) {
			reachedStage[stage] = (reachedStage[stage] ?? 0) + 1;
		}

		if (state.reasonCode) reasons[state.reasonCode] = (reasons[state.reasonCode] ?? 0) + 1;

		// TTFR: первый ЛЮБОЙ ответ работодателя.
		const firstReplyCandidates = (['replied', 'screening', 'rejected'] as const)
			.map((s) => state.firstAt[s])
			.filter((v): v is string => Boolean(v))
			.sort();
		if (firstReplyCandidates[0]) {
			ttfr.push(daysBetween(app.applied_at, firstReplyCandidates[0]));
		}

		const offerAt = state.firstAt.offer;
		if (offerAt) toOffer.push(daysBetween(app.applied_at, offerAt));

		// Доля игнора. Знаменатель — только отклики, с подачи которых прошло ≥ порога:
		// свежие исключаются, иначе право-цензурирование занижает показатель ровно на
		// объём последней недели. Завершённые воронки (оффер, отказ, отзыв, подтверждённый
		// игнор) из знаменателя тоже уходят — они не «молчат», они закончились.
		const ageDays = daysBetween(app.applied_at, opts.asOf);
		const resolved = TERMINAL_STAGES.has(current);
		if (ageDays >= opts.ghostAfterDays && !resolved) {
			ghostDenominator++;
			// Молчание считаем от последнего ВНЕШНЕГО события, а не от подачи: ответ месяц
			// назад и тишина после него — это тоже игнор.
			const silenceFrom = state.lastExternalAt ?? app.applied_at;
			if (daysBetween(silenceFrom, opts.asOf) >= opts.ghostAfterDays) ghostNumerator++;
		}
	}

	const conversions: Record<string, Rate> = {};
	for (const [from, to] of CONVERSION_PAIRS) {
		let numerator = 0;
		let denominator = 0;
		for (const app of applications) {
			const fromAt = firstAtOf(app, from);
			if (!fromAt) continue;
			denominator++;
			const toAt = firstAtOf(app, to);
			if (toAt && toAt >= fromAt) numerator++;
		}
		conversions[conversionKey(from, to)] = rate(numerator, denominator);
	}

	/** segment — разрез по произвольному ключу записи отклика. */
	const segment = (keyOf: (a: ApplicationRecord) => string | undefined) => {
		const buckets = new Map<string, { total: number; replied: number; offer: number }>();
		for (const app of applications) {
			const key = keyOf(app);
			if (!key) continue;
			const bucket = buckets.get(key) ?? { total: 0, replied: 0, offer: 0 };
			bucket.total++;
			const state = states.get(app.id);
			if (state?.lastExternalAt) bucket.replied++;
			if (state?.firstAt.offer) bucket.offer++;
			buckets.set(key, bucket);
		}
		const out: Record<string, SegmentStat> = {};
		for (const [key, b] of [...buckets].sort((a, z) => a[0].localeCompare(z[0]))) {
			out[key] = { replied: rate(b.replied, b.total), offer: rate(b.offer, b.total) };
		}
		return out;
	};

	const sources = opts.connectedSources;
	const sourceList = sources.length > 0 ? sources.join(', ') : 'нет подключённых';

	return {
		as_of: opts.asOf,
		total: applications.length,
		byStage,
		reachedStage,
		conversions,
		ttfrDays: durationStat(ttfr),
		timeToOfferDays: durationStat(toOffer),
		ghost: rate(ghostNumerator, ghostDenominator),
		breakdowns: {
			company_source: segment((a) => a.company_source),
			submission_channel: segment((a) => a.submission_channel),
			variant_id: segment((a) => a.variant_id),
		},
		reasons,
		trendAllowed: applications.length >= TREND_N,
		sourceCoverage: `Показатели покрывают только подключённые источники (${sources.length}: ${sourceList}); полного среза рынка не существует.`,
	};
}

/**
 * formatRate — единственная допустимая текстовая форма доли.
 *
 * Абсолюты рядом с процентом ВСЕГДА: `18 % (4 из 22)`. Пустой знаменатель — прочерк,
 * а не «0 %». При `n < 100` рядом идёт интервал.
 */
export function formatRate(r: Rate, opts: { withInterval?: boolean } = {}): string {
	if (r.value === null) return '—';
	const pct = `${Math.round(r.value * 100)} %`;
	const abs = `(${r.numerator} из ${r.denominator})`;
	if (opts.withInterval && r.ci) {
		const low = Math.round(r.ci.low * 100);
		const high = Math.round(r.ci.high * 100);
		return `${pct} ${abs}, интервал ${low}–${high} %`;
	}
	return `${pct} ${abs}`;
}
