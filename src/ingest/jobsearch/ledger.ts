/**
 * ledger.ts — спецификация леджера подсистемы «Поиск работы» ([ADR-0029]/[ADR-0030]).
 *
 * Четыре файла в ОДНОМ каталоге `raw/jobsearch/`: реестр компаний и вакансий
 * ([ADR-0029]) плюс воронка откликов ([ADR-0030]). Каталог общий не по недосмотру —
 * это один домен: отклик ссылается на компанию, компания без откликов бессмысленна.
 *
 * Механика — общий параметризованный `Ledger` (слайс [ADR-0028]). Финансовые константы
 * и `resolveFinanceDir()` не трогаются: воронка не должна уметь писать в `raw/finance/`,
 * и тест на это стоит рядом с path-guard'ом.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { Ledger, type LedgerOptions, type LedgerSpec } from '../ledger.js';
import {
	CompanyRecordSchema,
	OpportunityRecordSchema,
	type CompanyRecord,
	type OpportunityRecord,
} from './companies.js';
import {
	ApplicationEventSchema,
	ApplicationRecordSchema,
	type ApplicationEvent,
	type ApplicationRecord,
} from './events.js';
import { FormAnswerRecordSchema, type FormAnswerRecord } from './form-answers.js';

/** Имена файлов. Каталог без дефиса — `jobsearch`, как зафиксировано в глоссарии. */
export const JOBSEARCH_LEDGER_FILES = {
	companies: 'companies.jsonl',
	opportunities: 'opportunities.jsonl',
	applications: 'applications.jsonl',
	application_events: 'application_events.jsonl',
	form_answers: 'form-answers.jsonl',
} as const;

export type JobsearchFileKey = keyof typeof JOBSEARCH_LEDGER_FILES;

export type JobsearchRecordMap = {
	companies: CompanyRecord;
	opportunities: OpportunityRecord;
	applications: ApplicationRecord;
	application_events: ApplicationEvent;
	form_answers: FormAnswerRecord;
};

/**
 * resolveJobsearchDir — `raw/jobsearch/` приватного репо.
 * Порядок тот же, что у финансов и карьеры — окружение ведёт себя предсказуемо.
 */
export function resolveJobsearchDir(env: NodeJS.ProcessEnv = process.env): string {
	if (env.JOBSEARCH_RAW_DIR) return resolve(env.JOBSEARCH_RAW_DIR);
	if (env.RAW_DIR) return resolve(join(env.RAW_DIR, 'jobsearch'));
	const contentRoot = env.CONTENT_ROOT ?? join(homedir(), 'llm-wiki-content');
	return resolve(join(contentRoot, 'raw', 'jobsearch'));
}

export const JOBSEARCH_LEDGER: LedgerSpec<JobsearchRecordMap> = {
	files: JOBSEARCH_LEDGER_FILES,
	schemas: {
		companies: CompanyRecordSchema,
		opportunities: OpportunityRecordSchema,
		applications: ApplicationRecordSchema,
		application_events: ApplicationEventSchema,
		form_answers: FormAnswerRecordSchema,
	},
	resolveDir: resolveJobsearchDir,
};

export type JobsearchLedger = Ledger<JobsearchRecordMap>;

/**
 * createJobsearchLedger — леджер поиска работы с переданными опциями.
 *
 * @param opts — опции (dir, publicRepoRoot, env, onSkip)
 */
export function createJobsearchLedger(opts: LedgerOptions = {}): JobsearchLedger {
	return new Ledger(JOBSEARCH_LEDGER, opts);
}
