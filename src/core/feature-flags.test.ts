/**
 * feature-flags.test.ts — `isFinanceEnabled` default-off и разбор истинных значений,
 * плюс `applyFinanceGate`: доказательство DoD «FINANCE_ENABLED по умолчанию выключен —
 * леджер не создаётся И финансовой инструкции нет в промпте» на уровне поведения
 * (сравнение итоговой строки персоны с базовой), а не разбора значения флага.
 */
import { describe, expect, it } from 'vitest';

import { applyFinanceGate, isFinanceEnabled } from './feature-flags.js';

const BASE_PERSONA = 'Ты — базовая персона без финансов.';

describe('isFinanceEnabled', () => {
	it('пустое окружение → false (default-off)', () => {
		expect(isFinanceEnabled({})).toBe(false);
	});

	it("FINANCE_ENABLED='0' → false", () => {
		expect(isFinanceEnabled({ FINANCE_ENABLED: '0' })).toBe(false);
	});

	it("FINANCE_ENABLED='false' → false", () => {
		expect(isFinanceEnabled({ FINANCE_ENABLED: 'false' })).toBe(false);
	});

	it('мусорное значение → false', () => {
		expect(isFinanceEnabled({ FINANCE_ENABLED: 'enabled-ish' })).toBe(false);
	});

	it("FINANCE_ENABLED='1' → true", () => {
		expect(isFinanceEnabled({ FINANCE_ENABLED: '1' })).toBe(true);
	});

	it("FINANCE_ENABLED='true' → true", () => {
		expect(isFinanceEnabled({ FINANCE_ENABLED: 'true' })).toBe(true);
	});

	it("FINANCE_ENABLED='YES' (регистр не важен) → true", () => {
		expect(isFinanceEnabled({ FINANCE_ENABLED: 'YES' })).toBe(true);
	});
});

describe('applyFinanceGate', () => {
	it('пустое окружение (default-off) → леджер не создаётся, персона равна базовой', () => {
		let createLedgerCalled = false;
		let appendInstructionCalled = false;
		const result = applyFinanceGate({}, BASE_PERSONA, {
			createLedger: () => {
				createLedgerCalled = true;
				return { id: 'should-not-exist' };
			},
			appendInstruction: () => {
				appendInstructionCalled = true;
				return 'should not be reached';
			},
		});

		// Оба колбэка не должны вызываться вовсе — не только не «победить» в ветвлении.
		expect(createLedgerCalled).toBe(false);
		expect(appendInstructionCalled).toBe(false);
		expect(result.ledger).toBeUndefined();
		// Сравнение СТРОК персоны, а не флага — ровно то, чего не хватало старому DoD.
		expect(result.persona).toBe(BASE_PERSONA);
	});

	it("FINANCE_ENABLED='1' → и леджер, и инструкция появляются", () => {
		const fakeLedger = { id: 'fake-ledger' };
		const result = applyFinanceGate({ FINANCE_ENABLED: '1' }, BASE_PERSONA, {
			createLedger: () => fakeLedger,
			appendInstruction: (ledger) => `${BASE_PERSONA}\n[finance-intent для ${ledger.id}]`,
		});

		expect(result.ledger).toBe(fakeLedger);
		expect(result.persona).toBe(`${BASE_PERSONA}\n[finance-intent для fake-ledger]`);
		expect(result.persona).not.toBe(BASE_PERSONA);
	});

	it('createLedger вернул undefined (сбой инициализации) → персона остаётся базовой', () => {
		const result = applyFinanceGate({ FINANCE_ENABLED: '1' }, BASE_PERSONA, {
			createLedger: () => undefined,
			appendInstruction: () => 'should not be reached',
		});

		expect(result.ledger).toBeUndefined();
		expect(result.persona).toBe(BASE_PERSONA);
	});
});
