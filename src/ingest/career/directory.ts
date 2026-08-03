/**
 * directory.ts — IO-обвязка рендера: справочник идентифицирующих данных и запись документа.
 *
 * Здесь и только здесь модуль резюме касается файловой системы. Сам рендер (`render.ts`)
 * остаётся чистой функцией — это разделение не стилистическое: скоринг и подстановка
 * обязаны воспроизводиться, а всё, что зависит от диска, воспроизводиться не может.
 *
 * Две обязанности:
 *
 *   1. ЗАГРУЗИТЬ СПРАВОЧНИК (D3). Имя владельца, значения контактов, отображаемые названия
 *      организаций и ссылки не хранятся ни в публичном, ни в приватном репозитории —
 *      они лежат в gitignored-файле (по умолчанию `<CONTENT_ROOT>/career-directory.local.json`,
 *      путь переопределяется `CAREER_DIRECTORY_FILE`).
 *
 *   2. ЗАПИСАТЬ ДОКУМЕНТ ВНЕ ОБОИХ РЕПОЗИТОРИЕВ. В отрендеренном резюме подставлены
 *      реальные контакты, поэтому путь проверяется ДО записи: попадание внутрь публичного
 *      или приватного репо — исключение, а не предупреждение. Запись атомарная (tmp + rename):
 *      обрыв на середине оставил бы полуфайл, который выглядит как готовый документ.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { z } from 'zod';

import { resolvePublicRepo } from '../ledger.js';
import type { RenderDirectory } from './render.js';

/** Ошибка записи документа за пределы разрешённого места. */
export class RenderOutputPathError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RenderOutputPathError';
	}
}

/**
 * RenderDirectorySchema — форма gitignored-файла справочника.
 *
 * Значения — свободные строки: это почта, телефон, название организации. Схема их не
 * разбирает и не нормализует, потому что любая обработка PII здесь означала бы, что PII
 * тут задерживается; файл читается ровно для подстановки.
 */
export const RenderDirectorySchema = z.object({
	display_name: z.string().min(1),
	contacts: z.record(z.string(), z.string()).default({}),
	orgs: z.record(z.string(), z.string()).default({}),
	institutions: z.record(z.string(), z.string()).default({}),
	links: z.record(z.string(), z.string()).default({}),
});

/**
 * resolveDirectoryPath — путь к файлу справочника.
 *
 * Порядок:
 *   1. env.CAREER_DIRECTORY_FILE — явное переопределение
 *   2. env.CONTENT_ROOT + '/career-directory.local.json'
 *   3. ~/llm-wiki-content/career-directory.local.json
 *
 * Суффикс `.local.json` — тот же приём, что у `.filter-policy.local.json`: он уже
 * покрыт gitignore приватного репо, и файл не попадёт в коммит по невнимательности.
 */
export function resolveDirectoryPath(env: NodeJS.ProcessEnv = process.env): string {
	if (env.CAREER_DIRECTORY_FILE) return resolve(env.CAREER_DIRECTORY_FILE);
	const contentRoot = env.CONTENT_ROOT ?? join(homedir(), 'llm-wiki-content');
	return resolve(join(contentRoot, 'career-directory.local.json'));
}

/**
 * loadRenderDirectory — читает справочник с диска.
 *
 * Отсутствие файла — не «пустой справочник по умолчанию», а исключение: молча собранное
 * резюме без контактов выглядит готовым и уходит рекрутером нечитаемым. Пусть падает.
 *
 * @param path — путь к файлу; по умолчанию `resolveDirectoryPath()`
 */
export function loadRenderDirectory(
	path?: string,
	env: NodeJS.ProcessEnv = process.env,
): RenderDirectory {
	const filePath = path ?? resolveDirectoryPath(env);
	const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
	return RenderDirectorySchema.parse(raw);
}

/**
 * assertOutsideRepos — guard для пути отрендеренного документа.
 *
 * В документе подставлены реальные контакты владельца, поэтому его место — ВНЕ обоих
 * репозиториев ([ADR-0028]: «Отрендеренные документы — вне обоих репозиториев, под
 * gitignore»). Проверка зеркалит path-guard леджера, только в обратную сторону: там мы
 * не даём писать наружу приватного каталога, здесь — не даём писать внутрь репозиториев.
 *
 * @param targetPath  — куда собираемся писать документ
 * @param publicRepo  — корень публичного репо
 * @param contentRoot — корень приватного контент-репо
 */
export function assertOutsideRepos(
	targetPath: string,
	publicRepo: string,
	contentRoot: string,
): void {
	const target = resolve(targetPath);
	for (const [label, root] of [
		['публичного репозитория', publicRepo],
		['приватного контент-репозитория', contentRoot],
	] as const) {
		if (target.startsWith(resolve(root) + '/')) {
			throw new RenderOutputPathError(
				`ЗАПРЕЩЕНО: отрендеренное резюме содержит реальные контакты и не может лежать внутри ` +
					`${label} (${resolve(root)}). Путь: ${target}.`,
			);
		}
	}
}

/**
 * writeRenderedResume — атомарно пишет документ вне обоих репозиториев.
 *
 * tmp + rename, а не голый `writeFileSync`: `rename` в пределах одной файловой системы
 * атомарен, поэтому читатель видит либо старый документ, либо новый целиком — но никогда
 * не половину. Обрыв на записи резюме, которое собираются отправить, стоит дороже, чем
 * лишняя строка кода здесь.
 *
 * @param targetPath  — путь к документу (вне репозиториев)
 * @param markdown    — содержимое
 * @param env         — окружение для резолвинга корней репозиториев
 */
export function writeRenderedResume(
	targetPath: string,
	markdown: string,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const contentRoot = env.CONTENT_ROOT ?? join(homedir(), 'llm-wiki-content');
	assertOutsideRepos(targetPath, resolvePublicRepo(env), contentRoot);

	const target = resolve(targetPath);
	mkdirSync(dirname(target), { recursive: true });

	const tmpPath = `${target}.tmp`;
	writeFileSync(tmpPath, markdown, { encoding: 'utf8' });
	renameSync(tmpPath, target);
}
