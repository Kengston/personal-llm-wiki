"""lint_public.py — guard публичного репо: ноль секретов, ноль реальных PII.

НАЗНАЧЕНИЕ
==========
Это бэкстоп границы двух репо (ADR-0003): публичный фреймворк-репо
`personal-llm-wiki` физически не содержит `raw/`/`wiki/`/`reminders/` — только
код, доки и СИНТЕТИЧЕСКИЙ labelled-пример. Этот линт — последний рубеж: проходит
по всему публичному дереву и ФЕЙЛИТ (exit 1, печатает нарушителей), если находит
(а) секрет (через общий ingest.sanitizer.scan_secrets) или (б) известный PII-паттерн
(реальный телефон/email/Telegram-bot-token и т.п.), не помеченный как синтетический.

Предназначен для pre-commit-хука И CI (research/privacy-security.md: «pre-commit
одного мало — нужен CI», локальный хук обходится `--no-verify`/`SKIP=`). Здесь —
быстрый Python-gate; gitleaks/trufflehog в CI — отдельный, ещё более широкий слой
(см. setup/SETUP.md и privacy-security.md).

ВАЖНО про границу: scan_secrets — ОБЩИЙ детектор секретов из ingest (НЕ
переопределяем — правило брифа и инвариант «sanitizer — один на write-path»).
Мы НЕ редетектируем имена людей (PERSON-NER лоссов и в публичном репо не нужен:
гарантия чистоты — это граница двух репо + only-synthetic-examples, research).
Зато ловим СТРУКТУРНЫЕ PII-паттерны (телефон/email/bot-token), которые в публичном
коде почти всегда = случайная утечка реальных данных.

ИСПОЛЬЗОВАНИЕ
  python -m scheduler.lint_public                 # линт всего публичного репо
  python -m scheduler.lint_public --root /path    # явный корень
  python -m scheduler.lint_public --files a.py b.md  # только эти файлы (pre-commit)
  python -m scheduler.lint_public --quiet         # печатать только нарушения

КОДЫ ВЫХОДА: 0 — чисто; 1 — найдены нарушения (CI/хук фейлит билд/коммит).
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

# --- bootstrap sys.path -----------------------------------------------------
# Этот линт должен запускаться ДВУМЯ способами:
#   python3 -m scheduler.lint_public      (из корня репо — корень уже на sys.path)
#   python3 scheduler/lint_public.py      (по пути — pre-commit-хук так и делает)
# Во втором случае на sys.path[0] стоит каталог scheduler/, а НЕ корень репо,
# поэтому `from ingest.sanitizer import ...` падает с ModuleNotFoundError. Кладём
# корень репо (родитель каталога scheduler/) в начало sys.path ДО импорта ingest,
# чтобы оба способа запуска находили пакет ingest. Идемпотентно (не дублируем).
_REPO_ROOT = str(Path(__file__).resolve().parent.parent)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# ОБЩИЙ детектор секретов из ingest — не свой. Это и есть «scheduler/lint
# IMPORTS ingest/sanitizer» из брифа: один источник правил детекции секретов.
from ingest.sanitizer import scan_secrets  # noqa: E402 — после bootstrap sys.path

# ---------------------------------------------------------------------------
# Что сканируем / что пропускаем
# ---------------------------------------------------------------------------

#: Расширения текстовых файлов, которые имеет смысл сканировать. Бинарь/медиа
#: пропускаем (там scan_secrets бессмыслен и медленен).
_TEXT_SUFFIXES = {
    ".md", ".py", ".txt", ".toml", ".cfg", ".ini", ".env", ".example",
    ".plist", ".sh", ".json", ".yaml", ".yml", ".html", ".js", ".ts",
}

#: Директории, которые НИКОГДА не сканируем (служебные/сгенерированные).
_SKIP_DIRS = {
    ".git", "__pycache__", ".venv", "venv", "node_modules", ".idea", ".vscode",
    ".mypy_cache", ".pytest_cache", ".ruff_cache", "dist", "build",
    "graphify-out", ".DS_Store",
}

#: Маркеры, разрешающие реальную-выглядящую строку как ЗАВЕДОМО синтетическую.
#: Пример-вика и .env.example специально содержат fake-токены/телефоны —
#: фейлить на них нельзя, иначе линт бесполезен. Совпадает с ADR-0003/research:
#: пример в публичном — синтетический и ВИДИМО-labelled (frontmatter
#: `status: synthetic-example`, имена «Иван Пример», fake-id).
_SYNTHETIC_MARKERS = (
    "synthetic-example",
    "synthetic_example",
    "synthetic",     # любой явный self-label «synthetic …» (тест-векторы, фикстуры)
    "fake",          # FAKE / Fake / fake — самый частый маркер тест-векторов
    "example-only",
    "example",       # EXAMPLE-* / bare EXAMPLE-маркер
    "example.com",   # example.com/.org/.net — стандартные RFC2606 demo-домены
    "example.org",
    "example.net",
    "пример",  # «Иван Пример», «пример» в labelled-демо
    "замени",  # «ЗАМЕНИ_МЕНЯ»-плейсхолдер (рус. replace-me)
    "placeholder",
    "redacted",      # уже замаскированное значение ([REDACTED:...]) — не секрет
    "do-not-use",    # DO-NOT-USE / do_not_use — явный «не настоящий» маркер
    "do_not_use",
    "replace_me",    # replace_me / REPLACE_ME — плейсхолдер
    "replace-me",
    "<your",       # <YOUR_TOKEN_HERE>-плейсхолдеры в .env.example
    "xxxxx",
    "123456:aa",   # канонический fake Telegram-bot-token из research
)

#: Угловой <...>-плейсхолдер (например `<TOKEN>`, `<your-key>`, `<секрет>`).
#: В коде/доках такая запись — это слот «вставь сюда своё», а не утечка.
_ANGLE_PLACEHOLDER_RE = re.compile(r"<[^<>\n]{1,40}>")

#: Файлы/пути, которые целиком освобождены от PII-паттерн-проверки, потому что
#: ИХ НАЗНАЧЕНИЕ — содержать плейсхолдеры/синтетику. scan_secrets по ним всё равно
#: гоняется (настоящий секрет недопустим даже в .env.example).
_PII_EXEMPT_PATH_PARTS = (
    "wiki-example",           # синтетическая пример-вика
    ".env.example",           # плейсхолдеры
    "lint_public.py",         # ЭТОТ файл (содержит regex-паттерны PII по природе)
    "reminders_spec.md",      # спека показывает формат на fake-примерах
    "routines/README.md",     # каталог routine'ов цитирует fake-токены в примерах
    "/docs/",                 # research/ADR цитируют fake-токены как примеры форматов
)

#: Пути, где КЛАСС СЕКРЕТОВ (ярус-1 scan_secrets) заведомо иллюстративен и его
#: надо пропускать — но PII (ярус-2, ниже) там ВСЁ РАВНО ищем (реальный email/
#: телефон, не example.com, обязан зафейлить даже здесь). Два известных «дома»:
#:   • ingest/sanitizer.py — это САМ детектор: его regex-паттерны (scheme://
#:     user:pass@host, password=..., token=…) и синтетические self-test-векторы
#:     (FAKE-ключи, demo-base64/hex) — единственное место, где строки-ФОРМЫ
#:     секретов живут легитимно по дизайну (см. docstring sanitizer.py);
#:   • docs/research/** — библиография примеров/исследований: длинные slug'и URL
#:     и base64-иллюстрации форматов, не настоящие токены.
#: ВАЖНО: это allowlist ТОЛЬКО для [secret]. PII-проход не отключается этим
#: (для docs/ PII-исключение отдельно задаётся `/docs/` в _PII_EXEMPT_PATH_PARTS;
#: для ingest/sanitizer.py PII продолжает проверяться).
_SECRET_ILLUSTRATIVE_PATH_PARTS = (
    "ingest/sanitizer.py",    # сам детектор: его паттерны + self-test-векторы
    "docs/research/",         # research-библиография примеров секретов/форматов
    "lint_public.py",         # ЭТОТ файл: содержит secret-ФОРМЫ в regex/комментах
                              # по природе (как и sanitizer.py). PII тут отдельно
                              # exempt'ится через _PII_EXEMPT_PATH_PARTS.
)


# ---------------------------------------------------------------------------
# Известные структурные PII-паттерны (реальные данные ⇒ утечка)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PiiPattern:
    """Именованный PII-паттерн. `name` идёт в отчёт о нарушении."""

    name: str
    regex: re.Pattern[str]
    why: str  # человекочитаемое «почему это PII» для отчёта


#: Структурные паттерны. Намеренно консервативные (низкий false-positive):
#: ловим формы, которые в ПУБЛИЧНОМ коде-портфолио почти наверняка = реальные
#: личные данные. Имена НЕ детектим (см. док модуля).
_PII_PATTERNS: tuple[PiiPattern, ...] = (
    PiiPattern(
        "telegram_bot_token",
        # 8–10 цифр : 35 url-safe символов — формат Bot API токена (research
        # /privacy-security.md рекомендует ровно этот regex для .gitleaks.toml).
        re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{35}\b"),
        "похоже на реальный Telegram bot token",
    ),
    PiiPattern(
        "anthropic_key",
        # Anthropic API key: `sk-ant-...`. Движок v1 — Claude-native (ADR-0008),
        # поэтому утёкший Anthropic-ключ — самый вероятный секрет в этом проекте.
        # Проверяем ПЕРВЫМ (до общего sk-, иначе тот съест префикс).
        re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b"),
        "похоже на Anthropic API key (sk-ant-...)",
    ),
    PiiPattern(
        "openai_key",
        # Универсальный `sk-...` — ловит OpenAI и прочие провайдеры (Grok/Codex —
        # отложенные адаптеры, ADR-0008; ключ к ним тоже не должен утечь).
        re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"),
        "похоже на API key провайдера (sk-...)",
    ),
    PiiPattern(
        "email",
        # Консервативный email; исключаем очевидно-пример-домены ниже по маркеру.
        re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
        "реальный email-адрес",
    ),
    PiiPattern(
        "ru_phone",
        # Российский телефон в популярных написаниях: +7/8 + 10 цифр с разделителями.
        re.compile(r"(?<!\d)(?:\+7|8)[\s\-(]?\d{3}[\s\-)]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}(?!\d)"),
        "похоже на реальный российский номер телефона",
    ),
    PiiPattern(
        "intl_phone",
        # Обобщённый международный E.164-ish: + и 11–15 цифр подряд.
        re.compile(r"(?<!\d)\+\d{11,15}(?!\d)"),
        "похоже на международный номер телефона",
    ),
    PiiPattern(
        "telegram_chat_id",
        # Явный реальный owner chat_id в коде (длинный) — fake в research = 111111111.
        # Ловим присваивания вида OWNER_CHAT_ID=<8+ значащих цифр>, но fake-маркер
        # (повтор одной цифры) отсеется проверкой синтетичности на строке.
        re.compile(r"(?i)(?:owner_chat_id|telegram_owner_chat_id)\s*[=:]\s*['\"]?(\d{7,})"),
        "похоже на реальный Telegram owner chat_id",
    ),
)

#: Домены email, которые считаем синтетическими (не PII).
_EXAMPLE_EMAIL_DOMAINS = ("example.com", "example.org", "example.net", "primer.ru", "test.local")


# ---------------------------------------------------------------------------
# Модель нарушения
# ---------------------------------------------------------------------------


@dataclass
class Offence:
    """Одно нарушение чистоты публичного репо."""

    path: Path
    line_no: int
    kind: str  # "secret" | имя PII-паттерна
    detail: str  # что именно (РЕДАКТИРОВАННО — без полного значения секрета)

    def render(self, root: Path) -> str:
        try:
            rel = self.path.relative_to(root)
        except ValueError:
            rel = self.path
        return f"{rel}:{self.line_no}: [{self.kind}] {self.detail}"


# ---------------------------------------------------------------------------
# Логика сканирования
# ---------------------------------------------------------------------------


def _redact(value: str, keep: int = 4) -> str:
    """Показать только начало значения, остальное — `***`. Чтобы сам отчёт линта
    не печатал секрет целиком (research: gitleaks `--redact`-эквивалент)."""
    value = value.strip()
    if len(value) <= keep:
        return "***"
    return value[:keep] + "***"


#: Очевидно-фейковые числовые плейсхолдеры (повтор одной цифры ≥6 раз, либо
#: тривиальная последовательность 123456789/0123456789). Канонический fake
#: owner chat_id из research — `111111111`. Такие — НЕ реальные PII.
_FAKE_NUMERIC = re.compile(r"(?:(\d)\1{5,})|(?:0?123456789\d*)")


def _line_is_synthetic(line: str) -> bool:
    """Строка явно помечена как синтетическая/плейсхолдер?

    Признаём синтетикой: (а) явный текстовый маркер (`synthetic-example`,
    «Пример», `example.com`, `<your...`, fake-токен `123456:AA…`); (б) строку,
    где «реальное-выглядящее» число на деле — очевидный фейк (повтор одной цифры
    `111111111`, последовательность `123456789`). Иначе линт фейлил бы
    легитимные плейсхолдеры в SETUP.md/.env.example."""
    low = line.lower()
    if any(marker in low for marker in _SYNTHETIC_MARKERS):
        return True
    if _FAKE_NUMERIC.search(line):
        return True
    # `<...>`-плейсхолдер на строке (`<TOKEN>`, `<your-key>`, `<секрет>`) — слот
    # «вставь своё», а не секрет.
    if _ANGLE_PLACEHOLDER_RE.search(line):
        return True
    return False


def _file_is_pii_exempt(path: Path) -> bool:
    """Файл освобождён от PII-паттерн-проверки (но не от scan_secrets)?"""
    s = str(path).replace("\\", "/")
    return any(part in s for part in _PII_EXEMPT_PATH_PARTS)


def _file_is_secret_illustrative(path: Path) -> bool:
    """Файл — известный «дом» иллюстративных СЕКРЕТОВ (ingest/sanitizer.py или
    docs/research/**)? Если да — [secret]-находки scan_secrets там пропускаем,
    но PII-проход (ярус-2) продолжает работать (см. _SECRET_ILLUSTRATIVE_PATH_PARTS)."""
    s = str(path).replace("\\", "/")
    return any(part in s for part in _SECRET_ILLUSTRATIVE_PATH_PARTS)


#: RHS присваивания, считающийся НЕ-литералом (значение не захардкожено, а
#: читается из конфига/окружения/заголовка/вызова). Такой `secret = <не-литерал>`
#: — чтение конфига, а не утёкший секрет.
#:
#: НАМЕРЕННО консервативно (fail-closed): признаём не-литералом ТОЛЬКО формы с
#: однозначным синтаксисом, который НЕ может совпасть с самим значением секрета:
#:   • os.environ / os.getenv          — чтение окружения;
#:   • любой вызов `foo(...)` / `x.get(...)` — есть `(`, чего в плоском токене нет;
#:   • доступ к атрибуту `a.b[.c…]`    — есть `.`, что отличает от плоского токена
#:                                       (это и есть кейс `settings.webhook_secret`).
#: ВАЖНО: «голое имя переменной» и «индексация» НЕ включены сюда специально —
#: незакавыченное hardcode-значение секрета (`password=Gt5Yh8Jk2…`) синтаксически
#: НЕОТЛИЧИМО от ссылки на переменную (`password=UPSTREAM`), поэтому такие формы
#: оставляем фейлиться (лучше попросить пометить маркером, чем пропустить утечку).
#: Литерал-секрет (`secret = "AbC…"`) под это правило не подпадает в любом случае.
_NON_LITERAL_RHS_RE = re.compile(
    r"""(?ix)
    \s*(?:=>|[:=])\s*                  # разделитель присваивания (=, :, =>)
    (?!['"])                            # СРАЗУ не строковый литерал (нет кавычки)
    (?:
        os\s*\.\s*(?:environ|getenv)\b  # os.environ[...] / os.getenv(...)
      | [A-Za-z_][\w]*\s*\(             # любой вызов: foo(...), x.get(...)
      | [A-Za-z_][\w]*\s*\.\s*[\w.]+    # доступ к атрибуту: settings.webhook_secret
    )
    """
)


def _secret_assignment_rhs_is_non_literal(line: str) -> bool:
    """True, если в строке вида `<secret-name> = <RHS>` правая часть — НЕ строковый
    литерал, а чтение конфига: os.environ/getenv, вызов или доступ к атрибуту.

    Цель — отличить «утёкший хардкод-секрет» (`token = "ghp_real…"`, фейлим) от
    «чтение конфига» (`secret = state.settings.webhook_secret`, ОК — это не
    утечка, реальное значение приходит из окружения в рантайме). Применяется
    ТОЛЬКО к secret-присваиваниям kind == assigned_secret в обычных code-файлах;
    на сырой токен/ключ без `=` не влияет. Сознательно НЕ распознаёт «голую
    переменную»/индексацию (см. _NON_LITERAL_RHS_RE — fail-closed).
    """
    return bool(_NON_LITERAL_RHS_RE.search(line))


def _email_is_example(match: str) -> bool:
    low = match.lower()
    return any(low.endswith("@" + d) or low.endswith("." + d) for d in _EXAMPLE_EMAIL_DOMAINS)


def scan_file(path: Path, *, pii_exempt: bool | None = None) -> list[Offence]:
    """Просканировать один файл. Возвращает список нарушений (пустой = чисто).

    Два независимых прохода:
      1. scan_secrets (ОБЩИЙ детектор из ingest) — по всему тексту файла.
      2. структурные PII-паттерны построчно (если файл не PII-exempt и строка
         не помечена синтетической).
    """
    offences: list[Offence] = []
    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return offences  # бинарь/нечитаемое — пропускаем

    lines = text.splitlines()
    line_starts = _line_start_offsets(text)

    # Известный «дом» иллюстративных секретов (sanitizer.py / docs/research/**)?
    # Там [secret]-находки scan_secrets пропускаем (это паттерны детектора и его
    # синтетические тест-векторы / research-примеры форматов), но PII-проход
    # ниже всё равно отрабатывает — реальный email/телефон обязан зафейлить.
    secret_illustrative = _file_is_secret_illustrative(path)

    # --- проход 1: общий детектор секретов (по всему файлу) ----------------
    # КОНТРАКТ ingest.sanitizer.scan_secrets(text)->list[str]: элементы — НЕ
    # сами значения, а строки вида "<kind>@<offset>" (тип секрета + позиция в
    # тексте, БЕЗ значения — чтобы секрет не попал в CI-лог). Мы парсим их,
    # переводим offset в номер строки и используем kind как (уже безопасный)
    # detail. Если будущая реализация вернёт сырое значение (без '@<int>') —
    # деградируем на локализацию по подстроке.
    for hit in scan_secrets(text):
        kind, offset = _parse_secret_hit(hit)
        if offset is not None:
            line_no = _line_from_offset(line_starts, offset)
            detail = kind  # уже без значения — печатать безопасно
        else:
            # fallback: трактуем hit как сырое значение секрета.
            line_no = _find_line(lines, hit)
            detail = _redact(hit)
        # Строку, на которой найден секрет (если удалось локализовать).
        line_text = lines[line_no - 1] if 1 <= line_no <= len(lines) else ""

        # (1) Иллюстративный «дом» секретов — пропускаем [secret] (но не PII).
        if secret_illustrative:
            continue
        # (2) Уважаем синтетический маркер: fake-токен в labelled-примере — ок.
        #     Если строку локализовать не удалось (line_text == "") —
        #     _line_is_synthetic вернёт False, и мы НЕ exempt'им (fail-closed:
        #     guard скорее ложно сругается, чем пропустит реальный секрет).
        if line_text and _line_is_synthetic(line_text):
            continue
        # (3) Присваивание секрет-имени, чья ПРАВАЯ ЧАСТЬ — не строковый литерал
        #     (os.environ/getenv, вызов, атрибут settings.x, переменная) — это
        #     чтение конфига, а не утёкший хардкод. Хардкод-литерал
        #     (`token = "AbC123…"`) под это НЕ подпадает и будет пойман.
        if kind == "assigned_secret" and _secret_assignment_rhs_is_non_literal(line_text):
            continue
        offences.append(
            Offence(path=path, line_no=line_no, kind="secret", detail=f"scan_secrets: {detail}")
        )

    # --- проход 2: структурные PII-паттерны (построчно) --------------------
    if pii_exempt is None:
        pii_exempt = _file_is_pii_exempt(path)
    if not pii_exempt:
        for i, line in enumerate(lines, start=1):
            if _line_is_synthetic(line):
                continue
            for pat in _PII_PATTERNS:
                for m in pat.regex.finditer(line):
                    value = m.group(0)
                    if pat.name == "email" and _email_is_example(value):
                        continue
                    offences.append(
                        Offence(
                            path=path,
                            line_no=i,
                            kind=pat.name,
                            detail=f"{pat.why}: {_redact(value)}",
                        )
                    )
    return offences


#: Контракт scan_secrets: элемент вида "<kind>@<offset>" (см. ingest/sanitizer.py).
_SECRET_HIT_RE = re.compile(r"^(?P<kind>.+)@(?P<offset>\d+)$")


def _parse_secret_hit(hit: str) -> tuple[str, int | None]:
    """Распарсить элемент scan_secrets. Возвращает (kind, offset|None).

    Штатно элемент — "<kind>@<offset>" (offset — позиция в исходном тексте).
    Если формат иной (будущая реализация вернула сырое значение) — offset=None
    и весь hit считается значением (см. fallback в scan_file)."""
    m = _SECRET_HIT_RE.match(hit)
    if m:
        return m.group("kind"), int(m.group("offset"))
    return hit, None


def _line_start_offsets(text: str) -> list[int]:
    """Список offset'ов начала каждой строки — для перевода позиции в номер строки.
    `line_starts[i]` = смещение начала (i+1)-й строки в `text`."""
    starts = [0]
    for i, ch in enumerate(text):
        if ch == "\n":
            starts.append(i + 1)
    return starts


def _line_from_offset(line_starts: list[int], offset: int) -> int:
    """Номер строки (1-based) по offset символа в тексте. Бинарный поиск по
    отсортированным line_starts."""
    import bisect

    # bisect_right даёт индекс первой строки, чьё начало > offset → строка перед ним.
    idx = bisect.bisect_right(line_starts, offset)
    return max(1, idx)


def _find_line(lines: list[str], needle: str) -> int:
    """Номер первой строки, содержащей `needle`. 0, если не нашли (fallback-путь,
    когда scan_secrets вернул сырое значение вместо "<kind>@<offset>")."""
    for i, line in enumerate(lines, start=1):
        if needle in line:
            return i
    if len(needle) >= 8:
        prefix = needle[:8]
        for i, line in enumerate(lines, start=1):
            if prefix in line:
                return i
    return 0


def iter_files(root: Path):
    """Обойти текстовые файлы публичного репо, пропуская служебные директории."""
    for p in sorted(root.rglob("*")):
        if p.is_dir():
            continue
        if any(part in _SKIP_DIRS for part in p.parts):
            continue
        if p.suffix.lower() in _TEXT_SUFFIXES or p.name in {".env.example", ".gitignore"}:
            yield p


def lint(root: Path, explicit_files: list[Path] | None = None) -> list[Offence]:
    """Просканировать публичный репо (или явный список файлов). Возвращает все
    нарушения. Пустой список = чисто."""
    offences: list[Offence] = []
    if explicit_files:
        targets = [f for f in explicit_files if f.exists() and not f.is_dir()]
    else:
        targets = list(iter_files(root))
    for f in targets:
        offences.extend(scan_file(f))
    return offences


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _default_root() -> Path:
    """Корень публичного репо = на два уровня выше этого файла
    (scheduler/lint_public.py → repo root). Переопределяется --root."""
    return Path(__file__).resolve().parent.parent


def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="scheduler.lint_public",
        description="Guard публичного репо: ноль секретов, ноль реальных PII (exit 1 при находке).",
    )
    p.add_argument(
        "--root",
        type=Path,
        default=None,
        help="Корень публичного репо (по умолчанию — авто от расположения скрипта).",
    )
    p.add_argument(
        "--files",
        nargs="*",
        type=Path,
        default=None,
        help="Сканировать только эти файлы (для pre-commit на staged-файлах).",
    )
    p.add_argument("--quiet", action="store_true", help="Печатать только нарушения.")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_argparser().parse_args(argv)
    root = (args.root or _default_root()).resolve()

    offences = lint(root, explicit_files=args.files)

    if offences:
        print(
            f"FAIL: публичный репо НЕ чист — найдено {len(offences)} нарушение(й):",
            file=sys.stderr,
        )
        for off in offences:
            print("  " + off.render(root), file=sys.stderr)
        print(
            "\nЭто guard границы двух репо (ADR-0003): секреты и реальные PII в "
            "публичный репо попадать не должны. Если это ЗАВЕДОМО синтетический "
            "пример — пометь строку маркером (`synthetic-example` / «Пример» / "
            "example.com) или вынеси в wiki-example/.",
            file=sys.stderr,
        )
        return 1

    if not args.quiet:
        scanned = len(args.files) if args.files else "все"
        print(f"OK: публичный репо чист (просканировано: {scanned} файлов под {root}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
