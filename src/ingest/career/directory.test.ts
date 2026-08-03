/**
 * directory.test.ts — IO-обвязка рендера: справочник D3 и запись документа.
 *
 * Ключевое: отрендеренное резюме содержит реальные контакты, поэтому его путь
 * проверяется ДО записи — внутрь публичного или приватного репозитория оно не ложится
 * ни при каком вызове ([ADR-0028], [ADR-0003]).
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	assertOutsideRepos,
	loadRenderDirectory,
	resolveDirectoryPath,
	RenderOutputPathError,
	writeRenderedResume,
} from './directory.js';

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'career-directory-test-'));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

const SYNTHETIC_DIRECTORY = {
	display_name: 'Synthetic Owner',
	contacts: { email_primary: 'owner@example.com' },
	orgs: { acme: 'Acme' },
	institutions: {},
	links: {},
};

describe('справочник рендера', () => {
	it('путь по умолчанию — gitignored-файл рядом с приватным контентом', () => {
		expect(resolveDirectoryPath({ CONTENT_ROOT: '/synthetic/content' } as NodeJS.ProcessEnv)).toBe(
			join('/synthetic/content', 'career-directory.local.json'),
		);
	});

	it('читает справочник и добивает пропущенные разделы пустыми', () => {
		const path = join(tmpDir, 'career-directory.local.json');
		writeFileSync(path, JSON.stringify({ display_name: 'Synthetic Owner' }), 'utf8');

		const directory = loadRenderDirectory(path);

		expect(directory.display_name).toBe('Synthetic Owner');
		expect(directory.orgs).toEqual({});
	});

	it('отсутствие файла — исключение, а не пустой справочник', () => {
		// Молча собранное резюме без контактов выглядит готовым — и уходит нечитаемым.
		expect(() => loadRenderDirectory(join(tmpDir, 'absent.json'))).toThrow();
	});

	it('справочник без имени владельца не принимается', () => {
		const path = join(tmpDir, 'no-name.json');
		writeFileSync(path, JSON.stringify({ contacts: {} }), 'utf8');

		expect(() => loadRenderDirectory(path)).toThrow();
	});
});

describe('запись отрендеренного документа', () => {
	it('путь внутри публичного или приватного репо отбивается', () => {
		const publicRepo = join(tmpDir, 'public');
		const contentRoot = join(tmpDir, 'content');

		expect(() =>
			assertOutsideRepos(join(publicRepo, 'resume.md'), publicRepo, contentRoot),
		).toThrow(RenderOutputPathError);
		expect(() =>
			assertOutsideRepos(join(contentRoot, 'raw', 'resume.md'), publicRepo, contentRoot),
		).toThrow(RenderOutputPathError);
		expect(() =>
			assertOutsideRepos(join(tmpDir, 'out', 'resume.md'), publicRepo, contentRoot),
		).not.toThrow();
	});

	it('пишет документ вне репозиториев и не оставляет tmp-файла', () => {
		const out = join(tmpDir, 'out', 'resume-en.md');
		const env = {
			CONTENT_ROOT: join(tmpDir, 'content'),
			PUBLIC_REPO: join(tmpDir, 'public'),
		} as NodeJS.ProcessEnv;

		writeRenderedResume(out, '# Synthetic Owner\n', env);

		expect(readFileSync(out, 'utf8')).toBe('# Synthetic Owner\n');
		// tmp + rename: временный файл не должен пережить запись.
		expect(readdirSync(join(tmpDir, 'out'))).toEqual(['resume-en.md']);
	});

	it('в приватный контент-репо документ не пишется вовсе', () => {
		const contentRoot = join(tmpDir, 'content');
		mkdirSync(contentRoot, { recursive: true });
		const out = join(contentRoot, 'resume-en.md');
		const env = {
			CONTENT_ROOT: contentRoot,
			PUBLIC_REPO: join(tmpDir, 'public'),
		} as NodeJS.ProcessEnv;

		expect(() => writeRenderedResume(out, '# Synthetic Owner\n', env)).toThrow(
			RenderOutputPathError,
		);
		expect(existsSync(out)).toBe(false);
	});

	it('справочник синтетического примера читается целиком', () => {
		const path = join(tmpDir, 'full.json');
		writeFileSync(path, JSON.stringify(SYNTHETIC_DIRECTORY), 'utf8');

		expect(loadRenderDirectory(path)).toEqual(SYNTHETIC_DIRECTORY);
	});
});
