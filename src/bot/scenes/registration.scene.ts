import { Composer, Markup, Scenes } from 'telegraf';
import { message } from 'telegraf/filters';
import type { AppContext } from '../context.js';
import { userRepo } from '../../db/repositories/user.repo.js';
import { normalizeUaPhone } from '../../domain/users/phone.js';
import { validateFullName } from '../../domain/users/full-name.js';
import {
  consentKeyboard,
  mainMenuKeyboard,
  phoneRequestKeyboard,
} from '../keyboards/main-menu.js';

export const REGISTRATION_SCENE = 'registration';

/** Телефон: або кнопка контакту, або текст руками */
const phoneStep = new Composer<AppContext>();

phoneStep.on(message('contact'), async (ctx) => {
  const contact = ctx.message.contact;

  // Людина може переслати чужий контакт із адресної книги
  if (contact.user_id !== ctx.from.id) {
    await ctx.reply_t('register.phone.not_yours');
    return;
  }

  await acceptPhone(ctx, contact.phone_number);
});

phoneStep.on(message('text'), async (ctx) => {
  await acceptPhone(ctx, ctx.message.text);
});

// Стікер, фото, голосове замість номера
phoneStep.use(async (ctx) => {
  await ctx.reply_t('register.phone.invalid');
});

async function acceptPhone(ctx: AppContext, raw: string): Promise<void> {
  const phone = normalizeUaPhone(raw);

  if (!phone) {
    await ctx.reply_t('register.phone.invalid');
    return;
  }

  const telegramId = BigInt(ctx.from!.id);

  if (await userRepo.isPhoneTaken(phone, telegramId)) {
    ctx.log?.warn({ phone }, 'спроба зареєструвати зайнятий номер');
    await ctx.reply_t('register.phone.taken');
    return;
  }

  ctx.scene.session.state.phone = phone;

  await ctx.reply_t('register.name', undefined, Markup.removeKeyboard());
  await ctx.wizard.next();
}

/** ПІБ */
const nameStep = new Composer<AppContext>();

nameStep.on(message('text'), async (ctx) => {
  const result = validateFullName(ctx.message.text);

  if (!result.ok) {
    await ctx.reply_t('register.name.invalid');
    return;
  }

  ctx.scene.session.state.fullName = result.value;

  await ctx.reply_t('register.consent', undefined, await consentKeyboard());
  await ctx.wizard.next();
});

nameStep.use(async (ctx) => {
  await ctx.reply_t('register.name.invalid');
});

/** Згода на обробку персональних даних */
const consentStep = new Composer<AppContext>();

consentStep.action('consent:agree', async (ctx) => {
  await ctx.answerCbQuery();

  const { phone, fullName } = ctx.scene.session.state;

  // Страховка: якщо стан загубився (наприклад, людина натиснула кнопку
  // на старому повідомленні через тиждень) - починаємо спочатку
  if (!phone || !fullName) {
    ctx.log?.warn('порожній стан на кроці згоди - перезапуск сцени');
    await ctx.scene.reenter();
    return;
  }

  const telegramId = BigInt(ctx.from.id);

  // Номер могли зайняти, поки людина заповнювала ПІБ
  if (await userRepo.isPhoneTaken(phone, telegramId)) {
    await ctx.reply_t('register.phone.taken');
    await ctx.scene.leave();
    return;
  }

  const user = await userRepo.completeRegistration(telegramId, { phone, fullName });
  ctx.user = user;

  // Кнопку прибираємо, щоб її не натискали повторно
  await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);

  const firstName = fullName.split(' ')[1] ?? fullName.split(' ')[0] ?? '';
  await ctx.reply_t('register.done', { name: firstName }, await mainMenuKeyboard());

  ctx.log?.info('реєстрація завершена');
  await ctx.scene.leave();
});

consentStep.use(async (ctx) => {
  await ctx.reply_t('register.consent.required');
});

export const registrationScene = new Scenes.WizardScene<AppContext>(
  REGISTRATION_SCENE,
  phoneStep,
  nameStep,
  consentStep,
);

// Вхід у сцену: вітання + запит номера
registrationScene.enter(async (ctx) => {
  ctx.scene.session.state = {};
  await ctx.reply_t('register.intro');
  await ctx.reply_t('register.phone', undefined, await phoneRequestKeyboard());
});

// /cancel працює на будь-якому кроці
registrationScene.command('cancel', async (ctx) => {
  await ctx.reply_t('register.cancelled', undefined, Markup.removeKeyboard());
  await ctx.scene.leave();
});
