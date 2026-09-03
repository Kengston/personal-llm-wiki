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

/** Разбор одного `vacancy_ref` в поля отклика. */
export interface ParsedVacancyRef {
	platform?: PlatformId;
	externalId?: string;
	/** URL без query. Отсутствует у формы тега — там ссылки не было вовсе. */
	url?: string;
}

const TAG_PATTERN = /^([a-z]+):(.+)$/i;

/**
 * parseVacancyRef — детерминированный разбор старого `vacancy_ref` ([ADR-0033] §5).
 *
 * Две формы старых данных:
 *   - тег `platform:внешний_id` (площадка называется напрямую, без URL);
 *   - URL вакансии (площадка выводится из домена, внешний id — из последнего сегмента пути).
 *
 * Пустая или неразбираемая ссылка не выбрасывает исключение: она возвращает `{}`,
 * а вызывающий сам решает, куда записать «не разобрано» ([ADR-0033] §5 — миграция
 * ОБЯЗАНА иметь дело с реальными данными, а не падать на первой странной строке).
 */
export function parseVacancyRef(ref: string | undefined): ParsedVacancyRef {
	if (!ref) return {};
	const trimmed = ref.trim();
	if (!trimmed) return {};

	const tagMatch = TAG_PATTERN.exec(trimmed);
	if (tagMatch) {
		const prefix = tagMatch[1]!.toLowerCase();
		if ((PLATFORM_IDS as readonly string[]).includes(prefix)) {
			const platform = prefix as PlatformId;
			const idPrefix = EXTERNAL_ID_PREFIX[platform];
			const rawId = tagMatch[2]!.trim().replace(/[^a-zA-Z0-9._-]/g, '');
			return { platform, externalId: idPrefix && rawId ? `${idPrefix}${rawId}` : undefined };
		}
	}

	const domain = normalizeDomain(trimmed);
	if (!domain) return {};

	const platform = platformFromDomain(domain);
	try {
		const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
		const parsed = new URL(withScheme);
		const url = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '') || parsed.origin;
		const segments = parsed.pathname.split('/').filter(Boolean);
		const last = segments.length > 0 ? segments[segments.length - 1] : undefined;
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
	| 'event_touchpoint_missing_touch_kind';

export interface NormalizationNote {
	rule: NormalizationRule;
	recordType: 'application' | 'event';
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

function diffCounts(before: Record<string, number>, after: Record<string, number>): string[] {
	const mismatches: string[] = [];
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	for (const key of keys) {
		const b = before[key] ?? 0;
		const a = after[key] ?? 0;
		if (a !== b) mismatches.push(`стадия ${key}: было ${b}, стало ${a}`);
	}
	return mismatches;
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

	for (const raw of input.companies) {
		const oldId = isNonEmptyString(raw.id) ? raw.id : '';
		const newId = companyIdMap.get(oldId) ?? oldId;
		if (oldId && newId !== oldId && !companyAliasSeen.has(oldId)) {
			companyAliasSeen.add(oldId);
			companyAliases.push({ from: oldId, to: newId });
		}
		const candidate = { ...raw, id: newId };
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
		appliedAt: string;
	}

	const normalizations: NormalizationNote[] = [];
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

		// applied_via: явное значение > способ подачи из submission_channel > площадка
		// из ссылки (по умолчанию считаем, что подали там же, где нашли).
		if (!isNonEmptyString(raw.applied_via)) {
			if (appliedViaFromChannel) patch.applied_via = appliedViaFromChannel;
			else if (parsedRef.platform) patch.applied_via = parsedRef.platform;
		}

		const candidate: RawRecord = { ...raw, ...patch };
		const externalId = isNonEmptyString(candidate.external_id) ? candidate.external_id : undefined;
		works.push({
			oldId,
			candidate,
			externalId,
			appliedAt: isNonEmptyString(raw.applied_at) ? raw.applied_at : String(raw.ts ?? ''),
		});
	}

	// Новый id: <external_id> напрямую (сам уже несёт буквенный префикс площадки, второй
	// разделённый префикс не добавляем — так же, как уже сделано в hh.ts). Повторный
	// отклик на ТУ ЖЕ вакансию (тот же external_id) получает суффикс `-rN` по порядку
	// подачи ([ADR-0033] §4). Без внешнего id — старый id остаётся как есть.
	const applicationIdMap = new Map<string, string>();
	const repeatApplications: RepeatApplication[] = [];
	const byExternalId = new Map<string, AppWork[]>();
	for (const work of works) {
		if (!work.externalId) {
			applicationIdMap.set(work.oldId, work.oldId);
			continue;
		}
		const group = byExternalId.get(work.externalId) ?? [];
		group.push(work);
		byExternalId.set(work.externalId, group);
	}
	for (const [externalId, group] of byExternalId) {
		const ordered = [...group].sort(
			(a, b) => a.appliedAt.localeCompare(b.appliedAt) || a.oldId.localeCompare(b.oldId),
		);
		ordered.forEach((work, index) => {
			const assignedId = index === 0 ? externalId : `${externalId}-r${index + 1}`;
			applicationIdMap.set(work.oldId, assignedId);
			if (index > 0) {
				repeatApplications.push({
					assignedId,
					baseId: externalId,
					originalId: work.oldId,
					appliedAt: work.appliedAt,
				});
			}
		});
	}

	const applicationAliases: AliasEntry[] = [];
	const seenFinalIds = new Set<string>();
	const migratedApplications: ApplicationRecord[] = [];

	for (const work of works) {
		const newId = applicationIdMap.get(work.oldId) ?? work.oldId;
		if (work.oldId && newId !== work.oldId) applicationAliases.push({ from: work.oldId, to: newId });

		if (seenFinalIds.has(newId)) {
			validationErrors.push({
				recordType: 'application',
				id: newId,
				message: `id пересекается с другой мигрированной записью после переноса (было: ${work.oldId})`,
			});
		}
		seenFinalIds.add(newId);

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

	for (const raw of input.events) {
		const eventId = isNonEmptyString(raw.id) ? raw.id : '';
		const patch: RawRecord = {};

		const oldAppId = isNonEmptyString(raw.application_id) ? raw.application_id : undefined;
		if (oldAppId && applicationIdMap.has(oldAppId)) {
			const newAppId = applicationIdMap.get(oldAppId)!;
			if (newAppId !== oldAppId) {
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

		const candidate = { ...raw, ...patch };
		const parsed = ApplicationEventSchema.safeParse(candidate);
		if (parsed.success) {
			migratedEvents.push(parsed.data);
		} else {
			validationErrors.push({ recordType: 'event', id: eventId, message: parsed.error.message });
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
	mismatches.push(...diffCounts(beforeStageCounts, afterStageCounts));

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
		'Нормализации значений:',
		...(
			[
				['submission_channel_easy_apply', 'submission_channel: linkedin_easy_apply → direct + applied_via: linkedin'],
				['submission_channel_company_site', 'submission_channel: company_site → direct + applied_via: site'],
				['submission_channel_email', 'submission_channel: email → direct + applied_via: email'],
				['event_source_normalized', 'событие source: manual/пусто → owner'],
				['event_kind_note_to_touchpoint', 'событие kind: note → touchpoint + touch_kind: other'],
				['event_touchpoint_missing_touch_kind', 'событие touchpoint без touch_kind → other'],
			] as const
		).map(
			([rule, label]) =>
				`  ${label} — ${normalizations.filter((n) => n.rule === rule).length} раз`,
		),
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
