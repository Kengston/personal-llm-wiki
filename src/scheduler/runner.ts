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
import { BotApiTelegramClient, type InputFile } from '../bridge/telegram.js';
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

/**
 * Резолв owner chat_id из env (fail-closed на мисконфиге: без guard'а
 * Number(undefined)=NaN ушёл бы в Bot API как chat_id=null — непрозрачный 400
 * вместо понятной ошибки [аудит TS-порта]).
 */
function resolveOwnerChatId(env: NodeJS.ProcessEnv): number {
	const ownerChatId = Number((env.TELEGRAM_OWNER_CHAT_ID ?? '').trim());
	if (!Number.isInteger(ownerChatId)) {
		throw new Error('TELEGRAM_OWNER_CHAT_ID не задан или не число — push владельцу невозможен.');
	}
	return ownerChatId;
}

/** Owner-only push в Telegram (единственный исходящий канал проактива). */
export async function pushToOwner(
	text: string,
	opts: {
		disableNotification?: boolean;
		env?: NodeJS.ProcessEnv;
		/**
		 * replyMarkup — инлайн-клавиатура для сообщения (ADR-0023).
		 * Передаётся в sendMessage.replyMarkup без изменений.
		 * Используется кредит-напоминаниями (#7): [Оплачено]/[Отложить]/[Подробнее].
		 */
		replyMarkup?: import('../bridge/telegram.js').ReplyMarkup;
	} = {},
): Promise<void> {
	const env = opts.env ?? process.env;
	const ownerChatId = resolveOwnerChatId(env);
	const client = new BotApiTelegramClient((env.TELEGRAM_BOT_TOKEN ?? '').trim());
	await client.sendMessage(ownerChatId, text, {
		disableNotification: opts.disableNotification ?? false,
		...(opts.replyMarkup !== undefined ? { replyMarkup: opts.replyMarkup } : {}),
	});
}

/**
 * Owner-only проактивный push КАРТИНКИ (PNG-график matplotlib и т.п., [ADR-0023]).
 *
 * Last-mile guard ([ADR-0007] §risks) применяем к ТЕКСТОВЫМ полям — `caption` и
 * `filename` (они видимы/проверяемы как текст). Бинарь файла НЕ сканируем:
 *  - финансовый контент владельцу — это сам продукт ([ADR-0018]); приватность —
 *    про ПУБЛИЧНЫЙ репо, а не про личный owner-only канал (он и есть граница
 *    blast-radius для lethal-trifecta);
 *  - scanSecrets по байтам PNG бессмысленен, а по CSV с финданными даёт массовые
 *    ложняки (IBAN/суммы — легитимное содержимое).
 */
export async function pushPhotoToOwner(
	photo: InputFile,
	opts: { caption?: string; disableNotification?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
	const env = opts.env ?? process.env;
	const ownerChatId = resolveOwnerChatId(env);
	// Сканируем ПОЛНЫЙ caption (sendPhoto потом режет его до 1024 — обрезка
	// косметическая, scan ⊇ отправленного, утечки на границе обрезки нет).
	if (opts.caption) assertNoSecrets(opts.caption);
	if (photo.filename) assertNoSecrets(photo.filename);
	const client = new BotApiTelegramClient((env.TELEGRAM_BOT_TOKEN ?? '').trim());
	await client.sendPhoto(ownerChatId, photo, {
		caption: opts.caption,
		disableNotification: opts.disableNotification ?? false,
	});
}
