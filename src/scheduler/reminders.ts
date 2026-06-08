/**
 * reminders.ts — детерминированный парсер reminders-файла и движок «что due».
 *
 * Порт `scheduler/reminders.py` ([ADR-0012], [ADR-0007] §3). «Дешёвый предчек»:
 * чистый код БЕЗ вызова движка/сети — sweep сначала спрашивает «есть ли что due?»
 * и спавнит `claude -p` только если есть (экономия Agent-SDK-кредита, [ADR-0009]).
 *
 * tz-aware время — через luxon DateTime (аналог python-dateutil tz); recurrence —
 * через `rrule` (iCal RRULE). YAML-блоки парсим вручную (плоский key: value), как
 * Python-версия (без тяги js-yaml ради одного формата).
 *
 * Формат блока reminders.md (разделитель `---`): id, title, kind
 * (oneoff|recurring|spaced), due_at (ISO С ТАЙМЗОНОЙ), rrule (опц.), nl_source,
 * status (pending|done|snoozed), last_fired, created; для spaced — box,
 * interval_days, ease. Инвариант: персистим ТОЛЬКО ISO due_at (+rrule); NL — в
 * nl_source для аудита, не source-of-truth.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import { DateTime, Duration } from 'luxon';
import rrulePkg from 'rrule';

import { shouldSkipRawPath } from '../ingest/classifier.js';

// rrule — CommonJS: под Node ESM именованный экспорт `rrulestr` не виден (cjs-lexer
// его не детектит), но default = module.exports содержит его. Берём через default.
const { rrulestr } = rrulePkg;

// --- Константы домена ---------------------------------------------------------
/** Лесенка интервалов Leitner для idea-resurfacing (kind=spaced): 1→3→7→16→35. */
export const LEITNER_LADDER = [1, 3, 7, 16, 35] as const;
export const DEFAULT_GRACE = Duration.fromObject({ minutes: 5 });
export const DEFAULT_LOOKAHEAD = Duration.fromObject({ days: 7 });

const BLOCK_SEP_SPLIT = /^-{3,}\s*$/m;
const BLOCK_SEP_LINE = /^-{3,}\s*$/;
const VALID_KINDS = new Set(['oneoff', 'recurring', 'spaced']);
const VALID_STATUSES = new Set(['pending', 'done', 'snoozed']);

// --- Модель данных ------------------------------------------------------------
export interface Reminder {
	id: string;
	title: string;
	kind: string; // oneoff | recurring | spaced
	dueAt: DateTime | null; // tz-aware; null если блок битый
	rrule: string | null;
	nlSource: string | null;
	status: string;
	lastFired: DateTime | null;
	created: DateTime | null;
	box: number | null; // spaced-only
	intervalDays: number | null;
	ease: number | null;
	parseWarnings: string[];
}

/** pending/snoozed — живые; done — выключен. */
export function isActive(rem: Reminder): boolean {
	return rem.status === 'pending' || rem.status === 'snoozed';
}

export interface DueItem {
	id: string;
	title: string;
	kind: string; // oneoff | recurring | spaced | birthday | anniversary
	dueAt: DateTime;
	source: string; // "reminders" | "wiki:<relpath>"
	detail: string;
	upcoming: boolean; // true = в lookahead-окне, ещё не строго due
}

export interface DueOptions {
	now?: DateTime;
	grace?: Duration;
	lookahead?: Duration;
	defaultZone?: string;
}

function nowInZone(zone?: string): DateTime {
	return zone ? DateTime.now().setZone(zone) : DateTime.now();
}

// --- Парсинг времени ----------------------------------------------------------
/**
 * Разобрать ISO 8601 в tz-aware DateTime. Если в строке есть offset — берём его;
 * иначе навешиваем defaultZone (по умолчанию локальная tz). Дата-без-времени =
 * полночь дня. null, если не разобралось.
 */
export function parseIso(value: string | null | undefined, defaultZone?: string): DateTime | null {
	if (!value) return null;
	const v = value.trim();
	if (!v) return null;
	// Python fromisoformat принимает пробел-разделитель даты/времени; luxon требует
	// 'T' — нормализуем, чтобы один и тот же reminders.md парсился одинаково.
	const normalized = v.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/, '$1T$2');
	const dtm = DateTime.fromISO(normalized, { zone: defaultZone ?? 'local', setZone: true });
	return dtm.isValid ? dtm : null;
}

