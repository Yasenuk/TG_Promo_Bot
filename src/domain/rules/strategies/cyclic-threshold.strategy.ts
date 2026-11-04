import { z } from 'zod';
import type { PrizeStrategy } from '../types.js';

/**
 * Циклічні пороги — механіка Hype.
 *
 *   cycleLength: 6, awards: { "2": "opener", "4": "mug", "0": "cap" }
 *   → 2, 8, 14  = відкривачка
 *   → 4, 10, 16 = кружка
 *   → 6, 12, 18 = кепка (залишок 0)
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
