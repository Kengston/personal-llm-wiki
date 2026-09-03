/**
 * write-path.test.ts — единственный путь записи в леджер ([ADR-0035]).
 *
 * Проверяет ровно то, из-за чего ADR появился: пачка либо ложится на диск целиком, либо не
 * ложится вовсе (без частичной записи), новая запись отклика не проходит без площадки, а
 * история без неё продолжает читаться, и сплошная проверка находит порчу по всем файлам
 * спецификации, а не по одному.
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
import { appendBatch, validateAll } from './write-path.js';

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

let tmpDir: string;
let ledger: JobsearchLedger;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'jobsearch-write-path-test-'));
	ledger = createJobsearchLedger({
		dir: join(tmpDir, 'raw', 'jobsearch'),
		publicRepoRoot: join(tmpDir, 'public-fake'),
	});
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. appendBatch — всё или ничего
// ---------------------------------------------------------------------------

describe('appendBatch', () => {
	it('валидная пачка компаний записывается целиком, readback совпадает с файлом', () => {
		const rows: unknown[] = [
			company({ id: 'acme-example-com' }),
			company({ id: 'beta-example-com', site_domain: 'beta.example.com', name: 'Beta' }),
		];

		const result = appendBatch(ledger, 'companies', rows);

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

		const result = appendBatch(ledger, 'companies', rows);

		expect(result.ok).toBe(false);
		expect(result.written).toBe(0);
		expect(result.records).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.line).toBe(2); // позиция битой строки в rows, 1-based

		// Файла нет вовсе — ни одна из двух валидных строк не долетела до диска.
		expect(existsSync(result.path)).toBe(false);
	});

	it('dry-run валидирует пачку, но ничего не пишет', () => {
		const result = appendBatch(ledger, 'companies', [company()], { dryRun: true });

		expect(result.ok).toBe(true);
		expect(result.dryRun).toBe(true);
		expect(result.written).toBe(0);
		expect(result.records).toHaveLength(1);
		expect(existsSync(result.path)).toBe(false);
	});

	it('новая запись отклика без platform отклоняется, а такая же старая запись читается без ошибки', () => {
		// Новую запись пишем ЧЕРЕЗ CLI-путь — здесь действует строгая NewApplicationRecordSchema.
		const rejected = appendBatch(ledger, 'applications', [oldApplication('app-new-1')]);
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
		const accepted = appendBatch(ledger, 'applications', [newApplication('app-new-2')]);
		expect(accepted.ok).toBe(true);
		expect(accepted.written).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// 2. validateAll — сплошная проверка леджеров
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
});
