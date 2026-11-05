import { z } from 'zod';
import type { RuleAward, RuleContext, StrategyResult } from './types.js';
import { findStrategy, resolveStrategy } from './registry.js';

export const campaignRulesSchema = z.object({
  strategies: z
    .array(
      z.object({
        type: z.string(),
        config: z.unknown(),
      }),
    )
    .min(1),
});

export type CampaignRules = z.infer<typeof campaignRulesSchema>;

export function validateCampaignRules(raw: unknown): CampaignRules {
  const rules = campaignRulesSchema.parse(raw);
  for (const entry of rules.strategies) {
    const strategy = resolveStrategy(entry.type);
    strategy.configSchema.parse(entry.config);
  }
  return rules;
}

export function formatConfigError(error: unknown): string {
  return error instanceof z.ZodError
    ? z.prettifyError(error)
    : error instanceof Error
      ? error.message // SyntaxError від JSON.parse
      : String(error);
}

/**
 * Ключі призів, на які посилаються правила кампанії
 * Сирий JSON із БД; невалідні записи просто пропускаються
 */
export function prizeKeysReferencedByRules(raw: unknown): string[] {
  const parsed = campaignRulesSchema.safeParse(raw);
  if (!parsed.success) return [];

  const keys = new Set<string>();
  for (const entry of parsed.data.strategies) {
    const strategy = findStrategy(entry.type);
    const config = strategy?.configSchema.safeParse(entry.config);
    if (!strategy || !config?.success) continue;

    for (const key of strategy.prizeKeys(config.data)) keys.add(key);
  }
  return [...keys];
}

export function evaluateAwards(
  ctx: RuleContext,
  rules: CampaignRules,
): StrategyResult {
  const raw: RuleAward[] = [];

  for (const entry of rules.strategies) {
    const strategy = resolveStrategy(entry.type);
    const config = strategy.configSchema.parse(entry.config);
    raw.push(...strategy.evaluate(ctx, config));
  }

  const byKey = new Map(ctx.prizes.map((p) => [p.key, p]));
  const awards: RuleAward[] = [];
  const outOfStock: RuleAward[] = [];
  const takenThisRun = new Map<string, number>();

  for (const award of raw) {
    const prize = byKey.get(award.prizeKey);

    if (!prize) {
      outOfStock.push({
        ...award,
        reason: `${award.reason} | приз "${award.prizeKey}" не знайдено в кампанії`,
      });
      continue;
    }

    if (prize.stock === null) {
      awards.push(award);
      continue;
    }

    const already = takenThisRun.get(prize.key) ?? 0;
    const available = prize.stock - prize.issued - prize.reserved - already;

    if (available > 0) {
      takenThisRun.set(prize.key, already + 1);
      awards.push(award);
    } else {
      outOfStock.push({ ...award, reason: `${award.reason} | склад порожній` });
    }
  }

  return { awards, outOfStock };
}
