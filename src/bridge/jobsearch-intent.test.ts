/**
 * jobsearch-intent.test.ts — интенты воронки и кнопки follow-up ([ADR-0030]).
 *
 * Ключевое: движок записывает СОБЫТИЕ, а не состояние, и `ghosted` появляется в леджере
 * ТОЛЬКО по кнопке владельца. Автоматически проставленный по таймауту игнор — это запись
 * факта, которого не было: компания может ответить и на шестидесятый день.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { foldApplication } from '../ingest/jobsearch/events.js';
import { createJobsearchLedger, type JobsearchLedger } from '../ingest/jobsearch/ledger.js';
import { readSnoozeUntil } from '../scheduler/finance-state.js';
import { extractCareerIntent } from './career-intent-schema.js';
import { dispatchJobsearchCallback } from './jobsearch-callbacks.js';
import { dispatchJobsearchIntent, extractJobsearchIntent } from './jobsearch-intent.js';
import type { AnswerCallbackOptions, TelegramClient } from './telegram.js';

const NOW = new Date('2026-08-02T12:00:00Z');
const nowFn = () => NOW;

let tmpDir: string;
let ledger: JobsearchLedger;

function deps() {
	return { ledger, nowFn };
}

function fence(json: unknown): string {
	return '```jobsearch-intent\n' + JSON.stringify(json) + '\n```';
}

/** Готовая база: компания + отклик. */
function seed(): void {
	dispatchJobsearchIntent(
		{ type: 'add_company', site: 'acme.example.com', name: 'Acme', company_source: 'manual' },
		deps(),
	);
	dispatchJobsearchIntent(
		{
			type: 'add_application',
			id: 'acme-backend',
			company_id: 'acme-example-com',
			role_title: 'Backend Engineer',
			company_source: 'manual',
			submission_channel: 'referral',
			applied_at: '2026-06-01T00:00:00Z',
		},
		deps(),
	);
}

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'jobsearch-intent-test-'));
	ledger = createJobsearchLedger({
		dir: join(tmpDir, 'raw', 'jobsearch'),
		publicRepoRoot: join(tmpDir, 'public-fake'),
	});
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Извлечение
// ---------------------------------------------------------------------------

describe('extractJobsearchIntent', () => {
	it('достаёт интент из блока с пояснением вокруг', () => {
		const answer = `Записал.\n\n${fence({ type: 'query', what: 'funnel' })}\n\nГотово.`;

		expect(extractJobsearchIntent(answer)).toEqual({ type: 'query', what: 'funnel' });
	});

	it('битый JSON и чужая схема дают null — ход не роняется', () => {
		expect(extractJobsearchIntent('```jobsearch-intent\n{не json\n```')).toBeNull();
		expect(extractJobsearchIntent(fence({ type: 'nope' }))).toBeNull();
	});

	it('карьерный и воронковый блоки не перехватывают друг друга', () => {
		const answer = [
			'```career-intent',
			JSON.stringify({ type: 'query', what: 'positions' }),
			'```',
			'',
			fence({ type: 'query', what: 'funnel' }),
		].join('\n');

		expect(extractCareerIntent(answer)).toEqual({ type: 'query', what: 'positions' });
		expect(extractJobsearchIntent(answer)).toEqual({ type: 'query', what: 'funnel' });
	});
});

// ---------------------------------------------------------------------------
// 2. Запись
// ---------------------------------------------------------------------------

