import { z } from 'zod';
import type { PrizeStrategy } from '../types.js';

/**
 * Миттєвий виграш - шанс на кожен введений код.
 *   chance: 0.05, prize: "bottle"
 *
 * random() приходить з контексту, тож у тестах підміняється на константу.
 */
const configSchema = z.object({
  chance: z.number().min(0).max(1),
  prize: z.string(),
});

export type InstantWinConfig = z.infer<typeof configSchema>;

export const instantWinStrategy: PrizeStrategy<InstantWinConfig> = {
  type: 'instant-win',
  configSchema,
  defaultConfig: { chance: 0, prize: '' },
  prizeKeys: (config) => (config.prize ? [config.prize] : []),
  evaluate(ctx, config) {
    if (ctx.random() >= config.chance) return [];
    return [
      {
        prizeKey: config.prize,
        reason: `instant-win: chance=${config.chance}`,
      },
    ];
  },
};
