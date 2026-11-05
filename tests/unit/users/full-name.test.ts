import { describe, expect, it } from 'vitest';
import { validateFullName } from '../../../src/domain/users/full-name.js';

describe('validateFullName', () => {
  it('приймає нормальне ПІБ', () => {
    const r = validateFullName('іваненко іван іванович');
    expect(r).toEqual({ ok: true, value: 'Іваненко Іван Іванович' });
  });

  it('стискає зайві пробіли', () => {
    const r = validateFullName('  Петренко   Олег  ');
    expect(r.ok && r.value).toBe('Петренко Олег');
  });

  it('дозволяє дефіси й апострофи', () => {
    expect(validateFullName("Кос-Анатольський Дмитро Іванович").ok).toBe(true);
    expect(validateFullName("Д'Артаньян Шарль").ok).toBe(true);
    expect(validateFullName('Мар’яненко Олена').ok).toBe(true);
  });

  it('вимагає щонайменше два слова', () => {
    expect(validateFullName('Іваненко')).toEqual({ ok: false, reason: 'too_few_parts' });
  });

  it('відсіює цифри та емодзі', () => {
    expect(validateFullName('Іван 123').ok).toBe(false);
    expect(validateFullName('Іван 😀').ok).toBe(false);
    expect(validateFullName('Іваненко Іван #1').ok).toBe(false);
  });

  it('латиниця дозволена - \\p{L} це будь-яка літера', () => {
    expect(validateFullName('John Smith').ok).toBe(true);
    expect(validateFullName('Anna Maria Kowalska').ok).toBe(true);
  });

  it('ініціали не приймаються - потрібне повне ПІБ', () => {
    expect(validateFullName('Іваненко І').ok).toBe(false);
    expect(validateFullName('Іваненко І І').ok).toBe(false);
    expect(validateFullName('a b').ok).toBe(false);
  });

  it('короткі справжні імена проходять', () => {
    expect(validateFullName('Ян Лі').ok).toBe(true);
    expect(validateFullName('Іво Бок').ok).toBe(true);
  });

  it('обрізає надто довге', () => {
    expect(validateFullName('Іваненко '.repeat(20))).toMatchObject({ ok: false });
  });
});