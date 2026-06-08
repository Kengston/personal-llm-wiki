/**
 * classifier.ts — Tier-1 ФИЛЬТР чувствительности + роутер «задача vs знание».
 *
 * Порт `ingest/classifier.py` ([ADR-0011], [ADR-0012]). Контракт сохранён:
 *   classifySensitivity / routeLane / shouldSkipRawPath / filterLogRecord / loadPolicy
 *
 * Sibling к sanitizer (НЕ внутри — противоположная семантика отказа): секреты
 * fail-CLOSED, чувствительность fail-TO-QUARANTINE. Две оси + роутер:
 *  - Ось A (чувствительность) — здесь, on-device, ДО облака. Tier-1 детерминированный.
 *  - Ось B (важность) — НЕ здесь (расширение compile).
 *  - Роутер «задача vs знание» — здесь, консервативен В СТОРОНУ ЗНАНИЯ.
 *
 * Инварианты: возвращаем label/score/tier/reason/action — НИКОГДА содержимое;
 * карантин предпочитает ложно-ПОЛОЖИТЕЛЬНЫЕ; карантин ПОБЕЖДАЕТ лейн; политика —
 * из compiler/relevance-policy.md (JSON-блок) + приватный .local.json override.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { looksLikePhone, stripInvisible } from './sanitizer.js';

// --- Действия (по убыванию строгости: меньший индекс = строже = ПОБЕЖДАЕТ) ----
const ACTION_PRECEDENCE = [
	'quarantine', // целый док в raw/.quarantine/<cat>/
	'quarantine_and_redact',
	'keep_redact_spans', // ХРАНИМ как знание; sanitizer маскирует опасные подстроки
	'leave_in_raw', // не промоутить в wiki/ (но raw/ хранит)
	'normal', // обычный путь
];

function stricter(a: string, b: string): string {
	const ia = ACTION_PRECEDENCE.indexOf(a);
	const ib = ACTION_PRECEDENCE.indexOf(b);
	const sa = ia < 0 ? 99 : ia;
	const sb = ib < 0 ? 99 : ib;
	return sa <= sb ? a : b;
}

// Безопасные ОБЩИЕ дефолт-кейворды (расширение — в приватном .local.json).
const DEFAULT_KEYWORDS: Record<string, string[]> = {
	financial: ['долг', 'должен', 'займ', 'iban', 'оплат', 'счёт', 'invoice', 'owe', 'debt'],
	health: ['диагноз', 'болезн', 'симптом', 'therapy', 'терап', 'health', 'лекарств'],
	legal: ['контракт', 'договор', 'иск', 'суд', 'nda', 'lawsuit', 'арбитраж'],
	toxic: [], // реальный лексикон — приватно
};

// Дефолтные source_class-метки по категориям (расширяй в политике/приватно).
const SRC_DEFAULTS: Record<string, string[]> = {
	nsfw: ['adult', 'porn'],
	doomscroll: ['feed', 'shorts', 'reels'],
};

// Маркеры рефлексии — роутер НЕ дивертит их в task (это ростовой сигнал).
const REFLECTION_MARKERS = [
	'я думаю',
	'хочу научиться',
	'по жизни',
	'в целом',
	'delegat',
	'career',
	'карьер',
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?<!\d)\+?\d[\d\-\s()]{8,}\d(?!\d)/g;

// --- Типы ---------------------------------------------------------------------
export interface Classification {
	label: string; // nsfw | others_pii | toxic | financial | health | legal | doomscroll | normal
	action: string; // см. ACTION_PRECEDENCE
	tier: number; // 1 = детерминированный on-device
	reason: string; // человекочитаемая причина (provenance), без содержимого
	score: number | null;
}

export interface LaneDecision {
	lane: 'knowledge' | 'task';
	dualRoute: boolean; // true → и в task-log, И видимо для compile (на сомнении)
	reason: string;
}

export interface SourceMeta {
	source_class?: string;
	[k: string]: unknown;
}

interface SensitivityCfg {
	detect?: string[];
	action?: string;
	source_classes?: string[];
	domain_blocklist?: string[];
	keywords?: string[];
	lexicon?: string;
	lexicon_words?: string[];
	pii_density_threshold?: number;
	[k: string]: unknown;
}

interface LanesCfg {
	router_bias?: string;
	task_triggers?: string[];
	dual_route_on_ambiguity?: boolean;
	[k: string]: unknown;
}

export interface Policy {
	sensitivity?: Record<string, SensitivityCfg>;
	lanes?: LanesCfg;
	[k: string]: unknown;
}

export interface FilterLogRecord {
	ts: string;
	raw_path: string;
	axis: string;
	category: string;
	action: string;
	tier: number;
	reason: string;
	score: number | null;
	policy_version: string;
	content_sha256?: string;
	lane?: string;
	dual_route?: boolean;
}

// --- Загрузка политики --------------------------------------------------------
// Из src/ingest/classifier.ts и dist/ingest/classifier.js одинаково: ../../compiler.
const DEFAULT_POLICY_PATH = resolve(
	import.meta.dirname,
	'..',
	'..',
	'compiler',
	'relevance-policy.md',
);
const JSON_BLOCK_RE = /```json\s*(\{[\s\S]*?\})\s*```/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
	for (const [k, v] of Object.entries(over)) {
		const cur = base[k];
		if (isPlainObject(v) && isPlainObject(cur)) {
			deepMerge(cur, v);
		} else {
			base[k] = v;
		}
	}
	return base;
}

/**
 * Читает JSON-блок из compiler/relevance-policy.md + мёрджит приватный .local.json.
 * Граница двух репо: персональные лексиконы/имена живут ТОЛЬКО в приватном override.
 */
