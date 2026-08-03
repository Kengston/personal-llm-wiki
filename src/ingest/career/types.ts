/**
 * types.ts — zod-схемы и выведенные типы карьерной базы ([ADR-0028]).
 *
 * Контекст: данные живут в приватном репо `llm-wiki-content/raw/career/*.jsonl`,
 * здесь — только структура и правила. Ни одного реального имени, домена, числа
 * или контакта в этом файле быть не должно (`pnpm lint:public`, [ADR-0003]).
 *
 * Три вещи, которые отличают карьерную базу от финансовой и заданы [ADR-0028]:
 *
 *   1. ПРАВКА = НОВАЯ СТРОКА. Леджер append-only: изменение записи — новая строка
 *      с тем же `id` и большим `ts` (last-wins у читателя), удаление — строка с
 *      `deleted: true` (tombstone). Свод делает `loadCareerBase()` в store.ts.
 *
 *   2. ЧИСЛА НЕ ПИШУТСЯ В ТЕКСТ. `achievement.text` содержит плейсхолдеры
 *      `{{metric.key}}`; значение живёт ровно в одной записи `metric` — с датой
 *      (`as_of`) и происхождением (`source`). Иначе одно число копируется в
 *      резюме EN, резюме RU, capability-profile и на страницу проекта и расходится
 *      при первой же пересборке.
 *
 *   3. ФАКТ ЯЗЫКОНЕЗАВИСИМ. Даты, `metric.value`, `skill.kind`, связи — одни на все
 *      языки; переводится ТОЛЬКО листовое текстовое поле (`i18nText`). Отсутствующий
 *      перевод — ошибка валидатора при рендере, а не молчаливый фолбэк на другой язык.
 *
 * Контакты: в схеме только КЛЮЧИ (`contact.key`). Значения (почта, телефон, ссылка
 * на профиль) не хранятся нигде в репозитории и подставляются при рендере из
 * gitignored-источника — см. `ContactRecordSchema` ниже и D3 глоссария.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Базовые типы
// ---------------------------------------------------------------------------

/**
 * isoTimestamp — ISO-8601 момент записи как строка (не Date): леджер append-only
 * JSONL, и строка читается одинаково любым потребителем. Как в финансовом модуле.
 */
const isoTimestamp = z.string().min(1).describe('ISO-8601 timestamp, напр. "2026-08-02T10:00:00Z"');

/**
 * yearMonth — месячная точность периодов (`YYYY-MM`).
 * День в резюме не нужен и не хранится ([ADR-0028], общие конвенции сущностей).
 */
const yearMonth = z
	.string()
	.regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Ожидается YYYY-MM (месячная точность)')
	.describe('Период с месячной точностью, напр. "2024-02"');

/**
 * isoDate — календарная дата (`YYYY-MM-DD`) для `metric.as_of`: у числа дата точная,
 * в отличие от периода работы.
 */
const isoDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Ожидается YYYY-MM-DD')
	.describe('Календарная дата, напр. "2026-08-02"');

/**
 * slugId — человекочитаемый стабильный идентификатор записи.
 *
 * Длина ограничена: id ездит в компактном `callback_data` кнопок Telegram, где
 * потолок 64 байта на всю строку вместе с префиксом действия ([ADR-0026]).
 * Поэтому 48 символов — не косметика, а граница транспорта.
 */
const slugId = z
	.string()
	.min(1)
	.max(48)
	.regex(/^[a-z0-9][a-z0-9_.-]*$/, 'Ожидается slug: [a-z0-9] и [_.-], начиная с буквы или цифры');

/**
 * langKey — ключ языка в `i18nText`: `en`, `ru`, `pt-BR`.
 *
 * Регулярка заодно решает вопрос неоднозначности: `no_translate` под неё не
 * подходит, поэтому форма-словарь и форма-техноним не могут быть перепутаны.
 */
const langKey = z
	.string()
	.regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Ожидается код языка: "en", "ru", "pt-BR"');

/**
 * i18nText — листовое текстовое поле в двух допустимых формах:
 *
 *   1. Словарь `{ en: "…", ru: "…" }` — свободный ключ языка. Новый язык не требует
 *      правки схемы (тот же приём, что `currency` в [ADR-0018]).
 *   2. `{ no_translate: true, text: "…" }` — осознанное исключение для технонимов
 *      («PostgreSQL», «HTTP/2»): одно значение используется во всех языках ЯВНО.
 *
 * Молчаливого фолбэка на другой язык нет ни в одной из форм: отсутствующий перевод
 * ловит валидатор рендера (`missing_translation`), потому что русский буллет посреди
 * английского резюме — худший дефект документа из возможных, и производит его именно
 * тихий фолбэк.
 */
