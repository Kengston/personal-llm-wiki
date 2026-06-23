/**
 * telegram.ts — тонкий клиент Telegram Bot API (порт bridge/telegram.py).
 *
 * Дёргаем Bot API напрямую через встроенный `fetch` (без aiogram): мост делает
 * текст (sendMessage), медиа (sendPhoto/sendDocument — multipart-загрузка локальных
 * файлов), инлайн-клавиатуры (reply_markup) и ответ на нажатие (answerCallbackQuery),
 * плюс служебные getMe/getUpdates/deleteWebhook. Интерфейс `TelegramClient` — шов
 * портируемости/тестируемости (в тестах подменяем mock'ом). [ADR-0012], [ADR-0023].
 *
 * Транспорт-расширение под финансовый модуль ([ADR-0018]/[ADR-0023]): графики
 * (PNG matplotlib) через sendPhoto, экспорт CSV/PDF через sendDocument, кнопочные
 * флоу ([Оплачено]/[Отложить], селекторы периода) через reply_markup +
 * callback_query. Сами фичи — отдельно; здесь только транспорт.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { childLogger } from '../core/logger.js';

const log = childLogger('bridge.telegram');

// Лимит длины одного сообщения Telegram — 4096 символов.
const TELEGRAM_MAX_MESSAGE_CHARS = 4096;
// Лимит подписи к медиа (caption у sendPhoto/sendDocument) — 1024 символа.
const TELEGRAM_MAX_CAPTION_CHARS = 1024;
// Таймаут одного вызова Bot API.
const TELEGRAM_TIMEOUT_MS = 20_000;
// Загрузка файла (PNG-график, CSV/PDF) тяжелее JSON-вызова — даём больший таймаут.
const TELEGRAM_UPLOAD_TIMEOUT_MS = 60_000;

// --------------------------------------------------------------------------- //
// Типы транспорта                                                             //
// --------------------------------------------------------------------------- //

/**
 * Режим разметки текста. По умолчанию НЕ задаём (произвольный текст движка
 * безопасен как plain). Включается ОСОЗНАННО вызывающим, который сам гарантирует
 * валидность разметки (иначе Bot API → 400). [ADR-0023].
 */
export type ParseMode = 'HTML' | 'MarkdownV2' | 'Markdown';

/** Инлайн-кнопка. callback_data ≤ 64 байт; либо url (взаимоисключающи у нас). */
export interface InlineKeyboardButton {
	text: string;
	callback_data?: string;
	url?: string;
}

/** Инлайн-клавиатура (сетка кнопок). Пока поддерживаем только её. */
export interface InlineKeyboardMarkup {
	inline_keyboard: InlineKeyboardButton[][];
}

/** reply_markup: на сейчас — только инлайн-клавиатура (слот под reply-keyboard позже). */
export type ReplyMarkup = InlineKeyboardMarkup;

/**
 * Файл на отправку (sendPhoto/sendDocument): ЛИБО локальный `path` (PNG-график,
 * экспорт CSV/PDF), ЛИБО содержимое в памяти `data`. Имя/MIME выводятся, если не
 * заданы. URL/file_id намеренно НЕ поддерживаем — наш кейс это локальная загрузка.
 */
export interface InputFile {
	/** Путь к локальному файлу. */
	path?: string;
	/** Либо байты в памяти (если на диск не писали). */
	data?: Buffer | Uint8Array;
	/** Имя файла для Telegram (дефолт — basename(path) или 'file'). */
	filename?: string;
	/** MIME (дефолт — по расширению имени). */
	contentType?: string;
}

/** Опции текстового сообщения. parse_mode опционален и по умолчанию выключен. */
export interface SendMessageOptions {
	disableNotification?: boolean;
	parseMode?: ParseMode;
	replyMarkup?: ReplyMarkup;
}

/** Опции медиа (фото/документ): подпись + те же разметка/клавиатура/тишина. */
export interface SendMediaOptions {
	caption?: string;
	parseMode?: ParseMode;
	replyMarkup?: ReplyMarkup;
	disableNotification?: boolean;
}

/** Опции ответа на callback_query (всплывашка/тост над кнопкой). */
export interface AnswerCallbackOptions {
	text?: string;
	showAlert?: boolean;
}

