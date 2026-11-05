import { Composer, Markup } from 'telegraf';
import type { AppContext } from '../context.js';
import { isSuperAdmin } from './guard.js';
import { campaignRepo } from '../../db/repositories/campaign.repo.js';
import { prisma } from '../../db/client.js';
import { putPending, takePending, type PendingId } from './pending.js';
import { encodeCallback } from '../keyboards/callback.js';
import type { CampaignStatus } from '../../generated/prisma/client.js';
import { replyCampaignNotFound } from './campaign-helpers.js';

export const campaignHandler = new Composer<AppContext>();

type CampaignPending = {
  slug: string;
  title: string;
  status: CampaignStatus;
};

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ACTIONS: Record<string, CampaignStatus> = {
  activate: 'ACTIVE',
  pause: 'PAUSED',
  finish: 'FINISHED',
  draft: 'DRAFT',
};

const DESCRIPTION: Record<CampaignStatus, string> = {
  ACTIVE: 'Бот почне приймати коди цієї кампанії.',
  PAUSED: 'Бот перестане приймати коди. Дані зберігаються, можна відновити.',
  FINISHED: 'Акція завершується. Коди більше не приймаються.',
  DRAFT: 'Кампанія повертається в чернетку.',
};

/**
 * /campaign activate|pause|finish|draft <slug>
 */
campaignHandler.command('campaign', async (ctx) => {
  if (!(await isSuperAdmin(ctx.from.id))) return;

  const [, action, slug] = ctx.message.text.split(/\s+/);

  if (!action || !slug) {
    await ctx.reply(
      'Використання:\n' +
        '<code>/campaign activate hype</code> - почати приймати коди\n' +
        '<code>/campaign pause hype</code> - призупинити\n' +
        '<code>/campaign finish hype</code> - завершити акцію\n\n' +
        'Список: /campaigns',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const status = ACTIONS[action];
  if (!status) {
    await ctx.reply(`❌ Невідома дія «${action}». Доступні: activate, pause, finish, draft`);
    return;
  }

  const campaign = await campaignRepo.findBySlug(slug);
  if (!campaign) {
    await replyCampaignNotFound(ctx, slug);
    return;
  }

  if (campaign.status === status) {
    await ctx.reply(`Кампанія вже у статусі ${status}.`);
    return;
  }

  // Перед активацією перевіряємо готовність
  const warnings: string[] = [];

  if (status === 'ACTIVE') {
    const [codes, prizes] = await Promise.all([
      prisma.code.count({ where: { campaignId: campaign.id, isUsed: false } }),
      prisma.prize.count({ where: { campaignId: campaign.id } }),
    ]);

    if (codes === 0) warnings.push('⚠️ У кампанії немає вільних кодів');
    if (prizes === 0) warnings.push('⚠️ У кампанії не заведено призів');
    if (!campaign.adminThreadId) {
      warnings.push('⚠️ Топік не прив’язано - заявки підуть у General');
    }
  }

  const pendingId = await putPending<CampaignPending>('campaign', ctx.from.id, {
    slug,
    title: campaign.title,
    status,
  });

  const lines = [
    `<b>${esc(campaign.title)}</b>`,
    '',
    `${campaign.status} → <b>${status}</b>`,
    '',
    DESCRIPTION[status],
  ];

  if (warnings.length) lines.push('', ...warnings);

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Так', encodeCallback({ kind: 'confirm', pendingId })),
        Markup.button.callback('✖️ Ні', encodeCallback({ kind: 'cancel', pendingId })),
      ],
    ]),
  });
});

export async function confirmCampaign(
  ctx: AppContext,
  pendingId: PendingId,
): Promise<void> {
  const taken = await takePending<CampaignPending>('campaign', pendingId, ctx.from!.id);

  if (!taken.ok) {
    await ctx.answerCbQuery(
      taken.reason === 'not_owner'
        ? 'Підтвердити може лише той, хто виконав команду'
        : 'Термін підтвердження минув',
      { show_alert: true },
    );
    return;
  }

  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);

  const { slug, title, status } = taken.payload;
  await campaignRepo.setStatus(slug, status);

  const emoji = status === 'ACTIVE' ? '🟢' : status === 'PAUSED' ? '⏸' : '⚪️';
  await ctx.reply(`${emoji} «${title}» → ${status}`);

  ctx.log?.info({ slug, status, by: ctx.from!.id }, 'статус кампанії змінено');
}
