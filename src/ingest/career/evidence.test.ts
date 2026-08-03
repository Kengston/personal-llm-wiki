/**
 * evidence.test.ts — импорт машинного замера в метрики ([ADR-0028]).
 *
 * Главное, что проверяется: повторный импорт того же `snapshot_id` — no-op (иначе файл
 * растёт на каждом прогоне скрипта), а изменившееся число поднимает `evidence_stale`.
 *
 * Снапшоты синтетические: имена репозиториев вида `synthetic-*`, круглые числа.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	deriveEvidenceMetrics,
	formatEvidenceImport,
	importEvidenceSnapshot,
	parseEvidenceSnapshot,
	type EvidenceSnapshot,
} from './evidence.js';
import { createCareerLedger, loadCareerBase, type CareerLedger } from './store.js';

let tmpDir: string;
let ledger: CareerLedger;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'career-evidence-test-'));
	ledger = createCareerLedger({
		dir: join(tmpDir, 'raw', 'career'),
		publicRepoRoot: join(tmpDir, 'public-fake'),
	});
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Синтетический вывод `CAREER_FORMAT=json` — ровно та форма, что печатает скрипт. */
const SNAPSHOT: EvidenceSnapshot = {
	snapshot_id: 'aaaa11112222',
	repo_count: 2,
	total_commits: 300,
	repos: [
		{
			name: 'synthetic-alpha',
			commits: 200,
			first_commit: '2024-02-01',
			last_commit: '2026-07-01',
			added: 5000,
			removed: 1000,
		},
		{
			name: 'synthetic-beta',
			commits: 100,
			first_commit: '2025-01-01',
			last_commit: '2026-06-01',
			added: 2000,
			removed: 500,
		},
	],
	dropped_duplicates: ['synthetic-alpha-clone (200 коммитов) — дубль synthetic-alpha'],
	extensions: [{ ext: '.ts', files_touched: 400 }],
};

const REF = { snapshot_id: SNAPSHOT.snapshot_id, path: 'raw/career/evidence-synthetic.md' };
const TS = '2026-08-02T10:00:00Z';

// ---------------------------------------------------------------------------
// 1. Разбор и вывод метрик
// ---------------------------------------------------------------------------

describe('parseEvidenceSnapshot', () => {
	it('разбирает вывод скрипта и срезает лишние поля', () => {
		const parsed = parseEvidenceSnapshot({ ...SNAPSHOT, unknown_field: 'ignored' });

		expect(parsed.snapshot_id).toBe('aaaa11112222');
		expect(parsed.repos).toHaveLength(2);
		expect(parsed).not.toHaveProperty('unknown_field');
	});

	it('мусор вместо снапшота — исключение, а не пустой импорт', () => {
		expect(() => parseEvidenceSnapshot({ snapshot_id: 'x' })).toThrow();
		expect(() => parseEvidenceSnapshot('не json')).toThrow();
	});
});

describe('deriveEvidenceMetrics', () => {
	it('выводит агрегаты замера с source: evidence и ссылкой на снапшот', () => {
		const metrics = deriveEvidenceMetrics(SNAPSHOT, REF, TS);
		const byKey = new Map(metrics.map((m) => [m.key, m]));

		expect(byKey.get('commits.total')!.value).toBe(300);
		expect(byKey.get('repos.count')!.value).toBe(2);
		expect(byKey.get('code.lines_added')!.value).toBe(7000);
		expect(byKey.get('code.lines_removed')!.value).toBe(1500);
		// 2024-02 → 2026-07 включительно = 30 месяцев.
		expect(byKey.get('activity.months_span')!.value).toBe(30);

		for (const m of metrics) {
			expect(m.source).toBe('evidence');
			expect(m.evidence_ref).toEqual(REF);
		}
	});

	it('as_of берётся из данных (самый поздний коммит), а не из часов', () => {
		// Иначе одно и то же измерение получало бы разную дату при каждом прогоне.
		for (const m of deriveEvidenceMetrics(SNAPSHOT, REF, TS)) {
			expect(m.as_of).toBe('2026-07-01');
		}
	});

	it('имена репозиториев и расширения в метрики не попадают', () => {
		const serialized = JSON.stringify(deriveEvidenceMetrics(SNAPSHOT, REF, TS));

		expect(serialized).not.toContain('synthetic-alpha');
		expect(serialized).not.toContain('.ts');
	});

	it('замер без репозиториев даёт пустой набор, а не нули', () => {
		expect(deriveEvidenceMetrics({ ...SNAPSHOT, repos: [] }, REF, TS)).toEqual([]);
	});

	it('вывод детерминирован при одинаковом входе', () => {
		expect(deriveEvidenceMetrics(SNAPSHOT, REF, TS)).toEqual(
			deriveEvidenceMetrics(SNAPSHOT, REF, TS),
		);
	});
});

