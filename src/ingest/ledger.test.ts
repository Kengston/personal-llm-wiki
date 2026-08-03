/**
 * ledger.test.ts — тесты параметризованного леджера ([ADR-0028], «Следствия»).
 *
 * Главное, что здесь доказывается: спека модуля определяет КАТАЛОГ, и леджер
 * одного модуля физически не умеет писать в каталог другого. До параметризации
 * каталог был один (`raw/finance/`), и «дописать два ключа в карту схем» увело бы
 * воронку поиска работы в финансовый каталог — ровно это [ADR-0030] («Следствия»)
 * требует закрыть тестом рядом с path-guard'ом.
 *
 * Данные синтетические (`example.com`), как требует [ADR-0003] и `pnpm lint:public`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	Ledger,
	LedgerPathError,
	LedgerValidationError,
	resolvePublicRepo,
	type LedgerSkip,
	type LedgerSpec,
} from './ledger.js';

// ---------------------------------------------------------------------------
// Синтетическая спека: имитирует будущую воронку поиска работы ([ADR-0030]),
// но не тянет её схемы — слайс S1 про механику, а не про модель данных.
// ---------------------------------------------------------------------------

const ApplicationStubSchema = z.object({
	id: z.string().min(1),
	company_id: z.string().min(1),
	applied_at: z.string().min(1),
});

type ApplicationStub = z.infer<typeof ApplicationStubSchema>;

type JobsearchStubMap = { applications: ApplicationStub };

/** resolveDir как у будущего модуля воронки: `<CONTENT_ROOT>/raw/jobsearch`. */
function resolveJobsearchStubDir(env: NodeJS.ProcessEnv): string {
	const contentRoot = env.CONTENT_ROOT ?? join(tmpdir(), 'llm-wiki-content-absent');
	return resolve(join(contentRoot, 'raw', 'jobsearch'));
}

const JOBSEARCH_STUB: LedgerSpec<JobsearchStubMap> = {
	files: { applications: 'applications.jsonl' },
	schemas: { applications: ApplicationStubSchema },
	resolveDir: resolveJobsearchStubDir,
};

const SYNTHETIC_APPLICATION: ApplicationStub = {
	id: 'app-0001',
	company_id: 'acme-example-com',
	applied_at: '2026-08-02T10:00:00Z',
};

let tmpDir: string;
let publicFake: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'ledger-param-test-'));
	// Публичный репо — заведомо другое поддерево, чтобы guard разрешал запись.
	publicFake = join(tmpDir, 'public-fake');
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Каталог берётся из спеки — DoD слайса S1
// ---------------------------------------------------------------------------

