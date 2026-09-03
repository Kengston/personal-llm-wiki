/**
 * reviews.ts — журнал повторений учебного контура ([ADR-0034]).
 *
 * `raw/learning/reviews.jsonl` — тот же леджер-механизм, что у финансов, карьеры и поиска
 * работы ([ADR-0028]), со своей спекой. Три вещи, которые здесь неочевидны:
 *
 *   1. СОСТОЯНИЕ ЖИВЁТ ТОЛЬКО ЗДЕСЬ. Страница концепции (`wiki/concepts/<slug>.md`) box
 *      Лейтнера не хранит: копия дрейфовала бы, а lint копий не видит. Коробка концепции —
 *      это `box_after` её последнего события в журнале, и ничего больше.
 *
 *   2. ЛЕСЕНКА НЕ ДУБЛИРУЕТСЯ. `LEITNER_LADDER` и `advanceSpaced` уже написаны и покрыты
 *      тестами в `scheduler/reminders.ts` — этот файл их первый вызывающий в рантайме.
 *      Второй копии интервалов Лейтнера в проекте быть не должно.
 *
 *   3. `skipped` — ПРО КОНКРЕТНУЮ КОНЦЕПЦИЮ, а не про день целиком. Коробка при пропуске
 *      не меняется (`nextBox` возвращает её как есть), и `due()` не двигает по пропуску
 *      «давность»: иначе пропуск повторения выглядел бы как само повторение и прятал бы
 *      концепцию от следующего занятия — ровно то, чего ADR-0034 просит избежать.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import { Ledger, type LedgerOptions, type LedgerSpec } from '../ledger.js';
import { advanceSpaced, LEITNER_LADDER } from '../../scheduler/reminders.js';

const isoTimestamp = z.string().min(1);
const slugId = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9][a-z0-9_.-]*$/);

// ---------------------------------------------------------------------------
// review — одно событие журнала
// ---------------------------------------------------------------------------

export const REVIEW_KINDS = ['ingest', 'lesson', 'quiz', 'recall', 'skipped'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const ReviewEventSchema = z.object({
	ts: isoTimestamp,
	/** Ссылка на `wiki/concepts/<slug>.md` по slug, без пути и расширения. */
	concept: slugId,
	kind: z.enum(REVIEW_KINDS),
	/** Доля правильного 0–1. Отсутствует у `ingest` (первое знакомство) и `skipped`. */
	score: z.number().min(0).max(1).optional(),
	/** Коробка ПОСЛЕ этого события — состояние, которое `due()` читает как текущее. */
	box_after: z
		.number()
		.int()
		.min(0)
		.max(LEITNER_LADDER.length - 1),
	/** Урок, в рамках которого произошло событие (`lessons/0007-...html`). */
	lesson_ref: z.string().max(200).optional(),
});

export type ReviewEvent = z.infer<typeof ReviewEventSchema>;

// ---------------------------------------------------------------------------
// Леджер
// ---------------------------------------------------------------------------

export const LEARNING_LEDGER_FILES = { reviews: 'reviews.jsonl' } as const;

export type LearningRecordMap = { reviews: ReviewEvent };

/**
 * resolveLearningDir — `raw/learning/` приватного репо. Та же лесенка, что у поиска
 * работы, карьеры и финансов — окружение ведёт себя предсказуемо во всех модулях.
 */
export function resolveLearningDir(env: NodeJS.ProcessEnv = process.env): string {
	if (env.LEARNING_RAW_DIR) return resolve(env.LEARNING_RAW_DIR);
	if (env.RAW_DIR) return resolve(join(env.RAW_DIR, 'learning'));
	const contentRoot = env.CONTENT_ROOT ?? join(homedir(), 'llm-wiki-content');
	return resolve(join(contentRoot, 'raw', 'learning'));
}

export const LEARNING_LEDGER: LedgerSpec<LearningRecordMap> = {
	files: LEARNING_LEDGER_FILES,
	schemas: { reviews: ReviewEventSchema },
	resolveDir: resolveLearningDir,
};

export type LearningLedger = Ledger<LearningRecordMap>;

/** createLearningLedger — леджер учебного контура с переданными опциями. */
export function createLearningLedger(opts: LedgerOptions = {}): LearningLedger {
	return new Ledger(LEARNING_LEDGER, opts);
}

// ---------------------------------------------------------------------------
// nextBox — продвижение по лесенке Лейтнера
// ---------------------------------------------------------------------------

/**
 * Порог успеха для `score`. Ниже методология не даёт числа — берём 0.6 как «в основном
 * верно» (сам порог решает `learn-review`, здесь только точка принятия решения названа).
 */
const PASS_THRESHOLD = 0.6;

/**
 * nextBox — коробка ПОСЛЕ события, чистая функция без обращения к журналу.
 *
 * `ingest` — первое знакомство, всегда box 0. `skipped` — коробка не меняется: пропуск
 * повторения не есть повторение. `lesson`/`quiz`/`recall` — рост ровно через
 * `advanceSpaced` (единственный способ продвинуться в проекте), провал или отсутствующий
 * `score` — назад в box 0: тест без числа не отличим от заваленного, и оставлять коробку
 * на месте значило бы засчитывать неизвестность за успех.
 *
 * @param previousBox — коробка ДО события (0, если концепция встречается впервые)
 * @param kind        — вид события
 * @param score       — доля правильного 0–1, если применимо
 */
