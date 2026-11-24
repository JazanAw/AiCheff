import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  computeStoreImportHealth,
  edekaImportVerdict,
  aldiNordImportVerdict,
  aldiSuedImportVerdict,
  nahkaufImportVerdict,
  findStoreSourceGaps,
  type StoreImportHealthInput,
} from './storeImportHealth';
import { buildStoreExpectations } from './storeCompleteness';
import type {
  EdekaImportDiagnostics,
  AldiNordImportDiagnostics,
  AldiSuedImportDiagnostics,
  NahkaufImportDiagnostics,
} from '../../src/services/offersIngest/sourceConnectors/officialSupermarketConnector';

function nahkaufDiag(
  overrides: Partial<NahkaufImportDiagnostics> = {},
): NahkaufImportDiagnostics {
  return {
    generatedAt: '2026-06-03T11:00:00.000Z',
    sourceUrl: 'https://www.nahkauf.de/angebote-im-markt/',
    pageSource: 'offers_page',
    blocked: false,
    tokenFound: true,
    offerStoryCount: 120,
    importedDistinct: 34,
    offersLinkToRewe: false,
    sourceGap: false,
    marketIdConfigured: false,
    lastSuccessfulAt: '2026-06-03T11:00:00.000Z',
    ...overrides,
  };
}

function aldiNordDiag(overrides: Partial<AldiNordImportDiagnostics> = {}): AldiNordImportDiagnostics {
  return {
    generatedAt: '2026-06-03T11:00:00.000Z',
    sourceUrl: 'https://www.aldi-nord.de/angebote.html',
    apiDataFound: true,
    blocked: false,
    structuredProductsFound: 40,
    productsWithPrice: 40,
    productsWithValidity: 40,
    productsWithImage: 38,
    futureProducts: 8,
    currentProducts: 32,
    importedDistinct: 40,
    duplicatesMerged: 0,
    areaCount: 6,
    missingPriceExamples: [],
    missingValidityExamples: [],
    missingImageExamples: [],
    lastSuccessfulAt: '2026-06-03T11:00:00.000Z',
    ...overrides,
  };
}

function aldiSuedDiag(
  overrides: Partial<AldiSuedImportDiagnostics> = {},
): AldiSuedImportDiagnostics {
  return {
    generatedAt: '2026-06-03T11:00:00.000Z',
    sourceUrlsChecked: [
      {
        url: 'https://www.aldi-sued.de/produkte/wochenangebote/frischeprodukte-im-angebot/k/1588161427299187',
        status: 200,
        contentType: 'text/html;charset=utf-8',
        blocked: false,
        htmlProductCards: 8,
        embeddedJsonFound: true,
        jsonLdOffers: 0,
        dataGridDataCount: 0,
        apiCandidatesFound: 0,
        productsParsed: 8,
      },
    ],
    structuredProductsFound: 26,
    productsWithPrice: 26,
    productsWithImage: 25,
    productsWithValidity: 26,
    currentProducts: 24,
    futureProducts: 2,
    importedDistinct: 26,
    duplicatesMerged: 0,
    missingPriceExamples: [],
    missingImageExamples: [],
    missingValidityExamples: [],
    verdict: 'ok',
    blocked: false,
    lastSuccessfulAt: '2026-06-03T11:00:00.000Z',
    ...overrides,
  };
}

function edekaDiag(overrides: Partial<EdekaImportDiagnostics> = {}): EdekaImportDiagnostics {
  return {
    generatedAt: '2026-06-03T11:00:00.000Z',
    sourceUrl: 'https://www.edeka.de/angebote',
    blocked: false,
    pageLooksLikeOffers: true,
    marketScope: 'national',
    offerBlocks: 23,
    candidates: 11,
    withOfferPrice: 11,
    importedDistinct: 11,
    duplicatesMerged: 0,
    rejectedByReason: { kein_name: 0, kein_angebotspreis: 12, kein_preis: 0 },
    rejectedExamples: ['Toastbrot (kein_angebotspreis)'],
    brokenImageCount: 0,
    lastSuccessfulAt: '2026-06-03T11:00:00.000Z',
    validityStartSeen: '2026-06-08T00:00:00.000Z',
    ...overrides,
  };
}

const now = new Date('2026-06-03T12:00:00.000Z'); // Wed of week Mon 06-01 .. Sun 06-07

function offer(overrides: Partial<Offer> & Record<string, unknown> = {}): Offer {
  return {
    id: Math.random().toString(36).slice(2),
    name: 'Ware',
    normalizedName: 'ware',
    storeChain: 'Kaufland',
    category: 'Sonstiges',
    price: 1.99,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: '2026-06-01T00:00:00.000Z',
    validityEnd: '2026-06-06T23:59:59.999Z',
    imageUrl: 'https://img/x.png',
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  } as Offer;
}

function rowFor(report: ReturnType<typeof computeStoreImportHealth>, chain: string) {
  return report.stores.find((store) => store.storeChain === chain);
}

