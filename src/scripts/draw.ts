/**
 * Розіграш головних призів.
 *
 *   # 1. Подивитись результат, нічого не записуючи
 *   npm run draw -- --campaign=hype --prize=tv:1 --prize=phone:3 --dry-run
 *
 *   # 2. Зафіксувати
 *   npm run draw -- --campaign=hype --prize=tv:1 --prize=phone:3 --seed=abc123
 *
 *   # 3. Сповістити переможців
 *   npm run draw:notify -- --draw=<id>
 *
 * --allow-repeat  дозволити одній людині виграти кілька призів
 */
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { connectWithRetry, prisma } from '../db/client.js';
import { campaignRepo } from '../db/repositories/campaign.repo.js';
import { drawService } from '../domain/draw/draw.service.js';
import { formatPhone } from '../domain/users/phone.js';
import { formatDate } from '../shared/datetime.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const argv = process.argv.slice(2);
const arg = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const flag = (n: string) => argv.includes(`--${n}`);

async function main(): Promise<void> {
  await connectWithRetry();

  const slug = arg('campaign');
  const prizeArgs = argv
    .filter((a) => a.startsWith('--prize='))
    .map((a) => a.slice('--prize='.length));

  if (!slug || prizeArgs.length === 0) {
    console.error(
      'Використання: --campaign=<slug> --prize=<key>:<кількість> [--prize=...] ' +
        '[--seed=<hex>] [--dry-run] [--allow-repeat]',
    );
    process.exit(1);
  }

  const campaign = await campaignRepo.findBySlug(slug);
  if (!campaign) {
    console.error(`❌ Кампанію «${slug}» не знайдено.`);
    process.exit(1);
  }

  const available = await prisma.prize.findMany({ where: { campaignId: campaign.id } });

  const prizes = prizeArgs.map((raw) => {
    const [key, countRaw] = raw.split(':');
    const count = Number(countRaw ?? 1);
    const prize = available.find((p) => p.key === key);

    if (!prize) {
      console.error(
        `❌ Приз «${key}» не заведений у кампанії. Наявні: ${available.map((p) => p.key).join(', ')}`,
      );
      process.exit(1);
    }
    if (!Number.isInteger(count) || count < 1) {
      console.error(`❌ Некоректна кількість для «${key}»: ${countRaw}`);
      process.exit(1);
    }

    return { key: prize.key, title: prize.title, count };
  });

  const tickets = await drawService.loadTickets(campaign.id);

  if (tickets.length === 0) {
    console.error('❌ Немає жодної активації - нема серед кого розігрувати.');
    process.exit(1);
  }

  const totalPrizes = prizes.reduce((sum, p) => sum + p.count, 0);
  const uniqueWinners = !flag('allow-repeat');
  const seed = arg('seed') ?? drawService.generateSeed();

  const plan = drawService.plan(tickets, prizes, seed, { uniqueWinners });

  console.log(`
🎲 Розіграш - ${campaign.title}

   Квитків (активацій):  ${plan.totalTickets}
   Унікальних учасників: ${plan.uniqueParticipants}
   Призів розігрується:  ${totalPrizes}
   Один приз на людину:  ${uniqueWinners ? 'так' : 'ні'}

   SEED: ${seed}
`);

  if (plan.winners.length < totalPrizes) {
    console.log(
      `⚠️  Призначено лише ${plan.winners.length} з ${totalPrizes} призів - ` +
        `забракло придатних учасників.\n`,
    );
  }

  console.log('🏆 Переможці:\n');
  plan.winners.forEach((w, i) => {
    console.log(
      `   ${String(i + 1).padStart(2)}. ${w.prizeTitle}  -  ${w.fullName ?? '?'}  ` +
        `${w.phone ? formatPhone(w.phone) : ''}  (код ${w.codeValue})`,
    );
  });

  if (flag('dry-run')) {
    console.log('\n🔍 dry-run - нічого не записано.');
    console.log(`   Щоб зафіксувати ЦЕЙ САМИЙ результат: --seed=${seed}\n`);
    return;
  }

  // Розіграш скасувати не можна
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('\nЗафіксувати результат? (y/N) ');
  rl.close();

  if (answer.trim().toLowerCase() !== 'y') {
    console.log('Скасовано.');
    return;
  }

  const name = arg('name') ?? `Розіграш ${formatDate(new Date())}`;
  const drawId = await drawService.commit(campaign.id, name, plan);

  console.log(`
✅ Зафіксовано. Draw ID: ${drawId}

   Переможцям створено заявки зі статусом «чекає вибору магазину».
   Сповістити: npm run draw:notify -- --draw=${drawId}
`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
