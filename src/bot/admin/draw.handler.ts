import { Composer, Markup } from 'telegraf';
import type { AppContext } from '../context.js';
import { isSuperAdmin } from './guard.js';
import { campaignRepo } from '../../db/repositories/campaign.repo.js';
import { prisma } from '../../db/client.js';
import { drawService, type DrawPlan } from '../../domain/draw/draw.service.js';
import { contentService } from '../../domain/content/content.service.js';
import { formatPhone } from '../../domain/users/phone.js';
import { putPending, takePending, type PendingId } from './pending.js';
import { encodeCallback } from '../keyboards/callback.js';
import { broadcast } from '../../infra/queue.js';
import { userRepo } from '../../db/repositories/user.repo.js';
import { formatDate } from '../../shared/datetime.js';
import { replyCampaignNotFound } from './campaign-helpers.js';

export const drawHandler = new Composer<AppContext>();

type DrawPending = {
  campaignId: string;
  campaignTitle: string;
  name: string;
  plan: DrawPlan;
};

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * /draw <slug> <приз>:<кількість> [...] [--repeat]
 */
drawHandler.command('draw', async (ctx) => {
  if (!(await isSuperAdmin(ctx.from.id))) return;

  const parts = ctx.message.text.split(/\s+/).slice(1);
  const slug = parts.shift();
  const allowRepeat = parts.includes('--repeat');
  const prizeArgs = parts.filter((p) => !p.startsWith('--'));

  if (!slug || prizeArgs.length === 0) {
    await ctx.reply(
      'Використання:\n' +
        '<code>/draw <slug> tv:1 phone:3</code>\n\n' +
        '<code>--repeat</code> - дозволити одній людині виграти кілька призів\n\n' +
        'Переглянути ключі призів: /prizes <slug>',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const campaign = await campaignRepo.findBySlug(slug);
  if (!campaign) {
    await replyCampaignNotFound(ctx, slug);
    return;
  }

  const available = await prisma.prize.findMany({ where: { campaignId: campaign.id } });

  const prizes: { key: string; title: string; count: number }[] = [];

  for (const raw of prizeArgs) {
    const [key, countRaw] = raw.split(':');
    const count = Number(countRaw ?? 1);
    const prize = available.find((p) => p.key === key);

    if (!prize) {
      await ctx.reply(
        `❌ Приз «${key}» не заведений у кампанії.\n` +
          `Наявні: ${available.map((p) => p.key).join(', ') || '-'}`,
      );
      return;
    }
    if (!Number.isInteger(count) || count < 1) {
      await ctx.reply(`❌ Некоректна кількість для «${key}»: ${countRaw}`);
      return;
    }

    prizes.push({ key: prize.key, title: prize.title, count });
  }

  const tickets = await drawService.loadTickets(campaign.id);

  if (tickets.length === 0) {
    await ctx.reply('❌ Немає жодної активації - нема серед кого розігрувати');
    return;
  }

  const seed = drawService.generateSeed();
  const plan = drawService.plan(tickets, prizes, seed, {
    uniqueWinners: !allowRepeat,
  });

  const totalPrizes = prizes.reduce((sum, p) => sum + p.count, 0);
  const name = `Розіграш ${formatDate(new Date())}`;

  const pendingId = await putPending<DrawPending>('draw', ctx.from.id, {
    campaignId: campaign.id,
    campaignTitle: campaign.title,
    name,
    plan,
  });

  const lines = [
    `🎲 <b>${esc(campaign.title)}</b>`,
    '',
    `Квитків (активацій): <b>${plan.totalTickets}</b>`,
    `Унікальних учасників: <b>${plan.uniqueParticipants}</b>`,
    `Один приз на людину: ${allowRepeat ? 'ні' : 'так'}`,
    '',
    `<b>SEED:</b> <code>${plan.seed}</code>`,
    '',
  ];

  if (plan.winners.length < totalPrizes) {
    lines.push(
      `⚠️ Призначено ${plan.winners.length} з ${totalPrizes}`,
      '',
    );
  }

  lines.push('🏆 <b>Переможці:</b>');

  for (const [i, w] of plan.winners.slice(0, 25).entries()) {
    lines.push(
      `${i + 1}. ${esc(w.prizeTitle)} - ${esc(w.fullName ?? '?')} ` +
        `${w.phone ? esc(formatPhone(w.phone)) : ''}`,
    );
  }

  if (plan.winners.length > 25) {
    lines.push(`<i>…і ще ${plan.winners.length - 25}</i>`);
  }

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback(
          '🎲 Зафіксувати',
          encodeCallback({ kind: 'confirm', pendingId }),
        ),
        Markup.button.callback(
          '✖️ Скасувати',
          encodeCallback({ kind: 'cancel', pendingId }),
        ),
      ],
    ]),
  });
});

