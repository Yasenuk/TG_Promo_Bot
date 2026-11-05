import { prisma } from '../../db/client.js';
import type { Campaign, Prize } from '../../generated/prisma/client.js';
import { err, ok, type Result } from '../../shared/result.js';
import { prizeKeysReferencedByRules } from '../rules/engine.js';
import type { PrizeInput } from './parse-prize-line.js';

/** Скільки одиниць уже пообіцяно/видано - менше цього сток бути не може */
const committed = (p: Pick<Prize, 'issued' | 'reserved'>): number => p.issued + p.reserved;

const snapshot = (p: Pick<Prize, 'title' | 'stock' | 'kind'>) => ({
  title: p.title,
  stock: p.stock,
  kind: p.kind,
});

export type RemoveOutcome = {
  deleted: string[];
  /** мали заявки/переможців, тож не видалені, а закриті (stock = issued + reserved) */
  closed: string[];
};

export type RulesCheck = {
  /** є в правилах, немає в Prize - юзер отримає «приз закінчився» */
  missing: string[];
  /** GUARANTEED-призи, на які правила не посилаються (GRAND - для розіграшів, їх не рахуємо) */
  unused: string[];
};

export const prizeService = {
  list(campaignId: string): Promise<Prize[]> {
    return prisma.prize.findMany({
      where: { campaignId },
      orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
    });
  },

  /** Лише нові ключі; існуючий ключ - помилка (для зміни є update) */
  async add(
    campaignId: string,
    inputs: readonly PrizeInput[],
    actorId: bigint,
  ): Promise<Result<Prize[], string[]>> {
    const existing = await prisma.prize.findMany({
      where: { campaignId },
      select: { key: true, sortOrder: true },
    });

    const taken = new Set(existing.map((p) => p.key));
    const clashes = inputs
      .filter((p) => taken.has(p.key))
      .map((p) => `«${p.key}» вже є - для зміни використовуй update`);
    if (clashes.length > 0) return err(clashes);

    let sortOrder = Math.max(-1, ...existing.map((p) => p.sortOrder)) + 1;

    const created = await prisma.$transaction(async (tx) => {
      const rows: Prize[] = [];
      for (const input of inputs) {
        rows.push(
          await tx.prize.create({
            data: {
              campaignId,
              key: input.key,
              title: input.title,
              stock: input.stock,
              kind: input.kind ?? 'GUARANTEED',
              sortOrder: sortOrder++,
            },
          }),
        );
      }

      await tx.auditLog.createMany({
        data: rows.map((p) => ({
          actorId,
          action: 'prize.added',
          entityType: 'Prize',
          entityId: p.id,
          payload: { campaignId, key: p.key, ...snapshot(p) },
        })),
      });

      return rows;
    });

    return ok(created);
  },

  /** Лише існуючі ключі; сток не нижче вже виданого + зарезервованого */
  async update(
    campaignId: string,
    inputs: readonly PrizeInput[],
    actorId: bigint,
  ): Promise<Result<Prize[], string[]>> {
    const current = await prisma.prize.findMany({
      where: { campaignId, key: { in: inputs.map((p) => p.key) } },
    });
    const byKey = new Map(current.map((p) => [p.key, p]));

    const errors: string[] = [];
    for (const input of inputs) {
      const prize = byKey.get(input.key);
      if (!prize) {
        errors.push(`«${input.key}» немає - для нового використовуй add`);
        continue;
      }
      if (input.stock !== null && input.stock < committed(prize)) {
        errors.push(
          `«${input.key}»: видано ${prize.issued}, у резерві ${prize.reserved} - ` +
            `сток не може бути менше ${committed(prize)}`,
        );
      }
    }
    if (errors.length > 0) return err(errors);

    const updated = await prisma.$transaction(async (tx) => {
      const rows: Prize[] = [];
      for (const input of inputs) {
        const before = byKey.get(input.key)!;
        const after = await tx.prize.update({
          where: { id: before.id },
          data: {
            title: input.title,
            stock: input.stock,
            ...(input.kind ? { kind: input.kind } : {}),
          },
        });
        rows.push(after);

        await tx.auditLog.create({
          data: {
            actorId,
            action: 'prize.updated',
            entityType: 'Prize',
            entityId: after.id,
            payload: { campaignId, key: after.key, before: snapshot(before), after: snapshot(after) },
          },
        });
      }
      return rows;
    });

    return ok(updated);
  },

  /**
   * Приз без заявок і переможців - видаляється
   * Приз із ними - закривається (stock = issued + reserved): історія лишається,
   * нових видач немає. Відкрити назад - через update з більшим стоком
   */
  async remove(
    campaignId: string,
    keys: readonly string[],
    actorId: bigint,
  ): Promise<Result<RemoveOutcome, string[]>> {
    const unique = [...new Set(keys)];
    if (unique.length === 0) return err(['вкажи ключі призів: /prizes <slug> remove key [key…]']);

    const targets = await prisma.prize.findMany({
      where: { campaignId, key: { in: unique } },
      include: { _count: { select: { claims: true, winners: true } } },
    });

    const found = new Set(targets.map((p) => p.key));
    const missing = unique.filter((k) => !found.has(k));
    if (missing.length > 0) return err(missing.map((k) => `«${k}» немає в кампанії`));

    const inUse = targets.filter((p) => p._count.claims + p._count.winners > 0);
    const free = targets.filter((p) => p._count.claims + p._count.winners === 0);

    await prisma.$transaction(async (tx) => {
      if (free.length > 0) {
        await tx.prize.deleteMany({ where: { id: { in: free.map((p) => p.id) } } });
      }

      for (const prize of inUse) {
        await tx.prize.update({
          where: { id: prize.id },
          data: { stock: committed(prize) },
        });
      }

      await tx.auditLog.createMany({
        data: [
          ...free.map((p) => ({
            actorId,
            action: 'prize.removed',
            entityType: 'Prize',
            entityId: p.id,
            payload: { campaignId, key: p.key, ...snapshot(p) },
          })),
          ...inUse.map((p) => ({
            actorId,
            action: 'prize.closed',
            entityType: 'Prize',
            entityId: p.id,
            payload: { campaignId, key: p.key, stockBefore: p.stock, stockAfter: committed(p) },
          })),
        ],
      });
    });

    return ok({ deleted: free.map((p) => p.key), closed: inUse.map((p) => p.key) });
  },

  async checkAgainstRules(campaign: Pick<Campaign, 'id' | 'rules'>): Promise<RulesCheck> {
    const referenced = prizeKeysReferencedByRules(campaign.rules);
    const prizes = await prisma.prize.findMany({
      where: { campaignId: campaign.id },
      select: { key: true, kind: true },
    });

    const prizeKeys = new Set(prizes.map((p) => p.key));
    const referencedSet = new Set(referenced);

    return {
      missing: referenced.filter((k) => !prizeKeys.has(k)),
      unused: prizes
        .filter((p) => p.kind === 'GUARANTEED' && !referencedSet.has(p.key))
        .map((p) => p.key),
    };
  },
};
