/**
 * finance-intent.ts — детерминированный диспетчер финансовых намерений движка.
 *
 * АРХИТЕКТУРА ШВА (ADR-0024):
 *   1. Движок инструктируется (через системный промпт) при финансовом вводе/запросе
 *      вернуть ОДИН fenced-блок ```finance-intent\n{json}\n```.
 *   2. extractFinanceIntent(engineAnswer) — извлекает и валидирует intent (zod).
 *      Нет блока → null (обычный текстовый ответ проходит как есть).
 *   3. dispatchFinanceIntent(intent, deps) — по типу вызывает ГОТОВЫЕ детерминированные
 *      функции (recordFinanceEntry из record.ts, computeNetWorth из networth.ts и т.д.).
 *      Ничего не пишет при query-интентах.
 *   4. formatReadback(result) — детерминированный текст подтверждения для Telegram.
 *      LLM здесь НЕ нужен.
 *
 * ИНВАРИАНТЫ:
 *   - Вся арифметика — в чистых функциях (record.ts / networth.ts / goals.ts).
 *   - Query-интент НИЧЕГО не пишет в леджер.
 *   - Запись только в приватный репо (path-guard в Ledger).
 *   - Синтетические данные только в тестах; никаких PII/токенов в коде.
 *   - Мультивалютность: нативные валюты хранятся as-is, нет «базовой».
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as yaml from 'js-yaml';
import { z } from 'zod';

import { childLogger } from '../core/logger.js';
import { chartSpec, type BalanceEntry, type CategoryEntry, type GoalProgressData } from '../ingest/finance/chart.js';
import { createDefaultFxProvider, type FxProvider } from '../ingest/finance/fx.js';
import { computeGoalProgress } from '../ingest/finance/goals.js';
import { assertPathAllowed, Ledger, resolvePublicRepo } from '../ingest/finance/ledger.js';
import { recordFinanceEntry } from '../ingest/finance/record.js';
import { FinanceGoalSchema, type FinanceGoal, CreditRecordSchema, type AccountRecord } from '../ingest/finance/types.js';
import { renderChartPng } from './finance-render.js';
import {
	readPendingCashSurvey,
	clearPendingCashSurvey,
	writeLastInputTs,
	type PendingCashSurvey,
} from '../scheduler/finance-state.js';
import type { TelegramClient } from './telegram.js';

const log = childLogger('bridge.finance-intent');

// ---------------------------------------------------------------------------
// Схемы finance-intent (payload внутри fenced-блока движка)
// ---------------------------------------------------------------------------

/**
 * Схема AccountRef — ссылка на счёт внутри финансового интента.
 * Все поля минимально необходимы для bootstrap'а счёта через record.ts.
 */
const AccountRefSchema = z.object({
	/** source — источник/тип ввода (всегда "manual" для ручного ввода). */
	source: z.string().min(1).default('manual'),
	/** name — имя счёта без PII (напр. "Кошелёк RUB", "Наличные USD"). */
	name: z.string().min(1),
	/** currency — нативная валюта счёта (ISO-4217 или крипто). */
	currency: z.string().min(1).max(10),
	/** kind — тип счёта. */
	kind: z.enum(['bank', 'ewallet', 'exchange', 'loan', 'cash', 'checking', 'savings']).default('checking'),
});

/**
 * RecordBalanceIntent — обновление баланса счёта (снапшот).
 * Пример: «Баланс на Сбере 120000 рублей».
 */
const RecordBalanceIntentSchema = z.object({
	type: z.literal('record_balance'),
	account: AccountRefSchema,
	/** balance — новый баланс счёта в нативной валюте. */
	balance: z.number().finite(),
	/** ts — момент снапшота (ISO, опц.; если нет — берётся сейчас). */
	ts: z.string().optional(),
});

/**
 * RecordCashIntent — запись наличных (аналог record_balance, но kind='cash').
 * Пример: «В кошельке 5000 рублей наличными».
 */
const RecordCashIntentSchema = z.object({
	type: z.literal('record_cash'),
	account: AccountRefSchema,
	/** balance — текущий баланс наличных в нативной валюте. */
	balance: z.number().finite(),
	/** ts — момент снапшота (ISO, опц.). */
	ts: z.string().optional(),
});

/**
 * RecordIncomeIntent — запись входящего дохода (транзакция direction:'in').
 * Пример: «Получил зарплату 80000 рублей».
 */
const RecordIncomeIntentSchema = z.object({
	type: z.literal('record_income'),
	account: AccountRefSchema,
	/** amount — сумма дохода (> 0). */
	amount: z.number().finite().positive(),
	/** currency — валюта транзакции. */
	currency: z.string().min(1).max(10),
	/** category — категория (опц., напр. "salary"). */
	category: z.string().optional(),
	/** note — заметка без PII (опц.). */
	note: z.string().optional(),
	/** ts — момент транзакции (ISO, опц.). */
	ts: z.string().optional(),
});

/**
 * RecordExpenseIntent — запись расхода (транзакция direction:'out').
 * Пример: «Потратил 1500 рублей на продукты».
 */
const RecordExpenseIntentSchema = z.object({
	type: z.literal('record_expense'),
	account: AccountRefSchema,
	/** amount — сумма расхода (> 0). */
	amount: z.number().finite().positive(),
	/** currency — валюта транзакции. */
	currency: z.string().min(1).max(10),
	/** category — категория (опц., напр. "grocery"). */
	category: z.string().optional(),
	/** note — заметка без PII (опц.). */
	note: z.string().optional(),
	/** ts — момент транзакции (ISO, опц.). */
	ts: z.string().optional(),
	/** goal_tag — ссылка на цель (опц.). */
	goal_tag: z.string().optional(),
});

/**
 * CreateCreditIntent — создание нового кредита (первый CreditRecord-снапшот в credits.jsonl).
 *
 * Движок получает данные о кредите от владельца и возвращает этот интент.
 * dispatchFinanceIntent записывает первый снапшот кредита через Ledger.append('credits', ...),
 * что делает кредит видимым для кредит-движка (creditPaymentsDue, splitPayment и т.д.).
 *
 * Пример: «Добавь ипотеку: 3 млн рублей, 14% годовых, ежемесячный платёж 35000, день платежа 15».
 */
const CreateCreditIntentSchema = z.object({
	type: z.literal('create_credit'),
	/**
	 * credit_id — уникальный slug кредита без пробелов (напр. "mortgage-2026", "car-loan").
	 * Используется как id в CreditRecord — повторные create_credit с тем же id дедупятся
	 * (если кредит уже есть, возвращаем graceful без записи).
	 */
	credit_id: z.string().min(1).regex(/^[a-z0-9-]+$/, 'credit_id — slug без пробелов'),
	/**
	 * label — человекочитаемое название кредита (напр. "Ипотека ВТБ", "Кредит наличными").
	 * Сохраняется в CreditRecord как source-комментарий; отображается в напоминаниях.
	 */
	label: z.string().min(1),
	/** principal — первоначальная сумма кредита (> 0, в нативной валюте). */
	principal: z.number().finite().positive(),
	/** currency — нативная валюта кредита (ISO-4217 или крипто). */
	currency: z.string().min(1).max(10),
	/** rate_pct — годовая ставка в процентах (опц., напр. 21.5 → 21,5%). */
	rate_pct: z.number().finite().nonnegative().optional(),
	/** monthly_payment — ежемесячный платёж в нативной валюте (опц.). */
	monthly_payment: z.number().finite().positive().optional(),
	/**
	 * next_payment_date — дата следующего платежа (ISO-8601, опц.).
	 * Используется движком напоминаний: creditPaymentsDue вернёт этот платёж.
	 * Если не задан, но задан payment_day — движок вычислит следующую дату сам.
	 */
	next_payment_date: z.string().optional(),
	/**
	 * payment_day — день месяца планового платежа (1–31, опц.).
	 * Альтернатива next_payment_date для регулярных платежей без точной даты.
	 */
	payment_day: z.number().int().min(1).max(31).optional(),
	/**
	 * type — тип кредита: annuity (аннуитет) или differentiated (дифференцированный).
	 * По умолчанию 'annuity' (самый распространённый в РФ).
	 */
	credit_type: z.enum(['annuity', 'differentiated']).default('annuity'),
	/**
	 * balance — текущий остаток долга (опц.; если не задан — равен principal).
	 * Может отличаться от principal если кредит уже частично погашен.
	 */
	balance: z.number().finite().nonnegative().optional(),
	/** ts — момент создания записи (ISO, опц.; если нет — берётся сейчас). */
	ts: z.string().optional(),
});

/**
 * CreateGoalIntent — создание новой финансовой цели (страницы вики).
 * Пример: «Хочу накопить 300000 рублей к новому году».
 */
const CreateGoalIntentSchema = z.object({
	type: z.literal('create_goal'),
	/** goal_id — slug цели без пробелов (напр. "emergency-fund-2026"). */
	goal_id: z.string().min(1).regex(/^[a-z0-9-]+$/, 'goal_id — slug без пробелов'),
	/** title — человекочитаемый заголовок цели. */
	title: z.string().min(1),
	/** target_amount — целевая сумма (> 0). */
	target_amount: z.number().finite().positive(),
	/** currency — валюта цели. */
	currency: z.string().min(1).max(10),
	/** target_date — дата достижения (ISO-8601). */
	target_date: z.string().min(1),
	/** fin_kind — вид финансовой цели. */
	fin_kind: z.enum(['save', 'spend_cap', 'debt_paydown', 'grow']),
	/** priority — приоритет (опц., меньше = выше). */
	priority: z.number().int().nonnegative().optional(),
});

/**
 * EditIntent — правка (amend) уже записанной транзакции.
 * Пример: «Исправь последнюю транзакцию, сумма была 1200, а не 1500».
 */
const EditIntentSchema = z.object({
	type: z.literal('edit'),
	account: AccountRefSchema,
	/** amended_id — id транзакции, которую исправляем. */
	amended_id: z.string().min(1),
	/** amount — исправленная сумма (> 0). */
	amount: z.number().finite().positive(),
	/** currency — исправленная валюта. */
	currency: z.string().min(1).max(10),
	/** direction — исправленное направление. */
	direction: z.enum(['in', 'out']),
	/** category — исправленная категория (опц.). */
	category: z.string().optional(),
	/** note — заметка к правке (опц.). */
	note: z.string().optional(),
	/** ts — момент записи правки (ISO, опц.). */
	ts: z.string().optional(),
});

