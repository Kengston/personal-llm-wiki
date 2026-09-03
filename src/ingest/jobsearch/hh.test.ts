/**
 * hh.test.ts — канал добычи `hh` ([ADR-0031]).
 *
 * Проверяются ровно те швы, которые ADR называет в «Следствиях» и §3: псевдо-домен не
 * схлопывает работодателей и не выдумывает адрес, настоящий домен побеждает псевдо-,
 * идентификатор вакансии переживает санитайзер, отсутствие значка удалёнки НЕ становится
 * офисом, уже поданные вакансии отделяются от новых, зарубежные вакансии обходятся раньше
 * российских, а источник `hh` принимается схемой ОТКЛИКА — не только схемой компании.
 *
 * Живой сети здесь нет и быть не может: вход модуля — уже снятые со страницы поля.
 * Данные синтетические.
 */

import { describe, expect, it } from 'vitest';

import { failClosedSanitize } from '../sanitizer.js';
import { COMPANY_SOURCES } from './companies.js';
import { ApplicationRecordSchema } from './events.js';
import {
	buildHhGeoSearchSet,
	buildHhSearchUrl,
	buildHhSweep,
	dedupeHhCards,
	HH_AREA,
	orderHhByGeo,
	partitionHhByGeo,
	hhEmployerDomain,
	hhExternalId,
	hhVacancyUrl,
	isHhPseudoDomain,
	mapHhCards,
	parseHhCards,
	type HhSerpCard,
} from './hh.js';

const AT = '2026-09-01T10:00:00.000Z';

function card(over: Partial<HhSerpCard> = {}): HhSerpCard {
	return {
		id: '136857307',
		title: 'AI Engineer',
		employer: 'Acme',
		employer_id: '3162844',
		employer_site: null,
		remote: true,
		salary: null,
		experience: null,
		address: null,
		published_at: null,
		applied: false,
		...over,
	};
}

describe('hh: домен и идентификаторы', () => {
	it('без известного сайта даёт псевдо-домен в пространстве имён площадки', () => {
		const domain = hhEmployerDomain({ employer_id: '3162844', employer_site: null });

		expect(domain).toBe('3162844.employer.hh.ru');
		expect(isHhPseudoDomain(domain!)).toBe(true);
	});

	it('разные работодатели не схлопываются в hh.ru', () => {
		const a = hhEmployerDomain({ employer_id: '1', employer_site: null });
		const b = hhEmployerDomain({ employer_id: '2', employer_site: null });

		expect(a).not.toBe(b);
		expect(a).not.toBe('hh.ru');
	});

	it('настоящий сайт побеждает псевдо-домен — компания склеится с записью из LinkedIn', () => {
		const domain = hhEmployerDomain({
			employer_id: '3162844',
			employer_site: 'https://www.acme.com/jobs',
		});

		expect(domain).toBe('acme.com');
		expect(isHhPseudoDomain(domain!)).toBe(false);
	});

	it('идентификатор вакансии переживает санитайзер, голое 10-значное число — нет', () => {
		expect(hhExternalId('136857307')).toBe('hh136857307');
		expect(failClosedSanitize('вакансия hh136857307 в работе')).toContain('hh136857307');

		// Сегодняшний id hh — 9 знаков, и под телефонную эвристику он ещё не попадает.
		// Префикс стоит не поэтому: он снимает вопрос на 10-м знаке, до которого площадке
		// осталось меньше порядка, и делает поле одинаковым с `li…`.
		expect(failClosedSanitize('вакансия hh1368573070 в работе')).toContain('hh1368573070');
		expect(failClosedSanitize('вакансия 1368573070 в работе')).not.toContain('1368573070');
	});

	it('ссылка на вакансию идёт без query', () => {
		expect(hhVacancyUrl('136857307')).toBe('https://hh.ru/vacancy/136857307');
	});
});

