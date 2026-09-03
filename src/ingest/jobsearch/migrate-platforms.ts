/**
 * migrate-platforms.ts — миграция воронки под реестр площадок ([ADR-0033], R3/R8).
 *
 * Переписывает 436 откликов, 444 компании и 510 событий (реальные цифры на день
 * грумминга — код на них НЕ завязан, см. ниже). Две функции:
 *
 *   - `planMigration(input)` — ЧИСТАЯ функция: сырые записи трёх леджеров → план.
 *     Ничего не читает и не пишет. План содержит и переписанные записи, и отчёт.
 *   - `applyMigration(plan, opts)` — атомарная запись: временный файл рядом с целевым
 *     + `renameSync`. Отказывается писать хоть один байт, если инвариант или финальная
 *     валидация провалились — сперва все проверки, потом (и только потом) запись.
 *
 * Четыре вещи, которые здесь неочевидны:
 *
 *   1. ВХОД — СЫРОЙ JSON, а не типизированные записи. Старые строки хранят значения вне
 *      текущих enum'ов (`submission_channel: linkedin_easy_apply`, `event.kind: note`,
 *      `event.source: manual`) — ИМЕННО ИХ и чинит эта миграция. Прогнать такую строку
 *      через `ApplicationRecordSchema.parse` ДО миграции невозможно: она на этом и упадёт.
 *      Поэтому `planMigration` берёт `Record<string, unknown>[]`, а не `ApplicationRecord[]`.
 *
 *   2. ЧИСЛА ИЗ PRD — ТОЛЬКО ярлык для читателя кода, не литерал для сравнения. Инвариант
 *      миграции — это «столько же записей и то же распределение по стадиям, что и ДО»,
 *      посчитанное `foldAll` из `events.ts` на входе и на выходе ЭТОГО прогона. Сверка с
 *      436/444/510 из PRD на синтетических тестовых данных всегда провалится и ничего не
 *      докажет — контракт цифрами PRD НЕ регулируется нигде в этом файле.
 *
 *   3. ИНВАРИАНТ СЧИТАЕТСЯ ПО РАСПРЕДЕЛЕНИЮ, А НЕ ПО ПАРАМ id. У отклика после миграции
 *      почти всегда новый id (площадка+внешний id), поэтому сравнивать «стадия отклика X
 *      до» со «стадией отклика X после» бессмысленно — X больше не существует под этим
 *      именем. Сравнивается ГИСТОГРАММА (сколько откликов на каждой стадии), а связь
 *      «эти же события у того же отклика» обеспечивается тем, что `application_id` у
 *      событий переписывается ТОЙ ЖЕ картой алиасов, что и id самого отклика.
 *
 *   4. НИЧЕГО НЕ УДАЛЯЕТСЯ И НЕ СХЛОПЫВАЕТСЯ. Слияние компаний по домену не убирает ни
 *      одной строки `companies.jsonl` — оно только унифицирует значение `id` во ВСЕХ
 *      строках с одним доменом и переписывает `application.company_id`. Количество строк
 *      до и после равно по построению; инвариант это ещё и проверяет кодом, не только
 *      предполагает.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertPathAllowed, resolvePublicRepo } from '../ledger.js';
import {
	companyIdFromDomain,
	normalizeDomain,
	CompanyRecordSchema,
	DISCOVERY_PLATFORM_IDS,
	PLATFORM_IDS,
	type CompanyRecord,
	type PlatformId,
} from './companies.js';
import {
	ApplicationEventSchema,
	ApplicationRecordSchema,
	foldAll,
	type ApplicationEvent,
	type ApplicationRecord,
} from './events.js';
import { JOBSEARCH_LEDGER_FILES, resolveJobsearchDir } from './ledger.js';

// ---------------------------------------------------------------------------
// Разбор ссылки на вакансию
// ---------------------------------------------------------------------------

/**
 * Буквенный префикс внешнего id ([ADR-0031] §4, [ADR-0033] §2): голое число в свободном
 * тексте маскируется санитайзером как телефон. `site`/`email` не получают префикс —
 * у длинного хвоста карьерных страниц и у писем внешнего id вакансии не существует.
 */
const EXTERNAL_ID_PREFIX: Partial<Record<PlatformId, string>> = {
	hh: 'hh',
	linkedin: 'li',
	ashby: 'as',
	greenhouse: 'gh',
	lever: 'lv',
	join: 'jn',
	smartrecruiters: 'sr',
	workable: 'wk',
	icims: 'ic',
};

/** Домен → площадка. Порядок важен: более специфичные правила первыми. */
const DOMAIN_RULES: ReadonlyArray<{ platform: PlatformId; test: (domain: string) => boolean }> = [
	{ platform: 'linkedin', test: (d) => d === 'linkedin.com' || d.endsWith('.linkedin.com') },
	{ platform: 'hh', test: (d) => d === 'hh.ru' || d.endsWith('.hh.ru') },
	{ platform: 'ashby', test: (d) => d.endsWith('ashbyhq.com') },
	{ platform: 'greenhouse', test: (d) => d.endsWith('greenhouse.io') },
	{ platform: 'lever', test: (d) => d.endsWith('lever.co') },
	{ platform: 'join', test: (d) => d === 'join.com' || d.endsWith('.join.com') },
	{ platform: 'smartrecruiters', test: (d) => d.endsWith('smartrecruiters.com') },
	{ platform: 'workable', test: (d) => d.endsWith('workable.com') },
	{ platform: 'icims', test: (d) => d.endsWith('icims.com') },
];

/** Домены вне таблицы — длинный хвост карьерных страниц компаний ([ADR-0033] §1). */
function platformFromDomain(domain: string): PlatformId {
	for (const rule of DOMAIN_RULES) if (rule.test(domain)) return rule.platform;
	return 'site';
}

/**
 * ATS_PLATFORM_IDS — площадки, чья ссылка на вакансию физически совпадает с формой подачи
 * (находка ревью, [ADR-0033] §2). Aggregator/network ({@link DISCOVERY_PLATFORM_IDS}: hh,
 * linkedin) — это место НАХОДКИ вакансии, а не подачи формы; `site`/`email` — тоже не про
 * подачу через саму ссылку (длинный хвост карьерных страниц и почта ничего не гарантируют).
 * Единственный класс, где «нашёл здесь» надёжно значит «подал здесь», — ATS: там ссылка на
 * вакансию и есть страница с формой.
 */
const ATS_PLATFORM_IDS = new Set<PlatformId>(
	PLATFORM_IDS.filter(
		(id) => id !== 'site' && id !== 'email' && !DISCOVERY_PLATFORM_IDS.some((p) => p === id),
	),
);

/** Разбор одного `vacancy_ref` в поля отклика. */
export interface ParsedVacancyRef {
	platform?: PlatformId;
	externalId?: string;
	/** URL без query. Отсутствует у формы тега — там ссылки не было вовсе. */
	url?: string;
}

const TAG_PATTERN = /^([a-z]+):(.+)$/i;

/**
 * meaningfulPathSegment — значащий сегмент пути вакансии, а не слепой хвост (находка
 * ревью, [ADR-0033] §5). У iCIMS путь ВСЕГДА кончается литералом `/job`
 * (`.../jobs/<N>/human-readable-title/job`) — три разных отклика в три разных компании
 * получили один и тот же external_id `icjob`, если брать последний сегмент не глядя. Для
 * площадок без такой оговорки последний сегмент по-прежнему годится (hh, linkedin — id там
 * и есть последний сегмент, это уже покрыто тестами ниже).
 */
