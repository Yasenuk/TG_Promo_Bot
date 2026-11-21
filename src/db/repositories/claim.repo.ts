import { prisma } from '../client.js';
import type { Campaign, Prize, PrizeClaim, Store, User, City } from '../../generated/prisma/client.js';

export type ClaimFull = PrizeClaim & {
  user: User;
  prize: Prize;
  campaign: Campaign;
  store: (Store & { city: City }) | null;
};

const fullInclude = {
  user: true,
  prize: true,
  campaign: true,
  store: { include: { city: true } },
} as const;

export const claimRepo = {
  findById(id: string): Promise<ClaimFull | null> {
    return prisma.prizeClaim.findUnique({ where: { id }, include: fullInclude });
  },

  /** Заявки, де людина ще не обрала магазин */
  listAwaitingStore(userId: string): Promise<ClaimFull[]> {
    return prisma.prizeClaim.findMany({
      where: { userId, status: 'AWAITING_STORE' },
      include: fullInclude,
      orderBy: { createdAt: 'asc' },
    });
  },

  listByUser(userId: string): Promise<ClaimFull[]> {
    return prisma.prizeClaim.findMany({
      where: { userId },
      include: fullInclude,
      orderBy: { createdAt: 'desc' },
    });
  },

  attachStore(claimId: string, storeId: string): Promise<PrizeClaim> {
    return prisma.prizeClaim.update({
      where: { id: claimId },
      data: { storeId, status: 'AWAITING_DELIVERY' },
    });
  },

  rememberAdminMessage(
    claimId: string,
    chatId: bigint,
    messageId: number,
  ): Promise<PrizeClaim> {
    return prisma.prizeClaim.update({
      where: { id: claimId },
      data: { adminChatId: chatId, adminMessageId: messageId },
    });
  },

  /**
   * Позначити доставленим
   */
  async markDelivered(
    claimId: string,
    byTelegramId: bigint,
  ): Promise<ClaimFull | null> {
    const updated = await prisma.prizeClaim.updateMany({
      where: { id: claimId, status: 'AWAITING_DELIVERY' },
      data: {
        status: 'DELIVERED',
        deliveredByTelegramId: byTelegramId,
        deliveredAt: new Date(),
      },
    });

    if (updated.count === 0) return null;

    const claim = await prisma.prizeClaim.findUnique({
      where: { id: claimId },
      include: fullInclude,
    });

    if (claim) {
      await prisma.prize.update({
        where: { id: claim.prizeId },
        data: {
          reserved: { decrement: 1 },
          issued: { increment: 1 },
        },
      });
    }

    return claim;
  },

  markReceived(claimId: string): Promise<PrizeClaim> {
    return prisma.prizeClaim.update({
      where: { id: claimId },
      data: { status: 'RECEIVED', receivedAt: new Date() },
    });
  },

  listForStoreReminder(campaignId: string, cooldownMs: number) {
    const cutoff = new Date(Date.now() - cooldownMs);
    return prisma.prizeClaim.findMany({
      where: {
        campaignId,
        status: 'AWAITING_STORE',
        user: { isBlocked: false },
        OR: [{ remindedAt: null }, { remindedAt: { lt: cutoff } }],
        // переможців, яким ще не пішов draw.winner, не чіпаємо
        NOT: { drawWinner: { is: { notifiedAt: null } } },
      },
      include: { user: true, prize: true },
      orderBy: { createdAt: 'asc' },
    });
  },

  markReminded(ids: string[]) {
    return prisma.prizeClaim.updateMany({
      where: { id: { in: ids } },
      data: { remindedAt: new Date() },
    });
  },
};
