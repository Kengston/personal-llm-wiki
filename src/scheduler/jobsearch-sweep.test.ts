/**
 * jobsearch-sweep.test.ts — проактив воронки ([ADR-0030], Решение 5; D10).
 *
 * Главное, что проверяется помимо логики: свип РЕАЛЬНО ВЫЗЫВАЕТСЯ. Финансовый проактив
 * написан, покрыт тестами и мёртв — его результат надо прокидывать в `runSweep` извне, и
 * этого никто не делает. Поэтому здесь есть тест, читающий `routines.ts` и проверяющий,
 * что вызов на месте: «написано и не подключено» — это не работающая фича.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ApplicationEvent, ApplicationRecord } from '../ingest/jobsearch/events.js';
import {
	collectJobsearchDue,
	deliverJobsearchDue,
	followUpKey,
	interviewKey,
} from './jobsearch-sweep.js';
import { writeSnoozeUntil } from './finance-state.js';

const NOW = '2026-08-02T12:00:00Z';

function application(id: string, patch: Partial<ApplicationRecord> = {}): ApplicationRecord {
	return {
		id,
		company_id: 'acme-example-com',
		role_title: 'Backend Engineer',
		company_source: 'manual',
		submission_channel: 'direct',
		applied_at: '2026-06-01T00:00:00Z',
		ts: '2026-06-01T00:00:00Z',
		...patch,
	};
}

let seq = 0;
function event(patch: Partial<ApplicationEvent> & { application_id: string }): ApplicationEvent {
	seq++;
	return {
		id: `ev-${seq}`,
		ts: NOW,
		kind: 'stage_change',
		stage: 'replied',
		source: 'owner',
		...patch,
	} as ApplicationEvent;
}

let stateDir: string;
let pushed: { text: string; keyboard?: unknown }[];

/** Мок отправителя: запоминает всё, что свип попытался отправить. */
const push = (async (text: string, opts: { replyMarkup?: unknown } = {}) => {
	pushed.push({ text, keyboard: opts.replyMarkup });
}) as never;

beforeEach(() => {
	seq = 0;
	pushed = [];
	stateDir = mkdtempSync(join(tmpdir(), 'jobsearch-sweep-test-'));
});

