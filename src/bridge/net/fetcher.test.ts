/**
 * fetcher.test.ts — сетевой слой моста ([ADR-0029] §1).
 *
 * Все тесты ОФЛАЙН: транспорт инъектируется, живой сети нет, фикстуры синтетические
 * (`example.com`). Паузы тоже инъектируются — бэкофф в пять секунд не должен превращать
 * набор тестов в ожидание.
 *
 * Проверяется главное свойство контракта: загрузчик НИКОГДА не бросает. Что бы ни делал
 * чужой сервер, discovery деградирует, а мост живёт.
 */

import { describe, expect, it } from 'vitest';

import { BridgeFetcher, hostAllowed, parseRobots, stripQuery } from './fetcher.js';

const ALLOWLIST = ['example.com', '.jobs.example.com'];

/** Ответ robots.txt, разрешающий всё. */
function emptyRobots(): Response {
	return new Response('', { status: 200, headers: { 'content-type': 'text/plain' } });
}

function html(body = '<html>synthetic</html>'): Response {
	return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
}

/**
 * makeFetcher — загрузчик с записывающим моком транспорта.
 * `routes` отвечает по URL; неизвестный URL — сетевая ошибка (как недоступный хост).
 */
function makeFetcher(routes: Record<string, () => Response>, opts: { allowlist?: string[] } = {}) {
	const calls: string[] = [];
	const slept: number[] = [];

	const fetcher = new BridgeFetcher({
		allowlist: opts.allowlist ?? ALLOWLIST,
		fetchFn: (async (input: string | URL) => {
			const url = input.toString();
			calls.push(url);
			const route = routes[url];
			if (!route) throw new Error('synthetic network error');
			return route();
		}) as unknown as typeof fetch,
		sleepFn: async (ms) => {
			slept.push(ms);
		},
		// Часы двигаем сами: rate-limit не должен зависеть от скорости машины.
		nowMsFn: () => 1_000_000,
	});

	return { fetcher, calls, slept };
}

// ---------------------------------------------------------------------------
// 1. Чистые функции
// ---------------------------------------------------------------------------

describe('hostAllowed', () => {
	it('точное совпадение разрешает, похожий домен — нет', () => {
		// evil-example.com заканчивается на example.com — суффиксное сравнение было бы дырой.
		expect(hostAllowed('example.com', ALLOWLIST)).toBe(true);
		expect(hostAllowed('evil-example.com', ALLOWLIST)).toBe(false);
		expect(hostAllowed('sub.example.com', ALLOWLIST)).toBe(false);
	});

	it('запись с ведущей точкой разрешает поддомены', () => {
		expect(hostAllowed('careers.jobs.example.com', ALLOWLIST)).toBe(true);
	});
});

describe('stripQuery', () => {
	it('снимает query и фрагмент — PII в query не хранится и не логируется', () => {
		expect(stripQuery('https://example.com/jobs?utm=1&email=a@example.com#top')).toBe(
			'https://example.com/jobs',
		);
	});
});

