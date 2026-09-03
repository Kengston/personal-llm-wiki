/**
 * hh.ts — канал добычи `hh` ([ADR-0031]).
 *
 * Здесь нет сети и не может быть. Публичный API hh закрыт (`403` без токена приложения),
 * а ходить в него с куками живой сессии владельца запрещено ([ADR-0009]). Поэтому вход
 * этого модуля — уже снятые со страницы типизированные поля, а не URL: страницу открывает
 * человек, `HH_SERP_EXTRACTOR` снимает с карточек фиксированный набор значений, и дальше
 * работают чистые функции.
 *
 * Три вещи, которые здесь неочевидны и потому названы вслух:
 *
 *   1. ДОМЕНА У hh НЕТ. Карточка отдаёт идентификатор работодателя внутри площадки, а не
 *      сайт компании. Ключ дедупа при этом — домен ([ADR-0029]). Разрыв закрывается
 *      псевдо-доменом `<employerId>.employer.hh.ru`: он уникален на работодателя и честно
 *      говорит, откуда взялся. Выдуманный `<название>.com` соврал бы про адрес и развёл
 *      одну компанию на две записи, а голый `hh.ru` схлопнул бы всех в одну.
 *
 *   2. ИЗВЛЕКАТЕЛЬ ПАДАЕТ ГРОМКО. Он привязан к `data-qa` чужой вёрстки — точка заведомо
 *      хрупкая. Ноль карточек при непустой выдаче должен читаться как поломка прогона, а не
 *      как «сегодня ничего не нашлось»: молчаливый пустой список здесь дороже исключения.
 *
 *   3. НЕИЗВЕСТНОЕ ОСТАЁТСЯ НЕИЗВЕСТНЫМ. Значок «Можно удалённо» — это `remote_country_bound`
 *      (hh-удалёнка почти всегда привязана к стране), а его ОТСУТСТВИЕ — не `onsite`, а
 *      `unknown`: карточка про офис ничего не утверждала. `unknown` компанию не отсеивает
 *      никогда ([ADR-0029] §4), и додумывать за карточку значит терять именно те компании,
 *      про которые методология говорит «узнаётся только в разговоре».
 */

import { z } from 'zod';

import {
	companyIdFromDomain,
	normalizeDomain,
	CompanyRecordSchema,
	OpportunityRecordSchema,
	type CompanyRecord,
	type OpportunityRecord,
} from './companies.js';

/** Версия парсера в провенансе. Меняется вместе с набором селекторов. */
export const HH_PARSER_VERSION = 'hh-serp-1';

/** Пространство имён псевдо-доменов площадки. Настоящим доменом не бывает никогда. */
const HH_EMPLOYER_DOMAIN_SUFFIX = 'employer.hh.ru';

// ---------------------------------------------------------------------------
// Вход: то, что снято со страницы
// ---------------------------------------------------------------------------

/**
 * Карточка выдачи hh — ровно те поля, которые извлекатель снимает с DOM.
 *
 * Свободного текста объявления здесь нет ни одного поля: чужая страница отдаёт наружу
 * только типизированные значения ([ADR-0029] §6), иначе абзац «Ignore previous
 * instructions…» из описания вакансии уезжает в промпт.
 */
export const HhSerpCardSchema = z.object({
	/** Числовой id вакансии как строка: `136857307`. */
	id: z.string().regex(/^\d+$/),
	title: z.string().min(1).max(200),
	employer: z.string().min(1).max(200),
	/** Идентификатор работодателя внутри hh из `/employer/<id>`. */
	employer_id: z.string().regex(/^\d+$/).nullable().default(null),
	/**
	 * Настоящий сайт компании, если он известен ИЗВНЕ карточки (владелец подтвердил,
	 * страница работодателя показала). Карточка выдачи его не содержит.
	 */
	employer_site: z.string().nullable().default(null),
	/** Значок «Можно удалённо». Отсутствие значка — не офис, а неизвестность. */
	remote: z.boolean().default(false),
	/** Вилка как её показала карточка. В запись не идёт — в схеме `opportunity` её нет. */
	salary: z.string().max(120).nullable().default(null),
	experience: z.string().max(80).nullable().default(null),
	address: z.string().max(200).nullable().default(null),
	/** Дата публикации, если площадка её показала. Отсутствие даты информативно. */
	published_at: z.string().nullable().default(null),
	/** «Вы откликнулись» на карточке. Отсеивается ДО показа шорт-листа. */
	applied: z.boolean().default(false),
});

