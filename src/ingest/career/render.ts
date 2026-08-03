/**
 * render.ts — сборка варианта резюме из карьерной базы ([ADR-0028]).
 *
 * Модуль СТРОГО чистый: ни файловых операций, ни часов, ни сети. Всё, что приходит
 * извне, приходит аргументами:
 *   - `CareerBase`      — состояние базы (свод леджера, см. store.ts);
 *   - `RenderDirectory` — идентифицирующие данные (имя, контакты, названия организаций,
 *     ссылки), которые в репозитории не хранятся вообще и подставляются ТОЛЬКО здесь (D3);
 *   - `asOf`            — месяц, относительно которого считается свежесть.
 *
 * Почему часы — аргумент, а не `Date.now()`: скоринг обязан быть воспроизводимым.
 * Отправленный вариант резюме должен собираться байт-в-байт так же и через месяц,
 * иначе `variant.evidence_version` (пин к замеру) ничего не гарантирует.
 *
 * Три правила, которые здесь не обсуждаются:
 *
 *   1. FAIL-CLOSED. Документ с невосстановленным `{{metric.key}}` или с дырой перевода
 *      не выдаётся вовсе (`markdown: null`) — потому что именно такой документ уходит
 *      рекрутеру незамеченным. Ошибки перечислены в `issues`.
 *
 *   2. МОЛЧА НИЧЕГО НЕ РЕЖЕТСЯ. Ограничения формы — свойство рендера, а не данных:
 *      леджер хранит всё, рендер режет по хвосту скоринга и ОБЯЗАН вернуть список
 *      выброшенного с причиной. Молча выпавшее сильное достижение — скрытая потеря.
 *
 *   3. НЕТ МОЛЧАЛИВОГО ФОЛБЭКА ЯЗЫКА. Отсутствующий перевод — ошибка `missing_translation`
 *      со списком записей, а не подстановка текста на другом языке: русский буллет
 *      посреди английского резюме — худший дефект документа из возможных.
 *
 * Все примеры в тестах синтетические; реальные имена и контакты в публичный репозиторий
 * не попадают ни при каком сценарии ([ADR-0003]).
 */

import type { CareerBase } from './store.js';
import type {
	AchievementRecord,
	I18nText,
	MetricRecord,
	PositionRecord,
	VariantRecord,
} from './types.js';

// ---------------------------------------------------------------------------
// Внешние данные, которых нет в репозитории
// ---------------------------------------------------------------------------

/**
 * RenderDirectory — всё идентифицирующее, что живёт в gitignored-источнике и
 * подставляется в момент рендера (D3).
 *
 * Сюда входит и отображаемое имя владельца: оно идентифицирует его ровно так же, как
 * почта, и в леджере поля под него нет намеренно. Названия организаций — по той же
 * причине: в схеме позиции хранится непрозрачный `org_key`.
 */
export interface RenderDirectory {
	/** Отображаемое имя владельца в шапке документа. */
	display_name: string;
	/** Значения контактов по `contact.key`. */
	contacts: Record<string, string>;
	/** Отображаемые названия организаций по `position.org_key`. */
	orgs: Record<string, string>;
	/** Отображаемые названия учебных заведений по `education.institution_key`. */
	institutions: Record<string, string>;
	/** URL по `project.link_key` и `education.credential_key`. */
	links: Record<string, string>;
}

/** Опции рендера. */
export interface RenderOptions {
	/**
	 * Месяц (`YYYY-MM`), относительно которого считается свежесть опыта.
	 * Аргумент, а не `Date.now()`: см. шапку модуля.
	 */
	asOf: string;
}

// ---------------------------------------------------------------------------
// Диагностика
// ---------------------------------------------------------------------------

/** Код проблемы рендера. Ошибки блокируют документ, предупреждения — нет. */
export type RenderIssueCode =
	/** Плейсхолдер `{{metric.key}}` без записи метрики ([ADR-0028]). */
	| 'unknown_metric'
	/** Нет перевода листового поля на язык варианта. */
	| 'missing_translation'
	/** Нет значения контакта/организации/ссылки в справочнике рендера. */
	| 'missing_directory_entry'
	/** Язык варианта не поддержан шаблоном (нет подписей секций). */
	| 'unsupported_lang'
	/** `business`-метрика без внешнего подтверждения — в документ не идёт. */
	| 'unverifiable_business_metric'
	/** Метрика взята не из того замера, к которому пинован вариант. */
	| 'evidence_stale'
	/** Числоподобный литерал прямо в тексте достижения — эвристика, не блокирует. */
	| 'literal_number_in_text'
	/** В документ попала введённая руками оценка, а не измеренное число. */
	| 'manual_metric_in_document'
	/** Оценка объёма превышает `form.max_pages` — режем вручную, а не молча. */
	| 'form_overflow_estimate';