function meaningfulPathSegment(platform: PlatformId, segments: string[]): string | undefined {
	if (platform === 'icims') {
		const jobsIndex = segments.findIndex((s) => s.toLowerCase() === 'jobs');
		if (jobsIndex !== -1 && segments[jobsIndex + 1]) return segments[jobsIndex + 1];
		// Форма пути не совпала с ожидаемой — берём первый чисто числовой сегмент, а не
		// хвост: id вакансии у iCIMS всегда число, а хвост почти всегда `job`.
		return segments.find((s) => /^\d+$/.test(s));
	}
	return segments.length > 0 ? segments[segments.length - 1] : undefined;
}

/**
 * parseVacancyRef — детерминированный разбор старого `vacancy_ref` ([ADR-0033] §5).
 *
 * Две формы старых данных:
 *   - тег `platform:внешний_id` (площадка называется напрямую, без URL);
 *   - URL вакансии (площадка выводится из домена, внешний id — из значащего сегмента пути,
 *     см. {@link meaningfulPathSegment} — это не всегда последний сегмент).
 *
 * Пустая или неразбираемая ссылка не выбрасывает исключение: она возвращает `{}`,
 * а вызывающий сам решает, куда записать «не разобрано» ([ADR-0033] §5 — миграция
 * ОБЯЗАНА иметь дело с реальными данными, а не падать на первой странной строке).
 */
export function parseVacancyRef(ref: string | undefined): ParsedVacancyRef {
	if (!ref) return {};
	const trimmed = ref.trim();
	if (!trimmed) return {};

	// `TAG_PATTERN` матчит и URL со схемой (`https://...` — prefix тоже "похож на тег":
	// `https`, хвост `//hh.ru/...`), поэтому тег-ветка обязана применяться ТОЛЬКО когда
	// строка НЕ является URL со схемой http(s) — иначе она перехватывала бы любую ссылку
	// раньше домена ниже.
	const looksLikeUrl = /^https?:\/\//.test(trimmed);
	const tagMatch = looksLikeUrl ? null : TAG_PATTERN.exec(trimmed);
	if (tagMatch) {
		const prefix = tagMatch[1]!.toLowerCase();
		if ((PLATFORM_IDS as readonly string[]).includes(prefix)) {
			const platform = prefix as PlatformId;
			const idPrefix = EXTERNAL_ID_PREFIX[platform];
			const rawId = tagMatch[2]!.trim().replace(/[^a-zA-Z0-9._-]/g, '');
			return { platform, externalId: idPrefix && rawId ? `${idPrefix}${rawId}` : undefined };
		}
		// Незнакомый префикс тега (`epam:`, `jazzhr:`, ...) — та же лестница, что и у ветки
		// домена ниже: неизвестное схлопывается в `site` БЕЗ external_id, а площадку не
		// теряет вовсе (находка ревью, [ADR-0033] §1). Продолжать в разбор домена нельзя:
		// `prefix:rest` почти никогда не парсится как URL, и `normalizeDomain` на нём просто
		// вернёт `null` — тогда функция потеряла бы даже то, что уже знает (это тег с
		// известной структурой, а не мусор).
		return { platform: 'site' };
	}

	const domain = normalizeDomain(trimmed);
	if (!domain) return {};

	const platform = platformFromDomain(domain);
	try {
		const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
		const parsed = new URL(withScheme);
		const url = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '') || parsed.origin;
		const segments = parsed.pathname.split('/').filter(Boolean);
		const last = meaningfulPathSegment(platform, segments);
		const idPrefix = EXTERNAL_ID_PREFIX[platform];
		const rawId = last ? decodeURIComponent(last).replace(/[^a-zA-Z0-9._-]/g, '') : '';
		const externalId = idPrefix && rawId ? `${idPrefix}${rawId}` : undefined;
		return { platform, url, externalId };
	} catch {
		// URL не собрался (битая ссылка в старых данных) — площадку уже знаем по домену,
		// остальное оставляем неразобранным, а не роняем всю миграцию.
		return { platform };
	}
}

// ---------------------------------------------------------------------------
// Общие типы плана
// ---------------------------------------------------------------------------

/** Сырая строка леджера — до и вместо валидации: см. пункт 1 в шапке файла. */
export type RawRecord = Record<string, unknown>;

export interface MigrationInputRecords {
	companies: RawRecord[];
	applications: RawRecord[];
	events: RawRecord[];
}

export interface AliasEntry {
	from: string;
	to: string;
}

export interface CompanySlugCollision {
	/** Слаг, который без разрешения коллизии достался бы всем доменам разом. */
	baseId: string;
	/** Кому что реально досталось после разрешения (первый по алфавиту домена — baseId). */
	assignments: Array<{ domain: string; id: string }>;
}

export interface RepeatApplication {
	/** id, под которым повтор реально записан (с суффиксом `-rN`). */
	assignedId: string;
	/** Базовый id (площадка+внешний id) — общий для всех откликов на ту же вакансию. */
	baseId: string;
	/** Старый id записи-повтора (до миграции). */
	originalId: string;
	appliedAt: string;
}

export type NormalizationRule =
	| 'submission_channel_easy_apply'
	| 'submission_channel_company_site'
	| 'submission_channel_email'
	| 'event_source_normalized'
	| 'event_kind_note_to_touchpoint'
	| 'event_touchpoint_missing_touch_kind'
	| 'company_remote_mode_normalized'
	| 'company_stage_normalized'
	| 'company_type_normalized'
	| 'company_interview_language_normalized'
	| 'event_reason_note_null_removed'
	| 'event_id_synthesized';

export interface NormalizationNote {
	rule: NormalizationRule;
	recordType: 'company' | 'application' | 'event';
	/** id записи ПОСЛЕ миграции (устойчивее для поиска в отчёте, чем старый). */
	id: string;
	from: unknown;
	to: unknown;
}

export interface UnparsedVacancyRef {
	applicationId: string;
	vacancyRef: string;
}

export interface ValidationFailure {
	recordType: 'company' | 'application' | 'event';
	id: string;
	message: string;
}

export interface MigrationInvariant {
	before: { companies: number; applications: number; events: number; stageCounts: Record<string, number> };
	after: { companies: number; applications: number; events: number; stageCounts: Record<string, number> };
	ok: boolean;
	mismatches: string[];
}

export interface MigrationReport {
	companyAliases: AliasEntry[];
	companySlugCollisions: CompanySlugCollision[];
	applicationAliases: AliasEntry[];
	repeatApplications: RepeatApplication[];
	eventApplicationIdRewrites: Array<{ eventId: string; from: string; to: string }>;
	normalizations: NormalizationNote[];
	unparsedVacancyRefs: UnparsedVacancyRef[];
	validationErrors: ValidationFailure[];
	invariant: MigrationInvariant;
	/** Отчёт человеку — то, что печатает и сохраняет CLI. Структурные поля выше — для кода. */
	lines: string[];
}

export interface MigrationPlan {
	companies: CompanyRecord[];
	applications: ApplicationRecord[];
	events: ApplicationEvent[];
	report: MigrationReport;
}

// ---------------------------------------------------------------------------
// Мелкие чистые помощники
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

