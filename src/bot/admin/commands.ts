import { Composer } from 'telegraf';
import type { AppContext } from '../context.js';

import { z } from 'zod';
import { listStrategyTypes, validateCampaignRules, type CampaignRules } from '../../domain/rules/index.js';

import { env } from '../../config/env.js';

import { campaignRepo } from '../../db/repositories/campaign.repo.js';
import { codeRepo } from '../../db/repositories/code.repo.js';
import { prisma } from '../../db/client.js';
import { contentRepo } from '../../db/repositories/content.repo.js';

import { isAdmin, isSuperAdmin } from './guard.js';
import { replyCampaignNotFound } from './campaign-helpers.js';
import { parseTelegramError } from '../../infra/telegram-errors.js';
import { formatIsoDate } from '../../shared/datetime.js';

import { buildCampaignWorkbook } from '../../domain/export/xlsx.service.js';
import { invalidateContentCache } from '../../domain/content/content.service.js';
import type { ContentKey } from '../../domain/content/keys.js';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const adminCommands = new Composer<AppContext>();

/**
 * Показує id чату й топіка
 */
adminCommands.command('chatid', async (ctx) => {
  const chat = ctx.chat;
  const threadId = 'message_thread_id' in ctx.message ? ctx.message.message_thread_id : undefined;
  const isForum = 'is_forum' in chat ? chat.is_forum : false;

  const lines = [
    `<b>Chat ID:</b> <code>${chat.id}</code>`,
    `<b>Тип:</b> ${chat.type}${isForum ? ' (форум ✅)' : ''}`,
  ];

  if (threadId) {
    lines.push(`<b>Thread ID:</b> <code>${threadId}</code>`);
  } else if (chat.type !== 'private') {
    lines.push('<i>Це General або топіки вимкнені</i>');
  }

  lines.push('', `<b>Твій ID:</b> <code>${ctx.from.id}</code>`);

  if (chat.type === 'supergroup' && !isForum) {
    lines.push('', '⚠️ Топіки вимкнені. Увімкни їх у налаштуваннях групи.');
  }
  if (chat.type === 'group') {
    lines.push(
      '',
      '⚠️ Це звичайна група, топіки тут недоступні.',
    );
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
});

/**
 * Прив'язка топіка до кампанії
 */
adminCommands.command('bind_topic', async (ctx) => {
  if (!(await isSuperAdmin(ctx.from.id))) return;

  const slug = ctx.message.text.split(/\s+/)[1];
  if (!slug) {
    await ctx.reply('Використання: /bind_topic <slug-кампанії>');
    return;
  }

  const threadId = ctx.message.message_thread_id;
  if (!threadId) {
    await ctx.reply(
      'Виконай цю команду всередині топіка кампанії.',
    );
    return;
  }

  const campaign = await campaignRepo.findBySlug(slug);
  if (!campaign) {
    await replyCampaignNotFound(ctx, slug);
    return;
  }

  await campaignRepo.bindAdminThread(slug, threadId);
  await ctx.reply(`✅ Топік прив'язано до кампанії «${campaign.title}».`);
});

adminCommands.command('campaigns', async (ctx) => {
  if (!(await isAdmin(ctx.from.id))) return;

  const campaigns = await campaignRepo.listAll();
  if (campaigns.length === 0) {
    await ctx.reply('Кампаній ще немає.');
    return;
  }

  const lines = campaigns.map(
    (c) =>
      `${c.status === 'ACTIVE' ? '🟢' : '⚪️'} ${c.slug} - ${c.title}` +
      `${c.adminThreadId ? '' : '  ⚠️ топік не прив’язано'}`,
  );

  await ctx.reply(lines.join('\n'));
});

adminCommands.command('stats', async (ctx) => {
  if (!(await isAdmin(ctx.from.id))) return;

  const slug = ctx.message.text.split(/\s+/)[1];
  const campaign = slug ? await campaignRepo.findBySlug(slug) : undefined;

  if (slug && !campaign) {
    await replyCampaignNotFound(ctx, slug);
    return;
  }

  const where = campaign ? { campaignId: campaign.id } : {};

  const [participants, activations, claims, codeStats] = await Promise.all([
    prisma.participation.count({ where }),
    prisma.activation.count({ where }),
    prisma.prizeClaim.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    }),
    campaign ? codeRepo.countByCampaign(campaign.id) : Promise.resolve([]),
  ]);

  const used = codeStats.find((r) => r.isUsed)?._count._all ?? 0;
  const free = codeStats.find((r) => !r.isUsed)?._count._all ?? 0;

  const lines = [
    `📊 ${campaign ? campaign.title : 'Усі кампанії'}`,
    '',
    `👥 Учасників: ${participants}`,
    `🎟 Активацій: ${activations}`,
    ...(campaign ? [`🔢 Кодів: ${used} використано / ${free} вільно`] : []),
    '',
    '🎁 Заявки:',
    ...claims.map((c) => `   ${c.status}: ${c._count._all}`),
  ];

  await ctx.reply(lines.join('\n'));
});

