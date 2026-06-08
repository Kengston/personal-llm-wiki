/**
 * runner.ts — общий шов плановых routine'ов: спавн движка + last-mile guard + push.
 *
 * Порт `_load_engine`/`_load_telegram`/`assert_no_secrets` из digest.py ([ADR-0012]).
 * Движок — ОДИН шов на всю систему ([ADR-0008]): и реактивный мост, и плановые
 * routine'ы зовут официальный `claude -p` через абстракцию `Engine` (дефолт
 * `ClaudeEngine`). Здесь — синхронная обвязка для launchd/routine-скриптов.
 *
 * Движок side-effect-free: единственный исходящий канал — узкий owner-only push в
 * Telegram, который делает ЭТОТ код ПОСЛЕ выхода движка (минимизация blast-radius
 * для lethal-trifecta — [ADR-0007] §risks).
 */
import { buildEngineFromEnv, type EngineResult } from '../bridge/engine.js';
import { BotApiTelegramClient } from '../bridge/telegram.js';
import { scanSecrets } from '../ingest/sanitizer.js';

/** Движок не сконфигурирован (нет WIKI_REPO_PATH и т.п.) — sweep вернёт exit 2. */
export class EngineUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'EngineUnavailableError';
	}
}

/** Спавн движка stateless (session_id=null) с готовым промптом (плановое — без resume). */
export async function spawnEngine(prompt: string, env: NodeJS.ProcessEnv = process.env): Promise<EngineResult> {
	let engine;
	try {
		engine = buildEngineFromEnv(env);
	} catch (exc) {
		throw new EngineUnavailableError(String(exc));
	}
	return engine.run(prompt, null); // может бросить EngineError (engine-failed)
}

/**
 * Fail-closed last-mile guard: если в исходящем тексте детектится секрет — НЕ
 * отправляем (throw). Путь к владельцу приватный (личные данные допустимы), но
 * токен/ключ — почти наверняка случайная утечка, его нельзя слать даже в личный чат.
 */
export function assertNoSecrets(text: string): void {
	const offenders = scanSecrets(text);
	if (offenders.length > 0) {
		throw new Error(
			`digest заблокирован: scan_secrets нашёл ${offenders.length} потенциальных ` +
				'секрет(ов) в исходящем тексте — отправка отменена.',
		);
	}
}

/** Owner-only push в Telegram (единственный исходящий канал проактива). */
export async function pushToOwner(
	text: string,
	opts: { disableNotification?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
	const env = opts.env ?? process.env;
	// Fail-closed на мисконфиге: без guard'а Number(undefined)=NaN ушёл бы в Bot API
	// как chat_id=null (непрозрачный 400) вместо понятной ошибки ([аудит TS-порта]).
	const ownerChatId = Number((env.TELEGRAM_OWNER_CHAT_ID ?? '').trim());
	if (!Number.isInteger(ownerChatId)) {
		throw new Error('TELEGRAM_OWNER_CHAT_ID не задан или не число — push владельцу невозможен.');
	}
	const client = new BotApiTelegramClient((env.TELEGRAM_BOT_TOKEN ?? '').trim());
	await client.sendMessage(ownerChatId, text, opts.disableNotification ?? false);
}
