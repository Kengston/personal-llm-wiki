/**
 * sanitizer.ts — маскер секретов и PII в write-path (fail-closed).
 *
 * Порт `ingest/sanitizer.py` ([ADR-0012]). Публичный контракт сохранён 1:1:
 *   sanitizeText(text)        — маскирует, возвращает чистый текст
 *   scanSecrets(text)         — только находит секреты (ярус-1), НЕ мутирует
 *   failClosedSanitize(text)  — обёртка: при любой ошибке/остатке бросает SanitizerError
 *
 * «Корона» ингеста: маскирует секреты/PII ДО любой записи в `raw/` приватного
 * репо и ДО любого попадания в публичный репо (CONTEXT §3 «Sanitizer — в
 * write-path, fail-closed»; [ADR-0003]).
 *
 * Два яруса:
 *  - ЯРУС-1 — СЕКРЕТЫ (block-on-detect): известные форматы по regex + неизвестные
 *    high-entropy-блобы по энтропии Шеннона (base64 ≥ 4.5, hex ≥ 3.0, длина ≥ 20).
 *    Находка → `[REDACTED:<type>]`. Если санитайзер не может гарантировать чистоту —
 *    `failClosedSanitize` бросает, и вызывающий ОТМЕНЯЕТ запись.
 *  - ЯРУС-2 — PII (mask-but-never-block): email/телефон/карта/IBAN/IP/crypto —
 *    маскируются, но промах НЕ блокирует запись. Имена/локации НЕ детектируются
 *    (NER лоссов; «ноль личного в публичном» держит граница двух репо + синтетика).
 *
 * Парность с Python (см. [ADR-0012] «риск Unicode-семантики regex»): Python `re`
 * юникод-aware (`\b`/`\w` ловят кириллицу), JS `RegExp` `\b`/`\w` ASCII-only. Для
 * НАШИХ ASCII-токенов (sk-…, ghp_…, цифры) JS-границы дают НАДмножество совпадений
 * Python: токен, приклеенный к кириллице, JS поймает, Python мог пропустить →
 * для секретов это безопаснее (нет новых ложно-отрицательных). Парность доказана
 * портом self-test-векторов + кириллическими кейсами в sanitizer.test.ts.
 */

// Метка замены. Тип помогает при ревью git-diff понять, ЧТО замаскировано, не
// раскрывая значение. Формат: [REDACTED:<type>].
const redact = (kind: string): string => `[REDACTED:${kind}]`;

interface Rule {
	readonly kind: string;
	readonly re: RegExp;
}