export function loadPolicy(publicMd?: string | null, privateOverride?: string | null): Policy {
	const mdPath = publicMd ?? DEFAULT_POLICY_PATH;
	let policy: Policy = {};
	try {
		const text = readFileSync(mdPath, 'utf8');
		const m = JSON_BLOCK_RE.exec(text);
		if (m && m[1]) policy = JSON.parse(m[1]) as Policy;
	} catch {
		policy = {};
	}
	if (privateOverride && existsSync(privateOverride)) {
		try {
			deepMerge(policy as Record<string, unknown>, JSON.parse(readFileSync(privateOverride, 'utf8')));
		} catch {
			// приватный override битый — игнор (как в Python)
		}
	}
	return policy;
}

// Нормализацию переиспользуем из sanitizer, чтобы обфускация не проскочила лексикон.
function normalize(text: string): string {
	return stripInvisible(text).toLowerCase();
}

// --- Детекторы (Tier-1, детерминированные) ------------------------------------
function matchSourceClass(meta: SourceMeta, classes: string[]): boolean {
	const sc = meta.source_class ?? '';
	return Boolean(sc) && (classes ?? []).includes(sc);
}

function matchDomainBlocklist(text: string, meta: SourceMeta, blocklist: string[]): string | null {
	const metaVals = Object.values(meta)
		.map((v) => String(v))
		.join(' ');
	const hay = `${text} ${metaVals}`.toLowerCase();
	for (const dom of blocklist ?? []) {
		const d = (String(dom).split('#')[0] ?? '').trim().toLowerCase();
		if (d && hay.includes(d)) return d;
	}
	return null;
}

function matchKeyword(text: string, words: string[]): string | null {
	for (const raw of words ?? []) {
		const w = raw.trim().toLowerCase();
		if (w && text.includes(w)) return w;
	}
	return null;
}

function piiDensity(text: string): number {
	const emails = text.match(EMAIL_RE)?.length ?? 0;
	// Считаем только ВАЛИДНЫЕ телефоны (10..15 значащих цифр, как в sanitizer-ярус-2).
	// Иначе phone-regex ловит фрагменты ISO-дат (2024-05-29 = 8 цифр), и любая
	// дат-насыщенная страница (frontmatter + per-message stamps) ложно перебирает
	// порог → others_pii-карантин. ОСОЗНАННОЕ расхождение с Python-оригиналом
	// (фикс пред-существующего бага, НЕ редизайн фильтра) — [ADR-0013].
	const phones = (text.match(PHONE_RE) ?? []).filter((m) => looksLikePhone(m)).length;
	return emails + phones;
}

// --- Ось A: классификация чувствительности ------------------------------------
/** Tier-1 детерминированная классификация ЦЕЛОГО документа. On-device, без egress. */
export function classifySensitivity(
	text: string,
	sourceMeta?: SourceMeta | null,
	policy?: Policy | null,
): Classification {
	const pol = policy ?? loadPolicy();
	const meta = sourceMeta ?? {};
	const norm = normalize(text ?? '');
	const sens: Record<string, SensitivityCfg> = pol.sensitivity ?? {};

	let best: Classification = {
		label: 'normal',
		action: 'normal',
		tier: 1,
		reason: 'no-signal',
		score: null,
	};

	for (const [cat, rawCfg] of Object.entries(sens)) {
		const cfg = rawCfg ?? {};
		const detect = cfg.detect ?? [];
		const action = cfg.action ?? 'normal';
		let hitReason: string | null = null;

		if (
			detect.includes('source_class') &&
			matchSourceClass(meta, cfg.source_classes ?? SRC_DEFAULTS[cat] ?? [])
		) {
			hitReason = `source_class=${meta.source_class ?? ''}`;
		}
		if (!hitReason && detect.includes('domain_blocklist')) {
			const dom = matchDomainBlocklist(norm, meta, cfg.domain_blocklist ?? []);
			if (dom) hitReason = `domain_blocklist=${dom}`;
		}
		if (!hitReason && detect.includes('keyword')) {
			const kw = matchKeyword(norm, cfg.keywords ?? DEFAULT_KEYWORDS[cat] ?? []);
			if (kw) hitReason = `keyword=${kw}`;
		}
		if (!hitReason && detect.includes('lexicon') && cfg.lexicon === 'on') {
			const kw = matchKeyword(norm, cfg.lexicon_words ?? []);
			if (kw) hitReason = `lexicon=${kw}`;
		}
		if (!hitReason && detect.includes('pii_density')) {
			// Math.trunc + finite-guard: усечение дробного порога как Python int()
			// (5.9 → 5, без off-by-one на границе карантина) и без NaN-fail-open на
			// нечисловом значении (тогда сигнал просто не срабатывает) — [аудит TS-порта].
			const threshold = Math.trunc(Number(cfg.pii_density_threshold ?? 5));
			if (Number.isFinite(threshold) && piiDensity(norm) >= threshold) {
				hitReason = `pii_density>=${threshold}`;
			}
		}

		if (hitReason) {
			const cand: Classification = { label: cat, action, tier: 1, reason: hitReason, score: null };
			// Карантин ПОБЕЖДАЕТ: берём более строгое действие.
			if (stricter(cand.action, best.action) === cand.action && cand.action !== best.action) {
				best = cand;
			} else if (best.label === 'normal') {
				best = cand;
			}
		}
	}
	return best;
}

