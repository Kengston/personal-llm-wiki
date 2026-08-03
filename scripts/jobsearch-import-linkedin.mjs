/**
 * scripts/jobsearch-import-linkedin.mjs — импорт официального экспорта LinkedIn ([ADR-0029] §2б).
 *
 * Легальный ToS-safe путь: площадка сама отдаёт архив по запросу владельца. Ни скрейпинга,
 * ни автоматизации, ни работы под учёткой — файлом и только файлом ([ADR-0009]).
 *
 * ПРАВИЛО ИМПОРТА: одна компания = одна запись. Файл целиком наружу не идёт — ось A фильтра
 * карантинит документ при пяти и более PII, а любой экспорт связей это сотни адресов, так что
 * «импортировать одним куском» означало бы не импортировать вовсе. Контактные поля третьих
 * лиц отбрасываются НА ПАРСИНГЕ и в память процесса дольше строки CSV не живут (D9).
 *
 * Из файла связей берётся ровно один производный факт — «в компании есть тёплый контакт»,
 * без персоналий.
 *
 * Запуск:  pnpm jobsearch:import-linkedin <путь-к-Connections.csv> [--dry-run]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(ROOT, 'dist', p)).href);

const { importLinkedinExport, dedupeCompanies, sourceCoverageLine } = await imp(
	'ingest/jobsearch/companies.js',
);
const { createJobsearchLedger, resolveJobsearchDir } = await imp('ingest/jobsearch/ledger.js');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const file = args.find((a) => !a.startsWith('--'));

if (!file) {
	console.error('Укажите файл экспорта: pnpm jobsearch:import-linkedin <Connections.csv>');
	process.exit(2);
}

let csv;
try {
	csv = readFileSync(file, 'utf8');
} catch (e) {
	console.error(`Файл не прочитан: ${String(e)}`);
	process.exit(1);
}

const result = importLinkedinExport(csv, new Date().toISOString());

console.log(`Строк с пригодным доменом: ${result.companies.length}, пропущено: ${result.skippedRows}.`);
if (result.droppedColumns.length > 0) {
	console.log(`Отброшены на парсинге (PII третьих лиц): ${result.droppedColumns.join(', ')}.`);
}

const ledger = createJobsearchLedger({ env: process.env });

// Дедуп ДО записи: у одного человека в экспорте компания встречается столько раз, сколько
// у него там знакомых. Ключ дедупа — домен, а не название: «Acme» / «Acme Inc» / «ACME» это
// три написания одной компании, и склеивать их по строке значит склеивать по случайности.
const existing = ledger.readAll('companies');
const fresh = dedupeCompanies(result.companies).filter(
	(c) => !existing.some((e) => e.site_domain === c.site_domain),
);

console.log(`После дедупа по домену: ${fresh.length} новых компаний.`);

if (dryRun) {
	console.log(`[dry-run] записи легли бы в ${resolveJobsearchDir(process.env)}`);
	process.exit(0);
}

for (const company of fresh) ledger.append('companies', company);

console.log(`Записано: ${fresh.length}.`);
console.log(sourceCoverageLine(['linkedin_export'], fresh.length));
