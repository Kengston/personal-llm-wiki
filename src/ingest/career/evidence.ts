/**
 * evidence.ts — импорт машинного замера в метрики карьерной базы ([ADR-0028]).
 *
 * Источник — `scripts/career-evidence.sh` в режиме `CAREER_FORMAT=json`. Скрипт
 * считает по локальным git-репозиториям число коммитов, объём кода и даты, дедуплицирует
 * клоны по хешу корневого коммита и печатает стабильный `snapshot_id`, посчитанный от
 * ОТСОРТИРОВАННЫХ ДАННЫХ (время в хеш не входит). Отсюда главное свойство: повторный
 * прогон на неизменившихся репозиториях даёт тот же идентификатор — и повторный импорт
 * обязан быть no-op, а не второй строкой с тем же числом.
 *
 * Что импортируется: ТОЛЬКО агрегированные числа. Имена репозиториев, пути и список
 * расширений в леджер не попадают — метрика это число с единицей, датой и источником,
 * а не выгрузка рабочего окружения ([ADR-0003]: приватность, и глоссарий §1.1: evidence
 * это «N коммитов в M репозиториях с даты X», а не перечень).
 *
 * Расхождение с ADR, названное вслух: [ADR-0028] («Следствия») требует от скрипта JSON
 * вида `{ snapshot_id, taken_at, metrics: [...] }`, а скрипт отдаёт сырые агрегаты
 * (`repos[]`, `total_commits`, `extensions[]`). Словарь метрик выведен здесь, в TS, —
 * так он покрыт тестами и живёт рядом со схемой, которая его валидирует, а не в bash.
 * Числа при этом те же самые: `deriveEvidenceMetrics` ничего не досчитывает сверх
 * содержимого снапшота.
 */

import { z } from 'zod';

import { MetricRecordSchema, type MetricRecord } from './types.js';
import { loadCareerBase, type CareerLedger } from './store.js';

// ---------------------------------------------------------------------------
// Форма снапшота (то, что реально печатает скрипт)
// ---------------------------------------------------------------------------

/** Одна строка замера: репозиторий и его агрегаты по коммитам владельца. */
const EvidenceRepoSchema = z.object({
	name: z.string(),
	commits: z.number().int().nonnegative(),
	/** Дата первого и последнего коммита владельца, `YYYY-MM-DD`. */
	first_commit: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	last_commit: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	added: z.number().int().nonnegative(),
	removed: z.number().int().nonnegative(),
});

/**
 * EvidenceSnapshotSchema — машиночитаемый вывод `CAREER_FORMAT=json`.
 * Лишние поля zod срежет: скрипт вправе печатать больше, чем нужно импортёру.
 */
export const EvidenceSnapshotSchema = z.object({
	snapshot_id: z.string().min(1),
	repo_count: z.number().int().nonnegative(),
	total_commits: z.number().int().nonnegative(),
	repos: z.array(EvidenceRepoSchema),
	dropped_duplicates: z.array(z.string()).default([]),
	extensions: z.array(z.object({ ext: z.string(), files_touched: z.number().int() })).default([]),
});

export type EvidenceSnapshot = z.infer<typeof EvidenceSnapshotSchema>;

/**
 * parseEvidenceSnapshot — разбирает JSON скрипта в типизированный снапшот.
 * Бросает ZodError при несоответствии формы: импорт мусора хуже отсутствия импорта.
 */
