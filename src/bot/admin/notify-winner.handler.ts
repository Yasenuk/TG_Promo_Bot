import { Composer } from 'telegraf';
import { message } from 'telegraf/filters';
import type { AppContext } from '../context.js';
import { claimRepo } from '../../db/repositories/claim.repo.js';
import { userRepo } from '../../db/repositories/user.repo.js';
import { contentService } from '../../domain/content/content.service.js';
import { decodeCallback } from '../keyboards/callback.js';
import { isAdmin } from './guard.js';
import { asPendingId, putPending, takePending } from './pending.js';
import { isUserUnreachable } from '../../infra/telegram-errors.js';

export const notifyWinnerHandler = new Composer<AppContext>();

type NotePending = {
  claimId: string;
  promptMessageId: number;
};

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Запис прив'язаний до повідомлення-запрошення, щоб знайти його по reply */
const noteId = (chatId: number, messageId: number) =>
  asPendingId(`note_${chatId}_${messageId}`);

function managerName(from: { first_name: string; last_name?: string; username?: string; id: number }): string {
  return (
    [from.first_name, from.last_name].filter(Boolean).join(' ') ||
    (from.username ? `@${from.username}` : String(from.id))
  );
}

/** Крок 1: менеджер натиснув «Написати переможцю» */
notifyWinnerHandler.on('callback_query', async (ctx, next) => {
  const raw = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
  const action = raw ? decodeCallback(raw) : undefined;

  if (action?.kind !== 'notifyWinner') return next();

  if (!(await isAdmin(ctx.from.id))) {
    await ctx.answerCbQuery('Недостатньо прав', { show_alert: true });
    return;
  }

  const claim = await claimRepo.findById(action.claimId);
  const chatId = ctx.chat?.id;

  if (!claim || chatId === undefined) {
    await ctx.answerCbQuery('Заявку не знайдено', { show_alert: true });
    return;
  }

  await ctx.answerCbQuery('Напиши повідомлення відповіддю');

  const threadId =
    ctx.callbackQuery.message && 'message_thread_id' in ctx.callbackQuery.message
      ? ctx.callbackQuery.message.message_thread_id
      : undefined;

  const who = `<a href="tg://user?id=${ctx.from.id}">${esc(managerName(ctx.from))}</a>`;

  const prompt = await ctx.telegram.sendMessage(
    chatId.toString(),
    `✍️ ${who}, що написати переможцю про «${esc(claim.prize.title)}»?\n\n` +
      '<i>Відповідай на це повідомлення. Текст піде людині від бота. Є 10 хвилин.</i>',
    {
      parse_mode: 'HTML',
      ...(threadId ? { message_thread_id: threadId } : {}),
      reply_markup: {
        force_reply: true,
        selective: true,
        input_field_placeholder: 'Приз буде в магазині у четвер',
      },
    },
  );

  await putPending<NotePending>(
    'note',
    ctx.from.id,
    { claimId: claim.id, promptMessageId: prompt.message_id },
    noteId(chatId, prompt.message_id),
  );

  ctx.log?.info({ claimId: claim.id, by: ctx.from.id }, 'менеджер пише переможцю');
});

/**
 * Крок 2: відповідь на те саме повідомлення.
 * takePending повертає not_owner, якщо відповів хтось інший - тоді мовчки далі.
 */
notifyWinnerHandler.on(message('text'), async (ctx, next) => {
  if (ctx.chat.type === 'private') return next();

  const replyTo = ctx.message.reply_to_message;
  if (!replyTo) return next();

  const text = ctx.message.text.trim();
  if (!text || text.startsWith('/')) return next();

  const taken = await takePending<NotePending>(
    'note',
    noteId(ctx.chat.id, replyTo.message_id),
    ctx.from.id,
  );

  if (!taken.ok) {
    if (taken.reason === 'not_owner') {
      ctx.log?.debug({ by: ctx.from.id }, 'відповів не той, хто натиснув кнопку');
    }
    return next();
  }

  const claim = await claimRepo.findById(taken.payload.claimId);
  const threadId = ctx.message.message_thread_id;

  const reply = (body: string) =>
    ctx.telegram.sendMessage(ctx.chat.id.toString(), body, {
      parse_mode: 'HTML',
      ...(threadId ? { message_thread_id: threadId } : {}),
    });

  if (!claim) {
    await reply('❌ Заявку не знайдено - можливо, її вже прибрали.');
    return;
  }

  const header = await contentService.t(
    'prize.note_header',
    { prize: claim.prize.title },
    { campaignId: claim.campaignId },
  );

  try {
    await ctx.telegram.sendMessage(
      claim.user.telegramId.toString(),
      `${header}\n\n${text}`,
    );
  } catch (error) {
    if (isUserUnreachable(error)) {
      await userRepo.markBlocked(claim.user.telegramId);
      await reply('🚫 Людина заблокувала бота - повідомлення не дійшло.');
      return;
    }

    ctx.log?.error({ error, claimId: claim.id }, 'не вдалося написати переможцю');
    await reply('❌ Не вдалося надіслати. Спробуй ще раз.');
    return;
  }

  // Прибираємо запрошення, щоб топік не засмічувався
  await ctx.telegram
    .deleteMessage(ctx.chat.id.toString(), taken.payload.promptMessageId)
    .catch(() => undefined);

  await reply(
    `✉️ <b>${esc(managerName(ctx.from))}</b> написав(ла) переможцю:\n\n${esc(text)}`,
  );

  ctx.log?.info({ claimId: claim.id, by: ctx.from.id }, 'повідомлення переможцю надіслано');
});
