/**
 * career-intent-dispatch.ts — применение карьерного интента к базе ([ADR-0028]).
 *
 * Детерминированно и без LLM: интент уже разобран схемой, здесь только запись. Правка —
 * это НОВАЯ СТРОКА с тем же идентификатором и бо́льшим `ts`; удаление — строка с
 * `deleted: true`. Ничего не перезаписывается на месте, поэтому история правок резюме
 * восстановима, и «как выглядела формулировка в отправленном отклике» — отвечаемый вопрос.
 *
 * Часы инъектируются (`nowFn`), как в финансовом модуле: тесты не должны зависеть от
 * реального времени, а `ts` — единственное, что здесь недетерминировано по природе.
 */

import type { CareerBase, CareerLedger } from '../ingest/career/store.js';
import { loadCareerBase } from '../ingest/career/store.js';
import type {
	AchievementRecord,
	ContactRecord,
	EducationRecord,
	I18nText,
	MetricRecord,
	PositionRecord,
	ProfileRecord,
	ProjectRecord,
	SkillRecord,
	VariantRecord,
} from '../ingest/career/types.js';
import type { CareerIntent } from './career-intent-schema.js';
import { runCareerQuery, type CareerQueryResult } from './career-intent-query.js';

/** Зависимости диспетчера. */
export interface CareerDispatchDeps {
	ledger: CareerLedger;
	/** Источник времени. Инъекция — ради воспроизводимых тестов. */
	nowFn: () => Date;
}

/** Результат применения интента — структура, из которой собирается readback. */
export interface CareerDispatchResult {
	type: CareerIntent['type'];
	/** `false` — доменный отказ (нет записи, поле не разрешено). Не исключение. */
	ok: boolean;
	/** Детерминированное описание того, что произошло. */
	summary: string;
	/** Что записано: файл леджера и идентификатор. */
	written?: { file: string; id: string };
	/** Данные чтения — только для `query`. */
	query?: CareerQueryResult;
}

/**
 * FIELD_RULES — какие поля разрешено править интентом `set_field` и как.
 *
 * Белый список, а не «любое поле записи»: интент приходит от вероятностного движка, и
 * список разрешённого — единственное, что отделяет «поправь должность» от «поправь `ts`».
 * `i18n: true` означает, что значение — листовой текст и требует явного `lang`.
 */
const FIELD_RULES: Record<string, Record<string, { i18n: boolean }>> = {
	position: {
		title: { i18n: true },
		summary: { i18n: true },
		employment: { i18n: false },
		started_at: { i18n: false },
		ended_at: { i18n: false },
	},
	skill: {
		name: { i18n: true },
		level: { i18n: false },
		first_used: { i18n: false },
		last_used: { i18n: false },
	},
	profile: {
		headline: { i18n: true },
		about: { i18n: true },
		location: { i18n: false },
	},
	achievement: {
		text: { i18n: true },
		impact: { i18n: false },
	},
};

/** Файл леджера по имени сущности из интента. */
const ENTITY_FILE = {
	position: 'positions',
	skill: 'skills',
	profile: 'profile',
	achievement: 'achievements',
} as const;

/**
 * mergeI18n — добавляет перевод, не теряя остальные языки.
 *
 * Форма-техноним (`no_translate`) неизменяема через `set_field`: перевод технонима это
 * не правка значения, а смена решения о том, что это техноним. Такое делается заведением
 * записи заново, а не тихой конвертацией.
 */
function mergeI18n(existing: I18nText | undefined, lang: string, text: string): I18nText | null {
	if (existing && 'no_translate' in existing) return null;
	return { ...(existing ?? {}), [lang]: text };
}

/**
 * applyText — новое значение переводимого поля поверх старого.
 *
 * ДОПИСЫВАЕТ язык, а не заменяет словарь целиком: повторный `add_*` с английским текстом
 * не должен стирать введённый ранее русский. Раньше `add_*` собирал `{ [lang]: text }`
 * с нуля, и второй язык молча убивал первый — при том что `set_field` рядом мержил
 * правильно. Такое расхождение двух путей к одному полю и есть источник тихой потери.
 */
function applyText(
	existing: I18nText | undefined,
	value: { lang: string; text: string },
): I18nText {
	if (existing && !('no_translate' in existing)) return { ...existing, [value.lang]: value.text };
	return { [value.lang]: value.text };
}

