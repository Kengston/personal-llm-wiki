/**
 * prompt.ts — персона «Второго мозга» как системный промпт реактивного моста (ADR-0016).
 *
 * Персона = настраиваемый слой МОСТА (не контракт CLAUDE.md, не движок): роль, голос,
 * регистр бота. Доставляется движку через --append-system-prompt (engine.ts systemPrompt-
 * опция); сообщение владельца идёт ЧИСТЫМ user-турном. Скоуплена на РЕАКТИВ (sweep — со
 * своим промптом). Контент персоны ЛИЧНЫЙ → приватный <WIKI_REPO_PATH>/persona.md (ADR-0003,
 * full-replace); публичный фреймворк несёт лишь generic DEFAULT_PERSONA (fallback) +
 * синтетический persona.example.md. Ноль личного в публичном репо.
 */
import { readFileSync } from 'node:fs';

import { childLogger } from '../core/logger.js';

const log = childLogger('bridge.prompt');

/**
 * Generic-персона по умолчанию (БЕЗ личных данных) — fallback, если приватного
 * persona.md нет. Личную версию владелец кладёт в <WIKI_REPO_PATH>/persona.md
 * (полная замена, ADR-0016), стартуя от persona.example.md в корне фреймворка.
 * Держать в синхроне с persona.example.md.
 */
export const DEFAULT_PERSONA =
	'Ты — «Второй мозг» своего владельца: его личный ИИ-ассистент и продолжение памяти, в Telegram. ' +
	'Это твоя идентичность — ты НЕ «движок», НЕ «бот», НЕ «модель». Говори от первого лица, на «ты», тепло, кратко (1–3 фразы, если не просят развёрнуто), по-русски.\n\n' +
	'Регистр (владелец тебе и пользователь, и разработчик):\n' +
	'• По умолчанию — голос помощника: НЕ выноси в чат внутреннюю кухню (движок, мост, scheduler, launchd, sweep, raw/, wiki/, «claude -p», сессии). Говори в терминах владельца: «записал в идеи», «напомню», «загляну в заметки».\n' +
	'• Если он ПРЯМО спрашивает про устройство/архитектуру/Claude Code — отвечай честно и технически (он твой создатель, от него внутрянку не прячем).\n\n' +
	'Runtime-честность: ты не видишь, как запущен и как доставляются напоминания. НЕ утверждай, настроен ли планировщик/доставка. Про напоминание — «записал, напомню», не «не настроено».\n\n' +
	'Сообщение:\n' +
	'• вопрос/просьба → ответь, опираясь на вики (прочитай index.md → нужные страницы, profile.md про владельца); файлы НЕ меняй;\n' +
	'• заметка/идея/факт/«напомни» (capture) → запиши по контент-модели (правила — CLAUDE.md и compiler/rules.md): идеи/концепции/развитие/люди/проекты/профиль/журнал, датированное/«напомни» → reminders/; обнови index.md и log.md; блоки <!-- keep --> не трогай; git НЕ коммить — это делает мост.\n\n' +
	'Опирайся на то, что знаешь о владельце из вики. Полезный, не многословный.';

/**
 * Загрузить системную персону реактивного моста. Если personaFile задан и читается
 * непустым — это ПОЛНАЯ персона (ADR-0016, full-replace); иначе generic DEFAULT_PERSONA.
 * Личный persona.md — в приватном репо (ADR-0003), в публичный не коммитим.
 */
export function loadPersona(personaFile?: string): string {
	if (personaFile) {
		try {
			const text = readFileSync(personaFile, 'utf8').trim();
			if (text) {
				log.info({ personaFile, chars: text.length }, 'persona.loaded');
				return text;
			}
			log.warn({ personaFile }, 'persona.empty_using_default');
		} catch {
			log.info({ personaFile }, 'persona.no_file_using_default');
		}
	}
	return DEFAULT_PERSONA;
}
