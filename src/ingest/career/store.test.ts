/**
 * store.test.ts — карьерная база: запись/чтение всех сущностей, свод last-wins,
 * tombstone'ы и инварианты схем ([ADR-0028]).
 *
 * Все данные синтетические: `acme`, `example.com`, круглые числа. Реальных имён,
 * организаций и контактов в публичном репо быть не должно ([ADR-0003], `pnpm lint:public`).
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LedgerValidationError } from '../ledger.js';
import {
	createCareerLedger,
	loadCareerBase,
	resolveCareerDir,
	type CareerLedger,
} from './store.js';
import type {
	AchievementRecord,
	ContactRecord,
	EducationRecord,
	LanguageRecord,
	MetricRecord,
	PositionRecord,
	ProfileRecord,
	ProjectRecord,
	SkillRecord,
	VariantRecord,
} from './types.js';

let tmpDir: string;
let careerDir: string;
let ledger: CareerLedger;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'career-store-test-'));
	careerDir = join(tmpDir, 'raw', 'career');
	// publicRepoRoot — заведомо другое поддерево, чтобы path-guard разрешал запись.
	ledger = createCareerLedger({ dir: careerDir, publicRepoRoot: join(tmpDir, 'public-fake') });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Синтетические записи — по одной на сущность
// ---------------------------------------------------------------------------

const PROFILE: ProfileRecord = {
	id: 'main',
	headline: { en: 'Backend Engineer', ru: 'Бэкенд-инженер' },
	about: { en: 'Synthetic about text.', ru: 'Синтетический текст о себе.' },
	location: 'Synthetic City',
	work_setup: { mode: 'remote', relocation_ready: false },
	contact_keys: ['email_primary'],
	ts: '2026-08-02T10:00:00Z',
};

const POSITION: PositionRecord = {
	id: 'acme-backend',
	org_key: 'acme',
	title: { en: 'Backend Engineer', ru: 'Бэкенд-инженер' },
	employment: 'full_time',
	started_at: '2024-02',
	skill_ids: ['typescript'],
	summary: { en: 'Synthetic summary.', ru: 'Синтетическое описание.' },
	order: 1,
	ts: '2026-08-02T10:00:00Z',
};

const ACHIEVEMENT: AchievementRecord = {
	id: 'acme-shipped-api',
	position_id: 'acme-backend',
	text: {
		en: 'Shipped an API used by {{metric.services.count}} services.',
		ru: 'Запустил API, которым пользуются {{metric.services.count}} сервисов.',
	},
	metric_keys: ['services.count'],
	skill_ids: ['typescript'],
	impact: 'shipped',
	order: 1,
	ts: '2026-08-02T10:00:00Z',
};

const METRIC: MetricRecord = {
	key: 'services.count',
	value: 10,
	unit: 'count',
	as_of: '2026-08-02',
	source: 'manual',
	ts: '2026-08-02T10:00:00Z',
};

const SKILL: SkillRecord = {
	id: 'typescript',
	name: { no_translate: true, text: 'TypeScript' },
	kind: 'language',
	level: 'core',
	first_used: '2024-02',
	ts: '2026-08-02T10:00:00Z',
};

const EDUCATION: EducationRecord = {
	id: 'synthetic-degree',
	institution_key: 'synthetic-university',
	program: { en: 'Computer Science', ru: 'Информатика' },
	kind: 'degree',
	started_at: '2016-09',
	ended_at: '2020-06',
	ts: '2026-08-02T10:00:00Z',
};

const LANGUAGE: LanguageRecord = { id: 'en', level: 'b2', ts: '2026-08-02T10:00:00Z' };

const PROJECT: ProjectRecord = {
	id: 'synthetic-project',
	name: { no_translate: true, text: 'Synthetic Project' },
	summary: { en: 'Synthetic project summary.', ru: 'Синтетическое описание проекта.' },
	started_at: '2025-01',
	skill_ids: ['typescript'],
	wiki_ref: 'wiki/projects/synthetic-project.md',
	ts: '2026-08-02T10:00:00Z',
};

const VARIANT: VariantRecord = {
	id: 'en-backend',
	lang: 'en',
	target: { role_family: 'Backend Engineer', seniority: 'senior', keywords: ['typescript'] },
	pins: [],
	excludes: [],
	form: { max_pages: 1, max_bullets_per_position: 4, max_detailed_positions: 3 },
	status: 'draft',
	ts: '2026-08-02T10:00:00Z',
};

const CONTACT: ContactRecord = {
	key: 'email_primary',
	kind: 'email',
	label: { en: 'Email', ru: 'Почта' },
	render_required: true,
	ts: '2026-08-02T10:00:00Z',
};

// ---------------------------------------------------------------------------
// 1. Каталог и границы
// ---------------------------------------------------------------------------

describe('карьерный леджер — каталог', () => {
	it('resolveCareerDir указывает на raw/career приватного репо', () => {
		expect(resolveCareerDir({ CONTENT_ROOT: '/synthetic/content' } as NodeJS.ProcessEnv)).toBe(
			join('/synthetic/content', 'raw', 'career'),
		);
		expect(resolveCareerDir({ RAW_DIR: '/synthetic/raw' } as NodeJS.ProcessEnv)).toBe(
			join('/synthetic/raw', 'career'),
		);
	});

	it('запись идёт в raw/career/, финансовый каталог не появляется', () => {
		const envLedger = createCareerLedger({
			env: { CONTENT_ROOT: tmpDir } as NodeJS.ProcessEnv,
			publicRepoRoot: join(tmpDir, 'public-fake'),
		});
		envLedger.append('skills', SKILL);

		expect(existsSync(join(tmpDir, 'raw', 'career', 'skills.jsonl'))).toBe(true);
		expect(existsSync(join(tmpDir, 'raw', 'finance'))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 2. Round-trip всех сущностей
// ---------------------------------------------------------------------------

describe('карьерная база — запись и чтение всех сущностей', () => {
	it('десять сущностей записываются и читаются обратно', () => {
		ledger.append('profile', PROFILE);
		ledger.append('positions', POSITION);
		ledger.append('achievements', ACHIEVEMENT);
		ledger.append('metrics', METRIC);
		ledger.append('skills', SKILL);
		ledger.append('education', EDUCATION);
		ledger.append('languages', LANGUAGE);
		ledger.append('projects', PROJECT);
		ledger.append('variants', VARIANT);
		ledger.append('contacts', CONTACT);

		const base = loadCareerBase(ledger);

		expect(base.profile).toEqual(PROFILE);
		expect(base.positions).toEqual([POSITION]);
		expect(base.achievements).toEqual([ACHIEVEMENT]);
		expect(base.metrics.get('services.count')).toEqual(METRIC);
		expect(base.skills).toEqual([SKILL]);
		expect(base.education).toEqual([EDUCATION]);
		expect(base.languages).toEqual([LANGUAGE]);
		expect(base.projects).toEqual([PROJECT]);
		expect(base.variants).toEqual([VARIANT]);
		expect(base.contacts).toEqual([CONTACT]);
	});

	it('пустой леджер даёт пустое состояние, а не падение', () => {
		const base = loadCareerBase(ledger);

		expect(base.profile).toBeNull();
		expect(base.positions).toEqual([]);
		expect(base.metrics.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 3. Свод: last-wins, tombstone, детерминизм
// ---------------------------------------------------------------------------

describe('карьерная база — свод истории строк', () => {
	it('правка = новая строка с тем же id: побеждает бо́льший ts', () => {
		ledger.append('positions', POSITION);
		ledger.append('positions', {
			...POSITION,
			title: { en: 'Senior Backend Engineer', ru: 'Ведущий бэкенд-инженер' },
			ts: '2026-08-02T12:00:00Z',
		});

		const base = loadCareerBase(ledger);

		expect(base.positions).toHaveLength(1);
		expect(base.positions[0]!.title).toEqual({
			en: 'Senior Backend Engineer',
			ru: 'Ведущий бэкенд-инженер',
		});
	});

	it('при равных ts побеждает строка, записанная позже', () => {
		// Две правки внутри одной секунды дают одинаковую метку — без правила
		// «позже по файлу» результат зависел бы от порядка обхода Map.
		ledger.append('positions', { ...POSITION, order: 1 });
		ledger.append('positions', { ...POSITION, order: 7 });

		expect(loadCareerBase(ledger).positions[0]!.order).toBe(7);
	});

	it('запись с deleted: true убирает сущность из состояния', () => {
		ledger.append('skills', SKILL);
		ledger.append('skills', { ...SKILL, deleted: true, ts: '2026-08-02T12:00:00Z' });

		expect(loadCareerBase(ledger).skills).toEqual([]);
	});

	it('более поздняя запись возвращает удалённую сущность обратно', () => {
		// Удаление не необратимо: append-only леджер обещает именно это.
		ledger.append('skills', SKILL);
		ledger.append('skills', { ...SKILL, deleted: true, ts: '2026-08-02T12:00:00Z' });
		ledger.append('skills', { ...SKILL, deleted: false, ts: '2026-08-02T14:00:00Z' });

		expect(loadCareerBase(ledger).skills).toHaveLength(1);
	});

	it('метрики сводятся по key, а не по id', () => {
		ledger.append('metrics', METRIC);
		ledger.append('metrics', { ...METRIC, value: 42, ts: '2026-08-02T12:00:00Z' });

		const base = loadCareerBase(ledger);

		expect(base.metrics.size).toBe(1);
		expect(base.metrics.get('services.count')!.value).toBe(42);
	});

	it('позиции и достижения отсортированы по order детерминированно', () => {
		ledger.append('positions', { ...POSITION, id: 'third', order: 3 });
		ledger.append('positions', { ...POSITION, id: 'first', order: 1 });
		ledger.append('positions', { ...POSITION, id: 'second', order: 2 });

		expect(loadCareerBase(ledger).positions.map((p) => p.id)).toEqual(['first', 'second', 'third']);
	});
});

// ---------------------------------------------------------------------------
// 4. Инварианты схем
// ---------------------------------------------------------------------------

describe('схемы — инварианты [ADR-0028]', () => {
	it('достижение без владельца и достижение с двумя владельцами отбиваются', () => {
		const orphan = { ...ACHIEVEMENT };
		delete (orphan as { position_id?: string }).position_id;

		expect(() => ledger.append('achievements', orphan as AchievementRecord)).toThrow(
			LedgerValidationError,
		);
		expect(() =>
			ledger.append('achievements', { ...ACHIEVEMENT, project_id: 'synthetic-project' }),
		).toThrow(LedgerValidationError);
	});

	it('business-метрика без verifiable отбивается', () => {
		// Непроверяемое число в резюме опаснее его отсутствия — поэтому это ошибка записи,
		// а не предупреждение при рендере.
		expect(() => ledger.append('metrics', { ...METRIC, source: 'business' })).toThrow(
			LedgerValidationError,
		);
		expect(() =>
			ledger.append('metrics', { ...METRIC, source: 'business', verifiable: false }),
		).not.toThrow();
	});

	it('evidence-метрика обязана нести evidence_ref, остальные — не имеют права', () => {
		expect(() => ledger.append('metrics', { ...METRIC, source: 'evidence' })).toThrow(
			LedgerValidationError,
		);
		expect(() =>
			ledger.append('metrics', {
				...METRIC,
				source: 'manual',
				evidence_ref: { snapshot_id: 'abc123', path: 'raw/career/evidence.md' },
			}),
		).toThrow(LedgerValidationError);
		expect(() =>
			ledger.append('metrics', {
				...METRIC,
				source: 'evidence',
				evidence_ref: { snapshot_id: 'abc123', path: 'raw/career/evidence.md' },
			}),
		).not.toThrow();
	});

	it('контакт со значением падает громко, а не пишется без значения', () => {
		// zod по умолчанию молча срезал бы лишнее поле, и вызывающий считал бы,
		// что записал контакт — а записал бы ключ. Поэтому схема .strict().
		expect(() =>
			ledger.append('contacts', {
				...CONTACT,
				value: 'owner@example.com',
			} as ContactRecord),
		).toThrow(LedgerValidationError);

		expect(existsSync(join(careerDir, 'contacts.jsonl'))).toBe(false);
	});

	it('i18n-текст принимает словарь языков и форму техноним, но не мусор', () => {
		expect(() => ledger.append('skills', { ...SKILL, name: { en: 'TypeScript' } })).not.toThrow();
		expect(() =>
			ledger.append('skills', { ...SKILL, name: { no_translate: true, text: 'HTTP/2' } }),
		).not.toThrow();

		// Пустой словарь, неизвестный ключ языка и техноним без текста — не текст.
		expect(() => ledger.append('skills', { ...SKILL, name: {} })).toThrow(LedgerValidationError);
		expect(() =>
			ledger.append('skills', { ...SKILL, name: { english: 'TypeScript' } as never }),
		).toThrow(LedgerValidationError);
		expect(() =>
			ledger.append('skills', { ...SKILL, name: { no_translate: true } as never }),
		).toThrow(LedgerValidationError);
	});

	it('период принимается только с месячной точностью', () => {
		expect(() => ledger.append('positions', { ...POSITION, started_at: '2024-02-15' })).toThrow(
			LedgerValidationError,
		);
		expect(() => ledger.append('positions', { ...POSITION, started_at: '2024-13' })).toThrow(
			LedgerValidationError,
		);
	});

	it('id длиннее 48 символов не принимается (потолок callback_data)', () => {
		expect(() => ledger.append('skills', { ...SKILL, id: 'a'.repeat(49) })).toThrow(
			LedgerValidationError,
		);
	});
});
