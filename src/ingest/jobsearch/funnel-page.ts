/**
 * funnel-page.ts — компиляция сводки воронки в страницу вики ([PRD] US 38).
 *
 * `renderFunnelPage` — чистая функция: `FunnelReport` → markdown строкой. Ничего не читает
 * и не пишет — это и есть шов тестируемости (§Testing Decisions PRD), а не временный
 * каталог: леджеры читает и файл пишет `scripts/funnel-page.mjs`, этот модуль только
 * форматирует то, что уже посчитал `computeFunnel` ([ADR-0030]).
 *
 * Три вещи, которые здесь неочевидны:
 *
 *   1. МОМЕНТ ГЕНЕРАЦИИ — АРГУМЕНТ, НЕ `new Date()` ВНУТРИ. Иначе два вызова с одним и
 *      тем же отчётом дают разные страницы: git видит шум на каждом прогоне, а тест
 *      «тот же вход → те же байты» невозможен в принципе.
 *
 *   2. ДВА ПУНКТА PRD ЭТА СТРАНИЦА ЧЕСТНО НЕ ЗАКРЫВАЕТ, ПОТОМУ ЧТО ИХ НЕ УМЕЕТ
 *      `computeFunnel` (а его код здесь не переписывается): разреза по `platform` в
 *      `FunnelReport.breakdowns` нет — там только `company_source`/`submission_channel`/
 *      `variant_id`; отсечения по площадке (`since` из реестра, у hh — 2026-09-01,
 *      [PRD] US 27) `computeFunnel` тоже не принимает — конверсии считаются по всей
 *      истории. Оба факта — раздел «Ограничения» страницы, а не выдуманные числа.
 *
 *   3. ПРОЦЕНТ НИКОГДА НЕ БЕЗ `n`. Переиспользуем `formatRate` (не второй формат доли),
 *      и, в отличие от `renderFunnelHtml`, который при малом `n` в разрезе прячет процент
 *      и показывает только абсолюты, здесь процент остаётся всегда — но всегда с
 *      интервалом Уилсона: на трёх-пяти наблюдениях сам широкий интервал уже показывает,
 *      что число ничего не доказывает, отдельная лесенка "прятать/не прятать" не нужна.
 */

import { formatRate, type FunnelReport, type Rate, type SegmentStat } from './funnel.js';
import { APPLICATION_STAGES, type ApplicationStage } from './events.js';

/**
 * Человеческие подписи стадий — тот же словарь, что у `renderFunnelHtml`
 * (`src/bridge/jobsearch-html.ts`), но без обратной зависимости `ingest` → `bridge`:
 * `ingest` ниже `bridge` в архитектуре репозитория, а второй копии девяти строк константы
 * дешевле, чем разворот направления импорта.
 */
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

export interface FunnelPageOptions {
	/** Момент компиляции страницы, ISO. См. пункт 1 в шапке файла. */
	generatedAt: string;
	/**
	 * Команда, которой страница пересобирается (`pnpm jobsearch:funnel-page`). Печатается
	 * во frontmatter (`generated_by`) и в шапке: читатель обязан видеть, что правка руками
	 * бессмысленна и потеряется на следующей компиляции.
	 */
	command: string;
}

/** c — markdown код-спан. Строка одинарными кавычками, чтобы обратная кавычка внутри
 * литерала не требовала экранирования шаблонной строки, в которую она подставляется. */
function c(s: string): string {
	return '`' + s + '`';
}

/** cell — обязательная текстовая форма доли на этой странице: всегда с интервалом, то
 * есть всегда с `n` — «процент без n» на этой странице не существует ни в одном месте. */
function cell(r: Rate): string {
	return formatRate(r, { withInterval: true });
}

/** num — длительность в днях, округлённая до десятой; прочерк, если данных нет. */
function num(v: number | null): string {
	return v === null ? '—' : String(Math.round(v * 10) / 10);
}

/** stageTable — распределение откликов по стадиям: сейчас и когда-либо достигали. */
function stageTable(report: FunnelReport): string {
	const reached = APPLICATION_STAGES.filter((s) => (report.reachedStage[s] ?? 0) > 0);
	if (reached.length === 0) return 'Пока ни одного отклика.';
	const rows = reached.map(
		(s) => `| ${STAGE_LABELS[s]} | ${report.byStage[s] ?? 0} | ${report.reachedStage[s] ?? 0} |`,
	);
	return ['| Стадия | Сейчас на стадии | Когда-либо достигали |', '| --- | --- | --- |', ...rows].join(
		'\n',
	);
}