/**
 * applyName — то же для названий, где владелец может объявить строку технонимом.
 * Флаг `no_translate` решает форму явно; при нём язык не нужен и не спрашивается.
 */
function applyName(
	existing: I18nText | undefined,
	value: { lang?: string; text: string; no_translate: boolean },
): I18nText {
	if (value.no_translate) return { no_translate: true, text: value.text };
	return applyText(existing, { lang: value.lang!, text: value.text });
}

/** Отказ без исключения: движок ошибся содержимым, а не формой. */
function reject(type: CareerIntent['type'], summary: string): CareerDispatchResult {
	return { type, ok: false, summary };
}

/**
 * dispatchCareerIntent — применяет интент к карьерной базе.
 *
 * Доменные отказы (нет такой записи, поле не в белом списке) возвращаются значением с
 * `ok: false` — владельцу нужен внятный ответ, а не молчание и не стектрейс. Нарушение
 * схемы записи по-прежнему бросает `LedgerValidationError`: это уже дефект, а не ввод.
 */
export function dispatchCareerIntent(
	intent: CareerIntent,
	deps: CareerDispatchDeps,
): CareerDispatchResult {
	const ts = deps.nowFn().toISOString();
	const base = loadCareerBase(deps.ledger);

	switch (intent.type) {
		case 'add_position': {
			const record: PositionRecord = {
				id: intent.id,
				org_key: intent.org_key,
				title: applyText(base.positions.find((p) => p.id === intent.id)?.title, intent.title),
				employment: intent.employment,
				started_at: intent.started_at,
				...(intent.ended_at ? { ended_at: intent.ended_at } : {}),
				skill_ids: intent.skill_ids,
				...(intent.summary
					? {
							summary: applyText(
								base.positions.find((p) => p.id === intent.id)?.summary,
								intent.summary,
							),
						}
					: {}),
				order: intent.order,
				ts,
			};
			deps.ledger.append('positions', record);
			return {
				type: intent.type,
				ok: true,
				summary: `Позиция ${intent.id} записана (${intent.started_at} — ${intent.ended_at ?? 'по настоящее время'}).`,
				written: { file: 'positions', id: intent.id },
			};
		}

		case 'add_profile': {
			const prev = base.profile && base.profile.id === intent.id ? base.profile : null;
			const record: ProfileRecord = {
				id: intent.id,
				headline: applyText(prev?.headline, intent.headline),
				about: applyText(prev?.about, intent.about),
				location: intent.location,
				work_setup: intent.work_setup,
				// Объединяем: добавление одного контакта не должно требовать перечислить
				// остальные заново, а забытый ключ означал бы контакт, пропавший из резюме.
				contact_keys: [...new Set([...(prev?.contact_keys ?? []), ...intent.contact_keys])],
				ts,
			};
			deps.ledger.append('profile', record);

			// Ключи, которых в базе нет: рендер по ним ничего не найдёт, и сказать об этом
			// надо сейчас, а не при сборке документа.
			const known = new Set(base.contacts.map((c) => c.key));
			const unknown = record.contact_keys.filter((k) => !known.has(k));
			const tail = unknown.length > 0 ? ` Контакты без записи: ${unknown.join(', ')}.` : '';

			return {
				type: intent.type,
				ok: true,
				summary: `Профиль ${intent.id} записан (${record.contact_keys.length} контакт(ов) в шапке).${tail}`,
				written: { file: 'profile', id: intent.id },
			};
		}

		case 'add_achievement': {
			const owner = intent.position_id ?? intent.project_id!;
			const ownerExists = intent.position_id
				? base.positions.some((p) => p.id === intent.position_id)
				: base.projects.some((p) => p.id === intent.project_id);
			if (!ownerExists) {
				return reject(
					intent.type,
					`Не нашёл ${intent.position_id ? 'позицию' : 'проект'} ${owner}.`,
				);
			}

			const record: AchievementRecord = {
				id: intent.id,
				...(intent.position_id ? { position_id: intent.position_id } : {}),
				...(intent.project_id ? { project_id: intent.project_id } : {}),
				text: applyText(base.achievements.find((a) => a.id === intent.id)?.text, intent.text),
				metric_keys: intent.metric_keys,
				skill_ids: intent.skill_ids,
				...(intent.impact ? { impact: intent.impact } : {}),
				order: intent.order,
				ts,
			};
			deps.ledger.append('achievements', record);
			return {
				type: intent.type,
				ok: true,
				summary: `Достижение ${intent.id} записано под ${owner}.`,
				written: { file: 'achievements', id: intent.id },
			};
		}

		case 'remove': {
			// Удаление — это ДОЗАПИСЬ tombstone'а, а не пропажа строки: история правок
			// резюме должна оставаться восстановимой, включая «а что я убрал в марте».
			const found = findRemovable(base, intent.entity, intent.id);
			if (!found) return reject(intent.type, `Не нашёл ${intent.entity} ${intent.id}.`);

			deps.ledger.append(found.file, { ...found.record, deleted: true, ts } as never);
			return {
				type: intent.type,
				ok: true,
				summary: `${intent.entity} ${intent.id} снят с резюме (запись сохранена в истории).`,
				written: { file: found.file, id: intent.id },
			};
		}

		case 'toggle_achievement': {
			const variant = base.variants.find((v) => v.id === intent.variant_id);
			if (!variant) return reject(intent.type, `Не нашёл вариант ${intent.variant_id}.`);
			if (!base.achievements.some((a) => a.id === intent.achievement_id)) {
				return reject(intent.type, `Не нашёл достижение ${intent.achievement_id}.`);
			}

			// Включение — пин, исключение — exclude; в обоих случаях чистим противоположный
			// список, иначе достижение оказалось бы одновременно закреплено и исключено.
			const pins = variant.pins.filter((id) => id !== intent.achievement_id);
			const excludes = variant.excludes.filter((id) => id !== intent.achievement_id);
			if (intent.include) pins.push(intent.achievement_id);
			else excludes.push(intent.achievement_id);

			const updated: VariantRecord = { ...variant, pins, excludes, ts };
			deps.ledger.append('variants', updated);
			return {
				type: intent.type,
				ok: true,
				summary: `${intent.achievement_id} ${intent.include ? 'закреплено в' : 'исключено из'} варианта ${intent.variant_id}.`,
				written: { file: 'variants', id: intent.variant_id },
			};
		}

		case 'reorder': {
			if (intent.entity === 'position') {
				const existing = base.positions.find((p) => p.id === intent.id);
				if (!existing) return reject(intent.type, `Не нашёл позицию ${intent.id}.`);
				deps.ledger.append('positions', { ...existing, order: intent.order, ts });
			} else {
				const existing = base.achievements.find((a) => a.id === intent.id);
				if (!existing) return reject(intent.type, `Не нашёл достижение ${intent.id}.`);
				deps.ledger.append('achievements', { ...existing, order: intent.order, ts });
			}
			return {
				type: intent.type,
				ok: true,
				summary: `Порядок ${intent.id} теперь ${intent.order}.`,
				written: {
					file: intent.entity === 'position' ? 'positions' : 'achievements',
					id: intent.id,
				},
			};
		}

		case 'set_status': {
			const variant = base.variants.find((v) => v.id === intent.variant_id);
			if (!variant) return reject(intent.type, `Не нашёл вариант ${intent.variant_id}.`);

			deps.ledger.append('variants', { ...variant, status: intent.status, ts });
			return {
				type: intent.type,
				ok: true,
				summary: `Вариант ${intent.variant_id}: статус ${intent.status}.`,
				written: { file: 'variants', id: intent.variant_id },
			};
		}

		case 'set_field': {
			const rule = FIELD_RULES[intent.entity]?.[intent.field];
			if (!rule) {
				return reject(intent.type, `Поле «${intent.field}» у ${intent.entity} править нельзя.`);
			}
			if (rule.i18n && !intent.lang) {
				return reject(intent.type, `Для поля «${intent.field}» нужен язык: это переводимый текст.`);
			}
			if (rule.i18n && typeof intent.value !== 'string') {
				return reject(intent.type, `Поле «${intent.field}» — текст, а не число.`);
			}

			const file = ENTITY_FILE[intent.entity];
			const existing = findEntity(base, intent.entity, intent.id);
			if (!existing) return reject(intent.type, `Не нашёл ${intent.entity} ${intent.id}.`);

			let value: unknown = intent.value;
			if (rule.i18n) {
				const current = (existing as unknown as Record<string, I18nText | undefined>)[intent.field];
				const merged = mergeI18n(current, intent.lang!, intent.value as string);
				if (!merged) {
					return reject(
						intent.type,
						`Поле «${intent.field}» помечено no_translate — переводы к нему не применяются.`,
					);
				}
				value = merged;
			}

			const updated = { ...existing, [intent.field]: value, ts };
			// Типы записей различаются, но append валидирует своей схемой — она и есть гарантия.
			deps.ledger.append(file, updated as never);
			return {
				type: intent.type,
				ok: true,
				summary: `${intent.entity} ${intent.id}: поле «${intent.field}» обновлено.`,
				written: { file, id: intent.id },
			};
		}

		case 'create_variant': {
			const record: VariantRecord = {
				id: intent.id,
				lang: intent.lang,
				target: {
					role_family: intent.role_family,
					...(intent.seniority ? { seniority: intent.seniority } : {}),
					keywords: intent.keywords,
				},
				pins: [],
				excludes: [],
				form: {
					max_pages: intent.max_pages,
					max_bullets_per_position: intent.max_bullets_per_position,
					max_detailed_positions: intent.max_detailed_positions,
				},
				...(intent.evidence_version ? { evidence_version: intent.evidence_version } : {}),
				status: 'draft',
				ts,
			};
			deps.ledger.append('variants', record);
			return {
				type: intent.type,
				ok: true,
				summary: `Вариант ${intent.id} создан (${intent.lang}, ${intent.role_family}).`,
				written: { file: 'variants', id: intent.id },
			};
		}

		case 'add_metric': {
			// business без verifiable схема леджера тоже отобьёт, но владельцу нужен
			// внятный ответ, а не текст zod-ошибки.
			if (intent.source === 'business' && typeof intent.verifiable !== 'boolean') {
				return reject(
					intent.type,
					`Для бизнес-метрики «${intent.key}» нужно сказать, подтверждается ли она внешне.`,
				);
			}

			const record: MetricRecord = {
				key: intent.key,
				value: intent.value,
				unit: intent.unit,
				as_of: intent.as_of,
				source: intent.source,
				...(intent.verifiable !== undefined ? { verifiable: intent.verifiable } : {}),
				...(intent.display ? { display: { [intent.display.lang]: intent.display.text } } : {}),
				...(intent.note ? { note: intent.note } : {}),
				ts,
			};

			// Занятый evidence-ключ руками не переписываем: импортированный замер правится
			// пересбором снапшота, а не диалогом ([ADR-0028]).
			const prev = base.metrics.get(intent.key);
			if (prev?.source === 'evidence') {
				return reject(
					intent.type,
					`Ключ «${intent.key}» занят машинным замером — заведите свой ключ, а не переписывайте evidence.`,
				);
			}

			deps.ledger.append('metrics', record);
			return {
				type: intent.type,
				ok: true,
				summary: `Метрика ${intent.key} = ${intent.value} ${intent.unit} (на ${intent.as_of}).`,
				written: { file: 'metrics', id: intent.key },
			};
		}

		case 'add_skill': {
			const record: SkillRecord = {
				id: intent.id,
				name: applyName(base.skills.find((s) => s.id === intent.id)?.name, intent.name),
				kind: intent.kind,
				level: intent.level,
				first_used: intent.first_used,
				...(intent.last_used ? { last_used: intent.last_used } : {}),
				ts,
			};
			deps.ledger.append('skills', record);
			return {
				type: intent.type,
				ok: true,
				summary: `Навык ${intent.id} записан (${intent.kind}, ${intent.level}).`,
				written: { file: 'skills', id: intent.id },
			};
		}

		case 'add_education': {
			const record: EducationRecord = {
				id: intent.id,
				institution_key: intent.institution_key,
				program: applyText(base.education.find((e) => e.id === intent.id)?.program, intent.program),
				...(intent.degree
					? {
							degree: applyText(
								base.education.find((e) => e.id === intent.id)?.degree,
								intent.degree,
							),
						}
					: {}),
				kind: intent.kind,
				started_at: intent.started_at,
				...(intent.ended_at ? { ended_at: intent.ended_at } : {}),
				...(intent.credential_key ? { credential_key: intent.credential_key } : {}),
				ts,
			};
			deps.ledger.append('education', record);
			return {
				type: intent.type,
				ok: true,
				summary: `Образование ${intent.id} записано (${intent.kind}).`,
				written: { file: 'education', id: intent.id },
			};
		}

		case 'add_language': {
			deps.ledger.append('languages', { id: intent.id, level: intent.level, ts });
			return {
				type: intent.type,
				ok: true,
				summary: `Язык ${intent.id.toUpperCase()} — ${intent.level.toUpperCase()}.`,
				written: { file: 'languages', id: intent.id },
			};
		}

		case 'add_project': {
			const record: ProjectRecord = {
				id: intent.id,
				name: applyName(base.projects.find((p) => p.id === intent.id)?.name, intent.name),
				...(intent.role
					? { role: applyText(base.projects.find((p) => p.id === intent.id)?.role, intent.role) }
					: {}),
				summary: applyText(base.projects.find((p) => p.id === intent.id)?.summary, intent.summary),
				started_at: intent.started_at,
				...(intent.ended_at ? { ended_at: intent.ended_at } : {}),
				skill_ids: intent.skill_ids,
				...(intent.link_key ? { link_key: intent.link_key } : {}),
				...(intent.wiki_ref ? { wiki_ref: intent.wiki_ref } : {}),
				ts,
			};
			deps.ledger.append('projects', record);
			return {
				type: intent.type,
				ok: true,
				summary: `Проект ${intent.id} записан.`,
				written: { file: 'projects', id: intent.id },
			};
		}

		case 'add_contact': {
			// Значения контакта здесь нет и не будет: в леджер уходит ТОЛЬКО ключ (D3).
			const record: ContactRecord = {
				key: intent.key,
				kind: intent.kind,
				...(intent.label
					? {
							label: applyText(
								base.contacts.find((c) => c.key === intent.key)?.label,
								intent.label,
							),
						}
					: {}),
				render_required: intent.render_required,
				ts,
			};
			deps.ledger.append('contacts', record);
			return {
				type: intent.type,
				ok: true,
				summary: `Ключ контакта ${intent.key} заведён. Значение впишите в справочник рендера — через бота оно не проходит.`,
				written: { file: 'contacts', id: intent.key },
			};
		}

		case 'query': {
			const query = runCareerQuery(intent, base);
			return { type: intent.type, ok: true, summary: query.summary, query };
		}
	}
}

