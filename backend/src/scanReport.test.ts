import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  buildScanReport,
  renderScanReportMarkdown,
  buildLidlManualImportReport,
  emptyLidlManualImportReport,
} from './scanReport';

const now = new Date('2026-06-03T13:00:00.000Z');
const CURRENT = { validityStart: '2026-06-01T00:00:00.000Z', validityEnd: '2026-06-07T23:59:59.000Z' };
const UPCOMING = { validityStart: '2026-06-08T00:00:00.000Z', validityEnd: '2026-06-14T23:59:59.000Z' };

let seq = 0;
function offer(storeChain: string, when = CURRENT): Offer {
  seq += 1;
  return {
    id: `o_${seq}`,
    name: `Artikel ${seq}`,
    normalizedName: `artikel ${seq}`,
    storeChain,
    category: 'Sonstiges',
    price: 1.99,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: when.validityStart,
    validityEnd: when.validityEnd,
    sourceUrl: 'https://example.org',
    tags: [],
    createdAt: '2026-06-03T00:00:00.000Z',
  };
}

describe('buildScanReport', () => {
  it('summarizes completeness, blocked + critical stores and Kaufland missing examples', () => {
    const report = buildScanReport({
      offers: [
        ...Array.from({ length: 337 }, () => offer('Kaufland', CURRENT)),
        // Lidl-Kollaps (1 strukturiertes Angebot) → critical. 18+ wären seit
        // der ehrlichen Prospekt-Erwartung (expectedMin 15) gesund.
        offer('Lidl', CURRENT),
        offer('EDEKA', CURRENT),
      ],
      nextWeekOffers: Array.from({ length: 298 }, () => offer('Kaufland', UPCOMING)),
      filteredOffers: [],
      officialCounts: { kaufland: 593 },
      kauflandCompleteness: {
        officialFoodishCount: 593,
        officialDistinctFoodCount: 593,
        matchedCount: 337,
        matchedFilteredCount: 0,
        matchedFilteredNonFoodCount: 0,
        matchedFilteredUnconfirmedCount: 0,
        missingEstimate: 256,
        missingExamples: ['Dtsch. Erdbeeren', 'K-PURLAND Schweinenacken'],
        unmatchedImportedCount: 0,
        importedCurrentCount: 337,
        comparisonScope: 'Vergleich: distinct Namen der offiziellen aktuellen Food-Woche.',
      },
      now,
    });

    // EDEKA ist jetzt direkt lesbar (national_only), nicht mehr per Config
    // blockiert — es darf NICHT in blockedStores stehen, erscheint aber immer im
    // Health-Report und ist nie 'full'.
    expect(report.blockedStores).not.toContain('EDEKA');
    const edekaHealth = report.storeImportHealth.stores.find((s) => s.storeChain === 'EDEKA');
    expect(edekaHealth).toBeDefined();
    expect(edekaHealth?.importCoverage).toBe('national_only');
    expect(report.criticalStores).toContain('Lidl');
    expect(report.kauflandCompleteness?.missingEstimate).toBe(256);

    const kaufland = report.completeness.stores.find((s) => s.storeChain === 'Kaufland');
    expect(kaufland?.currentImported).toBe(337);
    expect(kaufland?.upcomingImported).toBe(298);
  });

  it('PENNY nur mit Nächste-Woche-Angeboten: kein criticalStore, ehrliche Quellen-Diagnose', () => {
    // Quellzustand "nur Zukunfts-Kampagne importiert" (z. B. Scan kurz vor dem
    // Wochenwechsel): der Import funktioniert, es gibt nur keine aktuelle
    // Woche. Das darf nicht als "Scraper vermutlich defekt" / critical gelten.
    const report = buildScanReport({
      offers: [],
      nextWeekOffers: Array.from({ length: 167 }, () => offer('PENNY', UPCOMING)),
      filteredOffers: [],
      now,
    });

    expect(report.criticalStores).not.toContain('PENNY');
    const penny = report.storeImportHealth.stores.find((s) => s.storeChain === 'PENNY');
    expect(penny?.currentCount).toBe(0);
    expect(penny?.nextWeekCount).toBe(167);
    expect(penny?.importHealth).toBe('warning');
    expect((penny?.warnings ?? []).join(' ')).not.toMatch(/Scraper vermutlich defekt/);
    expect((penny?.warnings ?? []).join(' ')).toMatch(/kommende/i);
  });

  it('Task E/#16/#17: reweSnapshotStatus wird frisch aus den Buckets berechnet, getrennt von der Import-Zählkette', () => {
    // Aktueller Snapshot: 2 REWE current, 1 next, 1 confirmed_non_food gefiltert
    // (Eiswürfelform), 1 uncertain gefiltert (mit reviewNeeded).
    const reweCurrentA = { ...offer('REWE', CURRENT), name: 'REWE Vollmilch', normalizedName: 'rewe vollmilch' };
    const reweCurrentB = { ...offer('REWE', CURRENT), name: 'REWE Bratwurst', normalizedName: 'rewe bratwurst' };
    const reweNext = { ...offer('REWE', UPCOMING), name: 'REWE Joghurt', normalizedName: 'rewe joghurt' };
    const reweNonFood = { ...offer('REWE', CURRENT), name: 'Eiswürfelform', normalizedName: 'eiswuerfelform' };
    const reweReview = {
      ...offer('REWE', CURRENT),
      name: 'Auslese',
      normalizedName: 'auslese',
      reviewNeeded: true,
    } as Offer;

    const report = buildScanReport({
      offers: [reweCurrentA, reweCurrentB],
      nextWeekOffers: [reweNext],
      filteredOffers: [reweNonFood, reweReview],
      // Historische Import-Zählkette mit ABWEICHENDEN Zahlen (Importzeitpunkt):
      reweImport: {
        rawCount: 120,
        normalizedCount: 110,
        reviewCount: 18,
        skippedCount: 0,
        skippedFragments: [],
        suspiciousPrices: [],
        duplicateCandidates: [],
        categoryCorrections: [],
        completeness: { imported: 110, reviewHeldBack: 18, explainedRejected: 0, duplicates: 0, filteredNonFood: 9, filteredReview: 18 },
      } as never,
      reweImportMethod: 'browser',
      now,
    });

    // Aktueller Snapshot frisch aus den Buckets — NICHT die Importzahlen.
    expect(report.reweSnapshotStatus.current).toBe(2);
    expect(report.reweSnapshotStatus.nextWeek).toBe(1);
    expect(report.reweSnapshotStatus.confirmedNonFoodFiltered).toBe(1);
    expect(report.reweSnapshotStatus.uncertainFiltered).toBe(1);
    expect(report.reweSnapshotStatus.unresolvedReview).toBe(1);
    expect(report.reweSnapshotStatus.wrongFoodFiltered).toBe(0);
    // Die historische Import-Zählkette bleibt unverändert erhalten (9/18).
    expect(report.reweImport?.completeness?.filteredNonFood).toBe(9);
    expect(report.reweImport?.completeness?.filteredReview).toBe(18);

    // Render trennt beide zeitlichen Sichten klar.
    const md = renderScanReportMarkdown(report);
    expect(md).toContain('REWE — Aktueller Snapshot-Zustand (nach Phase 2)');
    expect(md).toContain('REWE — Import-Zählkette (historischer Importbeleg');
  });

  it('Task F/#18: reviewDimension trennt das reviewNeeded-Flag von der FoodDecision', () => {
    const food = { ...offer('REWE', CURRENT), name: 'REWE Bratwurst', normalizedName: 'rewe bratwurst', reviewNeeded: true } as Offer;
    const uncertainVisible = { ...offer('REWE', CURRENT), name: 'Celebrations', normalizedName: 'celebrations' };
    const nonFoodReview = {
      ...offer('REWE', CURRENT),
      name: 'Eiswürfelform',
      normalizedName: 'eiswuerfelform',
      reviewNeeded: true,
    } as Offer;
    const report = buildScanReport({
      offers: [food, uncertainVisible],
      nextWeekOffers: [],
      filteredOffers: [nonFoodReview],
      now,
    });
    expect(report.reviewDimension.confirmedFoodWithReviewCount).toBe(1);
    expect(report.reviewDimension.confirmedNonFoodWithReviewCount).toBe(1);
    expect(report.reviewDimension.uncertainVisibleCount).toBe(1);
    expect(report.reviewDimension.unresolvedVisibleReviewCount).toBe(1);
    expect(report.reviewDimension.unresolvedFilteredReviewCount).toBe(1);
  });

  it('renders a human-readable markdown report with the missing examples', () => {
    const report = buildScanReport({
      offers: [offer('EDEKA', CURRENT)],
      nextWeekOffers: [],
      filteredOffers: [],
      officialCounts: { kaufland: 593 },
      kauflandCompleteness: {
        officialFoodishCount: 593,
        officialDistinctFoodCount: 593,
        matchedCount: 337,
        matchedFilteredCount: 0,
        matchedFilteredNonFoodCount: 0,
        matchedFilteredUnconfirmedCount: 17,
        missingEstimate: 256,
        missingExamples: ['Dtsch. Erdbeeren', 'K-PURLAND Schweinenacken'],
        unmatchedImportedCount: 0,
        importedCurrentCount: 337,
        comparisonScope: 'Vergleich: distinct Namen der offiziellen aktuellen Food-Woche.',
      },
      now,
    });
    const md = renderScanReportMarkdown(report);
    expect(md).toContain('EDEKA');
    expect(md).toMatch(/unverified|unverifiziert|blockiert/i);
    expect(md).toContain('Dtsch. Erdbeeren');
    expect(md).toContain('256');
    // Die erklärten Review-Fälle aus gemischten Promo-Kategorien sind
    // transparent ausgewiesen (kein stilles Verschwinden).
    expect(md).toMatch(/gemischte.*Aktionskategorie|Review-Fälle/i);
    expect(md).toContain('17');
  });

  it('includes a per-shop import health report (strategy + REWE honesty)', () => {
    const report = buildScanReport({
      offers: [offer('Kaufland', CURRENT)],
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    expect(report.storeImportHealth).toBeDefined();
    const kaufland = report.storeImportHealth.stores.find((s) => s.storeChain === 'Kaufland');
    expect(kaufland?.strategy).toBe('embedded_json');
    // REWE always appears and is honest when nothing was imported.
    const rewe = report.storeImportHealth.stores.find((s) => s.storeChain === 'REWE');
    expect(rewe?.strategy).toBe('browser_required');
    expect(rewe?.importHealth).toBe('critical');

    const md = renderScanReportMarkdown(report);
    expect(md).toContain('Import-Health pro Shop');
    expect(md).toContain('browser_required');
  });

  it('surfaces the REWE import report (fragments, suspicious prices, corrections)', () => {
    // Task P2: die angezeigten Kategorie-Korrekturen kommen aus dem FINALEN
    // persistierten Offer-Zustand. Lindt Lindor (Roh-Heading Alkohol → final
    // Snacks/Süßes) ist eine echte finale Korrektur; eine stale Import-Korrektur
    // ohne finalen Beleg wird verworfen.
    const lindt: Offer = {
      ...offer('REWE', CURRENT),
      name: 'Lindt Lindor',
      normalizedName: 'lindt lindor',
      category: 'Snacks/Süßes',
      sourceCategoryRaw: 'Wein, Sekt & Spirituosen',
    };
    const report = buildScanReport({
      offers: [lindt],
      nextWeekOffers: [],
      filteredOffers: [],
      reweImport: {
        rawCount: 59,
        normalizedCount: 54,
        reviewCount: 5,
        skippedCount: 0,
        skippedFragments: ['Peanut', 'Schoko Meersalz'],
        suspiciousPrices: [
          { name: 'Mederano de Freixenet', usedPrice: 2.99, ignoredPrices: [0.4] },
        ],
        duplicateCandidates: ['Mederano de Freixenet'],
        // Stale Import-Zwischenstands-Korrektur ohne finalen Beleg → wird verworfen.
        categoryCorrections: [{ name: 'Phantom Korrektur', from: 'Tiefkühl', to: 'Trockenware' }],
        possibleWebMissingEstimate: 6,
      },
      now,
    });
    expect(report.reweImport?.reviewCount).toBe(5);
    // Nur die echte finale Korrektur bleibt, mit korrekter Richtung.
    expect(report.reweImport?.categoryCorrections).toEqual([
      { name: 'Lindt Lindor', from: 'Alkohol', to: 'Snacks/Süßes' },
    ]);
    const md = renderScanReportMarkdown(report);
    expect(md).toMatch(/REWE/);
    expect(md).toContain('Peanut');
    expect(md).toContain('Lindt Lindor');
    expect(md).toContain('Mederano de Freixenet');
    // Die stale Korrektur taucht nicht mehr auf.
    expect(md).not.toContain('Phantom Korrektur');
  });
});

describe('criticalStores — Merge aus Completeness UND StoreImportHealth', () => {
  it('listet einen Store mit importHealth=critical auch dann, wenn die Completeness nur unverified sagt', () => {
    // Der widerspruechliche Netto-Fall: Quelle blocked => Completeness
    // "unverified" (nicht critical), aber 100 % kaputte Bilder eskalieren die
    // ImportHealth auf critical. Der Report darf dann nicht "ok" wirken.
    const nettoOffers = Array.from({ length: 10 }, () => ({
      ...offer('Netto', CURRENT),
      imageStatus: 'broken',
      brokenImage: true,
    }));
    const report = buildScanReport({
      offers: [...nettoOffers, ...Array.from({ length: 80 }, () => offer('Kaufland', CURRENT))],
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });

    const nettoHealth = report.storeImportHealth.stores.find((s) => s.storeChain === 'Netto');
    expect(nettoHealth?.importHealth).toBe('critical');
    const nettoCompleteness = report.completeness.stores.find((s) => s.storeChain === 'Netto');
    expect(nettoCompleteness?.status).toBe('unverified');
    // Frueher: criticalStores kam NUR aus der Completeness => Netto fehlte.
    expect(report.criticalStores).toContain('Netto');
    expect(report.blockedStores).toContain('Netto');
  });

  it('dedupliziert Stores, die in beiden Sichten critical sind', () => {
    const report = buildScanReport({
      offers: [offer('Lidl', CURRENT)], // 1 Angebot => beide Sichten critical
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    expect(report.criticalStores.filter((store) => store === 'Lidl')).toHaveLength(1);
  });
});

describe('Non-Food-Leaks im Scan-Report (current/next)', () => {
  // Reproduktions-Fixtures: klares Non-Food mit falschem KI-Food-Verdikt.
  const wrongVerdict = {
    category: 'Grundnahrungsmittel',
    canonicalCategory: { main: 'Grundnahrungsmittel', isNonFood: false, confidence: 0.9 },
  };
  const leak = (name: string, storeChain: string, when = CURRENT): Offer =>
    ({ ...offer(storeChain, when), name, normalizedName: name.toLowerCase(), ...wrongVerdict }) as Offer;

  it('zaehlt klare Non-Food-Leaks und nennt begrenzte Beispiele im Markdown', () => {
    const leakNames = [
      'BABY BORN Puppe',
      'Damen BH-Top',
      '3D-Teppich',
      'Auto-Organizer',
      'Nass-/Trockensauger',
      'Beistelltisch in Steinoptik',
      'Damen Culotte',
      'LUPILU Kinder-Planschbecken',
      'ADIDAS WM 2026 Match Ball',
      '7-Zonen-Komfortschaummatratze',
    ];
    const report = buildScanReport({
      offers: [
        ...Array.from({ length: 30 }, () => offer('Kaufland', CURRENT)),
        ...leakNames.slice(0, 5).map((name) => leak(name, 'Kaufland')),
      ],
      nextWeekOffers: leakNames.slice(5).map((name) => leak(name, 'ALDI SUED', UPCOMING)),
      filteredOffers: [],
      now,
    });

    expect(report.nonFoodLeakCount).toBe(10);
    expect(report.nonFoodLeakExamples.length).toBeLessThanOrEqual(8);
    expect(report.nonFoodLeakExamples).toContain('BABY BORN Puppe');

    const md = renderScanReportMarkdown(report);
    expect(md).toMatch(/Non-Food-Leak/i);
    expect(md).toContain('BABY BORN Puppe');
  });

  it('ohne Leaks: count 0 und keine Leak-Sektion im Markdown', () => {
    const report = buildScanReport({
      offers: [offer('Kaufland', CURRENT)],
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    expect(report.nonFoodLeakCount).toBe(0);
    expect(report.nonFoodLeakExamples).toHaveLength(0);
    expect(renderScanReportMarkdown(report)).not.toMatch(/Non-Food-Leak/i);
  });

  it('korrekt gefiltertes Non-Food zaehlt nicht als Leak', () => {
    const report = buildScanReport({
      offers: [offer('Kaufland', CURRENT)],
      nextWeekOffers: [],
      filteredOffers: [leak('BABY BORN Puppe', 'Kaufland')],
      now,
    });
    expect(report.nonFoodLeakCount).toBe(0);
  });
});

describe('Food-Rescue im Scan-Report', () => {
  // Gerettete Angebote tragen den food_rescue-Tag; Review-Faelle sind
  // gefilterte Angebote ohne Non-Food-Beleg und ohne starkes Food-Signal.
  const rescued = (name: string, storeChain: string): Offer =>
    ({
      ...offer(storeChain, CURRENT),
      name,
      normalizedName: name.toLowerCase(),
      tags: ['food_rescue'],
    }) as Offer;
  const modelFiltered = (name: string, storeChain: string): Offer =>
    ({
      ...offer(storeChain, CURRENT),
      name,
      normalizedName: name.toLowerCase(),
      foodFlag: 'nonfood',
      canonicalCategory: { isNonFood: true, confidence: 0.7 },
    }) as Offer;

  it('zaehlt gerettete und Review-Faelle pro Store mit Beispielen', () => {
    const report = buildScanReport({
      offers: [rescued('Surimi Sticks', 'Kaufland'), offer('Kaufland', CURRENT)],
      nextWeekOffers: [rescued('Steinofen-Pizza Salami', 'Lidl')],
      filteredOffers: [
        modelFiltered('Mystery Artikel 3000', 'Kaufland'),
        modelFiltered('BABY BORN Puppe', 'Kaufland'),
      ],
      now,
    });

    expect(report.foodRescue.rescuedCount).toBe(2);
    expect(report.foodRescue.reviewNeededFoodFilteredCount).toBe(1);

    const kaufland = report.foodRescue.stores.find((s) => s.storeChain === 'Kaufland');
    expect(kaufland?.rescuedCount).toBe(1);
    expect(kaufland?.rescuedExamples).toContain('Surimi Sticks');
    expect(kaufland?.reviewNeededCount).toBe(1);
    expect(kaufland?.reviewNeededExamples).toContain('Mystery Artikel 3000');

    const md = renderScanReportMarkdown(report);
    expect(md).toMatch(/Food-Rescue/);
    expect(md).toContain('Surimi Sticks');
    expect(md).toContain('Mystery Artikel 3000');
  });

  it('ohne Rescue-/Review-Faelle: counts 0 und keine Food-Rescue-Sektion', () => {
    const report = buildScanReport({
      offers: [offer('Kaufland', CURRENT)],
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    expect(report.foodRescue.rescuedCount).toBe(0);
    expect(report.foodRescue.reviewNeededFoodFilteredCount).toBe(0);
    expect(renderScanReportMarkdown(report)).not.toMatch(/Food-Rescue/);
  });
});

describe('buildScanReport — Datenqualität: Blumen-Leaks & falsch gefiltertes Food', () => {
  function flower(name: string, storeChain = 'Kaufland'): Offer {
    return {
      ...offer(storeChain, CURRENT),
      name,
      normalizedName: name.toLowerCase(),
      category: 'Obst/Gemuese',
      ...({ sourceCategoryRaw: 'Obst, Gemüse, Pflanzen' } as Partial<Offer>),
    };
  }
  function filteredFood(name: string): Offer {
    return {
      ...offer('ALDI SUED', CURRENT),
      name,
      normalizedName: name.toLowerCase(),
      ...({ foodFlag: 'nonfood', canonicalCategory: { isNonFood: true } } as Partial<Offer>),
    };
  }

  it('nonFoodLeakCount erkennt sichtbare Blumen, bevor der Gate sie entfernt', () => {
    const report = buildScanReport({
      offers: [flower('Chrysantheme'), flower('Rosen'), offer('Kaufland', CURRENT)],
      nextWeekOffers: [flower('Großköpfige Hochland Rosen', 'Netto')],
      filteredOffers: [],
      now,
    });
    expect(report.nonFoodLeakCount).toBe(3);
    expect(report.nonFoodLeakExamples).toContain('Chrysantheme');
  });

  it('likelyFoodWronglyFilteredCount zählt Food mit starkem Signal im Filtered-Bucket', () => {
    const report = buildScanReport({
      offers: [offer('ALDI SUED', CURRENT)],
      nextWeekOffers: [],
      filteredOffers: [filteredFood('Basilikum gerebelt'), filteredFood('Dillspitzen')],
      now,
    });
    expect(report.likelyFoodWronglyFilteredCount).toBe(2);
    expect(report.likelyFoodWronglyFilteredExamples).toContain('Basilikum gerebelt');
  });
});

describe('buildScanReport — Status-/Report-Schema & Zählkonsistenz (P4)', () => {
  function named(name: string, bucketStore = 'REWE', extra: Partial<Offer> = {}): Offer {
    return { ...offer(bucketStore, CURRENT), name, normalizedName: name.toLowerCase(), ...extra };
  }

  it('liefert die zentrale Drei-Wege-Aufschlüsselung + first-class Felder', () => {
    const report = buildScanReport({
      offers: [named('Grillkäse Natur')], // confirmed_food sichtbar
      nextWeekOffers: [],
      filteredOffers: [
        named('Damen BH-Top'), // confirmed_non_food
        named('Celebrations'), // uncertain (Review)
        named('Rama'), // uncertain (Review)
      ],
      now,
    });
    const fd = report.foodDecisionSummary;
    expect(fd.confirmedFoodVisibleCount).toBe(1);
    expect(fd.confirmedNonFoodFilteredCount).toBe(1);
    expect(fd.uncertainFilteredCount).toBe(2);
    // first-class P4-Felder spiegeln die Summary, keine pauschale Gleichsetzung.
    expect(report.unresolvedReviewCount).toBe(fd.uncertainFilteredCount);
    expect(report.gateConflicts.count).toBe(fd.wrongFoodFilteredCount);
    // Vor einem Commit ist das strukturell 0 (kein zeitlich gültiges Food im Filter).
    expect(report.gateConflicts.count).toBe(0);
  });

  it('Gate-Konflikt: zeitlich gültiges confirmed_food im Filter erscheint mit Count + Beispielen', () => {
    const report = buildScanReport({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [named('Bratwurst grob')], // confirmed_food, zeitlich gültig
      now,
    });
    expect(report.gateConflicts.count).toBe(1);
    expect(report.gateConflicts.examples).toContain('Bratwurst grob');
    expect(report.foodDecisionSummary.wrongFoodFilteredCount).toBe(1);
  });

  it('Invariante: reviewDimension.uncertain* === foodDecisionSummary.uncertain* (auch mit Lock/Fragment)', () => {
    const report = buildScanReport({
      offers: [named('Grillkäse Natur'), named('Celebrations')], // food + uncertain sichtbar
      nextWeekOffers: [],
      filteredOffers: [
        named('Damen BH-Top'), // confirmed_non_food
        named('Rama'), // uncertain
        named('Gold'), // uncertain
        named('Celebrations', 'REWE', { aiLocked: true } as Partial<Offer>), // Lock → kein uncertain
        named('Tiefpreis', 'REWE', { tags: ['name_fragment'] } as Partial<Offer>), // Fragment → kein uncertain
      ],
      now,
    });
    expect(report.reviewDimension.uncertainFilteredCount).toBe(
      report.foodDecisionSummary.uncertainFilteredCount,
    );
    expect(report.reviewDimension.uncertainVisibleCount).toBe(
      report.foodDecisionSummary.uncertainVisibleCount,
    );
    // Konkret: Rama + Gold = 2; Lock/Fragment zählen NICHT als uncertain.
    expect(report.foodDecisionSummary.uncertainFilteredCount).toBe(2);
    expect(report.foodDecisionSummary.uncertainVisibleCount).toBe(1); // Celebrations sichtbar
  });
});

// Regression für den /api/offers/scan-report-Crash: der Report MUSS über einem
// repräsentativen Snapshot-Shape (Textil-Non-Food + Spritzring-Cache-Konflikt +
// kernarm-Namensfragment + echtes Food) sauber bauen UND serialisierbar sein —
// kein zirkuläres/riesiges Feld darf JSON.stringify (= response.json) sprengen.
// Die fachliche Review-Queue-Regel bleibt dabei festgenagelt.
describe('buildScanReport — Review-Queue + Serialisierbarkeit (scan-report Route)', () => {
  function withName(name: string, extra: Partial<Offer> = {}, store = 'Kaufland'): Offer {
    return { ...offer(store, CURRENT), name, normalizedName: name.toLowerCase(), ...extra };
  }

  it('food_like enthält nur Spritzring, kernarm bleibt name_quality, Report ist serialisierbar', () => {
    const report = buildScanReport({
      offers: [withName('Grillkäse Natur')], // echtes Food → kein Leak
      nextWeekOffers: [],
      filteredOffers: [
        withName('Kinder-Poncho »Paw Patrol«'), // confirmed_non_food (Textil)
        withName('Kinder-Tankini »Paw Patrol«'), // confirmed_non_food (Textil)
        withName('Spritzring', { foodFlag: 'food' } as Partial<Offer>), // uncertain + food → food_like
        withName('kernarm', { tags: ['name_quality'] }), // Namensfragment → name_quality
      ],
      now,
    });

    // Spritzring ist bewusst der EINZIGE food-like Review-Fall.
    expect(report.reviewQueue.foodLikeReview.count).toBe(1);
    expect(report.reviewQueue.foodLikeReview.examples).toEqual(['Spritzring']);
    // kernarm bleibt eine Namensqualitäts-Klasse, NIE in der Food-Liste.
    expect(report.reviewQueue.nameQualityReview.count).toBe(1);
    expect(report.reviewQueue.nameQualityReview.examples).toContain('kernarm');
    // Textil-Regel: Poncho/Tankini sind confirmed_non_food → kein Review-Fall.
    expect(report.foodDecisionSummary.confirmedNonFoodFilteredCount).toBeGreaterThanOrEqual(2);
    // Keine fälschlich sichtbaren Non-Food-Leaks, kein fälschlich gefiltertes Food.
    expect(report.nonFoodLeakCount).toBe(0);
    expect(report.likelyFoodWronglyFilteredCount).toBe(0);

    // Der Report MUSS verlustfrei serialisierbar sein (genau das, was die Route
    // über response.json tut). Wirft JSON.stringify (zirkulär/Stack), stürbe die
    // Antwort — hier wird es als Test festgehalten.
    let serialized = '';
    expect(() => {
      serialized = JSON.stringify(report);
    }).not.toThrow();
    const roundTripped = JSON.parse(serialized);
    expect(roundTripped.reviewQueue.foodLikeReview.examples).toEqual(['Spritzring']);
  });
});

describe('buildScanReport — per Policy deaktivierte Shops (ALDI/Lidl/EDEKA)', () => {
  it('zeigt ALDI/Lidl/EDEKA als disabled, nie in criticalStores, ohne Mindestmengen-Warnung', () => {
    const report = buildScanReport({
      // Snapshot ist nach dem Purge frei von ALDI/Lidl/EDEKA — nur weiterlaufende Shops.
      offers: [
        ...Array.from({ length: 50 }, () => offer('Kaufland', CURRENT)),
        ...Array.from({ length: 30 }, () => offer('PENNY', CURRENT)),
      ],
      nextWeekOffers: [],
      filteredOffers: [],
      disabledStores: ['ALDI SÜD', 'ALDI NORD', 'Lidl', 'EDEKA'],
      now,
    });

    // Keiner der deaktivierten Shops ist critical.
    expect(report.criticalStores).not.toContain('ALDI SÜD');
    expect(report.criticalStores).not.toContain('ALDI NORD');
    expect(report.criticalStores).not.toContain('Lidl');
    expect(report.criticalStores).not.toContain('EDEKA');

    // Sie erscheinen klar als 'disabled' im Import-Health.
    const health = report.storeImportHealth.stores;
    for (const chain of ['ALDI SÜD', 'ALDI NORD', 'Lidl', 'EDEKA']) {
      const row = health.find((s) => s.storeChain === chain);
      expect(row, `${chain} fehlt im Health-Report`).toBeTruthy();
      expect(row!.importHealth).toBe('disabled');
      // Keine Mindestmengen-/Completeness-Warnung — nur die Policy-Begründung.
      expect(row!.warnings.join(' ')).toMatch(/deaktiviert/i);
      expect(row!.warnings.join(' ')).not.toMatch(/Minimum|erwartet/i);
    }
    // Weiterlaufende Shops bleiben sichtbar und nicht-disabled.
    expect(health.find((s) => s.storeChain === 'Kaufland')!.importHealth).not.toBe('disabled');
  });
});

describe('Lidl manual import diagnostics', () => {
  it('buildLidlManualImportReport mappt Queue-Summary + Meta korrekt', () => {
    const report = buildLidlManualImportReport(
      {
        pending: 5,
        approved: 2,
        committed: 3,
        withCropImageCount: 8,
        rejectedByReason: { price_is_deposit: 1, no_name: 2 },
      },
      { lastImportAt: '2026-06-27T10:00:00.000Z', pagesScanned: 12, candidatesFound: 10 },
    );
    expect(report).toMatchObject({
      queuePending: 5,
      approvedNotCommitted: 2,
      committedCount: 3,
      imageEvidenceCount: 8,
      pagesScanned: 12,
      candidatesFound: 10,
    });
    expect(report.rejectedByReason.no_name).toBe(2);
  });

  it('surfaced im Report ohne Lidl critical zu machen, Default ist leer', () => {
    const report = buildScanReport({
      offers: [offer('Kaufland')],
      nextWeekOffers: [],
      filteredOffers: [],
      now,
      disabledStores: ['Lidl', 'EDEKA'],
      lidlManualImport: buildLidlManualImportReport(
        { pending: 1, approved: 1, committed: 1, withCropImageCount: 2, rejectedByReason: {} },
        { lastImportAt: '2026-06-27T10:00:00.000Z', pagesScanned: 4, candidatesFound: 3 },
      ),
    });
    expect(report.criticalStores).not.toContain('Lidl');
    expect(report.lidlManualImport.committedCount).toBe(1);
    const md = renderScanReportMarkdown(report);
    expect(md).toMatch(/Lidl Prospekt-Import \(manuell\)/);
    expect(md).toMatch(/manual_review_import|deaktiviert/);

    // Default ohne Input bleibt leer (keine Coverage-Behauptung).
    const empty = buildScanReport({ offers: [], nextWeekOffers: [], filteredOffers: [], now });
    expect(empty.lidlManualImport).toEqual(emptyLidlManualImportReport());
  });
});

describe('criticalStores — belegter nahkauf-source-gap ist kein Defekt', () => {
  const sourceGapDiag = {
    generatedAt: '2026-06-03T11:00:00.000Z',
    sourceUrl: 'https://www.nahkauf.de/angebote-im-markt/',
    pageSource: 'home_fallback' as const,
    blocked: false,
    tokenFound: true,
    offerStoryCount: 0,
    importedDistinct: 0,
    offersLinkToRewe: true,
    sourceGap: true,
    marketIdConfigured: false,
  };

  it('nahkauf mit source-gap-Diagnose: warning-Zeile, NICHT in criticalStores', () => {
    const report = buildScanReport({
      offers: [offer('Kaufland', CURRENT)],
      nextWeekOffers: [],
      filteredOffers: [],
      nahkauf: sourceGapDiag,
      now,
    });
    expect(report.criticalStores).not.toContain('nahkauf');
    const row = report.storeImportHealth.stores.find((s) => s.storeChain === 'nahkauf');
    expect(row?.importHealth).toBe('warning');
    expect(row?.webVerification).toBe('ok');
    expect((row?.warnings ?? []).join(' ')).toContain('source-gap');
    expect(report.nahkauf?.sourceGap).toBe(true);
  });

  it('ohne Diagnose bleibt 0-Angebote-nahkauf ehrlich in criticalStores', () => {
    const report = buildScanReport({
      offers: [offer('Kaufland', CURRENT)],
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    expect(report.criticalStores).toContain('nahkauf');
  });
});
