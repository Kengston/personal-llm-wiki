/**
 * poller.test.ts — long-poll цикл ([ADR-0014]). Проверяем: owner-апдейт → очередь,
 * чужой чат дропается (allow-list в extractJob), offset стартует из store и
 * персистится (update_id+1), выход по AbortSignal.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { BridgeState } from './app.js';
import type { Settings } from './config.js';
import type { Engine } from './engine.js';
import { runPoller } from './poller.js';
import { SessionStore } from './store.js';
import type { TelegramClient } from './telegram.js';

const OWNER = 42;

const dummyEngine: Engine = {
	async run() {
		return { answer: '', sessionId: null, usage: null, isError: false };
	},
};

function makeSettings(over: Partial<Settings> = {}): Settings {
	return {
		botToken: 'token',
		ownerChatId: OWNER,
		mode: 'polling',
		webhookSecret: '',
		pollTimeoutSec: 1,
		dbPath: ':memory:',
		maxQueue: 10,
		workers: 1,
		port: 0,
		...over,
	};
}

const openStores: SessionStore[] = [];
function makeStore(): SessionStore {
	const s = new SessionStore(':memory:');
	openStores.push(s);
	return s;
}
afterEach(() => {
	for (const s of openStores.splice(0)) {
		try {
			s.close();
		} catch {
			/* already closed */
		}
	}
});

/** Mock Telegram: задаём только getUpdates, остальное — no-op. */
function fakeTelegram(getUpdates: TelegramClient['getUpdates']): TelegramClient {
	return {
		getUpdates,
		async deleteWebhook() {},
		async sendMessage() {},
		async sendPhoto() {},
		async sendDocument() {},
		async answerCallbackQuery() {},
		async sendChatAction() {},
		async getMe() {
			return {};
		},
		async aclose() {},
	};
}

describe('runPoller', () => {
	it('owner-апдейт → очередь; чужой чат дропается; offset персистится', async () => {
		const controller = new AbortController();
		let calls = 0;
		const telegram = fakeTelegram(async () => {
			calls++;
			if (calls === 1) {
				return [
					{ update_id: 100, message: { chat: { id: OWNER }, text: 'привет' } },
					{ update_id: 101, message: { chat: { id: 999 }, text: 'я чужой' } },
				];
			}
			controller.abort(); // второй вызов — останавливаем цикл
			return [];
		});
		const store = makeStore();
		const state = new BridgeState(makeSettings(), dummyEngine, store, telegram);

		await runPoller(state, controller.signal);

		expect(state.queue.size).toBe(1); // только owner-джоба
		expect(await state.queue.get()).toEqual({ chatId: OWNER, text: 'привет' });
		expect(store.getOffset()).toBe(102); // 101 + 1
	});

	it('стартует с сохранённого offset', async () => {
		const controller = new AbortController();
		let firstOffset: number | null = null;
		const telegram = fakeTelegram(async (offset) => {
			firstOffset = offset;
			controller.abort();
			return [];
		});
		const store = makeStore();
		store.setOffset(500);
		const state = new BridgeState(makeSettings(), dummyEngine, store, telegram);

		await runPoller(state, controller.signal);

		expect(firstOffset).toBe(500);
	});

	it('уже отменённый signal → getUpdates не вызывается', async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		const telegram = fakeTelegram(async () => {
			calls++;
			return [];
		});
		const state = new BridgeState(makeSettings(), dummyEngine, makeStore(), telegram);

		await runPoller(state, controller.signal);

		expect(calls).toBe(0);
	});
});
