/**
 * fx-historical.test.ts — тесты исторических курсов FX (E3).
 *
 * Принципы:
 *   - Все данные синтетические (FAKE, нет PII, нет реальных токенов/ключей).
 *   - Нет реальных сетевых запросов: fetch мокируется через fetchFn.
 *   - Тестируем ИСТОРИЧЕСКУЮ семантику: разные даты → разные курсы.
 *   - lint:public остаётся зелёным: нет захардкоженных API-ключей.
 *
 * Покрытие:
 *   1. CbrFxProvider — запрашивает курс НА ДАТУ (два разных курса для двух дат).
 *   2. CbrFxProvider — кеш по дате (повторный вызов той же даты не делает второй запрос).
 *   3. CbrFxProvider — разные даты → разные вызовы fetch.
 *   4. RecordedFxProvider — выбирает запись с ts ≤ atTs, ближайшую к дате.
 *   5. RecordedFxProvider — null если нет записей ≤ atTs.
 *   6. RecordedFxProvider — null если массив записей пустой.
 *   7. Null-fallback: ChainedFxProvider не бросает при null от всех провайдеров.
 *   8. ChainedFxProvider — первый ненулевой побеждает (RecordedFxProvider перед CBR).
 */

import { describe, expect, it, vi } from 'vitest';

import {
	CbrFxProvider,
	ChainedFxProvider,
	IdentityFxProvider,
	RecordedFxProvider,
	StablecoinFxProvider,
} from './fx.js';
import type { FxRateRecord } from './types.js';

// ---------------------------------------------------------------------------
// Синтетические фикстуры ответов ЦБ РФ (FAKE — не реальные курсы)
// ---------------------------------------------------------------------------

/**
 * Синтетический ответ ЦБ РФ для даты 2025-01-15.
 * Курсы полностью выдуманы — fake-example для тестов.
 */
const fakeCbrJan15 = {
	Date: '2025-01-15T00:00:00+03:00', // synthetic-example
	Valute: {
		USD: { CharCode: 'USD', Nominal: 1, Value: 88.0 }, // synthetic-example
		EUR: { CharCode: 'EUR', Nominal: 1, Value: 96.0 }, // synthetic-example
		GEL: { CharCode: 'GEL', Nominal: 1, Value: 31.5 }, // synthetic-example
	},
};

/**
 * Синтетический ответ ЦБ РФ для даты 2025-06-01.
 * Другой синтетический курс — должен отличаться от Jan-15 в тестах.
 */
const fakeCbrJun1 = {
	Date: '2025-06-01T00:00:00+03:00', // synthetic-example
	Valute: {
		USD: { CharCode: 'USD', Nominal: 1, Value: 82.5 }, // synthetic-example — другой курс
		EUR: { CharCode: 'EUR', Nominal: 1, Value: 90.0 }, // synthetic-example
	},
};

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

/**
 * makeDateMockFetch — создаёт mock fetch, который возвращает разные ответы
 * в зависимости от даты в URL.
 *
 * Формат URL ЦБ РФ: .../archive/YYYY/MM/DD/daily_json.js
 * Мы извлекаем дату из URL и возвращаем соответствующий synthetic ответ.
 */
function makeDateMockFetch(responses: Record<string, unknown>): typeof fetch {
	return async (url: string | URL | Request) => {
		const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;

		// Находим какой ответ вернуть по ключу даты в URL.
		for (const [dateKey, body] of Object.entries(responses)) {
			if (urlStr.includes(dateKey)) {
				return {
					ok: true,
					status: 200,
					json: async () => body,
				} as unknown as Response;
			}
		}

		// Нет совпадения — возвращаем 404.
		return {
			ok: false,
			status: 404,
			json: async () => ({}),
		} as unknown as Response;
	};
}

/**
 * makeSimpleMockFetch — mock fetch всегда возвращает один и тот же ответ.
 * Используется когда нам нужна только одна дата в тесте.
 */
