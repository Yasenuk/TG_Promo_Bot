import { z } from 'zod';
import type { PrizeStrategy } from '../types.js';

/**
 * Кожні N кодів - той самий приз.
 *   n: 3, prize: "sticker"
 */
const configSchema = z.object({
  n: z.number().int().positive(),
  prize: z.string(),
});

export type EveryNConfig = z.infer<typeof configSchema>;

export const everyNStrategy: PrizeStrategy<EveryNConfig> = {
  type: 'every-n',
  configSchema,
  defaultConfig: { n: 1, prize: '' },
  prizeKeys: (config) => (config.prize ? [config.prize] : []),
  evaluate(ctx, config) {
    // порожній prize = стратегія вимкнена (заглушка)
    if (!config.prize) return [];
    if (ctx.activationCount <= 0) return [];
    if (ctx.activationCount % config.n !== 0) return [];
    return [
      {
        prizeKey: config.prize,
        reason: `every-n: n=${config.n}, count=${ctx.activationCount}`,
      },
    ];
  },
};
