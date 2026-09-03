/**
 * feature-flags.test.ts — `isFinanceEnabled` default-off и разбор истинных значений.
 */
import { describe, expect, it } from 'vitest';

import { isFinanceEnabled } from './feature-flags.js';

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
