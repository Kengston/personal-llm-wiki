/**
 * runner.test.ts — last-mile guard проактивного push ([ADR-0007]/[ADR-0023]).
 * Проверяем pushPhotoToOwner: секрет в caption/filename блокирует отправку ДО сети;
 * чистый кейс доходит до sendPhoto (fetch замокан, без живой сети). Бинарь НЕ сканируем.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pushPhotoToOwner } from './runner.js';

const ENV = { TELEGRAM_OWNER_CHAT_ID: '42', TELEGRAM_BOT_TOKEN: '123456789:AAtoken' };

/** Замоканный fetch: ok=true; собираем вызовы. */
function mockFetchOk(): { calls: Array<[string, RequestInit]> } {
	const calls: Array<[string, RequestInit]> = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: RequestInit) => {
			calls.push([url, init]);
			return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
		}),
	);
	return { calls };
}

describe('pushPhotoToOwner — last-mile guard', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('секрет в caption → throw, fetch НЕ вызывается', async () => {
		const { calls } = mockFetchOk();
		const token = 'ghp_' + 'A'.repeat(36);
		await expect(
			pushPhotoToOwner(
				{ data: Buffer.from([1, 2, 3]), filename: 'chart.png' },
				{ caption: `см. ${token}`, env: ENV },
			),
		).rejects.toThrow(/scan_secrets|заблокирован/);
		expect(calls).toHaveLength(0);
	});

	it('секрет в filename → throw', async () => {
		mockFetchOk();
		const token = 'ghp_' + 'A'.repeat(36);
		await expect(
			pushPhotoToOwner({ data: Buffer.from([1]), filename: `${token}.png` }, { env: ENV }),
		).rejects.toThrow();
	});

	it('чистый caption → доходит до sendPhoto (бинарь не сканируем)', async () => {
		const { calls } = mockFetchOk();
		// Байты «PNG» с высокоэнтропийным мусором — НЕ блокируют (сканируем только текст-поля).
		await pushPhotoToOwner(
			{ data: Buffer.from('binary-blob-AKIA0000000000000000-ничего'), filename: 'chart.png' },
			{ caption: 'Расходы за июнь: 120 000 ₽', env: ENV },
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]![0]).toContain('/sendPhoto');
		const form = calls[0]![1].body as FormData;
		expect(form.get('chat_id')).toBe('42');
		expect(form.get('caption')).toBe('Расходы за июнь: 120 000 ₽');
	});
});
