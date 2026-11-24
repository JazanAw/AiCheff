import { describe, expect, it } from 'vitest';
import {
  assessReweImportQuality,
  createReweBrowserImportBookmarkletScript,
  extractReweCardFields,
  isReweSectionHeadingName,
  normalizeReweBrowserImportRequest,
  type ReweBrowserImportRequest,
} from './reweBrowserImport';
import { splitOffersByLiveWindow } from './snapshotLiveWindow';

const at = new Date('2026-06-13T10:00:00Z');

// Repro of the last bookscan: ~232 web tiles, only ~29 offers reached the
// snapshot. The live artifact showed section headings ("An der Bedientheke",
// "Tiefkühl", "Freizeit und Mode") leaking in AS offers, while real product
// tiles (whose name is not a heading) were missed. These tests pin the
// structural fix: headings are categories, not offers; name+price+context come
// from the SAME card; every drop is counted with a reason.

describe('isReweSectionHeadingName — Sektionsüberschriften sind keine Angebote', () => {
  it('erkennt die real geleakten REWE-Sektionsüberschriften', () => {
    for (const heading of [
      'An der Bedientheke',
      'Tiefkühl',
      'Freizeit und Mode',
      'Obst und Gemüse',
      'Bonus-Aktionen',
      'Drogerie',
      'Tier',
      'Schnell und einfach',
      'Fan-Momente zum Angrillen!',
      'Wein und Spirituosen',
    ]) {
      expect(isReweSectionHeadingName(heading), heading).toBe(true);
    }
  });

  it('lässt echte Produktnamen unangetastet (kein Produktlisten-Bias)', () => {
    for (const product of [
      'Le Gruyère AOP',
      'Bratwurst-Gemüse-Spieße',
      'Snack Äpfel',
      'Gelbfleischige Nektarinen',
      'Süßkartoffeln',
      'Frico Gouda jung',
      'Grand Sud Vin de France',
      'Maggi Guten Appetit Suppe',
      'Bananen',
      'Coca-Cola',
    ]) {
      expect(isReweSectionHeadingName(product), product).toBe(false);
    }
  });
});

describe('extractReweCardFields — Name/Preis/Kontext aus EINER Karte', () => {
  it('nimmt den Aktionspreis und den Produktnamen, Varianten/Grundpreis bleiben Kontext', () => {
    const card = extractReweCardFields([
      'Knaller',
      'Rispentomaten',
      'Klasse I, je 500-g-Schale',
      '(1 kg = 1,98 €)',
      '0,99 €',
    ]);
    expect(card.rejectReason).toBeNull();
    expect(card.name).toBe('Rispentomaten');
    expect(card.price).toBe('0,99');
    expect(card.description).toContain('Klasse I');
  });

  it('liest normale, Bonus- und Grundpreise korrekt aus', () => {
    expect(extractReweCardFields(['Bananen', '(1 kg = 1,79 €)', '1,79 €']).price).toBe('1,79');
    expect(extractReweCardFields(['Landliebe', 'Top-Angebot', '0,49 €']).price).toBe('0,49');
    // reiner Bonus-/Coupon-Preis ohne Anker → kein Angebotspreis → no_price
    expect(extractReweCardFields(['Treuepunkte mit der App', '0,50 €']).rejectReason).toBe('no_price');
  });

  it('Produktvariante wird Kontext, nicht ein eigener Offer-Name', () => {
    const card = extractReweCardFields(['Funny-frisch Frit-Sticks', 'ungarisch', '0,99 €']);
    expect(card.name).toBe('Funny-frisch Frit-Sticks');
    expect(card.description).toContain('ungarisch');
  });

  it('Karte ohne gültigen Preis wird mit Grund "no_price" abgelehnt', () => {
    const card = extractReweCardFields(['Frische Bedienung', '(1 kg = 2,00 €)', 'zzgl. 0,25 € Pfand']);
    expect(card.rejectReason).toBe('no_price');
  });

  it('Sektionsüberschrift mit Preis liefert keinen Offer (no_name/section)', () => {
    const card = extractReweCardFields(['An der Bedientheke', '2,49 €']);
    expect(card.rejectReason === 'no_name' || card.rejectReason === 'section_heading').toBe(true);
    expect(card.name === '' || isReweSectionHeadingName(card.name)).toBe(true);
  });
});

