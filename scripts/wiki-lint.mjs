/**
 * scripts/wiki-lint.mjs — тонкий CLI-клей над `lintStorage` (детерминированная часть
 * операции lint, PRD US 18–20/25). Вся логика — в `src/ingest/wiki-lint.ts`, тестируется
 * там; этот файл только парсит argv и печатает результат.
 *
 * Опции:
 *   --root <путь>     корень контента (по умолчанию env-лесенка CONTENT_ROOT → ~/llm-wiki-content)
 *   --skills <путь>   каталог одного скилла (SKILL.md + references/*.md) — включает skill-* правила
 *   --links-only      только ссылочные правила — им пользуется гейт движка на своих доках
 *   --json            печатать находки как JSON-массив вместо текстового отчёта
 *
 * Только сообщает, ничего не чинит. Ненулевой код выхода при любой находке.
 *
 * Запуск: pnpm wiki:lint -- --root <путь> [--skills <путь>] [--links-only] [--json]
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(ROOT, 'dist', p)).href);

const { lintStorage, defaultContentRoot } = await imp('ingest/wiki-lint.js');

function parseArgs(argv) {
	const args = { root: null, skills: null, linksOnly: false, json: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--root') args.root = argv[++i] ?? null;
		else if (a === '--skills') args.skills = argv[++i] ?? null;
		else if (a === '--links-only') args.linksOnly = true;
		else if (a === '--json') args.json = true;
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));
const root = resolve(args.root ?? defaultContentRoot());

const findings = lintStorage(root, {
	skillsDir: args.skills ? resolve(args.skills) : undefined,
	linksOnly: args.linksOnly,
});

if (args.json) {
	console.log(JSON.stringify(findings, null, 2));
} else if (findings.length === 0) {
	console.log(`OK: находок нет (корень: ${root}).`);
} else {
	console.error(`FAIL: находок ${findings.length} (корень: ${root}):`);
	for (const f of findings) {
		const at = f.line ? `:${f.line}` : '';
		console.error(`  [${f.rule}] ${f.path}${at} — ${f.message}`);
	}
}

process.exit(findings.length > 0 ? 1 : 0);
