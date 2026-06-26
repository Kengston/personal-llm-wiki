/**
 * scripts/finance-smoke.mjs — РУЧНОЙ живой end-to-end смоук финансового модуля.
 *
 * Гоняет РЕАЛЬНЫЙ движок (claude -p, как в проде) через тот же системный промпт и ту
 * же finance-intent проводку, что и мост (main.ts/app.ts), но в ИЗОЛИРОВАННОЙ песочнице
 * (temp CONTENT_ROOT). Приватный контент-репо НЕ затрагивается.
 *
 * Двойная цель:
 *   1) FINANCE — финансовые сообщения корректно распознаются и пишутся в леджер песочницы.
 *   2) РЕГРЕСС  — НЕфинансовые сообщения (приветствия, напоминания, вопросы-воспоминания)
 *      НЕ порождают finance-intent (intent === null), т.е. обычный ответ движка НЕ
 *      подменяется finance-readback'ом. Это и есть проверка «финансы не сломали бота».
 *
 * Запуск:  pnpm build && node scripts/finance-smoke.mjs
 * (нужен установленный и авторизованный бинарь `claude`; реальная сеть к Anthropic.)
 *
 * Все данные ниже — СИНТЕТИЧЕСКИЕ примеры (no PII).
 */
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const imp = (p) => import(pathToFileURL(join(DIST, p)).href);

// --- Изолированная песочница: все финданные пишутся сюда, НЕ в приватный репо ---
const sandbox = mkdtempSync(join(tmpdir(), 'fin-smoke-'));
const rawFinance = join(sandbox, 'raw', 'finance');
const goalsDir = join(sandbox, 'wiki', 'finance', 'goals');
const stateDir = join(sandbox, '.finance-state');
process.env.FINANCE_RAW_DIR = rawFinance; // resolveFinanceDir() уважает → path-guard разрешит запись в песочницу
process.env.CONTENT_ROOT = sandbox;
process.env.WIKI_REPO_PATH = sandbox; // движок требует путь приватного репо (capture-write, ADR-0015)
console.log('SANDBOX:', sandbox);

const { Ledger } = await imp('ingest/finance/ledger.js');
const { buildEngineFromEnv } = await imp('bridge/engine.js');
const { loadPersona, appendFinanceInstruction } = await imp('bridge/prompt.js');
const { extractFinanceIntent, dispatchFinanceIntent, buildFinanceContextSummary, formatReadback } =
  await imp('bridge/finance-intent.js');

const ledger = new Ledger({ env: process.env });
const nowFn = () => new Date();

// Системный промпт — РОВНО как собирает main.ts (персона + контекст + finance-инструкция).
function buildSystemPrompt() {
  const persona = loadPersona();
  const ctx = buildFinanceContextSummary(ledger, goalsDir);
  return appendFinanceInstruction(persona, ctx);
}

// --- FINANCE-сценарии: ДОЛЖНЫ дать корректный intent + запись ---
const financeScenarios = [
  { tag: 'S1 баланс+наличка', msg: 'На карте Тинькофф 50000 рублей. И ещё наличными 5 миллионов вьетнамских донгов.' },
  { tag: 'S2 доход', msg: 'Пришла зарплата 200000 рублей на карту Тинькофф.' },
  { tag: 'S3 цель', msg: 'Хочу накопить 1000000 рублей к 1 декабря 2027 года на квартиру.' },
  { tag: 'S4 кредит', msg: 'Взял кредит в Сбере 600000 рублей под 18 процентов годовых, ежемесячный платёж 20000 рублей, следующий платёж 10 июля 2026, аннуитетный.' },
  { tag: 'S5 Q&A net-worth', msg: 'Какой у меня сейчас net worth?' },
  { tag: 'S6 Q&A прогресс цели', msg: 'Сколько я уже накопил на цель по квартире и какой процент выполнен?' },
  { tag: 'S7 правка', msg: 'Поправь: на карте Тинькофф сейчас 60000 рублей, а не 50000.' },
];

// --- РЕГРЕСС: НЕфинансовые сообщения — intent ДОЛЖЕН быть null (обычный ответ не подменяется) ---
const regressionScenarios = [
  { tag: 'R1 приветствие', msg: 'Привет! Как дела?' },
  { tag: 'R2 напоминание', msg: 'Напомни мне завтра в 10 утра позвонить маме.' },
  { tag: 'R3 вопрос-воспоминание', msg: 'Что я делал на прошлой неделе по проекту?' },
  { tag: 'R4 захват идеи', msg: 'Запиши идею: сделать мобильное приложение для трекинга привычек.' },
  { tag: 'R5 ложный триггер', msg: 'Сегодня весь день работал над задачей, очень устал.' },
];