/**
 * stageHistogram — распределение по ПОСЛЕДНЕЙ стадии, тем же `foldAll`, что и отчёт
 * воронки. `_none` — отклики без единого `stage_change` (историческая ситуация, которую
 * `ApplicationState.stage: null` и отражает).
 */
function stageHistogram(
	applications: ApplicationRecord[],
	events: ApplicationEvent[],
): Record<string, number> {
	const states = foldAll(applications, events);
	const hist: Record<string, number> = {};
	for (const state of states.values()) {
		const key = state.stage ?? '_none';
		hist[key] = (hist[key] ?? 0) + 1;
	}
	return hist;
}

/**
 * diffCounts — расхождения распределения по стадиям, с одним разрешённым исключением.
 *
 * Буквальное «до == после» здесь оказалось СЛИШКОМ строгим, и это не послабление, а
 * уточнение того, что инвариант вообще охраняет. Стадия считается фолдом по `application.id`,
 * а до миграции два разных отклика на одну вакансию делили один id — второй в воронке просто
 * не existовал. Суффикс `-rN` их разводит, и стадия честно прибавляет ровно столько, сколько
 * откликов миграция сделала видимыми.
 *
 * Поэтому проверяется не равенство, а два условия: ни одна стадия не УБАВИЛАСЬ (потеря
 * запрещена всегда) и суммарная прибавка равна числу разведённых повторов (появление
 * запрещено, если его нечем объяснить). Число `allowedGrowth` приходит из плана, а не
 * подбирается под результат.
 */
export function diffStageCounts(
	before: Record<string, number>,
	after: Record<string, number>,
	allowedGrowth: number,
): string[] {
	const mismatches: string[] = [];
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	let growth = 0;
	for (const key of keys) {
		const b = before[key] ?? 0;
		const a = after[key] ?? 0;
		if (a < b) mismatches.push(`стадия ${key}: было ${b}, стало ${a} — стадия потеряна`);
		else growth += a - b;
	}
	if (growth !== allowedGrowth) {
		mismatches.push(
			`распределение по стадиям выросло на ${growth}, а разведённых повторов ${allowedGrowth} — ` +
				'прибавку нечем объяснить',
		);
	}
	return mismatches;
}

// ---------------------------------------------------------------------------
// Нормализация значений компаний
// ---------------------------------------------------------------------------

/**
 * COMPANY_VALUE_SYNONYMS — оставшиеся старые значения `assessed(...).value` четырёх полей
 * компании вне текущих словарей ([D4]/[ADR-0029]: словари закрытые, новых членов не
 * заводим). ОДНО правило на всю таблицу, а не своё для каждой строки:
 *
 *   - значение, которое является СИНОНИМОМ уже существующего члена словаря, приводится к
 *     нему (`remote_global`/`remote_worldwide` — то же самое, что `remote_100`: оба прямо
 *     называют отсутствие гео-привязки, просто другим словом; `remote_eu`/`remote_country`
 *     — то же самое, что `remote_country_bound`);
 *   - значение, из которого нужный факт НЕ следует, уходит в штатный `unknown`/`other`, а
 *     не додумывается: `private` не говорит, какой раунд у компании; `product`/`scaleup`
 *     не говорят, какого она размера (словарь `company_type` различает продуктовые компании
 *     именно по размеру); голое `remote` И `remote_first` не говорят, какой из трёх режимов
 *     (wfa/remote_100/remote_country_bound) имелся в виду — `remote_first` называет
 *     ПОЛИТИКУ компании («по умолчанию удалённо»), а не гео-охват, и remote-first компания
 *     вполне может при этом требовать привязку к стране (находка ревью: 19 из 444 записей);
 *     `es`/`it` — читаемые языки интервью, для которых словарь не заводит отдельных членов,
 *     а `other` под них и существует.
 *
 * Патчится ТОЛЬКО `.value` — `source`/`confirmed_at`/`confirmed_by_human` остаются как в
 * исходной записи: это происхождение факта, а не сам факт, и переименование значения его
 * не меняет.
 */
const COMPANY_VALUE_SYNONYMS: ReadonlyArray<{
	field: 'remote_mode' | 'stage' | 'company_type' | 'interview_language';
	rule: NormalizationRule;
	from: string;
	to: string;
}> = [
	{ field: 'remote_mode', rule: 'company_remote_mode_normalized', from: 'remote_global', to: 'remote_100' },
	{
		field: 'remote_mode',
		rule: 'company_remote_mode_normalized',
		from: 'remote_eu',
		to: 'remote_country_bound',
	},
	{
		field: 'remote_mode',
		rule: 'company_remote_mode_normalized',
		from: 'remote_country',
		to: 'remote_country_bound',
	},
	// remote_worldwide — синоним remote_100 (та же «без гео-привязки», другое слово).
	{ field: 'remote_mode', rule: 'company_remote_mode_normalized', from: 'remote_worldwide', to: 'remote_100' },
	// remote и remote_first — ни один из трёх реальных режимов (wfa/remote_100/
	// remote_country_bound) из этих слов не следует; remote_first говорит про ПОЛИТИКУ
	// (удалёнка по умолчанию), а не про гео-охват, и remote-first компания вполне может
	// требовать привязку к стране. Додумывать который из трёх — выдумывать факт (находка
	// ревью: 19 из 444 записей).
	{ field: 'remote_mode', rule: 'company_remote_mode_normalized', from: 'remote', to: 'unknown' },
	{ field: 'remote_mode', rule: 'company_remote_mode_normalized', from: 'remote_first', to: 'unknown' },
	{ field: 'stage', rule: 'company_stage_normalized', from: 'series_b', to: 'series_b_plus' },
	{ field: 'stage', rule: 'company_stage_normalized', from: 'series_c', to: 'series_b_plus' },
	{ field: 'stage', rule: 'company_stage_normalized', from: 'early', to: 'seed' },
	{ field: 'stage', rule: 'company_stage_normalized', from: 'pre_seed_seed', to: 'seed' },
	{ field: 'stage', rule: 'company_stage_normalized', from: 'private', to: 'unknown' },
	{ field: 'company_type', rule: 'company_type_normalized', from: 'product_startup', to: 'startup' },
	{
		field: 'company_type',
		rule: 'company_type_normalized',
		from: 'agency_outsourcing',
		to: 'outsourcing_outstaff',
	},
	{ field: 'company_type', rule: 'company_type_normalized', from: 'product', to: 'unknown' },
	// scaleup — как и product: про размер продуктовой компании (smb/enterprise) ничего не
	// говорит, размер додумывать значит выдумывать факт.
	{ field: 'company_type', rule: 'company_type_normalized', from: 'scaleup', to: 'unknown' },
	{ field: 'interview_language', rule: 'company_interview_language_normalized', from: 'es', to: 'other' },
	{ field: 'interview_language', rule: 'company_interview_language_normalized', from: 'it', to: 'other' },
] as const;

const COMPANY_VALUE_SYNONYM_MAP = new Map(
	COMPANY_VALUE_SYNONYMS.map((entry) => [`${entry.field}:${entry.from}`, entry]),
);

/**
 * normalizeCompanyValues — применяет {@link COMPANY_VALUE_SYNONYMS} к одной сырой записи
 * компании. Возвращает патч (только затронутые поля) и попутно пишет заметки в отчёт —
 * тем же способом, что и остальные нормализации этого файла.
 */
