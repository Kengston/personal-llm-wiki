/**
 * wiki-lint.ts — детерминированная часть операции lint хранилища ([ADR-0032] §lint,
 * PRD «Хранилище под трекер поиска работы и обучение» US 18–20, US 25).
 *
 * `lintStorage(root, opts)` — чистая функция: читает дерево контент-репо, ничего не
 * чинит и не пишет, возвращает список находок. Семантический проход (противоречия,
 * устаревшее) — отдельная LLM-обвязка поверх этого отчёта и в этот файл не входит
 * ([PRD] «детерминированная часть lint — команда движка, семантическая — отдельный
 * проход агента»).
 *
 * Три вещи, которые здесь неочевидны:
 *
 *   1. ОРФАН — БУКВАЛЬНО ПО СПЕКЕ, НЕ ТРАНЗИТИВНО. «Страница есть в `wiki/`, а
 *      `wiki/index.md` на неё не ссылается» проверяется ПРЯМОЙ ссылкой из индекса, а
 *      не обходом графа через хаб-страницы. Хаб вроде `wiki/jobsearch/decisions.md`,
 *      который сам линкует дальше на площадки, не освобождает их от прямой ссылки из
 *      индекса — так сформулировано задание, и находку так проще объяснить человеку,
 *      чем «где-то в глубине графа путь есть».
 *
 *   2. `reviews.jsonl` ВАЛИДИРУЕТСЯ ЧУЖИМ ЛЕДЖЕРОМ, НЕ КОПИЕЙ СХЕМЫ. Спецификация живёт в
 *      `src/ingest/learning/reviews.ts` ([ADR-0034] §2) — этот файл только импортирует
 *      `createLearningLedger`, как проверка jobsearch-леджеров импортирует
 *      `createJobsearchLedger`. Второй копии словаря `kind`/`box_after` в проекте нет.
 *
 *   3. КОД-БЛОКИ МАСКИРУЮТСЯ ПЕРЕД ПОИСКОМ ССЫЛОК. Доки самого движка (ADR, гайд)
 *      законно показывают `[[wikilink]]` и примеры битых ссылок как иллюстрацию того,
 *      что запрещено. Без маскирования тройных и одинарных backtick-блоков
 *      `--links-only`-гейт движка на собственной документации получил бы находки на
 *      собственных примерах правила.
 */

import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

import type { LedgerSkip } from './ledger.js';
import { PLATFORM_IDS } from './jobsearch/companies.js';
import {
	createJobsearchLedger,
	JOBSEARCH_LEDGER_FILES,
	type JobsearchFileKey,
} from './jobsearch/ledger.js';
import { createLearningLedger, LEARNING_LEDGER_FILES } from './learning/reviews.js';
import { parseFrontmatter } from './knowledge-package.js';

// ---------------------------------------------------------------------------
// Модель находки
// ---------------------------------------------------------------------------

/** LintFinding — одна находка lint'а. `line` есть не у всех правил (напр., frontmatter). */
export interface LintFinding {
	/** Rule-id: kebab-case, по одному на правило из PRD US 18/25. */
	rule: string;
	/** Путь ОТНОСИТЕЛЬНО `root` (или `skillsDir` для skill-* правил) — POSIX/OS-разделитель как отдаёт node:path. */
	path: string;
	/** 1-based номер строки, если применимо к правилу. */
	line?: number;
	message: string;
}

export interface LintOptions {
	/** Каталог одного скилла (`SKILL.md` + `references/*.md`) — включает skill-* правила. */
	skillsDir?: string;
	/**
	 * Только ссылочные правила: orphan-page, index-broken-link, wikilink-syntax,
	 * broken-relative-link. Им пользуется гейт движка на СВОИХ доках (`--root docs`
	 * без `wiki/index.md`) — там frontmatter/леджеры/реестр площадок неприменимы,
	 * а ссылочные правила молча не находят `wiki/index.md` и просто не срабатывают,
	 * не падая.
	 */
	linksOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Корень контента по умолчанию — та же лесенка, что у `resolveJobsearchDir`
// ---------------------------------------------------------------------------

export function defaultContentRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env.CONTENT_ROOT ?? join(homedir(), 'llm-wiki-content');
}

// ---------------------------------------------------------------------------
// Обход markdown-дерева
// ---------------------------------------------------------------------------

const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'build']);

