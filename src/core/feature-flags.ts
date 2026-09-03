/**
 * feature-flags.ts — явные флаги модулей движка, выключенных по умолчанию.
 *
 * Единственный сейчас: `FINANCE_ENABLED` (US 68, R7 п.7). Финансовых данных нет
 * вовсе, а модуль без данных всё равно платит контекстом за инструкцию в каждом
 * ходе бота ([01-decisions.md] D9) — поэтому default-off, а не default-on с опцией
 * выключить: тихая инструкция про пустой модуль хуже явно отсутствующей.
 *
 * Чистая функция от `env` (не от `process.env` напрямую) — тестируется без моков
 * окружения, тот же приём, что `loadSessionsConfig` (`src/bridge/sessions.ts`).
 */

const TRUTHY = new Set(['1', 'true', 'yes']);

/** FINANCE_ENABLED: включён только явным истинным значением, регистр не важен. */
export function isFinanceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return TRUTHY.has((env.FINANCE_ENABLED ?? '').trim().toLowerCase());
}

/**
 * Колбэки, которыми вызывающий (`main.ts`) отдаёт `applyFinanceGate` фактическое создание
 * леджера и достройку персоны. Оба — I/O и бридж-специфика (запись/чтение `raw/finance/`,
 * системный промпт), которым не место в `core/` — здесь только РЕШЕНИЕ, вызывать их или нет.
 * `createLedger` может вернуть `undefined` (инициализация упала — тот же контракт, что был
 * в `main.ts` до этой правки: нестандартный сетап не должен ронять весь мост).
 */
export interface FinanceGateCallbacks<TLedger> {
	readonly createLedger: () => TLedger | undefined;
	readonly appendInstruction: (ledger: TLedger) => string;
}

/** Итог применения гейта: леджер (или `undefined`) и персона, которую увидит движок. */
export interface FinanceGateResult<TLedger> {
	readonly ledger: TLedger | undefined;
	readonly persona: string;
}

/**
 * applyFinanceGate — единственное место, отвечающее за оба следствия `FINANCE_ENABLED`
 * (US 68, [01-decisions.md] D9, R7 п.8): создавать ли финансовый леджер И добавлять ли
 * финансовую инструкцию к персоне. До этой правки решение было размазано по `main.ts` двумя
 * независимыми проверками (`if (isFinanceEnabled(...))` вокруг создания леджера и отдельный
 * тернарник `financeLedger ? appendFinanceInstruction(...) : basePersona` для персоны) —
 * работоспособные порознь, но ничем не гарантированные оставаться синхронными, и ни один
 * тест их не вызывал (DoD «леджер не создаётся И инструкции нет в промпте» был без
 * доказательства).
 *
 * Чистая функция от `env` (тот же приём, что `loadSessionsConfig`, `src/bridge/sessions.ts`):
 * при выключенном флаге НИ ОДИН колбэк не вызывается вообще — не «создали и проигнорировали»,
 * а по-настоящему не создали. `basePersona` возвращается строкой как есть, без домешивания.
 */
export function applyFinanceGate<TLedger>(
	env: NodeJS.ProcessEnv,
	basePersona: string,
	callbacks: FinanceGateCallbacks<TLedger>,
): FinanceGateResult<TLedger> {
	if (!isFinanceEnabled(env)) {
		return { ledger: undefined, persona: basePersona };
	}
	const ledger = callbacks.createLedger();
	if (!ledger) {
		return { ledger: undefined, persona: basePersona };
	}
	return { ledger, persona: callbacks.appendInstruction(ledger) };
}
