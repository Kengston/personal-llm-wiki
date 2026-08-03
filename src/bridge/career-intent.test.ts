/**
 * career-intent.test.ts — протокол карьерных интентов: извлечение, диспетчеризация,
 * чтение и кнопочные правки ([ADR-0028], D1/D2).
 *
 * Отдельно проверяется то, ради чего менялся шов в `app.ts`: два интент-блока в одном
 * ответе движка (финансовый и карьерный) не отменяют друг друга. До правки финансовый
 * readback ЗАМЕЩАЛ ответ целиком, и второй блок пропадал вместе с текстом.
 *
 * Данные синтетические: `acme`, `example.com`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCareerLedger, loadCareerBase, type CareerLedger } from '../ingest/career/store.js';
import { dispatchCareerCallback } from './career-callbacks.js';
import { dispatchCareerIntent, formatCareerReadback } from './career-intent-dispatch.js';
import { careerCallbackData, runCareerQuery } from './career-intent-query.js';
import { extractCareerIntent } from './career-intent-schema.js';
import { extractFinanceIntent } from './finance-intent.js';
import type { AnswerCallbackOptions, ReplyMarkup, TelegramClient } from './telegram.js';

const TS = new Date('2026-08-02T10:00:00Z');
const nowFn = () => TS;

let tmpDir: string;
let ledger: CareerLedger;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'career-intent-test-'));
	ledger = createCareerLedger({
		dir: join(tmpDir, 'raw', 'career'),
		publicRepoRoot: join(tmpDir, 'public-fake'),
	});
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Готовая база: позиция + достижение + вариант. */
function seed(): void {
	dispatchCareerIntent(
		{
			type: 'add_position',
			id: 'acme-backend',
			org_key: 'acme',
			title: { lang: 'ru', text: 'Бэкенд-инженер' },
			employment: 'full_time',
			started_at: '2024-02',
			skill_ids: [],
			order: 1,
		},
		{ ledger, nowFn },
	);
	dispatchCareerIntent(
		{
			type: 'add_achievement',
			id: 'shipped-api',
			position_id: 'acme-backend',
			text: { lang: 'ru', text: 'Запустил API' },
			metric_keys: [],
			skill_ids: [],
			order: 1,
		},
		{ ledger, nowFn },
	);
	dispatchCareerIntent(
		{
			type: 'create_variant',
			id: 'ru-backend',
			lang: 'ru',
			role_family: 'Бэкенд-инженер',
			keywords: [],
			max_pages: 1,
			max_bullets_per_position: 4,
			max_detailed_positions: 3,
		},
		{ ledger, nowFn },
	);
}

function fence(json: unknown): string {
	return '```career-intent\n' + JSON.stringify(json) + '\n```';
}

// ---------------------------------------------------------------------------
// 1. Извлечение
// ---------------------------------------------------------------------------

describe('extractCareerIntent', () => {
	it('достаёт интент из блока с пояснением вокруг', () => {
		const answer = `Записал позицию.\n\n${fence({ type: 'query', what: 'positions' })}\n\nГотово.`;

		expect(extractCareerIntent(answer)).toEqual({ type: 'query', what: 'positions' });
	});

	it('нет блока / битый JSON / чужая схема → null, ход не роняется', () => {
		expect(extractCareerIntent('Обычный ответ без блоков.')).toBeNull();
		expect(extractCareerIntent('```career-intent\n{не json\n```')).toBeNull();
		expect(extractCareerIntent(fence({ type: 'not_an_intent' }))).toBeNull();
	});

	it('достижение сразу под позицией и проектом не проходит валидацию', () => {
		const answer = fence({
			type: 'add_achievement',
			id: 'both',
			position_id: 'acme-backend',
			project_id: 'synthetic-project',
			text: { lang: 'ru', text: 'Текст' },
		});

		expect(extractCareerIntent(answer)).toBeNull();
	});

	it('финансовый и карьерный блоки в одном ответе не перехватывают друг друга', () => {
		// Ровно тот случай, из-за которого правился шов в app.ts.
		const answer = [
			'```finance-intent',
			JSON.stringify({ type: 'query', query_kind: 'net_worth' }),
			'```',
			'',
			fence({ type: 'query', what: 'positions' }),
		].join('\n');

		expect(extractFinanceIntent(answer)).not.toBeNull();
		expect(extractCareerIntent(answer)).toEqual({ type: 'query', what: 'positions' });
	});
});

