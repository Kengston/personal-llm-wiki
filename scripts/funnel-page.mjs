/**
 * scripts/funnel-page.mjs — тонкий клей, компилирующий сводку воронки в страницу вики
 * ([PRD] US 38: «видеть сводку воронки страницей вики, которую компилирует отчёт движка,
 * чтобы читать цифры без запуска команд, зная, что источник истины остаётся леджером»).
 *
 * Читает леджеры (`applications`, `application_events`) через `createJobsearchLedger`,
 * зовёт `computeFunnel` ([ADR-0030]) и чистую `renderFunnelPage` — вся арифметика и вся
 * вёрстка живут там, этот файл только связывает источники и пишет результат.
 *
 * Помимо леджеров этот файл собирает ДВА факта, которых в самих леджерах нет:
 *   1. Карту отсечения `platform → since` — из frontmatter `wiki/jobsearch/platforms/*.md`
 *      ([ADR-0033], [PRD] US 27). `computeFunnel` её сама не строит (`funnel.ts` про реестр
 *      вики не знает и знать не должен) — без неё отсечение по площадке не применяется
 *      вовсе. Ловушка: `since: 2026-09-01` без кавычек — валидный YAML-timestamp, и
 *      `js-yaml` отдаёт его уже как `Date`, а не строку; `readPlatformCutoffs` нормализует
 *      оба варианта в один и тот же вид даты, иначе неэкранированная дата в frontmatter
 *      молча выпадала бы из карты.
 *   2. `connectedSources` для строки покрытия (D11) — фактические значения
 *      `company_source`, встреченные в леджере, а не жёстко `manual`. `JOBSEARCH_SOURCES`
 *      остаётся переопределением ПОВЕРХ этого дефолта (например, «сейчас реально
 *      подключён только X»), а не единственным источником значения.
 *
 * Опции:
 *   --root <путь>   корень контента (по умолчанию env-лесенка CONTENT_ROOT → ~/llm-wiki-content,
 *                    та же, что у `wiki:lint`/`resolveJobsearchDir`); леджеры читаются из
 *                    `<root>/raw/jobsearch/`, страница пишется в `<root>/wiki/jobsearch/funnel.md`
 *   --stdout        напечатать страницу в stdout вместо записи файла (для просмотра/CI)
 *
 * Запуск: pnpm jobsearch:funnel-page [-- --root <путь>] [--stdout]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(ROOT, 'dist', p)).href);

const { computeFunnel } = await imp('ingest/jobsearch/funnel.js');
const { renderFunnelPage } = await imp('ingest/jobsearch/funnel-page.js');
const { createJobsearchLedger } = await imp('ingest/jobsearch/ledger.js');
const { defaultContentRoot } = await imp('ingest/wiki-lint.js');
// Тот же frontmatter-парсер, что у wiki-lint (checkPlatformRegistry) — второй парсер
// YAML-заголовков в подсистеме заводить незачем, оба читают один и тот же реестр.
const { parseFrontmatter } = await imp('ingest/knowledge-package.js');
// Только константа-объект (`{port, ghostAfterDays, followUpAfterDays}`), не `loadReportConfig`:
// та требует REPORT_TOKEN (гард Fastify-сервиса, ADR-0030 Решение 3) — секрет чужой заботы,
// компиляция страницы читает те же дефолты значений, но без его гарда.
const { REPORT_DEFAULTS } = await imp('bridge/jobsearch-report.js');

function parseArgs(argv) {
	const args = { root: null, stdout: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--root') args.root = argv[++i] ?? null;
		else if (a === '--stdout') args.stdout = true;
	}
	return args;
}

/**
 * normalizeSince — `since` фронтматтера к единому виду даты (`YYYY-MM-DD`).
 *
 * `js-yaml` по умолчанию распознаёт неэкранированную ISO-дату (`since: 2026-09-01` без
 * кавычек) как `!!timestamp` и отдаёт `Date`, а не строку — это поведение самого YAML,
 * а не ошибка конкретной страницы реестра, поэтому нормализация здесь, а не правкой чужого
 * frontmatter (вне скоупа движка). Строка проходит как есть — авторы, поставившие кавычки,
 * не должны получать другой результат.
 */
function normalizeSince(value) {
	if (typeof value === 'string') return value;
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	return null;
}

/**
 * readPlatformCutoffs — карта `platform → since` из реестра площадок для `platformCutoffs`
 * ([ADR-0033]). Площадки с `since: null` (нет отсечения) в карту не попадают вовсе —
 * `computeFunnel` трактует отсутствие ключа как «без отсечения», а не как отсечение в null.
 */
function readPlatformCutoffs(root) {
	const dir = join(root, 'wiki', 'jobsearch', 'platforms');
	const cutoffs = {};
	if (!existsSync(dir)) return cutoffs;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith('.md')) continue;
		const { data } = parseFrontmatter(readFileSync(join(dir, name), 'utf8'));
		const since = normalizeSince(data.since);
		if (typeof data.id === 'string' && since) cutoffs[data.id] = since;
	}
	return cutoffs;
}

const args = parseArgs(process.argv.slice(2));
const root = args.root ? resolve(args.root) : defaultContentRoot(process.env);

const ledger = createJobsearchLedger({ dir: join(root, 'raw', 'jobsearch') });
const applications = ledger.readAll('applications');
const events = ledger.readAll('application_events');

const ghostAfterDays = Number(process.env.JOBSEARCH_GHOST_DAYS ?? REPORT_DEFAULTS.ghostAfterDays);

// JOBSEARCH_SOURCES, если задан явно, — переопределение поверх дефолта (см. шапку файла,
// пункт 2). Раньше дефолтом была жёсткая строка `'manual'`, и строка покрытия врала
// («покрывают только подключённые источники (1: manual)») даже на странице, где рядом стоят
// разрезы по hh и linkedin — сравниваем через Set, а не просто .map(), потому что в леджере
// один и тот же company_source повторяется на каждой строке.
const envSources = (process.env.JOBSEARCH_SOURCES ?? '')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);
const connectedSources =
	envSources.length > 0
		? envSources
		: [...new Set(applications.map((a) => a.company_source))].sort();

const generatedAt = new Date().toISOString();

const report = computeFunnel(applications, events, {
	asOf: generatedAt,
	ghostAfterDays: Number.isFinite(ghostAfterDays) ? ghostAfterDays : REPORT_DEFAULTS.ghostAfterDays,
	connectedSources,
	platformCutoffs: readPlatformCutoffs(root),
});

const page = renderFunnelPage(report, { generatedAt, command: 'pnpm jobsearch:funnel-page' });

if (args.stdout) {
	console.log(page);
} else {
	const outPath = join(root, 'wiki', 'jobsearch', 'funnel.md');
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, page, 'utf8');
	console.log(`Записано: ${outPath} (откликов: ${report.total}, момент: ${generatedAt})`);
}

// exitCode, а не process.exit(): вывод в канал (`--stdout | ...`) асинхронен, и немедленный
// выход обрубает его на границе буфера — та же причина, что у wiki-lint.mjs/jobsearch-validate.mjs.
process.exitCode = 0;