describe('normalizeReweBrowserImportRequest — Sektionsüberschrift nie live + Zählkette', () => {
  it('verwirft Sektionsüberschriften als Skip-Grund, echte Produkte bleiben live', () => {
    const result = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        offers: [
          // genau die real geleakten "Angebote" aus dem letzten Bookscan:
          { name: 'An der Bedientheke', price: '2,49' },
          { name: 'Tiefkühl', price: '0,10' },
          { name: 'Freizeit und Mode', price: '1,99' },
          // echte Produkte:
          { name: 'Le Gruyère AOP', price: '2,49', category: 'An der Bedientheke' },
          { name: 'Bananen', price: '1,79', category: 'Obst und Gemüse' },
        ],
      },
      at,
    );

    const liveNames = result.offers.map((offer) => offer.name);
    expect(liveNames).toEqual(expect.arrayContaining(['Le Gruyère AOP', 'Bananen']));
    for (const heading of ['An der Bedientheke', 'Tiefkühl', 'Freizeit und Mode']) {
      expect(liveNames).not.toContain(heading);
    }
    expect(result.report.skippedSectionHeadingCount).toBe(3);
    expect(result.report.skippedSectionHeadings).toEqual(
      expect.arrayContaining(['An der Bedientheke', 'Tiefkühl', 'Freizeit und Mode']),
    );
  });

  it('die Zählkette ist rechnerisch nachvollziehbar (kein stiller Verlust)', () => {
    // Browser-Diagnose, die exakt bilanziert: observed = unique + repeated,
    // unique = accepted + rejected, accepted = payload + offerDuplicates,
    // browser-payload = server-payload (6).
    const result = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        webCardCount: 60,
        diagnostics: {
          rawPriceMatches: 232,
          observedCardOccurrences: 84,
          uniqueCardCandidates: 60,
          repeatedCardObservations: 24,
          domPriceCards: 60,
          rejected: { noPrice: 41, noName: 8, sectionHeading: 1, extractionError: 0 },
          browserAcceptedBeforeDedupe: 10,
          browserOfferDuplicates: 4,
          payloadOffers: 6,
        },
        offers: [
          { name: 'Bananen', price: '1,79' },
          { name: 'Tiefkühl', price: '0,10' }, // Sektionsüberschrift → skip
          { name: 'Ohne Preis', price: 'ungültig' }, // no price → skip
          { name: 'Coca-Cola', price: '0,99' },
          { name: 'Coca-Cola', price: '0,40' }, // Grundpreis derselben Karte → dedupe-merge
          { name: 'Peanut', price: '1,49' }, // Fragment → review
        ],
      },
      at,
    );

    const chain = result.report.countingChain!;
    expect(chain).toBeDefined();
    // Browser-Stufen werden 1:1 durchgereicht.
    expect(chain.rawPriceMatches).toBe(232);
    expect(chain.observedCardOccurrences).toBe(84);
    expect(chain.uniqueCardCandidates).toBe(60);
    expect(chain.repeatedCardObservations).toBe(24);
    expect(chain.domPriceCards).toBe(60);
    expect(chain.browserRejected).toEqual({ noPrice: 41, noName: 8, sectionHeading: 1, extractionError: 0 });
    expect(chain.browserAcceptedBeforeDedupe).toBe(10);
    expect(chain.browserOfferDuplicates).toBe(4);
    // Server-Stufen.
    expect(chain.payloadOffers).toBe(6);
    expect(chain.serverSkipped.noPrice).toBe(1);
    expect(chain.serverSkipped.sectionHeading).toBe(1);
    expect(chain.serverDuplicatesMerged).toBe(1);
    expect(chain.liveNormalized).toBe(result.offers.length);
    expect(chain.reviewHeldBack).toBe(result.reviewOffers.length);

    // Alle Bilanzen halten exakt → balanced.
    expect(chain.balanced).toBe(true);
    expect(chain.balanceErrors).toEqual([]);

    // Server-Bilanz: payload = live + review + serverSkips + serverDuplicatesMerged.
    const skipped =
      chain.serverSkipped.noName + chain.serverSkipped.noPrice + chain.serverSkipped.sectionHeading;
    expect(chain.payloadOffers).toBe(
      chain.liveNormalized + chain.reviewHeldBack + skipped + chain.serverDuplicatesMerged,
    );
  });

  it('markiert die Zählkette als inkonsistent, wenn eine Browser-Bilanz nicht aufgeht', () => {
    const result = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        diagnostics: {
          observedCardOccurrences: 50, // ≠ unique(40) + repeated(5) → Fehler
          uniqueCardCandidates: 40,
          repeatedCardObservations: 5,
          rejected: { noPrice: 0, noName: 0, sectionHeading: 0, extractionError: 0 },
          browserAcceptedBeforeDedupe: 40,
          browserOfferDuplicates: 39,
          payloadOffers: 1,
        },
        offers: [{ name: 'Bananen', price: '1,79' }],
      },
      at,
    );
    const chain = result.report.countingChain!;
    expect(chain.balanced).toBe(false);
    expect(chain.balanceErrors.length).toBeGreaterThan(0);
    // Health wird ehrlich auf mindestens warning gezogen.
    expect(['warning', 'critical']).toContain(assessReweImportQuality(result.report).health);
  });

  it('webCardCount aus dem Browser ist die strukturelle Lücke, nicht die rohe Preis-Regex', () => {
    const result = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        webCardCount: 50, // strukturelle Kartenzahl (= diagnostics.domPriceCards)
        diagnostics: { domPriceCards: 50, rawPriceMatches: 232 },
        offers: [
          { name: 'Bananen', price: '1,79' },
          { name: 'Coca-Cola', price: '0,99' },
        ],
      },
      at,
    );
    // 50 strukturelle Karten − 2 importiert = 48 (nicht 232 − 2).
    expect(result.report.possibleWebMissingEstimate).toBe(48);
    expect(result.report.countingChain?.rawPriceMatches).toBe(232);
  });

  it('zählt die Skip-Gründe getrennt (kein Name vs. kein Preis)', () => {
    const result = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        offers: [
          { name: '', price: '1,79' },
          { name: 'Bananen', price: '' },
          { name: 'Coca-Cola', price: '0,99' },
        ],
      },
      at,
    );
    expect(result.report.skippedNoName).toBe(1);
    expect(result.report.skippedNoPrice).toBe(1);
    expect(result.report.skippedCount).toBe(2);
  });
});

