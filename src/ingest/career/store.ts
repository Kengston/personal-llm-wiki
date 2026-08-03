/**
 * store.ts — хранилище карьерной базы: спека леджера + свод записей в состояние.
 *
 * Записи append-only ([ADR-0028]): правка — новая строка с тем же идентификатором и
 * бо́льшим `ts`, удаление — строка с `deleted: true`. Файл на диске поэтому хранит
 * ИСТОРИЮ, а не текущее состояние; текущее состояние собирает `loadCareerBase()`
 * правилом last-wins. Это та же граница, что у воронки в [ADR-0030]: леджер хранит
 * наблюдения, свод хранит выводы.
 *
 * Мутабельных файлов в модуле нет вообще — только append, поэтому и tmp+rename здесь
 * применять не к чему. Первый мутабельный артефакт появится на рендере резюме
 * (документ с подставленными контактами, вне обоих репозиториев) — атомарная запись
 * нужна будет там, а копировать голый `writeFileSync` из `scheduler/finance-state.ts`
 * нельзя: обрыв на середине оставляет полуфайл, который читатель принимает за данные.
 *
 * Каталог — приватный `raw/career/`; path-guard общего леджера гарантирует, что
 * карьерные данные не уедут ни в публичный репо, ни в чужой модульный каталог.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { Ledger, type LedgerOptions, type LedgerSpec } from '../ledger.js';
import {
	AchievementRecordSchema,
	CAREER_LEDGER_FILES,
	ContactRecordSchema,
	EducationRecordSchema,
	LanguageRecordSchema,
	MetricRecordSchema,
	PositionRecordSchema,
	ProfileRecordSchema,
	ProjectRecordSchema,
	SkillRecordSchema,
	VariantRecordSchema,
	type AchievementRecord,
	type CareerRecordMap,
	type ContactRecord,
	type EducationRecord,
	type LanguageRecord,
	type MetricRecord,
	type PositionRecord,
	type ProfileRecord,
	type ProjectRecord,
	type SkillRecord,
	type VariantRecord,
} from './types.js';

// ---------------------------------------------------------------------------
// Разрешение путей
// ---------------------------------------------------------------------------

/**
 * resolveCareerDir — абсолютный путь к `raw/career/` приватного репо.
 *
 * Порядок поиска — как у финансового модуля, чтобы окружение вело себя предсказуемо:
 *   1. env.CAREER_RAW_DIR      — явное переопределение для тестов и нестандартных сетапов
 *   2. env.RAW_DIR + '/career' — raw-каталог из scheduler/config.ts
 *   3. env.CONTENT_ROOT + '/raw/career'
 *   4. ~/llm-wiki-content/raw/career
 */
export function resolveCareerDir(env: NodeJS.ProcessEnv = process.env): string {
	if (env.CAREER_RAW_DIR) return resolve(env.CAREER_RAW_DIR);
	if (env.RAW_DIR) return resolve(join(env.RAW_DIR, 'career'));
	const contentRoot = env.CONTENT_ROOT ?? join(homedir(), 'llm-wiki-content');
	return resolve(join(contentRoot, 'raw', 'career'));
}

// ---------------------------------------------------------------------------
// Спека леджера
// ---------------------------------------------------------------------------

/** Zod-схемы по ключу файла — вторая половина спеки (первая — имена файлов). */
const CAREER_SCHEMAS = {
	profile: ProfileRecordSchema,
	positions: PositionRecordSchema,
	achievements: AchievementRecordSchema,
	metrics: MetricRecordSchema,
	skills: SkillRecordSchema,
	education: EducationRecordSchema,
	languages: LanguageRecordSchema,
	projects: ProjectRecordSchema,
	variants: VariantRecordSchema,
	contacts: ContactRecordSchema,
} as const;

/** CAREER_LEDGER — спецификация карьерного модуля для общего класса Ledger. */
export const CAREER_LEDGER: LedgerSpec<CareerRecordMap> = {
	files: CAREER_LEDGER_FILES,
	schemas: CAREER_SCHEMAS,
	resolveDir: resolveCareerDir,
};

/** CareerLedger — леджер, специализированный картой карьерных записей. */
export type CareerLedger = Ledger<CareerRecordMap>;

/**
 * createCareerLedger — создаёт карьерный Ledger с переданными опциями.
 *
 * @param opts — опции (dir, publicRepoRoot, env, onSkip)
 */
export function createCareerLedger(opts: LedgerOptions = {}): CareerLedger {
	return new Ledger(CAREER_LEDGER, opts);
}

