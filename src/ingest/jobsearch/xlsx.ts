/**
 * xlsx.ts — минимальный писатель `.xlsx` на stdlib ([ADR-0030], Решение 4).
 *
 * Файл `.xlsx` — это ZIP с несколькими XML-частями. Минимальный валидный вариант
 * (inline-строки, без sharedStrings и без стилей) собирается чистой функцией поверх
 * `node:zlib` — примерно полторы сотни строк. Excel, Numbers и LibreOffice его открывают.
 *
 * Почему не библиотека: `xlsx` (SheetJS) ушёл с публичного npm-реестра, установка «как
 * обычно» тянет старую версию с известными уязвимостями, а установка «правильно» означает
 * внешний источник пакетов; `exceljs` — тяжёлая транзитивная цепочка ради одного листа без
 * форматирования. Проект уже держит эту планку: [ADR-0025] по тому же критерию отверг
 * `node-canvas` и puppeteer.
 *
 * **Детерминизм.** Таймстемпы ZIP-энтри зафиксированы (1980-01-01) — один и тот же вход
 * даёт побайтово один и тот же файл, как у `renderChartSvg`. Без этого «экспорт не
 * изменился» нельзя проверить сравнением.
 *
 * Граница на будущее: вся запись спрятана за одной сигнатурой `buildXlsx(sheets) → Buffer`.
 * Понадобятся стили, формулы или несколько листов с форматированием — заводим `exceljs`
 * и меняем реализацию за той же сигнатурой, без breaking change для вызывающих.
 */

import { deflateRawSync } from 'node:zlib';

import { formatRate, type FunnelReport } from './funnel.js';

/** Значение ячейки: число или строка. Ни дат, ни формул — их здесь нет намеренно. */
export type Cell = string | number;

/** Лист: имя и матрица строк. */
export interface Sheet {
	name: string;
	rows: Cell[][];
}

// ---------------------------------------------------------------------------
// CRC32 (нужен ZIP-формату; ~15 строк, зависимость ради него не заводим)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c >>> 0;
	}
	return table;
})();

function crc32(buf: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of buf) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
	return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

/** escapeXml — экранирование пяти обязательных сущностей. */
function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/** columnName — 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
	let name = '';
	let n = index;
	do {
		name = String.fromCharCode(65 + (n % 26)) + name;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return name;
}

/**
 * sheetXml — один лист с inline-строками.
 * `inlineStr` вместо sharedStrings: таблица общих строк экономит место на больших файлах,
 * а здесь это лишняя часть архива и лишний источник рассинхрона.
 */