export interface RenderIssue {
	code: RenderIssueCode;
	severity: 'error' | 'warning';
	/** На что указывает проблема: id записи, ключ метрики, ключ справочника. */
	ref: string;
	detail: string;
}

/** Причина, по которой запись не попала в документ. */
export type CutReason =
	/** Проиграла ранжирование внутри позиции (`form.max_bullets_per_position`). */
	| 'cut_by_score'
	/** Позиция за пределами `form.max_detailed_positions` — идёт строкой без буллетов. */
	| 'cut_by_form_limit'
	/** Явно исключена владельцем через `variant.excludes`. */
	| 'excluded_by_owner';

export interface CutItem {
	id: string;
	kind: 'achievement' | 'position';
	reason: CutReason;
	score: number;
	/** Из чего сложился балл — сортировка обязана объясняться, а не быть числом. */
	reasons: string[];
}

/** Результат рендера: документ (или его отсутствие), диагностика и выброшенное. */
export interface RenderResult {
	/** `null`, если есть хотя бы одна ошибка: fail-closed. */
	markdown: string | null;
	issues: RenderIssue[];
	cut: CutItem[];
}

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

/**
 * resolveI18n — достаёт текст на нужном языке.
 * Возвращает `null`, если перевода нет: фолбэка на другой язык здесь нет и не будет.
 */
export function resolveI18n(text: I18nText, lang: string): string | null {
	if ('no_translate' in text) return text.text;
	return text[lang] ?? null;
}

// ---------------------------------------------------------------------------
// Подписи секций
// ---------------------------------------------------------------------------

/**
 * SECTION_LABELS — подписи секций по языкам. Это слой ШАБЛОНА, а не данных
 * (глоссарий §1.2): смена шаблона не меняет ни одной записи карьерной базы.
 *
 * Новый язык варианта требует строки здесь; молчаливого фолбэка на английский нет —
 * секция «Experience» посреди немецкого резюме это тот же дефект, что и буллет не на
 * том языке, только заметнее.
 */
const SECTION_LABELS: Record<string, Record<string, string>> = {
	en: {
		about: 'About',
		experience: 'Experience',
		projects: 'Projects',
		skills: 'Skills',
		education: 'Education',
		languages: 'Languages',
		credential: 'verify',
		present: 'present',
	},
	ru: {
		about: 'О себе',
		experience: 'Опыт работы',
		projects: 'Проекты',
		skills: 'Навыки',
		education: 'Образование',
		languages: 'Языки',
		credential: 'подтверждение',
		present: 'по настоящее время',
	},
};

/** Подписи форматов работы — тоже слой шаблона. */
const WORK_SETUP_LABELS: Record<string, Record<string, string>> = {
	en: { onsite: 'on-site', hybrid: 'hybrid', remote: 'remote', relocation: 'open to relocation' },
	ru: { onsite: 'офис', hybrid: 'гибрид', remote: 'удалённо', relocation: 'готов к релокации' },
};

// ---------------------------------------------------------------------------
// Форматирование метрик
// ---------------------------------------------------------------------------

/** Разделитель разрядов по языкам — детерминированная замена `toLocaleString()`. */
const GROUP_SEPARATOR: Record<string, string> = { en: ',', ru: '\u202f' };

/**
 * formatNumber — разряды без зависимости от локали хоста.
 * `toLocaleString()` здесь недопустим: он делает вывод зависимым от машины, на которой
 * собрали документ, а документ обязан быть воспроизводимым.
 */
function formatNumber(value: number, lang: string): string {
	const sep = GROUP_SEPARATOR[lang] ?? ' ';
	const [int, frac] = Math.abs(value).toString().split('.');
	const grouped = (int ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, sep);
	const sign = value < 0 ? '-' : '';
	return frac ? `${sign}${grouped}.${frac}` : `${sign}${grouped}`;
}

/**
 * formatMetricValue — значение метрики так, как оно попадёт в текст.
 * `display` (если задан) побеждает: иногда число надо показать формулировкой.
 */
