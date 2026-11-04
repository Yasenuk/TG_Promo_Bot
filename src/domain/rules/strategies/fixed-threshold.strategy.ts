import { z } from 'zod';
import type { PrizeStrategy } from '../types.js';

/**
 * Разові пороги: приз видається рівно один раз на вказаній кількості.
 *   thresholds: [{ at: 5, prize: "tshirt" }, { at: 15, prize: "bag" }]
 */
const configSchema = z.object({
  thresholds: z.array(
    z.object({
      at: z.number().int().positive(),
      prize: z.string(),
    }),
  ),
});

export type FixedThresholdConfig = z.infer<typeof configSchema>;

export const fixedThresholdStrategy: PrizeStrategy<FixedThresholdConfig> = {
  type: 'fixed-threshold',
  configSchema,
  defaultConfig: { thresholds: [] },
  evaluate(ctx, config) {
    return config.thresholds
      .filter((t) => t.at === ctx.activationCount)
      .map((t) => ({
        prizeKey: t.prize,
        reason: `fixed-threshold: at=${t.at}`,
      }));
  },
};
