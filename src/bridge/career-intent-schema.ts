/**
 * career-intent-schema.ts — протокол карьерных интентов: схемы и извлечение из ответа движка.
 *
 * Форма та же, что у финансового модуля ([ADR-0024]): движок эмитит ОДИН fenced-блок
 * ```career-intent с JSON, мост детерминированно его валидирует и диспетчеризует. Текст
 * вокруг блока — пояснение владельцу; применяется ТОЛЬКО блок.
 *
 * Модуль намеренно разрезан на три файла с самого начала (`-schema` / `-dispatch` /
 * `-query`): `finance-intent.ts` дорос до двух тысяч строк одним куском, и тест к нему —
 * до двух с половиной. Разрез по границе «что это» / «что записать» / «что показать»
 * держится сам собой, потому что зависимости идут в одну сторону.
 *
 * Что через протокол ходит, а что нет (D1/D2):
 *   - СТРУКТУРА — через бота: добавить/удалить запись, включить/исключить в варианте,
 *     порядок, статус, короткое поле;
 *   - ДЛИННЫЙ ТЕКСТ — владелец диктует смысл, движок формулирует и показывает на
 *     подтверждение; интент эмитится только ПОСЛЕ явного approve. Схема этого не знает
 *     и знать не может — это правило диалога, не поля.
 */

import { z } from 'zod';

import { childLogger } from '../core/logger.js';

const log = childLogger('bridge.career-intent');

/** Slug записи — тот же формат, что в карьерной базе ([ADR-0028]). */
const slugId = z
	.string()
	.min(1)
	.max(48)
	.regex(/^[a-z0-9][a-z0-9_.-]*$/);

/** Код языка листового текста. */
const langKey = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/);

/** Период `YYYY-MM`: в резюме день не нужен и не хранится. */
const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/**
 * Текст, приходящий через интент, — всегда с явным языком.
 *
 * `{ lang, text }`, а не словарь: движок формулирует по одной формулировке за ход и
 * показывает её на подтверждение (D2). Словарь сразу на два языка означал бы, что
 * второй перевод никто глазами не видел.
 */
const langText = z.object({ lang: langKey, text: z.string().min(1).max(2000) });

/**
 * Название, которое может оказаться технонимом.
 *
 * `no_translate: true` — осознанное исключение для «PostgreSQL» и «HTTP/2»: одно значение
 * во всех языках ЯВНО. Это решение владельца о природе строки, а не удобство, поэтому оно
 * приходит флагом в интенте, а не выводится эвристикой по виду слова.
 */
const nameText = z
	.object({
		lang: langKey.optional(),
		text: z.string().min(1).max(200),
		no_translate: z.boolean().default(false),
	})
	.refine(
		(n) => n.no_translate || n.lang !== undefined,
		'Для переводимого названия нужен язык; без языка ставьте no_translate: true',
	);

/**
 * CareerIntentSchema — разобранный по `type` union.
 *
 * Про состав: глоссарий §1.3 перечисляет `add_position`, `remove_position`,
 * `toggle_achievement`, `reorder`, `set_status`, `set_field`, `create_variant`, `query`.
 * Реальный набор шире, и каждое расширение названо вслух, а не заведено молча:
 *   - `add_achievement` — достижение это центральная сущность [ADR-0028] (буллет резюме),
 *     без способа его завести модуль не выполняет свою задачу вообще;
 *   - `add_metric` — числа живут ТОЛЬКО в метриках, а `achievement.text` ссылается на них
 *     плейсхолдером. Пока метрику нельзя ввести, достижение с числом не рендерится вообще
 *     (fail-closed на `unknown_metric`) — то есть половина модуля недостижима;
 *   - `add_skill`/`add_education`/`add_language`/`add_project`/`add_contact` — иначе пять
 *     сущностей из десяти заводятся только ручной правкой JSONL, а бот, которому нужен
 *     редактор под собой, задачу не решает;
 *   - `remove` вместо пары `remove_<entity>` — вид записи это параметр, а не имя команды.
 *
 * Перечень в глоссарии читается как виды, а не как закрытый список.
 */
