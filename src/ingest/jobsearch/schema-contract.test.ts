/**
 * schema-contract.test.ts — контракт схем площадок и словарей ([ADR-0033]/[ADR-0035]).
 *
 * Схемы (`PLATFORM_IDS`, `COMPANY_SOURCES`, `NewApplicationRecordSchema`,
 * `FormAnswerRecordSchema`, словарь интентов моста) уже написаны главным циклом; этот
 * файл их не меняет, а защищает от отката. Три вещи, ради которых тест устроен именно так:
 *
 *   1. СЛОВАРИ СРАВНИВАЮТСЯ КАК МНОЖЕСТВА, а не как массивы или строки: порядок
 *      перечисления — деталь реализации, а не часть контракта, и падать на нём тест
 *      не должен.
 *
 *   2. СЛОВАРЬ ИНТЕНТОВ ПРОВЕРЯЕТСЯ ЧЕРЕЗ ИНТРОСПЕКЦИЮ zod-схемы (`ZodEnum.options`,
 *      `ZodDefault.removeDefault()`), а не через факт совпадения значений на глаз: если
 *      кто-то однажды впишет в `jobsearch-intent.ts` собственный `z.enum([...])` с теми же
 *      строками вместо импорта `companySource`, тест этого не поймает (значения ведь
 *      совпадают) — но поймает первую же правку словаря в одном месте без другого,
 *      ради которой всё это и заведено ([ADR-0031] §1).
 *
 *   3. ПЕРСИСТЕНЦИЯ ПРОВЕРЯЕТСЯ ЧТЕНИЕМ ФАЙЛА, а не возвратом `Ledger.append` (он и так
 *      `void`): `append` валидирует запись схемой и пишет `result.data` — если бы поле
 *      не было объявлено в схеме, zod бы его молча вырезал (strip по умолчанию), и
 *      единственный способ поймать такую порчу — прочитать байты, которые реально легли
 *      на диск.
 *
 * Данные синтетические, как в `funnel.test.ts`.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { JobsearchIntentSchema } from '../../bridge/jobsearch-intent.js';
import { COMPANY_SOURCES, DISCOVERY_PLATFORM_IDS, NON_PLATFORM_SOURCES } from './companies.js';
import {
	ApplicationRecordSchema,
	NewApplicationRecordSchema,
	type ApplicationEvent,
	type ApplicationRecord,
} from './events.js';
import { FormAnswerRecordSchema } from './form-answers.js';
import { createJobsearchLedger, type JobsearchLedger } from './ledger.js';

const ASOF = '2026-08-02T00:00:00Z';

/** Базовая валидная запись отклика — патчится под конкретный кейс. */
function baseApplication(patch: Partial<ApplicationRecord> = {}): ApplicationRecord {
	return {
		id: 'acme-a1',
		company_id: 'acme-example-com',
		role_title: 'Backend Engineer',
		company_source: 'manual',
		submission_channel: 'direct',
		applied_at: ASOF,
		ts: ASOF,
		...patch,
	};
}

let tmpDir: string;
let ledger: JobsearchLedger;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'jobsearch-schema-contract-test-'));
	ledger = createJobsearchLedger({
		dir: join(tmpDir, 'raw', 'jobsearch'),
		publicRepoRoot: join(tmpDir, 'public-fake'),
	});
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1–2. Обратная совместимость и словарь platform
// ---------------------------------------------------------------------------

