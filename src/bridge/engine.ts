/**
 * engine.ts — портируемый шов движка «Второго мозга» (порт bridge/engine.py).
 *
 * Весь остальной код знает движок ТОЛЬКО через контракт `Engine`:
 *     const { answer, sessionId, usage } = await engine.run(prompt, sessionId);
 *
 * v1 дефолт и единственный включённый адаптер — `ClaudeEngine` (официальный бинарь
 * `claude -p`, ToS-safe — [ADR-0009]). `GrokEngine`/`CodexEngine` — готовые
 * ОТЛОЖЕННЫЕ слоты ([ADR-0008]), выбираются `ENGINE`.
 *
 * Жёсткие правила ([ADR-0007]):
 *  - Spawn-fresh-per-task: один короткоживущий процесс на ход, затем выходит.
 *  - Resume по chat: session_id парсится из ответа и персистится в store.
 *  - Жёсткий timeout + kill; один retry на транзиентную ошибку — в воркере (app.ts).
 *  - БЕЗ shell: prompt (недоверенный текст пользователя) идёт АРГУМЕНТОМ массива
 *    spawn, НИКОГДА не интерполируется в shell-строку — минимизация blast radius
 *    ([ADR-0007]). ToS-safe ([ADR-0009]): только официальный бинарь, без реюза
 *    OAuth-токена в стороннем клиенте.
 */
import { spawn } from 'node:child_process';

import { childLogger } from '../core/logger.js';

const log = childLogger('bridge.engine');

// --------------------------------------------------------------------------- //
// Контракт движка                                                             //
// --------------------------------------------------------------------------- //

export interface EngineResult {
	answer: string; // финальный текст ответа для Telegram
	sessionId: string | null; // session_id движка ПОСЛЕ хода (для resume)
	usage: Record<string, unknown> | null; // сырой usage (токены/cost) или null
	isError: boolean;
}

/** Транзиентная или фатальная ошибка движка. transient=true → воркер сделает 1 retry. */
export class EngineError extends Error {
	readonly transient: boolean;

	constructor(message: string, opts: { transient?: boolean; cause?: unknown } = {}) {
		super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
		this.name = 'EngineError';
		this.transient = opts.transient ?? false;
	}
}

export interface Engine {
	/**
	 * Выполнить один ход. session_id — id предыдущей сессии для resume, либо
	 * null/undefined для первого хода. Бросает EngineError на сбое.
	 */
	run(prompt: string, sessionId?: string | null): Promise<EngineResult>;
}

interface ParsedOutput {
	answer: string;
	sessionId: string | null;
	usage: Record<string, unknown> | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// --------------------------------------------------------------------------- //
// Базовый spawn-помощник (общий для всех subprocess-адаптеров)                 //
// --------------------------------------------------------------------------- //

class ProcessTimeoutError extends Error {}

interface ProcResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

/**
 * spawn-fresh: запускает процесс БЕЗ shell (аргументы массивом), собирает
 * stdout/stderr, жёсткий timeout с terminate→kill (SIGTERM, затем SIGKILL).
 */
function runProcess(
	bin: string,
	args: string[],
	opts: { timeoutMs: number; env: NodeJS.ProcessEnv; cwd?: string },
): Promise<ProcResult> {
	return new Promise<ProcResult>((resolve, reject) => {
		const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let settled = false;
		let timedOut = false;
		let hardKillTimer: NodeJS.Timeout | undefined;

		const killTimer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGTERM');
			// Если за 5с не вышел — добиваем SIGKILL (как Python terminate→kill).
			hardKillTimer = setTimeout(() => {
				try {
					child.kill('SIGKILL');
				} catch {
					// процесс уже мёртв
				}
			}, 5000);
		}, opts.timeoutMs);

		const cleanup = (): void => {
			clearTimeout(killTimer);
			if (hardKillTimer) clearTimeout(hardKillTimer);
		};

		child.on('error', (err) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		});
		child.stdout?.on('data', (d: Buffer) => stdoutChunks.push(d));
		child.stderr?.on('data', (d: Buffer) => stderrChunks.push(d));
		child.on('close', (code, signal) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (timedOut) {
				reject(new ProcessTimeoutError());
				return;
			}
			resolve({
				code,
				signal,
				stdout: Buffer.concat(stdoutChunks).toString('utf8'),
				stderr: Buffer.concat(stderrChunks).toString('utf8'),
			});
		});
	});
}