function makeSimpleMockFetch(body: unknown): typeof fetch {
	return async (_url: string | URL | Request) => {
		return {
			ok: true,
			status: 200,
			json: async () => body,
		} as unknown as Response;
	};
}

// ---------------------------------------------------------------------------
// 1. CbrFxProvider — исторические курсы по дате
// ---------------------------------------------------------------------------

describe('CbrFxProvider: историческая точность (разные даты → разные курсы)', () => {
	it('USD→RUB на 2025-01-15 = синтетический курс Jan (88.0)', async () => {
		const mockFetch = makeDateMockFetch({
			'2025/01/15': fakeCbrJan15,
			'2025/06/01': fakeCbrJun1,
		});

		const provider = new CbrFxProvider({ fetchFn: mockFetch });
		const rate = await provider.rate('USD', 'RUB', '2025-01-15T10:00:00Z');

		// synthetic-example: Jan-15 USD.Value = 88.0
		expect(rate).toBeCloseTo(88.0);
	});

	it('USD→RUB на 2025-06-01 = синтетический курс Jun (82.5)', async () => {
		const mockFetch = makeDateMockFetch({
			'2025/01/15': fakeCbrJan15,
			'2025/06/01': fakeCbrJun1,
		});

		const provider = new CbrFxProvider({ fetchFn: mockFetch });
		const rate = await provider.rate('USD', 'RUB', '2025-06-01T09:00:00Z');

		// synthetic-example: Jun-01 USD.Value = 82.5
		expect(rate).toBeCloseTo(82.5);
	});

	it('два вызова с разными датами дают разные курсы', async () => {
		const mockFetch = makeDateMockFetch({
			'2025/01/15': fakeCbrJan15,
			'2025/06/01': fakeCbrJun1,
		});

		const provider = new CbrFxProvider({ fetchFn: mockFetch });

		const rateJan = await provider.rate('USD', 'RUB', '2025-01-15T00:00:00Z');
		const rateJun = await provider.rate('USD', 'RUB', '2025-06-01T00:00:00Z');

		// synthetic-example: разные курсы в разные месяцы
		expect(rateJan).toBeCloseTo(88.0);
		expect(rateJun).toBeCloseTo(82.5);
		expect(rateJan).not.toBeCloseTo(rateJun!);
	});

	it('GEL→RUB на Jan-15 (кросс-курс)', async () => {
		const mockFetch = makeSimpleMockFetch(fakeCbrJan15);
		const provider = new CbrFxProvider({ fetchFn: mockFetch });
		const rate = await provider.rate('GEL', 'RUB', '2025-01-15T00:00:00Z');

		// synthetic-example: GEL.Value = 31.5, Nominal = 1
		expect(rate).toBeCloseTo(31.5);
	});

	it('USD→EUR через кросс-курс на Jan-15', async () => {
		const mockFetch = makeSimpleMockFetch(fakeCbrJan15);
		const provider = new CbrFxProvider({ fetchFn: mockFetch });
		const rate = await provider.rate('USD', 'EUR', '2025-01-15T00:00:00Z');

		// synthetic-example: USD/RUB = 88.0, EUR/RUB = 96.0 → USD/EUR = 88.0/96.0
		expect(rate).toBeCloseTo(88.0 / 96.0);
	});
});

