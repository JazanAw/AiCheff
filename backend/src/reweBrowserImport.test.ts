import { describe, expect, it } from 'vitest';
import {
  assessReweImportQuality,
  countReweWebOfferCards,
  createReweBrowserImportBookmarkletScript,
  estimateReweWebMissing,
  normalizeReweBrowserImportRequest,
  parseGermanDateRange,
  pickReweCardPrice,
  resolveReweCategory,
  type ReweImportReportData,
} from './reweBrowserImport';
import { isHardBadOfferName, isLikelyFragmentName } from './offerNameQuality';

const at = new Date('2026-06-03T10:00:00Z');

describe('REWE web completeness estimate', () => {
  it('counts offer-price cards but ignores base/strike/bonus prices', () => {
    const html = `
      <div class="card"><h3>Produkt A</h3><span>2,99 €</span><span>(1 l = 3,99 €)</span></div>
      <div class="card"><h3>Produkt B</h3><span>1,49 €</span></div>
      <div class="card"><h3>Produkt C</h3><span>0,99 €</span><span>statt 1,49 €</span></div>
      <div>REWE Bonus 5,00 €</div>
    `;
    expect(countReweWebOfferCards(html)).toBe(3);
  });

  it('estimates possible missing offers vs. the imported live count', () => {
    expect(estimateReweWebMissing(65, 59)).toBe(6);
    expect(estimateReweWebMissing(50, 59)).toBe(0);
  });
});

describe('REWE browser import', () => {
  it('liest deutsche Gueltigkeitsbereiche', () => {
    expect(parseGermanDateRange('4.5. bis 10.5.', new Date('2026-05-09T10:00:00Z'))).toEqual({
      start: '2026-05-04T00:00:00.000Z',
      end: '2026-05-10T23:59:59.999Z',
    });
  });

  it('normalisiert sichtbare REWE-Angebote fuer den Snapshot', () => {
    const result = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        pageUrl: 'https://www.rewe.de/angebote/nationale-angebote/',
        validityLabel: '4.5. bis 10.5.',
        offers: [
          {
            name: 'Weihenstephan Butter oder Die Streichzarte',
            price: '1,19 €',
            description: 'versch. Sorten, je 250-g-Pckg. / 250-g-Becher, (1 kg = 4,76 €)',
            imageUrl: '/assets/butter.jpg',
            sourceUrl: '/angebote/nationale-angebote/',
            category: 'Top-Angebote',
          },
          {
            name: 'Milka Pralines',
            price: 'ungueltig',
          },
        ],
      },
      new Date('2026-05-09T10:00:00Z'),
    );

    expect(result.skippedCount).toBe(1);
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0]).toMatchObject({
      name: 'Weihenstephan Butter oder Die Streichzarte',
      normalizedName: 'weihenstephan butter oder die streichzarte',
      storeChain: 'REWE',
      price: 1.19,
      currency: 'EUR',
      unit: '250-g-Pckg',
      basePrice: 4.76,
      baseUnit: '1 kg',
      validityStart: '2026-05-04T00:00:00.000Z',
      validityEnd: '2026-05-10T23:59:59.999Z',
      imageUrl: 'https://www.rewe.de/assets/butter.jpg',
      tags: ['rewe', 'browser-import'],
    });
  });

  it('behält die rohe REWE-Sektionsüberschrift als sourceCategoryRaw', () => {
    const result = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        pageUrl: 'https://www.rewe.de/angebote/nationale-angebote/',
        validityLabel: '4.5. bis 10.5.',
        offers: [
          {
            name: 'Weihenstephan Butter',
            price: '1,19 €',
            description: 'versch. Sorten, je 250-g-Pckg.',
            sourceUrl: '/angebote/nationale-angebote/',
            category: 'Kühlung',
          },
        ],
      },
      new Date('2026-05-09T10:00:00Z'),
    );
    // The raw section heading survives even though the simple category is
    // re-resolved name-first (REWE flat-stream headings carry over wrongly).
    expect(result.offers[0].sourceCategoryRaw).toBe('Kühlung');
    expect(result.offers[0].sourceContextRaw).toContain('versch. Sorten');
  });
});

