/**
 * finance-callbacks.ts — диспетчер кнопочных флоу кредит-напоминаний.
 *
 * Контекст ([ADR-0018] финмодуль, [ADR-0023] транспорт, [ADR-0024] реактивный dispatch,
 * [ADR-0009] single-user, [ADR-0007] owner-only blast-radius):
 *
 *   Кредитное напоминание приходит владельцу с тремя инлайн-кнопками:
 *     [Оплачено]     — recordCreditPayment + детерминированный readback.
 *     [Отложить]     — oneoff-напоминание на завтра (finance-state).
 *     [Подробнее]    — текст/график деталей (renderChartPng, опц.).
 *
 *   dispatchFinanceCallback — основная точка входа: разбирает callback_data,
 *   проверяет owner-гейт, гасит «часики» (answerCallbackQuery), вызывает нужный хендлер.
 *
 * Формат callback_data (≤ 64 байт, UTF-8):
 *   fin:paid:<credit_id>      — [Оплачено]
 *   fin:snooze:<credit_id>    — [Отложить на 1 день]
 *   fin:detail:<credit_id>    — [Подробнее]
 *
 * Инварианты:
 *   - owner-only: from.id в callback_query ОБЯЗАН == ownerChatId.
 *   - answerCallbackQuery вызывается ВСЕГДА (best-effort гашение «часиков»).
 *   - Запись — ТОЛЬКО через recordCreditPayment (не напрямую в Ledger).
 *   - Нет сети, нет spawn; рендер PNG — локальная либа (renderChartPng).
 *   - Подробные комментарии на русском, в стиле src/bridge/*.
 */

import { DateTime } from 'luxon';
import { childLogger } from '../core/logger.js';
import { chartSpec } from '../ingest/finance/chart.js';
import { recordCreditPayment, type CreditPaymentResult } from '../ingest/finance/credit-payment.js';
import { projectPayoffDate } from '../ingest/finance/credit.js';
import { Ledger } from '../ingest/finance/ledger.js';
import {
	resolveFinanceStateDir,
	unmarkFiredByPrefix,
	writeSnoozeUntil,
} from '../scheduler/finance-state.js';
import { renderChartPng } from './finance-render.js';
import type { TelegramClient, InlineKeyboardMarkup, InlineKeyboardButton } from './telegram.js';

const log = childLogger('bridge.finance-callbacks');

// ---------------------------------------------------------------------------
// Константы кнопок и префиксов callback_data
// ---------------------------------------------------------------------------

/**
 * CALLBACK_PREFIX — префикс всех финансовых callback'ов. Позволяет app.ts
 * быстро фильтровать: startsWith(CALLBACK_PREFIX) → dispatchFinanceCallback.
 */
export const CALLBACK_PREFIX = 'fin:';

/**
 * CB_PAID — callback_data-префикс кнопки [Оплачено].
 * Формат: "fin:paid:<credit_id>" (≤ 64 байт).
 */
export const CB_PAID = 'fin:paid:';

/**
 * CB_SNOOZE — callback_data-префикс кнопки [Отложить на 1 день].
 * Формат: "fin:snooze:<credit_id>" (≤ 64 байт).
 */
export const CB_SNOOZE = 'fin:snooze:';

/**
 * CB_DETAIL — callback_data-префикс кнопки [Подробнее].
 * Формат: "fin:detail:<credit_id>" (≤ 64 байт).
 */
export const CB_DETAIL = 'fin:detail:';

// ---------------------------------------------------------------------------
// Строитель инлайн-клавиатуры для кредит-напоминания
// ---------------------------------------------------------------------------

/**
 * buildCreditReminderKeyboard — строит reply_markup с тремя кнопками
 * кредит-напоминания для sendMessage/sendPhoto.
 *
 * Кнопки в одну строку (ряд из 3):
 *   [Оплачено] [Отложить] [Подробнее]
 *
 * ГАРД ≤ 64 байт: все callback_data компактны.
 * "fin:paid:<credit_id>" — 9 + len(credit_id) байт.
 * При длинных credit_id (> 55 символов) — обрезаем (это не должно происходить
 * при нормальных id: deterministicId возвращает 32 символа).
 *
 * @param creditId — id кредита из CreditRecord.id
 * @returns InlineKeyboardMarkup для Telegram
 */
