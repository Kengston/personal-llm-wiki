/**
 * finance-state.ts — мутабельное состояние финансового проактива (STATE-утилита волны 2).
 *
 * Хранит три независимых слоя состояния, необходимых кластерам волны 2
 * (C1-проактив, C3-реактив, credit/goal-пуши, watermark простоя):
 *
 *   1. Pending-опрос налички (writePendingCashSurvey / readPendingCashSurvey / clearPendingCashSurvey)
 *      — проактив C1 спрашивает «сколько наличных?», сохраняет маркер с контекстом
 *      (account, currency, sinceIso); когда владелец отвечает ОДНИМ числом (C3-реактив),
 *      маркер читается → ответ распознаётся как cash-снапшот, затем гасится.
 *
 *   2. Fired-дедуп проактивных пушей (markFired / wasFired)
 *      — гарантирует, что кредит-напоминание/майлстоун цели не пушится повторно
 *      в каждый sweep-цикл. Ключи: 'credit:<id>:<dueDate>:<lead|due>'
 *      или 'goal:<id>:milestone:<pct>'. Хранение — JSON-объект (key → whenIso).
 *      Идемпотентно: повторный markFired не дублирует запись.
 *
 *   3. Last-input watermark (readLastInputTs / writeLastInputTs)
 *      — момент последнего финансового ввода; sweep читает его, чтобы вычислить
 *      простой и напомнить «обнови данные».
 *
 * АРХИТЕКТУРА:
 *   - Все функции принимают базовый каталог dir (инъекция → тесты используют mkdtemp).
 *   - По умолчанию: CONTENT_ROOT/.finance-state/ (рядом с reminders/, аналог
 *     raw/.watermarks/ в config.ts, но МУТАБЕЛЬНЫЙ → НЕ в immutable raw/).
 *   - Атомарной записи нет нужды: файлы < 100 КБ, single-user, POSIX flush (ADR-0009).
 *   - Путь к файлам строится ВНУТРИ dir (не raw/finance/) — state НЕ финансовые данные,
 *     path-guard Ledger'а на них НЕ распространяется.
 *
 * ИНВАРИАНТЫ (ADR-0009, ADR-0011, ADR-0015):
 *   - Синтетические данные в тестах. Нет PII в файлах состояния.
 *   - Нет сетевых вызовов, нет фоновых процессов. Только файловый I/O.
 *   - Комментарии на русском. Подражаем стилю src/ingest/finance/* и src/scheduler/*.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Разрешение базового каталога состояния
// ---------------------------------------------------------------------------

/**
 * resolveFinanceStateDir — путь к каталогу мутабельного состояния финпроактива.
 *
 * Порядок поиска (аналог resolveFinanceDir в ledger.ts):
 *   1. env.FINANCE_STATE_DIR — явное переопределение для тестов и нестандартных сетапов.
 *   2. env.CONTENT_ROOT + '/.finance-state'
 *   3. ~/llm-wiki-content/.finance-state — дефолт.
 *
 * Каталог НЕ создаётся здесь — только вычисляется путь (создание — в каждой write-функции).
 *
 * @param env — окружение (process.env или мок для тестов)
 * @returns абсолютный путь к .finance-state/
 */
export function resolveFinanceStateDir(env: NodeJS.ProcessEnv = process.env): string {
	if (env.FINANCE_STATE_DIR) return resolve(env.FINANCE_STATE_DIR);
	const contentRoot = env.CONTENT_ROOT ?? join(homedir(), 'llm-wiki-content');
	return resolve(join(contentRoot, '.finance-state'));
}

// ---------------------------------------------------------------------------
// Вспомогательные утилиты
// ---------------------------------------------------------------------------

/**
 * ensureDir — создаёт каталог (и всех родителей) если не существует.
 * Идемпотентно: повторный вызов не бросает.
 */
function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true });
}

/**
 * readJsonFile — читает JSON-файл и возвращает распарсенный объект,
 * или null если файл не существует / не читается / битый JSON.
 *
 * @param filePath — абсолютный путь
 * @returns распарсенный объект или null
 */