function formatMetricValue(metric: MetricRecord, lang: string): string | null {
	if (metric.display) return resolveI18n(metric.display, lang);

	const number = formatNumber(metric.value, lang);
	if (metric.unit === 'pct') return `${number}%`;
	if (metric.unit === 'x') return `${number}x`;
	if (metric.unit === 'count') return number;
	return `${number} ${metric.unit}`;
}

/** Плейсхолдер метрики в тексте достижения. */
const METRIC_PLACEHOLDER = /\{\{metric\.([a-z0-9][a-z0-9_.-]*)\}\}/g;

/**
 * LITERAL_NUMBER — эвристика «число зашито прямо в текст».
 *
 * Ловит проценты, кратности и разрядные группы — то, ради чего и заведены метрики.
 * НЕ ловит годы и версии (`2024`, `HTTP/2`): иначе предупреждение воюет с нормальным
 * текстом и его перестают читать. Эвристика не блокирует документ.
 */
const LITERAL_NUMBER = /\d+\s*%|\b\d+x\b|\b\d{1,3}(?:[\u202f ,]\d{3})+\b/;

// ---------------------------------------------------------------------------
// Скоринг
// ---------------------------------------------------------------------------

/**
 * SCORE_WEIGHTS — веса ранжирования достижений.
 *
 * Это ПОРЯДОК ПРЕДПОЧТЕНИЯ, а не измерение: числа подобраны так, чтобы совпадение по
 * стеку весило больше рубрики, а проверяемое число — больше свежести. Поэтому рядом с
 * каждым отобранным и выброшенным достижением едет список сработавших причин: сортировка
 * обязана объясняться словами, а не непрозрачным баллом (тот же принцип, что в
 * [ADR-0029] §4 про ранжирование компаний).
 *
 * Последнее слово всё равно за владельцем: `variant.pins` и `variant.excludes` —
 * жёсткий оверрайд поверх любого балла.
 */
export const SCORE_WEIGHTS = {
	/** За каждый навык достижения, попавший в ключевые слова вакансии. */
	skillMatch: 2,
	/** За проверяемое число (метрика из замера или подтверждаемая бизнес-метрика). */
	verifiableMetric: 3,
	/** Рубрика эффекта. */
	impact: { scaled: 3, saved: 3, shipped: 2, led: 2, fixed: 1 } as Record<string, number>,
	/** Свежесть родительской позиции: закончилась не дольше N месяцев назад. */
	freshRecent: 3,
	freshMid: 1,
} as const;

/** Границы свежести в месяцах: «недавно» и «ещё не древность». */
const FRESH_RECENT_MONTHS = 24;
const FRESH_MID_MONTHS = 60;

/** monthsBetween — разница месяцев между `YYYY-MM` строками (без Date, без таймзон). */
function monthsBetween(from: string, to: string): number {
	const [fy, fm] = from.split('-').map(Number) as [number, number];
	const [ty, tm] = to.split('-').map(Number) as [number, number];
	return (ty - fy) * 12 + (tm - fm);
}

/**
 * targetSkillIds — навыки базы, которые вакансия назвала ключевыми словами.
 *
 * Сопоставление ТОЧНОЕ (по id и по любому из названий, регистронезависимо), не по
 * вхождению подстроки: «java» не должна подсвечивать «javascript».
 */
function targetSkillIds(base: CareerBase, keywords: string[]): Set<string> {
	const wanted = new Set(keywords.map((k) => k.trim().toLowerCase()).filter(Boolean));
	const matched = new Set<string>();

	for (const skill of base.skills) {
		if (wanted.has(skill.id.toLowerCase())) {
			matched.add(skill.id);
			continue;
		}
		const names = 'no_translate' in skill.name ? [skill.name.text] : Object.values(skill.name);
		if (names.some((n) => wanted.has(n.toLowerCase()))) matched.add(skill.id);
	}

	return matched;
}

/** Оценка одного достижения плюс объяснение, из чего она сложилась. */
interface Scored {
	achievement: AchievementRecord;
	score: number;
	reasons: string[];
}

/**
 * scoreAchievement — детерминированный балл достижения под конкретную вакансию.
 *
 * Входы ровно те, что перечислены в [ADR-0028]: пересечение навыков с ключевыми словами,
 * наличие проверяемой метрики, рубрика `impact`, свежесть родительской позиции.
 */
