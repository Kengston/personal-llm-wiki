/**
 * ledger.ts — append-only JSONL-леджер, общий для всех модулей данных.
 *
 * Механика родилась в финансовом модуле ([ADR-0018]) и по [ADR-0028] («Следствия»:
 * «append/guard-механику НЕ копировать из finance/ledger.ts, а параметризовать
 * существующую каталогом и картой схем») вынесена сюда без изменения поведения.
 * Финансы, карьера и воронка поиска работы используют ОДИН класс с разными
 * спецификациями — второго механизма хранения в проекте нет.
 *
 * Принципы (неизменны с [ADR-0018]):
 *
 *   1. APPEND-ONLY: файлы никогда не перезаписываются целиком — только дозаписываются.
 *      Это обеспечивает исторический audit trail и совместимость с git-diff'ом.
 *
 *   2. ВАЛИДАЦИЯ ПЕРЕД ЗАПИСЬЮ: каждая запись валидируется zod-схемой до append'а.
 *      Невалидная запись → исключение, файл не изменяется.
 *
 *   3. PATH-ALLOWLIST GUARD (критический, обязателен по [ADR-0018]):
 *      Перед любой записью проверяем, что целевой путь:
 *        (а) находится ВНУТРИ каталога своей спеки (`raw/finance`, `raw/career`, …)
 *        (б) НЕ находится под корнем публичного репо
 *      Нарушение → LedgerPathError (запись не происходит).
 *      Это runtime-барьер против случайного коммита приватных данных в публичный репо
 *      ([ADR-0003]) И против записи одного модуля в каталог другого: леджер воронки
 *      физически не умеет писать в `raw/finance/`, потому что каталог зашит в спеку.
 *
 *   4. БЕЗ СЕКРЕТОВ: в записях нет ни токенов, ни PII — только структура и
 *      детерминированные идентификаторы.
 *
 * Спецификация модуля (LedgerSpec) отвечает на три вопроса: какие файлы существуют,
 * чем валидируется каждый и куда по умолчанию писать. Ничего больше класс о модуле
 * не знает — поэтому новый модуль данных не требует правки этого файла.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { z } from 'zod';

// ---------------------------------------------------------------------------
// Ошибки
// ---------------------------------------------------------------------------

/**
 * LedgerPathError — выбрасывается при нарушении path-allowlist guard'а.
 * Означает, что вызывающий пытается записать приватные данные в недопустимый
 * путь (публичный репо или за пределами каталога своей спеки).
 */
export class LedgerPathError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LedgerPathError';
	}
}

/**
 * LedgerValidationError — выбрасывается при провале zod-валидации записи.
 */
export class LedgerValidationError extends Error {
	constructor(
		message: string,
		public readonly cause: unknown,
	) {
		super(message);
		this.name = 'LedgerValidationError';
	}
}

// ---------------------------------------------------------------------------
// Path-allowlist guard (критический)
// ---------------------------------------------------------------------------

/**
 * assertPathAllowed — критический guard перед любой записью.
 *
 * Правила:
 *   1. `targetPath` должен находиться ВНУТРИ `allowedDir` (каталог модуля).
 *   2. `targetPath` НЕ должен находиться внутри `publicRepoRoot`.
 *
 * Оба пути резолвятся через `resolve()` (убирает `..`, `./`, лишние слэши;
 * симлинки не разворачиваются — нормализуются только сегменты).
 * Нарушение → LedgerPathError; файл не трогается.
 *
 * @param targetPath     — абсолютный путь к файлу леджера (куда пишем)
 * @param allowedDir     — обязательный prefix-каталог (raw/finance, raw/career, …)
 * @param publicRepoRoot — корень публичного репо (запрещённый prefix)
 */
export function assertPathAllowed(
	targetPath: string,
	allowedDir: string,
	publicRepoRoot: string,
): void {
	// Нормализуем пути (resolve убирает ../, ./, лишние слэши).
	// Добавляем trailing-separator, чтобы /foo/bar не совпало с /foo/barbaz.
	const normalTarget = resolve(targetPath);
	const normalAllowed = resolve(allowedDir) + '/';
	const normalPublic = resolve(publicRepoRoot) + '/';

	// Правило 1: targetPath должен начинаться с allowedDir.
	if (!normalTarget.startsWith(normalAllowed)) {
		throw new LedgerPathError(
			`Записывать можно только под ${normalAllowed}. ` +
				`Получен путь: ${normalTarget}. ` +
				'Проверьте переменную CONTENT_ROOT и вызов Ledger.',
		);
	}

	// Правило 2: targetPath НЕ должен лежать под публичным репо.
	if (normalTarget.startsWith(normalPublic)) {
		throw new LedgerPathError(
			`ЗАПРЕЩЕНО: целевой путь находится под корнем публичного репо (${normalPublic}). ` +
				`Путь: ${normalTarget}. ` +
				'Приватные данные никогда не должны попадать в публичный репо ([ADR-0003], [ADR-0018]).',
		);
	}
}