export function parseEvidenceSnapshot(raw: unknown): EvidenceSnapshot {
	return EvidenceSnapshotSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// Вывод метрик из снапшота (чистая функция)
// ---------------------------------------------------------------------------

/**
 * monthsSpan — сколько месяцев охватывает диапазон дат, включительно.
 *
 * Считается строковой арифметикой по `YYYY-MM-DD`, без `Date`: часовой пояс хоста не
 * должен влиять на число в резюме, а `new Date('2024-02-01')` уже зависит от него.
 */
function monthsSpan(firstDate: string, lastDate: string): number {
	const [fy, fm] = firstDate.split('-').map(Number) as [number, number];
	const [ly, lm] = lastDate.split('-').map(Number) as [number, number];
	return (ly - fy) * 12 + (lm - fm) + 1;
}

/** Пути метрик, которые модуль выводит из замера. Больше нигде не дублировать. */
export const EVIDENCE_METRIC_KEYS = {
	commits: 'commits.total',
	repos: 'repos.count',
	linesAdded: 'code.lines_added',
	linesRemoved: 'code.lines_removed',
	monthsSpan: 'activity.months_span',
} as const;

/** Ссылка на снапшот, из которого пришла метрика ([ADR-0028]: `metric.evidence_ref`). */
export interface EvidenceRef {
	snapshot_id: string;
	/** Относительный путь к файлу снапшота внутри приватного репо. */
	path: string;
}

/**
 * deriveEvidenceMetrics — превращает снапшот в набор метрик `source: evidence`.
 *
 * Чистая функция: ни IO, ни часов. `as_of` берётся из САМИХ ДАННЫХ (самый поздний
 * коммит), а не из момента запуска — иначе одно и то же измерение получало бы разную
 * дату при каждом прогоне, и «на какое число это верно» переставало бы быть ответом.
 * `ts` (момент записи строки) передаётся снаружи.
 *
 * @param snapshot — разобранный вывод скрипта
 * @param ref      — snapshot_id + путь к файлу снапшота
 * @param ts       — ISO-момент записи строк в леджер
 */
export function deriveEvidenceMetrics(
	snapshot: EvidenceSnapshot,
	ref: EvidenceRef,
	ts: string,
): MetricRecord[] {
	if (snapshot.repos.length === 0) return [];

	// Границы активности — по всем репозиториям сразу.
	const firstCommit = snapshot.repos.reduce(
		(min, r) => (r.first_commit < min ? r.first_commit : min),
		snapshot.repos[0]!.first_commit,
	);
	const lastCommit = snapshot.repos.reduce(
		(max, r) => (r.last_commit > max ? r.last_commit : max),
		snapshot.repos[0]!.last_commit,
	);

	const added = snapshot.repos.reduce((sum, r) => sum + r.added, 0);
	const removed = snapshot.repos.reduce((sum, r) => sum + r.removed, 0);

	const base = { as_of: lastCommit, source: 'evidence' as const, evidence_ref: ref, ts };

	return [
		{ key: EVIDENCE_METRIC_KEYS.commits, value: snapshot.total_commits, unit: 'count', ...base },
		{ key: EVIDENCE_METRIC_KEYS.repos, value: snapshot.repo_count, unit: 'count', ...base },
		{ key: EVIDENCE_METRIC_KEYS.linesAdded, value: added, unit: 'count', ...base },
		{ key: EVIDENCE_METRIC_KEYS.linesRemoved, value: removed, unit: 'count', ...base },
		{
			key: EVIDENCE_METRIC_KEYS.monthsSpan,
			value: monthsSpan(firstCommit, lastCommit),
			unit: 'months',
			...base,
		},
	].map((m) => MetricRecordSchema.parse(m));
}

// ---------------------------------------------------------------------------
// Импорт в леджер
// ---------------------------------------------------------------------------

/**
 * EvidenceDrift — расхождение нового замера с уже импортированным (`evidence_stale`).
 *
 * Само по себе не ошибка: замер и должен меняться. Но вариант резюме пинится к
 * `snapshot_id` ([ADR-0028]), и владелец обязан узнать, какие именно числа разъехались, —
 * иначе «обновил evidence» тихо меняет содержимое уже отправленного резюме.
 */
export interface EvidenceDrift {
	key: string;
	previous_snapshot_id: string;
	previous_value: number;
	value: number;
}

/**
 * EvidenceConflict — ключ метрики занят записью, введённой руками.
 *
 * [ADR-0028]: evidence-метрики руками не редактируются, несогласие оформляется записью
 * класса `business`/`manual`. Обратная сторона того же правила: импорт не имеет права
 * затирать осознанно введённое число. Ключ пропускается, владельцу сообщается.
 */
export interface EvidenceConflict {
	key: string;
	existing_source: 'business' | 'manual';
}

/** Результат импорта — что записано, что совпало, что разъехалось, что конфликтует. */
export interface EvidenceImportResult {
	snapshot_id: string;
	/** Метрики, дописанные в леджер. */
	written: MetricRecord[];
	/** Ключи, у которых уже лежит ровно то же значение из того же снапшота. */
	unchanged: string[];
	/** Расхождения с ранее импортированным замером (`evidence_stale`). */
	drift: EvidenceDrift[];
	/** Ключи, занятые ручными записями — импорт их не трогает. */
	conflicts: EvidenceConflict[];
}

/**
 * importEvidenceSnapshot — записывает метрики замера в карьерный леджер.
 *
 * Идемпотентность: перед записью читается текущее состояние базы. Если метрика с этим
 * ключом уже пришла из ЭТОГО ЖЕ снапшота и значение совпадает — строка не дописывается.
 * Поэтому повторный прогон скрипта без изменений в репозиториях не растит файл и не
 * меняет состояние (`snapshot_id` детерминирован — на этом всё и держится).
 *
 * @param ledger   — карьерный леджер
 * @param snapshot — разобранный снапшот
 * @param ref      — snapshot_id + путь к файлу снапшота в приватном репо
 * @param ts       — ISO-момент записи (инъекция часов, как в финансовом модуле)
 */
export function importEvidenceSnapshot(
	ledger: CareerLedger,
	snapshot: EvidenceSnapshot,
	ref: EvidenceRef,
	ts: string,
): EvidenceImportResult {
	const derived = deriveEvidenceMetrics(snapshot, ref, ts);
	const existing = loadCareerBase(ledger).metrics;

	const result: EvidenceImportResult = {
		snapshot_id: snapshot.snapshot_id,
		written: [],
		unchanged: [],
		drift: [],
		conflicts: [],
	};

	for (const metric of derived) {
		const prev = existing.get(metric.key);

		// Ключ занят ручной записью — не трогаем и говорим об этом вслух.
		if (prev && prev.source !== 'evidence') {
			result.conflicts.push({ key: metric.key, existing_source: prev.source });
			continue;
		}

		// Тот же снапшот и то же число — записывать нечего.
		if (prev?.evidence_ref?.snapshot_id === ref.snapshot_id && prev.value === metric.value) {
			result.unchanged.push(metric.key);
			continue;
		}

		// Значение разъехалось с ранее импортированным замером — это evidence_stale.
		if (prev && prev.value !== metric.value && prev.evidence_ref) {
			result.drift.push({
				key: metric.key,
				previous_snapshot_id: prev.evidence_ref.snapshot_id,
				previous_value: prev.value,
				value: metric.value,
			});
		}

		ledger.append('metrics', metric);
		result.written.push(metric);
	}

	return result;
}

/**
 * formatEvidenceImport — детерминированный отчёт об импорте для владельца.
 * Формулировок не сочиняет и чисел не округляет: сколько записано, что разъехалось.
 */
export function formatEvidenceImport(result: EvidenceImportResult): string {
	const lines = [`Замер ${result.snapshot_id}: записано ${result.written.length} метрик`];

	if (result.unchanged.length > 0) {
		lines.push(`Без изменений (${result.unchanged.length}): ${result.unchanged.join(', ')}`);
	}
	for (const d of result.drift) {
		lines.push(
			`evidence_stale: ${d.key} было ${d.previous_value} (замер ${d.previous_snapshot_id}), стало ${d.value}`,
		);
	}
	for (const c of result.conflicts) {
		lines.push(`Пропущено: ${c.key} занят записью источника ${c.existing_source}`);
	}

	return lines.join('\n');
}
