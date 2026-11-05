import { prisma } from '../../db/client.js';
import { storeRepo } from '../../db/repositories/store.repo.js';
import { parseTable, toRows } from './parse-table.js';
import { looksHierarchical, parseHierarchy } from './parse-hierarchy.js';
import { deriveStoreName } from '../stores/store-display.js';

const COLUMNS = {
  city: ['місто', 'city', 'населений пункт', 'нас. пункт'],
  name: ['назва', 'магазин', 'name', 'store', 'точка'],
  address: ['адреса', 'address', 'вулиця'],
} as const;

const OPTIONAL_COLUMNS = ['name'] as const;

export type StoreImportPreview = {
  ok: true;
  cities: string[];
  newCities: string[];
  stores: { city: string; name: string; address: string }[];
  duplicates: number;
  skipped: number;
  citiesWithoutAddress: string[];
  hierarchical: boolean;
};


export type StoreImportError = {
  ok: false;
  reason: 'empty' | 'missing_columns';
  missing?: string[];
};

/**
 * Розбір файлу БЕЗ запису в базу
 */
export async function previewStoreImport(
  buffer: Buffer,
  fileName: string,
): Promise<StoreImportPreview | StoreImportError> {
  const table = await parseTable(buffer, fileName);
  if (table.length === 0) return { ok: false, reason: 'empty' };

  if (looksHierarchical(table)) {
    return previewHierarchy(buffer.toString('utf8'));
  }

  if (table.length < 2) return { ok: false, reason: 'empty' };

  const { rows, missing } = toRows(table, COLUMNS, OPTIONAL_COLUMNS);
  if (missing.length > 0) return { ok: false, reason: 'missing_columns', missing };

  const seen = new Set<string>();
  const stores: { city: string; name: string; address: string }[] = [];
  let duplicates = 0;
  let skipped = 0;

  for (const row of rows) {
    const city = row.city?.trim() ?? '';
    const address = row.address?.trim() ?? '';
    const name = row.name?.trim() || deriveStoreName(address);

    if (!city || !address) {
      skipped++;
      continue;
    }

    const key = `${city}|${name}|${address}`.toLowerCase();
    if (seen.has(key)) {
      duplicates++;
      continue;
    }

    seen.add(key);
    stores.push({ city, name, address });
  }

  const cities = [...new Set(stores.map((s) => s.city))];

  const existing = await prisma.city.findMany({
    where: { name: { in: cities } },
    select: { name: true },
  });
  const existingNames = new Set(existing.map((c) => c.name));

  return {
    ok: true,
    cities,
    newCities: cities.filter((c) => !existingNames.has(c)),
    stores,
    duplicates,
    skipped,
    citiesWithoutAddress: [],
    hierarchical: false,
  };
}

async function previewHierarchy(
  text: string,
): Promise<StoreImportPreview | StoreImportError> {
  const { stores, citiesWithoutStores } = parseHierarchy(text);

  if (stores.length === 0 && citiesWithoutStores.length === 0) {
    return { ok: false, reason: 'empty' };
  }

  const seen = new Set<string>();
  const unique: typeof stores = [];
  let duplicates = 0;

  for (const store of stores) {
    const key = `${store.city}|${store.address}`.toLowerCase();
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    unique.push(store);
  }

  const cities = [...new Set([...unique.map((s) => s.city), ...citiesWithoutStores])];

  const existing = await prisma.city.findMany({
    where: { name: { in: cities } },
    select: { name: true },
  });
  const existingNames = new Set(existing.map((c) => c.name));

  return {
    ok: true,
    cities,
    newCities: cities.filter((c) => !existingNames.has(c)),
    stores: unique,
    duplicates,
    skipped: 0,
    citiesWithoutAddress: citiesWithoutStores,
    hierarchical: true,
  };
}

export type StoreImportResult = {
  citiesCreated: number;
  storesCreated: number;
  storesUpdated: number;
  placeholdersCreated: number;
  /** нових зв'язків магазин↔кампанія */
  storesLinked: number;
};

/**
 * Застосування імпорту
 *
 * campaignId — прив'язати всі магазини з файлу до кампанії (CampaignStore).
 * null — глобальний імпорт, без прив'язки.
 */
export async function applyStoreImport(
  preview: StoreImportPreview,
  campaignId: string | null,
): Promise<StoreImportResult> {
  const result: StoreImportResult = {
    citiesCreated: 0,
    storesCreated: 0,
    storesUpdated: 0,
    placeholdersCreated: 0,
    storesLinked: 0,
  };

  /** id усіх магазинів із файлу — і нових, і тих, що вже були */
  const storeIds: string[] = [];

  const cityIds = new Map<string, string>();

  for (const [index, name] of preview.cities.entries()) {
    const existing = await prisma.city.findUnique({ where: { name } });

    if (existing) {
      cityIds.set(name, existing.id);
      continue;
    }

    const created = await prisma.city.create({
      data: { name, sortOrder: index },
    });
    cityIds.set(name, created.id);
    result.citiesCreated++;
  }

  for (const store of preview.stores) {
    const cityId = cityIds.get(store.city);
    if (!cityId) continue;

    const existing = await prisma.store.findFirst({
      where: { cityId, name: store.name, address: store.address },
    });

    if (existing) {
      storeIds.push(existing.id);
      if (!existing.isActive) {
        await prisma.store.update({
          where: { id: existing.id },
          data: { isActive: true },
        });
        result.storesUpdated++;
      }
      continue;
    }

    const created = await prisma.store.create({
      data: { cityId, name: store.name, address: store.address },
    });
    storeIds.push(created.id);
    result.storesCreated++;
  }

  for (const cityName of preview.citiesWithoutAddress) {
    const cityId = cityIds.get(cityName);
    if (!cityId) continue;

    const anyStore = await prisma.store.count({ where: { cityId } });
    if (anyStore > 0) continue;

    await prisma.store.create({
      data: {
        cityId,
        name: cityName,
        address: '⚠️ адресу не вказано',
        isActive: false,
      },
    });
    result.placeholdersCreated++;
  }

  // плейсхолдери (міста без адрес) не прив'язуємо — вони неактивні
  if (campaignId) {
    result.storesLinked = await storeRepo.linkToCampaign(campaignId, storeIds);
  }

  return result;
}
