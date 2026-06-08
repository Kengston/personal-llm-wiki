/**
 * routines.ts — КАТАЛОГ плановых routine'ов «Второго мозга» (Claude-native).
 *
 * Порт `scheduler/routines.py` ([ADR-0012]). Единая точка входа планового слоя:
 * `node dist/scheduler/routines.js <name>`. Каждая routine — короткоживущий
 * `claude -p` ([ADR-0008]) с routine-специфичным промптом + детерминированная
 * обвязка (предчек, last-mile guard, push). Тяжёлые routine'ы делегируют (digest →
 * runSweep, lint → lint-public), лёгкие зовут общий `runEngineRoutine`.
 */
import { DateTime } from 'luxon';

import { isMainModule } from '../core/cli.js';
import { childLogger } from '../core/logger.js';
import { loadSchedulerConfig, type SchedulerConfig } from './config.js';
import { runSweep } from './digest.js';
import { lint, renderOffence } from './lint-public.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertNoSecrets, EngineUnavailableError, pushToOwner, spawnEngine } from './runner.js';

const log = childLogger('scheduler.routines');

function nowStr(now: DateTime): string {
	return now.toFormat('yyyy-MM-dd HH:mm ZZZZ');
}

// --- Общий помощник: спавн движка с routine-промптом (+ опц. owner-push) -------
async function runEngineRoutine(
	prompt: string,
	opts: { dryRun: boolean; pushSummary: boolean; label: string },
): Promise<number> {
	const { dryRun, pushSummary, label } = opts;
	if (dryRun) {
		process.stdout.write(`=== DRY RUN [${label}]: промпт для движка ===\n${prompt}\n`);
		return 0;
	}

	let answer: string;
	let usage: unknown;
	try {
		const result = await spawnEngine(prompt);
		answer = result.answer;
		usage = result.usage;
	} catch (exc) {
		if (exc instanceof EngineUnavailableError) {
			log.error({ routine: label, error: String(exc) }, 'engine-unavailable');
			return 2;
		}
		log.error({ routine: label, error: String(exc) }, 'engine-failed');
		return 3;
	}
	log.info({ routine: label, usage: String(usage) }, 'engine-completed');

	const text = (answer || '').trim();
	if (!pushSummary) {
		log.info({ routine: label, answerChars: text.length }, 'routine-done');
		return 0;
	}
	if (!text || text === 'NO_DIGEST') {
		log.info({ routine: label }, 'routine-no-output');
		return 0;
	}

	assertNoSecrets(text);
	try {
		await pushToOwner(text, { disableNotification: false });
	} catch (exc) {
		log.error({ routine: label, error: String(exc) }, 'telegram-send-failed');
		return 4;
	}
	log.info({ routine: label, chars: text.length }, 'routine-pushed');
	return 0;
}

// --- Промпт-шаблоны routine'ов ------------------------------------------------
function compilePrompt(cfg: SchedulerConfig, now: DateTime): string {
	return `Ты — компилятор персональной LLM-wiki «Второй мозг». Сейчас ${nowStr(now)}.

КОНТЕКСТ: workspace-write на приватный контент-репо. Перед любой правкой прочитай
контракт хранителя: ${join(cfg.publicRepo, 'compiler', 'rules.md')} и
${join(cfg.publicRepo, 'AGENTS.md')} (мандат чтения, анатомия страниц, дедуп).

ЗАДАЧА (ночная компиляция / событийный re-compile):
1. Найди НЕ скомпилированные ещё источники в ${cfg.rawDir} (по watermark per-source;
   не перечитывай учтённое — идемпотентность).
2. Инкрементально обнови/создай страницы в ${cfg.wikiDir} по контракту:
   - концепции/идеи/развитие — first-class; код-сессии СЖИМАЙ в accomplishment-
     выжимку и агрегируй в capability-profile — НЕ копируй код verbatim ([ADR-0010]);
   - новые факты — с массивом claims и источником; противоречия — через
     \`status: superseded\`, НЕ перезаписью; не воскрешай негативную память;
   - дедуп: ищи существующую страницу человека/идеи перед созданием новой.
3. Каждая правка — маленький git-diff; блоки \`<!-- keep -->\` не трогай; НИКАКОГО
   автономного bulk-rewrite.
4. Подвинь watermark источников после успешной записи.

ВЕРНИ В ОТВЕТЕ: одну строку-сводку «скомпилировано: N источников, +M страниц,
обновлено K» (для лога). Сам контент — в файлах, не в ответе.`;
}

