/**
 * telegram.ts — тонкий клиент Telegram Bot API (порт bridge/telegram.py).
 *
 * Дёргаем Bot API напрямую через встроенный `fetch` (без aiogram): мост в основном
 * делает sendMessage + sendChatAction + getMe. Интерфейс `TelegramClient` — шов
 * портируемости/тестируемости (в тестах подменяем mock'ом). [ADR-0012].
 */
import { childLogger } from '../core/logger.js';

const log = childLogger('bridge.telegram');

// Лимит длины одного сообщения Telegram — 4096 символов.
const TELEGRAM_MAX_MESSAGE_CHARS = 4096;
// Таймаут одного вызова Bot API.
const TELEGRAM_TIMEOUT_MS = 20_000;

export interface TelegramClient {
	sendMessage(chatId: number, text: string, disableNotification?: boolean): Promise<void>;
	sendChatAction(chatId: number, action?: string): Promise<void>;
	getMe(): Promise<Record<string, unknown>>;
	aclose(): Promise<void>;
}

export class BotApiTelegramClient implements TelegramClient {
	private readonly methodBase: string;

	constructor(botToken: string, opts: { apiBase?: string } = {}) {
		if (!botToken) {
			throw new Error('TELEGRAM_BOT_TOKEN пуст — клиент Telegram не сконфигурирован.');
		}
		const apiBase = (opts.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '');
		// Базовый URL метода: .../bot<token>. Сам токен в логи не пишем.
		this.methodBase = `${apiBase}/bot${botToken}`;
	}

	/** Отправить текст в чат, разрезая длинные ответы по 4096 символов. */
	async sendMessage(chatId: number, text: string, disableNotification = false): Promise<void> {
		for (const chunk of chunkText(text, TELEGRAM_MAX_MESSAGE_CHARS)) {
			await this.call('sendMessage', {
				chat_id: chatId,
				text: chunk,
				// Без parse_mode: ответ движка — произвольный текст (Markdown/HTML
				// небезопасны, легко словить 400 на разметке).
				disable_web_page_preview: true,
				disable_notification: disableNotification,
			});
		}
	}

	/** Индикатор «печатает…». Best-effort: ошибку не пробрасываем. */
	async sendChatAction(chatId: number, action = 'typing'): Promise<void> {
		try {
			await this.call('sendChatAction', { chat_id: chatId, action });
		} catch (exc) {
			log.debug({ error: String(exc) }, 'telegram.chat_action_failed');
		}
	}

	/** getMe — health-проверка токена/связи. */
	async getMe(): Promise<Record<string, unknown>> {
		return this.call('getMe', {});
	}

	async aclose(): Promise<void> {
		// fetch использует глобальный пул keep-alive — явного close не требуется.
	}

	/** Низкоуровневый POST к Bot API. Бросает на HTTP-ошибке или ok=false. */
	private async call(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
		const resp = await fetch(`${this.methodBase}/${method}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
		});
		if (!resp.ok) {
			throw new Error(`Telegram ${method} вернул HTTP ${resp.status}`);
		}
		const data = (await resp.json()) as Record<string, unknown>;
		if (!data.ok) {
			const description = (data.description as string) ?? 'unknown Bot API error';
			log.warn({ method, description }, 'telegram.api_not_ok');
			throw new Error(`Telegram ${method} вернул ok=false: ${description}`);
		}
		return (data.result ?? {}) as Record<string, unknown>;
	}
}

/**
 * Порезать текст на части не длиннее `limit`, стараясь рвать по границам строк.
 * Порт `_chunk_text` 1:1.
 */
export function chunkText(text: string, limit: number): string[] {
	if (text.length <= limit) return text ? [text] : [''];

	const chunks: string[] = [];
	let current = '';
	for (let line of text.split('\n')) {
		if (current.length + line.length + 1 > limit) {
			if (current) {
				chunks.push(current);
				current = '';
			}
			// Сама строка длиннее лимита — режем жёстко.
			while (line.length > limit) {
				chunks.push(line.slice(0, limit));
				line = line.slice(limit);
			}
		}
		current = current ? `${current}\n${line}` : line;
	}
	if (current) chunks.push(current);
	return chunks;
}
