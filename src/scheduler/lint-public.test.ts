/**
 * Парность с `scheduler/lint_public.py` ([ADR-0012]). PII-гейт: секреты/реальные
 * PII фейлят, синтетика/конфиг-чтение/пример-домены — нет. Все данные синтетические.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { lint, scanFile } from './lint-public.js';

describe('lint-public (PII-гейт)', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'lint-test-'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const write = (name: string, content: string): string => {
		const p = join(dir, name);
		writeFileSync(p, content, 'utf8');
		return p;
	};

	it('чистый файл → ноль нарушений', () => {
		const p = write('clean.ts', 'export const x = 42;\n// просто код про горы\n');
		expect(scanFile(p)).toEqual([]);
	});

	it('хардкод-секрет (sk-ant литерал) → нарушение [secret]', () => {
		const p = write('leak.ts', 'const k = "sk-ant-Ab3Cd7Ef1Gh9Ij2Kl5Mn8Op4Qr";\n');
		const off = scanFile(p);
		expect(off.length).toBeGreaterThanOrEqual(1);
		expect(off.some((o) => o.kind === 'secret')).toBe(true);
	});

	it('секрет на строке с маркером fake → пропуск', () => {
		const p = write('vec.ts', 'const fakeKey = "sk-ant-ABCDEFGHIJ0123456789KLMNOPQR"; // fake\n');
		expect(scanFile(p)).toEqual([]);
	});

	it('чтение конфига (process.env) → не утечка', () => {
		const p = write('cfg.ts', 'const secret = process.env.TELEGRAM_WEBHOOK_SECRET;\n');
		expect(scanFile(p)).toEqual([]);
	});

	it('чтение атрибута (settings.x) → не утечка (как в app.ts)', () => {
		const p = write('app2.ts', 'const secret = state.settings.webhookSecret;\n');
		expect(scanFile(p)).toEqual([]);
	});

	it('реальный email → нарушение; example.com → нет', () => {
		const real = write('a.md', 'пиши на vasya.petrov@gmail.com сегодня\n');
		expect(scanFile(real).some((o) => o.kind === 'email')).toBe(true);
		const ex = write('b.md', 'демо: ivan.primer@example.com\n');
		expect(scanFile(ex).some((o) => o.kind === 'email')).toBe(false);
	});

	it('реальный РФ-телефон → нарушение; фейк (повтор цифры) → нет', () => {
		const real = write('p1.md', 'мой номер +7 921 845 67 23 звони\n');
		expect(scanFile(real).some((o) => o.kind === 'ru_phone')).toBe(true);
		const fake = write('p2.md', 'пример +7 111 111 11 11\n');
		expect(scanFile(fake).some((o) => o.kind === 'ru_phone')).toBe(false);
	});

	it('telegram bot token (реальный-вид) → нарушение', () => {
		const p = write('tok.md', 'token 8042617395:AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqR here\n');
		expect(scanFile(p).length).toBeGreaterThanOrEqual(1);
	});

	it('owner_chat_id с длинным числом → нарушение', () => {
		const p = write('id.ts', 'const TELEGRAM_OWNER_CHAT_ID = 728451963;\n');
		expect(scanFile(p).some((o) => o.kind === 'telegram_chat_id')).toBe(true);
	});

	it('PII-exempt путь (.test.ts): PII и [secret] пропускаются', () => {
		const p = write('vectors.test.ts', "const phone = '+7 921 845 67 23'; const k='sk-ant-ABCDEFGHIJ0123456789KLMN';\n");
		expect(scanFile(p)).toEqual([]);
	});

	it('lint() обходит дерево и собирает нарушения', () => {
		write('ok.ts', 'export const y = 1;\n');
		write('bad.md', 'почта real.person@yandex.ru тут\n');
		const offences = lint(dir);
		expect(offences.some((o) => o.kind === 'email')).toBe(true);
	});
});
