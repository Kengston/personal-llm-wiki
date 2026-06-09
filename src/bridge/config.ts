/**
 * config.ts — конфигурация моста из окружения (.env через dotenv-flow).
 *
 * Порт `Settings.from_env` из bridge/app.py ([ADR-0012]). Валидация — zod (house
 * style abcage-mcp-hub): обязательные Telegram-секреты, числовые BRIDGE_*. Движок
 * читает свои переменные отдельно (buildEngineFromEnv в engine.ts).
 */
import { z } from 'zod';

const SettingsSchema = z
	.object({
		// Обязательные — без них мост не имеет смысла.
		TELEGRAM_BOT_TOKEN: z.string().min(1),
		TELEGRAM_OWNER_CHAT_ID: z.coerce.number().int(),
		// Транспорт ([ADR-0014]): polling (дефолт — $0, ноль inbound) | webhook.
		BRIDGE_MODE: z.enum(['webhook', 'polling']).default('polling'),
		// Секрет вебхука обязателен ТОЛЬКО в webhook-режиме (см. superRefine ниже);
		// в polling неприменим (нет входящего HTTP) → опционален.
		TELEGRAM_WEBHOOK_SECRET: z.string().min(1).optional(),
		// Таймаут long-poll getUpdates, сек (Telegram держит соединение до ответа/таймаута; max 50).
		TELEGRAM_POLL_TIMEOUT_SEC: z.coerce.number().int().positive().max(50).default(50),
		// Опциональные с дефолтами (как в Python).
		BRIDGE_DB_PATH: z.string().default('chat_sessions.sqlite'),
		BRIDGE_QUEUE_SIZE: z.coerce.number().int().positive().default(100),
		BRIDGE_WORKERS: z.coerce.number().int().positive().default(1),
		BRIDGE_PORT: z.coerce.number().int().positive().default(8080),
	})
	.superRefine((e, ctx) => {
		// secret-token заголовок + nonce пути нужны только при входящем вебхуке.
		if (e.BRIDGE_MODE === 'webhook' && !e.TELEGRAM_WEBHOOK_SECRET) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['TELEGRAM_WEBHOOK_SECRET'],
				message: 'обязателен при BRIDGE_MODE=webhook',
			});
		}
	});

export interface Settings {
	botToken: string; // TELEGRAM_BOT_TOKEN — токен Bot API (исходящие)
	ownerChatId: number; // TELEGRAM_OWNER_CHAT_ID — единственный разрешённый чат
	mode: 'webhook' | 'polling'; // BRIDGE_MODE — транспорт ([ADR-0014]); polling по умолчанию
	webhookSecret: string; // TELEGRAM_WEBHOOK_SECRET — secret-token header + nonce пути; '' в polling
	pollTimeoutSec: number; // TELEGRAM_POLL_TIMEOUT_SEC — таймаут long-poll getUpdates
	dbPath: string; // путь к SQLite chat_sessions
	maxQueue: number; // размер буфера очереди
	workers: number; // число воркеров
	port: number; // порт HTTP (/health; в webhook-режиме — за ним Cloudflare Tunnel)
}

/**
 * Собирает Settings из окружения; падает явно с подсказкой, если обязательное
 * не задано (как RuntimeError в Python).
 */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
	const parsed = SettingsSchema.safeParse(env);
	if (!parsed.success) {
		const issues = parsed.error.issues
			.map((i) => `  - ${i.path.join('.')}: ${i.message}`)
			.join('\n');
		throw new Error(
			`Некорректная конфигурация моста:\n${issues}\n` +
				'Скопируй .env.example → .env и заполни (см. setup/SETUP.md).',
		);
	}
	const e = parsed.data;
	return {
		botToken: e.TELEGRAM_BOT_TOKEN,
		ownerChatId: e.TELEGRAM_OWNER_CHAT_ID,
		mode: e.BRIDGE_MODE,
		webhookSecret: e.TELEGRAM_WEBHOOK_SECRET ?? '',
		pollTimeoutSec: e.TELEGRAM_POLL_TIMEOUT_SEC,
		dbPath: e.BRIDGE_DB_PATH,
		maxQueue: e.BRIDGE_QUEUE_SIZE,
		workers: e.BRIDGE_WORKERS,
		port: e.BRIDGE_PORT,
	};
}