function readJsonFile(filePath: string): unknown {
	if (!existsSync(filePath)) return null;
	let raw: string;
	try {
		raw = readFileSync(filePath, 'utf8');
	} catch {
		// Файл исчез между existsSync и readFileSync (edge case) — возвращаем null.
		return null;
	}
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		// Битый JSON (прерванная запись) — безопасно возвращаем null.
		return null;
	}
}

/**
 * writeJsonFile — сериализует объект в JSON и записывает в файл.
 * Создаёт родительские каталоги если нужно.
 *
 * @param filePath — абсолютный путь (будет создан/перезаписан)
 * @param data     — сериализуемый объект
 */
function writeJsonFile(filePath: string, data: unknown): void {
	ensureDir(resolve(filePath, '..'));
	writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// 1. Pending-опрос налички
// ---------------------------------------------------------------------------

/**
 * PendingCashSurvey — маркер активного проактивного опроса налички.
 *
 * Поля:
 *   account  — имя счёта (опц.; если задан, ответ будет привязан к конкретному счёту).
 *   currency — валюта наличных (опц.; если не задан, движок выбирает по контексту).
 *   sinceIso — момент начала опроса (ISO UTC). Нужен для корреляции и тайм-аута опроса.
 */
export interface PendingCashSurvey {
	/** Имя счёта наличных (опц., напр. "Кошелёк RUB"). Без PII. */
	account?: string;
	/** Нативная валюта наличных (опц., напр. "RUB", "VND"). */
	currency?: string;
	/** Момент запуска опроса (ISO 8601 UTC). */
	sinceIso: string;
}

/** Имя файла маркера внутри dir. */
const PENDING_CASH_FILE = 'pending-cash-survey.json';

/**
 * writePendingCashSurvey — записывает (или перезаписывает) маркер активного опроса налички.
 *
 * Вызывается проактивом C1 сразу после отправки вопроса «сколько наличных?».
 * Перезапись идемпотентна: повторный write с теми же данными — безопасно.
 *
 * @param dir    — базовый каталог состояния (инъекция; в проде resolveFinanceStateDir())
 * @param survey — данные маркера: account?, currency?, sinceIso
 */
export function writePendingCashSurvey(dir: string, survey: PendingCashSurvey): void {
	// Гард: sinceIso обязан быть непустой строкой (базовая санитизация).
	if (!survey.sinceIso || typeof survey.sinceIso !== 'string') {
		throw new TypeError('writePendingCashSurvey: sinceIso обязателен (непустая ISO-строка)');
	}
	writeJsonFile(join(dir, PENDING_CASH_FILE), survey);
}

/**
 * readPendingCashSurvey — читает текущий маркер опроса налички или возвращает null.
 *
 * Вызывается реактивным обработчиком C3 при получении числового ответа:
 *   - маркер есть → ответ распознаётся как cash-снапшот с контекстом из маркера
 *   - маркер null → обычная обработка входящего сообщения
 *
 * @param dir — базовый каталог состояния
 * @returns PendingCashSurvey или null
 */
export function readPendingCashSurvey(dir: string): PendingCashSurvey | null {
	const data = readJsonFile(join(dir, PENDING_CASH_FILE));
	if (data === null || typeof data !== 'object') return null;

	// Минимальная валидация структуры (без zod — state-файл, не API-ввод).
	const obj = data as Record<string, unknown>;
	if (typeof obj.sinceIso !== 'string' || !obj.sinceIso) return null;

	return {
		sinceIso: obj.sinceIso,
		...(typeof obj.account === 'string' ? { account: obj.account } : {}),
		...(typeof obj.currency === 'string' ? { currency: obj.currency } : {}),
	};
}

/**
 * clearPendingCashSurvey — удаляет маркер опроса (гасит состояние).
 *
 * Вызывается C3-реактивом после успешной записи cash-снапшота.
 * Идемпотентно: если файл не существует — ничего не происходит.
 *
 * @param dir — базовый каталог состояния
 */
export function clearPendingCashSurvey(dir: string): void {
	// Перезаписываем файл пустым маркером вместо unlink,
	// чтобы не создавать race condition при параллельных чтениях (ADR-0009 single-user,
	// но всё равно безопаснее явного write null-маркера).
	writeJsonFile(join(dir, PENDING_CASH_FILE), null);
}

// ---------------------------------------------------------------------------
// 2. Fired-дедуп проактивных пушей
// ---------------------------------------------------------------------------

/**
 * FiredRegistry — реестр уже отправленных проактивных пушей.
 *
 * Структура: { [key: string]: string } — ключ → момент отправки (ISO).
 *
 * Ключи (примеры):
 *   'credit:<id>:2026-07-01:lead'   — предупреждение за N дней до платежа
 *   'credit:<id>:2026-07-01:due'    — напоминание в день платежа
 *   'goal:<id>:milestone:50'        — достигнут 50%-майлстоун цели
 *   'goal:<id>:milestone:100'       — цель выполнена (100%)
 *
 * ГАРД callback_data ≤ 64 байт: ключи держать компактными.
 */
export type FiredRegistry = Record<string, string>;

/** Имя файла реестра внутри dir. */
const FIRED_REGISTRY_FILE = 'fired-proactive.json';

/**
 * readFiredRegistry — читает весь реестр fired-пушей из файла.
 *
 * @param dir — базовый каталог состояния
 * @returns FiredRegistry (пустой объект если файла нет или он битый)
 */
function readFiredRegistry(dir: string): FiredRegistry {
	const data = readJsonFile(join(dir, FIRED_REGISTRY_FILE));
	if (data === null || typeof data !== 'object' || Array.isArray(data)) return {};

	// Фильтруем: оставляем только ключи с string-значениями (ISO-строки whenIso).
	const registry: FiredRegistry = {};
	for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
		if (typeof v === 'string') {
			registry[k] = v;
		}
	}
	return registry;
}

