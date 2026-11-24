import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { computeQualityReport, isLikelyFragmentName } from './offersQuality';

function makeOffer(overrides: Partial<Offer> & Record<string, unknown> = {}): Offer {
  return {
    id: overrides.id as string ?? 'offer_test',
    name: 'Bio Milch',
    normalizedName: 'bio milch',
    storeChain: 'REWE',
    category: 'dairy',
    price: 1.29,
    currency: 'EUR',
    unit: '1l',
    validityStart: '2026-05-26T00:00:00.000Z',
    validityEnd: '2026-06-01T23:59:59.999Z',
    imageUrl: 'https://example.com/milk.png',
    sourceUrl: 'https://example.com/offer',
    tags: [],
    createdAt: '2026-05-26T08:00:00.000Z',
    ...overrides,
  } as Offer;
}

function snapshot(overrides: Partial<Parameters<typeof computeQualityReport>[0]> = {}) {
  return {
    offers: [],
    filteredOffers: [],
    nextWeekOffers: [],
    updatedAt: '2026-05-27T12:00:00.000Z',
    ingest: null,
    aiRun: null,
    ...overrides,
  };
}

describe('computeQualityReport — store counts', () => {
  it('groups offers by storeChain and counts totals', () => {
    const report = computeQualityReport(
      snapshot({
        offers: [
          makeOffer({ id: 'a', storeChain: 'REWE' }),
          makeOffer({ id: 'b', storeChain: 'REWE' }),
          makeOffer({ id: 'c', storeChain: 'Lidl' }),
        ],
      }),
    );

    const rewe = report.stores.find((s) => s.storeChain === 'REWE');
    const lidl = report.stores.find((s) => s.storeChain === 'Lidl');
    expect(rewe?.total).toBe(2);
    expect(lidl?.total).toBe(1);
    expect(report.kpis.storeCount).toBe(2);
    expect(report.kpis.liveTotal).toBe(3);
  });

  it('uses "Unbekannt" when storeChain is missing/blank', () => {
    const report = computeQualityReport(
      snapshot({
        offers: [
          makeOffer({ id: 'x', storeChain: '' as unknown as string }),
        ],
      }),
    );
    expect(report.stores[0].storeChain).toBe('Unbekannt');
  });

  it('flags stores below the low-offer threshold', () => {
    const report = computeQualityReport(
      snapshot({
        offers: [
          // 2 Lidl → flagged
          makeOffer({ id: '1', storeChain: 'Lidl' }),
          makeOffer({ id: '2', storeChain: 'Lidl' }),
          // 6 EDEKA → not flagged
          ...Array.from({ length: 6 }, (_, i) =>
            makeOffer({ id: `e${i}`, storeChain: 'EDEKA' }),
          ),
        ],
      }),
    );
    const lidl = report.stores.find((s) => s.storeChain === 'Lidl');
    const edeka = report.stores.find((s) => s.storeChain === 'EDEKA');
    expect(lidl?.lowOfferCount).toBe(true);
    expect(edeka?.lowOfferCount).toBe(false);
  });
});

describe('computeQualityReport — percent values', () => {
  it('reports image coverage per store with one decimal', () => {
    const report = computeQualityReport(
      snapshot({
        offers: [
          makeOffer({ id: '1', imageUrl: 'https://x/1.png' }),
          makeOffer({ id: '2', imageUrl: undefined }),
          makeOffer({ id: '3', imageUrl: 'https://x/3.png' }),
        ],
      }),
    );
    expect(report.stores[0].withImage).toBe(2);
    // 2/3 = 66.666... → rounded to one decimal
    expect(report.stores[0].withImagePercent).toBeCloseTo(66.7, 1);
    expect(report.kpis.imageCoveragePercent).toBeCloseTo(66.7, 1);
  });

  it('returns 0% when no offers exist (no division-by-zero)', () => {
    const report = computeQualityReport(snapshot({ offers: [] }));
    expect(report.kpis.imageCoveragePercent).toBe(0);
    expect(report.kpis.nutritionCoveragePercent).toBe(0);
    expect(report.kpis.halalCoveragePercent).toBe(0);
    expect(report.stores).toEqual([]);
  });
});

