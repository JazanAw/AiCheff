import { describe, expect, it } from 'vitest';
import {
  extractLidlLayoutOffers,
  runLidlProspectOcr,
  type LidlProspectOcrContext,
  type OcrLayoutPage,
} from './lidlProspectOcr';
import {
  fakePngBytes,
  LAYOUT_DEPOSIT_ONLY,
  LAYOUT_DIGIT_CONFUSION,
  LAYOUT_REAL_GARBLED_TILE_BASEPRICE,
  LAYOUT_REAL_GARBLED_TILE_NO_PRICE,
  LAYOUT_REAL_ONLY_DATE,
  LAYOUT_SPLIT_NOT_COMBINED,
} from './lidlProspect.fixture';

// Preisregion-Feindiagnose der Layoutquelle. Hintergrund (echte Lidl-Full-Scan-
// Evidence): die stylisierten Großpreis-Tiles werden vom OCR zu Low-Conf-Glyphen
// verstümmelt — es existieren GAR keine preisförmigen Tokens, nur Gültigkeitsdaten
// und Grundpreise. Der Extractor darf daraus KEINEN Preis erfinden; die Diagnose
// muss die echte Ursache (noPriceLikeWords/onlyDateOrLegal/splitPriceNotCombined)
// statt eines blanken noPriceRegion-Zählers ausweisen.

const CONTEXT: LidlProspectOcrContext = {
  storeChain: 'Lidl',
  sourceUrl: 'https://www.lidl.de/c/online-prospekte/s10005610',
  sourceId: 'lidl:aktionsprospekt-15-06-2026',
  validityStart: '2026-06-15T00:00:00.000Z',
  validityEnd: '2026-06-20T23:59:59.000Z',
};

describe('noPriceRegion-Feindiagnose (echte Wordbox-Evidence)', () => {
  it('verstümmelter Preis-Tile + Grundpreis → basePrice, NIE den Grundpreis als Angebot', () => {
    const result = extractLidlLayoutOffers([LAYOUT_REAL_GARBLED_TILE_BASEPRICE], CONTEXT);
    expect(result.layoutCardsDetected).toBe(1);
    // Der verstümmelte „£08"-Tile ist kein Preis; das einzige preisförmige Token ist
    // der Grundpreis 39.96 → basePrice, kein Roh-Kandidat, nichts live.
    expect(result.layoutRawCandidates).toBe(0);
    expect(result.rejections.basePrice).toBe(1);
    expect(result.rejections.noPriceRegion).toBe(0);
    expect(result.offers).toHaveLength(0);
  });

  it('verstümmelter Preis-Tile ohne Grundpreis → noPriceRegion / noPriceLikeWords (kein erfundener Preis)', () => {
    const result = extractLidlLayoutOffers([LAYOUT_REAL_GARBLED_TILE_NO_PRICE], CONTEXT);
    expect(result.layoutCardsDetected).toBe(1);
    expect(result.layoutRawCandidates).toBe(0);
    expect(result.rejections.noPriceRegion).toBe(1);
    expect(result.noPriceRegionDetail.noPriceLikeWords).toBe(1);
    expect(result.offers).toHaveLength(0);
  });

  it('nur Gültigkeits-Tagesdatum (15.6.) → noPriceRegion / onlyDateOrLegal (keine KW-Logik, Datum ≠ Preis)', () => {
    const result = extractLidlLayoutOffers([LAYOUT_REAL_ONLY_DATE], CONTEXT);
    expect(result.layoutRawCandidates).toBe(0);
    expect(result.rejections.noPriceRegion).toBe(1);
    expect(result.noPriceRegionDetail.onlyDateOrLegal).toBe(1);
    expect(result.noPriceRegionDetail.noPriceLikeWords).toBe(0);
  });

  it('Euro/Cent räumlich benachbart aber in getrennten Zeilen → splitPriceNotCombined', () => {
    const result = extractLidlLayoutOffers([LAYOUT_SPLIT_NOT_COMBINED], CONTEXT);
    expect(result.layoutRawCandidates).toBe(0);
    expect(result.rejections.noPriceRegion).toBe(1);
    expect(result.noPriceRegionDetail.splitPriceNotCombined).toBe(1);
  });
});

describe('Preisregion-Erkennung bleibt für ECHTE Preis-Optiken erhalten', () => {
  it('OCR-Digit-Verwechsler im Layout-Preis (Euro „l" → 1) → Preis 1,99 erkannt', () => {
    const result = extractLidlLayoutOffers([LAYOUT_DIGIT_CONFUSION], CONTEXT);
    expect(result.layoutRawCandidates).toBe(1);
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].price).toBe(1.99);
    expect(result.offers[0].name.toLowerCase()).toContain('speisequark');
  });

  it('Layout-Pfandzeile (zzgl. 0,25 Pfand) → deposit, nie Angebotspreis', () => {
    const result = extractLidlLayoutOffers([LAYOUT_DEPOSIT_ONLY], CONTEXT);
    expect(result.layoutRawCandidates).toBe(0);
    expect(result.rejections.deposit).toBe(1);
    expect(result.offers).toHaveLength(0);
  });
});

describe('Report-Note weist die dominante noPriceRegion-Ursache aus', () => {
  const benignText = ['Prospekt der Woche', 'Jetzt entdecken'].join('\n');
  const fakeFetchBinary = async (): Promise<Uint8Array> => fakePngBytes();
  const layoutOf = (page: OcrLayoutPage) => async (): Promise<OcrLayoutPage> => page;

  it('Karten erkannt, 0 Kandidaten, OCR-Müll-Tile → Note nennt noPriceLikeWords, nichts live', async () => {
    const out = await runLidlProspectOcr({
      imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg'],
      context: CONTEXT,
      mode: 'live',
      ocrImage: async () => benignText,
      ocrLayout: layoutOf(LAYOUT_REAL_GARBLED_TILE_NO_PRICE),
      fetchBinary: fakeFetchBinary,
    });
    expect(out.counters.layoutCardsDetected).toBe(1);
    expect(out.counters.layoutRawCandidates).toBe(0);
    expect(out.counters.finalEmittedOffers).toBe(0);
    expect(out.emittedOffers).toHaveLength(0);
    expect(out.diagnostic.note).toMatch(/noPriceRegion: noPriceLikeWords/);
  });
});
