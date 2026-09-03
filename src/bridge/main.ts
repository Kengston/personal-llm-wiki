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

import { applyFinanceGate } from '../core/feature-flags.js';
import { childLogger } from '../core/logger.js';
import { createCareerLedger, resolveCareerDir, type CareerLedger } from '../ingest/career/store.js';
import {
	createJobsearchLedger,
	resolveJobsearchDir,
	type JobsearchLedger,
} from '../ingest/jobsearch/ledger.js';
import { createLedger, resolveFinanceDir, type FinanceLedger } from '../ingest/finance/ledger.js';
import { resolveFinanceStateDir } from '../scheduler/finance-state.js';
import { buildApp, BridgeState, startWorkers, stopBridge } from './app.js';
import { loadSettings } from './config.js';
import { buildEngineFromEnv } from './engine.js';
import { buildFinanceContextSummary } from './finance-intent.js';
import { runPoller } from './poller.js';
import {
	appendCareerInstruction,
	appendFinanceInstruction,
	appendJobsearchInstruction,
	loadPersona,
} from './prompt.js';
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

	// financeGoalsDir/financeStateDir заполняются ТОЛЬКО колбэком applyFinanceGate ниже
	// (только когда FINANCE_ENABLED реально включён и леджер создался) — до вызова гейта
	// они не определены, и это корректно: без леджера этим каталогам взяться не из чего.
	let financeGoalsDir: string | undefined;
	// financeStateDir — каталог мутабельного состояния финпроактива (.finance-state/):
	// pending-cash-survey (ответ числом на опрос налички) и last-input watermark
	// (idle-нудж). Без него оба механизма #8 молча пропускаются — поэтому ОБЯЗАТЕЛЬНО
	// пробрасываем его в BridgeState (иначе app.ts получит undefined, как было до фикса).
	let financeStateDir: string | undefined;
	// Каталог состояния проактива общий на подсистемы (ключи разведены префиксом `js:`),
	// и от финансов он не зависит. Резолвится ДО гейта и отдельно от него: пока он брался
	// из финансовой ветки, выключенный FINANCE_ENABLED гасил заодно и проактив поиска
	// работы — механика fired/snooze молча оставалась без каталога. Резолвер чистый,
	// каталог не создаётся до первой записи.
	const proactiveStateDir = resolveFinanceStateDir(process.env);

	// Персона реактивного моста ([ADR-0016]): читаем ДО финансового гейта — applyFinanceGate
	// решает, достраивать её финансовой инструкцией или отдавать как есть.
	const basePersona = loadPersona(personaFile);

	// FINANCE_ENABLED (default-off, US 68, [01-decisions.md] D9, R7 п.8): создавать ли
	// финансовый леджер И добавлять ли финансовую инструкцию к персоне решает
	// `applyFinanceGate` (src/core/feature-flags.ts) — main.ts само условие не пишет,
	// а только отдаёт ему, КАК создать леджер и КАК достроить персону, если флаг включён.
	// При выключенном флаге ни один из колбэков ниже не вызывается вовсе: финансовых
	// данных нет, а модуль без данных всё равно платил бы контекстом за инструкцию в
	// промпте каждого хода бота — поэтому не «создали и проигнорировали», а не создали.
	const financeGate = applyFinanceGate(process.env, basePersona, {
		createLedger: () => {
			try {
				const ledger = createLedger({ env: process.env });
				// goals-каталог: wiki/finance/goals/ в приватном репо (WIKI_REPO_PATH) или CONTENT_ROOT.
				const contentRoot =
					(process.env.CONTENT_ROOT ?? '').trim() || (wikiRepo ? wikiRepo : undefined);
				if (contentRoot) {
					financeGoalsDir = join(contentRoot, 'wiki', 'finance', 'goals');
				}
				// Состояние проактива резолвится из окружения (CONTENT_ROOT/.finance-state по умолчанию).
				financeStateDir = resolveFinanceStateDir(process.env);
				log.info(
					{ financeDir: resolveFinanceDir(process.env), financeGoalsDir, financeStateDir },
					'finance.ledger_ready',
				);
				return ledger;
			} catch (err) {
				// Нестандартный сетап или ошибка резолвинга — мост стартует без финансового шва.
				log.warn({ err: String(err) }, 'finance.ledger_init_failed — finance-intent отключён');
				return undefined;
			}
		},
		// Дефект 2: передаём financeGoalsDir чтобы движок видел goal_id в системном промпте
		// и мог корректно эмитировать query/goal_progress (без этого сваливался в feasibility).
		// Контекст (балансы, net-worth) статичный на старт процесса — приемлемо для
		// single-user single-session моста (ходы сериализованы, следующий старт подтянет свежий).
		appendInstruction: (ledger) =>
			appendFinanceInstruction(basePersona, buildFinanceContextSummary(ledger, financeGoalsDir)),
	});
	const financeLedger: FinanceLedger | undefined = financeGate.ledger;
	if (!financeLedger) {
		log.info('finance.disabled — FINANCE_ENABLED не задан либо инициализация леджера не удалась');
	}

	// Карьерная база ([ADR-0028]): каталог резолвится из окружения (CAREER_RAW_DIR →
	// RAW_DIR/career → CONTENT_ROOT/raw/career). О включении и об ОТКЛЮЧЕНИИ говорим в лог
	// явно: модуль, который молча не работает, неотличим от работающего вхолостую.
	let careerLedger: CareerLedger | undefined;
	try {
		careerLedger = createCareerLedger({ env: process.env });
		log.info({ careerDir: resolveCareerDir(process.env) }, 'career.ledger_ready');
	} catch (err) {
		log.warn({ err: String(err) }, 'career.ledger_init_failed — career-intent ОТКЛЮЧЁН');
		careerLedger = undefined;
	}

	// Воронка откликов ([ADR-0030]): тот же каталог `raw/jobsearch/`, что и у реестра
	// компаний. О включении и об ОТКЛЮЧЕНИИ говорим в лог явно.
	let jobsearchLedger: JobsearchLedger | undefined;
	try {
		jobsearchLedger = createJobsearchLedger({ env: process.env });
		log.info({ jobsearchDir: resolveJobsearchDir(process.env) }, 'jobsearch.ledger_ready');
	} catch (err) {
		log.warn({ err: String(err) }, 'jobsearch.ledger_init_failed — jobsearch-intent ОТКЛЮЧЁН');
		jobsearchLedger = undefined;
	}

	// Карьерный протокол добавляется отдельно: модули независимы, и включённые финансы
	// не должны быть условием работы резюме (и наоборот).
	const withCareer = careerLedger
		? appendCareerInstruction(financeGate.persona)
		: financeGate.persona;
	const systemPrompt = jobsearchLedger ? appendJobsearchInstruction(withCareer) : withCareer;

	const state = new BridgeState({
		settings,
		engine: buildEngineFromEnv(process.env, { systemPrompt }),
		store: new SessionStore(settings.dbPath),
		telegram: new BotApiTelegramClient(settings.botToken),
		wikiRepoPath: wikiRepo,
		sessions: sessionsCfg,
		resumeEngineFor,
		financeLedger,
		financeGoalsDir,
		financeStateDir,
		careerLedger,
		jobsearchLedger,
		jobsearchStateDir: proactiveStateDir,
	});
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
