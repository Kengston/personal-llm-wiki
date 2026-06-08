/**
 * logger.ts — единый pino-логгер (house style abcage-mcp-hub).
 *
 * LOG_JSON=1 (дефолт) → структурированный JSON (launchd/агрегаторы перехватывают
 * stdout). LOG_JSON=0 → человекочитаемый pino-pretty для dev. Заменяет structlog
 * из Python-версии ([ADR-0012]). Использование: `log.info({ key }, 'event')`.
 */
import pino from 'pino';

const logJson = (process.env.LOG_JSON ?? '1') === '1';
const level = process.env.LOG_LEVEL ?? 'info';

export const logger = pino(
	logJson
		? { level, base: { service: 'second-brain' } }
		: {
				level,
				base: { service: 'second-brain' },
				transport: {
					target: 'pino-pretty',
					options: { colorize: true, translateTime: 'HH:MM:ss.l' },
				},
			},
);

/** Дочерний логгер с именем модуля (аналог structlog.get_logger("bridge.app")). */
export function childLogger(mod: string): pino.Logger {
	return logger.child({ mod });
}
