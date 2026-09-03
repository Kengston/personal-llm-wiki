/**
 * events.ts — воронка откликов: агрегат-заголовок + append-only поток событий ([ADR-0030]).
 *
 * Ключевое решение, из которого следует всё остальное: **стадия отклика нигде не хранится**.
 * Она вычисляется fold'ом по потоку `stage_change`. Обратное преобразование невозможно:
 * поле `status` знает только «где сейчас», а отчётность спрашивает «когда пришёл первый
 * ответ», «сколько было раундов», «отказали до или после тест-задания» — и по полю статуса
 * эти вопросы не отвечаемы. Заявка, дошедшая до оффера, в статус-модели больше не помнит,
 * что проходила скрининг, и выпадает из знаменателя предыдущей стадии: метрики тихо
 * занижают верх воронки и завышают низ.
 *
 * Второе решение: **касание — событие, но не переход**. `touchpoint` (написал рекрутеру,
 * напомнил о себе) живёт в том же потоке, потому что это наблюдение и его надо помнить,
 * но стадию не двигает, в конверсии не входит и таймер молчания НЕ сбрасывает: три письма
 * в пустоту не отменяют молчания работодателя.
 *
 * Третье: **`ghosted` — вывод, а не наблюдение**. Молчание это отсутствие события, а не
 * событие. В леджер `ghosted` попадает только по подтверждению владельца кнопкой; в
 * аналитике это предикат «столько-то дней без внешнего события».
 */

import { z } from 'zod';

import { companySource, platformId } from './companies.js';

const isoTimestamp = z.string().min(1);
const slugId = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9][a-z0-9_.-]*$/);

/**
 * Словарь стадий — ЕДИНСТВЕННЫЙ в подсистеме ([ADR-0030]).
 * `opportunity` ([ADR-0029]) поля стадии не несёт вовсе, глоссарий ссылается сюда.
 */
export const APPLICATION_STAGES = [
	'applied',
	'replied',
	'screening',
	'interview',
	'test_task',
	'offer',
	'rejected',
	'ghosted',
	'withdrawn',
] as const;

export type ApplicationStage = (typeof APPLICATION_STAGES)[number];

/**
 * Стадии, которые инициирует САМ владелец. Внешним событием они не считаются, поэтому
 * таймер молчания работодателя не сбрасывают — по той же причине, что и касания.
 *
 * `ghosted` здесь по третьему пункту шапки файла: это подтверждение владельцем того, что
 * ответа НЕ БЫЛО. Пока стадия отсутствовала в этом множестве, такое подтверждение
 * считалось внешним событием и через `lastExternalAt` попадало в числитель «есть реакция»
 * в разрезах воронки — то есть отклик, про который владелец сказал «мне не ответили»,
 * шёл в статистику ответивших. В леджере пока ноль таких записей, и потому это не
 * искажало цифры, но первое же нажатие кнопки испортило бы ровно ту метрику, ради которой
 * стадия и заведена.
 */
const OWNER_INITIATED: ReadonlySet<string> = new Set(['applied', 'withdrawn', 'ghosted']);

/** Виды касаний: контакт, который стадию не двигает. */
export const TOUCH_KINDS = ['outreach', 'follow_up', 'reply_sent', 'other'] as const;

/**
 * Нормализованный справочник причин. `other` без `reason_note` не принимается —
 * иначе через месяц 80% отказов имеют код `other` и группировка бессмысленна.
 */
export const REASON_CODES = [
	'no_response',
	'stack_mismatch',
	'seniority_mismatch',
	'comp_mismatch',
	'location_or_relocation',
	'language',
	'visa_or_legal',
	'role_closed',
	'internal_candidate',
	'failed_test_task',
	'failed_interview',
	'withdrew_own',
	'other',
] as const;

/** Стадии-исходы, для которых причина обязательна: по ней и группируем отказы. */
const OUTCOME_STAGES: ReadonlySet<string> = new Set(['rejected', 'ghosted', 'withdrawn']);

// ---------------------------------------------------------------------------
// application — иммутабельная шапка отклика
// ---------------------------------------------------------------------------

