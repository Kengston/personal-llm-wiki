/**
 * finance-callbacks.test.ts — тесты диспетчера кнопочных флоу кредит-напоминаний.
 *
 * Проверяем:
 *   1. Парсинг callback_data (CB_PAID/CB_SNOOZE/CB_DETAIL).
 *   2. [Оплачено] — пишет платёж + читаемый readback.
 *   3. [Отложить] — создаёт oneoff (finance-state markFired).
 *   4. owner-гейт режектит чужой from.id.
 *   5. answerCallbackQuery вызван (мок TelegramClient, проверка payload).
 *   6. [Подробнее] — отправляет текст/PNG.
 *
 * Инварианты:
 *   - Только синтетические/фейковые данные.
 *   - Мок TelegramClient — не дёргаем реальное API.
 *   - Temp-dir для ledger + finance-state.
 *   - Нет живой сети.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Ledger } from '../ingest/finance/ledger.js';
import type { CreditRecord } from '../ingest/finance/types.js';
import type { TelegramClient } from './telegram.js';
import {
	CALLBACK_PREFIX,
	CB_PAID,
	CB_SNOOZE,
	CB_DETAIL,
	buildCreditReminderKeyboard,
	dispatchFinanceCallback,
	formatCreditPaymentReadback,
	formatSnoozeReadback,
	type CallbackJob,
	type FinanceCallbackDeps,
} from './finance-callbacks.js';
import { markFired, readSnoozeUntil, wasFired } from '../scheduler/finance-state.js';
import type { ChartSpec } from '../ingest/finance/chart.js';

// ---------------------------------------------------------------------------
// Синтетические данные для тестов
// ---------------------------------------------------------------------------

/** Синтетический кредит для тестов. */
const SYNTHETIC_CREDIT: CreditRecord = {
	id: 'cb-test-credit-001',
	source: 'manual',
	principal: 120_000,
	currency: 'RUB',
	rate_pct: 12, // 12% годовых = 1% в месяц
	balance: 60_000,
	balance_ts: '2026-01-01T00:00:00Z',
	manual: true,
	monthly_payment: 3_000,
	next_payment_date: '2026-07-01T00:00:00Z',
	type: 'annuity',
};

// ---------------------------------------------------------------------------
// Мок TelegramClient
// ---------------------------------------------------------------------------

/** Мок-клиент Telegram для тестов. */
class MockTelegramClient implements TelegramClient {
	sent: { chatId: number; text: string }[] = [];
	photos: { chatId: number; caption?: string }[] = [];
	documents: { chatId: number }[] = [];
	answeredCallbacks: string[] = [];
	actions: { chatId: number; action: string }[] = [];

