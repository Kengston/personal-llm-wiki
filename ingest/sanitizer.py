"""Sanitizer — маскер секретов и PII в write-path (fail-closed).

«Корона» ингеста. Маскирует секреты/PII в тексте источника ДО любой записи в
`raw/` приватного репо и ДО любого попадания в публичный репо. Это первая линия
defense-in-depth (CONTEXT §3 «Sanitizer — в write-path, fail-closed»;
[ADR-0003](../docs/adr/0003-two-repos-public-private.md);
[docs/research/privacy-security.md](../docs/research/privacy-security.md)).

Два яруса (research §«Sanitizer приватного write-path — fail-closed, два яруса»):

- ЯРУС-1 — СЕКРЕТЫ (block-on-detect). Известные форматы токенов/ключей/паролей
  по regex + неизвестные high-entropy-блобы по энтропии Шеннона
  (base64 ≥ 4.5, hex ≥ 3.0, на токенах длиной ≥ 20). Находка → замена на
  `[REDACTED:<type>]`. Если sanitizer падает (raise) — вызывающая сторона ДОЛЖНА
  отменить запись (`fail_closed_sanitize`), чтобы немаскированный секрет не попал
  в immutable git-историю.
- ЯРУС-2 — PII (mask-but-never-block). Email, телефоны, карты, IBAN, IP, crypto —
  маскируются, но промах НЕ блокирует запись (это не секрет). Имена/локации здесь
  НЕ детектируются: NER лоссов, а гарантия «ноль личного в публичном» — это
  граница двух репо (ADR-0003) + только синтетические примеры, а не детекция имён.

Публичный интерфейс (стабильный — на него опирается `scheduler/lint_public.py`):
    sanitize_text(text: str) -> str          # маскирует, возвращает чистый текст
    scan_secrets(text: str) -> list[str]     # только находит, НЕ мутирует
    fail_closed_sanitize(text: str) -> str   # обёртка: при любой ошибке raise

Зависимости: только stdlib (см. research — «stdlib-only парсеры в ingest»).
Совместимость: Python 3.9+ (системный python3 на хосте — 3.9).
"""

from __future__ import annotations

import math
import re
import sys
import unicodedata
from dataclasses import dataclass
from typing import List, Pattern, Tuple

# Метка замены. Тип помогает при ревью git-diff понять, ЧТО было замаскировано,
# не раскрывая значение. Формат: [REDACTED:<type>].
REDACTION_TEMPLATE = "[REDACTED:{kind}]"


def _redact(kind: str) -> str:
    """Единая точка формирования метки замены."""
    return REDACTION_TEMPLATE.format(kind=kind)


# ---------------------------------------------------------------------------
# ЯРУС-1 — СЕКРЕТЫ (структурные, по regex). Порядок важен: более специфичные
# паттерны идут раньше дженериков, иначе дженерик «съест» специфичный токен и
# тип в метке будет менее точным.
# ---------------------------------------------------------------------------

