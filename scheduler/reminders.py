"""reminders.py — детерминированный парсер reminders-файла и движок «что due».

НАЗНАЧЕНИЕ
==========
Это «дешёвый предчек» из research/proactive-scheduling.md: чистый Python,
БЕЗ вызова движка. Перед тем как поднимать дорогой `claude -p` (Claude-native
движок v1, ADR-0008), sweep сначала спрашивает у этого модуля «есть ли вообще
что-то due?» — и спавнит движок только если есть. Так мы экономим месячный
Agent-SDK-кредит Claude (ADR-0009): 30-мин StartInterval launchd = до ~48
пробуждений в день, и гонять движок вхолостую на каждом — расточительно
(CONTEXT §6 OQ — «дешёвый anything-due-предчек перед спавном»).

Модуль НАМЕРЕННО не зависит ни от движка, ни от Telegram, ни от сети — только
стандартная библиотека + python-dateutil. Это делает все функции здесь
unit-testable как чистые функции (мы кормим текст + «сейчас», получаем список
due-элементов), ровно как просит research («вся scheduling-логика — в несколько
строк кода», pure-функции).

ФОРМАТ ДАННЫХ
=============
Источник истины — приватный `reminders/reminders.md` (см. reminders_spec.md и
ADR-0007 §3). Это append-only список YAML-frontmatter-блоков, по одному блоку на
напоминание, разделённых маркером `---`. Поля блока:

    id          — стабильный slug+дата (для дедупа/`/done <id>`)
    title       — человекочитаемый заголовок (идёт в digest)
    kind        — oneoff | recurring | spaced
    due_at      — ISO 8601 С ТАЙМЗОНОЙ (next occurrence для recurring/spaced)
    rrule       — iCal RRULE, опц. (только recurring) — напр. FREQ=YEARLY;...
    nl_source   — исходная фраза «remind me ...» дословно (аудит, НЕ парсим её)
    status      — pending | done | snoozed
    last_fired  — ISO, опц. (когда последний раз ушло в digest)
    created     — ISO
    # только для kind=spaced (idea-resurfacing, лесенка Leitner):
    box         — индекс ступени (0..len(LEITNER_LADDER)-1)
    interval_days — текущий интервал (дублирует ладдер для читаемости)
    ease        — опц. ease-factor (на будущее, для SM-2)

ИНВАРИАНТЫ (см. research «подводные камни»)
- Персистим ТОЛЬКО разрешённый ISO `due_at` (+ rrule). Относительные/NL-даты
  («через 3 дня») НИКОГДА не source-of-truth — только в `nl_source` для аудита,
  иначе повторная оценка файла молча сдвинет каждую дату.
- `due_at` — tz-aware (с offset). Сравнение в той же tz. Naive-время мисфайрит
  на DST и на «every year on May 31»/полночь-edge-кейсах (dateutil корректен
  только на tz-aware datetime).
- Идемпотентность через `status`/`last_fired`: коалесцированный двойной запуск
  launchd (см. research) не должен задвоить пуш — фильтр `_already_fired_today`.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

# python-dateutil — maintained-зависимость (research: НЕ старый kvh/recurrent).
# rrulestr/rrule парсят и эмитят iCal RRULE (RFC 5545); tz держит due_at корректным.
from dateutil import rrule as _rrule
from dateutil import tz as _tz

# ---------------------------------------------------------------------------
# Константы домена
# ---------------------------------------------------------------------------

#: Лесенка интервалов Leitner для idea-resurfacing (kind=spaced).
#: research/proactive-scheduling.md: «1 → 3 → 7 → 16 → 35 дней». Индекс = box.
#: Полный SM-2 с ease-factor — позже (пара строк), пока фиксированная лесенка.
LEITNER_LADDER: tuple[int, ...] = (1, 3, 7, 16, 35)

#: Grace-окно: элемент считается due, если due_at <= now + GRACE. Небольшое
#: окно ловит элементы, чьё время наступает «вот-вот» между тиками sweep,
#: и сглаживает дрожание планировщика. research: «(+ небольшое grace-окно)».
DEFAULT_GRACE = dt.timedelta(minutes=5)

#: Окно «предстоящее» для секции digest «скоро» (дни рождения за N дней и т.п.).
#: Не делает элемент due (не помечается fired), но показывается в превью digest.
DEFAULT_LOOKAHEAD = dt.timedelta(days=7)

#: Разделитель YAML-блоков в reminders.md. Строка ровно из трёх дефисов.
_BLOCK_SEP = re.compile(r"^-{3,}\s*$", re.MULTILINE)

#: Допустимые значения kind/status — для валидации (мягкой: невалидное логируем,
#: не роняем весь sweep — один битый блок не должен глушить все напоминания).
_VALID_KINDS = {"oneoff", "recurring", "spaced"}
_VALID_STATUSES = {"pending", "done", "snoozed"}


# ---------------------------------------------------------------------------
# Модель данных
# ---------------------------------------------------------------------------


@dataclass
class Reminder:
    """Один распарсенный блок reminder. Pure-data (как DTO): без поведения,
    только поля + пара деривативных предикатов. Вся логика — в функциях ниже."""

    id: str
    title: str
    kind: str  # oneoff | recurring | spaced
    due_at: dt.datetime | None  # tz-aware; None если блок битый
    rrule: str | None = None
    nl_source: str | None = None
    status: str = "pending"
    last_fired: dt.datetime | None = None
    created: dt.datetime | None = None
    # spaced-only:
    box: int | None = None
    interval_days: int | None = None
    ease: float | None = None
    # Диагностика парсинга (не персистится; для лога sweep):
    parse_warnings: list[str] = field(default_factory=list)

    @property
    def is_active(self) -> bool:
        """pending или snoozed считаем живыми; done — выключен."""
        return self.status in ("pending", "snoozed")


@dataclass
class DueItem:
    """Элемент, который sweep должен показать в digest. Объединяет reminder-due
    и birthday-due из вики под один тип, чтобы digest-промпт был однородным."""

    id: str
    title: str
    kind: str  # oneoff | recurring | spaced | birthday | anniversary
    due_at: dt.datetime
    source: str  # "reminders" | "wiki:<relpath>"
    detail: str = ""  # доп. строка для digest (напр. «исполняется 30»)
    upcoming: bool = False  # True = в lookahead-окне, ещё не строго due


# ---------------------------------------------------------------------------
# Парсинг времени
# ---------------------------------------------------------------------------


def parse_iso(value: str | None, *, default_tz: dt.tzinfo | None = None) -> dt.datetime | None:
    """Разобрать ISO 8601 в tz-aware datetime.

    Принимает `2026-05-31`, `2026-05-31T09:00`, `2026-05-31T09:00:00+03:00`.
    Если в строке нет таймзоны — навешиваем `default_tz` (по умолчанию локальная
    tz машины), чтобы дальше всё сравнение шло на tz-aware значениях (инвариант).
    Только дата (без времени) трактуется как полночь этого дня.

    Возвращает None, если строку не удалось разобрать (битый блок) — вызывающий
    сам решает, ругаться или скипнуть.
    """
    if not value:
        return None
    value = value.strip()
    if not value:
        return None
    try:
        # datetime.fromisoformat в 3.11+ ест и 'Z', и offset. Дату без времени —
        # тоже (вернёт naive). Нормализуем к tz-aware ниже.
        parsed = dt.datetime.fromisoformat(value)
    except ValueError:
        # Иногда YAML отдаёт уже date-объект как строку 'YYYY-MM-DD' — fromisoformat
        # это переварит; всё прочее — действительно невалидно.
        try:
            d = dt.date.fromisoformat(value)
            parsed = dt.datetime(d.year, d.month, d.day)
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=default_tz or _tz.tzlocal())
    return parsed


def _now(tz: dt.tzinfo | None = None) -> dt.datetime:
    """«Сейчас» как tz-aware datetime. Вынесено в функцию, чтобы тесты могли
    передавать фиксированное `now` и не зависеть от системных часов."""
    return dt.datetime.now(tz or _tz.tzlocal())


# ---------------------------------------------------------------------------
# Recurrence (iCal RRULE через dateutil)
# ---------------------------------------------------------------------------


def next_occurrence(
    rule_str: str,
    dtstart: dt.datetime,
    *,
    after: dt.datetime,
    inclusive: bool = False,
) -> dt.datetime | None:
    """Следующее срабатывание recurring-правила строго после (или с) `after`.

    `rule_str`  — iCal RRULE без префикса, напр. `FREQ=YEARLY;BYMONTH=5;BYMONTHDAY=31`.
    `dtstart`   — точка отсчёта (обычно `created` или исходный `due_at`); задаёт
                  время суток и якорь для FREQ. ДОЛЖНА быть tz-aware.
    `after`     — от какого момента искать следующее (обычно `now` или текущий due_at).

    Возвращает tz-aware datetime следующего occurrence либо None, если правило
    исчерпано (COUNT/UNTIL в прошлом). Это и есть «продвинуть due_at к следующему
    rrule-occurrence» из research после срабатывания recurring-напоминания.

    Реализация детерминированная (dateutil), NL здесь НЕ парсится — мы считаем
    математику recurrence из уже-разрешённого RRULE, не из «every year on...».
    """
    if dtstart.tzinfo is None:
        raise ValueError("dtstart must be tz-aware (инвариант tz-aware времени)")
    try:
        rule = _rrule.rrulestr(rule_str, dtstart=dtstart)
    except (ValueError, TypeError):
        # Битый RRULE — не роняем sweep, сигналим None (вызывающий залогирует).
        return None
    # rrule.after сравнивает в tz dtstart; приводим `after` к той же tz, иначе
    # сравнение naive↔aware кинет TypeError (DST-корректность, research).
    after_in_tz = after.astimezone(dtstart.tzinfo)
    occ = rule.after(after_in_tz, inc=inclusive)
    return occ


# ---------------------------------------------------------------------------
# Парсинг reminders.md
# ---------------------------------------------------------------------------


def _strip_yaml_fences(block: str) -> str:
    """Убрать обрамляющие `---`, если блок сам обёрнут как YAML-документ.
    Поддерживаем оба написания: блоки, разделённые `---` (тогда тело уже чистое),
    и блоки, каждый из которых — полноценный `---\\n...\\n---` документ."""
    lines = block.strip().splitlines()
    if lines and _BLOCK_SEP.match(lines[0] or ""):
        lines = lines[1:]
    if lines and _BLOCK_SEP.match(lines[-1] or ""):
        lines = lines[:-1]
    return "\n".join(lines)


def _parse_scalar(raw: str) -> str:
    """Снять кавычки/комментарии с YAML-скаляра без тяги PyYAML.

    Мы НАМЕРЕННО парсим вручную мини-подмножество YAML (плоские `key: value`),
    чтобы scheduler не тянул внешнюю зависимость ради одного формата файла и
    оставался запускаемым из коробки (правило брифа: реальный код, минимум
    зависимостей). Формат reminders плоский — этого достаточно.
    """
    raw = raw.strip()
    # Срезать inline-комментарий ` # ...` (но не '#' внутри кавычек).
    if raw and raw[0] not in "\"'":
        hash_pos = raw.find(" #")
        if hash_pos != -1:
            raw = raw[:hash_pos].rstrip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        raw = raw[1:-1]
    return raw


def _parse_block(block_text: str, *, default_tz: dt.tzinfo | None = None) -> Reminder | None:
    """Распарсить один YAML-блок в Reminder. Возвращает None для пустого блока.

    Невалидные/пропущенные поля не роняют парсинг — копятся в parse_warnings,
    чтобы sweep мог их залогировать, но один битый reminder не глушил остальные
    (research-инвариант: «один битый блок не должен глушить все напоминания»).
    """
    body = _strip_yaml_fences(block_text)
    if not body.strip():
        return None

    fields: dict[str, str] = {}
    for line in body.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        fields[key.strip()] = _parse_scalar(value)

    warnings: list[str] = []

    rid = fields.get("id") or ""
    if not rid:
        # id обязателен для дедупа — без него reminder бесполезен для sweep.
        warnings.append("missing id")

    kind = (fields.get("kind") or "oneoff").lower()
    if kind not in _VALID_KINDS:
        warnings.append(f"unknown kind={kind!r}, treating as oneoff")
        kind = "oneoff"

    status = (fields.get("status") or "pending").lower()
    if status not in _VALID_STATUSES:
        warnings.append(f"unknown status={status!r}, treating as pending")
        status = "pending"

    due_at = parse_iso(fields.get("due_at"), default_tz=default_tz)
    if due_at is None and fields.get("due_at"):
        warnings.append(f"unparseable due_at={fields.get('due_at')!r}")

    def _int(name: str) -> int | None:
        val = fields.get(name)
        if val is None or val == "":
            return None
        try:
            return int(val)
        except ValueError:
            warnings.append(f"non-int {name}={val!r}")
            return None

    def _float(name: str) -> float | None:
        val = fields.get(name)
        if val is None or val == "":
            return None
        try:
            return float(val)
        except ValueError:
            warnings.append(f"non-float {name}={val!r}")
            return None

    return Reminder(
        id=rid,
        title=fields.get("title") or rid or "(без названия)",
        kind=kind,
        due_at=due_at,
        rrule=fields.get("rrule") or None,
        nl_source=fields.get("nl_source") or None,
        status=status,
        last_fired=parse_iso(fields.get("last_fired"), default_tz=default_tz),
        created=parse_iso(fields.get("created"), default_tz=default_tz),
        box=_int("box"),
        interval_days=_int("interval_days"),
        ease=_float("ease"),
        parse_warnings=warnings,
    )


def parse_reminders(text: str, *, default_tz: dt.tzinfo | None = None) -> list[Reminder]:
    """Распарсить весь reminders.md в список Reminder.

    Первый блок файла обычно — markdown-заголовок/преамбула (`# Reminders ...`),
    не YAML; такие блоки тихо отбрасываются (нет распознанных полей → None).
    """
    reminders: list[Reminder] = []
    for raw_block in _BLOCK_SEP.split(text):
        if not raw_block.strip():
            continue
        rem = _parse_block(raw_block, default_tz=default_tz)
        if rem is not None and (rem.id or rem.due_at):
            reminders.append(rem)
    return reminders


def load_reminders(path: str | Path, *, default_tz: dt.tzinfo | None = None) -> list[Reminder]:
    """Прочитать и распарсить reminders.md с диска. Отсутствующий файл = пусто
    (валидно: ещё нет ни одного напоминания)."""
    p = Path(path)
    if not p.exists():
        return []
    return parse_reminders(p.read_text(encoding="utf-8"), default_tz=default_tz)


# ---------------------------------------------------------------------------
# Дни рождения / годовщины из person-страниц вики
# ---------------------------------------------------------------------------

#: В вики дни рождения — структурное поле person-страниц (research OQ:
#: «выводить из person-страниц — single source of truth, без дублирования»).
#: Поддерживаем frontmatter-поля `birthday:` и `anniversary:` в формате
#: `MM-DD` или `YYYY-MM-DD` (год игнорируется для повторения, используется для
#: вычисления «исполняется N»).
_FRONTMATTER_FENCE = re.compile(r"^---\s*$", re.MULTILINE)
_DATE_FIELD = re.compile(
    r"^(?P<key>birthday|anniversary|birth_date|named_day)\s*:\s*(?P<val>.+?)\s*$",
    re.IGNORECASE | re.MULTILINE,
)
_TITLE_FIELD = re.compile(r"^title\s*:\s*(?P<val>.+?)\s*$", re.IGNORECASE | re.MULTILINE)
_MMDD = re.compile(r"(?:(?P<year>\d{4})-)?(?P<month>\d{1,2})-(?P<day>\d{1,2})")


def _extract_frontmatter(text: str) -> str:
    """Вернуть YAML-frontmatter (между первой парой `---`), либо '' если нет."""
    fences = list(_FRONTMATTER_FENCE.finditer(text))
    if len(fences) >= 2 and fences[0].start() == 0:
        return text[fences[0].end() : fences[1].start()]
    return ""


def birthdays_from_wiki(
    wiki_dir: str | Path,
    *,
    now: dt.datetime | None = None,
    lookahead: dt.timedelta = DEFAULT_LOOKAHEAD,
    grace: dt.timedelta = DEFAULT_GRACE,
    default_tz: dt.tzinfo | None = None,
) -> list[DueItem]:
    """Просканировать `wiki/` (рекурсивно) на person-страницы с `birthday:`/
    `anniversary:` и вернуть те, что наступают сегодня или в lookahead-окне.

    Год повторения выводится динамически (yearly), как просит research: sweep
    генерит «every year on <MM-DD>» из поля, а не из дублирующей recurring-записи.
    Дата-без-времени трактуется как полночь локального дня.
    """
    now = now or _now(default_tz)
    tzinfo = now.tzinfo
    items: list[DueItem] = []
    wdir = Path(wiki_dir)
    if not wdir.exists():
        return items

    for md in sorted(wdir.rglob("*.md")):
        fm = _extract_frontmatter(md.read_text(encoding="utf-8"))
        if not fm:
            continue
        title_m = _TITLE_FIELD.search(fm)
        person = title_m.group("val").strip() if title_m else md.stem
        for field_m in _DATE_FIELD.finditer(fm):
            key = field_m.group("key").lower()
            mmdd = _MMDD.search(field_m.group("val"))
            if not mmdd:
                continue
            month, day = int(mmdd.group("month")), int(mmdd.group("day"))
            birth_year = int(mmdd.group("year")) if mmdd.group("year") else None
            kind = "anniversary" if key in ("anniversary", "named_day") else "birthday"

            # Ближайшее наступление в этом или следующем году (полночь локально).
            occ = _next_yearly(month, day, now, tzinfo)
            if occ is None:
                continue
            delta = occ - now
            if delta <= grace:
                upcoming = False
            elif delta <= lookahead:
                upcoming = True
            else:
                continue  # слишком далеко — не показываем

            detail = ""
            if birth_year is not None:
                turning = occ.year - birth_year
                noun = "лет" if kind == "birthday" else "годовщина"
                detail = f"исполняется {turning} {noun}".strip()

            items.append(
                DueItem(
                    id=f"{kind}:{md.stem}:{month:02d}-{day:02d}",
                    title=f"{person} — {'день рождения' if kind == 'birthday' else 'годовщина'}",
                    kind=kind,
                    due_at=occ,
                    source=f"wiki:{md.relative_to(wdir)}",
                    detail=detail,
                    upcoming=upcoming,
                )
            )
    return items


def _next_yearly(
    month: int, day: int, now: dt.datetime, tzinfo: dt.tzinfo
) -> dt.datetime | None:
    """Ближайшая полночь <month>-<day> не раньше начала текущего дня now.
    Обрабатывает 29 февраля мягко (сдвиг на 1 марта в невисокосный год)."""
    def _make(year: int) -> dt.datetime | None:
        try:
            return dt.datetime(year, month, day, 0, 0, tzinfo=tzinfo)
        except ValueError:
            # 29 февраля в невисокосный год → отмечаем 1 марта.
            if month == 2 and day == 29:
                return dt.datetime(year, 3, 1, 0, 0, tzinfo=tzinfo)
            return None

    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    this_year = _make(now.year)
    if this_year is not None and this_year >= today_start:
        return this_year
    return _make(now.year + 1)


# ---------------------------------------------------------------------------
# Главная функция: что due прямо сейчас
# ---------------------------------------------------------------------------


def _already_fired_today(rem: Reminder, now: dt.datetime) -> bool:
    """Дедуп: уже стреляли сегодня? Защита от коалесцированного двойного запуска
    launchd (research: «status/last_fired для дедупа, чтобы double-fire не задвоил
    пуш»). Сравнение по локальной дате `now`."""
    if rem.last_fired is None:
        return False
    return rem.last_fired.astimezone(now.tzinfo).date() == now.date()


def compute_due(
    reminders: Iterable[Reminder],
    *,
    now: dt.datetime | None = None,
    grace: dt.timedelta = DEFAULT_GRACE,
    lookahead: dt.timedelta = DEFAULT_LOOKAHEAD,
    default_tz: dt.tzinfo | None = None,
) -> list[DueItem]:
    """Превратить список Reminder в список DueItem, которые надо показать СЕЙЧАС.

    Правило «due»:
      - активный (pending/snoozed) И
      - due_at <= now + grace И
      - не стреляли сегодня (дедуп коалесцированного запуска).
    Дополнительно в lookahead-окне (due_at <= now + lookahead) элементы помечаются
    `upcoming=True` и попадают в «скоро»-секцию digest, но НЕ помечаются fired.

    Для recurring без due_at, но с rrule — вычисляем next_occurrence от now.
    Это и есть детерминированный due-движок; NL здесь не трогаем.
    """
    now = now or _now(default_tz)
    out: list[DueItem] = []

    for rem in reminders:
        if not rem.is_active:
            continue

        due_at = rem.due_at
        # recurring без явного due_at: вывести из rrule (next occurrence от now).
        if due_at is None and rem.kind == "recurring" and rem.rrule and rem.created:
            due_at = next_occurrence(rem.rrule, rem.created, after=now, inclusive=True)
        if due_at is None:
            continue  # нечего считать (битый/неполный блок)

        due_at = due_at.astimezone(now.tzinfo)
        delta = due_at - now

        if delta <= grace:
            if _already_fired_today(rem, now):
                continue  # уже стреляли сегодня — не дублируем
            upcoming = False
        elif delta <= lookahead:
            upcoming = True
        else:
            continue

        out.append(
            DueItem(
                id=rem.id,
                title=rem.title,
                kind=rem.kind,
                due_at=due_at,
                source="reminders",
                detail=(rem.nl_source or ""),
                upcoming=upcoming,
            )
        )
    return out


def collect_due_items(
    reminders_path: str | Path,
    wiki_dir: str | Path,
    *,
    now: dt.datetime | None = None,
    grace: dt.timedelta = DEFAULT_GRACE,
    lookahead: dt.timedelta = DEFAULT_LOOKAHEAD,
    default_tz: dt.tzinfo | None = None,
) -> list[DueItem]:
    """Высокоуровневый предчек: собрать ВСЁ due из reminders-файла + дней рождения
    вики, отсортировать по времени (строго-due раньше upcoming). Это то, что
    digest.py зовёт первым, чтобы решить, спавнить ли движок вообще.
    """
    now = now or _now(default_tz)
    reminders = load_reminders(reminders_path, default_tz=now.tzinfo)
    items = compute_due(
        reminders, now=now, grace=grace, lookahead=lookahead, default_tz=now.tzinfo
    )
    items += birthdays_from_wiki(
        wiki_dir, now=now, lookahead=lookahead, grace=grace, default_tz=now.tzinfo
    )
    # Сортировка: сначала строго-due (upcoming=False), потом по времени.
    items.sort(key=lambda it: (it.upcoming, it.due_at))
    return items


def advance_spaced(box: int | None) -> tuple[int, int]:
    """Продвинуть spaced-reminder (idea-resurfacing) на следующую ступень Leitner.

    Возвращает `(new_box, interval_days)`. На последней ступени остаёмся на ней
    (потолок 35 дней) — идея продолжает всплывать редко, пока юзер её не «drop»-нет.
    Несколько строк сейчас; полный SM-2 ease-factor — позже (research).

    Эту функцию зовёт движок-через-промпт ИЛИ post-обработчик после того, как
    spaced-элемент показан: продвинуть box, переписать due_at = now + interval_days.
    """
    if box is None or box < 0:
        box = 0
    else:
        box = min(box + 1, len(LEITNER_LADDER) - 1)
    return box, LEITNER_LADDER[box]
