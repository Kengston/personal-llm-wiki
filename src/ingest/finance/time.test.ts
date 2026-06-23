/**
 * time.test.ts — тесты tz-aware границ периодов (periodBounds).
 *
 * Принципы:
 *   - Все данные синтетические (FAKE даты, нет PII).
 *   - Нет сетевых запросов и внешних зависимостей — чисто функциональные тесты.
 *   - lint:public остаётся зелёным.
 *
 * Покрытие:
 *   1. Границы 'day' в конкретной tz (Europe/Moscow, UTC, Asia/Tbilisi).
 *   2. Границы 'week' — ISO-неделя (пн–вс), проверяем что среда попадает в пн–вс.
 *   3. Границы 'month' — обычный и короткий месяц, стык год (декабрь/январь).
 *   4. Отсутствие off-by-one на стыке месяца/года.
 *   5. DateTime на границе: последняя секунда дня → тот же день, не следующий.
 *   6. Поддержка DateTime объекта на входе (не только строки).
 *   7. isoToBounds — удобный alias работает идентично periodBounds.
 */

import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';

import { isoToBounds, periodBounds } from './time.js';

// ---------------------------------------------------------------------------
// Вспомогательные функции для тестов
// ---------------------------------------------------------------------------

/**
 * parseStart — парсит ISO-строку начала периода и возвращает DateTime в tz.
 * Используем для проверки конкретных компонентов даты (год, месяц, день, час).
 */
function parseStart(bounds: { start: string }, tz: string): DateTime {
	return DateTime.fromISO(bounds.start, { zone: tz });
}

/**
 * parseEnd — парсит ISO-строку конца периода.
 */
function parseEnd(bounds: { end: string }, tz: string): DateTime {
	return DateTime.fromISO(bounds.end, { zone: tz });
}

// ---------------------------------------------------------------------------
// 1. Границы 'day'
// ---------------------------------------------------------------------------

describe('periodBounds: day — границы дня', () => {
	it('начало дня = 00:00:00.000 в Europe/Moscow', () => {
		// synthetic-example: середина дня по Москве
		const bounds = periodBounds('day', 'Europe/Moscow', '2025-01-15T10:00:00Z');
		const start = parseStart(bounds, 'Europe/Moscow');

		expect(start.hour).toBe(0);
		expect(start.minute).toBe(0);
		expect(start.second).toBe(0);
		expect(start.millisecond).toBe(0);
	});

	it('конец дня = 23:59:59.999 в Europe/Moscow', () => {
		// synthetic-example
		const bounds = periodBounds('day', 'Europe/Moscow', '2025-01-15T10:00:00Z');
		const end = parseEnd(bounds, 'Europe/Moscow');

		expect(end.hour).toBe(23);
		expect(end.minute).toBe(59);
		expect(end.second).toBe(59);
		expect(end.millisecond).toBe(999);
	});

	it('начало дня: правильная дата по tz (не UTC)', () => {
		// synthetic-example: 23:00 UTC = следующий день по Москве (+3)
		// 2025-01-15T23:00:00Z = 2025-01-16T02:00:00+03:00 → день = Jan 16 по Москве
		const bounds = periodBounds('day', 'Europe/Moscow', '2025-01-15T23:00:00Z');
		const start = parseStart(bounds, 'Europe/Moscow');

		expect(start.day).toBe(16);
		expect(start.month).toBe(1);
		expect(start.year).toBe(2025);
	});

	it('тот же день при UTC-23:00 (start UTC) = Jan 15 в UTC', () => {
		// synthetic-example: 23:00 UTC → в UTC это ещё Jan 15
		const bounds = periodBounds('day', 'UTC', '2025-01-15T23:00:00Z');
		const start = parseStart(bounds, 'UTC');

		expect(start.day).toBe(15);
		expect(start.month).toBe(1);
	});

	it('последняя миллисекунда дня → тот же день (не следующий)', () => {
		// synthetic-example: 23:59:59.999 в Europe/Moscow → конец того же дня
		const bounds = periodBounds('day', 'Europe/Moscow', '2025-01-15T23:59:59.999+03:00');
		const start = parseStart(bounds, 'Europe/Moscow');
		const end = parseEnd(bounds, 'Europe/Moscow');

		// Оба — один и тот же день
		expect(start.day).toBe(end.day);
		expect(start.day).toBe(15);
	});

	it('Asia/Tbilisi (+4): 21:00 UTC = следующий день в Тбилиси', () => {
		// synthetic-example: 21:00 UTC = 01:00 следующего дня в Тбилиси
		// 2025-01-15T21:00:00Z = 2025-01-16T01:00:00+04:00 → Jan 16
		const bounds = periodBounds('day', 'Asia/Tbilisi', '2025-01-15T21:00:00Z');
		const start = parseStart(bounds, 'Asia/Tbilisi');

		expect(start.day).toBe(16);
	});
});

// ---------------------------------------------------------------------------
// 2. Границы 'week' — ISO-неделя (пн–вс)
// ---------------------------------------------------------------------------

