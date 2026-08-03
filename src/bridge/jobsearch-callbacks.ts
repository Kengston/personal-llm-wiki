/**
 * jobsearch-callbacks.ts — кнопки проактива воронки ([ADR-0030], Решение 5).
 *
 * Follow-up приходит один раз и с тремя кнопками:
 *   `[Написал]`        → КАСАНИЕ (`touch_kind: follow_up`) — стадию не двигает и в
 *                        конверсии не входит: переписка не должна рисовать себе конверсию;
 *   `[Отложить]`       → snooze, без записи в леджер: отложить — это про напоминание,
 *                        а не про факт;
 *   `[Считать игнором]`→ `stage_change` в `ghosted` — ЕДИНСТВЕННЫЙ законный способ
 *                        появления `ghosted` в леджере. Автоматически по таймауту его
 *                        дописывать нельзя: молчание это отсутствие события, компания
 *                        может ответить и на шестидесятый день. Леджер хранит наблюдения,
 *                        аналитика хранит выводы.
 *
 * После нажатия кнопки снимаются: отработавший флоу не должен позволять кликнуть второй раз.
 */

import { childLogger } from '../core/logger.js';
import type { ApplicationEvent } from '../ingest/jobsearch/events.js';
import type { JobsearchLedger } from '../ingest/jobsearch/ledger.js';
import { writeSnoozeUntil } from '../scheduler/finance-state.js';
import { eventId } from './jobsearch-intent.js';
import type { TelegramClient } from './telegram.js';

const log = childLogger('bridge.jobsearch-callbacks');

/** Префикс callback_data воронки. Свой, не пересекается с `fin:` и `res:`. */
export const JOBSEARCH_CALLBACK_PREFIX = 'js:';

/** На сколько откладывается предложение follow-up по кнопке «Отложить». */
const SNOOZE_DAYS = 3;

export interface JobsearchCallback {
	chatId: number;
	/** Инициатор нажатия — на нём стоит owner-гейт. */
	fromId: number;
	callbackQueryId: string;
	data: string;
	messageId?: number;
}

export interface JobsearchCallbackDeps {
	ownerChatId: number;
	telegram: TelegramClient;
	ledger: JobsearchLedger;
	/** Каталог состояния проактива (общий с финансовым, ключи разведены префиксом). */
	stateDir: string;
	nowFn: () => Date;
}

/**
 * dispatchJobsearchCallback — применяет нажатие кнопки follow-up.
 *
 * Гасит «часики» в любом исходе: непогашенный индикатор выглядит как зависший бот.
 */
export async function dispatchJobsearchCallback(
	cb: JobsearchCallback,
	deps: JobsearchCallbackDeps,
): Promise<void> {
	if (cb.fromId !== deps.ownerChatId) {
		log.warn({ fromId: cb.fromId }, 'security.jobsearch_callback_foreign');
		await deps.telegram.answerCallbackQuery(cb.callbackQueryId);
		return;
	}

	const [scope, action, applicationId] = cb.data.slice(JOBSEARCH_CALLBACK_PREFIX.length).split(':');
	if (scope !== 'fu' || !action || !applicationId) {
		log.warn({ data: cb.data }, 'jobsearch-callback.unknown');
		await deps.telegram.answerCallbackQuery(cb.callbackQueryId, { text: 'Не понял кнопку.' });
		return;
	}

	const application = deps.ledger.readAll('applications').find((a) => a.id === applicationId);
	if (!application) {
		await deps.telegram.answerCallbackQuery(cb.callbackQueryId, { text: 'Отклик не найден.' });
		return;
	}

	const now = deps.nowFn();
	const nowIso = now.toISOString();
	let reply: string;

	if (action === 'done') {
		const event: ApplicationEvent = {
			id: eventId([applicationId, 'touchpoint', 'follow_up', nowIso]),
			application_id: applicationId,
			ts: nowIso,
			kind: 'touchpoint',
			touch_kind: 'follow_up',
			source: 'owner',
		};
		deps.ledger.append('application_events', event);
		reply = 'Записал касание. Стадию оно не двигает.';
	} else if (action === 'snooze') {
		const until = new Date(now.getTime() + SNOOZE_DAYS * 86_400_000).toISOString();
		// Ключ тот же, что у свипа: `js:followup:<app>:<applied_at>`.
		writeSnoozeUntil(
			deps.stateDir,
			`js:followup:${applicationId}:${application.applied_at}`,
			until,
		);
		reply = `Отложил до ${until.slice(0, 10)}.`;
	} else if (action === 'ghost') {
		const event: ApplicationEvent = {
			id: eventId([applicationId, 'stage_change', 'ghosted', nowIso]),
			application_id: applicationId,
			ts: nowIso,
			kind: 'stage_change',
			stage: 'ghosted',
			source: 'owner',
			reason_code: 'no_response',
		};
		deps.ledger.append('application_events', event);
		reply = 'Отметил как игнор — это ваш вывод, не вывод системы.';
	} else {
		await deps.telegram.answerCallbackQuery(cb.callbackQueryId, { text: 'Не понял кнопку.' });
		return;
	}

	await deps.telegram.answerCallbackQuery(cb.callbackQueryId, { text: reply });

	// Кнопки снимаем: флоу отработал, второй клик по нему смысла не имеет.
	if (cb.messageId !== undefined) {
		await deps.telegram.editMessageReplyMarkup(cb.chatId, cb.messageId);
	}

	log.info({ action, applicationId }, 'jobsearch-callback.applied');
}
