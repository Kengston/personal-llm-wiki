/**
 * scripts/migrate-2026-09-platforms.mjs — миграция воронки под реестр площадок ([ADR-0033] §5).
 *
 * По умолчанию — dry-run: читает три леджера, печатает отчёт (карта алиасов, слияния
 * компаний по домену, повторы, нормализации, инвариант) и НЕ пишет ни байта. Запись —
 * только по явному `--apply`, атомарно (временный файл рядом с целевым + rename), и
 * только если инвариант («столько же записей и то же распределение по стадиям, что и до»)
 * и финальная валидация прошли — иначе `applyMigration` бросает раньше первой записи.
 *
 * Запуск:
 *   pnpm jobsearch:migrate                          — dry-run, отчёт в stdout
 *   pnpm jobsearch:migrate -- --report path.txt      — dry-run, отчёт ещё и в файл
 *   pnpm jobsearch:migrate -- --apply                — запись после отчёта
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(ROOT, 'dist', p)).href);

const { planMigration, applyMigration, readJsonlFile } = await imp('ingest/jobsearch/migrate-platforms.js');
const { JOBSEARCH_LEDGER_FILES, resolveJobsearchDir } = await imp('ingest/jobsearch/ledger.js');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const reportFlagIdx = args.indexOf('--report');
const reportPath = reportFlagIdx >= 0 ? args[reportFlagIdx + 1] : undefined;

const dir = resolveJobsearchDir(process.env);

const input = {
	companies: readJsonlFile(join(dir, JOBSEARCH_LEDGER_FILES.companies)),
	applications: readJsonlFile(join(dir, JOBSEARCH_LEDGER_FILES.applications)),
	events: readJsonlFile(join(dir, JOBSEARCH_LEDGER_FILES.application_events)),
};

console.log(`Каталог: ${dir}`);
console.log(
	`Прочитано: компаний ${input.companies.length}, откликов ${input.applications.length}, ` +
		`событий ${input.events.length}.\n`,
);

const plan = planMigration(input);
const reportText = plan.report.lines.join('\n');
console.log(reportText);

if (reportPath) {
	writeFileSync(reportPath, `${reportText}\n`, 'utf8');
	console.log(`\nОтчёт сохранён: ${reportPath}`);
}

const planOk = plan.report.invariant.ok && plan.report.validationErrors.length === 0;

if (!apply) {
	console.log('\n[dry-run] запись не выполнена. Для записи: pnpm jobsearch:migrate -- --apply');
	process.exit(planOk ? 0 : 1);
}

try {
	applyMigration(plan, { env: process.env });
} catch (e) {
	console.error(`\nЗапись отменена: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
}

console.log('\nЗаписано. Readback:');
console.log(`  companies: ${plan.companies.length}`);
console.log(`  applications: ${plan.applications.length}`);
console.log(`  application_events: ${plan.events.length}`);
