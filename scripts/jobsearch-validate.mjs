/**
 * scripts/jobsearch-validate.mjs — сплошная проверка всех леджеров подсистемы ([ADR-0035]).
 *
 * Проходит все пять файлов спецификации (`companies`, `opportunities`, `applications`,
 * `application_events`, `form_answers`) и печатает каждый пропуск: файл, номер строки,
 * причина. Ненулевой код возврата при ЛЮБОМ пропуске — это то, на чём стоит `wiki:lint`
 * ([ADR-0032]): зелёный lint = ноль пропущенных записей.
 *
 * Запуск:  pnpm jobsearch:validate
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(ROOT, 'dist', p)).href);

const { validateAll } = await imp('ingest/jobsearch/write-path.js');
const { createJobsearchLedger, resolveJobsearchDir } = await imp('ingest/jobsearch/ledger.js');

const ledger = createJobsearchLedger({ env: process.env });
const skips = validateAll(ledger);

console.log(`Каталог: ${resolveJobsearchDir(process.env)}`);

if (skips.length === 0) {
	console.log('Леджеры чисты: пропусков нет.');
} else {
	console.log(`Пропусков: ${skips.length}`);
	for (const skip of skips) {
		console.log(`  ${skip.file}:${skip.line} (${skip.reason}) — ${skip.message}`);
	}
}

// exitCode, а не process.exit(): вывод в канал асинхронен, и немедленный exit обрубает
// его на границе буфера — список пропусков приходил бы оборванным ровно тогда, когда он
// длинный и потому нужен.
process.exitCode = skips.length > 0 ? 1 : 0;
