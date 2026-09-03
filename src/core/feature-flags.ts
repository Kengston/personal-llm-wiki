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
