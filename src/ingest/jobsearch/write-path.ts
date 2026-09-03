/**
 * write-path.ts — единственный путь записи в леджеры подсистемы «Поиск работы» ([ADR-0035]).
 *
 * До этого файла в системе жили два пути: `Ledger.append` (валидация до записи) и агентская
 * привычка дописывать JSONL руками поверх файла. 02.09 второй путь дописал 66 строк мимо
 * схемы одним прогоном — воронка недосчиталась 7,8 %. `appendBatch`/`validateAll` не вводят
 * новую механику хранения — они складывают уже существующий `Ledger` в операции, у которых
 * НЕТ обходного пути: агент физически не может дописать JSONL иначе, чем вызвав функцию
 * отсюда (или CLI поверх неё), потому что инструкция «пиши напрямую» из скиллов убрана.
 *
 * Три вещи, которые здесь неочевидны:
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
 *   3. `applications` ПРОВЕРЯЮТСЯ СТРОЖЕ, ЧЕМ ЧИТАЮТСЯ. `appendBatch` валидирует новую строку
 *      `NewApplicationRecordSchema` (требует `platform`/`url`/`applied_via`), а `validateAll`
 *      и обычное чтение — базовой `ApplicationRecordSchema` (эти поля опциональны). Так и
 *      задумано ([ADR-0033] §2, [ADR-0035]): история без площадки обязана читаться и после
 *      миграции, а новая запись без неё — ровно тот дефект, который восстанавливали по ссылке.
 *      Спутать эти две схемы в `validateAll` значило бы объявить всю историю невалидной.
 */

import { existsSync, readFileSync } from 'node:fs';

import type { z } from 'zod';

import { NewApplicationRecordSchema } from './events.js';
import {
	JOBSEARCH_LEDGER,
	JOBSEARCH_LEDGER_FILES,
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

export interface AppendBatchResult<K extends JobsearchFileKey> {
	file: K;
	/** Абсолютный путь леджера, куда (или куда бы) легла пачка. */
	path: string;
	/** false — пачка не записана ни одной строкой, смотри `errors`. */
	ok: boolean;
	dryRun: boolean;
	/** Сколько строк реально дописано (0 при ошибке или dry-run). */
	written: number;
	/** Readback: провалидированные записи в порядке `rows` (то, что записано или было бы). */
	records: JobsearchRecordMap[K][];
	errors: AppendRowError[];
}

/** Схема, которой проверяется НОВАЯ запись файла — applications строже, остальные как в спеке. */
function schemaForAppend(file: JobsearchFileKey): z.ZodTypeAny {
	return file === 'applications' ? NewApplicationRecordSchema : JOBSEARCH_LEDGER.schemas[file];
}

/**
 * appendBatch — единственный способ дописать строки в леджер подсистемы ([ADR-0035]).
 *
 * Валидирует КАЖДУЮ строку до записи; если хоть одна не проходит схему — на диск не уходит
 * ни одна («всё или ничего», см. пункт 2 в шапке файла). При успехе дописывает по одной
 * записи через `ledger.append` (путь-guard и создание каталога уже в нём — второй раз их
 * тут не пишем) и возвращает readback: что и куда легло.
 *
 * @param ledger — леджер подсистемы (создаётся `createJobsearchLedger`)
 * @param file   — ключ файла спецификации ('applications' | 'companies' | …)
 * @param rows   — уже распарсенные JSON-значения, по одному на строку JSONL
 * @param opts   — { dryRun } — провалидировать и не писать
 */
export function appendBatch<K extends JobsearchFileKey>(
	ledger: JobsearchLedger,
	file: K,
	rows: unknown[],
	opts: AppendBatchOptions = {},
): AppendBatchResult<K> {
	const schema = schemaForAppend(file);
	const path = ledger.filePath(file);
	const errors: AppendRowError[] = [];
	const validated: JobsearchRecordMap[K][] = [];

	// Шаг 1: валидируем ВСЁ, не записав ни строки, — иначе «всё или ничего» невозможно.
	rows.forEach((row, i) => {
		const result = schema.safeParse(row);
		if (result.success) {
			validated.push(result.data as JobsearchRecordMap[K]);
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

// ---------------------------------------------------------------------------
// validateAll
// ---------------------------------------------------------------------------

/** Пропущенная строка при сплошной проверке леджеров: файл, номер строки, причина. */
export interface ValidationSkip {
	file: JobsearchFileKey;
	line: number;
	reason: 'json' | 'schema';
	message: string;
}

/**
 * validateAll — проверяет все пять файлов спецификации леджера и возвращает список
 * пропусков (пустой = чисто). Не использует `ledger.readAll` намеренно: у `Ledger` обработчик
 * пропуска (`onSkip`) фиксируется один раз в конструкторе и по умолчанию печатает в stderr —
 * а этой функции нужен СПИСОК, а не поток сообщений, поэтому файл читается и парсится тем же
 * алгоритмом заново, но с собственным накопителем вместо колбэка.
 *
 * Каждый файл проверяется своей базовой схемой спецификации (не строгой `New…`-версией —
 * см. пункт 3 в шапке файла): здесь мы читаем историю, а не принимаем новую запись.
 *
 * @param ledger — леджер подсистемы (создаётся `createJobsearchLedger`)
 */
export function validateAll(ledger: JobsearchLedger): ValidationSkip[] {
	const skips: ValidationSkip[] = [];

	for (const key of Object.keys(JOBSEARCH_LEDGER_FILES) as JobsearchFileKey[]) {
		const path = ledger.filePath(key);
		if (!existsSync(path)) continue;

		const schema = JOBSEARCH_LEDGER.schemas[key];
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
