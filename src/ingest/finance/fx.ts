/**
 * fx.ts — pluggable провайдер курсов валют.
 *
 * Архитектура ([ADR-0018], «мультивалютность, currency-agnostic»):
 *   - `FxProvider` — интерфейс: один метод `rate(base, quote, atTsISO) → Promise<number|null>`.
 *   - Провайдеры chain'ируются через `ChainedFxProvider` (первый ненулевой ответ побеждает).
 *   - `rate()` НИКОГДА не бросает исключение — только возвращает null при недоступности.
 *     Это позволяет sync'у завершаться успешно даже если курс недоступен (некритично).
 *
 * MVP-реализации:
 *   1. `IdentityFxProvider` — X→X = 1 (всегда).
 *   2. `StablecoinFxProvider` — USDT/USDC→USD ≈ 1, USD→USDT ≈ 1 (и обратно).
 *   3. `CbrFxProvider` — USD↔RUB через ЦБ РФ JSON API (cbr-xml-daily.ru).
 *      Параметр `atTsISO` игнорируется в MVP — используется ТЕКУЩИЙ курс.
 *      TODO Phase 2: исторические курсы через cbr.ru XML-архив.
 *
 * Расширение (пример добавления NBG для GEL):
 *   class NbgFxProvider implements FxProvider {
 *     async rate(base, quote, _ts) { ... fetch https://nbg.gov.ge/gw/api/ct/... }
 *   }
 *   const provider = new ChainedFxProvider([new IdentityFxProvider(), new NbgFxProvider(), new CbrFxProvider()]);
 *
 * БЕЗОПАСНОСТЬ: провайдеры читают только open API (без авторизации), не логируют
 * никаких пользовательских данных. `atTsISO` используется только как временная метка,
 * не содержит идентификаторов.
 */

// ---------------------------------------------------------------------------
// Интерфейс провайдера
// ---------------------------------------------------------------------------

/**
 * FxProvider — контракт провайдера курса валют.
 *
 * @param base    — базовая валюта (напр. "USD", "USDT", "BTC")
 * @param quote   — валюта котировки (напр. "RUB", "USD")
 * @param atTsISO — желаемый момент курса в ISO-8601 (провайдеры могут игнорировать)
 * @returns Promise<number|null> — курс (1 base = N quote) или null если недоступно
 *
 * Инвариант: НИКОГДА не бросает исключение. При любой ошибке возвращает null.
 * Это позволяет chain'у пробовать следующий провайдер и не прерывать sync.
 */
export interface FxProvider {
	rate(base: string, quote: string, atTsISO: string): Promise<number | null>;
}

// ---------------------------------------------------------------------------
// 1. IdentityFxProvider — тождественное отображение X→X = 1
// ---------------------------------------------------------------------------

/**
 * IdentityFxProvider — возвращает 1 для любой пары X/X (одна и та же валюта).
 * Для разных валют возвращает null.
 *
 * Используется как первый провайдер в ChainedFxProvider — убирает вырожденный случай
 * без лишнего сетевого запроса.
 */
export class IdentityFxProvider implements FxProvider {
	async rate(base: string, quote: string, _atTsISO: string): Promise<number | null> {
		// Нормализуем к UPPERCASE для сравнения: "usd" == "USD".
		if (base.toUpperCase() === quote.toUpperCase()) return 1;
		return null;
	}
}

// ---------------------------------------------------------------------------
// 2. StablecoinFxProvider — стейблкоины ≈ 1 USD
// ---------------------------------------------------------------------------

/**
 * STABLE_TO_USD — стейблкоины, для которых принимаем курс 1:1 к USD.
 * Только те, у которых депег крайне редок и незначителен на масштабе личных финансов.
 * Добавлять осторожно: USDN/UST и др. не стабильны.
 */
const STABLE_TO_USD = new Set(['USDT', 'USDC', 'BUSD', 'TUSD', 'USDP']);

/**
 * StablecoinFxProvider — USDT/USDC → USD ≈ 1 и обратно.
 *
 * Обрабатывает пары:
 *   USDT → USD:  1
 *   USD  → USDT: 1
 *   USDT → USDC: 1 (через USD как промежуточное)
 *
 * Для пар стейблкоин→другая валюта (напр. USDT→RUB) возвращает null —
 * цепочка продолжит поиск (CbrFxProvider обработает USD→RUB).
 */