export const ApplicationRecordSchema = z.object({
	id: slugId,
	/** Ссылка на `company.id` ([ADR-0029]). */
	company_id: slugId,
	/** Ссылка на `opportunity.id` там же. */
	opportunity_id: slugId.optional(),
	role_title: z.string().min(1).max(200),
	/**
	 * Какой вариант резюме отправлен (`variant.id`, [ADR-0028]).
	 * Без этого поля метрика «какой вариант конвертит» физически неисчислима —
	 * а ради неё вариант и версионируется.
	 */
	variant_id: slugId.optional(),
	/**
	 * Откуда узнали о компании. Словарь принадлежит [ADR-0029] и импортируется оттуда:
	 * копия литерала здесь уже разъезжалась с оригиналом, и разъезд вскрывался на
	 * валидации отклика — то есть после отправки ([ADR-0031] §1).
	 */
	company_source: companySource,
	/**
	 * Где вакансия найдена ([ADR-0033]). Отдельно от `applied_via`: «нашёл в LinkedIn,
	 * подал через Ashby» — два разных проверяемых факта, и склеенные в одно поле они
	 * дают неверную конверсию по обеим площадкам сразу.
	 */
	platform: platformId.optional(),
	/**
	 * id вакансии на площадке. Буквенный префикс без разделителя (`hh136857307`) — по той же
	 * причине, что и у вакансии: голое число санитайзер маскирует как телефон.
	 */
	external_id: z.string().max(64).optional(),
	/** Публичная страница вакансии без query. У вакансии тот же факт зовётся `source_url`. */
	url: z.string().url().optional(),
	/** Где отправлена форма ([ADR-0033]). */
	applied_via: platformId.optional(),
	/**
	 * Как подавались. Имя поля `channel` в подсистеме не используется вовсе.
	 *
	 * Словарь описывает СПОСОБ, а не место: `linkedin_easy_apply` из старых записей — это
	 * `direct` + `applied_via: linkedin`, и миграция так его и разбирает. Складывать место
	 * подачи сюда значит заводить второй словарь площадок.
	 */
	submission_channel: z.enum(['referral', 'direct', 'inbound']),
	/**
	 * Опаковая ссылка/идентификатор вакансии. Через `failClosedSanitize` НЕ проходит:
	 * это типизированное поле, а не свободный текст (иначе числовой id молча стал бы
	 * `[REDACTED:phone]` и ссылка превратилась бы в мусор).
	 */
	vacancy_ref: z.string().max(500).optional(),
	applied_at: isoTimestamp,
	currency: z.string().min(1).max(10).optional(),
	comp_expected: z.number().optional(),
	ts: isoTimestamp,
});

export type ApplicationRecord = z.infer<typeof ApplicationRecordSchema>;

/**
 * NewApplicationRecordSchema — то же самое, но для НОВЫХ записей ([ADR-0033], [ADR-0035]).
 *
 * Разделение схем — не удвоение контракта, а его единственный честный вид: история
 * писалась до реестра площадок и обязана читаться дальше (иначе отчёт падает на архиве),
 * а новая запись без площадки — это ровно тот пробел, из-за которого «где нашёл» и «где
 * подал» пришлось восстанавливать по ссылке. Строгую схему применяет только путь записи
 * (`jobsearch:append`); чтение всегда идёт базовой.
 *
 * `external_id` требуется не всегда: у `site` (длинный хвост карьерных страниц) и `email`
 * идентификатора вакансии не существует в природе, и требовать его значило бы вынуждать
 * агента выдумывать значение.
 */
export const NewApplicationRecordSchema = ApplicationRecordSchema.extend({
	platform: platformId,
	url: z.string().url(),
	applied_via: platformId,
}).refine(
	(a) => a.platform === 'site' || a.platform === 'email' || (a.external_id ?? '').length > 0,
	'external_id обязателен для новой записи на всех площадках, кроме site и email',
);

export type NewApplicationRecord = z.infer<typeof NewApplicationRecordSchema>;

// ---------------------------------------------------------------------------
// application_events — append-only поток
// ---------------------------------------------------------------------------

export const ApplicationEventSchema = z
	.object({
		id: slugId,
		application_id: slugId,
		ts: isoTimestamp,
		kind: z.enum(['stage_change', 'touchpoint']),
		/** Обязателен при `stage_change`, отсутствует при `touchpoint`. */
		stage: z.enum(APPLICATION_STAGES).optional(),
		/** Обязателен при `touchpoint`. */
		touch_kind: z.enum(TOUCH_KINDS).optional(),
		/** Кто/что зафиксировало событие. */
		source: z.enum(['owner', 'import', 'derived']),
		reason_code: z.enum(REASON_CODES).optional(),
		/**
		 * Лимит поднят с 1000 до 2000: четыре реальных заметки владельца его переросли
		 * (самая длинная — 1130 символов). Это не заметка агента, а разбор отказа своими
		 * словами, и обрезать его значило бы терять именно то, ради чего поле заведено.
		 * Тысяча была догадкой, две тысячи — догадка с запасом от известного максимума.
		 */
		reason_note: z.string().max(2000).optional(),
		/** Для назначенного события (собеседование) — когда оно состоится. */
		scheduled_at: isoTimestamp.optional(),
		/**
		 * Когда событие произошло на самом деле, если это не момент записи (`ts`).
		 * Заводится схемой задним числом: поле уже есть в четырёх исторических записях, а
		 * `Ledger.append` пишет только то, что описано схемой — без объявления миграция
		 * молча стёрла бы его при перезаписи.
		 */
		occurred_at: isoTimestamp.optional(),
		/** Свободная заметка к событию — та же история, что и у `occurred_at`. */
		note: z.string().max(1000).optional(),
		/** Компенсация ошибки ввода: отменяет указанное событие, само в fold не входит. */
		void_id: slugId.optional(),
		/** Исправление: отменяет указанное событие и заменяет его собой. */
		amended_id: slugId.optional(),
	})
	.refine(
		(e) => (e.kind === 'stage_change') === (e.stage !== undefined),
		'stage обязателен ровно при kind: stage_change',
	)
	.refine(
		(e) => (e.kind === 'touchpoint') === (e.touch_kind !== undefined),
		'touch_kind обязателен ровно при kind: touchpoint',
	)
	.refine(
		(e) => e.reason_code !== 'other' || (e.reason_note ?? '').trim().length > 0,
		'reason_code: other не принимается без reason_note — иначе справочник вырождается',
	)
	.refine(
		(e) => !(e.stage && OUTCOME_STAGES.has(e.stage)) || e.reason_code !== undefined,
		'для стадии-исхода (rejected/ghosted/withdrawn) обязателен reason_code',
	);