// ---------------------------------------------------------------------------
// 2. Запись
// ---------------------------------------------------------------------------

describe('dispatchCareerIntent — запись', () => {
	it('add_position пишет позицию, add_achievement — достижение под ней', () => {
		seed();
		const base = loadCareerBase(ledger);

		expect(base.positions.map((p) => p.id)).toEqual(['acme-backend']);
		expect(base.achievements.map((a) => a.id)).toEqual(['shipped-api']);
		expect(base.variants.map((v) => v.id)).toEqual(['ru-backend']);
	});

	it('достижение под несуществующей позицией — отказ значением, а не исключением', () => {
		const result = dispatchCareerIntent(
			{
				type: 'add_achievement',
				id: 'orphan',
				position_id: 'absent',
				text: { lang: 'ru', text: 'Текст' },
				metric_keys: [],
				skill_ids: [],
				order: 1,
			},
			{ ledger, nowFn },
		);

		expect(result.ok).toBe(false);
		expect(formatCareerReadback(result)).toContain('Не применил');
		expect(loadCareerBase(ledger).achievements).toEqual([]);
	});

	it('remove_position пишет tombstone, история строки остаётся', () => {
		seed();
		const result = dispatchCareerIntent(
			{ type: 'remove', entity: 'position', id: 'acme-backend' },
			{ ledger, nowFn: () => new Date('2026-08-02T12:00:00Z') },
		);

		expect(result.ok).toBe(true);
		expect(loadCareerBase(ledger).positions).toEqual([]);
		// В файле по-прежнему две строки: удаление — это дозапись, а не стирание.
		expect(ledger.readAll('positions')).toHaveLength(2);
	});

	it('toggle_achievement правит пины варианта и чистит противоположный список', () => {
		seed();
		dispatchCareerIntent(
			{
				type: 'toggle_achievement',
				variant_id: 'ru-backend',
				achievement_id: 'shipped-api',
				include: true,
			},
			{ ledger, nowFn: () => new Date('2026-08-02T11:00:00Z') },
		);
		let variant = loadCareerBase(ledger).variants[0]!;
		expect(variant.pins).toEqual(['shipped-api']);
		expect(variant.excludes).toEqual([]);

		dispatchCareerIntent(
			{
				type: 'toggle_achievement',
				variant_id: 'ru-backend',
				achievement_id: 'shipped-api',
				include: false,
			},
			{ ledger, nowFn: () => new Date('2026-08-02T12:00:00Z') },
		);
		variant = loadCareerBase(ledger).variants[0]!;
		expect(variant.pins).toEqual([]);
		expect(variant.excludes).toEqual(['shipped-api']);
	});

	it('set_field правит разрешённое поле и добавляет перевод, не теряя старый', () => {
		seed();
		dispatchCareerIntent(
			{
				type: 'set_field',
				entity: 'position',
				id: 'acme-backend',
				field: 'title',
				value: 'Backend Engineer',
				lang: 'en',
			},
			{ ledger, nowFn: () => new Date('2026-08-02T11:00:00Z') },
		);

		expect(loadCareerBase(ledger).positions[0]!.title).toEqual({
			ru: 'Бэкенд-инженер',
			en: 'Backend Engineer',
		});
	});

	it('поле вне белого списка не правится', () => {
		seed();
		const result = dispatchCareerIntent(
			{ type: 'set_field', entity: 'position', id: 'acme-backend', field: 'ts', value: 'x' },
			{ ledger, nowFn },
		);

		expect(result.ok).toBe(false);
		expect(result.summary).toContain('править нельзя');
	});

	it('i18n-поле без языка не правится', () => {
		seed();
		const result = dispatchCareerIntent(
			{ type: 'set_field', entity: 'position', id: 'acme-backend', field: 'title', value: 'X' },
			{ ledger, nowFn },
		);

		expect(result.ok).toBe(false);
		expect(result.summary).toContain('нужен язык');
	});

	it('перевод технонима через set_field не применяется', () => {
		ledger.append('skills', {
			id: 'typescript',
			name: { no_translate: true, text: 'TypeScript' },
			kind: 'language',
			level: 'core',
			first_used: '2024-02',
			ts: '2026-08-02T10:00:00Z',
		});

		const result = dispatchCareerIntent(
			{
				type: 'set_field',
				entity: 'skill',
				id: 'typescript',
				field: 'name',
				value: 'Тайпскрипт',
				lang: 'ru',
			},
			{ ledger, nowFn },
		);

		expect(result.ok).toBe(false);
		expect(result.summary).toContain('no_translate');
	});
});

