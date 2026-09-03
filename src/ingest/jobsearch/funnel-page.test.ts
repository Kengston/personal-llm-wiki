/**
 * funnel-page.test.ts — компиляция сводки воронки в страницу вики ([PRD] US 38).
 *
 * `renderFunnelPage` ничего не читает и не пишет (см. шапку `funnel-page.ts`), поэтому шов
 * теста — обычный синтетический `FunnelReport`, а не временный каталог/леджер: репорт
 * строится через уже протестированный `computeFunnel` из тех же фабрик, что в
 * `funnel.test.ts` (`application()`, `stageEvent()`) — переписывать нетривиальную
 * структуру `FunnelReport` литералом вручную было бы лишним и хрупким дублированием.
 *
 * Проверяется то, что явно требует PRD: все стадии/числа отчёта долетают до страницы;
 * процент нигде не печатается без `n` (сканом по всему тексту, а не по одной ячейке);
 * пустой отчёт даёт валидную страницу с честным «данных нет», а не падение; frontmatter
 * валиден и несёт `generated_by`; два вызова с тем же входом дают идентичную строку.
 */

import { describe, expect, it } from 'vitest';

import type { ApplicationEvent, ApplicationRecord, ApplicationStage } from './events.js';
import { computeFunnel, formatRate } from './funnel.js';
import { renderFunnelPage, type FunnelPageOptions } from './funnel-page.js';

const ASOF = '2026-09-03T00:00:00Z';
const OPTS: FunnelPageOptions = {
	generatedAt: '2026-09-03T12:00:00.000Z',
	command: 'pnpm jobsearch:funnel-page',
};

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

describe('renderFunnelPage', () => {
	it('содержит все стадии и числа из отчёта', () => {
		const apps = [
			application('a1', { company_source: 'hh' }),
			application('a2', { company_source: 'manual' }),
		];
		const events = [
			stageEvent('a1', 'replied', '2026-06-05T00:00:00Z'),
			stageEvent('a1', 'screening', '2026-06-10T00:00:00Z'),
			stageEvent('a1', 'offer', '2026-06-20T00:00:00Z'),
		];
		const report = computeFunnel(apps, events, {
			asOf: ASOF,
			ghostAfterDays: 21,
			connectedSources: ['manual', 'hh'],
		});

		const page = renderFunnelPage(report, OPTS);

		// Снимок: момент и общее число откликов.
		expect(page).toContain(report.as_of);
		expect(page).toContain(`всего откликов: ${report.total}`);

		// По стадиям: и текущая (applied для a2), и промежуточные (screening для a1),
		// и конечная (offer для a1) — знаменатели конверсий, а не только «сейчас».
		expect(page).toContain(`| Отклик подан | ${report.byStage.applied ?? 0} | ${report.reachedStage.applied} |`);
		expect(page).toContain(`| Скрининг | ${report.byStage.screening ?? 0} | ${report.reachedStage.screening} |`);
		expect(page).toContain(`| Оффер | ${report.byStage.offer ?? 0} | ${report.reachedStage.offer} |`);

		// Конверсии — та же текстовая форма, что даёт formatRate (единственная допустимая).
		expect(page).toContain(formatRate(report.conversions['applied→replied']!, { withInterval: true }));
		expect(page).toContain(formatRate(report.conversions['interview→offer']!, { withInterval: true }));

		// TTFR и ghost — числа из DurationStat/Rate долетели, а не потерялись при рендере.
		expect(page).toContain(String(report.ttfrDays.n));
		expect(page).toContain(formatRate(report.ghost, { withInterval: true }));

		// Разрез по company_source — оба значения (hh, manual) присутствуют как строки таблицы.
		expect(page).toContain('| hh |');
		expect(page).toContain('| manual |');
	});

	it('процент без n не печатается ни в одном месте страницы', () => {
		// formatRate даёт "NN % (x из y)" и при n < 100 добавляет ", интервал LL–HH %" —
		// второй "%" интервала легитимен: он на той же строке, что и "(x из y)". Правило
		// проверяем построчно: любая строка с "%" обязана нести на себе "из" — форму без n
		// в принципе нельзя было бы такой проверкой пропустить.
		const apps = [application('a1'), application('a2', { submission_channel: 'referral' })];
		const events = [stageEvent('a1', 'replied', '2026-06-05T00:00:00Z')];
		const report = computeFunnel(apps, events, { asOf: ASOF, ghostAfterDays: 21, connectedSources: ['manual'] });

		const page = renderFunnelPage(report, OPTS);

		const linesWithPercentButNoN = page.split('\n').filter((line) => /\d+ %/.test(line) && !line.includes('из'));
		expect(linesWithPercentButNoN).toEqual([]);
	});

	it('пустой отчёт даёт валидную страницу с честным «данных нет», а не падение или пустоту', () => {
		const report = computeFunnel([], [], { asOf: ASOF, ghostAfterDays: 21, connectedSources: ['manual'] });

		expect(() => renderFunnelPage(report, OPTS)).not.toThrow();
		const page = renderFunnelPage(report, OPTS);

		expect(page).toContain('всего откликов: 0');
		expect(page).toContain('леджер пуст');
		expect(page).toContain('Пока ни одного отклика.');
		expect(page).toContain('Нет данных.');
		// Прочерк там, где Rate.value === null — не «0 %» и не выдуманное число.
		expect(page).toContain(formatRate(report.ghost));
		expect(page).not.toMatch(/\d+ %/);
	});

	it('frontmatter валиден и несёт generated_by — читатель обязан видеть, что правка вручную бессмысленна', () => {
		const report = computeFunnel([application('a1')], [], {
			asOf: ASOF,
			ghostAfterDays: 21,
			connectedSources: ['manual'],
		});

		const page = renderFunnelPage(report, OPTS);
		const fmMatch = page.match(/^---\n([\s\S]*?)\n---\n/);

		expect(fmMatch).not.toBeNull();
		const frontmatter = fmMatch![1]!;
		expect(frontmatter).toMatch(/^title: .+$/m);
		expect(frontmatter).toMatch(/^type: .+$/m);
		expect(frontmatter).toMatch(/^status: .+$/m);
		expect(frontmatter).toMatch(/^last_updated: 2026-09-03$/m);
		expect(frontmatter).toContain(`generated_by: ${OPTS.command}`);
	});

	it('детерминизм: тот же отчёт даёт побайтово ту же страницу на повторной компиляции', () => {
		// Иначе страница шумит в git при каждом прогоне отчёта, даже когда данные не менялись.
		const report = computeFunnel(
			[application('a1'), application('a2', { company_source: 'linkedin' })],
			[stageEvent('a1', 'rejected', '2026-06-10T00:00:00Z', { reason_code: 'stack_mismatch' })],
			{ asOf: ASOF, ghostAfterDays: 21, connectedSources: ['manual', 'linkedin'] },
		);

		const first = renderFunnelPage(report, OPTS);
		const second = renderFunnelPage(report, OPTS);

		expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
	});

	it('момент генерации берётся из opts, а не из текущего времени — last_updated следует за generatedAt', () => {
		const report = computeFunnel([], [], { asOf: ASOF, ghostAfterDays: 21, connectedSources: ['manual'] });

		const page = renderFunnelPage(report, { generatedAt: '2020-01-15T09:30:00.000Z', command: 'x' });

		expect(page).toContain('last_updated: 2020-01-15');
		expect(page).toContain('Скомпилировано 2020-01-15T09:30:00.000Z');
	});
});