describe('REWE import — Preis-Merge (Grundpreis vs. Aktionspreis)', () => {
  it('nimmt bei mehreren Preisen derselben Karte den großen Aktionspreis, nicht den Teilpreis', () => {
    const result = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        offers: [
          {
            name: 'Mederano de Freixenet oder Freixenet Mia Wein',
            price: '2,99',
            description: 'je 0,75-l-Flasche',
            category: 'Wein & Spirituosen',
          },
          {
            name: 'Mederano de Freixenet oder Freixenet Mia Wein',
            price: '0,40',
            category: 'Wein & Spirituosen',
          },
        ],
      },
      at,
    );

    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].price).toBe(2.99);
    expect(result.report.suspiciousPrices).toEqual([
      expect.objectContaining({
        name: 'Mederano de Freixenet oder Freixenet Mia Wein',
        usedPrice: 2.99,
        ignoredPrices: [0.4],
      }),
    ]);
    expect(result.report.duplicateCandidates).toContain(
      'Mederano de Freixenet oder Freixenet Mia Wein',
    );
  });
});

describe('REWE import — Fragmentnamen werden nicht live gestellt', () => {
  it('hält Fragmentnamen als Review zurück, echte Produkte bleiben live', () => {
    const result = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        offers: [
          { name: 'Peanut', price: '1,49' },
          { name: 'Original', price: '0,99' },
          { name: 'mit milder Rauchnote', price: '2,49' },
          { name: 'Schoko Meersalz', price: '1,99' },
          { name: 'Bananen', price: '1,29' },
          { name: 'Coca-Cola', price: '0,99' },
        ],
      },
      at,
    );

    const liveNames = result.offers.map((o) => o.name);
    expect(liveNames).not.toContain('Peanut');
    expect(liveNames).not.toContain('Schoko Meersalz');
    // Echte Produkte bleiben live (nicht blind gelöscht).
    expect(liveNames).toEqual(expect.arrayContaining(['Bananen', 'Coca-Cola']));

    expect(result.reviewOffers.map((o) => o.name)).toEqual(
      expect.arrayContaining(['Peanut', 'Original', 'mit milder Rauchnote', 'Schoko Meersalz']),
    );
    expect(result.report.skippedFragments).toEqual(
      expect.arrayContaining(['Peanut', 'Schoko Meersalz']),
    );
    expect(result.reviewOffers.every((o) => o.tags.includes('name_fragment'))).toBe(true);
    expect(result.report.rawCount).toBe(6);
    expect(result.report.normalizedCount).toBe(result.offers.length);
  });
});

describe('pickReweCardPrice — robuste Preiswahl aus einer Browser-Karte', () => {
  it('nimmt den Knaller-/Aktionspreis, nicht Grundpreis oder Pfand', () => {
    const cardText = [
      'Red Bull Energy Drink',
      'versch. Sorten, koffeinhaltig',
      'je 0,25-l-Dose',
      '(1 l = 3,40 €)',
      'zzgl. 0,25 € Pfand',
      'Knaller',
      '0,85 €',
    ].join('\n');
    expect(pickReweCardPrice(cardText)).toBe('0,85');
  });

  it('ignoriert Grund-/Pfand-/Streichpreise auch ohne Anker', () => {
    const cardText = ['(1 l = 3,40 €)', 'statt 1,49 €', 'zzgl. 0,25 € Pfand', '0,85 €'].join('\n');
    expect(pickReweCardPrice(cardText)).toBe('0,85');
  });

  it('liefert leeren String, wenn nur Grund-/Pfandpreise vorhanden sind', () => {
    expect(pickReweCardPrice('(1 l = 3,40 €)\nzzgl. 0,25 € Pfand')).toBe('');
  });

  it('nutzt dieselbe Promo-Anker-Liste wie der PDF-Parser (Hammerpreis, Kracher, Top-Angebot)', () => {
    expect(pickReweCardPrice('Hochland Sandwich\n(1 kg = 9,95 €)\nHammerpreis\n1,99 €')).toBe('1,99');
    expect(pickReweCardPrice('Coca-Cola\nzzgl. 0,25 € Pfand\nKracher\n0,99 €')).toBe('0,99');
    expect(pickReweCardPrice('Landliebe\nTop-Angebot\n0,49 €')).toBe('0,49');
  });

  it('nimmt einen reinen Bonus-/Coupon-Preis nicht als normalen Preis', () => {
    expect(pickReweCardPrice('Treuepunkte mit der App\n0,50 €')).toBe('');
    expect(pickReweCardPrice('REWE Bonus\nnur mit Coupon\n2,00 €')).toBe('');
  });
});

