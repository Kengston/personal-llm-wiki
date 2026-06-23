/**
 * credit-payment.ts — запись факта оплаты по кредиту в леджер (append-only).
 *
 * Контекст ([ADR-0018] финмодуль, [ADR-0024] реактивный dispatch):
 *   Этот модуль — ЧИСТАЯ запись платежа по кредиту. Сюда не входят транзакции
 *   общего назначения (record.ts) и чистые вычисления амортизации (credit.ts).
 *   Именно здесь: splitPayment(credit, amount) → записываем credit_payment-транзакцию
 *   + НОВЫЙ снапшот кредита (обновлённый balance/balance_ts), сдвигаем дату след.
 *   платежа на 1 период (addMonthsToIso).
 *
 * Инварианты:
 *   - Прошлый CreditRecord НЕ мутируется — append-only: новый снапшот добавляется в credits.jsonl.
 *   - Платёж может быть явным (paymentAmount) или автоматическим (scheduledPaymentAmount(credit)).
 *   - path-guard: запись ТОЛЬКО в raw/finance/ через Ledger.append.
 *   - Нет сети, нет spawn, нет фоновых процессов.
 *   - Только синтетические данные в тестах (lint:public зелёный).
 *   - Подробные комментарии на русском, в стиле src/ingest/finance/*.
 */

import { Ledger } from './ledger.js';
import {
	addMonthsToIso,
	splitPayment,
} from './credit.js';
import type { CreditRecord, TransactionRecord } from './types.js';
import { deterministicId } from './normalize.js';

// ---------------------------------------------------------------------------
// Типы зависимостей и результата
// ---------------------------------------------------------------------------

/**
 * CreditPaymentDeps — инъектируемые зависимости (позволяют мокировать в тестах).
 */
export interface CreditPaymentDeps {
	/** ledger — экземпляр Ledger для чтения и записи JSONL-файлов. */
	ledger: Ledger;
	/** nowFn — инъекция времени (дефолт: () => new Date()). */
	nowFn?: () => Date;
}

/**
 * CreditPaymentResult — структурный результат recordCreditPayment.
 *
 * Используется finance-callbacks.ts для формирования детерминированного readback'а.
 */
export interface CreditPaymentResult {
	/** credit_id — id кредита, по которому выполнен платёж. */
	credit_id: string;
	/** principal — часть платежа, погасившая тело долга. */
	principal: number;
	/** interest — часть платежа, ушедшая на проценты. */
	interest: number;
	/** paymentAmount — фактическая сумма платежа. */
	paymentAmount: number;
	/** currency — нативная валюта кредита. */
	currency: string;
	/** prevBalance — остаток долга ДО платежа. */
	prevBalance: number;
	/** newBalance — остаток долга ПОСЛЕ платежа. */
	newBalance: number;
	/** nextPaymentDate — новая дата следующего платежа (ISO-8601). */
	nextPaymentDate: string;
	/** txId — id записанной транзакции (для аудита/дедупа). */
	txId: string;
	/** creditSnapshotTs — метка времени нового снапшота кредита (ISO). */
	creditSnapshotTs: string;
}

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

/**
 * nowIso — текущий момент в ISO-8601 UTC без миллисекунд.
 * Формат: "2026-06-23T12:00:00Z". Совпадает с паттерном record.ts/normalize.ts.
 *
 * @param nowFn — инъекция источника времени
 * @returns ISO-8601 строка UTC
 */
function nowIso(nowFn: () => Date): string {
	return nowFn()
		.toISOString()
		.replace(/\.\d{3}Z$/, 'Z');
}

/**
 * scheduledPaymentAmountForCredit — плановая сумма платежа для кредита.
 *
 * Порядок приоритета (аналог credit.ts scheduledPaymentAmount, но экспортируем
 * сюда только то, что нужно для нашего модуля без дублирования):
 *   1. credit.monthly_payment (явно зафиксированная сумма)
 *   2. balance + balance * monthlyRate (закрыть всё одним платежом)
 *
 * ПРИМЕЧАНИЕ: мы переиспользуем splitPayment из credit.ts для расчёта тела/процентов.
 * Для вычисления плановой суммы вызываем scheduledPaymentAmount через import.
 * Чтобы избежать circular imports и дублирования, просто берём monthly_payment
 * или вычисляем через splitPayment с balance*(1+rate).
 *
 * @param credit — снапшот кредита
 * @returns сумма планового платежа
 */