/** Грубая эвристика: похожа ли ошибка на транзиентную (стоит retry). */
function looksTransient(stderrText: string): boolean {
	const low = stderrText.toLowerCase();
	const fatal = ['auth', 'login', 'not found', 'no such', 'config', 'unauthorized'];
	if (fatal.some((m) => low.includes(m))) return false;
	const transient = [
		'rate limit',
		'429',
		'timeout',
		'timed out',
		'temporarily',
		'connection',
		'stream',
		'overloaded',
		'503',
		'502',
	];
	return transient.some((m) => low.includes(m));
}

/** Общий механизм spawn-fresh-per-task. Адаптеры задают argv + парсинг stdout. */
abstract class SubprocessEngine implements Engine {
	timeoutSeconds = 180;

	/** Собрать argv (включая бинарь как argv[0]) для нового хода или resume. */
	abstract buildArgv(prompt: string, sessionId: string | null): string[];

	/** Распарсить stdout процесса → answer/sessionId/usage. */
	abstract parseOutput(stdoutText: string, priorSessionId: string | null): ParsedOutput;

	/** Окружение дочернего процесса (адаптеры переопределяют для чистки ключей). */
	protected childEnv(): NodeJS.ProcessEnv {
		return { ...process.env };
	}

	/** Рабочая директория дочернего процесса (cwd спавна; адаптеры переопределяют). */
	protected workingDir(): string | undefined {
		return undefined;
	}

	protected missingBinaryHint(): string {
		return 'Бинарь движка не найден. Проверь установку и переменную *_BIN (см. setup/SETUP.md).';
	}

	async run(prompt: string, sessionId: string | null = null): Promise<EngineResult> {
		const argv = this.buildArgv(prompt, sessionId);
		const bin = argv[0] ?? '';
		const args = argv.slice(1);
		log.info(
			{
				engine: this.constructor.name,
				resume: Boolean(sessionId),
				sessionId,
				argvHead: argv.slice(0, 2), // только бинарь+флаг, НЕ сам prompt (приватный)
			},
			'engine.spawn',
		);

		let result: ProcResult;
		try {
			result = await runProcess(bin, args, {
				timeoutMs: this.timeoutSeconds * 1000,
				env: this.childEnv(),
				cwd: this.workingDir(),
			});
		} catch (exc) {
			if (exc instanceof ProcessTimeoutError) {
				throw new EngineError(`движок не ответил за ${this.timeoutSeconds}с — ход прерван.`, {
					transient: true,
				});
			}
			if ((exc as NodeJS.ErrnoException).code === 'ENOENT') {
				throw new EngineError(this.missingBinaryHint(), { transient: false, cause: exc });
			}
			throw new EngineError(`сбой запуска движка: ${String(exc)}`, { transient: false, cause: exc });
		}

		const stderrText = result.stderr.trim();
		if (result.code !== 0) {
			const transient = looksTransient(stderrText);
			// При гибели по сигналу code===null — даём информативный «сигналом SIGXXX»
			// вместо неинформативного «кодом null» (Python видел returncode=-N).
			const failedBySignal = result.code === null && result.signal !== null;
			const codeStr = failedBySignal ? `сигналом ${result.signal}` : `кодом ${result.code}`;
			log.warn(
				{
					engine: this.constructor.name,
					returnCode: result.code,
					signal: result.signal,
					stderr: stderrText.slice(0, 500),
					transient,
				},
				'engine.nonzero_exit',
			);
			throw new EngineError(`движок завершился ${codeStr}: ${stderrText.slice(0, 300)}`, {
				transient,
			});
		}

		const parsed = this.parseOutput(result.stdout, sessionId);
		let answer = parsed.answer;
		if (!answer) {
			answer = '(движок вернул пустой ответ)';
			log.warn({ engine: this.constructor.name }, 'engine.empty_answer');
		}
		log.info(
			{
				engine: this.constructor.name,
				sessionId: parsed.sessionId,
				answerChars: answer.length,
				usage: parsed.usage,
			},
			'engine.done',
		);
		return { answer, sessionId: parsed.sessionId, usage: parsed.usage, isError: false };
	}
}

