/**
 * app.ts — Fastify-мост Telegram ↔ движок (порт bridge/app.py, [ADR-0012]).
 *
 * Поток ([ADR-0004], [ADR-0008]):
 *   Telegram → CF Tunnel → POST /telegram/webhook/<nonce>
 *     → 3 слоя безопасности (nonce пути / secret-token header / owner chat_id)
 *     → кладём Job в очередь, СРАЗУ отвечаем 200 (webhook не ждёт движок)
 *     → воркер: single-flight на chat_id → engine.run → store → telegram.send
 *
 * Безопасность (три слоя). Слой №2 — жёсткий single-user-инвариант [ADR-0009]:
 *   (1) nonce в пути — constant-time против webhook_secret (несовпадение → 404);
 *   (2) заголовок X-Telegram-Bot-Api-Secret-Token — constant-time (→ 404);
 *   (3) hard allow-list: chat.id != TELEGRAM_OWNER_CHAT_ID → дроп (200, тихо).
 */
import { timingSafeEqual } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';

import { childLogger } from '../core/logger.js';
import type { Settings } from './config.js';
import { type Engine, EngineError, type EngineResult } from './engine.js';
import { AsyncQueue, Mutex, QueueFull } from './queue.js';
import type { SessionStore } from './store.js';
import type { TelegramClient } from './telegram.js';

const log = childLogger('bridge.app');

export interface Job {
	chatId: number;
	text: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Constant-time-сравнение строк (аналог hmac.compare_digest); false при разной длине. */
function safeEqual(a: string, b: string): boolean {
	const ba = Buffer.from(a, 'utf8');
	const bb = Buffer.from(b, 'utf8');
	if (ba.length !== bb.length) return false;
	return timingSafeEqual(ba, bb);
}

/** Собранные на старте зависимости моста + примитивы конкуренции. */
export class BridgeState {
	readonly queue: AsyncQueue<Job>;
	readonly workerTasks: Promise<void>[] = [];
	private readonly chatLocks = new Map<number, Mutex>();
	stopping = false;

	constructor(
		readonly settings: Settings,
		readonly engine: Engine,
		readonly store: SessionStore,
		readonly telegram: TelegramClient,
	) {
		this.queue = new AsyncQueue<Job>(settings.maxQueue);
	}