export function buildCreditReminderKeyboard(creditId: string): InlineKeyboardMarkup {
	// Обрезаем credit_id если очень длинный (защита от нарушения ≤ 64 байт).
	// Для стандартных deterministicId (32 символа) обрезания нет.
	const safeId = creditId.slice(0, 50);

	const buttons: InlineKeyboardButton[] = [
		{ text: '✅ Оплачено', callback_data: `${CB_PAID}${safeId}` },
		{ text: '⏰ Отложить', callback_data: `${CB_SNOOZE}${safeId}` },
		{ text: '📊 Подробнее', callback_data: `${CB_DETAIL}${safeId}` },
	];

	// Все три кнопки в одну строку (массив из 1 ряда).
	return { inline_keyboard: [buttons] };
}

// ---------------------------------------------------------------------------
// Инъектируемые зависимости диспетчера
// ---------------------------------------------------------------------------

/**
 * FinanceCallbackDeps — зависимости для dispatchFinanceCallback.
 * Всё инъектируется → тесты используют моки без реальных Telegram/файлов.
 */
export interface FinanceCallbackDeps {
	/** ownerChatId — id владельца (single-user guard). */
	ownerChatId: number;
	/** telegram — клиент Telegram для ответа и отправки. */
	telegram: TelegramClient;
	/** ledger — экземпляр Ledger для чтения/записи финансовых данных. */
	ledger: Ledger;
	/** stateDir — каталог мутабельного состояния (.finance-state/). Опц.: дефолт из env. */
	stateDir?: string;
	/** nowFn — инъекция времени (дефолт: () => new Date()). */
	nowFn?: () => Date;
	/** renderPng — опциональная инъекция рендерера PNG (для тестов без @resvg). */
	renderPng?: typeof renderChartPng;
}

// ---------------------------------------------------------------------------
// Типы CallbackJob
// ---------------------------------------------------------------------------

/**
 * CallbackJob — данные нажатого callback'а (подмножество Job из app.ts).
 *
 * Содержит то, что нужно диспетчеру: from.id (owner-гейт), chatId, callback.id
 * (answerCallbackQuery), callback.data (действие).
 */
export interface CallbackJob {
	/** chatId — chat_id чата владельца (куда отвечать). */
	chatId: number;
	/** fromId — from.id инициатора нажатия (owner-гейт). */
	fromId: number;
	/** callbackQueryId — id для answerCallbackQuery (гасит «часики»). */
	callbackQueryId: string;
	/** data — callback_data нажатой кнопки. */
	data: string;
}

// ---------------------------------------------------------------------------
// Formatters readback (детерминированные, без LLM)
// ---------------------------------------------------------------------------

/**
 * formatCreditPaymentReadback — детерминированный текст подтверждения
 * после [Оплачено].
 *
 * Формат (plain-text, ADR-0011: точные числа владельцу — он инициировал):
 *   ✅ Платёж по кредиту <credit_id> записан.
 *   Сумма: <paymentAmount> <currency>
 *   Тело: <principal> <currency>, проценты: <interest> <currency>
 *   Остаток: <newBalance> <currency> (было <prevBalance>)
 *   Следующий платёж: <nextPaymentDate>
 *
 * @param result — структурный результат recordCreditPayment
 * @returns строка readback для Telegram
 */
export function formatCreditPaymentReadback(result: CreditPaymentResult): string {
	const fmt = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
	const dateStr = result.nextPaymentDate.slice(0, 10); // YYYY-MM-DD
	return (
		`✅ Платёж по кредиту записан.\n` +
		`Сумма: ${fmt(result.paymentAmount)} ${result.currency}\n` +
		`Тело: ${fmt(result.principal)} ${result.currency}, проценты: ${fmt(result.interest)} ${result.currency}\n` +
		`Остаток: ${fmt(result.newBalance)} ${result.currency} (было ${fmt(result.prevBalance)})\n` +
		`Следующий платёж: ${dateStr}`
	);
}

/**
 * formatSnoozeReadback — детерминированный текст подтверждения после [Отложить].
 *
 * @param creditId — id кредита
 * @param untilDate — до какой даты отложено (ISO-8601)
 * @returns строка readback
 */
export function formatSnoozeReadback(creditId: string, untilDate: string): string {
	const dateStr = untilDate.slice(0, 10); // YYYY-MM-DD
	return `⏰ Напоминание по кредиту ${creditId} отложено до ${dateStr}.`;
}

// ---------------------------------------------------------------------------
// Хендлеры отдельных действий
// ---------------------------------------------------------------------------

