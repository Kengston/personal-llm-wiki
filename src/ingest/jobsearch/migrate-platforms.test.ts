/**
 * migrate-platforms.test.ts — миграция воронки под реестр площадок ([ADR-0033], R3/R8).
 *
 * Вход — СЫРЫЕ объекты (не типизированные записи): старые строки несут значения вне
 * текущих enum'ов (`submission_channel: linkedin_easy_apply`, `event.kind: note`), и
 * именно их чинит миграция — прогнать их заранее через текущую схему нельзя, она на этом
 * и упадёт (см. шапку `migrate-platforms.ts`, пункт 1). Фикстуры ниже — синтетические
 * `example.com`-домены, реальных данных здесь нет.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	applyMigration,
	diffStageCounts,
	MigrationInvariantError,
	parseVacancyRef,
	planMigration,
	type MigrationInputRecords,
	type MigrationPlan,
	type RawRecord,
} from './migrate-platforms.js';

const TS = '2026-08-01T00:00:00Z';

function rawCompany(id: string, domain: string, patch: RawRecord = {}): RawRecord {
	const unknown = (value: string) => ({ value, source: 'manual', confirmed_by_human: false, confirmed_at: null });
	return {
		id,
		site_domain: domain,
		name: domain,
		company_type: unknown('unknown'),
		stage: unknown('unknown'),
		remote_mode: unknown('unknown'),
		hires_contractors: unknown('unknown'),
		work_permit_required: unknown('unknown'),
		interview_language: unknown('unknown'),
		hq_country: unknown('unknown'),
		timezone_overlap: unknown('unknown'),
		has_warm_contact: unknown('unknown'),
		hiring_status: unknown('unknown'),
		fit_rank: 0,
		provenance: { company_source: 'manual', fetched_at: TS, parser_version: 'test-1', robots_ok: true },
		ts: TS,
		...patch,
	};
}

function rawApplication(id: string, companyId: string, patch: RawRecord = {}): RawRecord {
	return {
		id,
		company_id: companyId,
		role_title: 'Backend Engineer',
		company_source: 'manual',
		submission_channel: 'direct',
		applied_at: TS,
		ts: TS,
		...patch,
	};
}

function rawEvent(id: string, applicationId: string, patch: RawRecord = {}): RawRecord {
	return {
		id,
		application_id: applicationId,
		ts: TS,
		kind: 'stage_change',
		stage: 'applied',
		source: 'owner',
		...patch,
	};
}

function input(patch: Partial<MigrationInputRecords> = {}): MigrationInputRecords {
	return { companies: [], applications: [], events: [], ...patch };
}

// ---------------------------------------------------------------------------
// 1. Разбор vacancy_ref
// ---------------------------------------------------------------------------

describe('parseVacancyRef', () => {
	it('URL hh.ru → площадка hh, external_id с префиксом hh, url без query', () => {
		const parsed = parseVacancyRef('https://hh.ru/vacancy/136857307?query=1');
		expect(parsed.platform).toBe('hh');
		expect(parsed.externalId).toBe('hh136857307');
		expect(parsed.url).toBe('https://hh.ru/vacancy/136857307');
	});

	it('URL linkedin.com → площадка linkedin, external_id с префиксом li', () => {
		const parsed = parseVacancyRef('https://www.linkedin.com/jobs/view/4021234567/');
		expect(parsed.platform).toBe('linkedin');
		expect(parsed.externalId).toBe('li4021234567');
	});

	it('тег platform:ext_id → площадка напрямую', () => {
		expect(parseVacancyRef('ashby:abc123')).toEqual({ platform: 'ashby', externalId: 'asabc123' });
		expect(parseVacancyRef('greenhouse:98765')).toEqual({ platform: 'greenhouse', externalId: 'gh98765' });
	});

	it('неизвестный домен → site, внешнего id нет (длинный хвост карьерных страниц)', () => {
		const parsed = parseVacancyRef('https://careers.example.com/jobs/42');
		expect(parsed.platform).toBe('site');
		expect(parsed.externalId).toBeUndefined();
		expect(parsed.url).toBe('https://careers.example.com/jobs/42');
	});

	it('пустая ссылка → поля не проставляются', () => {
		expect(parseVacancyRef(undefined)).toEqual({});
		expect(parseVacancyRef('')).toEqual({});
		expect(parseVacancyRef('   ')).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// 2. planMigration — компании
// ---------------------------------------------------------------------------

describe('слияние компаний по домену', () => {
	it('два разных старых id на одном домене сливаются в один канонический, application.company_id переписывается', () => {
		const plan = planMigration(
			input({
				companies: [
					rawCompany('rho-a', 'rho.example.com'),
					rawCompany('rho-b', 'rho.example.com', { ts: '2026-08-02T00:00:00Z' }),
				],
				applications: [rawApplication('app-1', 'rho-b')],
			}),
		);

		const canonical = plan.companies[0]!.id;
		expect(plan.companies.every((c) => c.id === canonical)).toBe(true);
		expect(plan.companies).toHaveLength(2); // ничего не удалено

		const aliasFroms = plan.report.companyAliases.map((a) => a.from).sort();
		expect(aliasFroms).toEqual(['rho-a', 'rho-b'].sort());
		expect(plan.report.companyAliases.every((a) => a.to === canonical)).toBe(true);

		expect(plan.applications[0]!.company_id).toBe(canonical);
	});

	it('коллизия слага двух разных доменов — в отчёт, оба id остаются уникальными', () => {
		// normalizeDomain нормализует оба к разным hostname, но допустим, что их слаги
		// совпадают искусственно за счёт одинакового вида после companyIdFromDomain.
		const plan = planMigration(
			input({
				companies: [rawCompany('a1', 'foo.bar.com'), rawCompany('a2', 'foo-bar.com')],
			}),
		);

		expect(plan.report.companySlugCollisions.length).toBeGreaterThan(0);
		const ids = plan.companies.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length); // уникальны
	});
});

describe('нормализация значений компаний', () => {
	/** Компания с одним изменённым assessed-полем; остальные — 'unknown' по умолчанию. */
	function companyWithField(field: string, value: string): RawRecord {
		return rawCompany('acme', 'acme.example.com', {
			[field]: { value, source: 'manual', confirmed_by_human: true, confirmed_at: TS },
		});
	}

	it('remote_mode/stage/company_type: значения-синонимы приводятся к канoническому члену словаря, происхождение факта не трогается', () => {
		const synonyms: Array<[field: string, from: string, to: string]> = [
			['remote_mode', 'remote_first', 'remote_100'],
			['remote_mode', 'remote_global', 'remote_100'],
			['remote_mode', 'remote_eu', 'remote_country_bound'],
			['remote_mode', 'remote_country', 'remote_country_bound'],
			['stage', 'series_b', 'series_b_plus'],
			['stage', 'series_c', 'series_b_plus'],
			['stage', 'early', 'seed'],
			['stage', 'pre_seed_seed', 'seed'],
			['company_type', 'product_startup', 'startup'],
			['company_type', 'agency_outsourcing', 'outsourcing_outstaff'],
		];

		for (const [field, from, to] of synonyms) {
			const plan = planMigration(input({ companies: [companyWithField(field, from)] }));
			const patched = (plan.companies[0] as unknown as Record<string, RawRecord>)[field]!;
			expect(patched.value, `${field}: ${from} → ${to}`).toBe(to);
			// source/confirmed_at/confirmed_by_human — происхождение факта, не сам факт.
			expect(patched.source).toBe('manual');
			expect(patched.confirmed_by_human).toBe(true);
			expect(patched.confirmed_at).toBe(TS);
			expect(plan.report.validationErrors).toEqual([]);
		}
	});

	it('stage: private, company_type: product, interview_language: es/it — факт не выводится из значения, уходит в unknown/other без словаря-расширения', () => {
		const noFact: Array<[field: string, from: string, to: string]> = [
			['stage', 'private', 'unknown'],
			['company_type', 'product', 'unknown'],
			['interview_language', 'es', 'other'],
			['interview_language', 'it', 'other'],
		];

		for (const [field, from, to] of noFact) {
			const plan = planMigration(input({ companies: [companyWithField(field, from)] }));
			const patched = (plan.companies[0] as unknown as Record<string, RawRecord>)[field]!;
			expect(patched.value, `${field}: ${from} → ${to}`).toBe(to);
			expect(plan.report.validationErrors).toEqual([]);
		}
	});

	it('нормализация значения компании пишется в отчёт с правильным правилом', () => {
		const plan = planMigration(input({ companies: [companyWithField('remote_mode', 'remote_first')] }));
		expect(plan.report.normalizations).toContainEqual(
			expect.objectContaining({
				rule: 'company_remote_mode_normalized',
				recordType: 'company',
				from: 'remote_first',
				to: 'remote_100',
			}),
		);
	});
});

