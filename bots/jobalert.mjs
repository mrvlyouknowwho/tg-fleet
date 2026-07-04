import { wireStars } from '../lib/payments.mjs';

// Remote-job radar: Remotive + RemoteOK + Arbeitnow (remote only), all keyless.
// RemoteOK terms require linking back to the original remoteok.com job URL — we always do.
const FREE_SEARCHES = 5;
const FREE_WATCHES = 1;
const PRO_WATCHES = 10;
const PRO_DAYS = 30;
const WATCH_EVERY_MS = 60 * 60 * 1000;
const CACHE_MS = 10 * 60 * 1000;
const SEEN_CAP = 8000;

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const ago = (ts, lang) => {
  if (!ts) return '';
  const m = Math.max(1, Math.round((Date.now() - ts) / 60_000));
  if (m < 60) return lang === 'ru' ? `${m}м назад` : `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return lang === 'ru' ? `${h}ч назад` : `${h}h ago`;
  const d = Math.round(h / 24);
  return lang === 'ru' ? `${d}д назад` : `${d}d ago`;
};

async function fetchJson(url, headers = {}) {
  const r = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function remotive() {
  const { jobs } = await fetchJson('https://remotive.com/api/remote-jobs?limit=100');
  return (jobs || []).map((j) => ({
    id: `rmtv:${j.id}`,
    title: j.title,
    company: j.company_name || '',
    url: j.url,
    loc: j.candidate_required_location || '',
    salary: j.salary || '',
    hay: [j.title, j.company_name, j.category, j.candidate_required_location, ...(j.tags || [])].join(' ').toLowerCase(),
    // publication_date has no timezone marker; pin it to UTC for stable ordering
    ts: new Date(j.publication_date + 'Z').getTime() || 0,
  }));
}

async function remoteok() {
  const rows = await fetchJson('https://remoteok.com/api', { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' });
  // rows[0] is a legal notice, not a job
  return (Array.isArray(rows) ? rows : []).filter((j) => j && j.id && j.position).map((j) => ({
    id: `rok:${j.id}`,
    title: j.position,
    company: j.company || '',
    url: j.url,
    loc: j.location || '',
    salary: j.salary_min > 0 && j.salary_max > 0 ? `$${Math.round(j.salary_min / 1000)}k–$${Math.round(j.salary_max / 1000)}k` : '',
    // remoteok tags are a near-global tag cloud on every job — matching on them
    // floods keyword alerts with unrelated jobs, so only real fields go in
    hay: [j.position, j.company, j.location].join(' ').toLowerCase(),
    ts: (Number(j.epoch) || 0) * 1000,
  }));
}

async function arbeitnow() {
  const { data } = await fetchJson('https://www.arbeitnow.com/api/job-board-api');
  return (data || []).filter((j) => j.remote === true).map((j) => ({
    id: `anow:${j.slug}`,
    title: j.title,
    company: j.company_name || '',
    url: j.url,
    loc: j.location || '',
    salary: '',
    hay: [j.title, j.company_name, j.location, ...(j.tags || []), ...(j.job_types || [])].join(' ').toLowerCase(),
    ts: (Number(j.created_at) || 0) * 1000,
  }));
}

let cache = { at: 0, jobs: [] };
async function allJobs(force = false) {
  if (!force && cache.jobs.length && Date.now() - cache.at < CACHE_MS) return cache.jobs;
  const results = await Promise.allSettled([remotive(), remoteok(), arbeitnow()]);
  for (const r of results) if (r.status === 'rejected') console.error(`jobalert feed: ${r.reason?.message || r.reason}`);
  const jobs = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  if (jobs.length) cache = { at: Date.now(), jobs };
  return jobs;
}

const matcher = (q) => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return (j) => words.every((w) => j.hay.includes(w));
};

function jobLine(j, lang) {
  const bits = [esc(j.company)];
  if (j.loc) bits.push(`🌍 ${esc(j.loc)}`);
  if (j.salary) bits.push(`💰 ${esc(j.salary)}`);
  const open = lang === 'ru' ? 'открыть' : 'apply';
  return `• <b>${esc(j.title)}</b>\n  ${bits.filter(Boolean).join(' · ')} · <a href="${j.url}">${open}</a> · ${ago(j.ts, lang)}`;
}

const T = {
  start: {
    en: `Remote job radar — fresh openings from Remotive, RemoteOK and Arbeitnow.\n\n/jobs python — search fresh remote jobs\n/watch senior python — get pinged when matching jobs appear (checked hourly)\n/list · /unwatch 1\n\nFree: ${FREE_SEARCHES} searches/day, ${FREE_WATCHES} watch. PRO (${PRO_DAYS} days: ${PRO_WATCHES} watches + unlimited searches): /buy`,
    ru: `Радар удалённых вакансий — свежие позиции из Remotive, RemoteOK и Arbeitnow.\n\n/jobs python — поиск свежих удалённых вакансий\n/watch senior python — алерт, когда появится подходящая вакансия (проверка ежечасно)\n/list · /unwatch 1\n\nБесплатно: ${FREE_SEARCHES} поисков в день, ${FREE_WATCHES} подписка. PRO (${PRO_DAYS} дней: ${PRO_WATCHES} подписок + безлимитный поиск): /buy`,
  },
  which: { en: 'What to search? e.g. /jobs python or /jobs designer', ru: 'Что ищем? Например /jobs python или /jobs designer' },
  header: { en: (q) => `💼 Fresh remote jobs for “${esc(q)}”:`, ru: (q) => `💼 Свежие удалённые вакансии по «${esc(q)}»:` },
  empty: {
    en: 'No matches in the current feeds. Try a broader keyword, or /watch it — I will ping you when one appears.',
    ru: 'Совпадений в текущих фидах нет. Попробуй шире или поставь /watch — пингану, когда появится.',
  },
  alert: { en: (q) => `🔔 New remote jobs for “${esc(q)}”:`, ru: (q) => `🔔 Новые удалённые вакансии по «${esc(q)}»:` },
  watch_added: { en: (q) => `👁 Watching “${esc(q)}” — hourly alerts on new matches.`, ru: (q) => `👁 Слежу за «${esc(q)}» — ежечасные алерты по новым совпадениям.` },
  watch_bad: { en: 'Format: /watch <keywords>, e.g. /watch senior python', ru: 'Формат: /watch <слова>, например /watch senior python' },
  dup: { en: 'Already watching that.', ru: 'Уже слежу за этим.' },
  limit_watch: { en: `Watch limit reached. PRO raises it to ${PRO_WATCHES}: /buy`, ru: `Лимит подписок. PRO поднимает до ${PRO_WATCHES}: /buy` },
  list_empty: { en: 'No watches. /watch <keywords>', ru: 'Подписок нет. /watch <слова>' },
  removed: { en: 'Watch removed.', ru: 'Подписка снята.' },
  limit: { en: 'Daily free searches used up — PRO gives unlimited: /buy', ru: 'Дневные бесплатные поиски закончились — в PRO безлимит: /buy' },
  err: { en: 'Feeds hiccup, try again in a minute.', ru: 'Фиды икнули, попробуй через минуту.' },
  buy: { en: `PRO — ${PRO_WATCHES} watches + unlimited searches, ${PRO_DAYS} days:`, ru: `PRO — ${PRO_WATCHES} подписок + безлимитный поиск, ${PRO_DAYS} дней:` },
  paid: { en: `✅ PRO active for ${PRO_DAYS} days.`, ru: `✅ PRO активен на ${PRO_DAYS} дней.` },
  paysupport: {
    en: 'Payment problems? Describe the issue in a message starting with /paysupport — undelivered PRO is refunded.',
    ru: 'Проблема с оплатой? Опиши сообщением с /paysupport — неактивированный PRO возмещается.',
  },
};

const sendOpts = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

export function setup(bot, store, { promo } = {}) {
  const isPro = (id) => (store.getUser(id).proUntil || 0) > Date.now();
  const PACKS = {
    pro30: {
      stars: 150,
      label: { en: `PRO ${PRO_DAYS} days`, ru: `PRO ${PRO_DAYS} дней` },
      apply: (s, id) => { const u = s.getUser(id); u.proUntil = Math.max(u.proUntil || 0, Date.now()) + PRO_DAYS * 864e5; s.touch(); },
    },
  };
  wireStars(bot, store, PACKS, T);

  const watches = () => store.kvGet('watches', []);
  const save = (w) => store.kvSet('watches', w);

  bot.command('start', (ctx) => ctx.reply(T.start[ctx.lang] + (promo?.(ctx.lang) ?? '')));
  bot.command('help', (ctx) => ctx.reply(T.start[ctx.lang] + (promo?.(ctx.lang) ?? '')));

  bot.command('jobs', async (ctx) => {
    const q = (ctx.match || '').trim();
    if (!q) return ctx.reply(T.which[ctx.lang]);
    let quota = null;
    if (!isPro(ctx.from.id)) {
      quota = store.consume(ctx.from.id, FREE_SEARCHES);
      if (!quota.ok) return ctx.reply(T.limit[ctx.lang]);
    }
    try {
      const hits = (await allJobs()).filter(matcher(q)).sort((a, b) => b.ts - a.ts).slice(0, 8);
      if (!hits.length) {
        if (quota) store.refund(ctx.from.id, quota.source);
        return ctx.reply(T.empty[ctx.lang]);
      }
      await ctx.reply(`${T.header[ctx.lang](q)}\n\n${hits.map((j) => jobLine(j, ctx.lang)).join('\n')}`, sendOpts);
    } catch (e) {
      if (quota) store.refund(ctx.from.id, quota.source);
      console.error(`jobalert /jobs "${q}": ${e.message}`);
      await ctx.reply(T.err[ctx.lang]);
    }
  });

  bot.command('watch', (ctx) => {
    const q = (ctx.match || '').trim().replace(/\s+/g, ' ');
    if (!q || q.length > 64) return ctx.reply(T.watch_bad[ctx.lang]);
    const w = watches();
    const mine = w.filter((x) => x.userId === ctx.from.id);
    if (mine.some((x) => x.q.toLowerCase() === q.toLowerCase())) return ctx.reply(T.dup[ctx.lang]);
    if (mine.length >= (isPro(ctx.from.id) ? PRO_WATCHES : FREE_WATCHES)) return ctx.reply(T.limit_watch[ctx.lang]);
    w.push({ userId: ctx.from.id, chatId: ctx.chat.id, q, lang: ctx.lang });
    save(w);
    return ctx.reply(T.watch_added[ctx.lang](q));
  });

  bot.command('list', (ctx) => {
    const mine = watches().filter((x) => x.userId === ctx.from.id);
    if (!mine.length) return ctx.reply(T.list_empty[ctx.lang]);
    return ctx.reply(mine.map((x, i) => `${i + 1}. ${x.q}`).join('\n') + '\n\n/unwatch 1');
  });

  bot.command('unwatch', (ctx) => {
    const n = parseInt((ctx.match || '').trim() || '1', 10);
    const w = watches();
    const victim = w.filter((x) => x.userId === ctx.from.id)[n - 1];
    if (!victim) return ctx.reply(T.list_empty[ctx.lang]);
    save(w.filter((x) => x !== victim));
    return ctx.reply(T.removed[ctx.lang]);
  });

  // Hourly alert loop. First tick only seeds the seen-set so a fresh deploy
  // doesn't blast watchers with the entire feed backlog.
  async function tickWatches() {
    try {
      const jobs = await allJobs(true);
      if (!jobs.length) return;
      const seen = new Set(store.kvGet('seenJobs', []));
      const seeded = store.kvGet('seenSeeded', false);
      const fresh = jobs.filter((j) => !seen.has(j.id));
      jobs.forEach((j) => seen.add(j.id));
      store.kvSet('seenJobs', [...seen].slice(-SEEN_CAP));
      if (!seeded) { store.kvSet('seenSeeded', true); return; }
      if (!fresh.length) return;
      for (const x of watches()) {
        const hits = fresh.filter(matcher(x.q)).sort((a, b) => b.ts - a.ts).slice(0, 6);
        if (!hits.length) continue;
        const lang = x.lang || 'en';
        bot.api.sendMessage(x.chatId, `${T.alert[lang](x.q)}\n\n${hits.map((j) => jobLine(j, lang)).join('\n')}`, sendOpts).catch(() => {});
      }
    } catch (e) {
      console.error(`jobalert watch tick: ${e.message}`);
    }
  }
  setTimeout(tickWatches, 45_000);
  setInterval(tickWatches, WATCH_EVERY_MS).unref();
}

// Autonomous channel poster (optional, wired when JOBALERT_CHANNEL_ID is set):
// hourly digest of freshest remote jobs, deduped forever, funnel into the bot.
export function startChannelLoop(api, channelId, store, { botUsername, query }) {
  const match = query ? matcher(query) : () => true;
  const tick = async () => {
    try {
      const posted = new Set(store.kvGet('postedJobs', []));
      const jobs = (await allJobs()).filter((j) => match(j) && !posted.has(j.id)).sort((a, b) => b.ts - a.ts).slice(0, 6);
      if (!jobs.length) return;
      jobs.forEach((j) => posted.add(j.id));
      const footer = botUsername ? `\n\n🔔 Personal keyword alerts: @${botUsername}` : '';
      await api.sendMessage(channelId, `💼 <b>Fresh remote jobs</b>\n\n${jobs.map((j) => jobLine(j, 'en')).join('\n')}${footer}`, sendOpts);
      store.kvSet('postedJobs', [...posted].slice(-SEEN_CAP));
    } catch (e) {
      console.error(`jobalert channel: ${e.message}`);
    }
  };
  setTimeout(tick, 60_000);
  setInterval(tick, WATCH_EVERY_MS).unref();
}