/**
 * handlePaid — обработчик [Оплачено].
 *
 * Записывает платёж через recordCreditPayment, формирует readback,
 * отправляет текст и сбрасывает fired-дедуп для этого credit_id
 * (чтобы следующее напоминание в новом цикле работало).
 *
 * @param creditId — id кредита
 * @param job      — данные callback'а
 * @param deps     — инъектируемые зависимости
 */
async function handlePaid(
	creditId: string,
	job: CallbackJob,
	deps: FinanceCallbackDeps,
): Promise<void> {
	let result: CreditPaymentResult;
	try {
		// Вызываем запись платежа с 'auto' суммой (plановый платёж из monthly_payment).
		result = recordCreditPayment(creditId, 'auto', {
			ledger: deps.ledger,
			nowFn: deps.nowFn,
		});
	} catch (err) {
		// Ошибка записи (кредит не найден, уже погашен) — логируем, отправляем в Telegram.
		log.warn({ creditId, err: String(err) }, 'finance-callbacks.paid_failed');
		await deps.telegram.sendMessage(
			job.chatId,
			`❌ Не удалось записать платёж по кредиту ${creditId}: ${String(err)}`,
		);
		return;
	}

	// Детерминированный readback — без LLM.
	const text = formatCreditPaymentReadback(result);
	await deps.telegram.sendMessage(job.chatId, text);

	log.info(
		{
			creditId,
			paymentAmount: result.paymentAmount,
			newBalance: result.newBalance,
			currency: result.currency,
		},
		'finance-callbacks.paid_done',
	);
}

/**
 * handleSnooze — обработчик [Отложить на 1 день].
 *
 * Реализует НАСТОЯЩУЮ отсрочку через snooze-стор (writeSnoozeUntil),
 * а НЕ через удаление fired-ключей. Это исправляет баг W1: раньше
 * unmarkFiredByPrefix снимал дедуп, и СЛЕДУЮЩИЙ ЖЕ sweep (если он ходит чаще
 * раза в сутки) немедленно пересылал напоминание.
 *
 * Новая механика:
 *   1. sweep доставил напоминание → markFired('credit:<id>:<dueDate>:lead|due').
 *   2. Пользователь нажимает [Отложить].
 *   3. handleSnooze пишет snoozeUntil = начало следующего дня (по UTC):
 *      writeSnoozeUntil(stateDir, 'credit:<id>', untilIso).
 *   4. collectFinanceDue при каждом свипе читает readSnoozeUntil('credit:<id>'):
 *      если now < snoozeUntil → ПРОПУСКАЕТ айтем (не добавляет в results).
 *   5. Когда snoozeUntil прошёл → кредит снова попадает в свип.
 *      При первом успешном фаяринге sweep вызывает clearSnoozeUntil (уборка).
 *
 * Дедуп fired и snooze НЕ конфликтуют:
 *   - fired = «уже отправлено в этом окне/дне» (не пересылать дважды за окно).
 *   - snooze = «явный запрет до даты» (воля пользователя).
 *   - Оба проверяются независимо: snooze приоритетнее (if snooze active → skip).
 *
 * Отображение: «Отложено до <дата>» — readback с реальной untilIso.
 * Часики гасятся через answerCallbackQuery (уже вызван в dispatchFinanceCallback).
 *
 * @param creditId — id кредита
 * @param job      — данные callback'а
 * @param deps     — инъектируемые зависимости
 */
