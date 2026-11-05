/**
 * Скидання демо-даних: npm run reset:demo
 *
 * Щоб скинути й свій профіль: npm run reset:demo -- --me=<telegram_id>
 */
import { existsSync } from 'node:fs';
import { connectWithRetry, prisma } from '../db/client.js';

if (existsSync('.env')) process.loadEnvFile('.env');

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ reset:demo не для продакшену');
    process.exit(1);
  }

  await connectWithRetry();

  const campaign = await prisma.campaign.findUnique({ where: { slug: 'demo' } });

  if (campaign) {
    await prisma.campaign.delete({ where: { id: campaign.id } });
    console.log('✅ Кампанію «demo» видалено разом із даними');
  } else {
    console.log('ℹ️  Кампанії «demo» немає');
  }

  const meArg = process.argv.slice(2).find((a) => a.startsWith('--me='));
  if (meArg) {
    const telegramId = BigInt(meArg.slice(5));
    await prisma.user
      .delete({ where: { telegramId } })
      .then(() => console.log(`✅ Профіль ${telegramId} видалено - реєстрація з нуля`))
      .catch(() => console.log(`ℹ️  Профіль ${telegramId} не знайдено`));
  }

  await prisma.rateLimitEntry.deleteMany({});
  console.log('✅ Лічильники rate-limit скинуто');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
