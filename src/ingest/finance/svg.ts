/**
 * svg.ts — ЧИСТЫЙ детерминированный генератор SVG из ChartSpec.
 *
 * Контекст ([ADR-0018] финансовый модуль, [ADR-0023] транспорт медиа,
 * [ADR-0015] capture-write-path, [ADR-0025] рендер финвизуалов):
 *   Движок claude — spawn-fresh БЕЗ shell/сети ([ADR-0015]), поэтому
 *   matplotlib / «движок рендерит график своим кодом» НЕВОЗМОЖЕН. Рендер
 *   делается НА СТОРОНЕ Node двухступенчато:
 *     1. chartSpec(kind,data) → ChartSpec          (chart.ts, чистая функция)
 *     2. renderChartSvg(spec) → строка SVG          (ЭТОТ файл, чистая функция)
 *     3. растеризация SVG → PNG-Buffer              (finance-render.ts, адаптер)
 *
 *   Этот модуль — ШАГ 2. Здесь живёт ВСЯ геометрия/верстка графика как чистая
 *   детерминированная функция: один и тот же ChartSpec → побайтово один и тот же
 *   SVG-стринг. Это делает визуал тестируемым без растеризатора, без сети, без диска.
 *
 * Принципы (как в chart.ts):
 *   1. ЧИСТОТА: нет сети, нет файловой системы, нет побочных эффектов,
 *      НЕТ Date.now()/Math.random() — иначе вывод недетерминирован.
 *   2. Пустые/placeholder-спеки (meta.empty) → ВАЛИДНЫЙ SVG, без throw.
 *   3. Шрифты — НЕ внешние зависимости: обычные <text> с generic font-family
 *      (sans-serif). Растеризатор подставит системный фолбэк или деградирует
 *      грациозно (текст может не отрисоваться, но картинка валидна).
 *   4. Огрубление подписей (secret-gate, [ADR-0011]) делается НЕ здесь —
 *      это забота caption/доставки. svg.ts рисует ровно то, что в спеке.
 *
 * Поддерживаемые типы (ChartSpec.type):
 *   - 'line'     → линейный график (networth_over_time)
 *   - 'bar'      → столбчатый (balances_snapshot мультивалюта/>5 счетов)
 *   - 'pie'      → круговая диаграмма (balances/expense/debt структура)
 *   - 'progress' → горизонтальный прогресс-бар (goal_progress)
 */

import type { ChartSpec, ChartSeries } from './chart.js';

// ---------------------------------------------------------------------------
// Константы холста и палитры (детерминированные, без внешних тем)
// ---------------------------------------------------------------------------

/** Размеры SVG-холста по умолчанию (px). Фиксированы → детерминированный вывод. */
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 450;

/** Внутренние отступы области построения (px). */
const PADDING = { top: 56, right: 32, bottom: 56, left: 72 };

/** Цвета (хардкод-палитра, НЕ валюты): фон/сетка/текст/акцент. */
const COLOR_BG = '#ffffff';
const COLOR_GRID = '#e5e7eb';
const COLOR_AXIS = '#9ca3af';
const COLOR_TEXT = '#111827';
const COLOR_SUBTEXT = '#6b7280';
const COLOR_LINE = '#2563eb';
const COLOR_PROGRESS_TRACK = '#e5e7eb';
const COLOR_PROGRESS_FILL = '#16a34a';
/** Сигнал перерасхода spend_cap (progress > 1). */
const COLOR_PROGRESS_OVER = '#dc2626';

/**
 * Детерминированная палитра сегментов (pie/bar). Индексируется по позиции
 * сегмента — порядок сегментов в спеке стабилен → цвета стабильны.
 */
const SEGMENT_COLORS = [
	'#2563eb',
	'#16a34a',
	'#f59e0b',
	'#dc2626',
	'#7c3aed',
	'#0891b2',
	'#db2777',
	'#65a30d',
	'#ea580c',
	'#475569',
];