function resolvePaymentAmount(credit: CreditRecord, paymentAmount: number | 'auto'): number {
	if (paymentAmount !== 'auto') {
		// Явная сумма — проверяем, что > 0.
		if (paymentAmount <= 0) {
			throw new Error(
				`recordCreditPayment: paymentAmount должен быть > 0, получено ${paymentAmount}`,
			);
		}
		return paymentAmount;
	}

	// 'auto' — используем monthly_payment или balance*(1+monthlyRate).
	if (credit.monthly_payment && credit.monthly_payment > 0) {
		return credit.monthly_payment;
	}

	// Fallback: один платёж закрывает весь долг (тело + проценты за месяц).
	const monthlyRate = (credit.rate_pct ?? 0) / 100 / 12;
	return credit.balance + credit.balance * monthlyRate;
}

/**
 * computeNextPaymentDate — вычисляет новую дату следующего платежа через 1 период.
 *
 * Если у кредита есть next_payment_date — сдвигаем его на 1 месяц (addMonthsToIso).
 * Иначе берём текущий nowTs и тоже сдвигаем на 1 месяц.
 * payment_day при этом не меняется — он остаётся в снапшоте (пользователь его сам задал).
 *
 * @param credit — снапшот кредита
 * @param nowTs  — текущий момент (ISO-8601)
 * @returns ISO-8601 дата следующего платежа
 */
function computeNextPaymentDate(credit: CreditRecord, nowTs: string): string {
	// Если есть зафиксированная дата — сдвигаем её на 1 месяц.
	const base = credit.next_payment_date ?? nowTs;
	return addMonthsToIso(base, 1);
}

// ---------------------------------------------------------------------------
// Главная функция
// ---------------------------------------------------------------------------

/**
 * recordCreditPayment — записывает факт оплаты по кредиту в леджер.
 *
 * Алгоритм:
 *   1. Читает актуальный CreditRecord из ledger.readAll('credits') по credit_id.
 *   2. Разрешает сумму платежа (явную или 'auto' = monthly_payment / весь долг).
 *   3. Вызывает splitPayment(credit, paymentAmount) для разбивки тело/проценты.
 *   4. Append-only:
 *      a) Записывает TransactionRecord типа credit_payment в transactions.jsonl.
 *      b) Записывает новый CreditRecord (обновлённый balance/balance_ts/next_payment_date)
 *         в credits.jsonl (прошлый НЕ мутируется).
 *   5. Сдвигает next_payment_date на 1 период (addMonthsToIso).
 *   6. Возвращает CreditPaymentResult для readback в finance-callbacks.ts.
 *
 * ГАРДЫ:
 *   - credit_id не найден → throw Error (нельзя записывать платёж по несуществующему кредиту).
 *   - credit.balance = 0 → throw Error (кредит уже погашен).
 *   - path-guard → LedgerPathError от Ledger.append (ТОЛЬКО raw/finance/).
 *
 * @param credit_id — id кредита из CreditRecord.id (ключ снапшота)
 * @param paymentAmount — сумма платежа (> 0) или 'auto' (плановый платёж)
 * @param deps — зависимости: { ledger, nowFn? }
 * @returns CreditPaymentResult — структурный результат для readback
 */