export type HhSerpCard = z.infer<typeof HhSerpCardSchema>;

/**
 * HH_SERP_EXTRACTOR — код извлекателя, который выполняется в открытой владельцем вкладке.
 *
 * Лежит здесь, а не в скилле, ровно по одной причине: селекторы и маппер обязаны меняться
 * вместе. Разъехавшись, они дают худший из возможных отказов — не ошибку, а тихо неполный
 * сбор, который выглядит как законченный.
 *
 * Возвращает `{ declared, total, cards }`:
 * - `declared` — число из шапки выдачи («Найдено 111 вакансий»), то есть сколько вакансий
 *   ЕСТЬ по запросу;
 * - `total` — сколько карточек оказалось в DOM на момент снятия;
 * - `cards` — сами карточки в форме `HhSerpCard` (без нормализации — её делает `parseHhCards`).
 *
 * Из шапки берётся ПЕРВОЕ число не случайно: к «Найдено 11 вакансий «промпт»» hh дописывает
 * подсказку «По запросу промыт найдется 62 вакансии», и второе число относится к ЧУЖОМУ
 * запросу — исправленному за тебя. Взять последнее или сумму значит отчитаться о выдаче,
 * которую никто не запрашивал.
 *
 * `declared` нужен не для отчёта, а как детектор недосбора: страница hh дорисовывается
 * асинхронно, и снятие через 3 секунды после навигации отдало 20 карточек там, где через
 * 4 секунды их оказалось 50 (проверено 01.09.2026). Ошибка не выглядит ошибкой — список
 * просто короче. Правило: `total` должен быть равен размеру страницы (50) либо остатку
 * `declared` на последней странице; расхождение — пересобрать, а не идти дальше.
 */
export const HH_SERP_EXTRACTOR = `(() => {
  const cards = [...document.querySelectorAll('[data-qa~="vacancy-serp__vacancy"]')];
  const text = (c, s) => { const e = c.querySelector(s); return e ? e.textContent.trim() : null; };
  const out = cards.map((c) => {
    const link = c.querySelector('[data-qa="serp-item__title"]');
    const emp = c.querySelector('[data-qa="vacancy-serp__vacancy-employer"]');
    const salary = (c.innerText.match(/\\d[\\d\\s  ]*(?:–|-|от|до)?[\\d\\s  ]*(?:₽|\\$|€|руб)/) || [null])[0];
    return {
      id: ((link && link.href) || '').match(/vacancy\\/(\\d+)/)?.[1] || null,
      title: text(c, '[data-qa="serp-item__title-text"]'),
      employer: text(c, '[data-qa="vacancy-serp__vacancy-employer-text"]'),
      employer_id: ((emp && emp.getAttribute('href')) || '').match(/employer\\/(\\d+)/)?.[1] || null,
      employer_site: null,
      remote: !!c.querySelector('[data-qa="vacancy-label-work-schedule-remote"]'),
      salary: salary ? salary.trim().slice(0, 120) : null,
      experience: text(c, '[data-qa^="vacancy-serp__vacancy-work-experience"]'),
      address: text(c, '[data-qa="vacancy-serp__vacancy-address"]'),
      published_at: text(c, '[data-qa="vacancy-serp__vacancy-date"]'),
      // Маркер «уже откликался». data-qa="vacancy-serp__vacancy_response-done" МЁРТВ:
      // проверено 02.09.2026, hh его больше не рендерит, и старая проверка возвращала
      // applied:false на КАЖДОЙ карточке, включая вакансии с состоявшимся откликом.
      // Живой признак двойной: у откликнутой карточки нет кнопки отклика И есть текст
      // «Вы откликнулись». Пробел в этой фразе неразрывный, поэтому \\s+, а не пробел.
      applied:
        !c.querySelector('[data-qa="vacancy-serp__vacancy_response"]') ||
        /Вы\\s+откликнулись/.test(c.innerText),
    };
  });
  const header = document.querySelector('[data-qa="vacancies-search-header"]');
  const declared = header ? Number((header.textContent.match(/\\d[\\d\\s  ]*/) || ['0'])[0].replace(/\\D/g, '')) : null;
  return { declared: declared, total: cards.length, cards: out };
})()`;