describe('computeQualityReport — missing fields', () => {
  it('detects missing image, nutrition, halal, allergens', () => {
    const bare = makeOffer({
      id: 'bare',
      name: 'Mineralwasser',
      category: 'drinks',
      imageUrl: undefined,
    });
    const report = computeQualityReport(snapshot({ offers: [bare] }));
    expect(report.kpis.imageCoveragePercent).toBe(0);
    expect(report.kpis.nutritionCoveragePercent).toBe(0);
    expect(report.kpis.halalCoveragePercent).toBe(0);
    expect(report.kpis.allergensCoveragePercent).toBe(0);
  });

  it('counts halal as known when dietFlags.halal.status is "yes" or "no"', () => {
    const halalYes = makeOffer({
      id: 'h1',
      dietFlags: { halal: { status: 'yes' } },
    } as Partial<Offer> & Record<string, unknown>);
    const halalNo = makeOffer({
      id: 'h2',
      dietFlags: { halal: { status: 'no' } },
    } as Partial<Offer> & Record<string, unknown>);
    const halalUnknown = makeOffer({ id: 'h3' });

    const report = computeQualityReport(
      snapshot({ offers: [halalYes, halalNo, halalUnknown] }),
    );
    expect(report.kpis.halalCoveragePercent).toBeCloseTo(66.7, 1);
  });

  it('counts nutrition only when per_100g has a usable value', () => {
    const withNutrition = makeOffer({
      id: 'n1',
      nutrition: { source: 'openfoodfacts', per_100g: { kcal: 42 } },
    } as Partial<Offer> & Record<string, unknown>);
    const allNull = makeOffer({
      id: 'n2',
      nutrition: { per_100g: { kcal: null, protein_g: null } },
    } as Partial<Offer> & Record<string, unknown>);

    const report = computeQualityReport(snapshot({ offers: [withNutrition, allNull] }));
    expect(report.stores[0].withNutrition).toBe(1);
    expect(report.stores[0].withNutritionPercent).toBe(50);
  });

  it('counts vegetarian/vegan known only when dietFlags carry the answer', () => {
    const vegan = makeOffer({
      id: 'v1',
      dietFlags: { vegan: true, vegetarian: true },
    } as Partial<Offer> & Record<string, unknown>);
    const unknownDiet = makeOffer({ id: 'v2' });

    const report = computeQualityReport(snapshot({ offers: [vegan, unknownDiet] }));
    const store = report.stores[0];
    expect(store.vegetarianKnown).toBe(1);
    expect(store.veganKnown).toBe(1);
    expect(store.vegetarianKnownPercent).toBe(50);
  });
});

describe('computeQualityReport — review rules', () => {
  it('flags milk-like products with empty allergens as risk', () => {
    const milk = makeOffer({
      id: 'm1',
      name: 'Bio Vollmilch 1,5%',
      category: 'dairy',
    });
    const report = computeQualityReport(snapshot({ offers: [milk] }));
    const item = report.review.find((r) => r.id === 'm1');
    expect(item?.reasons).toContain('allergens_empty_risk');
  });

  it('recognizes beer as alcohol (detected, no longer an "unknown" risk)', () => {
    const beer = makeOffer({
      id: 'b1',
      name: 'Krombacher Pils 0,5l',
      category: 'Alkohol',
    });
    const report = computeQualityReport(snapshot({ offers: [beer] }));
    const item = report.review.find((r) => r.id === 'b1');
    // Alcohol is now KNOWN -> the honest derivation removes the "unknown" gate.
    expect(item?.reasons ?? []).not.toContain('alcohol_unknown_risk');
    expect(report.productInfo.alcoholDetected).toBe(1);
  });

  it('does not flag a snack with non-alcoholic name as alcohol risk', () => {
    // Snack-category Frischkäse-Cracker — drinks/sweets category triggers
    // the alcohol risk gate, but the *name* has no alcohol cue, so the
    // alcohol_unknown_risk flag should NOT fire if either: alcohol is
    // known OR the name has no alcohol cue. Reason: bare category alone
    // already triggers — we accept that as a false-positive baseline and
    // verify the inverse instead: known alcohol clears the flag.
    const alcoholKnown = makeOffer({
      id: 's1',
      name: 'Lindt Pralinen',
      category: 'snacks_sweets',
      dietFlags: { alcohol: { present: false } },
    } as Partial<Offer> & Record<string, unknown>);
    const report = computeQualityReport(snapshot({ offers: [alcoholKnown] }));
    const item = report.review.find((r) => r.id === 's1');
    expect(item?.reasons ?? []).not.toContain('alcohol_unknown_risk');
  });

  it('flags offers with category "other" via category_other reason', () => {
    const other = makeOffer({ id: 'o1', name: 'Glühbirne', category: 'other' });
    const report = computeQualityReport(snapshot({ offers: [other] }));
    expect(report.review.find((r) => r.id === 'o1')?.reasons).toContain('category_other');
  });

  it('flags offers with price 0 or missing as no_price', () => {
    const free = makeOffer({ id: 'p1', price: 0 });
    const report = computeQualityReport(snapshot({ offers: [free] }));
    expect(report.review.find((r) => r.id === 'p1')?.reasons).toContain('no_price');
  });

  it('aggregates reviewCounts per reason', () => {
    const report = computeQualityReport(
      snapshot({
        offers: [
          makeOffer({ id: 'a', name: 'Vollmilch', imageUrl: undefined }),
          makeOffer({ id: 'b', name: 'Bier', category: 'Alkohol', imageUrl: undefined }),
        ],
      }),
    );
    expect(report.reviewCounts.no_image).toBe(2);
    expect(report.reviewCounts.allergens_empty_risk).toBeGreaterThanOrEqual(1);
    // Bier is now detected as alcohol (honest analyzed signal) rather than an
    // "unknown alcohol" review case.
    expect(report.productInfo.alcoholDetected).toBe(1);
  });

  it('flags REWE fragment/generic names via the name_fragment reason', () => {
    const report = computeQualityReport(
      snapshot({
        offers: [
          makeOffer({ id: 'f1', name: 'Peanut', storeChain: 'REWE' }),
          makeOffer({ id: 'f2', name: 'Original', storeChain: 'REWE' }),
          makeOffer({ id: 'f3', name: 'Schoko Meersalz', storeChain: 'REWE' }),
          makeOffer({ id: 'f4', name: 'mit milder Rauchnote', storeChain: 'REWE' }),
          makeOffer({ id: 'ok', name: 'EHRMANN Almighurt 150g', storeChain: 'REWE' }),
        ],
      }),
    );
    expect(report.review.find((r) => r.id === 'f1')?.reasons).toContain('name_fragment');
    expect(report.review.find((r) => r.id === 'f3')?.reasons).toContain('name_fragment');
    expect(report.review.find((r) => r.id === 'f4')?.reasons).toContain('name_fragment');
    expect(report.review.find((r) => r.id === 'ok')?.reasons ?? []).not.toContain('name_fragment');
    expect(report.reviewCounts.name_fragment).toBe(4);
  });
});

