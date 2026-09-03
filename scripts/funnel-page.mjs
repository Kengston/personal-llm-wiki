/**
 * scripts/funnel-page.mjs — тонкий клей, компилирующий сводку воронки в страницу вики
 * ([PRD] US 38: «видеть сводку воронки страницей вики, которую компилирует отчёт движка,
 * чтобы читать цифры без запуска команд, зная, что источник истины остаётся леджером»).
 *
 * Читает леджеры (`applications`, `application_events`) через `createJobsearchLedger`,
 * зовёт `computeFunnel` ([ADR-0030]) и чистую `renderFunnelPage` — вся арифметика и вся
 * вёрстка живут там, этот файл только связывает источники и пишет результат.
 *
 * Опции:
 *   --root <путь>   корень контента (по умолчанию env-лесенка CONTENT_ROOT → ~/llm-wiki-content,
 *                    та же, что у `wiki:lint`/`resolveJobsearchDir`); леджеры читаются из
 *                    `<root>/raw/jobsearch/`, страница пишется в `<root>/wiki/jobsearch/funnel.md`
 *   --stdout        напечатать страницу в stdout вместо записи файла (для просмотра/CI)
 *
 * Запуск: pnpm jobsearch:funnel-page [-- --root <путь>] [--stdout]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(ROOT, 'dist', p)).href);

const { computeFunnel } = await imp('ingest/jobsearch/funnel.js');
const { renderFunnelPage } = await imp('ingest/jobsearch/funnel-page.js');
const { createJobsearchLedger } = await imp('ingest/jobsearch/ledger.js');
const { defaultContentRoot } = await imp('ingest/wiki-lint.js');
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

const args = parseArgs(process.argv.slice(2));
const root = args.root ? resolve(args.root) : defaultContentRoot(process.env);

const ledger = createJobsearchLedger({ dir: join(root, 'raw', 'jobsearch') });

const ghostAfterDays = Number(process.env.JOBSEARCH_GHOST_DAYS ?? REPORT_DEFAULTS.ghostAfterDays);
const connectedSources = (process.env.JOBSEARCH_SOURCES ?? 'manual')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);

const generatedAt = new Date().toISOString();

const report = computeFunnel(ledger.readAll('applications'), ledger.readAll('application_events'), {
	asOf: generatedAt,
	ghostAfterDays: Number.isFinite(ghostAfterDays) ? ghostAfterDays : REPORT_DEFAULTS.ghostAfterDays,
	connectedSources,
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
