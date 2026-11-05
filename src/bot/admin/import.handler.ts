import { Composer, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import type { AppContext } from '../context.js';
import { isSuperAdmin } from './guard.js';
import { downloadDocument } from '../../infra/telegram-files.js';
import {
  applyStoreImport,
  previewStoreImport,
  type StoreImportPreview,
} from '../../domain/import/store-import.js';
import { parseTable } from '../../domain/import/parse-table.js';
import {
  columnLetter,
  extractCodeLines,
  isCodeCandidate,
} from '../../domain/import/parse-codes.js';
import { normalizeCode } from '../../domain/codes/normalize.js';
import { codeRepo } from '../../db/repositories/code.repo.js';
import { campaignRepo } from '../../db/repositories/campaign.repo.js';
import { storeRepo } from '../../db/repositories/store.repo.js';
import {
  dropPending,
  overwritePending,
  putPending,
  readPending,
  takePending,
  type PendingId,
} from './pending.js';
import { encodeCallback, decodeCallback } from '../keyboards/callback.js';
import { replyCampaignNotFound } from './campaign-helpers.js';

export const importHandler = new Composer<AppContext>();

type StoresPending = StoreImportPreview & { campaignId: string | null };

type CodesPending = {
  campaignId: string;
  campaignTitle: string;
  fresh: string[];
  batchName?: string;
};

function confirmKeyboard(pendingId: PendingId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Залити', encodeCallback({ kind: 'confirm', pendingId })),
      Markup.button.callback('✖️ Скасувати', encodeCallback({ kind: 'cancel', pendingId })),
    ],
  ]);
}

/**
 * Імпорт файлом
 */
importHandler.on(message('document'), async (ctx, next) => {
  const caption = ctx.message.caption?.trim() ?? '';

  // Чужі файли в групі не чіпаємо
  if (!(await isSuperAdmin(ctx.from.id))) return next();

  const doc = ctx.message.document;
  const fileName = doc.file_name ?? 'file.csv';
  const isTable = /\.(csv|xlsx|xls|txt)$/i.test(fileName);

  if (!caption.startsWith('/import_')) {
    if (!isTable) return next();
    await askWhatToDo(ctx, doc.file_id, doc.file_size, fileName);
    return;
  }

  const [command, ...args] = caption.split(/\s+/);

  const downloaded = await downloadDocument(
    ctx.telegram,
    doc.file_id,
    doc.file_size,
  );

  if (!downloaded.ok) {
    await ctx.reply(
      downloaded.reason === 'too_large'
        ? '❌ Файл більший за 20 МБ'
        : '❌ Не вдалося завантажити файл. Спробуй ще раз',
    );
    return;
  }

  if (command?.startsWith('/import_stores')) {
    await handleStores(ctx, downloaded.buffer, fileName, args[0]);
    return;
  }

  if (command?.startsWith('/import_codes')) {
    await handleCodes(ctx, downloaded.buffer, fileName, args[0], args[1]);
    return;
  }

  await askWhatToDo(ctx, doc.file_id, doc.file_size, fileName);
});

type FilePending = {
  fileId: string;
  fileSize?: number | undefined;
  fileName: string;
  campaigns?: { slug: string; title: string }[];
};

async function askWhatToDo(
  ctx: AppContext,
  fileId: string,
  fileSize: number | undefined,
  fileName: string,
): Promise<void> {
  const pendingId = await putPending<FilePending>('file', ctx.from!.id, {
    fileId,
    fileSize,
    fileName,
  });

  await ctx.reply(
    `📎 <b>${fileName}</b>\n\nЩо з ним зробити?`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            '📍 Магазини',
            encodeCallback({ kind: 'fileAs', pendingId, target: 'stores' }),
          ),
        ],
        [
          Markup.button.callback(
            '🎟 Коди',
            encodeCallback({ kind: 'fileAs', pendingId, target: 'codes' }),
          ),
        ],
        [
          Markup.button.callback(
            '✖️ Нічого',
            encodeCallback({ kind: 'cancel', pendingId }),
          ),
        ],
      ]),
    },
  );
}

importHandler.on('callback_query', async (ctx, next) => {
  const raw = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
  const action = raw ? decodeCallback(raw) : undefined;

  if (action?.kind === 'fileAs') {
    await handleFileAs(ctx, action.pendingId, action.target);
    return;
  }

  if (action?.kind === 'fileCampaign') {
    await handleFileCampaign(ctx, action.pendingId, action.index);
    return;
  }

  return next();
});

