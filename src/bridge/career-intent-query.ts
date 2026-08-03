/**
 * career-intent-query.ts — чтение карьерной базы для ответа владельцу ([ADR-0028]).
 *
 * Ничего не пишет. Собирает два продукта: детерминированный текст и инлайн-клавиатуру
 * для структурных правок (D1) — редактирование идёт кнопками, а не разбором свободной речи.
 *
 * Предпросмотр варианта СПЕЦИАЛЬНО собирается с подставными значениями справочника:
 * реальные контакты и названия организаций живут вне репозитория и появляются только в
 * отрендеренном документе (D3). В чат уходит структура — что войдёт, что выпало и почему, —
 * и именно она владельцу и нужна при отборе.
 */

import {
	describeDirectoryNeeds,
	formatRenderReport,
	renderResume,
	type RenderDirectory,
} from '../ingest/career/render.js';
import type { CareerBase } from '../ingest/career/store.js';
import type { AchievementRecord } from '../ingest/career/types.js';
import type { CareerIntent } from './career-intent-schema.js';
import type { InlineKeyboardButton, ReplyMarkup } from './telegram.js';

/** Результат чтения: текст ответа плюс, если уместно, кнопки правки. */
export interface CareerQueryResult {
	what: string;
	/** Короткая строка для лога и readback'а. */
	summary: string;
	/** Полный текст сообщения владельцу. */
	text: string;
	/** Инлайн-клавиатура структурных правок (D1). */
	keyboard?: ReplyMarkup;
}

/** Префикс callback_data карьерных кнопок. Отдельный от финансового (`fin:`). */
export const CAREER_CALLBACK_PREFIX = 'res:';

/** Потолок Telegram на `callback_data` — 64 байта на всю строку ([ADR-0026]). */
const CALLBACK_DATA_LIMIT = 64;

/**
 * careerCallbackData — компактный payload кнопки или `null`, если не влезает.
 *
 * Не влезть реально: два slug'а по 48 символов вместе с действием дают больше 64 байт.
 * Вместо молчаливого обрезания (которое превратило бы кнопку в чужую команду) возвращаем
 * `null`, а вызывающий честно говорит, что кнопки для этой записи нет.
 */
export function careerCallbackData(action: string, ...parts: string[]): string | null {
	const data = `${CAREER_CALLBACK_PREFIX}${[action, ...parts].join(':')}`;
	return Buffer.byteLength(data, 'utf8') <= CALLBACK_DATA_LIMIT ? data : null;
}

/** Любой текст записи одной строкой — для списка, без выбора языка. */
function anyText(value: { [k: string]: string } | { no_translate: true; text: string }): string {
	if ('no_translate' in value) return value.text;
	return Object.values(value)[0] ?? '';
}

/**
 * previewDirectory — подставной справочник для предпросмотра.
 *
 * Имена берём из самих ключей: `org_key` показывается как есть, контакт — как
 * `{{contact.key}}`. Реальные значения в чат не попадают (D3), а структура документа
 * видна полностью.
 */
function previewDirectory(base: CareerBase): RenderDirectory {
	return {
		display_name: '{{display_name}}',
		contacts: Object.fromEntries(base.contacts.map((c) => [c.key, `{{contact.${c.key}}}`])),
		orgs: Object.fromEntries(base.positions.map((p) => [p.org_key, p.org_key])),
		institutions: Object.fromEntries(
			base.education.map((e) => [e.institution_key, e.institution_key]),
		),
		links: {},
	};
}

/**
 * achievementKeyboard — кнопки «в вариант / из варианта» по достижениям.
 *
 * Состояние кнопки читается из самого варианта: закреплённое предлагаем исключить,
 * остальное — закрепить. Так нажатие всегда меняет состояние, а не подтверждает текущее.
 */
function achievementKeyboard(
	variantId: string,
	achievements: AchievementRecord[],
	pins: Set<string>,
): { keyboard: ReplyMarkup | undefined; skipped: string[] } {
	const rows: InlineKeyboardButton[][] = [];
	const skipped: string[] = [];

	for (const achievement of achievements) {
		const included = pins.has(achievement.id);
		const data = careerCallbackData(included ? 'exc' : 'inc', variantId, achievement.id);
		if (!data) {
			skipped.push(achievement.id);
			continue;
		}
		rows.push([
			{
				text: `${included ? '−' : '+'} ${achievement.id}`,
				callback_data: data,
			},
		]);
	}

	return { keyboard: rows.length > 0 ? { inline_keyboard: rows } : undefined, skipped };
}

/**
 * runCareerQuery — собирает ответ на интент чтения.
 *
 * Пустая база — валидный ответ («записей нет»), а не пустое сообщение: молчащий бот
 * неотличим от сломанного.
 */
