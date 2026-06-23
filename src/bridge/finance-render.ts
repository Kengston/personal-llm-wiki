/**
 * finance-render.ts — ТОНКИЙ адаптер растеризации финвизуала: ChartSpec → PNG-Buffer.
 *
 * Контекст ([ADR-0025] рендер финвизуалов, [ADR-0023] транспорт медиа,
 * [ADR-0015] capture-write-path, [ADR-0018] финансовый модуль):
 *   Движок claude — spawn-fresh БЕЗ shell/сети ([ADR-0015]) → matplotlib/
 *   «движок-через-shell» невозможен. Поэтому рендер делается на стороне Node:
 *     1. chartSpec(kind,data) → ChartSpec     (chart.ts, чистая функция)
 *     2. renderChartSvg(spec) → строка SVG     (svg.ts, чистая функция — ВСЯ геометрия)
 *     3. ЭТОТ файл: SVG → PNG-Buffer           (тонкий адаптер на локальной либе)
 *
 *   Растеризатор — @resvg/resvg-js ([ADR-0025]): чистый Rust/NAPI с prebuilt-
 *   бинарём, БЕЗ системных librsvg/headless-браузера и БЕЗ сети. Вся «умная» часть
 *   (вёрстка графика) — в чистой тестируемой svg.ts; здесь только превращение
 *   строки SVG в байты PNG. Этот слой — НЕ место для арифметики/геометрии.
 *
 * Инварианты:
 *   - Без сети, без spawn, без фоновых процессов (только локальная либа).
 *   - Возвращаемые байты PNG — продукт ВЛАДЕЛЬЦУ ([ADR-0023]): secret-gate
 *     применяется к видимому тексту (caption/filename) на доставке, НЕ к байтам.
 *   - Огрубление подписей в самом графике (если нужно) делает вызывающий код,
 *     огрубляя данные ДО chartSpec — finance-render рисует ровно то, что в спеке.
 */

import { Resvg } from '@resvg/resvg-js';

import { renderChartSvg } from '../ingest/finance/svg.js';
import type { ChartSpec } from '../ingest/finance/chart.js';

/**
 * Опции растеризации. Ширина в px управляет итоговым разрешением PNG (resvg
 * масштабирует по viewBox SVG, сохраняя пропорции). Дефолт под Telegram-фото.
 */
export interface RenderPngOptions {
	/** Целевая ширина PNG в px (высота — пропорционально viewBox SVG). */
	width?: number;
	/** Фон PNG (SVG прозрачен по краям вне фон-прямоугольника). */
	background?: string;
}

/** Ширина PNG по умолчанию (2× к 800px-холсту SVG → чёткость в Telegram). */
const DEFAULT_PNG_WIDTH = 1600;
/** Фон по умолчанию — белый (графики читаемы и в тёмной теме клиента). */
const DEFAULT_BACKGROUND = '#ffffff';

/**
 * renderChartPng — ТОНКИЙ адаптер: ChartSpec → Buffer PNG.
 *
 * Шаги: renderChartSvg(spec) (чистая вёрстка) → растеризация resvg → PNG-байты.
 * Синхронна: resvg-js рендерит на месте, сети/диска/спавна нет.
 *
 * @param spec — сериализуемая спека графика (из chart.ts → chartSpec)
 * @param opts — опции разрешения/фона растеризации
 * @returns Buffer с PNG (магия 0x89 0x50 0x4E 0x47)
 *
 * @example
 * const png = renderChartPng(chartSpec({ kind: 'goal_progress', data }));
 * // await tg.sendPhoto(ownerChatId, { data: png, filename: 'goal.png' }, { caption });
 */
export function renderChartPng(spec: ChartSpec, opts: RenderPngOptions = {}): Buffer {
	// Шаг 2: чистая вёрстка — вся геометрия/детерминизм в svg.ts.
	const svg = renderChartSvg(spec);

	// Шаг 3: растеризация. fitTo по ширине → resvg сам считает высоту по viewBox,
	// сохраняя пропорции холста. Фон — чтобы PNG не был прозрачным в клиентах.
	const resvg = new Resvg(svg, {
		fitTo: { mode: 'width', value: opts.width ?? DEFAULT_PNG_WIDTH },
		background: opts.background ?? DEFAULT_BACKGROUND,
	});

	// asPng() возвращает Buffer с готовыми PNG-байтами (заголовок + IDAT + IEND).
	return resvg.render().asPng();
}