afterEach(() => {
	rmSync(stateDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Сбор
// ---------------------------------------------------------------------------

describe('collectJobsearchDue — собеседования', () => {
	const opts = { now: NOW, followUpAfterDays: 7 };

	it('за сутки до собеса — напоминание lead, за два часа — soon', () => {
		const apps = [application('a1')];
		const lead = collectJobsearchDue(
			apps,
			[event({ application_id: 'a1', stage: 'interview', scheduled_at: '2026-08-03T08:00:00Z' })],
			opts,
		);
		const soon = collectJobsearchDue(
			apps,
			[event({ application_id: 'a1', stage: 'interview', scheduled_at: '2026-08-02T13:00:00Z' })],
			opts,
		);

		expect(lead.interviews[0]).toMatchObject({ when: 'lead', applicationId: 'a1' });
		expect(soon.interviews[0]).toMatchObject({ when: 'soon' });
	});

	it('далёкое и прошедшее собеседование не напоминают о себе', () => {
		const apps = [application('a1')];
		const far = collectJobsearchDue(
			apps,
			[event({ application_id: 'a1', stage: 'interview', scheduled_at: '2026-09-01T12:00:00Z' })],
			opts,
		);
		const past = collectJobsearchDue(
			apps,
			[event({ application_id: 'a1', stage: 'interview', scheduled_at: '2026-07-01T12:00:00Z' })],
			opts,
		);

		expect(far.interviews).toEqual([]);
		expect(past.interviews).toEqual([]);
	});

	it('интервью без scheduled_at триггером не является', () => {
		// Назначенности достаточно, ожидания — нет.
		const due = collectJobsearchDue(
			[application('a1')],
			[event({ application_id: 'a1', stage: 'interview' })],
			opts,
		);

		expect(due.interviews).toEqual([]);
	});
});

describe('collectJobsearchDue — follow-up', () => {
	const opts = { now: NOW, followUpAfterDays: 7 };

	it('молчащий отклик попадает в предложение follow-up', () => {
		const due = collectJobsearchDue([application('a1')], [], opts);

		expect(due.followUps[0]).toMatchObject({ applicationId: 'a1' });
		expect(due.followUps[0]!.silentDays).toBeGreaterThanOrEqual(60);
	});

	it('свежий отклик молчащим не считается', () => {
		const due = collectJobsearchDue(
			[application('a1', { applied_at: '2026-08-01T00:00:00Z' })],
			[],
			opts,
		);

		expect(due.followUps).toEqual([]);
	});

	it('собственные касания таймер молчания не сбрасывают', () => {
		// Три письма в пустоту не отменяют молчания работодателя.
		const due = collectJobsearchDue(
			[application('a1')],
			[
				event({
					application_id: 'a1',
					kind: 'touchpoint',
					touch_kind: 'follow_up',
					stage: undefined,
					ts: '2026-08-01T00:00:00Z',
				}),
			],
			opts,
		);

		expect(due.followUps).toHaveLength(1);
	});

	it('ответ работодателя таймер сбрасывает', () => {
		const due = collectJobsearchDue(
			[application('a1')],
			[event({ application_id: 'a1', stage: 'replied', ts: '2026-08-01T00:00:00Z' })],
			opts,
		);

		expect(due.followUps).toEqual([]);
	});

	it('завершённая воронка follow-up не просит', () => {
		const due = collectJobsearchDue(
			[application('a1')],
			[
				event({
					application_id: 'a1',
					stage: 'rejected',
					reason_code: 'stack_mismatch',
					ts: '2026-06-10T00:00:00Z',
				}),
			],
			opts,
		);

		expect(due.followUps).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 2. Доставка
// ---------------------------------------------------------------------------

describe('deliverJobsearchDue', () => {
	const due = {
		interviews: [
			{
				applicationId: 'a1',
				roleTitle: 'Backend Engineer',
				scheduledAt: '2026-08-03T08:00:00Z',
				when: 'lead' as const,
			},
		],
		followUps: [
			{
				applicationId: 'a2',
				roleTitle: 'Platform Engineer',
				appliedAt: '2026-06-01T00:00:00Z',
				silentDays: 62,
			},
		],
	};

	it('отправляет оба вида пушей, follow-up — с тремя кнопками', () => {
		return deliverJobsearchDue(due, NOW, { stateDir, push }).then((sent) => {
			expect(sent).toBe(2);
			expect(pushed[0]!.text).toContain('Собеседование завтра');
			const keyboard = pushed[1]!.keyboard as { inline_keyboard: { callback_data: string }[][] };
			expect(keyboard.inline_keyboard[0]!.map((b) => b.callback_data)).toEqual([
				'js:fu:done:a2',
				'js:fu:snooze:a2',
				'js:fu:ghost:a2',
			]);
		});
	});

	it('повторный свип не шлёт то же самое второй раз', async () => {
		await deliverJobsearchDue(due, NOW, { stateDir, push });
		pushed = [];

		const sent = await deliverJobsearchDue(due, NOW, { stateDir, push });

		expect(sent).toBe(0);
		expect(pushed).toEqual([]);
	});

	it('отложенный follow-up не приходит до срока', async () => {
		writeSnoozeUntil(stateDir, followUpKey(due.followUps[0]!), '2026-09-01T00:00:00Z');

		await deliverJobsearchDue({ interviews: [], followUps: due.followUps }, NOW, {
			stateDir,
			push,
		});

		expect(pushed).toEqual([]);
	});

	it('сказать нечего — молчим, а не «сегодня 0 откликов»', async () => {
		const sent = await deliverJobsearchDue({ interviews: [], followUps: [] }, NOW, {
			stateDir,
			push,
		});

		expect(sent).toBe(0);
		expect(pushed).toEqual([]);
	});

	it('ключи дедупа различают окна напоминания и привязаны к записи', () => {
		expect(interviewKey(due.interviews[0]!)).toBe('js:interview:a1:2026-08-03T08:00:00Z:lead');
		expect(followUpKey(due.followUps[0]!)).toBe('js:followup:a2:2026-06-01T00:00:00Z');
	});
});

// ---------------------------------------------------------------------------
// 3. Шов подключён (а не «написан»)
// ---------------------------------------------------------------------------

describe('подключение свипа', () => {
	it('runDigest вызывает runJobsearchSweep — проверяем по исходнику', () => {
		// Финансовый проактив написан, покрыт тестами и мёртв: его результат надо
		// прокидывать в runSweep извне, и этого никто не делает. Этот тест не даёт
		// повторить ту же историю молча.
		const source = readFileSync(join(import.meta.dirname, 'routines.ts'), 'utf8');

		expect(source).toContain("from './jobsearch-sweep.js'");
		expect(source).toMatch(/runDigest[\s\S]*runJobsearchSweep\(/);
	});
});