describe('REWE Browser-Import — simulierte Red-Bull-Karte wird zu einem Offer', () => {
  it('normalisiert die vom Browser gelieferte Red-Bull-Karte korrekt', () => {
    const result = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        offers: [
          {
            name: 'Red Bull Energy Drink',
            price: '0,85',
            description: 'versch. Sorten, koffeinhaltig, je 0,25-l-Dose, (1 l = 3,40 €), zzgl. 0,25 € Pfand',
            category: 'Alkoholfreie Getränke',
            imageUrl: '/assets/redbull.png',
            sourceUrl: '/angebote/nationale-angebote/',
          },
        ],
      },
      at,
    );

    expect(result.offers).toHaveLength(1);
    expect(result.offers[0]).toMatchObject({
      name: 'Red Bull Energy Drink',
      storeChain: 'REWE',
      price: 0.85,
      category: 'Getränke Alkoholfrei',
    });
    // Red Bull darf NICHT als Fragment zurückgehalten werden.
    expect(result.reviewOffers).toHaveLength(0);
    expect(result.offers[0].tags).not.toContain('name_fragment');
  });

  it('mappt Red Bull Energy Drink auf Getränke Alkoholfrei', () => {
    expect(resolveReweCategory('Alkoholfreie Getränke', 'Red Bull Energy Drink', '')).toBe(
      'Getränke Alkoholfrei',
    );
  });

  it('markiert "Red Bull Energy Drink" nicht als Fragment', () => {
    expect(isLikelyFragmentName('Red Bull Energy Drink')).toBe(false);
  });

  it('bettet die robuste Preiswahl in das Bookmarklet ein', () => {
    expect(createReweBrowserImportBookmarkletScript()).toContain('pickReweCardPrice');
  });
});

describe('REWE Phase 1 — Fragment-Schutz (Variantenzeilen nie als Einzelartikel)', () => {
  it('hält orphan-Varianten zurück, echte Produkte bleiben live', () => {
    const { offers, reviewOffers } = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        offers: [
          { name: 'Funny-frisch Frit-Sticks ungarisch', price: '0,99' },
          { name: 'Share Protein Bites Peanut', price: '2,29' },
          { name: 'Mini Cherry Rispentomaten »Delizioso«', price: '3,00' },
          // Orphaned variant lines that must NOT become their own live offer:
          { name: 'ungarisch', price: '1,11' },
          { name: 'Original', price: '1,11' },
          { name: 'Peanut', price: '2,29' },
          { name: 'Schoko Meersalz', price: '1,79' },
          { name: 'mit milder Rauchnote', price: '3,49' },
        ],
      },
      at,
    );

    const liveNames = offers.map((o) => o.name);
    expect(liveNames).toEqual(
      expect.arrayContaining([
        'Funny-frisch Frit-Sticks ungarisch',
        'Share Protein Bites Peanut',
        'Mini Cherry Rispentomaten »Delizioso«',
      ]),
    );
    for (const fragment of ['ungarisch', 'Original', 'Peanut', 'Schoko Meersalz', 'mit milder Rauchnote']) {
      expect(liveNames).not.toContain(fragment);
    }
    expect(reviewOffers.map((o) => o.name)).toEqual(
      expect.arrayContaining(['ungarisch', 'Original']),
    );
  });
});

