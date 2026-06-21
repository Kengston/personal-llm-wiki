/**
 * knowledge-package.ts — оркестратор ингеста портативного knowledge-package в приватный контент-репо.
 *
 * Назначение ([ADR-0022]): зеркалить дерево пакета knowledge/<topic>/** в
 * <contentRoot>/knowledge/<topic>/ с трансформацией frontmatter под контракт хранителя;
 * прогнать транскрипт через fail-closed-sanitizer в иммутабельный raw/.
 * Идемпотентность — по версии пакета (watermark).
 *
 * Использование:
 *   node dist/ingest/knowledge-package.js <packageRoot> <transcriptPath>
 *
 * Переменные окружения:
 *   CONTENT_ROOT — путь к приватному контент-репо (по умолчанию ~/llm-wiki-content)
 */
import { createHash } from 'node:crypto';
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';

import { DateTime } from 'luxon';
import * as yaml from 'js-yaml';

import { isMainModule } from '../core/cli.js';
import { failClosedSanitize, SanitizerError } from './sanitizer.js';
import { shouldSkipRawPath } from './classifier.js';
import { Watermark } from './watermark.js';

// ---------------------------------------------------------------------------
// Разрешение путей (по образцу finance/ledger.ts resolveFinanceDir)
// ---------------------------------------------------------------------------

/**
 * resolveContentRoot — возвращает корень приватного контент-репо.
 * Приоритет: env.CONTENT_ROOT → ~/llm-wiki-content.
 */
export function resolveContentRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env['CONTENT_ROOT'] ?? join(homedir(), 'llm-wiki-content');
}

// ---------------------------------------------------------------------------
// Вспомогательные чистые функции (экспортируются для тестов)
// ---------------------------------------------------------------------------

/**
 * parseFrontmatter — разбивает raw-строку на { data, body }.
 * Если frontmatter не обнаружен (нет открывающего '---') — data={}, body=raw.
 */
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
	// Frontmatter начинается с '---' в самом начале файла.
	if (!raw.startsWith('---')) {
		return { data: {}, body: raw };
	}
	// Ищем закрывающий разделитель начиная со второй строки.
	const afterOpen = raw.slice(3);
	const closeIdx = afterOpen.search(/\n---(\n|$)/);
	if (closeIdx === -1) {
		// Незакрытый frontmatter — трактуем как нет frontmatter.
		return { data: {}, body: raw };
	}
	const yamlSource = afterOpen.slice(0, closeIdx);
	// '\n---\n' = 5 символов (\n + --- + \n); всё после = тело документа (как есть, без нормализации).
	const body = afterOpen.slice(closeIdx + 5);
	let data: Record<string, unknown>;
	try {
		const parsed = yaml.load(yamlSource);
		data =
			parsed && typeof parsed === 'object' && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: {};
	} catch {
		// Битый YAML — возвращаем пустые данные, тело сохраняем.
		data = {};
	}
	return { data, body };
}

/**
 * serializeFrontmatter — собирает markdown-строку с frontmatter.
 * lineWidth: -1 — запрет переноса строк (детерминированный diff).
 * Точная обратная функция к parseFrontmatter независимо от первого символа body.
 */
export function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
	const yamlStr = yaml.dump(data, { lineWidth: -1 });
	// body пишем как есть; обрамляем только открывающим/закрывающим '---\n'.
	return `---\n${yamlStr}---\n${body}`;
}

/**
 * deriveFreshness — вычисляет эвристику свежести источника по дате.
 * Принимает 'YYYY-MM' или 'YYYY-MM-DD'. Разница в месяцах до now:
 *   ≤12 → 'current', ≤24 → 'aging', >24 → 'stale'.
 */
export function deriveFreshness(
	sourceDate: string,
	now: Date,
): 'current' | 'aging' | 'stale' {
	// Нормализуем до 'YYYY-MM-DD' перед парсингом.
	const normalized = sourceDate.length === 7 ? `${sourceDate}-01` : sourceDate;
	const dt = DateTime.fromISO(normalized);
	if (!dt.isValid) return 'stale';
	const nowDt = DateTime.fromJSDate(now);
	// diffNow в месяцах (дробное число); нас интересует насколько СТАРЫЙ источник.
	const diffMonths = nowDt.diff(dt, 'months').months;
	if (diffMonths <= 12) return 'current';
	if (diffMonths <= 24) return 'aging';
	return 'stale';
}

