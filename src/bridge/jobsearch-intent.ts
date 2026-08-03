/**
 * jobsearch-intent.ts — протокол интентов воронки ([ADR-0030], образец — [ADR-0024]).
 *
 * Запись в леджер воронки идёт ТОЛЬКО детерминированным кодом: движок эмитит один
 * fenced-блок ```jobsearch-intent, мост валидирует его схемой и применяет. Свободный текст
 * допустим ровно в одном поле — `reason_note`; всё остальное это перечисления и даты.
 *
 * Тег блока свой, поэтому финансовый, карьерный и воронковый экстракторы физически не
 * могут перехватить блок друг друга.
 *
 * Идентификаторы записей строятся ДЕТЕРМИНИРОВАННО из содержания (хеш), а не случайно:
 * повторно применённый один и тот же интент даёт ту же строку, и свод её схлопывает,
 * вместо того чтобы посчитать событие дважды.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { childLogger } from '../core/logger.js';
import {
	companyIdFromDomain,
	normalizeDomain,
	type CompanyRecord,
} from '../ingest/jobsearch/companies.js';
import {
	APPLICATION_STAGES,
	REASON_CODES,
	TOUCH_KINDS,
	type ApplicationEvent,
	type ApplicationRecord,
} from '../ingest/jobsearch/events.js';
import { computeFunnel, formatRate } from '../ingest/jobsearch/funnel.js';
import type { JobsearchLedger } from '../ingest/jobsearch/ledger.js';

const log = childLogger('bridge.jobsearch-intent');

const slugId = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9][a-z0-9_.-]*$/);
const isoTimestamp = z.string().min(1);

export const JobsearchIntentSchema = z.discriminatedUnion('type', [
	/** Целевая компания. Дедуп по домену, id производен от него. */
	z.object({
		type: z.literal('add_company'),
		site: z.string().min(1).max(255),
		name: z.string().min(1).max(200),
		company_source: z.enum(['manual', 'linkedin_export', 'web_search']).default('manual'),
	}),

	/** Ручной вес владельца 0–5. Вычисляемого балла в подсистеме нет. */
	z.object({
		type: z.literal('set_fit_rank'),
		company_id: slugId,
		rank: z.number().int().min(0).max(5),
	}),

	/** Факт подачи отклика. Стадии здесь нет: она живёт в событиях. */
	z.object({
		type: z.literal('add_application'),
		id: slugId,
		company_id: slugId,
		opportunity_id: slugId.optional(),
		role_title: z.string().min(1).max(200),
		variant_id: slugId.optional(),
		company_source: z.enum(['manual', 'linkedin_export', 'web_search']),
		submission_channel: z.enum(['referral', 'direct', 'inbound']),
		vacancy_ref: z.string().max(500).optional(),
		applied_at: isoTimestamp,
		currency: z.string().min(1).max(10).optional(),
		comp_expected: z.number().optional(),
	}),

	/** Событие воронки: смена стадии либо касание. */
	z.object({
		type: z.literal('add_event'),
		application_id: slugId,
		kind: z.enum(['stage_change', 'touchpoint']),
		stage: z.enum(APPLICATION_STAGES).optional(),
		touch_kind: z.enum(TOUCH_KINDS).optional(),
		reason_code: z.enum(REASON_CODES).optional(),
		reason_note: z.string().max(1000).optional(),
		scheduled_at: isoTimestamp.optional(),
		at: isoTimestamp.optional(),
	}),

	/** Чтение. Ничего не пишет. */
	z.object({ type: z.literal('query'), what: z.enum(['funnel', 'applications', 'companies']) }),
]);

export type JobsearchIntent = z.infer<typeof JobsearchIntentSchema>;

const FENCE = /```jobsearch-intent\s*\n([\s\S]*?)\n```/;

/** extractJobsearchIntent — блок из ответа движка или `null` (ход не роняем). */
export function extractJobsearchIntent(engineAnswer: string): JobsearchIntent | null {
	const match = FENCE.exec(engineAnswer);
	if (!match) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse((match[1] ?? '').trim());
	} catch (e) {
		log.warn({ err: String(e) }, 'jobsearch-intent: невалидный JSON');
		return null;
	}

	const result = JobsearchIntentSchema.safeParse(parsed);
	if (!result.success) {
		log.warn({ errors: result.error.errors.slice(0, 5) }, 'jobsearch-intent: схема не прошла');
		return null;
	}
	return result.data;
}

/**
 * eventId — детерминированный идентификатор события из его содержания.
 * Повторное применение того же интента даёт ту же строку, и свод её схлопывает.
 */
export function eventId(parts: string[]): string {
	return `ev-${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12)}`;
}

export interface JobsearchDispatchDeps {
	ledger: JobsearchLedger;
	nowFn: () => Date;
	/** Подключённые источники — для оговорки о покрытии в ответе на `query`. */
	connectedSources?: string[];
	ghostAfterDays?: number;
}

export interface JobsearchDispatchResult {
	type: JobsearchIntent['type'];
	ok: boolean;
	text: string;
}

/**
 * dispatchJobsearchIntent — применяет интент к леджеру воронки.
 *
 * Доменные отказы возвращаются значением (`ok: false`): владельцу нужен внятный ответ,
 * а не стектрейс. Нарушение схемы записи по-прежнему бросает — это дефект, а не ввод.
 */
