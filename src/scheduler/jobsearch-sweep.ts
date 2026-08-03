/**
 * jobsearch-sweep.ts — проактив воронки ([ADR-0030], Решение 5; D10).
 *
 * **Ровно два триггера, и оба привязаны к записи в леджере.** Правило одной строкой:
 * у напоминания обязан быть якорь-запись; нет записи — нет пуша. Если за свип сказать
 * нечего — молчим (не «сегодня 0 откликов»).
 *
 * Ритуальных recurring-напоминаний здесь нет и не будет. Не «раз в неделю обнови профиль»,
 * не «проверь новые вакансии по понедельникам», не «еженедельная сводка воронки».
 * Предыдущий набор таких напоминаний владелец отключил 2026-08-01 ровно потому, что они
 * рапортовали о процессе, под которым не было ни одного артефакта: пуш приходил независимо
 * от того, происходило ли что-нибудь, и обучал игнорировать бота. Воспроизводить
 * отключённое — значит повторять уже оплаченную ошибку.
 *
 * Механика fired-state переиспользуется из `finance-state` с префиксом ключей `js:` —
 * она не финансово-специфична, обобщать её не требуется.
 */

import { childLogger } from '../core/logger.js';
import {
	foldAll,
	type ApplicationEvent,
	type ApplicationRecord,
	type ApplicationState,
} from '../ingest/jobsearch/events.js';
import type { JobsearchLedger } from '../ingest/jobsearch/ledger.js';
import { markFired, readSnoozeUntil, wasFired } from './finance-state.js';
import { pushToOwner } from './runner.js';

const log = childLogger('scheduler.jobsearch-sweep');

/** Напоминание о назначенном собеседовании. */
export interface InterviewDue {
	applicationId: string;
	roleTitle: string;
	/** Когда собеседование. */
	scheduledAt: string;
	/** `lead` — за сутки, `soon` — за два часа. */
	when: 'lead' | 'soon';
}

/** Предложение написать follow-up по молчащему отклику. */
export interface FollowUpDue {
	applicationId: string;
	roleTitle: string;
	appliedAt: string;
	/** Сколько дней тишины со стороны работодателя. */
	silentDays: number;
}

export interface JobsearchDue {
	interviews: InterviewDue[];
	followUps: FollowUpDue[];
}

/** Завершённые воронки не напоминают о себе: там уже нечего ждать. */
const TERMINAL: ReadonlySet<string> = new Set(['offer', 'rejected', 'withdrawn', 'ghosted']);

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Окна напоминания о собесе: сутки и два часа до события. */
const LEAD_MS = 24 * HOUR_MS;
const SOON_MS = 2 * HOUR_MS;

export interface CollectOptions {
	/** Момент свипа (ISO). Аргумент, а не часы внутри — свип воспроизводим в тестах. */
	now: string;
	/** Через сколько дней молчания предлагать follow-up. */
	followUpAfterDays: number;
}

/**
 * collectJobsearchDue — чистая функция: что именно сегодня заслуживает пуша.
 *
 * Никаких «а вдруг пригодится»: собеседование должно быть НАЗНАЧЕНО (у события заполнен
 * `scheduled_at`), а отклик — реально молчать. Ожидания и намерения триггерами не являются.
 */
export function collectJobsearchDue(
	applications: ApplicationRecord[],
	events: ApplicationEvent[],
	opts: CollectOptions,
): JobsearchDue {
	const states = foldAll(applications, events);
	const nowMs = Date.parse(opts.now);

	const interviews: InterviewDue[] = [];
	const followUps: FollowUpDue[] = [];

	for (const app of applications) {
		const state = states.get(app.id);
		if (!state) continue;

		collectInterviews(app, state, nowMs, interviews);

		// Follow-up — только по живой воронке и только при реальном молчании.
		if (TERMINAL.has(state.stage ?? '')) continue;
		const silentFrom = Date.parse(state.lastExternalAt ?? app.applied_at);
		const silentDays = (nowMs - silentFrom) / DAY_MS;
		if (silentDays >= opts.followUpAfterDays) {
			followUps.push({
				applicationId: app.id,
				roleTitle: app.role_title,
				appliedAt: app.applied_at,
				silentDays: Math.floor(silentDays),
			});
		}
	}

	return { interviews, followUps };
}