export type ApplicationEvent = z.infer<typeof ApplicationEventSchema>;

// ---------------------------------------------------------------------------
// foldApplication — состояние из потока
// ---------------------------------------------------------------------------

/** Состояние отклика, восстановленное из событий. Нигде не хранится. */
export interface ApplicationState {
	application_id: string;
	/** Последняя стадия из `stage_change`. `null` — событий смены стадии не было. */
	stage: ApplicationStage | null;
	/** Достигнутые стадии в порядке первого появления — знаменатели конверсий. */
	stagesReached: ApplicationStage[];
	/** Первое появление каждой стадии: из него считаются длительности. */
	firstAt: Partial<Record<ApplicationStage, string>>;
	/** Последнее ВНЕШНЕЕ событие: касания владельца сюда не входят. */
	lastExternalAt: string | null;
	/** Последнее событие любого вида. */
	lastEventAt: string | null;
	/** Причина исхода, если он зафиксирован. */
	reasonCode: string | null;
	/** Назначенные собеседования: `scheduled_at` из событий стадии `interview`. */
	scheduled: string[];
}

/**
 * foldApplication — чистая функция: поток событий → состояние.
 *
 * Компенсации применяются до fold'а: `void_id` отменяет указанное событие и сам в
 * подсчёт не входит; `amended_id` отменяет указанное и входит вместо него. Задним
 * числом строки не правятся — исправление это тоже запись.
 *
 * @param applicationId — чей поток сворачиваем
 * @param events        — события (любого порядка; сортируются внутри)
 */
export function foldApplication(
	applicationId: string,
	events: ApplicationEvent[],
): ApplicationState {
	const own = events.filter((e) => e.application_id === applicationId);

	// Отменённые события: и через void_id, и через amended_id.
	const voided = new Set<string>();
	for (const e of own) {
		if (e.void_id) voided.add(e.void_id);
		if (e.amended_id) voided.add(e.amended_id);
	}

	const effective = own
		.filter((e) => !voided.has(e.id))
		// Чистая отмена (`void_id` без собственного содержания) — маркер, не наблюдение.
		.filter((e) => !(e.void_id && !e.amended_id))
		.sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));

	const state: ApplicationState = {
		application_id: applicationId,
		stage: null,
		stagesReached: [],
		firstAt: {},
		lastExternalAt: null,
		lastEventAt: null,
		reasonCode: null,
		scheduled: [],
	};

	for (const event of effective) {
		state.lastEventAt = event.ts;

		if (event.kind !== 'stage_change' || !event.stage) continue;

		state.stage = event.stage;
		if (!(event.stage in state.firstAt)) {
			state.firstAt[event.stage] = event.ts;
			state.stagesReached.push(event.stage);
		}
		if (event.reason_code) state.reasonCode = event.reason_code;
		if (event.stage === 'interview' && event.scheduled_at) state.scheduled.push(event.scheduled_at);

		// Внешнее событие = смена стадии, инициированная НЕ владельцем. Касания и
		// собственные действия (`applied`, `withdrawn`) молчание работодателя не отменяют.
		if (!OWNER_INITIATED.has(event.stage)) state.lastExternalAt = event.ts;
	}

	return state;
}

/** foldAll — состояния по всем откликам разом, в порядке `applied_at`. */
export function foldAll(
	applications: ApplicationRecord[],
	events: ApplicationEvent[],
): Map<string, ApplicationState> {
	const byApp = new Map<string, ApplicationEvent[]>();
	for (const event of events) {
		const list = byApp.get(event.application_id);
		if (list) list.push(event);
		else byApp.set(event.application_id, [event]);
	}

	const result = new Map<string, ApplicationState>();
	for (const app of applications) {
		result.set(app.id, foldApplication(app.id, byApp.get(app.id) ?? []));
	}
	return result;
}