export const CareerIntentSchema = z
	.discriminatedUnion('type', [
		/** Новая позиция. Организация — непрозрачный ключ, не название работодателя. */
		z.object({
			type: z.literal('add_position'),
			id: slugId,
			org_key: slugId,
			title: langText,
			employment: z.enum(['full_time', 'contract', 'part_time', 'freelance']),
			started_at: yearMonth,
			ended_at: yearMonth.optional(),
			skill_ids: z.array(slugId).default([]),
			summary: langText.optional(),
			order: z.number().int().default(0),
		}),

		/**
		 * Шапка резюме: заголовок, «о себе», локация, формат работы и КЛЮЧИ контактов.
		 *
		 * Без этого интента профиля не существовало вовсе: `set_field entity:'profile'`
		 * умеет править только УЖЕ ЗАВЕДЁННУЮ запись, а завести её было нечем — рендер
		 * молча пропускал всю шапку вместе с контактами, а заведённый `add_contact` ключ
		 * никуда не подключался.
		 *
		 * `contact_keys` ДОПОЛНЯЕТ уже перечисленные, а не заменяет их: добавление одного
		 * контакта не должно требовать перечислить остальные заново.
		 */
		z.object({
			type: z.literal('add_profile'),
			id: slugId.default('main'),
			headline: langText,
			about: langText,
			location: z.string().min(1).max(120),
			work_setup: z.object({
				mode: z.enum(['onsite', 'hybrid', 'remote']),
				relocation_ready: z.boolean(),
			}),
			contact_keys: z.array(slugId).default([]),
		}),

		/** Новое достижение под позицией или проектом (ровно одно из двух — см. superRefine ниже). */
		z.object({
			type: z.literal('add_achievement'),
			id: slugId,
			position_id: slugId.optional(),
			project_id: slugId.optional(),
			text: langText,
			metric_keys: z.array(z.string().min(1)).default([]),
			skill_ids: z.array(slugId).default([]),
			impact: z.enum(['shipped', 'scaled', 'saved', 'led', 'fixed']).optional(),
			order: z.number().int().default(0),
		}),

		/**
		 * Удаление любой сущности с tombstone'ом — ОДИН интент на все виды.
		 * Пять почти одинаковых `remove_<entity>` разъезжаются при первой же правке одного
		 * из них; здесь вид записи это параметр, а не имя команды.
		 */
		z.object({
			type: z.literal('remove'),
			entity: z.enum(['position', 'achievement', 'skill', 'education', 'project']),
			id: slugId,
		}),

		/**
		 * Включить/исключить достижение в КОНКРЕТНОМ варианте.
		 * Правит `pins`/`excludes` варианта, а не саму запись достижения: одно достижение
		 * живёт в нескольких вариантах и в каждом решается отдельно.
		 */
		z.object({
			type: z.literal('toggle_achievement'),
			variant_id: slugId,
			achievement_id: slugId,
			include: z.boolean(),
		}),

		/** Порядок записи в резюме. */
		z.object({
			type: z.literal('reorder'),
			entity: z.enum(['position', 'achievement']),
			id: slugId,
			order: z.number().int(),
		}),

		/** Статус варианта резюме. */
		z.object({
			type: z.literal('set_status'),
			variant_id: slugId,
			status: z.enum(['draft', 'active', 'archived']),
		}),

		/**
		 * Короткое поле записи. `lang` обязателен ровно для i18n-полей — проверяет диспетчер
		 * по таблице разрешённых полей: схема не должна знать, какое поле переводится.
		 */
		z.object({
			type: z.literal('set_field'),
			entity: z.enum(['position', 'skill', 'profile', 'achievement']),
			id: slugId,
			field: z.string().min(1).max(40),
			value: z.union([z.string().max(2000), z.number(), z.boolean()]),
			lang: langKey.optional(),
		}),

		/** Новый вариант резюме под конкретную вакансию. */
		z.object({
			type: z.literal('create_variant'),
			id: slugId,
			lang: langKey,
			role_family: z.string().min(1).max(80),
			seniority: z.string().min(1).max(40).optional(),
			keywords: z.array(z.string().min(1).max(60)).default([]),
			max_pages: z.number().int().positive().default(1),
			max_bullets_per_position: z.number().int().positive().default(4),
			max_detailed_positions: z.number().int().positive().default(3),
			evidence_version: z.string().min(1).optional(),
		}),

		/**
		 * Метрика: число с единицей, датой и происхождением.
		 *
		 * `source` тут ТОЛЬКО `business` или `manual`: `evidence`-метрики приходят машинно из
		 * снапшота и руками не редактируются ([ADR-0028]) — несогласие с замером оформляется
		 * отдельной записью одного из этих двух классов, а не правкой импортированной.
		 * Для `business` обязателен `verifiable`: непроверяемое число в резюме опаснее его
		 * отсутствия, и отсекать его надо на вводе, а не на рендере.
		 */
		z.object({
			type: z.literal('add_metric'),
			key: z
				.string()
				.min(1)
				.max(64)
				.regex(/^[a-z0-9][a-z0-9_.-]*$/),
			value: z.number(),
			unit: z.string().min(1).max(16),
			as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
			source: z.enum(['business', 'manual']),
			verifiable: z.boolean().optional(),
			display: langText.optional(),
			note: z.string().max(500).optional(),
		}),

		/** Навык. Правка — повторный интент с тем же id: леджер append-only, побеждает поздний. */
		z.object({
			type: z.literal('add_skill'),
			id: slugId,
			name: nameText,
			kind: z.enum(['language', 'framework', 'tool', 'domain', 'practice', 'soft']),
			level: z.enum(['core', 'working', 'familiar']),
			first_used: yearMonth,
			last_used: yearMonth.optional(),
		}),

		/** Образование или сертификат. Учреждение — по непрозрачному ключу, не по названию. */
		z.object({
			type: z.literal('add_education'),
			id: slugId,
			institution_key: slugId,
			program: langText,
			degree: langText.optional(),
			kind: z.enum(['degree', 'course', 'certification']),
			started_at: yearMonth,
			ended_at: yearMonth.optional(),
			credential_key: slugId.optional(),
		}),

		/** Владение языком. */
		z.object({
			type: z.literal('add_language'),
			id: z.string().regex(/^[a-z]{2}$/),
			level: z.enum(['a1', 'a2', 'b1', 'b2', 'c1', 'c2', 'native']),
		}),

		/** Проект. `wiki_ref` — ссылка на страницу вики, а не копия её текста. */
		z.object({
			type: z.literal('add_project'),
			id: slugId,
			name: nameText,
			role: langText.optional(),
			summary: langText,
			started_at: yearMonth,
			ended_at: yearMonth.optional(),
			skill_ids: z.array(slugId).default([]),
			link_key: slugId.optional(),
			wiki_ref: z
				.string()
				.regex(/^wiki\/projects\/[a-z0-9-]+\.md$/)
				.optional(),
		}),

		/**
		 * КЛЮЧ контакта. Поля под значение здесь нет и быть не может (D3): реальные телефон,
		 * почта и ссылка на профиль через бота не проходят вообще — write-path маскирует их
		 * до записи (проверено: `+7 …` → `[REDACTED:phone]`). Значения живут в gitignored-
		 * справочнике и подставляются при рендере.
		 */
		z.object({
			type: z.literal('add_contact'),
			key: slugId,
			kind: z.enum(['email', 'phone', 'url', 'messenger']),
			/**
			 * Короткая подпись рядом с контактом («Почта», «Telegram») — и ТОЛЬКО она.
			 * Длину режем жёстко: это поле свободного текста в леджере контактов, и без
			 * потолка в него уедет то самое значение, которое здесь и не должно оказаться.
			 */
			label: z.object({ lang: langKey, text: z.string().min(1).max(60) }).optional(),
			render_required: z.boolean().default(true),
		}),

		/** Чтение. Ничего не пишет. */
		z.object({
			type: z.literal('query'),
			what: z.enum([
				'positions',
				'achievements',
				'variants',
				'skills',
				'metrics',
				'preview',
				// Чего не хватает в gitignored-справочнике, чтобы резюме собралось.
				// Отдаются ТОЛЬКО ключи — значения контактов в чат не попадают.
				'directory',
			]),
			variant_id: slugId.optional(),
		}),
	])
	// Правило «ЛИБО позиция, ЛИБО проект» живёт здесь, а не на самой ветке:
	// discriminatedUnion принимает только чистые объекты, а `.refine()` на ветке
	// превращает её в ZodEffects и ломает разбор по дискриминатору.
	.superRefine((intent, ctx) => {
		if (
			intent.type === 'add_achievement' &&
			(intent.position_id === undefined) === (intent.project_id === undefined)
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Достижение принадлежит ЛИБО позиции, ЛИБО проекту — ровно одному из двух',
				path: ['position_id'],
			});
		}
	});

