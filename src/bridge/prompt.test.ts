/**
 * prompt.test.ts — конверт-маршрутизатор buildOwnerPrompt: оборачивает текст,
 * сохраняет его дословно, несёт обе ветки (query/capture) и запрет коммита движком.
 */
import { describe, expect, it } from 'vitest';

import { buildOwnerPrompt, ROUTING_PREAMBLE } from './prompt.js';

describe('buildOwnerPrompt', () => {
	it('оборачивает текст владельца, сохраняя его дословно', () => {
		const text = 'Идея: транскрипция голосовых через whisper.cpp';
		const out = buildOwnerPrompt(text);
		expect(out.startsWith(ROUTING_PREAMBLE)).toBe(true);
		expect(out).toContain(text);
		expect(out.endsWith(text)).toBe(true);
	});

	it('преамбула несёт обе ветки и запрет коммита движком', () => {
		expect(ROUTING_PREAMBLE).toContain('capture');
		expect(ROUTING_PREAMBLE.toLowerCase()).toContain('вопрос');
		expect(ROUTING_PREAMBLE).toContain('git коммит НЕ делай');
		expect(ROUTING_PREAMBLE).toContain('runtime'); // runtime-humility (не врать про launchd/sweep)
	});
});