// ---------------------------------------------------------------------------
// Низкоуровневые чистые помощники
// ---------------------------------------------------------------------------

/**
 * esc — экранирует спецсимволы XML в тексте подписи.
 * Подписи приходят из спеки (лейблы счетов/категорий/целей) — могут содержать
 * <, >, &, кавычки. Без экранирования SVG станет невалидным XML.
 *
 * @param s — произвольная строка
 * @returns строка, безопасная для вставки в текстовый узел/атрибут SVG
 */
function esc(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/**
 * fmt — детерминированное форматирование числа для координат SVG.
 * Округляем до 2 знаков и убираем хвостовые нули — иначе float-погрешность
 * (напр. 0.30000000000000004) попадёт в путь и сломает детерминизм по платформам.
 *
 * @param n — число (может быть нецелым после геометрии)
 * @returns компактная строка координаты
 */
function fmt(n: number): string {
	if (!Number.isFinite(n)) return '0';
	// toFixed(2) фиксирует точность; parseFloat снимает хвостовые нули.
	return String(parseFloat(n.toFixed(2)));
}

/** Цвет сегмента по индексу (циклически по палитре). Детерминирован. */
function segmentColor(index: number): string {
	// Длина палитры > 0 → модуль безопасен; индекс стабилен → цвет стабилен.
	return SEGMENT_COLORS[index % SEGMENT_COLORS.length]!;
}

/**
 * isPointSeries — type-guard: ряд с массивом точек (line/bar) против
 * ряда с единственным value (pie/progress). Дискриминация по наличию `points`.
 */
function isPointSeries(
	s: ChartSeries,
): s is Extract<ChartSeries, { points: Array<{ x: string; y: number }> }> {
	return 'points' in s && Array.isArray((s as { points?: unknown }).points);
}

/**
 * svgText — собрать один <text>-узел. Шрифт — generic sans-serif (без внешних
 * зависимостей). anchor/size/цвет параметризованы.
 */
function svgText(
	x: number,
	y: number,
	content: string,
	opts: { size?: number; color?: string; anchor?: 'start' | 'middle' | 'end'; weight?: number } = {},
): string {
	const size = opts.size ?? 13;
	const color = opts.color ?? COLOR_TEXT;
	const anchor = opts.anchor ?? 'start';
	const weight = opts.weight ?? 400;
	return (
		`<text x="${fmt(x)}" y="${fmt(y)}" font-family="sans-serif" font-size="${size}" ` +
		`fill="${color}" text-anchor="${anchor}" font-weight="${weight}">${esc(content)}</text>`
	);
}

/**
 * svgFrame — обёртка: открывающий <svg> + фон-прямоугольник + заголовок.
 * Возвращает части, между которыми вставляется тело графика, и закрывающий тег.
 *
 * Заголовок не экранирует логику пустого графика — для пустых спек тело просто
 * содержит подпись «нет данных» (рисуется вызывающим билдером).
 */
function svgOpen(title: string): string {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" ` +
		`viewBox="0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}" role="img">` +
		`<rect x="0" y="0" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" fill="${COLOR_BG}"/>` +
		svgText(CANVAS_WIDTH / 2, 32, title, { size: 18, weight: 700, anchor: 'middle' })
	);
}

const SVG_CLOSE = '</svg>';

/**
 * emptyOverlay — центральная подпись «нет данных» для placeholder/пустых спек.
 * Не throw — graceful по принципу #2.
 */
function emptyOverlay(): string {
	return svgText(CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2, 'Нет данных', {
		size: 16,
		color: COLOR_SUBTEXT,
		anchor: 'middle',
	});
}

/** Признак пустой/placeholder-спеки (chart.ts ставит meta.empty = true). */
function isEmptySpec(spec: ChartSpec): boolean {
	return spec.meta?.empty === true;
}

// ---------------------------------------------------------------------------
// Рендер LINE (networth_over_time)
// ---------------------------------------------------------------------------