function scoreAchievement(
	achievement: AchievementRecord,
	wanted: Set<string>,
	metrics: Map<string, MetricRecord>,
	freshness: { score: number; label: string } | null,
): Scored {
	const reasons: string[] = [];
	let score = 0;

	const matched = achievement.skill_ids.filter((id) => wanted.has(id));
	if (matched.length > 0) {
		score += matched.length * SCORE_WEIGHTS.skillMatch;
		reasons.push(`совпадение по стеку: ${matched.join(', ')}`);
	}

	const verifiable = achievement.metric_keys.some((key) => {
		const metric = metrics.get(key);
		if (!metric) return false;
		return metric.source === 'evidence' || (metric.source === 'business' && metric.verifiable);
	});
	if (verifiable) {
		score += SCORE_WEIGHTS.verifiableMetric;
		reasons.push('есть проверяемое число');
	}

	if (achievement.impact) {
		const weight = SCORE_WEIGHTS.impact[achievement.impact] ?? 0;
		score += weight;
		reasons.push(`рубрика ${achievement.impact}`);
	}

	if (freshness && freshness.score > 0) {
		score += freshness.score;
		reasons.push(freshness.label);
	}

	return { achievement, score, reasons };
}

/** Свежесть позиции относительно `asOf`. */
function positionFreshness(
	position: PositionRecord,
	asOf: string,
): { score: number; label: string } {
	const months = monthsBetween(position.ended_at ?? asOf, asOf);
	if (months <= FRESH_RECENT_MONTHS) {
		return { score: SCORE_WEIGHTS.freshRecent, label: 'свежий опыт' };
	}
	if (months <= FRESH_MID_MONTHS)
		return { score: SCORE_WEIGHTS.freshMid, label: 'опыт не старше 5 лет' };
	return { score: 0, label: '' };
}

// ---------------------------------------------------------------------------
// Рендер
// ---------------------------------------------------------------------------

/**
 * Оценка объёма: сколько строк markdown укладывается на страницу.
 *
 * Это ОЦЕНКА, а не измерение — markdown не знает про страницы. Поэтому превышение
 * `form.max_pages` даёт предупреждение и не режет документ: тихо выбросить достижение
 * по выдуманной арифметике хуже, чем сказать владельцу «оценочно длиннее лимита».
 */
const ESTIMATED_LINES_PER_PAGE = 48;

/** Внутреннее состояние сборки: аккумулирует диагностику по ходу. */
class RenderContext {
	readonly issues: RenderIssue[] = [];
	readonly cut: CutItem[] = [];

	constructor(readonly lang: string) {}

	error(code: RenderIssueCode, ref: string, detail: string): void {
		this.issues.push({ code, severity: 'error', ref, detail });
	}

	warn(code: RenderIssueCode, ref: string, detail: string): void {
		this.issues.push({ code, severity: 'warning', ref, detail });
	}

	/** Текст на языке варианта; отсутствие перевода — ошибка, а не подстановка. */
	text(value: I18nText, ref: string): string {
		const resolved = resolveI18n(value, this.lang);
		if (resolved === null) {
			this.error('missing_translation', ref, `нет перевода на «${this.lang}»`);
			return '';
		}
		return resolved;
	}

	/** Значение из справочника рендера; отсутствие — ошибка с точным ключом. */
	directoryValue(map: Record<string, string>, key: string, kind: string): string {
		const value = map[key];
		if (value === undefined || value === '') {
			this.error('missing_directory_entry', key, `в справочнике рендера нет ${kind} «${key}»`);
			return '';
		}
		return value;
	}
}

/**
 * substituteMetrics — подставляет `{{metric.key}}` в текст достижения.
 *
 * Неизвестный ключ — ошибка `unknown_metric`: документ с видимым `{{…}}` внутри не
 * выдаётся вовсе. Непроверяемая `business`-метрика — тоже ошибка: непроверяемое число
 * в резюме опаснее его отсутствия ([ADR-0028]).
 */
