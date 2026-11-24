import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  assessReweImportQuality,
  isReweBrowserScopeOffer,
  normalizeReweBrowserImportRequest,
  replaceReweScopeOffers,
  resolveHttpUrl,
  reweNonProductNameReason,
} from './reweBrowserImport';
import { filterOffersStrictFood } from './offersStrictFoodFilter';

const at = new Date('2026-06-13T10:00:00Z');

function reweOffer(id: string, name: string): Offer {
  return {
    id,
    name,
    normalizedName: name.toLowerCase(),
    storeChain: 'REWE',
    category: 'Sonstiges',
    price: 1.99,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: at.toISOString(),
    validityEnd: at.toISOString(),
    sourceUrl: 'https://www.rewe.de/x',
    tags: ['rewe', 'browser-import'],
    createdAt: at.toISOString(),
  } as Offer;
}
function otherOffer(id: string, store: string): Offer {
  return { ...reweOffer(id, `${store} Produkt`), storeChain: store, tags: [store.toLowerCase()] } as Offer;
}

describe('P1 — atomare REWE-Scope-Ersetzung', () => {
  it('ersetzt den gesamten REWE-Browser-Scope, lässt andere Shops unberührt', () => {
    const previous = {
      current: [reweOffer('rewe_browser_old1', 'Alt REWE 1'), otherOffer('penny_1', 'PENNY')],
      nextWeek: [reweOffer('rewe_browser_old2', 'Alt REWE next')],
      filtered: [reweOffer('rewe_browser_old3', 'Tiefkühl'), otherOffer('kauf_1', 'KAUFLAND')],
    };
    const incoming = {
      current: [reweOffer('rewe_browser_new1', 'Neu REWE 1')],
      nextWeek: [],
      filtered: [reweOffer('rewe_browser_new2', 'Neu REWE filtered')],
    };
    const result = replaceReweScopeOffers(previous, incoming);

    expect(result.current.map((o) => o.name)).toEqual(['PENNY Produkt', 'Neu REWE 1']);
    expect(result.nextWeek.map((o) => o.name)).toEqual([]);
    expect(result.filtered.map((o) => o.name)).toEqual(['KAUFLAND Produkt', 'Neu REWE filtered']);
    expect(result.replacedPreviousCount).toEqual({ current: 1, nextWeek: 1, filtered: 1, total: 3 });
    // andere Shops bleiben erhalten
    expect(result.current.some((o) => o.storeChain === 'PENNY')).toBe(true);
    expect(result.filtered.some((o) => o.storeChain === 'KAUFLAND')).toBe(true);
  });

  it('ist rein (mutiert die vorherigen Arrays nicht) — abgelehnter Import erhält den Scope', () => {
    const previous = {
      current: [reweOffer('rewe_browser_old1', 'Alt')],
      nextWeek: [],
      filtered: [],
    };
    const snapshotBefore = previous.current.map((o) => o.id);
    replaceReweScopeOffers(previous, { current: [reweOffer('rewe_browser_new', 'Neu')], nextWeek: [], filtered: [] });
    // Original unverändert: ein abgelehnter Import (der replace nie aufruft) lässt
    // den Snapshot exakt so.
    expect(previous.current.map((o) => o.id)).toEqual(snapshotBefore);
  });

  it('wiederholter identischer Import bleibt idempotent (keine Alt-Dubletten)', () => {
    const incoming = {
      current: [reweOffer('rewe_browser_a', 'Bananen'), reweOffer('rewe_browser_b', 'Cola')],
      nextWeek: [],
      filtered: [],
    };
    const first = replaceReweScopeOffers({ current: [], nextWeek: [], filtered: [] }, incoming);
    const second = replaceReweScopeOffers(
      { current: first.current, nextWeek: first.nextWeek, filtered: first.filtered },
      incoming,
    );
    expect(second.current.map((o) => o.id)).toEqual(['rewe_browser_a', 'rewe_browser_b']);
    expect(second.replacedPreviousCount.current).toBe(2);
  });

  it('isReweBrowserScopeOffer erkennt nur REWE-Manual-Import-Angebote', () => {
    expect(isReweBrowserScopeOffer(reweOffer('rewe_browser_x', 'X'))).toBe(true);
    expect(isReweBrowserScopeOffer({ storeChain: 'REWE', id: 'rewe_browser_y', tags: [] } as Offer)).toBe(true);
    expect(isReweBrowserScopeOffer(otherOffer('penny_1', 'PENNY'))).toBe(false);
    expect(isReweBrowserScopeOffer({ storeChain: 'REWE', id: 'other', tags: ['rewe'] } as Offer)).toBe(false);
  });
});

