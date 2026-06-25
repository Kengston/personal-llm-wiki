/**
 * Парность с bridge/app.py ([ADR-0012]). Безопасность вебхука (3 слоя),
 * extractJob, обработка job'а (engine→store→telegram, /reset, фейл движка),
 * backpressure, /health. Реальный SessionStore на ':memory:'.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Ledger } from '../ingest/finance/ledger.js';
import type { Settings } from './config.js';
import { BridgeState, buildApp, extractJob, handleJob, startWorkers, stopBridge } from './app.js';
import { type Engine, EngineError, type EngineResult } from './engine.js';
import { SessionStore } from './store.js';
import type { TelegramClient } from './telegram.js';

const SECRET = 'super-secret-nonce-AaBbCc';

class FakeEngine implements Engine {
	calls: { prompt: string; sessionId: string | null }[] = [];
	result: EngineResult = {
		answer: 'ответ движка',
		sessionId: 'sess-1',
		usage: null,
		isError: false,
	};
	error: Error | null = null;

	async run(prompt: string, sessionId: string | null = null): Promise<EngineResult> {
		this.calls.push({ prompt, sessionId });
		if (this.error) throw this.error;
		return this.result;
	}
}

class FakeTelegram implements TelegramClient {
	sent: { chatId: number; text: string }[] = [];
	actions: { chatId: number; action: string }[] = [];
	photos: { chatId: number }[] = [];
	documents: { chatId: number }[] = [];
	answeredCallbacks: string[] = [];
	me: Record<string, unknown> = { username: 'second_brain_bot' };
	getMeError: Error | null = null;
	private waiters: (() => void)[] = [];

	async sendMessage(chatId: number, text: string): Promise<void> {
		this.sent.push({ chatId, text });
		this.waiters.splice(0).forEach((w) => w());
	}
	async sendPhoto(chatId: number): Promise<void> {
		this.photos.push({ chatId });
	}
	async sendDocument(chatId: number): Promise<void> {
		this.documents.push({ chatId });
	}
	async answerCallbackQuery(callbackQueryId: string): Promise<void> {
		this.answeredCallbacks.push(callbackQueryId);
	}
	async sendChatAction(chatId: number, action = 'typing'): Promise<void> {
		this.actions.push({ chatId, action });
	}
	async getMe(): Promise<Record<string, unknown>> {
		if (this.getMeError) throw this.getMeError;
		return this.me;
	}
	async getUpdates(): Promise<Array<Record<string, unknown>>> {
		return [];
	}
	async deleteWebhook(): Promise<void> {}
	async aclose(): Promise<void> {}
	waitForMessage(): Promise<void> {
		return new Promise((r) => this.waiters.push(r));
	}
}

const openStores: SessionStore[] = [];

function makeState(overrides: Partial<Settings> = {}): {
	state: BridgeState;
	engine: FakeEngine;
	telegram: FakeTelegram;
} {
	const settings: Settings = {
		botToken: 'token',
		ownerChatId: 42,
		mode: 'webhook',
		webhookSecret: SECRET,
		pollTimeoutSec: 50,
		dbPath: ':memory:',
		maxQueue: 2,
		workers: 1,
		port: 0,
		...overrides,
	};
	const engine = new FakeEngine();
	const telegram = new FakeTelegram();
	const store = new SessionStore(settings.dbPath);
	openStores.push(store);
	const state = new BridgeState(settings, engine, store, telegram);
	return { state, engine, telegram };
}

afterEach(() => {
	for (const s of openStores.splice(0)) {
		try {
			s.close();
		} catch {
			// уже закрыт через stopBridge
		}
	}
});

const ownerUpdate = { message: { chat: { id: 42 }, text: 'привет' } };

describe('webhook — безопасность (3 слоя)', () => {
	it('верный nonce+header+owner → 200, job в очереди', async () => {
		const { state } = makeState();
		const app = buildApp(state);
		const res = await app.inject({
			method: 'POST',
			url: `/telegram/webhook/${SECRET}`,
			headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
			payload: ownerUpdate,
		});
		expect(res.statusCode).toBe(200);
		expect(state.queue.size).toBe(1);
	});

	it('неверный nonce пути → 404', async () => {
		const { state } = makeState();
		const app = buildApp(state);
		const res = await app.inject({
			method: 'POST',
			url: `/telegram/webhook/wrong-nonce`,
			headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
			payload: ownerUpdate,
		});
		expect(res.statusCode).toBe(404);
		expect(state.queue.size).toBe(0);
	});

	it('отсутствующий/неверный secret-token header → 404', async () => {
		const { state } = makeState();
		const app = buildApp(state);
		const missing = await app.inject({
			method: 'POST',
			url: `/telegram/webhook/${SECRET}`,
			headers: { 'content-type': 'application/json' },
			payload: ownerUpdate,
		});
		expect(missing.statusCode).toBe(404);
		const wrong = await app.inject({
			method: 'POST',
			url: `/telegram/webhook/${SECRET}`,
			headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'nope' },
			payload: ownerUpdate,
		});
		expect(wrong.statusCode).toBe(404);
	});

	it('чужой chat_id → 200, но job НЕ в очереди (allow-list owner)', async () => {
		const { state } = makeState();
		const app = buildApp(state);
		const res = await app.inject({
			method: 'POST',
			url: `/telegram/webhook/${SECRET}`,
			headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
			payload: { message: { chat: { id: 999 }, text: 'я чужой' } },
		});
		expect(res.statusCode).toBe(200);
		expect(state.queue.size).toBe(0);
	});

	it('кривой JSON → 200 (без ретраев), job НЕ в очереди', async () => {
		const { state } = makeState();
		const app = buildApp(state);
		const res = await app.inject({
			method: 'POST',
			url: `/telegram/webhook/${SECRET}`,
			headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
			payload: '{ битый',
		});
		expect(res.statusCode).toBe(200);
		expect(state.queue.size).toBe(0);
	});

	it('переполнение очереди → 200 + уведомление', async () => {
		const { state, telegram } = makeState({ maxQueue: 1 });
		const app = buildApp(state);
		const inject = () =>
			app.inject({
				method: 'POST',
				url: `/telegram/webhook/${SECRET}`,
				headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
				payload: ownerUpdate,
			});
		await inject(); // в очередь (size=1)
		const overflow = await inject(); // переполнение
		expect(overflow.statusCode).toBe(200);
		expect(telegram.sent.some((m) => m.text.includes('перегружен'))).toBe(true);
	});

	it('POST без Content-Type + неверный nonce → 404 (security в хендлере, не 415)', async () => {
		const { state } = makeState();
		const app = buildApp(state);
		const res = await app.inject({
			method: 'POST',
			url: `/telegram/webhook/wrong-nonce`,
			headers: { 'x-telegram-bot-api-secret-token': SECRET },
			payload: 'тело без content-type',
		});
		expect(res.statusCode).toBe(404);
	});
});

describe('extractJob', () => {
	it('owner текст → Job', () => {
		expect(extractJob(ownerUpdate, 42)).toEqual({ chatId: 42, text: 'привет' });
	});
	it('edited_message тоже поддержан', () => {
		expect(extractJob({ edited_message: { chat: { id: 42 }, text: ' правка ' } }, 42)).toEqual({
			chatId: 42,
			text: 'правка',
		});
	});
	it('чужой чат → null', () => {
		expect(extractJob({ message: { chat: { id: 7 }, text: 'hi' } }, 42)).toBeNull();
	});
	it('не текст / пусто → null', () => {
		expect(extractJob({ message: { chat: { id: 42 }, photo: [] } }, 42)).toBeNull();
		expect(extractJob({ message: { chat: { id: 42 }, text: '   ' } }, 42)).toBeNull();
	});

	it('callback_query владельца → Job с callback-инфо', () => {
		const update = {
			callback_query: {
				id: 'cbq-1',
				from: { id: 42 },
				data: 'paid:7',
				message: { message_id: 100, chat: { id: 42 } },
			},
		};
		expect(extractJob(update, 42)).toEqual({
			chatId: 42,
			text: 'paid:7',
			callback: { id: 'cbq-1', data: 'paid:7', messageId: 100 },
		});
	});

	it('callback_query чужого from.id → null (allow-list по инициатору)', () => {
		const update = {
			callback_query: { id: 'x', from: { id: 7 }, data: 'd', message: { chat: { id: 7 } } },
		};
		expect(extractJob(update, 42)).toBeNull();
	});

	it('callback_query без message (старое сообщение) → chatId = владелец', () => {
		const update = { callback_query: { id: 'cbq-2', from: { id: 42 }, data: 'period' } };
		expect(extractJob(update, 42)).toEqual({
			chatId: 42,
			text: 'period',
			callback: { id: 'cbq-2', data: 'period', messageId: undefined },
		});
	});
});

describe('handleJob', () => {
	it('прогон движка → upsert сессии → отправка ответа', async () => {
		const { state, engine, telegram } = makeState();
		await handleJob(state, { chatId: 42, text: 'привет' });
		expect(telegram.actions).toContainEqual({ chatId: 42, action: 'typing' });
		expect(telegram.sent.at(-1)).toEqual({ chatId: 42, text: 'ответ движка' });
		// Движок получает ЧИСТЫЙ санитизированный текст — персона/роутинг в системном
		// промпте моста, не в user-турне (ADR-0016); sanitize — тождество для 'привет'.
		expect(engine.calls[0]).toEqual({ prompt: 'привет', sessionId: null });
		expect(state.store.getSession(42)).toBe('sess-1'); // персистнули для resume
	});

	it('второй ход идёт через resume по сохранённой сессии', async () => {
		const { state, engine } = makeState();
		state.store.upsertSession(42, 'prev-sess');
		await handleJob(state, { chatId: 42, text: 'ещё' });
		expect(engine.calls[0]?.sessionId).toBe('prev-sess');
	});

	it('/reset забывает сессию', async () => {
		const { state, telegram } = makeState();
		state.store.upsertSession(42, 'old');
		await handleJob(state, { chatId: 42, text: '/reset' });
		expect(state.store.getSession(42)).toBeNull();
		expect(telegram.sent.at(-1)?.text).toContain('сброшен');
	});

	it('фатальная ошибка движка → дружелюбный ответ, без падения', async () => {
		const { state, engine, telegram } = makeState();
		engine.error = new EngineError('boom', { transient: false });
		await handleJob(state, { chatId: 42, text: 'hi' });
		expect(telegram.sent.at(-1)?.text).toContain('Не удалось обработать');
	});

	it('секрет в сообщении маскируется ДО движка (§2/ADR-0015)', async () => {
		const { state, engine } = makeState();
		const token = 'ghp_' + 'A'.repeat(36);
		await handleJob(state, { chatId: 42, text: `мой токен ${token}` });
		const sent = engine.calls[0]?.prompt ?? '';
		expect(sent).not.toContain(token);
		expect(sent).toContain('[REDACTED:github_token]');
	});

	it('callback-джоба → answerCallbackQuery, движок НЕ зовётся ([ADR-0023])', async () => {
		const { state, engine, telegram } = makeState();
		await handleJob(state, {
			chatId: 42,
			text: 'paid:7',
			callback: { id: 'cbq-1', data: 'paid:7', messageId: 100 },
		});
		expect(telegram.answeredCallbacks).toEqual(['cbq-1']);
		// Транспорт-фундамент: не-финансовые callback'и (нет CALLBACK_PREFIX=fin:) → движок не дёргаем.
		expect(engine.calls).toHaveLength(0);
		expect(telegram.sent).toHaveLength(0);
	});

	it('финанс-callback (fin:paid:) с financeLedger → диспетчеризуется, движок НЕ зовётся', async () => {
		// Создаём tmp-каталог для леджера.
		const ledgerDir = mkdtempSync(join(tmpdir(), 'app-fcb-test-'));
		try {
			const financeLedger = new Ledger({
				financeDir: ledgerDir,
				publicRepoRoot: join(tmpdir(), 'fake-public-for-fcb-test'),
			});

			const settings: Settings = {
				botToken: 'token',
				ownerChatId: 42,
				mode: 'webhook',
				webhookSecret: SECRET,
				pollTimeoutSec: 50,
				dbPath: ':memory:',
				maxQueue: 2,
				workers: 1,
				port: 0,
			};
			const engine = new FakeEngine();
			const tg = new FakeTelegram();
			const store = new SessionStore(settings.dbPath);
			openStores.push(store);

			// BridgeState с financeLedger — финансовый диспетчер активен.
			const state = new BridgeState(settings, engine, store, tg, undefined, undefined, undefined, financeLedger);

			// Нажимаем [Оплачено] по несуществующему кредиту:
			// диспетчер запустится, не найдёт кредит, отправит сообщение об ошибке.
			await handleJob(state, {
				chatId: 42,
				text: 'fin:paid:nonexistent-credit',
				callback: { id: 'cbq-fin-1', data: 'fin:paid:nonexistent-credit', messageId: 200 },
			});

			// Движок НЕ вызывался (callback_query → не текстовый ход).
			expect(engine.calls).toHaveLength(0);
			// answerCallbackQuery вызван диспетчером.
			expect(tg.answeredCallbacks).toContain('cbq-fin-1');
			// Telegram получил сообщение от диспетчера (ошибка «не найден» или readback).
			expect(tg.sent.length).toBeGreaterThan(0);
		} finally {
			rmSync(ledgerDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// handleJob — реактивный финансовый шов (ADR-0024)
// ---------------------------------------------------------------------------

describe('handleJob — finance-intent диспетчер (ADR-0024)', () => {
	/**
	 * Создаёт BridgeState с инъектированным Ledger в tmp-каталоге.
	 * Engine мокируется и возвращает finance-intent блок в ответе.
	 * Проверяем что readback (детерминированный) заменил answer движка.
	 */
	it('движок эмитит finance-intent → readback заменяет answer, снапшот записан', async () => {
		// Создаём tmp-каталог для леджера (path-guard с фейковым публичным репо).
		const ledgerDir = mkdtempSync(join(tmpdir(), 'app-finance-test-'));
		try {
			const financeLedger = new Ledger({
				financeDir: ledgerDir,
				// Заведомо другой путь → path-guard позволит запись в ledgerDir.
				publicRepoRoot: join(tmpdir(), 'fake-public-for-app-test'),
			});

			// Engine возвращает ответ с finance-intent блоком.
			const fakeFinanceAnswer =
				'Записал баланс!\n' +
				'```finance-intent\n' +
				'{"type":"record_balance","account":{"source":"manual","name":"Fake App Account","currency":"RUB","kind":"checking"},"balance":99000}\n' +
				'```\n' +
				'Готово!';

			const settings: Settings = {
				botToken: 'token',
				ownerChatId: 42,
				mode: 'webhook',
				webhookSecret: SECRET,
				pollTimeoutSec: 50,
				dbPath: ':memory:',
				maxQueue: 2,
				workers: 1,
				port: 0,
			};
			const engine: Engine = {
				async run(_prompt: string, _sessionId: string | null): Promise<EngineResult> {
					return { answer: fakeFinanceAnswer, sessionId: 'sess-finance', usage: null, isError: false };
				},
			};
			const telegram = new FakeTelegram();
			const store = new SessionStore(settings.dbPath);
			openStores.push(store);

			// BridgeState с financeLedger — теперь шов активен.
			const state = new BridgeState(settings, engine, store, telegram, undefined, undefined, undefined, financeLedger);

			await handleJob(state, { chatId: 42, text: 'баланс сбера 99000 рублей' });

			// Снапшот записан в леджер (шов реально отработал).
			const snapshots = financeLedger.readAll('snapshots');
			expect(snapshots).toHaveLength(1);
			expect(snapshots[0]!.balance).toBe(99000);
			expect(snapshots[0]!.currency).toBe('RUB');

			// Telegram получил readback (детерминированный), а НЕ сырой ответ движка.
			const lastSent = telegram.sent.at(-1);
			expect(lastSent?.text).not.toContain('```finance-intent');
			expect(lastSent?.text).toContain('99000 RUB');
			expect(lastSent?.text).toContain('Fake App Account');
		} finally {
			rmSync(ledgerDir, { recursive: true, force: true });
		}
	});

	it('financeLedger undefined → finance-intent блок НЕ диспетчеризуется (шов выключен)', async () => {
		// makeState() не передаёт financeLedger → шов отключён.
		const { state, engine, telegram } = makeState();
		// Двигку возвращаем finance-intent — но шов выключен, должен прийти сырой ответ.
		engine.result = {
			answer: '```finance-intent\n{"type":"record_balance","account":{"source":"manual","name":"X","currency":"RUB","kind":"checking"},"balance":1}\n```',
			sessionId: 'sess-x',
			usage: null,
			isError: false,
		};
		await handleJob(state, { chatId: 42, text: 'проверка' });
		// Сырой ответ передан без изменений (fenced-блок остался).
		const lastSent = telegram.sent.at(-1);
		expect(lastSent?.text).toContain('```finance-intent');
	});
});

