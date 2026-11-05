import { Composer } from 'telegraf';
import type { AppContext } from '../context.js';
import { isSuperAdmin } from './guard.js';
import { campaignRepo } from '../../db/repositories/campaign.repo.js';
import { replyCampaignNotFound } from './campaign-helpers.js';
import { parsePrizeLines } from '../../domain/prizes/parse-prize-line.js';
import { prizeService } from '../../domain/prizes/prize.service.js';
import type { Campaign } from '../../generated/prisma/client.js';

export const prizesHandler = new Composer<AppContext>();

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const codeList = (keys: readonly string[]): string =>
  keys.map((k) => `<code>${esc(k)}</code>`).join(', ');

const USAGE = [
  '<b>Призи кампанії</b>',
  '',
  '<code>/prizes slug</code> - список',
  '',
  '<code>/prizes slug add</code>',
  '<code>key | назва | кількість [| grand]</code>',
  '<i>по одному призу на рядок; кількість - число або ∞</i>',
  '',
  '<code>/prizes slug update</code> - той самий формат, ключ має існувати',
  '<i>рядок можна скопіювати зі списку</i>',
  '',
  '<code>/prizes slug remove key [key…]</code>',
  '<i>приз із заявками не видаляється, а закривається</i>',
].join('\n');

prizesHandler.command('prizes', async (ctx) => {
  if (!(await isSuperAdmin(ctx.from.id))) return;

  const [firstLine = '', ...bodyLines] = ctx.message.text.split('\n');
  const [, slug, action, ...inlineArgs] = firstLine.trim().split(/\s+/);

  if (!slug) {
    await ctx.reply(USAGE, { parse_mode: 'HTML' });
    return;
  }

  const campaign = await campaignRepo.findBySlug(slug);
  if (!campaign) {
    await replyCampaignNotFound(ctx, slug);
    return;
  }

  const actorId = BigInt(ctx.from.id);

  switch (action) {
    case undefined: {
      await replyPrizeList(ctx, campaign);
      return;
    }

    case 'add':
    case 'update': {
      const parsed = parsePrizeLines(bodyLines);
      if (!parsed.ok) {
        await replyErrors(ctx, parsed.error);
        return;
      }

      const result =
        action === 'add'
          ? await prizeService.add(campaign.id, parsed.value, actorId)
          : await prizeService.update(campaign.id, parsed.value, actorId);

      if (!result.ok) {
        await replyErrors(ctx, result.error);
        return;
      }

      const verb = action === 'add' ? 'Додано' : 'Оновлено';
      await replyWithRulesCheck(ctx, campaign, `✅ ${verb}: ${codeList(result.value.map((p) => p.key))}`);
      ctx.log?.info({ slug, action, keys: result.value.map((p) => p.key) }, 'призи змінено');
      return;
    }

    case 'remove': {
      const keys = [...inlineArgs, ...bodyLines.flatMap((l) => l.trim().split(/\s+/))].filter(Boolean);
      const result = await prizeService.remove(campaign.id, keys, actorId);

      if (!result.ok) {
        await replyErrors(ctx, result.error);
        return;
      }

      const { deleted, closed } = result.value;
      const lines: string[] = [];
      if (deleted.length > 0) lines.push(`🗑 Видалено: ${codeList(deleted)}`);
      if (closed.length > 0) {
        lines.push(
          `🔒 Закрито: ${codeList(closed)}`,
          '<i>По них уже є заявки чи переможці, тож історію лишаю - просто більше не видаватимуться</i>',
        );
      }

      await replyWithRulesCheck(ctx, campaign, lines.join('\n'));
      ctx.log?.info({ slug, deleted, closed }, 'призи прибрано');
      return;
    }

    default: {
      await ctx.reply(`❌ Невідома дія «${esc(action)}»\n\n${USAGE}`, { parse_mode: 'HTML' });
    }
  }
});

async function replyPrizeList(ctx: AppContext, campaign: Campaign): Promise<void> {
  const prizes = await prizeService.list(campaign.id);

  if (prizes.length === 0) {
    await replyWithRulesCheck(
      ctx,
      campaign,
      `🎁 <b>${esc(campaign.title)}</b>\n\nПризів ще немає. Додати: <code>/prizes ${esc(campaign.slug)} add</code>`,
    );
    return;
  }

  const lines = prizes.map((p) => {
    const left = p.stock === null ? '∞' : String(p.stock - p.issued - p.reserved);
    const kind = p.kind === 'GRAND' ? ' | grand' : '';
    return (
      `<code>${esc(p.key)} | ${esc(p.title)} | ${p.stock ?? '∞'}${kind}</code>\n` +
      `   видано ${p.issued} · резерв ${p.reserved} · лишилось ${left}`
    );
  });

  await replyWithRulesCheck(ctx, campaign, `🎁 <b>${esc(campaign.title)}</b>\n\n${lines.join('\n')}`);
}

async function replyWithRulesCheck(ctx: AppContext, campaign: Campaign, text: string): Promise<void> {
  const { missing, unused } = await prizeService.checkAgainstRules(campaign);

  const notes: string[] = [];
  if (missing.length > 0) {
    notes.push(
      `⚠️ Правила посилаються на призи, яких немає: ${codeList(missing)}`,
      '<i>Юзер, який їх «виграє», отримає «приз закінчився»</i>',
    );
  }
  if (unused.length > 0) {
    notes.push(`ℹ️ Правила не видають: ${codeList(unused)}`);
  }

  await ctx.reply(notes.length > 0 ? `${text}\n\n${notes.join('\n')}` : text, { parse_mode: 'HTML' });
}

async function replyErrors(ctx: AppContext, errors: readonly string[]): Promise<void> {
  await ctx.reply(
    `❌ Нічого не змінено:\n\n${errors.map((e) => `• ${esc(e)}`).join('\n')}`,
    { parse_mode: 'HTML' },
  );
}