// ---------------------------------------------------------------------------
// 2. Импорт: идемпотентность и расхождения
// ---------------------------------------------------------------------------

describe('importEvidenceSnapshot', () => {
	it('первый импорт записывает метрики в леджер', () => {
		const result = importEvidenceSnapshot(ledger, SNAPSHOT, REF, TS);

		expect(result.written).toHaveLength(5);
		expect(result.unchanged).toEqual([]);
		expect(loadCareerBase(ledger).metrics.get('commits.total')!.value).toBe(300);
	});

	it('повторный импорт того же snapshot_id — no-op', () => {
		importEvidenceSnapshot(ledger, SNAPSHOT, REF, TS);
		// Второй прогон скрипта на неизменившихся репозиториях: тот же id, те же числа,
		// но другой момент записи — строк дописываться не должно.
		const second = importEvidenceSnapshot(ledger, SNAPSHOT, REF, '2026-08-03T10:00:00Z');

		expect(second.written).toEqual([]);
		expect(second.unchanged).toHaveLength(5);
		// Файл не вырос: в состоянии по-прежнему пять метрик с первым ts.
		const metrics = loadCareerBase(ledger).metrics;
		expect(metrics.size).toBe(5);
		expect(metrics.get('commits.total')!.ts).toBe(TS);
	});

	it('изменившееся число поднимает evidence_stale и записывает новое значение', () => {
		importEvidenceSnapshot(ledger, SNAPSHOT, REF, TS);

		const newer: EvidenceSnapshot = {
			...SNAPSHOT,
			snapshot_id: 'bbbb33334444',
			total_commits: 350,
		};
		const newerRef = { snapshot_id: newer.snapshot_id, path: 'raw/career/evidence-newer.md' };
		const result = importEvidenceSnapshot(ledger, newer, newerRef, '2026-09-01T10:00:00Z');

		expect(result.drift).toEqual([
			{
				key: 'commits.total',
				previous_snapshot_id: 'aaaa11112222',
				previous_value: 300,
				value: 350,
			},
		]);
		expect(loadCareerBase(ledger).metrics.get('commits.total')!.value).toBe(350);
	});

	it('новый снапшот с теми же числами перезаписывает пин, но расхождением не считается', () => {
		importEvidenceSnapshot(ledger, SNAPSHOT, REF, TS);

		const same: EvidenceSnapshot = { ...SNAPSHOT, snapshot_id: 'cccc55556666' };
		const sameRef = { snapshot_id: same.snapshot_id, path: 'raw/career/evidence-same.md' };
		const result = importEvidenceSnapshot(ledger, same, sameRef, '2026-09-01T10:00:00Z');

		expect(result.drift).toEqual([]);
		expect(result.written).toHaveLength(5);
		expect(loadCareerBase(ledger).metrics.get('commits.total')!.evidence_ref!.snapshot_id).toBe(
			'cccc55556666',
		);
	});

	it('ключ, занятый ручной метрикой, импорт не затирает', () => {
		// [ADR-0028]: несогласие с замером оформляется записью business/manual — значит
		// обратно импорт не имеет права стереть осознанно введённое число.
		ledger.append('metrics', {
			key: 'commits.total',
			value: 1,
			unit: 'count',
			as_of: '2026-01-01',
			source: 'manual',
			ts: '2026-01-01T00:00:00Z',
		});

		const result = importEvidenceSnapshot(ledger, SNAPSHOT, REF, TS);

		expect(result.conflicts).toEqual([{ key: 'commits.total', existing_source: 'manual' }]);
		expect(loadCareerBase(ledger).metrics.get('commits.total')!.value).toBe(1);
		// Остальные метрики записались — конфликт по одному ключу не отменяет импорт.
		expect(result.written).toHaveLength(4);
	});
});

// ---------------------------------------------------------------------------
// 3. Отчёт владельцу
// ---------------------------------------------------------------------------

describe('formatEvidenceImport', () => {
	it('называет расхождения и пропуски явно', () => {
		importEvidenceSnapshot(ledger, SNAPSHOT, REF, TS);
		const newer: EvidenceSnapshot = {
			...SNAPSHOT,
			snapshot_id: 'bbbb33334444',
			total_commits: 350,
		};
		const text = formatEvidenceImport(
			importEvidenceSnapshot(
				ledger,
				newer,
				{ snapshot_id: newer.snapshot_id, path: 'raw/career/evidence-newer.md' },
				'2026-09-01T10:00:00Z',
			),
		);

		expect(text).toContain('evidence_stale: commits.total было 300');
		expect(text).toContain('стало 350');
	});
});