function substituteMetrics(
	text: string,
	achievementId: string,
	metrics: Map<string, MetricRecord>,
	ctx: RenderContext,
	evidenceVersion: string | undefined,
): string {
	return text.replace(METRIC_PLACEHOLDER, (_match, key: string) => {
		const metric = metrics.get(key);
		if (!metric) {
			ctx.error('unknown_metric', `${achievementId}:${key}`, `нет записи метрики «${key}»`);
			return '';
		}

		// `manual` — это оценка, а не замер: [ADR-0028] говорит, что в дефолтный набор
		// варианта она не попадает без явного пина. Не блокируем — но владелец обязан
		// узнать, что в отправляемом документе стоит прикидка, а не измеренное число.
		if (metric.source === 'manual') {
			ctx.warn(
				'manual_metric_in_document',
				`${achievementId}:${key}`,
				`метрика «${key}» введена вручную (оценка) — в документе она пойдёт как факт`,
			);
		}

		if (metric.source === 'business' && !metric.verifiable) {
			ctx.error(
				'unverifiable_business_metric',
				`${achievementId}:${key}`,
				`метрика «${key}» не подтверждается внешне`,
			);
			return '';
		}

		// Вариант пинован к замеру; метрика из другого замера — сигнал, что документ
		// соберётся не тем числом, каким собирался раньше. Не блокирует: уже отправленный
		// вариант обязан воспроизводиться как есть.
		if (
			evidenceVersion &&
			metric.source === 'evidence' &&
			metric.evidence_ref?.snapshot_id !== evidenceVersion
		) {
			ctx.warn(
				'evidence_stale',
				`${achievementId}:${key}`,
				`метрика из замера ${metric.evidence_ref?.snapshot_id ?? '—'}, вариант пинован к ${evidenceVersion}`,
			);
		}

		const formatted = formatMetricValue(metric, ctx.lang);
		if (formatted === null) {
			ctx.error('missing_translation', `metric.${key}.display`, `нет перевода на «${ctx.lang}»`);
			return '';
		}
		return formatted;
	});
}

/** Период работы одной строкой: `2024-02 — present`. */
function formatPeriod(
	started: string,
	ended: string | undefined,
	labels: Record<string, string>,
): string {
	return `${started} — ${ended ?? labels.present}`;
}

/** Контекст блока, под которым идут буллеты: позиция или проект. */
interface AchievementScope {
	/** Свежесть владельца буллетов. У проекта её нет — проект не «закончился». */
	freshness: { score: number; label: string } | null;
	/** Кому принадлежат буллеты — для причин в списке выброшенного. */
	ownerRef: string;
	/** Не `null` — буллеты не рендерятся, всё уходит в `cut` с этой причиной. */
	suppressed?: string | null;
}

/** Всё, что нужно рендеру буллетов; собрано в объект, чтобы не тащить восемь аргументов. */
interface AchievementDeps {
	ctx: RenderContext;
	base: CareerBase;
	variant: VariantRecord;
	excluded: Set<string>;
	pinned: Set<string>;
	wanted: Set<string>;
	lines: string[];
}

/**
 * renderAchievements — отбор, ранжирование и вывод буллетов одного блока.
 *
 * Общая для позиций И проектов: раньше эта логика жила только в цикле по позициям, и
 * достижения под проектами не выводились нигде — ни в документе, ни в списке выброшенного.
 * Схема [ADR-0028] прямо разрешает достижению принадлежать проекту, так что это была
 * молчаливая потеря данных, а не ограничение формата.
 */
function renderAchievements(
	own: AchievementRecord[],
	scope: AchievementScope,
	deps: AchievementDeps,
): void {
	const { ctx, base, variant, excluded, pinned, wanted, lines } = deps;

	// Пины идут первыми и лимитом не режутся — это оверрайд владельца поверх балла.
	const scored = own
		.filter((a) => !excluded.has(a.id))
		.map((a) => scoreAchievement(a, wanted, base.metrics, scope.freshness))
		.sort(
			(x, y) =>
				Number(pinned.has(y.achievement.id)) - Number(pinned.has(x.achievement.id)) ||
				y.score - x.score ||
				x.achievement.order - y.achievement.order ||
				x.achievement.id.localeCompare(y.achievement.id),
		);

	for (const a of own.filter((a) => excluded.has(a.id))) {
		ctx.cut.push({
			id: a.id,
			kind: 'achievement',
			reason: 'excluded_by_owner',
			score: 0,
			reasons: ['исключено владельцем'],
		});
	}

	if (scope.suppressed) {
		for (const s of scored) {
			ctx.cut.push({
				id: s.achievement.id,
				kind: 'achievement',
				reason: 'cut_by_form_limit',
				score: s.score,
				reasons: [...s.reasons, scope.suppressed],
			});
		}
		return;
	}

	const kept = scored.slice(0, variant.form.max_bullets_per_position);
	for (const s of scored.slice(variant.form.max_bullets_per_position)) {
		ctx.cut.push({
			id: s.achievement.id,
			kind: 'achievement',
			reason: 'cut_by_score',
			score: s.score,
			reasons: [...s.reasons, `не влезло в max_bullets_per_position (${scope.ownerRef})`],
		});
	}

	if (kept.length > 0) lines.push('');
	for (const s of kept) {
		const raw = ctx.text(s.achievement.text, `achievement.${s.achievement.id}.text`);
		if (LITERAL_NUMBER.test(raw)) {
			ctx.warn(
				'literal_number_in_text',
				s.achievement.id,
				'в тексте достижения число-литерал — его место в записи метрики',
			);
		}
		const text = substituteMetrics(
			raw,
			s.achievement.id,
			base.metrics,
			ctx,
			variant.evidence_version,
		);
		lines.push(`- ${text}`);
	}
}

