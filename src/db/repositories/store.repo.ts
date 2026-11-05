import { prisma } from '../client.js';
import type { City, Store } from '../../generated/prisma/client.js';

export const storeRepo = {
  /**
   * Міста, де для цієї кампанії є хоч один активний магазин
   *
   * Якщо для кампанії не заведено жодного CampaignStore — доступні всі
   * активні магазини
   */
  async listCitiesForCampaign(campaignId: string): Promise<City[]> {
    const restricted = await prisma.campaignStore.count({ where: { campaignId } });

    return prisma.city.findMany({
      where: {
        isActive: true,
        stores: {
          some:
            restricted > 0
              ? { isActive: true, campaigns: { some: { campaignId } } }
              : { isActive: true },
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  },

  async listStores(cityId: string, campaignId: string): Promise<Store[]> {
    const restricted = await prisma.campaignStore.count({ where: { campaignId } });

    return prisma.store.findMany({
      where: {
        cityId,
        isActive: true,
        ...(restricted > 0 ? { campaigns: { some: { campaignId } } } : {}),
      },
      orderBy: { name: 'asc' },
    });
  },

  async countByCity(campaignId: string): Promise<Map<string, number>> {
    const restricted = await prisma.campaignStore.count({ where: { campaignId } });

    const rows = await prisma.store.groupBy({
      by: ['cityId'],
      where: {
        isActive: true,
        ...(restricted > 0 ? { campaigns: { some: { campaignId } } } : {}),
      },
      _count: { _all: true },
    });

    return new Map(rows.map((r) => [r.cityId, r._count._all]));
  },

  findById(id: string): Promise<(Store & { city: City }) | null> {
    return prisma.store.findUnique({ where: { id }, include: { city: true } });
  },

  /** Скільки магазинів прив'язано до кампанії (0 = доступні всі) */
  countLinked(campaignId: string): Promise<number> {
    return prisma.campaignStore.count({ where: { campaignId } });
  },

  /** Прив'язує магазини до кампанії, дублі пропускає. Повертає к-сть нових зв'язків */
  async linkToCampaign(campaignId: string, storeIds: string[]): Promise<number> {
    if (storeIds.length === 0) return 0;

    const { count } = await prisma.campaignStore.createMany({
      data: storeIds.map((storeId) => ({ campaignId, storeId })),
      skipDuplicates: true,
    });
    return count;
  },
};
