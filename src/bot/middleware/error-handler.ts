import type { MiddlewareFn } from 'telegraf';
import type { AppContext } from '../context.js';
import { userRepo } from '../../db/repositories/user.repo.js';
import { isNotModified, isUserUnreachable } from '../../infra/telegram-errors.js';

export const errorHandlerMiddleware: MiddlewareFn<AppContext> = async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    if (isNotModified(error)) {
      ctx.log?.debug('повідомлення не змінилось');
      return;
    }

    // 403 у групі - це «бот не має прав тут», а не «людина заблокувала бота»
    if (isUserUnreachable(error) && ctx.chat?.type === 'private') {
      ctx.log?.info('бот заблокований користувачем');
      if (ctx.from) await userRepo.markBlocked(BigInt(ctx.from.id));
      return;
    }

    ctx.log?.error({ error }, 'необроблена помилка в обробнику');

    try {
      await ctx.reply_t('error.generic');
    } catch {
      ctx.log?.debug('не змогли повідомити користувача про помилку');
    }
  }
};