function sheetXml(sheet: Sheet): string {
	const rows = sheet.rows
		.map((cells, rowIndex) => {
			const r = rowIndex + 1;
			const body = cells
				.map((cell, colIndex) => {
					const ref = `${columnName(colIndex)}${r}`;
					if (typeof cell === 'number' && Number.isFinite(cell)) {
						return `<c r="${ref}"><v>${cell}</v></c>`;
					}
					return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(cell))}</t></is></c>`;
				})
				.join('');
			return `<row r="${r}">${body}</row>`;
		})
		.join('');

	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
}

/**
 * Имя листа в Excel: до 31 символа, без `\ / ? * [ ]`.
 * Обрезаем и чистим сами — иначе файл открывается с ошибкой, а не с предупреждением.
 */
function safeSheetName(name: string, index: number): string {
	const cleaned = name.replace(/[\\/?*[\]:]/g, '-').slice(0, 31);
	return cleaned || `Лист${index + 1}`;
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

interface ZipEntry {
	name: string;
	data: Buffer;
}

/** Фиксированные дата и время ZIP-энтри: 1980-01-01 00:00 → побайтовая воспроизводимость. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

/** buildZip — сборка архива без внешних зависимостей (deflate из node:zlib). */
function buildZip(entries: ZipEntry[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBuf = Buffer.from(entry.name, 'utf8');
		const compressed = deflateRawSync(entry.data);
		const crc = crc32(entry.data);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0); // сигнатура
		local.writeUInt16LE(20, 4); // версия
		local.writeUInt16LE(0, 6); // флаги
		local.writeUInt16LE(8, 8); // метод: deflate
		local.writeUInt16LE(DOS_TIME, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(entry.data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28); // extra
		locals.push(local, nameBuf, compressed);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4); // версия создателя
		central.writeUInt16LE(20, 6); // минимальная версия
		central.writeUInt16LE(0, 8);
		central.writeUInt16LE(8, 10);
		central.writeUInt16LE(DOS_TIME, 12);
		central.writeUInt16LE(DOS_DATE, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(entry.data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt16LE(0, 30); // extra
		central.writeUInt16LE(0, 32); // comment
		central.writeUInt16LE(0, 34); // disk
		central.writeUInt16LE(0, 36); // internal attrs
		central.writeUInt32LE(0, 38); // external attrs
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBuf);

		offset += local.length + nameBuf.length + compressed.length;
	}

	const centralBuf = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralBuf.length, 12);
	eocd.writeUInt32LE(offset, 16);
	eocd.writeUInt16LE(0, 20);

	return Buffer.concat([...locals, centralBuf, eocd]);
}

// ---------------------------------------------------------------------------
// Публичная сигнатура
// ---------------------------------------------------------------------------

/**
 * buildXlsx — собирает книгу в память и отдаёт байтами.
 *
 * Файл НЕ пишется во временный путь внутри репозиториев: экспорт воронки — это карьерный
 * след владельца, и его место вне дерева ([ADR-0030], секрет-гейт).
 *
 * @param sheets — листы (минимум один; пустой список — ошибка, а не пустая книга)
 */
export function buildXlsx(sheets: Sheet[]): Buffer {
	if (sheets.length === 0) throw new Error('buildXlsx: нужен хотя бы один лист');

	const named = sheets.map((s, i) => ({ ...s, name: safeSheetName(s.name, i) }));

	const contentTypes =
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
		`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
		`<Default Extension="xml" ContentType="application/xml"/>` +
		`<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
		named
			.map(
				(_s, i) =>
					`<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
			)
			.join('') +
		`</Types>`;

	const rootRels =
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
		`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
		`</Relationships>`;

	const workbook =
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
		named
			.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
			.join('') +
		`</sheets></workbook>`;

	const workbookRels =
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
		named
			.map(
				(_s, i) =>
					`<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
			)
			.join('') +
		`</Relationships>`;

	const entries: ZipEntry[] = [
		{ name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
		{ name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
		{ name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
		{ name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
		...named.map((s, i) => ({
			name: `xl/worksheets/sheet${i + 1}.xml`,
			data: Buffer.from(sheetXml(s), 'utf8'),
		})),
	];

	return buildZip(entries);
}

// ---------------------------------------------------------------------------
// Экспорт воронки
// ---------------------------------------------------------------------------

/**
 * buildFunnelXlsx — книга по снимку воронки: сводка, конверсии, разрезы, причины.
 *
 * Проценты в таблицу НЕ пишутся отдельной колонкой без `n`: в каждой строке рядом стоят
 * числитель, знаменатель и доля. Файл, из которого можно вытащить «18 %» без «из 22»,
 * ровно так и будет процитирован.
 */
export function buildFunnelXlsx(report: FunnelReport): Buffer {
	const summary: Cell[][] = [
		['Показатель', 'Значение', 'n'],
		['Отчёт на', report.as_of, ''],
		['Всего откликов', report.total, report.total],
		['Медиана до первого ответа, дней', report.ttfrDays.median ?? '—', report.ttfrDays.n],
		['p75 до первого ответа, дней', report.ttfrDays.p75 ?? '—', report.ttfrDays.n],
		['Медиана до оффера, дней', report.timeToOfferDays.median ?? '—', report.timeToOfferDays.n],
		['Доля игнора', formatRate(report.ghost), report.ghost.n],
		['Покрытие источников', report.sourceCoverage, ''],
	];

	const conversions: Cell[][] = [['Переход', 'Числитель', 'Знаменатель', 'Доля', 'Интервал 95 %']];
	for (const [key, r] of Object.entries(report.conversions)) {
		conversions.push([
			key,
			r.numerator,
			r.denominator,
			r.value === null ? '—' : r.value,
			r.ci ? `${Math.round(r.ci.low * 100)}–${Math.round(r.ci.high * 100)} %` : '',
		]);
	}

	const breakdowns: Cell[][] = [['Разрез', 'Значение', 'Всего', 'Ответов', 'Офферов']];
	for (const [dimension, buckets] of Object.entries(report.breakdowns)) {
		for (const [key, stat] of Object.entries(buckets)) {
			breakdowns.push([
				dimension,
				key,
				stat.replied.denominator,
				stat.replied.numerator,
				stat.offer.numerator,
			]);
		}
	}

	const reasons: Cell[][] = [['Причина', 'Сколько']];
	for (const [code, count] of Object.entries(report.reasons).sort()) reasons.push([code, count]);

	return buildXlsx([
		{ name: 'Сводка', rows: summary },
		{ name: 'Конверсии', rows: conversions },
		{ name: 'Разрезы', rows: breakdowns },
		{ name: 'Причины', rows: reasons },
	]);
}
