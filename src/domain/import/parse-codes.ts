import { looksLikeCode, normalizeCode } from '../codes/normalize.js';

const CYRILLIC = /\p{Script=Cyrillic}/u;

/**
 * Значення з файлу схоже на код.
 * Кирилиця у згенерованих кодах не буває - це заголовки й підписи.
 */
export function isCodeCandidate(raw: string): boolean {
  return !CYRILLIC.test(raw) && looksLikeCode(normalizeCode(raw));
}

/**
 * Колонка з кодами - та, де найбільше УНІКАЛЬНИХ значень, схожих на код.
 * «№» програє, бо 1–999 закороткі; «5A + 5D» однакове в кожному рядку.
 * -1, якщо кодів немає ніде.
 */
export function pickCodeColumn(table: readonly string[][]): number {
  const width = table.reduce((max, row) => Math.max(max, row.length), 0);
  let best = -1;
  let bestScore = 0;

  for (let col = 0; col < width; col++) {
    const unique = new Set<string>();
    for (const row of table) {
      const raw = row[col]?.trim();
      if (raw && isCodeCandidate(raw)) unique.add(normalizeCode(raw));
    }
    if (unique.size > bestScore) {
      best = col;
      bestScore = unique.size;
    }
  }

  return best;
}

export type ExtractedCodes = {
  /** індекс колонки, -1 якщо не знайдено */
  column: number;
  /** значення колонки, починаючи з першого схожого на код */
  lines: string[];
};

/**
 * Витягує значення колонки з кодами.
 * Усе ДО першого коду (назва, підписи, заголовок) відкидається мовчки,
 * усе ПІСЛЯ - іде далі й перевіряється як код.
 */
export function extractCodeLines(table: readonly string[][]): ExtractedCodes {
  const column = pickCodeColumn(table);
  if (column === -1) return { column, lines: [] };

  const values = table.map((row) => row[column]?.trim() ?? '').filter(Boolean);
  const start = values.findIndex(isCodeCandidate);

  return { column, lines: start === -1 ? [] : values.slice(start) };
}

/** 0 → A, 25 → Z, 26 → AA */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}