/**
 * VoidIntent — аннулирование (сторно) ранее записанной транзакции.
 * Пример: «Отмени транзакцию grocery за 1500 рублей от вчера».
 */
const VoidIntentSchema = z.object({
	type: z.literal('void'),
	account: AccountRefSchema,
	/** void_id — id транзакции, которую аннулируем. */
	void_id: z.string().min(1),
	/** amount — сумма сторно-записи (> 0). */
	amount: z.number().finite().positive(),
	/** currency — валюта сторно. */
	currency: z.string().min(1).max(10),
	/** direction — направление сторно (обратное оригиналу). */
	direction: z.enum(['in', 'out']),
	/** note — причина аннулирования (опц.). */
	note: z.string().optional(),
	/** ts — момент записи сторно (ISO, опц.). */
	ts: z.string().optional(),
});

/**
 * TransferIntent — перевод между своими счетами.
 * Пример: «Перевёл 10000 рублей с Тинькофф на Сбер».
 */
const TransferIntentSchema = z.object({
	type: z.literal('transfer'),
	from_account: AccountRefSchema,
	to_account: AccountRefSchema,
	/** amount — сумма перевода (> 0). */
	amount: z.number().finite().positive(),
	/** currency — валюта перевода. */
	currency: z.string().min(1).max(10),
	/** note — заметка (опц.). */
	note: z.string().optional(),
	/** ts — момент перевода (ISO, опц.). */
	ts: z.string().optional(),
});

/**
 * BatchItemIntentSchema — под-союз типов, которые могут быть элементами batch.
 *
 * Разрешено: record_balance | record_cash | record_income | record_expense | transfer.
 * Запрещено: batch (вложенный), query, create_goal, create_credit, edit, void.
 * Это намеренное ограничение: batch плоский, не рекурсивный.
 * Переиспользуем уже объявленные схемы — без дублирования полей.
 */
const BatchItemIntentSchema = z.discriminatedUnion('type', [
	RecordBalanceIntentSchema,
	RecordCashIntentSchema,
	RecordIncomeIntentSchema,
	RecordExpenseIntentSchema,
	TransferIntentSchema,
]);

/** Тип одного элемента батча. */
export type BatchItemIntent = z.infer<typeof BatchItemIntentSchema>;

/**
 * BatchIntent — несколько операций в одном сообщении.
 * Пример: «На карте 50000 рублей и наличными 5 млн донгов» →
 *   {"type":"batch","items":[{record_balance...},{record_cash...}]}
 *
 * Ограничения:
 *   - items: min 1, max 20 (защита от злоупотреблений).
 *   - Элементы — только record_balance/record_cash/record_income/record_expense/transfer,
 *     не вложенные batch/query/create_* (batch плоский, не рекурсивный).
 *   - dispatchFinanceIntent обрабатывает каждый item последовательно через
 *     ту же логику что и одиночные record_balance/record_cash и т.д.
 *   - Idle-watermark (writeLastInputTs) обновляется один раз после всего батча.
 */
const BatchIntentSchema = z.object({
	type: z.literal('batch'),
	/** items — массив операций для последовательной обработки. */
	items: z.array(BatchItemIntentSchema).min(1).max(20),
});

/**
 * QueryIntent — запрос информации (net-worth, траты, цели, «могу ли»).
 * Query НИЧЕГО не пишет в леджер — только читает и отвечает.
 * Пример: «Сколько я потратил на еду в мае?» / «Какой мой net-worth?»
 */
const QueryIntentSchema = z.object({
	type: z.literal('query'),
	/**
	 * query_kind — вид запроса:
	 *   'net_worth'     — текущий чистый капитал (из снапшотов)
	 *   'spending'      — траты за период/категорию (из транзакций)
	 *   'goal_progress' — прогресс по цели
	 *   'feasibility'   — «могу ли позволить X» (discretionary/feasibility)
	 *   'summary'       — общая финансовая сводка
	 */
	query_kind: z.enum(['net_worth', 'spending', 'goal_progress', 'feasibility', 'summary']),
	/** goal_id — id цели (для query_kind='goal_progress'). Опц. */
	goal_id: z.string().optional(),
	/** category — категория для query_kind='spending'. Опц. */
	category: z.string().optional(),
	/** period_start — начало периода (ISO, для spending). Опц. */
	period_start: z.string().optional(),
	/** period_end — конец периода (ISO, для spending). Опц. */
	period_end: z.string().optional(),
	/** amount — сумма для query_kind='feasibility' («могу ли позволить N рублей»). */
	amount: z.number().optional(),
	/** currency — валюта для feasibility-запроса. Опц. */
	currency: z.string().optional(),
	/** question — исходный вопрос пользователя (для передачи в контекст). Опц. */
	question: z.string().optional(),
});

/**
 * FinanceIntent — дискриминированный union всех видов финансовых намерений.
 * Включает batch (несколько record_balance/transfer в одном сообщении, ADR-0024).
 */
export const FinanceIntentSchema = z.discriminatedUnion('type', [
	RecordBalanceIntentSchema,
	RecordCashIntentSchema,
	RecordIncomeIntentSchema,
	RecordExpenseIntentSchema,
	CreateGoalIntentSchema,
	CreateCreditIntentSchema,
	EditIntentSchema,
	VoidIntentSchema,
	TransferIntentSchema,
	QueryIntentSchema,
	BatchIntentSchema,
]);

export type FinanceIntent = z.infer<typeof FinanceIntentSchema>;

// ---------------------------------------------------------------------------
// Типы результатов диспетчера
// ---------------------------------------------------------------------------

/**
 * DispatchResult — структурный результат dispatchFinanceIntent.
 * Используется formatReadback для детерминированного текста подтверждения.
 */
export interface DispatchResult {
	/** intent — исходный интент (для форматирования). */
	intent: FinanceIntent;
	/**
	 * summary — краткое описание действия (что именно записано/прочитано).
	 * Детерминированная строка, построенная из структурных полей — без LLM.
	 */
	summary: string;
	/**
	 * balances — балансы счетов после записи (только для record-интентов).
	 * Пустой массив для query и create_goal.
	 */
	balances: Array<{ account_id: string; currency: string; balance: number }>;
	/**
	 * queryContext — данные из агрегатов (только для query-интентов).
	 * null для record-интентов.
	 */
	queryContext: QueryContext | null;
	/**
	 * goalPage — созданная страница цели (только для create_goal).
	 * null для остальных интентов.
	 */
	goalPage: { goalId: string; filePath: string } | null;
	/**
	 * chartPngSent — true если PNG-график был успешно отправлен через sendPhoto.
	 * false если отправка пропущена (нет telegramClient/ownerChatId) или не уместна.
	 * Используется тестами для проверки поведения реактивной визуализации (#6/#9).
	 */
	chartPngSent: boolean;
	/**
	 * pendingCashHandled — true если ответ был распознан как cash-снапшот из pending-опроса.
	 * Используется тестами для проверки pending-cash flow (#11).
	 */
	pendingCashHandled: boolean;
}

/**
 * QueryContext — данные для ответа на финансовый вопрос.
 * Строится из детерминированных функций (networth, goals, transactions).
 */
export interface QueryContext {
	/** balanceSummaries — балансы всех счетов по нативным валютам. */
	balanceSummaries: Array<{ currency: string; total: number }>;
	/** netWorthPerCurrency — чистый капитал в нативных валютах (активы − кредиты). */
	netWorthPerCurrency: Record<string, number>;
	/** spendingByCategory — траты по категориям за период (если запрошено). */
	spendingByCategory: Array<{ category: string; currency: string; amount: number }>;
	/** goalProgress — прогресс по запрошенной цели (если query_kind='goal_progress'). */
	goalProgress: { goal_id: string; current: number; target: number; pct: number; currency: string } | null;
	/** discretionaryInfo — доступный бюджет на дискреционные расходы (для feasibility). */
	discretionaryInfo: string | null;
}

// ---------------------------------------------------------------------------
// Зависимости (инъекция для тестов)
// ---------------------------------------------------------------------------

/**
 * FinanceIntentDeps — зависимости для dispatchFinanceIntent.
 * Все зависимости инъектируются для тестируемости (без реальной сети/FS/времени).
 */
export interface FinanceIntentDeps {
	/** ledger — экземпляр Ledger для записи/чтения JSONL. В тестах: tmp-dir Ledger. */
	ledger: Ledger;
	/** nowFn — функция текущего времени. В тестах: фиксированный момент. */
	nowFn?: () => Date;
	/**
	 * goalsDir — каталог для страниц finance-goal (wiki/finance/goals/ в приватном репо).
	 * В тестах: tmp-dir. Если не задан — страницы не создаются (graceful).
	 */
	goalsDir?: string;
	/**
	 * publicRepoRoot — корень публичного репо (для assertPathAllowed).
	 * По умолчанию берётся из Ledger.
	 */
	publicRepoRoot?: string;

	/**
	 * telegramClient — транспортный клиент для отправки графиков (sendPhoto) при
	 * query-интентах. Инъектируется из бриджа; если не задан — только текстовый readback
	 * (graceful: режим без Telegram, для тестов командной строки).
	 */
	telegramClient?: TelegramClient;

	/**
	 * ownerChatId — числовой id чата владельца (Telegram). Нужен для sendPhoto/sendDocument.
	 * Если не задан и telegramClient есть — отправка пропускается (graceful).
	 */
	ownerChatId?: number;

	/**
	 * financeStateDir — каталог мутабельного состояния (finance-state.ts).
	 * Нужен для readPendingCashSurvey / clearPendingCashSurvey.
	 * В тестах: tmp-dir. Если не задан — pending-cash обработка пропускается (graceful).
	 */
	financeStateDir?: string;

