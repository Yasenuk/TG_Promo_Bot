import { describe, expect, it } from 'vitest';
import {
  deriveStoreName,
  formatStore,
  formatStorePlace,
  hasOwnName,
} from '../../../src/domain/stores/store-display.js';

describe('deriveStoreName', () => {
  it('бере частину до першої коми', () => {
    expect(deriveStoreName('вул. Мазепи, буд. 28/3')).toBe('вул. Мазепи');
  });

  it('без коми - вся адреса', () => {
    expect(deriveStoreName('вул. Л. Українки')).toBe('вул. Л. Українки');
  });
});

describe('formatStore', () => {
  it('назва вирізана з адреси - показуємо тільки адресу', () => {
    const store = { name: 'вул. Мазепи', address: 'вул. Мазепи, буд. 28/3' };
    expect(hasOwnName(store)).toBe(false);
    expect(formatStore(store)).toBe('вул. Мазепи, буд. 28/3');
  });

  it('назва дорівнює адресі - без дубля', () => {
    const store = { name: 'вул. Л. Українки', address: 'вул. Л. Українки' };
    expect(formatStore(store)).toBe('вул. Л. Українки');
  });

  it('справжня назва - «назва - адреса»', () => {
    const store = { name: 'Тіпок №5', address: 'вул. Мазепи, 28' };
    expect(hasOwnName(store)).toBe(true);
    expect(formatStore(store)).toBe('Тіпок №5 - вул. Мазепи, 28');
  });
});

describe('formatStorePlace', () => {
  it('додає місто спереду', () => {
    const store = { name: 'вул. Ринок', address: 'вул. Ринок, 10', city: { name: 'м. Чортків' } };
    expect(formatStorePlace(store)).toBe('м. Чортків, вул. Ринок, 10');
  });
});