/**
 * claimId — детерминированный идентификатор утверждения.
 * 'claim_' + sha256(slug + '::' + text).hex[:4]
 */
export function claimId(slug: string, text: string): string {
	const digest = createHash('sha256')
		.update(slug + '::' + text)
		.digest('hex')
		.slice(0, 4);
	return `claim_${digest}`;
}

/**
 * transformFrontmatter — нормализует frontmatter страницы пакета под контракт хранителя.
 * Не мутирует вход.
 *
 * Правила ([ADR-0022]):
 *  1. sources: ТЗ-форма {id?,ref?,source_date?} → object-форма {name,date,freshness,url}.
 *  2. claims: строки → {id,text,status,sources} без confidence.
 *  3. Наличие type → status:'active' + last_updated. Отсутствие type → не трогать.
 *  4. Прочие поля — сохранить.
 */
export interface TransformContext {
	/** Относительный POSIX-путь от директории целевой страницы до raw-файла транскрипта. */
	url: string;
	/** ISO-строка текущего момента в TZ +03:00. */
	nowIso: string;
	/** Слаг страницы (для claimId). */
	slug: string;
	/** Текущее время (для deriveFreshness). */
	now: Date;
}

export function transformFrontmatter(
	data: Record<string, unknown>,
	ctx: TransformContext,
): Record<string, unknown> {
	// --- Трансформация sources ---------------------------------------------------
	let sources: unknown = data['sources'];
	if (Array.isArray(sources)) {
		sources = sources.map((src: unknown) => {
			if (src && typeof src === 'object' && !Array.isArray(src)) {
				const s = src as Record<string, unknown>;
				// Уже в object-форме (есть name && url) — оставляем как есть.
				if (s['name'] !== undefined && s['url'] !== undefined) return s;
				// ТЗ-форма: {id?, ref?, source_date?} → конвертируем.
				const rawDate = (s['source_date'] ?? s['date']) as string | undefined;
				return {
					name: s['ref'] ?? s['id'] ?? 'источник',
					date: rawDate,
					freshness: rawDate ? deriveFreshness(rawDate, ctx.now) : 'stale',
					url: ctx.url,
				};
			}
			return src;
		});
	}

	// --- Трансформация claims ----------------------------------------------------
	let claims: unknown = data['claims'];
	if (Array.isArray(claims)) {
		const allStrings = claims.every((c) => typeof c === 'string');
		if (allStrings) {
			// Строки → структуры.
			claims = (claims as string[]).map((s: string) => {
				// Проверяем, есть ли атрибуция: если слово 'источник' (в любом регистре) уже есть — не дублируем.
				const text = /[Ии]сточник/.test(s) ? s : `Источник: ${s}`;
				return {
					id: claimId(ctx.slug, s),
					text,
					status: 'active',
					sources: [ctx.url],
				};
			});
		}
		// Если не все строки — claims уже в object-форме, оставляем как есть.
	}

	// --- Статус и last_updated (только при наличии type) -------------------------
	const hasType = data['type'] !== undefined;

	// --- Сборка нового объекта в читаемом порядке --------------------------------
	const result: Record<string, unknown> = {};

	// Стандартный порядок ключей для стабильного diff.
	const ordered = [
		'title',
		'type',
		'topic',
		'part',
		'slug',
		'status',
		'last_updated',
		'risk',
		'actuality',
		'sources',
		'claims',
	] as const;

	// Сначала кладём ключи в читаемом порядке.
	// Работаем через string-алиас, чтобы избежать ложных narrowing-предупреждений TS
	// при сравнении литерального union с 'sources'/'claims' (эти ветки обработаны выше).
	for (const key of ordered) {
		const k = key as string;
		if (k === 'sources') {
			if (sources !== undefined) result['sources'] = sources;
		} else if (k === 'claims') {
			if (claims !== undefined) result['claims'] = claims;
		} else if (k === 'status' && hasType) {
			// При наличии type всегда выставляем status:'active'.
			result['status'] = 'active';
		} else if (k === 'last_updated' && hasType) {
			// При наличии type выставляем last_updated.
			result['last_updated'] = ctx.nowIso;
		} else if (k in data) {
			result[k] = data[k];
		}
	}

	// Прочие поля, не вошедшие в стандартный порядок.
	for (const key of Object.keys(data)) {
		if (!(key in result) && key !== 'sources' && key !== 'claims') {
			result[key] = data[key];
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Публичный API
// ---------------------------------------------------------------------------

/** Зависимости с DI (для тестируемости, как в finance). */
export interface IngestDeps {
	/** Переопределение contentRoot для тестов. */
	contentRoot?: string;
	/** Окружение (для resolveContentRoot). */
	env?: NodeJS.ProcessEnv;
	/** DI для времени (детерминизм в тестах). */
	nowFn?: () => Date;
	/** DI для санитизации. Дефолт — failClosedSanitize. */
	sanitizeFn?: (text: string) => string;
}

/** Результат вызова ingestKnowledgePackage. */
export interface IngestResult {
	/** true если версия уже втянута (watermark short-circuit). */
	noop: boolean;
	/** Версия пакета из MANIFEST. */
	version: string;
	/** Количество записанных .md-страниц. */
	pagesWritten: number;
	/** Относительные пути удалённых orphan .md. */
	orphansRemoved: string[];
	/** Абсолютный путь записанного raw-файла, либо null если no-op. */
	rawWritten: string | null;
}

// ---------------------------------------------------------------------------
// Внутренние вспомогательные функции
// ---------------------------------------------------------------------------

/**
 * readManifest — читает MANIFEST.md из packageKnowledgeDir и извлекает метаданные.
 * packageKnowledgeDir — путь вида <packageRoot>/knowledge/<topic>.
 */
function readManifest(packageKnowledgeDir: string): {
	packageName: string;
	version: string;
	sourceId: string;
	topic: string;
} {
	const manifestPath = join(packageKnowledgeDir, 'MANIFEST.md');
	if (!existsSync(manifestPath)) {
		throw new Error(`MANIFEST.md не найден: ${manifestPath}`);
	}
	const raw = readFileSync(manifestPath, 'utf8');
	const { data } = parseFrontmatter(raw);

	const packageName = String(data['package'] ?? '');
	const version = String(data['version'] ?? '');
	const sourceId = String(data['source_of_truth'] ?? '');
	const targetCategory = String(data['target_category'] ?? '');
	// topic = последний сегмент target_category (например 'knowledge/job-search' → 'job-search').
	const topic = targetCategory.split('/').pop() ?? '';

	if (!packageName || !version || !sourceId || !topic) {
		throw new Error(
			`MANIFEST.md неполный: package=${packageName}, version=${version}, source_of_truth=${sourceId}, target_category=${targetCategory}`,
		);
	}

	return { packageName, version, sourceId, topic };
}

/**
 * findTopicDir — находит единственный подкаталог в packageRoot/knowledge/.
 * Это и есть директория темы (например 'job-search').
 */
function findTopicDir(packageRoot: string): string {
	const knowledgeRoot = join(packageRoot, 'knowledge');
	if (!existsSync(knowledgeRoot)) {
		throw new Error(`Директория knowledge не найдена: ${knowledgeRoot}`);
	}
	const entries = readdirSync(knowledgeRoot);
	const dirs = entries.filter((e) => {
		const fullPath = join(knowledgeRoot, e);
		return statSync(fullPath).isDirectory();
	});
	if (dirs.length === 0) {
		throw new Error(`В ${knowledgeRoot} нет подкаталогов (ожидается директория темы)`);
	}
	if (dirs.length > 1) {
		throw new Error(
			`В ${knowledgeRoot} несколько подкаталогов: ${dirs.join(', ')} — ожидается один`,
		);
	}
	return join(knowledgeRoot, dirs[0]!);
}

/**
 * collectFiles — рекурсивно собирает все файлы в директории.
 * Возвращает массив абсолютных путей.
 */
function collectFiles(dir: string): string[] {
	const result: string[] = [];
	if (!existsSync(dir)) return result;
	const entries = readdirSync(dir);
	for (const entry of entries) {
		// Делегируем фильтрацию dot-путей (карантин, .tasks, .watermarks, .DS_Store и прочие dotfiles)
		// в shouldSkipRawPath из classifier.ts — единый инвариант для ВСЕХ читателей raw/.
		// rules.md §11: любой читатель raw/ обязан вызывать shouldSkipRawPath,
		// чтобы логика изоляции карантина не дублировалась и не дрейфовала независимо.
		if (shouldSkipRawPath(entry)) continue;
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			result.push(...collectFiles(full));
		} else {
			result.push(full);
		}
	}
	return result;
}

/**
 * toPosixRel — относительный путь в POSIX-нотации (слэши вместо sep).
 */
function toPosixRel(from: string, to: string): string {
	return relative(from, to).split(sep).join('/');
}

/**
 * atomicWrite — атомарная запись файла через tmp + renameSync.
 * tmp живёт в той же директории → rename на том же томе (атомарен на POSIX/macOS).
 * Если запись в tmp не удалась — tmp удаляется, целевой файл не затронут.
 */
function atomicWrite(destPath: string, content: string): void {
	const tmpPath = `${destPath}.${process.pid}.tmp`;
	try {
		writeFileSync(tmpPath, content, 'utf8');
		renameSync(tmpPath, destPath);
	} catch (e) {
		try {
			rmSync(tmpPath, { force: true });
		} catch {
			// игнор: tmp мог не создаться
		}
		throw e;
	}
}

/**
 * atomicCopy — атомарная бинарная копия через tmp + renameSync.
 * Зеркалит atomicWrite для не-.md файлов.
 */
function atomicCopy(srcPath: string, destPath: string): void {
	const tmpPath = `${destPath}.${process.pid}.tmp`;
	try {
		// cpSync в режиме одного файла делает bufio-копию.
		cpSync(srcPath, tmpPath);
		renameSync(tmpPath, destPath);
	} catch (e) {
		try {
			rmSync(tmpPath, { force: true });
		} catch {
			// игнор: tmp мог не создаться
		}
		throw e;
	}
}

/**
 * compareVersions — сравнивает две строки версий как массивы числовых сегментов.
 * Возвращает: <0 если a < b, 0 если a == b, >0 если a > b.
 * Не лексикографически: '0.10.0' > '0.9.0'.
 *
 * FAIL-CLOSED: если любой сегмент любой из двух версий не является целым числом
 * (pre-release суффиксы вида '0.2.0-beta', 'v1.0.0', '1.0.0-rc.1') — бросает ошибку.
 * Молчаливое сравнение NaN-сегментов приводит к неверным результатам: NaN !== NaN,
 * NaN - NaN === NaN, что заставляет код идти по ветке upgrade и писать данные,
 * обходя idempotency-short-circuit и downgrade-guard.
 */
export function compareVersions(a: string, b: string): number {
	// FAIL-CLOSED: принимаем ТОЛЬКО строгий числовой формат X.Y.Z (сегменты из
	// цифр, разделённые точками). Любой не-строгий ввод — pre-release/v-префикс,
	// пустой сегмент ('1..0'), отрицательный ('1.0.-1'), научная нотация ('1e2'),
	// hex ('0x1') — отвергаем. Иначе Number() вернул бы конечное целое, и guard
	// молча ушёл бы в ветку upgrade, обходя idempotency- и downgrade-проверки.
	const STRICT_SEMVER = /^\d+(\.\d+)*$/;
	if (!STRICT_SEMVER.test(a) || !STRICT_SEMVER.test(b)) {
		throw new Error(
			`Неподдерживаемый формат версии: '${a}' или '${b}'. ` +
				`Ожидается строго X.Y.Z — неотрицательные целые сегменты через точку.`,
		);
	}
	const segA = a.split('.').map(Number);
	const segB = b.split('.').map(Number);
	const len = Math.max(segA.length, segB.length);
	for (let i = 0; i < len; i++) {
		const na = segA[i] ?? 0;
		const nb = segB[i] ?? 0;
		if (na !== nb) return na - nb;
	}
	return 0;
}

/**
 * rawFileName — детерминированное content-адресуемое имя raw-файла.
 * Схема: <sourceId>@<hash8>.md
 *
 * Хеш считается от иммутабельного тела источника (санитизированный текст БЕЗ
 * provenance-frontmatter). Это гарантирует, что идентичный источник, втянутый
 * в разное время, получает одно и то же имя — дедупликация работает корректно.
 *
 * Хеш от rawContent (с exported_at:nowIso) был бы нестабилен: каждый ингест
 * одного и того же транскрипта давал бы уникальный таймштамп → уникальное имя,
 * и append-only raw-директория бесконечно росла бы дубликатами.
 *
 * Разные санитизированные тела (разные версии/правки контента) дают разные хеши
 * → файлы не коллидируют.
 */
export function rawFileName(sourceId: string, sanitizedBody: string): string {
	const hash = createHash('sha256').update(sanitizedBody).digest('hex').slice(0, 8);
	return `${sourceId}@${hash}.md`;
}

// ---------------------------------------------------------------------------
// Главная функция
// ---------------------------------------------------------------------------

/**
 * ingestKnowledgePackage — оркестратор ингеста портативного knowledge-package.
 *
 * @param packageRoot    — корень пакета (содержит knowledge/<topic>/)
 * @param transcriptPath — путь к сырому транскрипту источника
 * @param deps           — DI-зависимости (для тестов)
 * @returns IngestResult
 */
export function ingestKnowledgePackage(
	packageRoot: string,
	transcriptPath: string,
	deps?: IngestDeps,
): IngestResult {
	// --- Разрешение зависимостей -------------------------------------------------
	const contentRoot =
		deps?.contentRoot ?? resolveContentRoot(deps?.env ?? process.env);
	const nowFn = deps?.nowFn ?? (() => new Date());
	const sanitizeFn = deps?.sanitizeFn ?? failClosedSanitize;

	// --- 1. Найти topic-директорию и прочитать MANIFEST -------------------------
	const packageKnowledgeDir = findTopicDir(packageRoot);
	const { packageName, version, sourceId, topic } = readManifest(packageKnowledgeDir);

	// Пути целевых директорий.
	const knowledgeDir = join(contentRoot, 'knowledge', topic);
	const rawDir = join(contentRoot, 'raw', 'knowledge', topic);
	const watermarkStateDir = join(contentRoot, 'raw');

	// --- 2. Текущее время (Москва +03:00) ----------------------------------------
	const now = nowFn();
	const nowIso = DateTime.fromJSDate(now).setZone('Europe/Moscow').toISO() ?? now.toISOString();

	// --- 3. Watermark — идемпотентность + монотонный version guard ---------------
	// Watermark ключуется по topic: ингест разных пакетов не перетирает курсор друг друга
	// (footgun при многопакетном переиспользовании оркестратора — напр. 2-й источник в Фазе 3).
	const wm = Watermark.load(watermarkStateDir, `knowledge-package-${topic}`);
	const cursorVersion = wm.cursor['version'] as string | undefined;
	if (wm.cursor['package'] === packageName && cursorVersion !== undefined) {
		const cmp = compareVersions(version, cursorVersion);
		if (cmp === 0) {
			// Та же версия уже втянута — no-op без каких-либо записей.
			return {
				noop: true,
				version,
				pagesWritten: 0,
				orphansRemoved: [],
				rawWritten: null,
			};
		}
		if (cmp < 0) {
			// Даунгрейд: входящая версия НИЖЕ уже втянутой — отказываем без записи.
			// Молчаливый даунгрейд опаснее ошибки: контент стал бы старше watermark.
			throw new Error(
				`Downgrade запрещён: попытка втянуть версию ${version} поверх ${cursorVersion} (пакет ${packageName})`,
			);
		}
		// cmp > 0: version выше cursorVersion → легитимный upgrade, продолжаем.
	}

	// --- 4. Транскрипт: читаем и санитизируем СНАЧАЛА (атомарность) -------------
	const rawText = readFileSync(transcriptPath, 'utf8');
	// Если sanitizeFn бросает SanitizerError — пробрасываем наверх БЕЗ каких-либо записей.
	const cleanedText = sanitizeFn(rawText);

	// --- 5. Записываем raw-файл транскрипта -------------------------------------
	// Provenance-frontmatter по контракту rules.md §3: source, exported_at, watermark-cursor,
	// status: immutable, date (дата источника = nowIso.slice(0,10)).
	// Имя файла включает хеш содержимого — разные версии не коллидируют (правило 1).
	mkdirSync(rawDir, { recursive: true });

	const rawFrontmatter: Record<string, unknown> = {
		type: 'raw',
		status: 'immutable',
		source: sourceId,
		package: packageName,
		version,
		exported_at: nowIso,
		date: nowIso.slice(0, 10),
	};
	const rawContent = serializeFrontmatter(rawFrontmatter, cleanedText);

	// Имя файла = content-адрес ТЕЛА источника (cleanedText), НЕ всего rawContent:
	// exported_at в frontmatter меняется при каждом ингесте → хеш rawContent нестабилен,
	// дедупликация бы не работала. cleanedText иммутабелен → один источник → одно имя.
	const rawBaseName = rawFileName(sourceId, cleanedText);
	const rawFile = join(rawDir, rawBaseName);

	if (existsSync(rawFile)) {
		// Файл с таким хешем уже существует — содержимое идентично, ничего не пишем.
		// (Дедупликация: повторный ингест того же контента безопасен.)
	} else {
		// Атомарная запись: tmp + rename (правило 2).
		atomicWrite(rawFile, rawContent);
	}

	// --- 6. Зеркалим дерево пакета ----------------------------------------------
	// Собираем Set относительных путей всех записанных файлов (относительно knowledgeDir).
	const writtenRelPaths = new Set<string>();
	let pagesWritten = 0;

	const allSourceFiles = collectFiles(packageKnowledgeDir);
	for (const srcFile of allSourceFiles) {
		// Относительный путь от packageKnowledgeDir до файла.
		const relPath = relative(packageKnowledgeDir, srcFile);
		const destFile = join(knowledgeDir, relPath);
		mkdirSync(dirname(destFile), { recursive: true });

		if (srcFile.endsWith('.md')) {
			// Обрабатываем markdown: parseFrontmatter → transformFrontmatter → serializeFrontmatter.
			const srcContent = readFileSync(srcFile, 'utf8');
			const { data, body } = parseFrontmatter(srcContent);

			// slug = data.slug ?? basename без расширения.
			const slug = (data['slug'] as string | undefined) ?? basename(srcFile, '.md');

			// url = относительный POSIX-путь от директории целевого файла до rawFile.
			const url = toPosixRel(dirname(destFile), rawFile);

			const ctx: TransformContext = { url, nowIso, slug, now };
			const transformed = transformFrontmatter(data, ctx);
			const destContent = serializeFrontmatter(transformed, body);
			// Атомарная запись страницы: tmp + rename (правило 2).
			atomicWrite(destFile, destContent);
			pagesWritten += 1;
		} else {
			// Не-.md файлы копируем verbatim атомарно (правило 2).
			atomicCopy(srcFile, destFile);
		}

		// Регистрируем путь (POSIX относительно knowledgeDir).
		const destRelPath = toPosixRel(knowledgeDir, destFile);
		writtenRelPaths.add(destRelPath);
	}

	// --- 7. Удаляем orphan .md --------------------------------------------------
	// Скоуп-гард: knowledgeDir должен заканчиваться на join('knowledge', topic).
	const expectedSuffix = join('knowledge', topic);
	if (!knowledgeDir.endsWith(expectedSuffix)) {
		throw new Error(
			`Скоуп-гард: knowledgeDir (${knowledgeDir}) не заканчивается на ${expectedSuffix} — отказ от удаления`,
		);
	}

	const orphansRemoved: string[] = [];
	const existingFiles = collectFiles(knowledgeDir);
	for (const existingFile of existingFiles) {
		if (!existingFile.endsWith('.md')) continue;
		const existingRelPath = toPosixRel(knowledgeDir, existingFile);
		if (!writtenRelPaths.has(existingRelPath)) {
			// Orphan: файл существует в назначении, но отсутствует в пакете.
			rmSync(existingFile);
			orphansRemoved.push(existingRelPath);
		}
	}

	// --- 8. Продвигаем watermark ТОЛЬКО после успешных записей ------------------
	wm.advance({ package: packageName, version, source: sourceId, ingested_at: nowIso });
	wm.save();

	// --- 9. Возвращаем результат ------------------------------------------------
	return {
		noop: false,
		version,
		pagesWritten,
		orphansRemoved,
		rawWritten: rawFile,
	};
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.filename)) {
	const args = process.argv.slice(2);
	if (args.length < 2) {
		process.stderr.write(
			'usage: node dist/ingest/knowledge-package.js <packageRoot> <transcriptPath>\n',
		);
		process.exit(1);
	}

	const [packageRoot, transcriptPath] = args as [string, string];
	try {
		const result = ingestKnowledgePackage(packageRoot, transcriptPath);
		if (result.noop) {
			process.stdout.write(`no-op: версия ${result.version} уже втянута (watermark)\n`);
		} else {
			process.stdout.write(`ингест завершён: версия=${result.version}\n`);
			process.stdout.write(`  страниц записано: ${result.pagesWritten}\n`);
			process.stdout.write(`  orphan удалено: ${result.orphansRemoved.length}\n`);
			if (result.orphansRemoved.length > 0) {
				for (const p of result.orphansRemoved) {
					process.stdout.write(`    - ${p}\n`);
				}
			}
			process.stdout.write(`  raw транскрипт: ${result.rawWritten}\n`);
		}
	} catch (err) {
		if (err instanceof SanitizerError) {
			process.stderr.write(`[abort] санитизатор заблокировал запись: ${err.message}\n`);
		} else {
			process.stderr.write(
				`[error] ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
		process.exit(1);
	}
}
