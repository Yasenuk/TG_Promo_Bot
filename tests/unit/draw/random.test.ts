import { describe, expect, it } from 'vitest';
import { createSeededRandom, shuffle } from '../../../src/domain/draw/random.js';

describe('seeded random', () => {
  it('той самий seed - та сама послідовність', () => {
    const a = createSeededRandom('seed-123');
    const b = createSeededRandom('seed-123');

    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b());
    }
  });

  it('різні seed - різні послідовності', () => {
    const a = createSeededRandom('seed-a');
    const b = createSeededRandom('seed-b');

    const first = Array.from({ length: 10 }, () => a());
    const second = Array.from({ length: 10 }, () => b());

    expect(first).not.toEqual(second);
  });

  it('значення в межах [0, 1)', () => {
    const random = createSeededRandom('range');
    for (let i = 0; i < 1000; i++) {
      const v = random();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('розподіл рівномірний - жоден дециль не порожній і не роздутий', () => {
    const random = createSeededRandom('uniform');
    const buckets = new Array<number>(10).fill(0);

    for (let i = 0; i < 100_000; i++) {
      const idx = Math.floor(random() * 10);
      buckets[idx] = (buckets[idx] ?? 0) + 1;
    }

    // Очікуємо ~10 000 у кожному; допуск 10%
    for (const count of buckets) {
      expect(count).toBeGreaterThan(9000);
      expect(count).toBeLessThan(11000);
    }
  });
});

describe('shuffle', () => {
  const items = Array.from({ length: 50 }, (_, i) => i);

  it('детермінований для однакового seed', () => {
    const a = shuffle(items, createSeededRandom('x'));
    const b = shuffle(items, createSeededRandom('x'));
    expect(a).toEqual(b);
  });

  it('не втрачає і не дублює елементи', () => {
    const result = shuffle(items, createSeededRandom('y'));
    expect(result).toHaveLength(items.length);
    expect(new Set(result).size).toBe(items.length);
    expect([...result].sort((p, q) => p - q)).toEqual(items);
  });

  it('не мутує вхідний масив', () => {
    const original = [...items];
    shuffle(items, createSeededRandom('z'));
    expect(items).toEqual(original);
  });

  it('справді перемішує', () => {
    const result = shuffle(items, createSeededRandom('mix'));
    expect(result).not.toEqual(items);
  });
});
