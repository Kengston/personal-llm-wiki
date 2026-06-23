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

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { childLogger } from '../core/logger.js';
import { assertPathAllowed, Ledger, resolvePublicRepo } from '../ingest/finance/ledger.js';
import { recordFinanceEntry } from '../ingest/finance/record.js';
import { FinanceGoalSchema, type FinanceGoal } from '../ingest/finance/types.js';

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
 */
export const FinanceIntentSchema = z.discriminatedUnion('type', [
	RecordBalanceIntentSchema,
	RecordCashIntentSchema,
	RecordIncomeIntentSchema,
	RecordExpenseIntentSchema,
	CreateGoalIntentSchema,
	EditIntentSchema,
	VoidIntentSchema,
	TransferIntentSchema,
	QueryIntentSchema,
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
 * @param intent — распарсенный FinanceIntent из extractFinanceIntent
 * @param deps   — зависимости (Ledger, nowFn, goalsDir)
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

			return {
				intent,
				summary,
				balances: result.balances,
				queryContext: null,
				goalPage: null,
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

			return {
				intent,
				summary,
				balances: result.balances,
				queryContext: null,
				goalPage: null,
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

			return {
				intent,
				summary,
				balances: result.balances,
				queryContext: null,
				goalPage: null,
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

			return {
				intent,
				summary,
				balances: result.balances,
				queryContext: null,
				goalPage: null,
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

			return {
				intent,
				summary,
				balances: result.balances,
				queryContext: null,
				goalPage: null,
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

			return {
				intent,
				summary,
				balances: result.balances,
				queryContext: null,
				goalPage: null,
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

			return {
				intent,
				summary,
				balances: result.balances,
				queryContext: null,
				goalPage: null,
			};
		}

		// ── Query: чтение и агрегация данных (без записи) ────────────────────
		case 'query': {
			const queryContext = await buildQueryContext(intent, ledger, nowFn);
			const summary = formatQuerySummaryLine(intent);

			return {
				intent,
				summary,
				balances: [],
				queryContext,
				goalPage: null,
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
 *
 * @param intent  — QueryIntent с параметрами запроса
 * @param ledger  — Ledger для чтения (без записи)
 * @param nowFn   — функция текущего времени
 */
async function buildQueryContext(
	intent: z.infer<typeof QueryIntentSchema>,
	ledger: Ledger,
	nowFn: () => Date,
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
	// Чтение финансовой цели: если goal_id задан — ищем страницу в goalsDir.
	// Прогресс считаем детерминированно: балансы linked_accounts + snapshot-агрегат.
	// Без FX-конвертации (нет провайдера в этом контексте) — грубый счёт в нативной валюте.
	let goalProgress: QueryContext['goalProgress'] = null;
	if (intent.query_kind === 'goal_progress' && intent.goal_id) {
		// Ищем транзакции с goal_tag = goal_id для подсчёта накопленного.
		const goalTxs = transactions.filter(
			(tx) => tx.goal_tag === intent.goal_id && tx.direction === 'in',
		);
		const totalSaved = goalTxs.reduce((sum, tx) => sum + tx.amount, 0);
		// Без данных о target_amount из страницы (нет доступа к goalsDir в этом контексте)
		// даём частичный результат с суммой накоплений.
		goalProgress = {
			goal_id: intent.goal_id,
			current: totalSaved,
			target: 0, // 0 = данные о цели не прочитаны (нет goalsDir в query-контексте)
			pct: 0,
			currency: '?',
		};
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

	// Для record-интентов: показываем текущие балансы по счетам.
	if (result.balances.length > 0) {
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

		// Прогресс по цели.
		if (ctx.goalProgress && ctx.goalProgress.current > 0) {
			lines.push(
				`Цель ${ctx.goalProgress.goal_id}: накоплено ${ctx.goalProgress.current} ${ctx.goalProgress.currency}`,
			);
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
 * @param ledger — Ledger (read-only)
 * @param nowFn  — функция текущего времени
 */
export function buildFinanceContextSummary(
	ledger: Ledger,
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
			const creditStr = Array.from(latestCredits.values())
				.map(({ currency, balance }) => `${balance} ${currency}`)
				.join(', ');
			lines.push(`Обязательства (кредиты): ${creditStr}`);
		}

		if (topSpend.length > 0) {
			const spendStr = topSpend.map((s) => `${s.cat} ${s.amount} ${s.currency}`).join(', ');
			lines.push(`Траты за текущий месяц: ${spendStr}`);
		}

		lines.push('[/Финансовый контекст]');

		return lines.join('\n');
	} catch (err) {
		// Ошибка чтения леджера — безопасно возвращаем null (движок отвечает без контекста).
		log.warn({ err: String(err) }, 'finance-intent: ошибка при сборке финансового контекста');
		return null;
	}
}
