import { Bot, GrammyError } from 'grammy';
import { makeStore, pickLang } from './lib/store.mjs';
import * as gasbelow from './bots/gasbelow.mjs';
import * as freshpools from './bots/freshpools.mjs';
import * as walletping from './bots/walletping.mjs';

const RUGLENS = process.env.RUGLENS_USERNAME || 'RugLens_bot';

const MODULES = [
  { ns: 'gasbelow', tokenEnv: 'GASBELOW_TOKEN', mod: gasbelow },
  { ns: 'freshpools', tokenEnv: 'FRESHPOOLS_TOKEN', mod: freshpools },
  { ns: 'walletping', tokenEnv: 'WALLETPING_TOKEN', mod: walletping },
];

const running = [];
for (const { ns, tokenEnv, mod } of MODULES) {
  const token = process.env[tokenEnv];
  if (!token) {
    console.log(`${ns}: no ${tokenEnv}, skipped`);
    continue;
  }
  const bot = new Bot(token);
  const store = makeStore(ns);
  // ctx.lang everywhere
  bot.use((ctx, next) => { ctx.lang = pickLang(ctx.from?.language_code); return next(); });
  mod.setup(bot, store, { ruglensUsername: RUGLENS });
  bot.catch(({ error, ctx }) => {
    if (error instanceof GrammyError && error.error_code === 403) return;
    console.error(`${ns} error:`, error?.message || error, 'update:', ctx?.update?.update_id);
  });
  const me = await bot.api.getMe();
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
}

if (!running.length) {
  console.error('no bot tokens configured, exiting');
  process.exit(1);
}