describe('hh: ссылка на выдачу', () => {
	it('по умолчанию ищет по названию должности — иначе выдача не про роль', () => {
		const url = new URL(buildHhSearchUrl({ text: 'AI Engineer', remote: true }));

		expect(url.searchParams.get('search_field')).toBe('name');
		expect(url.searchParams.get('schedule')).toBe('remote');
		expect(url.searchParams.get('order_by')).toBe('publication_time');
	});

	it('поиск по всему тексту включается только явно', () => {
		const url = new URL(buildHhSearchUrl({ text: 'AI Engineer', byTitle: false }));

		expect(url.searchParams.has('search_field')).toBe(false);
	});
});

describe('hh: география — Сербия, зарубеж, Россия', () => {
	it('запрос по стране проживания идёт БЕЗ фильтра удалёнки', () => {
		const set = buildHhGeoSearchSet({ text: 'AI Engineer', remote: true });
		const serbia = new URL(set.priority[0]!.url);

		// Владелец живёт в Сербии: офис и гибрид там подходят так же, как удалёнка.
		// `schedule=remote` здесь отбросил бы половину лучшей группы.
		expect(serbia.searchParams.get('area')).toBe(HH_AREA.SERBIA);
		expect(serbia.searchParams.has('schedule')).toBe(false);

		// Для остального мира удалёнка обязательна — там живут по-другому.
		expect(new URL(set.all).searchParams.get('schedule')).toBe('remote');
		expect(new URL(set.all).searchParams.has('area')).toBe(false);
		expect(new URL(set.russia).searchParams.get('area')).toBe(HH_AREA.RUSSIA);
	});

	it('порядок обхода: Сербия → остальной зарубеж → Россия', () => {
		const cards = {
			priority: [{ id: 'rs1' }],
			all: [{ id: 'ru1' }, { id: 'f1' }, { id: 'ru2' }, { id: 'f2' }],
		};

		// Квота конечна: российские первыми сожгут её до зарубежных, зарубежные —
		// до страны проживания, где шансы выше всего.
		expect(orderHhByGeo(cards, ['ru1', 'ru2']).map((c) => c.id)).toEqual([
			'rs1',
			'f1',
			'f2',
			'ru1',
			'ru2',
		]);
	});

	it('сербская вакансия не задваивается, попав и в свою выдачу, и в общую', () => {
		const cards = { priority: [{ id: 'rs1' }], all: [{ id: 'rs1' }, { id: 'f1' }] };

		const split = partitionHhByGeo(cards, []);

		expect(split.priority.map((c) => c.id)).toEqual(['rs1']);
		expect(split.foreign.map((c) => c.id)).toEqual(['f1']);
	});

	it('незнакомая вакансия попадает в зарубежные, а не теряется', () => {
		// Незнание играет в пользу владельца: вакансию покажут, а не отбросят.
		const split = partitionHhByGeo({ all: [{ id: 'неизвестная' }] }, []);

		expect(split.foreign).toHaveLength(1);
		expect(split.ru).toHaveLength(0);
	});

	it('внутри группы сохраняется порядок выдачи — order_by=publication_time не ломается', () => {
		expect(
			orderHhByGeo({ all: [{ id: 'свежая' }, { id: 'старая' }] }, []).map((c) => c.id),
		).toEqual(['свежая', 'старая']);
	});
});

describe('hh: перебор специализаций', () => {
	it('каждая формулировка получает свой набор запросов', () => {
		const sweep = buildHhSweep(['AI Engineer', 'AI-инженер'], { remote: true });

		expect(sweep.map((s) => s.query)).toEqual(['AI Engineer', 'AI-инженер']);
		// `search_field=name` — жёсткий фильтр по заголовку, поэтому «AI Engineer»
		// физически не видит вакансию «AI-инженер». Одна формулировка = одна прорезь.
		expect(new URL(sweep[1]!.geo.all).searchParams.get('text')).toBe('AI-инженер');
		expect(new URL(sweep[1]!.geo.all).searchParams.get('search_field')).toBe('name');
	});

	it('одна вакансия из двух выдач не задваивается', () => {
		// «Senior AI/LLM Engineer» вернётся и по «AI Engineer», и по «LLM Engineer».
		// Повторный отклик в ту же компанию читается рекрутером как спам.
		const merged = dedupeHhCards([{ id: '1' }, { id: '2' }], [{ id: '2' }, { id: '3' }]);

		expect(merged.map((c) => c.id)).toEqual(['1', '2', '3']);
	});
});