export const I18nTextSchema = z.union([
	z.object({ no_translate: z.literal(true), text: z.string().min(1) }).strict(),
	z
		.record(langKey, z.string().min(1))
		.refine((v) => Object.keys(v).length > 0, 'Нужен хотя бы один язык'),
]);

export type I18nText = z.infer<typeof I18nTextSchema>;

// ---------------------------------------------------------------------------
// 1. ProfileRecord — шапка резюме
// ---------------------------------------------------------------------------

/**
 * ProfileRecord — то, что стоит над списком позиций: заголовок, «о себе», локация,
 * формат работы и КЛЮЧИ контактов.
 *
 * `location` — город/страна, а не адрес: адрес не нужен ни одному рекрутеру и
 * является PII, который незачем хранить.
 */
export const ProfileRecordSchema = z.object({
	/** Стабильный slug (профиль обычно один, но правка = новая строка с тем же id). */
	id: slugId,

	/** Заголовок резюме («Senior Backend Engineer»), i18n. */
	headline: I18nTextSchema,

	/** Длинный текст «о себе». Владелец диктует смысл, движок формулирует (D2). */
	about: I18nTextSchema,

	/** Город/страна. Не адрес. */
	location: z.string().min(1).max(120),

	/** Формат работы и готовность к релокации. */
	work_setup: z.object({
		mode: z.enum(['onsite', 'hybrid', 'remote']),
		relocation_ready: z.boolean(),
	}),

	/** Ключи контактов (`contact.key`), которые надо отрендерить. Значений здесь нет. */
	contact_keys: z.array(slugId).default([]),

	/** Момент записи строки. */
	ts: isoTimestamp,
});

export type ProfileRecord = z.infer<typeof ProfileRecordSchema>;

// ---------------------------------------------------------------------------
// 2. PositionRecord — место работы
// ---------------------------------------------------------------------------

/**
 * PositionRecord — одна запись опыта.
 *
 * `org_key` — НЕПРОЗРАЧНЫЙ ключ организации; отображаемое название живёт в приватном
 * справочнике и в публичную схему не попадает. Поля `company` здесь нет намеренно:
 * имя `company` приглашает положить в ключ название работодателя, то есть ровно то,
 * что схема из публичного слоя выносит (глоссарий §1.1).
 *
 * Фиктивных мест работы схема не поддерживает: полей под «компании-доноры» нет и не
 * будет (D8) — приём остаётся описанием чужого метода в `knowledge/`, без инструментальной
 * поддержки.
 */
export const PositionRecordSchema = z.object({
	id: slugId,

	/** Непрозрачный ключ организации. Не название работодателя. */
	org_key: slugId,

	/** Должность, i18n. Описывает ПРОШЛОЕ (в отличие от `variant.target`). */
	title: I18nTextSchema,

	employment: z.enum(['full_time', 'contract', 'part_time', 'freelance']),

	started_at: yearMonth,

	/** Пусто = по настоящее время. */
	ended_at: yearMonth.optional(),

	/** Ссылки на `skill.id`. */
	skill_ids: z.array(slugId).default([]),

	/** Одна-две фразы о роли, i18n. */
	summary: I18nTextSchema.optional(),

	/** Порядок в резюме (меньше — выше). */
	order: z.number().int(),

	ts: isoTimestamp,

	/** Tombstone: удаление — это новая строка, а не пропажа старой. */
	deleted: z.boolean().optional(),
});

export type PositionRecord = z.infer<typeof PositionRecordSchema>;

// ---------------------------------------------------------------------------
// 3. AchievementRecord — буллет резюме
// ---------------------------------------------------------------------------

/**
 * AchievementRecord — «действие → результат», по возможности с метрикой.
 *
 * Принадлежит ЛИБО позиции, ЛИБО проекту — ровно одному из двух. Это не вкусовщина:
 * буллет висит под конкретным блоком резюме, и запись, привязанная сразу к обоим,
 * не имеет однозначного места на странице.
 *
 * `text` содержит плейсхолдеры `{{metric.key}}`; `metric_keys[]` — денормализация
 * текста для валидатора и скоринга (искать плейсхолдеры регуляркой в каждом проходе
 * скоринга — это парсинг там, где достаточно поля).
 */
