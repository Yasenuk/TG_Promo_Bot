import { Composer, Scenes, Telegraf } from 'telegraf';
import type { AppContext } from './context.js';
import { env } from '../config/env.js';
import { logger } from '../infra/logger.js';

import { loggerMiddleware } from './middleware/logger.js';
import { contentMiddleware } from './middleware/content.js';
import { errorHandlerMiddleware } from './middleware/error-handler.js';
import { userMiddleware } from './middleware/user.js';
import { sessionMiddleware } from './middleware/session.js';
import { rateLimitMiddleware, startRateLimitCleanup } from './middleware/rate-limit.js';

import { registrationScene } from './scenes/registration.scene.js';
import { codeEntryScene } from './scenes/code-entry.scene.js';
import { storeSelectScene } from './scenes/store-select.scene.js';

import { startHandler } from './handlers/start.handler.js';
import { menuHandler } from './handlers/menu.handler.js';
import { prizeHandler } from './handlers/prize.handler.js';
import { claimActions } from './admin/claim-actions.js';
import { notifyWinnerHandler } from './admin/notify-winner.handler.js';
import { adminCommands } from './admin/commands.js';
import { confirmHandler } from './admin/confirm.handler.js';
import { drawHandler } from './admin/draw.handler.js';
import { campaignHandler } from './admin/campaign.handler.js';
import { importHandler } from './admin/import.handler.js';
import { adminsHandler } from './admin/admins.handler.js';
import { startPendingCleanup } from './admin/pending.js';

/**
 * Клієнтська частина: реєстрація, коди, призи
 */
function createPrivateFlow(): Composer<AppContext> {
  const flow = new Composer<AppContext>();

  flow.use(userMiddleware);
  flow.use(sessionMiddleware);
  flow.use(rateLimitMiddleware);

  const stage = new Scenes.Stage<AppContext>([
    registrationScene,
    codeEntryScene,
    storeSelectScene,
  ]);
  flow.use(stage.middleware());

  flow.use(startHandler);
  flow.use(prizeHandler);
  flow.use(menuHandler);

  flow.on('message', async (ctx) => {
    await ctx.reply_t('error.unknown_command');
  });

  return flow;
}

export function createBot(): Telegraf<AppContext> {
  const bot = new Telegraf<AppContext>(env.BOT_TOKEN, {
    handlerTimeout: 30_000,
  });

  bot.use(loggerMiddleware);
  bot.use(contentMiddleware);
  bot.use(errorHandlerMiddleware);

  bot.use(claimActions);
  bot.use(notifyWinnerHandler);
  bot.use(confirmHandler);
  bot.use(adminCommands);
  bot.use(drawHandler);
  bot.use(campaignHandler);
  bot.use(importHandler);
  bot.use(adminsHandler);

  bot.action('noop', (ctx) => ctx.answerCbQuery());

  bot.use(Composer.chatType('private', createPrivateFlow()));

  bot.on('message', async (ctx) => {
    if (ctx.chat.type === 'private') return;

    if ('text' in ctx.message && ctx.message.text.startsWith('/')) {
      ctx.log?.debug({ text: ctx.message.text }, 'невідома команда в групі');
    }
  });

  bot.catch((error, ctx) => {
    logger.error({ error, updateId: ctx.update.update_id }, 'bot.catch');
  });

  startRateLimitCleanup();
  startPendingCleanup();

  return bot;
}

export async function launchBot(bot: Telegraf<AppContext>): Promise<void> {
  const me = await bot.telegram.getMe();
  logger.info({ username: me.username, id: me.id }, 'Бот автентифікований');

  // Команди для приватного чату
  await bot.telegram.setMyCommands(
    [
      { command: 'start', description: 'Почати' },
      { command: 'cancel', description: 'Скасувати поточну дію' },
    ],
    { scope: { type: 'all_private_chats' } },
  );

  // Окремий набір для груп - щоб менеджери бачили саме свої команди
  await bot.telegram.setMyCommands(
    [
      { command: 'chatid', description: 'ID чату й топіка' },
      { command: 'campaigns', description: 'Список кампаній' },
      { command: 'campaign', description: 'activate | pause | finish <slug>' },
      { command: 'stats', description: 'Статистика' },
      { command: 'prizes', description: 'Склад призів кампанії' },
      { command: 'draw', description: 'Розіграш головних призів' },
      { command: 'export', description: 'Вигрузка .xlsx' },
      { command: 'bind_topic', description: 'Прив’язати топік до кампанії' },
    ],
    { scope: { type: 'all_group_chats' } },
  );

  void bot.launch({ dropPendingUpdates: true }, () => {
    logger.info('Long polling запущено');
  });
}
