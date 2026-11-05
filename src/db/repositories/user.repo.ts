import { prisma } from '../client.js';
import type { Prisma, User } from '../../generated/prisma/client.js';
import { DbNull } from '@prisma/client/runtime/client';

export type TelegramIdentity = {
  telegramId: bigint;
  username?: string | undefined;
};

export const userRepo = {
  findByTelegramId(telegramId: bigint): Promise<User | null> {
    return prisma.user.findUnique({ where: { telegramId } });
  },

  /**
   * Створює юзера при першому контакті або освіжає username
   * Знімає прапорець isBlocked: якщо людина знову пише - бот не заблокований
   */
  async upsertFromTelegram(identity: TelegramIdentity): Promise<User> {
    const { telegramId, username } = identity;

    return prisma.user.upsert({
      where: { telegramId },
      update: { username, isBlocked: false, blockedAt: null },
      create: { telegramId, username },
    });
  },

  /** Реєстрація завершена */
  isRegistered(user: Pick<User, 'phone' | 'fullName' | 'consentAt'>): boolean {
    return Boolean(user.phone && user.fullName && user.consentAt);
  },

  completeRegistration(
    telegramId: bigint,
    data: { phone: string; fullName: string },
  ): Promise<User> {
    return prisma.user.update({
      where: { telegramId },
      data: { ...data, consentAt: new Date() },
    });
  },

  /** true, якщо номер уже прив'язаний до ІНШОГО акаунта */
  async isPhoneTaken(phone: string, exceptTelegramId: bigint): Promise<boolean> {
    const owner = await prisma.user.findUnique({
      where: { phone },
      select: { telegramId: true },
    });
    return owner !== null && owner.telegramId !== exceptTelegramId;
  },

  markBlocked(telegramId: bigint): Promise<unknown> {
    return prisma.user
      .update({
        where: { telegramId },
        data: { isBlocked: true, blockedAt: new Date() },
      })
      .catch(() => undefined);
  },

  getState(telegramId: bigint): Promise<Prisma.JsonValue | undefined> {
    return prisma.user
      .findUnique({ where: { telegramId }, select: { state: true } })
      .then((r) => r?.state ?? undefined);
  },

  async setState(telegramId: bigint, state: Prisma.InputJsonValue): Promise<void> {
    await prisma.user.upsert({
      where: { telegramId },
      update: { state },
      create: { telegramId, state },
    });
  },

  async clearState(telegramId: bigint): Promise<void> {
    await prisma.user
      .update({ where: { telegramId }, data: { state: DbNull } })
      .catch(() => undefined);
  },
};
