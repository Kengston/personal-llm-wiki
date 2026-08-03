/**
 * scripts/career-directory.mjs — чеклист gitignored-справочника рендера ([ADR-0028], D3).
 *
 * Отвечает на единственный вопрос: чего не хватает, чтобы резюме собралось. Список ключей
 * считается ИЗ КАРЬЕРНОЙ БАЗЫ, а не из памяти владельца — он меняется вместе с базой, и
 * «я вроде всё заполнил» перестаёт быть предположением.
 *
 * Печатаются ТОЛЬКО ключи. Значения (имя, почта, телефон, названия организаций) не выводятся
 * никуда: они и заведены ради того, чтобы не появляться ни в репозитории, ни в логе.
 *
 * Запуск:  pnpm career:directory
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(ROOT, 'dist', p)).href);

const { createCareerLedger, loadCareerBase } = await imp('ingest/career/store.js');
const { describeDirectoryNeeds, missingDirectoryEntries } = await imp('ingest/career/render.js');
const { loadRenderDirectory, resolveDirectoryPath } = await imp('ingest/career/directory.js');

const base = loadCareerBase(createCareerLedger({ env: process.env }));
const needs = describeDirectoryNeeds(base);
const path = resolveDirectoryPath(process.env);

console.log(`Справочник: ${path}`);
console.log(`Карьерная база: позиций ${base.positions.length}, образование ${base.education.length}, проектов ${base.projects.length}.\n`);

const show = (title, keys, required = []) => {
	if (keys.length === 0) return;
	console.log(`${title}:`);
	for (const key of keys) console.log(`  ${key}${required.includes(key) ? ' — обязателен' : ''}`);
};

console.log('Нужны ключи:');
console.log('  display_name');
show('contacts', needs.contacts, needs.requiredContacts);
show('orgs', needs.orgs);
show('institutions', needs.institutions);
show('links', needs.links);

if (!existsSync(path)) {
	console.log(`\nФайла нет. Возьмите за основу career-directory.example.json и положите по пути выше.`);
	process.exit(1);
}

// Форму файла проверяет схема; чего не хватает — считаем по базе.
const missing = missingDirectoryEntries(base, loadRenderDirectory(path, process.env));
if (missing.length === 0) {
	console.log('\nСправочник закрывает все ключи — резюме соберётся.');
	process.exit(0);
}

console.log(`\nНе хватает ${missing.length}:`);
for (const key of missing) console.log(`  ${key}`);
process.exit(1);
