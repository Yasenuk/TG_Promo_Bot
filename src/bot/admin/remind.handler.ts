import { Composer, Markup } from "telegraf";
import type { AppContext } from "../context.js";

import { claimRepo } from "../../db/repositories/claim.repo.js";
import { campaignRepo } from "../../db/repositories/campaign.repo.js";

import { replyCampaignNotFound } from "./campaign-helpers.js";

import { isSuperAdmin } from "./guard.js";
import { putPending, takePending, type PendingId } from "./pending.js";
import { encodeCallback } from "../keyboards/callback.js";
import { contentService } from "../../domain/content/content.service.js";
import { broadcast } from "../../infra/queue.js";
import { userRepo } from "../../db/repositories/user.repo.js";
import { logger } from "../../infra/logger.js";

const COOLDOWN_MS = 24 * 60 * 60_000;

type RemindPending = { campaignId: string; campaignTitle: string; chatId: number; threadId?: number };
type Claims = Awaited<ReturnType<typeof claimRepo.listForStoreReminder>>;

const groupByUser = (claims: Claims) => {
  const map = new Map<string, Claims>();
  for (const c of claims) map.set(c.userId, [...(map.get(c.userId) ?? []), c]);
  return map;
};

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const remindHandler = new Composer<AppContext>();

remindHandler.command('remind_store', async (ctx) => {
  if (!(await isSuperAdmin(ctx.from.id))) return;

  const slug = ctx.message.text.split(/\s+/)[1];
  if (!slug) return void ctx.reply('Використання: /remind_store <slug>');

  const campaign = await campaignRepo.findBySlug(slug);
  if (!campaign) return replyCampaignNotFound(ctx, slug);

  const claims = await claimRepo.listForStoreReminder(campaign.id, COOLDOWN_MS);
  const users = groupByUser(claims);

  if (users.size === 0) {
    return void ctx.reply('Нікому нагадувати: всі обрали магазин або вже отримали нагадування за останні 24 год.');
  }

  const pendingId = await putPending<RemindPending>('remind', ctx.from.id, {
    campaignId: campaign.id,
    campaignTitle: campaign.title,
    chatId: ctx.chat.id,
    threadId: ctx.message.message_thread_id,
  });

  await ctx.reply(
    `📣 <b>${esc(campaign.title)}</b>\n\nНагадаю <b>${users.size}</b> людям (заявок: ${claims.length}).`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[
        Markup.button.callback('📣 Розіслати', encodeCallback({ kind: 'confirm', pendingId })),
        Markup.button.callback('✖️ Скасувати', encodeCallback({ kind: 'cancel', pendingId })),
      ]]),
    },
  );
});

export async function confirmRemind(ctx: AppContext, pendingId: PendingId): Promise<void> {
  const taken = await takePending<RemindPending>('remind', pendingId, ctx.from!.id);
  if (!taken.ok) {
    await ctx.answerCbQuery('Підтвердити може лише той, хто запустив', { show_alert: true });
    return;
  }

  await ctx.answerCbQuery('Розсилаю…');
  await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);

  const { campaignId, chatId, threadId } = taken.payload;
  const telegram = ctx.telegram;

  // у фоні: handlerTimeout 30с не переживе велику розсилку
  void (async () => {
    const claims = await claimRepo.listForStoreReminder(campaignId, COOLDOWN_MS); // свіжий список
    const chooseStore = await contentService.t('button.choose_store');

    const tasks = [...groupByUser(claims).values()].map((userClaims) => {
      const { user } = userClaims[0]!;
      return {
        item: userClaims,
        telegramId: user.telegramId,
        send: async () => {
          const text = await contentService.t(
            'prize.remind_store',
            { prizes: userClaims.map((c) => `🎁 ${c.prize.title}`).join('\n') },
            { campaignId },
          );
          const buttons = userClaims.map((c) => [
            Markup.button.callback(
              userClaims.length > 1 ? `${chooseStore}: ${c.prize.title}` : chooseStore,
              encodeCallback({ kind: 'chooseStore', claimId: c.id }),
            ),
          ]);
          await telegram.sendMessage(user.telegramId.toString(), text, Markup.inlineKeyboard(buttons));
          await claimRepo.markReminded(userClaims.map((c) => c.id));
        },
      };
    });

    const r = await broadcast(tasks, {
      onBlocked: async (t) => {
        await userRepo.markBlocked(t.telegramId);
      },
    });

    await telegram.sendMessage(
      chatId.toString(),
      `📣 Нагадування розіслано\n✅ ${r.sent} · 🚫 ${r.blocked} · ❌ ${r.failed}`,
      threadId ? { message_thread_id: threadId } : {},
    );
  })().catch((error: unknown) => logger.error({ error, campaignId }, 'remind_store впав'));
}