// ---------------------------------------------------------------------------
// 3. Чтение и кнопки
// ---------------------------------------------------------------------------

describe('runCareerQuery', () => {
	it('пустая база отвечает словами, а не пустым сообщением', () => {
		const result = runCareerQuery({ type: 'query', what: 'positions' }, loadCareerBase(ledger));

		expect(result.text).toContain('пока нет позиций');
	});

	it('достижения в контексте варианта приходят с кнопками правки', () => {
		seed();
		const result = runCareerQuery(
			{ type: 'query', what: 'achievements', variant_id: 'ru-backend' },
			loadCareerBase(ledger),
		);

		expect(result.keyboard?.inline_keyboard[0]?.[0]?.callback_data).toBe(
			'res:inc:ru-backend:shipped-api',
		);
	});

	it('без варианта кнопок нет — правка бессмысленна вне контекста варианта', () => {
		seed();
		const result = runCareerQuery({ type: 'query', what: 'achievements' }, loadCareerBase(ledger));

		expect(result.keyboard).toBeUndefined();
	});

	it('предпросмотр показывает документ и список выброшенного, но не реальные контакты', () => {
		seed();
		const result = runCareerQuery(
			{ type: 'query', what: 'preview', variant_id: 'ru-backend' },
			loadCareerBase(ledger),
		);

		expect(result.text).toContain('{{display_name}}');
		expect(result.text).toContain('Опыт работы');
	});

	it('слишком длинный payload кнопки не обрезается, а не выдаётся', () => {
		// Обрезанный callback_data превратился бы в команду по чужому идентификатору.
		expect(careerCallbackData('inc', 'a'.repeat(40), 'b'.repeat(40))).toBeNull();
		expect(careerCallbackData('inc', 'v1', 'a1')).toBe('res:inc:v1:a1');
	});
});

// ---------------------------------------------------------------------------
// 4. Кнопочный флоу
// ---------------------------------------------------------------------------

/** Мок транспорта: запоминает всё, что мост попытался отправить. */
class MockTelegram implements Partial<TelegramClient> {
	answered: { id: string; text?: string }[] = [];
	edited: { chatId: number; messageId: number; text: string; keyboard?: ReplyMarkup }[] = [];

	async answerCallbackQuery(id: string, opts: AnswerCallbackOptions = {}): Promise<void> {
		this.answered.push({ id, text: opts.text });
	}
	async editMessageText(
		chatId: number,
		messageId: number,
		text: string,
		opts: { replyMarkup?: ReplyMarkup } = {},
	): Promise<void> {
		this.edited.push({ chatId, messageId, text, keyboard: opts.replyMarkup });
	}
}

