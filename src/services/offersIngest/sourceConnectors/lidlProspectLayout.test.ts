import { describe, expect, it } from 'vitest';
import {
  extractLidlLayoutOffers,
  runLidlProspectOcr,
  type LidlProspectOcrContext,
  type OcrLayoutPage,
} from './lidlProspectOcr';
import {
  fakePngBytes,
  LAYOUT_AMBIGUOUS_PRICE,
  LAYOUT_BASE_PRICE_ONLY,
  LAYOUT_COLOR_PRICE,
  LAYOUT_FOOD_BIG_PRICE,
  LAYOUT_GARBAGE_NAME,
  LAYOUT_NONFOOD_DEVICE,
  LAYOUT_NONFOOD_ICEMAKER,
  LAYOUT_OFFER_OVER_BASE,
  LAYOUT_TOPLEFT_BADGE,
  LAYOUT_TWO_CARDS_PAGE,
  LAYOUT_WEAK_NO_FOOD,
  makeLayoutPage,
} from './lidlProspect.fixture';

// Layout-aware Lidl-Prospektkarten-Extraktor. Die konkreten Produktnamen sind reine
// synthetische Test-Reproduktionen (KEINE KW-/Marken-Allowlist im Produktivcode) —
// getestet wird die generische Karten-/Preis-/Namens-Heuristik + das geteilte
// Sicherheitsgate. Koordinaten in den Fixtures bilden Position + Schriftgröße ab.

const CONTEXT: LidlProspectOcrContext = {
  storeChain: 'Lidl',
  sourceUrl: 'https://www.lidl.de/c/online-prospekte/s10005610',
  sourceId: 'lidl:aktionsprospekt-15-06-2026',
  validityStart: '2026-06-15T00:00:00.000Z',
  validityEnd: '2026-06-20T23:59:59.000Z',
};