	/**
	 * fx — провайдер курсов валют для расчёта прогресса цели в query-интентах.
	 * Если не задан — создаётся createDefaultFxProvider() (Identity + Stablecoin + CBR).
	 * В тестах: инъектируется мок-провайдер без реальной сети.
	 */
	fx?: FxProvider;
}

// ---------------------------------------------------------------------------
// Извлечение интента из ответа движка
// ---------------------------------------------------------------------------

/**
 * FINANCE_INTENT_FENCE — шаблон fenced-блока для извлечения finance-intent JSON.
 * Движок должен вернуть ровно один такой блок при финансовом вводе/запросе.
 * Регексп: нежадный захват блока между ```finance-intent и ```.
 */
const FINANCE_INTENT_FENCE = /```finance-intent\s*\n([\s\S]*?)\n```/;

/**
 * extractFinanceIntent — детерминированный парсер ответа движка.
 *
 * Ищет в тексте ответа блок ```finance-intent\n{json}\n```.
 * Если блок найден — валидирует JSON через zod и возвращает типизированный intent.
 * Если блока нет → null (обычный текстовый ответ проходит как есть).
 * При невалидном JSON или провале zod → null (безопасный graceful fallback).
 *
 * @param engineAnswer — текст ответа движка (из EngineResult.answer)
 * @returns FinanceIntent | null
 */
export function extractFinanceIntent(engineAnswer: string): FinanceIntent | null {
	// Ищем fenced-блок finance-intent в ответе движка.
	const match = FINANCE_INTENT_FENCE.exec(engineAnswer);
	if (!match) {
		// Нет блока — обычный текстовый ответ, диспетчеризация не нужна.
		return null;
	}

	// Извлекаем JSON-тело блока.
	const rawJson = match[1]?.trim() ?? '';
	if (!rawJson) {
		log.warn('finance-intent: пустой блок JSON — игнорируем');
		return null;
	}

	// Парсим JSON.
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch (e) {
		// Невалидный JSON — безопасно игнорируем, ответ пройдёт как текст.
		log.warn({ err: String(e), rawHead: rawJson.slice(0, 200) }, 'finance-intent: невалидный JSON в блоке');
		return null;
	}

	// Валидируем через zod-схему.
	const result = FinanceIntentSchema.safeParse(parsed);
	if (!result.success) {
		// Невалидная схема — логируем и игнорируем (не роняем ход).
		log.warn(
			{ errors: result.error.errors.slice(0, 5), rawHead: rawJson.slice(0, 200) },
			'finance-intent: zod-валидация не прошла',
		);
		return null;
	}

	log.info({ type: result.data.type }, 'finance-intent: извлечён интент');
	return result.data;
}

// ---------------------------------------------------------------------------
// Диспетчер интентов
// ---------------------------------------------------------------------------

/**
 * dispatchFinanceIntent — детерминированный диспетчер по типу интента.
 *
 * По type зовёт ГОТОВЫЕ функции из record.ts, networth.ts, goals.ts.
 * Query-интенты НИЧЕГО не пишут в леджер — только читают.
 * Возвращает структурный DispatchResult для форматирования.
 *
 * Расширения (волна 2 кластер C3):
 *   - При query-интентах уместного вида (net_worth/summary/spending/goal_progress/debt)
 *     строит PNG-график через renderChartPng и отправляет через sendPhoto (если deps.telegramClient задан).
 *   - При поступлении числового значения (record_cash) проверяет pending-cash survey
 *     и гасит его через clearPendingCashSurvey.
 *
 * @param intent — распарсенный FinanceIntent из extractFinanceIntent
 * @param deps   — зависимости (Ledger, nowFn, goalsDir, telegramClient, ownerChatId, financeStateDir)
 */
