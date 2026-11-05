import { Composer } from 'telegraf';
import type { AppContext } from '../context.js';
import { decodeCallback } from '../keyboards/callback.js';
import { dropPending, peekPendingKind } from './pending.js';
import { confirmDraw } from './draw.handler.js';
import { confirmCampaign } from './campaign.handler.js';
import { confirmStoresImport, confirmCodesImport } from './import.handler.js';

export const confirmHandler = new Composer<AppContext>();

confirmHandler.on('callback_query', async (ctx, next) => {
  const raw = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
  const action = raw ? decodeCallback(raw) : undefined;

  if (!action) return next();

  if (action.kind === 'cancel') {
    await dropPending(action.pendingId);
    await ctx.answerCbQuery('Скасовано');
    await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
    return;
  }

  if (action.kind !== 'confirm') return next();

  const kind = await peekPendingKind(action.pendingId);

  if (!kind) {
    ctx.log?.warn({ pendingId: action.pendingId }, 'підтвердження не знайдено');
    await ctx.answerCbQuery(
      'Термін підтвердження минув - повтори команду',
      { show_alert: true },
    );
    await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
    return;
  }

  switch (kind) {
    case 'draw':
      await confirmDraw(ctx, action.pendingId);
      return;
    case 'campaign':
      await confirmCampaign(ctx, action.pendingId);
      return;
    case 'stores':
      await confirmStoresImport(ctx, action.pendingId);
      return;
    case 'codes':
      await confirmCodesImport(ctx, action.pendingId);
      return;
  }
});
