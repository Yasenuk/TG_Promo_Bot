import type { PrizeStrategy } from './types.js';
import { cyclicThresholdStrategy } from './strategies/cyclic-threshold.strategy.js';
import { fixedThresholdStrategy } from './strategies/fixed-threshold.strategy.js';
import { instantWinStrategy } from './strategies/instant-win.strategy.js';
import { everyNStrategy } from './strategies/every-n.strategy.js';

const strategies = new Map<string, PrizeStrategy<never>>();

export function registerStrategy<T>(strategy: PrizeStrategy<T>): void {
  strategies.set(strategy.type, strategy as unknown as PrizeStrategy<never>);
}

export function findStrategy(type: string): PrizeStrategy<never> | undefined {
  return strategies.get(type);
}

export function resolveStrategy(type: string): PrizeStrategy<never> {
  const strategy = strategies.get(type);
  if (!strategy) {
    const known = [...strategies.keys()].join(', ');
    throw new Error(`Невідома стратегія "${type}". Доступні: ${known}`);
  }
  return strategy;
}

export function listStrategyTypes(): string[] {
  return [...strategies.keys()];
}

registerStrategy(cyclicThresholdStrategy);
registerStrategy(fixedThresholdStrategy);
registerStrategy(instantWinStrategy);
registerStrategy(everyNStrategy);
