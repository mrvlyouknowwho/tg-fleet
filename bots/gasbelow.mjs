import { wireStars } from '../lib/payments.mjs';

const RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://cloudflare-eth.com'];
const POLL_MS = 30_000;
const PRO_DAYS = 30;

let cache = { gwei: null, ts: 0 };

async function fetchGasGwei() {
  if (Date.now() - cache.ts < 15_000 && cache.gwei != null) return cache.gwei;
  for (const rpc of RPCS) {
    try {
      const r = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"jsonrpc":"2.0","id":1,"method":"eth_gasPrice","params":[]}',
        signal: AbortSignal.timeout(8_000),
      });
      const hex = (await r.json()).result;
      if (!hex) continue;
      cache = { gwei: Number(BigInt(hex)) / 1e9, ts: Date.now() };
      return cache.gwei;
    } catch { /* next rpc */ }
  }
  throw new Error('all RPCs failed');
}

const fmt = (g) => (g >= 10 ? g.toFixed(1) : g >= 1 ? g.toFixed(2) : g.toFixed(3));

const T = {
  start: {
    en: (free) => `Ethereum gas alerts.\n\n/gas — current gas price\n/alert 0.05 — ping me when gas drops to 0.05 gwei\n/above 5 — ping me when gas spikes to 5 gwei\n/alerts — my alerts · /cancel — remove\n\nFree: ${free} active alert. PRO (${PRO_DAYS} days, unlimited alerts): /buy`,
    ru: (free) => `Алерты по газу Ethereum.\n\n/gas — текущая цена газа\n/alert 0.05 — пингануть, когда газ упадёт до 0.05 gwei\n/above 5 — пингануть, когда газ взлетит до 5 gwei\n/alerts — мои алерты · /cancel — удалить\n\nБесплатно: ${free} активный алерт. PRO (${PRO_DAYS} дней, без лимита): /buy`,
  },
  gas: { en: (g) => `⛽ ${fmt(g)} gwei`, ru: (g) => `⛽ ${fmt(g)} gwei` },
  set_below: { en: (v) => `✅ Alert set: gas ≤ ${fmt(v)} gwei`, ru: (v) => `✅ Алерт: газ ≤ ${fmt(v)} gwei` },
  set_above: { en: (v) => `✅ Alert set: gas ≥ ${fmt(v)} gwei`, ru: (v) => `✅ Алерт: газ ≥ ${fmt(v)} gwei` },
  fired_below: { en: (g, v) => `🔔 Gas is ${fmt(g)} gwei (≤ ${fmt(v)}). Go.`, ru: (g, v) => `🔔 Газ ${fmt(g)} gwei (≤ ${fmt(v)}). Пора.` },
  fired_above: { en: (g, v) => `🔔 Gas spiked to ${fmt(g)} gwei (≥ ${fmt(v)}).`, ru: (g, v) => `🔔 Газ взлетел до ${fmt(g)} gwei (≥ ${fmt(v)}).` },
  bad_value: { en: 'Usage: /alert 0.05 (gwei, number > 0)', ru: 'Формат: /alert 0.05 (gwei, число > 0)' },
  limit: { en: 'Free plan: 1 active alert. PRO removes the limit: /buy', ru: 'Бесплатно: 1 активный алерт. PRO снимает лимит: /buy' },
  list_empty: { en: 'No active alerts. Set one: /alert 0.05', ru: 'Активных алертов нет. Поставь: /alert 0.05' },
  cancelled: { en: 'Removed.', ru: 'Удалено.' },
  rpc_down: { en: 'Gas oracle unreachable, try in a minute.', ru: 'Не достучался до RPC, попробуй через минуту.' },
  buy: { en: 'PRO — unlimited active alerts:', ru: 'PRO — активные алерты без лимита:' },
  paid: { en: `✅ PRO active for ${PRO_DAYS} days.`, ru: `✅ PRO активен на ${PRO_DAYS} дней.` },
  paysupport: {
    en: 'Payment problems? Describe the issue in a message starting with /paysupport — refunds are honored for undelivered PRO.',
    ru: 'Проблема с оплатой? Опиши сообщением, начинающимся с /paysupport — неактивированный PRO возмещается.',
  },
};

