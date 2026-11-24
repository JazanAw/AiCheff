import { describe, expect, it } from 'vitest';
import {
  KNOWN_REWE_OFFERS,
  type ReweKnownOffer,
  buildReweMissingReport,
  checkReweKeywords,
  classifyReweOfferPresence,
  describeReweMissingOffers,
} from './reweMissingReport';

// Red Bull ist hier NUR ein Fixture-Beispiel, um die Mechanik zu testen — im
// Produktivcode gibt es keine hardcodierten Produkt-Sollwerte (KNOWN_REWE_OFFERS
// ist leer); bekannte Angebote kommen ausschließlich vom Aufrufer.
const RED_BULL_FIXTURE: ReweKnownOffer = {
  name: 'Red Bull Energy Drink',
  keywords: ['red bull', 'redbull', 'energy drink'],
  expectedPrice: 0.85,
  category: 'Getränke Alkoholfrei',
  source: 'official_web_snippet',
};

const RED_BULL_PDF_TEXT = `
Alkoholfreie Getränke
Red Bull Energy Drink
versch. Sorten, koffeinhaltig, je 0,25-l-Dose, (1 l = 3,96 €), zzgl. 0,25 € Pfand
Knaller
0,99 €
`;

describe('checkReweKeywords', () => {
  it('marks each searched keyword as found/not-found per source', () => {
    const checks = checkReweKeywords(['Red', 'Bull', 'Energy', '0,85'], {
      pdfText: RED_BULL_PDF_TEXT,
    });
    const byKeyword = new Map(checks.map((check) => [check.keyword, check]));
    expect(byKeyword.get('Red')?.inPdf).toBe(true);
    expect(byKeyword.get('Bull')?.inPdf).toBe(true);
    expect(byKeyword.get('Energy')?.inPdf).toBe(true);
    // The PDF lists 0,99 €, NOT the web's 0,85 € — must be reported as not found.
    expect(byKeyword.get('0,85')?.found).toBe(false);
    expect(byKeyword.get('Red')?.found).toBe(true);
  });
});

describe('classifyReweOfferPresence', () => {
  it('imported offer is "imported" regardless of where else it appears', () => {
    expect(
      classifyReweOfferPresence({ imported: true, inPdf: true, inWeb: true, webChecked: true }),
    ).toBe('imported');
  });

  it('in the PDF text but not parsed → presentInPdfButNotParsed', () => {
    expect(
      classifyReweOfferPresence({ imported: false, inPdf: true, inWeb: true, webChecked: true }),
    ).toBe('presentInPdfButNotParsed');
  });

  it('web knows it but the PDF does not → presentInWebButPdfMissing', () => {
    expect(
      classifyReweOfferPresence({ imported: false, inPdf: false, inWeb: true, webChecked: true }),
    ).toBe('presentInWebButPdfMissing');
  });

  it('not in PDF, no web evidence, web not verifiable → blockedWebVerification', () => {
    expect(
      classifyReweOfferPresence({ imported: false, inPdf: false, inWeb: false, webChecked: false }),
    ).toBe('blockedWebVerification');
  });

  it('not in PDF and web was checked without finding it → missingFromPdf', () => {
    expect(
      classifyReweOfferPresence({ imported: false, inPdf: false, inWeb: false, webChecked: true }),
    ).toBe('missingFromPdf');
  });
});

describe('buildReweMissingReport — Red Bull als Fixture-Beispiel', () => {
  it('flags Red Bull as presentInPdfButNotParsed when in the PDF but not imported', () => {
    const report = buildReweMissingReport({
      pdfText: RED_BULL_PDF_TEXT,
      importedNames: ['Coca-Cola', 'Desperados Beer'],
      knownOffers: [RED_BULL_FIXTURE],
    });
    const redBull = report.missingKnownOffers.find((offer) => /red bull/i.test(offer.name));
    expect(redBull).toBeDefined();
    expect(redBull?.status).toBe('presentInPdfButNotParsed');
    expect(redBull?.source).toBe('official_web_snippet');
    expect(redBull?.expectedPrice).toBeCloseTo(0.85);
  });

  it('does not list Red Bull as missing once it is imported', () => {
    const report = buildReweMissingReport({
      pdfText: RED_BULL_PDF_TEXT,
      importedNames: ['Red Bull Energy Drink'],
      knownOffers: [RED_BULL_FIXTURE],
    });
    expect(report.missingKnownOffers.some((offer) => /red bull/i.test(offer.name))).toBe(false);
    const status = report.knownOfferStatuses.find((offer) => /red bull/i.test(offer.name));
    expect(status?.status).toBe('imported');
  });

  it('flags Red Bull as presentInWebButPdfMissing only with live web evidence', () => {
    const report = buildReweMissingReport({
      pdfText: 'Coca-Cola\nKnaller\n1,49 €\n',
      webText: 'Red Bull Energy Drink 0,85 €',
      importedNames: ['Coca-Cola'],
      knownOffers: [RED_BULL_FIXTURE],
    });
    const redBull = report.missingKnownOffers.find((offer) => /red bull/i.test(offer.name));
    expect(redBull?.status).toBe('presentInWebButPdfMissing');
  });

  it('includes a keyword check row for the official price token (0,85)', () => {
    const report = buildReweMissingReport({
      pdfText: RED_BULL_PDF_TEXT,
      importedNames: [],
      knownOffers: [RED_BULL_FIXTURE],
    });
    expect(report.keywordChecks.some((check) => check.keyword === '0,85')).toBe(true);
    expect(report.keywordChecks.find((check) => check.keyword === '0,85')?.found).toBe(false);
  });
});

