/**
 * Парность с `ingest/sanitizer.py` ([ADR-0012]). Векторы перенесены из
 * Python `_selftest` 1:1 + добавлены кириллические boundary-кейсы (главный риск
 * порта: Python `re` юникод-aware, JS `RegExp` ASCII-only по `\b`/`\w`).
 *
 * ВАЖНО: все «секреты» ниже выдуманы (фейковые ключи/телефоны/email) — это
 * публичный репо, реальных данных тут быть не может.
 *
 * Невидимые/управляющие символы строим через String.fromCodePoint — чтобы в
 * исходнике теста НЕ было литеральных невидимых глифов.
 */
import { describe, expect, it } from 'vitest';
import {
	failClosedSanitize,
	sanitizeText,
	SanitizerError,
	scanSecrets,
	shannonEntropy,
	stripInvisible,
} from './sanitizer.js';

const LRM = String.fromCodePoint(0x200e); // left-to-right mark
const NNBSP = String.fromCodePoint(0x202f); // narrow no-break space
const ZWSP = String.fromCodePoint(0x200b); // zero width space
const LIGATURE_FI = String.fromCodePoint(0xfb01); // ﬁ → NFKC → "fi"

function expectRedaction(raw: string, mustRedact: string[], mustKeep: string[]): void {
	const out = sanitizeText(raw);
	for (const needle of mustRedact) {
		expect(out, `должно замаскировать ${JSON.stringify(needle)} в ${JSON.stringify(out)}`).not.toContain(
			needle,
		);
	}
	for (const needle of mustKeep) {
		expect(out, `должно сохранить ${JSON.stringify(needle)} в ${JSON.stringify(out)}`).toContain(
			needle,
		);
	}
}

describe('sanitizer — секреты (ярус-1)', () => {
	it('telegram_bot_token', () => {
		expectRedaction(
			'токен бота 123456789:AAFakeFakeFakeFakeFakeFakeFake12345 конец',
			['123456789:AAFakeFakeFakeFakeFakeFakeFake12345'],
			['токен бота', 'конец'],
		);
	});

	it('openai_key', () => {
		expectRedaction(
			'ключ sk-proj-AbCdEf0123456789AbCdEf0123456789 в конфиге',
			['sk-proj-AbCdEf0123456789AbCdEf0123456789'],
			['ключ', 'в конфиге'],
		);
	});

	it('bearer', () => {
		expectRedaction(
			'Authorization: Bearer abcDEF123456ghiJKL789mnoPQR0 ок',
			['abcDEF123456ghiJKL789mnoPQR0'],
			['Authorization:', 'ок'],
		);
	});

	it('jwt', () => {
		expectRedaction(
			'cookie eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3.fakefakefakeSIGN here',
			['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3.fakefakefakeSIGN'],
			['cookie', 'here'],
		);
	});

	it('assigned_password', () => {
		expectRedaction(
			'config: password="SuperSecret123!" host=localhost',
			['SuperSecret123!'],
			['config:', 'host=localhost'],
		);
	});

	it('github_token', () => {
		expectRedaction(
			'export GH=ghp_0123456789abcdefABCDEF0123456789abcdef done',
			['ghp_0123456789abcdefABCDEF0123456789abcdef'],
			['export GH=', 'done'],
		);
	});

	it('url_credentials', () => {
		expectRedaction(
			'clone https://user:p4ssw0rd@example.com/repo.git now',
			['p4ssw0rd'],
			['clone', 'now'],
		);
	});

	it('entropy_hex', () => {
		expectRedaction(
			'digest 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 end',
			['9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'],
			['digest', 'end'],
		);
	});
});

describe('sanitizer — PII (ярус-2)', () => {
	it('email', () => {
		expectRedaction('пиши на ivan.primer@example.com если что', ['ivan.primer@example.com'], [
			'пиши на',
			'если что',
		]);
	});

	it('phone', () => {
		expectRedaction('звони +7 (999) 123-45-67 вечером', ['123-45-67'], ['звони', 'вечером']);
	});

	it('credit_card', () => {
		expectRedaction('карта 4111 1111 1111 1111 истекает скоро', ['4111 1111 1111 1111'], [
			'карта',
			'истекает скоро',
		]);
	});
});