/** walkMarkdownFiles — рекурсивно собирает `.md` под `dir`. Скрытые каталоги (`.git`, `.watermarks`, …) пропускаются. */
function walkMarkdownFiles(dir: string): string[] {
	const out: string[] = [];
	if (!existsSync(dir)) return out;

	const walk = (d: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name.startsWith('.') || SKIP_DIR_NAMES.has(e.name)) continue;
			const full = join(d, e.name);
			if (e.isDirectory()) walk(full);
			else if (e.isFile() && e.name.endsWith('.md')) out.push(full);
		}
	};
	walk(dir);
	return out.sort();
}

// ---------------------------------------------------------------------------
// Разбор ссылок
// ---------------------------------------------------------------------------

interface RawLink {
	target: string;
	index: number;
}

/** maskCode — гасит содержимое тройных и одинарных backtick-блоков пробелами (длина и переносы строк сохраняются — номера строк не едут). */
function maskCode(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ' '))
		.replace(/`[^`\n]*`/g, (block) => block.replace(/[^\n]/g, ' '));
}

function extractMdLinks(text: string): RawLink[] {
	const out: RawLink[] = [];
	for (const m of text.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)) {
		if (m.index === undefined || m[2] === undefined) continue;
		out.push({ target: m[2].trim(), index: m.index });
	}
	return out;
}

function extractWikilinks(text: string): { index: number }[] {
	const out: { index: number }[] = [];
	for (const m of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
		if (m.index === undefined) continue;
		out.push({ index: m.index });
	}
	return out;
}

/** isExternalLink — http(s)/протокол-относительная ссылка, mailto/tel или чистый якорь `#…`: файл на диске не ищем. */
function isExternalLink(target: string): boolean {
	const t = target.trim();
	if (!t || t.startsWith('#')) return true;
	if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(t)) return true;
	return /^(mailto|tel):/i.test(t);
}

function resolveRelativeLink(fromFile: string, target: string): string {
	const clean = (target.split('#')[0] ?? '').split('?')[0]!.trim();
	return resolve(dirname(fromFile), clean);
}

function lineFromIndex(text: string, index: number): number {
	return text.slice(0, index).split('\n').length;
}

// ---------------------------------------------------------------------------
// Правило: orphan-page / index-broken-link
// ---------------------------------------------------------------------------

function checkIndexLinks(root: string): LintFinding[] {
	const wikiRoot = join(root, 'wiki');
	const indexPath = join(wikiRoot, 'index.md');
	if (!existsSync(indexPath)) return [];

	const findings: LintFinding[] = [];
	const text = readFileSync(indexPath, 'utf8');
	const masked = maskCode(text);
	const linkedAbs = new Set<string>();

	for (const { target, index } of extractMdLinks(masked)) {
		if (isExternalLink(target)) continue;
		const resolved = resolveRelativeLink(indexPath, target);
		if (!existsSync(resolved)) {
			findings.push({
				rule: 'index-broken-link',
				path: relative(root, indexPath),
				line: lineFromIndex(text, index),
				message: `wiki/index.md ссылается на несуществующий файл: ${target}`,
			});
		} else {
			linkedAbs.add(resolved);
		}
	}

	for (const page of walkMarkdownFiles(wikiRoot)) {
		if (page === indexPath) continue;
		if (!linkedAbs.has(page)) {
			findings.push({
				rule: 'orphan-page',
				path: relative(root, page),
				message: 'страница есть в wiki/, но wiki/index.md на неё не ссылается',
			});
		}
	}

	return findings;
}

// ---------------------------------------------------------------------------
// Правило: wikilink-syntax / broken-relative-link
// ---------------------------------------------------------------------------

function checkLinksInTree(root: string): LintFinding[] {
	const findings: LintFinding[] = [];

	for (const file of walkMarkdownFiles(root)) {
		const text = readFileSync(file, 'utf8');
		const masked = maskCode(text);

		for (const { index } of extractWikilinks(masked)) {
			findings.push({
				rule: 'wikilink-syntax',
				path: relative(root, file),
				line: lineFromIndex(text, index),
				message: 'найден [[wikilink]] — правило хранилища допускает только относительные markdown-ссылки',
			});
		}

		for (const { target, index } of extractMdLinks(masked)) {
			if (isExternalLink(target)) continue;
			const resolved = resolveRelativeLink(file, target);
			if (!existsSync(resolved)) {
				findings.push({
					rule: 'broken-relative-link',
					path: relative(root, file),
					line: lineFromIndex(text, index),
					message: `битая относительная ссылка: ${target}`,
				});
			}
		}
	}

	return findings;
}