	/** Lock single-flight для чата (создаётся лениво). */
	chatLock(chatId: number): Mutex {
		let lock = this.chatLocks.get(chatId);
		if (!lock) {
			lock = new Mutex();
			this.chatLocks.set(chatId, lock);
		}
		return lock;
	}
}

// --------------------------------------------------------------------------- //
// Парсинг update Telegram                                                     //
// --------------------------------------------------------------------------- //

/**
 * Вытащить Job из update. None (→ игнор), если: не текстовое сообщение;
 * chat.id != owner (слой №2, single-user); текст пустой. Поддерживаем
 * message и edited_message.
 */
export function extractJob(update: Record<string, unknown>, ownerChatId: number): Job | null {
	const message = isRecord(update.message)
		? update.message
		: isRecord(update.edited_message)
			? update.edited_message
			: null;
	if (!message) return null;

	const chat = isRecord(message.chat) ? message.chat : {};
	const chatId = chat.id;
	if (typeof chatId !== 'number') return null;

	// Слой №2 — HARD allow-list владельца ([ADR-0009], single-user).
	if (chatId !== ownerChatId) {
		log.warn({ chatId }, 'security.foreign_chat_dropped');
		return null;
	}

	const text = message.text;
	if (typeof text !== 'string' || !text.trim()) return null;

	return { chatId, text: text.trim() };
}

// --------------------------------------------------------------------------- //
// Воркер очереди                                                              //
// --------------------------------------------------------------------------- //

async function worker(state: BridgeState, workerId: number): Promise<void> {
	log.info({ workerId }, 'worker.started');
	for (;;) {
		const job = await state.queue.get();
		if (job === null) break; // очередь закрыта (shutdown)
		try {
			await handleJob(state, job);
		} catch (exc) {
			// Воркер обязан пережить любой сбой job'а.
			log.error({ chatId: job.chatId, err: String(exc) }, 'worker.job_failed');
		}
	}
}

export async function handleJob(state: BridgeState, job: Job): Promise<void> {
	// Команда /reset — забыть сессию.
	if (job.text.trim() === '/reset') {
		state.store.resetSession(job.chatId);
		await state.telegram.sendMessage(job.chatId, 'Контекст диалога сброшен.');
		return;
	}

	// «печатает…» сразу — маскирует латентность движка.
	await state.telegram.sendChatAction(job.chatId, 'typing');

	// single-flight на chat_id: возвращаем результат, отправку делаем ВНЕ lock'а.
	const result = await state.chatLock(job.chatId).run<EngineResult | null>(async () => {
		const sessionId = state.store.getSession(job.chatId);
		let res: EngineResult;
		try {
			res = await runEngineWithRetry(state.engine, job.text, sessionId);
		} catch (exc) {
			if (exc instanceof EngineError) {
				log.warn({ chatId: job.chatId, error: String(exc) }, 'engine.failed');
				await state.telegram.sendMessage(
					job.chatId,
					'Не удалось обработать сообщение (движок недоступен или превышен лимит). ' +
						'Попробуй ещё раз чуть позже.',
				);
				return null;
			}
			throw exc;
		}
		if (res.sessionId) state.store.upsertSession(job.chatId, res.sessionId);
		return res;
	});

	if (!result) return;

	// Сеть к Telegram не держит сессию (отправка вне lock'а).
	await state.telegram.sendMessage(job.chatId, result.answer);
	log.info(
		{ chatId: job.chatId, usage: result.usage, answerChars: result.answer.length },
		'job.done',
	);
}

async function runEngineWithRetry(
	engine: Engine,
	prompt: string,
	sessionId: string | null,
): Promise<EngineResult> {
	try {
		return await engine.run(prompt, sessionId);
	} catch (exc) {
		if (exc instanceof EngineError && exc.transient) {
			log.info({ reason: String(exc) }, 'engine.retry');
			await new Promise((r) => setTimeout(r, 2000)); // короткий backoff
			return engine.run(prompt, sessionId);
		}
		throw exc;
	}
}

/** Поднять пул воркеров (фоновые async-циклы). */
export function startWorkers(state: BridgeState): void {
	const n = Math.max(1, state.settings.workers);
	for (let i = 0; i < n; i++) {
		state.workerTasks.push(worker(state, i));
	}
	log.info({ workers: n, ownerChatId: state.settings.ownerChatId }, 'bridge.started');
}

/** Аккуратный shutdown: закрыть очередь (воркеры выйдут), затем ресурсы. */
export async function stopBridge(state: BridgeState): Promise<void> {
	state.stopping = true;
	state.queue.close();
	await Promise.all(state.workerTasks);
	state.store.close();
	await state.telegram.aclose();
	log.info('bridge.stopped');
}

// --------------------------------------------------------------------------- //
// Fastify-приложение                                                          //
// --------------------------------------------------------------------------- //

/**
 * Построить Fastify-инстанс. /health — всегда (диагностика launchd в обоих режимах,
 * [ADR-0014]); webhook-роут /telegram/webhook/:nonce — только при `webhook` (в
 * polling входящего HTTP нет). Дефолт webhook:true сохраняет webhook-режим и тесты.
 */
export function buildApp(state: BridgeState, opts: { webhook?: boolean } = {}): FastifyInstance {
	const includeWebhook = opts.webhook ?? true;
	const app = Fastify({ logger: false, trustProxy: true });

	// Лояльный JSON-парсер: кривое тело → undefined (вебхук ответит 200 без ретраев),
	// а не 400, как делает Python (молча игнорируем плохой JSON).
	const parseJsonBody = (
		_req: unknown,
		body: string,
		done: (err: Error | null, value?: unknown) => void,
	): void => {
		const raw = typeof body === 'string' ? body.trim() : '';
		if (!raw) {
			done(null, undefined);
			return;
		}
		try {
			done(null, JSON.parse(raw));
		} catch {
			done(null, undefined);
		}
	};
	app.addContentTypeParser('application/json', { parseAs: 'string' }, parseJsonBody);
	// '*' — любой/отсутствующий Content-Type: читаем тело как строку и парсим тем же
	// лениентным путём, чтобы security-проверки (nonce/header → 404) отрабатывали В
	// ХЕНДЛЕРЕ (как ленивый request.json() у FastAPI), а не 415 ДО него (это косвенно
	// палило бы существование POST-роута). [аудит TS-порта]
	app.addContentTypeParser('*', { parseAs: 'string' }, parseJsonBody);

	app.get('/health', async () => {
		let telegramOk = true;
		let bot: string | null = null;
		try {
			const me = await state.telegram.getMe();
			bot = typeof me.username === 'string' ? me.username : null;
		} catch (exc) {
			telegramOk = false;
			log.warn({ error: String(exc) }, 'health.telegram_unreachable');
		}
		return {
			status: telegramOk ? 'ok' : 'degraded',
			telegram_ok: telegramOk,
			bot,
			queue_size: state.queue.size,
			workers: state.workerTasks.length,
		};
	});

	// polling-режим ([ADR-0014]): входящего вебхука нет — отдаём только /health.
	if (!includeWebhook) return app;

	app.post<{ Params: { nonce: string } }>('/telegram/webhook/:nonce', async (request, reply) => {
		const { nonce } = request.params;
		const secret = state.settings.webhookSecret;

		// Слой №3: nonce в пути.
		if (!safeEqual(nonce, secret)) {
			log.warn('security.bad_path_nonce');
			return reply.code(404).send();
		}

		// Слой №1: secret-token header (constant-time).
		const header = request.headers['x-telegram-bot-api-secret-token'];
		const headerStr = typeof header === 'string' ? header : '';
		if (!headerStr || !safeEqual(headerStr, secret)) {
			log.warn('security.bad_secret_token');
			return reply.code(404).send();
		}

		// Тело update (кривой JSON → undefined → 200).
		const update = request.body;
		if (!isRecord(update)) {
			log.warn('webhook.bad_json');
			return reply.code(200).send();
		}

		// Слой №2 (allow-list владельца) + парсинг.
		const job = extractJob(update, state.settings.ownerChatId);
		if (!job) return reply.code(200).send();

		// В очередь без блокировки. Переполнено → backpressure (200, не вешаем webhook).
		try {
			state.queue.putNowait(job);
		} catch (exc) {
			if (exc instanceof QueueFull) {
				log.error({ chatId: job.chatId }, 'webhook.queue_full');
				try {
					await state.telegram.sendMessage(
						job.chatId,
						'Я сейчас перегружен, попробуй через минуту.',
					);
				} catch {
					// best-effort
				}
				return reply.code(200).send();
			}
			throw exc;
		}

		return reply.code(200).send();
	});

	return app;
}