describe('P3 — generische Nicht-Produkt-Namen werden begründet abgelehnt', () => {
  it('klassifiziert Section/Promo/Eigenschaft/Layout korrekt', () => {
    expect(reweNonProductNameReason('Tiefkühl')).toBe('section');
    expect(reweNonProductNameReason('An der Bedientheke')).toBe('section');
    expect(reweNonProductNameReason('Probierpreis')).toBe('promo_badge');
    expect(reweNonProductNameReason('Tiefpreis')).toBe('promo_badge');
    expect(reweNonProductNameReason('auch alkoholfrei')).toBe('property_fragment');
    expect(reweNonProductNameReason('wahlweise vegan')).toBe('property_fragment');
    expect(reweNonProductNameReason('···')).toBe('layout_artifact');
    // echte Produkte tragen Identität → null
    for (const real of ['Coca-Cola', 'Bananen', 'Heineken Lager Beer', 'Coca-Cola Tiefpreis', 'Le Gruyère AOP']) {
      expect(reweNonProductNameReason(real), real).toBeNull();
    }
  });

  it('skippt solche Namen begründet (nie live, nie Food-Review) — P2', () => {
    const result = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        offers: [
          { name: 'Probierpreis', price: '0,99' },
          { name: 'auch alkoholfrei', price: '1,49' },
          { name: 'nur noch heute', price: '4,99' },
          { name: 'Mehr anzeigen', price: '2,49' },
          { name: 'Bananen', price: '1,79' },
        ],
      },
      at,
    );
    // Nur das echte Produkt bleibt live; keine Promo-/CTA-/Property-Phrase.
    expect(result.offers.map((o) => o.name)).toEqual(['Bananen']);
    // Diese Namen landen NICHT im (Food-)Review, sondern im begründeten Skip.
    expect(result.reviewOffers).toHaveLength(0);
    expect(result.report.skippedNonProductCount).toBe(4);
    const examples = result.report.skippedNonProductExamples ?? [];
    expect(examples.some((e) => e.startsWith('nur noch heute') && e.includes('cta_phrase'))).toBe(true);
    expect(examples.some((e) => e.startsWith('Mehr anzeigen') && e.includes('cta_phrase'))).toBe(true);
    expect(examples.some((e) => e.startsWith('Probierpreis') && e.includes('promo_badge'))).toBe(true);
    // Zählkette bleibt rechnerisch korrekt (Skips zählen mit).
    const chain = result.report.countingChain!;
    expect(chain.serverSkipped.nonProduct).toBe(4);
    expect(chain.balanced).toBe(true);
  });

  it('erkennt CTA-/Zeitraum-Phrasen generisch, echte Produkte mit Aktionswort bleiben Produkt', () => {
    for (const cta of ['nur noch heute', 'Mehr anzeigen', 'solange der Vorrat reicht']) {
      expect(reweNonProductNameReason(cta), cta).toBe('cta_phrase');
    }
    for (const real of ['Coca-Cola nur diese Woche', 'Bananen', 'Wagner Steinofen Pizza']) {
      expect(reweNonProductNameReason(real), real).toBeNull();
    }
  });
});

describe('P4 — echte Lebensmittel bleiben Food (Alkohol bleibt Food), ohne Allowlist', () => {
  it('behält Alkohol/Food anhand der echten Sektion, filtert Drogerie weiter', () => {
    const cases: Array<[string, string]> = [
      ['Heineken Lager Beer', 'Wein und Spirituosen'],
      ['ja! Erdnuss-Flips', 'Süßes und Salziges'],
      ['Aoste Stickado', 'An der Bedientheke'],
      ['Rügenwalder vegane Rostbratwürstchen', 'Kühlung'],
      ['Züger Bio Mozzarella', 'Kühlung'],
      ['Maggi Ravioli', 'Vorratskammer'],
      ['Gorbatschow Premixed Longdrink', 'Wein und Spirituosen'],
    ];
    const result = normalizeReweBrowserImportRequest(
      { source: 'rewe-browser', offers: cases.map(([name, category]) => ({ name, price: '2,99', category })) },
      at,
    );
    const strict = filterOffersStrictFood(result.offers);
    expect(strict.removedOffers).toHaveLength(0);
    expect(strict.offers).toHaveLength(7);

    // Gegenprobe: echte Drogerie bleibt Non-Food.
    const drogerie = normalizeReweBrowserImportRequest(
      { source: 'rewe-browser', offers: [{ name: 'Pampers Baby Dry', price: '12,99', category: 'Drogerie' }] },
      at,
    );
    expect(filterOffersStrictFood(drogerie.offers).removedOffers.map((o) => o.name)).toEqual([
      'Pampers Baby Dry',
    ]);
  });
});

describe('P5 — Completeness getrennt von Datenqualität', () => {
  it('balancierte Kette → unexplainedMissing=0, possibleWebMissingEstimate=0 (nicht uniqueCards−live)', () => {
    const result = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        webCardCount: 151,
        diagnostics: {
          rawPriceMatches: 232,
          observedCardOccurrences: 151,
          uniqueCardCandidates: 151,
          repeatedCardObservations: 0,
          rejected: { noPrice: 23, noName: 20, sectionHeading: 0, extractionError: 0 },
          browserAcceptedBeforeDedupe: 108,
          browserOfferDuplicates: 1,
          payloadOffers: 107,
        },
        // 107 Payload: 105 live + 2 review (Fragmente)
        offers: [
          ...Array.from({ length: 105 }, (_v, i) => ({ name: `Produkt ${i}`, price: '1,99' })),
          { name: 'Peanut', price: '0,99' },
          { name: 'Original', price: '0,99' },
        ],
      },
      at,
    );
    const comp = result.report.completeness!;
    expect(comp.uniqueCardCandidates).toBe(151);
    expect(comp.imported).toBe(105);
    expect(comp.reviewHeldBack).toBe(2);
    expect(comp.explainedRejected).toBe(43);
    expect(comp.duplicates).toBe(1);
    expect(comp.unexplainedMissing).toBe(0);
    // KEINE falsche "46 fehlen"-Meldung:
    expect(result.report.possibleWebMissingEstimate).toBe(0);
    expect(result.report.countingChain?.balanced).toBe(true);
    // Health: keine Completeness-Warnung allein wegen 151−105.
    const quality = assessReweImportQuality(result.report);
    expect(quality.reasons.join(' ')).not.toMatch(/fehlen|fehlend/i);
  });

  it('hohe noName/noPrice-Rate löst ehrliche Datenqualitäts-Warnung mit Beispielen aus', () => {
    const result = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        webCardCount: 100,
        diagnostics: {
          observedCardOccurrences: 100,
          uniqueCardCandidates: 100,
          repeatedCardObservations: 0,
          rejected: { noPrice: 30, noName: 30, sectionHeading: 0, extractionError: 0 },
          rejectedExamples: { noPrice: ['Karte ohne Preis A'], noName: ['Karte ohne Name B'], sectionHeading: [] },
          browserAcceptedBeforeDedupe: 40,
          browserOfferDuplicates: 0,
          payloadOffers: 40,
        },
        offers: Array.from({ length: 40 }, (_v, i) => ({ name: `Produkt ${i}`, price: '1,99' })),
      },
      at,
    );
    const quality = assessReweImportQuality(result.report);
    expect(quality.health).toBe('warning');
    expect(quality.reasons.join(' ')).toMatch(/Ablehnungsrate/);
    expect(quality.reasons.join(' ')).toMatch(/ohne Name B|ohne Preis A/);
    // Completeness bleibt sauber (balanciert), die Warnung ist Datenqualität.
    expect(result.report.completeness?.unexplainedMissing).toBe(0);
  });
});

describe('P6 — sichere sourceUrl-Normalisierung', () => {
  it('resolveHttpUrl akzeptiert nur http/https', () => {
    expect(resolveHttpUrl('javascript:;', 'https://www.rewe.de/')).toBeUndefined();
    expect(resolveHttpUrl('data:text/html,x', 'https://www.rewe.de/')).toBeUndefined();
    expect(resolveHttpUrl('blob:abc', 'https://www.rewe.de/')).toBeUndefined();
    expect(resolveHttpUrl('', 'https://www.rewe.de/')).toBeUndefined();
    expect(resolveHttpUrl('/p/banane', 'https://www.rewe.de/')).toBe('https://www.rewe.de/p/banane');
    expect(resolveHttpUrl('https://www.rewe.de/p/x', 'https://www.rewe.de/')).toBe('https://www.rewe.de/p/x');
  });

  it('javascript:-Pseudo-Links werden nicht als sourceUrl gespeichert und beeinflussen die ID nicht', () => {
    const withJs = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        pageUrl: 'https://www.rewe.de/angebote/nationale-angebote/',
        offers: [{ name: 'Bananen', price: '1,79', sourceUrl: 'javascript:;' }],
      },
      at,
    );
    const noLink = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        pageUrl: 'https://www.rewe.de/angebote/nationale-angebote/',
        offers: [{ name: 'Bananen', price: '1,79' }],
      },
      at,
    );
    expect(withJs.offers[0].sourceUrl).toBe('https://www.rewe.de/angebote/nationale-angebote/');
    expect(withJs.offers[0].sourceUrl).not.toMatch(/javascript:/);
    // stabile ID hängt nicht am javascript:-Link → identisch zur Variante ohne Link
    expect(withJs.offers[0].id).toBe(noLink.offers[0].id);
  });

  it('gültige https-Produktlinks bleiben erhalten', () => {
    const result = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        pageUrl: 'https://www.rewe.de/angebote/nationale-angebote/',
        offers: [{ name: 'Bananen', price: '1,79', sourceUrl: 'https://www.rewe.de/produkte/bananen/' }],
      },
      at,
    );
    expect(result.offers[0].sourceUrl).toBe('https://www.rewe.de/produkte/bananen/');
  });
});