describe('REWE import — Kategorie name-first + Korrektur-Tracking', () => {
  it('korrigiert falsche Heading-Kategorien anhand des Produktnamens', () => {
    const result = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        offers: [
          { name: 'Lindt Lindor', price: '3,99', category: 'Wein & Spirituosen' },
          { name: "Ben & Jerry's Ice Cream", price: '3,49', category: 'Süßes & Salziges' },
          { name: 'Bonduelle Kopfsalat', price: '0,99', category: 'Sonstiges' },
          { name: 'Barilla Collezione Farfalle', price: '1,49', category: 'Tiefkühl' },
        ],
      },
      at,
    );

    const cat = new Map(result.offers.map((o) => [o.name, o.category]));
    expect(cat.get('Lindt Lindor')).toBe('Snacks/Süßes');
    expect(cat.get("Ben & Jerry's Ice Cream")).toBe('Tiefkühl');
    expect(cat.get('Bonduelle Kopfsalat')).toBe('Obst/Gemüse');
    expect(cat.get('Barilla Collezione Farfalle')).toBe('Trockenware');

    expect(result.report.categoryCorrections).toEqual(
      expect.arrayContaining([
        { name: 'Lindt Lindor', from: 'Alkohol', to: 'Snacks/Süßes' },
        { name: 'Barilla Collezione Farfalle', from: 'Tiefkühl', to: 'Trockenware' },
      ]),
    );
  });
});

describe('REWE import — generische Bad Names gehen nie live', () => {
  it('haelt "Tiefpreis", "Fl.", "Dose", "Packung" als Review zurueck', () => {
    const result = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        offers: [
          { name: 'Tiefpreis', price: '0,85 €' },
          { name: 'Fl.', price: '1,99 €' },
          { name: 'Dose', price: '0,99 €' },
          { name: 'Packung', price: '2,49 €' },
          { name: 'Red Bull Energy Drink', price: '0,85 €' },
        ],
      },
      at,
    );

    expect(result.offers.map((offer) => offer.name)).toEqual(['Red Bull Energy Drink']);
    // "Tiefpreis" ist ein Promo-Badge ⇒ begründeter Skip (kein Food-Review, P2);
    // die nackten Mengeneinheiten bleiben Fragment-Review (Rekonstruktion).
    expect(result.reviewOffers.map((offer) => offer.name).sort()).toEqual(
      ['Dose', 'Fl.', 'Packung'].sort(),
    );
    expect(result.report.skippedNonProductCount).toBe(1);
    expect((result.report.skippedNonProductExamples ?? []).some((e) => e.startsWith('Tiefpreis'))).toBe(
      true,
    );
    // Kein Live-Angebot darf ein Fragment sein.
    expect(result.report.falseLiveFragments).toEqual([]);
    for (const offer of result.offers) {
      expect(isLikelyFragmentName(offer.name)).toBe(false);
    }
  });

  it('erkennt die Bad Names auch direkt als Fragmente', () => {
    for (const name of ['Tiefpreis', 'Fl.', 'Dose', 'Packung', 'Aktion', 'Knaller', '2 Dosen']) {
      expect(isLikelyFragmentName(name)).toBe(true);
    }
    for (const name of ['Red Bull Energy Drink', 'Bananen', 'Coca-Cola Dose 0,33l']) {
      expect(isLikelyFragmentName(name)).toBe(false);
    }
  });

  it('harte Variante (Scan-Quarantäne/Gate): Promo-Namen ja, echte Produkte nie', () => {
    // Reine Promo-/Verpackungs-/Deskriptor-Namen → hart schlecht.
    for (const name of ['Tiefpreis', 'Fl.', 'Dose', 'Packung', 'Kracher', 'Original', '0,0 %']) {
      expect(isHardBadOfferName(name)).toBe(true);
    }
    // Echte Produkte mit Artikel-/Präpositions-Präfix oder Promo-Prefix dürfen
    // NICHT hart gefiltert werden (die REWE-OCR-Leader-Regel gilt hier nicht).
    for (const name of [
      'Die Streichzarte gesalzen',
      'Der Große Bauer',
      'Mit Skyr',
      '*Mit Kaufland Card Joghurt mild',
      '5,0 ORIGINAL',
      'DER GRÜNE ALTENBURGER Ziegenweichkäse',
    ]) {
      expect(isHardBadOfferName(name)).toBe(false);
    }
  });

  it('harte Variante: Packungs-/OCR-Fragmente und generische Beschreibungen', () => {
    // Real beobachtete Live-Leaks: "l-Dose" (Verpackungs-OCR), "individuell
    // kombinierbar kernlos" (Beschreibungszeile einer Trauben-Karte),
    // "Märkte & Angebote" (Navigations-/Promo-Text), "Liter" (nackte Einheit).
    for (const name of [
      'l-Dose',
      'Liter',
      'individuell kombinierbar kernlos',
      'Märkte & Angebote',
    ]) {
      expect(isHardBadOfferName(name), name).toBe(true);
      expect(isLikelyFragmentName(name), name).toBe(true);
    }
    // Echte Produkte mit Bindestrich/Einheit/Deskriptor-Anteil bleiben gültig.
    for (const name of [
      'Coca-Cola Dose 0,33l',
      'Trauben kernlos',
      'Tex-Mex-Swirl',
      '5,0 ORIGINAL',
    ]) {
      expect(isHardBadOfferName(name), name).toBe(false);
    }
  });
});