describe('extractLidlLayoutOffers — Produktkarten-Heuristik', () => {
  it('Produktkarte mit großer Preisbox + Namensblock → 1 Layout-Kandidat', () => {
    const result = extractLidlLayoutOffers([LAYOUT_FOOD_BIG_PRICE], CONTEXT);
    expect(result.layoutCardsDetected).toBe(1);
    expect(result.layoutRawCandidates).toBe(1);
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].name.toLowerCase()).toContain('haehnchenbrust');
    expect(result.offers[0].price).toBe(2.99);
    // Quelle ist als Tag sichtbar (sourceKind).
    expect(result.offers[0].tags).toContain('layout_card');
  });

  it('Grundpreis nahe der Produktbeschreibung wird NICHT als Angebotspreis genommen', () => {
    const result = extractLidlLayoutOffers([LAYOUT_BASE_PRICE_ONLY], CONTEXT);
    expect(result.offers).toHaveLength(0);
    expect(result.layoutRawCandidates).toBe(0);
    expect(result.rejections.basePrice).toBeGreaterThanOrEqual(1);
  });

  it('großer Aktionspreis schlägt den kleinen Grundpreis (Angebotspreis 1,99, nicht 3,98)', () => {
    const result = extractLidlLayoutOffers([LAYOUT_OFFER_OVER_BASE], CONTEXT);
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].price).toBe(1.99);
    expect(result.offers[0].name.toLowerCase()).toContain('rispentomaten');
  });

  it('Top-left-Badge ("3 Stück") wird nie als Produktname genommen', () => {
    const result = extractLidlLayoutOffers([LAYOUT_TOPLEFT_BADGE], CONTEXT);
    expect(result.offers).toHaveLength(1);
    const name = result.offers[0].name.toLowerCase();
    expect(name).toContain('bananen');
    expect(name).not.toContain('stück');
    expect(name).not.toMatch(/\b3\b/);
    expect(result.offers[0].price).toBe(1.79);
  });

  it('Non-Food-Karte mit Preisbox (Akkuschrauber) → verworfen (nonFood)', () => {
    const result = extractLidlLayoutOffers([LAYOUT_NONFOOD_DEVICE], CONTEXT);
    expect(result.layoutRawCandidates).toBe(1);
    expect(result.offers).toHaveLength(0);
    expect(result.rejections.nonFood).toBe(1);
  });

  it('Non-Food-Küchengerät mit Food-naher Kategorie (Eiswürfelmaschine) → categoryConflict, nie live', () => {
    const result = extractLidlLayoutOffers([LAYOUT_NONFOOD_ICEMAKER], CONTEXT);
    expect(result.layoutRawCandidates).toBe(1);
    expect(result.offers).toHaveLength(0);
    expect(result.rejections.categoryConflict).toBe(1);
    expect(result.offers.some((o) => /maschine/i.test(o.name))).toBe(false);
  });

  it('OCR-Müllname (Fo g i m m) → verworfen (nameQuality)', () => {
    const result = extractLidlLayoutOffers([LAYOUT_GARBAGE_NAME], CONTEXT);
    expect(result.layoutRawCandidates).toBe(1);
    expect(result.offers).toHaveLength(0);
    expect(result.rejections.nameQuality).toBe(1);
  });

  it('Food-nahe Karte ohne starken Food-Beleg → missingStrongFoodEvidence, bleibt nicht live', () => {
    const result = extractLidlLayoutOffers([LAYOUT_WEAK_NO_FOOD], CONTEXT);
    expect(result.layoutRawCandidates).toBe(1);
    expect(result.offers).toHaveLength(0);
    expect(result.rejections.missingStrongFoodEvidence).toBe(1);
  });

  it('mehrere gleichprominente Preise in EINER Karte → lowLayoutConfidence (mehrdeutig), nicht live', () => {
    const result = extractLidlLayoutOffers([LAYOUT_AMBIGUOUS_PRICE], CONTEXT);
    expect(result.layoutRawCandidates).toBe(1);
    expect(result.offers).toHaveLength(0);
    expect(result.rejections.lowLayoutConfidence).toBe(1);
    // Es ist die Layout-Konfidenz, NICHT das Food-Gate, das hier blockt.
    expect(result.rejections.missingStrongFoodEvidence).toBe(0);
  });

  it('rote Aktionsfarbfläche macht einen normalgroßen Preis prominent → Kandidat', () => {
    const result = extractLidlLayoutOffers([LAYOUT_COLOR_PRICE], CONTEXT);
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].name.toLowerCase()).toContain('joghurt');
    expect(result.offers[0].price).toBe(0.99);
  });

  it('zwei klar getrennte Karten auf einer Seite → 2 Karten, 2 Food-Kandidaten', () => {
    const result = extractLidlLayoutOffers([LAYOUT_TWO_CARDS_PAGE], CONTEXT);
    expect(result.layoutCardsDetected).toBe(2);
    expect(result.layoutSafeCandidates).toBe(2);
    const names = result.offers.map((o) => o.name.toLowerCase());
    expect(names.some((n) => n.includes('rispentomaten'))).toBe(true);
    expect(names.some((n) => n.includes('haehnchenbrust'))).toBe(true);
  });

  it('Karte ohne Preisfläche → noPriceRegion (kein Roh-Kandidat)', () => {
    const page = makeLayoutPage([
      { text: 'Frische', x: 120, y: 120, w: 160, h: 38 },
      { text: 'Erdbeeren', x: 120, y: 175, w: 220, h: 38 },
    ]);
    const result = extractLidlLayoutOffers([page], CONTEXT);
    expect(result.layoutRawCandidates).toBe(0);
    expect(result.rejections.noPriceRegion).toBe(1);
    expect(result.offers).toHaveLength(0);
  });

  it('dedupliziert gegen bereits strukturiert importierte Namen', () => {
    const result = extractLidlLayoutOffers([LAYOUT_FOOD_BIG_PRICE], {
      ...CONTEXT,
      existingNameKeys: ['haehnchenbrust'],
    });
    expect(result.offers).toHaveLength(0);
    expect(result.rejections.duplicate).toBeGreaterThanOrEqual(1);
  });

  it('injizierter starker Food-Beleg rettet einen kategorie-losen Layout-Namen', () => {
    const page = makeLayoutPage([
      { text: 'Karottini', x: 120, y: 120, w: 200, h: 38 },
      { text: '1', x: 150, y: 205, w: 65, h: 115 },
      { text: '29', x: 230, y: 220, w: 50, h: 65 },
    ]);
    const result = extractLidlLayoutOffers([page], CONTEXT, {
      hasStrongFoodEvidence: ({ name }) => /karottini/i.test(name),
    });
    expect(result.offers).toHaveLength(1);
    expect(result.rejections.missingStrongFoodEvidence).toBe(0);
  });
});

