import { prisma } from '../client.js';
import type { Campaign } from '../../generated/prisma/client.js';

export const campaignRepo = {
  findBySlug(slug: string): Promise<Campaign | null> {
    return prisma.campaign.findUnique({ where: { slug } });
  },

  findById(id: string): Promise<Campaign | null> {
    return prisma.campaign.findUnique({ where: { id } });
  },

  listActive(): Promise<Campaign[]> {
    return prisma.campaign.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
  },

  listAll(): Promise<Campaign[]> {
    return prisma.campaign.findMany({ orderBy: { createdAt: 'desc' } });
  },

  bindAdminThread(slug: string, threadId: number): Promise<Campaign> {
    return prisma.campaign.update({
      where: { slug },
      data: { adminThreadId: threadId },
    });
  },

  setStatus(slug: string, status: Campaign['status']): Promise<Campaign> {
    return prisma.campaign.update({ where: { slug }, data: { status } });
  },

  create(campaign: Omit<Campaign, 'id' | 'createdAt' | 'updatedAt'>): Promise<Campaign> {
    return prisma.campaign.create({
      data: {
        slug: campaign.slug,
        title: campaign.title,
        rules: campaign.rules as never,
        codePrefix: campaign.codePrefix ?? null,
        status: campaign.status,
      },
    });
  },
};