/**
 * renderResume — собирает вариант резюме в markdown.
 *
 * Порядок: отбор и ранжирование → подстановка метрик → сборка секций. Диагностика
 * копится по ходу; при любой ошибке `markdown` возвращается `null` (fail-closed), но
 * `issues` и `cut` заполнены полностью — владельцу нужно знать ВСЕ проблемы сразу,
 * а не первую попавшуюся.
 */
export function renderResume(
	base: CareerBase,
	variant: VariantRecord,
	directory: RenderDirectory,
	opts: RenderOptions,
): RenderResult {
	const ctx = new RenderContext(variant.lang);
	const labels = SECTION_LABELS[variant.lang];

	if (!labels) {
		ctx.error(
			'unsupported_lang',
			variant.id,
			`шаблон не знает подписей секций для языка «${variant.lang}»`,
		);
		return { markdown: null, issues: ctx.issues, cut: ctx.cut };
	}

	const excluded = new Set(variant.excludes);
	const pinned = new Set(variant.pins);
	const wanted = targetSkillIds(base, variant.target.keywords);

	// ── Шапка ────────────────────────────────────────────────────────────────
	const lines: string[] = [];
	lines.push(`# ${directory.display_name}`);

	if (base.profile) {
		lines.push('');
		lines.push(ctx.text(base.profile.headline, `profile.${base.profile.id}.headline`));

		const setup = WORK_SETUP_LABELS[variant.lang]?.[base.profile.work_setup.mode] ?? '';
		const relocation = base.profile.work_setup.relocation_ready
			? `, ${WORK_SETUP_LABELS[variant.lang]?.relocation ?? ''}`
			: '';
		lines.push(`${base.profile.location} · ${setup}${relocation}`);

		// Контакты: единственное место, где реальные значения вообще появляются (D3).
		const contactLine: string[] = [];
		for (const key of base.profile.contact_keys) {
			const contact = base.contacts.find((c) => c.key === key);
			const required = contact?.render_required ?? false;
			const value = directory.contacts[key];
			if (value === undefined || value === '') {
				if (required) {
					ctx.error('missing_directory_entry', key, `нет значения обязательного контакта «${key}»`);
				} else {
					ctx.warn('missing_directory_entry', key, `нет значения контакта «${key}»`);
				}
				continue;
			}
			contactLine.push(value);
		}
		if (contactLine.length > 0) lines.push(contactLine.join(' · '));

		lines.push('');
		lines.push(`## ${labels.about}`);
		lines.push('');
		lines.push(ctx.text(base.profile.about, `profile.${base.profile.id}.about`));
	}

	// ── Опыт ─────────────────────────────────────────────────────────────────
	const positions = base.positions.filter((p) => !excluded.has(p.id));
	for (const position of base.positions) {
		if (excluded.has(position.id)) {
			ctx.cut.push({
				id: position.id,
				kind: 'position',
				reason: 'excluded_by_owner',
				score: 0,
				reasons: ['исключено владельцем'],
			});
		}
	}

	lines.push('');
	lines.push(`## ${labels.experience}`);

	positions.forEach((position, index) => {
		const detailed = index < variant.form.max_detailed_positions;
		const org = ctx.directoryValue(directory.orgs, position.org_key, 'названия организации');
		const title = ctx.text(position.title, `position.${position.id}.title`);

		lines.push('');
		lines.push(`### ${title} — ${org}`);
		lines.push(formatPeriod(position.started_at, position.ended_at, labels));

		if (position.summary) {
			lines.push('');
			lines.push(ctx.text(position.summary, `position.${position.id}.summary`));
		}

		const freshness = positionFreshness(position, opts.asOf);
		renderAchievements(
			base.achievements.filter((a) => a.position_id === position.id),
			{
				freshness,
				ownerRef: `position ${position.id}`,
				// Позиция за пределами лимита детальных: остаётся строкой, буллеты не идут.
				suppressed: detailed ? null : 'позиция за пределами max_detailed_positions',
			},
			{ ctx, base, variant, excluded, pinned, wanted, lines },
		);
	});

	// ── Проекты ──────────────────────────────────────────────────────────────
	const projects = base.projects.filter((p) => !excluded.has(p.id));
	if (projects.length > 0) {
		lines.push('');
		lines.push(`## ${labels.projects}`);
		for (const project of projects) {
			const name = ctx.text(project.name, `project.${project.id}.name`);
			const link = project.link_key ? directory.links[project.link_key] : undefined;
			lines.push('');
			lines.push(link ? `### [${name}](${link})` : `### ${name}`);
			lines.push(formatPeriod(project.started_at, project.ended_at, labels));
			lines.push('');
			lines.push(ctx.text(project.summary, `project.${project.id}.summary`));

			// Достижения проекта. Раньше их не рендерил НИКТО: цикл по позициям брал только
			// `position_id`, а секция проектов — одно summary. Достижение под проектом
			// исчезало и из документа, и из списка выброшенного — то есть нарушался главный
			// инвариант рендера («молча ничего не режется») ровно там, где схема прямо
			// разрешает достижению принадлежать проекту.
			renderAchievements(
				base.achievements.filter((a) => a.project_id === project.id),
				{ freshness: null, ownerRef: `project ${project.id}` },
				{ ctx, base, variant, excluded, pinned, wanted, lines },
			);
		}
	}

	// ── Навыки ───────────────────────────────────────────────────────────────
	// Только `core` и `working`: список из всего, что когда-либо трогал, не читается.
	const skills = base.skills.filter((s) => s.level !== 'familiar');
	if (skills.length > 0) {
		lines.push('');
		lines.push(`## ${labels.skills}`);
		lines.push('');
		lines.push(skills.map((s) => ctx.text(s.name, `skill.${s.id}.name`)).join(' · '));
	}

	// ── Образование ──────────────────────────────────────────────────────────
	if (base.education.length > 0) {
		lines.push('');
		lines.push(`## ${labels.education}`);
		for (const item of base.education) {
			const institution = ctx.directoryValue(
				directory.institutions,
				item.institution_key,
				'названия учебного заведения',
			);
			const program = ctx.text(item.program, `education.${item.id}.program`);
			// Ссылка на верификацию сертификата — такой же ключ, как контакт: значение
			// подставляется здесь и нигде больше. Раньше чеклист её требовал, а рендер
			// не читал — то есть владельца просили заполнить поле в никуда.
			const credential = item.credential_key ? directory.links[item.credential_key] : undefined;
			const line = `- ${program} — ${institution}, ${formatPeriod(item.started_at, item.ended_at, labels)}`;
			lines.push('');
			lines.push(credential ? `${line} ([${labels.credential}](${credential}))` : line);
		}
	}

	// ── Языки ────────────────────────────────────────────────────────────────
	if (base.languages.length > 0) {
		lines.push('');
		lines.push(`## ${labels.languages}`);
		lines.push('');
		lines.push(
			base.languages.map((l) => `${l.id.toUpperCase()} — ${l.level.toUpperCase()}`).join(' · '),
		);
	}

	const markdown = lines.join('\n') + '\n';

	// Оценка объёма — предупреждением, а не молчаливым обрезанием.
	const estimatedPages = Math.ceil(lines.length / ESTIMATED_LINES_PER_PAGE);
	if (estimatedPages > variant.form.max_pages) {
		ctx.warn(
			'form_overflow_estimate',
			variant.id,
			`оценочно ${estimatedPages} стр. при лимите ${variant.form.max_pages} — ужесточите лимиты варианта`,
		);
	}

	const hasErrors = ctx.issues.some((i) => i.severity === 'error');
	return { markdown: hasErrors ? null : markdown, issues: ctx.issues, cut: ctx.cut };
}

