#!/usr/bin/env bash
# run_routine.sh — обёртка launchd для ЛЮБОЙ плановой routine «Второго мозга».
#
# НАЗНАЧЕНИЕ
#   Обобщение run_sweep.sh на весь каталог routine'ов (scheduler/routines.py).
#   launchd не умеет сам подгрузить .env, активировать venv или обернуть запуск в
#   caffeinate — поэтому plist зовёт не python напрямую, а этот скрипт с ИМЕНЕМ
#   routine первым аргументом. Он:
#     1. находит корни публичного и приватного репо,
#     2. подгружает секреты/пути из приватного .env (НИКОГДА не в публичном репо),
#     3. (опц.) активирует venv,
#     4. запускает: python -m scheduler.routines <ROUTINE> [extra-args],
#        обёрнутый в `caffeinate` НА ВРЕМЯ запуска (не 24/7 — сажает батарею,
#        research/proactive-scheduling.md: «caffeinate только вокруг запуска»).
#
# ДВИЖОК — CLAUDE-NATIVE (ADR-0008/0009): routine'ы спавнят официальный `claude -p`
# через bridge.engine. Этот скрипт движок НЕ зовёт напрямую — только python-диспетчер.
#
# ВАЖНО (research/ADR-0007): каждый запуск идемпотентен (digest: дедуп по
# status/last_fired; compile: watermark; lint/research/resurface: безопасны к повтору).
# launchd коалесцирует пропущенные при сне интервалы в одно wake-событие.
#
# ХОСТ-ПОРТАБЕЛЬНОСТЬ (ADR-0005): пути из env с дефолтами; перенос на Mac Mini/VPS —
# поправить .env + plist, без правок кода. Для 24/7 без бодрствующего Mac — не этот
# скрипт, а remote Claude routines (см. scheduler/README.md).
#
# Использование:
#   run_routine.sh <routine> [доп-аргументы python-диспетчеру]
#   напр.: run_routine.sh compile          run_routine.sh research --dry-run
#
# Окружение (обычно задаёт приватный .env):
#   PUBLIC_REPO   — корень публичного репо personal-llm-wiki (где пакет scheduler/)
#   CONTENT_ROOT  — корень приватного репо llm-wiki-content (.env, raw/, wiki/, reminders/)
#   PYTHON_BIN    — интерпретатор (по умолчанию python3 из PATH)
#   VENV_PATH     — опц. путь к venv (если используется)
#   CAFFEINATE    — "1" (по умолчанию) обернуть в caffeinate; "0" — выключить

set -euo pipefail

# --- 0. Имя routine ---------------------------------------------------------
ROUTINE="${1:-}"
if [ -z "$ROUTINE" ]; then
  echo "run_routine.sh: первым аргументом нужно имя routine (compile|digest|lint|research|resurface)." >&2
  echo "Каталог: python -m scheduler.routines --list" >&2
  exit 64  # EX_USAGE
fi
shift  # остаток аргументов прокинем диспетчеру (напр. --dry-run)

# --- 1. Где мы --------------------------------------------------------------
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

# --- 2. Подгрузить приватный .env (секреты + пути) --------------------------
# Токен Telegram, OWNER_CHAT_ID, переопределения путей — только в приватном .env.
# Публичный репо его НЕ содержит (gitignored там). Экспортируем все переменные
# из .env в окружение дочернего python-процесса.
ENV_FILE="${ENV_FILE:-$CONTENT_ROOT/.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
else
  echo "run_routine.sh: .env не найден по пути $ENV_FILE — продолжаю на дефолтах окружения." >&2
fi

# CONTENT_ROOT мог быть переопределён внутри .env — пере-резолвим производные.
CONTENT_ROOT="${CONTENT_ROOT:-$HOME/llm-wiki-content}"

# --- 3. Интерпретатор / venv ------------------------------------------------
if [ -n "${VENV_PATH:-}" ] && [ -f "$VENV_PATH/bin/activate" ]; then
  # shellcheck disable=SC1091
  . "$VENV_PATH/bin/activate"
fi
PYTHON_BIN="${PYTHON_BIN:-python3}"

# Пакет scheduler/ импортирует ingest.sanitizer и (лениво, через scheduler.digest)
# bridge.* — все в корне публичного репо. Поэтому PYTHONPATH = корень публичного репо.
export PYTHONPATH="${PUBLIC_REPO}${PYTHONPATH:+:$PYTHONPATH}"

# --- 4. Запуск routine (обёрнут в caffeinate на время выполнения) -----------
cd "$PUBLIC_REPO"

run_cmd=("$PYTHON_BIN" -m scheduler.routines "$ROUTINE" "$@")

if [ "${CAFFEINATE:-1}" = "1" ] && command -v caffeinate >/dev/null 2>&1; then
  exec caffeinate -s "${run_cmd[@]}"
else
  exec "${run_cmd[@]}"
fi
