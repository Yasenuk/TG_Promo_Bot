import { prisma } from '../client.js';

export type RateLimitVerdict =
  | { allowed: true }
  | { allowed: false; retryAfterSec: number };

/**
 * Ліміт на ввід кодів - у БД, на відміну від загального flood-control
 */
export const rateLimitRepo = {
  async hit(
    key: string,
    maxHits: number,
    windowMs: number,
    blockMs: number,
  ): Promise<RateLimitVerdict> {
    const now = new Date();

    const entry = await prisma.rateLimitEntry.findUnique({ where: { key } });

    if (entry?.blockedTo && entry.blockedTo > now) {
      return {
        allowed: false,
        retryAfterSec: Math.ceil((entry.blockedTo.getTime() - now.getTime()) / 1000),
      };
    }

    const windowExpired =
      !entry || now.getTime() - entry.windowAt.getTime() > windowMs;

    if (windowExpired) {
      await prisma.rateLimitEntry.upsert({
        where: { key },
        create: { key, hits: 1, windowAt: now },
        update: { hits: 1, windowAt: now, blockedTo: null },
      });
      return { allowed: true };
    }

    const hits = entry.hits + 1;

    if (hits > maxHits) {
      const blockedTo = new Date(now.getTime() + blockMs);
      await prisma.rateLimitEntry.update({
        where: { key },
        data: { hits, blockedTo },
      });
      return { allowed: false, retryAfterSec: Math.ceil(blockMs / 1000) };
    }

    await prisma.rateLimitEntry.update({ where: { key }, data: { hits } });
    return { allowed: true };
  },

  /** Успішний ввід скидає лічильник */
  async reset(key: string): Promise<void> {
    await prisma.rateLimitEntry
      .delete({ where: { key } })
      .catch(() => undefined);
  },
};
