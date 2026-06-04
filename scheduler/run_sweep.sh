#!/usr/bin/env bash
# run_sweep.sh — обёртка, которую запускает launchd (ru.secondbrain.digest.plist).
#
# НАЗНАЧЕНИЕ
#   launchd не умеет сам подгрузить .env, активировать venv или обернуть запуск в
#   caffeinate — поэтому plist зовёт не python напрямую, а этот скрипт. Он:
#     1. находит корни публичного и приватного репо,
#     2. подгружает секреты/пути из приватного .env (НИКОГДА не в публичном репо),
#     3. (опц.) активирует venv,
#     4. запускает один идемпотентный sweep: python -m scheduler.digest,
#        обёрнутый в `caffeinate` НА ВРЕМЯ запуска (не 24/7 — это сажает батарею,
#        research/proactive-scheduling.md: «caffeinate только вокруг sweep»).
#
# ВАЖНО (research/ADR-0007): один запуск = один SWEEP по всем due-элементам, а не
# таймер на напоминание. launchd коалесцирует пропущенные при сне интервалы в одно
# wake-событие — sweep идемпотентен (дедуп по status/last_fired в reminders.py),
# так что коалесцированный двойной запуск не задвоит пуш.
#
# ХОСТ-ПОРТАБЕЛЬНОСТЬ (ADR-0005): пути берём из env с дефолтами; перенос на Mac
# Mini/VPS = поправить .env + plist, без правок кода.
#
# Все настройки — через окружение (с дефолтами). Обычно их задаёт приватный .env:
#   PUBLIC_REPO   — корень публичного репо personal-llm-wiki (где пакет scheduler/)
#   CONTENT_ROOT  — корень приватного репо llm-wiki-content (.env, reminders/, wiki/)
#   PYTHON_BIN    — интерпретатор (по умолчанию python3 из PATH)
#   VENV_PATH     — опц. путь к venv (если используется)
#   CAFFEINATE    — "1" (по умолчанию) обернуть в caffeinate; "0" — выключить

set -euo pipefail

# --- 0. Где мы --------------------------------------------------------------
# Каталог этого скрипта = <PUBLIC_REPO>/scheduler. Корень публичного репо — на
# уровень выше. Резолвим симлинки, чтобы launchd-путь не сбивал расчёт.
SCRIPT_SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SCRIPT_SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SCRIPT_SOURCE")" >/dev/null 2>&1 && pwd)"
  SCRIPT_SOURCE="$(readlink "$SCRIPT_SOURCE")"
  [[ $SCRIPT_SOURCE != /* ]] && SCRIPT_SOURCE="$DIR/$SCRIPT_SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_SOURCE")" >/dev/null 2>&1 && pwd)"

PUBLIC_REPO="${PUBLIC_REPO:-$(cd "$SCRIPT_DIR/.." && pwd)}"
CONTENT_ROOT="${CONTENT_ROOT:-$HOME/llm-wiki-content}"

# --- 1. Подгрузить приватный .env (секреты + пути) --------------------------
# Токен Telegram, OWNER_CHAT_ID, переопределения путей — только в приватном .env.
# Публичный репо его НЕ содержит (gitignored там). Экспортируем все переменные
# из .env в окружение дочернего python-процесса.
ENV_FILE="${ENV_FILE:-$CONTENT_ROOT/.env}"
if [ -f "$ENV_FILE" ]; then
  # set -a: автоэкспорт всех присваиваний из .env; затем выключаем обратно.
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
else
  echo "run_sweep.sh: .env не найден по пути $ENV_FILE — продолжаю на дефолтах окружения." >&2
fi

# CONTENT_ROOT мог быть переопределён внутри .env — пере-резолвим производные.
CONTENT_ROOT="${CONTENT_ROOT:-$HOME/llm-wiki-content}"

# --- 2. Интерпретатор / venv ------------------------------------------------
if [ -n "${VENV_PATH:-}" ] && [ -f "$VENV_PATH/bin/activate" ]; then
  # shellcheck disable=SC1091
  . "$VENV_PATH/bin/activate"
fi
PYTHON_BIN="${PYTHON_BIN:-python3}"

# Пакет scheduler/ импортируется как `scheduler.digest`, а он импортит
# `ingest.sanitizer` и (лениво) `bridge.*` — все они в корне публичного репо.
# Поэтому PYTHONPATH = корень публичного репо.
export PYTHONPATH="${PUBLIC_REPO}${PYTHONPATH:+:$PYTHONPATH}"

# --- 3. Запуск sweep (обёрнут в caffeinate на время выполнения) -------------
# `caffeinate -s <cmd>`: не даёт system-sleep ПОКА идёт sweep, отпускает сразу
# после выхода — батарея не страдает (research). На не-macOS caffeinate нет —
# тогда зовём напрямую.
cd "$PUBLIC_REPO"

run_cmd=("$PYTHON_BIN" -m scheduler.digest "$@")

if [ "${CAFFEINATE:-1}" = "1" ] && command -v caffeinate >/dev/null 2>&1; then
  exec caffeinate -s "${run_cmd[@]}"
else
  exec "${run_cmd[@]}"
fi
