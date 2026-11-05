import { Markup, Scenes } from 'telegraf';
import type { AppContext } from '../context.js';
import { claimRepo } from '../../db/repositories/claim.repo.js';
import { storeRepo } from '../../db/repositories/store.repo.js';
import { contentService } from '../../domain/content/content.service.js';
import { notifyAdminsAboutClaim } from '../notifications/admin-notifier.js';
import { decodeCallback, encodeCallback } from '../keyboards/callback.js';
import { paginatedKeyboard } from '../keyboards/pagination.js';
import { mainMenuKeyboard } from '../keyboards/main-menu.js';
import { formatStore, formatStorePlace } from '../../domain/stores/store-display.js';

export const STORE_SELECT_SCENE = 'store-select';

/**
 * Вибір магазину для конкретної заявки
 */
type StoreSceneState = {
  claimId?: string;
  cityId?: string;
};

const state = (ctx: AppContext): StoreSceneState =>
  ctx.scene.session.state as StoreSceneState;

export const storeSelectScene = new Scenes.BaseScene<AppContext>(
  STORE_SELECT_SCENE,
);

storeSelectScene.enter(async (ctx) => {
  const s = state(ctx);

  if (!s.claimId) {
    ctx.log?.warn('вхід у сцену магазину без claimId');
    await ctx.scene.leave();
    return;
  }

  await showCities(ctx, 0);
});

async function showCities(ctx: AppContext, page: number): Promise<void> {
  const s = state(ctx);
  const claim = s.claimId ? await claimRepo.findById(s.claimId) : null;

  if (!claim) {
    await ctx.reply_t('error.generic');
    await ctx.scene.leave();
    return;
  }

  const cities = await storeRepo.listCitiesForCampaign(claim.campaignId);

  if (cities.length === 0) {
    ctx.log?.error({ campaignId: claim.campaignId }, 'немає активних магазинів');
    await ctx.reply_t('error.generic');
    await ctx.scene.leave();
    return;
  }

  const counts = await storeRepo.countByCity(claim.campaignId);

  const keyboard = paginatedKeyboard(
    cities.map((c) => {
      const count = counts.get(c.id) ?? 0;
      return {
        id: c.id,
        label: count > 1 ? `${c.name} · ${count}` : c.name,
      };
    }),
    {
      page,
      encodeItem: (id) => encodeCallback({ kind: 'city', cityId: id }),
      encodePage: (p) => encodeCallback({ kind: 'cityPage', page: p }),
    },
  );

  const text = await ctx.t('prize.choose_city');

  // Перший показ - нове повідомлення, гортання сторінок - редагування
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, keyboard).catch(() => ctx.reply(text, keyboard));
  } else {
    await ctx.reply(text, keyboard);
  }
}

async function showStores(ctx: AppContext, page: number): Promise<void> {
  const s = state(ctx);
  const claim = s.claimId ? await claimRepo.findById(s.claimId) : null;

  if (!claim || !s.cityId) {
    await ctx.reply_t('error.generic');
    await ctx.scene.leave();
    return;
  }

  const stores = await storeRepo.listStores(s.cityId, claim.campaignId);
  const cities = await storeRepo.listCitiesForCampaign(claim.campaignId);
  const cityName = cities.find((c) => c.id === s.cityId)?.name ?? '';

  const back = await contentService.t('button.back');

  const keyboard = paginatedKeyboard(
    stores.map((store) => ({ id: store.id, label: formatStore(store) })),
    {
      page,
      encodeItem: (id) => encodeCallback({ kind: 'store', storeId: id }),
      encodePage: (p) => encodeCallback({ kind: 'storePage', page: p }),
      footer: [
        Markup.button.callback(back, encodeCallback({ kind: 'backToCities' })),
      ],
    },
  );

  const text = await ctx.t('prize.choose_store', { city: cityName });
  await ctx.editMessageText(text, keyboard).catch(() => ctx.reply(text, keyboard));
}

storeSelectScene.on('callback_query', async (ctx) => {
  const raw =
    'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
  const action = raw ? decodeCallback(raw) : undefined;

  if (!action) {
    await ctx.answerCbQuery();
    return;
  }

  await ctx.answerCbQuery();
  const s = state(ctx);

  switch (action.kind) {
    case 'cityPage':
      await showCities(ctx, action.page);
      return;

    case 'city': {
      s.cityId = action.cityId;

      const claim = s.claimId ? await claimRepo.findById(s.claimId) : null;
      if (!claim) {
        await ctx.scene.leave();
        return;
      }

      const stores = await storeRepo.listStores(action.cityId, claim.campaignId);

      if (stores.length === 1 && stores[0]) {
        await confirmStore(ctx, stores[0].id);
        return;
      }

      await showStores(ctx, 0);
      return;
    }

    case 'storePage':
      await showStores(ctx, action.page);
      return;

    case 'backToCities':
      s.cityId = undefined;
      await showCities(ctx, 0);
      return;

    case 'store':
      await confirmStore(ctx, action.storeId);
      return;

    default:
      return;
  }
});

async function confirmStore(ctx: AppContext, storeId: string): Promise<void> {
  const s = state(ctx);
  if (!s.claimId) {
    await ctx.scene.leave();
    return;
  }

  const store = await storeRepo.findById(storeId);

  // Магазин могли вимкнути, поки людина гортала список
  if (!store || !store.isActive) {
    await ctx.reply_t('error.generic');
    await showCities(ctx, 0);
    return;
  }

  await claimRepo.attachStore(s.claimId, storeId);

  const claim = await claimRepo.findById(s.claimId);
  if (!claim) {
    await ctx.scene.leave();
    return;
  }

  await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);

  await ctx.reply_t(
    'prize.confirmed',
    {
      store: store.name,
      city: store.city.name,
      address: store.address,
      place: formatStorePlace(store),
    },
    await mainMenuKeyboard(),
  );

  // Заявка менеджерам - після того, як усе записано
  await notifyAdminsAboutClaim(ctx.telegram, claim);

  ctx.log?.info({ claimId: claim.id, storeId }, 'магазин обрано');
  await ctx.scene.leave();
}