async function handleSnooze(
	creditId: string,
	job: CallbackJob,
	deps: FinanceCallbackDeps,
): Promise<void> {
	const nowFn = deps.nowFn ?? (() => new Date());
	const now = nowFn();

	// Вычисляем начало СЛЕДУЮЩЕГО дня (UTC) через luxon.
	// Luxon гарантирует корректный переход полночи без off-by-one DST.
	// startOf('day') берёт текущий день 00:00:00 UTC, затем plusDays(1) — следующий день.
	const snoozeUntil = DateTime.fromJSDate(now, { zone: 'utc' })
		.startOf('day')
		.plus({ days: 1 })
		.toISO() ?? now.toISOString();

	// Получаем каталог state (инъекция или дефолт из env).
	const stateDir = deps.stateDir ?? resolveFinanceStateDir(process.env);

	// Записываем snooze: sweep будет молчать по этому кредиту до snoozeUntil.
	// Ключ 'credit:<id>' — без суффикса дедупа (snooze = на весь кредит).
	const snoozeKey = `credit:${creditId}`;
	try {
		writeSnoozeUntil(stateDir, snoozeKey, snoozeUntil);
		log.info({ creditId, snoozeUntil }, 'finance-callbacks.snooze_written');

		// R1: снимаем fired-метки для данного кредита, чтобы после истечения snooze
		// (завтра) алерт перефайрился ровно один раз.
		//
		// Механика двойной защиты:
		//   СЕГОДНЯ  → snooze активен (now < snoozeUntil) → sweep молчит, даже если fired снят.
		//   ЗАВТРА   → snooze истёк → swept находит кредит → markFired → алерт выходит.
		//
		// Без unmarkFiredByPrefix кредит остался бы в fired-реестре навсегда (до смены
		// dueDate), и readback «отложено до завтра» был бы ложью — перевыхода не было бы.
		//
		// Порядок гарантий:
		//   1. fired-гейт — строка wasFired() в collectFinanceDue — стоит ДО snooze-гейта.
		//      После unmark fired будет false → sweep доходит до snooze-проверки.
		//   2. snooze-гейт — now < snoozeUntil → continue → молчание СЕГОДНЯ.
		//   3. ЗАВТРА snooze истёк → clearSnoozeUntil + фаяр → markFired снова.
		unmarkFiredByPrefix(stateDir, `credit:${creditId}:`);
		log.info({ creditId }, 'finance-callbacks.snooze_unmark_fired');
	} catch (err) {
		// Ошибка записи (права доступа и т.п.) — логируем, readback всё равно отправляем.
		log.warn({ creditId, err: String(err) }, 'finance-callbacks.snooze_write_failed');
	}

	// Readback: «Отложено до <дата>» с реальной датой snoozeUntil.
	const text = formatSnoozeReadback(creditId, snoozeUntil);
	await deps.telegram.sendMessage(job.chatId, text);

	log.info({ creditId, until: snoozeUntil.slice(0, 10) }, 'finance-callbacks.snoozed');
}

/**
 * handleDetail — обработчик [Подробнее].
 *
 * Читает последний снапшот кредита и строит:
 *   1. Текстовую сводку (остаток, ставка, следующий платёж).
 *   2. Опционально — PNG-график структуры долга (renderChartPng).
 *
 * Ошибка рендеринга PNG — не фатальна: отправляем только текст.
 *
 * @param creditId — id кредита
 * @param job      — данные callback'а
 * @param deps     — инъектируемые зависимости
 */
async function handleDetail(
	creditId: string,
	job: CallbackJob,
	deps: FinanceCallbackDeps,
): Promise<void> {
	// Читаем все снапшоты кредита, берём последний.
	const allCredits = deps.ledger.readAll('credits');
	const creditSnapshots = allCredits.filter((c) => c.id === creditId);

	if (creditSnapshots.length === 0) {
		await deps.telegram.sendMessage(
			job.chatId,
			`❓ Кредит ${creditId} не найден в леджере.`,
		);
		return;
	}

	// Последний снапшот (max balance_ts).
	const credit = creditSnapshots.reduce(
		(latest, c) => (c.balance_ts > latest.balance_ts ? c : latest),
		creditSnapshots[0]!,
	);

	const fmt = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 2 });

	// Формируем текстовую сводку (plain-text, ADR-0011).
	const nextDate = credit.next_payment_date?.slice(0, 10) ?? 'не задана';
	const rateStr = credit.rate_pct != null ? `${credit.rate_pct}% годовых` : 'не задана';
	const monthlyStr =
		credit.monthly_payment != null
			? `${fmt(credit.monthly_payment)} ${credit.currency}`
			: 'не задан';

	// W2: прогнозируемая дата полного погашения (#4 крит.6).
	// projectPayoffDate — готовый движок (credit.ts), не пересчитываем сами.
	// now берём из инъекции nowFn (инвариант clock-injection).
	const nowFn = deps.nowFn ?? (() => new Date());
	const nowIso = nowFn().toISOString();
	const payoffDateIso = projectPayoffDate(credit, nowIso).slice(0, 10);

	const text =
		`📊 Кредит: ${creditId}\n` +
		`Остаток: ${fmt(credit.balance)} ${credit.currency}\n` +
		`Ставка: ${rateStr}\n` +
		`Ежемесячный платёж: ${monthlyStr}\n` +
		`Следующий платёж: ${nextDate}\n` +
		`Прогноз погашения: ${payoffDateIso}`;

	// Пробуем отрендерить PNG-график структуры долга.
	const renderFn = deps.renderPng ?? renderChartPng;
	try {
		const spec = chartSpec({
			kind: 'debt_structure',
			entries: [
				{
					label: `${creditId} ${credit.currency}`,
					balance: credit.balance,
					currency: credit.currency,
					rate_pct: credit.rate_pct,
				},
			],
		});
		const pngBuffer = renderFn(spec);
		// Отправляем PNG с текстом как подписью (caption ADR-0011: огрублённые числа если нужно).
		// Для detail-хендлера показываем точные числа — владелец сам запросил.
		await deps.telegram.sendPhoto(
			job.chatId,
			{ data: pngBuffer, filename: `credit-${creditId}.png` },
			{ caption: text.slice(0, 1024) },
		);
	} catch (err) {
		// Ошибка PNG — не фатальна: отправляем только текст.
		log.warn({ creditId, err: String(err) }, 'finance-callbacks.detail_png_failed');
		await deps.telegram.sendMessage(job.chatId, text);
	}

	log.info({ creditId, balance: credit.balance }, 'finance-callbacks.detail_sent');
}

