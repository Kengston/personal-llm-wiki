/**
 * write-path.ts — единственный путь записи в леджеры проекта ([ADR-0035]).
 *
 * До этого файла в системе жили два пути: `Ledger.append` (валидация до записи) и агентская
 * привычка дописывать JSONL руками поверх файла. 02.09 второй путь дописал 66 строк мимо
 * схемы одним прогоном — воронка недосчиталась 7,8 %. `appendBatch`/`validateAll` не вводят
 * новую механику хранения — они складывают уже существующий `Ledger` в операции, у которых
 * НЕТ обходного пути: агент физически не может дописать JSONL иначе, чем вызвав функцию
 * отсюда (или CLI поверх неё), потому что инструкция «пиши напрямую» из скиллов убрана.
 *
 * Изначально файл знал только про леджер поиска работы; [ADR-0035] («Следствия»: «учебный
 * журнал пишется тем же путём: `pnpm learn:append`») требует того же механизма для журнала
 * повторений — второй копии «валидируй-пачку-и-запиши» в проекте быть не должно. Поэтому
 * `appendBatch`/`validateAll` параметризованы `LedgerSpec<M>` и работают с любым леджером,
 * построенным поверх общего `Ledger` ([../ledger.ts]), а не только с `JOBSEARCH_LEDGER`.
 *
 * Четыре вещи, которые здесь неочевидны:
 *
 *   1. НОМЕР СТРОКИ В ОШИБКЕ — это позиция элемента в `rows` (1-based), а не номер строки
 *      исходного файла. Разбор JSONL (включая пропуск пустых строк) остаётся в `.mjs`
 *      ([ADR-0035] §1: «строки JSONL из stdin или файла — разбор в .mjs, не в функции»);
 *      функция получает уже распарсенные значения и не знает, были ли между ними пустые
 *      строки в файле. Тащить пару «текст + исходный номер» через границу ради леджеров,
 *      где пустых строк не бывает, — цена ради случая, которого на практике нет.
 *
 *   2. «ВСЁ ИЛИ НИЧЕГО» — это порядок вызовов, а не транзакция. У `Ledger` нет отката:
 *      он умеет валидировать-и-дописать ОДНУ строку. Атомарность пачки достигается тем, что
 *      КАЖДАЯ строка валидируется схемой ДО того, как `ledger.append` вызывается хоть раз —
 *      если хоть одна не прошла, цикл записи не начинается вовсе. Это не защищает от обрыва
 *      диска между записями уже провалидированных строк, но такой отказ у `Ledger.append`
 *      не защищён и для одиночной записи — это не новая дыра, а существующая граница.
 *
 *   3. `SPEC` — ОТДЕЛЬНЫЙ АРГУМЕНТ, А НЕ ЧАСТЬ `LEDGER`. `Ledger<M>` хранит свою спеку
 *      приватным полем (см. `../ledger.ts`) и не отдаёт её наружу — это чужой файл, менять
 *      его здесь нельзя. Поэтому `appendBatch`/`validateAll` принимают `spec: LedgerSpec<M>`
 *      явно: тот же объект, которым был создан переданный `ledger` (или его вариант со
 *      своей схемой ЗАПИСИ — см. пункт 4). Рассинхрон между `ledger` и `spec` — ошибка
 *      вызывающего, а не то, что эта функция может проверить рантаймом.
 *
 *   4. `JOBSEARCH_APPLICATIONS` ПРОВЕРЯЮТСЯ СТРОЖЕ, ЧЕМ ЧИТАЮТСЯ. Раньше `appendBatch` сам
 *      знал имя файла `'applications'` и подставлял `NewApplicationRecordSchema`. Общая
 *      функция ничего не знает про конкретные леджеры — поэтому подмена схемы теперь живёт
 *      в `JOBSEARCH_APPEND_SPEC`: та же `JOBSEARCH_LEDGER`, но со схемой `applications`,
 *      заменённой на строгую. `validateAll`, наоборот, всегда получает `JOBSEARCH_LEDGER`
 *      (базовую, читающую спеку) — история без площадки обязана читаться и после миграции
 *      ([ADR-0033] §2, [ADR-0035]), а новая запись без неё — ровно тот дефект, который
 *      восстанавливали по ссылке. Спутать эти две спеки в `validateAll` значило бы объявить
 *      всю историю невалидной.
 */

