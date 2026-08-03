/**
 * jobsearch-report.test.ts — сервис отчётности ([ADR-0030], Решение 3).
 *
 * Проверяются три слоя гарда и контракт отображения. Последнее — тестом, а не дисциплиной:
 * `/api/stats` не имеет права отдать значение без `n`, иначе рендер (любой, включая чужой)
 * напечатает «18 %» без «из 22» — а именно эта форма и меняет поведение владельца в
 * неверную сторону.
 *
 * HTTP гоняем через `inject()`: слушать порт в тестах не нужно.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ApplicationRecord } from '../ingest/jobsearch/events.js';
import { createJobsearchLedger, type JobsearchLedger } from '../ingest/jobsearch/ledger.js';
import { buildReportApp, loadReportConfig, type ReportConfig } from './jobsearch-report.js';

const TOKEN = 'synthetic-report-token';
const PORT = 7788;
const CONFIG: ReportConfig = {
	port: PORT,
	reportToken: TOKEN,
	ghostAfterDays: 21,
	connectedSources: ['manual'],
};

let tmpDir: string;
let ledger: JobsearchLedger;

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

function makeApp() {
	return buildReportApp({
		config: CONFIG,
		ledger,
		nowFn: () => new Date('2026-08-02T00:00:00Z'),
	});
}

/** Заголовки корректного локального запроса владельца. */
const OWNER = { host: `127.0.0.1:${PORT}`, 'x-report-token': TOKEN };

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'jobsearch-report-test-'));
	ledger = createJobsearchLedger({
		dir: join(tmpDir, 'raw', 'jobsearch'),
		publicRepoRoot: join(tmpDir, 'public-fake'),
	});
	ledger.append('applications', application('a1'));
	ledger.append('application_events', {
		id: 'ev-1',
		application_id: 'a1',
		ts: '2026-06-05T00:00:00Z',
		kind: 'stage_change',
		stage: 'replied',
		source: 'owner',
	});
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Конфигурация
// ---------------------------------------------------------------------------

describe('loadReportConfig', () => {
	it('без REPORT_TOKEN сервис не конфигурируется вовсе', () => {
		// «Стартует без гарда» — не вариант: без токена к сервису может обратиться
		// любая открытая вкладка браузера.
		expect(() => loadReportConfig({} as NodeJS.ProcessEnv)).toThrow(/REPORT_TOKEN/);
		expect(() => loadReportConfig({ REPORT_TOKEN: '   ' } as NodeJS.ProcessEnv)).toThrow();
	});

	it('порт и порог игнора имеют явные дефолты', () => {
		const cfg = loadReportConfig({ REPORT_TOKEN: TOKEN } as NodeJS.ProcessEnv);

		expect(cfg.port).toBe(7788);
		expect(cfg.ghostAfterDays).toBe(21);
	});
});

// ---------------------------------------------------------------------------
// 2. Гард
// ---------------------------------------------------------------------------

describe('гард сервиса', () => {
	it('без токена — 404, а не 403: наличие сервиса тоже информация', async () => {
		const app = makeApp();

		const res = await app.inject({
			method: 'GET',
			url: '/api/stats',
			headers: { host: OWNER.host },
		});

		expect(res.statusCode).toBe(404);
		await app.close();
	});

	it('чужой Host отбивается — это DNS-rebinding', async () => {
		// Чужая страница резолвит свой домен в 127.0.0.1 и обходит origin-политику.
		const app = makeApp();

		const res = await app.inject({
			method: 'GET',
			url: '/api/stats',
			headers: { host: 'evil.example.net', 'x-report-token': TOKEN },
		});

		expect(res.statusCode).toBe(404);
		await app.close();
	});

	it('неверный токен той же длины отбивается', async () => {
		const app = makeApp();

		const res = await app.inject({
			method: 'GET',
			url: '/api/stats',
			headers: { host: OWNER.host, 'x-report-token': 'x'.repeat(TOKEN.length) },
		});

		expect(res.statusCode).toBe(404);
		await app.close();
	});

	it('сервис read-only: записывающих роутов нет', async () => {
		const app = makeApp();

		const res = await app.inject({ method: 'POST', url: '/api/stats', headers: OWNER });

		expect(res.statusCode).toBe(404);
		await app.close();
	});
});

