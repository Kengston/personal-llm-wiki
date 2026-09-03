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
	MigrationValidationError,
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

	it('незнакомый префикс тега (epam:, jazzhr:, ...) → site без external_id, а не пустой объект', () => {
		// Находка ревью: раньше незнакомый префикс проваливался в разбор ДОМЕНА
		// (`normalizeDomain('epam:12345')` не даёт домена — там нет точки) и терял
		// площадку вовсе, возвращая `{}`. Пять записей (`epam:`, `jazzhr:` и другие)
		// оставались совсем без platform. Ведёт себя как ветка домена: неизвестное → site.
		expect(parseVacancyRef('epam:12345')).toEqual({ platform: 'site' });
		expect(parseVacancyRef('jazzhr:some-id')).toEqual({ platform: 'site' });
	});

	it('iCIMS: значащий сегмент — число из /jobs/<N>/, а не литерал /job на конце пути', () => {
		// Находка ревью: у iCIMS путь ВСЕГДА кончается литералом `/job` — если брать
		// последний сегмент не глядя, ЛЮБАЯ вакансия iCIMS даёт один и тот же external_id
		// `icjob`. Значащий сегмент — число сразу после литерала `jobs`.
		const parsed = parseVacancyRef('https://careers-acme.icims.com/jobs/70142/backend-engineer/job');
		expect(parsed.platform).toBe('icims');
		expect(parsed.externalId).toBe('ic70142');
	});

	it('iCIMS: без сегмента jobs в пути — фолбэк на первый чисто числовой сегмент', () => {
		const parsed = parseVacancyRef('https://careers-x.icims.com/12345/some-title');
		expect(parsed.platform).toBe('icims');
		expect(parsed.externalId).toBe('ic12345');
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

	it('stage: private, company_type: product, interview_language: es/it, remote_mode: remote_first — факт не выводится из значения, уходит в unknown/other без словаря-расширения', () => {
		const noFact: Array<[field: string, from: string, to: string]> = [
			['stage', 'private', 'unknown'],
			['company_type', 'product', 'unknown'],
			['interview_language', 'es', 'other'],
			['interview_language', 'it', 'other'],
			// remote_first называет ПОЛИТИКУ («по умолчанию удалённо»), а не гео-охват —
			// remote-first компания вполне может требовать привязку к стране, ровно как и
			// голое remote_mode: remote выше по файлу (находка ревью: 19 из 444 записей).
			['remote_mode', 'remote_first', 'unknown'],
		];

		for (const [field, from, to] of noFact) {
			const plan = planMigration(input({ companies: [companyWithField(field, from)] }));
			const patched = (plan.companies[0] as unknown as Record<string, RawRecord>)[field]!;
			expect(patched.value, `${field}: ${from} → ${to}`).toBe(to);
			expect(plan.report.validationErrors).toEqual([]);
		}
	});

	it('нормализация значения компании пишется в отчёт с правильным правилом', () => {
		const plan = planMigration(input({ companies: [companyWithField('remote_mode', 'remote_global')] }));
		expect(plan.report.normalizations).toContainEqual(
			expect.objectContaining({
				rule: 'company_remote_mode_normalized',
				recordType: 'company',
				from: 'remote_global',
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

describe('коллизия external_id при разных компаниях — не повтор (находка ревью)', () => {
	it('iCIMS: три отклика в три разные компании с одинаковым хвостом /job не сливаются в одну вакансию', () => {
		// Синтетическая реконструкция класса дефекта, найденного ревью на боевом леджере
		// (сами компании и id вакансий здесь вымышленные — ADR-0003, реальная воронка
		// владельца в публичный репозиторий не попадает): у iCIMS путь ВСЕГДА кончается
		// литералом `/job`, и если брать хвост не глядя, три отклика в три РАЗНЫХ компании
		// схлопнутся в один и тот же external_id `icjob`. Оба под-фикса (значащий сегмент +
		// группировка присвоения по company_id) нужны разом — этот тест проверяет их вместе.
		const plan = planMigration(
			input({
				companies: [
					rawCompany('acme-screening', 'acme-screening.example.com'),
					rawCompany('acme-procure', 'acme-procure.example.com'),
					rawCompany('acme-consulting', 'acme-consulting.example.com'),
				],
				applications: [
					rawApplication('app-1', 'acme-screening', {
						vacancy_ref: 'https://careers-acme-screening.icims.com/jobs/8001/role/job',
					}),
					rawApplication('app-2', 'acme-procure', {
						vacancy_ref: 'https://careers-acme-procure.icims.com/jobs/8002/role/job',
					}),
					rawApplication('app-3', 'acme-consulting', {
						vacancy_ref: 'https://careers-acme-consulting.icims.com/jobs/8003/role/job',
					}),
				],
			}),
		);

		const ids = plan.applications.map((a) => a.id).sort();
		expect(ids).toEqual(['ic8001', 'ic8002', 'ic8003']);
		expect(plan.report.repeatApplications).toHaveLength(0);
		expect(plan.report.validationErrors).toEqual([]);
	});

	it('одинаковый external_id при РАЗНЫХ company_id — коллизия, а не повтор', () => {
		// Изолированная проверка группировки присвоения по (external_id, company_id) без
		// URL-разбора: external_id проставлен напрямую, чтобы не смешивать с находкой про
		// iCIMS выше. Повтор значит тот же работодатель — двух разных здесь нет, поэтому
		// в repeatApplications пары быть не должно. Но и молча слиться в одну строку/один
		// id они не могут — коллизия обязана быть видна и валидацией, и инвариантом
		// (инъективность отображения старый id → новый).
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com'), rawCompany('other', 'other.example.com')],
				applications: [
					rawApplication('app-a', 'acme', { platform: 'icims', external_id: 'ic999' }),
					rawApplication('app-b', 'other', { platform: 'icims', external_id: 'ic999' }),
				],
			}),
		);

		expect(plan.report.repeatApplications).toHaveLength(0);
		expect(plan.report.validationErrors.length).toBeGreaterThan(0);
		expect(plan.report.invariant.ok).toBe(false);
		expect(plan.report.invariant.mismatches.some((m) => m.includes('не инъективно'))).toBe(true);
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

	it('submission_channel: company_site → direct, но площадка подачи НЕ домысливается', () => {
		// `company_site` — это «не через агрегатор», а не «на сайте компании»: у реальных
		// записей с этим значением заметки событий называют Lever и Ashby. Площадка
		// выводится из ссылки, а из отрицания — нет.
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com')],
				applications: [rawApplication('a1', 'acme', { submission_channel: 'company_site' })],
			}),
		);
		expect(plan.applications[0]!.submission_channel).toBe('direct');
		expect(plan.applications[0]!.applied_via).toBeUndefined();
	});

	it('company_site со ссылкой на ATS: площадка подачи берётся из ссылки, а не из канала', () => {
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com')],
				applications: [
					rawApplication('a1', 'acme', {
						submission_channel: 'company_site',
						vacancy_ref: 'https://jobs.lever.co/acme/0f1e2d3c',
					}),
				],
			}),
		);
		expect(plan.applications[0]!.submission_channel).toBe('direct');
		expect(plan.applications[0]!.applied_via).toBe('lever');
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

	it('applied_via НЕ выводится из площадки НАХОДКИ для aggregator/network (hh, linkedin) без явного сигнала подачи', () => {
		// Находка ревью: 167 откликов нашли вакансию в LinkedIn и подали НЕ через её форму
		// (submission_channel остался direct, без easy_apply) — вывод «подали там же, где
		// нашли» стирал единственный различимый факт (21 отклик, наоборот, ДЕЙСТВИТЕЛЬНО
		// подал через LinkedIn — тот случай покрыт тестом submission_channel выше). hh —
		// тот же класс aggregator/network.
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com')],
				applications: [
					rawApplication('a1', 'acme', { vacancy_ref: 'https://hh.ru/vacancy/136857307' }),
					rawApplication('a2', 'acme', {
						vacancy_ref: 'https://www.linkedin.com/jobs/view/4021234567/',
					}),
				],
			}),
		);
		const byId = new Map(plan.applications.map((a) => [a.id, a]));
		expect(byId.get('hh136857307')!.platform).toBe('hh');
		expect(byId.get('hh136857307')!.applied_via).toBeUndefined();
		expect(byId.get('li4021234567')!.platform).toBe('linkedin');
		expect(byId.get('li4021234567')!.applied_via).toBeUndefined();
	});

	it('applied_via выводится из ссылки ТОЛЬКО для ATS — там страница вакансии физически совпадает с формой подачи', () => {
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com')],
				applications: [rawApplication('a1', 'acme', { vacancy_ref: 'ashby:xyz' })],
			}),
		);
		expect(plan.applications[0]!.platform).toBe('ashby');
		expect(plan.applications[0]!.applied_via).toBe('ashby');
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

	it('рост БЕЗ -rN — одна старая occurrence-группа даёт два новых id с разными external_id — печатается поимённо (находка ревью)', () => {
		// Ровно сценарий реального леджера (02-migration-report.txt: applied 347 → 349,
		// «Повторные отклики (-rN): (нет)»): repeatApplications пуст (external_id у двух
		// occurrences РАЗНЫЙ — коллизии присвоения по (external_id, company_id) нет), но обе
		// делят один старый application.id, и foldAll «до» видел под ним только один слот.
		// unexplainedGrowth обязан объяснить эту прибавку поимённо, а не молчать при пустом
		// repeatApplications, как это делал отчёт до фикса.
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com')],
				applications: [
					rawApplication('role-y', 'acme', {
						vacancy_ref: 'https://hh.ru/vacancy/111',
						applied_at: '2026-01-01T00:00:00Z',
						ts: '2026-01-01T00:00:00Z',
					}),
					rawApplication('role-y', 'acme', {
						vacancy_ref: 'https://hh.ru/vacancy/222',
						applied_at: '2026-02-01T00:00:00Z',
						ts: '2026-02-01T00:00:00Z',
					}),
				],
			}),
		);

		expect(plan.report.repeatApplications).toHaveLength(0); // не -rN коллизия присвоения
		expect(plan.report.invariant.ok).toBe(true); // прибавка объяснена, а не роняет инвариант
		expect(plan.report.unexplainedGrowth).toHaveLength(1);
		expect(plan.report.unexplainedGrowth[0]).toMatchObject({
			newId: 'hh222',
			oldId: 'role-y',
			appliedAt: '2026-02-01T00:00:00Z',
			predecessorId: 'hh111',
		});

		// Владелец обязан видеть это ИМЕНЕМ в отчёте, а не только числом «роста без -rN» в
		// сводке — та же прибавка, что в реальном прогоне была видна лишь как расхождение
		// между «Повторные отклики (-rN): (нет)» и выросшей гистограммой applied.
		const text = plan.report.lines.join('\n');
		expect(text).toContain('hh222');
		expect(text).toContain('hh111');
		expect(text).toContain('role-y');
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