describe('parseRobots', () => {
	it('учитывает группу * и нашу собственную', () => {
		const rules = parseRobots(
			['User-agent: *', 'Disallow: /private', '', 'User-agent: other-bot', 'Disallow: /'].join(
				'\n',
			),
			'personal-llm-wiki-jobsearch/1.0',
		);

		expect(rules).toEqual(['/private']);
	});

	it('комментарии и пустые Disallow игнорируются', () => {
		expect(parseRobots('# комментарий\nUser-agent: *\nDisallow:\n', 'ua')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 2. Allowlist и редиректы
// ---------------------------------------------------------------------------

describe('BridgeFetcher — allowlist', () => {
	it('хост вне списка не запрашивается вовсе', async () => {
		const { fetcher, calls } = makeFetcher({});

		expect(await fetcher.fetch('https://not-allowed.example.net/jobs')).toBeNull();
		expect(calls).toEqual([]);
	});

	it('не-https отбивается до сети', async () => {
		const { fetcher, calls } = makeFetcher({});

		expect(await fetcher.fetch('http://example.com/jobs')).toBeNull();
		expect(calls).toEqual([]);
	});

	it('редирект за пределы allowlist не проходит', async () => {
		// Без перепроверки Location схему обходит один 302 — самая частая дыра.
		const { fetcher } = makeFetcher({
			'https://example.com/robots.txt': emptyRobots,
			'https://example.com/jobs': () =>
				new Response(null, { status: 302, headers: { location: 'https://evil.example.net/x' } }),
		});

		expect(await fetcher.fetch('https://example.com/jobs')).toBeNull();
	});

	it('редирект внутри allowlist проходит', async () => {
		const { fetcher } = makeFetcher({
			'https://example.com/robots.txt': emptyRobots,
			'https://example.com/jobs': () =>
				new Response(null, { status: 301, headers: { location: 'https://example.com/careers' } }),
			'https://example.com/careers': () => html(),
		});

		const doc = await fetcher.fetch('https://example.com/jobs');

		expect(doc?.url).toBe('https://example.com/careers');
		expect(doc?.body).toContain('synthetic');
	});
});

// ---------------------------------------------------------------------------
// 3. robots.txt
// ---------------------------------------------------------------------------

describe('BridgeFetcher — robots.txt', () => {
	it('Disallow закрывает путь', async () => {
		const { fetcher } = makeFetcher({
			'https://example.com/robots.txt': () =>
				new Response('User-agent: *\nDisallow: /jobs', {
					status: 200,
					headers: { 'content-type': 'text/plain' },
				}),
			'https://example.com/jobs': () => html(),
		});

		expect(await fetcher.fetch('https://example.com/jobs')).toBeNull();
	});

	it('404 на robots.txt — разрешено', async () => {
		const { fetcher } = makeFetcher({
			'https://example.com/robots.txt': () => new Response('', { status: 404 }),
			'https://example.com/jobs': () => html(),
		});

		expect(await fetcher.fetch('https://example.com/jobs')).not.toBeNull();
	});

	it('недоступный robots.txt считается запретом (fail-closed по вежливости)', async () => {
		const { fetcher } = makeFetcher({ 'https://example.com/jobs': () => html() });

		expect(await fetcher.fetch('https://example.com/jobs')).toBeNull();
	});

	it('robots тянется один раз на хост за прогон', async () => {
		const { fetcher, calls } = makeFetcher({
			'https://example.com/robots.txt': emptyRobots,
			'https://example.com/a': () => html(),
			'https://example.com/b': () => html(),
		});

		await fetcher.fetch('https://example.com/a');
		await fetcher.fetch('https://example.com/b');

		expect(calls.filter((c) => c.endsWith('/robots.txt'))).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// 4. Размер, тип, ошибки
// ---------------------------------------------------------------------------

describe('BridgeFetcher — тело ответа', () => {
	it('превышение потолка размера обрывает чтение', async () => {
		const fetcher = new BridgeFetcher({
			allowlist: ALLOWLIST,
			maxBytes: 64,
			sleepFn: async () => {},
			nowMsFn: () => 0,
			fetchFn: (async (input: string | URL) => {
				const url = input.toString();
				if (url.endsWith('/robots.txt')) return emptyRobots();
				return html('x'.repeat(1000));
			}) as unknown as typeof fetch,
		});

		expect(await fetcher.fetch('https://example.com/jobs')).toBeNull();
	});

	it('неподдерживаемый Content-Type отбивается', async () => {
		const { fetcher } = makeFetcher({
			'https://example.com/robots.txt': emptyRobots,
			'https://example.com/jobs': () =>
				new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } }),
		});

		expect(await fetcher.fetch('https://example.com/jobs')).toBeNull();
	});

	it('сетевая ошибка не бросает наружу — только null', async () => {
		const { fetcher } = makeFetcher({ 'https://example.com/robots.txt': emptyRobots });

		await expect(fetcher.fetch('https://example.com/jobs')).resolves.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 5. Ретраи и бюджет
// ---------------------------------------------------------------------------

describe('BridgeFetcher — ретраи и лимиты', () => {
	it('4xx не ретраится: повтор по 403 — это долбёжка', async () => {
		let hits = 0;
		const { fetcher } = makeFetcher({
			'https://example.com/robots.txt': emptyRobots,
			'https://example.com/jobs': () => {
				hits++;
				return new Response('', { status: 403 });
			},
		});

		expect(await fetcher.fetch('https://example.com/jobs')).toBeNull();
		expect(hits).toBe(1);
	});

	it('5xx ретраится ровно один раз, с бэкоффом', async () => {
		let hits = 0;
		const { fetcher, slept } = makeFetcher({
			'https://example.com/robots.txt': emptyRobots,
			'https://example.com/jobs': () => {
				hits++;
				return new Response('', { status: 503 });
			},
		});

		expect(await fetcher.fetch('https://example.com/jobs')).toBeNull();
		expect(hits).toBe(2);
		expect(slept.some((ms) => ms >= 5000)).toBe(true);
	});

	it('Retry-After уважается, если он больше бэкоффа', async () => {
		const { fetcher, slept } = makeFetcher({
			'https://example.com/robots.txt': emptyRobots,
			'https://example.com/jobs': () =>
				new Response('', { status: 429, headers: { 'retry-after': '30' } }),
		});

		await fetcher.fetch('https://example.com/jobs');

		expect(slept.some((ms) => ms >= 30_000)).toBe(true);
	});

	it('бюджет запросов на хост за прогон исчерпывается', async () => {
		const fetcher = new BridgeFetcher({
			allowlist: ALLOWLIST,
			maxRequestsPerHost: 2,
			sleepFn: async () => {},
			nowMsFn: () => 0,
			fetchFn: (async (input: string | URL) => {
				const url = input.toString();
				if (url.endsWith('/robots.txt')) return emptyRobots();
				return html();
			}) as unknown as typeof fetch,
		});

		expect(await fetcher.fetch('https://example.com/a')).not.toBeNull();
		expect(await fetcher.fetch('https://example.com/b')).not.toBeNull();
		// Третий уже за бюджетом — деградируем, а не долбим хост.
		expect(await fetcher.fetch('https://example.com/c')).toBeNull();
	});
});
