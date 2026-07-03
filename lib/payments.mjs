import { InlineKeyboard } from 'grammy';

// Wires Stars packs into a bot: /buy + buy callbacks + checkout + credit on payment.
// packs: {id: {stars, label: {en, ru}, apply(store, userId)}}
export function wireStars(bot, store, packs, texts) {
  const kb = (lang) => {
    const k = new InlineKeyboard();
    for (const [id, p] of Object.entries(packs)) k.text(`${p.label[lang]} — ${p.stars} ⭐`, `buy|${id}`).row();
    return k;
  };

  bot.command('buy', (ctx) => ctx.reply(texts.buy[ctx.lang], { reply_markup: kb(ctx.lang) }));
  bot.command('paysupport', (ctx) => ctx.reply(texts.paysupport[ctx.lang]));

  bot.callbackQuery(/^buy\|(\w+)$/, async (ctx) => {
    const pack = packs[ctx.match[1]];
    await ctx.answerCallbackQuery();
    if (!pack) return;
    const label = `${pack.label[ctx.lang]} — ${pack.stars} ⭐`;
    await ctx.api.sendInvoice(ctx.chat.id, label, label, ctx.match[1], 'XTR', [{ label, amount: pack.stars }]);
  });

  bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));

  bot.on('message:successful_payment', async (ctx) => {
    const p = ctx.message.successful_payment;
    const pack = packs[p.invoice_payload];
    if (pack) pack.apply(store, ctx.from.id);
    store.recordPurchase({ userId: ctx.from.id, payload: p.invoice_payload, stars: p.total_amount, chargeId: p.telegram_payment_charge_id });
    await ctx.reply(texts.paid[ctx.lang]);
  });

  return { buyKeyboard: kb };
}
