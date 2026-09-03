/**
 * companies.ts — реестр целевых компаний и вакансий ([ADR-0029]).
 *
 * Каталог `raw/jobsearch/` (без дефиса) — общий с воронкой ([ADR-0030]); леджер тот же
 * параметризованный, что у финансов и карьеры, только со своей спекой.
 *
 * Три вещи, которые здесь неочевидны и потому названы вслух:
 *
 *   1. ПРИЗНАКИ ТРЁХЗНАЧНЫЕ (`yes | no | unknown`), а не булевы, и каждый несёт
 *      происхождение: «так написано в вакансии» и «так сказал человек» — разные факты.
 *      `unknown` НЕ отсеивает компанию никогда: неизвестность это состояние ожидания
 *      разговора, а не отказ. Иначе гейты выбросят ровно тот класс компаний, про которые
 *      методология говорит «узнаётся только в диалоге».
 *
 *   2. ВЕРДИКТА НЕТ. `fit_rank` — это то, что владелец ПОСТАВИЛ (0–5 кнопками), а не то,
 *      что система вывела. Composite score из весов критериев отвергнут: весов в
 *      методологии нет, число не с чем сверить и нечем объяснить. Сортировка объясняется
 *      перечнем сработавших фактов.
 *
 *   3. ДЕДУП ПО ДОМЕНУ, ССЫЛКА ПО id. `site_domain` — ключ дедупа, `id` — то, на что
 *      ссылаются `opportunity.company_id` и `application.company_id`. Склеить их в одно
 *      поле нельзя: домен у компании может смениться, а ссылки при этом рваться не должны.
 *
 * PII третьих лиц не хранится никогда (D9): роль, ссылка на публичный профиль, дата и
 * канал контакта — максимум. Контактные поля импорта отбрасываются НА ПАРСИНГЕ, а не
 * «зачищаются потом».
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Базовые типы
// ---------------------------------------------------------------------------

const isoTimestamp = z.string().min(1);
const slugId = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9][a-z0-9_.-]*$/);

/**
 * Каналы добычи. Список закрытый: пятый не заводится без ADR (D4).
 *
 * `hh` добавлен [ADR-0031] — он назван поимённо, а не свёрнут в `web_search`, потому что
 * строка покрытия (§ sourceCoverageLine, D11) обязана перечислять источники по именам,
 * а hh — вдобавок другой рынок: рубли, российские юрлица, русскоязычные интервью.
 *
 * ЕДИНСТВЕННОЕ место, где живёт этот словарь. `applications.jsonl` ([ADR-0030]) импортирует
 * его отсюда: второй литерал уже расходился с этим — источник проходил валидацию компании
 * и падал на валидации отклика, то есть ПОСЛЕ того, как отклик был отправлен.
 */
export const COMPANY_SOURCES = ['manual', 'linkedin_export', 'web_search', 'hh'] as const;
export const companySource = z.enum(COMPANY_SOURCES);

/** Трёхзначный признак: `unknown` — легальное и частое состояние. */
const triState = z.enum(['yes', 'no', 'unknown']);

/**
 * assessed — значение вместе с происхождением.
 *
 * `confirmed_by_human` отделяет «так написано в вакансии» от «так сказал человек».
 * Для `work_permit_required` это принципиально: публично «work from anywhere» пишут
 * единицы, и точный факт даёт только разговор с HR — поэтому извлечённое из текста
 * значение всегда гипотеза (`confirmed_by_human: false`).
 */
function assessed<T extends z.ZodTypeAny>(value: T) {
	return z.object({
		value,
		source: companySource,
		confirmed_by_human: z.boolean(),
		confirmed_at: isoTimestamp.nullable().default(null),
	});
}

/** Провенанс записи: без него запись неотличима от галлюцинации движка. */
export const ProvenanceSchema = z.object({
	company_source: companySource,
	/** URL БЕЗ query: PII в query-строке не хранится и не логируется — сквозной запрет. */
	source_url: z.string().url().optional(),
	fetched_at: isoTimestamp,
	content_sha256: z.string().optional(),
	parser_version: z.string().min(1),
	robots_ok: z.boolean(),
});

