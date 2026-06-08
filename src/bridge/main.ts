/**
 * main.ts — точка входа моста (порт запуска uvicorn app:app, [ADR-0012]).
 *
 * Загружает .env (dotenv-flow), собирает зависимости из окружения, поднимает
 * воркеры и Fastify, слушает 127.0.0.1:<BRIDGE_PORT> (за ним Cloudflare Tunnel).
 * Корректный shutdown по SIGTERM/SIGINT.
 */
import dotenvFlow from 'dotenv-flow';

dotenvFlow.config({ silent: true });

import { childLogger } from '../core/logger.js';
import { buildApp, BridgeState, startWorkers, stopBridge } from './app.js';
import { loadSettings } from './config.js';
import { buildEngineFromEnv } from './engine.js';
import { SessionStore } from './store.js';
import { BotApiTelegramClient } from './telegram.js';

const log = childLogger('bridge.main');

async function main(): Promise<void> {
	const settings = loadSettings();
	const state = new BridgeState(
		settings,
		buildEngineFromEnv(),
		new SessionStore(settings.dbPath),
		new BotApiTelegramClient(settings.botToken),
	);

	const app = buildApp(state);
	startWorkers(state);

	let shuttingDown = false;
	const shutdown = (signal: string): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		log.info({ signal }, 'shutdown initiated');
		void (async () => {
			try {
				await app.close();
				await stopBridge(state);
				process.exit(0);
			} catch (err) {
				log.error({ err: String(err) }, 'error during shutdown');
				process.exit(1);
			}
		})();
	};
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));

	await app.listen({ port: settings.port, host: '127.0.0.1' });
	log.info({ port: settings.port, ownerChatId: settings.ownerChatId }, 'bridge listening');
}

main().catch((err) => {
	console.error('fatal startup error:', err);
	process.exit(1);
});