function lintPrompt(cfg: SchedulerConfig, now: DateTime): string {
	return `Ты — линтёр-хранитель персональной LLM-wiki «Второй мозг». Сейчас ${nowStr(now)}.

КОНТЕКСТ: workspace-write на приватный контент-репо. Контракт —
${join(cfg.publicRepo, 'compiler', 'rules.md')}.

ЗАДАЧА (еженедельный лёгкий аудит вики, БЕЗ bulk-rewrite):
1. Противоречия: страницы с конфликтующими claim'ами — пометь младший
   \`status: superseded\` со ссылкой на актуальный (НЕ перезаписывай факты).
2. Протухшее (stale): давний \`last_updated\` + устаревший факт — \`status: stale\`.
3. Orphans: страницы без входящих ссылок / нет в \`wiki/index.md\` — допиши ссылку.
4. Битые относительные ссылки — почини путь.
Делай ТОЧЕЧНЫЕ правки. Спорные случаи — вынеси строкой в ответ для владельца.

ВЕРНИ В ОТВЕТЕ: короткий отчёт «противоречий: N, stale: M, orphans: K, битых
ссылок: L; на ручное решение: …». Этот текст уйдёт владельцу в Telegram.`;
}

function researchPrompt(cfg: SchedulerConfig, now: DateTime, queriesBlock: string): string {
	return `Ты — research-ассистент персональной LLM-wiki «Второй мозг». Сейчас ${nowStr(now)}.

ПОЛЬЗОВАТЕЛЬСКИЕ ЗАПРОСЫ (из ${cfg.researchQueries}, по одному на строку):
${queriesBlock}

ЗАДАЧА (плановый web-research):
1. Для каждого запроса проведи web-research своими «руками» (web/computer-MCP):
   собери актуальные факты из надёжных источников, сверь, отметь даты.
2. На каждый запрос создай/обнови файл-конспект в ${cfg.researchOutDir}:
   frontmatter (title, type: research, status: active, last_updated, sources:),
   затем сжатый разбор + вывод. Свяжи с релевантными страницами (\`## Связанные\`).
3. НЕ копируй простыни — конспектируй; различай факт и мнение; цитируй источники.

ВЕРНИ В ОТВЕТЕ: короткий дайджест на русском (1–2 строки на запрос: вывод + ссылка
на файл). Telegram-Markdown, до ~1500 символов. Нет запросов → ровно \`NO_DIGEST\`.

ИНВАРИАНТЫ: даты ISO; в конспекты не пиши секреты/токены; правки инкрементальные.`;
}

function resurfacePrompt(cfg: SchedulerConfig, now: DateTime): string {
	return `Ты — слой idea-resurfacing персональной LLM-wiki «Второй мозг». Сейчас ${nowStr(now)}.

КОНТЕКСТ: workspace-write на приватный контент-репо. Идеи — в ${cfg.wikiDir}/ideas/.

ЗАДАЧА:
1. Просмотри идеи в ${cfg.wikiDir}/ideas/ и выбери 1–2 давно не тронутые (старый
   \`last_updated\`), которые СТОИТ освежить (ещё актуальны, не drop/done).
2. Для каждой сформулируй строку «всплыла идея: <название> — <почему важна /
   следующий маленький шаг>, ещё актуальна?».
3. Если по идее уже есть spaced-reminder — не дублируй (всплывёт через digest).

ВЕРНИ В ОТВЕТЕ: эти 1–2 строки (уйдут владельцу в Telegram), или ровно
\`NO_DIGEST\`, если освежать нечего. Файлы вики не меняй — это мягкий nudge.`;
}

// --- Реализации routine'ов ----------------------------------------------------
export interface RoutineOptions {
	now: DateTime;
	dryRun: boolean;
}

export function runCompile(cfg: SchedulerConfig, opts: RoutineOptions): Promise<number> {
	return runEngineRoutine(compilePrompt(cfg, opts.now), {
		dryRun: opts.dryRun,
		pushSummary: false,
		label: 'compile',
	});
}

export function runDigest(cfg: SchedulerConfig, opts: RoutineOptions): Promise<number> {
	return runSweep(cfg, { now: opts.now, dryRun: opts.dryRun });
}