export function setup(bot, store, { promo } = {}) {
  const FREE_ALERTS = 1;

  const isPro = (id) => (store.getUser(id).proUntil || 0) > Date.now();

  const PACKS = {
    pro30: {
      stars: 100,
      label: { en: `PRO ${PRO_DAYS} days`, ru: `PRO ${PRO_DAYS} дней` },
      apply: (s, id) => {
        const u = s.getUser(id);
        u.proUntil = Math.max(u.proUntil || 0, Date.now()) + PRO_DAYS * 864e5;
        s.touch();
      },
    },
  };
  wireStars(bot, store, PACKS, T);

  const alerts = () => store.kvGet('alerts', []);
  const saveAlerts = (a) => store.kvSet('alerts', a);

  bot.command('start', (ctx) => ctx.reply(T.start[ctx.lang](FREE_ALERTS) + (promo?.(ctx.lang) ?? '')));
  bot.command('help', (ctx) => ctx.reply(T.start[ctx.lang](FREE_ALERTS) + (promo?.(ctx.lang) ?? '')));

  bot.command('gas', async (ctx) => {
    try { await ctx.reply(T.gas[ctx.lang](await fetchGasGwei())); }
    catch { await ctx.reply(T.rpc_down[ctx.lang]); }
  });

  const addAlert = async (ctx, dir) => {
    const v = parseFloat((ctx.match || '').trim().replace(',', '.'));
    if (!Number.isFinite(v) || v <= 0) return ctx.reply(T.bad_value[ctx.lang]);
    const a = alerts();
    const mine = a.filter((x) => x.userId === ctx.from.id);
    if (!isPro(ctx.from.id) && mine.length >= FREE_ALERTS) return ctx.reply(T.limit[ctx.lang]);
    a.push({ userId: ctx.from.id, chatId: ctx.chat.id, dir, gwei: v, lang: ctx.lang });
    saveAlerts(a);
    return ctx.reply((dir === 'below' ? T.set_below : T.set_above)[ctx.lang](v));
  };
  bot.command('alert', (ctx) => addAlert(ctx, 'below'));
  bot.command('above', (ctx) => addAlert(ctx, 'above'));

  bot.command('alerts', (ctx) => {
    const mine = alerts().filter((x) => x.userId === ctx.from.id);
    if (!mine.length) return ctx.reply(T.list_empty[ctx.lang]);
    return ctx.reply(mine.map((x, i) => `${i + 1}. gas ${x.dir === 'below' ? '≤' : '≥'} ${fmt(x.gwei)} gwei`).join('\n') + '\n\n/cancel 1');
  });

  bot.command('cancel', (ctx) => {
    const n = parseInt((ctx.match || '').trim() || '1', 10);
    const a = alerts();
    const mine = a.filter((x) => x.userId === ctx.from.id);
    const victim = mine[n - 1];
    if (!victim) return ctx.reply(T.list_empty[ctx.lang]);
    saveAlerts(a.filter((x) => x !== victim));
    return ctx.reply(T.cancelled[ctx.lang]);
  });

  // poller: fire matching alerts, one-shot (removed after firing)
  const tick = async () => {
    const a = alerts();
    if (!a.length) return;
    let gwei;
    try { gwei = await fetchGasGwei(); } catch { return; }
    const keep = [];
    for (const x of a) {
      const hit = x.dir === 'below' ? gwei <= x.gwei : gwei >= x.gwei;
      if (!hit) { keep.push(x); continue; }
      const text = (x.dir === 'below' ? T.fired_below : T.fired_above)[x.lang || 'en'](gwei, x.gwei);
      bot.api.sendMessage(x.chatId, text).catch(() => {});
    }
    if (keep.length !== a.length) saveAlerts(keep);
  };
  setInterval(tick, POLL_MS).unref();
}
