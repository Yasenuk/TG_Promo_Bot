import { z } from 'zod';
import type { PrizeStrategy } from '../types.js';

/**
 * Циклічні пороги.
 *
 *   cycleLength: 6, awards: { "2": "prize 1", "4": "prize 2", "0": "prize 3" }
 *   → 2, 8, 14  = prize 1
 *   → 4, 10, 16 = prize 2
 *   → 6, 12, 18 = prize 3 (залишок 0)
 *
 * Ключ awards — це activationCount % cycleLength.
 */
const configSchema = z.object({
  cycleLength: z.number().int().positive(),
  awards: z.record(z.string(), z.string()),
});

export type CyclicThresholdConfig = z.infer<typeof configSchema>;

export const cyclicThresholdStrategy: PrizeStrategy<CyclicThresholdConfig> = {
  type: 'cyclic-threshold',
  configSchema,
  defaultConfig: { cycleLength: 1, awards: {} },
  evaluate(ctx, config) {
    if (ctx.activationCount <= 0) return [];

    const remainder = ctx.activationCount % config.cycleLength;
    const prizeKey = config.awards[String(remainder)];
    if (!prizeKey) return [];

    const cycle = Math.ceil(ctx.activationCount / config.cycleLength);
    return [
      {
        prizeKey,
        reason: `cyclic-threshold: count=${ctx.activationCount}, cycle=${cycle}, remainder=${remainder}`,
      },
    ];
  },
};