export type CareerIntent = z.infer<typeof CareerIntentSchema>;

/**
 * CAREER_INTENT_FENCE — блок, который эмитит движок. Тег свой (`career-intent`),
 * поэтому финансовый и карьерный экстракторы физически не могут перехватить блок
 * друг друга: каждый ищет собственный тег.
 */
const CAREER_INTENT_FENCE = /```career-intent\s*\n([\s\S]*?)\n```/;

/**
 * extractCareerIntent — детерминированный парсер ответа движка.
 *
 * Нет блока / невалидный JSON / провал схемы → `null`: ответ движка проходит как
 * обычный текст. Ронять ход из-за формы блока нельзя — движок вероятностный, а мост нет.
 */
export function extractCareerIntent(engineAnswer: string): CareerIntent | null {
	const match = CAREER_INTENT_FENCE.exec(engineAnswer);
	if (!match) return null;

	const rawJson = match[1]?.trim() ?? '';
	if (!rawJson) {
		log.warn('career-intent: пустой блок JSON — игнорируем');
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch (e) {
		log.warn({ err: String(e), rawHead: rawJson.slice(0, 200) }, 'career-intent: невалидный JSON');
		return null;
	}

	const result = CareerIntentSchema.safeParse(parsed);
	if (!result.success) {
		log.warn(
			{ errors: result.error.errors.slice(0, 5), rawHead: rawJson.slice(0, 200) },
			'career-intent: zod-валидация не прошла',
		);
		return null;
	}

	log.info({ type: result.data.type }, 'career-intent: извлечён интент');
	return result.data;
}
