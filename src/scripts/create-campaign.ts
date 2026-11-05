/**
 * Створення кампанії.
 *
 *   npm run campaign:create -- --slug={name} --title="{title}" \
 *     --prefix={XX} --rules=./rules/{name}.json --prizes=./rules/{name}-prizes.json
 */
import { existsSync, readFileSync } from 'node:fs';
import { connectWithRetry, prisma } from '../db/client.js';
import { prizeKeysReferencedByRules, validateCampaignRules } from '../domain/rules/engine.js';

type PrizeInput = {
  key: string;
  title: string;
  kind?: 'GUARANTEED' | 'GRAND';
  stock?: number | null;
  sortOrder?: number;
};

function arg(name: string): string | undefined {
  const found = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return found?.slice(name.length + 3);
}

function readJson<T>(path: string): T {
  if (!existsSync(path)) {
    console.error(`❌ Файл не знайдено: ${path}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

async function main(): Promise<void> {
  await connectWithRetry();

  const slug = arg('slug');
  const title = arg('title');
  const rulesPath = arg('rules');
  const prizesPath = arg('prizes');
  const prefix = arg('prefix');

  if (!slug || !title || !rulesPath) {
    console.error(
      'Використання: --slug=<slug> --title="<назва>" --rules=<rules.json> ' +
        '[--prizes=<prizes.json>] [--prefix=XX]',
    );
    process.exit(1);
  }

  const rawRules = readJson<unknown>(rulesPath);

  const rules = validateCampaignRules(rawRules);
  console.log(`✅ Правила валідні: ${rules.strategies.map((s) => s.type).join(', ')}`);

  const prizes = prizesPath ? readJson<PrizeInput[]>(prizesPath) : [];

  const campaign = await prisma.campaign.upsert({
    where: { slug },
    update: { title, rules: rawRules as never, codePrefix: prefix ?? null },
    create: {
      slug,
      title,
      rules: rawRules as never,
      codePrefix: prefix ?? null,
      status: 'DRAFT',
    },
  });

  for (const [index, prize] of prizes.entries()) {
    await prisma.prize.upsert({
      where: { campaignId_key: { campaignId: campaign.id, key: prize.key } },
      update: {
        title: prize.title,
        stock: prize.stock ?? null,
        kind: prize.kind ?? 'GUARANTEED',
        sortOrder: prize.sortOrder ?? index,
      },
      create: {
        campaignId: campaign.id,
        key: prize.key,
        title: prize.title,
        stock: prize.stock ?? null,
        kind: prize.kind ?? 'GUARANTEED',
        sortOrder: prize.sortOrder ?? index,
      },
    });
  }
  
  const prizeKeys = new Set(
    (await prisma.prize.findMany({
      where: { campaignId: campaign.id },
      select: { key: true },
    })).map((p) => p.key),
  );

  const missing = prizeKeysReferencedByRules(rules).filter((key) => !prizeKeys.has(key));

  console.log(`\n🎯 Кампанія: ${campaign.title} (${campaign.slug})`);
  console.log(`📌 Статус:   ${campaign.status}`);
  console.log(`🎁 Призи:    ${prizeKeys.size}`);

  if (missing.length) {
    console.log(
      `\n⚠️  У правилах згадані призи, яких немає в кампанії: ${missing.join(', ')}`,
    );
    console.log('   Бот їх не видасть. Додай їх у prizes.json і запусти ще раз.');
  }

  console.log('\nДалі:');
  console.log(`  1. У топіку адмін-групи:  /bind_topic ${slug}`);
  console.log(`  2. npm run import:codes -- --campaign=${slug} --file=codes.csv`);
  console.log(`  3. Активувати:  /campaign activate ${slug}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
