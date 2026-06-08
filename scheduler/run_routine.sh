#!/usr/bin/env bash
# run_routine.sh — обёртка launchd для ЛЮБОЙ плановой routine (node-порт, [ADR-0012]).
#
# Обобщение run_sweep.sh на весь каталог routine'ов (dist/scheduler/routines.js).
# plist зовёт этот скрипт с ИМЕНЕМ routine первым аргументом. Он подгружает приватный
# .env и запускает: node dist/scheduler/routines.js <ROUTINE> [extra-args], обёрнутый
# в caffeinate на время выполнения.
#
# ДВИЖОК — CLAUDE-NATIVE ([ADR-0008]/[ADR-0009]): routine'ы спавнят официальный
# `claude -p` через bridge/engine. Этот скрипт движок НЕ зовёт напрямую.
#
# Использование:
#   run_routine.sh <routine> [доп-аргументы]
#   напр.: run_routine.sh compile          run_routine.sh research --dry-run
#
# Окружение (обычно задаёт приватный .env):
#   PUBLIC_REPO   — корень публичного репо personal-llm-wiki (где dist/)
#   CONTENT_ROOT  — корень приватного репо llm-wiki-content
#   NODE_BIN      — интерпретатор Node (по умолчанию node из PATH)
#   CAFFEINATE    — "1" (по умолчанию) обернуть в caffeinate; "0" — выключить

set -euo pipefail

# --- 0. Имя routine ---------------------------------------------------------
ROUTINE="${1:-}"
if [ -z "$ROUTINE" ]; then
  echo "run_routine.sh: первым аргументом нужно имя routine (compile|digest|lint|research|resurface)." >&2
  echo "Каталог: node dist/scheduler/routines.js --list" >&2
  exit 64  # EX_USAGE
fi
shift  # остаток аргументов прокинем диспетчеру (напр. --dry-run)

# --- 1. Где мы (каталог скрипта = <PUBLIC_REPO>/scheduler) -------------------
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
ENV_FILE="${ENV_FILE:-$CONTENT_ROOT/.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
else
  echo "run_routine.sh: .env не найден по пути $ENV_FILE — продолжаю на дефолтах окружения." >&2
fi
CONTENT_ROOT="${CONTENT_ROOT:-$HOME/llm-wiki-content}"

# --- 3. Запуск routine (обёрнут в caffeinate на время выполнения) -----------
NODE_BIN="${NODE_BIN:-node}"
cd "$PUBLIC_REPO"

run_cmd=("$NODE_BIN" "$PUBLIC_REPO/dist/scheduler/routines.js" "$ROUTINE" "$@")

if [ "${CAFFEINATE:-1}" = "1" ] && command -v caffeinate >/dev/null 2>&1; then
  exec caffeinate -s "${run_cmd[@]}"
else
  exec "${run_cmd[@]}"
fi
