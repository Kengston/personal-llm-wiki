/**
 * writeback.ts — детерминированный коммит вики после хода движка (ADR-0015, R1).
 *
 * Движок (claude -p под acceptEdits) ПИШЕТ файлы, но НЕ гитует (compiler/rules.md §11;
 * Claude acceptEdits не покрывает git — .git/ защищён). Чтобы выполнить §0 «git-diff на
 * каждый ход», коммитит ДОВЕРЕННЫЙ код моста — НЕ инструмент LLM (ADR-0007 «без shell у
 * движка»): после хода, если рабочее дерево приватного репо «грязное», — git add -A &&
 * git commit. Query-ход дерево не меняет → коммита нет. Идемпотентно по «чистоте» дерева.
 * Push НЕ делаем (compiler/rules.md §11 «не пушит» — пуш ручной шаг владельца).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { childLogger } from '../core/logger.js';

const log = childLogger('bridge.writeback');
const pExecFile = promisify(execFile);

const GIT_TIMEOUT_MS = 15_000;

async function git(repoPath: string, args: string[]): Promise<string> {
	const { stdout } = await pExecFile('git', ['-C', repoPath, ...args], {
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: 8 * 1024 * 1024,
	});
	return stdout;
}

/**
 * Закоммитить правки вики этого хода, ЕСЛИ рабочее дерево приватного репо изменилось.
 * Возвращает true, если коммит создан. Безопасно к сбоям: ошибка git логируется и
 * проглатывается (файлы уже на диске и восстановимы; ответ владельцу важнее коммита).
 * НЕ пушит (§11).
 */
export async function commitIfDirty(repoPath: string, message: string): Promise<boolean> {
	try {
		const status = (await git(repoPath, ['status', '--porcelain'])).trim();
		if (!status) return false; // чистое дерево (напр. query-ход) → коммитить нечего

		await git(repoPath, ['add', '-A']);
		await git(repoPath, ['commit', '--no-verify', '-m', message]);
		const sha = (await git(repoPath, ['rev-parse', '--short', 'HEAD'])).trim();
		log.info({ repoPath, sha, changedEntries: status.split('\n').length }, 'writeback.committed');
		return true;
	} catch (err) {
		log.error({ repoPath, err: String(err) }, 'writeback.commit_failed');
		return false;
	}
}