async function handleFileAs(
  ctx: AppContext,
  pendingId: PendingId,
  target: 'stores' | 'codes',
): Promise<void> {
  const entry = await readPending<FilePending>('file', pendingId, ctx.from!.id);

  if (!entry.ok) {
    await ctx.answerCbQuery(
      entry.reason === 'not_owner'
        ? 'Це файл іншого адміна'
        : 'Файл застарів — надішли ще раз',
      { show_alert: true },
    );
    return;
  }

  if (target === 'stores') {
    await ctx.answerCbQuery('Читаю файл…');
    await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
    await dropPending(pendingId);

    const downloaded = await downloadDocument(
      ctx.telegram,
      entry.payload.fileId,
      entry.payload.fileSize,
    );

    if (!downloaded.ok) {
      await ctx.reply('❌ Не вдалося завантажити файл. Спробуй ще раз.');
      return;
    }

    await handleStores(ctx, downloaded.buffer, entry.payload.fileName);
    return;
  }

  const campaigns = await campaignRepo.listAll();

  if (campaigns.length === 0) {
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
    await ctx.reply(
      '❌ Кампаній ще немає',
      { parse_mode: 'HTML' },
    );
    return;
  }

  await ctx.answerCbQuery();

  const list = campaigns.map((c) => ({ slug: c.slug, title: c.title }));
  await overwritePending<FilePending>(pendingId, { ...entry.payload, campaigns: list });

  await ctx.editMessageText(
    `📎 <b>${entry.payload.fileName}</b>\n\nУ яку кампанію заливати коди?`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        ...list.map((c, i) => [
          Markup.button.callback(
            `${c.title}`,
            encodeCallback({ kind: 'fileCampaign', pendingId, index: i }),
          ),
        ]),
        [
          Markup.button.callback(
            '✖️ Скасувати',
            encodeCallback({ kind: 'cancel', pendingId }),
          ),
        ],
      ]),
    },
  );
}

async function handleFileCampaign(
  ctx: AppContext,
  pendingId: PendingId,
  index: number,
): Promise<void> {
  const entry = await readPending<FilePending>('file', pendingId, ctx.from!.id);

  if (!entry.ok) {
    await ctx.answerCbQuery('Файл застарів — надішли ще раз', { show_alert: true });
    return;
  }

  const campaign = entry.payload.campaigns?.[index];
  if (!campaign) {
    await ctx.answerCbQuery('Кампанію не знайдено', { show_alert: true });
    return;
  }

  await ctx.answerCbQuery('Читаю файл…');
  await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
  await dropPending(pendingId);

  const downloaded = await downloadDocument(
    ctx.telegram,
    entry.payload.fileId,
    entry.payload.fileSize,
  );

  if (!downloaded.ok) {
    await ctx.reply('❌ Не вдалося завантажити файл. Спробуй ще раз.');
    return;
  }

  await handleCodes(ctx, downloaded.buffer, entry.payload.fileName, campaign.slug);
}

importHandler.command(['import_stores', 'import_codes'], async (ctx) => {
  if (!(await isSuperAdmin(ctx.from.id))) return;

  await ctx.reply(
    '📎 <b>Команду треба писати в підписі до файлу</b>, не окремо.\n\n' +
      '<b>Магазини:</b> колонки місто, назва, адреса\n' +
      '<code>/import_stores slug</code> — ще й прив’яже магазини до кампанії\n' +
      '<b>Коди:</b> колонку з кодами бот знайде сам, заголовки й «№» не заважають\n\n' +
      'Формати: .csv, .xlsx (до 20 МБ)',
    { parse_mode: 'HTML' },
  );
});

async function handleStores(
  ctx: AppContext,
  buffer: Buffer,
  fileName: string,
  slug?: string,
): Promise<void> {
  const campaign = slug ? await campaignRepo.findBySlug(slug) : null;
  if (slug && !campaign) {
    await replyCampaignNotFound(ctx, slug);
    return;
  }

  const preview = await previewStoreImport(buffer, fileName);

  if (!preview.ok) {
    if (preview.reason === 'missing_columns') {
      await ctx.reply(
        `❌ У файлі немає колонок: ${preview.missing?.join(', ')}\n\n` +
          'Очікую заголовки (у будь-якому порядку):\n' +
          '• місто / city\n• назва / магазин / name\n• адреса / address',
      );
      return;
    }
    await ctx.reply('❌ Файл порожній або не читається.');
    return;
  }

  if (preview.stores.length === 0) {
    await ctx.reply('❌ Жодного придатного рядка.');
    return;
  }

  const pendingId = await putPending<StoresPending>('stores', ctx.from!.id, {
    ...preview,
    campaignId: campaign?.id ?? null,
  });

  const lines = [
    '📍 <b>Імпорт магазинів</b>',
    '',
    `Магазинів у файлі: <b>${preview.stores.length}</b>`,
    `Міст: <b>${preview.cities.length}</b>${preview.newCities.length ? ` (нових: ${preview.newCities.length})` : ''}`,
  ];

  if (preview.newCities.length) {
    lines.push(`Нові міста: ${preview.newCities.slice(0, 10).join(', ')}`);
  }
  if (preview.duplicates) lines.push(`⚠️ Дублів у файлі: ${preview.duplicates}`);
  if (preview.skipped) lines.push(`⚠️ Пропущено неповних рядків: ${preview.skipped}`);

   if (preview.citiesWithoutAddress.length) {
    lines.push(
      '',
      `<b>Міст без адрес: ${preview.citiesWithoutAddress.length}</b>`,
      preview.citiesWithoutAddress.join(', '),
    );
  }

  if (campaign) {
    lines.push('', `🔗 Прив’язати до кампанії: <b>${campaign.title}</b>`);
    if ((await storeRepo.countLinked(campaign.id)) === 0) {
      lines.push('⚠️ Зараз кампанії доступні ВСІ магазини. Після імпорту - лише прив’язані.');
    }
  }

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    ...confirmKeyboard(pendingId),
  });
}

