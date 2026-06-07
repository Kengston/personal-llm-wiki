---
title: relevance-policy — owner-tunable filter policy
type: config
status: accepted
last_updated: 2026-06-07
sources:
  - ../docs/adr/0011-relevance-sensitivity-filter.md
---

# relevance-policy — политика фильтра (чувствительность + важность + лейн задач)

> Единственный tunable источник правил фильтра ([ADR-0011](../docs/adr/0011-relevance-sensitivity-filter.md)). `ingest/classifier.py` и compile-шаг читают **JSON-блок** ниже (stdlib `json`, без PyYAML — держим stdlib-only). Проза вокруг объясняет каждую ручку; каждое изменение политики — обычный git-diff, ревьюится и откатывается.
>
> **Граница двух репо ([ADR-0003]).** Здесь — ТОЛЬКО публичная схема + безопасные дефолты. **Персональные значения** (имена как триггеры, приватные домены, расширенные лексиконы) кладёшь в ПРИВАТНЫЙ репо `llm-wiki-content/.filter-policy.local.json` — он мёрджится поверх этого в рантайме. Кастом-лексикон NSFW-терминов в публичном репо = утечка, которую `lint_public.py` не ловит, поэтому он **только** приватно.

## Принципы (зашиты в дефолты)

- **Цель — рост и жизнь-менеджмент.** Чувствительные, но *полезные* данные (финансы/долги, здоровье-цели, право) — это ценность, их **ХРАНИМ как знание**, маскируя только опасные подстроки (номера карт/IBAN — делает sanitizer). Карантин — для *нежелательного*: NSFW, чужие персданные, токсик.
- **Карантин-не-удаление.** `raw/` иммутабелен, хард-delete нет. «drop» = «не промоутить в `wiki/`». Re-promote из карантина — один логируемый шаг.
- **Направление ошибок по оси:** *карантин* предпочитает ложно-**положительные** (переусердствовать дёшево — `raw/` хранит, байты локально); только *drop-from-wiki* — ложно-отрицательные.
- **Лейн-роутер консервативен в сторону ЗНАНИЯ** (плоское слово «buy» не должно топить «buy back my time by delegating»): диверт только при «императив + объект», на сомнении — дуал-роут.
- **v1 — только детерминированный Tier-1.** ML-модель (Tier-2) и облачная классификация важности — за ручками, дефолт консервативный.

```json
{
  "policy_version": "2026-06-07",
  "engine_classification": "on",

  "sensitivity": {
    "nsfw":        { "detect": ["source_class", "domain_blocklist"], "lexicon": "off", "action": "quarantine", "drop_from_wiki_confidence": 0.95, "favor": "false_positive" },
    "others_pii":  { "detect": ["keyword", "pii_density"], "action": "quarantine_and_redact", "favor": "false_positive" },
    "toxic":       { "detect": ["lexicon"], "action": "quarantine", "auto_drop": false, "favor": "false_positive" },

    "financial":   { "detect": ["keyword"], "action": "keep_redact_spans", "note": "долги/кто-кому — ХРАНИМ; sanitizer маскирует карты/IBAN/счёта" },
    "health":      { "detect": ["keyword"], "action": "keep_redact_spans", "cloud_classify": false, "note": "цели/здоровье — растовое знание; PHI не уходит в облако" },
    "legal":       { "detect": ["keyword"], "action": "keep_redact_spans", "note": "смысл храним; редактим чувствительные специфики" },

    "doomscroll":  { "detect": ["source_class"], "action": "leave_in_raw" }
  },

  "importance": {
    "signals": ["recurrence", "owner_authored", "maps_to_entity", "decision_language", "survives_settle"],
    "llm_score": "tiebreaker",
    "bands": { "high": "promote", "medium": "settle", "low": "leave_in_raw" },
    "settle_days": 7,
    "person_importance": "conservative_keep_and_owner_approve"
  },

  "lanes": {
    "router_bias": "knowledge",
    "task_shape": "imperative_plus_object",
    "task_triggers": ["купи", "закажи", "найди билет", "забронируй", "buy", "order", "book", "find me"],
    "dual_route_on_ambiguity": true,
    "task_sink": "raw/.tasks/inbox/",
    "task_log": "tasks/log.md",
    "dated_items_go_to": "reminders/"
  },

  "audit": {
    "ledger": "raw/.filter-log.jsonl",
    "log_verb": "filter",
    "quarantine_root": "raw/.quarantine/",
    "review": "batched_in_digest",
    "review_surfaces": "metadata_and_sample_only",
    "never_log_content": true
  },

  "tier2_local_model": { "enabled": false, "note": "ОТЛОЖЕНО до будущего ADR — ломает stdlib-only; калибровать на RU-данных" }
}
```

## Ручки, которые скорее всего захочешь крутить

- `engine_classification: off` — **privacy-max**: НИКАКОЙ облачной классификации; пограничное → карантин на ручное ревью.
- `sensitivity.*.action` — `quarantine` / `keep_redact_spans` / `leave_in_raw` / `quarantine_and_redact`. (Финансы/здоровье/право стоят на `keep_redact_spans` по твоему требованию — поменяй, если захочешь жёстче.)
- `sensitivity.nsfw.lexicon: on` — включить грубый словарный пре-фильтр (по умолчанию off: на русском informal-тексте даёт много ложных; реальный лексикон — в приватном `.local.json`).
- `importance.settle_days` — сколько идея «отлёживается» в `raw/`, прежде чем судить о durability.
- `lanes.task_triggers` — слова-триггеры чор; помни: роутер консервативен, на сомнении дуал-роутит.