export function dispatchJobsearchIntent(
	intent: JobsearchIntent,
	deps: JobsearchDispatchDeps,
): JobsearchDispatchResult {
	const ts = deps.nowFn().toISOString();

	switch (intent.type) {
		case 'add_company': {
			const domain = normalizeDomain(intent.site);
			if (!domain) {
				return { type: intent.type, ok: false, text: `Не разобрал домен: «${intent.site}».` };
			}
			const unknown = <T extends string>(value: T) => ({
				value,
				source: intent.company_source,
				confirmed_by_human: false,
				confirmed_at: null,
			});
			const record: CompanyRecord = {
				id: companyIdFromDomain(domain),
				site_domain: domain,
				name: intent.name,
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
				provenance: {
					company_source: intent.company_source,
					fetched_at: ts,
					parser_version: 'manual-1',
					robots_ok: true,
				},
				ts,
			};
			deps.ledger.append('companies', record);
			return { type: intent.type, ok: true, text: `Компания ${record.id} (${domain}) записана.` };
		}

		case 'set_fit_rank': {
			const existing = deps.ledger
				.readAll('companies')
				.filter((c) => c.id === intent.company_id)
				.at(-1);
			if (!existing) {
				return { type: intent.type, ok: false, text: `Не нашёл компанию ${intent.company_id}.` };
			}
			deps.ledger.append('companies', { ...existing, fit_rank: intent.rank, ts });
			return { type: intent.type, ok: true, text: `${intent.company_id}: вес ${intent.rank}.` };
		}

		case 'add_application': {
			const record: ApplicationRecord = {
				id: intent.id,
				company_id: intent.company_id,
				...(intent.opportunity_id ? { opportunity_id: intent.opportunity_id } : {}),
				role_title: intent.role_title,
				...(intent.variant_id ? { variant_id: intent.variant_id } : {}),
				company_source: intent.company_source,
				submission_channel: intent.submission_channel,
				...(intent.vacancy_ref ? { vacancy_ref: intent.vacancy_ref } : {}),
				applied_at: intent.applied_at,
				...(intent.currency ? { currency: intent.currency } : {}),
				...(intent.comp_expected !== undefined ? { comp_expected: intent.comp_expected } : {}),
				ts,
			};
			deps.ledger.append('applications', record);
			return {
				type: intent.type,
				ok: true,
				text: `Отклик ${intent.id} записан (${intent.role_title}, ${intent.submission_channel}).`,
			};
		}

		case 'add_event': {
			if (!deps.ledger.readAll('applications').some((a) => a.id === intent.application_id)) {
				return { type: intent.type, ok: false, text: `Не нашёл отклик ${intent.application_id}.` };
			}
			const at = intent.at ?? ts;
			const event: ApplicationEvent = {
				id: eventId([
					intent.application_id,
					intent.kind,
					intent.stage ?? intent.touch_kind ?? '',
					at,
				]),
				application_id: intent.application_id,
				ts: at,
				kind: intent.kind,
				...(intent.stage ? { stage: intent.stage } : {}),
				...(intent.touch_kind ? { touch_kind: intent.touch_kind } : {}),
				source: 'owner',
				...(intent.reason_code ? { reason_code: intent.reason_code } : {}),
				...(intent.reason_note ? { reason_note: intent.reason_note } : {}),
				...(intent.scheduled_at ? { scheduled_at: intent.scheduled_at } : {}),
			};
			deps.ledger.append('application_events', event);
			return {
				type: intent.type,
				ok: true,
				text: `Событие записано: ${intent.stage ?? intent.touch_kind} по ${intent.application_id}.`,
			};
		}

		case 'query':
			return { type: intent.type, ok: true, text: runJobsearchQuery(intent.what, deps) };
	}
}

/** runJobsearchQuery — детерминированный текст ответа на чтение. */
function runJobsearchQuery(
	what: 'funnel' | 'applications' | 'companies',
	deps: JobsearchDispatchDeps,
): string {
	if (what === 'companies') {
		const companies = deps.ledger.readAll('companies');
		if (companies.length === 0) return 'Компаний пока нет.';
		return `Компании (${companies.length}):\n${companies
			.map((c) => `${c.id} — ${c.name}, вес ${c.fit_rank}`)
			.join('\n')}`;
	}

	const applications = deps.ledger.readAll('applications');
	if (what === 'applications') {
		if (applications.length === 0) return 'Откликов пока нет.';
		return `Отклики (${applications.length}):\n${applications
			.map((a) => `${a.id} — ${a.role_title} (${a.submission_channel}, подан ${a.applied_at})`)
			.join('\n')}`;
	}

	const report = computeFunnel(applications, deps.ledger.readAll('application_events'), {
		asOf: deps.nowFn().toISOString(),
		ghostAfterDays: deps.ghostAfterDays ?? 21,
		connectedSources: deps.connectedSources ?? ['manual'],
	});

	const lines = [`Воронка на ${report.as_of}: откликов ${report.total}.`];
	for (const [key, r] of Object.entries(report.conversions)) {
		lines.push(`${key}: ${formatRate(r, { withInterval: true })}`);
	}
	lines.push(`Доля игнора: ${formatRate(report.ghost)}`);
	if (!report.trendAllowed) lines.push('Мало данных для тренда — только счётчики.');
	lines.push(report.sourceCoverage);

	return lines.join('\n');
}
