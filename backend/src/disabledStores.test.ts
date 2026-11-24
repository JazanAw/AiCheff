import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISABLED_STORES,
  isStoreDisabled,
  parseDisabledStores,
  purgeDisabledFromBuckets,
} from './disabledStores';

describe('disabledStores — Default leer (Lidl, EDEKA + ALDI SÜD/NORD wieder aktiv)', () => {
  it('die Default-Policy deaktiviert KEINEN Shop mehr (auch Lidl nicht)', () => {
    expect(parseDisabledStores(undefined)).toEqual([]);
    expect(parseDisabledStores('')).toEqual([]);
    expect(DEFAULT_DISABLED_STORES).toEqual([]);
    // Lidl ist NICHT mehr per Policy deaktiviert — strukturierter Auto-Import
    // über die serverseitig gelisteten Aktionsprospekt-Identifier + die
    // öffentliche v4/flyer-Viewer-JSON (structured_only, nie full).
    expect(parseDisabledStores(undefined)).not.toContain('lidl');
    expect(parseDisabledStores(undefined)).not.toContain('edeka');
    expect(parseDisabledStores(undefined)).not.toContain('aldi sued');
    expect(parseDisabledStores(undefined)).not.toContain('aldi nord');
  });

  it('eine eigene CSV kann Lidl/ALDI SÜD weiterhin explizit deaktivieren (Override)', () => {
    // Der Default aktiviert alle Shops, aber ein Betreiber darf per ENV wieder
    // abschalten — die Override-CSV wird respektiert + Umlaut-dedupliziert.
    expect(parseDisabledStores('ALDI SUED, aldi süd ,Lidl')).toEqual(['aldi sued', 'lidl']);
  });

  it('erkennt einen explizit deaktivierten Store stabil, auch in unterschiedlicher Schreibweise', () => {
    // Generischer Matcher: eine eigene CSV kann jeden Store deaktivieren; das
    // Matching ist umlaut-/case-/whitespace-tolerant (hier am Beispiel EDEKA,
    // das per Default NICHT deaktiviert ist).
    const disabled = parseDisabledStores('EDEKA');
    expect(isStoreDisabled('EDEKA', disabled)).toBe(true);
    expect(isStoreDisabled('Edeka', disabled)).toBe(true);
    expect(isStoreDisabled('edeka', disabled)).toBe(true);
    expect(isStoreDisabled('  EDEKA  ', disabled)).toBe(true);
    // Aus eigener CSV dedupliziert über Schreibweisen hinweg.
    expect(parseDisabledStores('EDEKA, edeka , Edeka')).toEqual(['edeka']);
  });

  it('isStoreDisabled matcht mit dem leeren Default keinen einzigen Shop', () => {
    const disabled = parseDisabledStores(undefined);
    for (const chain of [
      'ALDI SÜD',
      'ALDI SUED',
      'aldi süd',
      'ALDI NORD',
      'EDEKA',
      'Edeka',
      'Lidl',
      'REWE',
      'Kaufland',
      'nahkauf',
    ]) {
      expect(isStoreDisabled(chain, disabled)).toBe(false);
    }
    expect(isStoreDisabled(undefined, disabled)).toBe(false);
  });

  it('purgeDisabledFromBuckets ist mit dem leeren Default ein No-Op (auch für Lidl)', () => {
    const disabled = parseDisabledStores(undefined);
    const buckets = {
      offers: [
        { storeChain: 'ALDI SÜD', name: 'Hähnchen' },
        { storeChain: 'REWE', name: 'Butter' },
        { storeChain: 'Lidl', name: 'Apfel' },
        { storeChain: 'EDEKA', name: 'Joghurt' },
      ],
      nextWeekOffers: [
        { storeChain: 'ALDI NORD', name: 'Milch' },
        { storeChain: 'Lidl', name: 'Rotwein' },
      ],
      filteredOffers: [{ storeChain: 'Lidl', name: 'Bohrmaschine' }],
    };
    const result = purgeDisabledFromBuckets(buckets, disabled);
    expect(result.removedCount).toBe(0);
    expect(result.offers).toEqual(buckets.offers);
    expect(result.nextWeekOffers).toEqual(buckets.nextWeekOffers);
    expect(result.filteredOffers).toEqual(buckets.filteredOffers);
  });

  it('purgeDisabledFromBuckets entfernt generisch mehrere explizit deaktivierte Stores', () => {
    // Der Purge-Mechanismus ist generisch: eine eigene CSV kann Lidl UND EDEKA
    // deaktivieren — dann werden beide aus allen Buckets entfernt.
    const disabled = parseDisabledStores('Lidl, EDEKA');
    const result = purgeDisabledFromBuckets(
      {
        offers: [
          { storeChain: 'ALDI SÜD', name: 'Hähnchen' },
          { storeChain: 'REWE', name: 'Butter' },
          { storeChain: 'Lidl', name: 'Apfel' },
          { storeChain: 'EDEKA', name: 'Joghurt' },
        ],
        nextWeekOffers: [{ storeChain: 'Edeka', name: 'Käse' }],
        filteredOffers: [{ storeChain: 'edeka', name: 'Bratpfanne' }],
      },
      disabled,
    );

    expect(result.offers.map((o) => o.storeChain)).toEqual(['ALDI SÜD', 'REWE']);
    expect(result.nextWeekOffers).toHaveLength(0);
    expect(result.filteredOffers).toHaveLength(0);
    expect(result.removedCount).toBe(4);
    expect(result.removedByStore).toEqual({ lidl: 1, edeka: 3 });
  });

  it('erhält manuell importierte Angebote eines explizit deaktivierten Stores (isPreserved), purged den Rest', () => {
    const disabled = parseDisabledStores('Lidl'); // expliziter Betreiber-Override
    const manual = (storeChain: string, name: string) => ({
      storeChain,
      name,
      tags: ['manual-import'],
    });
    const scraped = (storeChain: string, name: string) => ({ storeChain, name, tags: [] as string[] });
    const result = purgeDisabledFromBuckets(
      {
        offers: [
          manual('Lidl', 'Manuelle Milch'),
          scraped('Lidl', 'Auto-Scrape-Rest'),
          scraped('REWE', 'Butter'),
        ],
        nextWeekOffers: [manual('Lidl', 'Manueller Keks')],
        filteredOffers: [manual('Lidl', 'Manuelle Bratpfanne')],
      },
      disabled,
      { isPreserved: (offer) => (offer.tags ?? []).includes('manual-import') },
    );

    // Manuelle Angebote eines deaktivierten Stores bleiben in allen Buckets …
    expect(result.offers.map((o) => o.name)).toEqual(['Manuelle Milch', 'Butter']);
    expect(result.nextWeekOffers.map((o) => o.name)).toEqual(['Manueller Keks']);
    expect(result.filteredOffers.map((o) => o.name)).toEqual(['Manuelle Bratpfanne']);
    // … aber der Auto-Scrape-Rest desselben deaktivierten Stores wird entfernt.
    expect(result.removedCount).toBe(1);
    expect(result.removedByStore).toEqual({ lidl: 1 });
  });

  it('ist idempotent: ein Snapshot ohne deaktivierte Shops bleibt unverändert', () => {
    const disabled = parseDisabledStores('Netto');
    const buckets = {
      offers: [{ storeChain: 'REWE', name: 'Butter' }],
      nextWeekOffers: [{ storeChain: 'Lidl', name: 'Brot' }],
      filteredOffers: [{ storeChain: 'NORMA', name: 'Seife' }],
    };
    const result = purgeDisabledFromBuckets(buckets, disabled);
    expect(result.removedCount).toBe(0);
    expect(result.offers).toEqual(buckets.offers);
    expect(result.nextWeekOffers).toEqual(buckets.nextWeekOffers);
    expect(result.filteredOffers).toEqual(buckets.filteredOffers);
  });
});
