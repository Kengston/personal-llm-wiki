/**
 * Парность с `ingest/classifier.py` ([ADR-0011], [ADR-0012]). Дым-кейсы из Python
 * `__main__` + edge: карантин-побеждает-лейн, dot-skip, metadata-only ledger,
 * deep-merge приватного override. Все данные синтетические.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	classifySensitivity,
	filterLogRecord,
	loadPolicy,
	routeLane,
	shouldSkipRawPath,
	type Classification,
	type LaneDecision,
	type Policy,
} from './classifier.js';

const policy = loadPolicy();

describe('loadPolicy', () => {
	it('читает JSON-блок из relevance-policy.md', () => {
		expect(policy.policy_version).toBeTruthy();
		expect(policy.sensitivity?.nsfw?.action).toBe('quarantine');
		expect(policy.sensitivity?.financial?.action).toBe('keep_redact_spans');
		expect(policy.lanes?.task_triggers).toContain('купи');
	});
});

describe('classifySensitivity — дым-кейсы из Python __main__', () => {
	it('финансы → keep_redact_spans (keyword), НЕ карантин', () => {
		const c = classifySensitivity('Я должен Ивану 5000 за билеты', { source_class: 'telegram' }, policy);
		expect(c.label).toBe('financial');
		expect(c.action).toBe('keep_redact_spans');
		expect(c.reason).toContain('keyword=должен');
	});

	it('обычная чора → normal', () => {
		const c = classifySensitivity('купи молоко и хлеб', { source_class: 'telegram' }, policy);
		expect(c.label).toBe('normal');
		expect(c.action).toBe('normal');
	});

	it('NSFW по source_class → quarantine', () => {
		const c = classifySensitivity('explicit adult content', { source_class: 'adult' }, policy);
		expect(c.label).toBe('nsfw');
		expect(c.action).toBe('quarantine');
		expect(c.reason).toBe('source_class=adult');
	});

	it('чистый текст без сигналов → normal/no-signal', () => {
		const c = classifySensitivity('просто заметка про горы и музыку', { source_class: 'note' }, policy);
		expect(c.label).toBe('normal');
		expect(c.reason).toBe('no-signal');
	});

	it('карантин ПОБЕЖДАЕТ keep_redact (две категории сразу)', () => {
		// adult (source_class → quarantine) + "должен" (financial → keep_redact_spans).
		const c = classifySensitivity('я должен за adult content', { source_class: 'adult' }, policy);
		expect(c.action).toBe('quarantine');
		expect(c.label).toBe('nsfw');
	});
});

describe('routeLane — консервативен в сторону знания', () => {
	it('императив + объект → task', () => {
		const l = routeLane('купи молоко и хлеб', { source_class: 'telegram' }, policy);
		expect(l.lane).toBe('task');
		expect(l.reason).toContain('imperative');
	});

	it('рефлексия с триггером-словом → knowledge (не топим ростовой сигнал)', () => {
		const l = routeLane('хочу научиться делегировать, чтобы buy back my time', { source_class: 'note' }, policy);
		expect(l.lane).toBe('knowledge');
	});

	it('нет триггера → knowledge/no-task-trigger', () => {
		const l = routeLane('я думал сегодня про концепцию памяти', { source_class: 'note' }, policy);
		expect(l.lane).toBe('knowledge');
		expect(l.reason).toBe('no-task-trigger');
	});

	it('триггер после конца предложения (кириллица) → task (Unicode-boundary)', () => {
		// Проверяет фикс Python-`\b` юникод vs JS ASCII: "купи" после точки.
		const l = routeLane('записал мысль. купи билеты на концерт', { source_class: 'telegram' }, policy);
		expect(l.lane).toBe('task');
	});
});

describe('shouldSkipRawPath — изоляция dot-папок (P0-1)', () => {
	it.each([
		['raw/.quarantine/nsfw/x.md', true],
		['raw/.tasks/inbox/y.md', true],
		['raw/.filter-log.jsonl', true],
		['./raw/.quarantine/z.md', true],
		['raw/llm_chat/claude/z.md', false],
		['raw/people/ivan.md', false],
		['wiki/index.md', false],
	])('%s → %s', (p, expected) => {
		expect(shouldSkipRawPath(p as string)).toBe(expected);
	});
});

describe('filterLogRecord — НИКОГДА не содержимое', () => {
	const clf: Classification = {
		label: 'nsfw',
		action: 'quarantine',
		tier: 1,
		reason: 'source_class=adult',
		score: null,
	};
	const lane: LaneDecision = { lane: 'task', dualRoute: true, reason: 'x' };

	it('кладёт метаданные + sha256, но не тело', () => {
		const rec = filterLogRecord('raw/.quarantine/nsfw/x.md', clf, {
			axis: 'sensitivity',
			lane,
			content: 'ОЧЕНЬ ЧУВСТВИТЕЛЬНОЕ ТЕЛО',
			policyVersion: '2026-06-07',
			now: new Date('2026-06-08T00:00:00Z'),
		});
		expect(rec.category).toBe('nsfw');
		expect(rec.action).toBe('quarantine');
		expect(rec.axis).toBe('sensitivity');
		expect(rec.policy_version).toBe('2026-06-07');
		expect(rec.content_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(rec.lane).toBe('task');
		expect(rec.dual_route).toBe(true);
		expect(rec.ts).toBe('2026-06-08T00:00:00.000Z');
		// САМОЕ ВАЖНОЕ: тело нигде в записи.
		expect(JSON.stringify(rec)).not.toContain('ОЧЕНЬ ЧУВСТВИТЕЛЬНОЕ ТЕЛО');
	});

	it('без content — нет content_sha256; без lane — нет lane-полей', () => {
		const rec = filterLogRecord('raw/x.md', clf, { axis: 'sensitivity' });
		expect(rec.content_sha256).toBeUndefined();
		expect(rec.lane).toBeUndefined();
		expect(rec.dual_route).toBeUndefined();
	});
});

describe('pii_density — даты не считаются телефонами ([ADR-0013])', () => {
	it('дат-насыщенный текст (как ingested-страница) → normal, НЕ карантин', () => {
		const dateHeavy = [
			'date_range: 2024-05-29 — 2024-05-30',
			'ingested_at: 2024-05-29T10:00:00Z',
			'- user (2024-05-29T10:01:00Z): привет',
			'- assistant (2024-05-29T10:02:00Z): здравствуй',
			'- user (2024-05-29T10:03:00Z): как дела',
			'- assistant (2024-05-30T11:00:00Z): отлично',
		].join('\n');
		expect(classifySensitivity(dateHeavy, { source_class: 'note' }, policy).label).toBe('normal');
	});

	it('много РЕАЛЬНЫХ телефонов → others_pii (валидные phones по-прежнему считаются)', () => {
		const phones = 'контакты: +79990000001, +79990000002, +79990000003, +79990000004, +79990000005';
		const c = classifySensitivity(phones, { source_class: 'note' }, policy);
		expect(c.label).toBe('others_pii');
		expect(c.action).toBe('quarantine_and_redact');
	});

	it('дробный порог усекается как int (5.9 → 5, без off-by-one)', () => {
		const pol: Policy = {
			policy_version: 't',
			sensitivity: { others_pii: { detect: ['pii_density'], pii_density_threshold: 5.9, action: 'quarantine_and_redact' } },
			lanes: {},
		};
		const fivePhones = 'p +79990000001, +79990000002, +79990000003, +79990000004, +79990000005';
		// trunc(5.9)=5, count=5 → триггер (без усечения 5>=5.9 был бы false).
		expect(classifySensitivity(fivePhones, { source_class: 'note' }, pol).label).toBe('others_pii');
	});
});

describe('loadPolicy — приватный override (deep-merge)', () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), 'pol-test-'));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it('включает toxic-лексикон из .local.json и срабатывает', () => {
		const override = join(tmp, '.filter-policy.local.json');
		writeFileSync(
			override,
			JSON.stringify({ sensitivity: { toxic: { lexicon: 'on', lexicon_words: ['badword'] } } }),
			'utf8',
		);
		const merged = loadPolicy(undefined, override);
		expect(merged.sensitivity?.toxic?.lexicon).toBe('on');
		// detect=["lexicon"] из публичного дефолта сохранился после merge.
		const c = classifySensitivity('тут есть badword внутри', { source_class: 'note' }, merged);
		expect(c.label).toBe('toxic');
		expect(c.action).toBe('quarantine');
	});

	it('битый override игнорируется (не падаем)', () => {
		const override = join(tmp, 'broken.json');
		writeFileSync(override, '{ не json', 'utf8');
		const merged = loadPolicy(undefined, override);
		expect(merged.sensitivity?.nsfw?.action).toBe('quarantine');
	});
});