export const AchievementRecordSchema = z
	.object({
		id: slugId,

		/** Ссылка на `position.id`. Взаимоисключима с `project_id`. */
		position_id: slugId.optional(),

		/** Ссылка на `project.id`. Взаимоисключима с `position_id`. */
		project_id: slugId.optional(),

		/** Текст буллета с плейсхолдерами `{{metric.key}}`, i18n. */
		text: I18nTextSchema,

		/** Ключи метрик, использованных в тексте. */
		metric_keys: z.array(z.string().min(1)).default([]),

		skill_ids: z.array(slugId).default([]),

		/** Грубая рубрика эффекта — вход скоринга, не украшение. */
		impact: z.enum(['shipped', 'scaled', 'saved', 'led', 'fixed']).optional(),

		order: z.number().int(),

		ts: isoTimestamp,

		deleted: z.boolean().optional(),
	})
	.refine(
		(a) => (a.position_id === undefined) !== (a.project_id === undefined),
		'Достижение принадлежит ЛИБО позиции, ЛИБО проекту — ровно одному из двух',
	);

export type AchievementRecord = z.infer<typeof AchievementRecordSchema>;

// ---------------------------------------------------------------------------
// 4. MetricRecord — число с источником и датой
// ---------------------------------------------------------------------------

/**
 * MetricRecord — единственное место, где живёт число.
 *
 * `source` — три класса происхождения, и они не равноправны:
 *   - `evidence` — импортировано машинно из снапшота `scripts/career-evidence.sh`;
 *     руками не редактируется (несогласие оформляется отдельной записью класса
 *     `business`/`manual`), обязателен `evidence_ref` на снапшот;
 *   - `business` — бизнес-эффект, вводится руками; обязателен `verifiable` —
 *     можно ли подтвердить внешне (дашборд, релиз-нот, письмо). Непроверяемое
 *     число в резюме опаснее его отсутствия;
 *   - `manual` — всё остальное (оценки, приблизительные); в дефолтный набор варианта
 *     не попадает без явного пина.
 *
 * `unit` — свободная строка (`pct`, `count`, `ms`, `x`, `months`, валюта). Захардкоженного
 * перечня нет по той же причине, что у `currency` в [ADR-0018]: новая единица не должна
 * требовать правки схемы.
 */
export const MetricRecordSchema = z
	.object({
		/** Стабильный ключ, он же в плейсхолдере `{{metric.key}}`. */
		key: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[a-z0-9][a-z0-9_.-]*$/, 'Ожидается ключ из [a-z0-9] и [_.-]'),

		value: z.number(),

		/** Единица измерения, свободная строка. */
		unit: z.string().min(1).max(16),

		/** Когда показывать надо формулировкой, а не сырым числом. */
		display: I18nTextSchema.optional(),

		/** Дата, к которой число относится. */
		as_of: isoDate,

		source: z.enum(['evidence', 'business', 'manual']),

		/** Пин к снапшоту замера. Только для `source: evidence`. */
		evidence_ref: z
			.object({
				snapshot_id: z.string().min(1),
				/** Относительный путь к файлу снапшота внутри приватного репо. */
				path: z.string().min(1),
			})
			.optional(),

		/** Подтверждаемо ли число внешне. Обязательно при `source: business`. */
		verifiable: z.boolean().optional(),

		note: z.string().max(500).optional(),

		ts: isoTimestamp,
	})
	.refine(
		(m) => m.source !== 'business' || typeof m.verifiable === 'boolean',
		'Для business-метрики обязателен verifiable: непроверяемое число в резюме опаснее его отсутствия',
	)
	.refine(
		(m) => (m.source === 'evidence') === (m.evidence_ref !== undefined),
		'evidence_ref обязателен ровно для source: evidence и запрещён для остальных',
	);

export type MetricRecord = z.infer<typeof MetricRecordSchema>;

// ---------------------------------------------------------------------------
// 5. SkillRecord — навык
// ---------------------------------------------------------------------------

/**
 * SkillRecord — навык с периодом использования.
 *
 * «Лет опыта» — ВЫЧИСЛЯЕМОЕ (из `first_used`/`last_used` и позиций), отдельным полем
 * не хранится: это ровно тот дрейф, от которого уходит весь модуль. Хранимое «5 лет»
 * протухает через год, вычисленное — нет.
 */
