/**
 * main.ts — точка входа моста (порт запуска uvicorn app:app, [ADR-0012]).
 *
 * Загружает .env (dotenv-flow), собирает зависимости из окружения, поднимает
 * воркеры и Fastify, слушает 127.0.0.1:<BRIDGE_PORT> (за ним Cloudflare Tunnel).
 * Корректный shutdown по SIGTERM/SIGINT.
 */
import { join } from 'node:path';

import dotenvFlow from 'dotenv-flow';

dotenvFlow.config({ silent: true });

import { childLogger } from '../core/logger.js';
import { buildApp, BridgeState, startWorkers, stopBridge } from './app.js';
import { loadSettings } from './config.js';
import { buildEngineFromEnv } from './engine.js';
import { runPoller } from './poller.js';
import { loadPersona } from './prompt.js';
import { loadSessionsConfig } from './sessions.js';
import { SessionStore } from './store.js';
import { BotApiTelegramClient } from './telegram.js';

const log = childLogger('bridge.main');

async function main(): Promise<void> {
	const settings = loadSettings();
	const wikiRepo = (process.env.WIKI_REPO_PATH ?? '').trim() || undefined;
	// Персона реактивного моста (ADR-0016): из BRIDGE_PERSONA_FILE или <WIKI_REPO_PATH>/persona.md;
	// нет файла → generic DEFAULT_PERSONA. Контент личный (приватный репо, ADR-0003).
	const personaFile =
		(process.env.BRIDGE_PERSONA_FILE ?? '').trim() ||
		(wikiRepo ? join(wikiRepo, 'persona.md') : undefined);
	// Полоса локальных сессий Claude Code ([ADR-0017]). Конфиг из окружения (реальный
	// allowlist — в приватном .env, [ADR-0003]). Движок продолжения строится под cwd
	// конкретного проекта и БЕЗ персоны вики (опция repoPath, без systemPrompt).
	const sessionsCfg = loadSessionsConfig(process.env);
	const resumeEngineFor = (projectPath: string) =>
		buildEngineFromEnv(process.env, { repoPath: projectPath });

	const state = new BridgeState(
		settings,
		buildEngineFromEnv(process.env, { systemPrompt: loadPersona(personaFile) }),
		new SessionStore(settings.dbPath),
		new BotApiTelegramClient(settings.botToken),
		wikiRepo,
		sessionsCfg,
		resumeEngineFor,
	);
	if (sessionsCfg.enabled) {
		log.info(
			{ root: sessionsCfg.root, allowlist: sessionsCfg.allowlist.length },
			'sessions.enabled',
		);
	}

	// /health поднимаем в обоих режимах (диагностика launchd на 127.0.0.1); webhook-роут
	// — только в webhook-режиме. В polling мост опрашивает Telegram сам ([ADR-0014]).
	const app = buildApp(state, { webhook: settings.mode === 'webhook' });
	startWorkers(state);

	// Прерывание висящего long-poll на shutdown (polling-режим).
	const pollAbort = new AbortController();
	let shuttingDown = false;
	const shutdown = (signal: string): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		log.info({ signal }, 'shutdown initiated');
		pollAbort.abort();
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

	// polling: снять webhook до старта опроса (иначе getUpdates → 409 Conflict).
	if (settings.mode === 'polling') {
		try {
			await state.telegram.deleteWebhook();
			log.info('polling.webhook_deleted');
		} catch (err) {
			log.warn({ err: String(err) }, 'polling.delete_webhook_failed');
		}
	}

	await app.listen({ port: settings.port, host: '127.0.0.1' });
	log.info(
		{ mode: settings.mode, port: settings.port, ownerChatId: settings.ownerChatId },
		'bridge listening',
	);

	// polling: бесконечный long-poll до shutdown (резолвится по pollAbort.abort()).
	if (settings.mode === 'polling') {
		await runPoller(state, pollAbort.signal);
	}
}

main().catch((err) => {
	console.error('fatal startup error:', err);
	process.exit(1);
});
