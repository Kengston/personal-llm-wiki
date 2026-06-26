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
import { failClosedSanitize, SanitizerError } from '../ingest/sanitizer.js';
import { Ledger } from '../ingest/finance/ledger.js';
import type { Settings } from './config.js';
import { type Engine, EngineError, type EngineResult } from './engine.js';
import {
	dispatchFinanceIntent,
	extractFinanceIntent,
	formatReadback,
} from './finance-intent.js';
import {
	CALLBACK_PREFIX,
	dispatchFinanceCallback,
} from './finance-callbacks.js';
import { AsyncQueue, Mutex, QueueFull } from './queue.js';
import {
	findSession,
	formatAmbiguous,
	formatSessionCard,
	formatSessionList,
	listSessions,
	readSessionTail,
	type SessionsConfig,
} from './sessions.js';
import type { SessionStore } from './store.js';
import type { TelegramClient } from './telegram.js';
import { commitIfDirty } from './writeback.js';

const log = childLogger('bridge.app');

/** Данные нажатия инлайн-кнопки (callback_query, [ADR-0023]). */
export interface CallbackInfo {
	/** callback_query.id — для answerCallbackQuery (погасить «часики»). */
	id: string;
	/** callback_data кнопки (что нажали; задаём мы при создании клавиатуры). */
	data: string;
	/** message_id сообщения с кнопкой — для будущих editMessage* (drill-down). */
	messageId?: number;
}

