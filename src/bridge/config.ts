/**
 * config.ts — конфигурация моста из окружения (.env через dotenv-flow).
 *
 * Порт `Settings.from_env` из bridge/app.py ([ADR-0012]). Валидация — zod (house
 * style abcage-mcp-hub): обязательные Telegram-секреты, числовые BRIDGE_*. Движок
 * читает свои переменные отдельно (buildEngineFromEnv в engine.ts).
 */
import { z } from 'zod';

const SettingsSchema = z.object({
	// Обязательные — без них мост не имеет смысла.
	TELEGRAM_BOT_TOKEN: z.string().min(1),
	TELEGRAM_OWNER_CHAT_ID: z.coerce.number().int(),
	TELEGRAM_WEBHOOK_SECRET: z.string().min(1),
	// Опциональные с дефолтами (как в Python).
	BRIDGE_DB_PATH: z.string().default('chat_sessions.sqlite'),
	BRIDGE_QUEUE_SIZE: z.coerce.number().int().positive().default(100),
	BRIDGE_WORKERS: z.coerce.number().int().positive().default(1),
	BRIDGE_PORT: z.coerce.number().int().positive().default(8080),
});

export interface Settings {
	botToken: string; // TELEGRAM_BOT_TOKEN — токен Bot API (исходящие)
	ownerChatId: number; // TELEGRAM_OWNER_CHAT_ID — единственный разрешённый чат
	webhookSecret: string; // TELEGRAM_WEBHOOK_SECRET — secret-token header + nonce пути
	dbPath: string; // путь к SQLite chat_sessions
	maxQueue: number; // размер буфера очереди
	workers: number; // число воркеров
	port: number; // порт HTTP (за ним Cloudflare Tunnel)
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
		webhookSecret: e.TELEGRAM_WEBHOOK_SECRET,
		dbPath: e.BRIDGE_DB_PATH,
		maxQueue: e.BRIDGE_QUEUE_SIZE,
		workers: e.BRIDGE_WORKERS,
		port: e.BRIDGE_PORT,
	};
}