describe('REWE Browser-Import — keine statischen Produkt-Sollwerte', () => {
  it('meldet kein Produkt als fehlend, das nicht in der aktuellen Quelle vorkommt', () => {
    // Red Bull ist diese Woche kein Angebot → es steht nicht im Payload und darf
    // weder als missingKnownOffer auftauchen noch die Import-Health abwerten.
    const result = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        offers: [{ name: 'Weihenstephan Butter', price: '1,19 €' }],
      },
      at,
    );

    expect(result.report.missingKnownOffers ?? []).toEqual([]);
    expect(result.report.importHealth).toBe('ok');
  });

  it('meldet ein importiertes Produkt nie als fehlend', () => {
    const result = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        offers: [{ name: 'Red Bull Energy Drink', price: '0,85 €' }],
      },
      at,
    );

    const missing = result.report.missingKnownOffers ?? [];
    expect(missing.map((offer) => offer.name)).not.toContain('Red Bull Energy Drink');
  });
});

describe('assessReweImportQuality — hartes Commit-Gate', () => {
  function baseReport(overrides: Partial<ReweImportReportData> = {}): ReweImportReportData {
    return {
      rawCount: 10,
      normalizedCount: 10,
      reviewCount: 0,
      skippedCount: 0,
      skippedFragments: [],
      suspiciousPrices: [],
      duplicateCandidates: [],
      categoryCorrections: [],
      importHealth: 'ok',
      ...overrides,
    };
  }

  it('blockt, wenn Fragmente live gegangen waeren', () => {
    const quality = assessReweImportQuality(
      baseReport({ falseLiveFragments: ['Tiefpreis'] }),
    );
    expect(quality.blockCommit).toBe(true);
    expect(quality.health).toBe('critical');
  });

  it('blockt, wenn ein bekanntes Angebot in der Quelle steht, aber nicht geparst wurde', () => {
    const quality = assessReweImportQuality(
      baseReport({
        missingKnownOffers: [
          {
            name: 'Red Bull Energy Drink',
            source: 'official_web_snippet',
            status: 'presentInPdfButNotParsed',
            inPdf: true,
            inWeb: true,
            imported: false,
          },
        ],
      }),
    );
    expect(quality.blockCommit).toBe(true);
  });

  it('blockt bei massenhaft verdaechtigen Preisen oder Dubletten', () => {
    const suspicious = Array.from({ length: 6 }, (_unused, index) => ({
      name: `Offer ${index}`,
      usedPrice: 9.99,
      ignoredPrices: [0.99],
    }));
    expect(
      assessReweImportQuality(baseReport({ suspiciousPrices: suspicious })).blockCommit,
    ).toBe(true);
    expect(
      assessReweImportQuality(
        baseReport({ duplicateCandidates: Array.from({ length: 6 }, (_u, i) => `Dup ${i}`) }),
      ).blockCommit,
    ).toBe(true);
  });

  it('laesst einen sauberen Import durch, Red-Bull-Fehlen ist nur warning', () => {
    const clean = assessReweImportQuality(baseReport());
    expect(clean.blockCommit).toBe(false);
    expect(clean.health).toBe('ok');

    const missingWarn = assessReweImportQuality(
      baseReport({
        missingKnownOffers: [
          {
            name: 'Red Bull Energy Drink',
            source: 'official_web_snippet',
            status: 'presentInWebButPdfMissing',
            inPdf: false,
            inWeb: true,
            imported: false,
          },
        ],
      }),
    );
    expect(missingWarn.blockCommit).toBe(false);
    expect(missingWarn.health).toBe('warning');
  });
});

