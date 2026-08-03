/**
 * fetcher.ts — единственное место, где подсистема поиска работы ходит в сеть ([ADR-0029] §1).
 *
 * Это обычный TS-модуль моста, а НЕ инструмент LLM. Постура движка не меняется:
 * `deny: [WebFetch, WebSearch]` остаётся, `--allowedTools` под сеть не расширяется. Смысл
 * границы прямой: приватные данные в cwd + недоверенный контент + канал наружу не должны
 * сходиться в одном процессе ([ADR-0007], lethal trifecta). Здесь есть сеть — и нет LLM.
 *
 * Контракт эталонный для провайдеров проекта (`src/ingest/finance/fx.ts`): узкий интерфейс,
 * инъекция `fetchFn`, НИКОГДА не бросает. Любая беда — сеть, таймаут, allowlist, robots,
 * размер, тип — даёт `null` и строку в лог. Discovery от этого деградирует («из подключённых
 * источников доступно 2 из 3»), но мост не падает.
 *
 * Чего здесь нет и не будет: авторизованного скрейпинга, cookie, заголовка Authorization,
 * мимикрии под браузер, headless-браузера и параллельных вееров запросов. Всё это либо
 * нарушает ToS площадок ([ADR-0009]), либо превращает вежливую загрузку в обход защиты.
 */

import { childLogger } from '../../core/logger.js';

const log = childLogger('bridge.net.fetcher');

/** Загруженный документ: только то, что нужно детерминированному парсеру. */
export interface FetchedDoc {
	/** Итоговый URL без query (в лог и провенанс query не попадает — сквозной запрет). */
	url: string;
	host: string;
	contentType: string;
	body: string;
	/** Прошёл ли хост проверку robots.txt (в провенанс записи, [ADR-0029] §3). */
	robotsOk: true;
}

/** Настройки загрузчика. Все лимиты — из [ADR-0029] §1 и вынесены сюда явно. */
export interface FetcherOptions {
	/**
	 * Разрешённые хосты. Точное совпадение ИЛИ явно разрешённый поддомен
	 * (`example.com` разрешает `example.com`, но не `evil-example.com`; поддомен
	 * разрешается записью с ведущей точкой: `.example.com`).
	 */
	allowlist: string[];
	/** Инъекция транспорта — тесты офлайн, живой сети в них нет. */
	fetchFn?: typeof fetch;
	/** Инъекция пауз: тесты не должны ждать бэкофф по-настоящему. */
	sleepFn?: (ms: number) => Promise<void>;
	/** Суммарный таймаут на запрос, мс. */
	timeoutMs?: number;
	/** Потолок размера тела, байт. */
	maxBytes?: number;
	/** Минимальная пауза между запросами к одному хосту, мс. */
	minHostIntervalMs?: number;
	/** Потолок запросов к одному хосту за прогон. */
	maxRequestsPerHost?: number;
	/** Источник времени для rate-limit. Инъекция — ради детерминированных тестов. */
	nowMsFn?: () => number;
	/**
	 * User-Agent: честный и идентифицирующий. Мимикрия под браузер запрещена —
	 * она превращает вежливую загрузку в обход защиты, а обходов мы не делаем.
	 */
	userAgent?: string;
}

const DEFAULTS = {
	timeoutMs: 10_000,
	maxBytes: 2 * 1024 * 1024,
	minHostIntervalMs: 2_000,
	maxRequestsPerHost: 20,
	maxRedirects: 3,
	backoffMs: 5_000,
	userAgent: 'personal-llm-wiki-jobsearch/1.0 (+https://example.com/contact)',
} as const;

/** Типы содержимого, которые парсер умеет разобрать. Остальное — `null`. */
const ALLOWED_CONTENT_TYPES = ['text/html', 'text/plain', 'application/json', 'text/csv'];

/**
 * hostAllowed — точное совпадение или явно разрешённый поддомен.
 *
 * Запись без точки разрешает ровно этот хост. Запись `.example.com` разрешает любой
 * поддомен. Суффиксное сравнение без точки было бы дырой: `evil-example.com`
 * заканчивается на `example.com`.
 */
export function hostAllowed(host: string, allowlist: string[]): boolean {
	const normalized = host.toLowerCase();
	return allowlist.some((entry) => {
		const e = entry.toLowerCase();
		return e.startsWith('.') ? normalized.endsWith(e) : normalized === e;
	});
}

/** stripQuery — URL без query и фрагмента: PII в query-строке не хранится и не логируется. */
export function stripQuery(url: string): string {
	const u = new URL(url);
	u.search = '';
	u.hash = '';
	return u.toString();
}

/**
 * parseRobots — какие пути запрещены нашему UA.
 *
 * Разбираем только `User-agent` + `Disallow` — этого достаточно, чтобы уважать запрет.
 * Группы для чужих UA игнорируем; `*` и наш собственный UA учитываем.
 */
