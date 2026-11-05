import { describe, expect, it } from 'vitest';
import { evaluateAwards } from '../../../src/domain/rules/engine.js';
import { HYPE_PRIZES, HYPE_RULES, ctx, prize } from './helpers.js';

describe('cyclic-threshold (механіка Hype)', () => {
  it('не видає приз на непорогових кодах', () => {
    for (const count of [1, 3, 5, 7, 9, 11]) {
      const result = evaluateAwards(ctx(count, HYPE_PRIZES), HYPE_RULES);
      expect(result.awards, `count=${count}`).toHaveLength(0);
    }
  });

  it('видає відкривачку на 2, 8, 14', () => {
    for (const count of [2, 8, 14]) {
      const result = evaluateAwards(ctx(count, HYPE_PRIZES), HYPE_RULES);
      expect(result.awards.map((a) => a.prizeKey), `count=${count}`).toEqual([
        'opener',
      ]);
    }
  });

  it('видає кружку на 4, 10, 16', () => {
    for (const count of [4, 10, 16]) {
      const result = evaluateAwards(ctx(count, HYPE_PRIZES), HYPE_RULES);
      expect(result.awards.map((a) => a.prizeKey), `count=${count}`).toEqual([
        'mug',
      ]);
    }
  });

  it('видає кепку на 6, 12, 18 (залишок 0)', () => {
    for (const count of [6, 12, 18]) {
      const result = evaluateAwards(ctx(count, HYPE_PRIZES), HYPE_RULES);
      expect(result.awards.map((a) => a.prizeKey), `count=${count}`).toEqual([
        'cap',
      ]);
    }
  });

  it('нульова кількість активацій не дає кепку', () => {
    const result = evaluateAwards(ctx(0, HYPE_PRIZES), HYPE_RULES);
    expect(result.awards).toHaveLength(0);
  });

  it('у reason видно номер циклу - для аудиту', () => {
    const result = evaluateAwards(ctx(8, HYPE_PRIZES), HYPE_RULES);
    expect(result.awards[0]?.reason).toContain('cycle=2');
  });
});

describe('обмеження складу', () => {
  it('не обіцяє приз, якого не лишилось', () => {
    const prizes = [prize('opener', { stock: 10, issued: 10 })];
    const result = evaluateAwards(ctx(2, prizes), HYPE_RULES);

    expect(result.awards).toHaveLength(0);
    expect(result.outOfStock.map((a) => a.prizeKey)).toEqual(['opener']);
  });

  it('резерв під незавершені заявки теж рахується', () => {
    const prizes = [prize('opener', { stock: 10, issued: 7, reserved: 3 })];
    const result = evaluateAwards(ctx(2, prizes), HYPE_RULES);

    expect(result.awards).toHaveLength(0);
  });

  it('видає, поки залишок додатний', () => {
    const prizes = [prize('opener', { stock: 10, issued: 7, reserved: 2 })];
    const result = evaluateAwards(ctx(2, prizes), HYPE_RULES);

    expect(result.awards.map((a) => a.prizeKey)).toEqual(['opener']);
  });

  it('stock=null означає необмежено', () => {
    const prizes = [prize('opener', { stock: null, issued: 9999 })];
    const result = evaluateAwards(ctx(2, prizes), HYPE_RULES);

    expect(result.awards).toHaveLength(1);
  });

  it('приз із правил, не заведений у кампанії, не ламає бот', () => {
    const result = evaluateAwards(ctx(2, [prize('mug')]), HYPE_RULES);

    expect(result.awards).toHaveLength(0);
    expect(result.outOfStock[0]?.reason).toContain('не знайдено в кампанії');
  });
});