describe('computeStoreImportHealth', () => {
  it('reports per-store strategy, counts, food/non-food split and broken images', () => {
    const input: StoreImportHealthInput = {
      offers: [
        offer({ id: 'k1', storeChain: 'Kaufland', name: 'Milch' }),
        offer({ id: 'k2', storeChain: 'Kaufland', name: 'Käse', imageStatus: 'broken', brokenImage: true }),
      ],
      nextWeekOffers: [
        offer({
          id: 'k3',
          storeChain: 'Kaufland',
          name: 'Butter',
          validityStart: '2026-06-08T00:00:00.000Z',
          validityEnd: '2026-06-13T23:59:59.999Z',
        }),
      ],
      filteredOffers: [offer({ id: 'k4', storeChain: 'Kaufland', name: 'NIVEA Duschgel', tags: ['nonfood'] })],
      now,
    };
    const report = computeStoreImportHealth(input);
    const kaufland = rowFor(report, 'Kaufland');
    expect(kaufland).toBeDefined();
    expect(kaufland?.strategy).toBe('embedded_json');
    expect(kaufland?.currentCount).toBe(2);
    expect(kaufland?.nextWeekCount).toBe(1);
    expect(kaufland?.foodCount).toBe(3); // current + next are food
    expect(kaufland?.nonFoodCount).toBe(1);
    expect(kaufland?.filteredCount).toBe(1);
    expect(kaufland?.brokenImageCount).toBe(1);
  });

  it('teilt den Filtered-Bucket ehrlich in non-food / review / food-Verdacht (zentrale Klassifikation)', () => {
    // Drei gefilterte REWE-Angebote: ein klares Non-Food (Drogerie), ein
    // falsch gefiltertes Food (rescue) und ein ungeklärter Review-Fall.
    const report = computeStoreImportHealth({
      offers: [offer({ id: 'r1', storeChain: 'REWE', name: 'Bananen' })],
      nextWeekOffers: [],
      filteredOffers: [
        offer({ id: 'f1', storeChain: 'REWE', name: 'Pampers Baby Dry', sourceCategoryRaw: 'Drogerie' }),
        offer({ id: 'f2', storeChain: 'REWE', name: 'ja! Erdnüsse', sourceCategoryRaw: 'Fan-Momente zum Angrillen!' }),
        offer({ id: 'f3', storeChain: 'REWE', name: 'Mars m&m’s', sourceCategoryRaw: 'Fan-Momente zum Angrillen!' }),
      ],
      now,
    });
    const rewe = rowFor(report, 'REWE');
    expect(rewe?.filteredCount).toBe(3);
    expect(rewe?.nonFoodCount).toBe(1); // nur regelbestätigtes Non-Food (Pampers)
    expect(rewe?.foodSuspectCount).toBe(1); // Erdnüsse → rescue-Verdacht
    expect(rewe?.reviewCount).toBe(1); // m&m’s → review
    // nonFoodCount darf NIE die gesamte Filtered-Zahl sein.
    expect(rewe?.nonFoodCount).not.toBe(rewe?.filteredCount);
  });

  it('uses the Kaufland completeness for an honest missingEstimate', () => {
    const report = computeStoreImportHealth({
      offers: [offer({ id: 'k1', storeChain: 'Kaufland' })],
      nextWeekOffers: [],
      filteredOffers: [],
      officialCounts: { kaufland: 400 },
      kauflandCompleteness: {
        officialFoodishCount: 400,
        officialDistinctFoodCount: 400,
        matchedCount: 1,
        matchedFilteredCount: 0,
        matchedFilteredNonFoodCount: 0,
        matchedFilteredUnconfirmedCount: 0,
        missingEstimate: 399,
        missingExamples: ['K-CLASSIC Kondensmilch'],
        unmatchedImportedCount: 0,
        importedCurrentCount: 1,
        comparisonScope: 'Vergleich: distinct Namen der offiziellen aktuellen Food-Woche.',
      },
      now,
    });
    const kaufland = rowFor(report, 'Kaufland');
    expect(kaufland?.missingEstimate).toBe(399);
    expect(kaufland?.importHealth).toBe('critical'); // far below expected → not "complete"
  });

  it('always lists REWE as browser_required and is honest when nothing was imported', () => {
    const report = computeStoreImportHealth({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    const rewe = rowFor(report, 'REWE');
    expect(rewe).toBeDefined();
    expect(rewe?.strategy).toBe('browser_required');
    expect(rewe?.webVerification).toBe('unverified');
    expect(rewe?.importHealth).toBe('critical'); // no browser/PDF import yet
    expect(rewe?.browserImportAvailable).toBe(false);
    expect(rewe?.pdfImportAvailable).toBe(false);
  });

  it('marks REWE as imported when browser-import offers are present', () => {
    // Realistischer Snapshot: 38 aktuelle REWE-Angebote (= normalizedCount), damit
    // der ehrliche Dünnheits-Check (verdächtig wenige aktuelle Angebote) nicht
    // greift — ein voller Import bleibt ok.
    const reweOffers = Array.from({ length: 38 }, (_, index) =>
      offer({ id: `r${index}`, storeChain: 'REWE', name: `REWE Ware ${index}`, tags: ['rewe', 'browser-import'] }),
    );
    const report = computeStoreImportHealth({
      offers: reweOffers,
      nextWeekOffers: [],
      filteredOffers: [],
      rewe: {
        method: 'browser',
        report: {
          rawCount: 40,
          normalizedCount: 38,
          reviewCount: 1,
          skippedCount: 1,
          skippedFragments: [],
          suspiciousPrices: [],
          duplicateCandidates: [],
          categoryCorrections: [],
          importHealth: 'ok',
          webVerification: 'blocked',
          possibleWebMissingEstimate: 2,
        },
      },
      now,
    });
    const rewe = rowFor(report, 'REWE');
    expect(rewe?.webVerification).toBe('imported');
    expect(rewe?.importHealth).toBe('ok');
    expect(rewe?.browserImportAvailable).toBe(true);
    expect(rewe?.pdfImportAvailable).toBe(false);
    expect(rewe?.fetchedCount).toBe(40); // from the REWE import report
    expect(rewe?.parsedCount).toBe(38);
    expect(rewe?.missingEstimate).toBe(2);
  });

  it('keeps REWE out of critical when a manual import exists, even if the web is blocked', () => {
    // Reale Lage: REWE per Browser/PDF importiert (65 Live), aber der Web-Fetch
    // ist 403/Captcha-blockiert und der Report meldet importHealth "critical".
    // Mit vorhandenem Import darf das NICHT critical sein — höchstens warning.
    const reweOffers = Array.from({ length: 65 }, (_, index) =>
      offer({ id: `r${index}`, storeChain: 'REWE', name: `REWE Ware ${index}`, tags: ['rewe', 'browser-import'] }),
    );
    const report = computeStoreImportHealth({
      offers: reweOffers,
      nextWeekOffers: [],
      filteredOffers: [],
      rewe: {
        method: 'browser',
        report: {
          rawCount: 65,
          normalizedCount: 65,
          reviewCount: 2,
          skippedCount: 0,
          skippedFragments: [],
          suspiciousPrices: [],
          duplicateCandidates: [],
          categoryCorrections: [],
          importHealth: 'critical',
          webVerification: 'blocked',
          requiresLayoutFallback: true,
          possibleWebMissingEstimate: 4,
        },
      },
      now,
    });
    const rewe = rowFor(report, 'REWE');
    expect(rewe?.webVerification).toBe('imported');
    expect(rewe?.importHealth).toBe('warning'); // nicht critical, weil importiert
    // Report zeigt den echten Import-Weg statt "browser_required".
    expect(rewe?.strategy).toBe('browser_import');
    expect(rewe?.browserImportAvailable).toBe(true);
  });

  it('flags a REWE web fetch that was blocked (captcha/403) without imported data', () => {
    const report = computeStoreImportHealth({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [],
      rewe: { method: null, report: { rawCount: 0, normalizedCount: 0, reviewCount: 0, skippedCount: 0, skippedFragments: [], suspiciousPrices: [], duplicateCandidates: [], categoryCorrections: [], webVerification: 'blocked', importHealth: 'critical' } },
      now,
    });
    const rewe = rowFor(report, 'REWE');
    expect(rewe?.webVerification).toBe('blocked');
    expect(rewe?.importHealth).toBe('critical');
  });

  it('keeps Lidl critical when the leaflet import collapsed (1 offer)', () => {
    // Historischer Fehlerfall: nur 1 strukturiertes Lidl-Angebot. Mit der
    // ehrlichen Food-Erwartung (15, Prospekt liefert v. a. Wein + Non-Food)
    // bleibt der Kollaps critical, ein normaler Import (18 Food) wird gruen.
    const report = computeStoreImportHealth({
      offers: [offer({ id: 'lidl_1', storeChain: 'Lidl', name: 'Strauchtomaten' })],
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    const lidl = rowFor(report, 'Lidl');
    expect(lidl?.strategy).toBe('embedded_json');
    expect(lidl?.currentCount).toBe(1);
    expect(lidl?.importHealth).toBe('critical');

    // Ein funktionierender Teilimport (18 Food) ist hoechstens warning — die
    // Quelle liefert strukturiert nur einen Teil des Sortiments (coverage
    // structured_only), das darf nie als uneingeschraenkt "ok" erscheinen.
    const partial = computeStoreImportHealth({
      offers: Array.from({ length: 18 }, (_, index) =>
        offer({ id: `lidl_${index}`, storeChain: 'Lidl', name: `Lidl Ware ${index}` }),
      ),
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    const partialRow = rowFor(partial, 'Lidl');
    expect(partialRow?.importHealth).toBe('warning');
    expect(partialRow?.importCoverage).toBe('structured_only');
    expect(partialRow?.warnings.join(' ')).toMatch(/Teilimport/);
  });

  it('keeps Kaufland a warning (not green) and preserves the missing diagnosis', () => {
    // Kaufland: ~330 aktuelle Angebote bei offiziell 644 -> ~52 % -> warning.
    const kauflandOffers = Array.from({ length: 330 }, (_, index) =>
      offer({ id: `kf_${index}`, storeChain: 'Kaufland', name: `K-Classic ${index}` }),
    );
    const report = computeStoreImportHealth({
      offers: kauflandOffers,
      nextWeekOffers: [],
      filteredOffers: [],
      officialCounts: { kaufland: 644 },
      kauflandCompleteness: {
        officialFoodishCount: 644,
        importedCurrentCount: 330,
        missingEstimate: 314,
        missingExamples: ['K-CLASSIC Kondensmilch', 'Lavazza Espresso'],
      },
      now,
    });
    const kaufland = rowFor(report, 'Kaufland');
    expect(kaufland?.importHealth).toBe('warning');
    expect(kaufland?.importHealth).not.toBe('ok');
    expect(kaufland?.missingEstimate).toBe(314); // Diagnose bleibt erhalten
  });

  it('does not claim completeness for EDEKA (national_only, nie full/healthy)', () => {
    const report = computeStoreImportHealth({
      offers: [offer({ id: 'e1', storeChain: 'EDEKA', name: 'Apfel' })],
      nextWeekOffers: [],
      filteredOffers: [],
      // Keine frische Diagnose übergeben → in diesem Prozess kein Lauf.
      now,
    });
    const edeka = rowFor(report, 'EDEKA');
    // Quelle ist direkt lesbares HTML (Template "edeka_neu"), nicht mehr __NEXT_DATA__.
    expect(edeka?.strategy).toBe('direct_html');
    // Ohne frischen Lauf: nicht still ok, sondern ehrlich unverified.
    expect(edeka?.webVerification).toBe('unverified');
    expect(edeka?.importCoverage).toBe('national_only');
    expect(['warning', 'critical']).toContain(edeka?.importHealth);
  });
});

describe('computeStoreImportHealth — nahkauf ist NICHT REWE (Task 3)', () => {
  const reweReport = {
    rawCount: 96,
    normalizedCount: 96,
    reviewCount: 0,
    skippedCount: 0,
    skippedFragments: [],
    suspiciousPrices: [],
    duplicateCandidates: [],
    categoryCorrections: [],
    importHealth: 'ok' as const,
  };

  it('haengt die REWE-Importzahlen niemals an die nahkauf-Zeile', () => {
    const report = computeStoreImportHealth({
      offers: [offer({ id: 'r1', storeChain: 'REWE', tags: ['rewe', 'browser-import'] })],
      nextWeekOffers: [],
      filteredOffers: [],
      rewe: { method: 'browser', report: reweReport },
      now,
    });
    const nahkauf = rowFor(report, 'nahkauf');
    expect(nahkauf).toBeDefined();
    // nahkauf hat 0 echte Angebote → fetched/parsed duerfen NICHT 96 (REWE) sein.
    expect(nahkauf?.fetchedCount).toBeNull();
    expect(nahkauf?.parsedCount).toBeNull();
    expect(nahkauf?.currentCount).toBe(0);
    expect(nahkauf?.importHealth).toBe('critical');
    expect(nahkauf?.webVerification).not.toBe('imported');
    // Die REWE-Zeile bekommt die Zahlen weiterhin.
    const rewe = rowFor(report, 'REWE');
    expect(rewe?.fetchedCount).toBe(96);
  });

  it('zeigt nahkauf als api_endpoint-Store mit eigenen Zahlen, wenn Angebote da sind', () => {
    const report = computeStoreImportHealth({
      offers: [
        offer({ id: 'n1', storeChain: 'nahkauf', name: 'Oberdorfer Helles' }),
        offer({ id: 'n2', storeChain: 'nahkauf', name: 'Pringles Chips' }),
      ],
      nextWeekOffers: [],
      filteredOffers: [],
      rewe: { method: 'browser', report: reweReport },
      now,
    });
    const nahkauf = rowFor(report, 'nahkauf');
    expect(nahkauf?.strategy).toBe('api_endpoint');
    expect(nahkauf?.currentCount).toBe(2);
    expect(nahkauf?.fetchedCount).toBeNull(); // nie aus dem REWE-Report
    expect(nahkauf?.browserImportAvailable).toBeUndefined();
  });
});

describe('computeStoreImportHealth — Broken-Image-Eskalation (Netto)', () => {
  it('eskaliert einen Store mit fast nur kaputten Bildern auf critical', () => {
    const nettoOffers = Array.from({ length: 24 }, (_unused, index) =>
      offer({
        id: `netto_${index}`,
        storeChain: 'Netto',
        name: `Produkt ${index}`,
        imageStatus: 'broken',
        brokenImage: true,
      }),
    );
    const report = computeStoreImportHealth({
      offers: nettoOffers,
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    const netto = rowFor(report, 'Netto');
    expect(netto?.brokenImageCount).toBe(24);
    expect(netto?.brokenImageRate).toBe(1);
    expect(netto?.importHealth).toBe('critical');
    expect(netto?.webVerification).toBe('blocked');
    expect(netto?.warnings.join(' ')).toContain('kaputte Bilder');
  });

  it('markiert moderate Broken-Image-Raten mindestens als warning', () => {
    const offers = [
      ...Array.from({ length: 6 }, (_unused, index) =>
        offer({ id: `p_${index}`, storeChain: 'PENNY', name: `Produkt ${index}` }),
      ),
      ...Array.from({ length: 4 }, (_unused, index) =>
        offer({
          id: `pb_${index}`,
          storeChain: 'PENNY',
          name: `Kaputt ${index}`,
          imageStatus: 'broken',
          brokenImage: true,
        }),
      ),
    ];
    const report = computeStoreImportHealth({
      offers,
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    const penny = rowFor(report, 'PENNY');
    expect(penny?.brokenImageRate).toBe(0.4);
    expect(penny?.importHealth).not.toBe('ok');
  });
});

describe('computeStoreImportHealth — einseitiges Alkohol-Sortiment (Lidl-Fall)', () => {
  it('meldet hoechstens warning, wenn der sichtbare Feed fast nur Alkohol ist', () => {
    // Reproduktionsbeispiel: 38/38 sichtbare Lidl-Food-Angebote waren Alkohol.
    const offers = Array.from({ length: 38 }, (_unused, index) =>
      offer({
        id: `lidl_alk_${index}`,
        storeChain: 'Lidl',
        name: `Wein ${index}`,
        category: 'Alkohol',
      }),
    );
    const report = computeStoreImportHealth({
      offers,
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    const lidl = rowFor(report, 'Lidl');
    expect(lidl?.alcoholShare).toBe(1);
    expect(lidl?.importHealth).toBe('warning');
    expect(lidl?.warnings.join(' ')).toMatch(/Alkohol/);
  });

  it('laesst ein gemischtes Sortiment ohne Alkohol-Warnung durch', () => {
    const offers = [
      ...Array.from({ length: 4 }, (_unused, index) =>
        offer({ id: `p_alk_${index}`, storeChain: 'PENNY', name: `Bier ${index}`, category: 'Alkohol' }),
      ),
      ...Array.from({ length: 26 }, (_unused, index) =>
        offer({ id: `p_food_${index}`, storeChain: 'PENNY', name: `Ware ${index}`, category: 'Obst/Gemuese' }),
      ),
    ];
    const report = computeStoreImportHealth({
      offers,
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    const penny = rowFor(report, 'PENNY');
    expect(penny?.alcoholShare).toBeCloseTo(0.133, 2);
    expect(penny?.warnings.join(' ')).not.toMatch(/Alkohol/);
    expect(penny?.importHealth).toBe('ok');
  });

  it('wertet kleine Stichproben nicht (2 Weinangebote sind kein einseitiges Sortiment)', () => {
    const offers = Array.from({ length: 2 }, (_unused, index) =>
      offer({ id: `h_${index}`, storeChain: 'HIT', name: `Wein ${index}`, category: 'Alkohol' }),
    );
    const report = computeStoreImportHealth({
      offers,
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    expect(rowFor(report, 'HIT')?.warnings.join(' ')).not.toMatch(/Alkohol/);
  });
});

describe('computeStoreImportHealth — nahkauf Markt-Abdeckung', () => {
  const nahkaufOffers = Array.from({ length: 38 }, (_unused, index) =>
    offer({ id: `nk_${index}`, storeChain: 'nahkauf', name: `Ware ${index}`, category: 'Obst/Gemuese' }),
  );

  it('ohne Markt-ID: importCoverage national_only und hoechstens warning', () => {
    const report = computeStoreImportHealth({
      offers: nahkaufOffers,
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    const row = rowFor(report, 'nahkauf');
    expect(row?.importCoverage).toBe('national_only');
    expect(row?.importHealth).toBe('warning');
    expect(row?.warnings.join(' ')).toMatch(/lokale Marktangebote nicht verifiziert/);
  });

  it('mit Markt-ID-Expectations und importierten lokalen Angeboten: voll abgedeckt und ok', () => {
    const withLocal = [
      offer({
        id: 'nk_local',
        storeChain: 'nahkauf',
        name: 'Lokale Ware',
        category: 'Obst/Gemuese',
        tags: ['nahkauf-storyblok', 'nahkauf-local'],
      }),
      ...nahkaufOffers,
    ];
    const report = computeStoreImportHealth({
      offers: withLocal,
      nextWeekOffers: [],
      filteredOffers: [],
      // Frischer Lauf mit Diagnose (seit der nahkauf-Storyblok-Diagnose gilt ein
      // Snapshot OHNE Lauf ehrlich als unverified/warning — wie EDEKA/ALDI).
      nahkauf: nahkaufDiag({ marketIdConfigured: true, importedDistinct: withLocal.length }),
      expectations: buildStoreExpectations({ nahkaufMarketId: '320593' }),
      now,
    });
    const row = rowFor(report, 'nahkauf');
    expect(row?.importCoverage).toBe('full');
    expect(row?.importHealth).toBe('ok');
    // Der Report zeigt, dass eine Markt-ID aktiv ist.
    expect(row?.warnings.join(' ')).toContain('320593');
  });

  it('mit Markt-ID, aber nur nationalen Angeboten: national_only + warning statt false-positive ok', () => {
    const report = computeStoreImportHealth({
      offers: nahkaufOffers, // kein Angebot traegt das nahkauf-local-Tag
      nextWeekOffers: [],
      filteredOffers: [],
      expectations: buildStoreExpectations({ nahkaufMarketId: '320593' }),
      now,
    });
    const row = rowFor(report, 'nahkauf');
    expect(row?.importCoverage).toBe('national_only');
    expect(row?.importHealth).toBe('warning');
    expect(row?.warnings.join(' ')).toMatch(/Markt-ID/);
  });

  it('mit Markt-ID und 0 nahkauf-Angeboten: kein false-positive full, Scan bleibt nutzbar', () => {
    const report = computeStoreImportHealth({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [],
      expectations: buildStoreExpectations({ nahkaufMarketId: '320593' }),
      now,
    });
    const row = rowFor(report, 'nahkauf');
    expect(row?.importCoverage).toBe('national_only');
    expect(row?.importHealth).toBe('critical');
  });
});

describe('computeStoreImportHealth — Kaufland-Vollständigkeits-Eskalation', () => {
  const kauflandOffers = Array.from({ length: 300 }, (_unused, index) =>
    offer({ id: `kl_${index}`, storeChain: 'Kaufland', name: `Ware ${index}`, category: 'Obst/Gemuese' }),
  );
  const completeness = (overrides: Record<string, unknown>) => ({
    officialFoodishCount: 577,
    officialDistinctFoodCount: 369,
    matchedCount: 369,
    matchedFilteredCount: 0,
    matchedFilteredNonFoodCount: 0,
    matchedFilteredUnconfirmedCount: 0,
    missingEstimate: 0,
    missingExamples: [],
    unmatchedImportedCount: 0,
    importedCurrentCount: 369,
    comparisonScope: 'Vergleich: distinct Namen der offiziellen aktuellen Food-Woche.',
    ...overrides,
  });

  it('eskaliert auf warning, wenn > 10 % der offiziellen Food-Namen fehlen', () => {
    const report = computeStoreImportHealth({
      offers: kauflandOffers,
      nextWeekOffers: [],
      filteredOffers: [],
      officialCounts: { kaufland: 369 },
      kauflandCompleteness: completeness({
        matchedCount: 300,
        missingEstimate: 69,
        importedCurrentCount: 300,
        missingExamples: ['K-PURLAND Schweinenacken'],
      }) as never,
      now,
    });
    const kaufland = rowFor(report, 'Kaufland');
    expect(kaufland?.importHealth).toBe('warning');
    expect(kaufland?.warnings.join(' ')).toMatch(/69 von 369/);
  });

  it('eskaliert auf warning, wenn offizielles Food im Filtered-Bucket liegt', () => {
    const report = computeStoreImportHealth({
      offers: kauflandOffers,
      nextWeekOffers: [],
      // Echter Live-Befund: eine rescue-würdige Food-Position liegt im Filter
      // (zentrale Klassifikation 'rescue') — deckt die Completeness-Differenz.
      filteredOffers: [
        offer({
          id: 'kl_susp',
          storeChain: 'Kaufland',
          name: 'ja! Erdnüsse',
          sourceCategoryRaw: 'Fan-Momente zum Angrillen!',
        }),
      ],
      officialCounts: { kaufland: 369 },
      kauflandCompleteness: completeness({
        matchedCount: 360,
        matchedFilteredCount: 9,
        matchedFilteredNonFoodCount: 0,
        importedCurrentCount: 360,
      }) as never,
      now,
    });
    const kaufland = rowFor(report, 'Kaufland');
    expect(kaufland?.foodSuspectCount).toBeGreaterThan(0);
    expect(kaufland?.importHealth).toBe('warning');
    expect(kaufland?.warnings.join(' ')).toMatch(/Filtered-Bucket/);
  });

  it('setzt KEINE Food-in-Filter-Warnung, wenn matchedFiltered nur aus Review-Pflanzenfällen stammt (echter Live-Befund leer)', () => {
    // Reproduktion des Live-Stands (Kaufland KW 2026-06): Zierpflanzen aus der
    // offiziell food-bestätigten Mischabteilung liegen als 'review' im Filter
    // und blähen matchedFilteredCount auf, OHNE dass die zentrale Live-
    // Klassifikation echtes Food im Filter sieht (foodSuspect=0,
    // foodInFilterExamples leer). Das darf nicht als „2 offizielle Food-Angebote
    // … falsch als Non-Food einsortiert" eskalieren.
    const report = computeStoreImportHealth({
      offers: kauflandOffers,
      nextWeekOffers: [],
      filteredOffers: [
        // 'review' (kein Beleg in beide Richtungen) — Zierpflanze.
        offer({ id: 'kl_plant', storeChain: 'Kaufland', name: 'Kalanchoe im Übertopf' }),
        // regelbestätigtes Non-Food.
        offer({ id: 'kl_nf', storeChain: 'Kaufland', name: 'Spülmaschinen-Tabs', tags: ['nonfood'] }),
      ],
      officialCounts: { kaufland: 369 },
      kauflandCompleteness: completeness({
        matchedCount: 367,
        matchedFilteredCount: 2,
        matchedFilteredNonFoodCount: 0,
        matchedFilteredUnconfirmedCount: 5,
        importedCurrentCount: 367,
      }) as never,
      now,
    });
    const kaufland = rowFor(report, 'Kaufland');
    expect(kaufland?.foodSuspectCount).toBe(0);
    expect(kaufland?.foodInFilterExamples).toEqual([]);
    expect(kaufland?.warnings.join(' ')).not.toMatch(/offizielle Food-Angebot/);
    expect(kaufland?.importHealth).toBe('ok');
  });

  it('echtes Obst/Gemüse im Filter (rescue) erzeugt weiter die Food-in-Filter-Warnung', () => {
    const report = computeStoreImportHealth({
      offers: kauflandOffers,
      nextWeekOffers: [],
      filteredOffers: [
        offer({
          id: 'kl_veg',
          storeChain: 'Kaufland',
          name: 'ja! Erdnüsse',
          sourceCategoryRaw: 'Fan-Momente zum Angrillen!',
        }),
      ],
      officialCounts: { kaufland: 369 },
      kauflandCompleteness: completeness({
        matchedCount: 367,
        matchedFilteredCount: 2,
        importedCurrentCount: 367,
      }) as never,
      now,
    });
    const kaufland = rowFor(report, 'Kaufland');
    expect(kaufland?.foodSuspectCount).toBeGreaterThan(0);
    expect(kaufland?.importHealth).toBe('warning');
    expect(kaufland?.warnings.join(' ')).toMatch(/offizielle Food-Angebot/);
  });

  it('erklärte Review-Fälle aus gemischten Promo-Kategorien lösen KEINE Filtered-Warnung aus', () => {
    // Der Live-Fall: 25 echte Non-Food-Angebote (Holzkohle, Tankinis, …) aus
    // gemischten offiziellen Promo-Kategorien liegen ohne Beleg in beide
    // Richtungen im Filtered-Bucket — erklärt (reviewNeeded), kein Food-Verlust.
    const report = computeStoreImportHealth({
      offers: kauflandOffers,
      nextWeekOffers: [],
      filteredOffers: [],
      officialCounts: { kaufland: 300 },
      kauflandCompleteness: completeness({
        officialDistinctFoodCount: 394,
        matchedCount: 300,
        matchedFilteredCount: 0,
        matchedFilteredNonFoodCount: 69,
        matchedFilteredUnconfirmedCount: 25,
        importedCurrentCount: 300,
      }) as never,
      now,
    });
    const kaufland = rowFor(report, 'Kaufland');
    expect(kaufland?.importHealth).toBe('ok');
    expect(kaufland?.warnings.join(' ')).not.toMatch(/Filtered-Bucket/);
  });

  it('bleibt ok bei konsistentem, (fast) vollständigem Vergleich', () => {
    const report = computeStoreImportHealth({
      offers: kauflandOffers,
      nextWeekOffers: [],
      filteredOffers: [],
      officialCounts: { kaufland: 369 },
      kauflandCompleteness: completeness({ missingEstimate: 9, matchedCount: 360, importedCurrentCount: 360 }) as never,
      now,
    });
    expect(rowFor(report, 'Kaufland')?.importHealth).toBe('ok');
  });
});

describe('Non-Food-Leaks im sichtbaren Feed (current/next)', () => {
  // Reproduktions-Fixtures: klares Non-Food mit falschem KI-Food-Verdikt
  // ("Grundnahrungsmittel") darf einen Store nie als "ok" dastehen lassen.
  const wrongVerdict = {
    category: 'Grundnahrungsmittel',
    canonicalCategory: { main: 'Grundnahrungsmittel', isNonFood: false, confidence: 0.9 },
  };
  // ≥ 25 aktuelle Angebote, damit die Completeness-Heuristik (ABS_WARN) den
  // Store als healthy einstuft und hier nur die Leak-Eskalation gemessen wird.
  const cleanPenny = () =>
    Array.from({ length: 30 }, (_, i) =>
      offer({ id: `p${i}`, storeChain: 'PENNY', name: 'Joghurt Natur' }),
    );

  it('ohne Leaks: nonFoodLeakCount 0 und Health bleibt ok', () => {
    const report = computeStoreImportHealth({
      offers: cleanPenny(),
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    const penny = rowFor(report, 'PENNY');
    expect(penny?.nonFoodLeakCount).toBe(0);
    expect(penny?.nonFoodLeakExamples).toHaveLength(0);
    expect(penny?.importHealth).toBe('ok');
  });

  it('eskaliert einen Store mit klaren Non-Food-Leaks auf mindestens warning', () => {
    const report = computeStoreImportHealth({
      offers: [
        ...cleanPenny(),
        offer({ id: 'leak1', storeChain: 'PENNY', name: 'BABY BORN Puppe', ...wrongVerdict }),
      ],
      nextWeekOffers: [
        offer({ id: 'leak2', storeChain: 'PENNY', name: 'Damen BH-Top', ...wrongVerdict }),
      ],
      filteredOffers: [],
      now,
    });
    const penny = rowFor(report, 'PENNY');
    expect(penny?.nonFoodLeakCount).toBe(2);
    expect(penny?.nonFoodLeakExamples).toContain('BABY BORN Puppe');
    expect(penny?.importHealth).toBe('warning');
    expect(penny?.warnings.join(' ')).toMatch(/Non-Food/i);
  });

  it('viele Leaks (>= 10) sind critical', () => {
    const leaks = Array.from({ length: 10 }, (_, i) =>
      offer({ id: `leak${i}`, storeChain: 'PENNY', name: `Damen Kleid ${i}`, ...wrongVerdict }),
    );
    const report = computeStoreImportHealth({
      offers: [...cleanPenny(), ...leaks],
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    const penny = rowFor(report, 'PENNY');
    expect(penny?.nonFoodLeakCount).toBe(10);
    expect(penny?.importHealth).toBe('critical');
  });

  it('korrekt gefiltertes Non-Food (filteredOffers) zaehlt NICHT als Leak', () => {
    const report = computeStoreImportHealth({
      offers: cleanPenny(),
      nextWeekOffers: [],
      filteredOffers: [
        offer({ id: 'ok1', storeChain: 'PENNY', name: 'BABY BORN Puppe', tags: ['nonfood'] }),
      ],
      now,
    });
    const penny = rowFor(report, 'PENNY');
    expect(penny?.nonFoodLeakCount).toBe(0);
    expect(penny?.importHealth).toBe('ok');
  });
});

describe('computeStoreImportHealth — REWE ehrliche Vollständigkeit (Shop-Prompt 2)', () => {
  function reweReport(overrides: Record<string, unknown> = {}) {
    return {
      rawCount: 16,
      normalizedCount: 16,
      reviewCount: 0,
      skippedCount: 0,
      skippedFragments: [],
      suspiciousPrices: [],
      duplicateCandidates: [],
      categoryCorrections: [],
      importHealth: 'ok' as const,
      webVerification: 'blocked' as const,
      ...overrides,
    };
  }

  it('meldet bei nur 16 aktuellen REWE-Angeboten warning, nicht ok', () => {
    const reweOffers = Array.from({ length: 16 }, (_, index) =>
      offer({ id: `r${index}`, storeChain: 'REWE', name: `REWE Ware ${index}`, tags: ['rewe', 'browser-import'] }),
    );
    const report = computeStoreImportHealth({
      offers: reweOffers,
      nextWeekOffers: [],
      filteredOffers: [],
      rewe: { method: 'browser', report: reweReport() },
      now,
    });
    const rewe = rowFor(report, 'REWE');
    expect(rewe?.currentCount).toBe(16);
    expect(rewe?.importHealth).toBe('warning'); // sauberer Report, aber verdächtig dünn
    expect(rewe?.webVerification).toBe('imported');
  });

  it('eskaliert auf warning, wenn die Seite deutlich mehr Kacheln zeigt als importiert', () => {
    const reweOffers = Array.from({ length: 40 }, (_, index) =>
      offer({ id: `r${index}`, storeChain: 'REWE', name: `REWE Ware ${index}`, tags: ['rewe', 'browser-import'] }),
    );
    const report = computeStoreImportHealth({
      offers: reweOffers,
      nextWeekOffers: [],
      filteredOffers: [],
      rewe: { method: 'browser', report: reweReport({ normalizedCount: 40, possibleWebMissingEstimate: 60 }) },
      now,
    });
    const rewe = rowFor(report, 'REWE');
    expect(rewe?.importHealth).toBe('warning');
    expect(rewe?.warnings.join(' ')).toMatch(/mehr als importiert/);
  });

  it('zählt einen bewusst ausgeschlossenen REWE-Scan ohne Import als excluded, nicht critical', () => {
    const report = computeStoreImportHealth({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [],
      excludedStores: ['rewe', 'nahkauf'],
      now,
    });
    const rewe = rowFor(report, 'REWE');
    expect(rewe?.importHealth).toBe('excluded');
    expect(rewe?.warnings.join(' ')).toMatch(/ausgeschlossen/);
  });

  it('bleibt ohne Ausschluss-Liste beim ehrlichen critical für 0 importierte REWE-Angebote', () => {
    const report = computeStoreImportHealth({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    expect(rowFor(report, 'REWE')?.importHealth).toBe('critical');
  });

  // ── EDEKA (Auftrag): immer im Report, ehrliche Web-Verifikation ────────────
  it('EDEKA erscheint mit 0 Angeboten + Block-Diagnose als blocked/critical (nicht verschwunden)', () => {
    const report = computeStoreImportHealth({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [],
      edeka: edekaDiag({ blocked: true, blockReason: 'HTTP 403', httpStatus: 403, offerBlocks: 0, candidates: 0, withOfferPrice: 0, importedDistinct: 0, lastSuccessfulAt: undefined, rejectedByReason: { kein_name: 0, kein_angebotspreis: 0, kein_preis: 0 } }),
      now,
    });
    const edeka = rowFor(report, 'EDEKA');
    expect(edeka).toBeDefined();
    expect(edeka?.webVerification).toBe('blocked');
    expect(edeka?.importHealth).toBe('critical');
    expect(edeka?.warnings.join(' ')).toMatch(/blockiert/i);
  });

  it('EDEKA mit importierten nationalen Angeboten ist ok/warning und nie full', () => {
    // Glaubhafter Import (≥ 5 aktuelle) — ein winziger Import (<5) wäre
    // berechtigt critical (Scraper-Verdacht), siehe storeCompleteness.
    const edekaOffers = Array.from({ length: 8 }, (_unused, i) =>
      offer({
        id: `e${i}`,
        storeChain: 'EDEKA',
        name: `EDEKA Angebot ${i}`,
        validityStart: '2026-06-01T00:00:00.000Z',
        validityEnd: '2026-06-06T23:59:59.999Z',
      }),
    );
    const report = computeStoreImportHealth({
      offers: edekaOffers,
      nextWeekOffers: [],
      filteredOffers: [],
      edeka: edekaDiag({ importedDistinct: 8, candidates: 8, withOfferPrice: 8 }),
      now,
    });
    const edeka = rowFor(report, 'EDEKA');
    expect(edeka?.webVerification).toBe('ok');
    expect(edeka?.importHealth).toBe('warning'); // national_only — nie ok/full
    expect(edeka?.importCoverage).toBe('national_only');
    expect(edeka?.fetchedCount).toBe(23);
    expect(edeka?.parsedCount).toBe(8);
    expect(edeka?.warnings.join(' ')).toMatch(/Zählkette/);
  });

  it('EDEKA ohne Diagnose (kein Lauf) ist unverified, nicht still ok', () => {
    const report = computeStoreImportHealth({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [],
      edeka: null,
      now,
    });
    const edeka = rowFor(report, 'EDEKA');
    expect(edeka).toBeDefined();
    expect(edeka?.webVerification).toBe('unverified');
    expect(edeka?.importHealth).toBe('critical');
  });
});

describe('Shop-Coverage-Audit — Quelle, sourceCoverage, false-live, food-in-filter', () => {
  it('liefert pro Shop die öffentliche Quelle (sourceUrl)', () => {
    const report = computeStoreImportHealth({
      offers: [
        offer({ id: 'k1', storeChain: 'Kaufland', name: 'Milch' }),
        offer({ id: 'a1', storeChain: 'ALDI SUED', name: 'Bananen' }),
      ],
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    expect(rowFor(report, 'Kaufland')?.sourceUrl).toBe(
      'https://filiale.kaufland.de/angebote/aktuelle-woche.html',
    );
    expect(rowFor(report, 'ALDI SUED')?.sourceUrl).toBe(
      'https://www.aldi-sued.de/produkte/wochenangebote/k/1588161426582123',
    );
  });

  it('mappt die sourceCoverage ehrlich: Netto unverifiable, REWE browser_import, EDEKA national_only, Kaufland full', () => {
    const reweOffers = Array.from({ length: 38 }, (_unused, i) =>
      offer({ id: `r${i}`, storeChain: 'REWE', name: `REWE Ware ${i}`, tags: ['rewe', 'browser-import'] }),
    );
    const report = computeStoreImportHealth({
      offers: [
        offer({ id: 'n1', storeChain: 'Netto', name: 'Netto Ware' }),
        offer({ id: 'e1', storeChain: 'EDEKA', name: 'EDEKA Ware' }),
        offer({ id: 'k1', storeChain: 'Kaufland', name: 'Milch' }),
        ...reweOffers,
      ],
      nextWeekOffers: [],
      filteredOffers: [],
      rewe: {
        method: 'browser',
        report: {
          rawCount: 40,
          normalizedCount: 38,
          reviewCount: 0,
          skippedCount: 0,
          skippedFragments: [],
          suspiciousPrices: [],
          duplicateCandidates: [],
          categoryCorrections: [],
          importHealth: 'ok',
          webVerification: 'blocked',
        },
      },
      edeka: null,
      now,
    });
    expect(rowFor(report, 'Netto')?.sourceCoverage).toBe('unverifiable');
    expect(rowFor(report, 'REWE')?.sourceCoverage).toBe('browser_import');
    expect(rowFor(report, 'EDEKA')?.sourceCoverage).toBe('national_only');
    expect(rowFor(report, 'Kaufland')?.sourceCoverage).toBe('full');
  });

  it('markiert Lidl als partial_with_ocr, wenn OCR-Angebote (Prospektbild-Tag) im Snapshot sind', () => {
    const report = computeStoreImportHealth({
      offers: [
        ...Array.from({ length: 12 }, (_unused, i) =>
          offer({ id: `l${i}`, storeChain: 'Lidl', name: `Lidl Ware ${i}` }),
        ),
        offer({ id: 'locr', storeChain: 'Lidl', name: 'Frische Erdbeeren', tags: ['lidl-prospekt-ocr', 'ocr'] }),
      ],
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    expect(rowFor(report, 'Lidl')?.sourceCoverage).toBe('partial_with_ocr');
    // importCoverage (Eskalation) bleibt unverändert structured_only.
    expect(rowFor(report, 'Lidl')?.importCoverage).toBe('structured_only');
  });

  it('markiert den Lidl-Auto-Import (lidl-prospekt-Tag) als partial_with_viewer_json — nie full', () => {
    // Der reaktivierte Lidl-Auto-Scan importiert die strukturiert bepreisten
    // products-Map-Angebote aus der öffentlichen v4/flyer-Viewer-JSON. Das
    // Anzeige-Label muss den Teilimport ehrlich benennen; die Eskalations-
    // Coverage bleibt structured_only (dauerhaft warn, nie healthy/full).
    const report = computeStoreImportHealth({
      offers: Array.from({ length: 12 }, (_unused, i) =>
        offer({ id: `lv${i}`, storeChain: 'Lidl', name: `Lidl Wein ${i}`, tags: ['lidl-prospekt'] }),
      ),
      nextWeekOffers: [],
      filteredOffers: [
        offer({ id: 'lnf', storeChain: 'Lidl', name: 'Akkuschrauber', tags: ['lidl-prospekt', 'nonfood'] }),
      ],
      now,
    });
    const lidl = rowFor(report, 'Lidl');
    expect(lidl?.sourceCoverage).toBe('partial_with_viewer_json');
    expect(lidl?.importCoverage).toBe('structured_only');
    expect(lidl?.importCoverage).not.toBe('full');
    // Teilimport bleibt höchstens warning — aber NIE critical, solange der
    // strukturierte Import nachweislich Angebote liefert.
    expect(lidl?.importHealth).toBe('warning');
    expect(lidl?.importHealth).not.toBe('critical');
    expect(lidl?.warnings.join(' ')).toMatch(/Teilimport/);
  });

  it('Lidl erscheint auch mit 0 Angeboten IMMER im Report (kaputte Discovery nie stumm)', () => {
    const report = computeStoreImportHealth({
      offers: [offer({ id: 'k1', storeChain: 'Kaufland', name: 'Butter' })],
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    const lidl = rowFor(report, 'Lidl');
    expect(lidl).toBeTruthy();
    // 0 Angebote ohne disabled-Policy = ehrlich eskaliert (nie stilles Fehlen,
    // nie fake ok/full).
    expect(lidl?.currentCount).toBe(0);
    expect(lidl?.importHealth).toBe('critical');
    expect(lidl?.importCoverage).not.toBe('full');
  });

  it('zählt false-live: ein abgelaufenes und ein künftiges Angebot im LIVE-Bucket', () => {
    const report = computeStoreImportHealth({
      offers: [
        offer({ id: 'ok', storeChain: 'PENNY', name: 'Aktuell' }),
        offer({
          id: 'expired',
          storeChain: 'PENNY',
          name: 'Abgelaufen',
          validityStart: '2026-05-14T00:00:00.000Z',
          validityEnd: '2026-05-20T23:59:59.999Z',
        }),
        offer({
          id: 'future',
          storeChain: 'PENNY',
          name: 'Erst künftig',
          validityStart: '2026-06-20T00:00:00.000Z',
          validityEnd: '2026-06-26T23:59:59.999Z',
        }),
      ],
      nextWeekOffers: [],
      filteredOffers: [],
      now,
    });
    const penny = rowFor(report, 'PENNY');
    expect(penny?.falseLiveCount).toBe(2);
    expect(penny?.falseLiveExamples).toEqual(expect.arrayContaining(['Abgelaufen', 'Erst künftig']));
  });

  it('liefert food-in-filter Beispiele (verdacht falsch gefiltertes Food)', () => {
    const report = computeStoreImportHealth({
      offers: [offer({ id: 'r1', storeChain: 'REWE', name: 'Bananen' })],
      nextWeekOffers: [],
      filteredOffers: [
        offer({ id: 'f1', storeChain: 'REWE', name: 'ja! Erdnüsse', sourceCategoryRaw: 'Fan-Momente zum Angrillen!' }),
      ],
      now,
    });
    const rewe = rowFor(report, 'REWE');
    expect(rewe?.foodSuspectCount).toBe(1);
    expect(rewe?.foodInFilterExamples).toContain('ja! Erdnüsse');
  });
});

describe('ALDI SÜD Red-Bull-Fall — Source-Gap statt Produkt-Hack', () => {
  // Reproduktion: User sieht Red Bull bei ALDI SÜD, im Snapshot ist es NICHT in
  // current/next/filtered. Da die rechtlich sichere öffentliche Quelle
  // (/angebote-Produktkacheln) es nicht enthält, MUSS es als source-gap
  // ausgewiesen werden — ohne Produkt-Allowlist/Hardcode im Produktivcode.
  const aldiBuckets = {
    offers: [
      offer({ id: 'a1', storeChain: 'ALDI SUED', name: 'Rispentomaten' }),
      offer({ id: 'a2', storeChain: 'ALDI SUED', name: 'Hähnchenbrustfilet' }),
    ],
    nextWeekOffers: [offer({ id: 'a3', storeChain: 'ALDI SUED', name: 'Bio-Milch' })],
    filteredOffers: [offer({ id: 'a4', storeChain: 'ALDI SUED', name: 'Spülmaschinen-Tabs', tags: ['nonfood'] })],
  };

  it('meldet Red Bull als source-gap, weil es in keinem ALDI-SÜD-Bucket vorkommt', () => {
    const gaps = findStoreSourceGaps('ALDI SUED', ['Red Bull'], aldiBuckets);
    expect(gaps).toEqual(['Red Bull']);
  });

  it('meldet KEINEN Gap für ein tatsächlich importiertes Produkt', () => {
    expect(findStoreSourceGaps('ALDI SUED', ['Rispentomaten'], aldiBuckets)).toEqual([]);
  });

  it('grenzt den Gap-Check auf den genannten Shop ein (Red Bull bei Kaufland ≠ ALDI SÜD)', () => {
    const buckets = {
      offers: [...aldiBuckets.offers, offer({ id: 'k1', storeChain: 'Kaufland', name: 'Red Bull Energy 250ml' })],
      nextWeekOffers: aldiBuckets.nextWeekOffers,
      filteredOffers: aldiBuckets.filteredOffers,
    };
    // Kaufland hat es → kein Gap; ALDI SÜD weiterhin Gap.
    expect(findStoreSourceGaps('Kaufland', ['Red Bull'], buckets)).toEqual([]);
    expect(findStoreSourceGaps('ALDI SUED', ['Red Bull'], buckets)).toEqual(['Red Bull']);
  });

  it('die ALDI-SÜD-Zeile nennt die öffentliche Quelle und die Source-Gap-Ursache (regional/Prospektbild/App)', () => {
    const report = computeStoreImportHealth({ ...aldiBuckets, now });
    const aldi = rowFor(report, 'ALDI SUED');
    expect(aldi?.sourceUrl).toBe(
      'https://www.aldi-sued.de/produkte/wochenangebote/k/1588161426582123',
    );
    expect(aldi?.warnings.join(' ')).toMatch(/Prospektbild|regionale|App-exklusive|source-gap/i);
  });
});

describe('edekaImportVerdict (P4 — ehrliche Zustände)', () => {
  it('erreichbar + geparst → ok/warning', () => {
    const v = edekaImportVerdict(edekaDiag(), { currentCount: 5, nextWeekCount: 6 });
    expect(v.webVerification).toBe('ok');
    expect(v.importHealth).toBe('warning');
  });

  it('blockiert mit altem Bestand → blocked/warning (Bestand bleibt)', () => {
    const v = edekaImportVerdict(
      edekaDiag({ blocked: true, blockReason: 'Captcha', importedDistinct: 0, offerBlocks: 0 }),
      { currentCount: 8, nextWeekCount: 0 },
    );
    expect(v.webVerification).toBe('blocked');
    expect(v.importHealth).toBe('warning');
  });

  it('erreichbar, Struktur da, aber 0 importiert → parser_failure/critical', () => {
    const v = edekaImportVerdict(
      edekaDiag({ importedDistinct: 0, withOfferPrice: 0, candidates: 0, offerBlocks: 23, pageLooksLikeOffers: true, lastSuccessfulAt: undefined }),
      { currentCount: 0, nextWeekCount: 0 },
    );
    expect(v.webVerification).toBe('ok');
    expect(v.importHealth).toBe('critical');
    expect(v.warnings.join(' ')).toMatch(/Parser-Fehler/);
  });

  it('erreichbar, nachweislich 0 Karten → empty_with_reason/critical (kein Scraper-Fehler behauptet)', () => {
    const v = edekaImportVerdict(
      edekaDiag({ importedDistinct: 0, withOfferPrice: 0, candidates: 0, offerBlocks: 0, pageLooksLikeOffers: true, lastSuccessfulAt: undefined }),
      { currentCount: 0, nextWeekCount: 0 },
    );
    expect(v.webVerification).toBe('ok');
    expect(v.warnings.join(' ')).toMatch(/keine Angebotskarten/);
  });
});

describe('computeStoreImportHealth — per Policy deaktivierte Shops (ALDI/Lidl)', () => {
  it('zeigt deaktivierte Shops immer als "disabled", nie critical, ohne Angebote', () => {
    const report = computeStoreImportHealth({
      offers: [offer({ id: 'k1', storeChain: 'Kaufland' })],
      nextWeekOffers: [],
      filteredOffers: [],
      disabledStores: ['ALDI SÜD', 'ALDI NORD', 'Lidl'],
      now,
    });
    const byChain = (name: string) =>
      report.stores.find((s) => s.storeChain === name);
    for (const chain of ['ALDI SÜD', 'ALDI NORD', 'Lidl']) {
      const row = byChain(chain);
      expect(row, `${chain} fehlt im Report`).toBeTruthy();
      expect(row!.importHealth).toBe('disabled');
      expect(row!.currentCount).toBe(0);
      expect(row!.foodCount).toBe(0);
      expect(row!.warnings.join(' ')).toMatch(/deaktiviert/i);
    }
  });

  it('zeigt für einen deaktivierten ALDI-Store mit manuellem PDF-Import eine pdf_import-Zeile (nie critical)', () => {
    const report = computeStoreImportHealth({
      offers: [
        offer({
          id: 'a1',
          storeChain: 'ALDI NORD',
          name: 'Hot Dog Würstchen',
          tags: ['aldi-pdf-import', 'manual-import', 'aldi-nord'],
        }),
        offer({
          id: 'a2',
          storeChain: 'ALDI NORD',
          name: 'Katenschinken',
          tags: ['aldi-pdf-import', 'manual-import', 'aldi-nord'],
        }),
      ],
      nextWeekOffers: [],
      filteredOffers: [
        offer({
          id: 'a3',
          storeChain: 'ALDI NORD',
          name: 'Ziergras',
          tags: ['aldi-pdf-import', 'manual-import', 'aldi-nord', 'nonfood'],
        }),
      ],
      disabledStores: ['ALDI SÜD', 'ALDI NORD', 'Lidl'],
      now,
    });
    const nord = report.stores.find((s) => s.storeChain === 'ALDI NORD');
    expect(nord).toBeTruthy();
    expect(nord!.strategy).toBe('pdf_import');
    expect(nord!.importHealth).toBe('ok'); // gewollter Import, kein Defekt
    expect(nord!.importHealth).not.toBe('critical');
    expect(nord!.webVerification).toBe('imported');
    expect(nord!.currentCount).toBe(2);
    expect(nord!.foodCount).toBe(2);
    expect(nord!.filteredCount).toBe(1);
    expect(nord!.warnings.join(' ')).toMatch(/Auto-Scan deaktiviert; manuelle PDF-Angebote importiert: 2/);
    // ALDI SÜD (ohne manuellen Import) bleibt eine neutrale disabled-Zeile.
    const sued = report.stores.find((s) => s.storeChain === 'ALDI SÜD');
    expect(sued!.importHealth).toBe('disabled');
  });

  it('zeigt für das deaktivierte Lidl mit manuellem Prospekt-Review-Import eine manual_review_import-Zeile (nie critical)', () => {
    const report = computeStoreImportHealth({
      offers: [
        offer({
          id: 'l1',
          storeChain: 'Lidl',
          name: 'Rispentomaten 500 g',
          tags: ['lidl-manual-import', 'manual-import'],
        }),
      ],
      nextWeekOffers: [],
      filteredOffers: [],
      disabledStores: ['ALDI SÜD', 'ALDI NORD', 'Lidl'],
      lidlReview: { pending: 4, approved: 2 },
      now,
    });
    const lidl = report.stores.find((s) => s.storeChain === 'Lidl');
    expect(lidl).toBeTruthy();
    expect(lidl!.strategy).toBe('manual_import');
    expect(lidl!.sourceCoverage).toBe('manual_review_import');
    // Committet → ok, nie critical (bewusst deaktiviert + manueller Import).
    expect(lidl!.importHealth).toBe('ok');
    expect(lidl!.importHealth).not.toBe('critical');
    expect(lidl!.currentCount).toBe(1);
    // Keine full-Coverage-Behauptung.
    expect(lidl!.warnings.join(' ')).toMatch(/keine full-Coverage-Behauptung/);
    expect(lidl!.pendingReviewCount).toBe(4);
    expect(lidl!.approvedNotCommittedCount).toBe(2);
  });

  it('Lidl ohne manuellen Import bleibt eine neutrale disabled-Zeile (nie critical)', () => {
    const report = computeStoreImportHealth({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [],
      disabledStores: ['Lidl'],
      now,
    });
    const lidl = report.stores.find((s) => s.storeChain === 'Lidl');
    expect(lidl!.importHealth).toBe('disabled');
    expect(lidl!.importHealth).not.toBe('critical');
  });

  it('keiner der deaktivierten Shops erzeugt eine critical/warning-Eskalation', () => {
    const report = computeStoreImportHealth({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [],
      disabledStores: ['ALDI SÜD', 'ALDI NORD', 'Lidl'],
      now,
    });
    // Kein deaktivierter Shop darf critical/warning sein (REWE/nahkauf/EDEKA
    // erscheinen unabhängig als ALWAYS_REPORT_STORES — die sind hier irrelevant).
    for (const chain of ['ALDI SÜD', 'ALDI NORD', 'Lidl']) {
      const row = report.stores.find((s) => s.storeChain === chain);
      expect(row!.importHealth).toBe('disabled');
    }
    const disabled = report.stores.filter((s) => s.importHealth === 'disabled');
    expect(disabled.map((s) => s.storeChain).sort()).toEqual(['ALDI NORD', 'ALDI SÜD', 'Lidl']);
  });

  it('EDEKA in der disabled-Liste ist neutral "disabled" — die disabled-Zeile schlägt die EDEKA-Diagnose', () => {
    const report = computeStoreImportHealth({
      // Stale EDEKA-Angebote + eine (alte) blockiert-Diagnose dürfen die Zeile
      // NICHT mehr critical machen: per Policy ist EDEKA bewusst nicht gescannt.
      offers: [
        offer({ id: 'k1', storeChain: 'Kaufland' }),
        offer({ id: 'e1', storeChain: 'EDEKA', name: 'EDEKA Altbestand' }),
      ],
      nextWeekOffers: [],
      filteredOffers: [],
      edeka: edekaDiag({ blocked: true, blockReason: 'HTTP 403', httpStatus: 403, importedDistinct: 0, offerBlocks: 0 }),
      disabledStores: ['ALDI SÜD', 'ALDI NORD', 'Lidl', 'EDEKA'],
      now,
    });
    const edeka = report.stores.find((s) => s.storeChain === 'EDEKA');
    expect(edeka).toBeTruthy();
    expect(edeka!.importHealth).toBe('disabled');
    expect(edeka!.currentCount).toBe(0);
    expect(edeka!.foodCount).toBe(0);
    expect(edeka!.warnings.join(' ')).toMatch(/deaktiviert/i);
    // Andere Shops bleiben unberührt.
    expect(report.stores.find((s) => s.storeChain === 'Kaufland')!.importHealth).not.toBe('disabled');
  });
});

describe('ALDI NORD — strukturierter Import-Health (nicht mehr disabled)', () => {
  it('aldiNordImportVerdict: belegter Import → imported/ok mit Zählkette', () => {
    const verdict = aldiNordImportVerdict(aldiNordDiag(), { currentCount: 32, nextWeekCount: 8 });
    expect(verdict.importHealth).toBe('ok');
    expect(verdict.webVerification).toBe('imported');
    expect(verdict.warnings.join(' ')).toMatch(/Zählkette/);
  });

  it('aldiNordImportVerdict: apiData fehlt → warning/fetch_failed-Ehrlichkeit, nie still ok', () => {
    const verdict = aldiNordImportVerdict(
      aldiNordDiag({ apiDataFound: false, structuredProductsFound: 0, productsWithPrice: 0, importedDistinct: 0, currentProducts: 0, futureProducts: 0, lastSuccessfulAt: undefined }),
      { currentCount: 0, nextWeekCount: 0 },
    );
    expect(verdict.importHealth).toBe('warning');
    expect(verdict.warnings.join(' ')).toMatch(/apiData/);
  });

  it('aldiNordImportVerdict: Quelle nicht erreichbar → blocked', () => {
    const verdict = aldiNordImportVerdict(
      aldiNordDiag({ blocked: true, blockReason: 'HTTP 403', httpStatus: 403, apiDataFound: false, importedDistinct: 0, currentProducts: 0 }),
      { currentCount: 0, nextWeekCount: 0 },
    );
    expect(verdict.webVerification).toBe('blocked');
    expect(verdict.importHealth).toBe('critical');
  });

  it('computeStoreImportHealth: ALDI NORD erscheint als ok (NICHT disabled), wenn strukturiert importiert', () => {
    // Glaubhafter Feed (≥25 aktuelle Angebote), damit der Thin-Import-Schutz nicht
    // (zu Recht) auf warning/critical eskaliert — hier geht es um „nicht disabled".
    const aldiOffers = Array.from({ length: 30 }, (_, i) =>
      offer({
        id: `an${i}`,
        storeChain: 'ALDI NORD',
        name: `ALDI-NORD-Angebot ${i}`,
        tags: ['aldi-nord-structured'],
      }),
    );
    const report = computeStoreImportHealth({
      offers: aldiOffers,
      nextWeekOffers: [],
      filteredOffers: [],
      aldiNord: aldiNordDiag({ importedDistinct: 30, structuredProductsFound: 30, productsWithPrice: 30, productsWithImage: 30, currentProducts: 30, futureProducts: 0 }),
      // ALDI NORD ist NICHT mehr in disabledStores.
      disabledStores: ['ALDI SÜD', 'Lidl', 'EDEKA'],
      now,
    });
    const nord = rowFor(report, 'ALDI NORD');
    expect(nord).toBeTruthy();
    expect(nord!.importHealth).toBe('ok');
    expect(nord!.importHealth).not.toBe('disabled');
    expect(nord!.webVerification).toBe('imported');
  });

  it('computeStoreImportHealth: ALDI NORD erscheint auch ohne Angebote (ALWAYS_REPORT) als warning bei fehlendem apiData', () => {
    const report = computeStoreImportHealth({
      offers: [offer({ id: 'k1', storeChain: 'Kaufland' })],
      nextWeekOffers: [],
      filteredOffers: [],
      aldiNord: aldiNordDiag({ apiDataFound: false, importedDistinct: 0, structuredProductsFound: 0, productsWithPrice: 0, productsWithImage: 0, currentProducts: 0, futureProducts: 0, lastSuccessfulAt: undefined }),
      disabledStores: ['ALDI SÜD', 'Lidl', 'EDEKA'],
      now,
    });
    const nord = rowFor(report, 'ALDI NORD');
    expect(nord).toBeTruthy();
    expect(nord!.importHealth).toBe('warning');
  });
});

const aldiSuedRow = (report: ReturnType<typeof computeStoreImportHealth>) =>
  report.stores.find((store) => /aldi s(ü|u)ed/i.test(store.storeChain));

describe('aldiSuedImportVerdict — strukturierter Website-Connector (3 Kategorieseiten)', () => {
  it('belegter Import → ok/imported', () => {
    const verdict = aldiSuedImportVerdict(aldiSuedDiag(), { currentCount: 24, nextWeekCount: 2 });
    expect(verdict.importHealth).toBe('ok');
    expect(verdict.webVerification).toBe('imported');
  });

  it('alle 3 Quellen blockiert (403) → blocked, ohne Angebote critical', () => {
    const diag = aldiSuedDiag({
      verdict: 'blocked',
      blocked: true,
      blockReason: '403 Forbidden (Captcha/Anti-Bot)',
      structuredProductsFound: 0,
      productsWithPrice: 0,
      productsWithImage: 0,
      importedDistinct: 0,
      currentProducts: 0,
      futureProducts: 0,
      sourceUrlsChecked: [1, 2, 3].map((n) => ({
        url: `https://www.aldi-sued.de/produkte/wochenangebote/${n}`,
        status: 403,
        blocked: true,
        blockReason: '403 Forbidden',
        htmlProductCards: 0,
        embeddedJsonFound: false,
        jsonLdOffers: 0,
        dataGridDataCount: 0,
        apiCandidatesFound: 0,
        productsParsed: 0,
      })),
      lastSuccessfulAt: undefined,
    });
    const verdict = aldiSuedImportVerdict(diag, { currentCount: 0, nextWeekCount: 0 });
    expect(verdict.webVerification).toBe('blocked');
    expect(verdict.importHealth).toBe('critical');
    expect(verdict.warnings.join(' ')).toMatch(/nicht erreichbar/i);
  });

  it('Teilblockade (verdict warning) → warning/imported', () => {
    const diag = aldiSuedDiag({
      verdict: 'warning',
      sourceUrlsChecked: [
        { url: 'a', status: 200, blocked: false, htmlProductCards: 8, embeddedJsonFound: true, jsonLdOffers: 0, dataGridDataCount: 0, apiCandidatesFound: 0, productsParsed: 8 },
        { url: 'b', status: 403, blocked: true, blockReason: '403', htmlProductCards: 0, embeddedJsonFound: false, jsonLdOffers: 0, dataGridDataCount: 0, apiCandidatesFound: 0, productsParsed: 0 },
      ],
    });
    const verdict = aldiSuedImportVerdict(diag, { currentCount: 8, nextWeekCount: 0 });
    expect(verdict.importHealth).toBe('warning');
    expect(verdict.webVerification).toBe('imported');
    expect(verdict.warnings.join(' ')).toMatch(/blockiert/i);
  });

  it('erreichbar, aber 0 Produkte (verdict unavailable) → warning/unverified', () => {
    const diag = aldiSuedDiag({
      verdict: 'unavailable',
      structuredProductsFound: 0,
      productsWithPrice: 0,
      productsWithImage: 0,
      importedDistinct: 0,
      currentProducts: 0,
      futureProducts: 0,
      lastSuccessfulAt: undefined,
    });
    const verdict = aldiSuedImportVerdict(diag, { currentCount: 0, nextWeekCount: 0 });
    expect(verdict.importHealth).toBe('warning');
    expect(verdict.webVerification).toBe('unverified');
  });
});

describe('computeStoreImportHealth — ALDI SÜD wieder aktiv (strukturierter Connector)', () => {
  it('ALDI SÜD ist mit belegtem Import ok/imported, nicht disabled', () => {
    const report = computeStoreImportHealth({
      offers: [
        offer({ id: 's1', storeChain: 'ALDI SÜD', name: 'RED BULL Energy Drink 250 ml' }),
        offer({ id: 's2', storeChain: 'ALDI SÜD', name: 'PRINGLES Chips 185 g' }),
      ],
      nextWeekOffers: [],
      filteredOffers: [],
      aldiSued: aldiSuedDiag(),
      // Neue Policy: ALDI SÜD ist NICHT mehr deaktiviert.
      disabledStores: ['Lidl', 'EDEKA'],
      now,
    });
    const sued = aldiSuedRow(report);
    expect(sued).toBeTruthy();
    expect(sued!.importHealth).toBe('ok');
    expect(sued!.importHealth).not.toBe('disabled');
    expect(sued!.webVerification).toBe('imported');
  });

  it('alle 3 Links 403 → ALDI SÜD blocked/critical (kein stilles „0", kein Commit)', () => {
    const report = computeStoreImportHealth({
      offers: [offer({ id: 'k1', storeChain: 'Kaufland' })],
      nextWeekOffers: [],
      filteredOffers: [],
      aldiSued: aldiSuedDiag({
        verdict: 'blocked',
        blocked: true,
        blockReason: '403 Forbidden',
        structuredProductsFound: 0,
        productsWithPrice: 0,
        productsWithImage: 0,
        importedDistinct: 0,
        currentProducts: 0,
        futureProducts: 0,
        sourceUrlsChecked: [1, 2, 3].map((n) => ({
          url: `https://www.aldi-sued.de/x/${n}`,
          status: 403,
          blocked: true,
          blockReason: '403 Forbidden',
          htmlProductCards: 0,
          embeddedJsonFound: false,
          jsonLdOffers: 0,
          dataGridDataCount: 0,
          apiCandidatesFound: 0,
          productsParsed: 0,
        })),
        lastSuccessfulAt: undefined,
      }),
      disabledStores: ['Lidl', 'EDEKA'],
      now,
    });
    const sued = aldiSuedRow(report);
    expect(sued).toBeTruthy();
    expect(sued!.webVerification).toBe('blocked');
    expect(sued!.importHealth).toBe('critical');
    expect(sued!.currentCount).toBe(0);
  });

  it('explizit per ENV deaktiviert (kanonischer Chain) → neutrale disabled-Zeile schlägt die Diagnose', () => {
    const report = computeStoreImportHealth({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [],
      aldiSued: aldiSuedDiag(),
      // Kanonischer Connector-Chain 'ALDI SUED' (= storeChain der gescrapten
      // Angebote); ein Override-disable greift damit dieselbe Health-Zeile.
      disabledStores: ['ALDI SUED', 'Lidl', 'EDEKA'],
      now,
    });
    const sued = aldiSuedRow(report);
    expect(sued!.importHealth).toBe('disabled');
  });
});

describe('nahkaufImportVerdict — Storyblok-Diagnose (source-gap nie critical)', () => {
  it('belegter Import → imported/ok mit Zählkette', () => {
    const v = nahkaufImportVerdict(nahkaufDiag(), { currentCount: 30, nextWeekCount: 4 });
    expect(v.webVerification).toBe('imported');
    expect(v.importHealth).toBe('ok');
    expect(v.warnings.join(' ')).toContain('120 Offer-Stories → 34 importiert');
  });

  it('BELEGTER source-gap (0 Stories + rewe-Link) → warning mit Erklärung, NIE critical', () => {
    const v = nahkaufImportVerdict(
      nahkaufDiag({
        pageSource: 'home_fallback',
        offerStoryCount: 0,
        importedDistinct: 0,
        offersLinkToRewe: true,
        sourceGap: true,
      }),
      { currentCount: 0, nextWeekCount: 0 },
    );
    expect(v.webVerification).toBe('ok');
    expect(v.importHealth).toBe('warning');
    const text = v.warnings.join(' ');
    expect(text).toContain('source-gap');
    expect(text).toContain('kein Import-Defekt');
    expect(text).toContain('Startseiten-Fallback');
  });

  it('weder Angebotsseite noch Startseite lesbar → blocked (critical nur ohne Bestand)', () => {
    const diag = nahkaufDiag({ blocked: true, blockReason: 'store_fetch_timeout', tokenFound: false });
    expect(nahkaufImportVerdict(diag, { currentCount: 0, nextWeekCount: 0 }).importHealth).toBe('critical');
    expect(nahkaufImportVerdict(diag, { currentCount: 12, nextWeekCount: 0 }).importHealth).toBe('warning');
    expect(nahkaufImportVerdict(diag, { currentCount: 0, nextWeekCount: 0 }).webVerification).toBe('blocked');
  });

  it('kein Lauf in diesem Prozess → unverified (Snapshot-Bestand = warning, sonst critical)', () => {
    expect(nahkaufImportVerdict(null, { currentCount: 20, nextWeekCount: 0 }).importHealth).toBe('warning');
    expect(nahkaufImportVerdict(null, { currentCount: 0, nextWeekCount: 0 }).importHealth).toBe('critical');
    expect(nahkaufImportVerdict(null, { currentCount: 0, nextWeekCount: 0 }).webVerification).toBe('unverified');
  });

  it('Token nicht gefunden → unverified/warning (Seitenformat prüfen)', () => {
    const v = nahkaufImportVerdict(nahkaufDiag({ tokenFound: false, offerStoryCount: 0, importedDistinct: 0 }), {
      currentCount: 0,
      nextWeekCount: 0,
    });
    expect(v.webVerification).toBe('unverified');
    expect(v.importHealth).toBe('warning');
    expect(v.warnings.join(' ')).toContain('Storyblok-Token nicht im Seiten-HTML');
  });

  it('Stories vorhanden, 0 importiert, keine Markt-ID → warning mit NAHKAUF_MARKET_ID-Hinweis', () => {
    const v = nahkaufImportVerdict(
      nahkaufDiag({ offerStoryCount: 80, importedDistinct: 0 }),
      { currentCount: 0, nextWeekCount: 0 },
    );
    expect(v.importHealth).toBe('warning');
    expect(v.warnings.join(' ')).toContain('NAHKAUF_MARKET_ID');
  });
});

describe('computeStoreImportHealth — nahkauf source-gap (Publisher leer, kein Defekt)', () => {
  it('source-gap-Diag + 0 Angebote → warning statt critical, trotz expectedMin-Erwartung', () => {
    const report = computeStoreImportHealth({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [],
      nahkauf: nahkaufDiag({
        pageSource: 'home_fallback',
        offerStoryCount: 0,
        importedDistinct: 0,
        offersLinkToRewe: true,
        sourceGap: true,
      }),
      expectations: buildStoreExpectations(),
      now,
    });
    const row = rowFor(report, 'nahkauf');
    expect(row).toBeDefined();
    expect(row!.importHealth).toBe('warning');
    expect(row!.webVerification).toBe('ok');
    expect(row!.fetchedCount).toBe(0);
    expect(row!.parsedCount).toBe(0);
    expect(row!.warnings.join(' ')).toContain('source-gap');
  });

  it('ohne Diagnose bleibt 0-Angebote-nahkauf ehrlich critical (bestehendes Verhalten)', () => {
    const report = computeStoreImportHealth({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [],
      expectations: buildStoreExpectations(),
      now,
    });
    const row = rowFor(report, 'nahkauf');
    expect(row!.importHealth).toBe('critical');
  });

  it('belegter Import → nahkauf-Zeile ok/imported mit Zählkette aus der Diagnose', () => {
    const offers = Array.from({ length: 34 }, (_, i) =>
      offer({ storeChain: 'nahkauf', name: `Angebot ${i}`, normalizedName: `angebot ${i}` }),
    );
    const report = computeStoreImportHealth({
      offers,
      nextWeekOffers: [],
      filteredOffers: [],
      nahkauf: nahkaufDiag(),
      expectations: buildStoreExpectations(),
      now,
    });
    const row = rowFor(report, 'nahkauf');
    expect(row!.webVerification).toBe('imported');
    expect(row!.fetchedCount).toBe(120);
    // coverage national_only hält die Health ehrlich auf warning (nie still ok
    // ohne Markt-Beleg) — aber nie critical.
    expect(['ok', 'warning']).toContain(row!.importHealth);
    expect(row!.importHealth).not.toBe('critical');
  });
});