// Layoutquelle in der vollständigen Glue (runLidlProspectOcr): die Layoutanalyse ist
// eine optionale, ZWEITE Kandidatenquelle. diagnostic emittiert nie live; live nur
// sichere Kandidaten. Der Textpfad (ocrImage) liefert hier bewusst keinen
// gruppierbaren Block, damit die Layout-Beiträge isoliert sichtbar sind.
describe('runLidlProspectOcr — Layoutquelle als zweite Kandidatenquelle', () => {
  const benignText = ['Prospekt der Woche', 'Jetzt entdecken'].join('\n');
  const fakeFetchBinary = async (): Promise<Uint8Array> => fakePngBytes();
  const layoutOf = (page: OcrLayoutPage) => async (): Promise<OcrLayoutPage> => page;

  it('live: emittiert sichere Layout-Kandidaten (sourceKind=layout_card)', async () => {
    const out = await runLidlProspectOcr({
      imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg'],
      context: CONTEXT,
      mode: 'live',
      ocrImage: async () => benignText,
      ocrLayout: layoutOf(LAYOUT_FOOD_BIG_PRICE),
      fetchBinary: fakeFetchBinary,
    });
    expect(out.counters.layoutCardsDetected).toBe(1);
    expect(out.counters.layoutRawCandidates).toBe(1);
    expect(out.counters.layoutSafeCandidates).toBe(1);
    expect(out.counters.finalEmittedOffers).toBe(1);
    expect(out.emittedOffers).toHaveLength(1);
    expect(out.emittedOffers[0].tags).toContain('layout_card');
    // Note + primaryReason weisen die Layout-Bilanz aus.
    expect(out.diagnostic.note).toMatch(/Layout: 1 Karten/);
    expect(out.diagnostic.note).toMatch(/layoutSafeCandidates/);
    expect(out.primaryReason).toMatch(/Layout:/);
  });

  it('diagnostic: liest Layoutkarten, gibt aber NICHTS live', async () => {
    const out = await runLidlProspectOcr({
      imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg'],
      context: CONTEXT,
      mode: 'diagnostic',
      ocrImage: async () => benignText,
      ocrLayout: layoutOf(LAYOUT_FOOD_BIG_PRICE),
      fetchBinary: fakeFetchBinary,
    });
    expect(out.counters.layoutSafeCandidates).toBe(1);
    expect(out.counters.finalEmittedOffers).toBe(0);
    expect(out.emittedOffers).toHaveLength(0);
  });

  it('live: ein unsicherer Layout-Kandidat (Non-Food) geht nicht live, ein sicherer schon', async () => {
    // Eine Seite mit zwei klar getrennten Karten: links Food (safe), rechts Non-Food.
    const page = makeLayoutPage([
      { text: 'Rispentomaten', x: 120, y: 120, w: 280, h: 40 },
      { text: '1', x: 150, y: 205, w: 60, h: 110 },
      { text: '99', x: 225, y: 220, w: 50, h: 65 },
      { text: 'Akkuschrauber', x: 680, y: 120, w: 280, h: 40 },
      { text: '49', x: 710, y: 205, w: 95, h: 110 },
      { text: '99', x: 820, y: 220, w: 50, h: 65 },
    ]);
    const out = await runLidlProspectOcr({
      imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg'],
      context: CONTEXT,
      mode: 'live',
      ocrImage: async () => benignText,
      ocrLayout: layoutOf(page),
      fetchBinary: fakeFetchBinary,
    });
    expect(out.counters.layoutCardsDetected).toBe(2);
    expect(out.counters.layoutRawCandidates).toBe(2);
    expect(out.emittedOffers).toHaveLength(1);
    expect(out.emittedOffers[0].name.toLowerCase()).toContain('rispentomaten');
    expect(out.layoutRejectedByReason.nonFood).toBe(1);
  });

  it('regression: Eiswürfelmaschine + OCR-Müll gehen auch über die Layoutquelle nicht live', async () => {
    const out = await runLidlProspectOcr({
      imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg', 'https://leaflet.cdn.schwarz/p2-lg.jpg'],
      context: CONTEXT,
      mode: 'live',
      ocrImage: async () => benignText,
      ocrLayout: (() => {
        const queue = [LAYOUT_NONFOOD_ICEMAKER, LAYOUT_GARBAGE_NAME];
        let index = 0;
        return async (): Promise<OcrLayoutPage> => queue[index++ % queue.length];
      })(),
      fetchBinary: fakeFetchBinary,
    });
    expect(out.emittedOffers).toHaveLength(0);
    expect(out.layoutRejectedByReason.categoryConflict).toBe(1);
    expect(out.layoutRejectedByReason.nameQuality).toBe(1);
  });

  it('dedupliziert die Layoutquelle gegen die Textzeilenquelle desselben Laufs', async () => {
    // Textzeile UND Layout erkennen DENSELBEN Namen (Haehnchenbrust) → nur EIN
    // Live-Angebot (Dedupe ist exakter Namensabgleich, quellenübergreifend).
    const out = await runLidlProspectOcr({
      imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg'],
      context: CONTEXT,
      mode: 'live',
      ocrImage: async () => ['Haehnchenbrust', '2,99 €'].join('\n'),
      ocrLayout: layoutOf(LAYOUT_FOOD_BIG_PRICE),
      fetchBinary: fakeFetchBinary,
    });
    // Textzeile liefert Haehnchenbrust; Layout dasselbe → dedupe.
    const names = out.emittedOffers.map((o) => o.name.toLowerCase());
    expect(names.filter((n) => n.includes('haehnchenbrust'))).toHaveLength(1);
    expect(out.layoutRejectedByReason.duplicate).toBeGreaterThanOrEqual(1);
  });

  it('ohne ocrLayout bleibt das reine Textzeilenverhalten (keine Layout-Counter)', async () => {
    const out = await runLidlProspectOcr({
      imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg'],
      context: CONTEXT,
      mode: 'live',
      ocrImage: async () => ['Frische Haehnchenbrust', '2,99 €'].join('\n'),
      fetchBinary: fakeFetchBinary,
    });
    expect(out.counters.layoutCardsDetected).toBe(0);
    expect(out.counters.layoutRawCandidates).toBe(0);
    expect(out.diagnostic.note).not.toMatch(/Layout:/);
    expect(out.emittedOffers.length).toBeGreaterThanOrEqual(1);
  });
});