/** Окна напоминания по каждому назначенному собеседованию. */
function collectInterviews(
	app: ApplicationRecord,
	state: ApplicationState,
	nowMs: number,
	out: InterviewDue[],
): void {
	for (const scheduledAt of state.scheduled) {
		const atMs = Date.parse(scheduledAt);
		if (!Number.isFinite(atMs) || atMs <= nowMs) continue;

		const untilMs = atMs - nowMs;
		if (untilMs <= SOON_MS) {
			out.push({ applicationId: app.id, roleTitle: app.role_title, scheduledAt, when: 'soon' });
		} else if (untilMs <= LEAD_MS) {
			out.push({ applicationId: app.id, roleTitle: app.role_title, scheduledAt, when: 'lead' });
		}
	}
}

// ---------------------------------------------------------------------------
// Доставка
// ---------------------------------------------------------------------------

/** Ключ дедупа напоминания о собесе. */
export function interviewKey(due: InterviewDue): string {
	return `js:interview:${due.applicationId}:${due.scheduledAt}:${due.when}`;
}

/** Ключ дедупа предложения follow-up. */
export function followUpKey(due: FollowUpDue): string {
	return `js:followup:${due.applicationId}:${due.appliedAt}`;
}

export interface DeliverDeps {
	/** Каталог мутабельного состояния проактива (`.finance-state/`). */
	stateDir: string;
	/** Отправитель. Инъекция — тесты без живого Telegram. */
	push?: typeof pushToOwner;
}

/**
 * deliverJobsearchDue — отправляет то, что собрал сборщик, ровно по одному разу.
 *
 * Follow-up приходит С КНОПКАМИ: `[Написал]` пишет касание (стадию не двигает и в
 * конверсии не входит), `[Отложить]` ставит snooze, `[Считать игнором]` — единственный
 * законный способ появления `ghosted` в леджере. Автоматически дописывать `ghosted` по
 * таймауту нельзя: молчание это отсутствие события, а не событие, и компания может
 * ответить на шестидесятый день.
 *
 * @returns сколько пушей отправлено
 */
export async function deliverJobsearchDue(
	due: JobsearchDue,
	now: string,
	deps: DeliverDeps,
): Promise<number> {
	const push = deps.push ?? pushToOwner;
	let sent = 0;

	for (const item of due.interviews) {
		const key = interviewKey(item);
		if (wasFired(deps.stateDir, key)) continue;

		const when = item.when === 'lead' ? 'завтра' : 'через два часа';
		await push(`Собеседование ${when}: ${item.roleTitle} (${item.scheduledAt}).`);
		markFired(deps.stateDir, key, now);
		sent++;
	}

	for (const item of due.followUps) {
		const key = followUpKey(item);
		if (wasFired(deps.stateDir, key)) continue;

		// Snooze — отдельный от fired механизм: владелец отложил, а не отказался.
		const snoozed = readSnoozeUntil(deps.stateDir, key);
		if (snoozed && snoozed > now) continue;

		await push(
			`Тишина ${item.silentDays} дн. по отклику «${item.roleTitle}» (подан ${item.appliedAt}). Написать follow-up?`,
			{
				replyMarkup: {
					inline_keyboard: [
						[
							{ text: 'Написал', callback_data: `js:fu:done:${item.applicationId}` },
							{ text: 'Отложить', callback_data: `js:fu:snooze:${item.applicationId}` },
							{ text: 'Считать игнором', callback_data: `js:fu:ghost:${item.applicationId}` },
						],
					],
				},
			},
		);
		markFired(deps.stateDir, key, now);
		sent++;
	}

	if (sent > 0) log.info({ sent }, 'jobsearch-sweep.delivered');
	return sent;
}

/**
 * runJobsearchSweep — сборка + доставка одним ходом.
 *
 * Вызывается из `runDigest` НАПРЯМУЮ, а не через опциональный параметр: финансовый
 * проактив написан и мёртв ровно потому, что его результат надо было прокинуть в `runSweep`
 * извне, и этого никто не делает. Здесь швов, которые можно забыть соединить, нет.
 *
 * @returns сколько пушей отправлено (0 — значит сказать было нечего, и это норма)
 */
export async function runJobsearchSweep(
	ledger: JobsearchLedger,
	now: string,
	deps: DeliverDeps & { followUpAfterDays: number },
): Promise<number> {
	const due = collectJobsearchDue(
		ledger.readAll('applications'),
		ledger.readAll('application_events'),
		{ now, followUpAfterDays: deps.followUpAfterDays },
	);
	return deliverJobsearchDue(due, now, deps);
}