/** Редагування текстів без деплою */
adminCommands.command('text', async (ctx) => {
  if (!(await isSuperAdmin(ctx.from.id))) return;

  const [, sub, ...rest] = ctx.message.text.split(/\s+/);

  if (sub === 'list') {
    const rows = await contentRepo.listKeys(null);
    const lines = rows.map((r) => `${r.key} = ${r.value.slice(0, 40)}…`);
    await ctx.reply(lines.join('\n') || 'У БД перевизначень немає.');
    return;
  }

  if (sub === 'set') {
    const key = rest[0];
    const value = ctx.message.text.split(/\s+/).slice(3).join(' ');

    if (!key || !value) {
      await ctx.reply('Використання: /text set <ключ> <текст>');
      return;
    }

    await contentRepo.set(key, value, null, 'uk', BigInt(ctx.from.id));
    invalidateContentCache(key as ContentKey);
    await ctx.reply(`✅ Оновлено «${key}».`);
    return;
  }

  await ctx.reply('Використання:\n/text list\n/text set <ключ> <текст>');
});

/**
 * Вигрузка прямо в чат: /export <slug>
 */
adminCommands.command('export', async (ctx) => {
  if (!(await isAdmin(ctx.from.id))) return;

  const slug = ctx.message.text.split(/\s+/)[1];
  if (!slug) {
    await ctx.reply('Використання: /export <slug-кампанії>');
    return;
  }

  const campaign = await campaignRepo.findBySlug(slug);
  if (!campaign) {
    await replyCampaignNotFound(ctx, slug);
    return;
  }

  await ctx.reply('Готую вигрузку…');

  const threadId = ctx.message.message_thread_id;

  try {
    const workbook = await buildCampaignWorkbook(campaign.id);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const stamp = formatIsoDate();

    await ctx.replyWithDocument(
      { source: buffer, filename: `${slug}-${stamp}.xlsx` },
      {
        caption:
          `📊 ${campaign.title}\n\n` +
          'Лист «Активації» - для розіграшу: 1 код = 1 рядок.',
        ...(threadId ? { message_thread_id: threadId } : {}),
      },
    );
  } catch (error) {
    ctx.log?.error({ error, slug }, 'вигрузка не вдалася');

    // Це адмінська команда - показуємо причину, а не «щось пішло не так»
    const info = parseTelegramError(error);
    const reason = info
      ? `Telegram ${info.code}: ${info.description}`
      : error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);

    await ctx.reply(`❌ Вигрузка не вдалася.\n\n<code>${escapeHtml(reason)}</code>`, {
      parse_mode: 'HTML',
      ...(threadId ? { message_thread_id: threadId } : {}),
    });
  }
});

