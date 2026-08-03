#!/usr/bin/env bash
# career-evidence.sh — сборщик объективных фактов «что я построил как разработчик».
#
# Зачем. Резюме и capability-profile должны стоять на измеренных фактах (коммиты,
# объём кода, даты, стек), а не на самооценке по памяти. Скрипт сканирует локальные
# git-репозитории и печатает markdown-снапшот, который кладётся в `raw/career/`
# (immutable-источник) и цитируется project-страницами через `sources:`.
#
# Почему shell, а не TS-модуль движка: сбор идёт по ЛОКАЛЬНЫМ рабочим копиям вне
# обоих репозиториев вики — это разовая ручная операция владельца, а не write-path
# движка. Движку тут нечего исполнять, поэтому лишний слой не заводим.
#
# PII: ни авторы, ни пути НЕ захардкожены — публичный репозиторий их не хранит
# (см. `pnpm lint:public`). Всё приходит через окружение:
#   CAREER_AUTHORS — git-авторы через ';' (подстроки для --author, регистронезависимо)
#   CAREER_ROOTS   — каталоги-корни через ';' (сканируется сам корень и его прямые дети)
#
# Пример (synthetic-example, данные вымышленные):
#   CAREER_AUTHORS='you@example.com;Nickname' CAREER_ROOTS="$HOME/projects;$HOME/pet" \
#     bash scripts/career-evidence.sh > snapshot.md
# Без `pipefail` намеренно: скрипт агрегирующий, и `git log ... | head -1` штатно
# роняет git по SIGPIPE, как только head закрыл поток. С pipefail это выглядело бы
# как падение сбора (exit 141) на первом же репозитории. Отсутствие репо/веток тоже
# ожидаемо и гасится через `|| true` по месту.
set -eu

# Урезанный PATH в неинтерактивных оболочках — доклеиваем стандартные каталоги.
export PATH="/usr/bin:/bin:/usr/local/bin:$PATH"

if [[ -z "${CAREER_AUTHORS:-}" || -z "${CAREER_ROOTS:-}" ]]; then
	echo "CAREER_AUTHORS и CAREER_ROOTS обязательны (см. шапку скрипта)" >&2
	exit 2
fi

# Авторы → массив аргументов `--author=X`. git трактует несколько --author как OR,
# поэтому один общий regex с '|' не нужен (в BRE он бы и не сработал).
AUTHOR_ARGS=()
IFS=';' read -r -a _authors <<<"$CAREER_AUTHORS"
for a in "${_authors[@]}"; do
	[[ -n "$a" ]] && AUTHOR_ARGS+=("--author=$a")
done