// ---------------------------------------------------------------------------
// Правило: missing-type
// ---------------------------------------------------------------------------

function checkFrontmatterType(root: string): LintFinding[] {
	const wikiRoot = join(root, 'wiki');
	const findings: LintFinding[] = [];

	for (const page of walkMarkdownFiles(wikiRoot)) {
		const raw = readFileSync(page, 'utf8');
		if (!raw.startsWith('---')) {
			findings.push({
				rule: 'missing-type',
				path: relative(root, page),
				message: 'страница вики без frontmatter',
			});
			continue;
		}
		const { data } = parseFrontmatter(raw);
		if (!('type' in data)) {
			findings.push({
				rule: 'missing-type',
				path: relative(root, page),
				message: 'frontmatter есть, но без поля type',
			});
		}
	}

	return findings;
}

// ---------------------------------------------------------------------------
// Правило: invalid-ledger-record (jobsearch + reviews)
// ---------------------------------------------------------------------------

function describeSkip(skip: LedgerSkip): string {
	return skip.reason === 'json'
		? `не парсится JSON: ${skip.message}`
		: `не проходит схему: ${skip.message}`;
}

function checkLedgers(root: string): LintFinding[] {
	const findings: LintFinding[] = [];
	// publicRepoRoot гарантированно не совпадёт ни с одним реальным путём — readAll() его
	// не использует (guard срабатывает только в append()), но конструктор Ledger требует значение.
	const neverPublicRoot = join(root, '.wiki-lint-never-public');

	const jobsearchDir = join(root, 'raw', 'jobsearch');
	const jobsearchLedger = createJobsearchLedger({
		dir: jobsearchDir,
		publicRepoRoot: neverPublicRoot,
		onSkip: (skip) => {
			findings.push({
				rule: 'invalid-ledger-record',
				path: relative(root, join(jobsearchDir, JOBSEARCH_LEDGER_FILES[skip.key as JobsearchFileKey])),
				line: skip.line,
				message: describeSkip(skip),
			});
		},
	});
	for (const key of Object.keys(JOBSEARCH_LEDGER_FILES) as JobsearchFileKey[]) {
		jobsearchLedger.readAll(key);
	}

	const learningDir = join(root, 'raw', 'learning');
	const learningLedger = createLearningLedger({
		dir: learningDir,
		publicRepoRoot: neverPublicRoot,
		onSkip: (skip) => {
			findings.push({
				rule: 'invalid-ledger-record',
				path: relative(root, join(learningDir, LEARNING_LEDGER_FILES.reviews)),
				line: skip.line,
				message: describeSkip(skip),
			});
		},
	});
	learningLedger.readAll('reviews');

	return findings;
}

// ---------------------------------------------------------------------------
// Правило: platform-page-unknown-id / platform-id-missing-page
// ---------------------------------------------------------------------------

function checkPlatformRegistry(root: string): LintFinding[] {
	const findings: LintFinding[] = [];
	const platformsDir = join(root, 'wiki', 'jobsearch', 'platforms');
	const seenIds = new Set<string>();

	if (existsSync(platformsDir)) {
		for (const name of readdirSync(platformsDir)) {
			if (!name.endsWith('.md')) continue;
			const file = join(platformsDir, name);
			const { data } = parseFrontmatter(readFileSync(file, 'utf8'));
			const id = typeof data.id === 'string' ? data.id : null;
			if (!id) continue; // страница без id — не сфера этого правила (ловит missing-type)
			seenIds.add(id);
			if (!(PLATFORM_IDS as readonly string[]).includes(id)) {
				findings.push({
					rule: 'platform-page-unknown-id',
					path: relative(root, file),
					message: `id "${id}" отсутствует в PLATFORM_IDS движка`,
				});
			}
		}
	}

	for (const id of PLATFORM_IDS) {
		if (!seenIds.has(id)) {
			findings.push({
				rule: 'platform-id-missing-page',
				path: relative(root, join(platformsDir, `${id}.md`)),
				message: `PLATFORM_IDS содержит "${id}", но страницы реестра нет`,
			});
		}
	}

	return findings;
}

// ---------------------------------------------------------------------------
// Правило: source-without-concept
// ---------------------------------------------------------------------------