	async sendMessage(chatId: number, text: string): Promise<void> {
		this.sent.push({ chatId, text });
	}
	async sendPhoto(chatId: number, _photo: unknown, opts?: { caption?: string }): Promise<void> {
		this.photos.push({ chatId, caption: opts?.caption });
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
		return { username: 'test_bot' };
	}
	async getUpdates(): Promise<Array<Record<string, unknown>>> {
		return [];
	}
	async deleteWebhook(): Promise<void> {}
	async aclose(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Фикстуры
// ---------------------------------------------------------------------------

const OWNER_ID = 42;
const STRANGER_ID = 999;
const fixedNow = new Date('2026-06-23T10:00:00Z');
const nowFn = () => fixedNow;

let ledgerDir: string;
let publicFakeDir: string;
let stateDirPath: string;
let ledger: Ledger;
let telegram: MockTelegramClient;

/** Мок рендерера PNG — возвращает фейковый Buffer без реального resvg. */
function mockRenderPng(_spec: ChartSpec): Buffer {
	return Buffer.from('fake-png-data');
}

beforeEach(() => {
	ledgerDir = mkdtempSync(join(tmpdir(), 'fcb-ledger-'));
	publicFakeDir = mkdtempSync(join(tmpdir(), 'fcb-public-'));
	stateDirPath = mkdtempSync(join(tmpdir(), 'fcb-state-'));
	ledger = new Ledger({ financeDir: ledgerDir, publicRepoRoot: publicFakeDir });
	telegram = new MockTelegramClient();
});

afterEach(() => {
	rmSync(ledgerDir, { recursive: true, force: true });
	rmSync(publicFakeDir, { recursive: true, force: true });
	rmSync(stateDirPath, { recursive: true, force: true });
});

/** Создать базовый CallbackJob. */
function makeJob(data: string, fromId = OWNER_ID): CallbackJob {
	return {
		chatId: OWNER_ID,
		fromId,
		callbackQueryId: `cbq-${Date.now()}`,
		data,
	};
}

/** Создать базовые deps с инъекцией. */
function makeDeps(overrides: Partial<FinanceCallbackDeps> = {}): FinanceCallbackDeps {
	return {
		ownerChatId: OWNER_ID,
		telegram,
		ledger,
		stateDir: stateDirPath,
		nowFn,
		renderPng: mockRenderPng,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Тесты: buildCreditReminderKeyboard
// ---------------------------------------------------------------------------

describe('buildCreditReminderKeyboard', () => {
	it('строит клавиатуру с 3 кнопками в 1 ряду', () => {
		const kb = buildCreditReminderKeyboard('cb-test-credit-001');
		expect(kb.inline_keyboard).toHaveLength(1);
		expect(kb.inline_keyboard[0]).toHaveLength(3);
	});

	it('callback_data для каждой кнопки ≤ 64 байт', () => {
		const creditId = 'cb-test-credit-001';
		const kb = buildCreditReminderKeyboard(creditId);
		const row = kb.inline_keyboard[0]!;

		for (const btn of row) {
			const cbData = btn.callback_data ?? '';
			const bytes = Buffer.byteLength(cbData, 'utf8');
			expect(bytes).toBeLessThanOrEqual(64);
		}
	});

	it('кнопки содержат правильные префиксы', () => {
		const kb = buildCreditReminderKeyboard('cb-test-credit-001');
		const row = kb.inline_keyboard[0]!;

		const datas = row.map((b) => b.callback_data ?? '');
		expect(datas.some((d) => d.startsWith(CB_PAID))).toBe(true);
		expect(datas.some((d) => d.startsWith(CB_SNOOZE))).toBe(true);
		expect(datas.some((d) => d.startsWith(CB_DETAIL))).toBe(true);
	});

	it('все callback_data начинаются с CALLBACK_PREFIX (fin:)', () => {
		const kb = buildCreditReminderKeyboard('cb-test-credit-001');
		const row = kb.inline_keyboard[0]!;
		for (const btn of row) {
			expect(btn.callback_data?.startsWith(CALLBACK_PREFIX)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// Тесты: owner-гейт
// ---------------------------------------------------------------------------

describe('dispatchFinanceCallback — owner-гейт', () => {
	it('чужой from.id → answerCallbackQuery вызван, платёж НЕ записан', async () => {
		ledger.append('credits', SYNTHETIC_CREDIT);
		const job = makeJob(`${CB_PAID}cb-test-credit-001`, STRANGER_ID);

		await dispatchFinanceCallback(job, makeDeps());

		// answerCallbackQuery должен быть вызван (гасим часики для чужого тоже).
		expect(telegram.answeredCallbacks).toHaveLength(1);
		// Сообщение владельцу НЕ отправлено (тихий дроп).
		expect(telegram.sent).toHaveLength(0);
		// Транзакция НЕ записана.
		expect(ledger.readAll('transactions')).toHaveLength(0);
	});

	it('верный from.id = owner → обрабатывается', async () => {
		ledger.append('credits', SYNTHETIC_CREDIT);
		const job = makeJob(`${CB_PAID}cb-test-credit-001`, OWNER_ID);

		await dispatchFinanceCallback(job, makeDeps());

		// Владельцу отправлен readback.
		expect(telegram.sent.length + telegram.photos.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Тесты: answerCallbackQuery
// ---------------------------------------------------------------------------

describe('dispatchFinanceCallback — answerCallbackQuery', () => {
	it('[Оплачено] — answerCallbackQuery вызван с правильным id', async () => {
		ledger.append('credits', SYNTHETIC_CREDIT);
		const job = makeJob(`${CB_PAID}cb-test-credit-001`);
		const cbqId = job.callbackQueryId;

		await dispatchFinanceCallback(job, makeDeps());

		expect(telegram.answeredCallbacks).toContain(cbqId);
	});

	it('[Отложить] — answerCallbackQuery вызван', async () => {
		const job = makeJob(`${CB_SNOOZE}cb-test-credit-001`);
		await dispatchFinanceCallback(job, makeDeps());
		expect(telegram.answeredCallbacks).toHaveLength(1);
	});

	it('[Подробнее] — answerCallbackQuery вызван', async () => {
		ledger.append('credits', SYNTHETIC_CREDIT);
		const job = makeJob(`${CB_DETAIL}cb-test-credit-001`);
		await dispatchFinanceCallback(job, makeDeps());
		expect(telegram.answeredCallbacks).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Тесты: [Оплачено] — fin:paid:
// ---------------------------------------------------------------------------

describe('dispatchFinanceCallback — [Оплачено] (fin:paid:)', () => {
	it('записывает платёж в леджер', async () => {
		ledger.append('credits', SYNTHETIC_CREDIT);
		const job = makeJob(`${CB_PAID}cb-test-credit-001`);

		await dispatchFinanceCallback(job, makeDeps());

		// Транзакция записана.
		const transactions = ledger.readAll('transactions');
		expect(transactions).toHaveLength(1);
		expect(transactions[0]!.category).toBe('credit_payment');
		expect(transactions[0]!.amount).toBe(3_000); // monthly_payment
	});

	it('readback содержит новый остаток и дату следующего платежа', async () => {
		ledger.append('credits', SYNTHETIC_CREDIT);
		const job = makeJob(`${CB_PAID}cb-test-credit-001`);

		await dispatchFinanceCallback(job, makeDeps());

		// Telegram получил readback.
		expect(telegram.sent).toHaveLength(1);
		const text = telegram.sent[0]!.text;

		// Новый остаток: 60000 - (3000 - 600) = 60000 - 2400 = 57600
		// (проценты = 60000 * 0.01 = 600, principal = 3000 - 600 = 2400)
		expect(text).toContain('57');
		expect(text).toContain('RUB');
		// Следующая дата: 2026-08-01 (сдвиг с 2026-07-01 на 1 мес).
		expect(text).toContain('2026-08-01');
	});

	it('readback адресован chatId владельца', async () => {
		ledger.append('credits', SYNTHETIC_CREDIT);
		const job = makeJob(`${CB_PAID}cb-test-credit-001`);

		await dispatchFinanceCallback(job, makeDeps());

		expect(telegram.sent[0]!.chatId).toBe(OWNER_ID);
	});

	it('кредит не найден → отправляет сообщение об ошибке (не падает)', async () => {
		// Леджер пуст, кредита нет.
		const job = makeJob(`${CB_PAID}nonexistent-credit`);

		await dispatchFinanceCallback(job, makeDeps());

		expect(telegram.sent).toHaveLength(1);
		expect(telegram.sent[0]!.text).toContain('❌');
	});
});

// ---------------------------------------------------------------------------
// Тесты: [Отложить] — fin:snooze:
// ---------------------------------------------------------------------------

describe('dispatchFinanceCallback — [Отложить] (fin:snooze:)', () => {
	it('отправляет подтверждение откладывания с датой завтра', async () => {
		const job = makeJob(`${CB_SNOOZE}cb-test-credit-001`);

		await dispatchFinanceCallback(job, makeDeps());

		expect(telegram.sent).toHaveLength(1);
		const text = telegram.sent[0]!.text;
		expect(text).toContain('cb-test-credit-001');
		// Дата завтра: 2026-06-24 (nowFn = 2026-06-23T10:00:00Z).
		expect(text).toContain('2026-06-24');
	});

	it('[Отложить] — W1: ставит snooze НА ЗАВТРА (начало следующего дня UTC), а НЕ unmarkFired', async () => {
		// Новый контракт W1: handleSnooze пишет snooze-запись в stateDir.
		// nowFn = 2026-06-23T10:00:00Z → snoozeUntil должен быть 2026-06-24T00:00:00.000Z
		const job = makeJob(`${CB_SNOOZE}cb-test-credit-001`);
		await dispatchFinanceCallback(job, makeDeps());

		// Readback отправлен.
		expect(telegram.sent).toHaveLength(1);
		expect(telegram.sent[0]!.text).toContain('2026-06-24');

		// Ключ snooze записан в stateDir с завтрашним днём.
		const snoozeUntil = readSnoozeUntil(stateDirPath, 'credit:cb-test-credit-001');
		expect(snoozeUntil).not.toBeNull();
		// Snooze должен быть начало следующего дня (2026-06-24T00:00:00.000Z).
		expect(snoozeUntil?.slice(0, 10)).toBe('2026-06-24');
	});

	it('[Отложить] — R1: fired-ключ кредита СНИМАЕТСЯ + snooze записан (двойная механика)', async () => {
		// R1 исправляет баг: handleSnooze теперь вызывает unmarkFiredByPrefix
		// В ДОБАВЛЕНИЕ к writeSnoozeUntil. Это оживляет unmarkFiredByPrefix и делает
		// readback правдивым — перевыход завтра гарантирован.
		//
		// Механика:
		//   СЕГОДНЯ  → snooze активен (now < snoozeUntil) → sweep молчит (анти-спам).
		//   ЗАВТРА   → snooze истёк, fired снят → sweep фаярит ровно раз → markFired снова.

		// Имитируем что sweep уже доставил напоминание и записал fired-ключ.
		const existingFireKey = 'credit:cb-test-credit-001:2026-07-01:lead';
		markFired(stateDirPath, existingFireKey, '2026-06-23T09:00:00Z');
		expect(wasFired(stateDirPath, existingFireKey)).toBe(true);

		// Пользователь нажимает [Отложить].
		const job = makeJob(`${CB_SNOOZE}cb-test-credit-001`);
		await dispatchFinanceCallback(job, makeDeps());

		// R1: Fired-ключ СНЯТ (unmarkFiredByPrefix по префиксу 'credit:cb-test-credit-001:').
		// Это позволяет перевыходу завтра после истечения snooze.
		expect(wasFired(stateDirPath, existingFireKey)).toBe(false);

		// Snooze-запись создана: sweep будет молчать СЕГОДНЯ за счёт snooze-гейта.
		expect(readSnoozeUntil(stateDirPath, 'credit:cb-test-credit-001')).not.toBeNull();
	});

	it('R1: последовательность markFired → handleSnooze → свип в окне snooze → кредит НЕ фаярит', async () => {
		// Интеграционный тест: закрывает дыру, которую отметил ревьюер.
		// Проверяет полную цепочку: markFired(lead/due) → handleSnooze → collectFinanceDue
		// в том же дне → кредит НЕ возвращается (snooze активен).
		//
		// Для этого теста нужно работать с collectFinanceDue напрямую.
		// Используем import из finance-sweep.
		const { collectFinanceDue } = await import('../scheduler/finance-sweep.js');
		const { writeSnoozeUntil: wsu } = await import('../scheduler/finance-state.js');

		// Фиксируем fired для кредита.
		const fireKeyLead = 'credit:cb-test-credit-001:2026-07-01:lead';
		markFired(stateDirPath, fireKeyLead, fixedNow.toISOString());

		// handleSnooze: пишем snooze до завтра + снимаем fired.
		const job = makeJob(`${CB_SNOOZE}cb-test-credit-001`);
		await dispatchFinanceCallback(job, makeDeps());

		// Проверяем что fired снят, snooze активен.
		expect(wasFired(stateDirPath, fireKeyLead)).toBe(false);
		const snoozeUntilVal = readSnoozeUntil(stateDirPath, 'credit:cb-test-credit-001');
		expect(snoozeUntilVal).not.toBeNull();

		// Запускаем collectFinanceDue с тем же "сейчас" (snooze активен).
		// Кредит: платёж через неделю от fixedNow (2026-06-23 + 7 = 2026-07-01).
		const creditForTest: import('../ingest/finance/types.js').CreditRecord = {
			id: 'cb-test-credit-001',
			source: 'manual',
			principal: 120_000,
			currency: 'RUB',
			rate_pct: 12,
			balance: 60_000,
			balance_ts: '2026-01-01T00:00:00Z',
			manual: true,
			monthly_payment: 3_000,
			next_payment_date: '2026-07-01T00:00:00Z',
			type: 'annuity',
		};

		const fakeFx: import('../ingest/finance/fx.js').FxProvider = {
			rate: async (from: string, to: string) => from === to ? 1 : null,
		};

		const cfg = {
			creditLeadDays: 14,
			idleNudgeDays: 7,
			cashSurveyIntervalDays: 3,
			cashSurveyHour: 19,
			stateDir: stateDirPath,
			tz: 'Europe/Moscow',
		};

		// Свип в окне snooze (тот же день) → кредит НЕ должен возвращаться.
		const resultDuringSnooze = await collectFinanceDue(
			[creditForTest],
			[],
			[],
			fakeFx,
			fixedNow.toISOString(), // snooze ещё активен (snoozeUntil = 2026-06-24)
			cfg,
		);
		expect(resultDuringSnooze.credits).toHaveLength(0);

		// Эмулируем "завтра": now после snoozeUntil → snooze истёк → кредит ВОЗВРАЩАЕТСЯ.
		// wsu гарантирует что snooze уже записан; мы делаем now = после snoozeUntil.
		const tomorrowIso = '2026-06-24T06:00:00Z'; // после 2026-06-24T00:00:00Z
		const resultAfterSnooze = await collectFinanceDue(
			[creditForTest],
			[],
			[],
			fakeFx,
			tomorrowIso,
			cfg,
		);
		// После истечения snooze + fired снят → кредит фаярит снова.
		expect(resultAfterSnooze.credits).toHaveLength(1);

		// Подавляем предупреждение о неиспользованном импорте wsu.
		void wsu;
	});

	it('[Отложить] без предшествующего fired-ключа — не бросает (идемпотентность)', async () => {
		// Нет fired-записей для кредита — snooze должен отработать без ошибок.
		const job = makeJob(`${CB_SNOOZE}cb-test-credit-001`);

		await expect(
			dispatchFinanceCallback(job, makeDeps()),
		).resolves.toBeUndefined();

		expect(telegram.sent).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Тесты: [Подробнее] — fin:detail:
// ---------------------------------------------------------------------------

describe('dispatchFinanceCallback — [Подробнее] (fin:detail:)', () => {
	it('отправляет фото с подписью (или текст) содержащим детали кредита', async () => {
		ledger.append('credits', SYNTHETIC_CREDIT);
		const job = makeJob(`${CB_DETAIL}cb-test-credit-001`);

		await dispatchFinanceCallback(job, makeDeps());

		// Либо фото отправлено (с PNG), либо текстовое сообщение.
		const hasSomething = telegram.photos.length > 0 || telegram.sent.length > 0;
		expect(hasSomething).toBe(true);

		// Текст содержит остаток.
		const text =
			telegram.photos[0]?.caption ??
			telegram.sent[0]?.text ??
			'';
		expect(text).toContain('60');
		expect(text).toContain('RUB');
	});

	it('W2: текст [Подробнее] содержит прогнозируемую дату погашения', async () => {
		// Кредит: balance=60000, rate=12% (1%/мес), monthly_payment=3000.
		// projectPayoffDate должна вернуть дату в будущем (несколько лет).
		ledger.append('credits', SYNTHETIC_CREDIT);
		const job = makeJob(`${CB_DETAIL}cb-test-credit-001`);

		await dispatchFinanceCallback(job, makeDeps());

		// Текст либо в caption PNG, либо в sendMessage.
		const text =
			telegram.photos[0]?.caption ??
			telegram.sent[0]?.text ??
			'';

		// Должен содержать «Прогноз погашения» с датой формата YYYY-MM-DD.
		expect(text).toContain('Прогноз погашения');
		// Дата должна быть в будущем (позже 2026-06-23).
		const match = text.match(/Прогноз погашения:\s*(\d{4}-\d{2}-\d{2})/);
		expect(match).not.toBeNull();
		if (match) {
			expect(match[1]! > '2026-06-23').toBe(true);
		}
	});

	it('кредит не найден → отправляет сообщение о ненахождении', async () => {
		const job = makeJob(`${CB_DETAIL}nonexistent-credit`);

		await dispatchFinanceCallback(job, makeDeps());

		expect(telegram.sent).toHaveLength(1);
		expect(telegram.sent[0]!.text).toContain('не найден');
	});

	it('ошибка рендера PNG → fallback на текстовое сообщение (не падает)', async () => {
		ledger.append('credits', SYNTHETIC_CREDIT);
		const job = makeJob(`${CB_DETAIL}cb-test-credit-001`);

		// renderPng бросает ошибку — должен быть fallback на текст.
		const errorRenderPng = (): Buffer => {
			throw new Error('resvg not available');
		};

		await dispatchFinanceCallback(job, makeDeps({ renderPng: errorRenderPng }));

		// Должен отправить текст вместо PNG.
		expect(telegram.sent).toHaveLength(1);
		expect(telegram.sent[0]!.text).toContain('RUB');
	});
});

// ---------------------------------------------------------------------------
// Тесты: неизвестный callback_data
// ---------------------------------------------------------------------------

describe('dispatchFinanceCallback — неизвестные данные', () => {
	it('fin: с неизвестным действием — answerCallbackQuery, НЕ бросает', async () => {
		const job = makeJob('fin:unknown:xyz');

		await expect(
			dispatchFinanceCallback(job, makeDeps()),
		).resolves.toBeUndefined();

		// «Часики» погашены.
		expect(telegram.answeredCallbacks).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Тесты: форматтеры (чистые функции)
// ---------------------------------------------------------------------------

describe('formatCreditPaymentReadback', () => {
	it('содержит основные поля (newBalance, nextPaymentDate)', () => {
		const text = formatCreditPaymentReadback({
			credit_id: 'test-001',
			principal: 2_400,
			interest: 600,
			paymentAmount: 3_000,
			currency: 'RUB',
			prevBalance: 60_000,
			newBalance: 57_600,
			nextPaymentDate: '2026-08-01T00:00:00Z',
			txId: 'tx-abc',
			creditSnapshotTs: '2026-06-23T10:00:00Z',
		});

		expect(text).toContain('3');   // paymentAmount или principal
		expect(text).toContain('RUB');
		expect(text).toContain('57'); // newBalance
		expect(text).toContain('2026-08-01');
	});
});

describe('formatSnoozeReadback', () => {
	it('содержит credit_id и дату откладывания', () => {
		const text = formatSnoozeReadback('test-credit-001', '2026-06-24T00:00:00Z');
		expect(text).toContain('test-credit-001');
		expect(text).toContain('2026-06-24');
	});
});
