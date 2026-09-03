/**
 * write-path.test.ts — единственный путь записи в леджер ([ADR-0035]).
 *
 * Проверяет ровно то, из-за чего ADR появился: пачка либо ложится на диск целиком, либо не
 * ложится вовсе (без частичной записи), новая запись отклика не проходит без площадки, а
 * история без неё продолжает читаться, и сплошная проверка находит порчу по всем файлам
 * спецификации, а не по одному.
 *
 * Плюс — то, ради чего `appendBatch`/`validateAll` обобщены до параметра `LedgerSpec`
 * ([ADR-0035] «Следствия»: «учебный журнал пишется тем же путём: `pnpm learn:append`»):
 * тот же путь записи, применённый к СОВСЕМ ДРУГОМУ леджеру (журнал повторений учебного
 * контура, `../learning/reviews.ts`), без единой строчки, специфичной для jobsearch.
 *
 * Данные синтетические: `example.com`, `Acme`.
 */

import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CompanyRecord } from './companies.js';
import type { ApplicationRecord } from './events.js';
import { createJobsearchLedger, type JobsearchLedger } from './ledger.js';
import { appendBatch, JOBSEARCH_APPEND_SPEC, validateAll } from './write-path.js';

import { createLearningLedger, LEARNING_LEDGER, type LearningLedger, type ReviewEvent } from '../learning/reviews.js';

const TS = '2026-09-02T10:00:00Z';

function assessedUnknown<T extends string>(value: T) {
	return { value, source: 'manual' as const, confirmed_by_human: false, confirmed_at: null };
}

/** Валидная компания — тот же факторинг, что и в companies.test.ts. */
function company(patch: Partial<CompanyRecord> = {}): CompanyRecord {
	return {
		id: 'acme-example-com',
		site_domain: 'acme.example.com',
		name: 'Acme',
		company_type: assessedUnknown('startup'),
		stage: assessedUnknown('seed'),
		remote_mode: assessedUnknown('remote_100'),
		hires_contractors: assessedUnknown('yes'),
		work_permit_required: assessedUnknown('unknown'),
		interview_language: assessedUnknown('en'),
		hq_country: assessedUnknown('Synthetica'),
		timezone_overlap: assessedUnknown('UTC+0'),
		has_warm_contact: assessedUnknown('no'),
		hiring_status: assessedUnknown('active'),
		fit_rank: 0,
		provenance: {
			company_source: 'manual',
			fetched_at: TS,
			parser_version: 'manual-1',
			robots_ok: true,
		},
		ts: TS,
		...patch,
	} as CompanyRecord;
}

/** Старая запись отклика: без platform/external_id/url/applied_via — как до ADR-0033. */
function oldApplication(id: string, patch: Partial<ApplicationRecord> = {}): ApplicationRecord {
	return {
		id,
		company_id: 'acme-example-com',
		role_title: 'Backend Engineer',
		company_source: 'manual',
		submission_channel: 'direct',
		applied_at: TS,
		ts: TS,
		...patch,
	};
}

/** Новая запись отклика: площадка/внешний id/url/способ подачи заполнены как требует CLI. */
function newApplication(id: string, patch: Partial<ApplicationRecord> = {}): ApplicationRecord {
	return {
		...oldApplication(id),
		platform: 'hh',
		external_id: 'hh136857307',
		url: 'https://hh.ru/vacancy/136857307',
		applied_via: 'hh',
		...patch,
	};
}

/** Валидное событие журнала повторений — тот же факторинг, что и в reviews.test.ts. */
function reviewEvent(
	concept: string,
	kind: ReviewEvent['kind'],
	boxAfter: number,
	patch: Partial<ReviewEvent> = {},
): ReviewEvent {
	return { ts: TS, concept, kind, box_after: boxAfter, ...patch };
}

let tmpDir: string;
let ledger: JobsearchLedger;
let learningLedger: LearningLedger;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'jobsearch-write-path-test-'));
	ledger = createJobsearchLedger({
		dir: join(tmpDir, 'raw', 'jobsearch'),
		publicRepoRoot: join(tmpDir, 'public-fake'),
	});
	learningLedger = createLearningLedger({
		dir: join(tmpDir, 'raw', 'learning'),
		publicRepoRoot: join(tmpDir, 'public-fake'),
	});
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. appendBatch (jobsearch) — всё или ничего
// ---------------------------------------------------------------------------

