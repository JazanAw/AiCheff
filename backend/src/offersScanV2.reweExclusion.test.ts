import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { isStoreExcluded, parseExcludedStores, partitionExcludedFromBuckets } from './weeklyAutoScan';
import { mergeScopedRescan } from './offerAiRescanScope';
import { splitOffersByLiveWindow } from './snapshotLiveWindow';
import { evaluateSnapshotSafety } from './snapshotSafetyGate';

// Item 1: Angebots-Scan 2.0 darf REWE/nahkauf NICHT mehr per Web-Scan prüfen und
// ihre manuell importierten Angebote nicht überschreiben. Diese Tests sichern die
// genaue Helper-Komposition ab, die runScanV2Phase1 verwendet (Scrape ohne REWE +
// retained-Merge), ohne den IO-lastigen Server starten zu müssen.

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

describe('Angebots-Scan 2.0 — REWE bleibt manueller Import (Item 1)', () => {
  const excluded = parseExcludedStores('REWE,nahkauf');

  it('schließt REWE/nahkauf aus dem frischen Scrape aus (nie Pflicht-Web-Quelle)', () => {
    const scraped = [
      offer({ id: 'lidl_1', storeChain: 'Lidl' }),
      offer({ id: 'rewe_web_1', storeChain: 'REWE' }), // sollte gar nicht erst auftauchen
      offer({ id: 'nahkauf_web_1', storeChain: 'nahkauf' }),
    ];
    const fresh = scraped.filter((o) => !isStoreExcluded(o.storeChain, excluded));
    expect(fresh.map((o) => o.id)).toEqual(['lidl_1']);
  });

  it('behält die manuell importierten REWE-Angebote und ersetzt nur die anderen Stores', () => {
    // Aktueller Snapshot: REWE per Browser-Import (live) + ein alter Lidl-Stand.
    const snapshot = {
      current: [
        offer({ id: 'rewe_manual_1', storeChain: 'REWE', tags: ['rewe', 'browser-import'] }),
        offer({ id: 'lidl_old', storeChain: 'Lidl' }),
      ],
      next: [] as Offer[],
      filtered: [] as Offer[],
    };
    // Frischer Scrape (REWE ausgeschlossen) liefert nur neue Lidl-Angebote.
    const freshLive = [offer({ id: 'lidl_new', storeChain: 'Lidl' })];

    const { retained } = partitionExcludedFromBuckets(snapshot, excluded);
    const merged = mergeScopedRescan(retained, {
      current: freshLive,
      next: [],
      filtered: [],
    });

    const liveIds = merged.current.map((o) => o.id).sort();
    // REWE-Manuell bleibt erhalten, Lidl wird durch den frischen Stand ersetzt.
    expect(liveIds).toContain('rewe_manual_1');
    expect(liveIds).toContain('lidl_new');
    expect(liveIds).not.toContain('lidl_old');
  });

  // Sonntag, 2026-06-07: genau der „böse Scan"-Zeitpunkt, an dem REWE 65 → 0 fiel.
  const sunday = new Date('2026-06-07T04:12:49.000Z');

  it('Phase-2-Finalize-Komposition: preserved REWE bleibt live trotz „abgelaufener" Daten am Sonntag', () => {
    // Food-Universum wie in runScanV2Phase2: REWE (manueller Import, KW endet
    // heute) + frische Lidl-Angebote. Der ALTE Wochen-Split hätte REWE am Sonntag
    // nach 'other' geworfen und damit verloren.
    const foodUniverse = [
      offer({ id: 'rewe_a', storeChain: 'REWE', tags: ['rewe', 'browser-import'] }),
      offer({ id: 'rewe_b', storeChain: 'REWE', tags: ['rewe', 'browser-import'] }),
      offer({ id: 'lidl_today', storeChain: 'Lidl', validityStart: '2026-06-03', validityEnd: '2026-06-09' }),
    ];
    const liveSplit = splitOffersByLiveWindow(foodUniverse, {
      now: sunday,
      weekBucketOf: () => 'other',
      isPreserved: (o) => isStoreExcluded(o.storeChain, excluded),
    });
    const liveIds = liveSplit.current.map((o) => o.id).sort();
    expect(liveIds).toContain('rewe_a');
    expect(liveIds).toContain('rewe_b');
    expect(liveIds).toContain('lidl_today');
    expect(liveSplit.dropped).toHaveLength(0);
  });

  it('Safety-Gate verhindert den Commit, wenn REWE im Finalize verloren ginge', () => {
    const previous = {
      offers: [
        offer({ id: 'rewe_a', storeChain: 'REWE' }),
        offer({ id: 'lidl_old', storeChain: 'Lidl' }),
      ],
      nextWeekOffers: [] as Offer[],
      filteredOffers: [] as Offer[],
    };
    // Kandidat OHNE REWE-Preserve (der Bug) → Gate muss blocken.
    const candidate = {
      offers: [offer({ id: 'lidl_new', storeChain: 'Lidl' })],
      nextWeekOffers: [] as Offer[],
      filteredOffers: [] as Offer[],
    };
    const result = evaluateSnapshotSafety({ previous, candidate, now: sunday });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('excludedStoreLost');
  });

  it('Resume-Komposition: preservedExcluded aus dem Checkpoint behält REWE über mergeScopedRescan', () => {
    // resume.preservedExcluded (aus dem persistierten Checkpoint) + frisch
    // kategorisierte Nicht-REWE-Angebote → REWE bleibt erhalten.
    const resumePreserved = {
      current: [offer({ id: 'rewe_manual', storeChain: 'REWE', tags: ['browser-import'] })],
      next: [] as Offer[],
      filtered: [] as Offer[],
    };
    const freshSplit = splitOffersByLiveWindow(
      [offer({ id: 'lidl_today', storeChain: 'Lidl', validityStart: '2026-06-03', validityEnd: '2026-06-09' })],
      { now: sunday, weekBucketOf: () => 'other' },
    );
    const merged = mergeScopedRescan(resumePreserved, {
      current: freshSplit.current,
      next: freshSplit.next,
      filtered: [],
    });
    expect(merged.current.map((o) => o.id)).toContain('rewe_manual');
    expect(merged.current.map((o) => o.id)).toContain('lidl_today');
  });
});
