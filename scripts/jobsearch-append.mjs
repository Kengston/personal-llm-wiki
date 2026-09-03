/**
 * scripts/jobsearch-append.mjs — единственный путь записи в леджер подсистемы ([ADR-0035]).
 *
 * Строки JSONL читаются из файла (второй позиционный аргумент) или из stdin, если файл не
 * указан. Разбор JSON — здесь, а не в `write-path.ts`: функция получает уже готовые значения
 * ([ADR-0035] §1). Каждая строка валидируется схемой ДО записи; если хоть одна не проходит —
 * на диск не уходит ни одна (readback в этом случае не печатается, печатаются ошибки).
 *
 * Запуск:
 *   pnpm jobsearch:append -- <ledger> [файл.jsonl] [--dry-run]
 *   cat companies.jsonl | pnpm jobsearch:append -- companies
 *
 * <ledger> — один из: companies | opportunities | applications | application_events | form_answers
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(ROOT, 'dist', p)).href);

const { appendBatch } = await imp('ingest/jobsearch/write-path.js');
const { createJobsearchLedger } = await imp('ingest/jobsearch/ledger.js');

const LEDGER_KEYS = ['companies', 'opportunities', 'applications', 'application_events', 'form_answers'];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [ledgerKey, filePath] = args.filter((a) => !a.startsWith('--'));

if (!ledgerKey || !LEDGER_KEYS.includes(ledgerKey)) {
	console.error(
		`Укажите леджер: pnpm jobsearch:append -- <${LEDGER_KEYS.join('|')}> [файл.jsonl] [--dry-run]`,
	);
	process.exit(2);
}

let raw;
try {
	// fd 0 — stdin; читается синхронно, тем же способом, что и файл.
	raw = filePath ? readFileSync(filePath, 'utf8') : readFileSync(0, 'utf8');
} catch (e) {
	console.error(`Вход не прочитан: ${String(e)}`);
	process.exit(2);
}

const rows = [];
let parseFailed = false;
raw.split('\n').forEach((line, i) => {
	const trimmed = line.trim();
	if (!trimmed) return;
	try {
		rows.push(JSON.parse(trimmed));
	} catch (e) {
		console.error(`Строка ${i + 1} входа: не JSON — ${String(e)}`);
		parseFailed = true;
	}
});

if (parseFailed) process.exit(2);
if (rows.length === 0) {
	console.error('Пустой вход: ни одной строки JSONL.');
	process.exit(2);
}

const ledger = createJobsearchLedger({ env: process.env });
const result = appendBatch(ledger, ledgerKey, rows, { dryRun });

if (!result.ok) {
	console.error(`Пачка НЕ записана (${result.errors.length} ошибок валидации), диск не тронут:`);
	for (const err of result.errors) console.error(`  строка ${err.line}: ${err.message}`);
	process.exit(1);
}

if (result.dryRun) {
	console.log(`[dry-run] в ${result.path} легло бы ${result.records.length} записей:`);
} else {
	console.log(`Записано ${result.written} в ${result.path}:`);
}
for (const record of result.records) console.log(JSON.stringify(record));