// ---------------------------------------------------------------------------
// handleJob — регресс: финансовый реактивный слой не шумит без данных
// ---------------------------------------------------------------------------

describe('handleJob — регресс: финансы не шумят без finance-intent', () => {
	it('financeLedger задан, но ответ движка НЕ содержит finance-intent → answer проходит как есть', async () => {
		// Воспроизводит инвариант: наличие financeLedger в state не означает что каждый ответ
		// движка перезаписывается. Если extractFinanceIntent(answer)===null → res.answer не меняется.
		const ledgerDir = mkdtempSync(join(tmpdir(), 'app-no-intent-test-'));
		try {
			const financeLedger = new Ledger({
				financeDir: ledgerDir,
				publicRepoRoot: join(tmpdir(), 'fake-public-for-no-intent-test'),
			});

			const plainAnswer = 'Обычный ответ движка без финансового блока. Привет!';

			const settings: Settings = {
				botToken: 'token',
				ownerChatId: 42,
				mode: 'webhook',
				webhookSecret: SECRET,
				pollTimeoutSec: 50,
				dbPath: ':memory:',
				maxQueue: 2,
				workers: 1,
				port: 0,
			};
			const engine: Engine = {
				async run(_prompt, _sessionId) {
					return { answer: plainAnswer, sessionId: 'sess-plain', usage: null, isError: false };
				},
			};
			const telegram = new FakeTelegram();
			const store = new SessionStore(settings.dbPath);
			openStores.push(store);

			// BridgeState с financeLedger — шов активен, но ответ без finance-intent.
			const state = new BridgeState(settings, engine, store, telegram, undefined, undefined, undefined, financeLedger);

			await handleJob(state, { chatId: 42, text: 'просто поговорить' });

			// Ответ движка НЕ заменяется readback'ом (нет finance-intent).
			const lastSent = telegram.sent.at(-1);
			expect(lastSent?.text).toBe(plainAnswer);
		} finally {
			rmSync(ledgerDir, { recursive: true, force: true });
		}
	});

	it('нефинансовый callback_query (без fin: префикса) → answerCallbackQuery, движок НЕ зовётся', async () => {
		// Воспроизводит инвариант: не-финансовые callback'и (например кнопки sessions)
		// идут старым путём — answerCallbackQuery + лог, а не финанс-диспетчером.
		// Это защита от роутинга произвольных callback_data в финансовый обработчик.
		const { state, engine, telegram } = makeState();

		await handleJob(state, {
			chatId: 42,
			text: 'some:non:financial:callback',
			callback: { id: 'cbq-nonfin', data: 'some:non:financial:callback', messageId: 55 },
		});

		// Движок НЕ вызывался (callback → другая ветка).
		expect(engine.calls).toHaveLength(0);
		// answerCallbackQuery вызван best-effort (без financeLedger → общий путь).
		expect(telegram.answeredCallbacks).toContain('cbq-nonfin');
		// Никаких сообщений не отправлено (только погашение «часиков»).
		expect(telegram.sent).toHaveLength(0);
	});

	it('financeLedger ЗАДАН, но callback без fin: префикса → финанс-диспетчер НЕ зовётся (изоляция префикс-гейта)', async () => {
		// В отличие от теста выше (там financeLedger НЕ задан, и общий путь тривиален),
		// здесь финансы реально активны — Ledger инъектирован. Проверяем именно префикс-гейт
		// app.ts: callback_data.startsWith(CALLBACK_PREFIX='fin:'). Произвольный нефинансовый
		// callback ('some:non:financial') НЕ должен утечь в dispatchFinanceCallback.
		//
		// Сигнатура: dispatchFinanceCallback сам зовёт answerCallbackQuery И шлёт сообщение
		// (ошибка «кредит не найден» / readback). Поэтому если бы гейт протёк — мы увидели бы
		// tg.sent.length > 0. Старый же путь только гасит «часики» (answerCallbackQuery) без
		// единого sendMessage — на этом и ловим, что диспетчер не вызвался.
		const ledgerDir = mkdtempSync(join(tmpdir(), 'app-prefix-gate-test-'));
		try {
			const financeLedger = new Ledger({
				financeDir: ledgerDir,
				publicRepoRoot: join(tmpdir(), 'fake-public-for-prefix-gate-test'),
			});

			const settings: Settings = {
				botToken: 'token',
				ownerChatId: 42,
				mode: 'webhook',
				webhookSecret: SECRET,
				pollTimeoutSec: 50,
				dbPath: ':memory:',
				maxQueue: 2,
				workers: 1,
				port: 0,
			};
			const engine = new FakeEngine();
			const tg = new FakeTelegram();
			const store = new SessionStore(settings.dbPath);
			openStores.push(store);

			// BridgeState с financeLedger — финансовый диспетчер активен (восьмой аргумент).
			const state = new BridgeState(settings, engine, store, tg, undefined, undefined, undefined, financeLedger);

			// Нефинансовый callback (нет 'fin:' префикса) при активных финансах.
			await handleJob(state, {
				chatId: 42,
				text: 'some:non:financial',
				callback: { id: 'cbq-prefix-gate', data: 'some:non:financial', messageId: 77 },
			});

			// Движок НЕ зван (callback → не текстовый ход движка).
			expect(engine.calls).toHaveLength(0);
			// Старый путь: «часики» погашены через answerCallbackQuery.
			expect(tg.answeredCallbacks).toContain('cbq-prefix-gate');
			// Префикс-гейт сработал: финанс-диспетчер НЕ вызывался → ни одного sendMessage
			// (диспетчер всегда что-то шлёт; общий путь — нет). Это и изолирует именно гейт.
			expect(tg.sent).toHaveLength(0);
		} finally {
			rmSync(ledgerDir, { recursive: true, force: true });
		}
	});
});

describe('worker (end-to-end через очередь)', () => {
	it('воркер дренирует очередь и отправляет ответ', async () => {
		const { state, telegram } = makeState();
		startWorkers(state);
		const got = telegram.waitForMessage();
		state.queue.putNowait({ chatId: 42, text: 'привет' });
		await got;
		expect(telegram.sent.some((m) => m.text === 'ответ движка')).toBe(true);
		await stopBridge(state);
	});
});

describe('/health', () => {
	it('ok когда getMe проходит', async () => {
		const { state } = makeState();
		const app = buildApp(state);
		const res = await app.inject({ method: 'GET', url: '/health' });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.status).toBe('ok');
		expect(body.bot).toBe('second_brain_bot');
	});

	it('degraded когда getMe падает', async () => {
		const { state, telegram } = makeState();
		telegram.getMeError = new Error('unreachable');
		const app = buildApp(state);
		const res = await app.inject({ method: 'GET', url: '/health' });
		expect(res.statusCode).toBe(200);
		expect(res.json().status).toBe('degraded');
	});
});