/**
 * wasFired — проверяет, был ли пуш с данным ключом уже отправлен.
 *
 * @param dir — базовый каталог состояния
 * @param key — ключ вида 'credit:<id>:<dueDate>:<lead|due>' или 'goal:<id>:milestone:<pct>'
 * @returns true если пуш уже зафиксирован
 */
export function wasFired(dir: string, key: string): boolean {
	const registry = readFiredRegistry(dir);
	return Object.prototype.hasOwnProperty.call(registry, key);
}

/**
 * markFired — фиксирует успешную отправку проактивного пуша.
 *
 * Идемпотентно: если key уже присутствует в реестре — существующая запись
 * НЕ перезаписывается (первый пуш — источник истины, повтор не дублирует).
 * Это защищает от гонки: два sweep'а параллельно → только первый пишет whenIso.
 *
 * @param dir     — базовый каталог состояния
 * @param key     — ключ (длина ≤ 64 байт для совместимости с callback_data)
 * @param whenIso — момент отправки пуша (ISO 8601 UTC)
 */
export function markFired(dir: string, key: string, whenIso: string): void {
	// Гард: key и whenIso обязаны быть непустыми строками.
	if (!key || typeof key !== 'string') {
		throw new TypeError('markFired: key обязателен (непустая строка)');
	}
	if (!whenIso || typeof whenIso !== 'string') {
		throw new TypeError('markFired: whenIso обязателен (непустая ISO-строка)');
	}

	const registry = readFiredRegistry(dir);

	// Идемпотентность: если key уже есть — не перезаписываем.
	if (Object.prototype.hasOwnProperty.call(registry, key)) {
		return;
	}

	// Добавляем запись и сохраняем весь реестр.
	registry[key] = whenIso;
	writeJsonFile(join(dir, FIRED_REGISTRY_FILE), registry);
}