// ---------------------------------------------------------------------------
// 3. planMigration — отклики: id, повторы, нормализация
// ---------------------------------------------------------------------------

describe('id отклика и повторный отклик', () => {
	it('одиночный отклик получает id = external_id, без суффикса', () => {
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com')],
				applications: [
					rawApplication('old-1', 'acme', { vacancy_ref: 'https://hh.ru/vacancy/136857307' }),
				],
			}),
		);
		expect(plan.applications[0]!.id).toBe('hh136857307');
		expect(plan.report.applicationAliases).toContainEqual({ from: 'old-1', to: 'hh136857307' });
		expect(plan.report.repeatApplications).toHaveLength(0);
	});

	it('повторный отклик на ту же вакансию получает суффикс -r2 и попадает в отчёт', () => {
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com')],
				applications: [
					rawApplication('old-early', 'acme', {
						vacancy_ref: 'https://hh.ru/vacancy/136857307',
						applied_at: '2026-06-01T00:00:00Z',
						ts: '2026-06-01T00:00:00Z',
					}),
					rawApplication('old-late', 'acme', {
						vacancy_ref: 'https://hh.ru/vacancy/136857307',
						applied_at: '2026-08-01T00:00:00Z',
						ts: '2026-08-01T00:00:00Z',
					}),
				],
			}),
		);

		const ids = plan.applications.map((a) => a.id).sort();
		expect(ids).toEqual(['hh136857307', 'hh136857307-r2']);
		expect(plan.report.repeatApplications).toHaveLength(1);
		expect(plan.report.repeatApplications[0]!).toMatchObject({
			assignedId: 'hh136857307-r2',
			baseId: 'hh136857307',
			originalId: 'old-late',
		});
	});

	it('перезапись отклика (тот же старый id, тот же applied_at) — один новый id, без суффикса, не коллизия', () => {
		// Append-only: вторая строка правит первую (другой ts, тот же applied_at), а не
		// подаёт второй раз.
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com')],
				applications: [
					rawApplication('billing', 'acme', {
						vacancy_ref: 'https://hh.ru/vacancy/136857307',
						applied_at: '2026-08-21T10:18:19Z',
						ts: '2026-08-21T10:18:19Z',
					}),
					rawApplication('billing', 'acme', {
						vacancy_ref: 'https://hh.ru/vacancy/136857307',
						applied_at: '2026-08-21T10:18:19Z',
						ts: '2026-08-21T11:06:44Z',
					}),
				],
			}),
		);

		expect(plan.applications.map((a) => a.id)).toEqual(['hh136857307', 'hh136857307']);
		expect(plan.report.repeatApplications).toHaveLength(0);
		expect(plan.report.validationErrors).toEqual([]);
		expect(plan.report.applicationAliases).toEqual([{ from: 'billing', to: 'hh136857307' }]);
	});

	it('повторный отклик под ТЕМ ЖЕ старым id, но разным applied_at, получает -r2 — суффикс достаётся более позднему', () => {
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com')],
				applications: [
					rawApplication('role-x', 'acme', {
						vacancy_ref: 'https://hh.ru/vacancy/136857307',
						applied_at: '2026-08-09T00:00:00Z',
						ts: '2026-08-09T00:00:00Z',
					}),
					rawApplication('role-x', 'acme', {
						vacancy_ref: 'https://hh.ru/vacancy/136857307',
						applied_at: '2026-09-02T00:00:00Z',
						ts: '2026-09-02T00:00:00Z',
					}),
				],
			}),
		);

		const ids = plan.applications.map((a) => a.id).sort();
		expect(ids).toEqual(['hh136857307', 'hh136857307-r2']);
		expect(plan.report.repeatApplications).toHaveLength(1);
		expect(plan.report.repeatApplications[0]!).toMatchObject({
			assignedId: 'hh136857307-r2',
			baseId: 'hh136857307',
			originalId: 'role-x',
			appliedAt: '2026-09-02T00:00:00Z',
		});
		expect(plan.report.validationErrors).toEqual([]);
	});

	it('три перезаписи одной записи остаются тремя строками с одним id', () => {
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com')],
				applications: [
					rawApplication('bp', 'acme', {
						vacancy_ref: 'https://hh.ru/vacancy/136857307',
						applied_at: '2026-08-21T10:18:19Z',
						ts: '2026-08-21T10:18:19Z',
					}),
					rawApplication('bp', 'acme', {
						vacancy_ref: 'https://hh.ru/vacancy/136857307',
						applied_at: '2026-08-21T10:18:19Z',
						ts: '2026-08-21T11:06:44Z',
					}),
					rawApplication('bp', 'acme', {
						vacancy_ref: 'https://hh.ru/vacancy/136857307',
						applied_at: '2026-08-21T10:18:19Z',
						ts: '2026-08-21T10:18:19Z',
					}),
				],
			}),
		);

		expect(plan.applications).toHaveLength(3);
		expect(plan.applications.every((a) => a.id === 'hh136857307')).toBe(true);
		expect(plan.report.invariant.ok).toBe(true);
		expect(plan.report.validationErrors).toEqual([]);
	});

	it('отклик без внешнего id (site/email) сохраняет прежний id', () => {
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com')],
				applications: [
					rawApplication('keep-me', 'acme', { vacancy_ref: 'https://careers.example.com/jobs/1' }),
				],
			}),
		);
		expect(plan.applications[0]!.id).toBe('keep-me');
		expect(plan.applications[0]!.platform).toBe('site');
		expect(plan.report.applicationAliases).toHaveLength(0);
	});
});