/** conversionTable — все пары стадий из `computeFunnel`, доля с обязательным интервалом. */
function conversionTable(report: FunnelReport): string {
	const entries = Object.entries(report.conversions);
	if (entries.length === 0) return 'Конверсии не считаются: нет пар стадий с данными.';
	const rows = entries.map(([key, r]) => `| ${key} | ${cell(r)} |`);
	return ['| Переход | Доля |', '| --- | --- |', ...rows].join('\n');
}

/** segmentTable — один разрез: значение, знаменатель, доля ответивших и доля офферов. */
function segmentTable(buckets: Record<string, SegmentStat>): string {
	const entries = Object.entries(buckets);
	if (entries.length === 0) return 'Нет данных.';
	const rows = entries.map(
		([key, s]) => `| ${key} | ${s.replied.denominator} | ${cell(s.replied)} | ${cell(s.offer)} |`,
	);
	return ['| Значение | Откликов | Ответили | Офферы |', '| --- | --- | --- | --- |', ...rows].join(
		'\n',
	);
}

/**
 * renderFunnelPage — снимок воронки страницей вики ([PRD] US 38).
 *
 * @param report — результат `computeFunnel`, готовый снимок; ничего не досчитывается
 * @param opts   — момент компиляции и имя команды (см. `FunnelPageOptions`)
 */
export function renderFunnelPage(report: FunnelReport, opts: FunnelPageOptions): string {
	const lastUpdated = opts.generatedAt.slice(0, 10);
	const totalNote = report.total === 0 ? ' — леджер пуст, ниже нечему заполняться.' : '';

	return `---
title: Поиск работы — сводка воронки
type: note
status: active
last_updated: ${lastUpdated}
generated_by: ${opts.command}
---

# Поиск работы: сводка воронки

> **Компилируется командой ${c(opts.command)}, руками не правится.** Источник истины —
> леджеры в [${c('raw/jobsearch/')}](../../raw/jobsearch/) (${c('applications.jsonl')},
> ${c('application_events.jsonl')}). Эта страница — снимок того, что уже посчитал движок на
> момент компиляции; при расхождении верить леджеру и пересобрать страницу командой, а не
> редактировать цифры здесь — следующий прогон всё равно перезапишет правку.

Снимок на ${report.as_of} · всего откликов: ${report.total}${totalNote}

## Ограничения

- Разрез по площадке (${c('platform')}) не считается: ${c('computeFunnel')} строит разрезы
  только по ${c('company_source')}, ${c('submission_channel')} и ${c('variant_id')}
  ([ADR-0030]) — поля ${c('platform')} ([ADR-0033]) в ${c('FunnelReport.breakdowns')} нет.
  Раздел «По площадке» ниже поэтому не число, а констатация пробела.
- Точка отсечения площадки (${c('since')}, [PRD] US 27: у hh — 2026-09-01) не применяется:
  ${c('computeFunnel')} не принимает cutoff по площадке и не фильтрует по её дате —
  конверсии посчитаны по всей истории, включая отклики hh до отсечения.

## По стадиям

${stageTable(report)}

## Конверсии

${conversionTable(report)}

## Сроки

| Показатель | Медиана (дней) | p75 (дней) | n |
| --- | --- | --- | --- |
| До первого ответа (TTFR) | ${num(report.ttfrDays.median)} | ${num(report.ttfrDays.p75)} | ${report.ttfrDays.n} |
| До оффера | ${num(report.timeToOfferDays.median)} | ${num(report.timeToOfferDays.p75)} | ${report.timeToOfferDays.n} |

## Игнор

Доля откликов без ответа при истёкшем пороге молчания: ${cell(report.ghost)}.

## По источнику компании

Разбивка ${c('company_source')}: ${c('manual')}, ${c('linkedin_export')}, ${c('web_search')},
плюс id площадки-агрегатора/сети (${c('hh')}, ${c('linkedin')}).

${segmentTable(report.breakdowns.company_source)}

## По площадке

См. «Ограничения» выше — разрез по ${c('platform')} движок не считает.

## Покрытие источников

${report.sourceCoverage}

## Последнее обновление

Скомпилировано ${opts.generatedAt} командой ${c(opts.command)}.

## Связанные

- [../../raw/jobsearch/](../../raw/jobsearch/) — леджеры-источник истины
- [run-params.md](run-params.md) — параметры прогона
- [decisions.md](decisions.md) — журнал решений подсистемы
- [../growth/job-search.md](../growth/job-search.md) — личный слой: цель и этапы
`;
}
