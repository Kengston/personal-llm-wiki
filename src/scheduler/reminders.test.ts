/**
 * Парность с `scheduler/reminders.py` ([ADR-0012], [ADR-0007]). Чистые функции:
 * parseIso, parseReminders, computeDue (due/upcoming/дедуп/inactive), nextOccurrence
 * (RRULE), birthdaysFromWiki, advanceSpaced (Leitner). Фиксированный `now`.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	advanceSpaced,
	birthdaysFromWiki,
	collectDueItems,
	computeDue,
	loadReminders,
	nextOccurrence,
	parseIso,
	parseReminders,
} from './reminders.js';

const NOW = DateTime.fromISO('2026-06-08T10:00:00+03:00', { setZone: true });

describe('parseIso', () => {
	it('ISO с offset → tz-aware', () => {
		const d = parseIso('2026-06-15T09:00:00+03:00');
		expect(d?.isValid).toBe(true);
		expect(d?.hour).toBe(9);
		expect(d?.offset).toBe(180); // +03:00 = 180 минут
	});
	it('дата без времени → полночь в зоне', () => {
		const d = parseIso('2026-06-15', 'UTC+3');
		expect(d?.hour).toBe(0);
	});
	it('мусор / null → null', () => {
		expect(parseIso('не дата')).toBeNull();
		expect(parseIso(null)).toBeNull();
		expect(parseIso('')).toBeNull();
	});
});

describe('parseReminders', () => {
	const text = [
		'# Reminders',
		'---',
		'id: buy-tickets',
		'title: Купить билеты',
		'kind: oneoff',
		'due_at: 2026-06-08T12:00:00+03:00',
		'status: pending',
		'---',
		'id: bday-ivan',
		'kind: recurring',
		'rrule: FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=20',
		'created: 2020-06-20T09:00:00+03:00',
		'status: pending',
	].join('\n');

	it('преамбула отбрасывается, 2 блока распарсены', () => {
		const rems = parseReminders(text);
		expect(rems.map((r) => r.id)).toEqual(['buy-tickets', 'bday-ivan']);
		expect(rems[0]?.kind).toBe('oneoff');
		expect(rems[0]?.dueAt?.isValid).toBe(true);
	});

	it('inline-комментарий и кавычки снимаются', () => {
		const rems = parseReminders(['---', 'id: x', "title: 'Привет'", 'box: 2  # ступень'].join('\n'));
		expect(rems[0]?.title).toBe('Привет');
		expect(rems[0]?.box).toBe(2);
	});
});

describe('computeDue', () => {
	const mk = (over: Record<string, string>): string =>
		['---', ...Object.entries(over).map(([k, v]) => `${k}: ${v}`)].join('\n');

	it('в пределах grace → due (upcoming=false)', () => {
		const rems = parseReminders(mk({ id: 'a', due_at: '2026-06-08T10:03:00+03:00' }));
		const due = computeDue(rems, { now: NOW });
		expect(due).toHaveLength(1);
		expect(due[0]?.upcoming).toBe(false);
	});

	it('в пределах lookahead → upcoming=true', () => {
		const rems = parseReminders(mk({ id: 'b', due_at: '2026-06-10T10:00:00+03:00' }));
		expect(computeDue(rems, { now: NOW })[0]?.upcoming).toBe(true);
	});

	it('дальше lookahead → исключён', () => {
		const rems = parseReminders(mk({ id: 'c', due_at: '2026-06-30T10:00:00+03:00' }));
		expect(computeDue(rems, { now: NOW })).toHaveLength(0);
	});

	it('status=done → исключён', () => {
		const rems = parseReminders(mk({ id: 'd', due_at: '2026-06-08T10:01:00+03:00', status: 'done' }));
		expect(computeDue(rems, { now: NOW })).toHaveLength(0);
	});

	it('уже стреляли сегодня → дедуп', () => {
		const rems = parseReminders(
			mk({ id: 'e', due_at: '2026-06-08T10:01:00+03:00', last_fired: '2026-06-08T08:00:00+03:00' }),
		);
		expect(computeDue(rems, { now: NOW })).toHaveLength(0);
	});

	it('recurring без due_at выводит due из rrule', () => {
		const rems = parseReminders(
			mk({
				id: 'rec',
				kind: 'recurring',
				rrule: 'FREQ=DAILY',
				created: '2026-06-01T10:02:00+03:00',
			}),
		);
		// FREQ=DAILY от created 10:02 → сегодня 10:02 (в пределах grace от 10:00? нет, +2мин ≤5 → due).
		const due = computeDue(rems, { now: NOW });
		expect(due).toHaveLength(1);
		expect(due[0]?.kind).toBe('recurring');
	});
});

describe('nextOccurrence (RRULE)', () => {
	it('FREQ=YEARLY → следующий день рождения', () => {
		const dtstart = DateTime.fromISO('2020-06-20T09:00:00+03:00', { setZone: true });
		const occ = nextOccurrence('FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=20', dtstart, NOW, true);
		expect(occ?.year).toBe(2026);
		expect(occ?.month).toBe(6);
		expect(occ?.day).toBe(20);
		expect(occ?.hour).toBe(9);
	});
	it('битый RRULE → null', () => {
		const dtstart = DateTime.fromISO('2020-06-20T09:00:00+03:00', { setZone: true });
		expect(nextOccurrence('НЕ ПРАВИЛО', dtstart, NOW)).toBeNull();
	});
});

describe('birthdaysFromWiki', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'wiki-test-'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const person = (name: string, body: string): void => {
		const people = join(dir, 'people');
		mkdirSync(people, { recursive: true });
		writeFileSync(join(people, name), body, 'utf8');
	};

	it('день рождения через 2 дня → upcoming; сегодня → due + «исполняется N»', () => {
		person('ivan.md', '---\ntitle: Иван Пример\nbirthday: 06-10\n---\n# Иван\n');
		person('petr.md', '---\ntitle: Пётр Пример\nbirthday: 1990-06-08\n---\n# Пётр\n');
		const items = birthdaysFromWiki(dir, { now: NOW });
		const ivan = items.find((i) => i.title.includes('Иван'));
		const petr = items.find((i) => i.title.includes('Пётр'));
		expect(ivan?.upcoming).toBe(true);
		expect(petr?.upcoming).toBe(false);
		expect(petr?.detail).toBe('исполняется 36 лет');
	});

	it('пропускает dot-папки (.quarantine) — изоляция P0-1', () => {
		const q = join(dir, '.quarantine', 'people');
		mkdirSync(q, { recursive: true });
		writeFileSync(join(q, 'secret.md'), '---\ntitle: Чужой\nbirthday: 06-09\n---\n', 'utf8');
		expect(birthdaysFromWiki(dir, { now: NOW })).toHaveLength(0);
	});
});

describe('collectDueItems (интеграция)', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'collect-test-'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('объединяет reminders + дни рождения, строго-due раньше upcoming', () => {
		const remPath = join(dir, 'reminders.md');
		writeFileSync(
			remPath,
			['---', 'id: now-task', 'due_at: 2026-06-08T10:02:00+03:00', 'status: pending'].join('\n'),
			'utf8',
		);
		const wiki = join(dir, 'wiki');
		mkdirSync(wiki, { recursive: true });
		writeFileSync(join(wiki, 'ivan.md'), '---\ntitle: Иван\nbirthday: 06-11\n---\n', 'utf8');

		const items = collectDueItems(remPath, wiki, { now: NOW });
		expect(items.length).toBe(2);
		expect(items[0]?.upcoming).toBe(false); // строго-due реминдер первым
		expect(items[1]?.upcoming).toBe(true); // upcoming-ДР после
	});

	it('пустой путь reminders → пусто (валидно)', () => {
		expect(loadReminders(join(dir, 'нет.md'))).toEqual([]);
	});
});

describe('advanceSpaced (Leitner)', () => {
	it('null/отрицательный → box 0, интервал 1', () => {
		expect(advanceSpaced(null)).toEqual([0, 1]);
		expect(advanceSpaced(-5)).toEqual([0, 1]);
	});
	it('продвигает по лесенке', () => {
		expect(advanceSpaced(0)).toEqual([1, 3]);
		expect(advanceSpaced(1)).toEqual([2, 7]);
		expect(advanceSpaced(3)).toEqual([4, 35]);
	});
	it('потолок на последней ступени', () => {
		expect(advanceSpaced(4)).toEqual([4, 35]);
		expect(advanceSpaced(10)).toEqual([4, 35]);
	});
});