function checkSourcesLinkConcepts(root: string): LintFinding[] {
	const sourcesDir = join(root, 'wiki', 'sources');
	if (!existsSync(sourcesDir)) return [];

	const findings: LintFinding[] = [];
	for (const name of readdirSync(sourcesDir)) {
		if (!name.endsWith('.md')) continue;
		const file = join(sourcesDir, name);
		const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'));
		if (data.type !== 'source') continue;

		const linksToConcept = extractMdLinks(maskCode(body)).some(
			({ target }) => !isExternalLink(target) && /(^|\/)concepts\//.test(target),
		);
		if (!linksToConcept) {
			findings.push({
				rule: 'source-without-concept',
				path: relative(root, file),
				message: 'выжимка (type: source) не ссылается ни на одну концепцию',
			});
		}
	}

	return findings;
}

// ---------------------------------------------------------------------------
// --skills: skill-missing-shelf-path / skill-direct-jsonl-write / skill-unknown-platform-id
// ---------------------------------------------------------------------------

const SHELF_PREFIXES = new Set(['wiki', 'raw', 'work', 'learning', 'docs', 'knowledge', 'reminders']);

/**
 * Каталоги, в которые обход не заходит. `plugins` и `projects` — чужие скиллы и рабочее
 * состояние сессий: их пути к полкам этого хранилища ничего не значат, и находки оттуда
 * были бы шумом, который научит игнорировать весь отчёт.
 */
const SKILL_SCAN_SKIP = new Set([
	'plugins',
	'projects',
	'node_modules',
	'.git',
	'todos',
	'statsig',
	'shell-snapshots',
]);

/**
 * collectSkillDocs — все документы скиллов под переданным каталогом.
 *
 * Обход рекурсивный, и это не удобство, а условие работоспособности правила: гейт
 * запускается на `~/.claude`, где скиллы лежат по своим подкаталогам, а плоская проверка
 * «SKILL.md прямо здесь» на таком пути не находит НИЧЕГО и возвращает зелёный отчёт при
 * любом содержимом скиллов. Проверено на бэкапе доregroom-версий: плоский вариант молчал
 * там, где мёртвых путей и прямой дозаписи JSONL было в избытке.
 *
 * Симлинки не разворачиваются: `~/.claude/skills` держит ссылки на чужие репозитории, и
 * заходить в них значит проверять чужие правила своим уставом.
 */
/**
 * Скилл считается говорящим про ЭТО хранилище, только если он его называет.
 *
 * Без этого фильтра правило шумит на весь каталог скиллов: `docs/adr/`, `docs/phases/`,
 * `raw/` встречаются у скиллов совсем других проектов и означают там их собственные
 * репозитории. Находки «путь не существует» по чужим полкам не просто бесполезны — они
 * приучают пролистывать отчёт целиком, и тогда правило перестаёт работать и для своих.
 */
const OWN_STORAGE_MARKER = /llm-wiki-content|Второ\w+ мозг/i;

function collectSkillDocs(skillsDir: string): string[] {
	const docs: string[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 6) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.isSymbolicLink()) continue;
			if (e.isDirectory()) {
				if (SKILL_SCAN_SKIP.has(e.name)) continue;
				walk(join(dir, e.name), depth + 1);
			} else if (e.name === 'SKILL.md' || (e.name.endsWith('.md') && basename(dir) === 'references')) {
				docs.push(join(dir, e.name));
			}
		}
	};
	walk(skillsDir, 0);

	// Отбор идёт по СКИЛЛУ целиком, а не по отдельному файлу: хранилище обычно названо в
	// SKILL.md, а пути к полкам расписаны в его references/ — проверять их порознь значило
	// бы терять ровно те файлы, ради которых правило и заведено.
	const skillRootOf = (doc: string): string =>
		basename(dirname(doc)) === 'references' ? dirname(dirname(doc)) : dirname(doc);
	const ownSkillRoots = new Set<string>();
	for (const doc of docs) {
		const skillRoot = skillRootOf(doc);
		if (ownSkillRoots.has(skillRoot)) continue;
		if (OWN_STORAGE_MARKER.test(readFileSync(doc, 'utf8'))) ownSkillRoots.add(skillRoot);
	}
	return docs.filter((doc) => ownSkillRoots.has(skillRootOf(doc)));
}

