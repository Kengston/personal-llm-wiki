/**
 * Регрессия на HIGH-находку аудита: наивный `import.meta.url === file://${argv[1]}`
 * молча не запускал CLI под путём с пробелом (percent-кодирование) или через симлинк,
 * из-за чего `lint-public` (guard границы двух репо) «проходил» без сканирования.
 */
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isMainModule } from './cli.js';

describe('isMainModule', () => {
	let dir: string;
	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), 'cli-test-')));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('нет process.argv[1] → false', () => {
		expect(isMainModule('/x', undefined)).toBe(false);
	});

	it('совпадение realpath → true', () => {
		const f = join(dir, 'entry.js');
		writeFileSync(f, '// x');
		expect(isMainModule(realpathSync(f), f)).toBe(true);
	});

	it('другой путь → false', () => {
		const f = join(dir, 'a.js');
		writeFileSync(f, '//');
		expect(isMainModule('/some/other/file.js', f)).toBe(false);
	});

	it('путь с ПРОБЕЛОМ резолвится (наивный file://url percent-кодировал бы → false)', () => {
		const spaced = realpathSync(mkdtempSync(join(tmpdir(), 'cli sp ')));
		try {
			const f = join(spaced, 'entry.js');
			writeFileSync(f, '// x');
			expect(isMainModule(realpathSync(f), f)).toBe(true);
		} finally {
			rmSync(spaced, { recursive: true, force: true });
		}
	});

	it('вызов через СИМЛИНК → main распознан (realpath обоих путей)', () => {
		const target = join(dir, 'real.js');
		writeFileSync(target, '// x');
		const link = join(dir, 'link.js');
		symlinkSync(target, link);
		// metaFilename = realpath(target); скрипт вызван как симлинк link.
		expect(isMainModule(realpathSync(target), link)).toBe(true);
	});
});