/**
 * renderLine — линейный график. Берёт ПЕРВЫЙ point-ряд спеки (у нас один ряд —
 * «Чистый капитал»). Рисует оси, сетку, путь линии и подпись unit.
 *
 * Автомасштаб по min/max значений ряда. Пустой ряд → overlay «нет данных».
 */
function renderLine(spec: ChartSpec): string {
	const parts: string[] = [svgOpen(spec.title)];

	// Находим первый ряд с точками.
	const series = spec.series.find(isPointSeries);
	const points = series?.points ?? [];

	if (isEmptySpec(spec) || points.length === 0) {
		parts.push(emptyOverlay(), SVG_CLOSE);
		return parts.join('');
	}

	// Геометрия области построения.
	const plotX = PADDING.left;
	const plotY = PADDING.top;
	const plotW = CANVAS_WIDTH - PADDING.left - PADDING.right;
	const plotH = CANVAS_HEIGHT - PADDING.top - PADDING.bottom;

	// Диапазон оси Y (автомасштаб). Если все значения равны — раздвигаем на 1,
	// чтобы линия не схлопнулась и деление на ноль не возникло.
	const ys = points.map((p) => p.y);
	let yMin = Math.min(...ys);
	let yMax = Math.max(...ys);
	if (yMin === yMax) {
		yMin -= 1;
		yMax += 1;
	}
	const ySpan = yMax - yMin;

	// X равномерно по индексу (даты уже отсортированы в chart.ts).
	// Один пункт → ставим по центру (избегаем деления на ноль).
	const n = points.length;
	const xStep = n > 1 ? plotW / (n - 1) : 0;
	const xAt = (i: number): number => (n > 1 ? plotX + i * xStep : plotX + plotW / 2);
	const yAt = (v: number): number => plotY + plotH - ((v - yMin) / ySpan) * plotH;

	// Оси (рамка слева+снизу).
	parts.push(
		`<line x1="${fmt(plotX)}" y1="${fmt(plotY)}" x2="${fmt(plotX)}" y2="${fmt(plotY + plotH)}" stroke="${COLOR_AXIS}" stroke-width="1"/>`,
		`<line x1="${fmt(plotX)}" y1="${fmt(plotY + plotH)}" x2="${fmt(plotX + plotW)}" y2="${fmt(plotY + plotH)}" stroke="${COLOR_AXIS}" stroke-width="1"/>`,
	);

	// Горизонтальная сетка + подписи оси Y (3 деления: min/mid/max).
	for (let i = 0; i <= 2; i++) {
		const v = yMin + (ySpan * i) / 2;
		const gy = yAt(v);
		parts.push(
			`<line x1="${fmt(plotX)}" y1="${fmt(gy)}" x2="${fmt(plotX + plotW)}" y2="${fmt(gy)}" stroke="${COLOR_GRID}" stroke-width="1"/>`,
			svgText(plotX - 8, gy + 4, fmt(v), { size: 11, color: COLOR_SUBTEXT, anchor: 'end' }),
		);
	}

	// Путь линии.
	const d = points
		.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(xAt(i))} ${fmt(yAt(p.y))}`)
		.join(' ');
	parts.push(
		`<path d="${d}" fill="none" stroke="${COLOR_LINE}" stroke-width="2" stroke-linejoin="round"/>`,
	);

	// Точки-маркеры.
	for (let i = 0; i < n; i++) {
		parts.push(
			`<circle cx="${fmt(xAt(i))}" cy="${fmt(yAt(points[i]!.y))}" r="3" fill="${COLOR_LINE}"/>`,
		);
	}

	// Подписи оси X (первая/последняя метки времени — без перегруза).
	parts.push(
		svgText(xAt(0), plotY + plotH + 20, points[0]!.x, {
			size: 11,
			color: COLOR_SUBTEXT,
			anchor: 'start',
		}),
	);
	if (n > 1) {
		parts.push(
			svgText(xAt(n - 1), plotY + plotH + 20, points[n - 1]!.x, {
				size: 11,
				color: COLOR_SUBTEXT,
				anchor: 'end',
			}),
		);
	}

	// Подпись unit (валюта оси Y), если задана.
	if (spec.unit) {
		parts.push(
			svgText(plotX, plotY - 12, spec.unit, { size: 11, color: COLOR_SUBTEXT, anchor: 'start' }),
		);
	}

	parts.push(SVG_CLOSE);
	return parts.join('');
}

// ---------------------------------------------------------------------------
// Рендер BAR (balances_snapshot мультивалюта / >5 счетов)
// ---------------------------------------------------------------------------

/**
 * renderBar — столбчатая диаграмма по value-рядам спеки. Поддерживает
 * отрицательные значения (нулевая линия рисуется внутри области). Каждый
 * столбец подписан лейблом снизу и значением сверху.
 */
function renderBar(spec: ChartSpec): string {
	const parts: string[] = [svgOpen(spec.title)];

	// Берём только value-ряды (у bar нет points).
	const bars = spec.series.filter((s): s is Extract<ChartSeries, { value: number }> =>
		!isPointSeries(s),
	);

	if (isEmptySpec(spec) || bars.length === 0) {
		parts.push(emptyOverlay(), SVG_CLOSE);
		return parts.join('');
	}

	const plotX = PADDING.left;
	const plotY = PADDING.top;
	const plotW = CANVAS_WIDTH - PADDING.left - PADDING.right;
	const plotH = CANVAS_HEIGHT - PADDING.top - PADDING.bottom;

	// Диапазон значений (включаем 0 в шкалу, чтобы нулевая линия была видна).
	const vals = bars.map((b) => b.value);
	const vMax = Math.max(0, ...vals);
	const vMin = Math.min(0, ...vals);
	let vSpan = vMax - vMin;
	if (vSpan === 0) vSpan = 1; // все нули → не делим на ноль

	const yAt = (v: number): number => plotY + plotH - ((v - vMin) / vSpan) * plotH;
	const zeroY = yAt(0);

	// Геометрия столбцов: равные слоты с зазором.
	const slot = plotW / bars.length;
	const barW = slot * 0.6;
	const gap = (slot - barW) / 2;

	// Нулевая линия.
	parts.push(
		`<line x1="${fmt(plotX)}" y1="${fmt(zeroY)}" x2="${fmt(plotX + plotW)}" y2="${fmt(zeroY)}" stroke="${COLOR_AXIS}" stroke-width="1"/>`,
	);

	bars.forEach((bar, i) => {
		const bx = plotX + i * slot + gap;
		const by = bar.value >= 0 ? yAt(bar.value) : zeroY;
		const bh = Math.abs(yAt(bar.value) - zeroY);
		parts.push(
			`<rect x="${fmt(bx)}" y="${fmt(by)}" width="${fmt(barW)}" height="${fmt(bh)}" fill="${segmentColor(i)}"/>`,
		);
		// Значение над/под столбцом (+ валюта ряда, если есть).
		const valueLabel = bar.currency ? `${fmt(bar.value)} ${bar.currency}` : fmt(bar.value);
		const labelY = bar.value >= 0 ? by - 6 : by + bh + 14;
		parts.push(
			svgText(bx + barW / 2, labelY, valueLabel, {
				size: 10,
				color: COLOR_TEXT,
				anchor: 'middle',
			}),
		);
		// Лейбл столбца снизу.
		parts.push(
			svgText(bx + barW / 2, plotY + plotH + 20, bar.label, {
				size: 11,
				color: COLOR_SUBTEXT,
				anchor: 'middle',
			}),
		);
	});

	parts.push(SVG_CLOSE);
	return parts.join('');
}

// ---------------------------------------------------------------------------
// Рендер PIE (balances/expense/debt структура)
// ---------------------------------------------------------------------------

/**
 * arcPath — путь SVG-дуги для одного сегмента pie.
 * Углы в радианах от 12 часов по часовой стрелке.
 *
 * @param cx,cy — центр круга
 * @param r — радиус
 * @param startAngle,endAngle — углы (рад), 0 = вверх, по часовой
 * @returns строка `d` для <path>
 */
function arcPath(
	cx: number,
	cy: number,
	r: number,
	startAngle: number,
	endAngle: number,
): string {
	// Преобразуем «0=вверх, по часовой» в декартовы координаты SVG (y вниз).
	const p = (angle: number): [number, number] => [
		cx + r * Math.sin(angle),
		cy - r * Math.cos(angle),
	];
	const [x1, y1] = p(startAngle);
	const [x2, y2] = p(endAngle);
	// large-arc-flag = 1 если сектор больше полукруга.
	const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
	// sweep-flag = 1 (по часовой). M центр → L начало дуги → A дуга → Z.
	return (
		`M${fmt(cx)} ${fmt(cy)} L${fmt(x1)} ${fmt(y1)} ` +
		`A${fmt(r)} ${fmt(r)} 0 ${largeArc} 1 ${fmt(x2)} ${fmt(y2)} Z`
	);
}

/**
 * renderPie — круговая диаграмма по value-рядам. Доли считаются от суммы
 * АБСОЛЮТНЫХ значений (мультивалютные доли в chart.ts уже = 0; здесь это даёт
 * равные сектора-плейсхолдеры — корректная деградация). Легенда справа.
 *
 * Если суммарная величина = 0 (все нули) → overlay «нет данных».
 */
function renderPie(spec: ChartSpec): string {
	const parts: string[] = [svgOpen(spec.title)];

	const segs = spec.series.filter((s): s is Extract<ChartSeries, { value: number }> =>
		!isPointSeries(s),
	);

	// Суммарная абсолютная величина — основа углов.
	const absVals = segs.map((s) => Math.abs(s.value));
	const total = absVals.reduce((acc, v) => acc + v, 0);

	if (isEmptySpec(spec) || segs.length === 0 || total === 0) {
		parts.push(emptyOverlay(), SVG_CLOSE);
		return parts.join('');
	}

	// Круг слева, легенда справа.
	const cx = CANVAS_WIDTH * 0.32;
	const cy = CANVAS_HEIGHT / 2 + 8;
	const r = Math.min(plotRadius(), cy - PADDING.top);

	// Рисуем сектора, накапливая угол.
	let angle = 0;
	segs.forEach((_seg, i) => {
		const frac = absVals[i]! / total;
		const start = angle;
		const end = angle + frac * 2 * Math.PI;
		angle = end;
		parts.push(`<path d="${arcPath(cx, cy, r, start, end)}" fill="${segmentColor(i)}"/>`);
	});

	// Легенда: цветной квадрат + лейбл + процент.
	const legendX = CANVAS_WIDTH * 0.62;
	let legendY = PADDING.top + 8;
	segs.forEach((seg, i) => {
		const pct = Math.round((absVals[i]! / total) * 100);
		parts.push(
			`<rect x="${fmt(legendX)}" y="${fmt(legendY - 11)}" width="12" height="12" fill="${segmentColor(i)}"/>`,
		);
		const cur = seg.currency ? ` ${seg.currency}` : '';
		parts.push(
			svgText(legendX + 18, legendY, `${seg.label} — ${pct}% (${fmt(seg.value)}${cur})`, {
				size: 12,
				color: COLOR_TEXT,
				anchor: 'start',
			}),
		);
		legendY += 26;
	});

	parts.push(SVG_CLOSE);
	return parts.join('');
}

/** Радиус pie исходя из доступной ширины левой половины. */
function plotRadius(): number {
	const plotH = CANVAS_HEIGHT - PADDING.top - PADDING.bottom;
	return Math.min(CANVAS_WIDTH * 0.22, plotH / 2);
}

// ---------------------------------------------------------------------------
// Рендер PROGRESS (goal_progress)
// ---------------------------------------------------------------------------

/**
 * renderProgress — горизонтальный прогресс-бар по первому value-ряду спеки.
 * value трактуется как доля выполнения (chart.ts уже посчитал). Для spend_cap
 * value может быть > 1 (перерасход) — заливку зажимаем визуально в [0,1], но
 * красим в COLOR_PROGRESS_OVER и подписываем фактический процент из meta.pct.
 */
function renderProgress(spec: ChartSpec): string {
	const parts: string[] = [svgOpen(spec.title)];

	const series = spec.series.find(
		(s): s is Extract<ChartSeries, { value: number }> => !isPointSeries(s),
	);

	if (isEmptySpec(spec) || !series) {
		parts.push(emptyOverlay(), SVG_CLOSE);
		return parts.join('');
	}

	// value — доля выполнения. Зажимаем заливку визуально, флаг перерасхода — отдельно.
	const raw = Number.isFinite(series.value) ? series.value : 0;
	const filled = Math.max(0, Math.min(1, raw));
	const overspent = raw > 1;

	// Геометрия бара.
	const barX = PADDING.left;
	const barW = CANVAS_WIDTH - PADDING.left - PADDING.right;
	const barH = 36;
	const barY = CANVAS_HEIGHT / 2 - barH / 2;

	// Трек (фон) + заливка.
	parts.push(
		`<rect x="${fmt(barX)}" y="${fmt(barY)}" width="${fmt(barW)}" height="${fmt(barH)}" rx="6" fill="${COLOR_PROGRESS_TRACK}"/>`,
	);
	parts.push(
		`<rect x="${fmt(barX)}" y="${fmt(barY)}" width="${fmt(barW * filled)}" height="${fmt(barH)}" rx="6" fill="${overspent ? COLOR_PROGRESS_OVER : COLOR_PROGRESS_FILL}"/>`,
	);

	// Процент по центру бара (берём из meta.pct если есть — у spend_cap может быть >100).
	const pct = typeof spec.meta?.pct === 'number' ? spec.meta.pct : Math.round(filled * 100);
	parts.push(
		svgText(barX + barW / 2, barY + barH / 2 + 5, `${pct}%`, {
			size: 16,
			weight: 700,
			color: COLOR_TEXT,
			anchor: 'middle',
		}),
	);

	// Подпись прогресса (label ряда — содержит «накоплено/потрачено N / M»).
	parts.push(
		svgText(barX, barY - 16, series.label, { size: 13, color: COLOR_SUBTEXT, anchor: 'start' }),
	);

	parts.push(SVG_CLOSE);
	return parts.join('');
}

// ---------------------------------------------------------------------------
// Публичная точка входа — renderChartSvg
// ---------------------------------------------------------------------------

/**
 * renderChartSvg — ЧИСТАЯ функция: ChartSpec → строка SVG.
 *
 * Гарантии:
 *   1. Детерминирована: один и тот же spec → побайтово один и тот же SVG.
 *   2. Никогда не бросает (пустые/placeholder-спеки → валидный SVG с overlay).
 *   3. Нет сети, нет файловой системы, нет зависимости от времени/random.
 *   4. Выбор рендера по spec.type (line/bar/pie/progress).
 *
 * @param spec — сериализуемая спека из chart.ts (chartSpec)
 * @returns строка валидного SVG (`<svg ...>...</svg>`)
 *
 * @example
 * const svg = renderChartSvg(chartSpec({ kind: 'goal_progress', data }));
 * // svg.startsWith('<svg') === true
 */
export function renderChartSvg(spec: ChartSpec): string {
	switch (spec.type) {
		case 'line':
			return renderLine(spec);
		case 'bar':
			return renderBar(spec);
		case 'pie':
			return renderPie(spec);
		case 'progress':
			return renderProgress(spec);
	}
}