// ---------------------------------------------------------------------------
// Свод: история строк → текущее состояние
// ---------------------------------------------------------------------------

/**
 * CareerBase — текущее состояние карьерной базы, собранное из истории строк.
 *
 * Tombstone-записи (`deleted: true`) в результат не попадают, но участвуют в своде:
 * запись с бо́льшим `ts` и `deleted: false` возвращает сущность обратно. Иначе удаление
 * было бы необратимым, а append-only леджер как раз обещает обратное.
 */
export interface CareerBase {
	/** Профиль — последний записанный (шапка резюме одна). */
	profile: ProfileRecord | null;
	positions: PositionRecord[];
	achievements: AchievementRecord[];
	/** Метрики по `key` — основная операция над ними это точечный поиск при рендере. */
	metrics: Map<string, MetricRecord>;
	skills: SkillRecord[];
	education: EducationRecord[];
	languages: LanguageRecord[];
	projects: ProjectRecord[];
	variants: VariantRecord[];
	contacts: ContactRecord[];
}

/**
 * foldLatest — сводит историю строк к последней записи на идентификатор.
 *
 * Правило: побеждает бо́льший `ts`; при равных `ts` — та строка, что записана позже
 * (порядок в файле). Равные `ts` — не экзотика: две правки внутри одной секунды дают
 * одинаковую метку, и без правила «позже по файлу» результат зависел бы от порядка
 * обхода Map, то есть был бы недетерминированным.
 *
 * @param records — записи в порядке появления в файле
 * @param keyOf   — чем идентифицируется сущность (`id`, `key`)
 */
function foldLatest<T extends { ts: string }>(records: T[], keyOf: (r: T) => string): T[] {
	const latest = new Map<string, T>();
	for (const record of records) {
		const key = keyOf(record);
		const prev = latest.get(key);
		if (!prev || record.ts >= prev.ts) latest.set(key, record);
	}
	return [...latest.values()];
}

/** alive — убирает tombstone'ы после свода (до свода нельзя: они и есть последнее слово). */
function alive<T extends { deleted?: boolean }>(records: T[]): T[] {
	return records.filter((r) => r.deleted !== true);
}

/** byOrder — стабильная сортировка по полю `order`, тай-брейк по id. */
function byOrder<T extends { order: number; id: string }>(records: T[]): T[] {
	return [...records].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** byId — стабильная сортировка по идентификатору (для сущностей без `order`). */
function byId<T>(records: T[], keyOf: (r: T) => string): T[] {
	return [...records].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

/**
 * loadCareerBase — читает все файлы леджера и сводит их к текущему состоянию.
 *
 * Дедуп детерминирован: одинаковая история строк даёт одинаковое состояние в любом
 * порядке чтения, поэтому повторный импорт одного и того же снапшота evidence — no-op
 * на уровне результата (см. слайс импортёра).
 *
 * Битые строки леджер пропускает и отдаёт в `onSkip`, заданный при создании леджера, —
 * молчаливой потери записей здесь нет.
 */
export function loadCareerBase(ledger: CareerLedger): CareerBase {
	const profiles = foldLatest(ledger.readAll('profile'), (r) => r.id);
	// Профиль один; если строк несколько (разные id) — берём последнюю по времени записи.
	const profile =
		profiles.length === 0 ? null : profiles.reduce((best, cur) => (cur.ts >= best.ts ? cur : best));

	return {
		profile,
		positions: byOrder(alive(foldLatest(ledger.readAll('positions'), (r) => r.id))),
		achievements: byOrder(alive(foldLatest(ledger.readAll('achievements'), (r) => r.id))),
		metrics: new Map(foldLatest(ledger.readAll('metrics'), (r) => r.key).map((m) => [m.key, m])),
		skills: byId(alive(foldLatest(ledger.readAll('skills'), (r) => r.id)), (r) => r.id),
		education: byId(alive(foldLatest(ledger.readAll('education'), (r) => r.id)), (r) => r.id),
		languages: byId(
			foldLatest(ledger.readAll('languages'), (r) => r.id),
			(r) => r.id,
		),
		projects: byId(alive(foldLatest(ledger.readAll('projects'), (r) => r.id)), (r) => r.id),
		variants: byId(
			foldLatest(ledger.readAll('variants'), (r) => r.id),
			(r) => r.id,
		),
		contacts: byId(
			foldLatest(ledger.readAll('contacts'), (r) => r.key),
			(r) => r.key,
		),
	};
}