/**
 * unmarkFiredByPrefix — удаляет из реестра все ключи, начинающиеся с заданного префикса.
 *
 * Используется механизмом [Отложить] (handleSnooze): чтобы кредит-напоминание
 * перефайрилось при следующем sweep'е, нужно убрать fired-запись для данного кредита.
 * Поскольку handleSnooze не знает dueDate, удаляем все ключи credit:<id>:*.
 *
 * Пример: prefix = 'credit:my-credit-001:' → удаляет
 *   'credit:my-credit-001:2026-07-01:lead'
 *   'credit:my-credit-001:2026-07-01:due'
 *   и любые другие ключи с таким началом.
 *
 * Идемпотентно: если ключей с данным префиксом нет — ничего не происходит.
 *
 * @param dir    — базовый каталог состояния
 * @param prefix — строковый префикс ключей для удаления
 * @returns количество удалённых ключей
 */
export function unmarkFiredByPrefix(dir: string, prefix: string): number {
	// Гард: prefix обязан быть непустой строкой.
	if (!prefix || typeof prefix !== 'string') {
		throw new TypeError('unmarkFiredByPrefix: prefix обязателен (непустая строка)');
	}

	const registry = readFiredRegistry(dir);

	// Находим ключи с данным префиксом.
	const toDelete = Object.keys(registry).filter((k) => k.startsWith(prefix));
	if (toDelete.length === 0) return 0;

	// Удаляем найденные ключи.
	for (const k of toDelete) {
		delete registry[k];
	}

	// Сохраняем обновлённый реестр.
	writeJsonFile(join(dir, FIRED_REGISTRY_FILE), registry);
	return toDelete.length;
}

// ---------------------------------------------------------------------------
// 3. Snooze-стор (отсрочка кредит-напоминания до указанной даты)
// ---------------------------------------------------------------------------

/**
 * SnoozeRegistry — реестр snooze-записей (key → ISO-строка «молчать до»).
 *
 * Ключ вида 'credit:<id>' — id кредита без дедуп-суффикса.
 * Значение — ISO-8601 момент, до которого sweep НЕ должен фаярить этот кредит.
 *
 * Отличие от fired-реестра:
 *   fired  = «уже отправлено в этом окне» (дедуп по окну/дате).
 *   snooze = «явно молчать до конкретного момента» (воля пользователя).
 *
 * Snooze и fired могут работать одновременно: sweep проверяет ОБА.
 * Если snooze истёк — кредит снова доступен (clearSnoozeUntil вызывается
 * при первом срабатывании после istёкшего snooze, или при явном сбросе).
 */
export type SnoozeRegistry = Record<string, string>;

/** Имя файла snooze-реестра внутри dir. */
const SNOOZE_REGISTRY_FILE = 'snooze-until.json';

/**
 * readSnoozeRegistry — читает весь snooze-реестр из файла.
 *
 * @param dir — базовый каталог состояния
 * @returns SnoozeRegistry (пустой объект если файла нет или он битый)
 */
function readSnoozeRegistry(dir: string): SnoozeRegistry {
	const data = readJsonFile(join(dir, SNOOZE_REGISTRY_FILE));
	if (data === null || typeof data !== 'object' || Array.isArray(data)) return {};

	// Фильтруем: оставляем только ключи с string-значениями (ISO-строки untilIso).
	const registry: SnoozeRegistry = {};
	for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
		if (typeof v === 'string') {
			registry[k] = v;
		}
	}
	return registry;
}

/**
 * writeSnoozeUntil — записывает snooze для ключа: «не фаярить до untilIso».
 *
 * Идемпотентно: повторная запись с другим untilIso — ПЕРЕЗАПИСЫВАЕТ значение
 * (пользователь мог нажать [Отложить] несколько раз — последний wins).
 * Это отличает snooze от fired (там первый wins для дедупа).
 *
 * @param dir     — базовый каталог состояния (инъекция)
 * @param key     — ключ snooze, напр. 'credit:<id>'
 * @param untilIso — ISO-8601 UTC момент, до которого молчать
 */