// --- Recurrence (iCal RRULE) --------------------------------------------------
// rrule оперирует JS Date в «floating»-интерпретации (wall-clock как UTC). Конвертим
// luxon DateTime ↔ floating-UTC Date, чтобы tz-семантика совпала с dateutil.
function luxonToFloatingUtc(dt: DateTime): Date {
	return new Date(
		Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, dt.second, dt.millisecond),
	);
}

function floatingUtcToLuxon(d: Date, zone: string): DateTime {
	return DateTime.fromObject(
		{
			year: d.getUTCFullYear(),
			month: d.getUTCMonth() + 1,
			day: d.getUTCDate(),
			hour: d.getUTCHours(),
			minute: d.getUTCMinutes(),
			second: d.getUTCSeconds(),
			millisecond: d.getUTCMilliseconds(),
		},
		{ zone },
	);
}

/**
 * Следующее срабатывание recurring-правила строго после (или с) `after`.
 * `ruleStr` — iCal RRULE без префикса; `dtstart` — якорь (created/исходный due_at),
 * tz-aware. null, если правило битое или исчерпано.
 */
export function nextOccurrence(
	ruleStr: string,
	dtstart: DateTime,
	after: DateTime,
	inclusive = false,
): DateTime | null {
	const zone = dtstart.zoneName ?? 'local';
	let rule: ReturnType<typeof rrulestr>;
	try {
		rule = rrulestr(ruleStr, { dtstart: luxonToFloatingUtc(dtstart) });
	} catch {
		return null; // битый RRULE — не роняем sweep
	}
	const afterFloating = luxonToFloatingUtc(after.setZone(zone));
	const occ = rule.after(afterFloating, inclusive);
	return occ ? floatingUtcToLuxon(occ, zone) : null;
}

// --- Парсинг reminders.md -----------------------------------------------------
function stripYamlFences(block: string): string {
	const lines = block.trim().split('\n');
	if (lines.length && BLOCK_SEP_LINE.test(lines[0] ?? '')) lines.shift();
	if (lines.length && BLOCK_SEP_LINE.test(lines[lines.length - 1] ?? '')) lines.pop();
	return lines.join('\n');
}

/** Снять кавычки/инлайн-комментарий с плоского YAML-скаляра (без PyYAML/js-yaml). */
function parseScalar(raw: string): string {
	let s = raw.trim();
	if (s && s[0] !== '"' && s[0] !== "'") {
		const hashPos = s.indexOf(' #');
		if (hashPos !== -1) s = s.slice(0, hashPos).replace(/\s+$/, '');
	}
	if (s.length >= 2 && s[0] === s[s.length - 1] && (s[0] === '"' || s[0] === "'")) {
		s = s.slice(1, -1);
	}
	return s;
}

function parseBlock(blockText: string, defaultZone?: string): Reminder | null {
	const body = stripYamlFences(blockText);
	if (!body.trim()) return null;

	const fields: Record<string, string> = {};
	for (const line of body.split('\n')) {
		if (!line.trim() || line.trimStart().startsWith('#')) continue;
		const idx = line.indexOf(':');
		if (idx === -1) continue;
		fields[line.slice(0, idx).trim()] = parseScalar(line.slice(idx + 1));
	}

	const warnings: string[] = [];
	const rid = fields['id'] || '';
	if (!rid) warnings.push('missing id');

	let kind = (fields['kind'] || 'oneoff').toLowerCase();
	if (!VALID_KINDS.has(kind)) {
		warnings.push(`unknown kind=${JSON.stringify(kind)}, treating as oneoff`);
		kind = 'oneoff';
	}

	let status = (fields['status'] || 'pending').toLowerCase();
	if (!VALID_STATUSES.has(status)) {
		warnings.push(`unknown status=${JSON.stringify(status)}, treating as pending`);
		status = 'pending';
	}

	const dueAt = parseIso(fields['due_at'], defaultZone);
	if (dueAt === null && fields['due_at']) warnings.push(`unparseable due_at=${JSON.stringify(fields['due_at'])}`);

	const intOf = (name: string): number | null => {
		const val = fields[name];
		if (val === undefined || val === '') return null;
		const n = Number(val);
		if (!Number.isInteger(n)) {
			warnings.push(`non-int ${name}=${JSON.stringify(val)}`);
			return null;
		}
		return n;
	};
	const floatOf = (name: string): number | null => {
		const val = fields[name];
		if (val === undefined || val === '') return null;
		const n = Number(val);
		if (Number.isNaN(n)) {
			warnings.push(`non-float ${name}=${JSON.stringify(val)}`);
			return null;
		}
		return n;
	};

	return {
		id: rid,
		title: fields['title'] || rid || '(без названия)',
		kind,
		dueAt,
		rrule: fields['rrule'] || null,
		nlSource: fields['nl_source'] || null,
		status,
		lastFired: parseIso(fields['last_fired'], defaultZone),
		created: parseIso(fields['created'], defaultZone),
		box: intOf('box'),
		intervalDays: intOf('interval_days'),
		ease: floatOf('ease'),
		parseWarnings: warnings,
	};
}