/**
 * resolvePublicRepo — возвращает абсолютный путь к публичному репо.
 *
 * Порядок:
 *   1. env.PUBLIC_REPO — явное переопределение (совпадает с scheduler/config.ts)
 *   2. import.meta.dirname/../.. — т.е. корень пакета (src/ingest → ../..)
 */
export function resolvePublicRepo(env: NodeJS.ProcessEnv = process.env): string {
	if (env.PUBLIC_REPO) return resolve(env.PUBLIC_REPO);
	// dist/ingest/ledger.js → ../.. → корень пакета
	// src/ingest/ledger.ts  → ../.. → корень пакета (через tsc outDir)
	return resolve(import.meta.dirname, '..', '..');
}

// ---------------------------------------------------------------------------
// Спецификация модуля
// ---------------------------------------------------------------------------

/**
 * LedgerSpec — всё, что класс знает о конкретном модуле данных.
 *
 * `M` — карта «ключ файла → тип записи» (напр. `{ accounts: AccountRecord }`).
 * Она же задаёт сигнатуры `append`/`readAll`: `append('accounts', …)` принимает
 * ровно `AccountRecord`, а `readAll('accounts')` возвращает `AccountRecord[]`.
 *
 * Схемы держим как `ZodTypeAny`, а не как `ZodType<M[K]>`: у схем с `.default()`
 * и `.optional()` входной тип не равен выходному, и точная типизация здесь
 * воевала бы с zod вместо того, чтобы что-то ловить. Типобезопасность вызова
 * даёт карта `M`, валидацию значения — сама схема в рантайме.
 */
export interface LedgerSpec<M extends Record<string, unknown>> {
	/** Ключ → имя файла (`accounts` → `accounts.jsonl`). */
	readonly files: { readonly [K in keyof M]: string };
	/** Ключ → zod-схема записи. Синхронна с `files` по набору ключей. */
	readonly schemas: { readonly [K in keyof M]: z.ZodTypeAny };
	/** Каталог по умолчанию, если `dir` не передан в опциях. */
	resolveDir(env: NodeJS.ProcessEnv): string;
}

/**
 * LedgerSkip — пропущенная при чтении строка.
 *
 * Раньше пропуск уходил единственной строкой в stderr и вызывающему был невидим:
 * «прочитали 40 из 42» и «прочитали 42 из 42» выглядели одинаково. Теперь пропуск —
 * структурное событие, и валидатор модуля может о нём сообщить владельцу.
 */
export interface LedgerSkip {
	/** Ключ файла, в котором пропущена строка. */
	key: string;
	/** Номер строки в файле, 1-based (как показывает редактор). */
	line: number;
	/** Что именно не получилось: разобрать JSON или провалидировать схемой. */
	reason: 'json' | 'schema';
	/** Текст ошибки парсера или zod. */
	message: string;
}

/**
 * LedgerOptions — зависимости, которые можно переопределить в тестах.
 */
export interface LedgerOptions {
	/** Каталог модуля (куда писать). По умолчанию — `spec.resolveDir(env)`. */
	dir?: string;
	/** Корень публичного репо (запрещённый prefix). По умолчанию resolvePublicRepo(). */
	publicRepoRoot?: string;
	/** Окружение для резолвинга путей. По умолчанию process.env. */
	env?: NodeJS.ProcessEnv;
	/** Обработчик пропущенной строки при readAll. По умолчанию — warn в stderr. */
	onSkip?: (skip: LedgerSkip) => void;
}

/**
 * warnSkipToStderr — поведение по умолчанию при пропуске строки: предупреждение
 * в stderr, чтение продолжается. Ровно то, что делал леджер до параметризации,
 * плюс номер строки — иначе непонятно, какую именно строку править руками.
 */
function warnSkipToStderr(skip: LedgerSkip): void {
	const what =
		skip.reason === 'json' ? 'не удалось распарсить строку JSON' : 'пропущена невалидная запись';
	process.stderr.write(`[ledger] ${skip.key}:${skip.line}: ${what}: ${skip.message}\n`);
}

// ---------------------------------------------------------------------------
// Ядро леджера
// ---------------------------------------------------------------------------

/**
 * Ledger — append-only запись и чтение JSONL по спецификации модуля.
 *
 * Создание (обычно через фабрику модуля, напр. `createLedger()` в finance/ledger.ts):
 *   const ledger = new Ledger(FINANCE_LEDGER);                    // пути из env
 *   const ledger = new Ledger(FINANCE_LEDGER, { dir: '/tmp/…' }); // для тестов
 *
 * Запись:
 *   ledger.append('accounts', record);     // валидирует + записывает
 *
 * Чтение:
 *   const accounts = ledger.readAll('accounts');
 */