# Каждое правило — (kind, скомпилированный regex). `kind` уходит в [REDACTED:kind].
_SECRET_RULES: List[Tuple[str, Pattern[str]]] = [
    # --- Токены конкретно ЭТОГО проекта (research рекомендует тюнить под проект) ---
    # Telegram Bot API token: "<8-10 цифр>:<35 символов base64url>".
    ("telegram_bot_token", re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{35}\b")),
    # OpenAI / Codex ключи: sk-..., sk-proj-..., sk-ant-... и т.п.
    ("openai_key", re.compile(r"\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b")),

    # --- Распространённые облачные/VCS форматы ---
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,255}\b")),
    ("github_pat_fine", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{22,}\b")),
    ("slack_token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("aws_access_key", re.compile(r"\b(?:AKIA|ASIA|AGPA|AROA)[0-9A-Z]{16}\b")),
    ("google_api_key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    # Stripe live/test секреты.
    ("stripe_key", re.compile(r"\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b")),

    # --- JWT (header.payload.signature, всё base64url) ---
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")),

    # --- Bearer / Authorization заголовки ---
    ("bearer_token", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{16,}", re.IGNORECASE)),
    ("basic_auth", re.compile(r"\bBasic\s+[A-Za-z0-9+/=]{16,}", re.IGNORECASE)),

    # --- PEM приватные ключи (любой -----BEGIN ... PRIVATE KEY----- блок) ---
    (
        "private_key_pem",
        re.compile(
            r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----"
            r".*?"
            r"-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----",
            re.DOTALL,
        ),
    ),

    # --- URL c basic-auth внутри: scheme://user:pass@host ---
    ("url_credentials", re.compile(r"\b([a-z][a-z0-9+.-]*)://[^/\s:@]+:[^/\s:@]+@")),

    # --- Присвоения секретов: password=..., api_key: "...", secret => '...' ---
    # Ловит распространённые имена ключей с разделителем =, : или =>.
    (
        "assigned_secret",
        re.compile(
            r"""(?ix)                       # i: ignorecase, x: verbose
            \b
            (?:password|passwd|pwd|secret|token|api[_-]?key|apikey|
               access[_-]?token|auth[_-]?token|client[_-]?secret|
               private[_-]?key|session[_-]?key)
            \b
            \s*(?:=>|[:=])\s*               # разделитель
            ['"]?                            # опц. открывающая кавычка
            ([^\s'";,]{6,})                  # само значение (>=6 непробельных)
            """,
        ),
    ),
]


# ---------------------------------------------------------------------------
# ЯРУС-2 — PII (структурная: email/телефон/карта/IBAN/IP/crypto). По regex,
# mask-but-never-block. Имена/локации НЕ трогаем (см. docstring модуля).
# ---------------------------------------------------------------------------

_PII_RULES: List[Tuple[str, Pattern[str]]] = [
    # Email.
    ("email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    # IBAN (грубо: 2 буквы страны + 2 контрольные + 11..30 alnum).
    ("iban", re.compile(r"\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b")),
    # Банковская карта: 13-19 цифр, опц. разбитых пробелами/дефисами по 4.
    (
        "credit_card",
        re.compile(r"\b(?:\d[ -]?){12,18}\d\b"),
    ),
    # IPv4.
    (
        "ip_address",
        re.compile(r"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b"),
    ),
    # Bitcoin-адрес (legacy / bech32) — простое приближение.
    ("crypto_btc", re.compile(r"\b(?:bc1[a-z0-9]{20,60}|[13][A-HJ-NP-Za-km-z1-9]{25,34})\b")),
    # Телефоны: международный/российский. Маскируем только «длинные» (>=10 цифр),
    # чтобы не сжирать обычные числа; детальный фильтр — в _looks_like_phone.
    (
        "phone",
        re.compile(
            r"(?<![\w.])"                       # не часть слова/числа с точкой
            r"\+?\d[\d\s().-]{8,}\d"            # +7 (999) 123-45-67 и т.п.
            r"(?![\w])"
        ),
    ),
]


# ---------------------------------------------------------------------------
# Энтропия Шеннона — для НЕИЗВЕСТНЫХ high-entropy-блобов (ключи без явного
# формата). Пороги из research: base64 ≥ 4.5, hex ≥ 3.0; кандидаты длиной ≥ 20.
# ---------------------------------------------------------------------------

# Минимальная длина токена-кандидата для энтропийной проверки.
_ENTROPY_MIN_LEN = 20
# Порог для base64-подобных токенов (большой алфавит → высокая энтропия).
_ENTROPY_BASE64_THRESHOLD = 4.5
# Порог для hex-подобных токенов (алфавит 16 → потолок энтропии ~4.0).
_ENTROPY_HEX_THRESHOLD = 3.0

# Кандидат: «слово» из base64url/hex-символов. Разбиваем по пробелам/типичным
# разделителям, чтобы оценивать энтропию отдельных токенов, а не всей строки.
# `=` допускаем ТОЛЬКО как хвостовой padding base64 (`={1,2}` в конце), а не как
# глюк внутри токена — иначе кандидат «перепрыгнул» бы через `KEY=value` и съел
# имя переменной слева (баг с `GH=ghp_...`).
_TOKEN_CANDIDATE_RE = re.compile(r"[A-Za-z0-9+/_-]{%d,}={0,2}" % _ENTROPY_MIN_LEN)
_HEX_ONLY_RE = re.compile(r"\A[0-9a-fA-F]+\Z")
# Эвристика «выглядит как обычное слово/идентификатор», а не как секрет:
# естественный текст редко даёт энтропию выше порога, но подстрахуемся —
# исключаем токены без цифр и без смешения регистра (т.е. простые слова).
_HAS_DIGIT_RE = re.compile(r"\d")
_HAS_UPPER_RE = re.compile(r"[A-Z]")
_HAS_LOWER_RE = re.compile(r"[a-z]")


def shannon_entropy(s: str) -> float:
    """Энтропия Шеннона строки в битах на символ.

    Чем равномернее распределены символы (как в случайном ключе), тем выше
    значение. У осмысленного текста/повторов — ниже.
    """
    if not s:
        return 0.0
    # Частоты символов.
    freq = {}
    for ch in s:
        freq[ch] = freq.get(ch, 0) + 1
    length = len(s)
    entropy = 0.0
    for count in freq.values():
        p = count / length
        entropy -= p * math.log2(p)
    return entropy


def _is_high_entropy_secret(token: str) -> bool:
    """True, если токен похож на high-entropy-секрет по энтропии Шеннона.

    Применяем разные пороги к hex- и base64-подобным токенам (research),
    и фильтруем очевидно-несекретные токены (простые слова, повторы).
    """
    if len(token) < _ENTROPY_MIN_LEN:
        return False

    entropy = shannon_entropy(token)

    if _HEX_ONLY_RE.match(token):
        # Чистый hex (напр. SHA-подобное) — порог ниже (алфавит 16).
        return entropy >= _ENTROPY_HEX_THRESHOLD

    # base64url-подобное. Требуем хотя бы какой-то «разнобой», чтобы не ловить
    # длинные слова из одного регистра без цифр (напр. URL-сегменты-слова).
    has_mix = bool(_HAS_DIGIT_RE.search(token)) or (
        bool(_HAS_UPPER_RE.search(token)) and bool(_HAS_LOWER_RE.search(token))
    )
    if not has_mix:
        return False
    return entropy >= _ENTROPY_BASE64_THRESHOLD


def _looks_like_phone(match_text: str) -> bool:
    """Доп. фильтр телефона: 10..15 значащих цифр (E.164-диапазон).

    Отсекает случайные длинные числа (id, суммы), но пропускает реальные номера.
    """
    digits = re.sub(r"\D", "", match_text)
    return 10 <= len(digits) <= 15


# ---------------------------------------------------------------------------
# Результат сканирования (для отладки/аудита и для scan_secrets).
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Finding:
    """Одна находка сканера. `value` хранится ТОЛЬКО в памяти процесса для
    логики замены; наружу (scan_secrets) отдаём краткое описание без значения."""
    kind: str          # тип: telegram_bot_token | email | entropy:base64 | ...
    start: int         # позиция начала в исходном тексте
    end: int           # позиция конца
    value: str         # само совпадение (не логировать в открытый вывод!)


def _scan(text: str, include_pii: bool) -> List[Finding]:
    """Внутренний сканер: возвращает все находки (секреты + опц. PII).

    НЕ мутирует текст. Используется и sanitize_text (для замены), и scan_secrets.
    """
    findings: List[Finding] = []

    # --- ЯРУС-1: структурные секреты по regex ---
    for kind, pattern in _SECRET_RULES:
        for m in pattern.finditer(text):
            findings.append(Finding(kind, m.start(), m.end(), m.group(0)))

    # --- ЯРУС-1: энтропийные секреты (неизвестные форматы) ---
    for m in _TOKEN_CANDIDATE_RE.finditer(text):
        token = m.group(0)
        if _is_high_entropy_secret(token):
            sub = "entropy:hex" if _HEX_ONLY_RE.match(token) else "entropy:base64"
            findings.append(Finding(sub, m.start(), m.end(), token))

    # --- ЯРУС-2: PII (по запросу) ---
    if include_pii:
        for kind, pattern in _PII_RULES:
            for m in pattern.finditer(text):
                if kind == "phone" and not _looks_like_phone(m.group(0)):
                    continue
                findings.append(Finding(kind, m.start(), m.end(), m.group(0)))

    return findings


def _specificity(f: Finding) -> int:
    """Приоритет находки при разрешении перекрытий. Больше = важнее.

    Именованный (структурный) секрет/PII по regex точнее, чем дженерик-энтропия:
    напр. на `GH=ghp_...` энтропийный кандидат может начаться раньше (с `GH=`) и
    «съесть» префикс; именованное правило `github_token` должно победить, чтобы
    метка была точной, а безопасный префикс не пропал. Поэтому entropy:* — самый
    низкий приоритет."""
    return 0 if f.kind.startswith("entropy:") else 1


def _resolve_overlaps(findings: List[Finding]) -> List[Finding]:
    """Снимает перекрытия совпадений.

    Несколько правил могут поймать пересекающиеся диапазоны (напр. assigned_secret
    и entropy на одном токене, или entropy-префикс перед github_token). При замене
    это дало бы двойную замену/съеденный текст. Оставляем по одному совпадению на
    диапазон, отдавая приоритет: (1) более специфичному (именованное > entropy),
    (2) более раннему старту, (3) более длинному."""
    if not findings:
        return []
    # Сортируем: специфичность ↓, старт ↑, длина ↓. Так именованное правило
    # выбирается раньше пересекающегося entropy-кандидата, даже если тот начался
    # на пару символов левее.
    ordered = sorted(
        findings,
        key=lambda f: (-_specificity(f), f.start, -(f.end - f.start)),
    )
    result: List[Finding] = []
    for f in ordered:
        # Конфликт, если диапазон пересекается с уже принятым.
        if any(not (f.end <= a.start or f.start >= a.end) for a in result):
            continue
        result.append(f)
    # Возвращаем в порядке появления в тексте (для стабильной замены/вывода).
    result.sort(key=lambda f: f.start)
    return result


# ---------------------------------------------------------------------------
# Публичный интерфейс
# ---------------------------------------------------------------------------

def sanitize_text(text: str) -> str:
    """Маскирует секреты И PII в тексте, возвращает безопасную для записи строку.

    Это ОСНОВНАЯ функция write-path: вызывается на КАЖДОМ теле сообщения перед
    записью в `raw/`. Замена идёт с конца к началу, чтобы не сбить смещения.

    Замечание про fail-closed: сама по себе sanitize_text не «падает» на обычном
    тексте; ярус fail-closed реализует `fail_closed_sanitize`, который ловит
    любую неожиданную ошибку и пробрасывает её, чтобы вызывающий код отменил
    запись. Для реального write-path используйте именно `fail_closed_sanitize`.
    """
    if not text:
        return text

    # Нормализуем экзотические пробелы (WhatsApp LRM/NNBSP и пр.) — иначе они
    # могут «разрывать» паттерны и невидимо просочиться в raw/. NFKC сводит
    # совместимые формы; затем явно вычищаем zero-width/направляющие символы.
    text = _strip_invisible(text)

    findings = _resolve_overlaps(_scan(text, include_pii=True))
    if not findings:
        return text

    # Заменяем с конца, чтобы start/end оставшихся находок не «поехали».
    out = text
    for f in sorted(findings, key=lambda f: f.start, reverse=True):
        out = out[: f.start] + _redact(f.kind) + out[f.end :]
    return out


def scan_secrets(text: str) -> List[str]:
    """Возвращает список находок-СЕКРЕТОВ (ярус-1) БЕЗ мутации текста.

    Используется `scheduler/lint_public.py` как бэкстоп публичного репо: если
    список непустой — в публичный репо просочился секрет, линт фейлит билд.

    Формат элемента: "<kind>@<start>" — тип и позиция, БЕЗ самого значения
    (значение секрета не должно попасть в лог/CI-вывод). PII сюда НЕ включаем:
    линт публичного репо ищет именно секреты; PII в публичном не должно быть
    в принципе из-за границы двух репо, а телефоны/email в синтетическом
    примере — намеренно фейковые и не должны валить билд.
    """
    if not text:
        return []
    findings = _scan(_strip_invisible(text), include_pii=False)
    findings = _resolve_overlaps(findings)
    # Стабильный порядок: по позиции.
    findings.sort(key=lambda f: f.start)
    return ["{kind}@{pos}".format(kind=f.kind, pos=f.start) for f in findings]


def fail_closed_sanitize(text: str) -> str:
    """Fail-closed обёртка для write-path.

    Гарантия инварианта (CONTEXT §3): если санитизация по любой причине не
    отработала штатно — НИЧЕГО не возвращаем, а пробрасываем исключение, чтобы
    вызывающий код отменил запись (не создавал частичный/немаскированный
    `raw/`-файл). Дополнительно делаем «контрольный проход»: после маскирования
    повторно сканируем секреты, и если что-то осталось — это баг правил,
    лучше упасть, чем записать секрет.
    """
    try:
        cleaned = sanitize_text(text)
    except Exception as exc:  # noqa: BLE001 — намеренно широко: любой сбой = abort
        raise SanitizerError("sanitize_text упал — запись отменена") from exc

    # Контрольный проход: на выходе не должно остаться секретов яруса-1.
    residual = scan_secrets(cleaned)
    if residual:
        raise SanitizerError(
            "после санитизации остались секреты (%d) — запись отменена" % len(residual)
        )
    return cleaned


class SanitizerError(RuntimeError):
    """Поднимается, когда fail-closed-санитизация не может гарантировать чистоту.
    Вызывающий код ОБЯЗАН трактовать это как «не записывать»."""


# ---------------------------------------------------------------------------
# Невидимые/управляющие символы (WhatsApp LRM U+200E, NNBSP U+202F и пр.)
# ---------------------------------------------------------------------------

# Явный чёрный список zero-width и направляющих символов, которые ломают regex
# и могут невидимо просочиться (research: «невидимые LRM/NNBSP»).
_INVISIBLE_CHARS = (
    "​"  # zero width space
    "‌"  # zero width non-joiner
    "‍"  # zero width joiner
    "‎"  # left-to-right mark (LRM)
    "‏"  # right-to-left mark (RLM)
    "‪‫‬‭‮"  # bidi embeddings/overrides
    "⁠"  # word joiner
    "﻿"  # BOM / zero width no-break space
)
_INVISIBLE_RE = re.compile("[" + re.escape(_INVISIBLE_CHARS) + "]")


def _strip_invisible(text: str) -> str:
    """Убирает невидимые управляющие символы и нормализует пробелы.

    NNBSP (U+202F) и прочие «узкие неразрывные» сводим к обычному пробелу через
    NFKC, затем явно удаляем zero-width/bidi-метки."""
    # NFKC: совместимая нормализация (NNBSP → space, full-width → ascii и т.п.).
    text = unicodedata.normalize("NFKC", text)
    return _INVISIBLE_RE.sub("", text)


# ---------------------------------------------------------------------------
# __main__ — самотест на СИНТЕТИЧЕСКИХ строках (все значения фейковые).
# Запуск:  python3 -m ingest.sanitizer    (или python3 ingest/sanitizer.py)
# ---------------------------------------------------------------------------

def _selftest() -> int:
    """Прогон на синтетике. Возвращает 0 при успехе, 1 при провале.

    ВАЖНО: все «секреты» ниже выдуманы (фейковые ключи/телефоны/email) —
    это публичный репо, реальных данных тут быть не может.
    """
    print("sanitizer selftest — на синтетических строках (всё фейковое)\n")

    failures = 0

    def check(name: str, raw: str, must_redact: List[str], must_keep: List[str]) -> None:
        nonlocal failures
        out = sanitize_text(raw)
        ok = True
        for needle in must_redact:
            if needle in out:
                ok = False
                print("  [FAIL] %-22s не замаскировано: %r" % (name, needle))
        for needle in must_keep:
            if needle not in out:
                ok = False
                print("  [FAIL] %-22s потерян безопасный текст: %r" % (name, needle))
        if ok:
            print("  [ok]   %-22s -> %s" % (name, out))
        else:
            failures += 1
            print("         (исходник: %r)" % raw)
            print("         (вывод:    %r)" % out)

    # --- Секреты (ярус-1) — все ДОЛЖНЫ исчезнуть из вывода ---
    check(
        # 35 символов после двоеточия — точный формат Telegram Bot API.
        "telegram_bot_token",
        "токен бота 123456789:AAFakeFakeFakeFakeFakeFakeFake12345 конец",
        must_redact=["123456789:AAFakeFakeFakeFakeFakeFakeFake12345"],
        must_keep=["токен бота", "конец"],
    )
    check(
        "openai_key",
        "ключ sk-proj-AbCdEf0123456789AbCdEf0123456789 в конфиге",
        must_redact=["sk-proj-AbCdEf0123456789AbCdEf0123456789"],
        must_keep=["ключ", "в конфиге"],
    )
    check(
        "bearer",
        "Authorization: Bearer abcDEF123456ghiJKL789mnoPQR0 ок",
        must_redact=["abcDEF123456ghiJKL789mnoPQR0"],
        must_keep=["Authorization:", "ок"],
    )
    check(
        # header.payload.signature — три base64url-сегмента через точку.
        "jwt",
        "cookie eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3.fakefakefakeSIGN here",
        must_redact=["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3.fakefakefakeSIGN"],
        must_keep=["cookie", "here"],
    )
    check(
        "assigned_password",
        'config: password="SuperSecret123!" host=localhost',
        must_redact=["SuperSecret123!"],
        must_keep=["config:", "host=localhost"],
    )
    check(
        "github_token",
        "export GH=ghp_0123456789abcdefABCDEF0123456789abcdef done",
        must_redact=["ghp_0123456789abcdefABCDEF0123456789abcdef"],
        must_keep=["export GH=", "done"],
    )
    check(
        "url_credentials",
        "clone https://user:p4ssw0rd@example.com/repo.git now",
        must_redact=["p4ssw0rd"],
        must_keep=["clone", "now"],
    )
    check(
        "entropy_hex",
        "digest 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 end",
        must_redact=["9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"],
        must_keep=["digest", "end"],
    )

    # --- PII (ярус-2) — маскируются ---
    check(
        "email",
        "пиши на ivan.primer@example.com если что",
        must_redact=["ivan.primer@example.com"],
        must_keep=["пиши на", "если что"],
    )
    check(
        "phone",
        "звони +7 (999) 123-45-67 вечером",
        must_redact=["123-45-67"],
        must_keep=["звони", "вечером"],
    )
    check(
        "credit_card",
        "карта 4111 1111 1111 1111 истекает скоро",
        must_redact=["4111 1111 1111 1111"],
        must_keep=["карта", "истекает скоро"],
    )

    # --- Negative: обычный текст НЕ должен ломаться/переэкранироваться ---
    check(
        "plain_text_untouched",
        "Иван Пример любит горы и читает по выходным.",
        must_redact=[],
        must_keep=["Иван Пример любит горы и читает по выходным."],
    )
    # Короткий id / UUID-подобное не должно ловиться энтропией (длина/смешение).
    check(
        "short_id_kept",
        "заметка id=note-42 про встречу",
        must_redact=[],
        must_keep=["note-42", "про встречу"],
    )

    # --- Невидимые символы: LRM/NNBSP должны исчезнуть ---
    dirty = "сообщение‎с невидимыми"
    cleaned = sanitize_text(dirty)
    if "‎" in cleaned or " " in cleaned:
        failures += 1
        print("  [FAIL] invisible_chars        остались управляющие символы: %r" % cleaned)
    else:
        print("  [ok]   invisible_chars        -> %r" % cleaned)

    # --- scan_secrets НЕ мутирует и НЕ включает PII ---
    sample = "key sk-ant-FAKE0123456789FAKE0123456789 mail a@b.co"
    found = scan_secrets(sample)
    has_secret = any(f.startswith("openai_key") for f in found)
    has_email = any(f.startswith("email") for f in found)
    if has_secret and not has_email:
        print("  [ok]   scan_secrets           -> %s" % found)
    else:
        failures += 1
        print("  [FAIL] scan_secrets           ожидали секрет без email, got %s" % found)

    # --- fail_closed_sanitize: чистый вывод не содержит секретов ---
    try:
        safe = fail_closed_sanitize("token sk-FAKE0123456789FAKE0123456789 ok")
        if scan_secrets(safe):
            failures += 1
            print("  [FAIL] fail_closed            остались секреты после обёртки")
        else:
            print("  [ok]   fail_closed_sanitize   -> %s" % safe)
    except SanitizerError as exc:
        failures += 1
        print("  [FAIL] fail_closed            неожиданный abort: %s" % exc)

    print()
    if failures:
        print("ИТОГ: %d проверок упало" % failures)
        return 1
    print("ИТОГ: все проверки прошли")
    return 0


if __name__ == "__main__":
    sys.exit(_selftest())
