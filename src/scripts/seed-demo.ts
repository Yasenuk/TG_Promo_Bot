/**
 * Тестове середовище для ручної перевірки: npm run seed:demo
 */
import { existsSync } from 'node:fs';
import { connectWithRetry, prisma } from '../db/client.js';
import { codeRepo } from '../db/repositories/code.repo.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const SLUG = 'demo';
const CODE_COUNT = 40;

const makeCode = (i: number) => `TEST${String(i).padStart(4, '0')}`;

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ seed:demo не для продакшену');
    process.exit(1);
  }

  await connectWithRetry();

  const campaign = await prisma.campaign.upsert({
    where: { slug: SLUG },
    update: { status: 'ACTIVE', codePrefix: 'TEST' },
    create: {
      slug: SLUG,
      title: 'DEMO - тестова акція',
      status: 'ACTIVE',
      codePrefix: 'TEST',
      rules: {
        strategies: [
          {
            type: 'cyclic-threshold',
            config: {
              cycleLength: 6,
              awards: { '2': 'opener', '4': 'mug', '0': 'cap' },
            },
          },
        ],
      },
    },
  });

  const prizes = [
    { key: 'opener', title: 'Відкривачка (тест)', stock: 2, sortOrder: 0 },
    { key: 'mug', title: 'Кружка (тест)', stock: 1, sortOrder: 1 },
    { key: 'cap', title: 'Кепка (тест)', stock: null, sortOrder: 2 },
  ];

  for (const prize of prizes) {
    await prisma.prize.upsert({
      where: { campaignId_key: { campaignId: campaign.id, key: prize.key } },
      update: { title: prize.title, stock: prize.stock, reserved: 0, issued: 0 },
      create: { campaignId: campaign.id, ...prize },
    });
  }

  const city = await prisma.city.upsert({
    where: { name: 'Київ' },
    update: {},
    create: { name: 'Київ', sortOrder: 1 },
  });

  const existingStores = await prisma.store.count({ where: { cityId: city.id } });
  if (existingStores < 10) {
    for (let i = existingStores + 1; i <= 10; i++) {
      await prisma.store.create({
        data: {
          cityId: city.id,
          name: `Тест-маркет №${i}`,
          address: `вул. Тестова, ${i}`,
        },
      });
    }
  }

  const created = await codeRepo.importMany(
    Array.from({ length: CODE_COUNT }, (_, i) => ({
      raw: makeCode(i + 1),
      campaignId: campaign.id,
      batchName: 'demo',
    })),
  );

  console.log(`
✅ Демо-кампанія готова

   Кампанія:  ${campaign.title} (${campaign.slug}) - ACTIVE
   Коди:      ${makeCode(1)} … ${makeCode(CODE_COUNT)}  (нових: ${created})
   Призи:     відкривачка ×2, кружка ×1, кепка ∞
   Магазини:  10 у Києві (перевірка пагінації)

📋 Порядок призів за механікою (цикл 6):
   2-й код  → відкривачка      8-й код  → відкривачка
   4-й код  → кружка          10-й код  → кружка (СКЛАД ПОРОЖНІЙ)
   6-й код  → кепка           12-й код  → кепка
`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
