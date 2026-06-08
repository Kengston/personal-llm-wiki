/**
 * Парность с `ingest/watermark.py` ([ADR-0012]). Векторы из Python `_selftest`
 * + проверка идемпотентности «advance-only-after-write».
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Watermark } from './watermark.js';

describe('watermark', () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), 'wm-test-'));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it('пустой курсор на старте', () => {
		const wm = Watermark.load(tmp, 'telegram');
		expect(wm.runs).toBe(0);
		expect(wm.cursor).toEqual({});
		expect(wm.isSeenMessage(1)).toBe(false);
	});

	it('advance + save увеличивает runs и персистит', () => {
		const wm = Watermark.load(tmp, 'telegram');
		wm.advance({ last_message_id: 100, last_date_unixtime: 1717100000 });
		wm.save();
		expect(wm.runs).toBe(1);

		const wm2 = Watermark.load(tmp, 'telegram');
		expect(wm2.cursor['last_message_id']).toBe(100);
		expect(wm2.isSeenMessage(50)).toBe(true); // ниже курсора — уже виден
		expect(wm2.isSeenMessage(100)).toBe(true); // == курсор — уже виден
		expect(wm2.isSeenMessage(101)).toBe(false); // выше — новый
		expect(wm2.runs).toBe(1);
	});

	it('битый JSON → fail-safe пустой курсор', () => {
		const path = Watermark.statePath(tmp, 'broken');
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, '{ это не json', 'utf8');
		const wm = Watermark.load(tmp, 'broken');
		expect(wm.cursor).toEqual({});
	});

	it('statePath кладёт в .watermarks/<source>.json', () => {
		expect(Watermark.statePath('/base', 'vk')).toBe('/base/.watermarks/vk.json');
	});

	it('повторные save накапливают курсор атомарно', () => {
		const wm = Watermark.load(tmp, 's');
		wm.advance({ a: 1 });
		wm.save();
		wm.advance({ b: 2 });
		wm.save();
		const wm2 = Watermark.load(tmp, 's');
		expect(wm2.cursor).toEqual({ a: 1, b: 2 });
		expect(wm2.runs).toBe(2);
	});

	it('isSeenMessage без last_message_id — всё новое', () => {
		const wm = Watermark.load(tmp, 's');
		expect(wm.isSeenMessage(999)).toBe(false);
	});
});