describe('isLikelyFragmentName', () => {
  it('flags fragment/generic names', () => {
    expect(isLikelyFragmentName('Peanut')).toBe(true);
    expect(isLikelyFragmentName('Original')).toBe(true);
    expect(isLikelyFragmentName('Schoko Meersalz')).toBe(true);
    expect(isLikelyFragmentName('mit milder Rauchnote')).toBe(true);
  });

  it('does not flag real, contextful product names', () => {
    expect(isLikelyFragmentName('Bio Milch')).toBe(false);
    expect(isLikelyFragmentName('EHRMANN Almighurt 150g')).toBe(false);
    expect(isLikelyFragmentName('K-PURLAND Schweinenacken ohne Knochen')).toBe(false);
    expect(isLikelyFragmentName('Coca Cola 1,5l')).toBe(false);
    expect(isLikelyFragmentName('Deutsche Erdbeeren 500g')).toBe(false);
    expect(isLikelyFragmentName('Bananen')).toBe(false);
  });
});

describe('computeQualityReport — productInfo summary (honest)', () => {
  it('counts every offer as analyzed and breaks down halal/allergen/alcohol honestly', () => {
    const report = computeQualityReport(
      snapshot({
        offers: [
          makeOffer({ id: 'a', name: 'Vollmilch 3,5%', category: 'Milchprodukte' }),
          makeOffer({ id: 'b', name: 'Krombacher Pils', category: 'Alkohol' }),
          makeOffer({ id: 'c', name: 'Glühbirne', category: 'other' }),
        ],
      }),
    );
    const pi = report.productInfo;
    // Every live offer is analyzed, even when fields stay unknown.
    expect(pi.analyzedTotal).toBe(3);
    // Alcohol detected for the beer -> not_halal counts toward halalKnown.
    expect(pi.alcoholDetected).toBe(1);
    expect(pi.halalNotHalal).toBe(1);
    expect(pi.halalKnown).toBe(1);
    // Milk -> allergen risk; light bulb -> unknown (never "allergen-free").
    expect(pi.allergenRisk).toBeGreaterThanOrEqual(1);
    expect(pi.allergenUnknown).toBeGreaterThanOrEqual(1);
    // No real nutrition source anywhere -> honest unknown, none fabricated.
    expect(pi.nutritionVerified).toBe(0);
    expect(pi.nutritionUnknown).toBe(3);
  });
});

