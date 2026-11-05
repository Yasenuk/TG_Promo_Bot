/**
 * Імпорт кодів із CSV або XLSX (колонка з кодами визначається автоматично)
 *
 *   npm run import:codes -- --campaign=hype --file=./codes.xlsx --batch="друк-1"
 *   npm run import:codes -- --campaign=hype --file=./codes.csv --dry-run
 */
import { existsSync, readFileSync } from 'node:fs';
import { connectWithRetry, prisma } from '../db/client.js';
import { codeRepo } from '../db/repositories/code.repo.js';
import { campaignRepo } from '../db/repositories/campaign.repo.js';
import { normalizeCode } from '../domain/codes/normalize.js';
import { parseTable } from '../domain/import/parse-table.js';
import {
  columnLetter,
  extractCodeLines,
  isCodeCandidate,
} from '../domain/import/parse-codes.js';
 
type Args = {
  campaign?: string;
  file?: string;
  batch?: string;
  dryRun: boolean;
};
 
function parseArgs(): Args {
  const args: Args = { dryRun: false };
 
  for (const raw of process.argv.slice(2)) {
    const [key, ...valueParts] = raw.replace(/^--/, '').split('=');
    const value = valueParts.join('=');
 
    if (key === 'campaign') args.campaign = value;
    else if (key === 'file') args.file = value;
    else if (key === 'batch') args.batch = value;
    else if (key === 'dry-run') args.dryRun = true;
  }
 
  return args;
}
 
async function main(): Promise<void> {
  const args = parseArgs();
 
  if (!args.campaign || !args.file) {
    console.error(
      'Використання: --campaign=<slug> --file=<codes.csv|codes.xlsx> [--batch=назва] [--dry-run]',
    );
    process.exit(1);
  }
 
  if (!existsSync(args.file)) {
    console.error(`❌ Файл не знайдено: ${args.file}`);
    process.exit(1);
  }
 
  await connectWithRetry();
 
  const campaign = await campaignRepo.findBySlug(args.campaign);
  if (!campaign) {
    console.error(`❌ Кампанію «${args.campaign}» не знайдено.`);
    process.exit(1);
  }
 
  const table = await parseTable(readFileSync(args.file), args.file);
  const { column, lines } = extractCodeLines(table);

  if (column === -1 || lines.length === 0) {
    console.error('❌ Не знайшов у файлі колонки з кодами.');
    process.exit(1);
  }
 
  // Заголовки до першого коду вже відкинуто в extractCodeLines
 
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  const dupInFile: string[] = [];
 
  for (const line of lines) {
    const normalized = normalizeCode(line);
 
    if (!isCodeCandidate(line)) {
      invalid.push(line);
      continue;
    }
 
    if (seen.has(normalized)) {
      dupInFile.push(line);
      continue;
    }
 
    seen.add(normalized);
    valid.push(line);
  }
 
  const existing = await codeRepo.findExistingValues(valid);
  const collisions = valid.filter((v) => existing.has(normalizeCode(v)));
  const fresh = valid.filter((v) => !existing.has(normalizeCode(v)));
 
  console.log(`\n📄 Файл:        ${args.file}`);
  console.log(`🎯 Кампанія:    ${campaign.title} (${campaign.slug})`);
  console.log(`📦 Партія:      ${args.batch ?? '-'}`);
  console.log(`🔎 Колонка:     ${columnLetter(column)}`);
  console.log(`\n✅ Готові до імпорту: ${fresh.length}`);
  if (collisions.length) console.log(`⚠️  Вже існують:      ${collisions.length}`);
  if (dupInFile.length) console.log(`⚠️  Дублі у файлі:    ${dupInFile.length}`);
  if (invalid.length) console.log(`❌ Некоректні:        ${invalid.length}`);
 
  if (invalid.length) {
    console.log(`\nПриклади некоректних: ${invalid.slice(0, 5).join(', ')}`);
  }
  if (collisions.length) {
    console.log(`Приклади колізій:     ${collisions.slice(0, 5).join(', ')}`);
  }
 
  if (args.dryRun) {
    console.log('\n🔍 dry-run - нічого не записано.');
    return;
  }
 
  if (fresh.length === 0) {
    console.log('\nНічого імпортувати.');
    return;
  }
 
  const imported = await codeRepo.importMany(
    fresh.map((line) => ({
      raw: line,
      campaignId: campaign.id,
      batchName: args.batch,
    })),
  );
 
  console.log(`\n🎉 Імпортовано: ${imported}`);
}
 
main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });