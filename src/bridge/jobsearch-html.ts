/**
 * jobsearch-html.ts — генератор HTML снимка воронки ([ADR-0030], Решение 4).
 *
 * Один генератор — два потребителя: роут `/dashboard` отдаёт результат как страницу,
 * `/export.html` — как файл. Второй вёрстки не существует, расхождению взяться неоткуда.
 *
 * Страница САМОДОСТАТОЧНА: инлайновый CSS, ноль внешних CDN, ноль шрифтов по сети, ноль
 * JS-фреймворков. Полоски воронки — это `div` с процентной шириной, а не график: столбик,
 * показывающий количество, ничего не обещает; линия по шести точкам обещает тренд, которого
 * на этих данных нет.
 *
 * Правила отображения зашиты в код, а не оставлены на дисциплину вёрстки:
 *   - процент НИКОГДА не печатается без абсолютов: `18 % (4 из 22)`;
 *   - в разрезе при `n < 10` процент не показывается вовсе — только абсолютные числа;
 *   - при `n < 100` рядом идёт интервал Уилсона;
 *   - пустой знаменатель рисуется прочерком, а не «0 %»;
 *   - при `n < 30` вместо любого намёка на динамику стоит подпись «мало данных для тренда».
 */

import {
	formatRate,
	TREND_N,
	type FunnelReport,
	type Rate,
	type SegmentStat,
} from '../ingest/jobsearch/funnel.js';
import { APPLICATION_STAGES, type ApplicationStage } from '../ingest/jobsearch/events.js';