// ---------------------------------------------------------------------------
// Идентификаторы и ссылки
// ---------------------------------------------------------------------------

/**
 * hhExternalId — внешний идентификатор вакансии для `opportunity.external_id`.
 *
 * Буквенный префикс БЕЗ разделителя, как у `li…`: голое число в свободном тексте
 * маскируется санитайзером как телефон, и ссылка превращается в `[REDACTED:phone]`.
 */
export function hhExternalId(vacancyId: string): string {
	return `hh${vacancyId}`;
}

/** hhVacancyUrl — публичная страница вакансии. Без query: параметры поиска в провенанс не идут. */
export function hhVacancyUrl(vacancyId: string): string {
	return `https://hh.ru/vacancy/${vacancyId}`;
}

/**
 * hhEmployerDomain — ключ дедупа для работодателя с hh.
 *
 * Настоящий домен, если он известен; иначе пространство имён площадки. Третьего варианта
 * нет: `hh.ru` схлопнул бы всех работодателей в одну компанию, а `<название>.com` — ложь
 * про адрес, которая разводит одну компанию на две записи ([ADR-0031] §3).
 */
export function hhEmployerDomain(
	card: Pick<HhSerpCard, 'employer_site' | 'employer_id'>,
): string | null {
	if (card.employer_site) {
		const domain = normalizeDomain(card.employer_site);
		if (domain) return domain;
	}
	return card.employer_id ? `${card.employer_id}.${HH_EMPLOYER_DOMAIN_SUFFIX}` : null;
}

/** isHhPseudoDomain — домен ещё не подтверждён, компания может дублировать запись из LinkedIn. */
export function isHhPseudoDomain(domain: string): boolean {
	return domain.endsWith(`.${HH_EMPLOYER_DOMAIN_SUFFIX}`);
}

/**
 * buildHhSearchUrl — ссылка на выдачу, которую открывает владелец.
 *
 * `search_field: 'name'` по умолчанию не оптимизация, а условие осмысленности: в общем
 * режиме запрос «AI Engineer» возвращает и «B2B-маркетолог» — hh ищет по всему тексту
 * объявления, включая абзац «мы используем AI» в описании компании.
 */
export function buildHhSearchUrl(params: {
	text: string;
	/** Искать только по названию должности. Выключать осознанно. */
	byTitle?: boolean;
	/** Только удалённые. */
	remote?: boolean;
	/** Код региона hh (`113` — Россия). Не указан — все регионы. */
	area?: string;
	/** Глубина в днях: 1, 3, 7, 30. */
	periodDays?: 1 | 3 | 7 | 30;
	page?: number;
}): string {
	const url = new URL('https://hh.ru/search/vacancy');
	url.searchParams.set('text', params.text);
	url.searchParams.set('order_by', 'publication_time');
	if (params.byTitle !== false) url.searchParams.set('search_field', 'name');
	if (params.remote) url.searchParams.set('schedule', 'remote');
	if (params.area) url.searchParams.set('area', params.area);
	if (params.periodDays) url.searchParams.set('search_period', String(params.periodDays));
	if (params.page) url.searchParams.set('page', String(params.page));
	return url.toString();
}

// ---------------------------------------------------------------------------
// Разделение выдачи по географии
// ---------------------------------------------------------------------------

/**
 * Группа вакансии в порядке обхода.
 *
 * `priority` — страны, где владелец живёт и может выйти в офис; `foreign` — остальной
 * зарубеж (только удалённо); `ru` — Россия.
 */
