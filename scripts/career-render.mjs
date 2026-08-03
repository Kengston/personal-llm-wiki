/**
 * scripts/career-render.mjs — собрать вариант резюме в файл ([ADR-0028]).
 *
 * Единственное место, где реальные контакты и имя вообще появляются: они подставляются
 * из gitignored-справочника ровно здесь и уходят в документ, который лежит ВНЕ обоих
 * репозиториев (guard `assertOutsideRepos` это проверяет до записи, а не после).
 *
 * Рендер fail-closed: если в варианте есть дыра — невосстановленный `{{metric.…}}`,
 * отсутствующий перевод, незакрытый ключ справочника — документ НЕ пишется, а печатается
 * список проблем. Половинчатое резюме уходит рекрутеру незамеченным, поэтому лучше
 * не выдать его вовсе.
 *
 * Выброшенное печатается ВСЕГДА: список того, что не влезло, и есть цена отбора.
 *
 * Запуск:
 *   pnpm career:render <variant_id> [--out <путь>]
 *   pnpm career:render                # соберёт первый active-вариант
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(ROOT, 'dist', p)).href);

const { createCareerLedger, loadCareerBase } = await imp('ingest/career/store.js');
const { renderResume, formatRenderReport, missingDirectoryEntries } = await imp(
	'ingest/career/render.js',
);
const { loadRenderDirectory, writeRenderedResume, resolveDirectoryPath } = await imp(
	'ingest/career/directory.js',
);

const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const outPath = outFlag >= 0 ? args[outFlag + 1] : null;
const variantId = args.find((a) => !a.startsWith('--') && a !== outPath) ?? null;

const base = loadCareerBase(createCareerLedger({ env: process.env }));

// --- 1. Вариант ---------------------------------------------------------------
const variant = variantId
	? base.variants.find((v) => v.id === variantId)
	: (base.variants.find((v) => v.status === 'active') ?? base.variants[0]);

if (!variant) {
	console.error(
		variantId
			? `Не нашёл вариант «${variantId}». Есть: ${base.variants.map((v) => v.id).join(', ') || 'ни одного'}.`
			: 'Вариантов резюме нет. Заведите его через бота: create_variant.',
	);
	process.exit(1);
}

// --- 2. Справочник ------------------------------------------------------------
let directory;
try {
	directory = loadRenderDirectory(undefined, process.env);
} catch (e) {
	console.error(`Справочник не прочитан (${resolveDirectoryPath(process.env)}): ${String(e)}`);
	console.error('Чеклист нужных ключей: pnpm career:directory');
	process.exit(1);
}

const missing = missingDirectoryEntries(base, directory);
if (missing.length > 0) {
	console.error(`В справочнике не хватает ${missing.length} ключ(ей):`);
	for (const key of missing) console.error(`  ${key}`);
	process.exit(1);
}

// --- 3. Рендер ----------------------------------------------------------------
// asOf — месяц сборки: свежесть опыта считается относительно него. Часы живут ЗДЕСЬ,
// в CLI, а не внутри рендера: сам рендер обязан оставаться воспроизводимой чистой функцией.
const asOf = new Date().toISOString().slice(0, 7);
const result = renderResume(base, variant, directory, { asOf });

console.log(formatRenderReport(result));

if (result.markdown === null) {
	console.error('\nДокумент не собран — см. ошибки выше.');
	process.exit(1);
}

// --- 4. Запись вне репозиториев ------------------------------------------------
const target = outPath ?? join(homedir(), 'career-render', `resume-${variant.id}-${variant.lang}.md`);
try {
	writeRenderedResume(target, result.markdown, process.env);
} catch (e) {
	console.error(`\n${String(e)}`);
	process.exit(1);
}

console.log(`\nДокумент: ${target}`);
console.log('В нём подставлены реальные контакты — в репозитории он не попадает и не должен.');