export async function dispatchFinanceIntent(
	intent: FinanceIntent,
	deps: FinanceIntentDeps,
): Promise<DispatchResult> {
	const { ledger, nowFn = () => new Date() } = deps;

	switch (intent.type) {
		// ── Запись баланса (снапшот) ─────────────────────────────────────────
		case 'record_balance': {
			const result = recordFinanceEntry(
				{
					kind: 'snapshot',
					account: {
						source: intent.account.source,
						name: intent.account.name,
						currency: intent.account.currency,
						kind: intent.account.kind,
					},
					balance: intent.balance,
					ts: intent.ts,
				},
				{ ledger, nowFn },
			);

			// Формируем краткий суммарный текст из записанных данных.
			const bal = result.balances[0];
			const summary = bal
				? `Записан баланс счёта «${intent.account.name}»: ${bal.balance} ${bal.currency}`
				: `Записан баланс счёта «${intent.account.name}»`;

			// Обновляем watermark idle-нуджа после успешного ввода (блокер #8).
			if (deps.financeStateDir) {
				writeLastInputTs(deps.financeStateDir, nowFn().toISOString());
			}

			return {
				intent,
				summary,
				balances: result.balances,
				queryContext: null,
				goalPage: null,
				chartPngSent: false,
				pendingCashHandled: false,
			};
		}

		// ── Запись наличных (снапшот с kind=cash) ────────────────────────────
		case 'record_cash': {
			const result = recordFinanceEntry(
				{
					kind: 'snapshot',
					account: {
						source: intent.account.source,
						name: intent.account.name,
						currency: intent.account.currency,
						// Для наличных принудительно ставим kind=cash
						kind: 'cash',
					},
					balance: intent.balance,
					ts: intent.ts,
				},
				{ ledger, nowFn },
			);

			const bal = result.balances[0];
			const summary = bal
				? `Записаны наличные «${intent.account.name}»: ${bal.balance} ${bal.currency}`
				: `Записаны наличные «${intent.account.name}»`;

			// ── Pending-cash survey: если запись пришла в ответ на опрос, гасим маркер ──
			// C1-проактив поставил маркер и спросил «сколько наличных?»; C3 (мы) проверяем
			// маркер и гасим его после успешной записи (clearPendingCashSurvey).
			let pendingCashHandled = false;
			if (deps.financeStateDir) {
				const pending = readPendingCashSurvey(deps.financeStateDir);
				if (pending !== null) {
					clearPendingCashSurvey(deps.financeStateDir);
					pendingCashHandled = true;
					log.info(
						{ account: intent.account.name, currency: intent.account.currency },
						'finance-intent: pending cash survey погашен после записи наличных',
					);
				}
				// Обновляем watermark idle-нуджа после успешного ввода (блокер #8).
				writeLastInputTs(deps.financeStateDir, nowFn().toISOString());
			}

			return {
				intent,
				summary,
				balances: result.balances,
				queryContext: null,
				goalPage: null,
				chartPngSent: false,
				pendingCashHandled,
			};
		}

		// ── Запись дохода (транзакция direction:in) ───────────────────────────
		case 'record_income': {
			const result = recordFinanceEntry(
				{
					kind: 'transaction',
					account: {
						source: intent.account.source,
						name: intent.account.name,
						currency: intent.account.currency,
						kind: intent.account.kind,
					},
					amount: intent.amount,
					currency: intent.currency,
					direction: 'in',
					category: intent.category,
					note: intent.note,
					ts: intent.ts,
				},
				{ ledger, nowFn },
			);

			const summary = `Записан доход: +${intent.amount} ${intent.currency} на счёт «${intent.account.name}»${intent.category ? ` (${intent.category})` : ''}`;

			// Обновляем watermark idle-нуджа после успешного ввода (блокер #8).
			if (deps.financeStateDir) {
				writeLastInputTs(deps.financeStateDir, nowFn().toISOString());
			}

			return {
				intent,
				summary,
				balances: result.balances,
				queryContext: null,
				goalPage: null,
				chartPngSent: false,
				pendingCashHandled: false,
			};
		}

		// ── Запись расхода (транзакция direction:out) ─────────────────────────
		case 'record_expense': {
			const result = recordFinanceEntry(
				{
					kind: 'transaction',
					account: {
						source: intent.account.source,
						name: intent.account.name,
						currency: intent.account.currency,
						kind: intent.account.kind,
					},
					amount: intent.amount,
					currency: intent.currency,
					direction: 'out',
					category: intent.category,
					note: intent.note,
					ts: intent.ts,
					goal_tag: intent.goal_tag,
				},
				{ ledger, nowFn },
			);

			const summary = `Записан расход: -${intent.amount} ${intent.currency} со счёта «${intent.account.name}»${intent.category ? ` (${intent.category})` : ''}`;

			// Обновляем watermark idle-нуджа после успешного ввода (блокер #8).
			if (deps.financeStateDir) {
				writeLastInputTs(deps.financeStateDir, nowFn().toISOString());
			}

			return {
				intent,
				summary,
				balances: result.balances,
				queryContext: null,
				goalPage: null,
				chartPngSent: false,
				pendingCashHandled: false,
			};
		}

		// ── Создание финансовой цели (страница вики) ──────────────────────────
		case 'create_goal': {
			const goalPage = await createGoalPage(intent, deps);
			const summary = `Создана цель «${intent.title}» (${intent.goal_id}): ${intent.target_amount} ${intent.currency} к ${intent.target_date}`;

			return {
				intent,
				summary,
				balances: [],
				queryContext: null,
				goalPage,
				chartPngSent: false,
				pendingCashHandled: false,
			};
		}

		// ── Правка транзакции (amend) ─────────────────────────────────────────
		case 'edit': {
			const result = recordFinanceEntry(
				{
					kind: 'amend',
					account: {
						source: intent.account.source,
						name: intent.account.name,
						currency: intent.account.currency,
						kind: intent.account.kind,
					},
					amended_id: intent.amended_id,
					amount: intent.amount,
					currency: intent.currency,
					direction: intent.direction,
					category: intent.category,
					note: intent.note,
					ts: intent.ts,
				},
				{ ledger, nowFn },
			);

			const summary = `Исправлена транзакция ${intent.amended_id.slice(0, 8)}…: ${intent.direction === 'in' ? '+' : '-'}${intent.amount} ${intent.currency}`;

			// Обновляем watermark idle-нуджа после успешного ввода (блокер #8).
			if (deps.financeStateDir) {
				writeLastInputTs(deps.financeStateDir, nowFn().toISOString());
			}

			return {
				intent,
				summary,
				balances: result.balances,
				queryContext: null,
				goalPage: null,
				chartPngSent: false,
				pendingCashHandled: false,
			};
		}

		// ── Аннулирование транзакции (void/сторно) ────────────────────────────
		case 'void': {
			const result = recordFinanceEntry(
				{
					kind: 'void',
					account: {
						source: intent.account.source,
						name: intent.account.name,
						currency: intent.account.currency,
						kind: intent.account.kind,
					},
					void_id: intent.void_id,
					amount: intent.amount,
					currency: intent.currency,
					direction: intent.direction,
					note: intent.note,
					ts: intent.ts,
				},
				{ ledger, nowFn },
			);

			const summary = `Аннулирована транзакция ${intent.void_id.slice(0, 8)}…: сторно ${intent.amount} ${intent.currency}`;

			// Обновляем watermark idle-нуджа после успешного ввода (блокер #8).
			if (deps.financeStateDir) {
				writeLastInputTs(deps.financeStateDir, nowFn().toISOString());
			}

			return {
				intent,
				summary,
				balances: result.balances,
				queryContext: null,
				goalPage: null,
				pendingCashHandled: false,
				chartPngSent: false,
			};
		}

		// ── Батч: несколько операций в одном сообщении ───────────────────────
		// Дефект 1: без batch-интента «на карте 50000 и наличными 5 млн донгов»
		// теряло наличку. Промпт уже инструктирует движок эмитировать batch —
		// теперь код принимает и обрабатывает его.
		case 'batch': {
			// Агрегируем результаты всех items.
			const allBalances: DispatchResult['balances'] = [];
			const itemSummaries: string[] = [];

			for (const item of intent.items) {
				// Диспетчеризуем каждый элемент batch-а через ту же функцию:
				// рекурсивно вызываем dispatchFinanceIntent с одиночным интентом.
				// Это гарантирует единообразную логику — без дублирования веток.
				// Idle-watermark НЕ обновляем здесь — обновим один раз после цикла.
				const itemDeps: FinanceIntentDeps = {
					...deps,
					// Подавляем watermark-обновление внутри рекурсивного вызова:
					// передаём financeStateDir=undefined чтобы writeLastInputTs
					// не вызывался для каждого item — только один раз по окончании.
					financeStateDir: undefined,
				};
				// Диспетчеризуем элемент как обычный одиночный интент.
				const itemResult = await dispatchFinanceIntent(item, itemDeps);

				// Собираем строку-сводку для каждого элемента (что именно записано).
				itemSummaries.push(itemResult.summary);

				// Объединяем балансы (дедупируем по account_id: берём последний).
				for (const bal of itemResult.balances) {
					const existingIdx = allBalances.findIndex((b) => b.account_id === bal.account_id);
					if (existingIdx >= 0) {
						// Обновляем: последующий item переписал баланс счёта.
						allBalances[existingIdx] = bal;
					} else {
						allBalances.push(bal);
					}
				}
			}

			// Краткое summary batch-а: перечень всех обработанных операций.
			const batchSummary = `Батч (${intent.items.length} оп.): ${itemSummaries.join(' | ')}`;

			// Обновляем idle-watermark один раз по итогам всего батча (блокер #8).
			if (deps.financeStateDir) {
				writeLastInputTs(deps.financeStateDir, nowFn().toISOString());
			}

			return {
				intent,
				summary: batchSummary,
				balances: allBalances,
				queryContext: null,
				goalPage: null,
				chartPngSent: false,
				pendingCashHandled: false,
			};
		}

		// ── Перевод между счетами ─────────────────────────────────────────────
		case 'transfer': {
			const result = recordFinanceEntry(
				{
					kind: 'transfer',
					from_account: {
						source: intent.from_account.source,
						name: intent.from_account.name,
						currency: intent.from_account.currency,
						kind: intent.from_account.kind,
					},
					to_account: {
						source: intent.to_account.source,
						name: intent.to_account.name,
						currency: intent.to_account.currency,
						kind: intent.to_account.kind,
					},
					amount: intent.amount,
					currency: intent.currency,
					note: intent.note,
					ts: intent.ts,
				},
				{ ledger, nowFn },
			);

			const summary = `Перевод: ${intent.amount} ${intent.currency} из «${intent.from_account.name}» → «${intent.to_account.name}»`;

			// Обновляем watermark idle-нуджа после успешного ввода (блокер #8).
			if (deps.financeStateDir) {
				writeLastInputTs(deps.financeStateDir, nowFn().toISOString());
			}

			return {
				intent,
				summary,
				balances: result.balances,
				queryContext: null,
				goalPage: null,
				chartPngSent: false,
				pendingCashHandled: false,
			};
		}

		// ── Создание нового кредита (первый CreditRecord-снапшот) ─────────────
		case 'create_credit': {
			// Составляем текущий момент (используем ts из intent или nowFn).
			const nowIso = intent.ts ?? nowFn().toISOString();

			// Первоначальный баланс кредита: либо явно задан, либо равен principal.
			const initialBalance = intent.balance ?? intent.principal;

			// Строим CreditRecord для первого снапшота кредита.
			// Поле source = 'manual' (ввод диалогом; ADR-0018 тир 4).
			// Поле type в CreditRecord называется type — маппим из credit_type.
			const creditRecord = {
				id: intent.credit_id,
				source: 'manual',
				principal: intent.principal,
				currency: intent.currency,
				...(intent.rate_pct !== undefined ? { rate_pct: intent.rate_pct } : {}),
				balance: initialBalance,
				balance_ts: nowIso,
				manual: true,
				...(intent.monthly_payment !== undefined ? { monthly_payment: intent.monthly_payment } : {}),
				...(intent.next_payment_date !== undefined ? { next_payment_date: intent.next_payment_date } : {}),
				...(intent.payment_day !== undefined ? { payment_day: intent.payment_day } : {}),
				...(intent.credit_type !== undefined ? { type: intent.credit_type } : {}),
			};

			// Валидируем перед записью через CreditRecordSchema (path-guard — в Ledger).
			const validated = CreditRecordSchema.safeParse(creditRecord);
			if (!validated.success) {
				// Невалидная запись — логируем и не пишем (не роняем ход).
				log.warn(
					{ errors: validated.error.errors, credit_id: intent.credit_id },
					'finance-intent: невалидный CreditRecord при create_credit',
				);
				const summary = `Ошибка создания кредита «${intent.credit_id}»: невалидные данные`;
				return {
					intent,
					summary,
					balances: [],
					queryContext: null,
					goalPage: null,
					chartPngSent: false,
					pendingCashHandled: false,
				};
			}

			// Записываем первый снапшот кредита в credits.jsonl.
			// Ledger.append применяет path-guard (запись только в приватный репо).
			ledger.append('credits', validated.data);

			log.info(
				{ credit_id: intent.credit_id, balance: initialBalance, currency: intent.currency },
				'finance-intent: создан новый кредит (первый снапшот записан в credits.jsonl)',
			);

			// Обновляем watermark idle-нуджа (ввод = активность).
			if (deps.financeStateDir) {
				writeLastInputTs(deps.financeStateDir, nowIso);
			}

			const creditSummary = [
				`Создан кредит «${intent.label}» (${intent.credit_id})`,
				`Сумма: ${intent.principal} ${intent.currency}`,
				...(intent.rate_pct !== undefined ? [`Ставка: ${intent.rate_pct}% годовых`] : []),
				...(intent.monthly_payment !== undefined ? [`Платёж: ${intent.monthly_payment} ${intent.currency}/мес`] : []),
				...(intent.next_payment_date !== undefined ? [`Следующий платёж: ${intent.next_payment_date.slice(0, 10)}`] : []),
				...(intent.payment_day !== undefined ? [`День платежа: ${intent.payment_day}`] : []),
			].join('\n');

			return {
				intent,
				summary: creditSummary,
				balances: [],
				queryContext: null,
				goalPage: null,
				chartPngSent: false,
				pendingCashHandled: false,
			};
		}

		// ── Query: чтение и агрегация данных (без записи) ────────────────────
		case 'query': {
			// Пробрасываем goalsDir и fx из deps, чтобы buildQueryContext мог прочитать
			// страницу цели и вызвать computeGoalProgress с реальными данными.
			const queryContext = await buildQueryContext(intent, ledger, nowFn, deps.goalsDir, deps.fx);
			const summary = formatQuerySummaryLine(intent);

			// ── Реактивная доставка графика (#6/#9) ──────────────────────────────
			// При уместных query-запросах строим PNG-график из агрегатов и отправляем
			// через sendPhoto. «Уместность» определяется query_kind:
			//   net_worth / summary → balances_snapshot (bar/pie счетов)
			//   spending            → expense_by_category (pie категорий)
			//   goal_progress       → goal_progress (progress-bar)
			// Снапшот-графики доступны всегда (без оси времени, без FX).
			// Query-режим НИЧЕГО не пишет в леджер — только читает.
			const chartPngSent = await tryDeliverChart(intent, queryContext, deps);

			return {
				intent,
				summary,
				balances: [],
				queryContext,
				goalPage: null,
				chartPngSent,
				pendingCashHandled: false,
			};
		}

		default: {
			// Исчерпывающий switch — TypeScript покажет ошибку если новый тип не обработан.
			const exhaustive: never = intent;
			throw new Error(`dispatchFinanceIntent: неизвестный тип интента ${String((exhaustive as FinanceIntent).type)}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Вспомогательная функция: pending-cash обработка входящего числа
// ---------------------------------------------------------------------------

/**
 * tryHandlePendingCashAnswer — проверяет, является ли входящее сообщение ответом
 * на pending cash survey (владелец отвечает числом на вопрос «сколько наличных?»).
 *
 * Используется точкой входа бриджа ДО попытки извлечь finance-intent из ответа движка:
 * если financeStateDir задан и есть активный маркер, а текст сообщения — одно число,
 * диспетчер сразу создаёт record_cash intent и запускает dispatch.
 *
 * Это позволяет C1 поставить маркер через writePendingCashSurvey, а C3 (этот файл)
 * его «подхватить» без round-trip через LLM-движок.
 *
 * @param rawText — текст входящего сообщения от владельца
 * @param financeStateDir — каталог состояния (finance-state.ts)
 * @returns Распознанный PendingCashSurvey + число или null (не pending-ответ)
 */
export function tryParsePendingCashAnswer(
	rawText: string,
	financeStateDir: string,
): { survey: PendingCashSurvey; amount: number } | null {
	// Проверяем наличие активного маркера опроса.
	const survey = readPendingCashSurvey(financeStateDir);
	if (!survey) {
		// Нет активного опроса — это обычное сообщение.
		return null;
	}

	// Проверяем, что текст — одно конечное число (и ничего лишнего).
	// Допускаем пробелы, запятые вместо точек (локали), знак + опционально.
	const trimmed = rawText.trim().replace(/\s/g, '').replace(',', '.');
	// Пустая строка после trim → не число (Number('') = 0 что было бы false-positive).
	if (!trimmed) {
		return null;
	}
	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed) || parsed < 0) {
		// Текст не является корректным числом — это не cash-ответ.
		return null;
	}

	return { survey, amount: parsed };
}

// ---------------------------------------------------------------------------
// Реактивная доставка PNG-графика при query-интентах (#6/#9)
// ---------------------------------------------------------------------------

/**
 * tryDeliverChart — строит уместный PNG-график и отправляет через sendPhoto.
 *
 * Вызывается только для query-интентов. Best-effort: ошибка отправки логируется,
 * но не пробрасывается (текстовый readback дойдёт в любом случае).
 *
 * Secret-gate (ADR-0011): caption строится из огрублённых данных.
 * Точные числа в caption не выносятся — только аппроксимация.
 *
 * @param intent      — QueryIntent (проверяем query_kind для выбора вида графика)
 * @param context     — QueryContext с агрегатами из buildQueryContext
 * @param deps        — зависимости (telegramClient, ownerChatId)
 * @returns true если PNG успешно отправлен, false иначе
 */
async function tryDeliverChart(
	intent: z.infer<typeof QueryIntentSchema>,
	context: QueryContext,
	deps: FinanceIntentDeps,
): Promise<boolean> {
	// Транспорт не задан или чат не известен — пропускаем (graceful, CLI/тест режим).
	if (!deps.telegramClient || !deps.ownerChatId) {
		return false;
	}

	const tg = deps.telegramClient;
	const chatId = deps.ownerChatId;

	try {
		// Выбираем вид графика и строим данные по query_kind.
		// Снапшот-графики (без оси времени) доступны всегда — без FX, без истории.
		let pngBuffer: Buffer | null = null;
		let caption = '';
		let filename = 'chart.png';

		switch (intent.query_kind) {
			case 'net_worth':
			case 'summary': {
				// Балансы счетов по валютам → balances_snapshot (bar/pie).
				// Строим BalanceEntry[] из QueryContext.balanceSummaries.
				const entries: BalanceEntry[] = context.balanceSummaries.map((b) => ({
					label: b.currency,
					value: b.total,
					currency: b.currency,
				}));
				if (entries.length > 0) {
					const spec = chartSpec({ kind: 'balances_snapshot', entries });
					pngBuffer = renderChartPng(spec);
					// Caption: огрублённые суммы (secret-gate ADR-0011).
					const capParts = context.balanceSummaries.map(
						(b) => `~${roughenAmount(b.total)} ${b.currency}`,
					);
					caption = `Балансы: ${capParts.join(', ')}`;
					filename = 'balances.png';
				}
				break;
			}
			case 'spending': {
				// Расходы по категориям → expense_by_category (pie).
				if (context.spendingByCategory.length > 0) {
					// Определяем доминирующую валюту (первую по объёму).
					const dominantCurrency = context.spendingByCategory[0]!.currency;
					const entries: CategoryEntry[] = context.spendingByCategory.map((s) => ({
						category: s.category,
						amount: s.amount,
						currency: s.currency,
					}));
					const spec = chartSpec({
						kind: 'expense_by_category',
						entries,
						currency: dominantCurrency,
					});
					pngBuffer = renderChartPng(spec);
					caption = `Расходы по категориям${intent.category ? ` (${intent.category})` : ''}`;
					filename = 'spending.png';
				}
				break;
			}
			case 'goal_progress': {
				// Прогресс цели → goal_progress (progress-bar).
				// Используем данные из QueryContext.goalProgress.
				const gp = context.goalProgress;
				if (gp && gp.current > 0) {
					const goalData: GoalProgressData = {
						goal_id: gp.goal_id,
						label: gp.goal_id,
						current: gp.current,
						// target=0 в контексте означает «данные о цели не прочитаны» —
						// рендерим progress-placeholder, рендерер обработает gracefully.
						target: gp.target,
						currency: gp.currency === '?' ? 'RUB' : gp.currency,
						fin_kind: 'save',
					};
					const spec = chartSpec({ kind: 'goal_progress', data: goalData });
					pngBuffer = renderChartPng(spec);
					caption = `Прогресс цели ${gp.goal_id}`;
					filename = 'goal-progress.png';
				}
				break;
			}
			case 'feasibility':
				// Для feasibility нет подходящего снапшот-графика — пропускаем.
				break;
		}

		// PNG не построен (нет данных или неподходящий query_kind).
		if (!pngBuffer) {
			return false;
		}

		// Отправляем PNG через sendPhoto. Secret-gate уже применён в caption выше.
		await tg.sendPhoto(
			chatId,
			{ data: pngBuffer, filename, contentType: 'image/png' },
			{ caption },
		);

		log.info(
			{ query_kind: intent.query_kind, filename, captionLen: caption.length },
			'finance-intent: PNG-график отправлен через sendPhoto',
		);
		return true;
	} catch (err) {
		// Best-effort: ошибка отправки не роняет основной поток.
		log.warn({ err: String(err), query_kind: intent.query_kind }, 'finance-intent: ошибка отправки PNG-графика');
		return false;
	}
}

/**
 * roughenAmount — огрубляет числовую сумму до значимого порядка для caption/подписи.
 * Secret-gate (ADR-0011): в видимый текст идут приближённые значения.
 * Пример: 127456 → 130000; 1500 → 1500; 42.5 → 43.
 *
 * @param n — исходное число (может быть любым знаком)
 * @returns огрублённое число (ближайший «красивый» порядок)
 */
function roughenAmount(n: number): number {
	if (!Number.isFinite(n) || n === 0) return 0;
	const abs = Math.abs(n);
	const sign = n < 0 ? -1 : 1;
	// Для небольших чисел (< 100) округляем до целых.
	if (abs < 100) return sign * Math.round(abs);
	// Для больших — до ближайшего порядка (1 значащая цифра).
	const magnitude = Math.pow(10, Math.floor(Math.log10(abs)));
	return sign * Math.round(abs / magnitude) * magnitude;
}

// ---------------------------------------------------------------------------
// Создание страницы finance-goal (wiki/finance/goals/)
// ---------------------------------------------------------------------------

/**
 * createGoalPage — создаёт markdown-страницу типа 'finance-goal' в goalsDir.
 *
 * Формат страницы: YAML-фронтматтер (FinanceGoalSchema) + markdown-тело с
 * ОГРУБЛЁННЫМИ числами (ADR-0011 secret-gate: точные — в леджере, в вики-прозе
 * — корзинами). Если goalsDir не задан — graceful возврат null (не бросает).
 *
 * Файл называется <goal_id>.md. Если файл уже существует — не перезаписываем
 * (idempotent: create_goal повторный → возвращаем путь без записи).
 *
 * @param intent — CreateGoalIntent с параметрами цели
 * @param deps   — зависимости (goalsDir)
 */
async function createGoalPage(
	intent: z.infer<typeof CreateGoalIntentSchema>,
	deps: FinanceIntentDeps,
): Promise<{ goalId: string; filePath: string } | null> {
	const { goalsDir } = deps;

	// goalsDir не задан — пишем в лог и возвращаем null (graceful, без исключения).
	if (!goalsDir) {
		log.warn({ goalId: intent.goal_id }, 'finance-intent: goalsDir не задан, страница цели не создана');
		return null;
	}

	// Валидируем intent через FinanceGoalSchema (проверяем совместимость типов).
	const goalData: FinanceGoal = {
		id: intent.goal_id,
		type: 'finance-goal',
		target_amount: intent.target_amount,
		currency: intent.currency,
		target_date: intent.target_date,
		fin_kind: intent.fin_kind,
		priority: intent.priority,
	};

	// Проверяем schema перед записью.
	const validated = FinanceGoalSchema.safeParse(goalData);
	if (!validated.success) {
		log.warn({ errors: validated.error.errors, goalId: intent.goal_id }, 'finance-intent: невалидный FinanceGoal');
		return null;
	}

	// Создаём каталог если нужно.
	mkdirSync(goalsDir, { recursive: true });

	const filePath = join(goalsDir, `${intent.goal_id}.md`);

	// Path-guard (критический, ADR-0011/ADR-0018): проверяем, что goal-страница не уедет
	// в публичный репо. publicRepoRoot берём из deps (явная инъекция) или из env.
	// Нарушение → возвращаем null (страница не создаётся, не бросаем исключение хода).
	const publicRepoRoot = deps.publicRepoRoot ?? resolvePublicRepo();
	try {
		assertPathAllowed(filePath, goalsDir, publicRepoRoot);
	} catch (pathErr) {
		log.warn(
			{ filePath, goalsDir, publicRepoRoot, err: String(pathErr) },
			'finance-intent: path-guard запретил запись goal-страницы (путь под публичным репо или вне goalsDir)',
		);
		return null;
	}

	// Идемпотентность: файл уже существует → не перезаписываем.
	if (existsSync(filePath)) {
		log.info({ filePath, goalId: intent.goal_id }, 'finance-intent: страница цели уже существует');
		return { goalId: intent.goal_id, filePath };
	}

	// Строим YAML-фронтматтер. Числа в прозе — ОГРУБЛЁННЫЕ (корзинами, ADR-0011).
	// Точные числа хранятся в леджере, в вики-прозе не выносим.
	const roughAmount = roughen(intent.target_amount);

	const frontmatter = [
		'---',
		`id: ${intent.goal_id}`,
		`type: finance-goal`,
		`target_amount: ${intent.target_amount}`,
		`currency: ${intent.currency}`,
		`target_date: ${intent.target_date}`,
		`fin_kind: ${intent.fin_kind}`,
		...(intent.priority !== undefined ? [`priority: ${intent.priority}`] : []),
		'---',
	].join('\n');

	// Тело с огрублёнными числами (вики-проза).
	const body = [
		'',
		`# ${intent.title}`,
		'',
		`Вид цели: **${goalKindRu(intent.fin_kind)}**`,
		`Целевая сумма: ~${roughAmount} ${intent.currency}`,
		`Целевая дата: ${intent.target_date}`,
		'',
		'## Прогресс',
		'',
		'_Прогресс вычисляется автоматически из леджера._',
		'',
	].join('\n');

	// Записываем файл.
	const content = frontmatter + body;
	appendFileSync(filePath, content, { encoding: 'utf8', flag: 'w' });

	log.info({ filePath, goalId: intent.goal_id }, 'finance-intent: создана страница цели');
	return { goalId: intent.goal_id, filePath };
}

/**
 * roughen — огрубляет число до значимого порядка (ADR-0011 secret-gate).
 * Точные числа хранятся в леджере; в вики-прозе показываем корзины.
 * Например: 123456 → ~120000, 5000 → ~5000, 300 → ~300.
 */
function roughen(n: number): string {
	if (n <= 0) return String(Math.round(n));
	const magnitude = Math.pow(10, Math.floor(Math.log10(n)));
	const rounded = Math.round(n / magnitude) * magnitude;
	return String(rounded);
}

/**
 * goalKindRu — человекочитаемое название fin_kind на русском.
 */
function goalKindRu(kind: FinanceGoal['fin_kind']): string {
	const names: Record<FinanceGoal['fin_kind'], string> = {
		save: 'накопление',
		spend_cap: 'потолок расходов',
		debt_paydown: 'погашение долга',
		grow: 'рост активов',
	};
	return names[kind] ?? kind;
}

// ---------------------------------------------------------------------------
// Вспомогательные функции парсинга
// ---------------------------------------------------------------------------

/**
 * normalizeYamlDates — нормализует объект из js-yaml: заменяет все Date-объекты
 * на ISO-строки (toISOString()), рекурсивно обходя поля.
 *
 * Проблема: js-yaml по умолчанию конвертирует голые YAML-даты (2026-12-31) в объекты
 * Date. FinanceGoalSchema ожидает строку (isoTimestamp = z.string()). Без нормализации
 * safeParse падает с ошибкой типа.
 *
 * Обходит только plain-объекты и массивы — не трогает примитивы и null.
 *
 * @param value — произвольное значение из yaml.load()
 * @returns нормализованное значение с Date → ISO-string
 */
function normalizeYamlDates(value: unknown): unknown {
	// Date → ISO-строка (убираем миллисекунды для краткости: "2026-12-31T00:00:00Z").
	if (value instanceof Date) {
		return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
	}
	// Массив — рекурсивно обходим элементы.
	if (Array.isArray(value)) {
		return value.map(normalizeYamlDates);
	}
	// Plain-объект — рекурсивно обходим поля.
	if (value !== null && typeof value === 'object') {
		const result: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
			result[key] = normalizeYamlDates(val);
		}
		return result;
	}
	// Примитивы (string, number, boolean, null) — возвращаем как есть.
	return value;
}

// ---------------------------------------------------------------------------
// Агрегация данных для query-интентов
// ---------------------------------------------------------------------------

/**
 * buildQueryContext — читает данные из леджера и строит QueryContext.
 *
 * Query-интент НИЧЕГО не пишет в леджер — только читает.
 * Это детерминированная read-only операция.
 *
 * Для 'net_worth': читает все снапшоты и кредиты, агрегирует по валютам.
 * Для 'spending': фильтрует транзакции по периоду/категории.
 * Для 'summary': собирает балансы всех счетов.
 * Для 'goal_progress': читает страницу цели из goalsDir, собирает снапшоты,
 *   вызывает computeGoalProgress → реальные {current, target, pct, currency}.
 *
 * @param intent    — QueryIntent с параметрами запроса
 * @param ledger    — Ledger для чтения (без записи)
 * @param nowFn     — функция текущего времени
 * @param goalsDir  — каталог страниц finance-goal (опц.; graceful если не задан)
 * @param fxInput   — провайдер курсов валют (опц.; дефолт — createDefaultFxProvider())
 */
async function buildQueryContext(
	intent: z.infer<typeof QueryIntentSchema>,
	ledger: Ledger,
	nowFn: () => Date,
	goalsDir?: string,
	fxInput?: FxProvider,
): Promise<QueryContext> {
	// Читаем все данные из леджера (read-only, append-only гарантирован леджером).
	const snapshots = ledger.readAll('snapshots');
	const transactions = ledger.readAll('transactions');
	const credits = ledger.readAll('credits');

	// Нормализуем asOf до ISO без миллисекунд (как в ledger.ts nowIsoLocal):
	// снапшоты хранятся без миллисекунд ("...Z" without ".000"), поэтому
	// "2026-06-23T10:00:00Z" > "2026-06-23T10:00:00.000Z" лексикографически (Z=90 > .=46).
	// Чтобы избежать ложного skip'а — обрезаем до секунды.
	const asOf = nowFn().toISOString().replace(/\.\d{3}Z$/, 'Z');

	// ── Агрегация балансов по счетам ─────────────────────────────────────────
	// Для каждого account_id берём последний снапшот ≤ asOf.
	// latestByAccount хранит { currency, balance, ts } для корректного сравнения.
	const latestByAccount = new Map<string, { currency: string; balance: number; ts: string }>();
	for (const snap of snapshots) {
		if (snap.ts > asOf) continue; // будущие снапшоты игнорируем
		const existing = latestByAccount.get(snap.account_id);
		if (!existing || snap.ts >= existing.ts) {
			latestByAccount.set(snap.account_id, { currency: snap.currency, balance: snap.balance, ts: snap.ts });
		}
	}

	// Суммируем балансы по нативным валютам (без конвертации — инвариант мультивалютности).
	const balanceByCurrency = new Map<string, number>();
	for (const { currency, balance } of latestByAccount.values()) {
		balanceByCurrency.set(currency, (balanceByCurrency.get(currency) ?? 0) + balance);
	}
	const balanceSummaries = Array.from(balanceByCurrency.entries()).map(([currency, total]) => ({
		currency,
		total,
	}));

	// ── Net worth (активы − кредиты) по нативным валютам ─────────────────────
	const netWorthPerCurrency: Record<string, number> = {};
	for (const [currency, total] of balanceByCurrency) {
		netWorthPerCurrency[currency] = total;
	}
	// Вычитаем обязательства по кредитам (последний balance_ts ≤ asOf по каждому кредиту).
	const latestCredits = new Map<string, { currency: string; balance: number; balance_ts: string }>();
	for (const credit of credits) {
		if (credit.balance_ts > asOf) continue;
		const existing = latestCredits.get(credit.id);
		if (!existing || credit.balance_ts >= existing.balance_ts) {
			latestCredits.set(credit.id, { currency: credit.currency, balance: credit.balance, balance_ts: credit.balance_ts });
		}
	}
	for (const { currency, balance } of latestCredits.values()) {
		netWorthPerCurrency[currency] = (netWorthPerCurrency[currency] ?? 0) - balance;
	}

	// ── Агрегация трат по категориям (для query_kind='spending') ─────────────
	const spendingByCategory: Array<{ category: string; currency: string; amount: number }> = [];
	if (intent.query_kind === 'spending' || intent.query_kind === 'summary') {
		// Фильтруем транзакции по периоду и категории.
		const filtered = transactions.filter((tx) => {
			// Только расходы (direction:'out'), исключаем внутренние переводы.
			if (tx.direction !== 'out' || tx.transfer_id) return false;
			if (intent.period_start && tx.ts < intent.period_start) return false;
			if (intent.period_end && tx.ts >= intent.period_end) return false;
			if (intent.category && tx.category !== intent.category) return false;
			return true;
		});

		// Суммируем по (category, currency).
		// Ключ формата "category|currency" для группировки.
		const catMap = new Map<string, number>();
		for (const tx of filtered) {
			const key = `${tx.category ?? 'без категории'}|${tx.currency}`;
			catMap.set(key, (catMap.get(key) ?? 0) + tx.amount);
		}
		for (const [key, amount] of catMap) {
			// Сплит ключа: первая часть — категория, вторая — валюта.
			const parts = key.split('|');
			const category = parts[0] ?? 'без категории';
			const currency = parts[1] ?? 'RUB';
			spendingByCategory.push({ category, currency, amount });
		}
	}

	// ── Прогресс по цели (для query_kind='goal_progress') ────────────────────
	//
	// Алгоритм (полный, детерминированный):
	//   1. Если задан goal_id и goalsDir — читаем файл {goalsDir}/{goal_id}.md,
	//      парсим YAML-фронтматтер, валидируем через FinanceGoalSchema.
	//   2. Собираем релевантные снапшоты (все, если нет linked_accounts — они
	//      будут отфильтрованы самим computeGoalProgress). Для debt_paydown —
	//      снапшоты linked_accounts (кредитные счета) тоже учитываются.
	//   3. Вызываем computeGoalProgress(goal, snapshots, fx, asOf) →
	//      { current, target, pct, currency, coarse, missing_fx }.
	//   4. Graceful: если goalsDir не задан ИЛИ файл не найден — возвращаем null
	//      (честное «цель не найдена»); если goal_id не задан — null тоже.
	//
	// Примечание: debt_paydown-цель обрабатывается через linked_accounts:
	//   linked_accounts указывают на счёт-долг, снапшоты которого дают
	//   текущий остаток, а computeGoalProgress считает прогресс корректно
	//   (progress = 1 - balance/target или balance снижается до 0).
	let goalProgress: QueryContext['goalProgress'] = null;
	if (intent.query_kind === 'goal_progress' && intent.goal_id) {
		const goalId = intent.goal_id;

		// Пытаемся прочитать страницу цели из goalsDir.
		let parsedGoal: FinanceGoal | null = null;
		if (goalsDir) {
			const goalFilePath = join(goalsDir, `${goalId}.md`);
			try {
				// Читаем markdown-файл и извлекаем YAML-фронтматтер.
				// Формат: ---\n{yaml}\n---\n{markdown body}.
				const fileContent = readFileSync(goalFilePath, 'utf8');
				const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fileContent);
				if (fmMatch?.[1]) {
					// Парсим YAML-фронтматтер через js-yaml (тот же способ, что пишет createGoalPage).
					// ВАЖНО: js-yaml автоматически конвертирует голые даты YAML (напр. 2026-12-31)
					// в объекты Date. FinanceGoalSchema ожидает строку (isoTimestamp = z.string()).
					// Нормализуем: все Date-объекты в полях заменяем на ISO-строку (.toISOString()).
					const rawFm = normalizeYamlDates(yaml.load(fmMatch[1]));
					const validated = FinanceGoalSchema.safeParse(rawFm);
					if (validated.success) {
						parsedGoal = validated.data;
					} else {
						log.warn(
							{ goalId, errors: validated.error.errors },
							'finance-intent: невалидный фронтматтер страницы цели',
						);
					}
				} else {
					log.warn(
						{ goalId, goalFilePath },
						'finance-intent: файл цели не содержит YAML-фронтматтера',
					);
				}
			} catch (readErr) {
				// Файл не найден или не читается — graceful: цель не найдена.
				log.warn(
					{ goalId, goalFilePath, err: String(readErr) },
					'finance-intent: страница цели не найдена в goalsDir',
				);
			}
		}

		if (parsedGoal !== null) {
			// Страница цели прочитана — вызываем детерминированный computeGoalProgress.
			// FxProvider: используем переданный или создаём дефолтный (Identity + Stablecoin + CBR).
			// В тестах всегда передаётся мок-провайдер без реальной сети.
			const fx = fxInput ?? createDefaultFxProvider();

			// Передаём ВСЕ снапшоты — computeGoalProgress сам фильтрует по linked_accounts.
			// Если linked_accounts не заданы (режим goal_tag) — передаём транзакционные снапшоты:
			// в режиме goal_tag computeGoalProgress ожидает, что caller уже отфильтровал снапшоты.
			// Здесь мы не знаем, какие именно счета (нет goal_tag в SnapshotRecord), поэтому:
			//   — если linked_accounts заданы → все снапшоты (computeGoalProgress отфильтрует)
			//   — если linked_accounts не заданы → передаём пустой массив (нет автосвязки)
			//     плюс синтетические «снапшоты» из транзакций с goal_tag (накоплена сумма).
			let relevantSnapshots = snapshots;
			if (!parsedGoal.linked_accounts || parsedGoal.linked_accounts.length === 0) {
				// Нет привязанных счетов — строим синтетический снапшот из суммы транзакций
				// с goal_tag, чтобы computeGoalProgress получил хотя бы текущую накопленную сумму.
				const goalTxs = transactions.filter(
					(tx) => tx.goal_tag === goalId && tx.direction === 'in' && tx.ts <= asOf,
				);
				const totalFromTxs = goalTxs.reduce((sum, tx) => sum + tx.amount, 0);
				// Синтетический снапшот с суммой транзакций, помечен как virtual-account.
				relevantSnapshots = totalFromTxs > 0
					? [{
						ts: asOf,
						account_id: `__goal_tag_${goalId}__`,
						balance: totalFromTxs,
						currency: parsedGoal.currency,
					}]
					: [];
			}

			try {
				// Вызываем готовый детерминированный движок расчёта прогресса.
				const progress = await computeGoalProgress(parsedGoal, relevantSnapshots, fx, asOf);
				goalProgress = {
					goal_id: goalId,
					current: progress.current,
					target: progress.target,
					pct: progress.pct,
					currency: progress.currency,
				};
			} catch (computeErr) {
				// computeGoalProgress никогда не должен бросать, но на всякий случай — graceful.
				log.warn(
					{ goalId, err: String(computeErr) },
					'finance-intent: ошибка computeGoalProgress — возвращаем null',
				);
				// goalProgress остаётся null
			}
		}
		// Если parsedGoal === null (goalsDir не задан или файл не найден):
		// goalProgress = null — честное «цель не найдена», без фолбэка-фантома.
	}

	// ── Дискреционный бюджет (для query_kind='feasibility') ──────────────────
	let discretionaryInfo: string | null = null;
	if (intent.query_kind === 'feasibility' && intent.amount !== undefined) {
		// Простая эвристика: смотрим на баланс запрошенной валюты.
		const requestedCurrency = intent.currency ?? 'RUB';
		const availableBalance = netWorthPerCurrency[requestedCurrency] ?? 0;
		const canAfford = availableBalance >= intent.amount;
		discretionaryInfo = canAfford
			? `Баланс в ${requestedCurrency}: ${availableBalance} — на ${intent.amount} ${requestedCurrency} хватает.`
			: `Баланс в ${requestedCurrency}: ${availableBalance} — на ${intent.amount} ${requestedCurrency} не хватает (нехватка ${intent.amount - availableBalance}).`;
	}

	return {
		balanceSummaries,
		netWorthPerCurrency,
		spendingByCategory,
		goalProgress,
		discretionaryInfo,
	};
}

