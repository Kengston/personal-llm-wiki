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
import { Ledger, resolveFinanceDir } from '../ingest/finance/ledger.js';
import { resolveFinanceStateDir } from '../scheduler/finance-state.js';
import { buildApp, BridgeState, startWorkers, stopBridge } from './app.js';
import { loadSettings } from './config.js';
import { buildEngineFromEnv } from './engine.js';
import { buildFinanceContextSummary } from './finance-intent.js';
import { runPoller } from './poller.js';
import { appendFinanceInstruction, loadPersona } from './prompt.js';
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

	// Финансовый леджер (ADR-0024): создаём из окружения если задан FINANCE_RAW_DIR,
	// RAW_DIR или CONTENT_ROOT (resolveFinanceDir). Если переменных нет — используем
	// дефолтный ~/llm-wiki-content/raw/finance (Ledger создаётся, но каталог не трогается
	// до первой записи). Опционально: при ошибке инициализации (неправильные пути) мост
	// стартует без финансового шва (financeLedger = undefined → блок в app.ts не активен).
	let financeLedger: Ledger | undefined;
	let financeGoalsDir: string | undefined;
	// financeStateDir — каталог мутабельного состояния финпроактива (.finance-state/):
	// pending-cash-survey (ответ числом на опрос налички) и last-input watermark
	// (idle-нудж). Без него оба механизма #8 молча пропускаются — поэтому ОБЯЗАТЕЛЬНО
	// пробрасываем его в BridgeState (иначе app.ts получит undefined, как было до фикса).
	let financeStateDir: string | undefined;
	try {
		financeLedger = new Ledger({ env: process.env });
		// goals-каталог: wiki/finance/goals/ в приватном репо (WIKI_REPO_PATH) или CONTENT_ROOT.
		const contentRoot =
			(process.env.CONTENT_ROOT ?? '').trim() ||
			(wikiRepo ? wikiRepo : undefined);
		if (contentRoot) {
			financeGoalsDir = join(contentRoot, 'wiki', 'finance', 'goals');
		}
		// Состояние проактива резолвится из окружения (CONTENT_ROOT/.finance-state по умолчанию).
		financeStateDir = resolveFinanceStateDir(process.env);
		log.info(
			{ financeDir: resolveFinanceDir(process.env), financeGoalsDir, financeStateDir },
			'finance.ledger_ready',
		);
	} catch (err) {
		// Нестандартный сетап или ошибка резолвинга — мост стартует без финансового шва.
		log.warn({ err: String(err) }, 'finance.ledger_init_failed — finance-intent отключён');
		financeLedger = undefined;
	}

	// Персона с финансовой инструкцией (ADR-0024): если леджер доступен — добавляем
	// finance-intent протокол и снапшот финансового контекста (балансы, net-worth)
	// на момент старта. Контекст статичный на старт процесса — приемлемо для single-user
	// single-session моста (ходы сериализованы, следующий старт подтянет свежий контекст).
	const basePersona = loadPersona(personaFile);
	// Дефект 2: передаём financeGoalsDir чтобы движок видел goal_id в системном промпте
	// и мог корректно эмитировать query/goal_progress (без этого сваливался в feasibility).
	const financeContext = financeLedger
		? buildFinanceContextSummary(financeLedger, financeGoalsDir)
		: null;
	const systemPrompt = financeLedger
		? appendFinanceInstruction(basePersona, financeContext)
		: basePersona;

	const state = new BridgeState(
		settings,
		buildEngineFromEnv(process.env, { systemPrompt }),
		new SessionStore(settings.dbPath),
		new BotApiTelegramClient(settings.botToken),
		wikiRepo,
		sessionsCfg,
		resumeEngineFor,
		financeLedger,
		financeGoalsDir,
		financeStateDir,
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