// ---------------------------------------------------------------------------
// 3. Контракт отображения
// ---------------------------------------------------------------------------

describe('/api/stats', () => {
	it('отдаёт снимок воронки владельцу', async () => {
		const app = makeApp();

		const res = await app.inject({ method: 'GET', url: '/api/stats', headers: OWNER });

		expect(res.statusCode).toBe(200);
		expect(res.json().total).toBe(1);
		await app.close();
	});

	it('ни одно значение не отдаётся без n и признака малой выборки', async () => {
		const app = makeApp();

		const body = (await app.inject({ method: 'GET', url: '/api/stats', headers: OWNER })).json();

		for (const [key, r] of Object.entries(body.conversions as Record<string, unknown>)) {
			const value = r as Record<string, unknown>;
			expect(value, key).toHaveProperty('n');
			expect(value, key).toHaveProperty('lowN');
			expect(value, key).toHaveProperty('numerator');
			expect(value, key).toHaveProperty('denominator');
		}
		expect(body.ghost).toHaveProperty('n');
		await app.close();
	});
});

describe('/dashboard', () => {
	it('одноразовый ?t= обменивается на httpOnly-cookie и снимается редиректом', async () => {
		// Токен не должен оседать в истории браузера и в реферерах.
		const app = makeApp();

		const res = await app.inject({
			method: 'GET',
			url: `/dashboard?t=${TOKEN}`,
			headers: { host: OWNER.host },
		});

		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toBe('/dashboard');
		const cookie = String(res.headers['set-cookie']);
		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('SameSite=Strict');
		await app.close();
	});

	it('после обмена страница открывается по cookie', async () => {
		const app = makeApp();

		const res = await app.inject({
			method: 'GET',
			url: '/dashboard',
			headers: {
				host: OWNER.host,
				cookie: `jobsearch_report_token=${encodeURIComponent(TOKEN)}`,
			},
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Воронка откликов');
		await app.close();
	});

	it('при малой выборке страница прямо говорит, что тренда не будет', async () => {
		const app = makeApp();

		const res = await app.inject({ method: 'GET', url: '/dashboard', headers: OWNER });

		expect(res.body).toContain('Мало данных для тренда');
		expect(res.body).toContain('Показатели покрывают только подключённые источники');
		await app.close();
	});

	it('страница самодостаточна: ни одного внешнего ресурса', async () => {
		// Инлайновый CSS, ноль CDN, ноль шрифтов по сети, ноль JS-фреймворков.
		const app = makeApp();

		const html = (await app.inject({ method: 'GET', url: '/dashboard', headers: OWNER })).body;

		expect(html).not.toMatch(/<script/i);
		expect(html).not.toMatch(/https?:\/\//);
		await app.close();
	});
});

describe('экспорт', () => {
	it('.xlsx отдаётся байтами как вложение', async () => {
		const app = makeApp();

		const res = await app.inject({ method: 'GET', url: '/export.xlsx', headers: OWNER });

		expect(res.statusCode).toBe(200);
		expect(res.headers['content-disposition']).toContain('funnel.xlsx');
		expect(res.rawPayload.subarray(0, 2).toString('latin1')).toBe('PK');
		await app.close();
	});

	it('.html — тот же генератор, что у дашборда, только вложением', async () => {
		const app = makeApp();

		const dashboard = await app.inject({ method: 'GET', url: '/dashboard', headers: OWNER });
		const exported = await app.inject({ method: 'GET', url: '/export.html', headers: OWNER });

		expect(exported.headers['content-disposition']).toContain('funnel.html');
		expect(exported.body).toBe(dashboard.body);
		await app.close();
	});
});
