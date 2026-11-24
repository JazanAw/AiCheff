import { beforeEach, describe, expect, it } from 'vitest';
import {
  OfficialSupermarketSourceConnector,
  officialSupermarketTestApi,
  type OfficialStoreConfig,
} from './officialSupermarketConnector';
import { buildSubSourceDiagnostic, subSourceErrorCode } from '../subSourceDiagnostics';
import type { RawOfferCandidate, StoreFetchProgressEvent } from '../types';
import type { LocationFilter } from '../../../types/models';

// Robustheit von Phase 1: ein hängender/langsamer Shop darf den Scan nie
// einfrieren. Der Test-Seam (fetchStoreOffersImpl) ersetzt den echten Per-Store-
// Fetcher, damit Schleife/Timeout/Abort ohne Netzwerk deterministisch laufen.

const LOCATION: LocationFilter = {
  mode: 'none',
  postalCode: '',
  latitude: null,
  longitude: null,
  radiusKm: 40,
};

// Nur Lidl (idx 0) + Kaufland (idx 8) behalten → deterministische Reihenfolge
// [Lidl, Kaufland]. So kann ein hängender erster Store (Lidl) beweisen, dass der
// zweite (Kaufland) trotzdem läuft.
const EXCLUDE_ALL_BUT_LIDL_KAUFLAND = [
  'ALDI SUED',
  'ALDI NORD',
  'REWE',
  'nahkauf',
  'EDEKA',
  'PENNY',
  'Netto',
  'HIT',
  'NORMA',
];

function offerFor(store: OfficialStoreConfig): RawOfferCandidate {
  return {
    id: `${store.storeChain}-1`,
    name: 'Butter',
    price: 1.99,
    storeChain: store.storeChain,
  };
}

const neverResolves = (): Promise<RawOfferCandidate[]> => new Promise(() => {});

beforeEach(() => {
  officialSupermarketTestApi.resetCache();
});