describe('идемпотентность (находка ревью)', () => {
	it('миграция, применённая к своему же результату, — no-op и проходит инвариант', () => {
		// Доказательство ревьюера: `allowedGrowth = repeatApplications.length` — глобальный
		// скаляр, не привязанный к тому, ГДЕ распределение выросло. Повторный dry-run на
		// уже мигрированных данных (буквальный no-op — 0 алиасов, 0 нормализаций) падал с
		// «выросло на 0, а повторов N»: цепочка ПРИСВОЕНИЯ (external_id+company_id)
		// по-прежнему видит пару occurrences (vacancy_ref миграцией не трогается) и
		// производит непустой repeatApplications, хотя ни один id уже не меняется.
		const raw: MigrationInputRecords = {
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
			events: [
				rawEvent('e1', 'role-x', { ts: '2026-08-09T00:00:00Z', stage: 'applied' }),
				rawEvent('e2', 'role-x', { ts: '2026-09-02T00:00:00Z', stage: 'applied' }),
			],
		};

		const first = planMigration(raw);
		expect(first.report.invariant.ok).toBe(true);
		expect(first.report.repeatApplications).toHaveLength(1);

		// Скармливаем результат первого прогона как вход второго — те же id уже стоят в
		// записях (хвост -rN уже в самом id, external_id уже проставлен явно).
		const second = planMigration({
			companies: first.companies as unknown as RawRecord[],
			applications: first.applications as unknown as RawRecord[],
			events: first.events as unknown as RawRecord[],
		});

		expect(second.report.companyAliases).toEqual([]);
		expect(second.report.applicationAliases).toEqual([]); // ни один id не изменился
		expect(second.report.normalizations).toEqual([]);
		expect(second.companies).toHaveLength(first.companies.length);
		expect(second.applications).toHaveLength(first.applications.length);
		expect(second.events).toHaveLength(first.events.length);
		// Ключевая проверка: рост посчитан по СТАРОМУ id, а не по цепочке присвоения —
		// repeatApplications на этом прогоне вполне может остаться непустым (цепочка
		// присвоения по external_id+company_id всё ещё видит пару occurrences), но
		// инвариант обязан быть OK, потому что «до»-слотов здесь уже два, а не один.
		expect(second.report.invariant.ok).toBe(true);
		expect(second.report.invariant.mismatches).toEqual([]);
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

	it('при провале финальной валидации applyMigration бросает MigrationValidationError и не создаёт каталог', () => {
		// Зеркало теста провала инварианта выше: та же функция, но вторая защитная ветка
		// (`plan.report.validationErrors.length > 0`) — до этого теста её не проверял
		// никто, инвариант сабботировался, а валидация — нет.
		const plan = samplePlan();
		expect(plan.report.invariant.ok).toBe(true); // инвариант чист — падать должна ИМЕННО валидация
		const sabotaged: MigrationPlan = {
			...plan,
			report: {
				...plan.report,
				validationErrors: [
					{ recordType: 'application', id: 'hh136857307', message: 'искусственный провал теста' },
				],
			},
		};

		expect(() =>
			applyMigration(sabotaged, { dir: jobsearchDir, publicRepoRoot: join(tmpDir, 'public-fake') }),
		).toThrow(MigrationValidationError);

		expect(existsSync(jobsearchDir)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 7. Отчёт: опасные решения видны поимённо, а не только итогом (находка ревью)
// ---------------------------------------------------------------------------

describe('report.lines перечисляет повторы, неразобранные ссылки и обе гистограммы построчно', () => {
	it('владелец видит КАЖДЫЙ повтор, каждую неразобранную ссылку и полное распределение до/после, а не только «инвариант OK»', () => {
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
					rawApplication('unparsed-1', 'acme', { vacancy_ref: 'not a url, not a tag either' }),
				],
				events: [rawEvent('e1', 'old-early', { stage: 'applied' })],
			}),
		);

		// Тестовые данные обязаны реально произвести и повтор, и неразобранную ссылку —
		// иначе проверка ниже прошла бы и на пустом отчёте, ничего не доказав.
		expect(plan.report.repeatApplications.length).toBeGreaterThan(0);
		expect(plan.report.unparsedVacancyRefs.length).toBeGreaterThan(0);

		const text = plan.report.lines.join('\n');
		for (const repeat of plan.report.repeatApplications) {
			expect(text).toContain(repeat.assignedId);
			expect(text).toContain(repeat.originalId);
		}
		for (const unparsed of plan.report.unparsedVacancyRefs) {
			expect(text).toContain(unparsed.applicationId);
			expect(text).toContain(unparsed.vacancyRef);
		}
		expect(text).toContain('Распределение по стадиям (до):');
		expect(text).toContain('Распределение по стадиям (после):');
		for (const [stage, count] of Object.entries(plan.report.invariant.before.stageCounts)) {
			expect(text).toContain(`${stage}: ${count}`);
		}
		for (const [stage, count] of Object.entries(plan.report.invariant.after.stageCounts)) {
			expect(text).toContain(`${stage}: ${count}`);
		}
	});

	it('пустые списки повторов/неразобранных ссылок не оставляют заголовок без содержимого', () => {
		const plan = planMigration(
			input({
				companies: [rawCompany('acme', 'acme.example.com')],
				applications: [rawApplication('a1', 'acme')],
			}),
		);
		expect(plan.report.repeatApplications).toEqual([]);
		expect(plan.report.unparsedVacancyRefs).toEqual([]);
		expect(plan.report.unexplainedGrowth).toEqual([]);

		const text = plan.report.lines.join('\n');
		expect(text).toContain('Повторные отклики (-rN):\n  (нет)');
		expect(text).toContain('Неразобранные ссылки vacancy_ref:\n  (нет)');
		expect(text).toContain('Рост без -rN (новые id без единственного предшественника среди старых):\n  (нет)');
	});
});