describe('Ledger — каталог задаётся спекой модуля', () => {
	it('леджер воронки пишет в raw/jobsearch/, а не в raw/finance/', () => {
		// CONTENT_ROOT указывает на tmp-дерево; каталог резолвит СПЕКА, а не класс.
		const env = { CONTENT_ROOT: tmpDir } as NodeJS.ProcessEnv;
		const ledger = new Ledger(JOBSEARCH_STUB, { env, publicRepoRoot: publicFake });

		ledger.append('applications', SYNTHETIC_APPLICATION);

		const expected = join(tmpDir, 'raw', 'jobsearch', 'applications.jsonl');
		expect(existsSync(expected)).toBe(true);
		// Финансового каталога не появилось вовсе — воронка о нём не знает.
		expect(existsSync(join(tmpDir, 'raw', 'finance'))).toBe(false);

		const written: unknown = JSON.parse(readFileSync(expected, 'utf8').trim());
		expect(written).toEqual(SYNTHETIC_APPLICATION);
	});

	it('явный dir переопределяет резолвер спеки', () => {
		const dir = join(tmpDir, 'custom', 'jobsearch');
		const ledger = new Ledger(JOBSEARCH_STUB, { dir, publicRepoRoot: publicFake });

		expect(ledger.filePath('applications')).toBe(join(dir, 'applications.jsonl'));

		ledger.append('applications', SYNTHETIC_APPLICATION);
		expect(existsSync(join(dir, 'applications.jsonl'))).toBe(true);
	});

	it('запись мимо своего каталога отбивается path-guard-ом', () => {
		// Каталог леджера — jobsearch; цель — finance. assertPathAllowed внутри append
		// сверяет цель с this.dir, поэтому подмена каталога = отказ, а не тихая запись.
		const jobsearchDir = join(tmpDir, 'raw', 'jobsearch');
		const financeDir = join(tmpDir, 'raw', 'finance');

		// Спека с именем файла, уводящим за пределы каталога (симуляция ошибки конфигурации).
		const escapingSpec: LedgerSpec<JobsearchStubMap> = {
			...JOBSEARCH_STUB,
			files: { applications: '../finance/applications.jsonl' },
		};
		const ledger = new Ledger(escapingSpec, { dir: jobsearchDir, publicRepoRoot: publicFake });

		expect(() => ledger.append('applications', SYNTHETIC_APPLICATION)).toThrow(LedgerPathError);
		expect(existsSync(financeDir)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 2. Path-guard против публичного репо — поведение не изменилось при выносе
// ---------------------------------------------------------------------------

describe('Ledger — guard публичного репо', () => {
	it('LedgerPathError если каталог модуля лежит под публичным репо', () => {
		const publicRoot = join(tmpDir, 'public-repo');
		const dir = join(publicRoot, 'raw', 'jobsearch'); // ← ВНУТРИ публичного!
		const ledger = new Ledger(JOBSEARCH_STUB, { dir, publicRepoRoot: publicRoot });

		let thrown: LedgerPathError | null = null;
		try {
			ledger.append('applications', SYNTHETIC_APPLICATION);
		} catch (e) {
			if (e instanceof LedgerPathError) thrown = e;
		}

		expect(thrown).toBeInstanceOf(LedgerPathError);
		expect(thrown!.message).toContain('публичного репо');
		expect(existsSync(join(dir, 'applications.jsonl'))).toBe(false);
	});

	it('resolvePublicRepo указывает на корень пакета (глубина пути после выноса)', () => {
		// Файл переехал из src/ingest/finance/ в src/ingest/ — количество уровней
		// до корня изменилось с трёх на два. Проверяем не арифметику, а результат:
		// в найденном каталоге лежит package.json этого пакета.
		const root = resolvePublicRepo({} as NodeJS.ProcessEnv);
		expect(existsSync(join(root, 'package.json'))).toBe(true);
	});

	it('env.PUBLIC_REPO имеет приоритет над вычислением по пути модуля', () => {
		const root = resolvePublicRepo({ PUBLIC_REPO: tmpDir } as NodeJS.ProcessEnv);
		expect(root).toBe(resolve(tmpDir));
	});
});

// ---------------------------------------------------------------------------
// 3. Валидация и чтение
// ---------------------------------------------------------------------------

describe('Ledger — валидация и чтение', () => {
	it('невалидная запись не доходит до файла', () => {
		const dir = join(tmpDir, 'raw', 'jobsearch');
		const ledger = new Ledger(JOBSEARCH_STUB, { dir, publicRepoRoot: publicFake });

		expect(() =>
			// @ts-expect-error — намеренно нарушаем схему: company_id обязателен.
			ledger.append('applications', { id: 'app-0002', applied_at: '2026-08-02T10:00:00Z' }),
		).toThrow(LedgerValidationError);

		expect(existsSync(join(dir, 'applications.jsonl'))).toBe(false);
	});

	it('readAll на отсутствующем файле возвращает пустой массив', () => {
		const dir = join(tmpDir, 'raw', 'jobsearch');
		const ledger = new Ledger(JOBSEARCH_STUB, { dir, publicRepoRoot: publicFake });

		expect(ledger.readAll('applications')).toEqual([]);
	});

	it('битые строки пропускаются и попадают в onSkip с номером строки', () => {
		// До параметризации пропуск уходил в stderr и вызывающему был невидим:
		// «прочитали 1 из 3» и «прочитали 3 из 3» выглядели одинаково.
		const dir = join(tmpDir, 'raw', 'jobsearch');
		const skips: LedgerSkip[] = [];
		const ledger = new Ledger(JOBSEARCH_STUB, {
			dir,
			publicRepoRoot: publicFake,
			onSkip: (s) => skips.push(s),
		});

		ledger.append('applications', SYNTHETIC_APPLICATION);
		// Дописываем руками мусор: строка 2 — не JSON, строка 3 — JSON не по схеме.
		writeFileSync(
			join(dir, 'applications.jsonl'),
			'{не json\n' + JSON.stringify({ id: 'app-0003' }) + '\n',
			{ flag: 'a' },
		);

		const records = ledger.readAll('applications');

		expect(records).toEqual([SYNTHETIC_APPLICATION]);
		expect(skips).toHaveLength(2);
		expect(skips[0]).toMatchObject({ key: 'applications', line: 2, reason: 'json' });
		expect(skips[1]).toMatchObject({ key: 'applications', line: 3, reason: 'schema' });
	});
});
