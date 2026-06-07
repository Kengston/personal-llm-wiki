"""classifier.py — Tier-1 ФИЛЬТР чувствительности + роутер «задача vs знание».

НАЗНАЧЕНИЕ ([ADR-0011])
======================
Sibling к `sanitizer.py`, НЕ внутри него — противоположная семантика отказа:
  • sanitizer: секреты fail-CLOSED (abort write), PII mask-in-place.
  • classifier: чувствительность fail-TO-QUARANTINE (маршрутизирует ЦЕЛЫЙ документ),
    важность/лейн — выбор куда положить, без удаления.

Две оси + роутер (никогда не один гейт «выкинуть плохое/ненужное»):
  • Ось A (чувствительность) — здесь, on-device, ДО облака. Tier-1 детерминированный:
    source_class + domain_blocklist + (opt-in) lexicon + pii_density. БЕЗ ML, БЕЗ embedder.
  • Ось B (важность) — НЕ здесь: расширение compile-решения (LLM 1–10 как тай-брейкер).
  • Роутер «задача vs знание» — здесь, консервативен В СТОРОНУ ЗНАНИЯ.

ИНВАРИАНТЫ
  • Finding-discipline: возвращаем label/score/tier/reason/action — НИКОГДА не содержимое.
  • Карантин предпочитает ложно-ПОЛОЖИТЕЛЬНЫЕ (raw/ хранит → дёшево); drop-from-wiki — нет.
  • Карантин ПОБЕЖДАЕТ лейн (чувствительная чора → карантин, не .tasks/).
  • Политика — из compiler/relevance-policy.md (JSON-блок) + приватный .local.json override.
  • stdlib-only. Tier-2 ML — ОТЛОЖЕН (см. ADR-0011).
"""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

# Нормализацию переиспользуем из sanitizer, чтобы обфускация не проскочила лексикон.
try:
    from .sanitizer import _strip_invisible as _san_strip  # type: ignore
except Exception:  # pragma: no cover - sanitizer может быть импортирован иначе
    _san_strip = None

# --- Действия (по убыванию строгости: меньший индекс = строже = ПОБЕЖДАЕТ) ------
_ACTION_PRECEDENCE = [
    "quarantine",            # целый док в raw/.quarantine/<cat>/
    "quarantine_and_redact",
    "keep_redact_spans",     # ХРАНИМ как знание; sanitizer маскирует опасные подстроки
    "leave_in_raw",          # не промоутить в wiki/ (но raw/ хранит)
    "normal",                # обычный путь
]
def _stricter(a: str, b: str) -> str:
    ia = _ACTION_PRECEDENCE.index(a) if a in _ACTION_PRECEDENCE else 99
    ib = _ACTION_PRECEDENCE.index(b) if b in _ACTION_PRECEDENCE else 99
    return a if ia <= ib else b

# Безопасные ОБЩИЕ дефолт-кейворды (расширение — в приватном .local.json).
_DEFAULT_KEYWORDS = {
    "financial": ["долг", "должен", "займ", "iban", "оплат", "счёт", "invoice", "owe", "debt"],
    "health":    ["диагноз", "болезн", "симптом", "therapy", "терап", "health", "лекарств"],
    "legal":     ["контракт", "договор", "иск", "суд", "nda", "lawsuit", "арбитраж"],
    "toxic":     [],   # реальный лексикон — приватно; по умолчанию пусто (RU informal даёт ложные)
}
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
_PHONE_RE = re.compile(r"(?<!\d)(?:\+?\d[\d\-\s()]{8,}\d)(?!\d)")


@dataclass(frozen=True)
class Classification:
    """Результат оси A. Содержит только метаданные — НИКОГДА не текст."""
    label: str          # nsfw | others_pii | toxic | financial | health | legal | doomscroll | normal
    action: str         # см. _ACTION_PRECEDENCE
    tier: int           # 1 = детерминированный on-device
    reason: str         # человекочитаемая причина (provenance), без содержимого
    score: float | None = None


@dataclass(frozen=True)
class LaneDecision:
    lane: str           # "knowledge" | "task"
    dual_route: bool    # True → и в task-log, И видимо для compile (на сомнении)
    reason: str


