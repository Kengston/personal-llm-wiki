/**
 * wiki-lint.test.ts — по одному сценарию на правило: срабатывает на нарушении И не
 * срабатывает на корректном дереве. Тест на «не срабатывает» — не формальность: правило,
 * которое просто шумит на всём подряд, ничем не лучше отсутствующего правила.
 *
 * Шов — временный корень контента (`mkdtempSync`), как у `funnel.test.ts`. Данные
 * синтетические.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PLATFORM_IDS } from './jobsearch/companies.js';
import { lintStorage, type LintFinding } from './wiki-lint.js';

let tmpDir: string;
let root: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'wiki-lint-test-'));
	root = join(tmpDir, 'content');
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/** put — пишет файл фикстуры, создавая недостающие каталоги. */
function put(rel: string, content: string): void {
	const full = join(root, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content, 'utf8');
}

function findingsOf(rule: string, findings: LintFinding[]): LintFinding[] {
	return findings.filter((f) => f.rule === rule);
}

/** Валидный минимальный index.md — не линкует ничего лишнего. */
const INDEX_STUB = ['---', 'title: Индекс', 'type: index', '---', '', '# Индекс', ''].join('\n');

// ---------------------------------------------------------------------------
// orphan-page / index-broken-link
// ---------------------------------------------------------------------------

describe('orphan-page', () => {
	it('срабатывает: страница в wiki/ не упомянута в index.md', () => {
		put('wiki/index.md', INDEX_STUB);
		put('wiki/projects/lonely.md', '---\ntype: project\n---\n# Одинокая страница\n');

		const findings = lintStorage(root);

		const orphans = findingsOf('orphan-page', findings);
		expect(orphans).toHaveLength(1);
		expect(orphans[0]?.path).toBe(join('wiki', 'projects', 'lonely.md'));
	});

	it('не срабатывает: страница прямо линкуется из index.md', () => {
		put(
			'wiki/index.md',
			['---', 'title: Индекс', 'type: index', '---', '', '# Индекс', '', '- [Проект](./projects/linked.md)', ''].join(
				'\n',
			),
		);
		put('wiki/projects/linked.md', '---\ntype: project\n---\n# Проект\n');

		const findings = lintStorage(root);

		expect(findingsOf('orphan-page', findings)).toHaveLength(0);
	});
});

