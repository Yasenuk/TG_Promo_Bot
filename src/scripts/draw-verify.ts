/**
 * Перевірка чесності розіграшу: npm run draw:verify -- --draw=<id>
 */
import { existsSync } from 'node:fs';
import { connectWithRetry, prisma } from '../db/client.js';
import { drawService } from '../domain/draw/draw.service.js';

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

  const tickets = await drawService.loadTickets(draw.campaignId);

  // Відновлюємо конфігурацію призів із зафіксованих переможців
  const prizeCounts = new Map<string, { title: string; count: number }>();
  for (const winner of draw.winners) {
    const current = prizeCounts.get(winner.prize.key);
    prizeCounts.set(winner.prize.key, {
      title: winner.prize.title,
      count: (current?.count ?? 0) + 1,
    });
  }

  const prizes = [...prizeCounts.entries()].map(([key, v]) => ({
    key,
    title: v.title,
    count: v.count,
  }));

  const replay = drawService.plan(tickets, prizes, draw.seed, { uniqueWinners: true });

  const original = draw.winners
    .map((w) => `${w.prize.key}:${w.activationId}`)
    .sort()
    .join('|');

  const repeated = replay.winners
    .map((w) => `${w.prizeKey}:${w.activationId}`)
    .sort()
    .join('|');

  console.log(`
🔍 Перевірка розіграшу «${draw.name}»

   Кампанія:  ${draw.campaign.title}
   Seed:      ${draw.seed}
   Квитків на момент розіграшу: ${draw.totalActivations}
   Квитків зараз:               ${tickets.length}
`);

  if (tickets.length !== draw.totalActivations) {
    console.log(
      '⚠️  Кількість активацій змінилася з моменту розіграшу - після нього\n' +
        '   вводили нові коди. Повний збіг у такому разі неможливий,\n' +
        '   і це нормально.\n',
    );
  }

  if (original === repeated) {
    console.log('✅ ЗБІГАЄТЬСЯ. Результат відтворений з того самого seed.\n');
  } else {
    console.log('❌ НЕ ЗБІГАЄТЬСЯ.\n');
    console.log('   Зафіксовано:', original.slice(0, 200));
    console.log('   Відтворено: ', repeated.slice(0, 200));
    process.exitCode = 1;
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