export type HhGeo = 'priority' | 'foreign' | 'ru';

/** Коды стран из публичного справочника `https://api.hh.ru/areas/countries`. */
export const HH_AREA = {
	RUSSIA: '113',
	SERBIA: '146',
	CYPRUS: '236',
} as const;

/**
 * Приоритетные страны по умолчанию — там, где владелец живёт.
 *
 * Список короткий и лежит здесь как дефолт, а не как истина: рабочий перечень задаётся
 * роадмапом и передаётся аргументом. Меняется место жизни — правится роадмап, не код.
 */
export const HH_PRIORITY_AREAS: readonly string[] = [HH_AREA.SERBIA];

/**
 * buildHhGeoSearchSet — набор запросов, из которых складывается порядок обхода.
 *
 * Три вида запросов, и разница между ними не косметическая:
 *
 *   1. НА КАЖДУЮ ПРИОРИТЕТНУЮ СТРАНУ — свой запрос, и в нём **фильтр удалёнки снят**.
 *      Владелец живёт в Сербии, поэтому сербская вакансия в офисе или гибриде ему подходит
 *      ровно так же, как удалённая; оставить здесь `schedule=remote` значит отбросить
 *      половину лучшей группы своими руками.
 *   2. ВСЁ (без региона) — знаменатель, из которого вычитается остальное.
 *   3. РОССИЯ (`area=113`) — то, что уходит в конец очереди.
 *
 * Географию во всех трёх случаях считает САМА ПЛОЩАДКА. Разбор строки адреса с карточки
 * («эмират Дубай, Хадаэк Мухаммед Бин Рашид, Барша Хайтс, Tameem House», «Нижний Новгород»,
 * «Сербия») — угадывание с тихими промахами, и его здесь нет.
 *
 * Проверено 01.09.2026 на «AI Engineer»: 111 всего с удалёнкой, 79 по `area=113`
 * (то есть 32 зарубежные), 3 по `area=146` без фильтра удалёнки.
 */
export function buildHhGeoSearchSet(
	params: Omit<Parameters<typeof buildHhSearchUrl>[0], 'area'>,
	priorityAreas: readonly string[] = HH_PRIORITY_AREAS,
): { priority: { area: string; url: string }[]; all: string; russia: string } {
	return {
		priority: priorityAreas.map((area) => ({
			area,
			// Осознанно без `remote`: в стране проживания офис подходит.
			url: buildHhSearchUrl({ ...params, area, remote: false }),
		})),
		all: buildHhSearchUrl(params),
		russia: buildHhSearchUrl({ ...params, area: HH_AREA.RUSSIA }),
	};
}

/**
 * partitionHhByGeo — разложить выдачу на три группы.
 *
 * Приоритетные вакансии приходят СВОИМ списком (у них свой запрос, без фильтра удалёнки),
 * поэтому их может не быть в общей выдаче — и дедуп по `id` здесь обязателен, иначе
 * сербская удалённая вакансия попадёт в список дважды и будет предложена к подаче дважды.
 *
 * Российские вычитаются, всё непонятое остаётся в `foreign`. Направление вычитания выбрано
 * так, чтобы незнание играло в пользу владельца: незнакомая вакансия будет ПОКАЗАНА, а не
 * отброшена. Обратная схема («зарубежное = найденное по списку из 164 стран») молча теряет
 * вакансию, чью страну забыли перечислить, и заметить это нечем.
 */
export function partitionHhByGeo<T extends Pick<HhSerpCard, 'id'>>(
	cards: { priority?: T[]; all: T[] },
	russianIds: Iterable<string>,
): Record<HhGeo, T[]> {
	const ru = new Set(russianIds);
	const seen = new Set<string>();
	const out: Record<HhGeo, T[]> = { priority: [], foreign: [], ru: [] };

	for (const card of cards.priority ?? []) {
		if (seen.has(card.id)) continue;
		seen.add(card.id);
		out.priority.push(card);
	}
	for (const card of cards.all) {
		if (seen.has(card.id)) continue;
		seen.add(card.id);
		out[ru.has(card.id) ? 'ru' : 'foreign'].push(card);
	}

	return out;
}