function normalizeCompanyValues(
	raw: RawRecord,
	companyId: string,
	normalizations: NormalizationNote[],
): RawRecord {
	const patch: RawRecord = {};
	for (const field of ['remote_mode', 'stage', 'company_type', 'interview_language'] as const) {
		const wrapper = raw[field];
		if (!wrapper || typeof wrapper !== 'object') continue;
		const current = (wrapper as RawRecord).value;
		if (typeof current !== 'string') continue;
		const entry = COMPANY_VALUE_SYNONYM_MAP.get(`${field}:${current}`);
		if (!entry) continue;
		patch[field] = { ...(wrapper as RawRecord), value: entry.to };
		normalizations.push({ rule: entry.rule, recordType: 'company', id: companyId, from: current, to: entry.to });
	}
	return patch;
}

// ---------------------------------------------------------------------------
// Синтез id события
// ---------------------------------------------------------------------------

const SLUG_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]*$/;

/** Тот же контракт, что и `slugId` в `events.ts`/`companies.ts` (схема не экспортирует regex). */
function isValidSlugId(value: unknown): value is string {
	return typeof value === 'string' && value.length >= 1 && value.length <= 64 && SLUG_ID_PATTERN.test(value);
}

/**
 * synthesizeEventId — детерминированный id для события без валидного `id` (пусто, `null`
 * или длиннее 64 символов — реальный случай в леджере: три события со старым id
 * `<application_id>-<stage>` без обрезки, физически невалидным по схеме).
 *
 * Правило — то же самое, что уже видно на остальных id в файле (например
 * `freedom24-senior-php-developer-relocation-to-cyprus-billing-appl`, обрезанный ровно на
 * границе 64 символов): `<application_id>-<stage>` (или `<application_id>-<touch_kind>` для
 * касания), обрезка ДО 64 символов, а при коллизии с уже занятым id — числовой суффикс
 * `-N`, который откусывает место у базовой строки, чтобы итог остался в лимите. Это НЕ
 * `eventId` из `src/bridge/jobsearch-intent.ts` (там — хэш содержимого для идемпотентности
 * интентов владельца) — у исторических записей этого леджера другое соглашение об id, и
 * синтез обязан совпасть с НИМ, а не завести третье.
 */
function synthesizeEventId(base: string, used: Set<string>): string {
	const truncatedBase = base.slice(0, 64);
	let candidate = truncatedBase;
	let n = 0;
	while (used.has(candidate)) {
		const suffix = `-${n}`;
		candidate = `${truncatedBase.slice(0, 64 - suffix.length)}${suffix}`;
		n++;
	}
	return candidate;
}

// ---------------------------------------------------------------------------
// planMigration
// ---------------------------------------------------------------------------

/**
 * planMigration — сырые записи трёх леджеров → план миграции. Ничего не читает и не
 * пишет на диск: источник данных и запись — забота вызывающего (CLI-скрипт).
 */
