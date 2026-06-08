/**
 * lint-public.ts — guard публичного репо: ноль секретов, ноль реальных PII.
 *
 * Порт `scheduler/lint_public.py` ([ADR-0012]). Бэкстоп границы двух репо
 * ([ADR-0003]): публичный фреймворк-репо физически не содержит raw/wiki/reminders
 * — только код, доки и СИНТЕТИЧЕСКИЙ пример. Этот линт — последний рубеж: проходит
 * по всему дереву и ФЕЙЛИТ (exit 1), если находит (а) секрет (через ОБЩИЙ
 * `ingest/sanitizer.scanSecrets` — НЕ переопределяем) или (б) известный PII-паттерн.
 *
 * КОДЫ ВЫХОДА: 0 — чисто; 1 — найдены нарушения (CI/pre-commit фейлит).
 * Использование:
 *   node dist/scheduler/lint-public.js                 # весь публичный репо
 *   node dist/scheduler/lint-public.js --root /path    # явный корень
 *   node dist/scheduler/lint-public.js --files a.ts b.md  # только эти файлы
 *   node dist/scheduler/lint-public.js --quiet         # печатать только нарушения
 */
import { type Dirent, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';

import { isMainModule } from '../core/cli.js';
import { scanSecrets } from '../ingest/sanitizer.js';

// --- Что сканируем / что пропускаем -------------------------------------------
const TEXT_SUFFIXES = new Set([
	'.md', '.py', '.txt', '.toml', '.cfg', '.ini', '.env', '.example',
	'.plist', '.sh', '.json', '.yaml', '.yml', '.html', '.js', '.ts', '.cts', '.mts',
]);

const SKIP_DIRS = new Set([
	'.git', '__pycache__', '.venv', 'venv', 'node_modules', '.idea', '.vscode',
	'.mypy_cache', '.pytest_cache', '.ruff_cache', 'dist', 'build', 'graphify-out', '.DS_Store',
]);

// Файлы, которые не сканируем: лок-файлы пакетов = тонны high-entropy-хэшей
// (integrity sha512-…), которые scan_secrets ложно примет за секреты.
const SKIP_FILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']);

// Маркеры, разрешающие реальную-выглядящую строку как ЗАВЕДОМО синтетическую.
const SYNTHETIC_MARKERS = [
	'synthetic-example', 'synthetic_example', 'synthetic', 'fake', 'example-only', 'example',
	'example.com', 'example.org', 'example.net', 'пример', 'замени', 'placeholder', 'redacted',
	'do-not-use', 'do_not_use', 'replace_me', 'replace-me', '<your', 'xxxxx', '123456:aa',
];

const ANGLE_PLACEHOLDER_RE = /<[^<>\n]{1,40}>/;

// Файлы/пути, освобождённые от PII-паттерн-проверки (scan_secrets по ним всё равно
// гоняется). `.test.ts` — тест-векторы синтетические по природе (аналог self-test
// внутри sanitizer.py в Python-версии).
const PII_EXEMPT_PATH_PARTS = [
	'wiki-example', '.env.example', 'scheduler/lint-public.ts', 'reminders_spec.md',
	'routines/README.md', '/docs/', '.test.ts',
];

// Пути, где КЛАСС СЕКРЕТОВ (ярус-1) заведомо иллюстративен → [secret] пропускаем,
// но PII-проход ВСЁ РАВНО работает. «Дома» иллюстративных секретов: сам детектор
// (sanitizer.ts), тест-векторы (*.test.ts), research-библиография, этот линт.
const SECRET_ILLUSTRATIVE_PATH_PARTS = [
	'ingest/sanitizer.ts', 'docs/research/', 'scheduler/lint-public.ts', '.test.ts',
];

// --- Известные структурные PII-паттерны ---------------------------------------
interface PiiPattern {
	name: string;
	regex: RegExp;
	why: string;
}

const PII_PATTERNS: PiiPattern[] = [
	{
		name: 'telegram_bot_token',
		regex: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
		why: 'похоже на реальный Telegram bot token',
	},
	{
		name: 'anthropic_key',
		regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
		why: 'похоже на Anthropic API key (sk-ant-...)',
	},
	{
		name: 'openai_key',
		regex: /\bsk-[A-Za-z0-9]{20,}\b/g,
		why: 'похоже на API key провайдера (sk-...)',
	},
	{
		name: 'email',
		regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
		why: 'реальный email-адрес',
	},
	{
		name: 'ru_phone',
		regex: /(?<!\d)(?:\+7|8)[\s\-(]?\d{3}[\s\-)]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}(?!\d)/g,
		why: 'похоже на реальный российский номер телефона',
	},
	{
		name: 'intl_phone',
		regex: /(?<!\d)\+\d{11,15}(?!\d)/g,
		why: 'похоже на международный номер телефона',
	},
	{
		name: 'telegram_chat_id',
		regex: /(?:owner_chat_id|telegram_owner_chat_id)\s*[=:]\s*['"]?(\d{7,})/gi,
		why: 'похоже на реальный Telegram owner chat_id',
	},
];

const EXAMPLE_EMAIL_DOMAINS = ['example.com', 'example.org', 'example.net', 'primer.ru', 'test.local'];

// Очевидно-фейковые числовые плейсхолдеры (повтор цифры ≥6 раз / 123456789).
const FAKE_NUMERIC = /(?:(\d)\1{5,})|(?:0?123456789\d*)/;

// RHS присваивания, считающийся НЕ-литералом (чтение конфига/окружения/атрибута),
// а не утёкшим хардкодом. Адаптировано под TS-идиомы: process.env (+ os.environ/getenv
// для остаточного Python-кода), вызов foo(...), доступ к атрибуту a.b.c.
const NON_LITERAL_RHS_RE =
	/(?:=>|[:=])\s*(?!['"])(?:process\s*\.\s*env\b|os\s*\.\s*(?:environ|getenv)\b|[A-Za-z_]\w*\s*\(|[A-Za-z_]\w*\s*\.\s*[\w.]+)/i;

const SECRET_HIT_RE = /^(.+)@(\d+)$/;

// --- Модель нарушения ---------------------------------------------------------
export interface Offence {
	path: string;
	lineNo: number;
	kind: string; // "secret" | имя PII-паттерна
	detail: string;
}

export function renderOffence(off: Offence, root: string): string {
	let rel: string;
	try {
		rel = relative(root, off.path);
		if (rel.startsWith('..')) rel = off.path;
	} catch {
		rel = off.path;
	}
	return `${rel}:${off.lineNo}: [${off.kind}] ${off.detail}`;
}

// --- Логика сканирования ------------------------------------------------------
function redact(value: string, keep = 4): string {
	const v = value.trim();
	if (v.length <= keep) return '***';
	return v.slice(0, keep) + '***';
}

function lineIsSynthetic(line: string): boolean {
	const low = line.toLowerCase();
	if (SYNTHETIC_MARKERS.some((m) => low.includes(m))) return true;
	if (FAKE_NUMERIC.test(line)) return true;
	if (ANGLE_PLACEHOLDER_RE.test(line)) return true;
	return false;
}

function pathHasPart(path: string, parts: string[]): boolean {
	const s = path.replace(/\\/g, '/');
	return parts.some((part) => s.includes(part));
}

function emailIsExample(match: string): boolean {
	const low = match.toLowerCase();
	return EXAMPLE_EMAIL_DOMAINS.some((d) => low.endsWith('@' + d) || low.endsWith('.' + d));
}

function parseSecretHit(hit: string): { kind: string; offset: number | null } {
	const m = SECRET_HIT_RE.exec(hit);
	if (m && m[1] && m[2]) return { kind: m[1], offset: Number(m[2]) };
	return { kind: hit, offset: null };
}

// Offset'ы начала строк (по UTF-16 индексам — как scanSecrets через m.index).
function lineStartOffsets(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\n') starts.push(i + 1);
	}
	return starts;
}

function lineFromOffset(lineStarts: number[], offset: number): number {
	// Первая строка, чьё начало > offset → строка перед ней (1-based).
	let lo = 0;
	let hi = lineStarts.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if ((lineStarts[mid] ?? 0) <= offset) lo = mid + 1;
		else hi = mid;
	}
	return Math.max(1, lo);
}

function findLine(lines: string[], needle: string): number {
	for (let i = 0; i < lines.length; i++) {
		if ((lines[i] ?? '').includes(needle)) return i + 1;
	}
	if (needle.length >= 8) {
		const prefix = needle.slice(0, 8);
		for (let i = 0; i < lines.length; i++) {
			if ((lines[i] ?? '').includes(prefix)) return i + 1;
		}
	}
	return 0;
}

export function scanFile(path: string, opts: { piiExempt?: boolean } = {}): Offence[] {
	const offences: Offence[] = [];
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		return offences; // бинарь/нечитаемое — пропускаем
	}

	const lines = text.split('\n');
	const lineStarts = lineStartOffsets(text);
	const secretIllustrative = pathHasPart(path, SECRET_ILLUSTRATIVE_PATH_PARTS);

	// --- проход 1: общий детектор секретов (по всему файлу) ---
	for (const hit of scanSecrets(text)) {
		const { kind, offset } = parseSecretHit(hit);
		let lineNo: number;
		let detail: string;
		if (offset !== null) {
			lineNo = lineFromOffset(lineStarts, offset);
			detail = kind; // уже без значения — печатать безопасно
		} else {
			lineNo = findLine(lines, hit);
			detail = redact(hit);
		}
		const lineText = lineNo >= 1 && lineNo <= lines.length ? (lines[lineNo - 1] ?? '') : '';

		if (secretIllustrative) continue; // дом иллюстративных секретов — пропускаем [secret]
		if (lineText && lineIsSynthetic(lineText)) continue; // синтетический маркер
		if (kind === 'assigned_secret' && NON_LITERAL_RHS_RE.test(lineText)) continue; // чтение конфига
		offences.push({ path, lineNo, kind: 'secret', detail: `scan_secrets: ${detail}` });
	}

	// --- проход 2: структурные PII-паттерны (построчно) ---
	const piiExempt = opts.piiExempt ?? pathHasPart(path, PII_EXEMPT_PATH_PARTS);
	if (!piiExempt) {
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? '';
			if (lineIsSynthetic(line)) continue;
			for (const pat of PII_PATTERNS) {
				for (const m of line.matchAll(pat.regex)) {
					const value = m[0];
					if (value === undefined) continue;
					if (pat.name === 'email' && emailIsExample(value)) continue;
					offences.push({
						path,
						lineNo: i + 1,
						kind: pat.name,
						detail: `${pat.why}: ${redact(value)}`,
					});
				}
			}
		}
	}
	return offences;
}

function listFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				if (SKIP_DIRS.has(e.name)) continue;
				walk(full);
			} else if (e.isFile()) {
				out.push(full);
			}
		}
	};
	walk(root);
	return out.sort();
}

export function iterFiles(root: string): string[] {
	return listFiles(root).filter((p) => {
		const name = basename(p);
		if (SKIP_FILES.has(name)) return false;
		const ext = extname(p).toLowerCase();
		return TEXT_SUFFIXES.has(ext) || name === '.env.example' || name === '.gitignore';
	});
}

export function lint(root: string, explicitFiles?: string[]): Offence[] {
	const offences: Offence[] = [];
	const targets = explicitFiles?.length ? explicitFiles : iterFiles(root);
	for (const f of targets) offences.push(...scanFile(f));
	return offences;
}

// --- CLI ----------------------------------------------------------------------
function defaultRoot(): string {
	// dist/scheduler/lint-public.js | src/scheduler/lint-public.ts → ../.. = корень репо.
	return resolve(import.meta.dirname, '..', '..');
}

interface CliArgs {
	root: string | null;
	files: string[] | null;
	quiet: boolean;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = { root: null, files: null, quiet: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--root') args.root = argv[++i] ?? null;
		else if (a === '--quiet') args.quiet = true;
		else if (a === '--files') {
			args.files = [];
			while (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) args.files.push(argv[++i]!);
		}
	}
	return args;
}

export function main(argv: string[] = process.argv.slice(2)): number {
	const args = parseArgs(argv);
	const root = resolve(args.root ?? defaultRoot());
	const offences = lint(root, args.files ?? undefined);

	if (offences.length > 0) {
		process.stderr.write(`FAIL: публичный репо НЕ чист — найдено ${offences.length} нарушение(й):\n`);
		for (const off of offences) process.stderr.write('  ' + renderOffence(off, root) + '\n');
		process.stderr.write(
			'\nЭто guard границы двух репо ([ADR-0003]): секреты и реальные PII в публичный ' +
				'репо попадать не должны. Если это ЗАВЕДОМО синтетический пример — пометь строку ' +
				'маркером (synthetic-example / «Пример» / example.com) или вынеси в wiki-example/.\n',
		);
		return 1;
	}

	if (!args.quiet) {
		const scanned = args.files ? String(args.files.length) : 'все';
		process.stdout.write(`OK: публичный репо чист (просканировано: ${scanned} файлов под ${root}).\n`);
	}
	return 0;
}

// Запуск как CLI (node dist/scheduler/lint-public.js ...).
if (isMainModule(import.meta.filename)) {
	process.exit(main());
}
