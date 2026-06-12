/**
 * prompt.test.ts — персона моста (ADR-0016): DEFAULT_PERSONA-инвариант + loadPersona
 * (файл full-replace / fallback на дефолт / пустой → дефолт).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_PERSONA, loadPersona } from './prompt.js';

describe('DEFAULT_PERSONA', () => {
	it('идентичность «Второй мозг» + регистр + runtime-честность + роутинг', () => {
		expect(DEFAULT_PERSONA).toContain('«Второй мозг»');
		expect(DEFAULT_PERSONA.toLowerCase()).toContain('регистр');
		expect(DEFAULT_PERSONA).toContain('capture');
		expect(DEFAULT_PERSONA).toContain('git НЕ коммить');
		expect(DEFAULT_PERSONA).toContain('не «не настроено»'); // runtime-humility
	});
	it('без личных данных (generic — для публичного фреймворка)', () => {
		expect(DEFAULT_PERSONA).not.toContain('Данил');
	});
});

describe('loadPersona', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'sb-persona-'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('нет пути → generic DEFAULT_PERSONA', () => {
		expect(loadPersona(undefined)).toBe(DEFAULT_PERSONA);
	});
	it('несуществующий файл → DEFAULT_PERSONA', () => {
		expect(loadPersona(join(dir, 'nope.md'))).toBe(DEFAULT_PERSONA);
	});
	it('пустой файл → DEFAULT_PERSONA', () => {
		const p = join(dir, 'persona.md');
		writeFileSync(p, '   \n  ');
		expect(loadPersona(p)).toBe(DEFAULT_PERSONA);
	});
	it('непустой файл → ПОЛНАЯ замена (его содержимое, trimmed)', () => {
		const p = join(dir, 'persona.md');
		writeFileSync(p, '  Ты — мой личный Второй мозг.\n');
		expect(loadPersona(p)).toBe('Ты — мой личный Второй мозг.');
	});
});