async function handleCodes(
  ctx: AppContext,
  buffer: Buffer,
  fileName: string,
  slug?: string,
  batchName?: string,
): Promise<void> {
  if (!slug) {
    await ctx.reply('/import_codes <slug> [назва партії]');
    return;
  }

  const campaign = await campaignRepo.findBySlug(slug);
  if (!campaign) {
    await replyCampaignNotFound(ctx, slug);
    return;
  }

  const table = await parseTable(buffer, fileName);
  const { column, lines } = extractCodeLines(table);

  if (column === -1 || lines.length === 0) {
    await ctx.reply('❌ Не знайшов у файлі колонки з кодами.');
    return;
  }

  const seen = new Set<string>();
  const valid: string[] = [];
  let invalid = 0;
  let dupInFile = 0;

  for (const line of lines) {
    if (!isCodeCandidate(line)) {
      invalid++;
      continue;
    }

    const normalized = normalizeCode(line);
    if (seen.has(normalized)) {
      dupInFile++;
      continue;
    }

    seen.add(normalized);
    valid.push(line);
  }

  const existing = await codeRepo.findExistingValues(valid);
  const fresh = valid.filter((v) => !existing.has(normalizeCode(v)));
  const collisions = valid.length - fresh.length;

  if (fresh.length === 0) {
    await ctx.reply(
      `Нічого імпортувати.\n\nУ файлі: ${lines.length}\n` +
        `Вже в базі: ${collisions}\nНекоректних: ${invalid}`,
    );
    return;
  }

  const pendingId = await putPending<CodesPending>('codes', ctx.from!.id, {
    campaignId: campaign.id,
    campaignTitle: campaign.title,
    fresh,
    ...(batchName ? { batchName } : {}),
  });

  const report = [
    '🎟 <b>Імпорт кодів</b>',
    '',
    `Кампанія: <b>${campaign.title}</b>`,
    `Колонка з кодами: <b>${columnLetter(column)}</b>`,
    batchName ? `Партія: ${batchName}` : '',
    '',
    `✅ До імпорту: <b>${fresh.length}</b>`,
    collisions ? `⚠️ Вже існують: ${collisions}` : '',
    dupInFile ? `⚠️ Дублі у файлі: ${dupInFile}` : '',
    invalid ? `❌ Некоректні: ${invalid}` : '',
  ].filter(Boolean);

  await ctx.reply(report.join('\n'), {
    parse_mode: 'HTML',
    ...confirmKeyboard(pendingId),
  });
}

/** Підтвердження імпорту магазинів */
export async function confirmStoresImport(
  ctx: AppContext,
  pendingId: PendingId,
): Promise<void> {
  const taken = await takePending<StoresPending>('stores', pendingId, ctx.from!.id);

  if (!taken.ok) {
    await ctx.answerCbQuery(
      taken.reason === 'not_owner'
        ? 'Підтвердити може лише той, хто надіслав файл'
        : 'Термін підтвердження минув — надішли файл ще раз',
      { show_alert: true },
    );
    return;
  }

  await ctx.answerCbQuery('Заливаю…');
  await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);

  const { campaignId } = taken.payload;
  const result = await applyStoreImport(taken.payload, campaignId);

  await ctx.reply(
    `✅ Готово\n\n` +
      `Міст створено: ${result.citiesCreated}\n` +
      `Магазинів додано: ${result.storesCreated}` +
      (campaignId ? `\nНових прив’язок до кампанії: ${result.storesLinked}` : ''),
  );

  ctx.log?.info({ ...result }, 'імпорт магазинів');
}

/** Підтвердження імпорту кодів */
export async function confirmCodesImport(
  ctx: AppContext,
  pendingId: PendingId,
): Promise<void> {
  const taken = await takePending<CodesPending>('codes', pendingId, ctx.from!.id);

  if (!taken.ok) {
    await ctx.answerCbQuery(
      taken.reason === 'not_owner'
        ? 'Підтвердити може лише той, хто надіслав файл'
        : 'Термін підтвердження минув — надішли файл ще раз',
      { show_alert: true },
    );
    return;
  }

  await ctx.answerCbQuery('Заливаю…');
  await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);

  const { campaignId, campaignTitle, fresh, batchName } = taken.payload;

  const imported = await codeRepo.importMany(
    fresh.map((raw) => ({ raw, campaignId, batchName })),
  );

  await ctx.reply(`🎉 Імпортовано ${imported} кодів у «${campaignTitle}»`);
  ctx.log?.info({ imported, campaignId }, 'імпорт кодів');
}
