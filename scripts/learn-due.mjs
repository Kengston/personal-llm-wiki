/**
 * scripts/learn-due.mjs — детерминированный список «что пора повторять» ([ADR-0034]).
 *
 * Читает `raw/learning/reviews.jsonl` целиком и печатает `due()`: просроченные концепции
 * (коробка по возрастанию, давность по убыванию) плюс одну интерливинг-добавку из
 * непросроченных. Арифметику дат и выбор темы делает движок, не LLM — вызывающий скилл
 * (`learn-review`) только читает готовый список.
 *
 * Запуск:  pnpm learn:due [--json]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(ROOT, 'dist', p)).href);

const { createLearningLedger, due } = await imp('ingest/learning/reviews.js');

const asJson = process.argv.slice(2).includes('--json');

const ledger = createLearningLedger({ env: process.env });
const entries = ledger.readAll('reviews');
const result = due(entries);

if (asJson) {
	console.log(JSON.stringify(result, null, 2));
	process.exit(0);
}

if (result.length === 0) {
	console.log('Повторять нечего: журнал пуст или всё повторено вовремя.');
	process.exit(0);
}

console.log(`Пора повторять (${result.length}):`);
for (const entry of result) {
	const mark = entry.overdue ? '!' : '~';
	const label = entry.overdue ? 'просрочено' : 'добавка';
	const days = entry.daysSinceReview.toFixed(1);
	console.log(
		`  ${mark} ${entry.concept} — box ${entry.box}, не повторялась ${days} дн. (${label})`,
	);
}