/** checkSkillShelfPaths — backtick-путь на известную полку, которого нет на диске хранилища. */
function checkSkillShelfPaths(root: string, skillsDir: string): LintFinding[] {
	const findings: LintFinding[] = [];
	for (const doc of collectSkillDocs(skillsDir)) {
		const text = readFileSync(doc, 'utf8');
		for (const m of text.matchAll(/`([a-zA-Z0-9_./-]+)`/g)) {
			const mentioned = m[1]!;
			const topSegment = mentioned.split('/')[0] ?? '';
			if (!SHELF_PREFIXES.has(topSegment)) continue;
			if (mentioned.includes('<') || mentioned.includes('*')) continue; // шаблон/glob — не конкретный путь
			if (existsSync(join(root, mentioned))) continue;
			findings.push({
				rule: 'skill-missing-shelf-path',
				path: relative(skillsDir, doc),
				message: `упомянут путь к полке "${mentioned}", которого нет на диске хранилища`,
			});
		}
	}
	return findings;
}

const JSONL_WRITE_VERB_RE = /допиш\w*|запиш\w*|добав\w*\s+строк\w*|appendFileSync|writeFileSync/i;
const SANCTIONED_CLI_RE = /jobsearch:append|learn:append|jobsearch-append|learn-append/;

/** checkSkillDirectJsonlWrite — инструкция дозаписать строку прямо в .jsonl, минуя CLI ([ADR-0035]). */
function checkSkillDirectJsonlWrite(skillsDir: string): LintFinding[] {
	const findings: LintFinding[] = [];
	for (const doc of collectSkillDocs(skillsDir)) {
		const text = readFileSync(doc, 'utf8');
		if (SANCTIONED_CLI_RE.test(text)) continue; // запись уже описана командой — ОК
		const lines = text.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			if (/\.jsonl\b/.test(line) && JSONL_WRITE_VERB_RE.test(line)) {
				findings.push({
					rule: 'skill-direct-jsonl-write',
					path: relative(skillsDir, doc),
					line: i + 1,
					message: 'похоже на инструкцию дозаписать строку в .jsonl напрямую — запись должна быть описана только командой CLI',
				});
			}
		}
	}
	return findings;
}

/**
 * checkSkillPlatformMentions — id площадки, которого нет в PLATFORM_IDS.
 *
 * Токен считается идентификатором площадки только там, где он назван им синтаксически:
 * после `platform:` / `applied_via:` или внутри пути страницы реестра
 * `wiki/jobsearch/platforms/<id>.md`. Прежняя эвристика «строка со словом площадк… плюс
 * любой backtick-токен» ловила соседние слова — на живом дереве она объявила площадкой
 * поле `order` из фразы про порядок обхода площадок. Ложная находка в детерминированной
 * проверке дороже пропущенной: её нельзя ни подтвердить, ни починить.
 */
const PLATFORM_ID_MENTION_RE =
	/(?:platform|applied_via)\s*[:=]\s*`?([a-z][a-z0-9_-]{1,30})`?|platforms\/([a-z][a-z0-9_-]{1,30})\.md/g;

function checkSkillPlatformMentions(skillsDir: string): LintFinding[] {
	const findings: LintFinding[] = [];
	for (const doc of collectSkillDocs(skillsDir)) {
		const lines = readFileSync(doc, 'utf8').split('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			for (const m of line.matchAll(PLATFORM_ID_MENTION_RE)) {
				const id = m[1] ?? m[2] ?? '';
				if (!id || id === 'id') continue; // `platforms/<id>.md` — шаблон, а не площадка
				if (!(PLATFORM_IDS as readonly string[]).includes(id)) {
					findings.push({
						rule: 'skill-unknown-platform-id',
						path: relative(skillsDir, doc),
						line: i + 1,
						message: `упомянута площадка "${id}", которой нет в PLATFORM_IDS`,
					});
				}
			}
		}
	}
	return findings;
}

// ---------------------------------------------------------------------------
// lintStorage — сводит все правила
// ---------------------------------------------------------------------------

export function lintStorage(root: string, opts: LintOptions = {}): LintFinding[] {
	const findings: LintFinding[] = [
		...checkLinksInTree(root),
		...checkIndexLinks(root),
	];

	if (opts.linksOnly) return findings;

	findings.push(
		...checkFrontmatterType(root),
		...checkLedgers(root),
		...checkPlatformRegistry(root),
		...checkSourcesLinkConcepts(root),
	);

	if (opts.skillsDir) {
		findings.push(
			...checkSkillShelfPaths(root, opts.skillsDir),
			...checkSkillDirectJsonlWrite(opts.skillsDir),
			...checkSkillPlatformMentions(opts.skillsDir),
		);
	}

	return findings;
}
