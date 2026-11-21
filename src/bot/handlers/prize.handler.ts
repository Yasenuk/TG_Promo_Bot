import { Composer, Markup } from 'telegraf';
import type { AppContext } from '../context.js';
import { claimRepo } from '../../db/repositories/claim.repo.js';
import { codeService } from '../../domain/codes/code.service.js';
import { contentService } from '../../domain/content/content.service.js';
import { decodeCallback, encodeCallback } from '../keyboards/callback.js';
import { STORE_SELECT_SCENE } from '../scenes/store-select.scene.js';
import { formatStorePlace } from '../../domain/stores/store-display.js';

export const prizeHandler = new Composer<AppContext>();

async function removeClickedButton(ctx: AppContext, raw: string): Promise<void> {
  const msg = ctx.callbackQuery!.message;
  const rows =
    msg && 'reply_markup' in msg ? (msg.reply_markup?.inline_keyboard ?? []) : [];
  const rest = rows
    .map((row) => row.filter((b) => !('callback_data' in b) || b.callback_data !== raw))
    .filter((row) => row.length > 0);

  await ctx
    .editMessageReplyMarkup(rest.length ? { inline_keyboard: rest } : undefined)
    .catch(() => undefined);
}

/** Кнопка «Обрати магазин» під повідомленням про виграш */
prizeHandler.on('callback_query', async (ctx, next) => {
  const raw = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
  const action = raw ? decodeCallback(raw) : undefined;

  if (!raw || action?.kind !== 'chooseStore') return next();

  await ctx.answerCbQuery();

  const claim = await claimRepo.findById(action.claimId);

  if (!claim || claim.userId !== ctx.user.id) {
    ctx.log?.warn({ claimId: action.claimId }, 'чужа або неіснуюча заявка');
    await ctx.reply_t('error.generic');
    return;
  }

  // Магазин уже обрано
  if (claim.status !== 'AWAITING_STORE') {
    await removeClickedButton(ctx, raw);
    await ctx.reply_t('prize.confirmed', {
      store: claim.store?.name ?? '—',
      city: claim.store?.city.name ?? '',
      address: claim.store?.address ?? '',
      place: claim.store ? formatStorePlace(claim.store) : '—',
    });
    return;
  }

  await removeClickedButton(ctx, raw);
  await ctx.scene.enter(STORE_SELECT_SCENE, { claimId: claim.id });
});

/** «Мої призи» */
export async function showMyPrizes(ctx: AppContext): Promise<void> {
  const claims = await claimRepo.listByUser(ctx.user.id);

  if (claims.length === 0) {
    await ctx.reply_t('prize.none');
    return;
  }

  const chooseStore = await contentService.t('button.choose_store');

  for (const claim of claims) {
    const place = claim.store ? formatStorePlace(claim.store) : '—';

    const status = ((): string => {
      switch (claim.status) {
        case 'AWAITING_STORE':
          return '⏳ треба обрати магазин';
        case 'AWAITING_DELIVERY':
          return `📦 веземо в магазин: ${place}`;
        case 'DELIVERED':
          return `✅ чекає в магазині: ${place}`;
        case 'RECEIVED':
          return '🎉 отримано';
        default:
          return '—';
      }
    })();

    const line = `🎁 ${claim.prize.title} — ${claim.campaign.title}\n${status}`;

    if (claim.status === 'AWAITING_STORE') {
      await ctx.reply(
        line,
        Markup.inlineKeyboard([
          [
            Markup.button.callback(
              chooseStore,
              encodeCallback({ kind: 'chooseStore', claimId: claim.id }),
            ),
          ],
        ]),
      );
    } else {
      await ctx.reply(line);
    }
  }
}

/** «Мій прогрес» — по кожній кампанії окремо, лічильники не змішуються */
export async function showMyProgress(ctx: AppContext): Promise<void> {
  const participations = await codeService.progress(ctx.user.id);

  if (participations.length === 0) {
    await ctx.reply_t('prize.none');
    return;
  }

  const lines = participations.map(
    (p) => `📊 ${p.campaign.title}: ${p.activationCount} код(ів)`,
  );

  await ctx.reply(lines.join('\n'));
}