describe('CbrFxProvider: кеш по дате', () => {
	it('повторный вызов той же даты не делает второй HTTP-запрос', async () => {
		// Используем vi.fn() для подсчёта вызовов.
		const innerFetch = vi.fn(async (_url: string | URL | Request) => {
			return {
				ok: true,
				status: 200,
				json: async () => fakeCbrJan15,
			} as unknown as Response;
		});
		const fetchFn = innerFetch as unknown as typeof fetch;

		const provider = new CbrFxProvider({ fetchFn });

		// Два вызова с одной датой.
		await provider.rate('USD', 'RUB', '2025-01-15T08:00:00Z');
		await provider.rate('EUR', 'RUB', '2025-01-15T18:00:00Z');

		// Должен быть только 1 HTTP-запрос (кеш сработал на второй вызов).
		expect(innerFetch).toHaveBeenCalledTimes(1);
	});

	it('разные даты → разные HTTP-запросы (кеш раздельный)', async () => {
		const innerFetch = vi.fn(makeDateMockFetch({
			'2025/01/15': fakeCbrJan15,
			'2025/06/01': fakeCbrJun1,
		}));
		const fetchFn = innerFetch as unknown as typeof fetch;

		const provider = new CbrFxProvider({ fetchFn });

		await provider.rate('USD', 'RUB', '2025-01-15T00:00:00Z');
		await provider.rate('USD', 'RUB', '2025-06-01T00:00:00Z');

		// Два разных запроса — по одному на дату.
		expect(innerFetch).toHaveBeenCalledTimes(2);
	});
});