// --- Роутер «задача vs знание» (консервативен В СТОРОНУ ЗНАНИЯ) ----------------
/** Дивертит в TASK только при форме «императив + объект». На сомнении — дуал-роут. */
export function routeLane(
	text: string,
	_sourceMeta?: SourceMeta | null,
	policy?: Policy | null,
): LaneDecision {
	const pol = policy ?? loadPolicy();
	const lanes: LanesCfg = pol.lanes ?? {};
	// Сейчас поддерживаем только knowledge-bias; иное оставляем knowledge.
	const norm = normalize(text ?? '');
	const triggers = (lanes.task_triggers ?? []).map((t) => t.toLowerCase());
	const hit = triggers.find((t) => norm.includes(t)) ?? null;
	const dualOnAmbiguity = Boolean(lanes.dual_route_on_ambiguity ?? true);

	if (!hit) {
		return { lane: 'knowledge', dualRoute: false, reason: 'no-task-trigger' };
	}

	// «императив + объект»: триггер в начале или после конца предложения, объект есть,
	// и это не рефлексия. Граница справа — Unicode-aware (Python `\b` юникод-aware,
	// JS `\b` ASCII-only → используем negative-lookahead на букву/цифру/`_`).
	const escaped = hit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const impRe = new RegExp(`(^|[.!?]\\s*)(${escaped})(?![\\p{L}\\p{N}_])`, 'u');
	const looksImperative = impRe.test(norm) || norm.trim().startsWith(hit);
	const hasObject = norm.split(/\s+/).filter((w) => w.length > 0).length >= 2;
	const looksReflection = REFLECTION_MARKERS.some((m) => norm.includes(m));

	if (looksImperative && hasObject && !looksReflection) {
		return { lane: 'task', dualRoute: dualOnAmbiguity, reason: `task_trigger=${hit};imperative` };
	}
	// Совпало слово, но форма неоднозначна → дуал-роут, не теряем знание.
	return {
		lane: 'knowledge',
		dualRoute: dualOnAmbiguity,
		reason: `ambiguous_trigger=${hit};kept-as-knowledge`,
	};
}

// --- P0-1: явное исключение dot-папок (.quarantine/.tasks/.watermarks) ---------
/**
 * ЛЮБОЙ читатель raw/ обязан вызывать это: glob/rglob НЕ пропускает dot-папки сам.
 * Без явной проверки .quarantine/ и .tasks/ снова попадут в compile/query/digest
 * → ломается изоляция карантина (P0-1 из adversarial-проверки [ADR-0011]).
 */
export function shouldSkipRawPath(p: string): boolean {
	// pathlib.parts схлопывает '.' и пустые сегменты; повторяем это поведение.
	const parts = p.split(/[\\/]+/).filter((seg) => seg !== '' && seg !== '.');
	return parts.some((seg) => seg.startsWith('.'));
}

// --- Аудит-лог: строка ledger (НИКОГДА не содержимое) --------------------------
export function filterLogRecord(
	rawPath: string,
	clf: Classification,
	opts: {
		axis: string;
		lane?: LaneDecision | null;
		content?: string | null;
		policyVersion?: string;
		now?: Date;
	},
): FilterLogRecord {
	const { axis, lane = null, content = null, policyVersion = '', now } = opts;
	const rec: FilterLogRecord = {
		ts: (now ?? new Date()).toISOString(),
		raw_path: rawPath,
		axis,
		category: clf.label,
		action: clf.action,
		tier: clf.tier,
		reason: clf.reason,
		score: clf.score,
		policy_version: policyVersion,
	};
	if (content !== null) {
		rec.content_sha256 = 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex');
	}
	if (lane !== null) {
		rec.lane = lane.lane;
		rec.dual_route = lane.dualRoute;
	}
	return rec;
}
