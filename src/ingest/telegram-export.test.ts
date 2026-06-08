/**
 * Парность с `ingest/telegram_export.py` ([ADR-0012]). extract_text (text_entities),
 * parse_message (normal/service/media), build_page (санитизация body+sender),
 * идемпотентность по watermark id.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildPage, extractText, ingest, iterChats, parseMessage } from './telegram-export.js';
import { Watermark } from './watermark.js';

describe('extractText', () => {
	it('собирает из text_entities', () => {
		expect(extractText({ text_entities: [{ type: 'plain', text: 'привет ' }, { type: 'bold', text: 'мир' }] })).toBe('привет мир');
	});
	it('фолбэк на полиморфный text (массив строк+объектов)', () => {
		expect(extractText({ text: ['строка ', { type: 'link', text: 'ссылка' }] })).toBe('строка ссылка');
	});
	it('плоская строка text', () => {
		expect(extractText({ text: 'просто' })).toBe('просто');
	});
});

describe('parseMessage', () => {
	it('обычное сообщение', () => {
		const p = parseMessage({ id: 5, date_unixtime: '1717000000', from: 'Иван', text_entities: [{ text: 'хай' }] });
		expect(p?.id).toBe(5);
		expect(p?.sender).toBe('Иван');
		expect(p?.body).toBe('хай');
		expect(p?.dateIso).toMatch(/^2024-/);
	});
	it('service-сообщение', () => {
		const p = parseMessage({ id: 1, type: 'service', action: 'pinned_message', actor: 'Пётр' });
		expect(p?.isService).toBe(true);
		expect(p?.body).toBe('pinned_message: Пётр');
	});
	it('медиа-пометка', () => {
		const p = parseMessage({ id: 2, from: 'A', photo: 'photo_1.jpg', text_entities: [] });
		expect(p?.body).toBe('[media: photo]');
	});
	it('пустое сообщение → null', () => {
		expect(parseMessage({ id: 3, from: 'A', text_entities: [] })).toBeNull();
	});
});

describe('iterChats', () => {
	it('chats.list', () => {
		const chats = [...iterChats({ chats: { list: [{ id: 1, messages: [] }, { id: 2, messages: [] }] } })];
		expect(chats).toHaveLength(2);
	});
	it('экспорт одного диалога (верхний уровень — чат)', () => {
		const chats = [...iterChats({ name: 'Saved', messages: [] })];
		expect(chats).toHaveLength(1);
	});
});

describe('buildPage', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'tg-test-'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('санитизирует тело и отправителя, фронтматтер', () => {
		const wm = Watermark.load(dir, 'telegram');
		const chat = {
			name: 'Личный чат',
			id: 42,
			type: 'personal_chat',
			messages: [
				{ id: 10, date_unixtime: '1717000000', from: 'Контакт', text_entities: [{ text: 'мой ключ sk-ant-Ab3Cd7Ef1Gh9Ij2Kl5Mn8Op4Qr' }] },
			],
		};
		const res = buildPage(chat, { name: 'result.json' }, wm);
		expect(res.markdown).not.toContain('sk-ant-Ab3Cd7Ef1Gh9Ij2Kl5Mn8Op4Qr');
		expect(res.markdown).toContain('[REDACTED:openai_key]');
		expect(res.markdown).toContain('source: telegram');
		expect(res.nWritten).toBe(1);
		expect(res.maxId).toBe(10);
	});

	it('watermark отсекает уже виденные id → markdown null', () => {
		const wm = Watermark.load(dir, 'telegram');
		wm.advance({ last_message_id: 100 });
		const chat = { name: 'C', id: 1, messages: [{ id: 50, date_unixtime: '1717000000', from: 'A', text_entities: [{ text: 'старое' }] }] };
		expect(buildPage(chat, { name: 'r.json' }, wm).markdown).toBeNull();
	});
});

describe('ingest идемпотентность', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'tg-ingest-'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('второй ингест → 0 новых сообщений', () => {
		const exportPath = join(dir, 'result.json');
		const rawDir = join(dir, 'raw');
		const exportData = {
			name: 'Export',
			chats: { list: [{ name: 'Чат', id: 7, type: 'personal_chat', messages: [{ id: 1, date_unixtime: '1717000000', from: 'A', text_entities: [{ text: 'привет' }] }] }] },
		};
		writeFileSync(exportPath, JSON.stringify(exportData), 'utf8');
		expect(ingest(exportPath, rawDir)).toBe(1);
		expect(existsSync(join(rawDir, 'telegram'))).toBe(true);
		expect(ingest(exportPath, rawDir)).toBe(0); // дедуп по watermark id
	});
});