export function planMigration(input: MigrationInputRecords): MigrationPlan {
	// «До» считаем на входе как есть: foldAll трогает только id/application_id/kind/stage/
	// ts/reason_code/scheduled_at/void_id/amended_id — эти поля старые данные уже несут
	// корректно (миграция чинит другие поля), так что приведение типов здесь безопасно.
	const beforeStageCounts = stageHistogram(
		input.applications as ApplicationRecord[],
		input.events as ApplicationEvent[],
	);

	// ---- 1. Компании: канонический id = slug(домена), слияние дублей по домену ----
	const domainToCanonical = new Map<string, string>();
	for (const raw of input.companies) {
		const domain = isNonEmptyString(raw.site_domain) ? raw.site_domain.trim() : null;
		if (!domain || domainToCanonical.has(domain)) continue;
		const normalized = normalizeDomain(domain) ?? domain;
		domainToCanonical.set(domain, companyIdFromDomain(normalized));
	}

	// Коллизия: два РАЗНЫХ домена дали один и тот же слаг. Редкость, но нельзя молча
	// склеить две разные компании — разруливаем детерминированно (первый по алфавиту
	// домена оставляет чистый id, остальные получают числовой суффикс) и громко пишем в отчёт.
	const domainsByCanonical = new Map<string, string[]>();
	for (const [domain, canonical] of domainToCanonical) {
		const list = domainsByCanonical.get(canonical) ?? [];
		list.push(domain);
		domainsByCanonical.set(canonical, list);
	}
	const companySlugCollisions: CompanySlugCollision[] = [];
	for (const [canonical, domains] of domainsByCanonical) {
		if (domains.length <= 1) continue;
		const sorted = [...domains].sort();
		const assignments = sorted.map((domain, index) => ({
			domain,
			id: index === 0 ? canonical : `${canonical}-${index + 1}`,
		}));
		for (const { domain, id } of assignments) domainToCanonical.set(domain, id);
		companySlugCollisions.push({ baseId: canonical, assignments });
	}

	// Карта «старый id компании → новый»: последняя ПО ts запись на данный старый id
	// решает, каким доменом он в итоге считается ([D: latest wins], как у dedupeCompanies).
	const companyIdMap = new Map<string, string>();
	const companiesByTs = [...input.companies].sort((a, b) =>
		String(a.ts ?? '').localeCompare(String(b.ts ?? '')),
	);
	for (const raw of companiesByTs) {
		const oldId = isNonEmptyString(raw.id) ? raw.id : undefined;
		const domain = isNonEmptyString(raw.site_domain) ? raw.site_domain.trim() : null;
		if (!oldId || !domain) continue;
		const canonical = domainToCanonical.get(domain);
		if (canonical) companyIdMap.set(oldId, canonical);
	}

	const companyAliasSeen = new Set<string>();
	const companyAliases: AliasEntry[] = [];
	const migratedCompanies: CompanyRecord[] = [];
	const validationErrors: ValidationFailure[] = [];
	// Общий на все три леджера — объявлен здесь (а не в секции откликов, как раньше),
	// потому что нормализация значений компаний тоже пишет в него, а компании мигрируют
	// первыми.
	const normalizations: NormalizationNote[] = [];

	for (const raw of input.companies) {
		const oldId = isNonEmptyString(raw.id) ? raw.id : '';
		const newId = companyIdMap.get(oldId) ?? oldId;
		if (oldId && newId !== oldId && !companyAliasSeen.has(oldId)) {
			companyAliasSeen.add(oldId);
			companyAliases.push({ from: oldId, to: newId });
		}
		const valuePatch = normalizeCompanyValues(raw, newId, normalizations);
		const candidate = { ...raw, ...valuePatch, id: newId };
		const parsed = CompanyRecordSchema.safeParse(candidate);
		if (parsed.success) {
			migratedCompanies.push(parsed.data);
		} else {
			validationErrors.push({
				recordType: 'company',
				id: newId || oldId || '(без id)',
				message: parsed.error.message,
			});
			migratedCompanies.push(candidate as CompanyRecord);
		}
	}

	// ---- 2. Отклики: разбор vacancy_ref, нормализация submission_channel, новый id ----
	interface AppWork {
		oldId: string;
		candidate: RawRecord;
		externalId?: string;
		/**
		 * Финальный (после переноса по карте алиасов) id компании. Нужен, чтобы отличать
		 * повтор (тот же работодатель, та же вакансия) от коллизии external_id между
		 * РАЗНЫМИ работодателями (находка ревью, [ADR-0033] §4) — см. группировку
		 * occurrences ниже.
		 */
		companyId?: string;
		appliedAt: string;
		/** Для «latest wins» внутри перезаписи ([D: latest wins], как у dedupeCompanies). */
		ts: string;
	}

	const unparsedVacancyRefs: UnparsedVacancyRef[] = [];
	const works: AppWork[] = [];

	for (const raw of input.applications) {
		const oldId = isNonEmptyString(raw.id) ? raw.id : '';
		const patch: RawRecord = {};

		// company_id — по карте алиасов компаний.
		if (isNonEmptyString(raw.company_id) && companyIdMap.has(raw.company_id)) {
			patch.company_id = companyIdMap.get(raw.company_id);
		}

		// vacancy_ref → platform / external_id / url. Явные значения (если уже есть) не
		// перезаписываются: вывод из ссылки — только для того, чего в записи ещё нет.
		const ref = isNonEmptyString(raw.vacancy_ref) ? raw.vacancy_ref.trim() : undefined;
		const parsedRef = parseVacancyRef(ref);
		if (parsedRef.platform && !isNonEmptyString(raw.platform)) patch.platform = parsedRef.platform;
		if (parsedRef.externalId && !isNonEmptyString(raw.external_id)) {
			patch.external_id = parsedRef.externalId;
		}
		if (parsedRef.url && !isNonEmptyString(raw.url)) patch.url = parsedRef.url;
		if (ref && !parsedRef.platform) unparsedVacancyRefs.push({ applicationId: oldId, vacancyRef: ref });

		// submission_channel — старые значения вне текущего enum превращаются в способ +
		// applied_via ([ADR-0033] §2, R2). Явный applied_via, если уже есть, не трогаем.
		const channel = raw.submission_channel;
		let appliedViaFromChannel: PlatformId | undefined;
		let rule: NormalizationRule | undefined;
		if (channel === 'linkedin_easy_apply') {
			patch.submission_channel = 'direct';
			appliedViaFromChannel = 'linkedin';
			rule = 'submission_channel_easy_apply';
		} else if (channel === 'company_site') {
			patch.submission_channel = 'direct';
			appliedViaFromChannel = 'site';
			rule = 'submission_channel_company_site';
		} else if (channel === 'email') {
			patch.submission_channel = 'direct';
			appliedViaFromChannel = 'email';
			rule = 'submission_channel_email';
		}
		if (rule) {
			normalizations.push({
				rule,
				recordType: 'application',
				id: oldId,
				from: channel,
				to: patch.submission_channel,
			});
		}

		// applied_via: явное значение > способ подачи из submission_channel > ссылка на
		// ATS (находка ревью, [ADR-0033] §2). ПЛОЩАДКА НАХОДКИ — не площадка подачи для
		// aggregator/network (hh, linkedin): 21 отклик реально подал форму в LinkedIn
		// (submission_channel: linkedin_easy_apply, читается через appliedViaFromChannel
		// выше), а 167 — нашли вакансию в LinkedIn, но подали НЕ через её форму; молчаливое
		// «подали там же, где нашли» стёрло бы единственный факт, который старые данные ещё
		// различали. Для ATS ссылка НАДЁЖНЕЕ: страница вакансии ashby/greenhouse/... это и
		// есть форма подачи, там площадка находки и подачи физически совпадают. Без сигнала
		// поле остаётся пустым — пусто честнее домысла.
		if (!isNonEmptyString(raw.applied_via)) {
			if (appliedViaFromChannel) patch.applied_via = appliedViaFromChannel;
			else if (parsedRef.platform && ATS_PLATFORM_IDS.has(parsedRef.platform)) {
				patch.applied_via = parsedRef.platform;
			}
		}

		const candidate: RawRecord = { ...raw, ...patch };
		const externalId = isNonEmptyString(candidate.external_id) ? candidate.external_id : undefined;
		const companyId = isNonEmptyString(candidate.company_id) ? candidate.company_id : undefined;
		const appliedAt = isNonEmptyString(raw.applied_at) ? raw.applied_at : String(raw.ts ?? '');
		works.push({
			oldId,
			candidate,
			externalId,
			companyId,
			appliedAt,
			ts: isNonEmptyString(raw.ts) ? raw.ts : appliedAt,
		});
	}

	// Новый id: <external_id> напрямую (сам уже несёт буквенный префикс площадки, второй
	// разделённый префикс не добавляем — так же, как уже сделано в hh.ts). Повторный
	// отклик на ТУ ЖЕ вакансию (тот же external_id, ТОТ ЖЕ работодатель) получает суффикс
	// `-rN` по порядку подачи ([ADR-0033] §4). Без внешнего id — старый id остаётся как есть.
	//
	// ПЕРЕЗАПИСЬ vs ПОВТОРНЫЙ ОТКЛИК. Леджер append-only: несколько строк с одним старым
	// id — необязательно два разных отклика. Строки с одним старым id И одним applied_at —
	// перезаписи ОДНОЙ записи (правка задним числом; содержимое решает строка с самым
	// поздним ts, [D: latest wins], как у dedupeCompanies), им положен ОДИН новый id без
	// суффикса, и это не коллизия. Строки с одним старым id, но РАЗНЫМ applied_at — вправду
	// повторный отклик (подал снова спустя время); старый id у него просто исторически
	// совпал с прошлым, и такая пара «occurrence» разруливается -rN логикой ниже наравне с
	// откликами на разные старые id. Поэтому единица группировки здесь — occurrence
	// (oldId + applied_at), а не сырая строка и не голый oldId.
	//
	// ПОВТОР vs КОЛЛИЗИЯ (находка ревью). Одинаковый external_id при РАЗНЫХ company_id — не
	// повтор: повтор значит тот же работодатель и та же вакансия, а два разных работодателя
	// с одним external_id — это либо совпадение id-пространств разных ATS, либо брак
	// разбора ссылки. Группировка ниже поэтому идёт по паре (external_id, company_id), а не
	// по голому external_id: чужих работодателей в одну -rN цепочку не смешивает. Если при
	// этом два независимых chain'а всё равно претендуют на один и тот же итоговый id — это
	// ловит проверка инъективности applicationIdMap чуть ниже, а не -rN логика (для такой
	// пары она и не должна срабатывать).
	interface Occurrence {
		oldId: string;
		appliedAt: string;
		externalId?: string;
		companyId?: string;
		works: AppWork[];
	}
	const occurrenceKey = (oldId: string, appliedAt: string): string => `${oldId} ${appliedAt}`;

	const occurrences = new Map<string, Occurrence>();
	const occurrencesByOldId = new Map<string, Occurrence[]>();
	for (const work of works) {
		const key = occurrenceKey(work.oldId, work.appliedAt);
		let occurrence = occurrences.get(key);
		if (!occurrence) {
			occurrence = { oldId: work.oldId, appliedAt: work.appliedAt, works: [] };
			occurrences.set(key, occurrence);
			const list = occurrencesByOldId.get(work.oldId) ?? [];
			list.push(occurrence);
			occurrencesByOldId.set(work.oldId, list);
		}
		occurrence.works.push(work);
	}
	for (const occurrence of occurrences.values()) {
		const latest = occurrence.works.reduce((best, w) => (w.ts >= best.ts ? w : best));
		occurrence.externalId = latest.externalId;
		occurrence.companyId = latest.companyId;
	}

	const applicationIdMap = new Map<string, string>(); // occurrenceKey → новый id
	const repeatApplications: RepeatApplication[] = [];
	const byExternalIdAndCompany = new Map<string, Occurrence[]>();
	for (const occurrence of occurrences.values()) {
		if (!occurrence.externalId) {
			applicationIdMap.set(occurrenceKey(occurrence.oldId, occurrence.appliedAt), occurrence.oldId);
			continue;
		}
		const groupKey = `${occurrence.externalId}::${occurrence.companyId ?? ''}`;
		const group = byExternalIdAndCompany.get(groupKey) ?? [];
		group.push(occurrence);
		byExternalIdAndCompany.set(groupKey, group);
	}
	for (const group of byExternalIdAndCompany.values()) {
		const externalId = group[0]!.externalId!;
		const ordered = [...group].sort(
			(a, b) => a.appliedAt.localeCompare(b.appliedAt) || a.oldId.localeCompare(b.oldId),
		);
		ordered.forEach((occurrence, index) => {
			const assignedId = index === 0 ? externalId : `${externalId}-r${index + 1}`;
			applicationIdMap.set(occurrenceKey(occurrence.oldId, occurrence.appliedAt), assignedId);
			if (index > 0) {
				repeatApplications.push({
					assignedId,
					baseId: externalId,
					originalId: occurrence.oldId,
					appliedAt: occurrence.appliedAt,
				});
			}
		});
	}

	// ---- Рост распределения и инъективность: поимённо, а не глобальным скаляром ----
	//
	// Названная ошибка ревью: `allowedGrowth = repeatApplications.length` — глобальный
	// скаляр, не привязанный к тому, ГДЕ распределение выросло. `repeatApplications`
	// отвечает на вопрос «какой id досталась цепочке ПРИСВОЕНИЯ выше» (группировка по
	// external_id+company_id — нужна ради самой строки, которая запишется). Рост
	// распределения — другой вопрос: «сколько СЛОТОВ видел foldAll до миграции», а он
	// ключуется по `application.id` (`events.ts`, `foldAll`: `result.set(app.id, ...)`) —
	// несколько строк с ОДНИМ старым id схлопываются в ОДИН слот независимо от того, на
	// одну они вакансию или на разные. Поэтому рост считается ДРУГОЙ группировкой — по
	// самому старому id (`occurrencesByOldId`, уже построена выше для resolveApplicationId
	// ниже) — а не по цепочке присвоения; путать их и есть та ошибка, которую чинит блок.
	//
	// Доказательство расхождения — повторный (идемпотентный) прогон по уже мигрированным
	// данным: `vacancy_ref` миграцией не меняется, поэтому цепочка присвоения по
	// external_id+company_id по-прежнему видит пару occurrences и производит непустой
	// `repeatApplications`, хотя НИ ОДИН id уже не меняется (на входе такого прогона старые
	// id уже различны — хвост `-rN` уже в самом id). Рост, посчитанный по старому id, в
	// этом случае честно даёт 0 — «до»-слотов здесь уже два, а не один.
	const unexplainedNewIds = new Set<string>(); // «поимённо»: новые id без предшественника среди старых
	for (const occs of occurrencesByOldId.values()) {
		if (occs.length <= 1) continue; // единственная occurrence на старый id — предшественник есть, роста нет
		const ordered = [...occs].sort((a, b) => a.appliedAt.localeCompare(b.appliedAt));
		// Первая (по времени) occurrence — законный предшественник слота, который уже
		// существовал «до». Остальные — новые слоты БЕЗ предшественника: единственный слот
		// на этот старый id уже занят первой.
		for (const occ of ordered.slice(1)) {
			const newId = applicationIdMap.get(occurrenceKey(occ.oldId, occ.appliedAt));
			if (newId) unexplainedNewIds.add(newId);
		}
	}
	const allowedGrowth = unexplainedNewIds.size;

	// Инъективность applicationIdMap: два РАЗНЫХ occurrence не имеют права молча
	// схлопнуться в один и тот же новый id. Группировка по (external_id, company_id) выше
	// не даёт цепочке присвоения смешать разных работодателей — но если совпадение всё же
	// произошло (два независимых chain'а стартуют с одного и того же голого external_id),
	// это обязана поймать явная проверка, а не только совпадение чисел в счётчиках ниже.
	const newIdOccurrenceCounts = new Map<string, number>();
	for (const newId of applicationIdMap.values()) {
		newIdOccurrenceCounts.set(newId, (newIdOccurrenceCounts.get(newId) ?? 0) + 1);
	}
	const nonInjectiveApplicationIds = [...newIdOccurrenceCounts.entries()].filter(([, count]) => count > 1);

	/**
	 * resolveApplicationId — событие ссылается на СТАРЫЙ application_id, а не на occurrence.
	 * Когда у старого id несколько occurrences (повторный отклик), берём ту, что действовала
	 * на момент события: последнюю по applied_at, что не позже ts события; если событие
	 * почему-то раньше самой первой подачи (рассинхрон часов в старых данных) — берём первую.
	 */
	function resolveApplicationId(oldAppId: string, eventTs: string): string | undefined {
		const occs = occurrencesByOldId.get(oldAppId);
		if (!occs || occs.length === 0) return undefined;
		const sorted = [...occs].sort((a, b) => a.appliedAt.localeCompare(b.appliedAt));
		let chosen = sorted[0]!;
		for (const occ of sorted) if (occ.appliedAt <= eventTs) chosen = occ;
		return applicationIdMap.get(occurrenceKey(chosen.oldId, chosen.appliedAt));
	}

	const applicationAliases: AliasEntry[] = [];
	const seenFinalIds = new Set<string>();
	const seenOccurrences = new Set<string>();
	const migratedApplications: ApplicationRecord[] = [];

	for (const work of works) {
		const key = occurrenceKey(work.oldId, work.appliedAt);
		const newId = applicationIdMap.get(key) ?? work.oldId;

		// Алиас и коллизия — по occurrence, а не по сырой строке: несколько строк-перезаписей
		// делят один occurrence и один newId легитимно, это не коллизия и не второй алиас.
		if (!seenOccurrences.has(key)) {
			seenOccurrences.add(key);
			if (work.oldId && newId !== work.oldId) applicationAliases.push({ from: work.oldId, to: newId });
			if (seenFinalIds.has(newId)) {
				validationErrors.push({
					recordType: 'application',
					id: newId,
					message: `id пересекается с другой мигрированной записью после переноса (было: ${work.oldId})`,
				});
			}
			seenFinalIds.add(newId);
		}

		const candidate = { ...work.candidate, id: newId };
		const parsed = ApplicationRecordSchema.safeParse(candidate);
		if (parsed.success) {
			migratedApplications.push(parsed.data);
		} else {
			validationErrors.push({ recordType: 'application', id: newId, message: parsed.error.message });
			migratedApplications.push(candidate as ApplicationRecord);
		}
	}

	// ---- 3. События: application_id по карте алиасов, нормализация kind/source ----
	const eventApplicationIdRewrites: Array<{ eventId: string; from: string; to: string }> = [];
	const migratedEvents: ApplicationEvent[] = [];

	// Занятые id — сперва ВСЕ уже валидные (не только уже обработанные в этом цикле), иначе
	// синтезированный id мог бы столкнуться с событием, до которого цикл ещё не дошёл.
	const usedEventIds = new Set<string>();
	for (const raw of input.events) if (isValidSlugId(raw.id)) usedEventIds.add(raw.id);

	for (const raw of input.events) {
		const eventId = isNonEmptyString(raw.id) ? raw.id : '';
		const patch: RawRecord = {};

		// Событие ссылается на СТАРЫЙ application_id, а не на occurrence — при повторном
		// отклике (см. resolveApplicationId выше) под одним старым id может скрываться
		// несколько occurrences, и событие обязано попасть в ТУ, что действовала на момент
		// его ts, а не в первую попавшуюся.
		const oldAppId = isNonEmptyString(raw.application_id) ? raw.application_id : undefined;
		if (oldAppId) {
			const newAppId = resolveApplicationId(oldAppId, isNonEmptyString(raw.ts) ? raw.ts : '');
			if (newAppId && newAppId !== oldAppId) {
				patch.application_id = newAppId;
				eventApplicationIdRewrites.push({ eventId, from: oldAppId, to: newAppId });
			}
		}

		// source: manual/пусто → owner ([ADR-0035] контекст: старые записи писались агентом
		// мимо словаря источников события).
		const source = raw.source;
		if (source === 'manual' || !isNonEmptyString(source)) {
			patch.source = 'owner';
			normalizations.push({
				rule: 'event_source_normalized',
				recordType: 'event',
				id: eventId,
				from: source,
				to: 'owner',
			});
		}

		// kind: note → touchpoint + touch_kind: other. Обязаны снять `stage`, если он
		// каким-то образом был проставлен на note-записи — touchpoint его не допускает.
		let kind = raw.kind;
		if (kind === 'note') {
			patch.kind = 'touchpoint';
			patch.touch_kind = isNonEmptyString(raw.touch_kind) ? raw.touch_kind : 'other';
			patch.stage = undefined;
			normalizations.push({
				rule: 'event_kind_note_to_touchpoint',
				recordType: 'event',
				id: eventId,
				from: 'note',
				to: 'touchpoint',
			});
			kind = 'touchpoint';
		}

		// touchpoint без touch_kind → other (тот же дефолт, что уже применяет само событие
		// [ADR-0030], только для старых записей без него вовсе).
		if (kind === 'touchpoint' && !isNonEmptyString(raw.touch_kind) && !isNonEmptyString(patch.touch_kind)) {
			patch.touch_kind = 'other';
			normalizations.push({
				rule: 'event_touchpoint_missing_touch_kind',
				recordType: 'event',
				id: eventId,
				from: raw.touch_kind,
				to: 'other',
			});
		}

		// reason_note: null → поле убирается. Схема допускает ЕГО ОТСУТСТВИЕ (`.optional()`),
		// но не `null` — а старые записи писали `null` явно, вместо того чтобы не писать
		// поле вовсе. `undefined` в патче стирает ключ при сборке `candidate` ниже.
		if (raw.reason_note === null) {
			patch.reason_note = undefined;
			normalizations.push({
				rule: 'event_reason_note_null_removed',
				recordType: 'event',
				id: eventId,
				from: null,
				to: undefined,
			});
		}

		// id: невалидный slug (пусто/`null`/длиннее 64 символов — реальный случай в леджере:
		// старый генератор id не обрезал `<application_id>-<stage>` до лимита схемы) →
		// синтез тем же правилом, каким построены остальные id в файле. Обязано идти ПОСЛЕ
		// переписывания application_id по карте алиасов (patch.application_id выше) — иначе
		// id получился бы от уже устаревшей ссылки на отклик.
		if (!isValidSlugId(raw.id)) {
			const finalAppId = isNonEmptyString(patch.application_id)
				? patch.application_id
				: isNonEmptyString(raw.application_id)
					? raw.application_id
					: '';
			const finalStage = isNonEmptyString(patch.stage)
				? patch.stage
				: kind === 'stage_change' && isNonEmptyString(raw.stage)
					? raw.stage
					: undefined;
			const finalTouchKind = isNonEmptyString(patch.touch_kind)
				? patch.touch_kind
				: isNonEmptyString(raw.touch_kind)
					? raw.touch_kind
					: undefined;
			const suffixPart = kind === 'stage_change' ? finalStage : finalTouchKind;

			// Без application_id и стадии/вида касания синтезировать не из чего — запись
			// остаётся с исходным (невалидным) id и попадёт в отчёт валидации ниже, как и
			// любая другая запись, которую эта миграция не может починить сама.
			if (isNonEmptyString(finalAppId) && isNonEmptyString(suffixPart)) {
				const synthesized = synthesizeEventId(`${finalAppId}-${suffixPart}`, usedEventIds);
				usedEventIds.add(synthesized);
				patch.id = synthesized;
				normalizations.push({
					rule: 'event_id_synthesized',
					recordType: 'event',
					id: synthesized,
					from: raw.id,
					to: synthesized,
				});
			}
		}

		const candidate = { ...raw, ...patch };
		const parsed = ApplicationEventSchema.safeParse(candidate);
		if (parsed.success) {
			migratedEvents.push(parsed.data);
		} else {
			validationErrors.push({
				recordType: 'event',
				id: isNonEmptyString(patch.id) ? patch.id : eventId,
				message: parsed.error.message,
			});
			migratedEvents.push(candidate as ApplicationEvent);
		}
	}

	// ---- 4. Инвариант: счётчики и распределение по стадиям, ДО == ПОСЛЕ ----
	const afterStageCounts = stageHistogram(migratedApplications, migratedEvents);
	const mismatches: string[] = [];
	if (input.companies.length !== migratedCompanies.length) {
		mismatches.push(`companies: было ${input.companies.length}, стало ${migratedCompanies.length}`);
	}
	if (input.applications.length !== migratedApplications.length) {
		mismatches.push(
			`applications: было ${input.applications.length}, стало ${migratedApplications.length}`,
		);
	}
	if (input.events.length !== migratedEvents.length) {
		mismatches.push(`events: было ${input.events.length}, стало ${migratedEvents.length}`);
	}
	mismatches.push(...diffStageCounts(beforeStageCounts, afterStageCounts, allowedGrowth));
	for (const [id, count] of nonInjectiveApplicationIds) {
		mismatches.push(`отображение старый id → новый не инъективно: id "${id}" назначен ${count} раз`);
	}

	const invariant: MigrationInvariant = {
		before: {
			companies: input.companies.length,
			applications: input.applications.length,
			events: input.events.length,
			stageCounts: beforeStageCounts,
		},
		after: {
			companies: migratedCompanies.length,
			applications: migratedApplications.length,
			events: migratedEvents.length,
			stageCounts: afterStageCounts,
		},
		ok: mismatches.length === 0,
		mismatches,
	};

	const mergeGroups = companyAliases.reduce((set, a) => set.add(a.to), new Set<string>()).size;
	const formatHistogram = (counts: Record<string, number>): string[] =>
		Object.keys(counts)
			.sort()
			.map((stage) => `  ${stage}: ${counts[stage]}`);
	const lines = [
		'=== Миграция площадок: отчёт ===',
		`Компании: ${invariant.before.companies} → ${invariant.after.companies} ` +
			`(алиасов: ${companyAliases.length}, групп слияния: ${mergeGroups}, ` +
			`коллизий слага: ${companySlugCollisions.length})`,
		`Отклики: ${invariant.before.applications} → ${invariant.after.applications} ` +
			`(алиасов: ${applicationAliases.length}, повторов -rN: ${repeatApplications.length}, ` +
			`неразобранных ссылок: ${unparsedVacancyRefs.length})`,
		`События: ${invariant.before.events} → ${invariant.after.events} ` +
			`(переписанных ссылок application_id: ${eventApplicationIdRewrites.length})`,
		'',
		// Владелец обязан видеть КАЖДОЕ опасное решение поимённо, а не только «инвариант
		// OK» (находка ревью) — повторы, неразобранные ссылки и обе гистограммы построчно,
		// а не только числом в сводке выше.
		'Повторные отклики (-rN):',
		...(repeatApplications.length > 0
			? repeatApplications.map(
					(r) => `  ${r.assignedId} ← ${r.originalId} (база ${r.baseId}, подан ${r.appliedAt})`,
				)
			: ['  (нет)']),
		'',
		'Неразобранные ссылки vacancy_ref:',
		...(unparsedVacancyRefs.length > 0
			? unparsedVacancyRefs.map((u) => `  ${u.applicationId}: ${u.vacancyRef}`)
			: ['  (нет)']),
		'',
		'Нормализации значений:',
		...(
			[
				['submission_channel_easy_apply', 'submission_channel: linkedin_easy_apply → direct + applied_via: linkedin'],
				['submission_channel_company_site', 'submission_channel: company_site → direct + applied_via: site'],
				['submission_channel_email', 'submission_channel: email → direct + applied_via: email'],
				['event_source_normalized', 'событие source: manual/пусто → owner'],
				['event_kind_note_to_touchpoint', 'событие kind: note → touchpoint + touch_kind: other'],
				['event_touchpoint_missing_touch_kind', 'событие touchpoint без touch_kind → other'],
				['company_remote_mode_normalized', 'компания remote_mode: синоним/неопределимый факт → канонический член'],
				['company_stage_normalized', 'компания stage: синоним/неопределимый факт → канонический член или unknown'],
				['company_type_normalized', 'компания company_type: синоним/неопределимый факт → канонический член или unknown'],
				['company_interview_language_normalized', 'компания interview_language: синоним языка → other'],
				['event_reason_note_null_removed', 'событие reason_note: null → поле убрано'],
				['event_id_synthesized', 'событие id: невалидный/отсутствующий slug → синтезирован по <application_id>-<stage>'],
			] as const
		).map(
			([rule, label]) =>
				`  ${label} — ${normalizations.filter((n) => n.rule === rule).length} раз`,
		),
		'',
		'Распределение по стадиям (до):',
		...formatHistogram(invariant.before.stageCounts),
		'Распределение по стадиям (после):',
		...formatHistogram(invariant.after.stageCounts),
		'',
		`Инвариант: ${invariant.ok ? 'OK' : 'НАРУШЕН'}`,
		...invariant.mismatches.map((m) => `  ! ${m}`),
		`Ошибок финальной валидации: ${validationErrors.length}`,
		...validationErrors.map((e) => `  ! [${e.recordType}] ${e.id}: ${e.message}`),
	];

	return {
		companies: migratedCompanies,
		applications: migratedApplications,
		events: migratedEvents,
		report: {
			companyAliases,
			companySlugCollisions,
			applicationAliases,
			repeatApplications,
			eventApplicationIdRewrites,
			normalizations,
			unparsedVacancyRefs,
			validationErrors,
			invariant,
			lines,
		},
	};
}