export function parseRobots(text: string, userAgent: string): string[] {
	const disallow: string[] = [];
	let applies = false;

	for (const rawLine of text.split('\n')) {
		const line = rawLine.split('#')[0]!.trim();
		if (!line) continue;
		const [rawKey, ...rest] = line.split(':');
		const key = (rawKey ?? '').trim().toLowerCase();
		const value = rest.join(':').trim();

		if (key === 'user-agent') {
			applies = value === '*' || userAgent.toLowerCase().includes(value.toLowerCase());
			continue;
		}
		if (key === 'disallow' && applies && value) disallow.push(value);
	}

	return disallow;
}

/** Состояние одного прогона: robots-кеш и счётчики rate-limit живут здесь. */
interface HostState {
	/** `null` — robots ещё не тянули. */
	disallow: string[] | null;
	/** Хост целиком закрыт (robots недоступен) — fail-closed по вежливости. */
	blocked: boolean;
	requests: number;
	lastRequestMs: number;
}

/**
 * BridgeFetcher — загрузчик с allowlist, robots, rate-limit и потолком размера.
 *
 * Экземпляр живёт на прогон discovery: счётчики и robots-кеш — его поля, поэтому
 * «не более 20 запросов на хост за прогон» — это свойство объекта, а не глобальная
 * переменная, которую невозможно сбросить в тесте.
 */
export class BridgeFetcher {
	private readonly allowlist: string[];
	private readonly fetchFn: typeof fetch;
	private readonly sleepFn: (ms: number) => Promise<void>;
	private readonly timeoutMs: number;
	private readonly maxBytes: number;
	private readonly minHostIntervalMs: number;
	private readonly maxRequestsPerHost: number;
	private readonly userAgent: string;
	private readonly nowMsFn: () => number;
	private readonly hosts = new Map<string, HostState>();

	constructor(opts: FetcherOptions) {
		this.allowlist = opts.allowlist;
		this.fetchFn = opts.fetchFn ?? fetch;
		this.sleepFn = opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
		this.maxBytes = opts.maxBytes ?? DEFAULTS.maxBytes;
		this.minHostIntervalMs = opts.minHostIntervalMs ?? DEFAULTS.minHostIntervalMs;
		this.maxRequestsPerHost = opts.maxRequestsPerHost ?? DEFAULTS.maxRequestsPerHost;
		this.userAgent = opts.userAgent ?? DEFAULTS.userAgent;
		this.nowMsFn = opts.nowMsFn ?? Date.now;
	}

	/**
	 * fetch — загрузить документ. Возвращает `null` при любой проблеме.
	 *
	 * @param url — абсолютный https-URL
	 */
	async fetch(url: string): Promise<FetchedDoc | null> {
		try {
			return await this.fetchInner(url, 0);
		} catch (err) {
			// Сюда попадать не должны: внутренние шаги сами возвращают null. Но контракт
			// «никогда не бросает» важнее аккуратности внутри — discovery не имеет права
			// уронить мост из-за чужого сервера.
			log.warn({ err: String(err) }, 'fetcher.unexpected_error');
			return null;
		}
	}

	private state(host: string): HostState {
		let s = this.hosts.get(host);
		if (!s) {
			s = { disallow: null, blocked: false, requests: 0, lastRequestMs: 0 };
			this.hosts.set(host, s);
		}
		return s;
	}

	private async fetchInner(url: string, redirects: number): Promise<FetchedDoc | null> {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			log.warn('fetcher.bad_url');
			return null;
		}

		if (parsed.protocol !== 'https:') {
			log.warn({ host: parsed.host }, 'fetcher.not_https');
			return null;
		}
		if (!hostAllowed(parsed.hostname, this.allowlist)) {
			// Запрос НЕ отправляется вовсе: allowlist проверяется до сети.
			log.warn({ host: parsed.hostname }, 'fetcher.host_not_allowed');
			return null;
		}

		const state = this.state(parsed.hostname);
		if (state.requests >= this.maxRequestsPerHost) {
			log.warn({ host: parsed.hostname }, 'fetcher.host_budget_exhausted');
			return null;
		}

		if (!(await this.robotsAllows(parsed))) return null;

		const response = await this.request(parsed);
		if (!response) return null;