describe('appendBatch — леджер поиска работы', () => {
	it('валидная пачка компаний записывается целиком, readback совпадает с файлом', () => {
		const rows: unknown[] = [
			company({ id: 'acme-example-com' }),
			company({ id: 'beta-example-com', site_domain: 'beta.example.com', name: 'Beta' }),
		];

		const result = appendBatch(ledger, JOBSEARCH_APPEND_SPEC, 'companies', rows);

		expect(result.ok).toBe(true);
		expect(result.written).toBe(2);
		expect(result.errors).toEqual([]);
		expect(result.records.map((r) => r.id)).toEqual(['acme-example-com', 'beta-example-com']);

		// readback честный: то, что вернула функция, реально лежит в файле леджера.
		const onDisk = ledger.readAll('companies');
		expect(onDisk.map((r) => r.id)).toEqual(['acme-example-com', 'beta-example-com']);
	});

	it('пачка с одной битой строкой не пишется вовсе', () => {
		const rows: unknown[] = [
			company({ id: 'acme-example-com' }),
			{ id: 'broken', name: 'без обязательных полей' }, // не пройдёт CompanyRecordSchema
			company({ id: 'beta-example-com', site_domain: 'beta.example.com', name: 'Beta' }),
		];

		const result = appendBatch(ledger, JOBSEARCH_APPEND_SPEC, 'companies', rows);

		expect(result.ok).toBe(false);
		expect(result.written).toBe(0);
		expect(result.records).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.line).toBe(2); // позиция битой строки в rows, 1-based

		// Файла нет вовсе — ни одна из двух валидных строк не долетела до диска.
		expect(existsSync(result.path)).toBe(false);
	});

	it('dry-run валидирует пачку, но ничего не пишет', () => {
		const result = appendBatch(ledger, JOBSEARCH_APPEND_SPEC, 'companies', [company()], { dryRun: true });

		expect(result.ok).toBe(true);
		expect(result.dryRun).toBe(true);
		expect(result.written).toBe(0);
		expect(result.records).toHaveLength(1);
		expect(existsSync(result.path)).toBe(false);
	});

	it('новая запись отклика без platform отклоняется, а такая же старая запись читается без ошибки', () => {
		// Новую запись пишем ЧЕРЕЗ CLI-путь — здесь действует строгая NewApplicationRecordSchema
		// (JOBSEARCH_APPEND_SPEC подменяет схему 'applications', см. пункт 4 в шапке write-path.ts).
		const rejected = appendBatch(ledger, JOBSEARCH_APPEND_SPEC, 'applications', [oldApplication('app-new-1')]);
		expect(rejected.ok).toBe(false);
		expect(rejected.errors).toHaveLength(1);
		expect(rejected.errors[0]?.message).toMatch(/platform/);

		// Та же форма записи, но заведённая как ИСТОРИЯ (напрямую через Ledger.append,
		// т.е. до ADR-0033), обязана читаться без единого пропуска.
		ledger.append('applications', oldApplication('app-old-1'));
		const skips: unknown[] = [];
		const historyLedger = createJobsearchLedger({
			dir: join(tmpDir, 'raw', 'jobsearch'),
			publicRepoRoot: join(tmpDir, 'public-fake'),
			onSkip: (s) => skips.push(s),
		});
		const onDisk = historyLedger.readAll('applications');

		expect(skips).toEqual([]);
		expect(onDisk.map((a) => a.id)).toEqual(['app-old-1']);

		// А новая запись С площадкой проходит тот же CLI-путь как положено.
		const accepted = appendBatch(ledger, JOBSEARCH_APPEND_SPEC, 'applications', [newApplication('app-new-2')]);
		expect(accepted.ok).toBe(true);
		expect(accepted.written).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// 2. appendBatch (обучение) — тот же путь для СОВСЕМ ДРУГОГО LedgerSpec
// ---------------------------------------------------------------------------

describe('appendBatch — леджер учебного контура (generic LedgerSpec, не jobsearch)', () => {
	it('валидная пачка событий повторения записывается в учебный леджер целиком, readback совпадает с файлом', () => {
		const rows: unknown[] = [
			reviewEvent('spaced-repetition', 'ingest', 0),
			reviewEvent('leitner-system', 'lesson', 1, { score: 0.8 }),
		];

		const result = appendBatch(learningLedger, LEARNING_LEDGER, 'reviews', rows);

		expect(result.ok).toBe(true);
		expect(result.written).toBe(2);
		expect(result.errors).toEqual([]);

		const onDisk = learningLedger.readAll('reviews');
		expect(onDisk.map((r) => r.concept)).toEqual(['spaced-repetition', 'leitner-system']);
	});

	it('пачка с одной битой строкой не пишется вовсе', () => {
		const rows: unknown[] = [
			reviewEvent('spaced-repetition', 'ingest', 0),
			{ ts: TS, concept: 'без box_after' }, // не пройдёт ReviewEventSchema
			reviewEvent('leitner-system', 'lesson', 1, { score: 0.8 }),
		];

		const result = appendBatch(learningLedger, LEARNING_LEDGER, 'reviews', rows);

		expect(result.ok).toBe(false);
		expect(result.written).toBe(0);
		expect(result.records).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.line).toBe(2);
		expect(existsSync(result.path)).toBe(false);
	});

	it('событие вне словаря kind отвергнуто', () => {
		const rows: unknown[] = [{ ts: TS, concept: 'spaced-repetition', kind: 'exam', box_after: 0 }];

		const result = appendBatch(learningLedger, LEARNING_LEDGER, 'reviews', rows);

		expect(result.ok).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.message).toMatch(/kind/);
		expect(existsSync(result.path)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 3. validateAll — сплошная проверка леджеров
// ---------------------------------------------------------------------------

describe('validateAll', () => {
	it('на чистом леджере со всеми файлами по спецификации — пустой список', () => {
		ledger.append('companies', company());
		ledger.append('applications', newApplication('app-1'));

		expect(validateAll(ledger)).toEqual([]);
	});

	it('на леджере без единой записи — пустой список (нет файлов = нет пропусков)', () => {
		expect(validateAll(ledger)).toEqual([]);
	});

	it('битая строка в companies.jsonl даёт непустой список с файлом, номером строки и причиной', () => {
		ledger.append('companies', company());
		const path = ledger.filePath('companies');
		// Дописываем строки в обход Ledger.append — ровно то, что порождало дефект ADR-0035.
		appendFileSync(path, 'не json совсем\n', 'utf8');
		appendFileSync(path, JSON.stringify({ id: 'нет обязательных полей' }) + '\n', 'utf8');

		const skips = validateAll(ledger);

		expect(skips).toHaveLength(2);
		expect(skips.every((s) => s.file === 'companies')).toBe(true);
		expect(skips.map((s) => s.reason)).toEqual(['json', 'schema']);
		expect(skips[0]?.line).toBe(2);
		expect(skips[1]?.line).toBe(3);
	});

	it('сплошная проверка находит порчу в ДВУХ РАЗНЫХ файлах спецификации, а не только в первом', () => {
		ledger.append('companies', company());

		const companiesPath = ledger.filePath('companies');
		const eventsPath = ledger.filePath('application_events');

		// Порча в двух разных файлах, один из которых НЕ первый по порядку
		// JOBSEARCH_LEDGER_FILES ('companies' первый, 'application_events' четвёртый) — тест на
		// мутацию, которая сужает цикл validateAll до префикса списка файлов. Прежний тест
		// портил только 'companies' (первый файл) и такую мутацию пережил бы молча.
		appendFileSync(companiesPath, JSON.stringify({ id: 'нет обязательных полей' }) + '\n', 'utf8');
		appendFileSync(eventsPath, 'не json совсем\n', 'utf8');

		const skips = validateAll(ledger);

		expect(skips).toHaveLength(2);
		expect(skips.map((s) => s.file).sort()).toEqual(['application_events', 'companies']);
		expect(skips.find((s) => s.file === 'companies')?.reason).toBe('schema');
		expect(skips.find((s) => s.file === 'application_events')?.reason).toBe('json');
	});

	it('работает с любым LedgerSpec, не только jobsearch — леджер учебного контура', () => {
		learningLedger.append('reviews', reviewEvent('spaced-repetition', 'ingest', 0));
		const path = learningLedger.filePath('reviews');
		// Порча в обход Ledger.append, как и в остальных проверках validateAll.
		appendFileSync(path, JSON.stringify({ ts: TS, concept: 'x', kind: 'exam', box_after: 0 }) + '\n', 'utf8');

		const skips = validateAll(learningLedger, LEARNING_LEDGER);

		expect(skips).toHaveLength(1);
		expect(skips[0]).toMatchObject({ file: 'reviews', line: 2, reason: 'schema' });
	});
});