export interface TelegramClient {
	/** Отправить текст. opts.parseMode по умолчанию выключен (plain-text безопасен). */
	sendMessage(chatId: number, text: string, opts?: SendMessageOptions): Promise<void>;
	/** Отправить фото (multipart-загрузка локального/in-memory файла). [ADR-0023]. */
	sendPhoto(chatId: number, photo: InputFile, opts?: SendMediaOptions): Promise<void>;
	/** Отправить документ (CSV/PDF и пр., multipart-загрузка). [ADR-0023]. */
	sendDocument(chatId: number, document: InputFile, opts?: SendMediaOptions): Promise<void>;
	/** Погасить «часики» на инлайн-кнопке (best-effort). [ADR-0023]. */
	answerCallbackQuery(callbackQueryId: string, opts?: AnswerCallbackOptions): Promise<void>;
	sendChatAction(chatId: number, action?: string): Promise<void>;
	getMe(): Promise<Record<string, unknown>>;
	/** Long-poll за апдейтами (polling-режим, [ADR-0014]); массив update-объектов. */
	getUpdates(
		offset: number,
		timeoutSec: number,
		allowedUpdates?: string[],
		signal?: AbortSignal,
	): Promise<Array<Record<string, unknown>>>;
	/** Снять webhook — обязательно перед polling (иначе getUpdates → 409). */
	deleteWebhook(dropPendingUpdates?: boolean): Promise<void>;
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