# Корни → список кандидатов: сам корень + его прямые дети (типовой ~/Projects/*).
CANDIDATES=()
IFS=';' read -r -a _roots <<<"$CAREER_ROOTS"
for root in "${_roots[@]}"; do
	[[ -d "$root" ]] || continue
	CANDIDATES+=("$root")
	for child in "$root"/*/; do
		[[ -d "$child" ]] && CANDIDATES+=("${child%/}")
	done
done

# Общий набор фильтров для git log: все ветки + мои авторы.
log_mine() {
	local dir="$1"
	shift
	git -C "$dir" log --all --regexp-ignore-case "${AUTHOR_ARGS[@]}" "$@" 2>/dev/null
}

# ДЕДУП КЛОНОВ. Один и тот же репозиторий часто лежит в двух рабочих копиях (рабочая
# и «свежая», проектная и по-тикетная). Наивный обход посчитал бы его дважды и раздул
# итог. Ключ дедупа — ХЕШ КОРНЕВОГО КОММИТА: он одинаков у всех клонов репозитория.
# По URL дедуп не годится — `…/repo` и `…/repo.git` это одна и та же строка для человека
# и разные для машины (реальный случай: atlas_rgs_kau, 210 против 250 коммитов).
# Из группы клонов берём тот, где коммитов автора больше — то есть наименее устаревший.
declare -a UNIQUE_DIRS=()
declare -a DROPPED=()
roots_tmp="$(mktemp)"
ext_tmp="$(mktemp)"
trap 'rm -f "$roots_tmp" "$ext_tmp"' EXIT

for dir in "${CANDIDATES[@]}"; do
	[[ -d "$dir/.git" ]] || continue
	commits="$(log_mine "$dir" --oneline | wc -l | tr -d ' ')"
	[[ "$commits" == "0" ]] && continue
	# Корневых коммитов может быть несколько (слитые истории) — берём последний
	# в списке, он стабилен для конкретного репозитория.
	root="$(git -C "$dir" rev-list --max-parents=0 HEAD 2>/dev/null | tail -1)"
	# Репозиторий без коммитов/без HEAD — ключуем по пути, чтобы не схлопнуть разные.
	[[ -z "$root" ]] && root="path:$dir"
	printf "%s\t%s\t%s\n" "$root" "$commits" "$dir" >>"$roots_tmp"
done

# В каждой группе по root-хешу оставляем строку с максимальным числом коммитов.
while IFS=$'\t' read -r root commits dir; do
	best_line="$(awk -F'\t' -v r="$root" '$1 == r {print}' "$roots_tmp" | sort -t$'\t' -k2 -rn | head -1)"
	best_dir="$(printf '%s' "$best_line" | cut -f3)"
	if [[ "$dir" == "$best_dir" ]]; then
		UNIQUE_DIRS+=("$dir")
	else
		DROPPED+=("$(basename "$dir") ($commits коммитов) — дубль $(basename "$best_dir")")
	fi
done < <(sort -u "$roots_tmp")

# --- Сбор замера ------------------------------------------------------------
# Данные сначала собираются в TSV, и только потом печатаются в выбранном формате.
# Так один и тот же замер даёт побайтово одинаковый markdown и JSON, а snapshot_id
# считается ровно от данных, а не от того, как их отрендерили.
rows_tmp="$(mktemp)"
trap 'rm -f "$roots_tmp" "$ext_tmp" "$rows_tmp"' EXIT

total_commits=0
repo_count=0

for dir in "${UNIQUE_DIRS[@]}"; do
	commits="$(log_mine "$dir" --oneline | wc -l | tr -d ' ')"
	name="$(basename "$dir")"
	first="$(log_mine "$dir" --reverse --format=%ad --date=short | head -1)"
	last="$(log_mine "$dir" --format=%ad --date=short | head -1)"
	# numstat даёт добавленные/удалённые строки только по МОИМ коммитам.
	read -r added removed <<<"$(log_mine "$dir" --numstat --format='' |
		awk '{a += $1; d += $2} END {printf "%d %d", a, d}')"

	log_mine "$dir" --name-only --format='' | grep -oE '\.[a-zA-Z0-9]+$' >>"$ext_tmp" || true

	printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$name" "$commits" "$first" "$last" "$added" "$removed" >>"$rows_tmp"
	total_commits=$((total_commits + commits))
	repo_count=$((repo_count + 1))
done

# SNAPSHOT_ID — стабильный идентификатор ЗАМЕРА, а не запуска. Считается от отсортированных
# строк данных, поэтому повторный прогон на неизменившихся репозиториях даёт тот же id, а
# любое расхождение в цифрах — новый. На это опирается ADR-0028: метрика ссылается на
# snapshot_id, вариант резюме пинится к нему, а расхождение id и есть сигнал «данные устарели».
# Время в хеш НЕ входит намеренно — иначе id менялся бы на каждом запуске и пин стал бы бессмысленным.
hash_stdin() {
	if command -v shasum >/dev/null 2>&1; then
		shasum -a 256 | cut -c1-12
	else
		sha256sum | cut -c1-12
	fi
}
SNAPSHOT_ID="$(sort "$rows_tmp" | hash_stdin)"

# Экранирование для JSON-строк: обратный слеш и кавычка. Имена репозиториев — это basename
# каталогов, где теоретически возможно и то, и другое.
json_escape() {
	printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# --- Вывод ------------------------------------------------------------------
if [[ "${CAREER_FORMAT:-markdown}" == "json" ]]; then
	# Машиночитаемый режим — для импортёра карьерного модуля (ADR-0028).
	printf '{\n  "snapshot_id": "%s",\n' "$SNAPSHOT_ID"
	printf '  "repo_count": %s,\n  "total_commits": %s,\n' "$repo_count" "$total_commits"
	printf '  "repos": [\n'
	first_row=1
	while IFS=$'\t' read -r name commits first last added removed; do
		[[ $first_row -eq 0 ]] && printf ',\n'
		first_row=0
		printf '    {"name": "%s", "commits": %s, "first_commit": "%s", "last_commit": "%s", "added": %s, "removed": %s}' \
			"$(json_escape "$name")" "$commits" "$first" "$last" "$added" "$removed"
	done <"$rows_tmp"
	printf '\n  ],\n  "dropped_duplicates": [\n'
	first_row=1
	for d in "${DROPPED[@]:-}"; do
		[[ -z "$d" ]] && continue
		[[ $first_row -eq 0 ]] && printf ',\n'
		first_row=0
		printf '    "%s"' "$(json_escape "$d")"
	done
	printf '\n  ],\n  "extensions": [\n'
	first_row=1
	while read -r count ext; do
		[[ -z "$ext" ]] && continue
		[[ $first_row -eq 0 ]] && printf ',\n'
		first_row=0
		printf '    {"ext": "%s", "files_touched": %s}' "$(json_escape "$ext")" "$count"
	done < <(sort "$ext_tmp" | uniq -c | sort -rn | head -15)
	printf '\n  ]\n}\n'
	exit 0
fi

# Человекочитаемый режим (по умолчанию) — идёт в raw/career/ как immutable-снапшот.
echo "**Snapshot ID:** \`$SNAPSHOT_ID\`"
echo
echo "| Репозиторий | Коммиты | Первый | Последний | +строк | -строк |"
echo "|---|---:|---|---|---:|---:|"
while IFS=$'\t' read -r name commits first last added removed; do
	printf "| %s | %s | %s | %s | %s | %s |\n" "$name" "$commits" "$first" "$last" "$added" "$removed"
done <"$rows_tmp"

# Отброшенное печатаем ЯВНО: молчаливый дедуп читался бы как «столько и было».
if ((${#DROPPED[@]} > 0)); then
	echo
	echo "**Отброшено как дубликаты клонов (${#DROPPED[@]}):**"
	for d in "${DROPPED[@]}"; do echo "- $d"; done
fi

echo
echo "**Уникальных репозиториев:** $repo_count"

echo
echo "**Всего коммитов:** $total_commits"
echo
echo "## Стек по фактическим правкам (топ-15 расширений)"
echo
echo '```'
sort "$ext_tmp" | uniq -c | sort -rn | head -15
echo '```'