describe('нормализация значений', () => {
	it('submission_channel: linkedin_easy_apply → direct + applied_via: linkedin', () => {
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com')],
				applications: [rawApplication('a1', 'acme', { submission_channel: 'linkedin_easy_apply' })],
			}),
		);
		expect(plan.applications[0]!.submission_channel).toBe('direct');
		expect(plan.applications[0]!.applied_via).toBe('linkedin');
		expect(plan.report.normalizations).toContainEqual(
			expect.objectContaining({ rule: 'submission_channel_easy_apply', from: 'linkedin_easy_apply' }),
		);
	});

	it('submission_channel: company_site → direct + applied_via: site', () => {
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com')],
				applications: [rawApplication('a1', 'acme', { submission_channel: 'company_site' })],
			}),
		);
		expect(plan.applications[0]!.submission_channel).toBe('direct');
		expect(plan.applications[0]!.applied_via).toBe('site');
	});

	it('submission_channel: email → direct + applied_via: email', () => {
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com')],
				applications: [rawApplication('a1', 'acme', { submission_channel: 'email' })],
			}),
		);
		expect(plan.applications[0]!.submission_channel).toBe('direct');
		expect(plan.applications[0]!.applied_via).toBe('email');
	});

	it('событие source: manual и пустой → owner', () => {
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com')],
				applications: [rawApplication('a1', 'acme')],
				events: [
					rawEvent('e1', 'a1', { source: 'manual' }),
					rawEvent('e2', 'a1', { source: '' }),
				],
			}),
		);
		expect(plan.events.every((e) => e.source === 'owner')).toBe(true);
		expect(plan.report.normalizations.filter((n) => n.rule === 'event_source_normalized')).toHaveLength(2);
	});

	it('событие kind: note → touchpoint + touch_kind: other, без stage', () => {
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com')],
				applications: [rawApplication('a1', 'acme')],
				events: [rawEvent('e1', 'a1', { kind: 'note', stage: undefined, note: 'позвонил рекрутёру' })],
			}),
		);
		const event = plan.events[0]!;
		expect(event.kind).toBe('touchpoint');
		expect(event.touch_kind).toBe('other');
		expect(event.stage).toBeUndefined();
		expect(plan.report.validationErrors).toHaveLength(0);
	});

	it('touchpoint без touch_kind → other', () => {
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com')],
				applications: [rawApplication('a1', 'acme')],
				events: [rawEvent('e1', 'a1', { kind: 'touchpoint', stage: undefined, touch_kind: undefined })],
			}),
		);
		expect(plan.events[0]!.touch_kind).toBe('other');
	});

	it('событие reason_note: null исчезает, а не становится пустой строкой', () => {
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com')],
				applications: [rawApplication('a1', 'acme')],
				events: [rawEvent('e1', 'a1', { reason_note: null })],
			}),
		);
		const event = plan.events[0]!;
		expect(event.reason_note).toBeUndefined();
		expect(event.reason_note === '').toBe(false);
		expect(plan.report.normalizations).toContainEqual(
			expect.objectContaining({ rule: 'event_reason_note_null_removed', recordType: 'event', from: null }),
		);
		expect(plan.report.validationErrors).toEqual([]);
	});

	it('событие с id длиннее 64 символов (реальный случай в леджере) получает синтезированный id и не коллидирует с уже существующим id в том же файле', () => {
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com')],
				applications: [rawApplication('a1', 'acme')],
				events: [
					// Занимает базовый id заранее — вторая запись обязана получить суффикс.
					rawEvent('a1-applied', 'a1', { stage: 'applied' }),
					rawEvent('x'.repeat(70), 'a1', { stage: 'applied' }),
				],
			}),
		);

		const ids = plan.events.map((e) => e.id);
		expect(new Set(ids).size).toBe(2);
		expect(ids).toContain('a1-applied');
		const synthesized = ids.find((id) => id !== 'a1-applied')!;
		expect(synthesized.startsWith('a1-applied-')).toBe(true);
		expect(plan.report.normalizations).toContainEqual(
			expect.objectContaining({ rule: 'event_id_synthesized', recordType: 'event', to: synthesized }),
		);
		expect(plan.report.validationErrors).toEqual([]);
	});

	it('синтез id события учитывает application_id ПОСЛЕ переписывания по карте алиасов', () => {
		// vacancy_ref даёт отклику новый id (hh…) — событие без своего id обязано
		// синтезироваться от НОВОЙ ссылки, а не от старой.
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com')],
				applications: [
					rawApplication('old-app', 'acme', { vacancy_ref: 'https://hh.ru/vacancy/136857307' }),
				],
				events: [rawEvent('placeholder', 'old-app', { stage: 'applied', id: null })],
			}),
		);

		expect(plan.applications[0]!.id).toBe('hh136857307');
		expect(plan.events[0]!.application_id).toBe('hh136857307');
		expect(plan.events[0]!.id).toBe('hh136857307-applied');
	});
});

