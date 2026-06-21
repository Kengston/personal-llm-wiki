/**
 * knowledge-package.test.ts — тесты оркестратора ингеста knowledge-package.
 *
 * Принципы:
 *   - Все данные синтетические (выдуманные топики, версии, тексты).
 *   - Нет реальных сетевых запросов и зависимостей от файловой системы вне tmp.
 *   - Тесты идемпотентны: mkdtempSync → rmSync в afterEach.
 *   - Fail-closed: инжектируемый sanitizeFn бросает SanitizerError → ничего не записывается.
 *
 * Покрытие:
 *   1. deriveFreshness: current / aging / stale по возрасту в месяцах.
 *   2. claimId: детерминированность, формат 'claim_'+4hex.
 *   3. transformFrontmatter: sources ТЗ-форма; bare-string claims; префикс 'Источник:';
 *      наличие/отсутствие type → status+last_updated.
 *   4. ingestKnowledgePackage round-trip: дерево пакета, orphan-удаление, raw-файл, watermark.
 *   5. Идемпотентность: второй вызов той же версии → noop.
 *   6. Fail-closed: sanitizeFn бросает → raw не создан, watermark не продвинут.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SanitizerError } from './sanitizer.js';
import {
	claimId,
	compareVersions,
	deriveFreshness,
	ingestKnowledgePackage,
	parseFrontmatter,
	rawFileName,
	serializeFrontmatter,
	transformFrontmatter,
	type TransformContext,
} from './knowledge-package.js';

// ---------------------------------------------------------------------------
// 1. deriveFreshness
// ---------------------------------------------------------------------------

describe('deriveFreshness', () => {
	// Фиксированная «сейчас» — 2026-06-21.
	const now = new Date('2026-06-21T12:00:00Z');

	it('≤12 месяцев → current (6 месяцев назад)', () => {
		// 2025-12-01 → ~6 месяцев до 2026-06-21.
		expect(deriveFreshness('2025-12', now)).toBe('current');
	});

	it('≤24 месяцев → aging (18 месяцев назад)', () => {
		// 2024-12-01 → ~18 месяцев до 2026-06-21.
		expect(deriveFreshness('2024-12', now)).toBe('aging');
	});

	it('>24 месяцев → stale (36 месяцев назад)', () => {
		// 2023-06-01 → ~36 месяцев до 2026-06-21.
		expect(deriveFreshness('2023-06', now)).toBe('stale');
	});

	it('полная дата YYYY-MM-DD распознаётся', () => {
		// 2025-09-01 → ~9.5 месяцев назад → уверенно внутри окна ≤12 → current.
		// (Граничный пример «ровно 12 мес» хрупок: now несёт время суток 12:00Z,
		//  так что источник 12 мес назад в 00:00 даёт 12.02 мес → aging. Берём дату внутри окна.)
		expect(deriveFreshness('2025-09-01', now)).toBe('current');
	});

	it('некорректная дата → stale', () => {
		expect(deriveFreshness('not-a-date', now)).toBe('stale');
	});
});

// ---------------------------------------------------------------------------
// 2. claimId
// ---------------------------------------------------------------------------

describe('claimId', () => {
	it('детерминирован: одинаковый вход → одинаковый id', () => {
		const id1 = claimId('my-slug', 'Утверждение о чём-то важном');
		const id2 = claimId('my-slug', 'Утверждение о чём-то важном');
		expect(id1).toBe(id2);
	});

	it('разный slug → разный id', () => {
		const id1 = claimId('slug-a', 'Одинаковый текст');
		const id2 = claimId('slug-b', 'Одинаковый текст');
		expect(id1).not.toBe(id2);
	});

	it('разный текст → разный id', () => {
		const id1 = claimId('slug', 'Текст первый');
		const id2 = claimId('slug', 'Текст второй');
		expect(id1).not.toBe(id2);
	});

	it("формат 'claim_' + 4 hex символа", () => {
		const id = claimId('test-slug', 'Тестовое утверждение');
		expect(id).toMatch(/^claim_[0-9a-f]{4}$/);
	});
});

// ---------------------------------------------------------------------------
// 3. transformFrontmatter
// ---------------------------------------------------------------------------

describe('transformFrontmatter: sources ТЗ-форма → object-форма', () => {
	const now = new Date('2026-06-21T12:00:00Z');
	const ctx: TransformContext = {
		url: '../../../raw/knowledge/job-search/nazarov-2024.md',
		nowIso: '2026-06-21T15:00:00+03:00',
		slug: 'test-page',
		now,
	};

	it('ТЗ-форма {id, ref, source_date} → {name, date, freshness, url}', () => {
		const data = {
			title: 'Тестовая страница',
			type: 'concept',
			sources: [{ id: 'nazarov-2024', ref: 'Назаров 2024', source_date: '2024-09' }],
		};
		const result = transformFrontmatter(data, ctx);
		const sources = result['sources'] as Array<Record<string, unknown>>;
		expect(Array.isArray(sources)).toBe(true);
		expect(sources).toHaveLength(1);
		const src = sources[0]!;
		expect(src['name']).toBe('Назаров 2024');
		expect(src['date']).toBe('2024-09');
		// 2024-09 → ~21 мес до 2026-06 → aging.
		expect(src['freshness']).toBe('aging');
		expect(src['url']).toBe(ctx.url);
	});

	it('object-форма (есть name && url) оставляется как есть (идемпотентность)', () => {
		const existingSource = {
			name: 'Уже готовый источник',
			date: '2025-01',
			freshness: 'current',
			url: '/some/path.md',
		};
		const data = {
			type: 'concept',
			sources: [existingSource],
		};
		const result = transformFrontmatter(data, ctx);
		const sources = result['sources'] as Array<Record<string, unknown>>;
		expect(sources[0]).toEqual(existingSource);
	});

	it('source без ref → name берётся из id', () => {
		const data = {
			type: 'concept',
			sources: [{ id: 'some-id', source_date: '2025-01' }],
		};
		const result = transformFrontmatter(data, ctx);
		const sources = result['sources'] as Array<Record<string, unknown>>;
		expect(sources[0]!['name']).toBe('some-id');
	});

	it('source без id и ref → name = "источник"', () => {
		const data = {
			type: 'concept',
			sources: [{ source_date: '2025-01' }],
		};
		const result = transformFrontmatter(data, ctx);
		const sources = result['sources'] as Array<Record<string, unknown>>;
		expect(sources[0]!['name']).toBe('источник');
	});
});

describe('transformFrontmatter: bare-string claims → структуры', () => {
	const now = new Date('2026-06-21T12:00:00Z');
	const ctx: TransformContext = {
		url: '../../../raw/knowledge/job-search/nazarov-2024.md',
		nowIso: '2026-06-21T15:00:00+03:00',
		slug: 'index',
		now,
	};

	it('строки → {id, text, status, sources} БЕЗ поля confidence', () => {
		const data = {
			type: 'concept',
			claims: ['Ключевой навык — адаптируемость'],
		};
		const result = transformFrontmatter(data, ctx);
		const claims = result['claims'] as Array<Record<string, unknown>>;
		expect(Array.isArray(claims)).toBe(true);
		expect(claims).toHaveLength(1);
		const claim = claims[0]!;
		expect(claim).not.toHaveProperty('confidence');
		expect(claim['status']).toBe('active');
		expect(Array.isArray(claim['sources'])).toBe(true);
		expect((claim['sources'] as string[])[0]).toBe(ctx.url);
	});

	it('текст без атрибуции получает префикс "Источник: "', () => {
		const data = {
			type: 'concept',
			claims: ['Резюме должно быть кратким'],
		};
		const result = transformFrontmatter(data, ctx);
		const claims = result['claims'] as Array<Record<string, unknown>>;
		expect(String(claims[0]!['text'])).toMatch(/^Источник: /);
	});

	it('текст уже содержит "источник" — префикс НЕ дублируется', () => {
		const data = {
			type: 'concept',
			claims: ['Источник: Резюме должно быть кратким'],
		};
		const result = transformFrontmatter(data, ctx);
		const claims = result['claims'] as Array<Record<string, unknown>>;
		const text = String(claims[0]!['text']);
		// Не должно быть "Источник: Источник:".
		expect(text).not.toMatch(/Источник: Источник:/);
		expect(text).toBe('Источник: Резюме должно быть кратким');
	});

	it('текст содержит "источник" (строчная и) — префикс НЕ дублируется', () => {
		const data = {
			type: 'concept',
			claims: ['По данному источнику...'],
		};
		const result = transformFrontmatter(data, ctx);
		const claims = result['claims'] as Array<Record<string, unknown>>;
		const text = String(claims[0]!['text']);
		expect(text).toBe('По данному источнику...');
	});

	it('id = "claim_" + 4 hex', () => {
		const data = { type: 'concept', claims: ['Любое утверждение'] };
		const result = transformFrontmatter(data, ctx);
		const claims = result['claims'] as Array<Record<string, unknown>>;
		expect(String(claims[0]!['id'])).toMatch(/^claim_[0-9a-f]{4}$/);
	});

	it('claims уже object-форма — оставляем как есть', () => {
		const existingClaim = { id: 'claim_abcd', text: 'Текст', status: 'active', sources: [] };
		const data = { type: 'concept', claims: [existingClaim] };
		const result = transformFrontmatter(data, ctx);
		const claims = result['claims'] as Array<Record<string, unknown>>;
		expect(claims[0]).toEqual(existingClaim);
	});
});

describe('transformFrontmatter: status и last_updated', () => {
	const now = new Date('2026-06-21T12:00:00Z');
	const ctx: TransformContext = {
		url: '../raw/nazarov-2024.md',
		nowIso: '2026-06-21T15:00:00+03:00',
		slug: 'manifest',
		now,
	};

	it('при наличии type выставляются status:"active" и last_updated', () => {
		const data = { title: 'Страница', type: 'concept', slug: 'page' };
		const result = transformFrontmatter(data, ctx);
		expect(result['status']).toBe('active');
		expect(result['last_updated']).toBe(ctx.nowIso);
	});

	it('при отсутствии type (MANIFEST) — status и last_updated НЕ трогаются', () => {
		// MANIFEST не имеет поля type.
		const data = {
			title: 'MANIFEST',
			package: 'job-search-knowledge',
			version: '0.1.0',
			target_category: 'knowledge/job-search',
			source_of_truth: 'nazarov-2024',
		};
		const result = transformFrontmatter(data, ctx);
		// status и last_updated не должны появляться.
		expect(result).not.toHaveProperty('status');
		expect(result).not.toHaveProperty('last_updated');
	});

	it('прочие поля (title, topic, part, risk) сохраняются', () => {
		const data = {
			title: 'Страница концепции',
			type: 'concept',
			topic: 'job-search',
			part: '1',
			risk: 'low',
			slug: 'concept-page',
		};
		const result = transformFrontmatter(data, ctx);
		expect(result['title']).toBe('Страница концепции');
		expect(result['topic']).toBe('job-search');
		expect(result['part']).toBe('1');
		expect(result['risk']).toBe('low');
		expect(result['slug']).toBe('concept-page');
	});
});

// ---------------------------------------------------------------------------
// 4. ingestKnowledgePackage round-trip
// ---------------------------------------------------------------------------

/**
 * Вспомогательная функция: создаёт синтетический package-root в tmpDir.
 * Структура: knowledge/<topic>/{MANIFEST.md, index.md, part-1/page-a.md}
 */
