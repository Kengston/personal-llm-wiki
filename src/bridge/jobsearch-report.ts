/**
 * jobsearch-report.ts — локальный сервис отчётности по воронке ([ADR-0030], Решение 3).
 *
 * **Отдельный Fastify-инстанс на своём порту, а не роуты в мосте.** Добавить `/dashboard`
 * в существующий `buildApp` дешевле на один процесс — и отвергнуто по конкретной причине:
 * в webhook-режиме перед портом моста стоит Cloudflare Tunnel. Сузить публикацию до одного
 * пути он умеет, и именно в этом проблема — приватность карьерной воронки начинала бы
 * держаться на правильности правила в конфиге туннеля, который живёт вне репозитория,
 * правится отдельно и в дефолтной форме публикует origin целиком. Забытая строка в чужом
 * файле — и дашборд в интернете, молча. Отдельный порт за туннель не попадает НИ ПРИ КАКОЙ
 * конфигурации ingress: изоляция получена топологией процессов, а не аккуратностью.
 *
 * **Три слоя гарда, каждый закрывает то, чего не закрывают остальные:**
 *   1. bind `127.0.0.1` — отсекает всю сеть, включая соседей по Wi-Fi в кафе;
 *   2. обязательный токен — loopback защищает от сети, но НЕ от локального браузера: любая
 *      открытая вкладка может слать запросы на `127.0.0.1`, и CORS запрещает читать ответ,
 *      но не запрещает его отправку. Токен — единственный слой, различающий владельца и
 *      произвольный локальный процесс;
 *   3. проверка `Host` — ломает DNS-rebinding, когда чужая страница резолвит свой домен
 *      в `127.0.0.1` и обходит origin-политику.
 *
 * Сервис READ-ONLY: запись идёт только через Telegram-диспетчер. Отсюда следствие — у него
 * нет поверхности CSRF-на-запись, и весь гард сводится к чтению.
 */

import { timingSafeEqual } from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { isMainModule } from '../core/cli.js';
import { childLogger } from '../core/logger.js';
import { computeFunnel, type FunnelReport } from '../ingest/jobsearch/funnel.js';
import { createJobsearchLedger, type JobsearchLedger } from '../ingest/jobsearch/ledger.js';
import { buildFunnelXlsx } from '../ingest/jobsearch/xlsx.js';
import { renderFunnelHtml } from './jobsearch-html.js';

const log = childLogger('bridge.jobsearch-report');

/** Конфигурация сервиса. Токен обязателен и дефолта не имеет. */
export interface ReportConfig {
	port: number;
	reportToken: string;
	ghostAfterDays: number;
	/** Подключённые источники — для оговорки о покрытии (D11). */
	connectedSources: string[];
}

/** Значения по умолчанию, названные явно ([ADR-0030], «Следствия»). */
export const REPORT_DEFAULTS = { port: 7788, ghostAfterDays: 21, followUpAfterDays: 7 } as const;

/**
 * loadReportConfig — конфигурация из окружения.
 *
 * Отсутствие `REPORT_TOKEN` — ошибка старта, а не «стартуем без гарда». Сервис без токена
 * отличается от сервиса с токеном ровно тем, что к нему может обратиться любая открытая
 * вкладка браузера; молча деградировать до этого нельзя.
 */
export function loadReportConfig(env: NodeJS.ProcessEnv = process.env): ReportConfig {
	const reportToken = env.REPORT_TOKEN?.trim() ?? '';
	if (!reportToken) {
		throw new Error(
			'REPORT_TOKEN обязателен: сервис отчётности не стартует без токена ([ADR-0030], Решение 3).',
		);
	}

	const port = Number(env.JOBSEARCH_REPORT_PORT ?? REPORT_DEFAULTS.port);
	const ghostAfterDays = Number(env.JOBSEARCH_GHOST_DAYS ?? REPORT_DEFAULTS.ghostAfterDays);

	return {
		port: Number.isFinite(port) && port > 0 ? port : REPORT_DEFAULTS.port,
		reportToken,
		ghostAfterDays:
			Number.isFinite(ghostAfterDays) && ghostAfterDays > 0
				? ghostAfterDays
				: REPORT_DEFAULTS.ghostAfterDays,
		connectedSources: (env.JOBSEARCH_SOURCES ?? 'manual')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean),
	};
}

/** Constant-time-сравнение; false при разной длине. */
function safeEqual(a: string, b: string): boolean {
	const ba = Buffer.from(a, 'utf8');
	const bb = Buffer.from(b, 'utf8');
	if (ba.length !== bb.length) return false;
	return timingSafeEqual(ba, bb);
}

/** Имя httpOnly-cookie, в которую обменивается одноразовый `?t=`. */
const COOKIE_NAME = 'jobsearch_report_token';

/** Разбор заголовка Cookie без зависимости: нам нужен ровно один ключ. */
function readCookie(header: string | undefined, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(';')) {
		const eq = part.indexOf('=');
		if (eq < 0) continue;
		if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
	}
	return null;
}

export interface ReportDeps {
	config: ReportConfig;
	/** Леджер; по умолчанию строится из окружения. */
	ledger?: JobsearchLedger;
	/** Источник времени. Инъекция — ради воспроизводимых тестов. */
	nowFn?: () => Date;
}