import { existsSync, readFileSync } from 'node:fs';

import type { Ledger, LedgerSpec } from '../ledger.js';
import { NewApplicationRecordSchema } from './events.js';
import {
	JOBSEARCH_LEDGER,
	type JobsearchFileKey,
	type JobsearchLedger,
	type JobsearchRecordMap,
} from './ledger.js';

// ---------------------------------------------------------------------------
// appendBatch
// ---------------------------------------------------------------------------

/** Одна строка пачки, не прошедшая схему: номер (1-based в `rows`) и текст ошибки zod. */
export interface AppendRowError {
	line: number;
	message: string;
}

export interface AppendBatchOptions {
	/** Провалидировать пачку и вернуть readback, но не писать на диск. */
	dryRun?: boolean;
}

export interface AppendBatchResult<M extends Record<string, unknown>, K extends keyof M> {
	file: K;
	/** Абсолютный путь леджера, куда (или куда бы) легла пачка. */
	path: string;
	/** false — пачка не записана ни одной строкой, смотри `errors`. */
	ok: boolean;
	dryRun: boolean;
	/** Сколько строк реально дописано (0 при ошибке или dry-run). */
	written: number;
	/** Readback: провалидированные записи в порядке `rows` (то, что записано или было бы). */
	records: M[K][];
	errors: AppendRowError[];
}

/**
 * appendBatch — единственный способ дописать строки в ЛЮБОЙ леджер проекта ([ADR-0035]).
 *
 * Валидирует КАЖДУЮ строку до записи; если хоть одна не проходит схему — на диск не уходит
 * ни одна («всё или ничего», см. пункт 2 в шапке файла). При успехе дописывает по одной
 * записи через `ledger.append` (путь-guard и создание каталога уже в нём — второй раз их
 * тут не пишем) и возвращает readback: что и куда легло.
 *
 * `spec` — та же спецификация, которой построен `ledger` (или её вариант со своей схемой
 * записи для одного из файлов, см. пункт 3/4 в шапке файла); `appendBatch` не проверяет их
 * согласованность рантаймом.
 *
 * @param ledger — леджер модуля (создаётся `createJobsearchLedger`/`createLearningLedger`/…)
 * @param spec   — `LedgerSpec` этого леджера — источник схем для валидации строк
 * @param file   — ключ файла спецификации
 * @param rows   — уже распарсенные JSON-значения, по одному на строку JSONL
 * @param opts   — { dryRun } — провалидировать и не писать
 */
export function appendBatch<M extends Record<string, unknown>, K extends keyof M>(
	ledger: Ledger<M>,
	spec: LedgerSpec<M>,
	file: K,
	rows: unknown[],
	opts: AppendBatchOptions = {},
): AppendBatchResult<M, K> {
	const schema = spec.schemas[file];
	const path = ledger.filePath(file);
	const errors: AppendRowError[] = [];
	const validated: M[K][] = [];

	// Шаг 1: валидируем ВСЁ, не записав ни строки, — иначе «всё или ничего» невозможно.
	rows.forEach((row, i) => {
		const result = schema.safeParse(row);
		if (result.success) {
			validated.push(result.data as M[K]);
		} else {
			errors.push({ line: i + 1, message: result.error.message });
		}
	});

	if (errors.length > 0) {
		return { file, path, ok: false, dryRun: opts.dryRun ?? false, written: 0, records: [], errors };
	}

	if (opts.dryRun) {
		return { file, path, ok: true, dryRun: true, written: 0, records: validated, errors: [] };
	}

	// Шаг 2: записываем по одной — только сюда мы попадаем, если провалидировалась вся пачка.
	for (const record of validated) ledger.append(file, record);

	return { file, path, ok: true, dryRun: false, written: validated.length, records: validated, errors: [] };
}