describe('dispatchCareerCallback', () => {
	it('нажатие применяет правку и переписывает сообщение на месте', async () => {
		seed();
		const telegram = new MockTelegram();

		await dispatchCareerCallback(
			{
				chatId: 42,
				fromId: 42,
				callbackQueryId: 'cbq-1',
				data: 'res:inc:ru-backend:shipped-api',
				messageId: 7,
			},
			{
				ownerChatId: 42,
				telegram: telegram as unknown as TelegramClient,
				ledger,
				nowFn: () => new Date('2026-08-02T11:00:00Z'),
			},
		);

		expect(loadCareerBase(ledger).variants[0]!.pins).toEqual(['shipped-api']);
		expect(telegram.answered[0]).toMatchObject({ id: 'cbq-1' });
		// Сообщение перерисовано, и кнопка теперь предлагает обратное действие.
		expect(telegram.edited).toHaveLength(1);
		expect(telegram.edited[0]!.keyboard?.inline_keyboard[0]?.[0]?.callback_data).toBe(
			'res:exc:ru-backend:shipped-api',
		);
	});

	it('чужой from.id не применяет ничего', async () => {
		seed();
		const telegram = new MockTelegram();

		await dispatchCareerCallback(
			{ chatId: 42, fromId: 999, callbackQueryId: 'cbq-2', data: 'res:inc:ru-backend:shipped-api' },
			{
				ownerChatId: 42,
				telegram: telegram as unknown as TelegramClient,
				ledger,
				nowFn,
			},
		);

		expect(loadCareerBase(ledger).variants[0]!.pins).toEqual([]);
		expect(telegram.edited).toEqual([]);
	});

	it('незнакомая кнопка гасит «часики» и ничего не пишет', async () => {
		seed();
		const telegram = new MockTelegram();

		await dispatchCareerCallback(
			{ chatId: 42, fromId: 42, callbackQueryId: 'cbq-3', data: 'res:unknown:x:y' },
			{ ownerChatId: 42, telegram: telegram as unknown as TelegramClient, ledger, nowFn },
		);

		expect(telegram.answered[0]!.text).toContain('Не понял кнопку');
		expect(loadCareerBase(ledger).variants[0]!.pins).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 5. Сущности, у которых раньше не было входа вовсе
// ---------------------------------------------------------------------------

describe('dispatchCareerIntent — метрики и остальные сущности', () => {
	it('бизнес-метрика записывается и становится доступна плейсхолдеру', () => {
		// До появления add_metric числа мог писать ТОЛЬКО импортёр evidence, а достижение
		// с {{metric.…}} не рендерилось вовсе (fail-closed на unknown_metric).
		const result = dispatchCareerIntent(
			{
				type: 'add_metric',
				key: 'hub.calls',
				value: 71946,
				unit: 'count',
				as_of: '2026-08-02',
				source: 'business',
				verifiable: true,
			},
			{ ledger, nowFn },
		);

		expect(result.ok).toBe(true);
		expect(loadCareerBase(ledger).metrics.get('hub.calls')!.value).toBe(71946);
	});

	it('бизнес-метрика без ответа о проверяемости не принимается', () => {
		const result = dispatchCareerIntent(
			{
				type: 'add_metric',
				key: 'revenue.growth',
				value: 30,
				unit: 'pct',
				as_of: '2026-08-02',
				source: 'business',
			},
			{ ledger, nowFn },
		);

		expect(result.ok).toBe(false);
		expect(result.summary).toContain('подтверждается ли она внешне');
		expect(loadCareerBase(ledger).metrics.size).toBe(0);
	});

	it('ключ машинного замера руками не переписывается', () => {
		// Несогласие с evidence оформляется своей записью, а не правкой импортированной.
		ledger.append('metrics', {
			key: 'commits.total',
			value: 3189,
			unit: 'count',
			as_of: '2026-07-01',
			source: 'evidence',
			evidence_ref: { snapshot_id: 'abc123', path: 'raw/career/evidence-abc123.json' },
			ts: '2026-08-02T10:00:00Z',
		});

		const result = dispatchCareerIntent(
			{
				type: 'add_metric',
				key: 'commits.total',
				value: 9999,
				unit: 'count',
				as_of: '2026-08-02',
				source: 'manual',
			},
			{ ledger, nowFn },
		);

		expect(result.ok).toBe(false);
		expect(loadCareerBase(ledger).metrics.get('commits.total')!.value).toBe(3189);
	});

	it('навык, образование, язык и проект заводятся через бота', () => {
		dispatchCareerIntent(
			{
				type: 'add_skill',
				id: 'typescript',
				name: { lang: 'ru', text: 'TypeScript', no_translate: true },
				kind: 'language',
				level: 'core',
				first_used: '2024-02',
			},
			{ ledger, nowFn },
		);
		dispatchCareerIntent(
			{
				type: 'add_education',
				id: 'degree',
				institution_key: 'synthetic-university',
				program: { lang: 'ru', text: 'Информатика' },
				kind: 'degree',
				started_at: '2018-09',
				ended_at: '2022-06',
			},
			{ ledger, nowFn },
		);
		dispatchCareerIntent({ type: 'add_language', id: 'en', level: 'b2' }, { ledger, nowFn });
		dispatchCareerIntent(
			{
				type: 'add_project',
				id: 'synthetic-project',
				name: { lang: 'ru', text: 'Synthetic Project', no_translate: true },
				summary: { lang: 'ru', text: 'Описание' },
				started_at: '2025-01',
				skill_ids: ['typescript'],
			},
			{ ledger, nowFn },
		);

		const base = loadCareerBase(ledger);
		expect(base.skills[0]!.name).toEqual({ no_translate: true, text: 'TypeScript' });
		expect(base.education[0]!.institution_key).toBe('synthetic-university');
		expect(base.languages[0]!.level).toBe('b2');
		expect(base.projects[0]!.id).toBe('synthetic-project');
	});

	it('контакт заводится КЛЮЧОМ, значения в интенте нет вовсе', () => {
		const result = dispatchCareerIntent(
			{ type: 'add_contact', key: 'email_primary', kind: 'email', render_required: true },
			{ ledger, nowFn },
		);

		expect(result.ok).toBe(true);
		expect(loadCareerBase(ledger).contacts[0]).toMatchObject({ key: 'email_primary' });
		// Схема интента поля под значение не имеет — записать его физически нечем.
		expect(JSON.stringify(ledger.readAll('contacts'))).not.toContain('@');
		expect(result.summary).toContain('через бота оно не проходит');
	});

	it('remove одним интентом снимает любую сущность', () => {
		dispatchCareerIntent(
			{
				type: 'add_skill',
				id: 'typescript',
				name: { lang: 'ru', text: 'TypeScript', no_translate: true },
				kind: 'language',
				level: 'core',
				first_used: '2024-02',
			},
			{ ledger, nowFn },
		);

		const result = dispatchCareerIntent(
			{ type: 'remove', entity: 'skill', id: 'typescript' },
			{ ledger, nowFn: () => new Date('2026-08-02T12:00:00Z') },
		);

		expect(result.ok).toBe(true);
		expect(loadCareerBase(ledger).skills).toEqual([]);
		expect(ledger.readAll('skills')).toHaveLength(2);
	});

	it('повторный add с тем же id — это правка, а не дубль', () => {
		const skill = {
			type: 'add_skill' as const,
			id: 'typescript',
			name: { lang: 'ru', text: 'TypeScript', no_translate: true },
			kind: 'language' as const,
			level: 'working' as const,
			first_used: '2024-02',
		};
		dispatchCareerIntent(skill, { ledger, nowFn });
		dispatchCareerIntent(
			{ ...skill, level: 'core' },
			{ ledger, nowFn: () => new Date('2026-08-02T12:00:00Z') },
		);

		const base = loadCareerBase(ledger);
		expect(base.skills).toHaveLength(1);
		expect(base.skills[0]!.level).toBe('core');
	});
});

describe('runCareerQuery — чеклист справочника', () => {
	it('отдаёт КЛЮЧИ, которые владелец должен закрыть руками, и ни одного значения', () => {
		seed();
		dispatchCareerIntent(
			{ type: 'add_contact', key: 'email_primary', kind: 'email', render_required: true },
			{ ledger, nowFn },
		);

		const result = runCareerQuery({ type: 'query', what: 'directory' }, loadCareerBase(ledger));

		expect(result.text).toContain('display_name');
		expect(result.text).toContain('acme');
		expect(result.text).toContain('через бота они не проходят');
	});
});

// ---------------------------------------------------------------------------
// 6. Находки адверсариального ревью — регрессия
// ---------------------------------------------------------------------------

describe('профиль и контакты — сквозной путь до документа', () => {
	it('заведённый контакт доходит до шапки профиля, а не повисает сиротой', () => {
		// Ревью нашло: add_contact писал ключ, который не читал ни рендер, ни чеклист —
		// рендер шапки берёт контакты ТОЛЬКО из profile.contact_keys, а завести профиль
		// было нечем. Код есть, покрыт тестом, не подключён — ровно та же болезнь.
		dispatchCareerIntent(
			{ type: 'add_contact', key: 'email_primary', kind: 'email', render_required: true },
			{ ledger, nowFn },
		);
		dispatchCareerIntent(
			{
				type: 'add_profile',
				id: 'main',
				headline: { lang: 'ru', text: 'Инженер' },
				about: { lang: 'ru', text: 'О себе' },
				location: 'Город',
				work_setup: { mode: 'remote', relocation_ready: true },
				contact_keys: ['email_primary'],
			},
			{ ledger, nowFn },
		);

		const base = loadCareerBase(ledger);
		expect(base.profile!.contact_keys).toEqual(['email_primary']);
		expect(runCareerQuery({ type: 'query', what: 'directory' }, base).text).toContain(
			'email_primary',
		);
	});

	it('контакт без профиля показывается как сирота, а не молчит', () => {
		dispatchCareerIntent(
			{ type: 'add_contact', key: 'email_primary', kind: 'email', render_required: true },
			{ ledger, nowFn },
		);

		const text = runCareerQuery({ type: 'query', what: 'directory' }, loadCareerBase(ledger)).text;

		expect(text).toContain('НЕ включены в шапку профиля');
		expect(text).toContain('email_primary');
	});

	it('contact_keys дополняются, а не заменяются', () => {
		const profile = {
			type: 'add_profile' as const,
			id: 'main',
			headline: { lang: 'ru', text: 'Инженер' },
			about: { lang: 'ru', text: 'О себе' },
			location: 'Город',
			work_setup: { mode: 'remote' as const, relocation_ready: true },
		};
		dispatchCareerIntent({ ...profile, contact_keys: ['email_primary'] }, { ledger, nowFn });
		dispatchCareerIntent(
			{ ...profile, contact_keys: ['profile_public'] },
			{ ledger, nowFn: () => new Date('2026-08-02T12:00:00Z') },
		);

		expect(loadCareerBase(ledger).profile!.contact_keys).toEqual([
			'email_primary',
			'profile_public',
		]);
	});

	it('профиль называет ключи, под которыми нет записи контакта', () => {
		const result = dispatchCareerIntent(
			{
				type: 'add_profile',
				id: 'main',
				headline: { lang: 'ru', text: 'Инженер' },
				about: { lang: 'ru', text: 'О себе' },
				location: 'Город',
				work_setup: { mode: 'remote', relocation_ready: true },
				contact_keys: ['absent_key'],
			},
			{ ledger, nowFn },
		);

		expect(result.summary).toContain('Контакты без записи: absent_key');
	});
});

describe('повторный add_* не теряет введённые переводы', () => {
	it('второй язык дописывается к первому, а не затирает его', () => {
		// Ревью нашло: add_* собирал { [lang]: text } с нуля, и английский молча убивал
		// русский — при том что set_field рядом мержил правильно.
		seed();
		dispatchCareerIntent(
			{
				type: 'add_position',
				id: 'acme-backend',
				org_key: 'acme',
				title: { lang: 'en', text: 'Backend Engineer' },
				employment: 'full_time',
				started_at: '2024-02',
				skill_ids: [],
				order: 1,
			},
			{ ledger, nowFn: () => new Date('2026-08-02T12:00:00Z') },
		);

		expect(loadCareerBase(ledger).positions[0]!.title).toEqual({
			ru: 'Бэкенд-инженер',
			en: 'Backend Engineer',
		});
	});

	it('техноним объявляется флагом и языка не требует', () => {
		const result = dispatchCareerIntent(
			{
				type: 'add_skill',
				id: 'typescript',
				name: { text: 'TypeScript', no_translate: true },
				kind: 'language',
				level: 'core',
				first_used: '2024-02',
			},
			{ ledger, nowFn },
		);

		expect(result.ok).toBe(true);
		expect(loadCareerBase(ledger).skills[0]!.name).toEqual({
			no_translate: true,
			text: 'TypeScript',
		});
	});

	it('переводимое название без языка не проходит валидацию', () => {
		expect(
			extractCareerIntent(
				fence({
					type: 'add_skill',
					id: 'ts',
					name: { text: 'Тайпскрипт' },
					kind: 'language',
					level: 'core',
					first_used: '2024-02',
				}),
			),
		).toBeNull();
	});
});
