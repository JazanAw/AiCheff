import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { buildScanReport, computeDiagnosticFreshness } from './scanReport';
import { summarizeReviewQueue } from './reviewReductionClasses';
import { summarizeFoodDecisions } from './foodDecision';

// Tasks P3 (Diagnose-Frische) + P4 (Review-Queue-Aufteilung). Produktnamen sind
// reine Reproduktions-Fixtures; keine Produkt-/Marken-Allowlist, keine KW-Logik.

const CURRENT = {
  validityStart: '2026-06-14T00:00:00.000Z',
  validityEnd: '2026-06-21T23:59:59.000Z',
};

function offer(name: string, extra: Partial<Offer> & Record<string, unknown> = {}): Offer {
  return {
    id: name,
    name,
    normalizedName: name.toLowerCase(),
    storeChain: 'Netto',
    category: 'Sonstiges',
    price: 1.99,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: CURRENT.validityStart,
    validityEnd: CURRENT.validityEnd,
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-06-14T00:00:00.000Z',
    ...extra,
  } as Offer;
}

function spritzring(): Offer {
  return offer('Spritzring', {
    storeChain: 'Netto',
    category: 'Getränke Alkoholfrei',
    price: 0.49,
    unit: 'stück',
    sourceCategoryRaw: 'Filialangebote',
    foodFlag: 'food',
    canonicalCategory: {
      main: 'Non-Food',
      sub: 'Küche & Geräte',
      isNonFood: true,
      confidence: 0.8,
      reasons: ['Küchenutensil', 'cache:hit'],
    },
  });
}

function kernarm(): Offer {
  return offer('kernarm', {
    storeChain: 'REWE',
    category: 'Getränke Alkoholfrei',
    price: 1.11,
    unit: '1-kg',
    foodFlag: 'unsure',
    sourceCategoryRaw: 'Angebote im Markt',
    canonicalCategory: {
      main: 'Non-Food',
      isNonFood: true,
      confidence: 0.4,
      reasons: ["Product name 'kernarm' does not indicate a food item.", 'cache:hit'],
    },
  });
}

const REWE_IMPORT = {
  rawCount: 10,
  normalizedCount: 8,
  reviewCount: 1,
  skippedCount: 1,
  suspiciousPrices: [],
  duplicateCandidates: [],
  categoryCorrections: [],
  skippedFragments: [],
} as unknown as NonNullable<Parameters<typeof buildScanReport>[0]['reweImport']>;

const SUB_SOURCE_OUTCOME = {
  storeChain: 'Lidl',
  sourceId: 'lidl-current',
  status: 'success',
  previousCount: 100,
  candidateCount: 100,
  lossCount: 0,
  lossRate: 0,
  gateDecision: 'committed',
} as unknown as NonNullable<Parameters<typeof buildScanReport>[0]['subSourceOutcomes']>[number];

describe('P3 — Diagnose-Frische je Lauf-Kontext', () => {
  it('phase2-only ohne Daten ⇒ reweImport/subSourceBalance = not_refreshed', () => {
    const fr = computeDiagnosticFreshness('phase2-only', {
      reweImport: false,
      subSourceBalance: false,
      edeka: false,
      kaufland: false,
    });
    expect(fr.reweImport).toBe('not_refreshed');
    expect(fr.subSourceBalance).toBe('not_refreshed');
  });

  it('phase2-only mit alten Snapshot-Daten ⇒ stale, nicht fresh', () => {
    const fr = computeDiagnosticFreshness('phase2-only', {
      reweImport: true,
      subSourceBalance: false,
      edeka: true,
      kaufland: true,
    });
    expect(fr.reweImport).toBe('stale');
    expect(fr.edeka).toBe('stale');
    expect(fr.kaufland).toBe('stale');
  });

  it('full scan mit Diagnosen ⇒ fresh', () => {
    const fr = computeDiagnosticFreshness('full', {
      reweImport: true,
      subSourceBalance: true,
      edeka: true,
      kaufland: true,
    });
    expect(fr.reweImport).toBe('fresh');
    expect(fr.subSourceBalance).toBe('fresh');
  });

  it('buildScanReport: phase2-only-Report zeigt not_refreshed (Felder nicht kontextlos leer)', () => {
    const report = buildScanReport({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [spritzring()],
      officialCounts: {},
      reweImport: null,
      subSourceOutcomes: [],
      runContext: 'phase2-only',
    });
    expect(report.diagnosticFreshness.reweImport).toBe('not_refreshed');
    expect(report.diagnosticFreshness.subSourceBalance).toBe('not_refreshed');
    // Kein Regress: das blockierende Qualitäts-Gate ist unberührt (not_refreshed
    // ist eine ehrliche Diagnose, kein Fehler — es erzeugt keinen Gate-Konflikt).
    expect(report.gateConflicts.count).toBe(0);
  });

  it('buildScanReport: full scan mit Diagnosen ⇒ fresh', () => {
    const report = buildScanReport({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [],
      officialCounts: {},
      reweImport: REWE_IMPORT,
      subSourceOutcomes: [SUB_SOURCE_OUTCOME],
      runContext: 'full',
    });
    expect(report.diagnosticFreshness.reweImport).toBe('fresh');
    expect(report.diagnosticFreshness.subSourceBalance).toBe('fresh');
  });

  it('Default-Lauf-Kontext ist full (bestehende Aufrufer unverändert)', () => {
    const report = buildScanReport({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [],
      officialCounts: {},
    });
    expect(report.diagnosticFreshness.runContext).toBe('full');
  });
});

describe('P4 — Review-Queue nach Klasse getrennt', () => {
  it('Spritzring ist cache-conflict, kernarm ist name-quality — getrennte Listen', () => {
    const queue = summarizeReviewQueue([spritzring(), kernarm()]);
    expect(queue.cacheConflictReview.count).toBe(1);
    expect(queue.cacheConflictReview.examples).toContain('Spritzring');
    expect(queue.nameQualityReview.count).toBe(1);
    expect(queue.nameQualityReview.examples).toContain('kernarm');
    // Nie vermischt:
    expect(queue.cacheConflictReview.examples).not.toContain('kernarm');
    expect(queue.foodLikeReview.examples).not.toContain('kernarm');
    expect(queue.foodLikeReview.examples).not.toContain('Spritzring');
  });

  it('food-like vs non-food-like nach Modell-Votum', () => {
    const foodish = offer('Mysterium A', { foodFlag: 'food', category: 'Sonstiges', unit: 'stück' });
    const nonfoodish = offer('Mysterium B', { foodFlag: 'unsure', category: 'Sonstiges', unit: 'stück' });
    const queue = summarizeReviewQueue([foodish, nonfoodish]);
    expect(queue.foodLikeReview.examples).toContain('Mysterium A');
    expect(queue.nonFoodLikeReview.examples).toContain('Mysterium B');
  });

  it('Review-Zähler konsistent mit foodDecisionSummary.uncertainFilteredCount', () => {
    const filtered = [spritzring(), kernarm(), offer('Mysterium', { foodFlag: 'food', unit: 'stück' })];
    const queue = summarizeReviewQueue(filtered);
    const fd = summarizeFoodDecisions({ offers: [], nextWeekOffers: [], filteredOffers: filtered });
    // Die uncertain-Klassen (ohne name_quality, das ein Bewegungs-Guard ist)
    // summieren sich exakt zu uncertainFilteredCount.
    expect(
      queue.foodLikeReview.count + queue.nonFoodLikeReview.count + queue.cacheConflictReview.count,
    ).toBe(fd.uncertainFilteredCount);
  });
});
