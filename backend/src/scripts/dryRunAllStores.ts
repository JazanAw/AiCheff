// Dry-run ALL-store scraper inspector — DOES NOT touch the live snapshot.
//
// Usage:
//   npx tsx backend/src/scripts/dryRunAllStores.ts [--only=Lidl,Kaufland]
//
// Runs the SAME Phase-1 scrape as the weekly auto-scan ONCE (OfficialSupermarket-
// SourceConnector with the configured WEEKLY_SCAN_EXCLUDED_STORES +
// OFFERS_DISABLED_STORES) against the live public sources and prints one honest
// row per store: fetch outcome, offer counts (current/next, nonfood-Tag), price/
// image coverage, duration, plus all warnings and per-sub-source diagnostics.
// Read-only: no snapshot write, no Phase 2/Ollama, no Supabase. `--only=` limits
// the run to the named chains (shopweise Prüfung) by excluding all others.

import { appConfig } from '../../../src/config/env';
import type { LocationFilter } from '../../../src/types/models';
import { classifyOfferBucket } from '../../../src/utils/offerBucket';
import {
  OfficialSupermarketSourceConnector,
  selectOfficialStores,
} from '../../../src/services/offersIngest/sourceConnectors/officialSupermarketConnector';
import type { RawOfferCandidate } from '../../../src/services/offersIngest/types';
import { parseExcludedStores } from '../weeklyAutoScan';
import { parseDisabledStores } from '../disabledStores';

const locationFilter: LocationFilter = {
  mode: 'none',
  postalCode: '',
  latitude: null,
  longitude: null,
  radiusKm: 40,
};

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function normalize(chain: string): string {
  return chain.trim().toLowerCase();
}

async function main(): Promise<void> {
  const excluded = parseExcludedStores(appConfig.weeklyScanExcludedStores);
  const disabled = parseDisabledStores(appConfig.offersDisabledStores).map(normalize);
  const allStores = selectOfficialStores([]);

  const only = (arg('only') ?? '')
    .split(',')
    .map(normalize)
    .filter((entry) => entry.length > 0);
  // --only wird über die vorhandene Exclusion-Mechanik abgebildet: alle NICHT
  // genannten Chains ausschließen (kein neuer Codepfad im Connector nötig).
  const onlyExclusions =
    only.length > 0
      ? allStores
          .map((store) => normalize(store.storeChain))
          .filter((chain) => !only.includes(chain))
      : [];

  const excludeStoreChains = [...new Set([...excluded, ...disabled, ...onlyExclusions])];
  const activeStores = selectOfficialStores(excludeStoreChains);

  console.log('# Dry-Run: alle Auto-Scan-Stores (Phase 1, read-only)');
  console.log(`Ausgeschlossen (WEEKLY_SCAN_EXCLUDED_STORES): ${excluded.join(', ') || '–'}`);
  console.log(`Deaktiviert (OFFERS_DISABLED_STORES): ${disabled.join(', ') || '–'}`);
  if (only.length > 0) console.log(`--only aktiv: ${only.join(', ')}`);
  console.log(`Aktive Stores (${activeStores.length}): ${activeStores.map((s) => s.storeChain).join(', ')}\n`);

  const durations = new Map<string, number>();
  const outcomes = new Map<string, string>();

  const connector = new OfficialSupermarketSourceConnector({ excludeStoreChains });
  const startedAt = Date.now();
  const offers = await connector.fetchRawOffers(locationFilter, false, {
    onStoreProgress: (event) => {
      if (event.phase === 'start') {
        console.log(`… ${event.index}/${event.total} ${event.storeChain} (${event.parser})`);
        return;
      }
      durations.set(normalize(event.storeChain), event.durationMs ?? 0);
      outcomes.set(normalize(event.storeChain), event.phase);
    },
  });
  const totalMs = Date.now() - startedAt;

  const byStore = new Map<string, RawOfferCandidate[]>();
  for (const offer of offers) {
    const key = normalize(offer.storeChain ?? 'Unbekannt');
    const list = byStore.get(key) ?? [];
    list.push(offer);
    byStore.set(key, list);
  }

  console.log(`\n## Ergebnis pro Store (gesamt ${offers.length} Angebote, ${Math.round(totalMs / 1000)}s)`);
  for (const store of activeStores) {
    const key = normalize(store.storeChain);
    const storeOffers = byStore.get(key) ?? [];
    const outcome = outcomes.get(key) ?? 'unbekannt';
    const durationS = Math.round((durations.get(key) ?? 0) / 1000);
    const current = storeOffers.filter((o) => classifyOfferBucket(o) === 'current').length;
    const upcoming = storeOffers.filter((o) => classifyOfferBucket(o) === 'upcoming').length;
    const nonFoodTagged = storeOffers.filter((o) => (o.tags ?? []).includes('nonfood')).length;
    const withPrice = storeOffers.filter((o) => {
      const price = typeof o.price === 'string' ? Number.parseFloat(o.price) : o.price;
      return typeof price === 'number' && Number.isFinite(price) && price > 0;
    }).length;
    const withImage = storeOffers.filter((o) => Boolean(o.imageUrl)).length;
    console.log(
      `- ${store.storeChain}: ${outcome}, ${storeOffers.length} Angebote ` +
        `(aktuell ${current}, künftig ${upcoming}, nonfood-Tag ${nonFoodTagged}), ` +
        `mit Preis ${withPrice}, mit Bild ${withImage}, Dauer ${durationS}s`,
    );
    for (const offer of storeOffers.slice(0, 3)) {
      const price = typeof offer.price === 'string' ? offer.price : offer.price?.toFixed(2);
      console.log(
        `    z. B. ${offer.name} | ${price ?? '–'} € | gültig ${offer.validityStart ?? '–'} bis ${offer.validityEnd ?? '–'}`,
      );
    }
  }

  const warnings = connector.getLastWarnings();
  console.log(`\n## Warnungen (${warnings.length})`);
  for (const warning of warnings) console.log(`- ${warning}`);

  const diagnostics = connector.getLastSubSourceDiagnostics();
  console.log(`\n## Subquellen-Diagnosen (${diagnostics.length})`);
  for (const diag of diagnostics) {
    const error = 'errorCode' in diag && diag.errorCode ? ` errorCode=${diag.errorCode}` : '';
    console.log(
      `- ${diag.storeChain} ${diag.sourceId}: ${diag.status}${error} ` +
        `raw=${diag.rawCount ?? '–'} result=${diag.resultCount ?? '–'}${diag.note ? ` | ${diag.note}` : ''}`,
    );
  }

  // Nicht gescannte Stores ehrlich ausweisen, damit der Dry-Run nie so aussieht,
  // als wären sie geprüft worden.
  const skipped = allStores.filter(
    (store) => !activeStores.some((active) => active.storeChain === store.storeChain),
  );
  if (skipped.length > 0) {
    console.log('\n## Nicht gescannt');
    for (const store of skipped) {
      const key = normalize(store.storeChain);
      const reason = disabled.includes(key)
        ? 'per Policy deaktiviert (OFFERS_DISABLED_STORES)'
        : excluded.includes(key)
          ? 'ausgeschlossen (WEEKLY_SCAN_EXCLUDED_STORES) — Browser-Import'
          : '--only-Filter';
      console.log(`- ${store.storeChain}: ${reason}`);
    }
  }
}

void main();