export function nextBox(previousBox: number, kind: ReviewKind, score?: number): number {
	if (kind === 'skipped') return previousBox;
	if (kind === 'ingest') return 0;
	if (score !== undefined && score >= PASS_THRESHOLD) return advanceSpaced(previousBox)[0];
	return 0;
}

// ---------------------------------------------------------------------------
// due — что пора повторять
// ---------------------------------------------------------------------------

/** Состояние одной концепции с признаком просрочки. */
export interface DueEntry {
	concept: string;
	/** Текущая коробка (из `box_after` последнего события). */
	box: number;
	/** Момент последнего ДЕЙСТВИТЕЛЬНОГО повторения (без `skipped`). */
	lastReviewAt: string;
	/** Сколько дней прошло с `lastReviewAt` на момент `now`. */
	daysSinceReview: number;
	/** `true` — просрочена по интервалу коробки; ровно одна запись с `false` — добавка. */
	overdue: boolean;
}

export interface DueOptions {
	/** Момент расчёта. Аргумент, а не часы внутри — вызов воспроизводим. */
	now?: string;
	/** Лесенка интервалов (дни). По умолчанию — общая `LEITNER_LADDER`. */
	ladder?: readonly number[];
}

/** daysBetween — разница в днях между двумя ISO-моментами. */
function daysBetween(fromIso: string, toIso: string): number {
	return (Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000;
}

interface ConceptState {
	concept: string;
	box: number;
	lastReviewAt: string;
}

/**
 * foldConcept — состояние одной концепции из ЕЁ потока событий, отсортированного по `ts`.
 *
 * `box` — `box_after` последнего события ЛЮБОГО вида (по конвенции `nextBox` в `skipped`
 * событии он уже равен предыдущему, так что читать его не глядя на вид события корректно).
 * `lastReviewAt` — `ts` последнего НЕ-`skipped` события: пропуск не двигает «давность»,
 * иначе пропущенная концепция пряталась бы от следующего занятия дольше, чем повторённая.
 */
function foldConcept(concept: string, events: ReviewEvent[]): ConceptState {
	const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
	const last = sorted[sorted.length - 1]!;
	const genuine = [...sorted].reverse().find((e) => e.kind !== 'skipped');
	return {
		concept,
		box: last.box_after,
		lastReviewAt: (genuine ?? last).ts,
	};
}

/**
 * due — детерминированный список «что пора» ([ADR-0034]).
 *
 * Порядок: сначала просроченные (коробка по возрастанию — сперва то, что забывается
 * быстрее всего; при равной коробке давность по убыванию), затем ОДНА не просроченная
 * концепция с самым старым `lastReviewAt` — интерливинг. Выбор всегда детерминирован
 * (при равенстве — по имени концепции), случайности в коде нет: иначе тест недоказуем.
 *
 * @param entries — весь журнал (или его срез), `readAll('reviews')`
 * @param opts    — момент расчёта и лесенка интервалов
 */
export function due(entries: ReviewEvent[], opts: DueOptions = {}): DueEntry[] {
	const now = opts.now ?? new Date().toISOString();
	const ladder = opts.ladder ?? LEITNER_LADDER;

	const byConcept = new Map<string, ReviewEvent[]>();
	for (const e of entries) {
		const list = byConcept.get(e.concept);
		if (list) list.push(e);
		else byConcept.set(e.concept, [e]);
	}

	const states = [...byConcept.entries()]
		.map(([concept, events]) => foldConcept(concept, events))
		.sort((a, b) => a.concept.localeCompare(b.concept));

	const overdue: DueEntry[] = [];
	const notOverdue: ConceptState[] = [];

	for (const state of states) {
		const interval = ladder[state.box] ?? ladder[ladder.length - 1] ?? 0;
		const daysSinceReview = daysBetween(state.lastReviewAt, now);
		if (daysSinceReview >= interval) {
			overdue.push({ ...state, daysSinceReview, overdue: true });
		} else {
			notOverdue.push(state);
		}
	}

	// Просроченные: коробка по возрастанию, при равенстве — давность по убыванию.
	overdue.sort(
		(a, b) =>
			a.box - b.box || b.daysSinceReview - a.daysSinceReview || a.concept.localeCompare(b.concept),
	);

	// Интерливинг: ОДНА самая давно не повторявшаяся из непросроченных, добавляется ПОСЛЕ
	// просроченных — отсюда общий результат называется result, а не overdue.
	notOverdue.sort(
		(a, b) => a.lastReviewAt.localeCompare(b.lastReviewAt) || a.concept.localeCompare(b.concept),
	);
	const pick = notOverdue[0];

	const result: DueEntry[] = [...overdue];
	if (pick) {
		result.push({ ...pick, daysSinceReview: daysBetween(pick.lastReviewAt, now), overdue: false });
	}

	return result;
}