// --------------------------------------------------------------------------- //
// Адаптер Claude (v1, ДЕФОЛТНЫЙ и единственный включённый)                     //
// --------------------------------------------------------------------------- //

export interface ClaudeEngineOptions {
	claudeBin?: string;
	wikiRepoPath?: string;
	model?: string | null;
	timeoutSeconds?: number;
	continueLatest?: boolean;
	extraArgs?: string[];
}

export class ClaudeEngine extends SubprocessEngine {
	private readonly claudeBin: string;
	private readonly wikiRepoPath: string;
	private readonly model: string | null;
	private readonly continueLatest: boolean;
	private readonly extraArgs: string[];

	constructor(opts: ClaudeEngineOptions = {}) {
		super();
		this.claudeBin = opts.claudeBin ?? 'claude';
		this.wikiRepoPath = opts.wikiRepoPath ?? '.';
		this.model = opts.model ?? null;
		this.timeoutSeconds = opts.timeoutSeconds ?? 180;
		this.continueLatest = opts.continueLatest ?? false;
		this.extraArgs = opts.extraArgs ?? [];
	}

	/** claude читает/пишет вики из cwd — задаём рабочую директорию спавна, не флагом. */
	protected override workingDir(): string | undefined {
		return this.wikiRepoPath;
	}

	buildArgv(prompt: string, sessionId: string | null): string[] {
		// claude -p "<prompt>" --output-format json [-m model]
		//        [--resume <session_id> | --continue] [extraArgs...]
		// Рабочая директория (вики-репо) задаётся через cwd спавна (workingDir()), а НЕ
		// флагом: у официального claude нет --cwd (фикс при E2E polling, [ADR-0014]).
		const argv = [this.claudeBin, '-p', prompt, '--output-format', 'json'];
		if (this.model) argv.push('-m', this.model);
		if (sessionId) {
			if (this.continueLatest) argv.push('--continue');
			else argv.push('--resume', sessionId);
		}
		argv.push(...this.extraArgs);
		return argv;
	}

	protected override missingBinaryHint(): string {
		return (
			`claude-бинарь не найден: ${this.claudeBin}. Установи официальный Claude Code ` +
			`и/или поправь CLAUDE_BIN (см. setup/SETUP.md). Реюз OAuth-токена в стороннем ` +
			`клиенте запрещён ([ADR-0009]).`
		);
	}

	parseOutput(stdoutText: string, priorSessionId: string | null): ParsedOutput {
		const text = stdoutText.trim();
		if (!text) return { answer: '', sessionId: priorSessionId, usage: null };

		let payload: unknown;
		try {
			payload = JSON.parse(text);
		} catch {
			// Не JSON (plain-text) — отдаём как есть, session_id прежний.
			log.warn({ head: text.slice(0, 200) }, 'engine.claude.non_json_stdout');
			return { answer: text, sessionId: priorSessionId, usage: null };
		}

		if (Array.isArray(payload)) {
			payload =
				payload.find((e) => isRecord(e) && e.type === 'result') ??
				(payload.length ? payload[payload.length - 1] : {});
		}
		if (!isRecord(payload)) return { answer: text, sessionId: priorSessionId, usage: null };

		const sid = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : priorSessionId;
		const usage = isRecord(payload.usage) ? payload.usage : null;

		if (payload.is_error) {
			const message = payload.result || payload.error || 'claude вернул is_error';
			throw new EngineError(String(message), { transient: true });
		}

		const answer = typeof payload.result === 'string' ? payload.result : '';
		return { answer: answer.trim(), sessionId: sid, usage };
	}
}

// --------------------------------------------------------------------------- //
// Адаптер Codex (ОТЛОЖЕННЫЙ слот — портируемость, не v1)                       //
// --------------------------------------------------------------------------- //

export interface CodexEngineOptions {
	codexBin?: string;
	wikiRepoPath?: string;
	model?: string | null;
	timeoutSeconds?: number;
	extraArgs?: string[];
}

export class CodexEngine extends SubprocessEngine {
	private readonly codexBin: string;
	private readonly wikiRepoPath: string;
	private readonly model: string | null;
	private readonly extraArgs: string[];

	constructor(opts: CodexEngineOptions = {}) {
		super();
		this.codexBin = opts.codexBin ?? 'codex';
		this.wikiRepoPath = opts.wikiRepoPath ?? '.';
		this.model = opts.model ?? null;
		this.timeoutSeconds = opts.timeoutSeconds ?? 180;
		this.extraArgs = opts.extraArgs ?? [];
	}

