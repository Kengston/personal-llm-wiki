#!/usr/bin/env bash
# run_sweep.sh — обёртка launchd для дайджеста (node-порт, [ADR-0012]).
#
# launchd не умеет сам подгрузить .env или обернуть запуск в caffeinate — поэтому
# plist (ru.secondbrain.digest.plist) зовёт не node напрямую, а этот скрипт. Он:
#   1. находит корни публичного и приватного репо,
#   2. подгружает секреты/пути из приватного .env (НИКОГДА не в публичном репо),
#   3. запускает один идемпотентный sweep: node dist/scheduler/digest.js,
#      обёрнутый в `caffeinate` НА ВРЕМЯ запуска (research: «caffeinate только вокруг sweep»).
#
# ВАЖНО ([ADR-0007]): один запуск = один SWEEP по всем due-элементам, не таймер-на-
# напоминание. launchd коалесцирует пропущенные при сне интервалы → sweep идемпотентен
# (дедуп по status/last_fired в reminders.ts).
#
# Окружение (обычно задаёт приватный .env):
#   PUBLIC_REPO   — корень публичного репо personal-llm-wiki (где dist/)
#   CONTENT_ROOT  — корень приватного репо llm-wiki-content (.env, reminders/, wiki/)
#   NODE_BIN      — интерпретатор Node (по умолчанию node из PATH)
#   CAFFEINATE    — "1" (по умолчанию) обернуть в caffeinate; "0" — выключить
#
# СНАЧАЛА СБОРКА: dist/ собирается `pnpm build` (tsc). Скрипт запускает уже
# скомпилированный JS, не tsx (для launchd надёжнее без dev-зависимостей).

set -euo pipefail

# --- 0. Где мы (каталог скрипта = <PUBLIC_REPO>/scheduler) -------------------
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
ENV_FILE="${ENV_FILE:-$CONTENT_ROOT/.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
else
  echo "run_sweep.sh: .env не найден по пути $ENV_FILE — продолжаю на дефолтах окружения." >&2
fi
CONTENT_ROOT="${CONTENT_ROOT:-$HOME/llm-wiki-content}"

# --- 2. Запуск sweep (node dist/scheduler/digest.js, обёрнут в caffeinate) ---
NODE_BIN="${NODE_BIN:-node}"
cd "$PUBLIC_REPO"

run_cmd=("$NODE_BIN" "$PUBLIC_REPO/dist/scheduler/digest.js" "$@")

if [ "${CAFFEINATE:-1}" = "1" ] && command -v caffeinate >/dev/null 2>&1; then
  caffeinate -s "${run_cmd[@]}" && rc=0 || rc=$?
else
  "${run_cmd[@]}" && rc=0 || rc=$?
fi

# --- 3. Коммит правок reminders/вики этого sweep'а (ADR-0015 R1, плановый слой) ---
# Движок (claude -p под acceptEdits) ПИШЕТ файлы (reminders status/last_fired, log.md),
# но НЕ гитует (§11 «движок не пишет git»; ADR-0007 «без shell у движка»). Коммитит
# ДОВЕРЕННЫЙ wrapper — симметрично мосту в реактиве. Только при успехе sweep'а и только
# если дерево «грязное». НЕ пушит (§11 «не пушит» — пуш ручной шаг владельца).
if [ "${rc:-1}" -eq 0 ] && [ -d "$CONTENT_ROOT/.git" ]; then
  git -C "$CONTENT_ROOT" add -A || true
  if ! git -C "$CONTENT_ROOT" diff --cached --quiet; then
    git -C "$CONTENT_ROOT" commit --no-verify -q -m "audit: proactive sweep digest" || true
  fi
fi

exit "${rc:-1}"