// ---------------------------------------------------------------------------
// 4. Ссылки событий на отклики
// ---------------------------------------------------------------------------

describe('переписанные ссылки событий', () => {
	it('application_id события переписывается по карте алиасов отклика', () => {
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com')],
				applications: [
					rawApplication('old-app', 'acme', { vacancy_ref: 'https://hh.ru/vacancy/136857307' }),
				],
				events: [rawEvent('e1', 'old-app', { stage: 'replied' })],
			}),
		);

		expect(plan.applications[0]!.id).toBe('hh136857307');
		expect(plan.events[0]!.application_id).toBe('hh136857307');
		expect(plan.report.eventApplicationIdRewrites).toContainEqual({
			eventId: 'e1',
			from: 'old-app',
			to: 'hh136857307',
		});
	});

	it('при повторном отклике под одним старым application_id событие резолвится в occurrence по своему ts', () => {
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com')],
				applications: [
					rawApplication('role-x', 'acme', {
						vacancy_ref: 'https://hh.ru/vacancy/111',
						applied_at: '2026-08-09T00:00:00Z',
						ts: '2026-08-09T00:00:00Z',
					}),
					rawApplication('role-x', 'acme', {
						vacancy_ref: 'https://hh.ru/vacancy/222',
						applied_at: '2026-09-02T00:00:00Z',
						ts: '2026-09-02T00:00:00Z',
					}),
				],
				events: [
					rawEvent('e-early', 'role-x', { ts: '2026-08-09T00:00:00Z', stage: 'applied' }),
					rawEvent('e-late', 'role-x', { ts: '2026-09-02T00:00:00Z', stage: 'applied' }),
				],
			}),
		);

		const earlyEvent = plan.events.find((e) => e.id === 'e-early')!;
		const lateEvent = plan.events.find((e) => e.id === 'e-late')!;
		expect(earlyEvent.application_id).toBe('hh111');
		expect(lateEvent.application_id).toBe('hh222');
	});
});