// ---------------------------------------------------------------------------
// applyMigration
// ---------------------------------------------------------------------------

export class MigrationInvariantError extends Error {
	constructor(
		message: string,
		public readonly mismatches: string[],
	) {
		super(message);
		this.name = 'MigrationInvariantError';
	}
}

export class MigrationValidationError extends Error {
	constructor(
		message: string,
		public readonly errors: ValidationFailure[],
	) {
		super(message);
		this.name = 'MigrationValidationError';
	}
}

export interface ApplyMigrationOptions {
	/** Каталог `raw/jobsearch/`. По умолчанию — та же лесенка env, что и у леджера. */
	dir?: string;
	env?: NodeJS.ProcessEnv;
	/** Запрещённый prefix для path-allowlist guard'а. По умолчанию `resolvePublicRepo()`. */
	publicRepoRoot?: string;
}

/**
 * applyMigration — атомарная запись плана: временный файл рядом с целевым + `renameSync`
 * ([ADR-0033] §5). Инвариант и финальная валидация проверяются ПЕРВЫМ ДЕЛОМ, до того как
 * тронут диск хоть один файл — провал любой из двух проверок не оставляет НИ временных,
 * НИ частично переписанных файлов: миграция всё-или-ничего, как и `jobsearch:append`.
 */