describe('assessReweImportQuality — hohe Dubletten ≠ kaputt (Lazy-Render-Dedupe)', () => {
  /**
   * Build a report shaped like the live REWE bookmarklet import on 2026-06-22
   * (rawCount 190, normalizedCount 118, duplicateCandidates 69,
   * duplicateMergedCount 71) with a fully balanced, complete counting chain.
   * Overrides let each test couple the high duplicate share with a defect.
   */
  function balancedDupeReport(
    overrides: Partial<ReweImportReportData> = {},
  ): ReweImportReportData {
    return {
      rawCount: 190,
      normalizedCount: 118,
      reviewCount: 1,
      skippedCount: 0,
      duplicateMergedCount: 71,
      duplicateCandidates: Array.from({ length: 69 }, (_u, i) => `Dup ${i}`),
      completeness: {
        uniqueCardCandidates: 190,
        imported: 118,
        reviewHeldBack: 1,
        explainedRejected: 0,
        duplicates: 71,
        unexplainedMissing: 0,
      },
      countingChain: {
        payloadOffers: 190,
        serverSkipped: { noName: 0, noPrice: 0, sectionHeading: 0, nonProduct: 0 },
        serverDuplicatesMerged: 71,
        duplicatesMerged: 71,
        liveNormalized: 118,
        reviewHeldBack: 1,
        uniqueCardCandidates: 190,
        balanced: true,
        balanceErrors: [],
      },
      browserDiagnostics: { consistent: true },
      possibleWebMissingEstimate: 0,
      skippedFragments: [],
      suspiciousPrices: [],
      categoryCorrections: [],
      importHealth: 'ok',
      ...overrides,
    } as ReweImportReportData;
  }

  it('committet den Live-Befund 190/118/69 bei balancierter Zählkette (nur Warnung)', () => {
    const quality = assessReweImportQuality(balancedDupeReport());
    expect(quality.blockCommit).toBe(false);
    expect(quality.duplicateQuality).toBe('warning');
    expect(['ok', 'warning']).toContain(quality.health);
    // Die Begründung erklärt die deduplizierten Dubletten, ohne von "kaputt" zu reden.
    expect(quality.reasons.join(' ')).toMatch(/dedupliziert/i);
    expect(quality.reasons.join(' ')).not.toMatch(/kaputt|unsicher/i);
  });

  it('blockt hohe Dubletten + unbalancierte Zählkette', () => {
    const quality = assessReweImportQuality(
      balancedDupeReport({
        countingChain: {
          payloadOffers: 190,
          serverSkipped: { noName: 0, noPrice: 0, sectionHeading: 0, nonProduct: 0 },
          serverDuplicatesMerged: 71,
          duplicatesMerged: 71,
          liveNormalized: 118,
          reviewHeldBack: 1,
          uniqueCardCandidates: 190,
          balanced: false,
          balanceErrors: ['payload ≠ live + skipped + dupes'],
        },
      }),
    );
    expect(quality.blockCommit).toBe(true);
    expect(quality.duplicateQuality).toBe('blocking');
    expect(quality.reasons.join(' ')).toMatch(/unbalanciert/i);
  });

  it('blockt hohe Dubletten + unexplainedMissing > 0', () => {
    const quality = assessReweImportQuality(
      balancedDupeReport({
        completeness: {
          uniqueCardCandidates: 200,
          imported: 118,
          reviewHeldBack: 1,
          explainedRejected: 0,
          duplicates: 71,
          unexplainedMissing: 10,
        },
      }),
    );
    expect(quality.blockCommit).toBe(true);
    expect(quality.duplicateQuality).toBe('blocking');
  });

  it('blockt hohe Dubletten + inkonsistente Browser-Diagnose', () => {
    const quality = assessReweImportQuality(
      balancedDupeReport({ browserDiagnostics: { consistent: false } }),
    );
    expect(quality.blockCommit).toBe(true);
    expect(quality.duplicateQuality).toBe('blocking');
  });

  it('blockt hohe Dubletten + möglicher Web-Verlust (possibleWebMissingEstimate > 0)', () => {
    const quality = assessReweImportQuality(
      balancedDupeReport({ possibleWebMissingEstimate: 12 }),
    );
    expect(quality.blockCommit).toBe(true);
    expect(quality.duplicateQuality).toBe('blocking');
  });

  it('blockt weiterhin bei >50 % verdächtigen Preisen, auch mit balancierter Kette', () => {
    const suspicious = Array.from({ length: 60 }, (_u, i) => ({
      name: `Offer ${i}`,
      usedPrice: 9.99,
      ignoredPrices: [0.99],
    }));
    const quality = assessReweImportQuality(
      balancedDupeReport({ suspiciousPrices: suspicious }),
    );
    expect(quality.blockCommit).toBe(true);
  });

  it('blockt weiterhin bei Fragmenten im Live-Feed, auch mit balancierter Kette', () => {
    const quality = assessReweImportQuality(
      balancedDupeReport({ falseLiveFragments: ['Tiefpreis'] }),
    );
    expect(quality.blockCommit).toBe(true);
  });

  it('blockt weiterhin bei 0 Live-Angeboten', () => {
    const quality = assessReweImportQuality(
      balancedDupeReport({ normalizedCount: 0 }),
    );
    expect(quality.blockCommit).toBe(true);
  });

  it('blockt hohe Dubletten ohne Vollständigkeitsnachweis (z. B. PDF ohne Zählkette)', () => {
    const quality = assessReweImportQuality(
      balancedDupeReport({
        countingChain: undefined,
        browserDiagnostics: undefined,
        completeness: undefined,
        possibleWebMissingEstimate: undefined,
      }),
    );
    expect(quality.blockCommit).toBe(true);
    expect(quality.duplicateQuality).toBe('blocking');
    expect(quality.reasons.join(' ')).toMatch(/fehlendem Vollständigkeitsnachweis/i);
  });
});