describe('index-broken-link', () => {
	it('срабатывает: index.md ссылается на несуществующий файл', () => {
		put(
			'wiki/index.md',
			['---', 'title: Индекс', 'type: index', '---', '', '- [Нет такого](./projects/ghost.md)', ''].join('\n'),
		);

		const findings = lintStorage(root);

		const broken = findingsOf('index-broken-link', findings);
		expect(broken).toHaveLength(1);
		expect(broken[0]?.message).toContain('ghost.md');
		expect(broken[0]?.line).toBeGreaterThan(0);
	});

	it('не срабатывает: все ссылки index.md резолвятся', () => {
		put(
			'wiki/index.md',
			['---', 'title: Индекс', 'type: index', '---', '', '- [Проект](./projects/real.md)', ''].join('\n'),
		);
		put('wiki/projects/real.md', '---\ntype: project\n---\n# Проект\n');

		const findings = lintStorage(root);

		expect(findingsOf('index-broken-link', findings)).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// wikilink-syntax
// ---------------------------------------------------------------------------

describe('wikilink-syntax', () => {
	it('срабатывает: [[wikilink]] где угодно в вики', () => {
		put('wiki/index.md', INDEX_STUB);
		put('wiki/projects/uses-wikilink.md', '---\ntype: project\n---\nСм. [[Другая страница]] за подробностями.\n');

		const findings = lintStorage(root);

		const hits = findingsOf('wikilink-syntax', findings);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.path).toBe(join('wiki', 'projects', 'uses-wikilink.md'));
	});

	it('не срабатывает: только относительные markdown-ссылки', () => {
		put('wiki/index.md', INDEX_STUB);
		put('wiki/projects/clean.md', '---\ntype: project\n---\nСм. [другую страницу](./other.md).\n');
		put('wiki/projects/other.md', '---\ntype: project\n---\n# Другая\n');

		const findings = lintStorage(root);

		expect(findingsOf('wikilink-syntax', findings)).toHaveLength(0);
	});

	it('не срабатывает на [[wikilink]] внутри блока кода — это иллюстрация правила, не нарушение', () => {
		put('wiki/index.md', INDEX_STUB);
		put(
			'wiki/projects/doc-example.md',
			['---', 'type: project', '---', '', 'Запрещённый синтаксис: ```[[Пример]]```', ''].join('\n'),
		);

		const findings = lintStorage(root);

		expect(findingsOf('wikilink-syntax', findings)).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// broken-relative-link
// ---------------------------------------------------------------------------

describe('broken-relative-link', () => {
	it('срабатывает: относительная ссылка не резолвится', () => {
		put('wiki/index.md', INDEX_STUB);
		put('wiki/projects/broken.md', '---\ntype: project\n---\n[Нет файла](./missing.md)\n');

		const findings = lintStorage(root);

		const hits = findingsOf('broken-relative-link', findings);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.path).toBe(join('wiki', 'projects', 'broken.md'));
	});

	it('не срабатывает: относительная ссылка резолвится, внешние ссылки не проверяются', () => {
		put('wiki/index.md', INDEX_STUB);
		put(
			'wiki/projects/ok.md',
			['---', 'type: project', '---', '[Сосед](./sibling.md)', '[Внешняя](https://example.com/x)', ''].join('\n'),
		);
		put('wiki/projects/sibling.md', '---\ntype: project\n---\n# Сосед\n');

		const findings = lintStorage(root);

		expect(findingsOf('broken-relative-link', findings)).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// missing-type
// ---------------------------------------------------------------------------

describe('missing-type', () => {
	it('срабатывает: страница без frontmatter вовсе', () => {
		put('wiki/index.md', INDEX_STUB);
		put('wiki/projects/no-frontmatter.md', '# Просто страница\n\nБез frontmatter.\n');

		const findings = lintStorage(root);

		const hits = findingsOf('missing-type', findings);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.message).toContain('без frontmatter');
	});

	it('срабатывает: frontmatter есть, но без type', () => {
		put('wiki/index.md', INDEX_STUB);
		put('wiki/projects/no-type.md', '---\ntitle: Без типа\n---\n# Страница\n');

		const findings = lintStorage(root);

		const hits = findingsOf('missing-type', findings);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.message).toContain('type');
	});

	it('не срабатывает: frontmatter с type присутствует', () => {
		put('wiki/index.md', INDEX_STUB);
		put('wiki/projects/typed.md', '---\ntitle: С типом\ntype: project\n---\n# Страница\n');

		const findings = lintStorage(root);

		expect(findingsOf('missing-type', findings)).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// invalid-ledger-record
// ---------------------------------------------------------------------------

describe('invalid-ledger-record', () => {
	it('срабатывает: битая JSON-строка в companies.jsonl', () => {
		put('raw/jobsearch/companies.jsonl', '{not valid json\n');

		const findings = lintStorage(root);

		const hits = findingsOf('invalid-ledger-record', findings);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.line).toBe(1);
		expect(hits[0]?.path).toBe(join('raw', 'jobsearch', 'companies.jsonl'));
	});

	it('срабатывает: запись reviews.jsonl не проходит схему (box_after вне диапазона)', () => {
		const bad = {
			ts: '2026-09-01T00:00:00Z',
			concept: 'spaced-repetition',
			kind: 'lesson',
			box_after: 9, // вне диапазона 1–5
		};
		put('raw/learning/reviews.jsonl', JSON.stringify(bad) + '\n');

		const findings = lintStorage(root);

		const hits = findingsOf('invalid-ledger-record', findings);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.path).toBe(join('raw', 'learning', 'reviews.jsonl'));
	});

	it('не срабатывает: валидные записи в обоих леджерах', () => {
		const company = {
			id: 'acme-example-com',
			site_domain: 'acme.example.com',
			name: 'Acme',
			company_type: { value: 'unknown', source: 'manual', confirmed_by_human: false, confirmed_at: null },
			stage: { value: 'unknown', source: 'manual', confirmed_by_human: false, confirmed_at: null },
			remote_mode: { value: 'unknown', source: 'manual', confirmed_by_human: false, confirmed_at: null },
			hires_contractors: { value: 'unknown', source: 'manual', confirmed_by_human: false, confirmed_at: null },
			work_permit_required: { value: 'unknown', source: 'manual', confirmed_by_human: false, confirmed_at: null },
			interview_language: { value: 'unknown', source: 'manual', confirmed_by_human: false, confirmed_at: null },
			hq_country: { value: 'unknown', source: 'manual', confirmed_by_human: false, confirmed_at: null },
			timezone_overlap: { value: 'unknown', source: 'manual', confirmed_by_human: false, confirmed_at: null },
			has_warm_contact: { value: 'unknown', source: 'manual', confirmed_by_human: false, confirmed_at: null },
			hiring_status: { value: 'unknown', source: 'manual', confirmed_by_human: false, confirmed_at: null },
			fit_rank: 0,
			provenance: {
				company_source: 'manual',
				fetched_at: '2026-09-01T00:00:00Z',
				parser_version: 'test-1',
				robots_ok: true,
			},
			ts: '2026-09-01T00:00:00Z',
		};
		put('raw/jobsearch/companies.jsonl', JSON.stringify(company) + '\n');

		const review = {
			ts: '2026-09-01T00:00:00Z',
			concept: 'spaced-repetition',
			kind: 'lesson',
			box_after: 2,
		};
		put('raw/learning/reviews.jsonl', JSON.stringify(review) + '\n');

		const findings = lintStorage(root);

		expect(findingsOf('invalid-ledger-record', findings)).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// platform-page-unknown-id / platform-id-missing-page
// ---------------------------------------------------------------------------

function platformPage(id: string, extra = ''): string {
	return ['---', `id: ${id}`, 'type: platform', 'kind: aggregator', '---', extra].join('\n');
}

describe('platform-page-unknown-id', () => {
	it('срабатывает: id страницы реестра отсутствует в PLATFORM_IDS', () => {
		put('wiki/jobsearch/platforms/indeed.md', platformPage('indeed'));

		const findings = lintStorage(root);

		const hits = findingsOf('platform-page-unknown-id', findings);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.message).toContain('indeed');
	});

	it('не срабатывает: все id страниц реестра есть в PLATFORM_IDS', () => {
		for (const id of PLATFORM_IDS) put(`wiki/jobsearch/platforms/${id}.md`, platformPage(id));

		const findings = lintStorage(root);

		expect(findingsOf('platform-page-unknown-id', findings)).toHaveLength(0);
	});
});

describe('platform-id-missing-page', () => {
	it('срабатывает: у id из PLATFORM_IDS нет страницы реестра', () => {
		// Ни одной страницы вообще — весь словарь PLATFORM_IDS должен быть отмечен.
		const findings = lintStorage(root);

		const hits = findingsOf('platform-id-missing-page', findings);
		expect(hits.length).toBe(PLATFORM_IDS.length);
	});

	it('не срабатывает: у каждого id из PLATFORM_IDS есть страница', () => {
		for (const id of PLATFORM_IDS) put(`wiki/jobsearch/platforms/${id}.md`, platformPage(id));

		const findings = lintStorage(root);

		expect(findingsOf('platform-id-missing-page', findings)).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// source-without-concept
// ---------------------------------------------------------------------------

describe('source-without-concept', () => {
	it('срабатывает: выжимка (type: source) без единой ссылки на концепцию', () => {
		put('wiki/sources/talk.md', '---\ntype: source\ntitle: Доклад\n---\nПересказ без ссылок на концепции.\n');

		const findings = lintStorage(root);

		const hits = findingsOf('source-without-concept', findings);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.path).toBe(join('wiki', 'sources', 'talk.md'));
	});

	it('не срабатывает: выжимка ссылается на концепцию', () => {
		put(
			'wiki/sources/talk.md',
			'---\ntype: source\ntitle: Доклад\n---\nСм. концепцию [Каденция](../concepts/cadence.md).\n',
		);

		const findings = lintStorage(root);

		expect(findingsOf('source-without-concept', findings)).toHaveLength(0);
	});

	it('не срабатывает на странице wiki/sources/ без type: source', () => {
		put('wiki/sources/not-a-source.md', '---\ntype: project\n---\nЭто не выжимка.\n');

		const findings = lintStorage(root);

		expect(findingsOf('source-without-concept', findings)).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// --skills: skill-missing-shelf-path / skill-direct-jsonl-write / skill-unknown-platform-id
// ---------------------------------------------------------------------------

describe('--skills skill-missing-shelf-path', () => {
	it('срабатывает: путь к полке упомянут, но не существует на диске', () => {
		const skillsDir = join(tmpDir, 'skills', 'jobsearch-run');
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(join(skillsDir, 'SKILL.md'), 'Скилл хранилища ~/llm-wiki-content.\nПараметры прогона лежат в `wiki/jobsearch/run-params.md`.\n');

		const findings = lintStorage(root, { skillsDir });

		const hits = findingsOf('skill-missing-shelf-path', findings);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.message).toContain('run-params.md');
	});

	it('не срабатывает: упомянутый путь существует', () => {
		put('wiki/jobsearch/run-params.md', '---\ntype: run-params\n---\n# Параметры\n');
		const skillsDir = join(tmpDir, 'skills', 'jobsearch-run');
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(join(skillsDir, 'SKILL.md'), 'Скилл хранилища ~/llm-wiki-content.\nПараметры прогона лежат в `wiki/jobsearch/run-params.md`.\n');

		const findings = lintStorage(root, { skillsDir });

		expect(findingsOf('skill-missing-shelf-path', findings)).toHaveLength(0);
	});

	it('без опции --skills правило не выполняется вовсе', () => {
		const findings = lintStorage(root);

		expect(findingsOf('skill-missing-shelf-path', findings)).toHaveLength(0);
	});

	it('находит скиллы в глубине дерева, а не только SKILL.md в самом каталоге', () => {
		// Так гейт и запускается: --skills ~/.claude, где каждый скилл лежит в своём
		// подкаталоге. Плоская проверка «SKILL.md прямо здесь» на таком пути молчит при
		// любом содержимом скиллов — то есть даёт зелёный отчёт, ничего не проверив.
		const rootDir = join(tmpDir, 'claude-home');
		const nested = join(rootDir, 'skills', 'jobsearch-daily');
		mkdirSync(join(nested, 'references'), { recursive: true });
		writeFileSync(join(nested, 'SKILL.md'), 'Скилл хранилища ~/llm-wiki-content.\nЖивые заметки в `raw/jobsearch/open-tails.md`.\n');
		writeFileSync(
			join(nested, 'references', 'routine.md'),
			'Адрес дневника хранилища llm-wiki-content — `raw/jobsearch/diary-url.txt`.\n',
		);

		const hits = findingsOf('skill-missing-shelf-path', lintStorage(root, { skillsDir: rootDir }));

		expect(hits).toHaveLength(2);
		expect(hits.map((h) => h.path).sort()).toEqual([
			'skills/jobsearch-daily/SKILL.md',
			'skills/jobsearch-daily/references/routine.md',
		]);
	});

	it('не срабатывает на скрытом каталоге внутри полки — движок заводит его при первой записи', () => {
		const skillsDir = join(tmpDir, 'skills', 'personal-llm-wiki');
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(
			join(skillsDir, 'SKILL.md'),
			'Хранилище llm-wiki-content: карантин в `raw/.quarantine/`, чоры в `raw/.tasks/`.\n',
		);

		expect(findingsOf('skill-missing-shelf-path', lintStorage(root, { skillsDir }))).toEqual([]);
	});

	it('игнорирует скилл, который это хранилище вообще не упоминает', () => {
		// У скилла чужого проекта свои `docs/` и `raw/`, и они означают его репозиторий.
		// Без этого отбора правило на живом каталоге выдавало два десятка находок по
		// tutor-plus и abcage-mcp-hub — отчёт, который перестают читать целиком.
		const rootDir = join(tmpDir, 'claude-home-3');
		const foreign = join(rootDir, 'skills', 'tutor-plus');
		mkdirSync(foreign, { recursive: true });
		writeFileSync(join(foreign, 'SKILL.md'), 'Фазы проекта лежат в `docs/phases/`.\n');

		expect(findingsOf('skill-missing-shelf-path', lintStorage(root, { skillsDir: rootDir }))).toEqual(
			[],
		);
	});

	it('голое имя полки не делает чужой скилл своим', () => {
		// Реальный случай: у соседнего скилла про MCP-хаб `wiki` — это имя сервера, а не
		// путь. Пока признак «своего» принимал голый токен, весь чужой `docs/` начинал
		// числиться мёртвыми путями хранилища — двенадцать находок ни о чём.
		put('wiki/index.md', INDEX_STUB);
		const rootDir = join(tmpDir, 'claude-home-4');
		const foreign = join(rootDir, 'skills', 'mcp-hub');
		mkdirSync(foreign, { recursive: true });
		writeFileSync(
			join(foreign, 'SKILL.md'),
			'Сервер `wiki` отвечает на `/mcp/wiki`. Фазы проекта — в `docs/phases/`.\n',
		);

		expect(findingsOf('skill-missing-shelf-path', lintStorage(root, { skillsDir: rootDir }))).toEqual(
			[],
		);
	});

	it('не заходит в plugins и projects: чужие скиллы живут по своим правилам', () => {
		const rootDir = join(tmpDir, 'claude-home-2');
		for (const dir of ['plugins', 'projects']) {
			mkdirSync(join(rootDir, dir, 'foreign'), { recursive: true });
			writeFileSync(
				join(rootDir, dir, 'foreign', 'SKILL.md'),
				'Чужой скилл проекта llm-wiki-content читает `wiki/nothing-here.md`.\n',
			);
		}

		expect(findingsOf('skill-missing-shelf-path', lintStorage(root, { skillsDir: rootDir }))).toEqual(
			[],
		);
	});
});

describe('OWN_STORAGE_MARKER: свой скилл без строки-маркера, но с путём в реальное дерево хранилища', () => {
	it('скилл без "llm-wiki-content"/"Второй мозг" в тексте признаётся своим по backtick-пути в СУЩЕСТВУЮЩЕЕ дерево хранилища', () => {
		// jobsearch-system называет полки хранилища кодом (`raw/jobsearch/…`), ни разу не
		// произнося литерал "llm-wiki-content" — раньше такой скилл вообще не проходил отбор,
		// и ни одно skill-правило на него не смотрело ([PLAN] находка 3).
		put('raw/jobsearch/companies.jsonl', '');
		const skillsDir = join(tmpDir, 'skills', 'jobsearch-system');
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(
			join(skillsDir, 'SKILL.md'),
			'Леджер компаний лежит в `raw/jobsearch/companies.jsonl`.\nПараметры прогона — на странице `wiki/jobsearch/run-params.md`.\n',
		);

		const hits = findingsOf('skill-missing-shelf-path', lintStorage(root, { skillsDir }));

		expect(hits).toHaveLength(1);
		expect(hits[0]?.message).toContain('run-params.md');
	});

	it('не ослабляет отсечение чужих скиллов: путь на полку без маркера, которого НЕТ в этом хранилище на диске, — скилл остаётся чужим', () => {
		const skillsDir = join(tmpDir, 'skills', 'tutor-plus');
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(join(skillsDir, 'SKILL.md'), 'Фазы проекта лежат в `docs/phases/`.\n');

		expect(findingsOf('skill-missing-shelf-path', lintStorage(root, { skillsDir }))).toEqual([]);
	});

	it('не ослабляет отсечение чужих скиллов: тот же случай для abcage-mcp-hub', () => {
		const skillsDir = join(tmpDir, 'skills', 'abcage-mcp-hub');
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(join(skillsDir, 'SKILL.md'), 'Конфиг хаба лежит в `docs/upstreams.md`.\n');

		expect(findingsOf('skill-missing-shelf-path', lintStorage(root, { skillsDir }))).toEqual([]);
	});
});

describe('--skills skill-missing-shelf-path: абсолютная тильда-форма', () => {
	it('срабатывает: путь дан абсолютной тильда-формой `~/llm-wiki-content/…` и не существует на диске', () => {
		// Обе реальные запланированные задачи (jobsearch-daily, learn-review) пишут пути
		// ИСКЛЮЧИТЕЛЬНО этой формой — раньше символ `~` не входил в класс символов
		// backtick-регулярки, и такой путь для правила не был путём вовсе ([PLAN] находка 2).
		const skillsDir = join(tmpDir, 'skills', 'learn-review');
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(
			join(skillsDir, 'SKILL.md'),
			'Скилл хранилища ~/llm-wiki-content.\nАдрес дневника — `~/llm-wiki-content/work/jobsearch/diary-url.txt`.\n',
		);

		const hits = findingsOf('skill-missing-shelf-path', lintStorage(root, { skillsDir }));

		expect(hits).toHaveLength(1);
		expect(hits[0]?.message).toContain('diary-url.txt');
	});

	it('не срабатывает: тот же путь абсолютной тильда-формой существует на диске хранилища', () => {
		put('work/jobsearch/diary-url.txt', 'https://example.com/x\n');
		const skillsDir = join(tmpDir, 'skills', 'learn-review');
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(
			join(skillsDir, 'SKILL.md'),
			'Скилл хранилища ~/llm-wiki-content.\nАдрес дневника — `~/llm-wiki-content/work/jobsearch/diary-url.txt`.\n',
		);

		expect(findingsOf('skill-missing-shelf-path', lintStorage(root, { skillsDir }))).toEqual([]);
	});

	it('срезает `$CONTENT_ROOT/` так же, как тильда-форму', () => {
		const skillsDir = join(tmpDir, 'skills', 'jobsearch-daily');
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(
			join(skillsDir, 'SKILL.md'),
			'Скилл хранилища ~/llm-wiki-content.\nПараметры прогона — `$CONTENT_ROOT/wiki/jobsearch/run-params.md`.\n',
		);

		const hits = findingsOf('skill-missing-shelf-path', lintStorage(root, { skillsDir }));

		expect(hits).toHaveLength(1);
		expect(hits[0]?.message).toContain('run-params.md');
	});
});

describe('--skills skill-direct-jsonl-write', () => {
	it('срабатывает: инструкция дозаписать строку в .jsonl напрямую', () => {
		const skillsDir = join(tmpDir, 'skills', 'jobsearch-run');
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(
			join(skillsDir, 'SKILL.md'),
			'Скилл хранилища ~/llm-wiki-content.\nПосле подачи допишите строку в applications.jsonl вручную.\n',
		);

		const findings = lintStorage(root, { skillsDir });

		expect(findingsOf('skill-direct-jsonl-write', findings)).toHaveLength(1);
	});

	it('не срабатывает: запись описана командой CLI', () => {
		const skillsDir = join(tmpDir, 'skills', 'jobsearch-run');
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(
			join(skillsDir, 'SKILL.md'),
			'Скилл хранилища ~/llm-wiki-content.\nПосле подачи запишите строку в applications.jsonl командой `pnpm jobsearch:append -- applications`.\n',
		);

		const findings = lintStorage(root, { skillsDir });

		expect(findingsOf('skill-direct-jsonl-write', findings)).toHaveLength(0);
	});

	it('срабатывает: команда названа в шаге 1, а инструкция дозаписать строку — в шаге 9, вдали от неё', () => {
		// Раньше санкция проверялась по ВСЕМУ документу: одно упоминание команды где угодно
		// снимало находку со всего файла, включая инструкцию прямой дозаписи через восемь
		// шагов после неё — ровно так были устроены jobsearch-run:123, jobsearch-daily:137
		// и routine.md:46, ради которых правило и заведено ([PLAN] находка 1).
		const skillsDir = join(tmpDir, 'skills', 'learn-review');
		mkdirSync(skillsDir, { recursive: true });
		const doc = [
			'Скилл хранилища ~/llm-wiki-content.',
			'### Шаг 1. Запись',
			'',
			'Запись идёт командой `pnpm learn:append -- reviews`.',
			'',
			'### Шаг 9. Если команда недоступна',
			'',
			'Если CLI не запускается, дописать строку в reviews.jsonl вручную.',
			'',
		].join('\n');
		writeFileSync(join(skillsDir, 'SKILL.md'), doc);

		const findings = lintStorage(root, { skillsDir });

		const hits = findingsOf('skill-direct-jsonl-write', findings);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.line).toBe(8); // строка «дописать строку в reviews.jsonl», не строка с командой
	});
});

describe('--skills skill-unknown-platform-id', () => {
	it('срабатывает: упомянута площадка вне PLATFORM_IDS', () => {
		const skillsDir = join(tmpDir, 'skills', 'jobsearch-run');
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(join(skillsDir, 'SKILL.md'), 'Скилл хранилища ~/llm-wiki-content.\nНовая площадка: platform: indeed — пока не в реестре.\n');

		const findings = lintStorage(root, { skillsDir });

		const hits = findingsOf('skill-unknown-platform-id', findings);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.message).toContain('indeed');
	});

	it('не срабатывает: площадка есть в PLATFORM_IDS', () => {
		const skillsDir = join(tmpDir, 'skills', 'jobsearch-run');
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(join(skillsDir, 'SKILL.md'), 'Скилл хранилища ~/llm-wiki-content.\nПлощадка platform: hh идёт первой в порядке обхода.\n');

		const findings = lintStorage(root, { skillsDir });

		expect(findingsOf('skill-unknown-platform-id', findings)).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// --links-only
// ---------------------------------------------------------------------------

describe('--links-only', () => {
	it('оставляет только ссылочные правила: невалидный леджер и frontmatter не отмечаются', () => {
		put('wiki/index.md', INDEX_STUB);
		put('wiki/projects/no-type.md', '# Без frontmatter\n');
		put('raw/jobsearch/companies.jsonl', '{not valid json\n');

		const findings = lintStorage(root, { linksOnly: true });

		expect(findingsOf('missing-type', findings)).toHaveLength(0);
		expect(findingsOf('invalid-ledger-record', findings)).toHaveLength(0);
		// но сама страница остаётся орфаном — это ссылочное правило.
		expect(findingsOf('orphan-page', findings)).toHaveLength(1);
	});

	it('работает на произвольном дереве доков без wiki/index.md — молча, без падения', () => {
		put('adr/0001-example.md', '# ADR\n\n[Битая](./nowhere.md)\n');

		const findings = lintStorage(root, { linksOnly: true });

		expect(findingsOf('broken-relative-link', findings)).toHaveLength(1);
		expect(findingsOf('orphan-page', findings)).toHaveLength(0);
		expect(findingsOf('index-broken-link', findings)).toHaveLength(0);
	});
});