describe('sanitizer — негативы (обычный текст не ломается)', () => {
	it('plain_text_untouched', () => {
		const raw = 'Иван Пример любит горы и читает по выходным.';
		expect(sanitizeText(raw)).toBe(raw);
	});

	it('short_id_kept', () => {
		expectRedaction('заметка id=note-42 про встречу', [], ['note-42', 'про встречу']);
	});

	it('русский текст с короткими числами не маскируется', () => {
		const raw = 'встреча в 2026 году, кабинет 42, дом 7';
		expect(sanitizeText(raw)).toBe(raw);
	});
});

describe('sanitizer — кириллическая граница (парность с Python)', () => {
	it('секрет в русском контексте всё равно маскируется', () => {
		expectRedaction(
			'Мой токен — sk-ant-ABCdef0123456789ABCdef0123 не показывай никому',
			['sk-ant-ABCdef0123456789ABCdef0123'],
			['Мой токен', 'не показывай никому'],
		);
	});

	it('email в русском предложении маскируется, проза сохраняется', () => {
		expectRedaction('мой адрес ivan.primer@example.com, пиши вечером', ['ivan.primer@example.com'], [
			'мой адрес',
			'пиши вечером',
		]);
	});

	it('секрет, приклеенный к кириллице, JS ловит (надмножество Python)', () => {
		// Python с юникод-`\b` мог бы это пропустить; JS (ASCII-`\b`) ловит — безопаснее.
		const out = sanitizeText('префиксsk-ant-ABCdef0123456789ABCdef0123');
		expect(out).not.toContain('sk-ant-ABCdef0123456789ABCdef0123');
		expect(out).toContain('префикс');
	});
});

describe('sanitizer — невидимые символы', () => {
	it('LRM/NNBSP исчезают после sanitizeText', () => {
		const dirty = `сообщение${LRM}с невидимыми`;
		const cleaned = sanitizeText(dirty);
		expect(cleaned).not.toContain(LRM);
		expect(cleaned).not.toContain(NNBSP);
	});

	it('stripInvisible убирает zero-width и нормализует NFKC', () => {
		expect(stripInvisible(`a${ZWSP}b`)).toBe('ab');
		expect(stripInvisible(LIGATURE_FI)).toBe('fi'); // NFKC ﬁ → fi
		expect(stripInvisible(`a${NNBSP}b`)).toBe('a b'); // NFKC NNBSP → пробел
	});
});

describe('sanitizer — scanSecrets (находит секрет, НЕ включает PII)', () => {
	it('возвращает секрет без email', () => {
		const found = scanSecrets('key sk-ant-FAKE0123456789FAKE0123456789 mail a@b.co');
		expect(found.some((f) => f.startsWith('openai_key'))).toBe(true);
		expect(found.some((f) => f.startsWith('email'))).toBe(false);
	});

	it('формат элемента — kind@pos, без значения', () => {
		const found = scanSecrets('x sk-ant-FAKE0123456789FAKE0123456789');
		expect(found).toHaveLength(1);
		expect(found[0]).toMatch(/^openai_key@\d+$/);
	});

	it('чистый текст — пустой список', () => {
		expect(scanSecrets('просто обычная заметка про горы')).toEqual([]);
	});
});

describe('sanitizer — failClosedSanitize', () => {
	it('чистый вывод не содержит секретов', () => {
		const safe = failClosedSanitize('token sk-FAKE0123456789FAKE0123456789 ok');
		expect(scanSecrets(safe)).toHaveLength(0);
		expect(safe).toContain('ok');
	});

	it('SanitizerError существует и наследует Error', () => {
		const err = new SanitizerError('test');
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe('SanitizerError');
	});
});