describe('REWE Browser-Import — Obst/Gemüse-Wortgrenzen + Vollständigkeit (Shop-Prompt)', () => {
  it('klassifiziert Rispentomaten/Nektarinen als Obst/Gemüse, nie als Getränk', () => {
    expect(resolveReweCategory('Obst und Gemüse', 'Rispentomaten', '')).toBe('Obst/Gemüse');
    expect(resolveReweCategory('Obst und Gemüse', 'Gelbfleischige Nektarinen', '')).toBe('Obst/Gemüse');
    // echte Säfte/Nektare bleiben Getränk
    expect(resolveReweCategory('Getränke', 'Pfirsichnektar', '')).toBe('Getränke Alkoholfrei');
  });

  it('behält den Tiefkühl-Abteilungskontext bei zuverlässiger DOM-Überschrift (P3)', () => {
    // Browser: heading ist strukturell die echte Abteilung → Tiefkühl bleibt,
    // auch wenn der Name kein eigenes Frost-Signal trägt.
    expect(resolveReweCategory('Tiefkühl', 'Mini Laugen-Mix', '', true)).toBe('Tiefkühl');
    expect(resolveReweCategory('Tiefkühl', 'Wildlachs Filets', '', true)).toBe('Tiefkühl');
    // PDF/Screenshot (Default): mögliche Heading-Verschleppung wird weiter
    // entschärft — ein nacktes Tiefkühl ohne Namenssignal → Sonstiges.
    expect(resolveReweCategory('Tiefkühl', 'Mini Laugen-Mix', '')).toBe('Sonstiges');
    // Ein stärkeres eindeutiges Namenssignal gewinnt weiter (auch reliable).
    expect(resolveReweCategory('Tiefkühl', 'Barilla Farfalle', '', true)).toBe('Trockenware');
  });

  it('sammelt Angebote aus mehreren Sektions-Containern (Bonus/Obst/Bedientheke/Knaller)', () => {
    const result = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        offers: [
          { name: 'Rispentomaten', price: '0,99', category: 'Obst und Gemüse' },
          { name: 'Gelbfleischige Nektarinen', price: '3,99', category: 'Obst und Gemüse' },
          { name: 'Le Gruyère AOP', price: '2,49', category: 'An der Bedientheke' },
          { name: 'Neuburger', price: '1,99', category: 'An der Bedientheke' },
          { name: 'Maggi Guten Appetit Suppe', price: '0,99', category: 'Bonus-Aktionen' },
          { name: 'Paulaner Spezi', price: '0,79', category: 'Knaller' },
        ],
      },
      at,
    );

    // Alle 6 echten Container-Angebote werden normalisiert (kein Container verloren).
    expect(result.report.normalizedCount).toBe(6);
    const cat = new Map(result.offers.map((o) => [o.name, o.category]));
    expect(cat.get('Rispentomaten')).toBe('Obst/Gemüse');
    expect(cat.get('Gelbfleischige Nektarinen')).toBe('Obst/Gemüse');
  });

  it('meldet die Web-Lücke (Kachelzähler minus importiert) über possibleWebMissingEstimate', () => {
    const result = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        webCardCount: 80,
        offers: [
          { name: 'Rispentomaten', price: '0,99', category: 'Obst und Gemüse' },
          { name: 'Le Gruyère AOP', price: '2,49', category: 'An der Bedientheke' },
        ],
      },
      at,
    );
    expect(result.report.possibleWebMissingEstimate).toBe(78); // 80 sichtbar − 2 importiert
  });

  it('markiert ungewöhnlich niedrige Bonus-Preise transparent, statt sie zu löschen', () => {
    const result = normalizeReweBrowserImportRequest(
      {
        source: 'rewe-browser',
        offers: [
          { name: 'Oatly Haferdrink Barista', price: '0,10', category: 'Bonus-Aktionen' },
          { name: 'Frischer Zuckermais', price: '0,30', category: 'Bonus-Aktionen' },
          { name: 'Rispentomaten', price: '0,99', category: 'Obst und Gemüse' },
        ],
      },
      at,
    );
    const lowNames = (result.report.unusualLowPrices ?? []).map((entry) => entry.name).sort();
    expect(lowNames).toEqual(['Frischer Zuckermais', 'Oatly Haferdrink Barista']);
    // Die niedrigen Bonus-Preise bleiben echte Live-Angebote (nicht gelöscht).
    expect(result.offers.map((o) => o.name)).toContain('Oatly Haferdrink Barista');
    expect(result.offers.map((o) => o.name)).toContain('Frischer Zuckermais');
  });
});