drawHandler.command('prizes', async (ctx) => {
  if (!(await isSuperAdmin(ctx.from.id))) return;

  const slug = ctx.message.text.split(/\s+/)[1];
  if (!slug) {
    await ctx.reply('Використання: /prizes <slug>');
    return;
  }

  const campaign = await campaignRepo.findBySlug(slug);
  if (!campaign) {
    await replyCampaignNotFound(ctx, slug);
    return;
  }

  const prizes = await prisma.prize.findMany({
    where: { campaignId: campaign.id },
    orderBy: { sortOrder: 'asc' },
  });

  if (prizes.length === 0) {
    await ctx.reply('У кампанії немає призів.');
    return;
  }

  const lines = prizes.map((p) => {
    const left = p.stock === null ? '∞' : String(p.stock - p.issued - p.reserved);
    return (
      `<code>${p.key}</code> - ${esc(p.title)}\n` +
      `   видано ${p.issued} · резерв ${p.reserved} · лишилось ${left}`
    );
  });

  await ctx.reply(`🎁 <b>${esc(campaign.title)}</b>\n\n${lines.join('\n')}`, {
    parse_mode: 'HTML',
  });
});

/**
 * Фіксація розіграшу + одразу розсилка переможцям
 */
export async function confirmDraw(
  ctx: AppContext,
  pendingId: PendingId,
): Promise<void> {
  const taken = await takePending<DrawPending>('draw', pendingId, ctx.from!.id);

  if (!taken.ok) {
    await ctx.answerCbQuery(
      taken.reason === 'not_owner'
        ? 'Зафіксувати може лише той, хто запустив розіграш'
        : 'Термін підтвердження минув - запусти /draw ще раз',
      { show_alert: true },
    );
    return;
  }

  await ctx.answerCbQuery('Фіксую…');
  await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);

  const { campaignId, campaignTitle, name, plan } = taken.payload;

  const drawId = await drawService.commit(
    campaignId,
    name,
    plan,
    BigInt(ctx.from!.id),
  );

  await ctx.reply(
    `✅ Розіграш зафіксовано\n\n` +
      `ID: <code>${drawId}</code>\n` +
      `SEED: <code>${plan.seed}</code>\n\n` +
      `Розсилаю переможцям…`,
    { parse_mode: 'HTML' },
  );

  const draw = await drawService.findDraw(drawId);
  if (!draw) return;

  const chooseStore = await contentService.t('button.choose_store');

  const tasks = await Promise.all(
    draw.winners.map(async (winner) => {
      const claim = await prisma.prizeClaim.findFirst({
        where: { drawWinnerId: winner.id },
        select: { id: true },
      });

      const text = await contentService.t(
        'draw.winner',
        { prize: winner.prize.title },
        { campaignId },
      );

      return {
        item: winner,
        telegramId: winner.user.telegramId,
        send: async () => {
          await ctx.telegram.sendMessage(
            winner.user.telegramId.toString(),
            text,
            claim
              ? Markup.inlineKeyboard([
                  [
                    Markup.button.callback(
                      chooseStore,
                      encodeCallback({ kind: 'chooseStore', claimId: claim.id }),
                    ),
                  ],
                ])
              : undefined,
          );

          await prisma.drawWinner.update({
            where: { id: winner.id },
            data: { notifiedAt: new Date() },
          });
        },
      };
    }),
  );

  const result = await broadcast(tasks, {
    onBlocked: async (task) => {
      await userRepo.markBlocked(task.telegramId);
      await prisma.drawWinner.update({
        where: { id: task.item.id },
        data: { notifiedAt: new Date() },
      });
    },
  });

  const summary = [
    `📣 <b>Розсилка завершена</b> - ${esc(campaignTitle)}`,
    '',
    `✅ Надіслано: ${result.sent}`,
    result.blocked ? `🚫 Заблокували бота: ${result.blocked}` : '',
    result.failed ? `❌ Помилок: ${result.failed}` : '',
  ].filter(Boolean);

  if (result.blocked > 0) {
    summary.push(
      '',
      '<i>Тих, хто заблокував бота, шукайте за телефоном у /export - ' +
        'приз за ними лишається.</i>',
    );
  }

  await ctx.reply(summary.join('\n'), { parse_mode: 'HTML' });

  ctx.log?.info({ drawId, ...result }, 'розіграш проведено');
}
