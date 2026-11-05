import { describe, expect, it } from 'vitest';
import { parsePrizeLine, parsePrizeLines } from '../../../src/domain/prizes/parse-prize-line.js';

describe('parsePrizeLine', () => {
  it('назва з пробілами й кількість', () => {
    expect(parsePrizeLine('opener | Відкривачка для пляшок | 100')).toEqual({
      ok: true,
      value: { key: 'opener', title: 'Відкривачка для пляшок', stock: 100 },
    });
  });

  it('∞ та inf = необмежено', () => {
    for (const raw of ['∞', 'inf', 'INF']) {
      const r = parsePrizeLine(`cap | Кепка | ${raw}`);
      expect(r.ok && r.value.stock).toBeNull();
    }
  });

  it('0 - валідний сток (закритий приз), а не «необмежено»', () => {
    const r = parsePrizeLine('cap | Кепка | 0');
    expect(r.ok && r.value.stock).toBe(0);
  });

  it('тип grand / guaranteed без урахування регістру', () => {
    const r = parsePrizeLine('car | Авто | 1 | GRAND');
    expect(r.ok && r.value.kind).toBe('GRAND');
  });

  it('без типу - kind не задано', () => {
    const r = parsePrizeLine('cap | Кепка | 5');
    expect(r.ok && 'kind' in r.value).toBe(false);
  });

  it.each([
    ['порожня кількість', 'cap | Кепка'],
    ['порожня кількість з роздільником', 'cap | Кепка | '],
    ['сміття', 'cap | Кепка | abc'],
    ['відʼємна', 'cap | Кепка | -5'],
    ['дробова', 'cap | Кепка | 1.5'],
    ['більше int4', 'cap | Кепка | 3000000000'],
    ['без назви', 'cap |  | 5'],
    ['великі літери в ключі', 'Cap | Кепка | 5'],
    ['HTML у ключі', '<b> | Кепка | 5'],
    ['невідомий тип', 'cap | Кепка | 5 | mega'],
    ['зайва колонка', 'cap | Кепка | 5 | grand | x'],
  ])('помилка: %s', (_name, line) => {
    expect(parsePrizeLine(line).ok).toBe(false);
  });
});

describe('parsePrizeLines', () => {
  it('порожні рядки пропускає', () => {
    const r = parsePrizeLines(['', 'a | A | 1', '   ', 'b | B | ∞']);
    expect(r.ok && r.value.map((p) => p.key)).toEqual(['a', 'b']);
  });

  it('збирає ВСІ помилки, а не першу', () => {
    const r = parsePrizeLines(['a | A | x', 'b |  | 1', 'c | C | 1']);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toHaveLength(2);
  });

  it('дубль ключа - помилка', () => {
    expect(parsePrizeLines(['a | A | 1', 'a | A2 | 2']).ok).toBe(false);
  });

  it('жодного рядка - помилка', () => {
    expect(parsePrizeLines(['', '  ']).ok).toBe(false);
  });
});