describe('OfficialSupermarketSourceConnector — Per-Store-Timeout & Robustheit', () => {
  it('a) ein hängender Store timeoutet, erzeugt fetch_failed (store_fetch_timeout) + Warning, der nächste Store läuft', async () => {
    const connector = new OfficialSupermarketSourceConnector({
      excludeStoreChains: EXCLUDE_ALL_BUT_LIDL_KAUFLAND,
      storeFetchTimeoutMs: 30,
      fetchStoreOffersImpl: async (store) =>
        store.storeChain === 'Lidl' ? neverResolves() : [offerFor(store)],
    });

    const offers = await connector.fetchRawOffers(LOCATION, false);

    // Der nächste Store (Kaufland) lieferte trotz des Lidl-Hängers Angebote.
    expect(offers.map((offer) => offer.storeChain)).toEqual(['Kaufland']);

    const diagnostics = connector.getLastSubSourceDiagnostics();
    const lidlDiag = diagnostics.find((d) => d.storeChain === 'Lidl');
    expect(lidlDiag?.status).toBe('fetch_failed');
    expect(subSourceErrorCode(lidlDiag!)).toBe('store_fetch_timeout');

    expect(connector.getLastWarnings().some((w) => w.startsWith('Lidl:'))).toBe(true);
  });

  it('b) der Per-Store-Fortschritt meldet start und done (success) je Store', async () => {
    const events: StoreFetchProgressEvent[] = [];
    const connector = new OfficialSupermarketSourceConnector({
      excludeStoreChains: EXCLUDE_ALL_BUT_LIDL_KAUFLAND,
      fetchStoreOffersImpl: async (store) => [offerFor(store)],
    });

    await connector.fetchRawOffers(LOCATION, false, {
      onStoreProgress: (event) => events.push(event),
    });

    const starts = events.filter((e) => e.phase === 'start').map((e) => e.storeChain);
    const dones = events.filter((e) => e.phase === 'success').map((e) => e.storeChain);
    expect(starts).toEqual(['Lidl', 'Kaufland']);
    expect(dones).toEqual(['Lidl', 'Kaufland']);

    const firstStart = events.find((e) => e.phase === 'start');
    expect(firstStart).toMatchObject({ storeChain: 'Lidl', index: 1, total: 2 });
    const lidlDone = events.find((e) => e.phase === 'success' && e.storeChain === 'Lidl');
    expect(lidlDone?.offerCount).toBe(1);
    expect(typeof lidlDone?.durationMs).toBe('number');
  });

  it('c) ein Abbruch (Cancel/Pause) stoppt sauber und gilt NICHT als Store-Timeout', async () => {
    const controller = new AbortController();
    const events: StoreFetchProgressEvent[] = [];
    const connector = new OfficialSupermarketSourceConnector({
      excludeStoreChains: EXCLUDE_ALL_BUT_LIDL_KAUFLAND,
      storeFetchTimeoutMs: 1000,
      fetchStoreOffersImpl: async (store) => {
        if (store.storeChain === 'Lidl') {
          // Während des ersten Stores abbrechen und hängen lassen — der Abort muss
          // das Rennen gewinnen, nicht der Timeout.
          controller.abort();
          return neverResolves();
        }
        return [offerFor(store)];
      },
    });

    await connector.fetchRawOffers(LOCATION, false, {
      signal: controller.signal,
      onStoreProgress: (event) => events.push(event),
    });

    // Abbruch ist KEIN Store-Timeout: weder Timeout-Warning noch fetch_failed.
    expect(connector.getLastWarnings()).toHaveLength(0);
    const diagnostics = connector.getLastSubSourceDiagnostics();
    expect(diagnostics.some((d) => subSourceErrorCode(d) === 'store_fetch_timeout')).toBe(false);
    expect(events.some((e) => e.phase === 'timeout')).toBe(false);

    // Schleife bricht sauber ab → der nächste Store (Kaufland) startet nicht mehr.
    expect(events.some((e) => e.phase === 'start' && e.storeChain === 'Kaufland')).toBe(false);
  });

  it('d) normale Stores laufen unverändert (kein Timeout-Diagnostic, keine Warnings)', async () => {
    const connector = new OfficialSupermarketSourceConnector({
      excludeStoreChains: EXCLUDE_ALL_BUT_LIDL_KAUFLAND,
      fetchStoreOffersImpl: async (store) => [offerFor(store)],
    });

    const offers = await connector.fetchRawOffers(LOCATION, false);

    expect(offers.map((offer) => offer.storeChain)).toEqual(['Lidl', 'Kaufland']);
    expect(connector.getLastWarnings()).toHaveLength(0);
    expect(
      connector
        .getLastSubSourceDiagnostics()
        .some((d) => subSourceErrorCode(d) === 'store_fetch_timeout'),
    ).toBe(false);
  });

  it('e) spaete Diagnostics eines getimeouteten Stores mutieren den Lauf nicht nachtraeglich', async () => {
    const connector = new OfficialSupermarketSourceConnector({
      excludeStoreChains: EXCLUDE_ALL_BUT_LIDL_KAUFLAND,
      storeFetchTimeoutMs: 10,
      fetchStoreOffersImpl: async (store, warnings, diagnostics) => {
        if (store.storeChain !== 'Lidl') return [offerFor(store)];
        await new Promise((resolve) => setTimeout(resolve, 50));
        warnings.push('Lidl: late success warning must stay local');
        diagnostics.push(
          buildSubSourceDiagnostic({
            storeChain: 'Lidl',
            sourceId: 'lidl:late_success',
            status: 'success',
            rawCount: 140,
            resultCount: 140,
          }),
        );
        return [offerFor(store)];
      },
    });

    const offers = await connector.fetchRawOffers(LOCATION, false);
    await new Promise((resolve) => setTimeout(resolve, 70));

    expect(offers.map((offer) => offer.storeChain)).toEqual(['Kaufland']);
    expect(connector.getLastWarnings().some((warning) => warning.includes('late success'))).toBe(false);
    const diagnostics = connector.getLastSubSourceDiagnostics();
    expect(diagnostics.some((diagnostic) => diagnostic.sourceId === 'lidl:late_success')).toBe(false);
    expect(diagnostics.filter((diagnostic) => diagnostic.storeChain === 'Lidl')).toHaveLength(1);
    expect(subSourceErrorCode(diagnostics.find((diagnostic) => diagnostic.storeChain === 'Lidl')!)).toBe(
      'store_fetch_timeout',
    );
  });
});
