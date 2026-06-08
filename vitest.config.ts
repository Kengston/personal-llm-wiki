import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// Тесты лежат рядом с исходниками: src/**/*.test.ts. Отдельного tests/ для unit'ов нет.
		include: ['src/**/*.test.ts'],
		environment: 'node',
		reporters: ['default'],
		// Тише в тестах: pino не шумит структурными логами (node:sqlite грузится
		// через createRequire в store.ts, поэтому externalize в конфиге не нужен).
		env: {
			LOG_LEVEL: 'silent',
		},
	},
});