// ── Phase-0 Safety Gate: финансовые / криптовалютные векторы ──────────────────
// Эти тесты верифицируют ПЯТЬ паттернов, добавленных для функции «личный финансовый
// трекер» (raw/finance/ в приватном репо). Все значения заведомо синтетические —
// реальные ключи/адреса НИКОГДА не должны попадать в публичный репо.
//
// Векторы дублируют SYNTHETIC_MARKERS-файл (.test.ts) → lint-public.ts их пропускает
// (SECRET_ILLUSTRATIVE_PATH_PARTS + PII_EXEMPT_PATH_PARTS оба включают '.test.ts').
describe('sanitizer — Phase-0: финансовые паттерны (ярус-1 + ярус-2)', () => {
	it('bybit_api_key_assigned — явное присваивание маскируется', () => {
		// Синтетический фейковый ключ: BYBIT_API_KEY=FAKEbybitkey0123456789
		// Паттерн /\bBYBIT_API_KEY\b\s*[=:]\s*['"]?([A-Za-z0-9]{10,})/gi захватывает
		// весь матч включая «BYBIT_API_KEY=», поэтому проверяем, что значение ключа ушло,
		// а окружающий текст (до и после) остался.
		expectRedaction(
			'env: BYBIT_API_KEY=FAKEbybitkey0123456789 # synthetic-example',
			['FAKEbybitkey0123456789'],
			['env:', '# synthetic-example'],
		);
	});

	it('bybit_api_secret_assigned — явное присваивание маскируется', () => {
		// Синтетический фейковый секрет: BYBIT_API_SECRET=FAKEbybitsecret0123456789abcdef012345
		// Паттерн захватывает весь матч включая «BYBIT_API_SECRET=»; окружение сохраняется.
		expectRedaction(
			'config: BYBIT_API_SECRET=FAKEbybitsecret0123456789abcdef012345 # synthetic-example',
			['FAKEbybitsecret0123456789abcdef012345'],
			['config:', '# synthetic-example'],
		);
	});

	it('yoomoney_token_assigned — явное присваивание маскируется', () => {
		// Синтетический фейковый токен: YOOMONEY_TOKEN=FAKE.yoomoney.token.0123456789abcdef
		// Паттерн захватывает «YOOMONEY_TOKEN=<значение>»; проверяем что значение ушло.
		expectRedaction(
			'config: YOOMONEY_TOKEN=FAKE.yoomoney.token.0123456789abcdef end',
			['FAKE.yoomoney.token.0123456789abcdef'],
			['config:', 'end'],
		);
	});

	it('crypto_eth — Ethereum-адрес (0x + 40 hex) маскируется как PII', () => {
		// Синтетический ETH-адрес: 0x + 40 нулей (явно не реальный кошелёк).
		// Паттерн (ярус-2): /\b0x[0-9a-fA-F]{40}\b/g
		expectRedaction(
			'вывод на 0x0000000000000000000000000000000000000000 # synthetic-example',
			['0x0000000000000000000000000000000000000000'],
			['вывод на'],
		);
	});

	it('crypto_tron — TRON-адрес (T + 33 Base58) маскируется как PII', () => {
		// Синтетический TRON-адрес: T + 33 символа Base58 (нули — не входят в Base58,
		// используем «1» как минимальный Base58-символ — заведомо фейковый адрес).
		// Паттерн (ярус-2): /\bT[1-9A-HJ-NP-Za-km-z]{33}\b/g
		expectRedaction(
			'получатель T111111111111111111111111111111111 # synthetic-example',
			['T111111111111111111111111111111111'],
			['получатель'],
		);
	});
});

describe('sanitizer — shannonEntropy', () => {
	it('пустая строка — 0', () => expect(shannonEntropy('')).toBe(0));
	it('один символ повторён — 0', () => expect(shannonEntropy('aaaaaa')).toBe(0));
	it('два равновероятных символа — 1 бит', () => expect(shannonEntropy('abab')).toBeCloseTo(1));
	it('случайный hex — высокая энтропия (≥3)', () => {
		expect(
			shannonEntropy('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'),
		).toBeGreaterThanOrEqual(3);
	});
});