export interface Job {
	chatId: number;
	/** Текст сообщения; для callback-джобы — callback_data нажатой кнопки. */
	text: string;
	/** Присутствует, если джоба — нажатие инлайн-кнопки (а не сообщение). */
	callback?: CallbackInfo;
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
		readonly wikiRepoPath?: string,
		// Полоса локальных сессий Claude Code ([ADR-0017]). Опциональны: фича включается
		// только при SESSIONS_ENABLED=1 + непустом allowlist. resumeEngineFor строит движок
		// под cwd конкретного проекта (без персоны вики) для `/resume`.
		readonly sessions?: SessionsConfig,
		readonly resumeEngineFor?: (projectPath: string) => Engine,
		/**
		 * financeLedger — экземпляр Ledger для финансового диспетчера (ADR-0024).
		 * Опционально: если не задан, finance-intent диспетчеризация не производится.
		 * Создаётся в main.ts при наличии FINANCE_RAW_DIR / CONTENT_ROOT в окружении.
		 */
		readonly financeLedger?: Ledger,
		/**
		 * financeGoalsDir — каталог для страниц finance-goal (wiki/finance/goals/).
		 * Опционально: если не задан, create_goal не пишет страницы (только логирует).
		 */
		readonly financeGoalsDir?: string,
		/**
		 * financeStateDir — каталог мутабельного состояния финансового проактива
		 * (.finance-state/ в приватном репо). Нужен для pending-cash-survey и
		 * last-input watermark. Опционально: если не задан, оба механизма пропускаются
		 * (graceful). Создаётся в main.ts через resolveFinanceStateDir().
		 */
		readonly financeStateDir?: string,
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
 * message, edited_message и callback_query (нажатие инлайн-кнопки, [ADR-0023]).
 */
export function extractJob(update: Record<string, unknown>, ownerChatId: number): Job | null {
	// callback_query (нажатие инлайн-кнопки) — отдельная ветка ([ADR-0023]).
	if (isRecord(update.callback_query)) {
		return extractCallbackJob(update.callback_query, ownerChatId);
	}

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

/**
 * Вытащить callback-Job из callback_query ([ADR-0023]). Слой №2 (allow-list)
 * проверяем по `from.id` — это ИНИЦИАТОР нажатия, он есть всегда (в отличие от
 * `message`, который Telegram опускает у старых сообщений). В приватном чате
 * from.id == chat.id == owner, поэтому это корректный single-user-гейт.
 */
function extractCallbackJob(
	callbackQuery: Record<string, unknown>,
	ownerChatId: number,
): Job | null {
	const from = isRecord(callbackQuery.from) ? callbackQuery.from : {};
	const fromId = from.id;
	if (typeof fromId !== 'number' || fromId !== ownerChatId) {
		log.warn({ fromId }, 'security.foreign_callback_dropped');
		return null;
	}

	const id = callbackQuery.id;
	if (typeof id !== 'string' || !id) return null;
	const data = typeof callbackQuery.data === 'string' ? callbackQuery.data : '';

	// chatId для ответа берём из message.chat.id; если message опущен — отвечаем владельцу.
	const message = isRecord(callbackQuery.message) ? callbackQuery.message : null;
	const chat = message && isRecord(message.chat) ? message.chat : null;
	const chatId = chat && typeof chat.id === 'number' ? chat.id : ownerChatId;
	const messageId = message && typeof message.message_id === 'number' ? message.message_id : undefined;

	return { chatId, text: data, callback: { id, data, messageId } };
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
	// Нажатие инлайн-кнопки ([ADR-0023]) — отдельная ветка ДО текстовой обработки.
	if (job.callback) {
		await handleCallbackQuery(state, job, job.callback);
		return;
	}

	// Команда /reset — забыть сессию.
	if (job.text.trim() === '/reset') {
		state.store.resetSession(job.chatId);
		await state.telegram.sendMessage(job.chatId, 'Контекст диалога сброшен.');
		return;
	}

	// Команды локальных сессий Claude Code ([ADR-0017]): /sessions, /session, /resume.
	// Доступны ТОЛЬКО при сконфигурированной фиче (SESSIONS_ENABLED=1 + непустой allowlist).
	// Своя обработка (свой маскер на отдачу/инъекцию) — поэтому ДО общего sanitize вики-хода.
	if (state.sessions?.enabled && isSessionCommand(job.text)) {
		await handleSessionCommand(state, job);
		return;
	}

	// §2 + ADR-0015: маскируем входящий текст fail-closed ДО движка (он уходит в облако и
	// может попасть в файлы вики). Сбой маскера → ход отменяется (лучше потерять ход, чем
	// слить секрет). Для обычного текста sanitize — тождество (7.1 не ломается).
	let safeText: string;
	try {
		safeText = failClosedSanitize(job.text);
	} catch (exc) {
		if (exc instanceof SanitizerError) {
			log.warn({ chatId: job.chatId, error: String(exc) }, 'sanitizer.blocked');
			await state.telegram.sendMessage(
				job.chatId,
				'Не обработал: не удалось безопасно замаскировать данные. Убери секреты и попробуй снова.',
			);
			return;
		}
		throw exc;
	}

	// «печатает…» сразу — маскирует латентность движка.
	await state.telegram.sendChatAction(job.chatId, 'typing');

	// single-flight на chat_id: возвращаем результат, отправку делаем ВНЕ lock'а.
	// Сообщение владельца идёт движку ЧИСТЫМ user-турном; персона/роутинг — в системном
	// промпте моста (ADR-0016), а не в тексте.
	const result = await state.chatLock(job.chatId).run<EngineResult | null>(async () => {
		const sessionId = state.store.getSession(job.chatId);
		let res: EngineResult;
		try {
			res = await runEngineWithRetry(state.engine, safeText, sessionId);
		} catch (exc) {
			// Сессия резюма исчезла (claude: "No conversation found with session ID"): мост
			// запомнил session_id, который не персистнулся на диск. Сбрасываем привязку
			// chat→session и повторяем ОДИН раз свежим ходом — состояние второго мозга живёт
			// в вики (raw/ + wiki/), а не в сессии чата, поэтому потеря контекста безопасна.
			if (sessionId && exc instanceof EngineError && /no conversation found/i.test(String(exc))) {
				log.warn(
					{ chatId: job.chatId, sessionId, error: String(exc) },
					'engine.session_lost_retry_fresh',
				);
				state.store.resetSession(job.chatId);
				try {
					res = await runEngineWithRetry(state.engine, safeText, null);
				} catch (exc2) {
					if (exc2 instanceof EngineError) {
						log.warn({ chatId: job.chatId, auth: exc2.auth, error: String(exc2) }, 'engine.failed');
						await state.telegram.sendMessage(job.chatId, engineFailureText(exc2));
						return null;
					}
					throw exc2;
				}
			} else if (exc instanceof EngineError) {
				log.warn({ chatId: job.chatId, auth: exc.auth, error: String(exc) }, 'engine.failed');
				await state.telegram.sendMessage(job.chatId, engineFailureText(exc));
				return null;
			} else {
				throw exc;
			}
		}
		if (res.sessionId) state.store.upsertSession(job.chatId, res.sessionId);

		// ADR-0024 (finance-intent): если движок эмитил finance-intent блок —
		// детерминированно диспетчеризуем в чистые функции (record/query/goal).
		// Readback формируется детерминированно (без LLM). При ошибке диспетчера
		// — логируем и пропускаем (ответ движка отдаётся как есть, не ронять ход).
		if (state.financeLedger) {
			const intent = extractFinanceIntent(res.answer);
			if (intent) {
				try {
					const dispatchResult = await dispatchFinanceIntent(intent, {
						ledger: state.financeLedger,
						goalsDir: state.financeGoalsDir,
						// financeStateDir — для pending-cash-survey и idle-nudge watermark (блокер #8).
						// Если не задан — оба механизма пропускаются gracefully.
						financeStateDir: state.financeStateDir,
					});
					// Детерминированный readback заменяет ответ движка (или дополняет его).
					// Используем readback как основной текст: он содержит актуальные балансы.
					const readback = formatReadback(dispatchResult);
					// Сохраняем session_id из оригинального ответа; заменяем только answer.
					res = { ...res, answer: readback };
					log.info(
						{ intentType: intent.type, readbackChars: readback.length },
						'finance-intent.dispatched',
					);
				} catch (err) {
					// Ошибка диспетчера — безопасно: движок уже ответил, отдаём как есть.
					log.warn({ err: String(err), intentType: intent.type }, 'finance-intent.dispatch_failed');
				}
			}
		}

		// ADR-0015 R1: движок мог дописать вику (capture) → коммитит ДОВЕРЕННЫЙ мост (НЕ
		// LLM-инструмент), если дерево «грязное». Query-ход дерево не меняет → коммита нет.
		// Сериализовано chatLock'ом (single-user → глобально). Сбой коммита не рушит ответ.
		if (state.wikiRepoPath) {
			await commitIfDirty(state.wikiRepoPath, 'note: capture via telegram');
		}

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

// --------------------------------------------------------------------------- //
// Нажатие инлайн-кнопки (callback_query, [ADR-0023])                          //
// --------------------------------------------------------------------------- //

/**
 * Обработать нажатие инлайн-кнопки ([ADR-0023]).
 *
 * Диспетчеризация по prefixу callback_data:
 *   - Финансовые кнопки (callback_data начинается с CALLBACK_PREFIX = "fin:"):
 *     → dispatchFinanceCallback (если financeLedger задан в state).
 *     → answerCallbackQuery + лог если ledger не настроен.
 *   - Всё остальное: best-effort answerCallbackQuery + лог (базовое поведение).
 *
 * Инвариант: callback_data никогда не уходит в облако (в отличие от текстового хода),
 * поэтому failClosedSanitize здесь не нужен. Если в будущем callback_data будет
 * передаваться движку — маскировать ОБЯЗАТЕЛЬНО ([ADR-0015]).
 */
async function handleCallbackQuery(
	state: BridgeState,
	job: Job,
	cb: CallbackInfo,
): Promise<void> {
	log.info({ chatId: job.chatId, data: cb.data, messageId: cb.messageId }, 'callback.received');

	// Финансовые кнопки ([ADR-0024]): кнопочные флоу кредит-напоминаний.
	// dispatchFinanceCallback сам гасит «часики» (answerCallbackQuery) и проверяет owner-гейт.
	if (cb.data.startsWith(CALLBACK_PREFIX) && state.financeLedger) {
		await dispatchFinanceCallback(
			{
				chatId: job.chatId,
				fromId: job.chatId, // В приватном чате from.id == chat.id == owner (ADR-0009).
				callbackQueryId: cb.id,
				data: cb.data,
			},
			{
				ownerChatId: state.settings.ownerChatId,
				telegram: state.telegram,
				ledger: state.financeLedger,
			},
		);
		return;
	}

	// Остальные (не-финансовые) callback'и или финансовые при отключённом ledger:
	// гасим «часики» best-effort и логируем.
	await state.telegram.answerCallbackQuery(cb.id);
}

// --------------------------------------------------------------------------- //
// Команды локальных сессий Claude Code ([ADR-0017])                           //
// --------------------------------------------------------------------------- //

const SESSION_COMMANDS = new Set(['/sessions', '/session', '/resume']);

/** Первый токен сообщения (имя команды). */
function firstToken(text: string): string {
	return text.trim().split(/\s+/, 1)[0] ?? '';
}

/** Это одна из команд работы с сессиями? (роутинг в handleJob). */
export function isSessionCommand(text: string): boolean {
	return SESSION_COMMANDS.has(firstToken(text));
}

/**
 * Обработать /sessions | /session <id> | /resume <id> <сообщение>. Чтение —
 * локальное, без облака (маскируется sanitizeText на отдачу). Продолжение —
 * локальный движок в cwd проекта; инъекция маскируется failClosedSanitize до облака.
 */
async function handleSessionCommand(state: BridgeState, job: Job): Promise<void> {
	const cfg = state.sessions;
	if (!cfg) return;
	const text = job.text.trim();
	const cmd = firstToken(text);

	// /sessions [подстрока] — список (фильтр по firstPrompt/projectPath).
	if (cmd === '/sessions') {
		const query = text.slice(cmd.length).trim().toLowerCase();
		const all = listSessions(cfg);
		const filtered = query
			? all.filter((s) => `${s.firstPrompt} ${s.projectPath}`.toLowerCase().includes(query))
			: all;
		const shown = filtered.slice(0, cfg.listLimit);
		await state.telegram.sendMessage(
			job.chatId,
			formatSessionList(shown, filtered.length, cfg.listLimit),
		);
		return;
	}

	// /session <id> — карточка + хвост диалога (локальное чтение, без движка).
	if (cmd === '/session') {
		const id = firstToken(text.slice(cmd.length));
		if (!id) {
			await state.telegram.sendMessage(job.chatId, 'Использование: /session <id>. Список: /sessions');
			return;
		}
		const { meta, ambiguous } = findSession(cfg, id);
		if (!meta) {
			await state.telegram.sendMessage(job.chatId, formatAmbiguous(id, ambiguous));
			return;
		}
		const tail = readSessionTail(meta, cfg.tailMessages);
		await state.telegram.sendMessage(job.chatId, formatSessionCard(meta, tail));
		return;
	}

	// /resume <id> <сообщение> — продолжить сессию локальным движком в cwd проекта.
	const m = text.match(/^\/resume\s+(\S+)\s+([\s\S]+)$/);
	if (!m) {
		await state.telegram.sendMessage(
			job.chatId,
			'Использование: /resume <id> <сообщение>. Список: /sessions',
		);
		return;
	}
	const id = m[1] ?? '';
	const message = (m[2] ?? '').trim();
	const { meta, ambiguous } = findSession(cfg, id);
	if (!meta) {
		await state.telegram.sendMessage(job.chatId, formatAmbiguous(id, ambiguous));
		return;
	}
	if (!state.resumeEngineFor) {
		await state.telegram.sendMessage(
			job.chatId,
			'Продолжение сессий не сконфигурировано (нет resume-движка).',
		);
		return;
	}

	// Инъекцию маскируем fail-closed ДО облачного движка ([ADR-0015] §2): сбой → отмена хода.
	let safeMsg: string;
	try {
		safeMsg = failClosedSanitize(message);
	} catch (exc) {
		if (exc instanceof SanitizerError) {
			log.warn({ chatId: job.chatId, error: String(exc) }, 'resume.sanitizer_blocked');
			await state.telegram.sendMessage(
				job.chatId,
				'Не отправил: не смог безопасно замаскировать сообщение. Убери секреты и попробуй снова.',
			);
			return;
		}
		throw exc;
	}

	await state.telegram.sendChatAction(job.chatId, 'typing');
	// Сериализуем с реактивной полосой по chat_id (single-user → глобально): не плодим
	// параллельные claude-процессы. Движок строится под cwd проекта сессии (без персоны вики).
	const result = await state.chatLock(job.chatId).run<EngineResult | null>(async () => {
		const engine = state.resumeEngineFor!(meta.projectPath);
		try {
			return await runEngineWithRetry(engine, safeMsg, meta.sessionId);
		} catch (exc) {
			if (exc instanceof EngineError) {
				log.warn(
					{ chatId: job.chatId, sessionId: meta.sessionId, error: String(exc) },
					'resume.failed',
				);
				await state.telegram.sendMessage(
					job.chatId,
					'Не удалось продолжить сессию (движок недоступен или сессия не резюмируется).',
				);
				return null;
			}
			throw exc;
		}
	});
	if (!result) return;

	await state.telegram.sendMessage(job.chatId, result.answer);
	log.info(
		{ chatId: job.chatId, sessionId: meta.sessionId, answerChars: result.answer.length },
		'resume.done',
	);
}

/**
 * Текст владельцу при фатальном сбое движка. Auth-сбой (истёк токен CLI) → внятная
 * подсказка про релогин вместо пугающего «движок недоступен или превышен лимит»,
 * который маскировал реальную причину (диагностика 2026-06-26).
 */
function engineFailureText(exc: EngineError): string {
	if (exc.auth) {
		return (
			'Движок Claude не аутентифицирован — похоже, истёк токен CLI. ' +
			'Нужен релогин: запусти `claude` и выполни /login (или `claude setup-token` для headless). ' +
			'После этого повтори сообщение.'
		);
	}
	return (
		'Не удалось обработать сообщение (движок недоступен или превышен лимит). ' +
		'Попробуй ещё раз чуть позже.'
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