describe('CbrFxProvider: null-безопасность', () => {
	it('несуществующая дата (404) → null, не бросает', async () => {
		const errorFetch: typeof fetch = async () =>
			({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);

		const provider = new CbrFxProvider({ fetchFn: errorFetch });
		const rate = await provider.rate('USD', 'RUB', '2024-01-01T00:00:00Z');

		expect(rate).toBeNull();
	});

	it('сетевая ошибка → null, не бросает', async () => {
		const failFetch: typeof fetch = async () => {
			throw new Error('network error synthetic-example');
		};

		const provider = new CbrFxProvider({ fetchFn: failFetch });
		const rate = await provider.rate('USD', 'RUB', '2025-01-15T00:00:00Z');

		expect(rate).toBeNull();
	});

	it('валюта отсутствует в ответе → null', async () => {
		const mockFetch = makeSimpleMockFetch(fakeCbrJan15);
		const provider = new CbrFxProvider({ fetchFn: mockFetch });

		// XYZ нет в fakeCbrJan15.Valute
		const rate = await provider.rate('XYZ', 'RUB', '2025-01-15T00:00:00Z');
		expect(rate).toBeNull();
	});

	it('некорректный формат atTsISO → null (не бросает)', async () => {
		// Если передать невалидный timestamp — провайдер не должен падать.
		const errorFetch: typeof fetch = async () =>
			({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);

		const provider = new CbrFxProvider({ fetchFn: errorFetch });
		const rate = await provider.rate('USD', 'RUB', 'not-a-date');

		expect(rate).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 2. RecordedFxProvider — курс из зафиксированных записей
// ---------------------------------------------------------------------------

describe('RecordedFxProvider: выбор ближайшей записи ≤ atTs', () => {
	/**
	 * Синтетический набор FxRateRecord для тестов.
	 * Три записи USD/RUB с разными датами.
	 */
	const syntheticRecords: FxRateRecord[] = [
		// synthetic-example: курс 1 января 2025
		{
			ts: '2025-01-01T00:00:00Z',
			base: 'USD',
			quote: 'RUB',
			rate: 90.0, // synthetic-example
			source: 'cbr',
		},
		// synthetic-example: курс 1 февраля 2025
		{
			ts: '2025-02-01T00:00:00Z',
			base: 'USD',
			quote: 'RUB',
			rate: 88.5, // synthetic-example
			source: 'cbr',
		},
		// synthetic-example: курс 1 марта 2025
		{
			ts: '2025-03-01T00:00:00Z',
			base: 'USD',
			quote: 'RUB',
			rate: 85.0, // synthetic-example
			source: 'cbr',
		},
		// synthetic-example: EUR/RUB отдельная пара
		{
			ts: '2025-01-01T00:00:00Z',
			base: 'EUR',
			quote: 'RUB',
			rate: 98.0, // synthetic-example
			source: 'cbr',
		},
	];

	it('выбирает ближайшую запись ≤ atTs (Jan 20 → Jan 1)', async () => {
		const provider = new RecordedFxProvider(syntheticRecords);
		const rate = await provider.rate('USD', 'RUB', '2025-01-20T00:00:00Z');

		// synthetic-example: Jan 20 → ближайшая ≤ это Jan 1 (rate = 90.0)
		expect(rate).toBeCloseTo(90.0);
	});

	it('выбирает ближайшую запись ≤ atTs (Feb 15 → Feb 1)', async () => {
		const provider = new RecordedFxProvider(syntheticRecords);
		const rate = await provider.rate('USD', 'RUB', '2025-02-15T12:00:00Z');

		// synthetic-example: Feb 15 → ближайшая ≤ это Feb 1 (rate = 88.5)
		expect(rate).toBeCloseTo(88.5);
	});

	it('выбирает запись точно на дату запроса (Mar 1 = Mar 1)', async () => {
		const provider = new RecordedFxProvider(syntheticRecords);
		const rate = await provider.rate('USD', 'RUB', '2025-03-01T00:00:00Z');

		// synthetic-example: точное совпадение → rate = 85.0
		expect(rate).toBeCloseTo(85.0);
	});

	it('null если нет записей ≤ atTs (запрашиваем дату до первой записи)', async () => {
		const provider = new RecordedFxProvider(syntheticRecords);
		const rate = await provider.rate('USD', 'RUB', '2024-12-01T00:00:00Z');

		// synthetic-example: Dec 2024 раньше всех записей (с Jan 2025)
		expect(rate).toBeNull();
	});

	it('null для неизвестной валютной пары', async () => {
		const provider = new RecordedFxProvider(syntheticRecords);
		const rate = await provider.rate('GBP', 'RUB', '2025-02-15T00:00:00Z');

		// GBP/RUB нет в записях
		expect(rate).toBeNull();
	});

	it('null для пустого массива записей', async () => {
		const provider = new RecordedFxProvider([]);
		const rate = await provider.rate('USD', 'RUB', '2025-01-15T00:00:00Z');

		expect(rate).toBeNull();
	});

	it('нечувствителен к регистру базы/котировки', async () => {
		const provider = new RecordedFxProvider(syntheticRecords);

		// Передаём строчные буквы — должен найти USD/RUB.
		const rate = await provider.rate('usd', 'rub', '2025-01-20T00:00:00Z');
		expect(rate).toBeCloseTo(90.0); // synthetic-example
	});

	it('EUR/RUB не путается с USD/RUB', async () => {
		const provider = new RecordedFxProvider(syntheticRecords);
		const eurRate = await provider.rate('EUR', 'RUB', '2025-01-20T00:00:00Z');

		// synthetic-example: EUR/RUB Jan 1 = 98.0
		expect(eurRate).toBeCloseTo(98.0);
	});

	it('выбирает наиближайшую когда несколько кандидатов ≤ atTs', async () => {
		// synthetic-example: три записи USD/RUB Jan, Feb, Mar
		// Для Mar 31 → ближайшая ≤ это Mar 1 (rate 85.0), не Jan/Feb
		const provider = new RecordedFxProvider(syntheticRecords);
		const rate = await provider.rate('USD', 'RUB', '2025-03-31T23:59:59Z');

		// synthetic-example: Mar 31 → ближайшая ≤ Mar 1 (rate = 85.0)
		expect(rate).toBeCloseTo(85.0);
	});
});

// ---------------------------------------------------------------------------
// 3. Null-fallback: ChainedFxProvider не бросает при null от всех
// ---------------------------------------------------------------------------

describe('ChainedFxProvider: null-fallback не бросает', () => {
	it('все провайдеры возвращают null → результат null (не throw)', async () => {
		// IdentityFxProvider вернёт null для USD→RUB, больше провайдеров нет.
		const chain = new ChainedFxProvider([new IdentityFxProvider()]);
		const rate = await chain.rate('USD', 'RUB', '2025-01-15T00:00:00Z');

		expect(rate).toBeNull();
	});

	it('провайдер бросает исключение → поглощается, цепочка продолжает', async () => {
		// Первый провайдер падает с ошибкой, второй даёт ответ.
		const throwingProvider = {
			async rate(_b: string, _q: string, _ts: string): Promise<number | null> {
				throw new Error('synthetic crash test');
			},
		};

		const mockFetch = makeSimpleMockFetch(fakeCbrJan15);
		const chain = new ChainedFxProvider([
			throwingProvider,
			new CbrFxProvider({ fetchFn: mockFetch }),
		]);

		// Не бросает — CbrFxProvider отработал.
		const rate = await chain.rate('USD', 'RUB', '2025-01-15T00:00:00Z');
		expect(rate).not.toBeNull();
		expect(rate).toBeCloseTo(88.0); // synthetic-example
	});

	it('null-курс в цепочке не блокирует sync', async () => {
		// Имитируем sync: получаем курс для двух транзакций, одна валюта недоступна.
		const errorFetch: typeof fetch = async () =>
			({ ok: false, status: 503, json: async () => ({}) } as unknown as Response);

		const provider = new CbrFxProvider({ fetchFn: errorFetch });
		const chain = new ChainedFxProvider([
			new IdentityFxProvider(),
			new StablecoinFxProvider(),
			provider,
		]);

		// USDT→USD = 1 (stablecoin работает)
		const stableRate = await chain.rate('USDT', 'USD', '2025-01-15T00:00:00Z');
		expect(stableRate).toBe(1);

		// USD→RUB = null (CBR недоступен) — не бросает, sync продолжается
		const rubRate = await chain.rate('USD', 'RUB', '2025-01-15T00:00:00Z');
		expect(rubRate).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 4. ChainedFxProvider с RecordedFxProvider
// ---------------------------------------------------------------------------

describe('ChainedFxProvider: RecordedFxProvider перед CbrFxProvider', () => {
	it('RecordedFxProvider даёт курс → CBR не вызывается', async () => {
		const cbrCallCount = { count: 0 };

		const cbrFetch: typeof fetch = async () => {
			cbrCallCount.count += 1;
			return {
				ok: true,
				status: 200,
				json: async () => fakeCbrJan15,
			} as unknown as Response;
		};

		const recorded: FxRateRecord[] = [
			{
				ts: '2025-01-01T00:00:00Z',
				base: 'USD',
				quote: 'RUB',
				rate: 91.0, // synthetic-example: другой курс чем в CBR (88.0)
				source: 'manual',
			},
		];

		const chain = new ChainedFxProvider([
			new IdentityFxProvider(),
			new RecordedFxProvider(recorded),
			new CbrFxProvider({ fetchFn: cbrFetch }),
		]);

		const rate = await chain.rate('USD', 'RUB', '2025-01-15T00:00:00Z');

		// synthetic-example: RecordedFxProvider даёт 91.0 (Jan 1 ≤ Jan 15)
		expect(rate).toBeCloseTo(91.0);
		// CBR не был вызван — сетевой запрос не состоялся.
		expect(cbrCallCount.count).toBe(0);
	});

	it('RecordedFxProvider не нашёл → CBR вызывается', async () => {
		const cbrCallCount = { count: 0 };

		const cbrFetch: typeof fetch = async () => {
			cbrCallCount.count += 1;
			return {
				ok: true,
				status: 200,
				json: async () => fakeCbrJan15,
			} as unknown as Response;
		};

		// Записей нет — RecordedFxProvider вернёт null для любого запроса.
		const chain = new ChainedFxProvider([
			new IdentityFxProvider(),
			new RecordedFxProvider([]),
			new CbrFxProvider({ fetchFn: cbrFetch }),
		]);

		const rate = await chain.rate('USD', 'RUB', '2025-01-15T00:00:00Z');

		// synthetic-example: CBR даёт 88.0
		expect(rate).toBeCloseTo(88.0);
		// CBR был вызван (RecordedFxProvider не нашёл ничего).
		expect(cbrCallCount.count).toBe(1);
	});
});