export const SkillRecordSchema = z.object({
	id: slugId,

	/** Название навыка. Для технонимов — форма `{ no_translate: true, text: … }`. */
	name: I18nTextSchema,

	kind: z.enum(['language', 'framework', 'tool', 'domain', 'practice', 'soft']),

	level: z.enum(['core', 'working', 'familiar']),

	first_used: yearMonth,

	/** Пусто = используется сейчас. Вход скоринга «свежесть». */
	last_used: yearMonth.optional(),

	ts: isoTimestamp,

	deleted: z.boolean().optional(),
});

export type SkillRecord = z.infer<typeof SkillRecordSchema>;

// ---------------------------------------------------------------------------
// 6. EducationRecord — образование и сертификаты
// ---------------------------------------------------------------------------

/**
 * EducationRecord — учебное заведение, программа, тип.
 *
 * `institution_key` и `credential_key` — КЛЮЧИ, не названия и не URL: ссылка на
 * верификацию сертификата идентифицирует владельца ровно так же, как контакт,
 * поэтому подчиняется тому же правилу подстановки при рендере (D3).
 */
export const EducationRecordSchema = z.object({
	id: slugId,

	/** Непрозрачный ключ учебного заведения. */
	institution_key: slugId,

	program: I18nTextSchema,

	degree: I18nTextSchema.optional(),

	kind: z.enum(['degree', 'course', 'certification']),

	started_at: yearMonth,

	ended_at: yearMonth.optional(),

	/** Ключ ссылки на верификацию (`contact.key`-подобный), не URL. */
	credential_key: slugId.optional(),

	ts: isoTimestamp,

	deleted: z.boolean().optional(),
});

export type EducationRecord = z.infer<typeof EducationRecordSchema>;

// ---------------------------------------------------------------------------
// 7. LanguageRecord — владение языком
// ---------------------------------------------------------------------------

/**
 * LanguageRecord — язык и уровень. `id` — код ISO-639-1 (`en`, `ru`, `de`).
 */
export const LanguageRecordSchema = z.object({
	/** Код ISO-639-1. */
	id: z.string().regex(/^[a-z]{2}$/, 'Ожидается код ISO-639-1: "en", "ru"'),

	/** Уровень CEFR или `native`. */
	level: z.enum(['a1', 'a2', 'b1', 'b2', 'c1', 'c2', 'native']),

	ts: isoTimestamp,
});

export type LanguageRecord = z.infer<typeof LanguageRecordSchema>;

// ---------------------------------------------------------------------------
// 8. ProjectRecord — проект
// ---------------------------------------------------------------------------

/**
 * ProjectRecord — проект, к которому могут крепиться достижения.
 *
 * `wiki_ref` — ЕДИНСТВЕННАЯ связь машинного слоя с прозой `wiki/projects/<slug>.md`:
 * ссылка, не копия. Дублировать текст страницы сюда запрещено — это ломает контент-модель
 * [ADR-0010] и порождает вторую расходящуюся версию одного факта.
 */
export const ProjectRecordSchema = z.object({
	id: slugId,

	name: I18nTextSchema,

	role: I18nTextSchema.optional(),

	summary: I18nTextSchema,

	started_at: yearMonth,

	ended_at: yearMonth.optional(),

	skill_ids: z.array(slugId).default([]),

	/** Ключ внешней ссылки (репозиторий, демо), не URL. */
	link_key: slugId.optional(),

	/** Относительный путь на страницу вики: `wiki/projects/<slug>.md`. */
	wiki_ref: z
		.string()
		.min(1)
		.regex(
			/^wiki\/projects\/[a-z0-9-]+\.md$/,
			'Ожидается относительный путь wiki/projects/<slug>.md',
		)
		.optional(),

	ts: isoTimestamp,

	deleted: z.boolean().optional(),
});

export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

// ---------------------------------------------------------------------------
// 9. VariantRecord — вариант резюме
// ---------------------------------------------------------------------------

/**
 * VariantRecord — именованная версия резюме: язык, позиционирование, пины и
 * исключения, ограничения формы, пин к версии evidence.
 *
 * Данные не копирует — ссылается на записи карьерной базы. Статуса отклика здесь НЕТ:
 * воронка ссылается на вариант своим полем `application.variant_id` ([ADR-0030]), и
 * второй словарь состояний в этой схеме не заводится.
 *
 * `form` — ограничения РЕНДЕРА, а не данных: леджер хранит всё, режет рендер и обязан
 * вернуть список выброшенного с причиной.
 */