describe('dispatchJobsearchIntent', () => {
	it('компания заводится с id, производным от домена', () => {
		const result = dispatchJobsearchIntent(
			{
				type: 'add_company',
				site: 'https://www.Acme.example.com/careers',
				name: 'Acme',
				company_source: 'manual',
			},
			deps(),
		);

		expect(result.ok).toBe(true);
		expect(ledger.readAll('companies')[0]!.site_domain).toBe('acme.example.com');
	});

	it('неразбираемый домен — отказ значением, а не исключение', () => {
		const result = dispatchJobsearchIntent(
			{ type: 'add_company', site: 'Acme Inc', name: 'Acme', company_source: 'manual' },
			deps(),
		);

		expect(result.ok).toBe(false);
		expect(ledger.readAll('companies')).toEqual([]);
	});

	it('вес компании ставится вручную и в 0–5', () => {
		seed();
		dispatchJobsearchIntent(
			{ type: 'set_fit_rank', company_id: 'acme-example-com', rank: 4 },
			deps(),
		);

		expect(ledger.readAll('companies').at(-1)!.fit_rank).toBe(4);
	});

	it('событие под несуществующим откликом не пишется', () => {
		const result = dispatchJobsearchIntent(
			{ type: 'add_event', application_id: 'absent', kind: 'stage_change', stage: 'replied' },
			deps(),
		);

		expect(result.ok).toBe(false);
		expect(ledger.readAll('application_events')).toEqual([]);
	});

	it('стадия не хранится полем: движок пишет событие, стадия вычисляется', () => {
		seed();
		dispatchJobsearchIntent(
			{
				type: 'add_event',
				application_id: 'acme-backend',
				kind: 'stage_change',
				stage: 'replied',
				at: '2026-06-05T00:00:00Z',
			},
			deps(),
		);

		const application = ledger.readAll('applications')[0]!;
		expect(application).not.toHaveProperty('stage');
		expect(foldApplication('acme-backend', ledger.readAll('application_events')).stage).toBe(
			'replied',
		);
	});

	it('повторный тот же интент даёт ту же строку — id детерминирован', () => {
		seed();
		const intent = {
			type: 'add_event' as const,
			application_id: 'acme-backend',
			kind: 'stage_change' as const,
			stage: 'replied' as const,
			at: '2026-06-05T00:00:00Z',
		};

		dispatchJobsearchIntent(intent, deps());
		dispatchJobsearchIntent(intent, deps());

		const events = ledger.readAll('application_events');
		expect(events).toHaveLength(2);
		expect(events[0]!.id).toBe(events[1]!.id);
		// Свод схлопывает дубль: стадия одна, история не задвоилась.
		expect(foldApplication('acme-backend', events).stagesReached).toEqual(['replied']);
	});

	it('query по воронке печатает проценты только вместе с числом наблюдений', () => {
		seed();
		const result = dispatchJobsearchIntent({ type: 'query', what: 'funnel' }, deps());

		expect(result.text).toContain('Мало данных для тренда');
		expect(result.text).toContain('покрывают только подключённые источники');
		// Ни одного процента без абсолютов.
		for (const line of result.text.split('\n')) {
			if (line.includes('%')) expect(line).toMatch(/\(\d+ из \d+\)|—/);
		}
	});
});

// ---------------------------------------------------------------------------
// 3. Кнопки follow-up
// ---------------------------------------------------------------------------

/** Мок транспорта. */
class MockTelegram implements Partial<TelegramClient> {
	answered: { id: string; text?: string }[] = [];
	markupEdits: { chatId: number; messageId: number }[] = [];

	async answerCallbackQuery(id: string, opts: AnswerCallbackOptions = {}): Promise<void> {
		this.answered.push({ id, text: opts.text });
	}
	async editMessageReplyMarkup(chatId: number, messageId: number): Promise<void> {
		this.markupEdits.push({ chatId, messageId });
	}
}

function callbackDeps(telegram: MockTelegram) {
	return {
		ownerChatId: 42,
		telegram: telegram as unknown as TelegramClient,
		ledger,
		stateDir: tmpDir,
		nowFn,
	};
}

