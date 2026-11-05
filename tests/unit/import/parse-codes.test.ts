import { describe, expect, it } from 'vitest';
import {
  columnLetter,
  extractCodeLines,
  isCodeCandidate,
  pickCodeColumn,
} from '../../../src/domain/import/parse-codes.js';

/** Структура як у unique_codes_5000.xlsx: назва, підпис, шапка, № у колонці A */
function generatorLikeTable(count: number): string[][] {
  const rows: string[][] = [
    ['Генератор унікальних кодів', '', '', 'Загальна кількість:', String(count)],
    ['Формат: 5 великих літер + 5 цифр (наприклад, AAAAA11111)', '', '', 'Унікальних кодів:', String(count)],
    ['№', 'Унікальний код', 'Довжина', 'Формат', 'Статус'],
  ];
  for (let i = 1; i <= count; i++) {
    const code = `ABCDE${String(i).padStart(5, '0')}`;
    rows.push([String(i), code, '10', '5A + 5D', 'Унікальний']);
  }
  return rows;
}

describe('isCodeCandidate', () => {
  it('відкидає кирилицю навіть якщо вона схожа на латиницю', () => {
    expect(isCodeCandidate('Унікальний код')).toBe(false);
    expect(isCodeCandidate('НУ4А')).toBe(false);
  });

  it('приймає латиницю й цифри від 4 символів', () => {
    expect(isCodeCandidate('UVDHX29016')).toBe(true);
    expect(isCodeCandidate('hy-4f2a')).toBe(true);
    expect(isCodeCandidate('999')).toBe(false);
  });
});

describe('pickCodeColumn', () => {
  it('обирає колонку з кодами, а не «№»', () => {
    expect(pickCodeColumn(generatorLikeTable(1500))).toBe(1);
  });

  it('одноколонковий файл без шапки', () => {
    expect(pickCodeColumn([['AAAA1111'], ['BBBB2222']])).toBe(0);
  });

  it('-1, якщо кодів немає', () => {
    expect(pickCodeColumn([['№', 'Назва'], ['1', 'Київ']])).toBe(-1);
    expect(pickCodeColumn([])).toBe(-1);
  });
});

describe('extractCodeLines', () => {
  it('віддає тільки коди без назви й шапки', () => {
    const { column, lines } = extractCodeLines(generatorLikeTable(1500));
    expect(column).toBe(1);
    expect(lines).toHaveLength(1500);
    expect(lines[0]).toBe('ABCDE00001');
  });

  it('сміття ПІСЛЯ першого коду лишає - його порахують як некоректне', () => {
    const { lines } = extractCodeLines([['код'], ['AAAA1111'], ['Разом'], ['BBBB2222']]);
    expect(lines).toEqual(['AAAA1111', 'Разом', 'BBBB2222']);
  });
});

describe('columnLetter', () => {
  it('A, Z, AA', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
  });
});
