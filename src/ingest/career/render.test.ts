/**
 * render.test.ts — сборка варианта резюме ([ADR-0028]).
 *
 * Три инварианта, ради которых модуль и написан отдельно от хранилища:
 *   - fail-closed: документ с дырой (`{{…}}`, отсутствующий перевод) не выдаётся;
 *   - ничего не режется молча: у каждого выброшенного буллета есть причина и балл;
 *   - функция чистая: ни IO, ни часов — иначе отправленный вариант не воспроизводится.
 *
 * Данные синтетические: `acme`, `example.com`, круглые числа.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	describeDirectoryNeeds,
	formatRenderReport,
	missingDirectoryEntries,
	renderResume,
	type RenderDirectory,
} from './render.js';
import type { CareerBase } from './store.js';
import type { AchievementRecord, MetricRecord, PositionRecord, VariantRecord } from './types.js';

const TS = '2026-08-02T10:00:00Z';

const DIRECTORY: RenderDirectory = {
	display_name: 'Synthetic Owner',
	contacts: { email_primary: 'owner@example.com' },
	orgs: { acme: 'Acme', globex: 'Globex' },
	institutions: { 'synthetic-university': 'Synthetic University' },
	links: { 'project-repo': 'https://example.com/repo' },
};

function position(id: string, order: number, patch: Partial<PositionRecord> = {}): PositionRecord {
	return {
		id,
		org_key: 'acme',
		title: { en: 'Backend Engineer', ru: 'Бэкенд-инженер' },
		employment: 'full_time',
		started_at: '2024-02',
		skill_ids: ['typescript'],
		order,
		ts: TS,
		...patch,
	};
}

function achievement(
	id: string,
	order: number,
	patch: Partial<AchievementRecord> = {},
): AchievementRecord {
	return {
		id,
		position_id: 'acme-backend',
		text: { en: `Did ${id}.`, ru: `Сделал ${id}.` },
		metric_keys: [],
		skill_ids: [],
		order,
		ts: TS,
		...patch,
	};
}

function metric(key: string, patch: Partial<MetricRecord> = {}): MetricRecord {
	return {
		key,
		value: 7000,
		unit: 'count',
		as_of: '2026-07-01',
		source: 'manual',
		ts: TS,
		...patch,
	} as MetricRecord;
}

const VARIANT: VariantRecord = {
	id: 'en-backend',
	lang: 'en',
	target: { role_family: 'Backend Engineer', keywords: ['typescript'], seniority: 'senior' },
	pins: [],
	excludes: [],
	form: { max_pages: 1, max_bullets_per_position: 3, max_detailed_positions: 2 },
	status: 'draft',
	ts: TS,
};

function base(patch: Partial<CareerBase> = {}): CareerBase {
	return {
		profile: {
			id: 'main',
			headline: { en: 'Backend Engineer', ru: 'Бэкенд-инженер' },
			about: { en: 'Synthetic about.', ru: 'Синтетическое о себе.' },
			location: 'Synthetic City',
			work_setup: { mode: 'remote', relocation_ready: true },
			contact_keys: ['email_primary'],
			ts: TS,
		},
		positions: [position('acme-backend', 1)],
		achievements: [achievement('shipped-api', 1)],
		metrics: new Map(),
		skills: [
			{
				id: 'typescript',
				name: { no_translate: true, text: 'TypeScript' },
				kind: 'language',
				level: 'core',
				first_used: '2024-02',
				ts: TS,
			},
		],
		education: [],
		languages: [],
		projects: [],
		variants: [VARIANT],
		contacts: [{ key: 'email_primary', kind: 'email', render_required: true, ts: TS }],
		...patch,
	};
}

const OPTS = { asOf: '2026-08' };

// ---------------------------------------------------------------------------
// 1. Чистота функции — прямое требование DoD слайса
// ---------------------------------------------------------------------------

describe('renderResume — чистота', () => {
	it('в модуле нет ни IO, ни обращения к часам', () => {
		// Проверка на исходнике, а не «на глаз»: скоринг обязан быть воспроизводимым,
		// а любое `Date.now()` или чтение файла тихо ломает воспроизводимость.
		// Комментарии вырезаем: в них эти имена как раз и объясняются.
		const code = readFileSync(join(import.meta.dirname, 'render.ts'), 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/\/\/.*$/gm, '');

		expect(code).not.toMatch(/from 'node:/);
		expect(code).not.toMatch(/Date\.now\(\)/);
		expect(code).not.toMatch(/new Date\(/);
	});

	it('два вызова с одним входом дают идентичный документ', () => {
		const first = renderResume(base(), VARIANT, DIRECTORY, OPTS);
		const second = renderResume(base(), VARIANT, DIRECTORY, OPTS);

		expect(first.markdown).toBe(second.markdown);
	});
});

// ---------------------------------------------------------------------------
// 2. Happy path
// ---------------------------------------------------------------------------

describe('renderResume — сборка документа', () => {
	it('собирает markdown с именем, контактом и названием организации из справочника', () => {
		const result = renderResume(base(), VARIANT, DIRECTORY, OPTS);

		expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
		expect(result.markdown).toContain('# Synthetic Owner');
		expect(result.markdown).toContain('owner@example.com');
		expect(result.markdown).toContain('Backend Engineer — Acme');
		expect(result.markdown).toContain('## Experience');
		expect(result.markdown).toContain('2024-02 — present');
	});

	it('русский вариант берёт русские подписи и русские тексты', () => {
		const ru: VariantRecord = { ...VARIANT, id: 'ru-backend', lang: 'ru' };
		const result = renderResume(base(), ru, DIRECTORY, OPTS);

		expect(result.markdown).toContain('## Опыт работы');
		expect(result.markdown).toContain('Сделал shipped-api.');
		expect(result.markdown).not.toContain('Did shipped-api.');
	});

	it('подставляет значение метрики вместо плейсхолдера', () => {
		const result = renderResume(
			base({
				achievements: [
					achievement('shipped-api', 1, {
						text: {
							en: 'Served {{metric.rps.total}} requests.',
							ru: 'Обслужил {{metric.rps.total}}.',
						},
						metric_keys: ['rps.total'],
					}),
				],
				metrics: new Map([['rps.total', metric('rps.total')]]),
			}),
			VARIANT,
			DIRECTORY,
			OPTS,
		);

		expect(result.markdown).toContain('Served 7,000 requests.');
		expect(result.markdown).not.toContain('{{');
	});

	it('разряды и единицы форматируются по языку варианта, без локали хоста', () => {
		const withMetric = base({
			achievements: [
				achievement('shipped-api', 1, {
					text: { en: 'Grew by {{metric.growth}}.', ru: 'Вырос на {{metric.growth}}.' },
					metric_keys: ['growth'],
				}),
			],
			metrics: new Map([['growth', metric('growth', { value: 7000, unit: 'pct' })]]),
		});

		expect(renderResume(withMetric, VARIANT, DIRECTORY, OPTS).markdown).toContain('7,000%');
		expect(
			renderResume(withMetric, { ...VARIANT, lang: 'ru' }, DIRECTORY, OPTS).markdown,
		).toContain('7 000%');
	});
});

// ---------------------------------------------------------------------------
// 3. Fail-closed
// ---------------------------------------------------------------------------

describe('renderResume — fail-closed', () => {
	it('отсутствующий перевод даёт missing_translation и НЕ подставляет другой язык', () => {
		const result = renderResume(
			base({
				achievements: [achievement('shipped-api', 1, { text: { ru: 'Только по-русски.' } })],
			}),
			VARIANT,
			DIRECTORY,
			OPTS,
		);

		expect(result.markdown).toBeNull();
		expect(result.issues).toContainEqual(
			expect.objectContaining({ code: 'missing_translation', severity: 'error' }),
		);
		// Русский текст не должен был просочиться ни в какой форме.
		expect(JSON.stringify(result.issues)).not.toContain('Только по-русски');
	});

	it('плейсхолдер без метрики — unknown_metric и документ не выдаётся', () => {
		const result = renderResume(
			base({
				achievements: [
					achievement('shipped-api', 1, {
						text: { en: 'Served {{metric.absent}}.', ru: 'Обслужил {{metric.absent}}.' },
						metric_keys: ['absent'],
					}),
				],
			}),
			VARIANT,
			DIRECTORY,
			OPTS,
		);

		expect(result.markdown).toBeNull();
		expect(result.issues[0]).toMatchObject({ code: 'unknown_metric', severity: 'error' });
	});

	it('непроверяемая business-метрика в документ не идёт', () => {
		const result = renderResume(
			base({
				achievements: [
					achievement('shipped-api', 1, {
						text: { en: 'Saved {{metric.cost}}.', ru: 'Сэкономил {{metric.cost}}.' },
						metric_keys: ['cost'],
					}),
				],
				metrics: new Map([['cost', metric('cost', { source: 'business', verifiable: false })]]),
			}),
			VARIANT,
			DIRECTORY,
			OPTS,
		);

		expect(result.markdown).toBeNull();
		expect(result.issues[0]!.code).toBe('unverifiable_business_metric');
	});

	it('нет значения обязательного контакта — ошибка, необязательного — предупреждение', () => {
		const required = renderResume(base(), VARIANT, { ...DIRECTORY, contacts: {} }, OPTS);
		expect(required.markdown).toBeNull();
		expect(required.issues[0]).toMatchObject({
			code: 'missing_directory_entry',
			severity: 'error',
		});

		const optional = renderResume(
			base({
				contacts: [{ key: 'email_primary', kind: 'email', render_required: false, ts: TS }],
			}),
			VARIANT,
			{ ...DIRECTORY, contacts: {} },
			OPTS,
		);
		expect(optional.markdown).not.toBeNull();
		expect(optional.issues[0]!.severity).toBe('warning');
	});

	it('нет названия организации в справочнике — ошибка с точным ключом', () => {
		const result = renderResume(base(), VARIANT, { ...DIRECTORY, orgs: {} }, OPTS);

		expect(result.markdown).toBeNull();
		expect(result.issues).toContainEqual(
			expect.objectContaining({ code: 'missing_directory_entry', ref: 'acme' }),
		);
	});

	it('язык без подписей секций — ошибка, а не английские заголовки', () => {
		const result = renderResume(base(), { ...VARIANT, lang: 'de' }, DIRECTORY, OPTS);

		expect(result.markdown).toBeNull();
		expect(result.issues[0]!.code).toBe('unsupported_lang');
	});
});

// ---------------------------------------------------------------------------
// 4. Отбор: ничего не режется молча
// ---------------------------------------------------------------------------

describe('renderResume — отбор и отчёт о выброшенном', () => {
	it('лишние буллеты режутся по хвосту балла и попадают в cut с причинами', () => {
		const result = renderResume(
			base({
				achievements: [
					achievement('a1', 1, { impact: 'scaled', skill_ids: ['typescript'] }),
					achievement('a2', 2, { impact: 'shipped' }),
					achievement('a3', 3, { impact: 'led' }),
					achievement('a4', 4, { impact: 'fixed' }),
				],
			}),
			VARIANT,
			DIRECTORY,
			OPTS,
		);

		expect(result.cut).toHaveLength(1);
		expect(result.cut[0]).toMatchObject({ id: 'a4', kind: 'achievement', reason: 'cut_by_score' });
		expect(result.cut[0]!.reasons.join(' ')).toContain('max_bullets_per_position');
		// Самый релевантный (стек + рубрика) стоит первым.
		expect(result.markdown!.indexOf('Did a1.')).toBeLessThan(result.markdown!.indexOf('Did a2.'));
	});

	it('пин владельца побеждает балл и лимит не выбрасывает его', () => {
		const result = renderResume(
			base({
				achievements: [
					achievement('a1', 1, { impact: 'scaled', skill_ids: ['typescript'] }),
					achievement('a2', 2, { impact: 'shipped' }),
					achievement('a3', 3, { impact: 'led' }),
					achievement('weak', 4),
				],
			}),
			{ ...VARIANT, pins: ['weak'] },
			DIRECTORY,
			OPTS,
		);

		expect(result.markdown).toContain('Did weak.');
		expect(result.cut.map((c) => c.id)).not.toContain('weak');
	});

	it('исключение владельца отмечается отдельной причиной', () => {
		const result = renderResume(base(), { ...VARIANT, excludes: ['shipped-api'] }, DIRECTORY, OPTS);

		expect(result.cut).toContainEqual(
			expect.objectContaining({ id: 'shipped-api', reason: 'excluded_by_owner' }),
		);
		expect(result.markdown).not.toContain('Did shipped-api.');
	});

	it('позиции за пределами max_detailed_positions остаются строкой без буллетов', () => {
		const result = renderResume(
			base({
				positions: [
					position('p1', 1),
					position('p2', 2, { org_key: 'globex' }),
					position('p3', 3, { org_key: 'globex', ended_at: '2023-12' }),
				],
				achievements: [
					achievement('a1', 1, { position_id: 'p1' }),
					achievement('a3', 1, { position_id: 'p3' }),
				],
			}),
			VARIANT,
			DIRECTORY,
			OPTS,
		);

		expect(result.markdown).toContain('Did a1.');
		expect(result.markdown).not.toContain('Did a3.');
		expect(result.cut).toContainEqual(
			expect.objectContaining({ id: 'a3', reason: 'cut_by_form_limit' }),
		);
	});

	it('отчёт перечисляет и проблемы, и выброшенное', () => {
		const result = renderResume(base(), { ...VARIANT, excludes: ['shipped-api'] }, DIRECTORY, OPTS);

		expect(formatRenderReport(result)).toContain('выброшено achievement shipped-api');
	});
});

// ---------------------------------------------------------------------------
// 5. Предупреждения, которые не блокируют
// ---------------------------------------------------------------------------

describe('renderResume — предупреждения', () => {
	it('число-литерал в тексте достижения ловится эвристикой', () => {
		const result = renderResume(
			base({
				achievements: [
					achievement('shipped-api', 1, {
						text: { en: 'Cut latency by 30%.', ru: 'Сократил задержку на 30%.' },
					}),
				],
			}),
			VARIANT,
			DIRECTORY,
			OPTS,
		);

		expect(result.markdown).not.toBeNull();
		expect(result.issues).toContainEqual(
			expect.objectContaining({ code: 'literal_number_in_text', severity: 'warning' }),
		);
	});

	it('эвристика не воюет с версиями и годами', () => {
		const result = renderResume(
			base({
				achievements: [
					achievement('shipped-api', 1, {
						text: { en: 'Moved to HTTP/2 in 2024.', ru: 'Перевёл на HTTP/2 в 2024 году.' },
					}),
				],
			}),
			VARIANT,
			DIRECTORY,
			OPTS,
		);

		expect(result.issues.map((i) => i.code)).not.toContain('literal_number_in_text');
	});

	it('метрика не из пинованного замера даёт evidence_stale, но документ выдаётся', () => {
		const result = renderResume(
			base({
				achievements: [
					achievement('shipped-api', 1, {
						text: {
							en: 'Wrote {{metric.commits.total}} commits.',
							ru: 'Написал {{metric.commits.total}}.',
						},
						metric_keys: ['commits.total'],
					}),
				],
				metrics: new Map([
					[
						'commits.total',
						metric('commits.total', {
							source: 'evidence',
							evidence_ref: { snapshot_id: 'newer', path: 'raw/career/evidence-newer.json' },
						}),
					],
				]),
			}),
			{ ...VARIANT, evidence_version: 'pinned-older' },
			DIRECTORY,
			OPTS,
		);

		expect(result.markdown).toContain('Wrote 7,000 commits.');
		expect(result.issues).toContainEqual(
			expect.objectContaining({ code: 'evidence_stale', severity: 'warning' }),
		);
	});
});

// ---------------------------------------------------------------------------
// 6. Чеклист справочника: что владелец обязан закрыть руками
// ---------------------------------------------------------------------------

describe('describeDirectoryNeeds / missingDirectoryEntries', () => {
	it('список ключей считается из базы, а не из памяти владельца', () => {
		const needs = describeDirectoryNeeds(
			base({
				positions: [position('p1', 1), position('p2', 2, { org_key: 'globex' })],
				education: [
					{
						id: 'degree',
						institution_key: 'synthetic-university',
						program: { en: 'CS', ru: 'Информатика' },
						kind: 'degree',
						started_at: '2018-09',
						ts: TS,
					},
				],
				projects: [
					{
						id: 'proj',
						name: { no_translate: true, text: 'Proj' },
						summary: { en: 'S', ru: 'С' },
						started_at: '2025-01',
						skill_ids: [],
						link_key: 'project-repo',
						ts: TS,
					},
				],
			}),
		);

		expect(needs.orgs).toEqual(['acme', 'globex']);
		expect(needs.institutions).toEqual(['synthetic-university']);
		expect(needs.links).toEqual(['project-repo']);
		expect(needs.requiredContacts).toEqual(['email_primary']);
	});

	it('перечисляет недостающее путями, по которым видно, что вписать', () => {
		const missing = missingDirectoryEntries(base(), { contacts: {}, orgs: {} });

		expect(missing).toContain('display_name');
		expect(missing).toContain('contacts.email_primary');
		expect(missing).toContain('orgs.acme');
	});

	it('закрытый справочник не даёт ни одного пропуска', () => {
		expect(missingDirectoryEntries(base(), DIRECTORY)).toEqual([]);
	});

	it('в чеклисте только ключи — ни одного значения', () => {
		// Ключи непрозрачны по построению, поэтому список безопасно показать в чате.
		const needs = describeDirectoryNeeds(base());

		expect(JSON.stringify(needs)).not.toContain('Synthetic Owner');
		expect(JSON.stringify(needs)).not.toContain('@');
	});
});

// ---------------------------------------------------------------------------
// 7. Находки адверсариального ревью — регрессия
// ---------------------------------------------------------------------------

describe('достижения под проектами', () => {
	const withProject = () =>
		base({
			achievements: [
				achievement('proj-win', 1, { position_id: undefined, project_id: 'synthetic-project' }),
			],
			projects: [
				{
					id: 'synthetic-project',
					name: { no_translate: true, text: 'Synthetic Project' },
					summary: { en: 'Summary.', ru: 'Описание.' },
					started_at: '2025-01',
					skill_ids: [],
					ts: TS,
				},
			],
		});

	it('попадают в документ, а не исчезают вместе с проектом', () => {
		// До фикса цикл шёл только по position_id, а секция проектов печатала одно summary:
		// достижение под проектом не выводилось нигде и не попадало даже в список выброшенного.
		const result = renderResume(withProject(), VARIANT, DIRECTORY, OPTS);

		expect(result.markdown).toContain('Did proj-win.');
	});

	it('при исключении владельцем попадают в список выброшенного', () => {
		const result = renderResume(
			withProject(),
			{ ...VARIANT, excludes: ['proj-win'] },
			DIRECTORY,
			OPTS,
		);

		expect(result.cut).toContainEqual(
			expect.objectContaining({ id: 'proj-win', reason: 'excluded_by_owner' }),
		);
		expect(result.markdown).not.toContain('Did proj-win.');
	});
});

describe('ссылка на подтверждение сертификата', () => {
	it('подставляется из справочника, а не требуется впустую', () => {
		// Чеклист требовал links.<credential_key>, а рендер его не читал — владельца
		// просили заполнить поле, которое никуда не шло.
		const result = renderResume(
			base({
				education: [
					{
						id: 'cert',
						institution_key: 'synthetic-university',
						program: { en: 'Course', ru: 'Курс' },
						kind: 'certification',
						started_at: '2025-01',
						credential_key: 'project-repo',
						ts: TS,
					},
				],
			}),
			VARIANT,
			DIRECTORY,
			OPTS,
		);

		expect(result.markdown).toContain('https://example.com/repo');
	});
});

describe('оценочные метрики', () => {
	it('ручная метрика в документе помечается предупреждением', () => {
		// manual — это прикидка. Документ собирается, но владелец обязан знать, что
		// отправляет оценку под видом факта.
		const result = renderResume(
			base({
				achievements: [
					achievement('shipped-api', 1, {
						text: { en: 'Served {{metric.guess}}.', ru: 'Обслужил {{metric.guess}}.' },
						metric_keys: ['guess'],
					}),
				],
				metrics: new Map([['guess', metric('guess', { source: 'manual' })]]),
			}),
			VARIANT,
			DIRECTORY,
			OPTS,
		);

		expect(result.markdown).not.toBeNull();
		expect(result.issues).toContainEqual(
			expect.objectContaining({ code: 'manual_metric_in_document', severity: 'warning' }),
		);
	});
});

describe('осиротевшие ключи контактов', () => {
	it('заведённый, но не подключённый к профилю контакт назван отдельно', () => {
		const needs = describeDirectoryNeeds(
			base({
				contacts: [
					{ key: 'email_primary', kind: 'email', render_required: true, ts: TS },
					{ key: 'profile_public', kind: 'url', render_required: false, ts: TS },
				],
			}),
		);

		expect(needs.contacts).toEqual(['email_primary']);
		expect(needs.orphanContacts).toEqual(['profile_public']);
	});
});