/**
 * orderHhByGeo — порядок обхода: Сербия → остальной зарубеж → Россия.
 *
 * Порядок важен потому, что дневная квота откликов конечна. Российские вакансии первыми
 * сожгут её раньше, чем прогон дойдёт до зарубежных; зарубежные первыми — раньше, чем он
 * дойдёт до страны проживания, где у владельца лучшие шансы (нет вопроса о разрешении на
 * работу и о часовых поясах).
 *
 * Сортировка устойчивая: внутри группы сохраняется порядок выдачи, то есть
 * `order_by=publication_time` продолжает работать.
 */
export function orderHhByGeo<T extends Pick<HhSerpCard, 'id'>>(
	cards: { priority?: T[]; all: T[] },
	russianIds: Iterable<string>,
): T[] {
	const split = partitionHhByGeo(cards, russianIds);
	return [...split.priority, ...split.foreign, ...split.ru];
}

// ---------------------------------------------------------------------------
// Перебор специализаций
// ---------------------------------------------------------------------------

/**
 * Один шаг перебора: запрос по названию должности и его география.
 *
 * Перебор нужен не для полноты ради полноты. `search_field=name` — жёсткий фильтр по
 * заголовку вакансии, и это условие того, что выдача вообще про роль (без него «AI Engineer»
 * возвращает «B2B-маркетолог»). Обратная сторона жёсткости: строка «AI Engineer» физически
 * не видит вакансию «AI-инженер», «Инженер агентных систем» или «LLM-разработчик» — это
 * ДРУГИЕ заголовки. Одна формулировка = одна прорезь; рынок виден только через все.
 */
export interface HhSweepStep {
	query: string;
	geo: ReturnType<typeof buildHhGeoSearchSet>;
}

/**
 * buildHhSweep — набор запросов на все специализации владельца.
 *
 * Список формулировок — ФАКТ О ВЛАДЕЛЬЦЕ и живёт в роадмапе, а не здесь: меняется
 * позиционирование — правится роадмап. Сюда он приходит аргументом.
 *
 * Порядок списка сохраняется: первая формулировка — основная специализация, и её выдача
 * обходится раньше. Но география важнее специализации: сербская вакансия по запасной роли
 * идёт раньше зарубежной по основной — см. `orderHhByGeo`, который применяется К СВЕДЁННОМУ
 * результату перебора, а не к каждому запросу по отдельности.
 */
export function buildHhSweep(
	queries: readonly string[],
	params: Omit<Parameters<typeof buildHhSearchUrl>[0], 'text' | 'area'>,
	priorityAreas: readonly string[] = HH_PRIORITY_AREAS,
): HhSweepStep[] {
	return queries.map((query) => ({
		query,
		geo: buildHhGeoSearchSet({ ...params, text: query }, priorityAreas),
	}));
}

/**
 * dedupeHhCards — свести выдачи всех запросов в один список.
 *
 * Пересечения гарантированы и это норма: «AI Engineer» и «LLM Engineer» вернут одну и ту же
 * вакансию «Senior AI/LLM Engineer». Без дедупа она попадёт в шорт-лист дважды и будет
 * предложена к подаче дважды — а повторный отклик в ту же компанию читается как спам.
 *
 * Порядок первого вхождения сохраняется: вакансия остаётся там, где её нашли раньше.
 */