		// Редиректы — вручную: каждый Location заново проходит allowlist. Иначе схему
		// обходит один 302, и это самая частая дыра такой проверки.
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location');
			if (!location) return null;
			if (redirects >= DEFAULTS.maxRedirects) {
				log.warn({ host: parsed.hostname }, 'fetcher.too_many_redirects');
				return null;
			}
			const next = new URL(location, parsed).toString();
			return this.fetchInner(next, redirects + 1);
		}

		if (!response.ok) {
			log.warn({ host: parsed.hostname, status: response.status }, 'fetcher.http_error');
			return null;
		}

		const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
		if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
			log.warn({ host: parsed.hostname, contentType }, 'fetcher.content_type_rejected');
			return null;
		}

		const body = await this.readCapped(response, parsed.hostname);
		if (body === null) return null;

		log.info({ host: parsed.hostname, status: response.status, bytes: body.length }, 'fetcher.ok');
		return {
			url: stripQuery(parsed.toString()),
			host: parsed.hostname,
			contentType,
			body,
			robotsOk: true,
		};
	}

	/**
	 * robotsAllows — уважает robots.txt ([ADR-0029] §1).
	 *
	 * `404`/пустой файл → разрешено. Недоступен по сети или `5xx` → считаем ЗАПРЕЩЁННЫМ:
	 * это fail-closed по вежливости, а не по безопасности — если сервер не может сказать,
	 * что нам можно, мы не ходим.
	 */
	private async robotsAllows(url: URL): Promise<boolean> {
		const state = this.state(url.hostname);
		if (state.blocked) return false;

		if (state.disallow === null) {
			const response = await this.request(new URL('/robots.txt', url.origin), { skipCount: true });
			if (!response) {
				state.blocked = true;
				log.warn({ host: url.hostname }, 'fetcher.robots_unreachable_blocked');
				return false;
			}
			if (response.status >= 500) {
				state.blocked = true;
				log.warn({ host: url.hostname, status: response.status }, 'fetcher.robots_5xx_blocked');
				return false;
			}
			state.disallow =
				response.status === 404 ? [] : parseRobots(await response.text(), this.userAgent);
		}

		const path = url.pathname;
		const denied = state.disallow.some((rule) => rule === '/' || path.startsWith(rule));
		if (denied) log.warn({ host: url.hostname }, 'fetcher.robots_disallow');
		return !denied;
	}

	/**
	 * request — один HTTP-вызов с таймаутом, rate-limit и ОДНИМ ретраем.
	 *
	 * Ретрай только на сетевую ошибку / `5xx` / `429`. `4xx` не ретраится никогда:
	 * повтор по 403 — это уже долбёжка, а не устойчивость.
	 */
	private async request(url: URL, opts: { skipCount?: boolean } = {}): Promise<Response | null> {
		const state = this.state(url.hostname);

		for (let attempt = 0; attempt < 2; attempt++) {
			// Rate-limit: не чаще одного запроса в интервал на хост, обход последовательный.
			const waitMs = state.lastRequestMs + this.minHostIntervalMs - this.nowMsFn();
			if (waitMs > 0) await this.sleepFn(waitMs);

			state.lastRequestMs = this.nowMsFn();
			if (!opts.skipCount) state.requests++;

			let response: Response;
			try {
				response = await this.fetchFn(url.toString(), {
					method: 'GET',
					redirect: 'manual',
					signal: AbortSignal.timeout(this.timeoutMs),
					headers: { 'user-agent': this.userAgent, accept: ALLOWED_CONTENT_TYPES.join(', ') },
					// Ни cookies, ни Authorization: чужая сессия не переиспользуется никогда
					// ([ADR-0009]) — правило шире подписочного OAuth и покрывает любой cookie-jar.
					credentials: 'omit',
				});
			} catch (err) {
				log.warn({ host: url.hostname, err: String(err) }, 'fetcher.network_error');
				if (attempt === 0) {
					await this.sleepFn(DEFAULTS.backoffMs);
					continue;
				}
				return null;
			}

			const retriable = response.status >= 500 || response.status === 429;
			if (retriable && attempt === 0) {
				const retryAfter = Number(response.headers.get('retry-after'));
				const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
				await this.sleepFn(Math.max(DEFAULTS.backoffMs, delay));
				continue;
			}
			return response;
		}

		return null;
	}

	/**
	 * readCapped — читает тело потоково и ОБРЫВАЕТ на превышении потолка.
	 *
	 * Не `await response.text()`: у неизвестного тела нет заранее известного размера,
	 * и «прочитать, потом проверить» означает прочитать сколько дадут.
	 */
	private async readCapped(response: Response, host: string): Promise<string | null> {
		const declared = Number(response.headers.get('content-length'));
		if (Number.isFinite(declared) && declared > this.maxBytes) {
			log.warn({ host, declared }, 'fetcher.too_large_declared');
			return null;
		}

		const reader = response.body?.getReader();
		if (!reader) {
			// Транспорт без потока (мок в тестах) — берём текст и проверяем размер после.
			const text = await response.text();
			if (Buffer.byteLength(text, 'utf8') > this.maxBytes) {
				log.warn({ host }, 'fetcher.too_large');
				return null;
			}
			return text;
		}

		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > this.maxBytes) {
				await reader.cancel();
				log.warn({ host, total }, 'fetcher.too_large');
				return null;
			}
			chunks.push(value);
		}

		return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
	}
}
