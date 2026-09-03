/**
 * reviews.test.ts — журнал повторений учебного контура ([ADR-0034]).
 *
 * Три вещи, ради которых модель именно такая, и проверяются они прямо:
 *   - рост коробки идёт ровно через `advanceSpaced` (второй копии лесенки Лейтнера в
 *     проекте нет), провал и отсутствующий `score` возвращают в box 0;
 *   - `skipped` не двигает ни коробку, ни «давность» — иначе пропуск повторения выглядел
 *     бы как само повторение и прятал бы концепцию от следующего занятия;
 *   - выбор «что пора» полностью детерминирован: интерливинг-добавка берётся из
 *     непросроченных по самому старому `lastReviewAt`, без случайности.
 *
 * Данные синтетические.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { advanceSpaced, LEITNER_LADDER } from '../../scheduler/reminders.js';
import { LedgerValidationError } from '../ledger.js';
import {
	createLearningLedger,
	due,
	nextBox,
	resolveLearningDir,
	type LearningLedger,
	type ReviewEvent,
} from './reviews.js';

function review(
	concept: string,
	ts: string,
	kind: ReviewEvent['kind'],
	boxAfter: number,
	patch: Partial<ReviewEvent> = {},
): ReviewEvent {
	return { ts, concept, kind, box_after: boxAfter, ...patch };
}

// ---------------------------------------------------------------------------
// 1. Леджер
// ---------------------------------------------------------------------------

let tmpDir: string;
let ledger: LearningLedger;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'learning-reviews-test-'));
	ledger = createLearningLedger({
		dir: join(tmpDir, 'raw', 'learning'),
		publicRepoRoot: join(tmpDir, 'public-fake'),
	});
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe('леджер reviews.jsonl', () => {
	it('валидная запись пишется и читается обратно', () => {
		ledger.append('reviews', review('spaced-repetition', '2026-09-01T09:30:00Z', 'ingest', 0));

		expect(existsSync(join(tmpDir, 'raw', 'learning', 'reviews.jsonl'))).toBe(true);
		expect(ledger.readAll('reviews')).toEqual([
			review('spaced-repetition', '2026-09-01T09:30:00Z', 'ingest', 0),
		]);
	});

	it('kind вне словаря и box_after вне лесенки отвергаются', () => {
		expect(() =>
			ledger.append(
				'reviews',
				review('x', '2026-09-01T09:30:00Z', 'ingest' as ReviewEvent['kind'], 0, {
					kind: 'exam' as ReviewEvent['kind'],
				}),
			),
		).toThrow(LedgerValidationError);

		expect(() =>
			ledger.append(
				'reviews',
				review('x', '2026-09-01T09:30:00Z', 'ingest', LEITNER_LADDER.length),
			),
		).toThrow(LedgerValidationError);
	});

	it('resolveLearningDir уважает порядок переменных окружения', () => {
		expect(resolveLearningDir({ CONTENT_ROOT: '/synthetic' } as NodeJS.ProcessEnv)).toBe(
			join('/synthetic', 'raw', 'learning'),
		);
		expect(resolveLearningDir({ RAW_DIR: '/synthetic/raw' } as NodeJS.ProcessEnv)).toBe(
			join('/synthetic/raw', 'learning'),
		);
		expect(
			resolveLearningDir({ LEARNING_RAW_DIR: '/synthetic/learning' } as NodeJS.ProcessEnv),
		).toBe(join('/synthetic/learning'));
	});
});

// ---------------------------------------------------------------------------
// 2. nextBox — продвижение по лесенке
// ---------------------------------------------------------------------------

describe('nextBox', () => {
	it('коробка растёт при успехе — ровно через advanceSpaced', () => {
		expect(nextBox(0, 'lesson', 0.8)).toBe(advanceSpaced(0)[0]);
		expect(nextBox(2, 'quiz', 1)).toBe(advanceSpaced(2)[0]);
	});

	it('коробка падает при провале — назад в box 0', () => {
		expect(nextBox(3, 'quiz', 0.2)).toBe(0);
	});

	it('score не задан для оцениваемого вида — как провал, не как «непонятно»', () => {
		// Иначе занятие без записанной оценки молча сохраняло бы высокую коробку.
		expect(nextBox(3, 'recall', undefined)).toBe(0);
	});

	it('ingest — всегда box 0 независимо от прошлой коробки', () => {
		expect(nextBox(4, 'ingest')).toBe(0);
	});

	it('skipped не двигает коробку', () => {
		expect(nextBox(3, 'skipped')).toBe(3);
		expect(nextBox(0, 'skipped', 0)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 3. due — что пора повторять
// ---------------------------------------------------------------------------

describe('due', () => {
	const NOW = '2026-09-03T00:00:00Z';

	it('пустой журнал даёт пустой результат без исключения', () => {
		expect(due([], { now: NOW })).toEqual([]);
	});

	it('просрочка считается по интервалу коробки (LEITNER_LADDER[box] дней)', () => {
		// box 0 → интервал 1 день ([1, 3, 7, 16, 35]).
		const overdueEntries = [review('a', '2026-08-30T00:00:00Z', 'ingest', 0)]; // 4 дня назад
		const freshEntries = [review('b', '2026-09-02T12:00:00Z', 'ingest', 0)]; // 12 часов назад

		const overdueResult = due(overdueEntries, { now: NOW });
		const freshResult = due(freshEntries, { now: NOW });

		expect(overdueResult.find((r) => r.concept === 'a')?.overdue).toBe(true);
		// Единственная непросроченная концепция сама становится интерливинг-добавкой.
		expect(freshResult.find((r) => r.concept === 'b')?.overdue).toBe(false);
	});

	it('ровно интервал коробки — уже просрочено: граница включающая', () => {
		// Все прочие расстояния в этом файле — 0.5, 2, 4, 14, 20, 33 дня, то есть заведомо
		// по одну или другую сторону. Поэтому строгость сравнения (`>=` против `>`) не была
		// зафиксирована ничем, и мутация проходила незамеченной. Фиксируем: «пора» наступает
		// в тот момент, когда интервал истёк, а не сутками позже.
		const exactly = [review('a', '2026-09-02T00:00:00Z', 'ingest', 0)]; // box 0 → интервал 1 день

		const result = due(exactly, { now: '2026-09-03T00:00:00Z' });

		expect(result.find((r) => r.concept === 'a')?.overdue).toBe(true);
	});

	it('добавка-interleaving берётся НЕ из просроченных, а из самой давней непросроченной', () => {
		const entries = [
			// Просрочена: box 0 (интервал 1 день), не повторялась 20 дней.
			review('overdue-1', '2026-08-14T00:00:00Z', 'ingest', 0),
			// Не просрочена (box 2 → интервал 7 дней, прошло 5), но давнее всех непросроченных.
			review('stale-not-overdue', '2026-08-29T00:00:00Z', 'lesson', 2, { score: 0.9 }),
			// Не просрочена и повторялась совсем недавно — не должна быть выбрана.
			review('fresh-not-overdue', '2026-09-02T18:00:00Z', 'ingest', 0),
		];

		const result = due(entries, { now: NOW });

		const overdue = result.filter((r) => r.overdue);
		const addition = result.filter((r) => !r.overdue);

		expect(overdue.map((r) => r.concept)).toEqual(['overdue-1']);
		expect(addition).toHaveLength(1);
		expect(addition[0]?.concept).toBe('stale-not-overdue');
	});

	it('событие skipped не двигает "давность" — просрочка считается от предыдущего повторения', () => {
		const entries = [
			review('x', '2026-08-01T00:00:00Z', 'ingest', 0),
			// Успех продвигает в box 1 (интервал 3 дня), но случился 20 дней назад.
			review('x', '2026-08-14T00:00:00Z', 'lesson', 1, { score: 0.9 }),
			// Пропуск сегодня НЕ должен выглядеть как повторение и гасить просрочку.
			review('x', '2026-09-02T23:00:00Z', 'skipped', 1),
		];

		const result = due(entries, { now: NOW });
		const state = result.find((r) => r.concept === 'x');

		expect(state?.box).toBe(1);
		expect(state?.overdue).toBe(true);
		expect(state?.lastReviewAt).toBe('2026-08-14T00:00:00Z');
	});

	it('порядок просроченных: коробка по возрастанию, давность по убыванию', () => {
		const entries = [
			// box 1 (интервал 3 дня), просрочена на много.
			review('slow-forgetter', '2026-08-01T00:00:00Z', 'lesson', 1, { score: 0.9 }),
			// box 0 (интервал 1 день), просрочена сильнее по времени, но коробка ниже.
			review('fast-forgetter-old', '2026-08-20T00:00:00Z', 'ingest', 0),
			review('fast-forgetter-new', '2026-09-01T00:00:00Z', 'ingest', 0),
		];

		const result = due(entries, { now: NOW });
		const overdueConcepts = result.filter((r) => r.overdue).map((r) => r.concept);

		expect(overdueConcepts).toEqual(['fast-forgetter-old', 'fast-forgetter-new', 'slow-forgetter']);
	});
});