// ---------------------------------------------------------------------------
// company
// ---------------------------------------------------------------------------

export const CompanyRecordSchema = z.object({
	/** Стабильный slug, производный от нормализованного домена. На него ссылаются. */
	id: slugId,
	/** Ключ дедупа. Нормализованный домен без `www.` и схемы. */
	site_domain: z.string().min(1).max(255),
	/** Отображаемое имя. Не PII: это публичное название организации. */
	name: z.string().min(1).max(200),

	company_type: assessed(
		z.enum([
			'startup',
			'product_smb',
			'product_enterprise',
			'outsourcing_outstaff',
			'agency',
			'unknown',
		]),
	),
	stage: assessed(
		z.enum(['bootstrapped', 'seed', 'series_a', 'series_b_plus', 'public', 'unknown']),
	),
	remote_mode: assessed(
		z.enum(['wfa', 'remote_100', 'remote_country_bound', 'hybrid', 'onsite', 'unknown']),
	),
	hires_contractors: assessed(triState),
	work_permit_required: assessed(triState),
	interview_language: assessed(z.enum(['en', 'ru', 'other', 'unknown'])),
	hq_country: assessed(z.string().min(1).max(80)),
	timezone_overlap: assessed(z.string().min(1).max(80)),
	has_warm_contact: assessed(triState),
	hiring_status: assessed(z.enum(['active', 'paused', 'unknown'])),

	/** Ручной вес владельца 0–5. Не вычисляется. Поля `fit_score` не существует. */
	fit_rank: z.number().int().min(0).max(5).default(0),

	provenance: ProvenanceSchema,
	ts: isoTimestamp,
	deleted: z.boolean().optional(),
});

export type CompanyRecord = z.infer<typeof CompanyRecordSchema>;

// ---------------------------------------------------------------------------
// opportunity
// ---------------------------------------------------------------------------

/**
 * OpportunityRecordSchema — конкретная вакансия у целевой компании.
 *
 * Полей воронки здесь НЕТ (`funnel_stage`, `dropped_reason`): всё, что после подачи,
 * принадлежит [ADR-0030], где стадия вычисляется fold'ом и словарь стадий один.
 * Второй словарь состояний разъехался бы с первым при первой же правке.
 */
export const OpportunityRecordSchema = z.object({
	id: slugId,
	company_id: slugId,
	title: z.string().min(1).max(200),
	/** URL без query. Санитайзер по нему НЕ ходит — это типизированное поле, не текст. */
	source_url: z.string().url().optional(),
	/**
	 * Внешний идентификатор площадки. Хранится с буквенным префиксом БЕЗ разделителя
	 * (`li4021234567`): голое число в свободном тексте маскируется санитайзером как телефон.
	 */
	external_id: z.string().max(64).optional(),
	/** `null` — даты нет; отсутствие даты информативно само по себе (низкое доверие). */
	posted_at: z.string().nullable(),
	fetched_at: isoTimestamp,
	employment_type: z.enum(['contract', 'employee', 'unknown']),
	remote_mode: z.enum(['wfa', 'remote_100', 'remote_country_bound', 'hybrid', 'onsite', 'unknown']),
	company_source: companySource,
	/** Путь к иммутабельному снапшоту сырья в `raw/jobsearch/<host>/<sha>.md`. */
	raw_ref: z.string().optional(),
	ts: isoTimestamp,
	deleted: z.boolean().optional(),
});

export type OpportunityRecord = z.infer<typeof OpportunityRecordSchema>;

// ---------------------------------------------------------------------------
// Нормализация и дедуп
// ---------------------------------------------------------------------------

/**
 * normalizeDomain — ключ дедупа из чего угодно похожего на адрес.
 *
 * Дедуп идёт по домену, а не по названию: «Acme» / «Acme Inc» / «ACME» — три написания
 * одной компании, и склеивать их по строке значит склеивать по случайности.
 */