	buildArgv(prompt: string, sessionId: string | null): string[] {
		const common = ['--json', '--skip-git-repo-check', '--cd', this.wikiRepoPath, '-a', 'never'];
		if (this.model) common.push('-m', this.model);
		common.push(...this.extraArgs);
		if (sessionId) {
			// resume: БЕЗ --ephemeral (баг #15538 молча форкает thread).
			return [this.codexBin, 'exec', 'resume', sessionId, ...common, prompt];
		}
		return [this.codexBin, 'exec', ...common, prompt];
	}

	protected override childEnv(): NodeJS.ProcessEnv {
		// Гарантируем отсутствие OPENAI_API_KEY (иначе codex может уйти в per-token биллинг).
		const env = { ...process.env };
		delete env.OPENAI_API_KEY;
		return env;
	}

	protected override missingBinaryHint(): string {
		return (
			`codex-бинарь не найден: ${this.codexBin} (адаптер ОТЛОЖЕН). Установи Codex CLI ` +
			`и/или поправь CODEX_BIN, либо используй ENGINE=claude.`
		);
	}

	parseOutput(stdoutText: string, priorSessionId: string | null): ParsedOutput {
		let sessionId: string | null = priorSessionId;
		let usage: Record<string, unknown> | null = null;
		const answerParts: string[] = [];

		for (const rawLine of stdoutText.split('\n')) {
			const line = rawLine.trim();
			if (!line) continue;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				continue; // не-JSON баннеры игнорируем
			}
			if (!isRecord(event)) continue;

			const etype = event.type;
			if (etype === 'thread.started') {
				const sid = event.session_id || event.thread_id;
				if (typeof sid === 'string' && sid) sessionId = sid;
			} else if (etype === 'turn.completed') {
				if (isRecord(event.usage)) usage = event.usage;
			} else if (etype === 'error') {
				const message = event.message || event.error || 'codex вернул error';
				throw new EngineError(String(message), { transient: true });
			} else if (etype === 'item.completed' || etype === 'assistant' || etype === 'message') {
				const chunk =
					event.text || event.content || (isRecord(event.message) ? event.message.content : undefined);
				if (typeof chunk === 'string') answerParts.push(chunk);
			}
		}

		return { answer: answerParts.filter(Boolean).join('\n').trim(), sessionId, usage };
	}
}

// --------------------------------------------------------------------------- //
// Адаптер Grok (ОТЛОЖЕННЫЙ слот — advisor-голос)                               //
// --------------------------------------------------------------------------- //

export interface GrokEngineOptions {
	backend?: string;
	grokBin?: string;
	openclawBin?: string;
	wikiRepoPath?: string;
	model?: string | null;
	timeoutSeconds?: number;
	extraArgs?: string[];
}

export class GrokEngine extends SubprocessEngine {
	private readonly backend: string;
	private readonly grokBin: string;
	private readonly openclawBin: string;
	private readonly model: string | null;
	private readonly extraArgs: string[];

	constructor(opts: GrokEngineOptions = {}) {
		super();
		this.backend = opts.backend ?? 'grok-build-cli';
		this.grokBin = opts.grokBin ?? 'grok';
		this.openclawBin = opts.openclawBin ?? 'openclaw';
		this.model = opts.model ?? null;
		this.timeoutSeconds = opts.timeoutSeconds ?? 180;
		this.extraArgs = opts.extraArgs ?? [];
	}

	buildArgv(prompt: string, sessionId: string | null): string[] {
		if (this.backend === 'openclaw') {
			// ⚠ OpenClaw допустим ТОЛЬКО для Grok (санкционирован xAI), НИКОГДА для Claude ([ADR-0009]).
			const argv = [this.openclawBin, 'run', prompt, '--json'];
			if (sessionId) argv.push('--session', sessionId);
			if (this.model) argv.push('--model', this.model);
			return [...argv, ...this.extraArgs];
		}
		// По умолчанию — официальный Grok Build CLI (форма как у claude -p).
		const argv = [this.grokBin, '-p', prompt, '--output-format', 'json'];
		if (this.model) argv.push('-m', this.model);
		if (sessionId) argv.push('--resume', sessionId);
		return [...argv, ...this.extraArgs];
	}

