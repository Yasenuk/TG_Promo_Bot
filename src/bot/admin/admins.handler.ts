import { Composer } from 'telegraf';
import type { AppContext } from '../context.js';
import { prisma } from '../../db/client.js';
import { env } from '../../config/env.js';
import { invalidateAdminCache, isSuperAdmin } from './guard.js';
import type { AdminRole } from '../../generated/prisma/client.js';

export const adminsHandler = new Composer<AppContext>();

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const USAGE = [
  '👥 <b>Керування доступами</b>',
  '',
  '<b>Додати менеджера</b> - відповідай на його повідомлення:',
  '<code>/admin add</code>',
  '',
  '<b>Додати супер-адміна:</b>',
  '<code>/admin add super</code>',
  '',
  '<b>Або за id:</b>',
  '<code>/admin add 660682549</code>',
  '<code>/admin add 660682549 super</code>',
  '',
  '<b>Прибрати:</b> реплаєм або за id',
  '<code>/admin remove</code>',
  '',
  '<b>Список:</b> <code>/admin list</code>',
  '',
  '<i>Свій id можна дізнатись командою /chatid</i>',
].join('\n');

adminsHandler.command('admin', async (ctx) => {
  if (!(await isSuperAdmin(ctx.from.id))) return;

  const parts = ctx.message.text.split(/\s+/).slice(1);
  const sub = parts[0]?.toLowerCase();

  if (!sub || !['add', 'remove', 'list'].includes(sub)) {
    await ctx.reply(USAGE, { parse_mode: 'HTML' });
    return;
  }

  if (sub === 'list') {
    await listAdmins(ctx);
    return;
  }

  const reply = ctx.message.reply_to_message;
  const args = parts.slice(1);

  // Цільова людина: або з реплаю, або перший числовий аргумент
  const idArg = args.find((a) => /^\d+$/.test(a));
  const wantsSuper = args.some((a) => a.toLowerCase() === 'super');

  let targetId: bigint | undefined;
  let targetName: string | undefined;

  if (reply?.from && !reply.from.is_bot) {
    targetId = BigInt(reply.from.id);
    targetName =
      [reply.from.first_name, reply.from.last_name].filter(Boolean).join(' ') ||
      (reply.from.username ? `@${reply.from.username}` : undefined);
  } else if (idArg) {
    targetId = BigInt(idArg);
  }

  if (targetId === undefined) {
    await ctx.reply(
      '❌ Не зрозуміло, кого саме.\n\n' +
        'Відповідай на повідомлення людини або вкажи її id.\n\n' + USAGE,
      { parse_mode: 'HTML' },
    );
    return;
  }

  if (sub === 'add') {
    await addAdmin(ctx, targetId, targetName, wantsSuper ? 'SUPER' : 'MANAGER');
    return;
  }

  await removeAdmin(ctx, targetId);
});

async function addAdmin(
  ctx: AppContext,
  telegramId: bigint,
  name: string | undefined,
  role: AdminRole,
): Promise<void> {
  await prisma.admin.upsert({
    where: { telegramId },
    update: { role, isActive: true, ...(name ? { name } : {}) },
    create: { telegramId, role, ...(name ? { name } : {}) },
  });

  invalidateAdminCache();

  const label = role === 'SUPER' ? 'супер-адмін' : 'менеджер';

  await ctx.reply(
    `✅ ${name ? esc(name) : telegramId.toString()} - тепер <b>${label}</b>\n\n` +
      (role === 'MANAGER'
        ? 'Може: підтверджувати видачу призів, /stats, /campaigns, /export'
        : 'Повний доступ до всіх команд'),
    { parse_mode: 'HTML' },
  );

  ctx.log?.info({ telegramId: telegramId.toString(), role }, 'адміна додано');

  await prisma.auditLog.create({
    data: {
      actorId: BigInt(ctx.from!.id),
      action: 'admin.added',
      entityType: 'Admin',
      entityId: telegramId.toString(),
      payload: { role },
    },
  });
}

async function removeAdmin(ctx: AppContext, telegramId: bigint): Promise<void> {
  // Захист від самоблокування: якщо прибрати останнього SUPER,
  // керувати доступами стане нікому
  const superAdmins = await prisma.admin.count({
    where: { role: 'SUPER', isActive: true },
  });

  const target = await prisma.admin.findUnique({ where: { telegramId } });

  if (!target || !target.isActive) {
    // Може бути в .env - звідти прибрати з бота не можна
    const inEnv = env.SUPER_ADMIN_IDS.some((id) => id === telegramId);
    await ctx.reply(
      inEnv
        ? '⚠️ Цей доступ заданий у .env (SUPER_ADMIN_IDS) - прибрати можна лише там.'
        : 'Такого адміна немає.',
    );
    return;
  }

  if (target.role === 'SUPER' && superAdmins <= 1) {
    await ctx.reply(
      '❌ Це останній супер-адмін. Спершу признач іншого, інакше нікому буде керувати доступами.',
    );
    return;
  }

  await prisma.admin.update({
    where: { telegramId },
    data: { isActive: false },
  });

  invalidateAdminCache();

  await ctx.reply(`✅ Доступ прибрано: ${target.name ?? telegramId.toString()}`);
  ctx.log?.info({ telegramId: telegramId.toString() }, 'адміна вимкнено');

  await prisma.auditLog.create({
    data: {
      actorId: BigInt(ctx.from!.id),
      action: 'admin.removed',
      entityType: 'Admin',
      entityId: telegramId.toString(),
    },
  });
}

async function listAdmins(ctx: AppContext): Promise<void> {
  const admins = await prisma.admin.findMany({
    where: { isActive: true },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
  });

  const lines = ['👥 <b>Доступи</b>', ''];

  const envOnly = env.SUPER_ADMIN_IDS.filter(
    (id) => !admins.some((a) => a.telegramId === id),
  );

  if (envOnly.length) {
    lines.push('<b>З .env (незмінні):</b>');
    for (const id of envOnly) {
      lines.push(`  🔑 <code>${id.toString()}</code>`);
    }
    lines.push('');
  }

  const supers = admins.filter((a) => a.role === 'SUPER');
  const managers = admins.filter((a) => a.role === 'MANAGER');

  if (supers.length) {
    lines.push('<b>Супер-адміни:</b>');
    for (const a of supers) {
      lines.push(`  👑 ${esc(a.name ?? a.telegramId.toString())}`);
    }
    lines.push('');
  }

  if (managers.length) {
    lines.push('<b>Менеджери:</b>');
    for (const a of managers) {
      lines.push(`  👤 ${esc(a.name ?? a.telegramId.toString())}`);
    }
  }

  if (admins.length === 0 && envOnly.length === 0) {
    lines.push('<i>Порожньо.</i>');
  }

  lines.push('', '<i>Додати: реплай на повідомлення + /admin add</i>');

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}
