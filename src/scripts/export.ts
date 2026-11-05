/**
 * Вигрузка по кампанії у .xlsx
 *
 *   npm run export -- --campaign=hype
 *   npm run export -- --campaign=hype --out=./exports/hype.xlsx
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { connectWithRetry, prisma } from '../db/client.js';
import { campaignRepo } from '../db/repositories/campaign.repo.js';
import { buildCampaignWorkbook } from '../domain/export/xlsx.service.js';
import { formatIsoDate } from '../shared/datetime.js';

if (existsSync('.env')) process.loadEnvFile('.env');

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main(): Promise<void> {
  await connectWithRetry();

  const slug = arg('campaign');
  if (!slug) {
    console.error('Використання: --campaign=<slug> [--out=<path.xlsx>]');
    process.exit(1);
  }

  const campaign = await campaignRepo.findBySlug(slug);
  if (!campaign) {
    console.error(`❌ Кампанію «${slug}» не знайдено.`);
    process.exit(1);
  }

  const stamp = formatIsoDate();
  const out = resolve(arg('out') ?? `./exports/${slug}-${stamp}.xlsx`);
  mkdirSync(dirname(out), { recursive: true });

  const workbook = await buildCampaignWorkbook(campaign.id);
  await workbook.xlsx.writeFile(out);

  console.log(`\n✅ Готово: ${out}`);
  console.log('   Листи: Активації · Учасники · Призи · Підсумки');
  console.log('   Для розіграшу потрібен лист «Активації» - 1 код = 1 рядок.\n');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