export function recordCreditPayment(
	credit_id: string,
	paymentAmount: number | 'auto',
	deps: CreditPaymentDeps,
): CreditPaymentResult {
	const { ledger } = deps;
	const nowFn = deps.nowFn ?? (() => new Date());
	const nowTs = nowIso(nowFn);

	// ── Шаг 1: читаем актуальный снапшот кредита ─────────────────────────────
	// credits.jsonl — append-only; последний снапшот по credit.id — актуальный.
	const allCredits = ledger.readAll('credits');

	// Ищем последний снапшот кредита с данным id (наибольший balance_ts).
	const creditSnapshots = allCredits.filter((c) => c.id === credit_id);
	if (creditSnapshots.length === 0) {
		throw new Error(
			`recordCreditPayment: кредит с id="${credit_id}" не найден в леджере. ` +
			'Проверьте credit_id и убедитесь, что кредит записан в credits.jsonl.',
		);
	}

	// Берём последний снапшот (max balance_ts) — он актуальный.
	const credit = creditSnapshots.reduce<CreditRecord>(
		(latest, c) => (c.balance_ts > latest.balance_ts ? c : latest),
		creditSnapshots[0]!,
	);

	// Кредит уже погашен — платёж бессмысленен.
	if (credit.balance <= 0) {
		throw new Error(
			`recordCreditPayment: кредит "${credit_id}" уже погашен (balance = ${credit.balance}). ` +
			'Платёж не записывается.',
		);
	}

	// ── Шаг 2: разрешаем сумму платежа ──────────────────────────────────────
	const resolvedAmount = resolvePaymentAmount(credit, paymentAmount);

	// ── Шаг 3: разбивка платежа на тело/проценты ────────────────────────────
	// splitPayment из credit.ts — чистая функция, нет IO.
	const { principal, interest, newBalance } = splitPayment(credit, resolvedAmount);
	const prevBalance = credit.balance;

	// ── Шаг 4a: записываем транзакцию credit_payment ───────────────────────
	// id транзакции: детерминированный хэш из компонентов (дедуп при повторе).
	const txComponents = `credit_payment|${credit_id}|${nowTs}|${resolvedAmount}|${credit.currency}`;
	const txId = deterministicId(txComponents);

	// Ищем аккаунт кредита для привязки транзакции. Если нет — используем credit_id как account_id.
	// В нашей модели кредитный счёт мог создаваться через record.ts, но мы не требуем его наличия.
	// Транзакция записывается с account_id = deterministicId(source|id|currency) — виртуальный счёт.
	const creditAccountId = deterministicId(`${credit.source}|${credit_id}|${credit.currency}`);

	const tx: TransactionRecord = {
		id: txId,
		ts: nowTs,
		// Привязываем к виртуальному счёту кредита (source|id|currency).
		account_id: creditAccountId,
		// Сумма платежа: списание (direction='out') с точки зрения кредитного счёта
		// (мы отдаём деньги банку).
		amount: resolvedAmount,
		currency: credit.currency,
		direction: 'out',
		source: 'manual',
		// Категория для фильтрации в readback / аналитике.
		category: 'credit_payment',
		// Заметка без PII: тело/проценты для аудита.
		counterparty: `credit:${credit_id} principal:${principal.toFixed(2)} interest:${interest.toFixed(2)}`,
	};

	ledger.append('transactions', tx);

	// ── Шаг 4b: записываем новый снапшот кредита ────────────────────────────
	// Прошлый CreditRecord НЕ мутируется — append-only.
	// Новый снапшот наследует все поля старого, обновляем только balance/balance_ts/next_payment_date.
	const nextPaymentDate = computeNextPaymentDate(credit, nowTs);

	const newCreditSnapshot: CreditRecord = {
		// Копируем все поля старого снапшота.
		...credit,
		// Обновляем актуальные поля.
		balance: newBalance,
		balance_ts: nowTs,
		// Сдвигаем дату следующего платежа на 1 период (addMonthsToIso).
		next_payment_date: nextPaymentDate,
	};

	ledger.append('credits', newCreditSnapshot);

	// ── Шаг 5: возвращаем структурный результат ─────────────────────────────
	return {
		credit_id,
		principal,
		interest,
		paymentAmount: resolvedAmount,
		currency: credit.currency,
		prevBalance,
		newBalance,
		nextPaymentDate,
		txId,
		creditSnapshotTs: nowTs,
	};
}
