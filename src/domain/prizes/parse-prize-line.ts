import { err, ok, type Result } from '../../shared/result.js';
import type { PrizeKind } from '../../generated/prisma/client.js';

export type PrizeInput = {
  key: string;
  title: string;
  /** null = необмежено */
  stock: number | null;
  /** не вказано: add → GUARANTEED, update → не чіпаємо */
  kind?: PrizeKind;
};

/** Ключі живуть у JSON правил, тож тільки безпечні символи */
const KEY_RE = /^[a-z0-9_-]+$/;
const STOCK_RE = /^\d+$/;
const INT4_MAX = 2_147_483_647;
const UNLIMITED = '-';
const KINDS: Record<string, PrizeKind> = { grand: 'GRAND', guaranteed: 'GUARANTEED' };
  
/**
 * Один рядок: `key | назва | кількість [| grand]`
 *   кількість - ціле ≥ 0 або ∞; 0 = приз закритий
 */
export function parsePrizeLine(line: string): Result<PrizeInput, string> {
  const [key = '', title = '', stockRaw = '', kindRaw = '', ...extra] = line
    .split('|')
    .map((s) => s.trim());

  if (extra.length > 0) return err(`«${line.trim()}»: забагато колонок`);
  if (!KEY_RE.test(key)) return err(`ключ «${key}»: лише a-z, 0-9, _ і -`);
  if (!title) return err(`«${key}»: немає назви`);

  let stock: number | null = null;
  if (stockRaw !== UNLIMITED) {
    if (!STOCK_RE.test(stockRaw) || Number(stockRaw) > INT4_MAX) {
      return err(`«${key}»: кількість - ціле число >= 0 або ∞`);
    }
    stock = Number(stockRaw);
  }

  if (!kindRaw) return ok({ key, title, stock });

  const kind = KINDS[kindRaw.toLowerCase()];
  if (!kind) return err(`«${key}»: тип «${kindRaw}» - лише grand або guaranteed`);

  return ok({ key, title, stock, kind });
}

/** Усі рядки разом: або всі валідні, або повний список помилок */
export function parsePrizeLines(lines: readonly string[]): Result<PrizeInput[], string[]> {
  const prizes: PrizeInput[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (!line.trim()) continue;

    const parsed = parsePrizeLine(line);
    if (!parsed.ok) {
      errors.push(parsed.error);
      continue;
    }

    if (seen.has(parsed.value.key)) {
      errors.push(`«${parsed.value.key}» повторюється`);
      continue;
    }

    seen.add(parsed.value.key);
    prizes.push(parsed.value);
  }

  if (errors.length > 0) return err(errors);
  if (prizes.length === 0) return err(['жодного призу - кожег приз має бути з нового рядка: key | назва | кількість']);
  return ok(prizes);
}
