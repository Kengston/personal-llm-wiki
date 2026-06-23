/** Парность с `_chunk_text` из bridge/telegram.py ([ADR-0012]) + транспорт [ADR-0023]. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BotApiTelegramClient, chunkText } from './telegram.js';

describe('chunkText', () => {
	it('короткий текст — один кусок', () => {
		expect(chunkText('привет', 4096)).toEqual(['привет']);
	});

	it('пустой текст → [""]', () => {
		expect(chunkText('', 10)).toEqual(['']);
	});

	it('режет по границам строк', () => {
		const text = `${'a'.repeat(8)}\n${'b'.repeat(8)}`;
		expect(chunkText(text, 10)).toEqual(['aaaaaaaa', 'bbbbbbbb']);
	});

	it('жёстко режет строку длиннее лимита', () => {
		const text = 'x'.repeat(25);
		const chunks = chunkText(text, 10);
		expect(chunks.every((c) => c.length <= 10)).toBe(true);
		expect(chunks.join('')).toBe(text);
	});
});

// --------------------------------------------------------------------------- //
// BotApiTelegramClient — транспорт ([ADR-0023]). fetch замокан, без живой сети.  //
// --------------------------------------------------------------------------- //

/** Замоканный fetch: всегда ok=true; собираем (url, init) для ассертов. */
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

describe('BotApiTelegramClient — транспорт', () => {
	let client: BotApiTelegramClient;

	beforeEach(() => {
		client = new BotApiTelegramClient('123456789:AAtoken');
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('sendMessage по умолчанию БЕЗ parse_mode (plain-text безопасен)', async () => {
		const { calls } = mockFetchOk();
		await client.sendMessage(42, 'привет');
		const body = JSON.parse(calls[0]![1].body as string);
		expect(calls[0]![0]).toContain('/sendMessage');
		expect(body.parse_mode).toBeUndefined();
		expect(body.disable_web_page_preview).toBe(true);
		expect(body.reply_markup).toBeUndefined();
	});

	it('sendMessage с opt-in parseMode прокидывает parse_mode', async () => {
		const { calls } = mockFetchOk();
		await client.sendMessage(42, '<b>жирный</b>', { parseMode: 'HTML' });
		expect(JSON.parse(calls[0]![1].body as string).parse_mode).toBe('HTML');
	});

	it('reply_markup вешается ТОЛЬКО на последний чанк длинного текста', async () => {
		const { calls } = mockFetchOk();
		const markup = { inline_keyboard: [[{ text: 'Оплачено', callback_data: 'paid:1' }]] };
		// > 4096 символов из двух строк → ровно 2 чанка.
		const text = `${'a'.repeat(4096)}\n${'b'.repeat(10)}`;
		await client.sendMessage(42, text, { replyMarkup: markup });
		expect(calls).toHaveLength(2);
		expect(JSON.parse(calls[0]![1].body as string).reply_markup).toBeUndefined();
		expect(JSON.parse(calls[1]![1].body as string).reply_markup).toEqual(markup);
	});

	it('sendPhoto — multipart FormData с chat_id, photo и подписью', async () => {
		const { calls } = mockFetchOk();
		await client.sendPhoto(
			42,
			{ data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), filename: 'chart.png' },
			{ caption: 'Расходы за июнь' },
		);
		const [url, init] = calls[0]!;
		expect(url).toContain('/sendPhoto');
		const form = init.body as FormData;
		expect(form).toBeInstanceOf(FormData);
		expect(form.get('chat_id')).toBe('42');
		expect(form.get('caption')).toBe('Расходы за июнь');
		const photo = form.get('photo');
		expect(photo).toBeInstanceOf(Blob);
		expect((photo as File).name).toBe('chart.png');
		// content-type руками НЕ задаём — boundary ставит сам fetch по FormData.
		expect((init.headers as Record<string, string>) ?? {}).not.toHaveProperty('content-type');
	});

	it('sendDocument — multipart с reply_markup строкой (JSON)', async () => {
		const { calls } = mockFetchOk();
		const markup = { inline_keyboard: [[{ text: 'Период', callback_data: 'p' }]] };
		await client.sendDocument(42, { data: Buffer.from('a;b\n'), filename: 'export.csv' }, {
			replyMarkup: markup,
		});
		const form = calls[0]![1].body as FormData;
		expect(calls[0]![0]).toContain('/sendDocument');
		expect(form.get('reply_markup')).toBe(JSON.stringify(markup));
		expect((form.get('document') as File).name).toBe('export.csv');
	});

	it('answerCallbackQuery постит callback_query_id и глотает ошибку (best-effort)', async () => {
		const { calls } = mockFetchOk();
		await client.answerCallbackQuery('cbq-1');
		expect(JSON.parse(calls[0]![1].body as string).callback_query_id).toBe('cbq-1');
		// Падение API не должно пробрасываться (часики сами погаснут).
		vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
		await expect(client.answerCallbackQuery('cbq-2')).resolves.toBeUndefined();
	});

	it('getUpdates по умолчанию запрашивает message + callback_query', async () => {
		const { calls } = mockFetchOk();
		await client.getUpdates(0, 1);
		expect(JSON.parse(calls[0]![1].body as string).allowed_updates).toEqual([
			'message',
			'callback_query',
		]);
	});
});