/** Распарсить весь reminders.md. Первый блок (markdown-преамбула) тихо отбрасывается. */
export function parseReminders(text: string, defaultZone?: string): Reminder[] {
	const reminders: Reminder[] = [];
	for (const rawBlock of text.split(BLOCK_SEP_SPLIT)) {
		if (!rawBlock.trim()) continue;
		const rem = parseBlock(rawBlock, defaultZone);
		if (rem !== null && (rem.id || rem.dueAt)) reminders.push(rem);
	}
	return reminders;
}

/** Прочитать reminders.md с диска. Отсутствующий файл = пусто. */
export function loadReminders(path: string, defaultZone?: string): Reminder[] {
	if (!existsSync(path)) return [];
	return parseReminders(readFileSync(path, 'utf8'), defaultZone);
}

// --- Дни рождения / годовщины из person-страниц вики --------------------------
const FRONTMATTER_FENCE = /^---\s*$/gm;
const DATE_FIELD = /^(birthday|anniversary|birth_date|named_day)\s*:\s*(.+?)\s*$/gim;
const TITLE_FIELD = /^title\s*:\s*(.+?)\s*$/im;
const MMDD = /(?:(\d{4})-)?(\d{1,2})-(\d{1,2})/;

function extractFrontmatter(text: string): string {
	const fences = [...text.matchAll(FRONTMATTER_FENCE)];
	const first = fences[0];
	const second = fences[1];
	if (fences.length >= 2 && first && second && first.index === 0) {
		return text.slice((first.index ?? 0) + first[0].length, second.index);
	}
	return '';
}

function mdFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string): void => {
		let entries;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = join(d, e.name);
			if (e.isDirectory()) walk(full);
			else if (e.isFile() && e.name.endsWith('.md')) out.push(full);
		}
	};
	walk(dir);
	return out.sort();
}

function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

/** Ближайшая полночь <month>-<day> не раньше начала текущего дня now. */
function nextYearly(month: number, day: number, now: DateTime, zone: string): DateTime | null {
	const make = (year: number): DateTime | null => {
		const dtm = DateTime.fromObject({ year, month, day, hour: 0, minute: 0 }, { zone });
		if (dtm.isValid) return dtm;
		// 29 февраля в невисокосный год → 1 марта.
		if (month === 2 && day === 29) {
			const d2 = DateTime.fromObject({ year, month: 3, day: 1, hour: 0 }, { zone });
			return d2.isValid ? d2 : null;
		}
		return null;
	};
	const todayStart = now.set({ hour: 0, minute: 0, second: 0, millisecond: 0 });
	const thisYear = make(now.year);
	if (thisYear && thisYear.toMillis() >= todayStart.toMillis()) return thisYear;
	return make(now.year + 1);
}