# --- Загрузка политики --------------------------------------------------------
_JSON_BLOCK = re.compile(r"```json\s*(\{.*?\})\s*```", re.S)

def load_policy(public_md: str | Path | None = None,
                private_override: str | Path | None = None) -> dict:
    """Читает JSON-блок из compiler/relevance-policy.md + мёрджит приватный .local.json.

    Граница двух репо: персональные лексиконы/имена живут ТОЛЬКО в приватном override.
    """
    md = Path(public_md) if public_md else Path(__file__).resolve().parent.parent / "compiler" / "relevance-policy.md"
    policy: dict = {}
    try:
        m = _JSON_BLOCK.search(md.read_text(encoding="utf-8"))
        if m:
            policy = json.loads(m.group(1))
    except Exception:
        policy = {}
    if private_override and Path(private_override).exists():
        try:
            _deep_merge(policy, json.loads(Path(private_override).read_text(encoding="utf-8")))
        except Exception:
            pass
    return policy

def _deep_merge(base: dict, over: dict) -> dict:
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _deep_merge(base[k], v)
        else:
            base[k] = v
    return base


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    if _san_strip:
        try:
            text = _san_strip(text)
        except Exception:
            pass
    return text.lower()


# --- Детекторы (Tier-1, детерминированные) ------------------------------------
def _match_source_class(meta: dict, classes: list[str]) -> bool:
    sc = (meta or {}).get("source_class", "")
    return bool(sc) and sc in set(classes or [])

def _match_domain_blocklist(text: str, meta: dict, blocklist: list[str]) -> str | None:
    hay = " ".join([text, " ".join(str(v) for v in (meta or {}).values())]).lower()
    for dom in (blocklist or []):
        d = str(dom).split("#")[0].strip().lower()
        if d and d in hay:
            return d
    return None

def _match_keyword(text: str, words: list[str]) -> str | None:
    for w in (words or []):
        w = w.strip().lower()
        if w and w in text:
            return w
    return None

def _pii_density(text: str) -> int:
    return len(_EMAIL_RE.findall(text)) + len(_PHONE_RE.findall(text))


# --- Ось A: классификация чувствительности ------------------------------------
def classify_sensitivity(text: str, source_meta: dict | None = None,
                         policy: dict | None = None) -> Classification:
    """Tier-1 детерминированная классификация ЦЕЛОГО документа. On-device, без egress."""
    policy = policy or load_policy()
    meta = source_meta or {}
    norm = _normalize(text or "")
    sens = (policy.get("sensitivity") or {})

    best = Classification(label="normal", action="normal", tier=1, reason="no-signal")
    for cat, cfg in sens.items():
        cfg = cfg or {}
        detect = cfg.get("detect", [])
        action = cfg.get("action", "normal")
        hit_reason = None

        if "source_class" in detect and _match_source_class(meta, cfg.get("source_classes", _SRC_DEFAULTS.get(cat, []))):
            hit_reason = f"source_class={meta.get('source_class')}"
        if not hit_reason and "domain_blocklist" in detect:
            dom = _match_domain_blocklist(norm, meta, cfg.get("domain_blocklist", []))
            if dom:
                hit_reason = f"domain_blocklist={dom}"
        if not hit_reason and "keyword" in detect:
            kw = _match_keyword(norm, cfg.get("keywords", _DEFAULT_KEYWORDS.get(cat, [])))
            if kw:
                hit_reason = f"keyword={kw}"
        if not hit_reason and "lexicon" in detect and cfg.get("lexicon") == "on":
            kw = _match_keyword(norm, cfg.get("lexicon_words", []))
            if kw:
                hit_reason = f"lexicon={kw}"
        if not hit_reason and "pii_density" in detect and _pii_density(norm) >= int(cfg.get("pii_density_threshold", 5)):
            hit_reason = f"pii_density>={cfg.get('pii_density_threshold', 5)}"

        if hit_reason:
            cand = Classification(label=cat, action=action, tier=1, reason=hit_reason)
            # Карантин ПОБЕЖДАЕТ: берём более строгое действие.
            if _stricter(cand.action, best.action) == cand.action and cand.action != best.action:
                best = cand
            elif best.label == "normal":
                best = cand
    return best


