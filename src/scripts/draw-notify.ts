/**
 * Сповіщення переможців розіграшу: npm run draw:notify -- --draw=<id>
 */
import { existsSync } from 'node:fs';
import { Markup, Telegraf } from 'telegraf';
import { connectWithRetry, prisma } from '../db/client.js';
import { drawService } from '../domain/draw/draw.service.js';
import { contentService } from '../domain/content/content.service.js';
import { encodeCallback } from '../bot/keyboards/callback.js';
import { broadcast } from '../infra/queue.js';
import { userRepo } from '../db/repositories/user.repo.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const arg = (n: string) =>
  process.argv.slice(2).find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

async function main(): Promise<void> {
  await connectWithRetry();

  const drawId = arg('draw');
  if (!drawId) {
    console.error('Використання: --draw=<id>');
    process.exit(1);
  }

  const draw = await drawService.findDraw(drawId);
  if (!draw) {
    console.error(`❌ Розіграш ${drawId} не знайдено.`);
    process.exit(1);
  }

  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error('❌ BOT_TOKEN не заданий.');
    process.exit(1);
  }

  const bot = new Telegraf(token);
  const pending = draw.winners.filter((w) => w.notifiedAt === null);

  console.log(`
📣 ${draw.name} - ${draw.campaign.title}
   Переможців: ${draw.winners.length}
   До сповіщення: ${pending.length} (решту вже сповіщено)
`);

  if (pending.length === 0) return;

  const chooseStore = await contentService.t('button.choose_store');

  const tasks = await Promise.all(
    pending.map(async (winner) => {
      const claim = await prisma.prizeClaim.findFirst({
        where: { drawWinnerId: winner.id },
        select: { id: true },
      });

      const text = await contentService.t(
        'draw.winner',
        { prize: winner.prize.title },
        { campaignId: draw.campaignId },
      );

      return {
        item: winner,
        telegramId: winner.user.telegramId,
        send: async () => {
          await bot.telegram.sendMessage(
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

          // Позначаємо одразу після успіху - повторний запуск не задублює
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
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) {
        process.stdout.write(`\r   ${done}/${total}`);
      }
    },
  });

  console.log(`

✅ Надіслано:      ${result.sent}
🚫 Заблокували:    ${result.blocked}
❌ Помилок:        ${result.failed}
`);

  if (result.blocked > 0) {
    console.log(
      '   Тих, хто заблокував бота, доведеться шукати за телефоном ' +
        'із вигрузки - приз за ними лишається.\n',
    );
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
