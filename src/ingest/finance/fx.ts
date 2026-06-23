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
 *   3. `CbrFxProvider` — любая валюта ЦБ РФ ↔ RUB (через cbr-xml-daily.ru).
 *      Параметр `atTsISO` используется для запроса ИСТОРИЧЕСКОГО курса на дату.
 *      Кеширует по дате — один запрос на уникальную дату за жизнь экземпляра.
 *   4. `RecordedFxProvider` — резолвит курс из массива ранее зафиксированных FxRateRecord.
 *      Чистая функция: нет сети, нет импорта Ledger — только массив записей на входе.
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

import type { FxRateRecord } from './types.js';

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
// 3. CbrFxProvider — ЦБ РФ (cbr-xml-daily.ru) с историческими курсами
// ---------------------------------------------------------------------------

/**
 * Структура ответа ЦБ РФ JSON API (cbr-xml-daily.ru/daily_json.js и архивный /archive/...).
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

/**
 * Базовый URL архивного API ЦБ РФ.
 * Формат: {CBR_ARCHIVE_BASE}/YYYY/MM/DD/daily_json.js
 * Пример: https://www.cbr-xml-daily.ru/archive/2025/01/15/daily_json.js
 */
const CBR_ARCHIVE_BASE = 'https://www.cbr-xml-daily.ru/archive';

/**
 * URL текущего (не архивного) курса — используется как fallback когда дата сегодняшняя
 * или архивный ответ недоступен.
 */
const CBR_CURRENT_URL = 'https://www.cbr-xml-daily.ru/daily_json.js';

/**
 * Извлекает дату в формате 'YYYY-MM-DD' из ISO-8601 строки.
 * Пример: "2025-01-15T12:30:00Z" → "2025-01-15"
 * При некорректном формате возвращает null.
 */
function isoToDateStr(atTsISO: string): string | null {
	// ISO дата — первые 10 символов всегда YYYY-MM-DD (если строка достаточно длинная).
	if (atTsISO.length < 10) return null;
	const dateStr = atTsISO.slice(0, 10);
	// Валидируем что это действительно дата (не произвольный текст).
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
	return dateStr;
}

/**
 * Строит URL архивного JSON ЦБ РФ по строке даты 'YYYY-MM-DD'.
 * Пример: "2025-01-15" → "https://www.cbr-xml-daily.ru/archive/2025/01/15/daily_json.js"
 */
function cbrArchiveUrl(dateStr: string, baseUrl: string): string {
	const [yyyy, mm, dd] = dateStr.split('-');
	return `${baseUrl}/${yyyy}/${mm}/${dd}/daily_json.js`;
}

/**
 * CbrFxProvider — курс любой валюты к RUB и обратно через ЦБ РФ.
 *
 * Поддерживает:
 *   USD → RUB:  прямо из ЦБ (1 USD = Value RUB)
 *   RUB → USD:  1 / (USD/RUB)
 *   EUR → RUB, GEL → RUB и любые другие валюты в ЦБ РФ словаре.
 *   USD → EUR:  через перекрёстный курс (USD/RUB) / (EUR/RUB)
 *
 * ИСТОРИЧЕСКАЯ ТОЧНОСТЬ: параметр `atTsISO` определяет дату запроса.
 * Провайдер запрашивает архивный URL ЦБ РФ вида:
 *   https://www.cbr-xml-daily.ru/archive/YYYY/MM/DD/daily_json.js
 * Кеш PER ДАТА — один HTTP-запрос на уникальную дату за жизнь экземпляра.
 * Это экономит сеть при нормализации нескольких пар с одной датой.
 *
 * FALLBACK: если архивный запрос вернул !ok или бросил ошибку (например,
 * для будущих дат или очень старых), метод возвращает null — не бросает.
 *
 * Инъекция fetchFn — для тестов без реальной сети.
 */
export class CbrFxProvider implements FxProvider {
	private readonly fetchFn: typeof fetch;

