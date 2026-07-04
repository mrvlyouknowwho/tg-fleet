import { Bot, GrammyError } from 'grammy';
import { makeStore, pickLang } from './lib/store.mjs';
import * as gasbelow from './bots/gasbelow.mjs';
import * as freshpools from './bots/freshpools.mjs';
import * as walletping from './bots/walletping.mjs';
import * as jobalert from './bots/jobalert.mjs';

const RUGLENS = process.env.RUGLENS_USERNAME || 'RugLens_bot';
const PROMO_CHANNEL = process.env.PROMO_CHANNEL || 'FreshPoolsFeed';

const FAMILY = [
  { u: RUGLENS, en: 'token rug/honeypot check', ru: 'проверка токена на rug/honeypot' },
  { u: 'GasBelowBot', en: 'ETH gas alerts', ru: 'алерты газа ETH' },
  { u: 'FreshPoolsBot', en: 'fresh DEX pools', ru: 'свежие DEX-пулы' },
  { u: 'WalletPingAlertBot', en: 'wallet activity alerts', ru: 'алерты активности кошелька' },
];
const promoFor = (self) => (lang) => {
  const others = FAMILY
    .filter((f) => f.u.toLowerCase() !== String(self).toLowerCase())
    .map((f) => `@${f.u} (${lang === 'ru' ? f.ru : f.en})`)
    .join(' · ');
  const head = lang === 'ru' ? 'Ещё бесплатные инструменты' : 'More free tools';
  const ch = lang === 'ru' ? 'Свежие пулы ежечасно' : 'Fresh pools hourly';
  return `\n\n${head}: ${others}\n📡 ${ch}: @${PROMO_CHANNEL}`;
};

const MODULES = [
  { ns: 'gasbelow', tokenEnv: 'GASBELOW_TOKEN', mod: gasbelow },
  { ns: 'freshpools', tokenEnv: 'FRESHPOOLS_TOKEN', mod: freshpools },
  { ns: 'walletping', tokenEnv: 'WALLETPING_TOKEN', mod: walletping },
  // non-crypto audience: no cross-promo with the crypto family
  { ns: 'jobalert', tokenEnv: 'JOBALERT_TOKEN', mod: jobalert, noPromo: true },
];

const running = [];
for (const { ns, tokenEnv, mod, noPromo } of MODULES) {
  const token = process.env[tokenEnv];
  if (!token) {
    console.log(`${ns}: no ${tokenEnv}, skipped`);
    continue;
  }
  const bot = new Bot(token);
  const store = makeStore(ns);
  // ctx.lang everywhere
  bot.use((ctx, next) => { ctx.lang = pickLang(ctx.from?.language_code); return next(); });
  const me = await bot.api.getMe();
  mod.setup(bot, store, { ruglensUsername: RUGLENS, promo: noPromo ? null : promoFor(me.username) });
  bot.catch(({ error, ctx }) => {
    if (error instanceof GrammyError && error.error_code === 403) return;
    console.error(`${ns} error:`, error?.message || error, 'update:', ctx?.update?.update_id);
  });
  bot.start();
  running.push(ns);
  console.log(`${ns}: @${me.username} up`);

  if (ns === 'freshpools' && process.env.CHANNEL_ID) {
    freshpools.startChannelLoop(bot.api, process.env.CHANNEL_ID, store, {
      ruglensUsername: RUGLENS,
      botUsername: me.username,
    });
    console.log(`freshpools: channel poster -> ${process.env.CHANNEL_ID}`);
  }

  if (ns === 'jobalert' && process.env.JOBALERT_CHANNEL_ID) {
    jobalert.startChannelLoop(bot.api, process.env.JOBALERT_CHANNEL_ID, store, {
      botUsername: me.username,
      query: process.env.JOBALERT_CHANNEL_QUERY || '',
    });
    console.log(`jobalert: channel poster -> ${process.env.JOBALERT_CHANNEL_ID}`);
  }
}

if (!running.length) {
  console.error('no bot tokens configured, exiting');
  process.exit(1);
}