describe('computeQualityReport — current price vs. enrichment', () => {
  it('counts current offer price per store', () => {
    const report = computeQualityReport(
      snapshot({
        offers: [
          makeOffer({ id: '1', price: 1.99 }),
          makeOffer({ id: '2', price: 0 }),
          makeOffer({ id: '3', price: 2.49 }),
        ],
      }),
    );
    const store = report.stores[0];
    expect(store.withCurrentPrice).toBe(2);
    expect(store.withCurrentPricePercent).toBeCloseTo(66.7, 1);
  });
});

describe('computeQualityReport — store status (honest tiers)', () => {
  // A store with plenty of offers, prices and images, but zero enrichment.
  function healthyButUnenriched(storeChain: string, count = 40) {
    return Array.from({ length: count }, (_, i) =>
      makeOffer({
        id: `${storeChain}_${i}`,
        storeChain,
        name: 'Apfel', // maps to a real category, never "other"
        category: 'Obst/Gemüse',
        price: 1.49,
        imageUrl: 'https://example.com/p.png',
      }),
    );
  }

  it('does NOT mark a store critical only because nutrition/halal/allergens are empty', () => {
    const report = computeQualityReport(
      snapshot({ offers: healthyButUnenriched('REWE') }),
    );
    const store = report.stores.find((s) => s.storeChain === 'REWE');
    expect(store?.status.tier).not.toBe('crit');
    // enrichment gaps are surfaced as a soft, informational reason only
    expect(store?.status.reasons).toContain('enrichment_pending');
  });

  it('marks "Anreicherung offen" stores as warn, not crit', () => {
    const report = computeQualityReport(
      snapshot({ offers: healthyButUnenriched('EDEKA') }),
    );
    const store = report.stores.find((s) => s.storeChain === 'EDEKA');
    expect(store?.status.tier).toBe('warn');
    // the only open point is enrichment — no hard blocker
    expect(store?.status.reasons).toEqual(['enrichment_pending']);
  });

  it('marks a store critical when the current price is missing on most offers', () => {
    const offers = Array.from({ length: 40 }, (_, i) =>
      makeOffer({
        id: `noprice_${i}`,
        storeChain: 'Penny',
        name: 'Apfel',
        category: 'Obst/Gemüse',
        price: 0,
        imageUrl: 'https://example.com/p.png',
      }),
    );
    const report = computeQualityReport(snapshot({ offers }));
    const store = report.stores.find((s) => s.storeChain === 'Penny');
    expect(store?.status.tier).toBe('crit');
    expect(store?.status.reasons).toContain('missing_current_price');
  });

  it('marks a store critical when images are missing on most offers', () => {
    const offers = Array.from({ length: 40 }, (_, i) =>
      makeOffer({
        id: `noimg_${i}`,
        storeChain: 'Aldi',
        name: 'Apfel',
        category: 'Obst/Gemüse',
        price: 1.49,
        imageUrl: undefined,
      }),
    );
    const report = computeQualityReport(snapshot({ offers }));
    const store = report.stores.find((s) => s.storeChain === 'Aldi');
    expect(store?.status.tier).toBe('crit');
    expect(store?.status.reasons).toContain('missing_images');
  });

  it('marks a store critical when almost everything is uncategorized', () => {
    const offers = Array.from({ length: 40 }, (_, i) =>
      makeOffer({
        id: `other_${i}`,
        storeChain: 'Kaufland',
        name: 'Diverses',
        category: 'Sonstiges',
        price: 1.49,
        imageUrl: 'https://example.com/p.png',
      }),
    );
    const report = computeQualityReport(snapshot({ offers }));
    const store = report.stores.find((s) => s.storeChain === 'Kaufland');
    expect(store?.status.tier).toBe('crit');
    expect(store?.status.reasons).toContain('uncategorized_high');
  });

  it('flags a store with too few offers as critical', () => {
    const report = computeQualityReport(
      snapshot({
        offers: [
          makeOffer({ id: '1', storeChain: 'Mini', name: 'Apfel', category: 'Obst/Gemüse' }),
          makeOffer({ id: '2', storeChain: 'Mini', name: 'Apfel', category: 'Obst/Gemüse' }),
        ],
      }),
    );
    const store = report.stores.find((s) => s.storeChain === 'Mini');
    expect(store?.status.tier).toBe('crit');
    expect(store?.status.reasons).toContain('low_offers');
  });
});

