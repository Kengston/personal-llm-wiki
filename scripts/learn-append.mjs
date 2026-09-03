/**
 * scripts/learn-append.mjs — единственный путь записи в журнал повторений учебного контура
 * ([ADR-0034], [ADR-0035] «Следствия»: «учебный журнал пишется тем же путём:
 * `pnpm learn:append`»). Зеркало `scripts/jobsearch-append.mjs`: тот же `appendBatch`
 * ([ingest/jobsearch/write-path.ts]), обобщённый до параметра `LedgerSpec`, применённый
 * к `LEARNING_LEDGER` вместо `JOBSEARCH_LEDGER` — второй копии «разбери stdin → провалидируй
 * каждую строку → пиши всё или ничего → readback» в проекте нет и не появится.
 *
 * Строки JSONL читаются из файла (второй позиционный аргумент) или из stdin, если файл не
 * указан. Разбор JSON — здесь, не в `write-path.ts` ([ADR-0035] §1). Каждая строка
 * валидируется `ReviewEventSchema` ДО записи; если хоть одна не проходит — на диск не уходит
 * ни одна (readback в этом случае не печатается, печатаются ошибки).
 *
 * Запуск:
 *   pnpm learn:append -- <ledger> [файл.jsonl] [--dry-run]
 *   cat reviews.jsonl | pnpm learn:append -- reviews
 *
 * <ledger> — один из: reviews
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(ROOT, 'dist', p)).href);

const { appendBatch } = await imp('ingest/jobsearch/write-path.js');
const { createLearningLedger, LEARNING_LEDGER, LEARNING_LEDGER_FILES } = await imp('ingest/learning/reviews.js');

// Ключи берём из словаря спецификации леджера, а не держим второй литерал рядом — тот же
// приём, что и у jobsearch-append.mjs/migrate-2026-09-platforms.mjs для их словарей.
const LEDGER_KEYS = Object.keys(LEARNING_LEDGER_FILES);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [ledgerKey, filePath] = args.filter((a) => !a.startsWith('--'));

// Ни одна ветка ниже не зовёт process.exit(): вывод в канал асинхронен, и немедленный
// выход обрубает его на границе буфера — список ошибок валидации приходил бы оборванным
// ровно тогда, когда он длинный (тот же дефект, что чинил a5ae63c в других скриптах).
if (!ledgerKey || !LEDGER_KEYS.includes(ledgerKey)) {
	console.error(`Укажите леджер: pnpm learn:append -- <${LEDGER_KEYS.join('|')}> [файл.jsonl] [--dry-run]`);
	process.exitCode = 2;
}

let raw;
if (!process.exitCode) {
	try {
		// fd 0 — stdin; читается синхронно, тем же способом, что и файл.
		raw = filePath ? readFileSync(filePath, 'utf8') : readFileSync(0, 'utf8');
	} catch (e) {
		console.error(`Вход не прочитан: ${String(e)}`);
		process.exitCode = 2;
	}
}

const rows = [];
if (!process.exitCode) {
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

	if (parseFailed) {
		process.exitCode = 2;
	} else if (rows.length === 0) {
		console.error('Пустой вход: ни одной строки JSONL.');
		process.exitCode = 2;
	}
}

if (!process.exitCode) {
	const ledger = createLearningLedger({ env: process.env });
	const result = appendBatch(ledger, LEARNING_LEDGER, ledgerKey, rows, { dryRun });

	if (!result.ok) {
		console.error(`Пачка НЕ записана (${result.errors.length} ошибок валидации), диск не тронут:`);
		for (const err of result.errors) console.error(`  строка ${err.line}: ${err.message}`);
		process.exitCode = 1;
	} else {
		if (result.dryRun) {
			console.log(`[dry-run] в ${result.path} легло бы ${result.records.length} записей:`);
		} else {
			console.log(`Записано ${result.written} в ${result.path}:`);
		}
		for (const record of result.records) console.log(JSON.stringify(record));
	}
}