// ---------------------------------------------------------------------------
// 5. Инвариант
// ---------------------------------------------------------------------------

describe('инвариант счётчиков и стадий', () => {
	function buildLedger(): MigrationInputRecords {
		return {
			companies: [
				rawCompany('rho-a', 'rho.example.com'),
				rawCompany('rho-b', 'rho.example.com', { ts: '2026-08-02T00:00:00Z' }),
				rawCompany('acme', 'acme.example.com'),
			],
			applications: [
				rawApplication('app-1', 'rho-b', { vacancy_ref: 'https://hh.ru/vacancy/111' }),
				rawApplication('app-2', 'acme', { vacancy_ref: 'ashby:xyz' }),
				rawApplication('app-3', 'acme', { vacancy_ref: '' }), // ни разу не обработана событием
			],
			events: [
				rawEvent('e1', 'app-1', { stage: 'applied' }),
				rawEvent('e2', 'app-1', { stage: 'replied' }),
				rawEvent('e3', 'app-2', { stage: 'applied' }),
				rawEvent('e4', 'app-2', {
					stage: 'rejected',
					reason_code: 'no_response',
				}),
			],
		};
	}

	it('число записей и распределение по последней стадии равны до и после', () => {
		const raw = buildLedger();
		const plan = planMigration(raw);

		expect(plan.report.invariant.ok).toBe(true);
		expect(plan.report.invariant.mismatches).toEqual([]);
		expect(plan.companies).toHaveLength(raw.companies.length);
		expect(plan.applications).toHaveLength(raw.applications.length);
		expect(plan.events).toHaveLength(raw.events.length);
		expect(plan.report.invariant.before.stageCounts).toEqual(plan.report.invariant.after.stageCounts);
		// app-3 не имеет stage_change ни разу — должен остаться в стадии "_none" по обе стороны.
		expect(plan.report.invariant.after.stageCounts._none).toBe(1);
		expect(plan.report.validationErrors).toEqual([]);
	});

	it('разведённый повтор прибавляет стадию ровно на себя, и инвариант это принимает', () => {
		// Два отклика на одну вакансию под одним старым id: до миграции fold видел ОДИН
		// отклик и одну стадию applied, после — два. Прибавка тут не потеря контроля, а
		// то, ради чего суффикс -rN и заведён: второй отклик перестаёт быть невидимым.
		const raw = buildLedger();
		raw.applications.push(
			rawApplication('app-1', 'rho-b', {
				vacancy_ref: 'https://hh.ru/vacancy/111',
				applied_at: '2026-08-20T00:00:00Z',
			}),
		);
		raw.events.push(rawEvent('e5', 'app-1', { stage: 'applied', ts: '2026-08-20T00:00:00Z' }));

		const plan = planMigration(raw);

		expect(plan.report.repeatApplications).toHaveLength(1);
		expect(plan.report.invariant.ok).toBe(true);

		// Проверяется суммарная прибавка, а не конкретная стадия: у разведённого повтора
		// события могут не найтись вовсе (оба отклика делили один id, и поток событий под
		// ним неразделим), и тогда он встаёт в `_none`. Инвариант охраняет ровно то, что
		// прибавка объяснена числом повторов, а не то, в какую корзину она легла.
		const sum = (counts: Record<string, number>): number =>
			Object.values(counts).reduce((acc, n) => acc + n, 0);
		expect(
			sum(plan.report.invariant.after.stageCounts) - sum(plan.report.invariant.before.stageCounts),
		).toBe(1);
	});

	it('прибавка, которую нечем объяснить разведёнными повторами, роняет инвариант', () => {
		const raw = buildLedger();
		const plan = planMigration(raw);
		// Подделываем ровно один вход инварианта — распределение «после». Так проверяется
		// сама формула, а не побочный эффект какой-нибудь нормализации.
		const mismatches = diffStageCounts(
			{ applied: 2, replied: 1 },
			{ applied: 4, replied: 1 },
			plan.report.repeatApplications.length,
		);

		expect(mismatches).toHaveLength(1);
		expect(mismatches[0]).toContain('нечем объяснить');
	});

	it('исчезнувшая стадия роняет инвариант всегда, сколько бы ни было повторов', () => {
		const mismatches = diffStageCounts({ applied: 2, replied: 1 }, { applied: 3 }, 1);

		expect(mismatches.some((m) => m.includes('стадия replied') && m.includes('потеряна'))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 6. applyMigration — атомарная запись, dry-run, отказ при провале инварианта
// ---------------------------------------------------------------------------

describe('applyMigration', () => {
	let tmpDir: string;
	let jobsearchDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'jobsearch-migrate-test-'));
		jobsearchDir = join(tmpDir, 'raw', 'jobsearch');
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function samplePlan(): MigrationPlan {
		return planMigration({
			companies: [rawCompany('acme', 'acme.example.com')],
			applications: [
				rawApplication('old-1', 'acme', { vacancy_ref: 'https://hh.ru/vacancy/136857307' }),
			],
			events: [rawEvent('e1', 'old-1', { stage: 'applied' })],
		});
	}

	it('пишет три файла атомарно (временный файл + rename) с мигрированным содержимым', () => {
		const plan = samplePlan();
		applyMigration(plan, { dir: jobsearchDir, publicRepoRoot: join(tmpDir, 'public-fake') });

		expect(existsSync(join(jobsearchDir, 'companies.jsonl'))).toBe(true);
		expect(existsSync(join(jobsearchDir, 'applications.jsonl'))).toBe(true);
		expect(existsSync(join(jobsearchDir, 'application_events.jsonl'))).toBe(true);

		// Никаких временных файлов не осталось.
		const leftovers = readdirSync(jobsearchDir).filter((f) => f.includes('.migrate-tmp-'));
		expect(leftovers).toEqual([]);

		const apps = readFileSync(join(jobsearchDir, 'applications.jsonl'), 'utf8')
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l));
		expect(apps).toHaveLength(1);
		expect(apps[0].id).toBe('hh136857307');

		const events = readFileSync(join(jobsearchDir, 'application_events.jsonl'), 'utf8')
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l));
		expect(events[0].application_id).toBe('hh136857307');
	});

	it('planMigration (dry-run) не создаёт и не меняет файлов', () => {
		// Файлы уже "существуют" — как будто это боевой каталог до миграции.
		writeFileSync(join(tmpDir, 'existing-sentinel.jsonl'), '{"marker":"before"}\n', 'utf8');
		const before = readFileSync(join(tmpDir, 'existing-sentinel.jsonl'), 'utf8');

		samplePlan(); // planMigration уже вызван внутри — эффекта на диск быть не должно

		expect(readFileSync(join(tmpDir, 'existing-sentinel.jsonl'), 'utf8')).toBe(before);
		expect(existsSync(jobsearchDir)).toBe(false); // каталог миграции даже не создан
	});

	it('при провале инварианта applyMigration бросает и не оставляет полуписаного состояния', () => {
		const plan = samplePlan();
		const sabotaged: MigrationPlan = {
			...plan,
			report: {
				...plan.report,
				invariant: { ...plan.report.invariant, ok: false, mismatches: ['искусственный провал теста'] },
			},
		};

		expect(() =>
			applyMigration(sabotaged, { dir: jobsearchDir, publicRepoRoot: join(tmpDir, 'public-fake') }),
		).toThrow(MigrationInvariantError);

		expect(existsSync(jobsearchDir)).toBe(false);
	});
});
