/**
 * poller.ts — long-poll цикл getUpdates (polling-режим, [ADR-0014]).
 *
 * Альтернатива входящему вебхуку: мост сам опрашивает api.telegram.org ИСХОДЯЩИМИ
 * запросами. Ни публичного URL, ни домена/туннеля — inbound attack surface = 0.
 * Бизнес-логику НЕ дублирует: тот же `extractJob` (owner-allow-list, [ADR-0009]) и
 * та же очередь/воркеры, что и webhook-путь (app.ts) — транспорт-нейтральное ядро.
 */
import { childLogger } from '../core/logger.js';
import { type BridgeState, extractJob } from './app.js';
import { QueueFull } from './queue.js';

const log = childLogger('bridge.poller');

/** Пауза с прерыванием по signal (backoff на сетевой ошибке, не висит на shutdown). */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * Бесконечный long-poll до отмены `signal` (shutdown). offset переживает рестарт
 * через store; backpressure — тот же QueueFull, что у вебхука. На сетевом сбое —
 * короткий backoff и продолжаем (Telegram копит апдейты до 24ч).
 */
export async function runPoller(state: BridgeState, signal: AbortSignal): Promise<void> {
	const { telegram, store, settings } = state;
	const { ownerChatId, pollTimeoutSec } = settings;
	let offset = store.getOffset();
	log.info({ ownerChatId, pollTimeoutSec, offset }, 'poller.started');

	while (!signal.aborted) {
		let updates: Array<Record<string, unknown>>;
		try {
			// message + callback_query (нажатия инлайн-кнопок, [ADR-0023]); extractJob
			// маршрутизирует оба. allowed_updates — явный allow-list ТИПОВ апдейтов.
			updates = await telegram.getUpdates(
				offset,
				pollTimeoutSec,
				['message', 'callback_query'],
				signal,
			);
		} catch (exc) {
			if (signal.aborted) break; // shutdown оборвал висящий long-poll
			log.warn({ err: String(exc) }, 'poller.get_updates_failed');
			await sleep(2000, signal);
			continue;
		}

		for (const update of updates) {
			const updateId = update.update_id;
			if (typeof updateId === 'number') offset = updateId + 1; // монотонный сдвиг

			const job = extractJob(update, ownerChatId);
			if (!job) continue; // не текст / чужой чат (security.foreign_chat_dropped в extractJob)

			try {
				state.queue.putNowait(job);
			} catch (exc) {
				if (exc instanceof QueueFull) {
					log.error({ chatId: job.chatId }, 'poller.queue_full');
					try {
						await telegram.sendMessage(job.chatId, 'Я сейчас перегружен, попробуй через минуту.');
					} catch {
						// best-effort
					}
				} else {
					throw exc;
				}
			}
		}

		// Сохраняем offset после батча: следующий getUpdates подтвердит обработанное серверу.
		if (updates.length > 0) store.setOffset(offset);
	}

	log.info({ offset }, 'poller.stopped');
}