describe('REWE Browser-Import — Bookmarklet lädt vollständig (Shop-Prompt 1)', () => {
  it('scrollt automatisch, klickt Aufklapp-Buttons und schickt webCardCount mit', () => {
    const script = createReweBrowserImportBookmarkletScript();
    // Vollständigkeits-Mechanik im Bookmarklet vorhanden:
    expect(script).toContain('autoLoad');
    expect(script).toContain('clickExpanders');
    expect(script).toContain('countReweWebOfferCards');
    expect(script).toContain('webCardCount');
    // injiziert den GETEILTEN DOM-Collector (gleiche Implementierung wie die
    // jsdom-Tests), nicht eine bookmarklet-eigene Kopie:
    expect(script).toContain('createReweDomCollector');
    expect(script).toContain('findReweCardElements');
    expect(script).toContain('extractReweCardFields');
    expect(script).toContain('isReweSectionHeadingName');
    const helperIndex = script.indexOf('const __name =');
    const firstInjectedFunctionIndex = script.indexOf('const pickReweCardPrice =');
    expect(helperIndex).toBeGreaterThanOrEqual(0);
    expect(firstInjectedFunctionIndex).toBeGreaterThan(helperIndex);
    // Name darf NIE mehr aus der Überschrift kommen:
    expect(script).not.toContain('normalize(heading.textContent)');
    // schickt die Zählkette als diagnostics mit:
    expect(script).toContain('diagnostics');
    expect(script).toContain('webCardCount = diagnostics.uniqueCardCandidates');
  });
});