/** Просканировать wiki/ на person-страницы с birthday:/anniversary: due/upcoming. */
export function birthdaysFromWiki(wikiDir: string, opts: DueOptions = {}): DueItem[] {
	const now = opts.now ?? nowInZone(opts.defaultZone);
	const zone = now.zoneName ?? 'local';
	const graceMs = (opts.grace ?? DEFAULT_GRACE).toMillis();
	const lookaheadMs = (opts.lookahead ?? DEFAULT_LOOKAHEAD).toMillis();
	const items: DueItem[] = [];
	if (!existsSync(wikiDir)) return items;

	for (const md of mdFiles(wikiDir)) {
		// P0-1 ([ADR-0011]): rglob не пропускает dot-папки — режем по rel-пути.
		const rel = relative(wikiDir, md);
		if (shouldSkipRawPath(rel)) continue;
		const fm = extractFrontmatter(readFileSync(md, 'utf8'));
		if (!fm) continue;
		const titleM = TITLE_FIELD.exec(fm);
		const person = titleM && titleM[1] ? titleM[1].trim() : basename(md, '.md');

		for (const fieldM of fm.matchAll(DATE_FIELD)) {
			const key = (fieldM[1] ?? '').toLowerCase();
			const mmdd = MMDD.exec(fieldM[2] ?? '');
			if (!mmdd) continue;
			const month = Number(mmdd[2]);
			const day = Number(mmdd[3]);
			const birthYear = mmdd[1] ? Number(mmdd[1]) : null;
			const kind = key === 'anniversary' || key === 'named_day' ? 'anniversary' : 'birthday';

			const occ = nextYearly(month, day, now, zone);
			if (!occ) continue;
			const deltaMs = occ.toMillis() - now.toMillis();
			let upcoming: boolean;
			if (deltaMs <= graceMs) upcoming = false;
			else if (deltaMs <= lookaheadMs) upcoming = true;
			else continue;

			let detail = '';
			if (birthYear !== null) {
				const turning = occ.year - birthYear;
				const noun = kind === 'birthday' ? 'лет' : 'годовщина';
				detail = `исполняется ${turning} ${noun}`;
			}

			items.push({
				id: `${kind}:${basename(md, '.md')}:${pad2(month)}-${pad2(day)}`,
				title: `${person} — ${kind === 'birthday' ? 'день рождения' : 'годовщина'}`,
				kind,
				dueAt: occ,
				source: `wiki:${rel}`,
				detail,
				upcoming,
			});
		}
	}
	return items;
}

// --- Главная функция: что due прямо сейчас ------------------------------------
function alreadyFiredToday(rem: Reminder, now: DateTime): boolean {
	if (!rem.lastFired) return false;
	return rem.lastFired.setZone(now.zoneName ?? 'local').hasSame(now, 'day');
}

/** Превратить список Reminder в DueItem'ы, которые надо показать СЕЙЧАС. */
export function computeDue(reminders: Iterable<Reminder>, opts: DueOptions = {}): DueItem[] {
	const now = opts.now ?? nowInZone(opts.defaultZone);
	const zone = now.zoneName ?? 'local';
	const graceMs = (opts.grace ?? DEFAULT_GRACE).toMillis();
	const lookaheadMs = (opts.lookahead ?? DEFAULT_LOOKAHEAD).toMillis();
	const out: DueItem[] = [];

	for (const rem of reminders) {
		if (!isActive(rem)) continue;

		let dueAt = rem.dueAt;
		// recurring без явного due_at: вывести из rrule (next occurrence от now).
		if (dueAt === null && rem.kind === 'recurring' && rem.rrule && rem.created) {
			dueAt = nextOccurrence(rem.rrule, rem.created, now, true);
		}
		if (dueAt === null) continue;

		dueAt = dueAt.setZone(zone);
		const deltaMs = dueAt.toMillis() - now.toMillis();

		let upcoming: boolean;
		if (deltaMs <= graceMs) {
			if (alreadyFiredToday(rem, now)) continue; // уже стреляли сегодня
			upcoming = false;
		} else if (deltaMs <= lookaheadMs) {
			upcoming = true;
		} else {
			continue;
		}

		out.push({
			id: rem.id,
			title: rem.title,
			kind: rem.kind,
			dueAt,
			source: 'reminders',
			detail: rem.nlSource ?? '',
			upcoming,
		});
	}
	return out;
}

/** Высокоуровневый предчек: всё due из reminders + дней рождения, отсортировано. */
export function collectDueItems(
	remindersPath: string,
	wikiDir: string,
	opts: DueOptions = {},
): DueItem[] {
	const now = opts.now ?? nowInZone(opts.defaultZone);
	const zone = now.zoneName ?? 'local';
	const reminders = loadReminders(remindersPath, zone);
	const items = computeDue(reminders, { ...opts, now, defaultZone: zone });
	items.push(...birthdaysFromWiki(wikiDir, { ...opts, now, defaultZone: zone }));
	// Сначала строго-due (upcoming=false), потом по времени.
	items.sort((a, b) => {
		if (a.upcoming !== b.upcoming) return a.upcoming ? 1 : -1;
		return a.dueAt.toMillis() - b.dueAt.toMillis();
	});
	return items;
}

/** Продвинуть spaced-reminder на следующую ступень Leitner. (new_box, interval_days). */
export function advanceSpaced(box: number | null): [number, number] {
	const b = box === null || box < 0 ? 0 : Math.min(box + 1, LEITNER_LADDER.length - 1);
	return [b, LEITNER_LADDER[b] ?? LEITNER_LADDER[LEITNER_LADDER.length - 1]!];
}