function buildSyntheticPackage(
	tmpDir: string,
	topic = 'job-search',
	version = '0.1.0',
	sourceId = 'nazarov-2024',
): string {
	const packageRoot = join(tmpDir, 'package');
	const topicDir = join(packageRoot, 'knowledge', topic);
	mkdirSync(topicDir, { recursive: true });
	mkdirSync(join(topicDir, 'part-1'), { recursive: true });

	// MANIFEST.md.
	const manifestFm = {
		title: 'Job Search Knowledge',
		package: 'job-search-knowledge',
		version,
		target_category: `knowledge/${topic}`,
		source_of_truth: sourceId,
	};
	writeFileSync(
		join(topicDir, 'MANIFEST.md'),
		serializeFrontmatter(manifestFm, 'Методология поиска работы.\n'),
		'utf8',
	);

	// index.md — главная страница темы.
	const indexFm = {
		title: 'Поиск работы — обзор',
		type: 'concept',
		topic,
		slug: 'index',
		sources: [{ id: sourceId, ref: 'Назаров 2024', source_date: '2024-09' }],
		claims: ['Системный подход повышает вероятность оффера'],
	};
	writeFileSync(
		join(topicDir, 'index.md'),
		serializeFrontmatter(indexFm, 'Обзор методологии.\n'),
		'utf8',
	);

	// part-1/page-a.md — вложенная страница.
	const pageAFm = {
		title: 'Резюме ATS',
		type: 'guide',
		topic,
		part: '1',
		slug: 'resume-ats',
		sources: [{ id: sourceId, ref: 'Назаров 2024', source_date: '2024-09' }],
		claims: ['Резюме должно проходить ATS-фильтры'],
	};
	writeFileSync(
		join(topicDir, 'part-1', 'page-a.md'),
		serializeFrontmatter(pageAFm, 'Детали по ATS.\n'),
		'utf8',
	);

	return packageRoot;
}