/**
 * formatRenderReport — детерминированный отчёт владельцу о том, что произошло.
 * Выброшенное перечисляется ВСЕГДА: список выброшенного и есть цена отбора.
 */
export function formatRenderReport(result: RenderResult): string {
	const lines: string[] = [];

	if (result.markdown === null) lines.push('Документ не собран: есть блокирующие проблемы.');

	for (const issue of result.issues) {
		const mark = issue.severity === 'error' ? 'ОШИБКА' : 'предупреждение';
		lines.push(`${mark} ${issue.code} (${issue.ref}): ${issue.detail}`);
	}

	for (const item of result.cut) {
		lines.push(
			`выброшено ${item.kind} ${item.id} [${item.reason}, балл ${item.score}]: ${item.reasons.join('; ')}`,
		);
	}

	if (lines.length === 0) lines.push('Документ собран без замечаний.');

	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Что нужно справочнику рендера
// ---------------------------------------------------------------------------

/**
 * DirectoryNeeds — какие КЛЮЧИ должен закрыть gitignored-справочник, чтобы резюме собралось.
 *
 * Только ключи, никаких значений: этот список безопасно показывать в чате и в логе, потому
 * что `org_key` и `contact.key` непрозрачны по построению — они и заведены ради того, чтобы
 * идентифицирующие строки не попадали ни в репозиторий, ни в переписку.
 */
export interface DirectoryNeeds {
	contacts: string[];
	/** Подмножество `contacts`, без которого рендер вернёт ошибку, а не предупреждение. */
	requiredContacts: string[];
	/**
	 * Ключи, заведённые в базе, но НЕ перечисленные в `profile.contact_keys`.
	 *
	 * Рендер шапки читает только `contact_keys`, поэтому такой ключ в документ не попадёт,
	 * сколько его ни заполняй. Владельцу это надо сказать прямо: «завёл контакт, а его нет
	 * в резюме» — ровно та молчаливая пропажа, от которой весь модуль и защищается.
	 */
	orphanContacts: string[];
	orgs: string[];
	institutions: string[];
	links: string[];
}

/**
 * describeDirectoryNeeds — чистая функция: что справочник обязан содержать под эту базу.
 *
 * Считается ИЗ ДАННЫХ, а не из памяти владельца: список ключей меняется вместе с базой,
 * и «я вроде всё заполнил» перестаёт быть предположением.
 */
export function describeDirectoryNeeds(base: CareerBase): DirectoryNeeds {
	const contactKeys = base.profile?.contact_keys ?? [];
	const required = new Set(base.contacts.filter((c) => c.render_required).map((c) => c.key));

	const uniq = (values: (string | undefined)[]): string[] =>
		[...new Set(values.filter((v): v is string => Boolean(v)))].sort();

	const linked = new Set(contactKeys);

	return {
		contacts: uniq(contactKeys),
		requiredContacts: uniq(contactKeys.filter((k) => required.has(k))),
		orphanContacts: uniq(base.contacts.map((c) => c.key).filter((k) => !linked.has(k))),
		orgs: uniq(base.positions.map((p) => p.org_key)),
		institutions: uniq(base.education.map((e) => e.institution_key)),
		links: uniq([
			...base.projects.map((p) => p.link_key),
			...base.education.map((e) => e.credential_key),
		]),
	};
}

/**
 * missingDirectoryEntries — чего в справочнике не хватает прямо сейчас.
 *
 * Возвращает пути вида `orgs.acme`, `contacts.email_primary` — их можно и показать
 * владельцу, и проверить в CI, не раскрывая ни одного значения.
 */
export function missingDirectoryEntries(
	base: CareerBase,
	directory: Partial<RenderDirectory>,
): string[] {
	const needs = describeDirectoryNeeds(base);
	const missing: string[] = [];

	if (!directory.display_name) missing.push('display_name');
	for (const key of needs.contacts) {
		if (!directory.contacts?.[key]) missing.push(`contacts.${key}`);
	}
	for (const key of needs.orgs) {
		if (!directory.orgs?.[key]) missing.push(`orgs.${key}`);
	}
	for (const key of needs.institutions) {
		if (!directory.institutions?.[key]) missing.push(`institutions.${key}`);
	}
	for (const key of needs.links) {
		if (!directory.links?.[key]) missing.push(`links.${key}`);
	}

	return missing;
}