// ---------------------------------------------------------------------------
// Главная точка входа: dispatchFinanceCallback
// ---------------------------------------------------------------------------

/**
 * dispatchFinanceCallback — диспетчер нажатия инлайн-кнопки финансового модуля.
 *
 * Порядок работы:
 *   1. Owner-гейт: fromId != ownerChatId → логируем, выходим (молчаливо).
 *   2. Гасим «часики»: answerCallbackQuery (best-effort, всегда).
 *   3. Разбираем callback_data по префиксу (fin:paid/snooze/detail).
 *   4. Вызываем нужный хендлер (handlePaid / handleSnooze / handleDetail).
 *   5. Неизвестный префикс → логируем warn и выходим.
 *
 * Вызывается из handleCallbackQuery (app.ts) по условию
 *   job.callback.data.startsWith(CALLBACK_PREFIX).
 *
 * @param job  — данные callback'а (chatId, fromId, callbackQueryId, data)
 * @param deps — инъектируемые зависимости (telegram, ledger, ownerChatId, ...)
 */
export async function dispatchFinanceCallback(
	job: CallbackJob,
	deps: FinanceCallbackDeps,
): Promise<void> {
	// ── Шаг 1: owner-гейт (ADR-0009, ADR-0007) ──────────────────────────────
	// from.id ОБЯЗАН быть владельцем. Чужой from.id → тихий дроп (не отвечаем
	// чужим chat_id ничем, чтобы не палить существование бота).
	if (job.fromId !== deps.ownerChatId) {
		log.warn({ fromId: job.fromId, ownerChatId: deps.ownerChatId }, 'finance-callbacks.foreign_owner_rejected');
		// Гасим «часики» best-effort — чтобы UI не крутил бесконечно.
		await deps.telegram.answerCallbackQuery(job.callbackQueryId);
		return;
	}

	// ── Шаг 2: гасим «часики» (best-effort, ADR-0023) ───────────────────────
	// answerCallbackQuery вызываем ВСЕГДА до начала тяжёлой работы — иначе
	// Telegram UI крутит спиннер до таймаута (~ 30 сек).
	await deps.telegram.answerCallbackQuery(job.callbackQueryId);

	const data = job.data;

	// ── Шаг 3–4: разбор callback_data и диспетчеризация ─────────────────────
	if (data.startsWith(CB_PAID)) {
		// [Оплачено]: recordCreditPayment + readback.
		const creditId = data.slice(CB_PAID.length);
		if (!creditId) {
			log.warn({ data }, 'finance-callbacks.paid_empty_credit_id');
			return;
		}
		await handlePaid(creditId, job, deps);
		return;
	}

	if (data.startsWith(CB_SNOOZE)) {
		// [Отложить]: oneoff-напоминание на завтра через finance-state.
		const creditId = data.slice(CB_SNOOZE.length);
		if (!creditId) {
			log.warn({ data }, 'finance-callbacks.snooze_empty_credit_id');
			return;
		}
		await handleSnooze(creditId, job, deps);
		return;
	}

	if (data.startsWith(CB_DETAIL)) {
		// [Подробнее]: текст + опциональный PNG-график.
		const creditId = data.slice(CB_DETAIL.length);
		if (!creditId) {
			log.warn({ data }, 'finance-callbacks.detail_empty_credit_id');
			return;
		}
		await handleDetail(creditId, job, deps);
		return;
	}

	// Неизвестный финансовый callback — логируем, но не падаем.
	log.warn({ data }, 'finance-callbacks.unknown_action');
}