export async function runLint(cfg: SchedulerConfig, opts: RoutineOptions): Promise<number> {
	// (а) PII/секрет-скан публичного репо — чистый код, без движка.
	const offences = lint(cfg.publicRepo);
	if (offences.length > 0) {
		process.stderr.write(
			`FAIL: публичный репо НЕ чист — ${offences.length} нарушение(й) (см. lint-public):\n`,
		);
		for (const off of offences) process.stderr.write('  ' + renderOffence(off, cfg.publicRepo) + '\n');
		if (!opts.dryRun) return 1;
	}
	// (б) Содержательный аудит вики движком.
	const rc = await runEngineRoutine(lintPrompt(cfg, opts.now), {
		dryRun: opts.dryRun,
		pushSummary: true,
		label: 'lint',
	});
	return offences.length > 0 ? 1 : rc;
}

function readResearchQueries(path: string): string[] {
	if (!existsSync(path)) return [];
	const queries: string[] = [];
	for (const raw of readFileSync(path, 'utf8').split('\n')) {
		const line = raw.trim();
		if (line.startsWith('- ') || line.startsWith('* ')) {
			const q = line.slice(2).trim();
			if (q) queries.push(q);
		}
	}
	return queries;
}

export async function runResearch(cfg: SchedulerConfig, opts: RoutineOptions): Promise<number> {
	const queries = readResearchQueries(cfg.researchQueries);
	if (!queries.length) {
		log.info({ path: cfg.researchQueries }, 'research-no-queries');
		return 0;
	}
	const queriesBlock = queries.map((q) => `- ${q}`).join('\n');
	return runEngineRoutine(researchPrompt(cfg, opts.now, queriesBlock), {
		dryRun: opts.dryRun,
		pushSummary: true,
		label: 'research',
	});
}

export function runResurface(cfg: SchedulerConfig, opts: RoutineOptions): Promise<number> {
	return runEngineRoutine(resurfacePrompt(cfg, opts.now), {
		dryRun: opts.dryRun,
		pushSummary: true,
		label: 'resurface',
	});
}

// --- Реестр routine'ов --------------------------------------------------------
export interface Routine {
	name: string;
	runner: (cfg: SchedulerConfig, opts: RoutineOptions) => Promise<number>;
	summary: string;
}

export const ROUTINES: Record<string, Routine> = {
	compile: {
		name: 'compile',
		runner: runCompile,
		summary: 'ночь/событие: новые источники raw/ → страницы wiki/ (инкрементально)',
	},
	digest: {
		name: 'digest',
		runner: runDigest,
		summary: 'утро: due-напоминания + дни рождения → один Telegram-дайджест',
	},
	lint: {
		name: 'lint',
		runner: runLint,
		summary: 'еженедельно: PII-скан публичного репо + аудит вики (противоречия/stale/orphans)',
	},
	research: {
		name: 'research',
		runner: runResearch,
		summary: 'по расписанию: research/queries.md → web-research → wiki/research/ + Telegram',
	},
	resurface: {
		name: 'resurface',
		runner: runResurface,
		summary: 'idea-resurfacing: всплытие спящих идей (база — spaced-записи в digest)',
	},
};

// --- CLI ----------------------------------------------------------------------
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
	const list = argv.includes('--list');
	const dryRun = argv.includes('--dry-run');
	const routineName = argv.find((a) => !a.startsWith('--'));

	if (list || !routineName) {
		process.stdout.write('Каталог routine’ов «Второго мозга» (Claude-native, claude -p):\n\n');
		for (const name of Object.keys(ROUTINES).sort()) {
			process.stdout.write(`  ${name.padEnd(10)} — ${ROUTINES[name]!.summary}\n`);
		}
		process.stdout.write(
			'\nЗапуск: node dist/scheduler/routines.js <name> [--dry-run]\n' +
				'Расписания и два варианта планировщика — scheduler/routines/README.md\n',
		);
		return list ? 0 : 2;
	}

	const routine = ROUTINES[routineName];
	if (!routine) {
		process.stderr.write(`Неизвестная routine: ${routineName}. См. --list.\n`);
		return 2;
	}

	const cfg = loadSchedulerConfig();
	return routine.runner(cfg, { now: DateTime.now(), dryRun });
}

if (isMainModule(import.meta.filename)) {
	main().then((code) => process.exit(code));
}
