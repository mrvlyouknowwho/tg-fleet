import { wireStars } from '../lib/payments.mjs';

const GT = 'https://api.geckoterminal.com/api/v2';
// GeckoTerminal network slug -> display + whether RugLens can scan the token
const NETWORKS = {
  base: { title: 'Base', scan: true },
  eth: { title: 'Ethereum', scan: true },
  bsc: { title: 'BSC', scan: true },
  solana: { title: 'Solana', scan: false },
  ton: { title: 'TON', scan: true },
};
const FREE_PER_DAY = 5;
const MIN_LIQ_BOT = 1_000;      // junk filter for /fresh
const MIN_LIQ_CHANNEL = 25_000; // channel only shows meaningful liquidity
const CHANNEL_EVERY_MS = 60 * 60 * 1000;

async function newPools(network) {
  const r = await fetch(`${GT}/networks/${network}/new_pools?page=1`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!r.ok) throw new Error(`geckoterminal ${network} -> ${r.status}`);
  const { data } = await r.json();
  return (data || []).map((p) => {
    const a = p.attributes || {};
    return {
      id: p.id,
      name: a.name,
      liq: Number(a.reserve_in_usd) || 0,
      priceUsd: a.base_token_price_usd ? Number(a.base_token_price_usd) : null,
      createdAt: a.pool_created_at,
      // "base_0xabc..." -> "0xabc..."; ton ids keep friendly form after the prefix
      tokenAddress: (p.relationships?.base_token?.data?.id || '').split('_').slice(1).join('_') || null,
    };
  }).filter((p) => p.liq >= MIN_LIQ_BOT);
}

const ago = (iso, lang) => {
  const m = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (m < 60) return lang === 'ru' ? `${m}м назад` : `${m}m ago`;
  const h = Math.round(m / 60);
  return lang === 'ru' ? `${h}ч назад` : `${h}h ago`;
};
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function poolLine(p, net, lang, ruglens) {
  const scanLink = ruglens && NETWORKS[net].scan && p.tokenAddress
    ? ` · <a href="https://t.me/${ruglens}?start=${p.tokenAddress}">scan</a>` : '';
  return `• <b>${esc(p.name)}</b> — 💧 ${money(p.liq)} · ${ago(p.createdAt, lang)}${scanLink}`;
}

const T = {
  start: {
    en: `Fresh liquidity radar — newest DEX pools as they appear.\n\n/fresh base · /fresh eth · /fresh bsc · /fresh solana · /fresh ton\n\nFree: ${FREE_PER_DAY} sweeps/day, packs: /buy`,
    ru: `Радар свежей ликвидности — новые DEX-пулы по мере появления.\n\n/fresh base · /fresh eth · /fresh bsc · /fresh solana · /fresh ton\n\nБесплатно: ${FREE_PER_DAY} свипов в день, пакеты: /buy`,
  },
  header: { en: (t) => `🆕 Newest pools on ${t}:`, ru: (t) => `🆕 Свежие пулы на ${t}:` },
  empty: { en: 'Nothing above the junk filter right now.', ru: 'Сейчас ничего выше мусорного фильтра.' },
  which: { en: `Which network? /fresh base|eth|bsc|solana|ton`, ru: `Какая сеть? /fresh base|eth|bsc|solana|ton` },
  limit: { en: 'Daily free limit reached — /buy for packs.', ru: 'Дневной лимит исчерпан — пакеты в /buy.' },
  err: { en: 'Radar hiccup, try again in a minute.', ru: 'Радар икнул, попробуй через минуту.' },
  buy: { en: 'Sweep packs (Stars):', ru: 'Пакеты свипов (Stars):' },
  paid: { en: '✅ Payment received, credits added.', ru: '✅ Оплата получена, кредиты начислены.' },
  paysupport: {
    en: 'Payment problems? Describe the issue in a message starting with /paysupport — undelivered credits are refunded.',
    ru: 'Проблема с оплатой? Опиши сообщением с /paysupport — невыданные кредиты возмещаются.',
  },
};

export function setup(bot, store, { ruglensUsername }) {
  const PACKS = {
    p100: { stars: 50, label: { en: '100 sweeps', ru: '100 свипов' }, apply: (s, id) => s.addCredits(id, 100) },
    p500: { stars: 200, label: { en: '500 sweeps', ru: '500 свипов' }, apply: (s, id) => s.addCredits(id, 500) },
  };
  wireStars(bot, store, PACKS, T);

  bot.command('start', (ctx) => ctx.reply(T.start[ctx.lang]));
  bot.command('help', (ctx) => ctx.reply(T.start[ctx.lang]));

  bot.command('fresh', async (ctx) => {
    const net = (ctx.match || '').trim().toLowerCase();
    if (!NETWORKS[net]) return ctx.reply(T.which[ctx.lang]);
    const q = store.consume(ctx.from.id, FREE_PER_DAY);
    if (!q.ok) return ctx.reply(T.limit[ctx.lang]);
    try {
      const pools = (await newPools(net)).slice(0, 10);
      if (!pools.length) { store.refund(ctx.from.id, q.source); return ctx.reply(T.empty[ctx.lang]); }
      const body = pools.map((p) => poolLine(p, net, ctx.lang, ruglensUsername)).join('\n');
      await ctx.reply(`${T.header[ctx.lang](NETWORKS[net].title)}\n\n${body}`, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      store.refund(ctx.from.id, q.source);
      console.error(`freshpools /fresh ${net}: ${e.message}`);
      await ctx.reply(T.err[ctx.lang]);
    }
  });
}

// Autonomous channel poster: hourly digest of significant new pools, deduped forever.
export function startChannelLoop(api, channelId, store, { ruglensUsername, botUsername }) {
  const tick = async () => {
    try {
      const posted = new Set(store.kvGet('postedPools', []));
      const sections = [];
      for (const [net, meta] of Object.entries(NETWORKS)) {
        let pools;
        try { pools = await newPools(net); } catch { continue; }
        const fresh = pools.filter((p) => p.liq >= MIN_LIQ_CHANNEL && !posted.has(p.id)).slice(0, 5);
        if (!fresh.length) continue;
        fresh.forEach((p) => posted.add(p.id));
        sections.push(`<b>${meta.title}</b>\n` + fresh.map((p) => poolLine(p, net, 'en', ruglensUsername)).join('\n'));
      }
      if (!sections.length) return;
      const footer = botUsername ? `\n\n📡 @${botUsername}` : '';
      await api.sendMessage(channelId, `💧 <b>Fresh liquidity</b>\n\n${sections.join('\n\n')}${footer}`, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      store.kvSet('postedPools', [...posted].slice(-5000));
    } catch (e) {
      console.error(`channel loop: ${e.message}`);
    }
  };
  setTimeout(tick, 30_000);
  setInterval(tick, CHANNEL_EVERY_MS).unref();
}
