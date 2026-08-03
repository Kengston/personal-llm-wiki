/**
 * scripts/career-import-evidence.mjs — прогон замера карьеры и импорт его в метрики.
 *
 * Закрывает цепочку [ADR-0028] от начала до конца:
 *   career-evidence.sh (CAREER_FORMAT=json)
 *     → иммутабельный файл снапшота в raw/career/, имя несёт snapshot_id
 *     → метрики `source: evidence` с `evidence_ref` на этот файл
 *
 * Скрипт запускается ОДИН раз: `snapshot_id` детерминирован (хеш от отсортированных
 * данных, время в него не входит), поэтому повторный прогон без изменений в репозиториях
 * даёт тот же идентификатор, тот же файл и no-op импорт — леджер не растёт.
 *
 * Запуск:  pnpm build && node scripts/career-import-evidence.mjs [--dry-run]
 *
 * Пути берутся из окружения так же, как их видит мост: CAREER_RAW_DIR → RAW_DIR/career →
 * CONTENT_ROOT/raw/career → ~/llm-wiki-content/raw/career. Реальных данных в этом файле нет.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(ROOT, 'dist', p)).href);

const dryRun = process.argv.includes('--dry-run');

const { parseEvidenceSnapshot, importEvidenceSnapshot, formatEvidenceImport } =
	await imp('ingest/career/evidence.js');
const { createCareerLedger, resolveCareerDir } = await imp('ingest/career/store.js');
const { assertPathAllowed, resolvePublicRepo } = await imp('ingest/ledger.js');

// --- 1. Замер -----------------------------------------------------------------
// Скрипт сканирует локальные git-репозитории; на полусотне репозиториев это минуты.
// Через `bash <файл>`, а не напрямую: скрипт не обязан иметь бит +x, и режим файла
// в git — не то, от чего должен зависеть запуск импорта.
let raw;
try {
	raw = execFileSync('bash', [join(ROOT, 'scripts', 'career-evidence.sh')], {
		env: { ...process.env, CAREER_FORMAT: 'json' },
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024,
	});
} catch (e) {
	// Модуль обязан сообщать о невозможности работать явно, а не стектрейсом Node.
	// Самая частая причина — не заданы CAREER_AUTHORS/CAREER_ROOTS (скрипт их не хардкодит,
	// чтобы имена авторов и пути не попадали в публичный репозиторий).
	process.stderr.write(String(e.stderr ?? e.message ?? e));
	process.stderr.write(
		'\nЗамер не собран. Нужны CAREER_AUTHORS и CAREER_ROOTS в окружении — см. шапку scripts/career-evidence.sh.\n',
	);
	process.exit(2);
}
const snapshot = parseEvidenceSnapshot(JSON.parse(raw));
console.log(
	`Замер ${snapshot.snapshot_id}: ${snapshot.total_commits} коммитов в ${snapshot.repo_count} репозиториях`,
);

// --- 2. Иммутабельный файл снапшота -------------------------------------------
// Имя несёт snapshot_id — на него ссылается metric.evidence_ref и пин варианта резюме.
const careerDir = resolveCareerDir(process.env);
const snapshotPath = join(careerDir, `evidence-${snapshot.snapshot_id}.json`);

// Тот же guard, что и у леджера: под приватный raw/career и никогда под публичный репо.
assertPathAllowed(snapshotPath, careerDir, resolvePublicRepo(process.env));

if (dryRun) {
	console.log(`[dry-run] снапшот лёг бы в ${snapshotPath}, импорт не выполняется`);
	process.exit(0);
}

mkdirSync(careerDir, { recursive: true });
// tmp + rename: обрыв на середине оставил бы полуфайл, который читатель принял бы за данные.
const tmpPath = `${snapshotPath}.tmp`;
writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
renameSync(tmpPath, snapshotPath);

// --- 3. Импорт в метрики -------------------------------------------------------
const ledger = createCareerLedger({ env: process.env });
const ref = {
	snapshot_id: snapshot.snapshot_id,
	// Путь относительно приватного репо: абсолютный путь хоста в леджер не пишем.
	path: relative(join(careerDir, '..', '..'), snapshotPath),
};
const result = importEvidenceSnapshot(ledger, snapshot, ref, new Date().toISOString());

console.log(formatEvidenceImport(result));