export function runCareerQuery(
	intent: Extract<CareerIntent, { type: 'query' }>,
	base: CareerBase,
): CareerQueryResult {
	switch (intent.what) {
		case 'positions': {
			if (base.positions.length === 0) {
				return {
					what: intent.what,
					summary: 'позиций нет',
					text: 'В карьерной базе пока нет позиций.',
				};
			}
			const lines = base.positions.map(
				(p) =>
					`${p.order}. ${p.id} — ${anyText(p.title)} (${p.org_key}, ${p.started_at} — ${p.ended_at ?? 'сейчас'})`,
			);
			return {
				what: intent.what,
				summary: `позиций: ${base.positions.length}`,
				text: `Позиции (${base.positions.length}):\n${lines.join('\n')}`,
			};
		}

		case 'achievements': {
			if (base.achievements.length === 0) {
				return { what: intent.what, summary: 'достижений нет', text: 'Достижений пока нет.' };
			}
			const lines = base.achievements.map(
				(a) => `${a.order}. ${a.id} [${a.position_id ?? a.project_id}] — ${anyText(a.text)}`,
			);

			// Кнопки правки имеют смысл только в контексте конкретного варианта.
			const variant = intent.variant_id
				? base.variants.find((v) => v.id === intent.variant_id)
				: undefined;
			if (!variant) {
				return {
					what: intent.what,
					summary: `достижений: ${base.achievements.length}`,
					text: `Достижения (${base.achievements.length}):\n${lines.join('\n')}`,
				};
			}

			const { keyboard, skipped } = achievementKeyboard(
				variant.id,
				base.achievements,
				new Set(variant.pins),
			);
			const note =
				skipped.length > 0
					? `\n\nБез кнопок (идентификаторы длиннее лимита callback_data): ${skipped.join(', ')}`
					: '';
			return {
				what: intent.what,
				summary: `достижений: ${base.achievements.length}`,
				text: `Достижения в варианте ${variant.id} (${base.achievements.length}):\n${lines.join('\n')}${note}`,
				keyboard,
			};
		}

		case 'variants': {
			if (base.variants.length === 0) {
				return { what: intent.what, summary: 'вариантов нет', text: 'Вариантов резюме пока нет.' };
			}
			const lines = base.variants.map(
				(v) => `${v.id} — ${v.lang}, ${v.target.role_family} [${v.status}]`,
			);
			return {
				what: intent.what,
				summary: `вариантов: ${base.variants.length}`,
				text: `Варианты (${base.variants.length}):\n${lines.join('\n')}`,
			};
		}

		case 'skills': {
			if (base.skills.length === 0) {
				return { what: intent.what, summary: 'навыков нет', text: 'Навыков пока нет.' };
			}
			const lines = base.skills.map((s) => `${anyText(s.name)} — ${s.kind}, ${s.level}`);
			return {
				what: intent.what,
				summary: `навыков: ${base.skills.length}`,
				text: `Навыки (${base.skills.length}):\n${lines.join('\n')}`,
			};
		}

		case 'metrics': {
			if (base.metrics.size === 0) {
				return { what: intent.what, summary: 'метрик нет', text: 'Метрик пока нет.' };
			}
			const lines = [...base.metrics.values()].map(
				(m) => `${m.key} = ${m.value} ${m.unit} (${m.source}, на ${m.as_of})`,
			);
			return {
				what: intent.what,
				summary: `метрик: ${base.metrics.size}`,
				text: `Метрики (${base.metrics.size}):\n${lines.sort().join('\n')}`,
			};
		}

		case 'directory': {
			// Чеклист gitignored-справочника: КЛЮЧИ, которые владелец обязан закрыть руками.
			// Значения через бота не проходят вообще — write-path маскирует телефон и почту
			// до записи, поэтому единственный путь это файл (D3).
			const needs = describeDirectoryNeeds(base);
			const section = (title: string, keys: string[], mark: (k: string) => string = (k) => k) =>
				keys.length > 0 ? `${title}:\n${keys.map((k) => `  ${mark(k)}`).join('\n')}` : '';

			const blocks = [
				'display_name (имя в шапке документа)',
				section('contacts', needs.contacts, (k) =>
					needs.requiredContacts.includes(k) ? `${k} — обязателен` : k,
				),
				section('orgs', needs.orgs),
				section('institutions', needs.institutions),
				section('links', needs.links),
			].filter(Boolean);

			// Заведён, но не подключён к профилю → в резюме его не будет, сколько ни заполняй.
			const orphans =
				needs.orphanContacts.length > 0
					? `\n\nЗаведены, но НЕ включены в шапку профиля (в резюме не попадут): ${needs.orphanContacts.join(', ')}. Добавьте их в contact_keys профиля.`
					: '';

			return {
				what: intent.what,
				summary: `ключей справочника: ${
					1 +
					needs.contacts.length +
					needs.orgs.length +
					needs.institutions.length +
					needs.links.length
				}`,
				text: `Справочник рендера (файл вне репозиториев) должен закрыть:\n${blocks.join('\n')}${orphans}\n\nЗначения впишите в career-directory.local.json — через бота они не проходят.`,
			};
		}

		case 'preview': {
			const variant = intent.variant_id
				? base.variants.find((v) => v.id === intent.variant_id)
				: (base.variants.find((v) => v.status === 'active') ?? base.variants[0]);
			if (!variant) {
				return {
					what: intent.what,
					summary: 'варианта нет',
					text: 'Нет варианта для предпросмотра.',
				};
			}

			// asOf берём из данных: самый поздний известный конец периода или начало.
			// Часы сюда не тянем — предпросмотр обязан совпадать с будущим рендером.
			const asOf = base.positions.reduce(
				(max, p) => (p.started_at > max ? p.started_at : max),
				variant.ts.slice(0, 7),
			);
			const result = renderResume(base, variant, previewDirectory(base), { asOf });
			const report = formatRenderReport(result);
			const body = result.markdown ?? '(документ не собран)';

			return {
				what: intent.what,
				summary: `предпросмотр ${variant.id}`,
				text: `Предпросмотр варианта ${variant.id} (контакты подставляются только при рендере файла):\n\n${body}\n\n---\n${report}`,
			};
		}
	}
}
