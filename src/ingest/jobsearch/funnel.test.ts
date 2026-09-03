/**
 * funnel.test.ts — воронка откликов: свод событий, метрики, экспорт ([ADR-0030]).
 *
 * Три вещи, ради которых модель именно событийная, и проверяются они прямо:
 *   - стадия НИГДЕ не хранится — она вычисляется, и заявка, ушедшая до оффера, остаётся
 *     в знаменателе предыдущей стадии (у статус-модели этого не получается);
 *   - касание не двигает стадию и не сбрасывает таймер молчания;
 *   - значение не ходит без `n`, а пустой знаменатель — прочерк, а не «0 %».
 *
 * Данные синтетические.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LedgerValidationError } from '../ledger.js';
import {
	foldApplication,
	type ApplicationEvent,
	type ApplicationRecord,
	type ApplicationStage,
} from './events.js';
import {
	computeFunnel,
	dedupeApplications,
	durationStat,
	formatRate,
	rate,
	wilson,
	TREND_N,
} from './funnel.js';
import { createJobsearchLedger, type JobsearchLedger } from './ledger.js';
import { buildFunnelXlsx, buildXlsx, columnName } from './xlsx.js';

const ASOF = '2026-08-02T00:00:00Z';

function application(id: string, patch: Partial<ApplicationRecord> = {}): ApplicationRecord {
	return {
		id,
		company_id: 'acme-example-com',
		role_title: 'Backend Engineer',
		company_source: 'manual',
		submission_channel: 'direct',
		applied_at: '2026-06-01T00:00:00Z',
		ts: '2026-06-01T00:00:00Z',
		...patch,
	};
}

let seq = 0;
function stageEvent(
	appId: string,
	stage: ApplicationStage,
	ts: string,
	patch: Partial<ApplicationEvent> = {},
): ApplicationEvent {
	seq++;
	return {
		id: `ev-${seq}`,
		application_id: appId,
		ts,
		kind: 'stage_change',
		stage,
		source: 'owner',
		...patch,
	};
}

function touch(appId: string, ts: string, patch: Partial<ApplicationEvent> = {}): ApplicationEvent {
	seq++;
	return {
		id: `tp-${seq}`,
		application_id: appId,
		ts,
		kind: 'touchpoint',
		touch_kind: 'follow_up',
		source: 'owner',
		...patch,
	};
}

let tmpDir: string;
let ledger: JobsearchLedger;

beforeEach(() => {
	seq = 0;
	tmpDir = mkdtempSync(join(tmpdir(), 'jobsearch-funnel-test-'));
	ledger = createJobsearchLedger({
		dir: join(tmpDir, 'raw', 'jobsearch'),
		publicRepoRoot: join(tmpDir, 'public-fake'),
	});
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Схема событий
// ---------------------------------------------------------------------------

describe('схема событий', () => {
	it('stage обязателен ровно при stage_change, touch_kind — при touchpoint', () => {
		expect(() =>
			ledger.append('application_events', {
				id: 'bad-1',
				application_id: 'a1',
				ts: ASOF,
				kind: 'stage_change',
				source: 'owner',
			} as ApplicationEvent),
		).toThrow(LedgerValidationError);

		expect(() =>
			ledger.append('application_events', {
				id: 'bad-2',
				application_id: 'a1',
				ts: ASOF,
				kind: 'touchpoint',
				stage: 'replied',
				source: 'owner',
			} as ApplicationEvent),
		).toThrow(LedgerValidationError);
	});

	it('reason_code: other без reason_note не принимается', () => {
		// Иначе через месяц 80 % отказов имеют код other и группировка бессмысленна.
		expect(() =>
			ledger.append(
				'application_events',
				stageEvent('a1', 'rejected', ASOF, { reason_code: 'other' }),
			),
		).toThrow(LedgerValidationError);

		expect(() =>
			ledger.append(
				'application_events',
				stageEvent('a1', 'rejected', ASOF, {
					reason_code: 'other',
					reason_note: 'закрыли направление',
				}),
			),
		).not.toThrow();
	});

	it('стадия-исход без reason_code не принимается', () => {
		expect(() => ledger.append('application_events', stageEvent('a1', 'rejected', ASOF))).toThrow(
			LedgerValidationError,
		);
	});
});

// ---------------------------------------------------------------------------
// 2. foldApplication
// ---------------------------------------------------------------------------

describe('foldApplication', () => {
	it('текущая стадия — последняя из stage_change, история достигнутых сохраняется', () => {
		const state = foldApplication('a1', [
			stageEvent('a1', 'applied', '2026-06-01T00:00:00Z'),
			stageEvent('a1', 'replied', '2026-06-05T00:00:00Z'),
			stageEvent('a1', 'screening', '2026-06-10T00:00:00Z'),
		]);

		expect(state.stage).toBe('screening');
		expect(state.stagesReached).toEqual(['applied', 'replied', 'screening']);
		expect(state.firstAt.replied).toBe('2026-06-05T00:00:00Z');
	});

	it('касание не двигает стадию и не сбрасывает таймер молчания', () => {
		// Три письма в пустоту не отменяют молчания работодателя.
		const state = foldApplication('a1', [
			stageEvent('a1', 'applied', '2026-06-01T00:00:00Z'),
			touch('a1', '2026-07-01T00:00:00Z'),
			touch('a1', '2026-07-15T00:00:00Z'),
		]);

		expect(state.stage).toBe('applied');
		expect(state.lastExternalAt).toBeNull();
		expect(state.lastEventAt).toBe('2026-07-15T00:00:00Z');
	});

	it('собственные стадии владельца внешним событием не считаются', () => {
		const state = foldApplication('a1', [
			stageEvent('a1', 'applied', '2026-06-01T00:00:00Z'),
			stageEvent('a1', 'withdrawn', '2026-07-01T00:00:00Z', { reason_code: 'withdrew_own' }),
		]);

		expect(state.lastExternalAt).toBeNull();
	});

	it('void_id отменяет событие и сам в свод не входит', () => {
		// Задним числом строки не правятся — ошибка гасится компенсирующей записью.
		const wrong = stageEvent('a1', 'offer', '2026-06-05T00:00:00Z');
		const state = foldApplication('a1', [
			stageEvent('a1', 'applied', '2026-06-01T00:00:00Z'),
			wrong,
			{
				id: 'void-1',
				application_id: 'a1',
				ts: '2026-06-06T00:00:00Z',
				kind: 'touchpoint',
				touch_kind: 'other',
				source: 'owner',
				void_id: wrong.id,
			},
		]);

		expect(state.stage).toBe('applied');
		expect(state.firstAt.offer).toBeUndefined();
	});

	it('amended_id заменяет исправляемое событие собой', () => {
		const wrong = stageEvent('a1', 'screening', '2026-06-05T00:00:00Z');
		const state = foldApplication('a1', [
			stageEvent('a1', 'applied', '2026-06-01T00:00:00Z'),
			wrong,
			stageEvent('a1', 'interview', '2026-06-05T00:00:00Z', {
				id: 'amend-1',
				amended_id: wrong.id,
			}),
		]);

		expect(state.stage).toBe('interview');
		expect(state.firstAt.screening).toBeUndefined();
	});

	it('назначенные собеседования собираются для проактива', () => {
		const state = foldApplication('a1', [
			stageEvent('a1', 'interview', '2026-06-05T00:00:00Z', {
				scheduled_at: '2026-06-20T12:00:00Z',
			}),
		]);

		expect(state.scheduled).toEqual(['2026-06-20T12:00:00Z']);
	});
});

// ---------------------------------------------------------------------------
// 3. Арифметика с обязательным контекстом
// ---------------------------------------------------------------------------

describe('Rate и статистическая честность', () => {
	it('пустой знаменатель — «нет данных», а не ноль процентов', () => {
		const r = rate(0, 0);

		expect(r.value).toBeNull();
		expect(formatRate(r)).toBe('—');
	});

	it('процент никогда не печатается без абсолютов', () => {
		expect(formatRate(rate(4, 22))).toBe('18 % (4 из 22)');
	});

	it('при n < 10 разрез помечается lowN, при n < 100 считается интервал', () => {
		expect(rate(2, 5).lowN).toBe(true);
		expect(rate(2, 5).ci).not.toBeNull();
		expect(rate(20, 200).lowN).toBe(false);
		expect(rate(20, 200).ci).toBeNull();
	});

	it('интервал Уилсона показывает, что 18 % на 22 наблюдениях — это разброс', () => {
		const { low, high } = wilson(4, 22);

		expect(Math.round(low * 100)).toBeLessThanOrEqual(8);
		expect(Math.round(high * 100)).toBeGreaterThanOrEqual(38);
	});

	it('длительности — медиана и p75, не среднее', () => {
		// Один ответ через три месяца сдвинул бы среднее так, что оно перестало бы
		// описывать типичный случай.
		const stat = durationStat([1, 2, 3, 4, 90]);

		expect(stat.median).toBe(3);
		expect(stat.p75).toBe(4);
		expect(stat.n).toBe(5);
	});
});

// ---------------------------------------------------------------------------
// 3a. dedupeApplications — сведение строк леджера по id ([ADR-0029])
// ---------------------------------------------------------------------------

describe('dedupeApplications', () => {
	it('строки леджера с одним id сводятся в одну запись, а не считаются N откликами', () => {
		const rows = [
			application('a1', { ts: '2026-06-01T00:00:00Z' }),
			application('a1', { ts: '2026-06-02T00:00:00Z' }),
		];

		expect(dedupeApplications(rows)).toHaveLength(1);
	});

	it('уникальные id дедуп не трогает', () => {
		const rows = [application('a1'), application('a2')];

		expect(dedupeApplications(rows)).toHaveLength(2);
	});

	it('слияние: поле, отсутствующее в строке с более поздним ts, добирается из более ранней строки той же группы', () => {
		// Боевой паттерн (25 групп в леджере): перезапись, более поздняя
		// по ts, писалась урезанным набором полей — без applied_via, хотя он был в исходной
		// подаче. Наивный latest-wins стёр бы факт «где подал».
		const early = application('a1', { ts: '2026-06-01T00:00:00Z', applied_via: 'linkedin' });
		const late = application('a1', { ts: '2026-06-02T00:00:00Z' }); // applied_via отсутствует

		const [merged] = dedupeApplications([early, late]);

		expect(merged!.applied_via).toBe('linkedin');
		// «Текущесть» результата всё равно от поздней строки — это не «ранняя строка
		// побеждает целиком», а именно слияние двух строк в одну.
		expect(merged!.ts).toBe('2026-06-02T00:00:00Z');
	});

	it('это слияние, а не выбор одной строки: поля из разных строк группы присутствуют одновременно', () => {
		const early = application('a1', { ts: '2026-06-01T00:00:00Z', variant_id: 'ru-backend' });
		const late = application('a1', { ts: '2026-06-02T00:00:00Z', applied_via: 'hh' });

		const [merged] = dedupeApplications([early, late]);

		expect(merged!.variant_id).toBe('ru-backend');
		expect(merged!.applied_via).toBe('hh');
	});

	it('результат не зависит от порядка строк в леджере', () => {
		const early = application('a1', { ts: '2026-06-01T00:00:00Z', applied_via: 'linkedin' });
		const late = application('a1', { ts: '2026-06-02T00:00:00Z' });

		expect(dedupeApplications([early, late])).toEqual(dedupeApplications([late, early]));
	});

	it('группа из трёх строк с совпадающим ts у части из них сводится корректно (боевой паттерн леджера)', () => {
		const rows = [
			application('a1', { ts: '2026-06-01T00:00:00Z', applied_via: 'linkedin' }),
			application('a1', { ts: '2026-06-01T00:00:00Z' }), // тот же ts, без applied_via
			application('a1', { ts: '2026-06-02T00:00:00Z' }), // самая поздняя, тоже без applied_via
		];

		const merged = dedupeApplications(rows);

		expect(merged).toHaveLength(1);
		expect(merged[0]!.applied_via).toBe('linkedin');
		expect(merged[0]!.ts).toBe('2026-06-02T00:00:00Z');
	});
});

// ---------------------------------------------------------------------------
// 4. computeFunnel
// ---------------------------------------------------------------------------

describe('computeFunnel', () => {
	const opts = { asOf: ASOF, ghostAfterDays: 21, connectedSources: ['manual'] };

	it('дубли одного id по строкам леджера не задваивают total и знаменатели конверсий (регресс: 436 строк / 410 откликов в бою)', () => {
		const apps = [
			application('a1', { ts: '2026-06-01T00:00:00Z', applied_via: 'linkedin' }),
			application('a1', { ts: '2026-06-02T00:00:00Z' }), // перезапись без applied_via
		];
		const events = [stageEvent('a1', 'replied', '2026-06-05T00:00:00Z')];

		const report = computeFunnel(apps, events, opts);

		expect(report.total).toBe(1);
		expect(report.byStage.replied).toBe(1);
		expect(report.conversions['applied→replied']).toMatchObject({ numerator: 1, denominator: 1 });
	});

	it('заявка, дошедшая до оффера, остаётся в знаменателе предыдущих стадий', () => {
		// У статус-модели это и не получается: она больше не помнит, что проходила скрининг.
		const apps = [application('a1'), application('a2')];
		const events = [
			stageEvent('a1', 'replied', '2026-06-05T00:00:00Z'),
			stageEvent('a1', 'screening', '2026-06-10T00:00:00Z'),
			stageEvent('a1', 'interview', '2026-06-15T00:00:00Z'),
			stageEvent('a1', 'offer', '2026-06-25T00:00:00Z'),
			stageEvent('a2', 'replied', '2026-06-06T00:00:00Z'),
		];

		const report = computeFunnel(apps, events, opts);

		expect(report.conversions['applied→replied']).toMatchObject({ numerator: 2, denominator: 2 });
		expect(report.conversions['replied→screening']).toMatchObject({
			numerator: 1,
			denominator: 2,
		});
		expect(report.conversions['interview→offer']).toMatchObject({ numerator: 1, denominator: 1 });
	});

	it('касания в конверсии не входят — фильтр стоит на входе', () => {
		const apps = [application('a1')];
		const withTouches = [
			stageEvent('a1', 'applied', '2026-06-01T00:00:00Z'),
			touch('a1', '2026-06-10T00:00:00Z'),
			touch('a1', '2026-06-20T00:00:00Z'),
		];

		const report = computeFunnel(apps, withTouches, opts);

		expect(report.conversions['applied→replied']).toMatchObject({ numerator: 0, denominator: 1 });
	});

	it('стадия, достигнутая РАНЬШЕ предыдущей по времени, конверсию не засчитывает', () => {
		// Все остальные сценарии естественно хронологичны, поэтому проверку порядка
		// (`toAt >= fromAt`) можно было убрать, и ни один тест бы не заметил. Здесь
		// screening датирован раньше replied — пара replied→screening не должна сработать.
		const apps = [application('a1')];
		const events = [
			stageEvent('a1', 'screening', '2026-06-02T00:00:00Z'),
			stageEvent('a1', 'replied', '2026-06-10T00:00:00Z'),
		];

		const report = computeFunnel(apps, events, opts);

		expect(report.conversions['replied→screening']).toMatchObject({ numerator: 0 });
	});

	it('свежие отклики исключены из знаменателя игнора', () => {
		// Иначе право-цензурирование занижает показатель ровно на объём последней недели.
		const apps = [
			application('old', { applied_at: '2026-06-01T00:00:00Z' }),
			application('fresh', { applied_at: '2026-08-01T00:00:00Z' }),
		];

		const report = computeFunnel(apps, [], opts);

		expect(report.ghost.denominator).toBe(1);
		expect(report.ghost.numerator).toBe(1);
	});

	it('завершённые воронки в знаменатель игнора не идут — они не молчат, они закончились', () => {
		const apps = [application('a1', { applied_at: '2026-06-01T00:00:00Z' })];
		const events = [
			stageEvent('a1', 'rejected', '2026-06-10T00:00:00Z', { reason_code: 'stack_mismatch' }),
		];

		expect(computeFunnel(apps, events, opts).ghost.denominator).toBe(0);
	});

	it('ответ месяц назад и тишина после него — тоже игнор', () => {
		const apps = [application('a1', { applied_at: '2026-06-01T00:00:00Z' })];
		const events = [stageEvent('a1', 'replied', '2026-06-05T00:00:00Z')];

		expect(computeFunnel(apps, events, opts).ghost).toMatchObject({
			numerator: 1,
			denominator: 1,
		});
	});

	it('подача старая, но ответ пришёл недавно — молчания нет: отсчёт от последнего ВНЕШНЕГО события', () => {
		// Единственный сценарий, который различает «считать от последнего внешнего события»
		// и «считать от подачи». В соседних тестах оба расстояния заведомо больше порога,
		// поэтому мутация `lastExternalAt ?? applied_at` → `applied_at` их переживает.
		// Здесь подача на 62 дня раньше `asOf` при пороге 21 день, а ответ — за 3 дня до него.
		const apps = [application('a1', { applied_at: '2026-06-01T00:00:00Z' })];
		const events = [stageEvent('a1', 'replied', '2026-07-30T00:00:00Z')];

		expect(computeFunnel(apps, events, opts).ghost).toMatchObject({
			numerator: 0,
			denominator: 1,
		});
	});

	it('подтверждённое владельцем молчание не считается внешним ответом', () => {
		// `ghosted` — вывод владельца, а не наблюдение (шапка events.ts, пункт третий).
		// Пока стадия не входила в OWNER_INITIATED, она двигала lastExternalAt, и отклик,
		// про который владелец сказал «мне не ответили», попадал в числитель «есть реакция».
		const apps = [application('a1', { applied_at: '2026-06-01T00:00:00Z' })];
		const events = [
			stageEvent('a1', 'ghosted', '2026-07-30T00:00:00Z', { reason_code: 'no_response' }),
		];
		const report = computeFunnel(apps, events, opts);

		// Разрез «есть реакция» — это и есть то, что чинит попадание `ghosted` в
		// OWNER_INITIATED: без него подтверждение молчания двигало lastExternalAt и
		// отклик уходил в числитель ответивших.
		expect(report.breakdowns.company_source?.manual?.replied?.numerator).toBe(0);
		// А из самой метрики молчания отклик исключён потому, что стадия терминальная:
		// исход зафиксирован, и предикат «столько-то дней без ответа» к нему больше
		// не применяется. Это отдельное свойство, и оно не должно молча измениться.
		expect(report.ghost.denominator).toBe(0);
	});

	it('TTFR считается до первого любого ответа работодателя', () => {
		const apps = [application('a1', { applied_at: '2026-06-01T00:00:00Z' })];
		const events = [
			stageEvent('a1', 'replied', '2026-06-06T00:00:00Z'),
			stageEvent('a1', 'screening', '2026-06-11T00:00:00Z'),
		];

		expect(computeFunnel(apps, events, opts).ttfrDays.median).toBe(5);
	});

	it('разрезы считаются по каналу добычи, каналу подачи и варианту резюме', () => {
		const apps = [
			application('a1', { submission_channel: 'referral', variant_id: 'ru-backend' }),
			application('a2', { submission_channel: 'direct', variant_id: 'en-backend' }),
		];
		const events = [stageEvent('a1', 'replied', '2026-06-05T00:00:00Z')];

		const report = computeFunnel(apps, events, opts);

		expect(report.breakdowns.submission_channel.referral!.replied).toMatchObject({
			numerator: 1,
			denominator: 1,
		});
		expect(report.breakdowns.variant_id['en-backend']!.replied).toMatchObject({
			numerator: 0,
			denominator: 1,
		});
		expect(report.breakdowns.company_source.manual!.replied.denominator).toBe(2);
	});

	it('тренд запрещён, пока наблюдений меньше порога', () => {
		expect(computeFunnel([application('a1')], [], opts).trendAllowed).toBe(false);

		const many = Array.from({ length: TREND_N }, (_, i) => application(`a${i}`));
		expect(computeFunnel(many, [], opts).trendAllowed).toBe(true);
	});

	it('оговорка о покрытии перечисляет источники и не обещает рынка', () => {
		const report = computeFunnel([], [], { ...opts, connectedSources: ['manual', 'web_search'] });

		expect(report.sourceCoverage).toContain('manual, web_search');
		expect(report.sourceCoverage).toContain('полного среза рынка не существует');
	});

	it('пустая база даёт валидный отчёт, а не падение', () => {
		const report = computeFunnel([], [], opts);

		expect(report.total).toBe(0);
		expect(report.ghost.value).toBeNull();
		expect(report.ttfrDays.median).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 4a. Разрез по площадке и точка отсечения ([PRD] US 27/29/30)
// ---------------------------------------------------------------------------

describe('разрез по platform и точка отсечения по площадке', () => {
	const opts = { asOf: ASOF, ghostAfterDays: 21, connectedSources: ['manual', 'hh'] };

	it('разрез по platform считается тем же механизмом, что остальные, и совпадает с ручным подсчётом', () => {
		// Ручной подсчёт: hh — 2 отклика, у ОБОИХ есть внешнее событие (replied и rejected —
		// оба не входят в OWNER_INITIATED, оба двигают lastExternalAt) → replied 2 из 2.
		// linkedin — 1 отклик, событий нет → replied 0 из 1.
		const apps = [
			application('a1', { platform: 'hh' }),
			application('a2', { platform: 'hh' }),
			application('a3', { platform: 'linkedin' }),
		];
		const events = [
			stageEvent('a1', 'replied', '2026-06-05T00:00:00Z'),
			stageEvent('a2', 'rejected', '2026-06-06T00:00:00Z', { reason_code: 'stack_mismatch' }),
		];

		const report = computeFunnel(apps, events, opts);

		expect(report.breakdowns.platform.hh).toMatchObject({
			replied: { numerator: 2, denominator: 2 },
		});
		expect(report.breakdowns.platform.linkedin).toMatchObject({
			replied: { numerator: 0, denominator: 1 },
		});
	});

	it('отклик раньше точки отсечения своей площадки не входит в её разрез, но входит в общую конверсию', () => {
		// PRD US 27: у hh since 2026-09-01 — 78 исторических откликов не должны портить
		// конверсию ПО ПЛОЩАДКЕ, но общая воронка (applied→replied) историю не теряет.
		const apps = [
			application('old-hh', { platform: 'hh', applied_at: '2026-08-01T00:00:00Z' }),
			application('new-hh', { platform: 'hh', applied_at: '2026-09-05T00:00:00Z' }),
		];
		const events = [stageEvent('old-hh', 'replied', '2026-08-05T00:00:00Z')];

		const report = computeFunnel(apps, events, { ...opts, platformCutoffs: { hh: '2026-09-01' } });

		// Разрез «По площадке»: old-hh исключён ЦЕЛИКОМ — ни в total, ни в числитель.
		expect(report.breakdowns.platform.hh).toMatchObject({
			replied: { numerator: 0, denominator: 1 },
		});

		// Общая конверсия видит ОБА отклика — cutoff площадки её не касается.
		expect(report.conversions['applied→replied']).toMatchObject({ numerator: 1, denominator: 2 });
	});

	it('отклик ровно в день отсечения В разрезе остаётся — граница включающая', () => {
		// Соседние тесты берут даты далеко по обе стороны, поэтому семантика самого дня
		// cutoff была не зафиксирована ничем. Фиксируем явно: `since` — это «считаем С
		// этой даты», значит день отсечения принадлежит окну.
		const apps = [application('edge-hh', { platform: 'hh', applied_at: '2026-09-01T00:00:00Z' })];

		const report = computeFunnel(apps, [], { ...opts, platformCutoffs: { hh: '2026-09-01' } });

		expect(report.breakdowns.platform.hh?.replied?.denominator).toBe(1);
	});

	it('без карты отсечения разрез по площадке ведёт себя как раньше — без фильтра', () => {
		const apps = [application('a1', { platform: 'hh', applied_at: '2026-01-01T00:00:00Z' })];

		const report = computeFunnel(apps, [], opts);

		expect(report.breakdowns.platform.hh).toMatchObject({ replied: { denominator: 1 } });
	});
});

// ---------------------------------------------------------------------------
// 5. Экспорт
// ---------------------------------------------------------------------------

describe('buildXlsx', () => {
	it('собирает валидный ZIP-контейнер', () => {
		const buf = buildXlsx([{ name: 'Лист', rows: [['a', 1]] }]);

		// Сигнатура локального заголовка ZIP и хвост центральной директории.
		expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
		expect(buf.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(true);
	});

	it('детерминирован: тот же вход — те же байты', () => {
		// Таймстемпы ZIP-энтри зафиксированы; иначе «экспорт не изменился» не проверить.
		const a = buildXlsx([{ name: 'Лист', rows: [['a', 1]] }]);
		const b = buildXlsx([{ name: 'Лист', rows: [['a', 1]] }]);

		expect(a.equals(b)).toBe(true);
	});

	it('колонки нумеруются как в Excel', () => {
		expect(columnName(0)).toBe('A');
		expect(columnName(25)).toBe('Z');
		expect(columnName(26)).toBe('AA');
	});

	it('пустой список листов — ошибка, а не пустая книга', () => {
		expect(() => buildXlsx([])).toThrow();
	});

	it('книга по воронке собирается в память и не пуста', () => {
		const report = computeFunnel([application('a1')], [], {
			asOf: ASOF,
			ghostAfterDays: 21,
			connectedSources: ['manual'],
		});

		const buf = buildFunnelXlsx(report);

		expect(buf.length).toBeGreaterThan(500);
		expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
	});
});