/** Экранирование: в отчёт попадают названия вариантов и коды причин из данных. */
function esc(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** Человеческие подписи стадий. Словарь один, подписи — слой представления. */
const STAGE_LABELS: Record<ApplicationStage, string> = {
	applied: 'Отклик подан',
	replied: 'Ответили',
	screening: 'Скрининг',
	interview: 'Интервью',
	test_task: 'Тест-задание',
	offer: 'Оффер',
	rejected: 'Отказ',
	ghosted: 'Игнор',
	withdrawn: 'Отозван',
};

/**
 * cell — ячейка с долей.
 * В разрезе (`inSegment`) при малом `n` процент не печатается: разница «реферал 33 %
 * против прямого 20 %» на трёх и пяти наблюдениях — это ноль информации, оформленный
 * как вывод.
 */
function cell(r: Rate, inSegment = false): string {
	if (r.value === null) return '<span class="none">—</span>';
	if (inSegment && r.lowN) return `<span class="abs">${r.numerator} из ${r.denominator}</span>`;
	return esc(formatRate(r, { withInterval: true }));
}

/** bar — полоска пропорционально числу. Показывает количество, ничего не обещает. */
function bar(count: number, max: number): string {
	const width = max > 0 ? Math.round((count / max) * 100) : 0;
	return `<div class="bar"><div class="bar-fill" style="width:${width}%"></div></div>`;
}

/**
 * renderFunnelHtml — снимок воронки одной самодостаточной страницей.
 *
 * @param report — результат `computeFunnel`
 */
export function renderFunnelHtml(report: FunnelReport): string {
	const reached = APPLICATION_STAGES.filter((s) => (report.reachedStage[s] ?? 0) > 0);
	const maxReached = Math.max(1, ...reached.map((s) => report.reachedStage[s] ?? 0));

	const stageRows = reached
		.map(
			(stage) => `<tr>
			<td>${STAGE_LABELS[stage]}</td>
			<td class="num">${report.reachedStage[stage] ?? 0}</td>
			<td class="num">${report.byStage[stage] ?? 0}</td>
			<td class="barcell">${bar(report.reachedStage[stage] ?? 0, maxReached)}</td>
		</tr>`,
		)
		.join('');

	const conversionRows = Object.entries(report.conversions)
		.map(([key, r]) => `<tr><td>${esc(key)}</td><td>${cell(r)}</td></tr>`)
		.join('');

	const segmentTable = (title: string, buckets: Record<string, SegmentStat>): string => {
		const entries = Object.entries(buckets);
		if (entries.length === 0) {
			return `<h3>${esc(title)}</h3><p class="none">Нет данных.</p>`;
		}
		const rows = entries
			.map(
				([key, stat]) => `<tr>
				<td>${esc(key)}</td>
				<td class="num">${stat.replied.denominator}</td>
				<td>${cell(stat.replied, true)}</td>
				<td>${cell(stat.offer, true)}</td>
			</tr>`,
			)
			.join('');
		return `<h3>${esc(title)}</h3>
		<table><thead><tr><th>Значение</th><th>Откликов</th><th>Ответили</th><th>Офферы</th></tr></thead>
		<tbody>${rows}</tbody></table>`;
	};

	const reasonRows = Object.entries(report.reasons)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([code, count]) => `<tr><td>${esc(code)}</td><td class="num">${count}</td></tr>`)
		.join('');

	const trendNote = report.trendAllowed
		? ''
		: `<p class="warn">Мало данных для тренда (${report.total} из ${TREND_N} наблюдений) — показаны только счётчики. Шесть точек на графике выглядят как закономерность и ею не являются.</p>`;

	const num = (v: number | null): string =>
		v === null ? '<span class="none">—</span>' : String(Math.round(v * 10) / 10);

	return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Воронка откликов</title>
<style>
:root { color-scheme: light dark; }
body { font: 15px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 24px; max-width: 900px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 28px 0 8px; }
h3 { font-size: 15px; margin: 18px 0 6px; font-weight: 600; }
.meta { opacity: .7; font-size: 13px; margin: 0 0 4px; }
table { border-collapse: collapse; width: 100%; margin: 6px 0; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid rgba(128,128,128,.3); }
th { font-weight: 600; font-size: 13px; opacity: .8; }
.num { text-align: right; font-variant-numeric: tabular-nums; width: 90px; }
.none { opacity: .5; }
.abs { font-variant-numeric: tabular-nums; }
.barcell { width: 200px; }
.bar { background: rgba(128,128,128,.2); height: 10px; border-radius: 5px; overflow: hidden; }
.bar-fill { background: currentColor; height: 100%; opacity: .55; }
.warn { background: rgba(200,160,0,.15); padding: 8px 10px; border-radius: 6px; font-size: 13px; }
.coverage { margin-top: 28px; font-size: 13px; opacity: .75; border-top: 1px solid rgba(128,128,128,.3); padding-top: 10px; }
</style>
</head>
<body>
<h1>Воронка откликов</h1>
<p class="meta">Снимок на ${esc(report.as_of)} · всего откликов: ${report.total}</p>
${trendNote}

<h2>Стадии</h2>
<table>
<thead><tr><th>Стадия</th><th class="num">Достигали</th><th class="num">Сейчас</th><th></th></tr></thead>
<tbody>${stageRows || '<tr><td colspan="4" class="none">Пока ни одного отклика.</td></tr>'}</tbody>
</table>

<h2>Конверсии</h2>
<table><thead><tr><th>Переход</th><th>Доля</th></tr></thead><tbody>${conversionRows}</tbody></table>

<h2>Сроки</h2>
<table>
<thead><tr><th>Показатель</th><th class="num">Медиана</th><th class="num">p75</th><th class="num">n</th></tr></thead>
<tbody>
<tr><td>Дней до первого ответа</td><td class="num">${num(report.ttfrDays.median)}</td><td class="num">${num(report.ttfrDays.p75)}</td><td class="num">${report.ttfrDays.n}</td></tr>
<tr><td>Дней до оффера</td><td class="num">${num(report.timeToOfferDays.median)}</td><td class="num">${num(report.timeToOfferDays.p75)}</td><td class="num">${report.timeToOfferDays.n}</td></tr>
</tbody>
</table>
<p>Доля игнора: ${cell(report.ghost)}</p>

<h2>Разрезы</h2>
${segmentTable('Откуда узнали о компании', report.breakdowns.company_source)}
${segmentTable('Как подавались', report.breakdowns.submission_channel)}
${segmentTable('Вариант резюме', report.breakdowns.variant_id)}

<h2>Причины исхода</h2>
<table><thead><tr><th>Код</th><th class="num">Сколько</th></tr></thead>
<tbody>${reasonRows || '<tr><td colspan="2" class="none">Исходов пока нет.</td></tr>'}</tbody></table>

<p class="coverage">${esc(report.sourceCoverage)}</p>
</body>
</html>
`;
}