describe('ApplicationRecordSchema — базовая (история)', () => {
	it('старая запись без platform/external_id/url/applied_via валидна', () => {
		// Так писалась вся история до реестра площадок — читать её обязаны.
		const legacy = baseApplication();

		expect(ApplicationRecordSchema.safeParse(legacy).success).toBe(true);
	});

	it('platform вне словаря площадок отвергнут', () => {
		const withBogusPlatform = baseApplication({ platform: 'bogus-ats' as ApplicationRecord['platform'] });

		expect(ApplicationRecordSchema.safeParse(withBogusPlatform).success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 3–4. NewApplicationRecordSchema — обязательность для новых записей
// ---------------------------------------------------------------------------

describe('NewApplicationRecordSchema — путь записи для новых откликов', () => {
	it('требует platform/url/applied_via и отвергает запись без них', () => {
		const withoutPlatformTriad = baseApplication();

		expect(NewApplicationRecordSchema.safeParse(withoutPlatformTriad).success).toBe(false);
	});

	it('принимает запись со всей триадой и external_id для площадки hh', () => {
		const complete = baseApplication({
			platform: 'hh',
			external_id: 'hh136857307',
			url: 'https://hh.ru/vacancy/136857307',
			applied_via: 'hh',
		});

		expect(NewApplicationRecordSchema.safeParse(complete).success).toBe(true);
	});

	it('не требует external_id для site и email', () => {
		const viaSite = baseApplication({
			platform: 'site',
			url: 'https://example.com/careers/backend',
			applied_via: 'site',
		});
		const viaEmail = baseApplication({
			platform: 'email',
			url: 'https://example.com/contacts',
			applied_via: 'email',
		});

		expect(NewApplicationRecordSchema.safeParse(viaSite).success).toBe(true);
		expect(NewApplicationRecordSchema.safeParse(viaEmail).success).toBe(true);
	});

	it('требует external_id для hh — площадки с реальным id вакансии', () => {
		const viaHhWithoutExternalId = baseApplication({
			platform: 'hh',
			url: 'https://hh.ru/vacancy/136857307',
			applied_via: 'hh',
		});

		expect(NewApplicationRecordSchema.safeParse(viaHhWithoutExternalId).success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 5. COMPANY_SOURCES — словарь как множество
// ---------------------------------------------------------------------------

describe('COMPANY_SOURCES', () => {
	it('равен объединению не-площадочных источников и площадок-агрегаторов, linkedin включён', () => {
		const expected = new Set<string>([...NON_PLATFORM_SOURCES, ...DISCOVERY_PLATFORM_IDS]);
		const actual = new Set<string>(COMPANY_SOURCES);

		expect(actual).toEqual(expected);
		expect(actual.has('linkedin')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 6. Словарь интентов моста ⊆ словарь леджера (через интроспекцию zod, не на глаз)
// ---------------------------------------------------------------------------

/**
 * enumOptionsOf — значения ZodEnum, снимая обёртку ZodDefault при необходимости.
 * Бросает, если поле оказалось не enum'ом вовсе — это тоже отступление от контракта.
 */
function enumOptionsOf(schema: z.ZodTypeAny): string[] {
	const unwrapped = schema instanceof z.ZodDefault ? schema.removeDefault() : schema;
	if (!(unwrapped instanceof z.ZodEnum)) {
		throw new Error('company_source в интенте должен быть ZodEnum (импортом companySource)');
	}
	return [...unwrapped.options];
}

describe('JobsearchIntentSchema — company_source импортирован, не задублирован литералом', () => {
	it('add_company и add_application принимают ровно словарь леджера (сравнение множеств)', () => {
		const addCompany = JobsearchIntentSchema.optionsMap.get('add_company');
		const addApplication = JobsearchIntentSchema.optionsMap.get('add_application');
		if (!addCompany || !addApplication) {
			throw new Error('ветки add_company/add_application не найдены в JobsearchIntentSchema');
		}

		const addCompanySource = addCompany.shape.company_source;
		const addApplicationSource = addApplication.shape.company_source;
		if (!addCompanySource || !addApplicationSource) {
			throw new Error('поле company_source отсутствует в ветках add_company/add_application');
		}

		const addCompanyValues = new Set(enumOptionsOf(addCompanySource));
		const addApplicationValues = new Set(enumOptionsOf(addApplicationSource));
		const ledgerValues = new Set<string>(COMPANY_SOURCES);

		// Если бы кто-то вписал собственный z.enum([...]) с теми же строками вместо импорта,
		// это сравнение всё равно прошло бы — интроспекция ловит расхождение ПРИ следующей
		// правке словаря в одном месте без другого, а не факт копипасты сейчас.
		expect(addCompanyValues).toEqual(ledgerValues);
		expect(addApplicationValues).toEqual(ledgerValues);
	});
});

// ---------------------------------------------------------------------------
// 7. Событие с occurred_at и note — валидация и персистенция на диске
// ---------------------------------------------------------------------------

describe('application_events — occurred_at и note', () => {
	it('проходит валидацию и переживает запись через Ledger.append (проверка чтением файла)', () => {
		const event: ApplicationEvent = {
			id: 'ev-occurred-1',
			application_id: 'acme-a1',
			ts: ASOF,
			kind: 'touchpoint',
			touch_kind: 'follow_up',
			source: 'owner',
			occurred_at: '2026-08-01T00:00:00Z',
			note: 'напомнил о себе после интервью',
		};

		ledger.append('application_events', event);

		// Не return append() (он void) и не readAll() — берём сырые байты файла, чтобы
		// поймать порчу zod-strip'ом, если бы поля не были объявлены в схеме.
		const raw = readFileSync(ledger.filePath('application_events'), 'utf8');
		const line = raw.trim().split('\n').at(-1) ?? '';
		const persisted = JSON.parse(line) as Record<string, unknown>;

		expect(persisted.occurred_at).toBe('2026-08-01T00:00:00Z');
		expect(persisted.note).toBe('напомнил о себе после интервью');
	});
});

// ---------------------------------------------------------------------------
// 8. form_answers — в спецификации леджера, валидирует реальную форму
// ---------------------------------------------------------------------------

describe('form_answers — леджер ответов на анкеты', () => {
	it('валидирует запись с полями реальной формы и переживает запись через Ledger.append', () => {
		const answer = {
			id: 'visa-sponsorship',
			question: 'Do you now, or will you in the future, require visa sponsorship?',
			answer: 'No, I do not require visa sponsorship.',
			first_used: '2026-06-10',
			source: 'wiki/capability-profile.md',
			platform: 'ashby' as const,
		};

		expect(FormAnswerRecordSchema.safeParse(answer).success).toBe(true);

		ledger.append('form_answers', answer);
		const persisted = ledger.readAll('form_answers');

		expect(persisted).toHaveLength(1);
		expect(persisted[0]?.answer).toBe(answer.answer);
	});
});