describe('dispatchJobsearchCallback', () => {
	it('[Написал] пишет КАСАНИЕ — стадию оно не двигает', () => {
		seed();
		const telegram = new MockTelegram();

		return dispatchJobsearchCallback(
			{
				chatId: 42,
				fromId: 42,
				callbackQueryId: 'cb-1',
				data: 'js:fu:done:acme-backend',
				messageId: 5,
			},
			callbackDeps(telegram),
		).then(() => {
			const events = ledger.readAll('application_events');
			expect(events[0]).toMatchObject({ kind: 'touchpoint', touch_kind: 'follow_up' });
			expect(foldApplication('acme-backend', events).stage).toBeNull();
			// Кнопки сняты: флоу отработал.
			expect(telegram.markupEdits).toEqual([{ chatId: 42, messageId: 5 }]);
		});
	});

	it('[Отложить] ставит snooze и в леджер не пишет', async () => {
		seed();
		const telegram = new MockTelegram();

		await dispatchJobsearchCallback(
			{ chatId: 42, fromId: 42, callbackQueryId: 'cb-2', data: 'js:fu:snooze:acme-backend' },
			callbackDeps(telegram),
		);

		expect(ledger.readAll('application_events')).toEqual([]);
		expect(readSnoozeUntil(tmpDir, 'js:followup:acme-backend:2026-06-01T00:00:00Z')).toBe(
			'2026-08-05T12:00:00.000Z',
		);
	});

	it('[Считать игнором] — единственный способ появления ghosted в леджере', async () => {
		seed();
		const telegram = new MockTelegram();

		await dispatchJobsearchCallback(
			{ chatId: 42, fromId: 42, callbackQueryId: 'cb-3', data: 'js:fu:ghost:acme-backend' },
			callbackDeps(telegram),
		);

		const events = ledger.readAll('application_events');
		expect(events[0]).toMatchObject({ stage: 'ghosted', reason_code: 'no_response' });
		expect(telegram.answered[0]!.text).toContain('ваш вывод');
	});

	it('чужой from.id не применяет ничего', async () => {
		seed();
		const telegram = new MockTelegram();

		await dispatchJobsearchCallback(
			{ chatId: 42, fromId: 999, callbackQueryId: 'cb-4', data: 'js:fu:ghost:acme-backend' },
			callbackDeps(telegram),
		);

		expect(ledger.readAll('application_events')).toEqual([]);
	});

	it('кнопка по неизвестному отклику ничего не пишет', async () => {
		const telegram = new MockTelegram();

		await dispatchJobsearchCallback(
			{ chatId: 42, fromId: 42, callbackQueryId: 'cb-5', data: 'js:fu:done:absent' },
			callbackDeps(telegram),
		);

		expect(telegram.answered[0]!.text).toContain('не найден');
		expect(ledger.readAll('application_events')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 4. Список компаний: гейты, объяснение ранга, оговорка о покрытии
// ---------------------------------------------------------------------------

describe('query companies', () => {
	/** Заводит компанию и приводит её признаки к нужным значениям. */
	function company(site: string, name: string, patch: Record<string, unknown> = {}): void {
		dispatchJobsearchIntent({ type: 'add_company', site, name, company_source: 'manual' }, deps());
		if (Object.keys(patch).length === 0) return;
		const last = ledger.readAll('companies').at(-1)!;
		ledger.append('companies', {
			...last,
			...patch,
			ts: '2026-08-02T13:00:00Z',
		} as never);
	}

	const assessed = <T extends string>(value: T) => ({
		value,
		source: 'manual' as const,
		confirmed_by_human: false,
		confirmed_at: null,
	});

	it('оговорка о покрытии стоит в ответе и не обещает рынка', () => {
		// [ADR-0029], «Следствия»: одна строка-шаблон рядом с генератором ответа,
		// а не редполитика. Подключённые источники считаются из данных.
		company('acme.example.com', 'Acme');

		const text = dispatchJobsearchIntent({ type: 'query', what: 'companies' }, deps()).text;

		expect(text).toContain('Из подключённых источников');
		expect(text).toContain('manual');
		expect(text).not.toMatch(/все компании|весь рынок/i);
	});

	it('пустой реестр тоже несёт оговорку, а не голое «компаний нет»', () => {
		const text = dispatchJobsearchIntent({ type: 'query', what: 'companies' }, deps()).text;

		expect(text).toContain('нет подключённых');
	});

	it('сортировка объясняется фактами, а не баллом', () => {
		company('low.example.com', 'Low', { fit_rank: 1 });
		company('high.example.com', 'High', {
			fit_rank: 5,
			has_warm_contact: assessed('yes'),
			hires_contractors: { ...assessed('yes'), confirmed_by_human: true },
		});

		const text = dispatchJobsearchIntent({ type: 'query', what: 'companies' }, deps()).text;

		expect(text.indexOf('high-example-com')).toBeLessThan(text.indexOf('low-example-com'));
		expect(text).toContain('вес 5');
		expect(text).toContain('контрактор подтверждён в разговоре');
		expect(text).toContain('есть тёплый контакт');
	});

	it('отсеянные не исчезают молча — они перечислены с причиной', () => {
		company('acme.example.com', 'Acme');
		company('onsite.example.com', 'Onsite Only', {
			remote_mode: assessed('onsite'),
			hires_contractors: assessed('no'),
		});

		const text = dispatchJobsearchIntent({ type: 'query', what: 'companies' }, deps()).text;

		expect(text).toContain('Компании (1 из 2)');
		expect(text).toContain('Отсеяно (1)');
		expect(text).toContain('только офис');
		expect(text).toContain('контракторов не берут');
	});

	it('unknown не отсеивает — компания остаётся в списке', () => {
		company('acme.example.com', 'Acme', {
			work_permit_required: assessed('unknown'),
			hires_contractors: assessed('unknown'),
		});

		const text = dispatchJobsearchIntent({ type: 'query', what: 'companies' }, deps()).text;

		expect(text).toContain('Компании (1 из 1)');
		expect(text).toContain('разрешение на работу — выясняется в разговоре');
	});
});