export function normalizeDomain(input: string): string | null {
	const trimmed = input.trim().toLowerCase();
	if (!trimmed) return null;

	const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
	let host: string;
	try {
		host = new URL(withScheme).hostname;
	} catch {
		return null;
	}
	const stripped = host.replace(/^www\./, '');
	return stripped.includes('.') ? stripped : null;
}

/** companyIdFromDomain — человекочитаемый стабильный slug из домена. */
export function companyIdFromDomain(domain: string): string {
	return domain.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * dedupeCompanies — свод истории строк: последняя запись на домен.
 *
 * Именно на домен, а не на id: две записи с разными id и одним доменом — это дубль ввода,
 * ровно тот случай, ради которого дедуп и заведён.
 */
export function dedupeCompanies(records: CompanyRecord[]): CompanyRecord[] {
	const latest = new Map<string, CompanyRecord>();
	for (const record of records) {
		const prev = latest.get(record.site_domain);
		if (!prev || record.ts >= prev.ts) latest.set(record.site_domain, record);
	}
	return [...latest.values()]
		.filter((c) => c.deleted !== true)
		.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Гейты отбора
// ---------------------------------------------------------------------------

/** Причина отсева. Пустой список = компания проходит. */
export interface GateResult {
	passed: boolean;
	reasons: string[];
}

/**
 * applyCompanyGates — булевы гейты из методологии ([ADR-0029] §4).
 *
 * Применяются ТОЛЬКО к известным значениям. `unknown` не отсеивает никогда — это правило
 * важнее любого гейта: неизвестность есть состояние ожидания разговора.
 *
 * @param company        — запись компании
 * @param avoidWorkPermit — отсеивать ли компании с требованием разрешения на работу
 *                          (стратегия локации выбирается владельцем, не системой)
 */
export function applyCompanyGates(company: CompanyRecord, avoidWorkPermit = true): GateResult {
	const reasons: string[] = [];

	if (company.hires_contractors.value === 'no') reasons.push('контракторов не берут');
	if (company.remote_mode.value === 'onsite') reasons.push('только офис');
	if (avoidWorkPermit && company.work_permit_required.value === 'yes') {
		reasons.push('требуется разрешение на работу');
	}

	return { passed: reasons.length === 0, reasons };
}

/**
 * explainRank — строка, которой объясняется место компании в списке.
 *
 * Сортировка обязана объясняться словами: «вес 4 · контрактор подтверждён в разговоре ·
 * есть тёплый контакт». Непрозрачный балл объяснить нечем и проверить не против чего.
 */
export function explainRank(company: CompanyRecord): string {
	const facts: string[] = [`вес ${company.fit_rank}`];

	if (company.hires_contractors.value === 'yes') {
		facts.push(
			company.hires_contractors.confirmed_by_human
				? 'контрактор подтверждён в разговоре'
				: 'контрактор по тексту вакансии',
		);
	}
	if (company.has_warm_contact.value === 'yes') facts.push('есть тёплый контакт');
	if (company.remote_mode.value === 'wfa' || company.remote_mode.value === 'remote_100') {
		facts.push(`удалёнка: ${company.remote_mode.value}`);
	}
	if (company.work_permit_required.value === 'unknown') {
		facts.push('разрешение на работу — выясняется в разговоре');
	}

	return facts.join(' · ');
}

/**
 * sourceCoverageLine — ЕДИНСТВЕННАЯ допустимая формулировка покрытия (D11).
 *
 * Не редполитика, а одна строка в коде: полного среза рынка не существует, и обещать его
 * нельзя. «Все подходящие компании» означает «все из подключённых источников», и источники
 * перечисляются поимённо.
 */
export function sourceCoverageLine(connectedSources: string[], found: number): string {
	const sources = connectedSources.length > 0 ? connectedSources.join(', ') : 'нет подключённых';
	return `Из подключённых источников (${connectedSources.length}: ${sources}) найдено ${found}.`;
}

// ---------------------------------------------------------------------------
// Импорт официального экспорта LinkedIn
// ---------------------------------------------------------------------------

/**
 * Поля экспорта, которые НЕ импортируются ни при каком заголовке.
 *
 * Отбрасываются на парсинге, а не «зачищаются потом»: PII третьих лиц не должно
 * существовать в памяти процесса дольше строки CSV. Плюс ось A фильтра карантинит
 * документ целиком при `pii_density ≥ 5`, а любой экспорт связей — это сотни адресов.
 */
const DROPPED_COLUMNS = [
	'email',
	'email address',
	'emails',
	'phone',
	'phone number',
	'phone numbers',
	'first name',
	'last name',
	'full name',
	'address',
	'im',
	'twitter handles',
];

/** Разбор одной строки CSV с учётом кавычек. Внешних зависимостей не заводим. */
function parseCsvLine(line: string): string[] {
	const cells: string[] = [];
	let cell = '';
	let quoted = false;

	for (let i = 0; i < line.length; i++) {
		const ch = line[i]!;
		if (quoted) {
			if (ch === '"' && line[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (ch === '"') quoted = false;
			else cell += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ',') {
			cells.push(cell);
			cell = '';
		} else cell += ch;
	}
	cells.push(cell);
	return cells.map((c) => c.trim());
}

/** Что импортёр вернул: записи компаний и то, что он отбросил. */
export interface LinkedinImportResult {
	companies: CompanyRecord[];
	/** Имена колонок с PII третьих лиц, выброшенные на парсинге. */
	droppedColumns: string[];
	/** Строки без пригодного домена — импортировать нечего. */
	skippedRows: number;
}

/**
 * importLinkedinExport — детерминированный парсер официального файла-экспорта.
 *
 * Легальный ToS-safe путь: площадка сама отдаёт архив по запросу владельца — ни
 * скрейпинга, ни автоматизации, ни работы под учёткой ([ADR-0029] §2б).
 *
 * ПРАВИЛО ИМПОРТА: одна компания = одна запись. Файл целиком наружу не идёт — иначе он
 * гарантированно уедет в карантин по плотности PII и не доедет никуда.
 *
 * @param csv     — содержимое файла экспорта
 * @param fetchedAt — момент импорта (ISO); инъекция вместо часов внутри
 */
export function importLinkedinExport(csv: string, fetchedAt: string): LinkedinImportResult {
	const lines = csv.split('\n').filter((l) => l.trim());
	if (lines.length < 2) return { companies: [], droppedColumns: [], skippedRows: 0 };

	const header = parseCsvLine(lines[0]!).map((h) => h.toLowerCase());
	const droppedColumns = header.filter((h) => DROPPED_COLUMNS.includes(h));

	const companyIdx = header.findIndex((h) => h === 'company' || h === 'company name');
	const domainIdx = header.findIndex((h) => h === 'website' || h === 'company website');

	const companies: CompanyRecord[] = [];
	let skippedRows = 0;

	for (const line of lines.slice(1)) {
		const cells = parseCsvLine(line);
		const rawDomain = domainIdx >= 0 ? (cells[domainIdx] ?? '') : '';
		const name = companyIdx >= 0 ? (cells[companyIdx] ?? '') : '';

		// Домен — единственный ключ дедупа; без него запись не заводим.
		const domain = normalizeDomain(rawDomain || name);
		if (!domain || !name) {
			skippedRows++;
			continue;
		}

		const unknown = <T extends string>(value: T) => ({
			value,
			source: 'linkedin_export' as const,
			confirmed_by_human: false,
			confirmed_at: null,
		});

		companies.push(
			CompanyRecordSchema.parse({
				id: companyIdFromDomain(domain),
				site_domain: domain,
				name,
				company_type: unknown('unknown'),
				stage: unknown('unknown'),
				remote_mode: unknown('unknown'),
				hires_contractors: unknown('unknown'),
				work_permit_required: unknown('unknown'),
				interview_language: unknown('unknown'),
				hq_country: unknown('unknown'),
				timezone_overlap: unknown('unknown'),
				// Производный булев факт «есть тёплый контакт» — единственное, что берётся
				// из файла связей; персоналии не импортируются вовсе.
				has_warm_contact: unknown('yes'),
				hiring_status: unknown('unknown'),
				fit_rank: 0,
				provenance: {
					company_source: 'linkedin_export',
					fetched_at: fetchedAt,
					parser_version: 'linkedin-export-1',
					robots_ok: true,
				},
				ts: fetchedAt,
			}),
		);
	}

	return { companies, droppedColumns, skippedRows };
}

// ---------------------------------------------------------------------------
// Структурное извлечение из чужого текста
// ---------------------------------------------------------------------------

/**
 * Что извлекается из страницы. ТОЛЬКО типизированные значения из фиксированного набора —
 * enum'ы, короткие строки с жёстким лимитом. Свободного текста здесь нет ни одного поля.
 */
export interface CompanyFields {
	title: string;
	remote_mode: CompanyRecord['remote_mode']['value'];
	hires_contractors: 'yes' | 'no' | 'unknown';
	work_permit_required: 'yes' | 'no' | 'unknown';
	/** Дата публикации, если площадка её показала. Отсутствие даты информативно. */
	posted_at: string | null;
}

/**
 * stripInvisible — снимает zero-width и bidi-символы.
 * Обфускация невидимыми символами — штатный приём prompt-injection; типизированные
 * значения проходят через эту чистку, чтобы «remote» с zero-width внутри не проехало.
 */
function stripInvisible(text: string): string {
	return text.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '');
}

/** htmlToText — грубое снятие разметки. LLM в разборе не участвует ([ADR-0029] §6). */
function htmlToText(html: string): string {
	return stripInvisible(html)
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * parseCompanyPage — детерминированное извлечение полей из загруженной страницы.
 *
 * Загруженный документ ЦЕЛИКОМ в промпт не попадает никогда: наружу уходят только поля
 * `CompanyFields`. Практический результат — абзац «Ignore previous instructions and …»
 * на карьерной странице оседает в `raw/`, а движок видит `remote_mode: unknown`.
 *
 * Маркеры взяты из методологии: «remote» ≠ удалёнка (за словом часто стоит требование
 * work permit), настоящие маркеры — WFA / remote 100% / contractor.
 */
export function parseCompanyPage(doc: { url: string; body: string }): CompanyFields {
	const text = htmlToText(doc.body).toLowerCase();

	const remote_mode: CompanyFields['remote_mode'] = /work from anywhere|\bwfa\b/.test(text)
		? 'wfa'
		: /remote[- ]?100|fully remote|100% remote/.test(text)
			? 'remote_100'
			: /hybrid/.test(text)
				? 'hybrid'
				: /on[- ]?site|in[- ]office/.test(text)
					? 'onsite'
					: /remote/.test(text)
						? 'remote_country_bound'
						: 'unknown';

	const hires_contractors: CompanyFields['hires_contractors'] =
		/contractor|b2b contract|self[- ]employed/.test(text) ? 'yes' : 'unknown';

	// Требование разрешения на работу из текста — ВСЕГДА гипотеза: точный факт даёт только
	// разговор с HR. Поэтому вызывающий обязан положить это значение с
	// confirmed_by_human: false, а `unknown` компанию не отсеивает.
	const work_permit_required: CompanyFields['work_permit_required'] =
		/work permit|work authorization|right to work/.test(text) ? 'yes' : 'unknown';

	const dateMatch = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(text);

	// Заголовок берём из <title>, режем по длине: длинная строка чужого текста в поле —
	// это тот же свободный текст, только под другим именем.
	const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(doc.body);
	const title = stripInvisible(titleMatch?.[1] ?? '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 200);

	return {
		title,
		remote_mode,
		hires_contractors,
		work_permit_required,
		posted_at: dateMatch?.[1] ?? null,
	};
}