// Створює кампанію з правилами-заглушкою: /create_campaign <slug> <стратегія> <назва>
adminCommands.command('create_campaign', async (ctx) => {
  if (!(await isSuperAdmin(ctx.from.id))) return;

  const [firstLine = '', ...configLines] = ctx.message.text.split('\n');
  const [, slug, strategy, ...titleParts] = firstLine.trim().split(/\s+/);
  const title = titleParts.join(' ');
  const rawConfig = configLines.join('\n').trim();

  if (!slug || !strategy || !title || !rawConfig) {
    await ctx.reply(
      'Використання:\n/create_campaign <slug> <стратегія> <назва>\n<JSON-конфіг з нового рядка>',
    );
    return;
  }

  const knownStrategies = listStrategyTypes();
  if (!knownStrategies.includes(strategy)) {
    await ctx.reply(
      `❌ Невідома стратегія «${strategy}». Доступні: ${knownStrategies.join(', ')}`,
    );
    return;
  }

  const existing = await campaignRepo.findBySlug(slug);
  if (existing) {
    await ctx.reply(`🟡 Кампанія зі slug «${slug}» вже існує.`);
  }

  let rules: CampaignRules;
  try {
    rules = validateCampaignRules({
      strategies: [{ type: strategy, config: JSON.parse(rawConfig) }],
    });
  } catch (error) {
    const reason =
      error instanceof z.ZodError
        ? z.prettifyError(error)
        : error instanceof Error
          ? error.message // SyntaxError від JSON.parse
          : String(error);
    await ctx.reply(`❌ Кривий конфіг для «${strategy}»:\n\n${reason}`);
    return;
  }

  await campaignRepo.create({
    slug,
    title,
    rules: rules as never,
    status: 'DRAFT',
    startsAt: null,
    endsAt: null,
    adminThreadId: null,
    codePrefix: null,
  });

  if (env.ADMIN_CHAT_ID === undefined) {
    await ctx.reply(`✅ Кампанію «${title}» створено, але ADMIN_CHAT_ID не заданий - топік не створено.`);
    return;
  }

  try {
    const topic = existing && existing?.adminThreadId !== null
      ? { message_thread_id: existing.adminThreadId }
      : await ctx.telegram.createForumTopic(
        env.ADMIN_CHAT_ID.toString(),
        title.slice(0, 128),
      );

    await campaignRepo.bindAdminThread(slug, topic.message_thread_id);
    await ctx.reply(`✅ Кампанію «${title}» ${existing ? 'оновлено' : 'створено'} та топік прив'язано.`);
  } catch (error) {
    ctx.log?.error({ error, slug }, 'не вдалося створити топік');
    const info = parseTelegramError(error);
    await ctx.reply(
      '⚠️ Кампанію створено, а топік - ні' +
      (info ? ` (Telegram ${info.code}: ${info.description})` : '') +
      `.\nСтвори топік вручну і виконай у ньому /bind_topic ${slug}`
    );
  }
});

adminCommands.command('update_campaign', async (ctx) => {
  if (!(await isSuperAdmin(ctx.from.id))) return;

  const [firstLine = '', ...configLines] = ctx.message.text.split('\n');
  const [, slug, strategyType = ''] = firstLine.trim().split(/\s+/);
  const rawConfig = configLines.join('\n').trim();

  if (!slug || !rawConfig) {
    await ctx.reply(
      'Використання:\n/update_campaign <slug> [<стратегія>] \n[<JSON-конфіг з нового рядка>]',
    );
    return;
  }
  
  const campaignRules = await campaignRepo.findBySlug(slug).catch(() => null).then(c => c?.rules);
  if (!campaignRules) {
    await replyCampaignNotFound(ctx, slug);
    return;
  }
  
  const campaignRulesType = strategyType ||
    JSON.parse(JSON.stringify(campaignRules)).strategies[0].type;

  let rules: CampaignRules;
  try {
    rules = validateCampaignRules({
      strategies: [{ type: campaignRulesType, config: JSON.parse(rawConfig) }],
    });
  } catch (error) {
    const reason =
      error instanceof z.ZodError
        ? z.prettifyError(error)
        : error instanceof Error
          ? error.message // SyntaxError від JSON.parse
          : String(error);
    await ctx.reply(`❌ Кривий конфіг для «${campaignRulesType}»:\n\n${reason}`);
    return;
  }

  await prisma.campaign.update({
    where: { slug },
    data: { rules: rules as never },
  });
  
  await ctx.reply(`✅ Конфіг кампанії «${campaignRulesType}» оновлено.`);
});