# дефолтные source_class-метки по категориям (расширяй в политике/приватно)
_SRC_DEFAULTS = {
    "nsfw": ["adult", "porn"],
    "doomscroll": ["feed", "shorts", "reels"],
}


# --- Роутер «задача vs знание» (консервативен В СТОРОНУ ЗНАНИЯ) ----------------
def route_lane(text: str, source_meta: dict | None = None,
               policy: dict | None = None) -> LaneDecision:
    """Дивертит в TASK только при форме «императив + объект». На сомнении — дуал-роут."""
    policy = policy or load_policy()
    lanes = (policy.get("lanes") or {})
    if lanes.get("router_bias", "knowledge") != "knowledge":
        pass  # сейчас поддерживаем только knowledge-bias; иное оставляем knowledge
    norm = _normalize(text or "")
    triggers = [t.lower() for t in lanes.get("task_triggers", [])]
    hit = next((t for t in triggers if t in norm), None)
    if not hit:
        return LaneDecision(lane="knowledge", dual_route=False, reason="no-task-trigger")

    # «императив + объект»: после триггера есть содержательный объект, и это не рефлексия.
    looks_imperative = bool(re.search(r"(^|[\.\!\?]\s*)(" + re.escape(hit) + r")\b", norm)) or norm.strip().startswith(hit)
    has_object = len(norm.split()) >= 2
    reflection_markers = ("я думаю", "хочу научиться", "по жизни", "в целом", "delegat", "career", "карьер")
    looks_reflection = any(m in norm for m in reflection_markers)

    if looks_imperative and has_object and not looks_reflection:
        return LaneDecision(lane="task", dual_route=bool(lanes.get("dual_route_on_ambiguity", True)),
                            reason=f"task_trigger={hit};imperative")
    # Совпало слово, но форма неоднозначна → дуал-роут (и task, и видимо compile), не теряем знание.
    return LaneDecision(lane="knowledge",
                        dual_route=bool(lanes.get("dual_route_on_ambiguity", True)),
                        reason=f"ambiguous_trigger={hit};kept-as-knowledge")


# --- P0-1: явное исключение dot-папок (.quarantine/.tasks/.watermarks) ---------
def should_skip_raw_path(path: str | Path) -> bool:
    """ЛЮБОЙ читатель raw/ обязан вызывать это: rglob НЕ пропускает dot-папки сам.

    Без явной проверки .quarantine/ и .tasks/ снова попадут в compile/query/digest
    → ломается изоляция карантина (P0-1 из adversarial-проверки ADR-0011).
    """
    return any(part.startswith(".") for part in Path(path).parts)


# --- Аудит-лог: строка ledger (НИКОГДА не содержимое) --------------------------
def filter_log_record(raw_path: str, clf: Classification, *, axis: str,
                      lane: LaneDecision | None = None,
                      content: str | None = None, policy_version: str = "") -> dict:
    rec = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "raw_path": raw_path,
        "axis": axis,
        "category": clf.label,
        "action": clf.action,
        "tier": clf.tier,
        "reason": clf.reason,
        "score": clf.score,
        "policy_version": policy_version,
    }
    if content is not None:
        rec["content_sha256"] = "sha256:" + hashlib.sha256(content.encode("utf-8", "replace")).hexdigest()
    if lane is not None:
        rec["lane"] = lane.lane
        rec["dual_route"] = lane.dual_route
    return rec


if __name__ == "__main__":  # быстрый дым-тест на СИНТЕТИКЕ
    pol = load_policy()
    for t, meta in [
        ("Я должен Ивану 5000 за билеты", {"source_class": "telegram"}),
        ("купи молоко и хлеб", {"source_class": "telegram"}),
        ("хочу научиться делегировать, чтобы buy back my time", {"source_class": "note"}),
        ("explicit adult content", {"source_class": "adult"}),
    ]:
        c = classify_sensitivity(t, meta, pol)
        l = route_lane(t, meta, pol)
        print(f"sens={c.label}/{c.action} ({c.reason}) | lane={l.lane} dual={l.dual_route} ({l.reason})")
