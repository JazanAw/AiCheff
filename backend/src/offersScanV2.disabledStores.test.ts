import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { parseExcludedStores } from './weeklyAutoScan';
import { parseDisabledStores, purgeDisabledFromBuckets } from './disabledStores';
import { selectOfficialStores } from '../../src/services/offersIngest/sourceConnectors/officialSupermarketConnector';

// Policy: Der Disabled-Default ist LEER — Lidl importiert wieder automatisch
// über die serverseitig gelisteten Aktionsprospekt-Identifier + die öffentliche
// v4/flyer-Viewer-JSON (structured_only, nie full; preislose Frische-Hotspots
// bleiben pending). EDEKA (national_only), ALDI SÜD und ALDI NORD bleiben aktiv.
// Ein Betreiber kann jeden Shop weiterhin explizit per OFFERS_DISABLED_STORES
// deaktivieren; dann greifen Scrape-Ausschluss + Snapshot-Purge wie zuvor.
// Diese Tests sichern die genaue Helper-Komposition ab, die der Angebots-Scan
// verwendet, ohne den IO-lastigen Server zu starten.

function offer(overrides: Partial<Offer> & { id: string; storeChain: string }): Offer {
  return {
    name: overrides.id,
    normalizedName: overrides.id,
    category: 'Sonstiges',
    price: 1.99,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: '2026-06-01T00:00:00.000Z',
    validityEnd: '2026-06-07T23:59:59.999Z',
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  } as Offer;
}

describe('Angebots-Scan — Disabled-Default leer: Lidl wieder im Auto-Scan', () => {
  const excluded = parseExcludedStores('REWE');
  const disabled = parseDisabledStores(undefined); // Policy-Default (leer)

  it('die Scrape-Store-Auswahl fetcht Lidl wieder (zusammen mit EDEKA + ALDI SÜD/NORD)', () => {
    // Genau die Liste, die runScanV2Phase1/Weekly an excludeStoreChains übergibt.
    const selected = selectOfficialStores([...excluded, ...disabled]);
    const chains = selected.map((s) => s.storeChain);

    expect(chains).toContain('Lidl');
    expect(chains).toContain('EDEKA');
    expect(chains).toContain('ALDI SUED');
    expect(chains).toContain('ALDI NORD');
    // REWE bleibt manueller Import (excluded), wird also weiterhin nicht gefetcht.
    expect(chains).not.toContain('REWE');
    for (const keep of ['Kaufland', 'PENNY', 'Netto', 'NORMA', 'HIT']) {
      expect(chains).toContain(keep);
    }
  });

  it('ein expliziter Betreiber-Override (CSV) nimmt Lidl weiterhin aus der Scrape-Auswahl', () => {
    const overrideDisabled = parseDisabledStores('Lidl');
    const selected = selectOfficialStores([...excluded, ...overrideDisabled]);
    const chains = selected.map((s) => s.storeChain);
    expect(chains).not.toContain('Lidl');
    expect(chains).toContain('EDEKA');
  });

  it('das Sicherheitsnetz behält Lidl mit dem leeren Default, verwirft es nur bei explizitem Override', () => {
    const scraped = [
      offer({ id: 'kaufland_1', storeChain: 'Kaufland' }),
      offer({ id: 'aldi_sued_1', storeChain: 'ALDI SÜD' }),
      offer({ id: 'lidl_1', storeChain: 'Lidl' }),
      offer({ id: 'penny_1', storeChain: 'PENNY' }),
    ];
    // Default (leer): nichts wird verworfen — Lidl bleibt im Scrape-Ergebnis.
    const freshDefault = purgeDisabledFromBuckets(
      { offers: scraped, nextWeekOffers: [], filteredOffers: [] },
      disabled,
    ).offers;
    expect(freshDefault.map((o) => o.id)).toEqual([
      'kaufland_1',
      'aldi_sued_1',
      'lidl_1',
      'penny_1',
    ]);

    // Expliziter Override: dasselbe Prädikat wie im Server verwirft Lidl wieder.
    const freshOverride = purgeDisabledFromBuckets(
      { offers: scraped, nextWeekOffers: [], filteredOffers: [] },
      parseDisabledStores('Lidl'),
    ).offers;
    expect(freshOverride.map((o) => o.id)).toEqual(['kaufland_1', 'aldi_sued_1', 'penny_1']);
  });

  it('Snapshot-Reconciliation ist mit dem leeren Default ein No-Op, purged bei Override nur Lidl', () => {
    const snapshot = {
      offers: [
        offer({ id: 'rewe_live', storeChain: 'REWE' }),
        offer({ id: 'aldi_nord_live', storeChain: 'ALDI NORD' }),
        offer({ id: 'lidl_live', storeChain: 'Lidl' }),
        offer({ id: 'edeka_live', storeChain: 'EDEKA' }),
      ],
      nextWeekOffers: [
        offer({ id: 'aldi_sued_next', storeChain: 'ALDI SUED' }),
        offer({ id: 'lidl_next', storeChain: 'Lidl' }),
      ],
      filteredOffers: [
        offer({ id: 'lidl_filtered', storeChain: 'Lidl' }),
        offer({ id: 'kaufland_filtered', storeChain: 'Kaufland' }),
      ],
    };
    // Default: nichts entfernt — Lidl bleibt in allen Buckets.
    const noop = purgeDisabledFromBuckets(snapshot, disabled);
    expect(noop.removedCount).toBe(0);
    expect(noop.offers.map((o) => o.id)).toContain('lidl_live');

    // Override: nur Lidl fliegt aus allen Buckets, idempotent.
    const purged = purgeDisabledFromBuckets(snapshot, parseDisabledStores('Lidl'));
    expect(purged.offers.map((o) => o.id)).toEqual(['rewe_live', 'aldi_nord_live', 'edeka_live']);
    expect(purged.nextWeekOffers.map((o) => o.id)).toEqual(['aldi_sued_next']);
    expect(purged.filteredOffers.map((o) => o.id)).toEqual(['kaufland_filtered']);
    expect(purged.removedCount).toBe(3);
    expect(purged.removedByStore.lidl).toBe(3);
    const again = purgeDisabledFromBuckets(purged, parseDisabledStores('Lidl'));
    expect(again.removedCount).toBe(0);
  });

  it('andere Shops (REWE, PENNY, Kaufland, Netto, NORMA, nahkauf) bleiben unverändert', () => {
    const others = [
      offer({ id: 'rewe', storeChain: 'REWE' }),
      offer({ id: 'penny', storeChain: 'PENNY' }),
      offer({ id: 'kaufland', storeChain: 'Kaufland' }),
      offer({ id: 'netto', storeChain: 'Netto' }),
      offer({ id: 'norma', storeChain: 'NORMA' }),
      offer({ id: 'nahkauf', storeChain: 'nahkauf' }),
    ];
    const purged = purgeDisabledFromBuckets(
      { offers: others, nextWeekOffers: [], filteredOffers: [] },
      disabled,
    );
    expect(purged.removedCount).toBe(0);
    expect(purged.offers.map((o) => o.id)).toEqual(others.map((o) => o.id));
  });
});