// ---------------------------------------------------------------------------
// ЯРУС-1 — СЕКРЕТЫ (структурные, по regex). Порядок важен: более специфичные
// паттерны раньше дженериков. Все regex с флагом `g` (нужен для matchAll).
// ---------------------------------------------------------------------------
const SECRET_RULES: readonly Rule[] = [
	// Токены конкретно ЭТОГО проекта.
	{ kind: 'telegram_bot_token', re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
	{ kind: 'openai_key', re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g },

	// Распространённые облачные/VCS форматы.
	{ kind: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
	{ kind: 'github_pat_fine', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
	{ kind: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
	{ kind: 'aws_access_key', re: /\b(?:AKIA|ASIA|AGPA|AROA)[0-9A-Z]{16}\b/g },
	{ kind: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	{ kind: 'stripe_key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },

	// JWT (header.payload.signature, всё base64url).
	{ kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },

	// Bearer / Authorization заголовки.
	{ kind: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
	{ kind: 'basic_auth', re: /\bBasic\s+[A-Za-z0-9+/=]{16,}/gi },

	// PEM приватные ключи (любой -----BEGIN ... PRIVATE KEY----- блок). `s` = DOTALL.
	{
		kind: 'private_key_pem',
		re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----.*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/gs,
	},

	// URL c basic-auth внутри: scheme://user:pass@host.
	{ kind: 'url_credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/g },

	// Bybit v5 API key/secret и YooMoney-токен НЕ имеют отличительного префикса
	// (в отличие от sk-…, ghp_…). Поэтому «голый» fixed-length match
	// [A-Za-z0-9]{18}/{36}/{60,} недопустим — он ловит ЛЮБОЙ изолированный alnum
	// (git-SHA, id, хэши из pnpm-lock) и даёт массовые ложные срабатывания:
	// порча легального контента при записи И красный lint:public на чистом дереве.
	// Ловим ТОЛЬКО явное присваивание (KEY=…); «голый» высокоэнтропийный токен
	// добивает энтропийный детектор ниже по файлу.
	{
		kind: 'bybit_api_key_assigned',
		// Явное присваивание: BYBIT_API_KEY=<значение>
		re: /\bBYBIT_API_KEY\b\s*[=:]\s*['"]?([A-Za-z0-9]{10,})/gi,
	},
	{
		kind: 'bybit_api_secret_assigned',
		// Явное присваивание: BYBIT_API_SECRET=<значение>
		re: /\bBYBIT_API_SECRET\b\s*[=:]\s*['"]?([A-Za-z0-9]{10,})/gi,
	},
	// YooMoney / ЮMoney OAuth access token — длинный непрозрачный токен высокой
	// энтропии. Ловим явное присваивание YOOMONEY_TOKEN=…; «голый» токен ловит
	// энтропийный детектор (без fixed-length rule, чтобы не плодить ложняки).
	{
		kind: 'yoomoney_token_assigned',
		re: /\bYOOMONEY_TOKEN\b\s*[=:]\s*['"]?([^\s'";,]{20,})/gi,
	},

	// Присвоения секретов: password=..., api_key: "...", secret => '...'.
	// (Python verbose `(?ix)` развёрнут в обычный JS-regex с флагом `i`.)
	{
		kind: 'assigned_secret',
		re: /\b(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|session[_-]?key)\b\s*(?:=>|[:=])\s*['"]?([^\s'";,]{6,})/gi,
	},
];

// ---------------------------------------------------------------------------
// ЯРУС-2 — PII (структурная). По regex, mask-but-never-block. Имена/локации
// НЕ трогаем.
// ---------------------------------------------------------------------------
const PII_RULES: readonly Rule[] = [
	{ kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
	// IBAN (грубо: 2 буквы страны + 2 контрольные + 11..30 alnum).
	{ kind: 'iban', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g },
	// Банковская карта: 13-19 цифр, опц. разбитых пробелами/дефисами.
	{ kind: 'credit_card', re: /\b(?:\d[ -]?){12,18}\d\b/g },
	// IPv4.
	{
		kind: 'ip_address',
		re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
	},
	// Bitcoin-адрес (legacy / bech32) — простое приближение.
	{ kind: 'crypto_btc', re: /\b(?:bc1[a-z0-9]{20,60}|[13][A-HJ-NP-Za-km-z1-9]{25,34})\b/g },
	// Ethereum-адрес: 0x + ровно 40 шестнадцатеричных символов.
	// Bybit поддерживает вывод ETH/ERC-20, поэтому адрес кошелька — реальный PII.
	// Пример (синтетический): 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 (не настоящий).
	{ kind: 'crypto_eth', re: /\b0x[0-9a-fA-F]{40}\b/g },
	// TRON-адрес (TRC-20 / USDT-TRC20): начинается с 'T', затем 33 символа Base58
	// (алфавит без 0, O, I, l). Bybit также поддерживает вывод USDT по сети TRC-20.
	// Пример (синтетический): TRxFJfFDf2HpD7PeHezF8DHe3yPxPkG9sX (не настоящий).
	{ kind: 'crypto_tron', re: /\bT[1-9A-HJ-NP-Za-km-z]{33}\b/g },
	// Телефоны: маскируем только «длинные»; детальный фильтр — в looksLikePhone.
	{ kind: 'phone', re: /(?<![\w.])\+?\d[\d\s().-]{8,}\d(?![\w])/g },
];

// ---------------------------------------------------------------------------
// Энтропия Шеннона — для НЕИЗВЕСТНЫХ high-entropy-блобов. Пороги из research:
// base64 ≥ 4.5, hex ≥ 3.0; кандидаты длиной ≥ 20.
// ---------------------------------------------------------------------------
const ENTROPY_MIN_LEN = 20;
const ENTROPY_BASE64_THRESHOLD = 4.5;
const ENTROPY_HEX_THRESHOLD = 3.0;

// Кандидат: «слово» из base64url/hex-символов; `=` только как хвостовой padding.
const TOKEN_CANDIDATE_RE = /[A-Za-z0-9+/_-]{20,}={0,2}/g;
const HEX_ONLY_RE = /^[0-9a-fA-F]+$/;
const HAS_DIGIT_RE = /\d/;
const HAS_UPPER_RE = /[A-Z]/;
const HAS_LOWER_RE = /[a-z]/;

/** Энтропия Шеннона строки в битах на символ. Считаем по code points (как Python). */
export function shannonEntropy(s: string): number {
	if (!s) return 0;
	const chars = [...s];
	const freq = new Map<string, number>();
	for (const ch of chars) freq.set(ch, (freq.get(ch) ?? 0) + 1);
	const length = chars.length;
	let entropy = 0;
	for (const count of freq.values()) {
		const p = count / length;
		entropy -= p * Math.log2(p);
	}
	return entropy;
}

/** True, если токен похож на high-entropy-секрет по энтропии Шеннона. */
function isHighEntropySecret(token: string): boolean {
	if (token.length < ENTROPY_MIN_LEN) return false;
	const entropy = shannonEntropy(token);
	if (HEX_ONLY_RE.test(token)) {
		// Чистый hex (напр. SHA-подобное) — порог ниже (алфавит 16).
		return entropy >= ENTROPY_HEX_THRESHOLD;
	}
	// base64url-подобное. Требуем «разнобой», чтобы не ловить длинные слова.
	const hasMix = HAS_DIGIT_RE.test(token) || (HAS_UPPER_RE.test(token) && HAS_LOWER_RE.test(token));
	if (!hasMix) return false;
	return entropy >= ENTROPY_BASE64_THRESHOLD;
}

/**
 * Доп. фильтр телефона: 10..15 значащих цифр (E.164-диапазон). Экспортируется,
 * чтобы classifier.ts переиспользовал ТО ЖЕ правило в pii_density ([ADR-0013]):
 * без него phone-regex ловит фрагменты ISO-дат (2024-05-29 = 8 цифр).
 */
export function looksLikePhone(matchText: string): boolean {
	const digits = matchText.replace(/\D/g, '');
	return digits.length >= 10 && digits.length <= 15;
}

// ---------------------------------------------------------------------------
// Сканер находок
// ---------------------------------------------------------------------------
interface Finding {
	kind: string; // telegram_bot_token | email | entropy:base64 | ...
	start: number;
	end: number;
	value: string; // совпадение; наружу (scanSecrets) НЕ отдаём
}

/** Внутренний сканер: все находки (секреты + опц. PII). НЕ мутирует текст. */
function scan(text: string, includePii: boolean): Finding[] {
	const findings: Finding[] = [];

	// ЯРУС-1: структурные секреты по regex.
	for (const { kind, re } of SECRET_RULES) {
		for (const m of text.matchAll(re)) {
			const value = m[0];
			if (value === undefined) continue;
			const start = m.index ?? 0;
			findings.push({ kind, start, end: start + value.length, value });
		}
	}

	// ЯРУС-1: энтропийные секреты (неизвестные форматы).
	for (const m of text.matchAll(TOKEN_CANDIDATE_RE)) {
		const token = m[0];
		if (token === undefined || !isHighEntropySecret(token)) continue;
		const sub = HEX_ONLY_RE.test(token) ? 'entropy:hex' : 'entropy:base64';
		const start = m.index ?? 0;
		findings.push({ kind: sub, start, end: start + token.length, value: token });
	}

	// ЯРУС-2: PII (по запросу).
	if (includePii) {
		for (const { kind, re } of PII_RULES) {
			for (const m of text.matchAll(re)) {
				const value = m[0];
				if (value === undefined) continue;
				if (kind === 'phone' && !looksLikePhone(value)) continue;
				const start = m.index ?? 0;
				findings.push({ kind, start, end: start + value.length, value });
			}
		}
	}

	return findings;
}

/** Приоритет находки при разрешении перекрытий. Именованный > entropy. */
function specificity(f: Finding): number {
	return f.kind.startsWith('entropy:') ? 0 : 1;
}

/**
 * Снимает перекрытия. Приоритет: (1) специфичнее (именованное > entropy),
 * (2) раньше старт, (3) длиннее. Так именованное правило побеждает пересекающийся
 * entropy-кандидат, даже если тот начался на пару символов левее.
 */
function resolveOverlaps(findings: Finding[]): Finding[] {
	if (findings.length === 0) return [];
	const ordered = [...findings].sort((a, b) => {
		const sa = specificity(a);
		const sb = specificity(b);
		if (sa !== sb) return sb - sa; // специфичность ↓
		if (a.start !== b.start) return a.start - b.start; // старт ↑
		return b.end - b.start - (a.end - a.start); // длина ↓
	});
	const result: Finding[] = [];
	for (const f of ordered) {
		const conflict = result.some((a) => !(f.end <= a.start || f.start >= a.end));
		if (conflict) continue;
		result.push(f);
	}
	result.sort((a, b) => a.start - b.start);
	return result;
}

// ---------------------------------------------------------------------------
// Невидимые/управляющие символы (WhatsApp LRM U+200E, NNBSP U+202F и пр.)
// NFKC сводит совместимые формы (NNBSP → пробел), затем убираем zero-width/bidi:
//   U+200B–U+200F  zwsp, zwnj, zwj, LRM, RLM
//   U+202A–U+202E  bidi embeddings/overrides
//   U+2060         word joiner
//   U+FEFF         BOM / zero width no-break space
// ---------------------------------------------------------------------------
// Строим из явных code points — чтобы в исходнике НЕ было литеральных невидимых
// символов (их легко не заметить при ревью). Источник regex: […].
const INVISIBLE_CODE_POINTS = [
	0x200b, 0x200c, 0x200d, 0x200e, 0x200f, // zwsp, zwnj, zwj, LRM, RLM
	0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // bidi embeddings/overrides
	0x2060, // word joiner
	0xfeff, // BOM / zero width no-break space
];
const INVISIBLE_RE = new RegExp(
	`[${INVISIBLE_CODE_POINTS.map((c) => `\\u${c.toString(16).padStart(4, '0')}`).join('')}]`,
	'g',
);

/** Убирает невидимые управляющие символы и нормализует пробелы (NFKC). */
export function stripInvisible(text: string): string {
	return text.normalize('NFKC').replace(INVISIBLE_RE, '');
}

// ---------------------------------------------------------------------------
// Публичный интерфейс
// ---------------------------------------------------------------------------

/**
 * Маскирует секреты И PII, возвращает безопасную для записи строку. ОСНОВНАЯ
 * функция write-path. Замена идёт с конца к началу, чтобы не сбить смещения.
 *
 * Для реального write-path используйте `failClosedSanitize` (контрольный проход).
 */
export function sanitizeText(text: string): string {
	if (!text) return text;
	const normalized = stripInvisible(text);
	const findings = resolveOverlaps(scan(normalized, true));
	if (findings.length === 0) return normalized;

	// Заменяем с конца, чтобы start/end оставшихся находок не «поехали».
	let out = normalized;
	for (const f of [...findings].sort((a, b) => b.start - a.start)) {
		out = out.slice(0, f.start) + redact(f.kind) + out.slice(f.end);
	}
	return out;
}

/**
 * Возвращает список находок-СЕКРЕТОВ (ярус-1) БЕЗ мутации текста. Бэкстоп
 * публичного репо (`scheduler/lint-public.ts`). Элемент: "<kind>@<start>" —
 * тип и позиция, БЕЗ значения. PII сюда НЕ включаем.
 */
export function scanSecrets(text: string): string[] {
	if (!text) return [];
	const findings = resolveOverlaps(scan(stripInvisible(text), false));
	findings.sort((a, b) => a.start - b.start);
	return findings.map((f) => `${f.kind}@${f.start}`);
}

/** Поднимается, когда fail-closed-санитизация не может гарантировать чистоту. */
export class SanitizerError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'SanitizerError';
	}
}

/**
 * Fail-closed обёртка для write-path. Если санитизация не отработала штатно —
 * бросаем, чтобы вызывающий ОТМЕНИЛ запись. Плюс контрольный проход: после
 * маскирования повторно сканируем секреты — остаток = баг правил, лучше упасть.
 */
export function failClosedSanitize(text: string): string {
	let cleaned: string;
	try {
		cleaned = sanitizeText(text);
	} catch (exc) {
		throw new SanitizerError('sanitizeText упал — запись отменена', { cause: exc });
	}
	const residual = scanSecrets(cleaned);
	if (residual.length > 0) {
		throw new SanitizerError(
			`после санитизации остались секреты (${residual.length}) — запись отменена`,
		);
	}
	return cleaned;
}