const summary = [];

console.log('\n############ FINANCE (ожидаем корректный intent) ############');
for (const sc of financeScenarios) {
  console.log(`\n### ${sc.tag}\nUSER: ${sc.msg}`);
  try {
    const engine = await buildEngineFromEnv(process.env, { systemPrompt: buildSystemPrompt() });
    const res = await engine.run(sc.msg, null);
    const intent = extractFinanceIntent(res.answer);
    if (!intent) {
      console.log('⚠️ NO finance-intent. Ответ:', res.answer.slice(0, 300));
      summary.push({ kind: 'finance', tag: sc.tag, ok: false, detail: 'нет intent' });
      continue;
    }
    const dr = await dispatchFinanceIntent(intent, { ledger, goalsDir, financeStateDir: stateDir, nowFn });
    console.log(`✔ intent=${intent.type}${intent.query_kind ? '/' + intent.query_kind : ''}`);
    console.log('READBACK:', formatReadback(dr).replace(/\n/g, ' | '));
    summary.push({ kind: 'finance', tag: sc.tag, ok: true, detail: intent.type + (intent.query_kind ? '/' + intent.query_kind : '') });
  } catch (err) {
    console.log('💥', String(err).slice(0, 300));
    summary.push({ kind: 'finance', tag: sc.tag, ok: false, detail: 'ERROR' });
  }
}

console.log('\n############ РЕГРЕСС (ожидаем intent === null, обычный ответ цел) ############');
for (const sc of regressionScenarios) {
  console.log(`\n### ${sc.tag}\nUSER: ${sc.msg}`);
  try {
    const engine = await buildEngineFromEnv(process.env, { systemPrompt: buildSystemPrompt() });
    const res = await engine.run(sc.msg, null);
    const intent = extractFinanceIntent(res.answer);
    if (intent) {
      // РЕГРЕСС: финансы перехватили НЕфинансовое сообщение → реальный ответ был бы подменён.
      console.log(`❌ РЕГРЕСС: эмитнут finance-intent (${intent.type}) на НЕфинансовое сообщение!`);
      summary.push({ kind: 'regress', tag: sc.tag, ok: false, detail: `ложный intent ${intent.type}` });
    } else {
      console.log('✔ intent=null. Обычный ответ:', res.answer.slice(0, 200).replace(/\n/g, ' '));
      summary.push({ kind: 'regress', tag: sc.tag, ok: true, detail: 'обычный ответ сохранён' });
    }
  } catch (err) {
    console.log('💥', String(err).slice(0, 300));
    summary.push({ kind: 'regress', tag: sc.tag, ok: false, detail: 'ERROR' });
  }
}

// --- Дамп леджера песочницы ---
console.log('\n############ ЛЕДЖЕР ПЕСОЧНИЦЫ ############');
for (const f of ['accounts', 'snapshots', 'transactions', 'credits', 'fx_rates']) {
  const p = join(rawFinance, `${f}.jsonl`);
  if (existsSync(p)) {
    const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
    console.log(`-- ${f}.jsonl (${lines.length}) --`);
  }
}
if (existsSync(goalsDir)) console.log('-- finance-goal:', readdirSync(goalsDir).join(', '));

// --- Итог ---
console.log('\n############ СВОДКА ############');
for (const s of summary) console.log(`  ${s.ok ? '✅' : '❌'} [${s.kind}] ${s.tag} → ${s.detail}`);
const finOk = summary.filter((s) => s.kind === 'finance' && s.ok).length;
const finTot = summary.filter((s) => s.kind === 'finance').length;
const regOk = summary.filter((s) => s.kind === 'regress' && s.ok).length;
const regTot = summary.filter((s) => s.kind === 'regress').length;
console.log(`\nFINANCE: ${finOk}/${finTot} корректно`);
console.log(`РЕГРЕСС: ${regOk}/${regTot} НЕфинансовых не перехвачены (обычный бот цел)`);
const allOk = finOk === finTot && regOk === regTot;
console.log(allOk ? '\n✅ ИТОГ: финансы работают И обычный бот не задет.' : '\n❌ ИТОГ: есть провалы — см. выше.');
process.exit(allOk ? 0 : 1);
