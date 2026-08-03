/**
 * career-callbacks.ts — кнопочные правки карьерной базы ([ADR-0028], D1).
 *
 * Структурная правка — включить/исключить достижение в варианте — делается нажатием,
 * а не свободным текстом: структура, введённая текстом, требует разбора речи движком,
 * то есть ровно того недетерминизма, который вся остальная система выносит в код.
 *
 * После записи сообщение со списком ПЕРЕПИСЫВАЕТСЯ на месте (`editMessageText`), а не
 * шлётся заново: без этого каждое нажатие плодит новое сообщение и диалог правки
 * становится нечитаемым — именно поэтому транспорт и получил `editMessage*`.
 *
 * Owner-gate стоит и здесь, а не только на входе моста: `from.id` — инициатор нажатия,
 * и проверять его надо там, где выполняется действие ([ADR-0009], single-user).
 */

import { childLogger } from '../core/logger.js';
import type { CareerLedger } from '../ingest/career/store.js';
import { loadCareerBase } from '../ingest/career/store.js';
import { dispatchCareerIntent, formatCareerReadback } from './career-intent-dispatch.js';
import { CAREER_CALLBACK_PREFIX, runCareerQuery } from './career-intent-query.js';

import type { TelegramClient } from './telegram.js';

const log = childLogger('bridge.career-callbacks');

/** Нажатие кнопки: то, что нужно обработчику. */
export interface CareerCallback {
	chatId: number;
	/** Инициатор нажатия — на нём стоит owner-гейт. */
	fromId: number;
	callbackQueryId: string;
	data: string;
	/** Сообщение с кнопкой — его и переписываем. */
	messageId?: number;
}

export interface CareerCallbackDeps {
	ownerChatId: number;
	telegram: TelegramClient;
	ledger: CareerLedger;
	nowFn: () => Date;
}

/**
 * Действия кнопок. Их ровно два, потому что ровно две кнопки и рисует
 * `career-intent-query.ts`: список действий без кнопок был бы мёртвым кодом.
 */
const ACTIONS = { inc: true, exc: false } as const;

/**
 * dispatchCareerCallback — применяет нажатие и обновляет сообщение.
 *
 * Гасит «часики» в любом исходе: непогашенный индикатор выглядит как зависший бот.
 */
export async function dispatchCareerCallback(
	cb: CareerCallback,
	deps: CareerCallbackDeps,
): Promise<void> {
	if (cb.fromId !== deps.ownerChatId) {
		log.warn({ fromId: cb.fromId }, 'security.career_callback_foreign');
		await deps.telegram.answerCallbackQuery(cb.callbackQueryId);
		return;
	}

	const parts = cb.data.slice(CAREER_CALLBACK_PREFIX.length).split(':');
	const [action, variantId, achievementId] = parts;

	if (!action || !(action in ACTIONS) || !variantId || !achievementId) {
		log.warn({ data: cb.data }, 'career-callback.unknown');
		await deps.telegram.answerCallbackQuery(cb.callbackQueryId, { text: 'Не понял кнопку.' });
		return;
	}

	const result = dispatchCareerIntent(
		{
			type: 'toggle_achievement',
			variant_id: variantId,
			achievement_id: achievementId,
			include: ACTIONS[action as keyof typeof ACTIONS],
		},
		{ ledger: deps.ledger, nowFn: deps.nowFn },
	);

	await deps.telegram.answerCallbackQuery(cb.callbackQueryId, {
		text: formatCareerReadback(result),
	});

	if (!result.ok || cb.messageId === undefined) return;

	// Перерисовываем список из СВЕЖЕГО состояния: кнопка обязана показывать то, что
	// записано, а не то, что мы предполагаем после нажатия.
	const refreshed = runCareerQuery(
		{ type: 'query', what: 'achievements', variant_id: variantId },
		loadCareerBase(deps.ledger),
	);
	await deps.telegram.editMessageText(cb.chatId, cb.messageId, refreshed.text, {
		...(refreshed.keyboard ? { replyMarkup: refreshed.keyboard } : {}),
	});

	log.info({ action, variantId, achievementId }, 'career-callback.applied');
}
