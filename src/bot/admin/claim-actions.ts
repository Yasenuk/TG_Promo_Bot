import { Composer } from 'telegraf';
import type { AppContext } from '../context.js';
import { claimRepo } from '../../db/repositories/claim.repo.js';
import { decodeCallback } from '../keyboards/callback.js';
import { claimKeyboard, markClaimMessageDelivered } from '../notifications/admin-notifier.js';
import { contentService } from '../../domain/content/content.service.js';
import { formatStorePlace } from '../../domain/stores/store-display.js';
import { isAdmin } from './guard.js';
import { isUserUnreachable } from '../../infra/telegram-errors.js';
import { userRepo } from '../../db/repositories/user.repo.js';

export const claimActions = new Composer<AppContext>();

/** Менеджер натиснув «Приз доставлено» */
claimActions.on('callback_query', async (ctx, next) => {
  const raw = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
  const action = raw ? decodeCallback(raw) : undefined;

  if (action?.kind !== 'deliver') return next();

  if (!(await isAdmin(ctx.from.id))) {
    await ctx.answerCbQuery('Недостатньо прав', { show_alert: true });
    return;
  }

  /**
   * markDelivered атомарний: умова status = AWAITING_DELIVERY всередині
   * UPDATE. Якщо двоє менеджерів тиснуть одночасно, другий отримає null
   * і stock не перерахується двічі.
   */
  const claim = await claimRepo.markDelivered(action.claimId, BigInt(ctx.from.id));

  if (!claim) {
    await ctx.answerCbQuery('Цю заявку вже закрито', { show_alert: true });

    // Прибираємо застарілу кнопку видачі, але лишаємо «Написати переможцю»
    const existing = await claimRepo.findById(action.claimId);
    await ctx
      .editMessageReplyMarkup(
        existing ? claimKeyboard(existing, { deliver: false }).reply_markup : undefined,
      )
      .catch(() => undefined);
    return;
  }

  await ctx.answerCbQuery('Готово');
  await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);

  const managerName =
    [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') ||
    (ctx.from.username ? `@${ctx.from.username}` : String(ctx.from.id));

  await markClaimMessageDelivered(ctx.telegram, claim, managerName);

  // Повідомляємо клієнта
  const text = await contentService.t(
    'prize.delivered',
    {
      prize: claim.prize.title,
      city: claim.store?.city.name ?? '',
      store: claim.store?.name ?? '-',
      address: claim.store?.address ?? '',
      place: claim.store ? formatStorePlace(claim.store) : '-',
    },
    { campaignId: claim.campaignId },
  );

  try {
    await ctx.telegram.sendMessage(claim.user.telegramId.toString(), text);
  } catch (error) {
    if (isUserUnreachable(error)) {
      // Людина заблокувала бота після того, як залишила заявку
      // Приз усе одно виданий
      await userRepo.markBlocked(claim.user.telegramId);
      ctx.log?.warn({ claimId: claim.id }, 'клієнт недосяжний, приз видано');
    } else {
      ctx.log?.error({ error, claimId: claim.id }, 'не вдалося сповістити клієнта');
    }
  }

  ctx.log?.info({ claimId: claim.id, by: ctx.from.id }, 'приз видано');
});