/**
 * formatQuerySummaryLine — краткая строка для поля summary query-результата.
 */
function formatQuerySummaryLine(intent: z.infer<typeof QueryIntentSchema>): string {
	switch (intent.query_kind) {
		case 'net_worth': return 'Запрос: чистый капитал';
		case 'spending': return `Запрос: траты${intent.category ? ` (${intent.category})` : ''}${intent.period_start ? ` с ${intent.period_start.slice(0, 10)}` : ''}`;
		case 'goal_progress': return `Запрос: прогресс цели${intent.goal_id ? ` ${intent.goal_id}` : ''}`;
		case 'feasibility': return `Запрос: могу ли позволить${intent.amount ? ` ${intent.amount} ${intent.currency ?? ''}` : ''}`;
		case 'summary': return 'Запрос: финансовая сводка';
		default: return 'Запрос: финансовые данные';
	}
}

// ---------------------------------------------------------------------------
// Форматирование читбэка (детерминированный текст для Telegram)
// ---------------------------------------------------------------------------

/**
 * formatReadback — детерминированный текст подтверждения для Telegram.
 *
 * LLM здесь НЕ нужен: строим ответ из структурных полей DispatchResult.
 * Это тонкий адаптер (Telegram-I/O слой); арифметика — в чистых функциях выше.
 *
 * Принципы:
 *   - Краткость: 2–5 строк.
 *   - Балансы: нативные валюты через «/» без конвертации (инвариант).
 *   - Числа огрублены только в вики-прозе (goals); здесь — точные (readback).
 *   - Нет PII: только имя счёта и суммы.
 *
 * @param result — структурный результат из dispatchFinanceIntent
 */