export function writeSnoozeUntil(dir: string, key: string, untilIso: string): void {
	// Гард: key и untilIso обязаны быть непустыми строками.
	if (!key || typeof key !== 'string') {
		throw new TypeError('writeSnoozeUntil: key обязателен (непустая строка)');
	}
	if (!untilIso || typeof untilIso !== 'string') {
		throw new TypeError('writeSnoozeUntil: untilIso обязателен (непустая ISO-строка)');
	}

	const registry = readSnoozeRegistry(dir);
	// Перезаписываем: последний [Отложить] берёт верх.
	registry[key] = untilIso;
	writeJsonFile(join(dir, SNOOZE_REGISTRY_FILE), registry);
}

/**
 * readSnoozeUntil — читает snooze-границу для ключа или возвращает null.
 *
 * Возвращает ISO-строку (untilIso) если snooze задан, или null если записи нет.
 * Вызывающий код сам решает: now < snoozeUntil → молчать; иначе → разрешить.
 *
 * @param dir — базовый каталог состояния
 * @param key — ключ snooze
 * @returns ISO-строка или null
 */
export function readSnoozeUntil(dir: string, key: string): string | null {
	const registry = readSnoozeRegistry(dir);
	const val = registry[key];
	// Проверяем что значение непустая строка.
	return typeof val === 'string' && val ? val : null;
}

/**
 * clearSnoozeUntil — удаляет snooze-запись для ключа.
 *
 * Вызывается sweep'ом при первом успешном фаяринге после истёкшего snooze —
 * чтобы «разбудить» кредит без лишних записей в реестре.
 *
 * Идемпотентно: если ключа нет — ничего не происходит.
 *
 * @param dir — базовый каталог состояния
 * @param key — ключ snooze
 */
export function clearSnoozeUntil(dir: string, key: string): void {
	const registry = readSnoozeRegistry(dir);

	// Если ключа нет — ничего делать.
	if (!Object.prototype.hasOwnProperty.call(registry, key)) return;

	delete registry[key];
	writeJsonFile(join(dir, SNOOZE_REGISTRY_FILE), registry);
}

// ---------------------------------------------------------------------------
// 4. Last-input watermark
// ---------------------------------------------------------------------------

/** Имя файла watermark'а внутри dir. */
const LAST_INPUT_TS_FILE = 'last-input-ts.txt';

/**
 * readLastInputTs — читает момент последнего финансового ввода.
 *
 * Возвращает ISO-строку или null если файл не существует или пустой.
 * Sweep использует это значение для вычисления простоя:
 *   if (now - lastInputTs > IDLE_THRESHOLD) → «обнови данные»
 *
 * @param dir — базовый каталог состояния
 * @returns ISO-строка момента или null
 */
export function readLastInputTs(dir: string): string | null {
	const filePath = join(dir, LAST_INPUT_TS_FILE);
	if (!existsSync(filePath)) return null;

	let raw: string;
	try {
		raw = readFileSync(filePath, 'utf8').trim();
	} catch {
		return null;
	}

	// Минимальная проверка: строка непустая и похожа на ISO (начинается с цифры).
	return raw && /^\d/.test(raw) ? raw : null;
}

/**
 * writeLastInputTs — обновляет watermark момента последнего финансового ввода.
 *
 * Вызывается record.ts (или finance-intent.ts) после каждой успешной записи.
 * Перезапись идемпотентна: новое значение всегда актуальнее.
 *
 * @param dir — базовый каталог состояния
 * @param iso — момент ввода (ISO 8601 UTC, напр. "2026-06-23T12:00:00Z")
 */
export function writeLastInputTs(dir: string, iso: string): void {
	// Гард: iso обязан быть непустой строкой.
	if (!iso || typeof iso !== 'string') {
		throw new TypeError('writeLastInputTs: iso обязателен (непустая ISO-строка)');
	}
	ensureDir(dir);
	writeFileSync(join(dir, LAST_INPUT_TS_FILE), iso + '\n', { encoding: 'utf8' });
}