export class StablecoinFxProvider implements FxProvider {
	async rate(base: string, quote: string, _atTsISO: string): Promise<number | null> {
		const b = base.toUpperCase();
		const q = quote.toUpperCase();

		// Оба стейблкоины → между собой ≈ 1.
		if (STABLE_TO_USD.has(b) && STABLE_TO_USD.has(q)) return 1;

		// Стейблкоин → USD: 1.
		if (STABLE_TO_USD.has(b) && q === 'USD') return 1;

		// USD → стейблкоин: 1.
		if (b === 'USD' && STABLE_TO_USD.has(q)) return 1;

		return null;
	}
}

// ---------------------------------------------------------------------------
// 3. CbrFxProvider — ЦБ РФ (cbr-xml-daily.ru)
// ---------------------------------------------------------------------------

/**
 * Структура ответа ЦБ РФ JSON API (cbr-xml-daily.ru/daily_json.js).
 * Показываем только нужные поля.
 */
interface CbrValute {
	CharCode: string; // "USD", "EUR", "GEL", ...
	Nominal: number; // номинал (обычно 1, но для JPY = 100)
	Value: number; // курс nominal единиц в рублях
}

interface CbrResponse {
	Date: string; // дата публикации
	Valute: Record<string, CbrValute>; // ключ = CharCode
}

/** URL ЦБ РФ — можно переопределить в тестах. */
const CBR_URL = 'https://www.cbr-xml-daily.ru/daily_json.js';

/**
 * CbrFxProvider — курс любой валюты к RUB и обратно через ЦБ РФ.
 *
 * Поддерживает:
 *   USD → RUB:  прямо из ЦБ (1 USD = Value RUB)
 *   RUB → USD:  1 / (USD/RUB)
 *   EUR → RUB, GEL → RUB и любые другие валюты в ЦБ РФ словаре.
 *   USD → EUR:  через перекрёстный курс (USD/RUB) / (EUR/RUB)
 *
 * Параметр `atTsISO` в MVP ИГНОРИРУЕТСЯ — используется текущий курс ЦБ.
 * TODO Phase 2: для исторических курсов использовать cbr.ru XML-архив
 *   (https://cbr.ru/scripts/XML_dynamic.asp?date_req1=...&date_req2=...&VAL_NM_RQ=...).
 *
 * Кеширует ответ ЦБ внутри одного экземпляра (TTL = 1 час) чтобы не делать
 * дублирующие запросы при нормализации нескольких пар за один sync.
 *
 * Инъекция fetchFn — для тестов без реальной сети.
 */
export class CbrFxProvider implements FxProvider {
	private readonly fetchFn: typeof fetch;
	private readonly cbrUrl: string;

	/** Кеш последнего ответа (не переживает перезапуск). */
	private cache: { data: CbrResponse; fetchedAt: number } | null = null;

	/** TTL кеша в мс (1 час). Курс ЦБ обновляется раз в сутки — 1 час достаточно. */
	private readonly cacheTtlMs: number;

	constructor(opts: { fetchFn?: typeof fetch; cbrUrl?: string; cacheTtlMs?: number } = {}) {
		this.fetchFn = opts.fetchFn ?? globalThis.fetch;
		this.cbrUrl = opts.cbrUrl ?? CBR_URL;
		this.cacheTtlMs = opts.cacheTtlMs ?? 3600_000;
	}

	/**
	 * fetchCbr — загружает свежие данные ЦБ РФ (или берёт из кеша).
	 * Возвращает null при любой ошибке сети/парсинга — не бросает.
	 */
	private async fetchCbr(): Promise<CbrResponse | null> {
		// Проверяем кеш.
		if (this.cache && Date.now() - this.cache.fetchedAt < this.cacheTtlMs) {
			return this.cache.data;
		}

		try {
			const response = await this.fetchFn(this.cbrUrl);
			if (!response.ok) return null;
			const data = (await response.json()) as CbrResponse;
			this.cache = { data, fetchedAt: Date.now() };
			return data;
		} catch {
			// Сетевая ошибка или некорректный JSON — возвращаем null тихо.
			return null;
		}
	}

