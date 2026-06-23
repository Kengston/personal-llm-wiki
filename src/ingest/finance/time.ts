/**
 * time.ts — tz-aware границы периодов для финансовых roll-up'ов.
 *
 * Контекст ([ADR-0018]):
 *   Финансовые агрегации (день/неделя/месяц) должны работать в таймзоне
 *   пользователя — «сегодня» в Москве ≠ «сегодня» в UTC. Этот модуль
 *   предоставляет чистые функции без side-эффектов для вычисления начала/конца
 *   периода.
 *
 * КОНВЕНЦИЯ ДЛЯ 'week':
 *   Используем ISO-8601 week: неделя начинается в ПОНЕДЕЛЬНИК (day=1),
 *   заканчивается в ВОСКРЕСЕНЬЕ (day=7). Это международный стандарт и
 *   соответствует weekday-нумерации Luxon (1=пн, 7=вс).
 *   Пример: если at = среда 2025-01-15, то
 *     week start = 2025-01-13T00:00:00 (пн)
 *     week end   = 2025-01-19T23:59:59.999 (вс конец дня)
 *
 * ГРАНИЦЫ:
 *   start — начало периода (00:00:00.000 в tz).
 *   end   — ВКЛЮЧИТЕЛЬНЫЙ конец периода (23:59:59.999 в tz).
 *   Это «closed interval» семантика — удобна для фильтрации по ts >= start && ts <= end.
 *
 * ЗАВИСИМОСТЬ: только luxon (уже в package.json), нет импортов из финмодуля.
 * Это намеренно — time.ts используется и в других частях вики (будущие digest и т.п.).
 */

import { DateTime } from 'luxon';

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

/**
 * PeriodKind — тип периода для агрегации.
 * - 'day'   — один календарный день (00:00–23:59:59.999 в tz)
 * - 'week'  — ISO-неделя (пн 00:00 – вс 23:59:59.999 в tz, см. конвенцию выше)
 * - 'month' — один календарный месяц (1-е число 00:00 – последний день 23:59:59.999 в tz)
 */
export type PeriodKind = 'day' | 'week' | 'month';

/**
 * PeriodBounds — результат periodBounds: начало и конец периода в ISO-8601.
 *
 * Оба поля — строки ISO-8601 с сохранением timezone из входного DateTime
 * (или из параметра tz если вход был строкой ISO). Это позволяет читателю
 * делать простое сравнение строк ts >= start && ts <= end.
 */
export interface PeriodBounds {
	/** Начало периода: 00:00:00.000 первого дня в tz. ISO-8601. */
	start: string;
	/** Конец периода: 23:59:59.999 последнего дня в tz. ISO-8601. */
	end: string;
}

// ---------------------------------------------------------------------------
// Внутренние вспомогательные функции
// ---------------------------------------------------------------------------

/**
 * startOfDayInZone — возвращает начало дня (00:00:00.000) в указанной tz.
 * Если входной DateTime уже в нужной tz — просто startOf('day').
 * Если tz не валидна — бросает InvalidZoneError (поведение Luxon).
 */
function startOfDayInZone(dt: DateTime, tz: string): DateTime {
	return dt.setZone(tz).startOf('day');
}

/**
 * endOfDay — возвращает конец дня (23:59:59.999) для данного DateTime.
 * Использует endOf('day') из Luxon — гарантирует 23:59:59.999.
 */
function endOfDay(dt: DateTime): DateTime {
	return dt.endOf('day');
}

// ---------------------------------------------------------------------------
// Основная функция: periodBounds
// ---------------------------------------------------------------------------