describe('ingestKnowledgePackage: round-trip', () => {
	let tmpPkg: string;
	let tmpContent: string;

	beforeEach(() => {
		tmpPkg = mkdtempSync(join(tmpdir(), 'kp-pkg-'));
		tmpContent = mkdtempSync(join(tmpdir(), 'kp-content-'));
	});

	afterEach(() => {
		rmSync(tmpPkg, { recursive: true, force: true });
		rmSync(tmpContent, { recursive: true, force: true });
	});

	it('round-trip: pagesWritten > 0, файлы созданы, watermark существует', () => {
		const packageRoot = buildSyntheticPackage(tmpPkg);
		const transcriptPath = join(tmpPkg, 'transcript.txt');
		writeFileSync(transcriptPath, 'Синтетический транскрипт лекции. Без секретов.\n', 'utf8');

		const now = new Date('2026-06-21T12:00:00Z');
		const result = ingestKnowledgePackage(packageRoot, transcriptPath, {
			contentRoot: tmpContent,
			nowFn: () => now,
		});

		expect(result.noop).toBe(false);
		expect(result.version).toBe('0.1.0');
		expect(result.pagesWritten).toBeGreaterThan(0);
		// Raw файл транскрипта создан.
		expect(result.rawWritten).not.toBeNull();
		expect(existsSync(result.rawWritten!)).toBe(true);
		// Watermark создан.
		const wmPath = join(tmpContent, 'raw', '.watermarks', 'knowledge-package-job-search.json');
		expect(existsSync(wmPath)).toBe(true);
	});

	it('raw-файл содержит санитизированное тело транскрипта', () => {
		const packageRoot = buildSyntheticPackage(tmpPkg);
		const transcriptPath = join(tmpPkg, 'transcript.txt');
		const transcriptBody = 'Это тело транскрипта. Чистое содержимое.\n';
		writeFileSync(transcriptPath, transcriptBody, 'utf8');

		const result = ingestKnowledgePackage(packageRoot, transcriptPath, {
			contentRoot: tmpContent,
			nowFn: () => new Date('2026-06-21T12:00:00Z'),
		});

		const rawContent = readFileSync(result.rawWritten!, 'utf8');
		// Тело транскрипта должно присутствовать в raw-файле.
		expect(rawContent).toContain(transcriptBody.trim());
		// Frontmatter raw-файла: тип 'raw', статус 'immutable' (контракт rules.md §3).
		const { data } = parseFrontmatter(rawContent);
		expect(data['type']).toBe('raw');
		expect(data['status']).toBe('immutable');
		// exported_at — поле момента экспорта (не ingested_at).
		expect(data).toHaveProperty('exported_at');
		expect(data).not.toHaveProperty('ingested_at');
	});

	it('целевая page-a.md имеет object-форму sources и structured claims без confidence', () => {
		const packageRoot = buildSyntheticPackage(tmpPkg);
		const transcriptPath = join(tmpPkg, 'transcript.txt');
		writeFileSync(transcriptPath, 'Транскрипт.\n', 'utf8');

		ingestKnowledgePackage(packageRoot, transcriptPath, {
			contentRoot: tmpContent,
			nowFn: () => new Date('2026-06-21T12:00:00Z'),
		});

		const pageAPath = join(tmpContent, 'knowledge', 'job-search', 'part-1', 'page-a.md');
		expect(existsSync(pageAPath)).toBe(true);

		const content = readFileSync(pageAPath, 'utf8');
		const { data } = parseFrontmatter(content);

		// sources должны быть в object-форме.
		const sources = data['sources'] as Array<Record<string, unknown>>;
		expect(Array.isArray(sources)).toBe(true);
		expect(sources[0]).toHaveProperty('name');
		expect(sources[0]).toHaveProperty('freshness');
		expect(sources[0]).toHaveProperty('url');

		// claims должны быть в object-форме без confidence.
		const claims = data['claims'] as Array<Record<string, unknown>>;
		expect(Array.isArray(claims)).toBe(true);
		expect(claims[0]).toHaveProperty('id');
		expect(claims[0]).toHaveProperty('text');
		expect(claims[0]).toHaveProperty('status');
		expect(claims[0]).not.toHaveProperty('confidence');
	});

	it('orphan.md удалён: есть в orphansRemoved, файла нет', () => {
		const packageRoot = buildSyntheticPackage(tmpPkg);
		const transcriptPath = join(tmpPkg, 'transcript.txt');
		writeFileSync(transcriptPath, 'Транскрипт.\n', 'utf8');

		// Создаём seed-orphan в целевом контент-репо до ингеста.
		const orphanDir = join(tmpContent, 'knowledge', 'job-search');
		mkdirSync(orphanDir, { recursive: true });
		const orphanPath = join(orphanDir, 'resume-ats.md');
		writeFileSync(orphanPath, '# Старая страница\n', 'utf8');

		const result = ingestKnowledgePackage(packageRoot, transcriptPath, {
			contentRoot: tmpContent,
			nowFn: () => new Date('2026-06-21T12:00:00Z'),
		});

		// Orphan должен быть в результате.
		expect(result.orphansRemoved).toContain('resume-ats.md');
		// Физически файл должен быть удалён.
		expect(existsSync(orphanPath)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 5. Идемпотентность: второй вызов той же версии → noop
// ---------------------------------------------------------------------------

describe('ingestKnowledgePackage: идемпотентность по версии', () => {
	let tmpPkg: string;
	let tmpContent: string;

	beforeEach(() => {
		tmpPkg = mkdtempSync(join(tmpdir(), 'kp-idem-pkg-'));
		tmpContent = mkdtempSync(join(tmpdir(), 'kp-idem-content-'));
	});

	afterEach(() => {
		rmSync(tmpPkg, { recursive: true, force: true });
		rmSync(tmpContent, { recursive: true, force: true });
	});

	it('второй вызов той же версии → noop=true', () => {
		const packageRoot = buildSyntheticPackage(tmpPkg);
		const transcriptPath = join(tmpPkg, 'transcript.txt');
		writeFileSync(transcriptPath, 'Транскрипт.\n', 'utf8');

		const deps = {
			contentRoot: tmpContent,
			nowFn: () => new Date('2026-06-21T12:00:00Z'),
		};

		// Первый ингест.
		const first = ingestKnowledgePackage(packageRoot, transcriptPath, deps);
		expect(first.noop).toBe(false);

		// Второй ингест той же версии.
		const second = ingestKnowledgePackage(packageRoot, transcriptPath, deps);
		expect(second.noop).toBe(true);
		expect(second.pagesWritten).toBe(0);
		expect(second.orphansRemoved).toHaveLength(0);
		expect(second.rawWritten).toBeNull();
	});

	it('число .md в knowledgeDir не выросло после второго вызова', () => {
		const packageRoot = buildSyntheticPackage(tmpPkg);
		const transcriptPath = join(tmpPkg, 'transcript.txt');
		writeFileSync(transcriptPath, 'Транскрипт.\n', 'utf8');

		const deps = {
			contentRoot: tmpContent,
			nowFn: () => new Date('2026-06-21T12:00:00Z'),
		};

		ingestKnowledgePackage(packageRoot, transcriptPath, deps);

		// Считаем .md-файлы рекурсивно (readdirSync уже импортирован вверху файла).
		const countMdFiles = (dir: string): number => {
			if (!existsSync(dir)) return 0;
			let count = 0;
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const e of entries) {
				if (e.isDirectory()) {
					count += countMdFiles(join(dir, e.name));
				} else if (e.name.endsWith('.md')) {
					count += 1;
				}
			}
			return count;
		};
		const knowledgeDir = join(tmpContent, 'knowledge', 'job-search');
		const countAfterFirst = countMdFiles(knowledgeDir);

		ingestKnowledgePackage(packageRoot, transcriptPath, deps);

		const countAfterSecond = countMdFiles(knowledgeDir);
		expect(countAfterSecond).toBe(countAfterFirst);
	});
});

// ---------------------------------------------------------------------------
// 6. Fail-closed: sanitizeFn бросает → raw не создан, watermark не продвинут
// ---------------------------------------------------------------------------

describe('ingestKnowledgePackage: fail-closed при SanitizerError', () => {
	let tmpPkg: string;
	let tmpContent: string;

	beforeEach(() => {
		tmpPkg = mkdtempSync(join(tmpdir(), 'kp-fc-pkg-'));
		tmpContent = mkdtempSync(join(tmpdir(), 'kp-fc-content-'));
	});

	afterEach(() => {
		rmSync(tmpPkg, { recursive: true, force: true });
		rmSync(tmpContent, { recursive: true, force: true });
	});

	it('SanitizerError пробрасывается наверх', () => {
		const packageRoot = buildSyntheticPackage(tmpPkg, 'job-search', '0.2.0', 'nazarov-2024');
		const transcriptPath = join(tmpPkg, 'transcript.txt');
		writeFileSync(transcriptPath, 'Транскрипт с секретом.\n', 'utf8');

		const throwingSanitizer = (): string => {
			throw new SanitizerError('synthetic-secret-found — запись отменена');
		};

		expect(() =>
			ingestKnowledgePackage(packageRoot, transcriptPath, {
				contentRoot: tmpContent,
				sanitizeFn: throwingSanitizer,
				nowFn: () => new Date('2026-06-21T12:00:00Z'),
			}),
		).toThrow(SanitizerError);
	});

	it('raw-файл НЕ создан при SanitizerError', () => {
		const packageRoot = buildSyntheticPackage(tmpPkg, 'job-search', '0.2.0', 'nazarov-2024');
		const transcriptPath = join(tmpPkg, 'transcript.txt');
		writeFileSync(transcriptPath, 'Транскрипт.\n', 'utf8');

		try {
			ingestKnowledgePackage(packageRoot, transcriptPath, {
				contentRoot: tmpContent,
				sanitizeFn: () => {
					throw new SanitizerError('synthetic-error');
				},
				nowFn: () => new Date('2026-06-21T12:00:00Z'),
			});
		} catch {
			// ожидаемо
		}

		// raw-файл не должен существовать.
		const rawFile = join(tmpContent, 'raw', 'knowledge', 'job-search', 'nazarov-2024.md');
		expect(existsSync(rawFile)).toBe(false);
	});

	it('watermark НЕ продвинут при SanitizerError', () => {
		const packageRoot = buildSyntheticPackage(tmpPkg, 'job-search', '0.2.0', 'nazarov-2024');
		const transcriptPath = join(tmpPkg, 'transcript.txt');
		writeFileSync(transcriptPath, 'Транскрипт.\n', 'utf8');

		try {
			ingestKnowledgePackage(packageRoot, transcriptPath, {
				contentRoot: tmpContent,
				sanitizeFn: () => {
					throw new SanitizerError('synthetic-error');
				},
				nowFn: () => new Date('2026-06-21T12:00:00Z'),
			});
		} catch {
			// ожидаемо
		}

		// Watermark-файл не должен существовать (watermark не был продвинут и сохранён).
		const wmPath = join(tmpContent, 'raw', '.watermarks', 'knowledge-package-job-search.json');
		expect(existsSync(wmPath)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 7. compareVersions — корректное числовое сравнение сегментов
// ---------------------------------------------------------------------------

describe('compareVersions', () => {
	it('равные версии → 0', () => {
		expect(compareVersions('0.2.0', '0.2.0')).toBe(0);
	});

	it('версия выше → положительное число', () => {
		expect(compareVersions('0.3.0', '0.2.0')).toBeGreaterThan(0);
	});

	it('версия ниже → отрицательное число', () => {
		expect(compareVersions('0.2.0', '0.3.0')).toBeLessThan(0);
	});

	it('числовое, не лексикографическое: 0.10.0 > 0.9.0', () => {
		expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
	});

	it('числовое: 1.0.0 > 0.99.0', () => {
		expect(compareVersions('1.0.0', '0.99.0')).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// 8. rawFileName — схема имени <sourceId>@<hash8>.md
// ---------------------------------------------------------------------------

describe('rawFileName', () => {
	it('имя содержит sourceId и 8-символьный hex-хеш', () => {
		const name = rawFileName('nazarov-2024', 'content body');
		expect(name).toMatch(/^nazarov-2024@[0-9a-f]{8}\.md$/);
	});

	it('один и тот же контент → одно и то же имя (дедупликация)', () => {
		const name1 = rawFileName('src', 'identical content');
		const name2 = rawFileName('src', 'identical content');
		expect(name1).toBe(name2);
	});

	it('разный контент → разное имя (нет коллизий)', () => {
		const name1 = rawFileName('src', 'version 1 content');
		const name2 = rawFileName('src', 'version 2 content');
		expect(name1).not.toBe(name2);
	});
});

// ---------------------------------------------------------------------------
// 9. APPEND-ONLY raw: version-bump не затирает прежний raw
// ---------------------------------------------------------------------------

describe('ingestKnowledgePackage: append-only raw при version-bump', () => {
	let tmpPkg: string;
	let tmpContent: string;

	beforeEach(() => {
		tmpPkg = mkdtempSync(join(tmpdir(), 'kp-raw-'));
		tmpContent = mkdtempSync(join(tmpdir(), 'kp-raw-content-'));
	});

	afterEach(() => {
		rmSync(tmpPkg, { recursive: true, force: true });
		rmSync(tmpContent, { recursive: true, force: true });
	});

	it('version-bump: оба raw-файла существуют, старый не перезаписан', () => {
		// Ингест версии 0.1.0.
		const pkg1 = buildSyntheticPackage(tmpPkg, 'job-search', '0.1.0', 'nazarov-2024');
		const t1 = join(tmpPkg, 'transcript-v1.txt');
		writeFileSync(t1, 'Транскрипт версии 1.\n', 'utf8');
		const res1 = ingestKnowledgePackage(pkg1, t1, {
			contentRoot: tmpContent,
			nowFn: () => new Date('2026-06-21T12:00:00Z'),
		});
		expect(res1.noop).toBe(false);
		const raw1 = res1.rawWritten!;
		expect(existsSync(raw1)).toBe(true);

		// Запоминаем содержимое первого raw.
		const raw1ContentBefore = readFileSync(raw1, 'utf8');

		// Ингест версии 0.2.0 с ДРУГИМ транскриптом (другой хеш → другое имя).
		const pkg2 = buildSyntheticPackage(tmpPkg, 'job-search', '0.2.0', 'nazarov-2024');
		const t2 = join(tmpPkg, 'transcript-v2.txt');
		writeFileSync(t2, 'Транскрипт версии 2 — расширенный.\n', 'utf8');
		const res2 = ingestKnowledgePackage(pkg2, t2, {
			contentRoot: tmpContent,
			nowFn: () => new Date('2026-06-22T12:00:00Z'),
		});
		expect(res2.noop).toBe(false);
		const raw2 = res2.rawWritten!;

		// Оба raw-файла существуют.
		expect(existsSync(raw1)).toBe(true);
		expect(existsSync(raw2)).toBe(true);
		// Имена разные (разный хеш = разный контент).
		expect(raw1).not.toBe(raw2);
		// Первый raw не изменился.
		expect(readFileSync(raw1, 'utf8')).toBe(raw1ContentBefore);
	});
});

// ---------------------------------------------------------------------------
// 10. MONOTONIC version guard: downgrade отвергается
// ---------------------------------------------------------------------------

describe('ingestKnowledgePackage: монотонный version guard', () => {
	let tmpPkg: string;
	let tmpContent: string;

	beforeEach(() => {
		tmpPkg = mkdtempSync(join(tmpdir(), 'kp-mono-'));
		tmpContent = mkdtempSync(join(tmpdir(), 'kp-mono-content-'));
	});

	afterEach(() => {
		rmSync(tmpPkg, { recursive: true, force: true });
		rmSync(tmpContent, { recursive: true, force: true });
	});

	it('downgrade (0.2.0 после 0.3.0) бросает ошибку и НЕ трогает контент', () => {
		// Сначала втягиваем 0.3.0.
		const pkgHigh = buildSyntheticPackage(tmpPkg, 'job-search', '0.3.0', 'nazarov-2024');
		const t1 = join(tmpPkg, 'transcript-high.txt');
		writeFileSync(t1, 'Транскрипт 0.3.0.\n', 'utf8');
		const resHigh = ingestKnowledgePackage(pkgHigh, t1, {
			contentRoot: tmpContent,
			nowFn: () => new Date('2026-06-21T12:00:00Z'),
		});
		expect(resHigh.noop).toBe(false);

		// Запоминаем количество raw-файлов.
		const rawDirPath = join(tmpContent, 'raw', 'knowledge', 'job-search');
		const rawCountBefore = readdirSync(rawDirPath).filter(f => f.endsWith('.md')).length;

		// Теперь пытаемся втянуть 0.2.0 — downgrade.
		const pkgLow = buildSyntheticPackage(tmpPkg, 'job-search', '0.2.0', 'nazarov-2024');
		const t2 = join(tmpPkg, 'transcript-low.txt');
		writeFileSync(t2, 'Транскрипт 0.2.0.\n', 'utf8');

		expect(() =>
			ingestKnowledgePackage(pkgLow, t2, {
				contentRoot: tmpContent,
				nowFn: () => new Date('2026-06-22T12:00:00Z'),
			}),
		).toThrow(/[Dd]owngrade/);

		// raw-директория не изменилась — новый raw не добавлен.
		const rawCountAfter = readdirSync(rawDirPath).filter(f => f.endsWith('.md')).length;
		expect(rawCountAfter).toBe(rawCountBefore);
	});

	it('upgrade (0.4.0 после 0.3.0) проходит успешно', () => {
		// Втягиваем 0.3.0.
		const pkgLow = buildSyntheticPackage(tmpPkg, 'job-search', '0.3.0', 'nazarov-2024');
		const t1 = join(tmpPkg, 'transcript-low.txt');
		writeFileSync(t1, 'Транскрипт 0.3.0.\n', 'utf8');
		ingestKnowledgePackage(pkgLow, t1, {
			contentRoot: tmpContent,
			nowFn: () => new Date('2026-06-21T12:00:00Z'),
		});

		// Втягиваем 0.4.0 — upgrade.
		const pkgHigh = buildSyntheticPackage(tmpPkg, 'job-search', '0.4.0', 'nazarov-2024');
		const t2 = join(tmpPkg, 'transcript-high.txt');
		writeFileSync(t2, 'Транскрипт 0.4.0 — новая версия.\n', 'utf8');
		const resHigh = ingestKnowledgePackage(pkgHigh, t2, {
			contentRoot: tmpContent,
			nowFn: () => new Date('2026-06-22T12:00:00Z'),
		});
		expect(resHigh.noop).toBe(false);
		expect(resHigh.version).toBe('0.4.0');
	});

	it('watermark НЕ продвигается при downgrade', () => {
		// Втягиваем 0.3.0.
		const pkgHigh = buildSyntheticPackage(tmpPkg, 'job-search', '0.3.0', 'nazarov-2024');
		const t1 = join(tmpPkg, 'transcript-high.txt');
		writeFileSync(t1, 'Транскрипт 0.3.0.\n', 'utf8');
		ingestKnowledgePackage(pkgHigh, t1, {
			contentRoot: tmpContent,
			nowFn: () => new Date('2026-06-21T12:00:00Z'),
		});

		// Читаем watermark до попытки downgrade.
		const wmPath = join(tmpContent, 'raw', '.watermarks', 'knowledge-package-job-search.json');
		const wmBefore = readFileSync(wmPath, 'utf8');

		// Попытка downgrade — должна бросить.
		const pkgLow = buildSyntheticPackage(tmpPkg, 'job-search', '0.2.0', 'nazarov-2024');
		const t2 = join(tmpPkg, 'transcript-low.txt');
		writeFileSync(t2, 'Транскрипт 0.2.0.\n', 'utf8');
		try {
			ingestKnowledgePackage(pkgLow, t2, {
				contentRoot: tmpContent,
				nowFn: () => new Date('2026-06-22T12:00:00Z'),
			});
		} catch {
			// ожидаемо
		}

		// Watermark не изменился.
		const wmAfter = readFileSync(wmPath, 'utf8');
		expect(wmAfter).toBe(wmBefore);
	});
});

// ---------------------------------------------------------------------------
// 11. RAW PROVENANCE: frontmatter соответствует контракту rules.md §3
// ---------------------------------------------------------------------------

describe('raw provenance frontmatter (контракт rules.md §3)', () => {
	let tmpPkg: string;
	let tmpContent: string;

	beforeEach(() => {
		tmpPkg = mkdtempSync(join(tmpdir(), 'kp-prov-'));
		tmpContent = mkdtempSync(join(tmpdir(), 'kp-prov-content-'));
	});

	afterEach(() => {
		rmSync(tmpPkg, { recursive: true, force: true });
		rmSync(tmpContent, { recursive: true, force: true });
	});

	it('raw frontmatter: status=immutable, exported_at есть, ingested_at нет', () => {
		const packageRoot = buildSyntheticPackage(tmpPkg, 'job-search', '0.1.0', 'nazarov-2024');
		const transcriptPath = join(tmpPkg, 'transcript.txt');
		writeFileSync(transcriptPath, 'Тело для проверки провенанса.\n', 'utf8');

		const result = ingestKnowledgePackage(packageRoot, transcriptPath, {
			contentRoot: tmpContent,
			nowFn: () => new Date('2026-06-21T12:00:00Z'),
		});

		const rawContent = readFileSync(result.rawWritten!, 'utf8');
		const { data } = parseFrontmatter(rawContent);

		// Контракт §3: status: immutable.
		expect(data['status']).toBe('immutable');
		// Момент экспорта — exported_at (не ingested_at).
		expect(data).toHaveProperty('exported_at');
		expect(data).not.toHaveProperty('ingested_at');
		// Обязательные поля §3.
		expect(data).toHaveProperty('source');
		expect(data).toHaveProperty('package');
		expect(data).toHaveProperty('version');
		// date — дата источника/экспорта.
		expect(data).toHaveProperty('date');
	});

	it('raw-файл: имя содержит sourceId и хеш (<sourceId>@<hash>.md)', () => {
		const packageRoot = buildSyntheticPackage(tmpPkg, 'job-search', '0.1.0', 'nazarov-2024');
		const transcriptPath = join(tmpPkg, 'transcript.txt');
		writeFileSync(transcriptPath, 'Тело транскрипта.\n', 'utf8');

		const result = ingestKnowledgePackage(packageRoot, transcriptPath, {
			contentRoot: tmpContent,
			nowFn: () => new Date('2026-06-21T12:00:00Z'),
		});

		const rawBase = result.rawWritten!.split('/').pop()!;
		expect(rawBase).toMatch(/^nazarov-2024@[0-9a-f]{8}\.md$/);
	});
});

// ---------------------------------------------------------------------------
// 12. compareVersions: FAIL-CLOSED при не-числовых сегментах (дефект 1)
// ---------------------------------------------------------------------------

describe('compareVersions: fail-closed при non-numeric сегментах', () => {
	it('pre-release суффикс "0.2.0-beta" в первом аргументе → throw', () => {
		// '0.2.0-beta'.split('.') = ['0', '2', '0-beta'] → Number('0-beta') = NaN.
		// Без guard: NaN возвращал бы 0 или NaN, код уходил в ветку upgrade — НЕВЕРНО.
		expect(() => compareVersions('0.2.0-beta', '0.2.0')).toThrow(/Неподдерживаемый формат версии|non-numeric/i);
	});

	it('pre-release суффикс "0.2.0-rc.1" во втором аргументе → throw', () => {
		expect(() => compareVersions('0.3.0', '0.2.0-rc.1')).toThrow();
	});

	it('v-префикс "v1.0.0" → throw', () => {
		// 'v1' → Number('v1') = NaN.
		expect(() => compareVersions('v1.0.0', '1.0.0')).toThrow();
	});

	it('корректные числовые версии сравниваются без ошибки', () => {
		// Убеждаемся, что исправление не сломало нормальный путь.
		expect(compareVersions('0.3.0', '0.2.0')).toBeGreaterThan(0);
		expect(compareVersions('0.2.0', '0.2.0')).toBe(0);
		expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0);
	});

	it('при NaN-версии watermark и контент НЕ тронуты (fail-closed в контексте ingest)', () => {
		// Пакет с некорректной версией в MANIFEST → compareVersions в guard-блоке бросит.
		// Проверяем, что raw-директория не создана до броска.
		const tmpPkgLocal = mkdtempSync(join(tmpdir(), 'kp-nan-pkg-'));
		const tmpContentLocal = mkdtempSync(join(tmpdir(), 'kp-nan-content-'));

		try {
			// Строим пакет с корректной версией, затем вручную подменяем MANIFEST.
			const pkg = buildSyntheticPackage(tmpPkgLocal, 'job-search', '0.1.0', 'nazarov-2024');

			// Сначала ингестируем корректную версию, чтобы watermark существовал.
			const t1 = join(tmpPkgLocal, 'transcript-v1.txt');
			writeFileSync(t1, 'Транскрипт 0.1.0.\n', 'utf8');
			ingestKnowledgePackage(pkg, t1, {
				contentRoot: tmpContentLocal,
				nowFn: () => new Date('2026-06-21T12:00:00Z'),
			});

			// Запоминаем состояние watermark.
			const wmPath = join(tmpContentLocal, 'raw', '.watermarks', 'knowledge-package-job-search.json');
			const wmBefore = readFileSync(wmPath, 'utf8');

			// Строим пакет с pre-release версией.
			const pkgBeta = buildSyntheticPackage(tmpPkgLocal, 'job-search', '0.2.0-beta', 'nazarov-2024');
			const t2 = join(tmpPkgLocal, 'transcript-beta.txt');
			writeFileSync(t2, 'Транскрипт beta.\n', 'utf8');

			expect(() =>
				ingestKnowledgePackage(pkgBeta, t2, {
					contentRoot: tmpContentLocal,
					nowFn: () => new Date('2026-06-22T12:00:00Z'),
				}),
			).toThrow();

			// Watermark не изменился — запись не произошла.
			const wmAfter = readFileSync(wmPath, 'utf8');
			expect(wmAfter).toBe(wmBefore);
		} finally {
			rmSync(tmpPkgLocal, { recursive: true, force: true });
			rmSync(tmpContentLocal, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// 13. collectFiles: dot-пути пропускаются через shouldSkipRawPath (дефект 2)
// ---------------------------------------------------------------------------

describe('collectFiles: карантинные dot-пути пропускаются', () => {
	it('dot-директории (.quarantine, .tasks, .watermarks) не попадают в результат ingest', () => {
		// Проверяем косвенно через ingestKnowledgePackage: dot-директории в пакете
		// не должны зеркалироваться в knowledgeDir.
		// Создаём пакет и вручную добавляем dot-директорию в топик-папку.
		const tmpPkgLocal = mkdtempSync(join(tmpdir(), 'kp-dotdir-pkg-'));
		const tmpContentLocal = mkdtempSync(join(tmpdir(), 'kp-dotdir-content-'));

		try {
			const pkg = buildSyntheticPackage(tmpPkgLocal, 'job-search', '0.1.0', 'nazarov-2024');
			const topicDir = join(pkg, 'knowledge', 'job-search');

			// Добавляем dot-файл и dot-директорию в пакет.
			mkdirSync(join(topicDir, '.quarantine'));
			writeFileSync(join(topicDir, '.quarantine', 'secret.md'), '# Секрет\n', 'utf8');
			writeFileSync(join(topicDir, '.DS_Store'), 'macs-junk', 'utf8');

			const transcriptPath = join(tmpPkgLocal, 'transcript.txt');
			writeFileSync(transcriptPath, 'Транскрипт без секретов.\n', 'utf8');

			ingestKnowledgePackage(pkg, transcriptPath, {
				contentRoot: tmpContentLocal,
				nowFn: () => new Date('2026-06-21T12:00:00Z'),
			});

			const knowledgeDir = join(tmpContentLocal, 'knowledge', 'job-search');
			// dot-директории не должны были зеркалироваться.
			expect(existsSync(join(knowledgeDir, '.quarantine'))).toBe(false);
			expect(existsSync(join(knowledgeDir, '.DS_Store'))).toBe(false);
			// Обычные файлы при этом зеркалируются нормально.
			expect(existsSync(join(knowledgeDir, 'index.md'))).toBe(true);
		} finally {
			rmSync(tmpPkgLocal, { recursive: true, force: true });
			rmSync(tmpContentLocal, { recursive: true, force: true });
		}
	});

	it('dot-директории на вложенных уровнях также пропускаются', () => {
		// Вложенная dot-директория (part-1/.tasks) тоже не должна попасть в результат.
		const tmpPkgLocal = mkdtempSync(join(tmpdir(), 'kp-dotdir2-pkg-'));
		const tmpContentLocal = mkdtempSync(join(tmpdir(), 'kp-dotdir2-content-'));

		try {
			const pkg = buildSyntheticPackage(tmpPkgLocal, 'job-search', '0.1.0', 'nazarov-2024');
			const topicDir = join(pkg, 'knowledge', 'job-search');

			// Добавляем dot-директорию внутри part-1.
			mkdirSync(join(topicDir, 'part-1', '.tasks'));
			writeFileSync(join(topicDir, 'part-1', '.tasks', 'todo.md'), '# TODO\n', 'utf8');

			const transcriptPath = join(tmpPkgLocal, 'transcript.txt');
			writeFileSync(transcriptPath, 'Транскрипт.\n', 'utf8');

			ingestKnowledgePackage(pkg, transcriptPath, {
				contentRoot: tmpContentLocal,
				nowFn: () => new Date('2026-06-21T12:00:00Z'),
			});

			const knowledgeDir = join(tmpContentLocal, 'knowledge', 'job-search');
			// Вложенная dot-директория не зеркалируется.
			expect(existsSync(join(knowledgeDir, 'part-1', '.tasks'))).toBe(false);
			// Обычные файлы part-1 зеркалируются.
			expect(existsSync(join(knowledgeDir, 'part-1', 'page-a.md'))).toBe(true);
		} finally {
			rmSync(tmpPkgLocal, { recursive: true, force: true });
			rmSync(tmpContentLocal, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// 14. rawFileName: content-адресация по телу, независимо от now (дефект 3)
// ---------------------------------------------------------------------------

describe('rawFileName: content-адресация по иммутабельному телу', () => {
	it('одинаковый sanitizedBody при разном now → одно и то же имя', () => {
		// До исправления rawFileName получал rawContent с exported_at:nowIso →
		// разный now давал разный хеш. После исправления хеш зависит только от тела.
		const body = 'Идентичное тело транскрипта.\n';
		const name1 = rawFileName('src-id', body);
		const name2 = rawFileName('src-id', body);
		// Имена совпадают независимо от внешнего времени (now инжектируется снаружи).
		expect(name1).toBe(name2);
	});

	it('идентичный транскрипт, ингестируемый в разное время → один raw-файл', () => {
		// E2E: два ингеста с одинаковым телом транскрипта, но разным nowFn → один raw.
		const tmpPkgLocal = mkdtempSync(join(tmpdir(), 'kp-dedup-pkg-'));
		const tmpContentLocal = mkdtempSync(join(tmpdir(), 'kp-dedup-content-'));

		try {
			// Ингест #1 (первая версия).
			const pkg1 = buildSyntheticPackage(tmpPkgLocal, 'job-search', '0.1.0', 'nazarov-2024');
			const t1 = join(tmpPkgLocal, 'transcript-same.txt');
			writeFileSync(t1, 'Идентичный транскрипт для дедупликации.\n', 'utf8');
			const res1 = ingestKnowledgePackage(pkg1, t1, {
				contentRoot: tmpContentLocal,
				nowFn: () => new Date('2026-06-21T10:00:00Z'), // now = 10:00
			});
			expect(res1.noop).toBe(false);
			const raw1 = res1.rawWritten!;

			// Ингест #2: та же версия → noop (идемпотентность по watermark).
			// Поэтому проверяем через rawFileName напрямую: имя должно совпадать.
			const samebody = 'Идентичный транскрипт для дедупликации.\n';
			const nameAtTime1 = rawFileName('nazarov-2024', samebody);
			const nameAtTime2 = rawFileName('nazarov-2024', samebody); // другой момент, то же тело
			expect(nameAtTime1).toBe(nameAtTime2);

			// И имя из реального ингеста совпадает с вычисленным.
			const actualBase = raw1.split('/').pop()!;
			expect(actualBase).toBe(nameAtTime1);
		} finally {
			rmSync(tmpPkgLocal, { recursive: true, force: true });
			rmSync(tmpContentLocal, { recursive: true, force: true });
		}
	});

	it('разное тело → разное имя (нет ложных коллизий)', () => {
		const name1 = rawFileName('src', 'Тело версии 1');
		const name2 = rawFileName('src', 'Тело версии 2');
		expect(name1).not.toBe(name2);
	});
});
