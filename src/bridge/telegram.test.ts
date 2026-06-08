/** Парность с `_chunk_text` из bridge/telegram.py ([ADR-0012]). */
import { describe, expect, it } from 'vitest';

import { chunkText } from './telegram.js';

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