describe('Bookmarklet — strukturelle Sammlung wird mit injiziert', () => {
  it('injiziert den geteilten Collector + Sektions-Vokabeln', () => {
    const script = createReweBrowserImportBookmarkletScript();
    expect(script).toContain('REWE_SECTION_VOCAB');
    expect(script).toContain('REWE_SECTION_CONNECTORS');
    expect(script).toContain('createReweDomCollector');
    expect(script).toContain('findReweCardElements');
    expect(script).toContain('extractReweCardFields');
    // Name darf NIE mehr aus der Überschrift kommen:
    expect(script).not.toContain('normalize(heading.textContent)');
  });

  it('der generierte Bookmarklet-Code ist syntaktisch gültiges JS (Injection/Escaping ok)', () => {
    const script = createReweBrowserImportBookmarkletScript();
    // new Function PARST den gesamten injizierten Blob (inkl. der via toString
    // eingebetteten Funktionen mit Template-Literalen/Backticks) — wirft bei
    // kaputtem Escaping. Ausgeführt wird hier nichts (document/fetch erst zur
    // Laufzeit referenziert).
    expect(() => new Function(script)).not.toThrow();
  });

  it('declares serialized runtime helpers before the collector that uses them', () => {
    const script = createReweBrowserImportBookmarkletScript();
    const collectorIndex = script.indexOf('const createReweDomCollector =');
    const nameHelperIndex = script.indexOf('const __name =');
    const safeUrlHelperIndex = script.indexOf('const reweSafeHttpUrl =');

    expect(collectorIndex).toBeGreaterThan(0);
    expect(nameHelperIndex).toBeGreaterThanOrEqual(0);
    expect(safeUrlHelperIndex).toBeGreaterThanOrEqual(0);
    expect(nameHelperIndex).toBeLessThan(collectorIndex);
    expect(safeUrlHelperIndex).toBeLessThan(collectorIndex);
    expect(script.slice(collectorIndex)).toContain('reweSafeHttpUrl(');
  });
});

// Phase 2 teilt die Angebote über splitOffersByLiveWindow neu in current/next
// auf (genau der Schritt, der REWE früher 65 → 0 fallen ließ). Ein frisch
// importiertes REWE-Angebot muss diesen Schritt als "current" überleben — Phase
// 2 darf erfolgreich importierte REWE-Angebote nicht löschen.
describe('REWE-Import — überlebt den Phase-2-Live-Window-Split', () => {
  it('frisch importierte REWE-Angebote bleiben current (werden nicht gedroppt)', () => {
    const result = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        offers: [
          { name: 'Bananen', price: '1,79' },
          { name: 'Le Gruyère AOP', price: '2,49' },
        ],
      },
      at,
    );
    const split = splitOffersByLiveWindow(result.offers, {
      now: at,
      // wie in runScanV2Phase2: nicht-exkludierte Shops folgen dem Live-Window.
      isPreserved: () => false,
    });
    expect(split.dropped).toHaveLength(0);
    const currentNames = split.current.map((offer) => offer.name);
    expect(currentNames).toEqual(expect.arrayContaining(['Bananen', 'Le Gruyère AOP']));
  });
});

// Defensiv: REWE-Import darf andere Shops nicht beeinflussen — alle erzeugten
// Offers tragen ausschließlich die REWE-Kette.
describe('REWE-Import — keine Regression für andere Shops', () => {
  it('markiert ausschließlich REWE und browser-import', () => {
    const request: ReweBrowserImportRequest = {
      source: 'rewe-browser',
      offers: [{ name: 'Bananen', price: '1,79' }],
    };
    const result = normalizeReweBrowserImportRequest(request, at);
    for (const offer of result.offers) {
      expect(offer.storeChain).toBe('REWE');
      expect(offer.tags).toContain('browser-import');
    }
  });
});