export function formatReadback(result: DispatchResult): string {
	const lines: string[] = [];

	// Первая строка: краткое действие.
	lines.push(result.summary);

	// Для batch-интента: показываем итоговые балансы ВСЕХ затронутых счетов —
	// владелец должен видеть, что учтены ВСЕ счета из батча.
	// Балансы уже агрегированы в dispatchFinanceIntent case 'batch'.
	if (result.intent.type === 'batch' && result.balances.length > 0) {
		// Выводим каждый счёт на отдельной строке для наглядности.
		for (const b of result.balances) {
			lines.push(`  • ${b.balance} ${b.currency} (счёт ${b.account_id.slice(0, 8)}…)`);
		}
	}

	// Для обычных record-интентов: показываем текущие балансы по счетам.
	if (result.intent.type !== 'batch' && result.balances.length > 0) {
		const balStr = result.balances
			.map((b) => `${b.balance} ${b.currency}`)
			.join(' / ');
		lines.push(`Баланс: ${balStr}`);
	}

	// Для create_goal: подтверждение создания страницы.
	if (result.goalPage) {
		lines.push(`Создана страница цели: ${result.goalPage.goalId}.md`);
	}

	// Для query: показываем контекст (детерминированно из агрегатов).
	if (result.queryContext) {
		const ctx = result.queryContext;

		// Net-worth по нативным валютам.
		const nwParts = Object.entries(ctx.netWorthPerCurrency)
			.filter(([, v]) => v !== 0)
			.map(([cur, val]) => `${val >= 0 ? '+' : ''}${Math.round(val)} ${cur}`)
			.join(', ');
		if (nwParts) {
			lines.push(`Чистый капитал: ${nwParts}`);
		}

		// Балансы по валютам.
		if (ctx.balanceSummaries.length > 0) {
			const balStr = ctx.balanceSummaries
				.map((b) => `${b.total} ${b.currency}`)
				.join(' / ');
			lines.push(`Балансы: ${balStr}`);
		}

		// Траты по категориям.
		if (ctx.spendingByCategory.length > 0) {
			const topN = ctx.spendingByCategory.slice(0, 5);
			const spendStr = topN.map((s) => `${s.category}: ${s.amount} ${s.currency}`).join(', ');
			lines.push(`Траты: ${spendStr}`);
		}

		// Прогресс по цели — показываем реальные target/pct если они получены
		// из computeGoalProgress (target > 0), иначе только текущую сумму.
		if (ctx.goalProgress) {
			const gp = ctx.goalProgress;
			if (gp.current > 0 || gp.target > 0) {
				if (gp.target > 0) {
					// Полный прогресс: текущее / целевое = X%.
					const pctStr = `${Math.round(gp.pct)}%`;
					lines.push(
						`Цель ${gp.goal_id}: ${gp.current} / ${gp.target} ${gp.currency} (${pctStr})`,
					);
				} else {
					// Фолбэк: target не известен (не должно происходить после исправления,
					// но защищаемся на случай graceful-ситуации).
					lines.push(
						`Цель ${gp.goal_id}: накоплено ${gp.current} ${gp.currency}`,
					);
				}
			}
		}

		// Feasibility.
		if (ctx.discretionaryInfo) {
			lines.push(ctx.discretionaryInfo);
		}
	}

	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Пред-расчёт финансового контекста для query-режима движка
// ---------------------------------------------------------------------------

/**
 * buildFinanceContextSummary — собирает детерминированный финансовый контекст
 * для подачи движку в системный промпт (query-режим).
 *
 * Вызывается ПЕРЕД запуском движка: бридж читает балансы, net-worth и прогресс
 * целей из леджера и передаёт краткую сводку в --append-system-prompt.
 * Движок использует эти данные для ответов на «сколько потратил», «могу ли позволить».
 *
 * Query-режим НИЧЕГО не пишет в леджер (read-only).
 *
 * Если леджер пустой или недоступен — возвращает null (безопасно: движок отвечает
 * из общих знаний без контекста).
 *
 * @param ledger   — Ledger (read-only)
 * @param goalsDir — каталог страниц finance-goal (опц.; если задан и существует —
 *                   добавляет секцию «Активные цели:» с goal_id/title/target/дата).
 *                   Без goalsDir поведение как раньше — секция целей не добавляется.
 *                   Это устраняет дефект 2: движок не знал goal_id и падал в feasibility
 *                   вместо корректного emit goal_progress при живом прогоне.
 * @param nowFn    — функция текущего времени
 */
export function buildFinanceContextSummary(
	ledger: Ledger,
	goalsDir?: string,
	nowFn: () => Date = () => new Date(),
): string | null {
	try {
		const snapshots = ledger.readAll('snapshots');
		const credits = ledger.readAll('credits');
		const transactions = ledger.readAll('transactions');

		if (snapshots.length === 0 && credits.length === 0) {
			// Пустой леджер — контекст не нужен.
			return null;
		}

		// Нормализуем до ISO без миллисекунд (аналогично buildQueryContext выше).
		const asOf = nowFn().toISOString().replace(/\.\d{3}Z$/, 'Z');

		// ── Словарь счетов: account_id → {name, kind} ────────────────────────────
		// Читаем AccountRecord'ы один раз; дедупируем: если один id встречается
		// дважды (повторная запись при обновлении name) — берём последнюю запись
		// (JSONL append-only, последняя в файле актуальнее).
		const accounts = ledger.readAll('accounts');
		const accountMeta = new Map<string, { name: string; kind: AccountRecord['kind'] }>();
		for (const acc of accounts) {
			// Перетираем — последняя запись в файле побеждает (append-only семантика).
			accountMeta.set(acc.id, { name: acc.name, kind: acc.kind });
		}

		// Агрегируем балансы по нативным валютам (последний снапшот ≤ asOf).
		const latestByAccount = new Map<string, { currency: string; balance: number; ts: string }>();
		for (const snap of snapshots) {
			if (snap.ts > asOf) continue;
			const existing = latestByAccount.get(snap.account_id);
			if (!existing || snap.ts >= existing.ts) {
				latestByAccount.set(snap.account_id, { currency: snap.currency, balance: snap.balance, ts: snap.ts });
			}
		}

		const balByCurrency = new Map<string, number>();
		for (const { currency, balance } of latestByAccount.values()) {
			balByCurrency.set(currency, (balByCurrency.get(currency) ?? 0) + balance);
		}

		// Кредиты (обязательства).
		const latestCredits = new Map<string, { currency: string; balance: number; balance_ts: string }>();
		for (const credit of credits) {
			if (credit.balance_ts > asOf) continue;
			const existing = latestCredits.get(credit.id);
			if (!existing || credit.balance_ts >= existing.balance_ts) {
				latestCredits.set(credit.id, { currency: credit.currency, balance: credit.balance, balance_ts: credit.balance_ts });
			}
		}

		// Net-worth: активы − кредиты.
		const nw: Record<string, number> = {};
		for (const [currency, total] of balByCurrency) {
			nw[currency] = total;
		}
		for (const { currency, balance } of latestCredits.values()) {
			nw[currency] = (nw[currency] ?? 0) - balance;
		}

		// Текущий месяц — траты за месяц по категориям (топ 5).
		const monthStart = asOf.slice(0, 7) + '-01T00:00:00Z';
		const monthlySpend = transactions.filter(
			(tx) => tx.direction === 'out' && !tx.transfer_id && tx.ts >= monthStart && tx.ts <= asOf,
		);
		const spendByCat = new Map<string, { amount: number; currency: string }>();
		for (const tx of monthlySpend) {
			const cat = tx.category ?? 'прочее';
			const key = `${cat}|${tx.currency}`;
			const prev = spendByCat.get(key) ?? { amount: 0, currency: tx.currency };
			spendByCat.set(key, { amount: prev.amount + tx.amount, currency: tx.currency });
		}
		const topSpend = Array.from(spendByCat.entries())
			.map(([key, val]) => ({ cat: key.split('|')[0] ?? 'прочее', ...val }))
			.sort((a, b) => b.amount - a.amount)
			.slice(0, 5);

		// Строим сводку (plain-text, без markdown — Telegram без parse_mode).
		const lines: string[] = ['[Финансовый контекст (автоматически, актуально на сейчас)]'];

		// ── Секция «Счета:» — перечень КАЖДОГО счёта по имени (fix дефекта S7) ───
		// Движок ОБЯЗАН переиспользовать точное имя счёта из этого списка — не
		// выдумывать новое (именно это приводило к созданию дубля «Кошелёк RUB»).
		// Формат: «Счета: Тинькофф (checking, RUB) = 50000; Наличные VND (cash, VND) = 5000000».
		// Отображаем только счета с известным балансом ≤ asOf.
		if (latestByAccount.size > 0) {
			const accountParts: string[] = [];
			for (const [accountId, { currency, balance }] of latestByAccount.entries()) {
				const meta = accountMeta.get(accountId);
				if (meta) {
					// Счёт найден в AccountRecord — показываем имя + kind + валюта + баланс.
					accountParts.push(`${meta.name} (${meta.kind}, ${currency}) = ${balance}`);
				} else {
					// AccountRecord не найден (аномалия) — показываем обрезанный id.
					accountParts.push(`account:${accountId.slice(0, 8)} (${currency}) = ${balance}`);
				}
			}
			lines.push(`Счета: ${accountParts.join('; ')}`);
		}

		if (balByCurrency.size > 0) {
			const balStr = Array.from(balByCurrency.entries())
				.map(([cur, val]) => `${val} ${cur}`)
				.join(', ');
			lines.push(`Балансы счетов: ${balStr}`);
		}

		const nwParts = Object.entries(nw)
			.filter(([, v]) => v !== 0)
			.map(([cur, val]) => `${val >= 0 ? '+' : ''}${Math.round(val)} ${cur}`);
		if (nwParts.length > 0) {
			lines.push(`Чистый капитал (net worth): ${nwParts.join(', ')}`);
		}

		if (latestCredits.size > 0) {
			// ── Секция «Кредиты:» — перечень активных кредитов с id ──────────────
			// Движок должен знать credit_id для корректного emit balance_update_credit
			// (иначе выдумывает id — приводит к созданию дублей кредитов).
			// Формат: «Кредиты: sber-2026 (RUB) = 600000; card-alfa (RUB) = 42000».
			const creditParts: string[] = [];
			for (const [creditId, { currency, balance }] of latestCredits.entries()) {
				creditParts.push(`${creditId} (${currency}) = ${balance}`);
			}
			lines.push(`Кредиты: ${creditParts.join('; ')}`);
		}

		if (topSpend.length > 0) {
			const spendStr = topSpend.map((s) => `${s.cat} ${s.amount} ${s.currency}`).join(', ');
			lines.push(`Траты за текущий месяц: ${spendStr}`);
		}

		// ── Активные цели (дефект 2) ──────────────────────────────────────────
		// Без секции целей движок не знал goal_id и не мог корректно эмитировать
		// query/goal_progress — в живом прогоне сваливался в feasibility.
		// Читаем страницы *.md из goalsDir, парсим фронтматтер (FinanceGoalSchema),
		// добавляем строки вида «- <goal_id>: <title>, цель <target_amount> <currency> к <target_date>».
		if (goalsDir) {
			try {
				// Проверяем что каталог существует — existsSync не бросает.
				if (existsSync(goalsDir)) {
					// Читаем список файлов через readdirSync (синхронно, как весь метод).
					const files = readdirSync(goalsDir).filter((f) => f.endsWith('.md'));
					const goalLines: string[] = [];

					for (const file of files) {
						try {
							const filePath = join(goalsDir, file);
							const content = readFileSync(filePath, 'utf8');
							// Извлекаем YAML-фронтматтер (--- ... ---).
							const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
							if (!fmMatch?.[1]) continue;

							// Парсим и нормализуем (Date → ISO string) как в buildQueryContext.
							const rawFm = normalizeYamlDates(yaml.load(fmMatch[1]));
							const validated = FinanceGoalSchema.safeParse(rawFm);
							if (!validated.success) continue;

							const goal = validated.data;
							// Формат строки: «- <goal_id>: цель <amount> <currency> к <date>».
							// FinanceGoalSchema не содержит поля title (оно только в markdown-body),
							// поэтому используем goal_id как идентификатор — это именно то, что
							// нужно движку для корректного emit query/goal_progress (goal_id важнее title).
							goalLines.push(
								`- ${goal.id}: цель ${goal.target_amount} ${goal.currency} к ${goal.target_date.slice(0, 10)}`,
							);
						} catch {
							// Ошибка чтения/парсинга одного файла — пропускаем, продолжаем.
						}
					}

					if (goalLines.length > 0) {
						lines.push(`Активные цели:\n${goalLines.join('\n')}`);
					}
				}
			} catch (goalsErr) {
				// Ошибка чтения goalsDir — не роняем метод, контекст без секции целей.
				log.warn({ err: String(goalsErr) }, 'finance-intent: ошибка чтения goalsDir в buildFinanceContextSummary');
			}
		}

		lines.push('[/Финансовый контекст]');

		return lines.join('\n');
	} catch (err) {
		// Ошибка чтения леджера — безопасно возвращаем null (движок отвечает без контекста).
		log.warn({ err: String(err) }, 'finance-intent: ошибка при сборке финансового контекста');
		return null;
	}
}