export function applyMigration(plan: MigrationPlan, opts: ApplyMigrationOptions = {}): void {
	if (!plan.report.invariant.ok) {
		throw new MigrationInvariantError(
			`Инвариант миграции нарушен — запись отменена:\n${plan.report.invariant.mismatches.join('\n')}`,
			plan.report.invariant.mismatches,
		);
	}
	if (plan.report.validationErrors.length > 0) {
		throw new MigrationValidationError(
			`${plan.report.validationErrors.length} записей не прошли финальную валидацию — запись отменена`,
			plan.report.validationErrors,
		);
	}

	const env = opts.env ?? process.env;
	const dir = opts.dir ?? resolveJobsearchDir(env);
	const publicRepoRoot = opts.publicRepoRoot ?? resolvePublicRepo(env);

	const targets: Array<{ file: string; records: unknown[] }> = [
		{ file: JOBSEARCH_LEDGER_FILES.companies, records: plan.companies },
		{ file: JOBSEARCH_LEDGER_FILES.applications, records: plan.applications },
		{ file: JOBSEARCH_LEDGER_FILES.application_events, records: plan.events },
	];

	// Guard ПЕРЕД mkdir/записью — тот же порядок, что у Ledger.append.
	for (const { file } of targets) assertPathAllowed(join(dir, file), dir, publicRepoRoot);

	mkdirSync(dir, { recursive: true });

	for (const { file, records } of targets) {
		const targetPath = join(dir, file);
		const tmpPath = join(dir, `.${file}.migrate-tmp-${process.pid}-${Date.now()}`);
		const content = records.map((r) => JSON.stringify(r)).join('\n');
		writeFileSync(tmpPath, records.length > 0 ? `${content}\n` : '', 'utf8');
		renameSync(tmpPath, targetPath);
	}
}

// ---------------------------------------------------------------------------
// Чтение сырого JSONL — тонкий помощник для CLI-скрипта
// ---------------------------------------------------------------------------

/**
 * readJsonlFile — читает JSONL БЕЗ схемы (сырые объекты для `planMigration`).
 *
 * Отличие от `Ledger.readAll`: та молча пропускает невалидные строки (нормально при
 * штатном чтении), а миграция обязана видеть ИМЕННО их — это и есть материал для
 * нормализации. Непарсируемый JSON — не пропуск, а фатальная ошибка: «ничего не терять»
 * подразумевает «не сделать вид, что битой строки не было».
 */
export function readJsonlFile(path: string): RawRecord[] {
	if (!existsSync(path)) return [];
	const lines = readFileSync(path, 'utf8').split('\n');
	const out: RawRecord[] = [];
	for (let i = 0; i < lines.length; i++) {
		const trimmed = (lines[i] ?? '').trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed) as RawRecord);
		} catch (e) {
			throw new Error(`${path}:${i + 1}: не удалось распарсить JSON: ${String(e)}`);
		}
	}
	return out;
}