export function dedupeHhCards<T extends Pick<HhSerpCard, 'id'>>(...lists: T[][]): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const list of lists) {
		for (const card of list) {
			if (seen.has(card.id)) continue;
			seen.add(card.id);
			out.push(card);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Маппинг в записи леджера
// ---------------------------------------------------------------------------

/** Что вернул маппер: записи и то, что он выбросил и почему. */
export interface HhMapResult {
	companies: CompanyRecord[];
	opportunities: OpportunityRecord[];
	/** Карточки без id вакансии или без работодателя — заводить нечего. */
	skipped: number;
	/** Вакансии, где на карточке уже стоит «Вы откликнулись». */
	alreadyApplied: HhSerpCard[];
}

/**
 * parseHhCards — нормализация сырья извлекателя. Мусорная карточка выбрасывается,
 * прогон не падает: чужая вёрстка меняется, и одна кривая карточка не повод потерять сорок.
 */
export function parseHhCards(raw: unknown[]): { cards: HhSerpCard[]; skipped: number } {
	const cards: HhSerpCard[] = [];
	let skipped = 0;
	for (const item of raw) {
		const parsed = HhSerpCardSchema.safeParse(item);
		if (parsed.success) cards.push(parsed.data);
		else skipped++;
	}
	return { cards, skipped };
}

/**
 * mapHhCards — карточки выдачи → записи `company` + `opportunity`.
 *
 * Все извлечённые признаки кладутся с `confirmed_by_human: false`: это то, что НАПИСАНО
 * в карточке, а не то, что сказал человек. Разница — основа отсева ([ADR-0029] §3), и
 * особенно она важна для `work_permit_required`, которое карточка hh не утверждает вовсе.
 *
 * @param cards     — нормализованные карточки
 * @param fetchedAt — момент снятия (ISO); инъекция вместо часов внутри
 */
export function mapHhCards(cards: HhSerpCard[], fetchedAt: string): HhMapResult {
	const companies = new Map<string, CompanyRecord>();
	const opportunities: OpportunityRecord[] = [];
	const alreadyApplied: HhSerpCard[] = [];
	let skipped = 0;

	const unknown = <T extends string>(value: T) => ({
		value,
		source: 'hh' as const,
		confirmed_by_human: false,
		confirmed_at: null,
	});

	for (const card of cards) {
		const domain = hhEmployerDomain(card);
		if (!domain) {
			// Без домена нет ключа дедупа — запись завела бы дубль при следующем прогоне.
			skipped++;
			continue;
		}

		if (card.applied) alreadyApplied.push(card);

		const companyId = companyIdFromDomain(domain);
		if (!companies.has(domain)) {
			companies.set(
				domain,
				CompanyRecordSchema.parse({
					id: companyId,
					site_domain: domain,
					name: card.employer,
					company_type: unknown('unknown'),
					stage: unknown('unknown'),
					// Значок удалёнки — про режим работы вакансии, и он привязан к стране:
					// WFA на hh не бывает, а его отсутствие ничего не утверждает про офис.
					remote_mode: card.remote ? unknown('remote_country_bound') : unknown('unknown'),
					hires_contractors: unknown('unknown'),
					work_permit_required: unknown('unknown'),
					// Площадка русскоязычная — но язык интервью из этого не следует.
					interview_language: unknown('unknown'),
					hq_country: unknown('unknown'),
					timezone_overlap: unknown('unknown'),
					has_warm_contact: unknown('unknown'),
					// Вакансия висит в выдаче — значит наём идёт. Единственное, что карточка
					// действительно утверждает про компанию.
					hiring_status: unknown('active'),
					fit_rank: 0,
					provenance: {
						company_source: 'hh',
						source_url: hhVacancyUrl(card.id),
						fetched_at: fetchedAt,
						parser_version: HH_PARSER_VERSION,
						// Ни одного HTTP-запроса от нашего кода к hh не уходит: страницу
						// открыл человек. Поле означает «автоматической загрузки не было».
						robots_ok: true,
					},
					ts: fetchedAt,
				}),
			);
		}

		opportunities.push(
			OpportunityRecordSchema.parse({
				id: hhExternalId(card.id),
				company_id: companyId,
				title: card.title,
				source_url: hhVacancyUrl(card.id),
				external_id: hhExternalId(card.id),
				posted_at: card.published_at,
				fetched_at: fetchedAt,
				// Карточка hh про форму занятости не говорит: и штат, и подряд выглядят одинаково.
				employment_type: 'unknown',
				remote_mode: card.remote ? 'remote_country_bound' : 'unknown',
				company_source: 'hh',
				ts: fetchedAt,
			}),
		);
	}

	return { companies: [...companies.values()], opportunities, skipped, alreadyApplied };
}
