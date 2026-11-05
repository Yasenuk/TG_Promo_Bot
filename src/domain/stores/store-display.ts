/**
 * Як показувати магазин людям і менеджерам
 */

type StoreLike = { name: string; address: string };

/** Назва, якщо у файлі її не було: перша частина адреси до коми */
export function deriveStoreName(address: string): string {
  return address.split(',')[0]?.trim() || address;
}

/** Назву задали руками, а не вирізали з адреси */
export function hasOwnName(store: StoreLike): boolean {
  return store.name.trim() !== deriveStoreName(store.address.trim());
}

/**
 * «вул. Мазепи, буд. 28/3» - якщо назва вирізана з адреси
 * «Тіпок №5 - вул. Мазепи, 28» - якщо назва справжня
 */
export function formatStore(store: StoreLike): string {
  return hasOwnName(store) ? `${store.name} - ${store.address}` : store.address;
}

/** «м. Тернопіль, вул. Мазепи, буд. 28/3» */
export function formatStorePlace(store: StoreLike & { city: { name: string } }): string {
  return `${store.city.name}, ${formatStore(store)}`;
}