/**
 * JOBSEARCH_APPEND_SPEC — `JOBSEARCH_LEDGER` со схемой ЗАПИСИ (не чтения) для `applications`
 * (пункт 4 в шапке файла). Именно её передают в `appendBatch` для леджера поиска работы;
 * `validateAll` (сплошная проверка истории) всегда получает базовую `JOBSEARCH_LEDGER`.
 */
export const JOBSEARCH_APPEND_SPEC: LedgerSpec<JobsearchRecordMap> = {
	...JOBSEARCH_LEDGER,
	schemas: { ...JOBSEARCH_LEDGER.schemas, applications: NewApplicationRecordSchema },
};

// ---------------------------------------------------------------------------
// validateAll
// ---------------------------------------------------------------------------

/** Пропущенная строка при сплошной проверке леджеров: файл, номер строки, причина. */
export interface ValidationSkip<F extends string = string> {
	file: F;
	line: number;
	reason: 'json' | 'schema';
	message: string;
}

/**
 * validateAll — проверяет все файлы спецификации ЛЮБОГО леджера и возвращает список
 * пропусков (пустой = чисто). Не использует `ledger.readAll` намеренно: у `Ledger` обработчик
 * пропуска (`onSkip`) фиксируется один раз в конструкторе и по умолчанию печатает в stderr —
 * а этой функции нужен СПИСОК, а не поток сообщений, поэтому файл читается и парсится тем же
 * алгоритмом заново, но с собственным накопителем вместо колбэка.
 *
 * Каждый файл проверяется своей БАЗОВОЙ схемой спецификации (не строгой `New…`-версией —
 * см. пункт 4 в шапке файла): здесь мы читаем историю, а не принимаем новую запись.
 *
 * Перегрузка с одним аргументом — то же самое, что раньше: леджер поиска работы и его
 * `JOBSEARCH_LEDGER` без явной передачи (её и раньше не нужно было называть, называть
 * второй раз то же самое значение бессмысленно). Любой другой леджер спеку называет явно.
 *
 * @param ledger — леджер модуля
 * @param spec   — `LedgerSpec` этого леджера; для леджера поиска работы можно опустить
 */
export function validateAll(ledger: JobsearchLedger): ValidationSkip<JobsearchFileKey>[];
export function validateAll<M extends Record<string, unknown>>(
	ledger: Ledger<M>,
	spec: LedgerSpec<M>,
): ValidationSkip<Extract<keyof M, string>>[];
export function validateAll<M extends Record<string, unknown>>(
	ledger: Ledger<M>,
	spec?: LedgerSpec<M>,
): ValidationSkip<Extract<keyof M, string>>[] {
	// Перегрузка с одним аргументом всегда вызывается с JobsearchLedger (см. сигнатуры выше) —
	// поэтому фолбэк на JOBSEARCH_LEDGER безопасен для каждого реального вызова снаружи,
	// хотя внутри дженерика M он и требует явного приведения типа.
	const effectiveSpec = spec ?? (JOBSEARCH_LEDGER as unknown as LedgerSpec<M>);
	const skips: ValidationSkip<Extract<keyof M, string>>[] = [];

	for (const key of Object.keys(effectiveSpec.files) as Extract<keyof M, string>[]) {
		const path = ledger.filePath(key);
		if (!existsSync(path)) continue;

		const schema = effectiveSpec.schemas[key];
		const lines = readFileSync(path, 'utf8').split('\n');

		lines.forEach((line, i) => {
			const trimmed = line.trim();
			if (!trimmed) return; // хвостовой \n после каждой записи — не пропуск.

			let raw: unknown;
			try {
				raw = JSON.parse(trimmed);
			} catch (e) {
				skips.push({ file: key, line: i + 1, reason: 'json', message: String(e) });
				return;
			}

			const result = schema.safeParse(raw);
			if (!result.success) {
				skips.push({ file: key, line: i + 1, reason: 'schema', message: result.error.message });
			}
		});
	}

	return skips;
}