export const VariantRecordSchema = z.object({
	id: slugId,

	/** Язык варианта — ключ в `i18nText` листовых полей. */
	lang: langKey,

	/** Позиционирование: под какую роль и рынок собирается вариант. */
	target: z.object({
		role_family: z.string().min(1).max(80),
		seniority: z.string().min(1).max(40).optional(),
		/** Ключевые слова из текста вакансии — детерминированным парсером, не движком. */
		keywords: z.array(z.string().min(1).max(60)).default([]),
	}),

	/** Принудительно включить (`achievement.id` / `position.id` / `project.id`). */
	pins: z.array(slugId).default([]),

	/** Принудительно исключить. Жёсткий оверрайд поверх скоринга. */
	excludes: z.array(slugId).default([]),

	form: z.object({
		max_pages: z.number().int().positive(),
		max_bullets_per_position: z.number().int().positive(),
		max_detailed_positions: z.number().int().positive(),
	}),

	/** Пин к `snapshot_id` замера evidence, из которого взяты метрики. */
	evidence_version: z.string().min(1).optional(),

	status: z.enum(['draft', 'active', 'archived']),

	ts: isoTimestamp,
});

export type VariantRecord = z.infer<typeof VariantRecordSchema>;

// ---------------------------------------------------------------------------
// 10. ContactRecord — КЛЮЧ контакта (без значения)
// ---------------------------------------------------------------------------

/**
 * ContactRecord — плейсхолдер на месте телефона/почты/ссылки на профиль.
 *
 * ЗНАЧЕНИЯ НЕТ НИ В ОДНОМ ПОЛЕ СХЕМЫ (D3). Реальные значения живут в gitignored-файле
 * (`contacts.local.json`/env) и попадают только в отрендеренный документ, который лежит
 * вне обоих репозиториев.
 *
 * Причина не в аккуратности, а в механике: write-path проходит `failClosedSanitize`,
 * который маскирует PII И ПОРТИТ СОСЕДНИЕ ДАННЫЕ молча (проверено: ИНН → `[REDACTED:phone]`,
 * числовой id вакансии в URL → `[REDACTED:phone]`). Санитайзер не ослабляем — убираем
 * повод его срабатывания.
 *
 * Схема `.strict()` намеренно: попытка дописать поле со значением должна ПАДАТЬ громко.
 * Дефолтный zod-strip тихо выбросил бы лишнее поле, и вызывающий считал бы, что записал
 * контакт — а записал бы ключ без значения.
 */
export const ContactRecordSchema = z
	.object({
		/** Ключ вида `email_primary`, `profile_public`. */
		key: slugId,

		kind: z.enum(['email', 'phone', 'url', 'messenger']),

		/** Подпись рядом с контактом в документе, i18n. */
		label: I18nTextSchema.optional(),

		/** Обязателен ли контакт в отрендеренном документе. */
		render_required: z.boolean(),

		ts: isoTimestamp,
	})
	.strict();

export type ContactRecord = z.infer<typeof ContactRecordSchema>;

// ---------------------------------------------------------------------------
// Карта файлов леджера
// ---------------------------------------------------------------------------

/** Имена файлов карьерного леджера — по файлу на сущность ([ADR-0028]). */
export const CAREER_LEDGER_FILES = {
	profile: 'profile.jsonl',
	positions: 'positions.jsonl',
	achievements: 'achievements.jsonl',
	metrics: 'metrics.jsonl',
	skills: 'skills.jsonl',
	education: 'education.jsonl',
	languages: 'languages.jsonl',
	projects: 'projects.jsonl',
	variants: 'variants.jsonl',
	contacts: 'contacts.jsonl',
} as const;

/** Ключ файла карьерного леджера. */
export type CareerFileKey = keyof typeof CAREER_LEDGER_FILES;

/** Карта «ключ файла → тип записи» — задаёт сигнатуры append/readAll. */
export type CareerRecordMap = {
	profile: ProfileRecord;
	positions: PositionRecord;
	achievements: AchievementRecord;
	metrics: MetricRecord;
	skills: SkillRecord;
	education: EducationRecord;
	languages: LanguageRecord;
	projects: ProjectRecord;
	variants: VariantRecord;
	contacts: ContactRecord;
};
