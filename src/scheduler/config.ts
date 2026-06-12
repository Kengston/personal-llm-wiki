/**
 * config.ts — пути и параметры планового слоя из окружения (host-portable, [ADR-0005]).
 *
 * Порт `Config`/`RoutineConfig` из digest.py/routines.py ([ADR-0012]). Никаких
 * хардкод-путей: переезд на Mac Mini/VPS не требует правок кода. Содержимое —
 * приватный контент-репо (raw/ + wiki/ + reminders/), пути задаёт .env приватного репо.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { Duration } from 'luxon';

export interface SchedulerConfig {
	contentRoot: string;
	remindersPath: string;
	wikiDir: string;
	remindersLog: string;
	rawDir: string;
	filterLog: string; // append-only ledger диспозиций фильтра (метаданные, НЕ тела)
	tasksLog: string;
	tasksInbox: string; // raw/.tasks/inbox/ — считаем только КОЛ-ВО файлов
	filterWatermark: string; // курсор «с какого момента показывать фильтр-сводку»
	upcomingWatermark: string; // дата последнего «только-скоро» дайджеста (дедуп раз/сутки)
	filterSamplesPerCategory: number;
	lookaheadDays: number;
	graceMinutes: number;
	quietWhenOnlyUpcoming: boolean;
	// routine-specific:
	researchQueries: string;
	researchOutDir: string;
	publicRepo: string;
	// derived:
	lookahead: Duration;
	grace: Duration;
}

/** Парс целого из env: СОХРАНЯЕТ 0 (Number()||default его глотал), нечисловое → дефолт. */
function intEnv(raw: string | undefined, def: number): number {
	if (raw === undefined) return def;
	const t = raw.trim();
	return /^[+-]?\d+$/.test(t) ? Number.parseInt(t, 10) : def;
}

export function loadSchedulerConfig(env: NodeJS.ProcessEnv = process.env): SchedulerConfig {
	const contentRoot = env.CONTENT_ROOT ?? join(homedir(), 'llm-wiki-content');
	const rawDir = env.RAW_DIR ?? join(contentRoot, 'raw');
	const wikiDir = env.WIKI_DIR ?? join(contentRoot, 'wiki');
	const lookaheadDays = intEnv(env.DIGEST_LOOKAHEAD_DAYS, 7);
	const graceMinutes = intEnv(env.DIGEST_GRACE_MINUTES, 5);

	return {
		contentRoot,
		remindersPath: env.REMINDERS_PATH ?? join(contentRoot, 'reminders', 'reminders.md'),
		wikiDir,
		remindersLog: env.REMINDERS_LOG ?? join(contentRoot, 'reminders', 'log.md'),
		rawDir,
		filterLog: env.FILTER_LOG ?? join(rawDir, '.filter-log.jsonl'),
		tasksLog: env.TASKS_LOG ?? join(contentRoot, 'tasks', 'log.md'),
		tasksInbox: env.TASKS_INBOX ?? join(rawDir, '.tasks', 'inbox'),
		filterWatermark: env.FILTER_DIGEST_WATERMARK ?? join(rawDir, '.watermarks', 'filter-digest.txt'),
		upcomingWatermark: env.UPCOMING_DIGEST_WATERMARK ?? join(rawDir, '.watermarks', 'upcoming-digest.txt'),
		filterSamplesPerCategory: intEnv(env.FILTER_DIGEST_SAMPLES, 2),
		lookaheadDays,
		graceMinutes,
		quietWhenOnlyUpcoming: (env.DIGEST_QUIET_UPCOMING ?? 'true').toLowerCase() === 'true',
		researchQueries: env.RESEARCH_QUERIES ?? join(contentRoot, 'research', 'queries.md'),
		researchOutDir: env.RESEARCH_OUT_DIR ?? join(wikiDir, 'research'),
		// Корень ПУБЛИЧНОГО репо (для PII-скана в routine lint): ../.. от этого модуля.
		publicRepo: env.PUBLIC_REPO ?? resolve(import.meta.dirname, '..', '..'),
		lookahead: Duration.fromObject({ days: lookaheadDays }),
		grace: Duration.fromObject({ minutes: graceMinutes }),
	};
}
