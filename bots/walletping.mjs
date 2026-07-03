import { wireStars } from '../lib/payments.mjs';

// v1 scope: ERC-20 transfer activity on ETH/Base/BSC via getLogs topic filters,
// full account events on TON via tonapi. Native EVM transfers are out of scope
// (block scanning is too heavy for public RPCs) — /help says so honestly.
const CHAINS = {
  ethereum: { rpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io/address/' },
  base: { rpc: 'https://base-rpc.publicnode.com', explorer: 'https://basescan.org/address/' },
  bsc: { rpc: 'https://bsc-rpc.publicnode.com', explorer: 'https://bscscan.com/address/' },
};
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const POLL_MS = 120_000;
const MAX_RANGE = 5_000; // cap block range per query to stay within public RPC limits
const FREE_WATCHES = 1;
const PRO_WATCHES = 10;
const PRO_DAYS = 30;

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await r.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const addrTopic = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

async function tonEvents(addr) {
  const headers = process.env.TONAPI_KEY ? { Authorization: `Bearer ${process.env.TONAPI_KEY}` } : {};
  const r = await fetch(`https://tonapi.io/v2/accounts/${addr}/events?limit=5`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`tonapi -> ${r.status}`);
  return (await r.json()).events || [];
}

const T = {
  start: {
    en: `Wallet activity alerts.\n\n/watch 0x… — watch an EVM address (ETH, Base, BSC — token transfers)\n/watch EQ… — watch a TON address (all activity)\n/list · /unwatch 1\n\nFree: ${FREE_WATCHES} address. PRO (${PRO_DAYS} days, ${PRO_WATCHES} addresses): /buy`,
    ru: `Алерты активности кошельков.\n\n/watch 0x… — следить за EVM-адресом (ETH, Base, BSC — токен-переводы)\n/watch EQ… — следить за TON-адресом (вся активность)\n/list · /unwatch 1\n\nБесплатно: ${FREE_WATCHES} адрес. PRO (${PRO_DAYS} дней, ${PRO_WATCHES} адресов): /buy`,
  },
  added: { en: (a) => `👁 Watching ${a}`, ru: (a) => `👁 Слежу за ${a}` },
  bad: { en: 'Send /watch with a 0x… or EQ…/UQ… address.', ru: 'Формат: /watch и адрес 0x… или EQ…/UQ….' },
  dup: { en: 'Already watching this address.', ru: 'Этот адрес уже под наблюдением.' },
  limit: { en: `Watch limit reached. PRO raises it to ${PRO_WATCHES}: /buy`, ru: `Лимит адресов. PRO поднимает до ${PRO_WATCHES}: /buy` },
  list_empty: { en: 'Nothing watched. /watch <address>', ru: 'Ничего не отслеживается. /watch <адрес>' },
  removed: { en: 'Stopped watching.', ru: 'Наблюдение снято.' },
  evm_hit: {
    en: (n, addr, chain) => `🔔 ${n} token transfer(s) involving <code>${addr}</code> on ${chain}`,
    ru: (n, addr, chain) => `🔔 ${n} токен-перевод(ов) с участием <code>${addr}</code> на ${chain}`,
  },
  ton_hit: {
    en: (addr, kinds) => `🔔 Activity on <code>${addr}</code> (TON): ${kinds}`,
    ru: (addr, kinds) => `🔔 Активность на <code>${addr}</code> (TON): ${kinds}`,
  },
  view: { en: 'Open in explorer', ru: 'Открыть в эксплорере' },
  buy: { en: `PRO — ${PRO_WATCHES} watched addresses:`, ru: `PRO — ${PRO_WATCHES} адресов под наблюдением:` },
  paid: { en: `✅ PRO active for ${PRO_DAYS} days.`, ru: `✅ PRO активен на ${PRO_DAYS} дней.` },
  paysupport: {
    en: 'Payment problems? Describe the issue in a message starting with /paysupport — undelivered PRO is refunded.',
    ru: 'Проблема с оплатой? Опиши сообщением с /paysupport — неактивированный PRO возмещается.',
  },
};

export function setup(bot, store) {
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
  const short = (a) => a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;

  bot.command('start', (ctx) => ctx.reply(T.start[ctx.lang]));
  bot.command('help', (ctx) => ctx.reply(T.start[ctx.lang]));

  bot.command('watch', (ctx) => {
    const arg = (ctx.match || '').trim();
    let kind = null;
    if (/^0x[0-9a-fA-F]{40}$/.test(arg)) kind = 'evm';
    else if (/^(?:EQ|UQ)[A-Za-z0-9_-]{46}$/.test(arg)) kind = 'ton';
    if (!kind) return ctx.reply(T.bad[ctx.lang]);
    const w = watches();
    const mine = w.filter((x) => x.userId === ctx.from.id);
    if (mine.some((x) => x.address.toLowerCase() === arg.toLowerCase())) return ctx.reply(T.dup[ctx.lang]);
    if (mine.length >= (isPro(ctx.from.id) ? PRO_WATCHES : FREE_WATCHES)) return ctx.reply(T.limit[ctx.lang]);
    w.push({ userId: ctx.from.id, chatId: ctx.chat.id, kind, address: arg, lang: ctx.lang, cursor: null });
    save(w);
    return ctx.reply(T.added[ctx.lang](short(arg)));
  });

  bot.command('list', (ctx) => {
    const mine = watches().filter((x) => x.userId === ctx.from.id);
    if (!mine.length) return ctx.reply(T.list_empty[ctx.lang]);
    return ctx.reply(mine.map((x, i) => `${i + 1}. ${x.kind === 'ton' ? 'TON' : 'EVM'} ${short(x.address)}`).join('\n') + '\n\n/unwatch 1');
  });

  bot.command('unwatch', (ctx) => {
    const n = parseInt((ctx.match || '').trim() || '1', 10);
    const w = watches();
    const victim = w.filter((x) => x.userId === ctx.from.id)[n - 1];
    if (!victim) return ctx.reply(T.list_empty[ctx.lang]);
    save(w.filter((x) => x !== victim));
    return ctx.reply(T.removed[ctx.lang]);
  });

  // --- pollers ---
  const notify = (x, text, explorerUrl) =>
    bot.api.sendMessage(x.chatId, `${text}\n<a href="${explorerUrl}">${T.view[x.lang || 'en']}</a>`, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    }).catch(() => {});

  async function tickEvm() {
    const w = watches().filter((x) => x.kind === 'evm');
    if (!w.length) return;
    for (const [chain, cfg] of Object.entries(CHAINS)) {
      let head;
      try { head = Number(BigInt(await rpc(cfg.rpc, 'eth_blockNumber', []))); } catch { continue; }
      const cursorKey = `evmCursor:${chain}`;
      const from = store.kvGet(cursorKey) ?? head; // first run: start at head, no backfill
      const to = Math.min(head, from + MAX_RANGE);
      if (to <= from) continue;
      for (const x of w) {
        const topic = addrTopic(x.address);
        try {
          const [out, inn] = await Promise.all([
            rpc(cfg.rpc, 'eth_getLogs', [{ fromBlock: '0x' + (from + 1).toString(16), toBlock: '0x' + to.toString(16), topics: [TRANSFER_TOPIC, topic] }]),
            rpc(cfg.rpc, 'eth_getLogs', [{ fromBlock: '0x' + (from + 1).toString(16), toBlock: '0x' + to.toString(16), topics: [TRANSFER_TOPIC, null, topic] }]),
          ]);
          const n = new Set([...out, ...inn].map((l) => l.transactionHash)).size;
          if (n > 0) notify(x, T.evm_hit[x.lang || 'en'](n, x.address, chain), cfg.explorer + x.address);
        } catch { /* rpc hiccup: retry window next tick */ }
      }
      store.kvSet(cursorKey, to);
    }
  }

  async function tickTon() {
    const w = watches().filter((x) => x.kind === 'ton');
    for (const x of w) {
      try {
        const events = await tonEvents(x.address);
        if (!events.length) continue;
        const latest = events[0].timestamp;
        if (x.cursor && latest > x.cursor) {
          const fresh = events.filter((e) => e.timestamp > x.cursor);
          const kinds = [...new Set(fresh.flatMap((e) => (e.actions || []).map((a) => a.type)))].join(', ') || 'events';
          notify(x, T.ton_hit[x.lang || 'en'](x.address, kinds), 'https://tonviewer.com/' + x.address);
        }
        if (latest !== x.cursor) {
          x.cursor = latest;
          store.touch();
        }
      } catch { /* next tick */ }
    }
  }

  setInterval(tickEvm, POLL_MS).unref();
  setInterval(tickTon, POLL_MS).unref();
}
