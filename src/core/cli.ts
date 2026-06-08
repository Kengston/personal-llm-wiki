/**
 * cli.ts — устойчивая проверка «запущен как CLI-скрипт, а не импортирован».
 *
 * Наивный `import.meta.url === \`file://${process.argv[1]}\`` ломается в двух
 * реальных случаях: (1) путь содержит пробел/спецсимвол — url его percent-кодирует
 * (`sp%20ace`), а argv[1] оставляет литеральным; (2) скрипт вызван через симлинк —
 * url отдаёт realpath, argv[1] — путь как вызвали. В обоих случаях условие = false,
 * main() НЕ вызывается, процесс молча выходит 0. Для guard'а границы двух репо
 * (`lint-public`) это означало бы «успех» без сканирования НИ ОДНОГО файла.
 *
 * Сравниваем realpath обоих путей: `import.meta.filename` уже realpath'нут и
 * декодирован, а realpathSync(argv[1]) резолвит симлинк и нормализует литерал.
 */
import { realpathSync } from 'node:fs';

export function isMainModule(
	metaFilename: string,
	scriptPath: string | undefined = process.argv[1],
): boolean {
	if (!scriptPath) return false;
	try {
		return realpathSync(scriptPath) === metaFilename;
	} catch {
		return false;
	}
}
