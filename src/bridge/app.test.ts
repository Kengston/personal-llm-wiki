/**
 * Парность с bridge/app.py ([ADR-0012]). Безопасность вебхука (3 слоя),
 * extractJob, обработка job'а (engine→store→telegram, /reset, фейл движка),
 * backpressure, /health. Реальный SessionStore на ':memory:'.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { Settings } from './config.js';
import {
	BridgeState,
	buildApp,
	extractJob,
	handleJob,
	startWorkers,
	stopBridge,
} from './app.js';
import { type Engine, EngineError, type EngineResult } from './engine.js';
import { SessionStore } from './store.js';
import type { TelegramClient } from './telegram.js';

const SECRET = 'super-secret-nonce-AaBbCc';

class FakeEngine implements Engine {
	calls: { prompt: string; sessionId: string | null }[] = [];
	result: EngineResult = { answer: 'ответ движка', sessionId: 'sess-1', usage: null, isError: false };
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
	me: Record<string, unknown> = { username: 'second_brain_bot' };
	getMeError: Error | null = null;
	private waiters: (() => void)[] = [];

	async sendMessage(chatId: number, text: string): Promise<void> {
		this.sent.push({ chatId, text });
		this.waiters.splice(0).forEach((w) => w());
	}
	async sendChatAction(chatId: number, action = 'typing'): Promise<void> {
		this.actions.push({ chatId, action });
	}
	async getMe(): Promise<Record<string, unknown>> {
		if (this.getMeError) throw this.getMeError;
		return this.me;
	}
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
		webhookSecret: SECRET,
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
});

describe('handleJob', () => {
	it('прогон движка → upsert сессии → отправка ответа', async () => {
		const { state, engine, telegram } = makeState();
		await handleJob(state, { chatId: 42, text: 'привет' });
		expect(telegram.actions).toContainEqual({ chatId: 42, action: 'typing' });
		expect(telegram.sent.at(-1)).toEqual({ chatId: 42, text: 'ответ движка' });
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
