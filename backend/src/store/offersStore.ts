import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Offer } from '../../../src/types/models';
import { withArticleIds } from '../../../src/utils/articleIdentity';

export interface OfferScopeFlags {
  national: boolean;
  local: boolean;
}

export type OfferScopeMap = Record<string, OfferScopeFlags>;

export interface OffersSnapshot {
  offers: Offer[];
  nextWeekOffers: Offer[];
  filteredOffers: Offer[];
  offerScopes: OfferScopeMap;
  updatedAt: string | null;
  warnings: string[];
}

const defaultSnapshot: OffersSnapshot = {
  offers: [],
  nextWeekOffers: [],
  filteredOffers: [],
  offerScopes: {},
  updatedAt: null,
  warnings: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeOfferScopes(rawValue: unknown): OfferScopeMap {
  if (!isRecord(rawValue)) {
    return {};
  }

  const normalized: OfferScopeMap = {};
  for (const [offerId, rawScope] of Object.entries(rawValue)) {
    const id = offerId.trim();
    if (!id || !isRecord(rawScope)) {
      continue;
    }

    const national = rawScope.national === true;
    const local = rawScope.local === true;
    if (!national && !local) {
      continue;
    }

    normalized[id] = { national, local };
  }

  return normalized;
}

function resolveDataFile(): string {
  const customPath = process.env.OFFERS_DATA_FILE?.trim();
  if (customPath) {
    return path.resolve(process.cwd(), customPath);
  }

  return path.resolve(process.cwd(), 'backend/data/offers.json');
}

const offersDataFile = resolveDataFile();

/** Absoluter Pfad der Snapshot-Datei, die dieses Backend liest und schreibt.
 *  Exportiert fuer den Snapshot-Download im Admin — so haengt der Endpunkt am
 *  GLEICHEN Pfad inkl. `OFFERS_DATA_FILE`-Override, statt ihn nachzubauen. */
export function getOffersDataFile(): string {
  return offersDataFile;
}

async function ensureDataDirectory(): Promise<void> {
  const directory = path.dirname(offersDataFile);
  await fs.mkdir(directory, { recursive: true });
}

export async function loadOffersSnapshot(): Promise<OffersSnapshot> {
  await ensureDataDirectory();

  try {
    const raw = await fs.readFile(offersDataFile, 'utf8');
    const parsed = JSON.parse(raw) as OffersSnapshot;

    if (!Array.isArray(parsed.offers)) {
      return defaultSnapshot;
    }

    return {
      offers: withArticleIds(parsed.offers),
      nextWeekOffers: Array.isArray(parsed.nextWeekOffers)
        ? withArticleIds(parsed.nextWeekOffers)
        : [],
      filteredOffers: Array.isArray(parsed.filteredOffers)
        ? withArticleIds(parsed.filteredOffers)
        : [],
      offerScopes: normalizeOfferScopes(
        isRecord(parsed) ? parsed.offerScopes : undefined,
      ),
      updatedAt: parsed.updatedAt ?? null,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    };
  } catch {
    return defaultSnapshot;
  }
}

export async function saveOffersSnapshot(snapshot: OffersSnapshot): Promise<void> {
  await ensureDataDirectory();
  // Mutate the in-memory snapshot as well as the serialized copy: API callers
  // immediately see articleId after a scan/import without waiting for restart.
  snapshot.offers = withArticleIds(snapshot.offers);
  snapshot.nextWeekOffers = withArticleIds(snapshot.nextWeekOffers);
  snapshot.filteredOffers = withArticleIds(snapshot.filteredOffers);
  await fs.writeFile(offersDataFile, JSON.stringify(snapshot, null, 2), 'utf8');
}