/** Куда писать tombstone для каждого удаляемого вида. */
const REMOVABLE_FILE = {
	position: 'positions',
	achievement: 'achievements',
	skill: 'skills',
	education: 'education',
	project: 'projects',
} as const;

/** findRemovable — файл леджера и текущая запись для удаляемой сущности. */
function findRemovable(
	base: CareerBase,
	entity: keyof typeof REMOVABLE_FILE,
	id: string,
): { file: (typeof REMOVABLE_FILE)[keyof typeof REMOVABLE_FILE]; record: { ts: string } } | null {
	const file = REMOVABLE_FILE[entity];
	const record = (base[file] as { id: string; ts: string }[]).find((r) => r.id === id);
	return record ? { file, record } : null;
}

/** findEntity — запись по сущности и идентификатору; профиль ищется как единственный. */
function findEntity(
	base: CareerBase,
	entity: 'position' | 'skill' | 'profile' | 'achievement',
	id: string,
): PositionRecord | SkillRecord | ProfileRecord | AchievementRecord | undefined {
	if (entity === 'position') return base.positions.find((p) => p.id === id);
	if (entity === 'skill') return base.skills.find((s) => s.id === id);
	if (entity === 'achievement') return base.achievements.find((a) => a.id === id);
	return base.profile && base.profile.id === id ? base.profile : undefined;
}

/**
 * formatCareerReadback — детерминированный текст подтверждения. LLM здесь не участвует:
 * подтверждение обязано описывать то, что реально записано, а не то, что модель поняла.
 */
export function formatCareerReadback(result: CareerDispatchResult): string {
	if (!result.ok) return `Не применил: ${result.summary}`;
	if (result.query) return result.query.text;
	return result.summary;
}