	protected override missingBinaryHint(): string {
		const which = this.backend === 'openclaw' ? this.openclawBin : this.grokBin;
		return (
			`grok-бинарь не найден: ${which} (адаптер ОТЛОЖЕН, backend=${this.backend}). Установи ` +
			`Grok Build CLI/OpenClaw и/или поправь GROK_BIN/OPENCLAW_BIN, либо используй ENGINE=claude.`
		);
	}

	parseOutput(stdoutText: string, priorSessionId: string | null): ParsedOutput {
		const text = stdoutText.trim();
		if (!text) return { answer: '', sessionId: priorSessionId, usage: null };
		let payload: unknown;
		try {
			payload = JSON.parse(text);
		} catch {
			log.warn({ backend: this.backend, head: text.slice(0, 200) }, 'engine.grok.non_json_stdout');
			return { answer: text, sessionId: priorSessionId, usage: null };
		}

		if (Array.isArray(payload)) {
			payload =
				payload.find((e) => isRecord(e) && (e.type === 'result' || e.type === 'text')) ??
				(payload.length ? payload[payload.length - 1] : {});
		}
		if (!isRecord(payload)) return { answer: text, sessionId: priorSessionId, usage: null };

		const sid =
			(typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : null) ??
			(typeof payload.session === 'string' && payload.session ? payload.session : null) ??
			priorSessionId;
		const usage = isRecord(payload.usage) ? payload.usage : null;
		if (payload.is_error) {
			const message = payload.result || payload.error || 'grok вернул is_error';
			throw new EngineError(String(message), { transient: true });
		}
		const answerRaw = payload.result || payload.text || '';
		const answer = typeof answerRaw === 'string' ? answerRaw : '';
		return { answer: answer.trim(), sessionId: sid, usage };
	}
}

// --------------------------------------------------------------------------- //
// Фабрика движка из окружения                                                 //
// --------------------------------------------------------------------------- //

/**
 * Собрать движок из окружения (ENGINE=claude|grok|codex, дефолт claude).
 * Сменить/добавить движок — добавить ветку здесь; остальной мост не меняется.
 */
export function buildEngineFromEnv(env: NodeJS.ProcessEnv = process.env): Engine {
	const wikiRepo = (env.WIKI_REPO_PATH ?? '').trim();
	if (!wikiRepo) {
		throw new EngineError(
			'WIKI_REPO_PATH не задан — движку некуда указывать (приватный контент-репо). ' +
				'См. .env.example / setup/SETUP.md.',
			{ transient: false },
		);
	}

	const engineName = (env.ENGINE || 'claude').trim().toLowerCase();
	const timeout = Number(env.ENGINE_TIMEOUT_SEC ?? '180') || 180;

	if (engineName === 'claude') {
		return new ClaudeEngine({
			claudeBin: (env.CLAUDE_BIN || 'claude').trim() || 'claude',
			wikiRepoPath: wikiRepo,
			model: (env.CLAUDE_MODEL || '').trim() || null,
			timeoutSeconds: timeout,
			continueLatest: env.CLAUDE_CONTINUE_LATEST === '1',
		});
	}

	if (engineName === 'grok') {
		log.warn({ engine: 'grok' }, 'engine.deferred_selected');
		return new GrokEngine({
			backend: (env.GROK_BACKEND || 'grok-build-cli').trim(),
			grokBin: (env.GROK_BIN || 'grok').trim() || 'grok',
			openclawBin: (env.OPENCLAW_BIN || 'openclaw').trim() || 'openclaw',
			wikiRepoPath: wikiRepo,
			model: (env.GROK_MODEL || '').trim() || null,
			timeoutSeconds: timeout,
		});
	}

	if (engineName === 'codex') {
		log.warn({ engine: 'codex' }, 'engine.deferred_selected');
		return new CodexEngine({
			codexBin: (env.CODEX_BIN || 'codex').trim() || 'codex',
			wikiRepoPath: wikiRepo,
			model: (env.CODEX_MODEL || '').trim() || null,
			timeoutSeconds: timeout,
		});
	}

	throw new EngineError(`Неизвестный ENGINE=${engineName}. Допустимо: claude (дефолт), grok, codex.`, {
		transient: false,
	});
}