	/**
	 * Базовый URL для построения архивных URL'ов.
	 * Инъецируется в тестах — позволяет подставить mock-origin.
	 */
	private readonly cbrArchiveBase: string;

	/**
	 * URL текущего (не-архивного) курса.
	 * Сохраняем для обратной совместимости с тестами, которые подставляют cbrUrl.
	 */
	private readonly cbrCurrentUrl: string;

	/**
	 * Кеш по дате: Map<'YYYY-MM-DD', CbrResponse | null>.
	 * null означает «запрашивали, но не получили» — не будем повторять запрос.
	 */
	private readonly dateCache: Map<string, CbrResponse | null> = new Map();

	constructor(
		opts: {
			fetchFn?: typeof fetch;
			/**
			 * cbrUrl — URL текущего курса (не архивного).
			 * Оставлен для совместимости с тестами finance.test.ts.
			 * Если задан — используется как cbrCurrentUrl.
			 */
			cbrUrl?: string;
			/**
			 * cbrArchiveBase — базовый URL архивного API.
			 * Инъецируется в тестах: при подстановке моки возвращают нужный ответ
			 * независимо от конкретного пути.
			 */
			cbrArchiveBase?: string;
		} = {},
	) {
		this.fetchFn = opts.fetchFn ?? globalThis.fetch;
		this.cbrCurrentUrl = opts.cbrUrl ?? CBR_CURRENT_URL;
		this.cbrArchiveBase = opts.cbrArchiveBase ?? CBR_ARCHIVE_BASE;
	}