/**
 * buildReportApp — Fastify-инстанс с четырьмя read-only роутами.
 *
 * Слушать его должен ТОЛЬКО `127.0.0.1` (см. `startReportService`); инстанс сам по себе
 * адрес не выбирает, поэтому bind проверяется там, где происходит `listen`.
 */
export function buildReportApp(deps: ReportDeps): FastifyInstance {
	const app = Fastify({ logger: false });
	const { config } = deps;
	const ledger = deps.ledger ?? createJobsearchLedger();
	const nowFn = deps.nowFn ?? (() => new Date());

	/** Слой 3: Host обязан быть локальным — иначе это DNS-rebinding. */
	const hostAllowed = (req: FastifyRequest): boolean => {
		const host = (req.headers.host ?? '').toLowerCase();
		return host === `127.0.0.1:${config.port}` || host === `localhost:${config.port}`;
	};

	/** Слой 2: токен из заголовка или из обменянной cookie. */
	const authorized = (req: FastifyRequest): boolean => {
		const header = req.headers['x-report-token'];
		if (typeof header === 'string' && safeEqual(header, config.reportToken)) return true;
		const cookie = readCookie(req.headers.cookie, COOKIE_NAME);
		return cookie !== null && safeEqual(cookie, config.reportToken);
	};

	/** Общий гард. 404, а не 403: наличие сервиса — тоже информация. */
	const guard = (req: FastifyRequest, reply: FastifyReply): boolean => {
		if (!hostAllowed(req)) {
			log.warn({ host: req.headers.host }, 'report.host_rejected');
			void reply.code(404).send();
			return false;
		}
		if (!authorized(req)) {
			log.warn({ url: req.url.split('?')[0] }, 'report.token_rejected');
			void reply.code(404).send();
			return false;
		}
		return true;
	};

	/** Снимок пересчитывается на каждый запрос: кэша в подсистеме нет вовсе. */
	const snapshot = (): FunnelReport =>
		computeFunnel(ledger.readAll('applications'), ledger.readAll('application_events'), {
			asOf: nowFn().toISOString(),
			ghostAfterDays: config.ghostAfterDays,
			connectedSources: config.connectedSources,
		});

	app.get('/api/stats', async (req, reply) => {
		if (!guard(req, reply)) return;
		return reply.type('application/json; charset=utf-8').send(JSON.stringify(snapshot()));
	});

	app.get('/dashboard', async (req, reply) => {
		if (!hostAllowed(req)) return reply.code(404).send();

		// Одноразовый `?t=` из ссылки в Telegram обменивается на httpOnly-cookie и снимается
		// редиректом на чистый URL: токен не оседает в истории браузера и в реферерах.
		const query = req.query as Record<string, unknown>;
		const oneTime = typeof query.t === 'string' ? query.t : null;
		if (oneTime && safeEqual(oneTime, config.reportToken)) {
			return reply
				.header(
					'set-cookie',
					`${COOKIE_NAME}=${encodeURIComponent(config.reportToken)}; HttpOnly; SameSite=Strict; Path=/`,
				)
				.redirect('/dashboard', 302);
		}

		if (!authorized(req)) return reply.code(404).send();
		return reply.type('text/html; charset=utf-8').send(renderFunnelHtml(snapshot()));
	});

	app.get('/export.html', async (req, reply) => {
		if (!guard(req, reply)) return;
		// Тот же генератор, что у /dashboard — второй вёрстки не существует.
		return reply
			.type('text/html; charset=utf-8')
			.header('content-disposition', 'attachment; filename="funnel.html"')
			.send(renderFunnelHtml(snapshot()));
	});

	app.get('/export.xlsx', async (req, reply) => {
		if (!guard(req, reply)) return;
		// Файл собирается В ПАМЯТИ и отдаётся байтами: во временные файлы внутри
		// репозиториев экспорт воронки не пишется никогда.
		return reply
			.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
			.header('content-disposition', 'attachment; filename="funnel.xlsx"')
			.send(buildFunnelXlsx(snapshot()));
	});

	return app;
}

/**
 * startReportService — поднимает сервис строго на loopback.
 *
 * `127.0.0.1`, а не `0.0.0.0`: ноутбук — портативный хост ([ADR-0005]), и «послушать все
 * интерфейсы» здесь означает «раздать карьерную воронку кафе».
 */
export async function startReportService(deps: ReportDeps): Promise<FastifyInstance> {
	const app = buildReportApp(deps);
	await app.listen({ host: '127.0.0.1', port: deps.config.port });
	log.info({ port: deps.config.port }, 'jobsearch-report.listening');
	return app;
}

// ---------------------------------------------------------------------------
// Точка входа: отдельный процесс (`pnpm jobsearch:report`)
// ---------------------------------------------------------------------------

/**
 * Сервис поднимается СВОИМ процессом — в этом и состоит изоляция ([ADR-0030], Решение 3).
 * Запускать его внутри моста нельзя: тогда он делит порт с вебхуком и его приватность
 * начинает зависеть от конфига туннеля, который живёт вне репозитория.
 */
if (isMainModule(import.meta.url)) {
	const config = loadReportConfig(process.env);
	startReportService({ config }).catch((err: unknown) => {
		process.stderr.write(`jobsearch-report: не стартовал — ${String(err)}\n`);
		process.exit(1);
	});
}