describe('hh: маппинг карточек в записи', () => {
	it('две вакансии одного работодателя дают одну компанию и две зацепки', () => {
		const result = mapHhCards([card(), card({ id: '2', title: 'LLM Engineer' })], AT);

		expect(result.companies).toHaveLength(1);
		expect(result.opportunities).toHaveLength(2);
		expect(result.companies[0]!.site_domain).toBe('3162844.employer.hh.ru');
		expect(result.opportunities.map((o) => o.id)).toEqual(['hh136857307', 'hh2']);
	});

	it('отсутствие значка удалёнки — это unknown, а не офис', () => {
		const result = mapHhCards([card({ remote: false })], AT);

		// onsite отсеял бы компанию гейтом ([ADR-0029] §4), а карточка про офис
		// ничего не утверждала.
		expect(result.companies[0]!.remote_mode.value).toBe('unknown');
		expect(result.opportunities[0]!.remote_mode).toBe('unknown');
	});

	it('значок удалёнки — country_bound, а не wfa: на hh удалёнка привязана к стране', () => {
		const result = mapHhCards([card({ remote: true })], AT);

		expect(result.companies[0]!.remote_mode.value).toBe('remote_country_bound');
	});

	it('все признаки помечены как неподтверждённые человеком', () => {
		const company = mapHhCards([card()], AT).companies[0]!;

		expect(company.work_permit_required.value).toBe('unknown');
		expect(company.work_permit_required.confirmed_by_human).toBe(false);
		expect(company.remote_mode.confirmed_by_human).toBe(false);
		expect(company.provenance.company_source).toBe('hh');
		expect(company.provenance.parser_version).toBe('hh-serp-1');
	});

	it('уже поданные вакансии отделяются, а не теряются молча', () => {
		const result = mapHhCards([card({ applied: true }), card({ id: '2', employer_id: '9' })], AT);

		expect(result.alreadyApplied.map((c) => c.id)).toEqual(['136857307']);
		expect(result.opportunities).toHaveLength(2);
	});

	it('карточка без работодателя выбрасывается со счётчиком, а не заводит дубль', () => {
		const result = mapHhCards([card({ employer_id: null, employer_site: null })], AT);

		expect(result.companies).toHaveLength(0);
		expect(result.skipped).toBe(1);
	});

	it('дата публикации остаётся null, если карточка её не показала', () => {
		expect(mapHhCards([card()], AT).opportunities[0]!.posted_at).toBeNull();
	});
});

describe('hh: нормализация сырья извлекателя', () => {
	it('кривая карточка выбрасывается, прогон не падает', () => {
		const { cards, skipped } = parseHhCards([
			{ id: '1', title: 'AI Engineer', employer: 'Acme', employer_id: '7' },
			{ id: 'не-число', title: 'AI Engineer', employer: 'Acme' },
			{ title: 'без id' },
		]);

		expect(cards).toHaveLength(1);
		expect(skipped).toBe(2);
	});
});

describe('hh: словарь источников един для компании и отклика', () => {
	it('источник hh принимается схемой ОТКЛИКА, а не только схемой компании', () => {
		// Именно здесь дубль литерала разъезжался: компания заводилась, отклик падал
		// на валидации — то есть уже ПОСЛЕ отправки ([ADR-0031] §1).
		const application = ApplicationRecordSchema.safeParse({
			id: 'acme-ai-engineer',
			company_id: '3162844-employer-hh-ru',
			role_title: 'AI Engineer',
			company_source: 'hh',
			submission_channel: 'direct',
			vacancy_ref: hhVacancyUrl('136857307'),
			applied_at: AT,
			ts: AT,
		});

		expect(application.success).toBe(true);
		expect(COMPANY_SOURCES).toContain('hh');
	});
});
