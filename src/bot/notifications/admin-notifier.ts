import { Markup, type Telegram } from 'telegraf';
import type { ClaimFull } from '../../db/repositories/claim.repo.js';
import { claimRepo } from '../../db/repositories/claim.repo.js';
import { encodeCallback } from '../keyboards/callback.js';
import { formatPhone } from '../../domain/users/phone.js';
import { env } from '../../config/env.js';
import { logger } from '../../infra/logger.js';
import { parseTelegramError } from '../../infra/telegram-errors.js';
import { formatDateTime } from '../../shared/datetime.js';
import { formatStorePlace } from '../../domain/stores/store-display.js';

/** HTML-escape: у ПІБ або назві магазину може бути & або < */
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function buildClaimMessage(claim: ClaimFull): string {
  const user = claim.user;
  const store = claim.store;

  const username = user.username ? ` (@${esc(user.username)})` : '';
  const phone = user.phone ? formatPhone(user.phone) : '-';

  const lines = [
    `🎁 <b>Нова заявка</b> - ${esc(claim.campaign.title)}`,
    '',
    `👤 ${esc(user.fullName ?? 'без імені')}${username}`,
    `📞 ${esc(phone)}`,
    `🏆 ${esc(claim.prize.title)}`,
  ];

  if (store) {
    lines.push(`📍 ${esc(formatStorePlace(store))}`);
    if (!store.isActive) lines.push('⚠️ <i>магазин позначено як неактивний</i>');
  }

  lines.push('');
  lines.push(
    `🕐 ${formatDateTime(claim.createdAt)}`,
  );

  return lines.join('\n');
}

/**
 * Кнопки під заявкою.
 * Після видачі «Приз доставлено» зникає, а написати людині все ще можна.
 */
export function claimKeyboard(claim: ClaimFull, options: { deliver: boolean }) {
  const rows = [];

  if (options.deliver) {
    rows.push([
      Markup.button.callback(
        '✅ Приз доставлено',
        encodeCallback({ kind: 'deliver', claimId: claim.id }),
      ),
    ]);
  }

  rows.push([
    Markup.button.callback(
      '✍️ Написати переможцю',
      encodeCallback({ kind: 'notifyWinner', claimId: claim.id }),
    ),
  ]);

  return Markup.inlineKeyboard(rows);
}

/**
 * Заявка летить у топік своєї кампанії
 */
export async function notifyAdminsAboutClaim(
  telegram: Telegram,
  claim: ClaimFull,
): Promise<void> {
  const chatId = env.ADMIN_CHAT_ID;

  if (chatId === undefined) {
    logger.error(
      { claimId: claim.id },
      '⚠️ ADMIN_CHAT_ID не заданий - заявку нікому надіслати. Виконай /chatid у групі.',
    );
    return;
  }

  const text = buildClaimMessage(claim);
  const keyboard = claimKeyboard(claim, { deliver: true });
  const threadId = claim.campaign.adminThreadId ?? undefined;

  const send = (thread?: number) =>
    telegram.sendMessage(chatId.toString(), text, {
      parse_mode: 'HTML',
      ...(thread ? { message_thread_id: thread } : {}),
      ...keyboard,
    });

  try {
    const message = await send(threadId);
    await claimRepo.rememberAdminMessage(claim.id, chatId, message.message_id);
    return;
  } catch (error) {
    const info = parseTelegramError(error);

    // Якщо топік зник
    const threadGone =
      info?.code === 400 &&
      /thread not found|TOPIC_DELETED|TOPIC_CLOSED/i.test(info.description);

    if (!threadId || !threadGone) {
      logger.error({ error, claimId: claim.id }, 'не вдалося сповістити адмінів');
      return;
    }

    logger.error(
      { claimId: claim.id, threadId, campaign: claim.campaign.slug },
      '⚠️ топік кампанії недоступний - шлемо в General, перепривʼяжи через /bind_topic',
    );

    try {
      const fallback = await send(undefined);
      await claimRepo.rememberAdminMessage(
        claim.id,
        chatId,
        fallback.message_id,
      );
    } catch (fallbackError) {
      logger.error(
        { error: fallbackError, claimId: claim.id },
        'заявка не доставлена адмінам взагалі',
      );
    }
  }
}

/** Дописати в те саме повідомлення, хто і коли видав приз */
export async function markClaimMessageDelivered(
  telegram: Telegram,
  claim: ClaimFull,
  managerName: string,
): Promise<void> {
  if (!claim.adminChatId || !claim.adminMessageId) return;

  const text = [
    buildClaimMessage(claim),
    '',
    `✅ <b>Видано</b> - ${esc(managerName)}`,
    `🕐 ${formatDateTime(claim.deliveredAt ?? new Date())}`,
  ].join('\n');

  await telegram
    .editMessageText(
      claim.adminChatId.toString(),
      claim.adminMessageId,
      undefined,
      text,
      { parse_mode: 'HTML', ...claimKeyboard(claim, { deliver: false }) },
    )
    .catch((error: unknown) => {
      logger.warn({ error, claimId: claim.id }, 'не вдалося оновити повідомлення');
    });
}