export class Ledger<M extends Record<string, unknown>> {
	private readonly spec: LedgerSpec<M>;
	private readonly dir: string;
	private readonly publicRepoRoot: string;
	private readonly onSkip: (skip: LedgerSkip) => void;

	constructor(spec: LedgerSpec<M>, opts: LedgerOptions = {}) {
		const env = opts.env ?? process.env;
		this.spec = spec;
		// Каталог: или явный аргумент, или дефолт спеки из окружения.
		this.dir = opts.dir ?? spec.resolveDir(env);
		// PublicRepoRoot: или явный аргумент, или из окружения.
		this.publicRepoRoot = opts.publicRepoRoot ?? resolvePublicRepo(env);
		this.onSkip = opts.onSkip ?? warnSkipToStderr;
	}

	/**
	 * filePath — возвращает абсолютный путь к файлу леджера для данного ключа.
	 * Не создаёт каталог — только вычисляет путь.
	 */
	filePath(key: keyof M): string {
		return join(this.dir, this.spec.files[key]);
	}

	/**
	 * append — валидирует запись zod-схемой и дозаписывает одну JSON-строку в JSONL.
	 *
	 * Порядок действий:
	 *   1. Path-allowlist guard (LedgerPathError при нарушении).
	 *   2. Zod-валидация (LedgerValidationError при несоответствии схеме).
	 *   3. mkdirSync (идемпотентно, recursive).
	 *   4. appendFileSync — атомарная дозапись одной строки (O_APPEND семантика).
	 *
	 * Ошибка на любом шаге → исключение, файл не изменяется.
	 *
	 * @param key    — ключ файла леджера ('accounts' | 'applications' | …)
	 * @param record — запись для валидации и сохранения
	 */
	append<K extends keyof M>(key: K, record: M[K]): void {
		const targetPath = this.filePath(key);

		// ── Шаг 1: path-allowlist guard ──────────────────────────────────────────
		assertPathAllowed(targetPath, this.dir, this.publicRepoRoot);

		// ── Шаг 2: zod-валидация ─────────────────────────────────────────────────
		const schema = this.spec.schemas[key];
		const result = schema.safeParse(record);
		if (!result.success) {
			throw new LedgerValidationError(
				`Запись не прошла валидацию схемы '${String(key)}': ${result.error.message}`,
				result.error,
			);
		}

		// ── Шаг 3: создаём каталог если нужно ───────────────────────────────────
		mkdirSync(this.dir, { recursive: true });

		// ── Шаг 4: append одной JSON-строки ──────────────────────────────────────
		// JSON.stringify без форматирования → компактный JSONL (одна запись = одна строка).
		// Сохраняем validated data (result.data), а не исходный record,
		// чтобы strip unknown-полей (zod по умолчанию делает strip).
		appendFileSync(targetPath, JSON.stringify(result.data) + '\n', {
			encoding: 'utf8',
			flag: 'a',
		});
	}

	/**
	 * readAll — читает весь файл леджера и парсит каждую строку.
	 *
	 * Возвращает только валидные записи. Непарсируемые и невалидные строки
	 * пропускаются — чтобы не ломаться при ручных правках или частично записанной
	 * строке, — но КАЖДЫЙ пропуск отдаётся в `onSkip` (по умолчанию warn в stderr).
	 *
	 * @param key — ключ файла леджера
	 * @returns массив записей (возможно пустой если файл не существует)
	 */
	readAll<K extends keyof M>(key: K): M[K][] {
		const filePath = this.filePath(key);

		// Файл может не существовать (первый sync) — возвращаем пустой массив.
		if (!existsSync(filePath)) return [];

		const content = readFileSync(filePath, 'utf8');
		const schema = this.spec.schemas[key];
		const results: M[K][] = [];
		const lines = content.split('\n');

		for (let i = 0; i < lines.length; i++) {
			const trimmed = (lines[i] ?? '').trim();
			// Пустые строки — нормально (хвостовой \n у каждой записи).
			if (!trimmed) continue;

			let raw: unknown;
			try {
				raw = JSON.parse(trimmed);
			} catch (e) {
				// Непарсируемая строка — сообщаем, пропускаем.
				this.onSkip({ key: String(key), line: i + 1, reason: 'json', message: String(e) });
				continue;
			}

			const parsed = schema.safeParse(raw);
			if (!parsed.success) {
				// Невалидная запись — сообщаем, пропускаем.
				this.onSkip({
					key: String(key),
					line: i + 1,
					reason: 'schema',
					message: parsed.error.message,
				});
				continue;
			}

			results.push(parsed.data as M[K]);
		}

		return results;
	}
}