describe('buildReweMissingReport — keine statischen Produkt-Sollwerte', () => {
  it('meldet ohne explizite knownOffers keine missingKnownOffers', () => {
    const report = buildReweMissingReport({
      pdfText: 'Coca-Cola\nAktion\n1,49 €',
      importedNames: ['Coca-Cola'],
      webChecked: true,
    });
    expect(report.knownOfferStatuses).toEqual([]);
    expect(report.missingKnownOffers).toEqual([]);
    expect(report.health).toBe('ok');
  });

  it('meldet ein bekanntes Produkt OHNE Beleg in der aktuellen Quelle nicht als fehlend', () => {
    const report = buildReweMissingReport({
      pdfText: 'Coca-Cola\nAktion\n1,49 €',
      importedNames: ['Coca-Cola'],
      webText: 'Coca-Cola 1,49 €',
      webChecked: true,
      knownOffers: [RED_BULL_FIXTURE],
    });
    const status = report.knownOfferStatuses.find((offer) => /red bull/i.test(offer.name));
    // Status bleibt transparent sichtbar, aber KEIN Missing-Report und kein
    // Health-Malus — das Produkt ist diese Woche schlicht kein Angebot.
    expect(status?.status).toBe('missingFromPdf');
    expect(report.missingKnownOffers).toEqual([]);
    expect(report.health).toBe('ok');
  });

  it('web-derived source allein zählt nicht als Beleg (kein Treffer im Live-Web-Text)', () => {
    const report = buildReweMissingReport({
      pdfText: 'Coca-Cola\nAktion\n1,49 €',
      importedNames: ['Coca-Cola'],
      knownOffers: [RED_BULL_FIXTURE],
    });
    const status = report.knownOfferStatuses.find((offer) => /red bull/i.test(offer.name));
    expect(status?.inWeb).toBe(false);
    expect(status?.status).toBe('blockedWebVerification');
    expect(report.missingKnownOffers).toEqual([]);
  });
});

describe('describeReweMissingOffers', () => {
  it('returns undefined when nothing is missing', () => {
    expect(describeReweMissingOffers([])).toBeUndefined();
  });

  it('builds a status-aware warning that does not over-claim importability', () => {
    const warning = describeReweMissingOffers([
      {
        name: 'Red Bull Energy Drink',
        source: 'official_web_snippet',
        status: 'presentInWebButPdfMissing',
        inPdf: false,
        inWeb: true,
        imported: false,
      },
    ]);
    expect(warning).toContain('Red Bull Energy Drink');
    expect(warning).toMatch(/nicht im PDF/i);
  });
});

function block(overrides: Partial<import('./rewePromoAnchors').ReweParseBlock>) {
  return {
    lineIndex: 0,
    price: '1,99',
    priceValue: 1.99,
    promoAnchor: null,
    nameGuess: '',
    accepted: false,
    dropReason: null,
    bonusOrCoupon: false,
    ...overrides,
  };
}