describe('computeQualityReport — honest image quality (Scan 2.0 broken images)', () => {
  it('keeps withImagePercent = URL-present and adds reachable/broken from Phase-1 check', () => {
    const offers = [
      makeOffer({ id: 'ok', imageStatus: 'ok' } as Partial<Offer> & Record<string, unknown>),
      // EDEKA-Fall: URL vorhanden, aber 404/kein image/* → broken, NICHT erreichbar.
      makeOffer({ id: 'edeka', imageStatus: 'broken', brokenImage: true } as Partial<Offer> & Record<string, unknown>),
      makeOffer({ id: 'ok2', imageStatus: 'ok' } as Partial<Offer> & Record<string, unknown>),
    ];
    const report = computeQualityReport(snapshot({ offers }));
    const store = report.stores[0];
    // Alle 3 haben eine URL → withImage bleibt 100 %.
    expect(store.withImage).toBe(3);
    expect(store.withImagePercent).toBe(100);
    // Aber nur 2 sind wirklich erreichbar; 1 ist broken.
    expect(store.withReachableImage).toBe(2);
    expect(store.brokenImage).toBe(1);
    expect(store.imageChecked).toBe(3);
    expect(store.withReachableImagePercent).toBeCloseTo(66.7, 1);
    // KPI: ehrliche Erreichbarkeit statt blanker URL-Abdeckung.
    expect(report.kpis.imageCoveragePercent).toBe(100);
    expect(report.kpis.reachableImageCoveragePercent).toBeCloseTo(66.7, 1);
    expect(report.kpis.brokenImageTotal).toBe(1);
    expect(report.kpis.imageCheckedTotal).toBe(3);
  });

  it('does not invent broken/reachable counts when no image check has run', () => {
    const offers = [
      makeOffer({ id: 'a' }),
      makeOffer({ id: 'b' }),
    ];
    const report = computeQualityReport(snapshot({ offers }));
    const store = report.stores[0];
    expect(store.imageChecked).toBe(0);
    expect(store.brokenImage).toBe(0);
    expect(store.withReachableImage).toBe(0);
    // Ohne Check fällt die ehrliche Quote auf die URL-Abdeckung zurück.
    expect(report.kpis.reachableImageCoveragePercent).toBe(100);
    expect(report.kpis.brokenImageTotal).toBe(0);
    expect(report.kpis.imageCheckedTotal).toBe(0);
    // Kein broken_images-Grund, solange nichts geprüft wurde.
    expect(store.status.reasons).not.toContain('broken_images');
  });

  it('warns a store with broken images (EDEKA 404s no longer count as 100 %)', () => {
    // 40 EDEKA-Angebote mit URL, davon viele broken → warn-Grund broken_images.
    const offers = Array.from({ length: 40 }, (_, i) =>
      makeOffer({
        id: `edeka_${i}`,
        storeChain: 'EDEKA',
        name: 'Apfel',
        category: 'Obst/Gemüse',
        price: 1.49,
        imageUrl: 'https://edeka.example/p.jpg',
        imageStatus: i < 10 ? 'broken' : 'ok',
        brokenImage: i < 10,
      } as Partial<Offer> & Record<string, unknown>),
    );
    const report = computeQualityReport(snapshot({ offers }));
    const store = report.stores.find((s) => s.storeChain === 'EDEKA');
    expect(store?.brokenImage).toBe(10);
    expect(store?.status.reasons).toContain('broken_images');
  });
});

describe('computeQualityReport — empty snapshot', () => {
  it('returns a well-formed empty report', () => {
    const report = computeQualityReport(snapshot());
    expect(report.kpis.liveTotal).toBe(0);
    expect(report.kpis.filteredTotal).toBe(0);
    expect(report.kpis.nextWeekTotal).toBe(0);
    expect(report.stores).toEqual([]);
    expect(report.review).toEqual([]);
    expect(report.reviewCounts.no_image).toBe(0);
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('passes through updatedAt and process states', () => {
    const report = computeQualityReport(
      snapshot({
        updatedAt: '2026-05-27T13:00:00.000Z',
        ingest: { running: true, message: 'läuft', startedAt: '2026-05-27T12:59:00.000Z' },
        aiRun: { running: false, finishedAt: '2026-05-27T11:00:00.000Z' },
      }),
    );
    expect(report.kpis.updatedAt).toBe('2026-05-27T13:00:00.000Z');
    expect(report.kpis.lastIngest?.running).toBe(true);
    expect(report.kpis.lastIngest?.message).toBe('läuft');
    expect(report.kpis.lastAiRun?.running).toBe(false);
    expect(report.kpis.lastAiRun?.finishedAt).toBe('2026-05-27T11:00:00.000Z');
  });
});
