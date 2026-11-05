import type { z } from 'zod';

export type PrizeSnapshot = {
  key: string;
  title: string;
  /** null = необмежено */
  stock: number | null;
  reserved: number;
  issued: number;
};

export type RuleContext = {
  campaignId: string;
  userId: string;
  /** порядковий номер щойно зробленої активації (1-based) */
  position: number;
  /** усього активацій юзера в цій кампанії ПІСЛЯ поточної */
  activationCount: number;
  activationId: string;
  prizes: readonly PrizeSnapshot[];
  /** інжектується заради детермінованих тестів */
  random: () => number;
};

export type RuleAward = {
  prizeKey: string;
  /** для аудиту й дебагу: чому саме цей приз */
  reason: string;
};

export type StrategyResult = {
  awards: RuleAward[];
  /** випали за правилами, але закінчилися на складі */
  outOfStock: RuleAward[];
};

export interface PrizeStrategy<TConfig = unknown> {
  readonly type: string;
  readonly configSchema: z.ZodType<TConfig>;
  /** Нейтральний конфіг-заглушка: проходить схему і нічого не видає */
  readonly defaultConfig: TConfig;
  /** Ключі призів, які стратегія може видати - для звірки з таблицею Prize */
  prizeKeys(config: TConfig): string[];
  evaluate(ctx: RuleContext, config: TConfig): RuleAward[];
}