	/**
	 * rubPerUnit — возвращает курс "1 единица charCode = ? RUB".
	 * Учитывает Nominal (JPY = 100 ен за значение).
	 * null если валюта не найдена в ЦБ.
	 */
	private rubPerUnit(data: CbrResponse, charCode: string): number | null {
		const entry = data.Valute[charCode];
		if (!entry) return null;
		if (entry.Nominal <= 0) return null;
		// Value = стоимость Nominal единиц → стоимость 1 единицы.
		return entry.Value / entry.Nominal;
	}

	/**
	 * rate — возвращает курс base/quote через ЦБ РФ.
	 *
	 * Алгоритм:
	 *   1. base=X, quote=RUB → rubPerUnit(X)
	 *   2. base=RUB, quote=X → 1/rubPerUnit(X)
	 *   3. base=X, quote=Y  → rubPerUnit(X) / rubPerUnit(Y)  (кросс-курс)
	 */
	async rate(base: string, quote: string, _atTsISO: string): Promise<number | null> {
		const b = base.toUpperCase();
		const q = quote.toUpperCase();

		// Тождественное отображение — на случай если IdentityFxProvider не в цепочке.
		if (b === q) return 1;

		const data = await this.fetchCbr();
		if (!data) return null;

		// Случай 1: quote = RUB.
		if (q === 'RUB') {
			return this.rubPerUnit(data, b);
		}

		// Случай 2: base = RUB.
		if (b === 'RUB') {
			const rub = this.rubPerUnit(data, q);
			if (rub === null || rub === 0) return null;
			return 1 / rub;
		}

		// Случай 3: кросс-курс через RUB.
		const baseRub = this.rubPerUnit(data, b);
		const quoteRub = this.rubPerUnit(data, q);
		if (baseRub === null || quoteRub === null || quoteRub === 0) return null;
		return baseRub / quoteRub;
	}
}

// ---------------------------------------------------------------------------
// ChainedFxProvider — цепочка провайдеров
// ---------------------------------------------------------------------------

/**
 * ChainedFxProvider — перебирает провайдеры по порядку, возвращает первый
 * ненулевой результат. Если ни один не дал курс — возвращает null.
 *
 * Рекомендованный порядок в цепочке:
 *   [IdentityFxProvider, StablecoinFxProvider, CbrFxProvider]
 *
 * Расширение: добавить NbgFxProvider или OERFxProvider перед или после CbrFxProvider.
 */
export class ChainedFxProvider implements FxProvider {
	constructor(private readonly providers: FxProvider[]) {}

	async rate(base: string, quote: string, atTsISO: string): Promise<number | null> {
		for (const provider of this.providers) {
			let result: number | null;
			try {
				// Каждый провайдер должен сам поглощать ошибки, но на всякий случай
				// оборачиваем и здесь — чтобы один сломанный провайдер не ронял цепочку.
				result = await provider.rate(base, quote, atTsISO);
			} catch {
				result = null;
			}
			if (result !== null && Number.isFinite(result) && result > 0) {
				return result;
			}
		}
		return null;
	}
}

// ---------------------------------------------------------------------------
// Фабрика: дефолтный MVP-провайдер
// ---------------------------------------------------------------------------

/**
 * createDefaultFxProvider — создаёт цепочку MVP-провайдеров:
 *   Identity → Stablecoin → CBR
 *
 * Покрывает все пары из Bybit UNIFIED (крипто/USD) ↔ RUB.
 * При недоступности CBR — стейблкоины всё равно обрабатываются.
 *
 * @param opts.fetchFn — инъекция HTTP-клиента для тестов
 * @param opts.cbrUrl  — переопределение URL CBR API для тестов
 */
export function createDefaultFxProvider(opts: { fetchFn?: typeof fetch; cbrUrl?: string } = {}): FxProvider {
	return new ChainedFxProvider([
		new IdentityFxProvider(),
		new StablecoinFxProvider(),
		new CbrFxProvider({ fetchFn: opts.fetchFn, cbrUrl: opts.cbrUrl }),
	]);
}