	/**
	 * fetchCbrForDate — загружает данные ЦБ РФ на конкретную дату.
	 *
	 * Алгоритм:
	 *   1. Определяем дату из atTsISO (YYYY-MM-DD).
	 *   2. Если дата уже в кеше — возвращаем кешированный результат (включая null).
	 *   3. Делаем запрос к архивному URL.
	 *   4. При ошибке кешируем null (не будем долбить сервер повторно в той же сессии).
	 *
	 * Возвращает null при любой ошибке — не бросает.
	 */
	private async fetchCbrForDate(atTsISO: string): Promise<CbrResponse | null> {
		// Извлекаем дату из ISO-строки.
		const dateStr = isoToDateStr(atTsISO);

		// Если дата не парсится — используем текущий URL (аналог старого поведения).
		const url =
			dateStr !== null ? cbrArchiveUrl(dateStr, this.cbrArchiveBase) : this.cbrCurrentUrl;

		// Ключ кеша — строка даты или специальный ключ для некорректных дат.
		const cacheKey = dateStr ?? '__invalid_date__';

		// Проверяем кеш (включая закешированный null = неудачный запрос).
		if (this.dateCache.has(cacheKey)) {
			return this.dateCache.get(cacheKey) ?? null;
		}

		try {
			const response = await this.fetchFn(url);
			if (!response.ok) {
				// Ошибка HTTP — кешируем null, не бросаем.
				this.dateCache.set(cacheKey, null);
				return null;
			}
			const data = (await response.json()) as CbrResponse;
			this.dateCache.set(cacheKey, data);
			return data;
		} catch {
			// Сетевая ошибка или некорректный JSON — кешируем null тихо.
			this.dateCache.set(cacheKey, null);
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
	 * rate — возвращает ИСТОРИЧЕСКИЙ курс base/quote через ЦБ РФ на дату atTsISO.
	 *
	 * Алгоритм:
	 *   1. base=X, quote=RUB → rubPerUnit(X)
	 *   2. base=RUB, quote=X → 1/rubPerUnit(X)
	 *   3. base=X, quote=Y  → rubPerUnit(X) / rubPerUnit(Y)  (кросс-курс)
	 *
	 * Дата извлекается из первых 10 символов atTsISO (YYYY-MM-DD) → запрашивает
	 * архивный JSON ЦБ для этой даты.
	 */
	async rate(base: string, quote: string, atTsISO: string): Promise<number | null> {
		const b = base.toUpperCase();
		const q = quote.toUpperCase();

		// Тождественное отображение — на случай если IdentityFxProvider не в цепочке.
		if (b === q) return 1;

		const data = await this.fetchCbrForDate(atTsISO);
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
// 4. RecordedFxProvider — курс из массива зафиксированных FxRateRecord
// ---------------------------------------------------------------------------

/**
 * RecordedFxProvider — ЧИСТЫЙ провайдер без сети.
 *
 * Получает массив ранее зафиксированных FxRateRecord на входе (напр. из ledger'а).
 * Для каждого запроса rate(base, quote, atTsISO) выбирает запись с совпадающей
 * парой base/quote и НАИБЛИЖАЙШЕЙ меткой ts ≤ atTs (floor-семантика).
 *
 * Если записей с ts ≤ atTs нет — возвращает null (не берёт "будущие" курсы).
 *
 * ПОЧЕМУ НЕ ИМПОРТИРУЕТ LEDGER: провайдер принимает готовый массив — это держит
 * fx.ts развязанным от хранилища и упрощает тесты (можно передать фикстуру напрямую).
 * Загрузку записей из Ledger делает вызывающий код.
 *
 * Инвариант пар: сравниваем base/quote UPPERCASE для нормализации.
 *
 * Пример:
 *   records = [
 *     { ts: "2025-01-01T00:00:00Z", base: "USD", quote: "RUB", rate: 90.0, source: "cbr" },
 *     { ts: "2025-02-01T00:00:00Z", base: "USD", quote: "RUB", rate: 88.5, source: "cbr" },
 *   ]
 *   rate("USD", "RUB", "2025-01-20T00:00:00Z") → 90.0  (ближайший ≤ = Jan 1)
 *   rate("USD", "RUB", "2024-12-01T00:00:00Z") → null  (нет записей ≤ Dec 2024)
 */
export class RecordedFxProvider implements FxProvider {
	constructor(private readonly records: FxRateRecord[]) {}

	async rate(base: string, quote: string, atTsISO: string): Promise<number | null> {
		const b = base.toUpperCase();
		const q = quote.toUpperCase();

		// Фильтруем записи по паре (сравниваем UPPERCASE) и ограничению ts ≤ atTs.
		// ISO-8601 строки корректно сортируются лексикографически (UTC timestamps).
		const candidates = this.records.filter(
			(r) =>
				r.base.toUpperCase() === b &&
				r.quote.toUpperCase() === q &&
				r.ts <= atTsISO,
		);

		if (candidates.length === 0) {
			// Нет ни одной записи с ts ≤ atTs для этой пары.
			return null;
		}

		// Выбираем наиближайшую запись — с наибольшим ts ≤ atTs.
		// Сортируем по ts убыванию и берём первую.
		const nearest = candidates.reduce((best, cur) => (cur.ts > best.ts ? cur : best));

		return nearest.rate;
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
 *   [IdentityFxProvider, StablecoinFxProvider, RecordedFxProvider, CbrFxProvider]
 *
 * RecordedFxProvider ставим перед CbrFxProvider — сначала проверяем локально
 * зафиксированные курсы (точные исторические данные), потом идём в сеть.
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
 * @param opts.cbrUrl  — переопределение URL текущего курса CBR для тестов (совместимость)
 * @param opts.cbrArchiveBase — переопределение базового URL архивного API для тестов
 */
export function createDefaultFxProvider(
	opts: { fetchFn?: typeof fetch; cbrUrl?: string; cbrArchiveBase?: string } = {},
): FxProvider {
	return new ChainedFxProvider([
		new IdentityFxProvider(),
		new StablecoinFxProvider(),
		new CbrFxProvider({
			fetchFn: opts.fetchFn,
			cbrUrl: opts.cbrUrl,
			cbrArchiveBase: opts.cbrArchiveBase,
		}),
	]);
}