/**
 * periodBounds — возвращает начало и конец периода в tz-aware виде.
 *
 * @param kind — тип периода: 'day' | 'week' | 'month'
 * @param tz   — IANA timezone name, напр. "Europe/Moscow", "UTC", "Asia/Tbilisi".
 *               Передаётся в Luxon setZone — невалидная tz выбросит Invalid DateTime.
 * @param at   — момент внутри периода. Принимает:
 *               - DateTime (Luxon) — используется напрямую (переводится в tz)
 *               - string           — ISO-8601 строка, парсится через DateTime.fromISO()
 *
 * @returns PeriodBounds — { start, end } в ISO-8601, timezone-aware.
 *
 * Гарантии:
 *   - start всегда ≤ at ≤ end (at всегда ВНУТРИ периода)
 *   - Нет off-by-one на стыке месяцев/лет (Luxon обрабатывает через startOf/endOf)
 *   - Для 'week': пн-вс (ISO-неделя), не вс-сб
 *
 * Примеры:
 *   periodBounds('day', 'Europe/Moscow', '2025-01-15T10:00:00Z')
 *   → { start: "2025-01-15T00:00:00.000+03:00", end: "2025-01-15T23:59:59.999+03:00" }
 *
 *   periodBounds('month', 'Europe/Moscow', '2025-02-28T23:00:00Z')
 *   → { start: "2025-02-01T00:00:00.000+03:00", end: "2025-02-28T23:59:59.999+03:00" }
 *
 *   periodBounds('week', 'Europe/Moscow', '2025-01-15T10:00:00Z')  // среда
 *   → { start: "2025-01-13T00:00:00.000+03:00", end: "2025-01-19T23:59:59.999+03:00" }
 */
export function periodBounds(kind: PeriodKind, tz: string, at: DateTime | string): PeriodBounds {
	// Парсим входной момент.
	const dt: DateTime =
		typeof at === 'string'
			? DateTime.fromISO(at, { zone: tz }) // ISO-строка: парсим сразу в tz
			: at.setZone(tz); // DateTime: переводим в tz

	// Находим начало периода в зависимости от kind.
	let periodStart: DateTime;

	if (kind === 'day') {
		// День: начало текущего дня в tz.
		periodStart = startOfDayInZone(dt, tz);
	} else if (kind === 'week') {
		// ISO-неделя (пн–вс): переходим к началу дня, затем к началу недели.
		// Luxon startOf('week') использует ISO-weekday: weekday 1 = пн, 7 = вс.
		// Это соответствует нашей конвенции.
		periodStart = startOfDayInZone(dt, tz).startOf('week');
	} else {
		// kind === 'month': начало первого дня месяца.
		periodStart = startOfDayInZone(dt, tz).startOf('month');
	}

	// Конец периода — конец последнего дня.
	// Используем endOf('day') / endOf('week') / endOf('month') — Luxon ставит
	// milliseconds = 999, seconds = 59, minutes = 59, hours = 23.
	let periodEnd: DateTime;

	if (kind === 'day') {
		periodEnd = endOfDay(periodStart);
	} else if (kind === 'week') {
		// Конец ISO-недели = последняя миллисекунда воскресенья.
		periodEnd = periodStart.endOf('week');
	} else {
		// Конец месяца — endOf('month') даёт последний день месяца 23:59:59.999.
		// Это корректно для января (31 дней), февраля (28/29), и любых других.
		periodEnd = periodStart.endOf('month');
	}

	// Возвращаем ISO-строки с timezone-offset (не UTC) — так легче читать и отлаживать.
	// Пример: "2025-01-15T00:00:00.000+03:00" для Europe/Moscow.
	return {
		start: periodStart.toISO() ?? '',
		end: periodEnd.toISO() ?? '',
	};
}

// ---------------------------------------------------------------------------
// Вспомогательная функция: isoToBounds (удобный alias)
// ---------------------------------------------------------------------------

/**
 * isoToBounds — удобная обёртка над periodBounds для ISO-строк.
 *
 * Семантически эквивалентна periodBounds(kind, tz, at) где at — ISO-строка.
 * Вынесена для явности вызова в коде, где всегда работают с ISO-строками.
 *
 * @param kind  — тип периода
 * @param tz    — IANA timezone
 * @param atISO — ISO-8601 строка момента внутри периода
 */
export function isoToBounds(kind: PeriodKind, tz: string, atISO: string): PeriodBounds {
	return periodBounds(kind, tz, atISO);
}