describe('buildReweMissingReport — promo-anchor & dropped-block diagnostics', () => {
  it('lists the promo badges detected in the PDF text', () => {
    const report = buildReweMissingReport({
      pdfText: 'Kracher\n0,99 €\nHammerpreis\n1,49 €\nKnaller\n0,49 €',
      importedNames: [],
    });
    expect(report.promoAnchorsDetected).toEqual(
      expect.arrayContaining(['Kracher', 'Hammerpreis', 'Knaller']),
    );
  });

  it('flags promo-anchored prices that produced no live offer', () => {
    const report = buildReweMissingReport({
      pdfText: '',
      importedNames: [],
      parseBlocks: [
        block({ price: '1,99', promoAnchor: 'Hammerpreis', nameGuess: 'Hochland Sandwich', accepted: false, dropReason: 'badName' }),
        block({ price: '0,99', promoAnchor: 'Knaller', nameGuess: 'Echtes Produkt', accepted: true, dropReason: null }),
      ],
    });
    expect(report.promoAnchorsWithoutImportedOffer).toHaveLength(1);
    expect(report.promoAnchorsWithoutImportedOffer[0].promoAnchor).toBe('Hammerpreis');
  });

  it('collects suspicious dropped blocks (price + plausible name, not imported)', () => {
    const report = buildReweMissingReport({
      pdfText: '',
      importedNames: [],
      parseBlocks: [
        // A real price + plausible name that was dropped for an UNEXPLAINED reason.
        block({ price: '2,49', nameGuess: 'Tolles Markenprodukt', accepted: false, dropReason: 'badName' }),
        // Explained drops (sub-threshold teaser, secondary price) are NOT suspicious.
        block({ price: '0,10', nameGuess: '', accepted: false, dropReason: 'belowMinPrice' }),
        block({ price: '0,40', nameGuess: 'Schon importiert', accepted: false, dropReason: 'anchorHadInterveningPrice' }),
      ],
    });
    expect(report.suspiciousDroppedOfferBlocks).toHaveLength(1);
    expect(report.suspiciousDroppedOfferBlocks[0].nameGuess).toBe('Tolles Markenprodukt');
  });

  it('collects bonus/coupon price candidates', () => {
    const report = buildReweMissingReport({
      pdfText: '',
      importedNames: [],
      parseBlocks: [
        block({ price: '2,00', nameGuess: '', accepted: false, dropReason: 'bonusOrCoupon', bonusOrCoupon: true }),
        block({ price: '0,99', nameGuess: 'Normal', accepted: true }),
      ],
    });
    expect(report.bonusOrCouponPriceCandidates).toHaveLength(1);
    expect(report.bonusOrCouponPriceCandidates[0].price).toBe('2,00');
  });

  it('is "critical" when a control article is in the PDF but not imported', () => {
    const report = buildReweMissingReport({
      pdfText: 'Red Bull Energy Drink\nKnaller\n0,99 €',
      importedNames: [],
      knownOffers: [RED_BULL_FIXTURE],
    });
    expect(report.health).toBe('critical');
    expect(report.warnings.join(' ')).toMatch(/kontrollartikel/i);
    expect(report.missingLikelyOffers.some((offer) => /red bull/i.test(offer.name))).toBe(true);
  });

  it('reports review fragments as fragmentReconstructionNeeded (not ok)', () => {
    const report = buildReweMissingReport({
      pdfText: '',
      importedNames: ['Echtes Produkt'],
      reviewNames: ['ungarisch', 'Original'],
    });
    expect(report.fragmentReconstructionNeeded).toEqual(
      expect.arrayContaining(['ungarisch', 'Original']),
    );
    expect(report.requiresLayoutFallback).toBe(true);
    expect(report.health).not.toBe('ok');
  });

  it('flags a fragment that slipped into the LIVE feed as falseLiveFragments → critical', () => {
    const report = buildReweMissingReport({
      pdfText: '',
      importedNames: ['Echtes Produkt', 'Peanut'],
      webChecked: true,
    });
    expect(report.falseLiveFragments).toContain('Peanut');
    expect(report.health).toBe('critical');
  });

  it('is "warning" when many promo anchors yield no live offer', () => {
    const report = buildReweMissingReport({
      pdfText: '',
      importedNames: ['Eins'],
      parseBlocks: [
        block({ promoAnchor: 'Knaller', accepted: false, nameGuess: 'A', dropReason: 'badName' }),
        block({ promoAnchor: 'Kracher', accepted: false, nameGuess: 'B', dropReason: 'badName' }),
        block({ promoAnchor: 'Hammerpreis', accepted: false, nameGuess: 'C', dropReason: 'badName' }),
      ],
    });
    expect(report.health).toBe('warning');
  });

  it('marks web verification as blocked when webChecked is false', () => {
    const report = buildReweMissingReport({ pdfText: 'x', importedNames: ['x'], webChecked: false });
    expect(report.webVerification).toBe('blocked');
  });

  it('is "ok" when the control article is imported and nothing suspicious dropped', () => {
    const report = buildReweMissingReport({
      pdfText: 'Red Bull Energy Drink\nKnaller\n0,99 €',
      importedNames: ['Red Bull Energy Drink'],
      webChecked: true,
      knownOffers: [RED_BULL_FIXTURE],
    });
    expect(report.health).toBe('ok');
  });
});

describe('KNOWN_REWE_OFFERS', () => {
  it('ist leer — keine hardcodierten Produkt-Sollwerte im Produktivcode', () => {
    expect(KNOWN_REWE_OFFERS).toEqual([]);
  });
});