	/**
	 * Отправить текст в чат, разрезая длинные ответы по 4096 символов.
	 *
	 * parse_mode по умолчанию НЕ задаётся: ответ движка — произвольный текст, а
	 * Markdown/HTML легко словят 400 на случайной разметке. Включается ОСОЗНАННО
	 * (opts.parseMode) вызывающим, который сам форматирует валидно ([ADR-0023]);
	 * учти, что при разбиении длинного размеченного текста по строкам entity может
	 * порваться на границе чанка — для parse_mode держи сообщение в пределах лимита.
	 *
	 * reply_markup (инлайн-клавиатура) вешается ТОЛЬКО на последний чанк, чтобы
	 * кнопки были под полным сообщением, а не дублировались на каждом куске.
	 */
	async sendMessage(chatId: number, text: string, opts: SendMessageOptions = {}): Promise<void> {
		const chunks = chunkText(text, TELEGRAM_MAX_MESSAGE_CHARS);
		for (let i = 0; i < chunks.length; i++) {
			const isLast = i === chunks.length - 1;
			await this.call('sendMessage', {
				chat_id: chatId,
				text: chunks[i],
				disable_web_page_preview: true,
				disable_notification: opts.disableNotification ?? false,
				...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
				// reply_markup в JSON-режиме уходит вложенным объектом (Bot API так и ждёт).
				...(isLast && opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
			});
		}
	}

	/**
	 * Отправить фото — multipart-загрузка локального/in-memory файла (PNG-график
	 * matplotlib). Подпись режется до лимита caption. [ADR-0023].
	 */
	async sendPhoto(chatId: number, photo: InputFile, opts: SendMediaOptions = {}): Promise<void> {
		await this.sendMedia('sendPhoto', 'photo', chatId, photo, opts);
	}

	/**
	 * Отправить документ — multipart-загрузка (экспорт CSV/PDF и пр.). [ADR-0023].
	 */
	async sendDocument(
		chatId: number,
		document: InputFile,
		opts: SendMediaOptions = {},
	): Promise<void> {
		await this.sendMedia('sendDocument', 'document', chatId, document, opts);
	}

	/** Общая multipart-отправка медиа: собрать поля + файл, дернуть Bot API. */
	private async sendMedia(
		method: 'sendPhoto' | 'sendDocument',
		fileField: 'photo' | 'document',
		chatId: number,
		file: InputFile,
		opts: SendMediaOptions,
	): Promise<void> {
		const resolved = await resolveInputFile(file);
		const fields: Record<string, string> = {
			chat_id: String(chatId),
			disable_notification: String(opts.disableNotification ?? false),
		};
		if (opts.caption) fields.caption = opts.caption.slice(0, TELEGRAM_MAX_CAPTION_CHARS);
		if (opts.parseMode) fields.parse_mode = opts.parseMode;
		// В multipart reply_markup уходит СТРОКОЙ (JSON), в отличие от JSON-режима sendMessage.
		if (opts.replyMarkup) fields.reply_markup = JSON.stringify(opts.replyMarkup);
		await this.callMultipart(method, fields, fileField, resolved, {
			timeoutMs: TELEGRAM_UPLOAD_TIMEOUT_MS,
		});
	}

	/**
	 * Ответить на callback_query — гасит «часики» на инлайн-кнопке. Best-effort:
	 * ошибку не пробрасываем (callback живёт ~минуту, индикатор сам погаснет). [ADR-0023].
	 */
	async answerCallbackQuery(
		callbackQueryId: string,
		opts: AnswerCallbackOptions = {},
	): Promise<void> {
		try {
			await this.call('answerCallbackQuery', {
				callback_query_id: callbackQueryId,
				...(opts.text ? { text: opts.text } : {}),
				...(opts.showAlert ? { show_alert: true } : {}),
			});
		} catch (exc) {
			log.debug({ error: String(exc) }, 'telegram.answer_callback_failed');
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

	/**
	 * Long-poll getUpdates ([ADR-0014], polling-режим). Свой увеличенный таймаут
	 * (timeoutSec + запас), т.к. общий TELEGRAM_TIMEOUT_MS короче long-poll и оборвал
	 * бы запрос раньше ответа. Внешний signal обрывает висящий poll на shutdown.
	 */
	async getUpdates(
		offset: number,
		timeoutSec: number,
		// callback_query — нажатия инлайн-кнопок ([ADR-0023]); без него апдейты кнопок
		// сервер не отдаёт. allowed_updates — явный allow-list ТИПОВ апдейтов.
		allowedUpdates: string[] = ['message', 'callback_query'],
		signal?: AbortSignal,
	): Promise<Array<Record<string, unknown>>> {
		const result: unknown = await this.call(
			'getUpdates',
			{ offset, timeout: timeoutSec, allowed_updates: allowedUpdates },
			{ timeoutMs: timeoutSec * 1000 + 15_000, signal },
		);
		return Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
	}

	/** Снять webhook — обязательно перед polling (webhook и getUpdates взаимоисключающи, иначе 409). */
	async deleteWebhook(dropPendingUpdates = false): Promise<void> {
		await this.call('deleteWebhook', { drop_pending_updates: dropPendingUpdates });
	}

	async aclose(): Promise<void> {
		// fetch использует глобальный пул keep-alive — явного close не требуется.
	}

	/** Низкоуровневый JSON-POST к Bot API. Бросает на HTTP-ошибке или ok=false. */
	private async call(
		method: string,
		payload: Record<string, unknown>,
		opts: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<Record<string, unknown>> {
		const resp = await fetch(`${this.methodBase}/${method}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
			signal: this.buildSignal(opts),
		});
		return this.handleResponse(method, resp);
	}

	/**
	 * Низкоуровневый multipart-POST (загрузка файла). Content-Type/boundary ставит
	 * сам fetch по FormData — заголовок руками НЕ задаём. Используется sendPhoto/
	 * sendDocument: байты файла + строковые поля (chat_id/caption/reply_markup). [ADR-0023].
	 */
	private async callMultipart(
		method: string,
		fields: Record<string, string>,
		fileField: string,
		file: ResolvedFile,
		opts: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<Record<string, unknown>> {
		const form = new FormData();
		for (const [key, value] of Object.entries(fields)) form.set(key, value);
		form.set(fileField, new Blob([file.bytes], { type: file.contentType }), file.filename);
		const resp = await fetch(`${this.methodBase}/${method}`, {
			method: 'POST',
			body: form,
			signal: this.buildSignal(opts),
		});
		return this.handleResponse(method, resp);
	}

	/**
	 * Свой таймаут на вызов (long-poll/загрузка просят больше TELEGRAM_TIMEOUT_MS) +
	 * внешний AbortSignal (быстрый shutdown обрывает висящий long-poll).
	 */
	private buildSignal(opts: { timeoutMs?: number; signal?: AbortSignal }): AbortSignal {
		const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? TELEGRAM_TIMEOUT_MS);
		return opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;
	}

	/** Общая проверка ответа Bot API: HTTP-ошибка или ok=false → throw; иначе result. */
	private async handleResponse(
		method: string,
		resp: Response,
	): Promise<Record<string, unknown>> {
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

// --------------------------------------------------------------------------- //
// Подготовка файла к multipart-загрузке                                       //
// --------------------------------------------------------------------------- //

/** Готовый к отправке файл: байты + имя + MIME. */
interface ResolvedFile {
	bytes: Uint8Array;
	filename: string;
	contentType: string;
}

/** Расширение → MIME для типичных вложений (PNG-график, экспорт CSV/PDF). */
function guessContentType(filename: string): string {
	const ext = filename.toLowerCase().split('.').pop() ?? '';
	switch (ext) {
		case 'png':
			return 'image/png';
		case 'jpg':
		case 'jpeg':
			return 'image/jpeg';
		case 'csv':
			return 'text/csv';
		case 'pdf':
			return 'application/pdf';
		case 'json':
			return 'application/json';
		case 'txt':
			return 'text/plain';
		default:
			return 'application/octet-stream';
	}
}

/**
 * Привести InputFile к байтам+имени+MIME. Читает локальный `path` ИЛИ берёт `data`
 * из памяти; имя — из filename/basename, MIME — из contentType/расширения. Путь —
 * наш (генератор графика/экспорта), не пользовательский ввод (path-traversal не
 * наша поверхность). Бросает, если нет ни path, ни data.
 */
async function resolveInputFile(file: InputFile): Promise<ResolvedFile> {
	if (file.data) {
		const filename = file.filename ?? 'file';
		return {
			bytes: file.data instanceof Uint8Array ? file.data : Buffer.from(file.data),
			filename,
			contentType: file.contentType ?? guessContentType(filename),
		};
	}
	if (file.path) {
		const bytes = await readFile(file.path);
		const filename = file.filename ?? basename(file.path);
		return { bytes, filename, contentType: file.contentType ?? guessContentType(filename) };
	}
	throw new Error('InputFile: нужен либо path, либо data.');
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
