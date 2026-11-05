import { describe, expect, it } from 'vitest';
import {
  evaluateAwards,
  prizeKeysReferencedByRules,
  validateCampaignRules,
} from '../../../src/domain/rules/engine.js';
import { ctx, prize } from './helpers.js';
import { listStrategyTypes, resolveStrategy } from '../../../src/domain/rules/registry.js';

describe('fixed-threshold', () => {
  const rules = {
    strategies: [
      {
        type: 'fixed-threshold',
        config: {
          thresholds: [
            { at: 5, prize: 'tshirt' },
            { at: 15, prize: 'bag' },
          ],
        },
      },
    ],
  };
  const prizes = [prize('tshirt'), prize('bag')];

  it('спрацьовує рівно на вказаній кількості', () => {
    expect(evaluateAwards(ctx(5, prizes), rules).awards).toHaveLength(1);
    expect(evaluateAwards(ctx(15, prizes), rules).awards).toHaveLength(1);
  });

  it('мовчить на решті', () => {
    for (const count of [4, 6, 14, 16, 20]) {
      expect(evaluateAwards(ctx(count, prizes), rules).awards).toHaveLength(0);
    }
  });
});

describe('every-n', () => {
  const rules = {
    strategies: [{ type: 'every-n', config: { n: 3, prize: 'sticker' } }],
  };
  const prizes = [prize('sticker')];

  it('кожен третій код', () => {
    for (const count of [3, 6, 9, 12]) {
      expect(evaluateAwards(ctx(count, prizes), rules).awards).toHaveLength(1);
    }
    for (const count of [1, 2, 4, 5, 7]) {
      expect(evaluateAwards(ctx(count, prizes), rules).awards).toHaveLength(0);
    }
  });
});

describe('instant-win', () => {
  const rules = {
    strategies: [{ type: 'instant-win', config: { chance: 0.05, prize: 'bottle' } }],
  };
  const prizes = [prize('bottle')];

  it('виграє, коли random нижчий за шанс', () => {
    const result = evaluateAwards(ctx(1, prizes, () => 0.01), rules);
    expect(result.awards.map((a) => a.prizeKey)).toEqual(['bottle']);
  });

  it('не виграє, коли random вищий', () => {
    const result = evaluateAwards(ctx(1, prizes, () => 0.5), rules);
    expect(result.awards).toHaveLength(0);
  });

  it('межа chance не спрацьовує (>= означає програш)', () => {
    const result = evaluateAwards(ctx(1, prizes, () => 0.05), rules);
    expect(result.awards).toHaveLength(0);
  });
});

describe('композиція стратегій', () => {
  it('циклічні пороги і миттєвий виграш співіснують', () => {
    const rules = {
      strategies: [
        {
          type: 'cyclic-threshold',
          config: { cycleLength: 6, awards: { '2': 'opener' } },
        },
        { type: 'instant-win', config: { chance: 1, prize: 'bottle' } },
      ],
    };
    const prizes = [prize('opener'), prize('bottle')];

    const result = evaluateAwards(ctx(2, prizes, () => 0), rules);
    expect(result.awards.map((a) => a.prizeKey).sort()).toEqual([
      'bottle',
      'opener',
    ]);
  });
});

describe('validateCampaignRules', () => {
  it('пропускає коректний конфіг', () => {
    expect(() =>
      validateCampaignRules({
        strategies: [
          {
            type: 'cyclic-threshold',
            config: { cycleLength: 6, awards: { '2': 'opener' } },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('падає на невідомій стратегії', () => {
    expect(() =>
      validateCampaignRules({ strategies: [{ type: 'магія', config: {} }] }),
    ).toThrow(/Невідома стратегія/);
  });

  it('падає на кривому конфігу стратегії', () => {
    expect(() =>
      validateCampaignRules({
        strategies: [
          { type: 'cyclic-threshold', config: { cycleLength: -1, awards: {} } },
        ],
      }),
    ).toThrow();
  });

  it('падає на порожньому списку стратегій', () => {
    expect(() => validateCampaignRules({ strategies: [] })).toThrow();
  });
});

describe('defaultConfig', () => {
  for (const type of listStrategyTypes()) {
    const rules = { strategies: [{ type, config: resolveStrategy(type).defaultConfig }] };

    it(`${type}: проходить валідацію`, () => {
      expect(() => validateCampaignRules(rules)).not.toThrow();
    });

    it(`${type}: нічого не видає й не пише в outOfStock`, () => {
      for (let count = 1; count <= 20; count++) {
        // random = 0 - найгірший випадок для instant-win
        const result = evaluateAwards(ctx(count, [], () => 0), rules);
        expect(result.awards).toHaveLength(0);
        expect(result.outOfStock).toHaveLength(0);
      }
    });

    it(`${type}: не посилається на жоден приз`, () => {
      expect(prizeKeysReferencedByRules(rules)).toEqual([]);
    });
  }
});

describe('prizeKeysReferencedByRules', () => {
  it('збирає ключі з усіх стратегій без дублів', () => {
    const rules = {
      strategies: [
        { type: 'cyclic-threshold', config: { cycleLength: 6, awards: { '2': 'opener', '0': 'cap' } } },
        { type: 'fixed-threshold', config: { thresholds: [{ at: 5, prize: 'cap' }, { at: 9, prize: 'bag' }] } },
        { type: 'every-n', config: { n: 3, prize: 'sticker' } },
        { type: 'instant-win', config: { chance: 0.1, prize: 'bottle' } },
      ],
    };
    expect(prizeKeysReferencedByRules(rules).sort()).toEqual(
      ['bag', 'bottle', 'cap', 'opener', 'sticker'],
    );
  });

  it('невалідні правила й невідомі стратегії не валять, а дають []', () => {
    expect(prizeKeysReferencedByRules(null)).toEqual([]);
    expect(prizeKeysReferencedByRules({ strategies: [{ type: 'nope', config: {} }] })).toEqual([]);
    expect(prizeKeysReferencedByRules({ strategies: [{ type: 'every-n', config: {} }] })).toEqual([]);
  });
});