describe('periodBounds: week — ISO-неделя (пн–вс)', () => {
	it('среда → начало недели = понедельник', () => {
		// synthetic-example: 2025-01-15 — среда
		const bounds = periodBounds('week', 'Europe/Moscow', '2025-01-15T10:00:00Z');
		const start = parseStart(bounds, 'Europe/Moscow');

		// 2025-01-13 = понедельник
		expect(start.weekday).toBe(1); // 1 = понедельник в Luxon
		expect(start.day).toBe(13);
		expect(start.month).toBe(1);
	});

	it('среда → конец недели = воскресенье', () => {
		// synthetic-example: 2025-01-15 — среда
		const bounds = periodBounds('week', 'Europe/Moscow', '2025-01-15T10:00:00Z');
		const end = parseEnd(bounds, 'Europe/Moscow');

		// 2025-01-19 = воскресенье
		expect(end.weekday).toBe(7); // 7 = воскресенье в Luxon
		expect(end.day).toBe(19);
		expect(end.month).toBe(1);
	});

	it('понедельник → начало недели = тот же понедельник', () => {
		// synthetic-example: 2025-01-13 — понедельник
		const bounds = periodBounds('week', 'Europe/Moscow', '2025-01-13T10:00:00Z');
		const start = parseStart(bounds, 'Europe/Moscow');

		expect(start.weekday).toBe(1);
		expect(start.day).toBe(13);
	});

	it('воскресенье → конец недели = тот же воскресенье', () => {
		// synthetic-example: 2025-01-19 — воскресенье
		const bounds = periodBounds('week', 'Europe/Moscow', '2025-01-19T10:00:00Z');
		const end = parseEnd(bounds, 'Europe/Moscow');

		expect(end.weekday).toBe(7);
		expect(end.day).toBe(19);
	});

	it('начало недели: 00:00:00.000 в tz', () => {
		// synthetic-example
		const bounds = periodBounds('week', 'Europe/Moscow', '2025-01-15T10:00:00Z');
		const start = parseStart(bounds, 'Europe/Moscow');

		expect(start.hour).toBe(0);
		expect(start.minute).toBe(0);
		expect(start.second).toBe(0);
		expect(start.millisecond).toBe(0);
	});

	it('конец недели: 23:59:59.999 в tz', () => {
		// synthetic-example
		const bounds = periodBounds('week', 'Europe/Moscow', '2025-01-15T10:00:00Z');
		const end = parseEnd(bounds, 'Europe/Moscow');

		expect(end.hour).toBe(23);
		expect(end.minute).toBe(59);
		expect(end.second).toBe(59);
		expect(end.millisecond).toBe(999);
	});

	it('неделя на стыке месяца: Jan 29 → пн Jan 27 — вс Feb 2', () => {
		// synthetic-example: 2025-01-29 — среда, неделя: пн 27 Jan — вс 2 Feb
		const bounds = periodBounds('week', 'Europe/Moscow', '2025-01-29T10:00:00Z');
		const start = parseStart(bounds, 'Europe/Moscow');
		const end = parseEnd(bounds, 'Europe/Moscow');

		expect(start.day).toBe(27);
		expect(start.month).toBe(1);
		expect(end.day).toBe(2);
		expect(end.month).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// 3. Границы 'month' — обычный, короткий, стык года
// ---------------------------------------------------------------------------

describe('periodBounds: month — границы месяца', () => {
	it('начало месяца = 1-е число 00:00:00.000', () => {
		// synthetic-example: середина января
		const bounds = periodBounds('month', 'Europe/Moscow', '2025-01-15T10:00:00Z');
		const start = parseStart(bounds, 'Europe/Moscow');

		expect(start.day).toBe(1);
		expect(start.month).toBe(1);
		expect(start.hour).toBe(0);
		expect(start.minute).toBe(0);
	});

	it('конец января = 31-е 23:59:59.999', () => {
		// synthetic-example
		const bounds = periodBounds('month', 'Europe/Moscow', '2025-01-15T10:00:00Z');
		const end = parseEnd(bounds, 'Europe/Moscow');

		expect(end.day).toBe(31);
		expect(end.month).toBe(1);
		expect(end.hour).toBe(23);
		expect(end.millisecond).toBe(999);
	});

	it('февраль 2025 (не високосный) = 28 дней', () => {
		// synthetic-example: 2025-02-10 → конец месяца = Feb 28
		const bounds = periodBounds('month', 'Europe/Moscow', '2025-02-10T10:00:00Z');
		const end = parseEnd(bounds, 'Europe/Moscow');

		expect(end.day).toBe(28);
		expect(end.month).toBe(2);
	});

	it('февраль 2024 (високосный) = 29 дней', () => {
		// synthetic-example: 2024-02-15 → конец = Feb 29
		const bounds = periodBounds('month', 'Europe/Moscow', '2024-02-15T10:00:00Z');
		const end = parseEnd(bounds, 'Europe/Moscow');

		expect(end.day).toBe(29);
		expect(end.month).toBe(2);
	});

	it('декабрь: конец = Dec 31 23:59:59.999 (не Jan 1)', () => {
		// synthetic-example: нет off-by-one на стыке года
		const bounds = periodBounds('month', 'Europe/Moscow', '2025-12-15T10:00:00Z');
		const end = parseEnd(bounds, 'Europe/Moscow');

		expect(end.day).toBe(31);
		expect(end.month).toBe(12);
		expect(end.year).toBe(2025); // не переходит в следующий год
	});

	it('январь следующего года: начало = Jan 1', () => {
		// synthetic-example: 2026-01-01 → начало = Jan 1 2026
		const bounds = periodBounds('month', 'UTC', '2026-01-01T00:00:00Z');
		const start = parseStart(bounds, 'UTC');

		expect(start.day).toBe(1);
		expect(start.month).toBe(1);
		expect(start.year).toBe(2026);
	});

	it('месяц 30 дней: апрель = Apr 30', () => {
		// synthetic-example
		const bounds = periodBounds('month', 'UTC', '2025-04-15T00:00:00Z');
		const end = parseEnd(bounds, 'UTC');

		expect(end.day).toBe(30);
		expect(end.month).toBe(4);
	});
});

// ---------------------------------------------------------------------------
// 4. Инвариант: at всегда внутри [start, end]
// ---------------------------------------------------------------------------

describe('periodBounds: at всегда внутри периода', () => {
	const cases: Array<{ kind: 'day' | 'week' | 'month'; tz: string; at: string }> = [
		// synthetic-examples
		{ kind: 'day', tz: 'Europe/Moscow', at: '2025-01-15T10:00:00Z' },
		{ kind: 'day', tz: 'UTC', at: '2025-06-30T23:59:59Z' },
		{ kind: 'week', tz: 'Europe/Moscow', at: '2025-01-15T10:00:00Z' },
		{ kind: 'week', tz: 'Asia/Tbilisi', at: '2025-12-31T20:00:00Z' },
		{ kind: 'month', tz: 'Europe/Moscow', at: '2025-02-28T23:59:59Z' },
		{ kind: 'month', tz: 'UTC', at: '2024-02-29T12:00:00Z' },
	];

	for (const { kind, tz, at } of cases) {
		it(`at ∈ [start, end] для ${kind}/${tz} at=${at.slice(0, 16)}`, () => {
			const bounds = periodBounds(kind, tz, at);

			// Преобразуем в числа для сравнения (Unix ms).
			const atMs = DateTime.fromISO(at).toMillis();
			const startMs = DateTime.fromISO(bounds.start).toMillis();
			const endMs = DateTime.fromISO(bounds.end).toMillis();

			expect(startMs).toBeLessThanOrEqual(atMs);
			expect(atMs).toBeLessThanOrEqual(endMs);
		});
	}
});

// ---------------------------------------------------------------------------
// 5. Вход DateTime объект (не строка)
// ---------------------------------------------------------------------------

describe('periodBounds: вход DateTime объект', () => {
	it('DateTime на входе работает как ISO-строка', () => {
		// synthetic-example: создаём DateTime явно
		const dt = DateTime.fromISO('2025-01-15T10:00:00Z', { zone: 'Europe/Moscow' });
		const boundsFromDt = periodBounds('day', 'Europe/Moscow', dt);
		const boundsFromStr = periodBounds('day', 'Europe/Moscow', '2025-01-15T10:00:00Z');

		// Оба должны дать одинаковый результат.
		const startDt = parseStart(boundsFromDt, 'Europe/Moscow');
		const startStr = parseStart(boundsFromStr, 'Europe/Moscow');

		expect(startDt.day).toBe(startStr.day);
		expect(startDt.month).toBe(startStr.month);
		expect(startDt.year).toBe(startStr.year);
	});

	it('DateTime в другой tz переводится в целевую tz', () => {
		// synthetic-example: DateTime в UTC, запрашиваем в Europe/Moscow
		const dt = DateTime.fromISO('2025-01-15T23:00:00Z'); // UTC
		const bounds = periodBounds('day', 'Europe/Moscow', dt);
		const start = parseStart(bounds, 'Europe/Moscow');

		// 23:00 UTC = 02:00 MSK следующего дня → Jan 16
		expect(start.day).toBe(16);
	});
});

// ---------------------------------------------------------------------------
// 6. isoToBounds — удобный alias
// ---------------------------------------------------------------------------

describe('isoToBounds: alias для periodBounds', () => {
	it('isoToBounds идентичен periodBounds', () => {
		// synthetic-example
		const iso = '2025-01-15T10:00:00Z';
		const tz = 'Europe/Moscow';

		const direct = periodBounds('month', tz, iso);
		const alias = isoToBounds('month', tz, iso);

		expect(alias.start).toBe(direct.start);
		expect(alias.end).toBe(direct.end);
	});

	it('isoToBounds для week даёт правильные границы', () => {
		// synthetic-example: пятница 2025-01-17 → пн 13 — вс 19
		const bounds = isoToBounds('week', 'UTC', '2025-01-17T10:00:00Z');
		const start = DateTime.fromISO(bounds.start, { zone: 'UTC' });
		const end = DateTime.fromISO(bounds.end, { zone: 'UTC' });

		expect(start.weekday).toBe(1); // понедельник
		expect(end.weekday).toBe(7);   // воскресенье
	});
});
