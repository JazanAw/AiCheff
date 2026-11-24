import { describe, expect, it } from 'vitest';
import {
  applyGrayscaleContrast,
  clusterWordsIntoCards,
  deriveCardName,
  determinePriceCropRegions,
  derivePriceCropOcrOptions,
  layoutBoxToTesseractRectangle,
  parseCropPrice,
  runLidlProspectOcr,
  type LayoutBox,
  type LidlProspectOcrContext,
  type OcrLayoutPage,
  type PriceCropOcr,
} from './lidlProspectOcr';
import {
  fakePngBytes,
  LAYOUT_CROP_BASEPRICE_ONLY,
  LAYOUT_CROP_DATE_ONLY,
  LAYOUT_CROP_FOOD_GARBLED,
  LAYOUT_CROP_GEOMETRIC_BIG_CLUSTER,
  LAYOUT_CROP_GEOMETRIC_FOOD,
  LAYOUT_CROP_GEOMETRIC_GARBAGE_NAME,
  LAYOUT_CROP_GEOMETRIC_NONFOOD,
  LAYOUT_CROP_GEOMETRIC_TOPLEFT_BADGE,
  LAYOUT_CROP_NONFOOD_GARBLED,
  makeLayoutPage,
} from './lidlProspect.fixture';

// Preisbox-OCR-Crop-Pass. Hintergrund (belegte Lidl-Full-Scan-Evidence): Layout
// erkennt Karten, aber die großen Aktionspreis-Tiles werden vom Seiten-OCR zu
// kaputten Low-Conf-Glyphen („£08") verstümmelt → 0 layoutRawCandidates. Der Crop-
// Pass OCRt NUR die kleine Preisbox-Region separat. Er darf keinen Preis aus
// kaputten Glyphen raten und nur sichere, food-belegte Kandidaten live schalten.

const CONTEXT: LidlProspectOcrContext = {
  storeChain: 'Lidl',
  sourceUrl: 'https://www.lidl.de/c/online-prospekte/s10005610',
  sourceId: 'lidl:aktionsprospekt-15-06-2026',
  validityStart: '2026-06-15T00:00:00.000Z',
  validityEnd: '2026-06-20T23:59:59.000Z',
};

// ── 1. parseCropPrice (pure): klare Formen erkennen, kaputtes verwerfen ──────
describe('parseCropPrice — sichere Crop-Preisformen', () => {
  it('klares „1,99" → Preis 1,99', () => {
    const out = parseCropPrice('1,99', 90);
    expect(out).toEqual({ ok: true, price: 1.99, raw: '1,99' });
  });

  it('Leerzeichen-Preis „1 99" (Crop-Kontext eindeutig) → 1,99', () => {
    const out = parseCropPrice('1 99', 88);
    expect(out.ok && out.price).toBe(1.99);
  });

  it('Strich-Cents „1,-" → 1,00 und Strich-Euro „-,99" → 0,99', () => {
    expect(parseCropPrice('1,-', 90)).toMatchObject({ ok: true, price: 1 });
    expect(parseCropPrice('-,99', 90)).toMatchObject({ ok: true, price: 0.99 });
  });

  it('kaputte Low-Confidence-Glyphe → cropOcrUnreadable, KEIN geratener Preis', () => {
    expect(parseCropPrice('£ l |', 20)).toEqual({ ok: false, reason: 'cropOcrUnreadable' });
    expect(parseCropPrice('', 0)).toEqual({ ok: false, reason: 'cropOcrUnreadable' });
  });

  it('Grundpreis im Crop (1 kg = 3,98) → cropLooksLikeBasePrice', () => {
    expect(parseCropPrice('1 kg = 3,98', 95)).toEqual({ ok: false, reason: 'cropLooksLikeBasePrice' });
  });

  it('Pfandzeile im Crop (zzgl. 0,25) → kein Angebotspreis (Grund-/Pfand-Veto)', () => {
    expect(parseCropPrice('zzgl. 0,25', 95)).toEqual({ ok: false, reason: 'cropLooksLikeBasePrice' });
  });

  it('Datum/Legal (15.6. / PLZ 74206) → cropLooksLikeDateOrLegal', () => {
    expect(parseCropPrice('15.6.', 95)).toEqual({ ok: false, reason: 'cropLooksLikeDateOrLegal' });
    expect(parseCropPrice('74206', 95)).toEqual({ ok: false, reason: 'cropLooksLikeDateOrLegal' });
  });

  it('mehrere plausible Preise im Crop → cropPriceAmbiguous', () => {
    expect(parseCropPrice('1,99 2,49', 95)).toEqual({ ok: false, reason: 'cropPriceAmbiguous' });
  });

  it('Confidence zu niedrig → cropPriceLowConfidence', () => {
    expect(parseCropPrice('1,99', 30, { minConfidence: 55 })).toEqual({
      ok: false,
      reason: 'cropPriceLowConfidence',
    });
  });
});

// ── 2. determinePriceCropRegions (pure): Geometrie ───────────────────────────
describe('determinePriceCropRegions — Anker aus Wortbox-Geometrie', () => {
  const cardOf = (page: OcrLayoutPage) => clusterWordsIntoCards(page)[0];

  it('verstümmelter Großpreis-Tile (£08) → akzeptierte Crop-Region mit linkedCardId + nearbyWords', () => {
    const card = cardOf(LAYOUT_CROP_FOOD_GARBLED);
    const regions = determinePriceCropRegions(card, 'card_x', { width: 1000, height: 1400 });
    const accepted = regions.filter((region) => region.accepted);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].linkedCardId).toBe('card_x');
    expect(accepted[0].nearbyWords).toContain('£08');
    expect(accepted[0].bbox.w).toBeGreaterThan(0);
    expect(accepted[0].bbox.h).toBeGreaterThan(0);
  });

  it('Karte mit NUR Grundpreis (kein prominenter Tile) → cropLooksLikeBasePrice (keine Region)', () => {
    const card = cardOf(LAYOUT_CROP_BASEPRICE_ONLY);
    const regions = determinePriceCropRegions(card, 'card_b', { width: 1000, height: 1400 });
    expect(regions.every((region) => !region.accepted)).toBe(true);
    expect(regions[0].rejectReason).toBe('cropLooksLikeBasePrice');
  });

  it('Karte mit NUR Gültigkeits-Tagesdatum (15.6.) → cropLooksLikeDateOrLegal (keine KW-Logik)', () => {
    const card = cardOf(LAYOUT_CROP_DATE_ONLY);
    const regions = determinePriceCropRegions(card, 'card_d', { width: 1000, height: 1400 });
    expect(regions.every((region) => !region.accepted)).toBe(true);
    expect(regions[0].rejectReason).toBe('cropLooksLikeDateOrLegal');
  });

  it('Anker außerhalb der (zu kleinen) Seite → cropOutsideCard (Region kollabiert)', () => {
    const farRight = makeLayoutPage(
      [
        { text: 'Rispentomaten', x: 900, y: 120, w: 200, h: 40 },
        { text: '£08', x: 950, y: 205, w: 100, h: 95 },
      ],
      { width: 1200, height: 1400 },
    );
    const card = clusterWordsIntoCards(farRight)[0];
    const regions = determinePriceCropRegions(card, 'card_o', { width: 300, height: 1400 });
    expect(regions.every((region) => !region.accepted)).toBe(true);
    expect(regions[0].rejectReason).toBe('cropOutsideCard');
  });

  it('Karte ohne ziffern-tragende Wörter → noCropRegion', () => {
    const noDigits = makeLayoutPage([
      { text: 'Frische', x: 120, y: 120, w: 160, h: 38 },
      { text: 'Kraeuter', x: 120, y: 175, w: 200, h: 38 },
    ]);
    const card = clusterWordsIntoCards(noDigits)[0];
    const regions = determinePriceCropRegions(card, 'card_n', { width: 1000, height: 1400 });
    expect(regions[0].rejectReason).toBe('noCropRegion');
  });

  it('deriveCardName nimmt den Karten-Namen (food), NIE den Crop-Preis', () => {
    const card = cardOf(LAYOUT_CROP_FOOD_GARBLED);
    expect(deriveCardName(card, 250)?.toLowerCase()).toContain('rispentomaten');
  });
});

// ── 3. Preprocessing (pure): Parameter + Graustufen-/Kontrast-Transform ───────
describe('Crop-Preprocessing (pure, testbar ohne canvas)', () => {
  it('kleine Box wird stärker hochskaliert als große', () => {
    const small: LayoutBox = { x: 0, y: 0, w: 60, h: 40 };
    const large: LayoutBox = { x: 0, y: 0, w: 400, h: 200 };
    expect(derivePriceCropOcrOptions(small).scale).toBeGreaterThan(derivePriceCropOcrOptions(large).scale);
    expect(derivePriceCropOcrOptions(small).whitelist).toContain('0123456789');
    expect(derivePriceCropOcrOptions(small).psm).toBe(7);
  });

  it('applyGrayscaleContrast vereinheitlicht R=G=B; Binarisierung erzwingt 0/255; Invertierung kippt', () => {
    // Ein roter und ein dunkler Pixel (RGBA).
    const pixels = new Uint8ClampedArray([200, 20, 20, 255, 10, 10, 10, 255]);
    applyGrayscaleContrast(pixels, { contrast: 1, threshold: 128, invert: false });
    // Pixel 1: Luminanz ~80 < 128 → 0; Pixel 2: ~10 → 0. Beide schwarz, R=G=B.
    expect([pixels[0], pixels[1], pixels[2]]).toEqual([0, 0, 0]);
    expect([pixels[4], pixels[5], pixels[6]]).toEqual([0, 0, 0]);
    expect(pixels[3]).toBe(255); // Alpha unberührt

    const bright = new Uint8ClampedArray([240, 240, 240, 255]);
    applyGrayscaleContrast(bright, { threshold: 128, invert: true });
    // 240 >= 128 → 255, invert → 0.
    expect(bright[0]).toBe(0);
  });
});

// ── 3b. Rectangle-Fallback-Mapping (pure): WebP-Crops ohne canvas ────────────
describe('layoutBoxToTesseractRectangle — Crop-Box → Tesseract-Rechteck', () => {
  it('floort Ursprung, ceilt Maße, klemmt auf nicht-negativ und min. 1px', () => {
    expect(layoutBoxToTesseractRectangle({ x: 12.7, y: 30.2, w: 40.1, h: 18.9 })).toEqual({
      left: 12,
      top: 30,
      width: 41,
      height: 19,
    });
    // Negative/entartete Box (geklemmter Anker am Rand) bleibt ein gültiges Rechteck.
    expect(layoutBoxToTesseractRectangle({ x: -5, y: -3, w: 0, h: 0 })).toEqual({
      left: 0,
      top: 0,
      width: 1,
      height: 1,
    });
  });
});

// ── 4. Orchestrierung: runLidlProspectOcr mit injizierter Crop-OCR ───────────
const fakeFetch = async (): Promise<Uint8Array> => fakePngBytes();
const layoutOf = (page: OcrLayoutPage) => async (): Promise<OcrLayoutPage> => page;
const cropOf =
  (text: string, confidence = 90): PriceCropOcr =>
  async () => ({ text, confidence });
/** Liefert je Aufruf das nächste OCR-Ergebnis (für „erst Region A, dann Region B"). */
const cropSequence = (outputs: readonly { text: string; confidence: number }[]): PriceCropOcr => {
  let call = 0;
  return async () => outputs[Math.min(call++, outputs.length - 1)];
};
const boxCenterYOf = (box: LayoutBox): number => box.y + box.h / 2;
const BENIGN_TEXT = ['Prospekt der Woche', 'Jetzt entdecken'].join('\n');

async function runCrop(opts: {
  layout: OcrLayoutPage;
  crop?: PriceCropOcr;
  mode?: 'diagnostic' | 'live';
  cropMode?: 'off' | 'diagnostic' | 'live';
}) {
  return runLidlProspectOcr({
    imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg'],
    context: CONTEXT,
    mode: opts.mode ?? 'live',
    ocrImage: async () => BENIGN_TEXT,
    ocrLayout: layoutOf(opts.layout),
    cropPriceOcr: opts.crop,
    priceCropMode: opts.cropMode ?? 'live',
    fetchBinary: fakeFetch,
  });
}

describe('Preisbox-Crop-Pass — Orchestrierung (live)', () => {
  it('Food-Karte + verstümmelter Tile + Crop „1,99" → sicherer price_crop-Kandidat live', async () => {
    const out = await runCrop({ layout: LAYOUT_CROP_FOOD_GARBLED, crop: cropOf('1,99') });
    expect(out.counters.layoutRawCandidates).toBe(0); // textbasierte Preisregion fand nichts
    expect(out.counters.priceCropAttempts).toBe(1);
    expect(out.counters.priceCropParsedPrices).toBe(1);
    expect(out.counters.cropRawCandidates).toBe(1);
    expect(out.counters.cropSafeCandidates).toBe(1);
    expect(out.priceCropResult.offers).toHaveLength(1);
    expect(out.emittedOffers).toHaveLength(1);
    expect(out.emittedOffers[0].price).toBe(1.99);
    expect(out.emittedOffers[0].tags).toContain('price_crop');
    expect(out.emittedOffers[0].name.toLowerCase()).toContain('rispentomaten');
  });

  it('Food-Karte + Crop „1 99" (Leerzeichenpreis) → Preis 1,99 erkannt', async () => {
    const out = await runCrop({ layout: LAYOUT_CROP_FOOD_GARBLED, crop: cropOf('1 99') });
    expect(out.priceCropResult.offers).toHaveLength(1);
    expect(out.priceCropResult.offers[0].price).toBe(1.99);
  });

  it('kaputte Crop-OCR-Glyphe → kein Preis geraten, cropOcrUnreadable, nichts live', async () => {
    const out = await runCrop({ layout: LAYOUT_CROP_FOOD_GARBLED, crop: cropOf('£ l |', 15) });
    expect(out.counters.priceCropAttempts).toBe(1);
    expect(out.counters.cropRawCandidates).toBe(0);
    expect(out.priceCropResult.rejections.cropOcrUnreadable).toBe(1);
    expect(out.emittedOffers).toHaveLength(0);
  });

  // Belegte Lidl-Full-Scan-Evidence (alle Prospektbilder sind WebP): die akzeptierten
  // Crop-Regionen tragen `parseReason: cropOcrUnreadable` OHNE jeden `ocrText` — d. h.
  // die Crop-OCR WARF (node-canvas decodiert WebP nicht), es lief gar kein OCR-Pass.
  // Das ist eine ANDERE Verluststufe als „OCR lief, Glyphen unlesbar" und muss in der
  // Zählkette getrennt sichtbar sein, sonst lügt die primaryReason.
  it('Crop-OCR wirft (z. B. nicht-decodierbares Bild) → cropRenderFailed statt cropOcrUnreadable', async () => {
    const cropThrows: PriceCropOcr = async () => {
      throw new Error('Unsupported image type');
    };
    const out = await runCrop({ layout: LAYOUT_CROP_FOOD_GARBLED, crop: cropThrows });
    expect(out.counters.priceCropAttempts).toBe(1);
    // Der Wurf wird NICHT mehr als „OCR lief, unlesbar" fehletikettiert.
    expect(out.priceCropResult.rejections.cropOcrUnreadable).toBe(0);
    expect(out.priceCropResult.rejections.cropRenderFailed).toBe(1);
    expect(out.counters.priceCropOcrSucceeded).toBe(0);
    expect(out.counters.cropRawCandidates).toBe(0);
    expect(out.emittedOffers).toHaveLength(0);
    expect(out.diagnostic.note).toMatch(/cropRenderFailed/);
  });

  it('Non-Food-Karte + plausibler Crop-Preis → Safety-Gate verwirft (nonFood), nichts live', async () => {
    const out = await runCrop({ layout: LAYOUT_CROP_NONFOOD_GARBLED, crop: cropOf('49,99') });
    expect(out.counters.cropRawCandidates).toBe(1); // Preis + Name gruppiert
    expect(out.counters.cropSafeCandidates).toBe(0);
    expect(out.priceCropResult.rejections.nonFood).toBe(1);
    expect(out.emittedOffers).toHaveLength(0);
  });

  it('Grundpreis-Karte → cropLooksLikeBasePrice, kein Crop-OCR-Versuch, nichts live', async () => {
    const out = await runCrop({ layout: LAYOUT_CROP_BASEPRICE_ONLY, crop: cropOf('1,99') });
    expect(out.counters.priceCropAttempts).toBe(0);
    expect(out.priceCropResult.rejections.cropLooksLikeBasePrice).toBe(1);
    expect(out.emittedOffers).toHaveLength(0);
  });

  it('Note nennt die getrennte Crop-Bilanz (priceCropAttempts/cropRawCandidates/cropSafeCandidates)', async () => {
    const out = await runCrop({ layout: LAYOUT_CROP_FOOD_GARBLED, crop: cropOf('1,99') });
    expect(out.diagnostic.note).toMatch(/Preis-Crop \(live\)/);
    expect(out.diagnostic.note).toMatch(/cropRawCandidates/);
    expect(out.diagnostic.note).toMatch(/cropSafeCandidates/);
  });
});

describe('Preisbox-Crop-Pass — Modus-Sicherheit', () => {
  it('diagnostic emittiert NIE live (Crop-Kandidat sicher, aber 0 emitted)', async () => {
    const out = await runCrop({
      layout: LAYOUT_CROP_FOOD_GARBLED,
      crop: cropOf('1,99'),
      mode: 'diagnostic',
      cropMode: 'live',
    });
    expect(out.priceCropResult.cropSafeCandidates).toBe(1);
    expect(out.emittedOffers).toHaveLength(0);
    expect(out.counters.finalEmittedOffers).toBe(0);
  });

  it('mode=live, aber cropMode=diagnostic → sicherer Crop-Kandidat, NICHT live', async () => {
    const out = await runCrop({
      layout: LAYOUT_CROP_FOOD_GARBLED,
      crop: cropOf('1,99'),
      mode: 'live',
      cropMode: 'diagnostic',
    });
    expect(out.priceCropResult.cropSafeCandidates).toBe(1);
    expect(out.emittedOffers.filter((offer) => offer.tags?.includes('price_crop'))).toHaveLength(0);
  });

  it('cropMode=off / keine Crop-OCR → kein Crop-Pass (default-off)', async () => {
    const off = await runCrop({ layout: LAYOUT_CROP_FOOD_GARBLED, crop: cropOf('1,99'), cropMode: 'off' });
    expect(off.counters.priceCropAttempts).toBe(0);
    expect(off.priceCropResult.cropRawCandidates).toBe(0);

    const noInjector = await runCrop({ layout: LAYOUT_CROP_FOOD_GARBLED, crop: undefined });
    expect(noInjector.counters.priceCropAttempts).toBe(0);
  });
});

// ── 5. GEOMETRISCHER (anker-freier) Preisbox-Finder ──────────────────────────
// Der belegte Blocker: die großen stilisierten Lidl-Aktionspreise werden vom Seiten-
// OCR NICHT als saubere Preis-/Ziffernwörter erkannt (kein ziffern-Anker). Der
// geometrische Finder muss die Preiszone trotzdem rein aus der Kartengeometrie
// ableiten — Preis kommt aus dem Crop, Name aus der Karte, dann das geteilte Gate.
describe('determineGeometricPriceRegions (pure) — anker-frei aus der Kartengeometrie', () => {
  const cardOf = (page: OcrLayoutPage) => clusterWordsIntoCards(page)[0];
  const overlaps = (a: LayoutBox, b: LayoutBox): boolean =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  it('Karte mit Name + großer Preisbox unten, KEIN OCR-Preiswort → akzeptierte geometrische Region(en)', () => {
    const card = cardOf(LAYOUT_CROP_GEOMETRIC_FOOD);
    const regions = determinePriceCropRegions(card, 'card_geo', { width: 1000, height: 1400 });
    const accepted = regions.filter((region) => region.accepted);
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    // Alle akzeptierten Regionen tragen eine GEOMETRISCHE Strategie (kein Ziffern-Anker).
    expect(accepted.every((region) => region.reason.startsWith('geometric'))).toBe(true);
    expect(accepted.every((region) => region.linkedCardId === 'card_geo')).toBe(true);
    // Mindestgröße erzwungen (keine winzigen Einzelzeichen-Crops).
    expect(accepted.every((region) => region.bbox.w >= 28 && region.bbox.h >= 16)).toBe(true);
    // Die Preiszone liegt UNTER dem Namensblock (kein Crop über dem Namen).
    expect(accepted.every((region) => region.bbox.y > 150)).toBe(true);
    // Name kommt aus der Karte (food), nie aus dem Crop.
    expect(deriveCardName(card, 260)?.toLowerCase()).toContain('rispentomaten');
  });

  it('Top-left-Badge „3 Stück" → nie als Preisregion gecroppt, nie als Name', () => {
    const card = cardOf(LAYOUT_CROP_GEOMETRIC_TOPLEFT_BADGE);
    const regions = determinePriceCropRegions(card, 'card_badge', { width: 1000, height: 1400 });
    const accepted = regions.filter((region) => region.accepted);
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    // Das Badge oben links (≈ x120..242, y100..130) wird von KEINER Region berührt.
    const badgeBox: LayoutBox = { x: 120, y: 100, w: 122, h: 30 };
    expect(accepted.some((region) => overlaps(region.bbox, badgeBox))).toBe(false);
    // Name = echter Namensblock, nie das Stückzahl-Badge.
    const name = deriveCardName(card, 320)?.toLowerCase() ?? '';
    expect(name).toContain('bananen');
    expect(name).not.toContain('stück');
    expect(name).not.toMatch(/\b3\b/);
  });

  it('GROSSE zusammengeclusterte Karte → lokale Teil-Crops je Produkt, kein Ganzkarten-Junk-Crop', () => {
    const card = cardOf(LAYOUT_CROP_GEOMETRIC_BIG_CLUSTER);
    const regions = determinePriceCropRegions(card, 'card_big', { width: 1000, height: 1400 });
    const accepted = regions.filter((region) => region.accepted);
    expect(accepted.length).toBeGreaterThanOrEqual(2);
    // Es gibt Regionen nahe dem OBEREN (≈y245) UND dem UNTEREN (≈y485) Preis-Glyph.
    expect(accepted.some((region) => boxCenterYOf(region.bbox) < 320)).toBe(true);
    expect(accepted.some((region) => boxCenterYOf(region.bbox) > 400)).toBe(true);
    // KEINE Region spannt über BEIDE Preiszonen (kein Ganzkarten-Junk-Crop).
    const spansBoth = (b: LayoutBox): boolean => b.y <= 245 && b.y + b.h >= 485;
    expect(accepted.some((region) => spansBoth(region.bbox))).toBe(false);
  });

  it('reiner Grundpreis / reines Datum → KEINE geometrische Region (Feinursache bleibt erhalten)', () => {
    const base = clusterWordsIntoCards(LAYOUT_CROP_BASEPRICE_ONLY)[0];
    const baseRegions = determinePriceCropRegions(base, 'card_base', { width: 1000, height: 1400 });
    expect(baseRegions.every((region) => !region.accepted)).toBe(true);
    expect(baseRegions[0].rejectReason).toBe('cropLooksLikeBasePrice');

    const date = clusterWordsIntoCards(LAYOUT_CROP_DATE_ONLY)[0];
    const dateRegions = determinePriceCropRegions(date, 'card_date', { width: 1000, height: 1400 });
    expect(dateRegions.every((region) => !region.accepted)).toBe(true);
    expect(dateRegions[0].rejectReason).toBe('cropLooksLikeDateOrLegal');
  });
});

describe('Geometrischer Crop-Pass — Orchestrierung (live)', () => {
  it('Food-Karte ohne OCR-Preiswort + Crop „1,99" → sicherer geometrischer price_crop-Kandidat live', async () => {
    const out = await runCrop({ layout: LAYOUT_CROP_GEOMETRIC_FOOD, crop: cropOf('1,99') });
    expect(out.counters.layoutRawCandidates).toBe(0); // text/layout fand keinen Preis
    expect(out.counters.priceCropAttempts).toBe(1); // break beim ersten sicheren Preis
    expect(out.counters.priceCropParsedPrices).toBe(1);
    expect(out.counters.geometricCropAttempts).toBe(1);
    expect(out.counters.geometricCropParsedPrices).toBe(1);
    expect(out.counters.cropRawCandidates).toBe(1);
    expect(out.counters.cropSafeCandidates).toBe(1);
    expect(out.emittedOffers).toHaveLength(1);
    expect(out.emittedOffers[0].price).toBe(1.99);
    expect(out.emittedOffers[0].tags).toContain('price_crop');
    expect(out.emittedOffers[0].name.toLowerCase()).toContain('rispentomaten');
    // Note belegt den NEUEN visuellen Crop getrennt.
    expect(out.diagnostic.note).toMatch(/1 visualCropAttempts/);
    expect(out.diagnostic.note).toMatch(/1 visualCropParsedPrices/);
  });

  it('mehrere Regionen je Karte: erste Region unlesbar → nächste Region findet den Preis', async () => {
    const out = await runCrop({
      layout: LAYOUT_CROP_GEOMETRIC_FOOD,
      crop: cropSequence([
        { text: '£ l |', confidence: 15 }, // erste (beste) Region unlesbar
        { text: '1,99', confidence: 90 }, // zweite Region trägt den Preis
      ]),
    });
    expect(out.counters.priceCropAttempts).toBe(2);
    expect(out.counters.geometricCropAttempts).toBe(2);
    expect(out.counters.priceCropParsedPrices).toBe(1);
    expect(out.counters.cropRawCandidates).toBe(1);
    expect(out.emittedOffers).toHaveLength(1);
    expect(out.emittedOffers[0].price).toBe(1.99);
  });

  it('Non-Food-Karte mit gut recoverbarem Preis → Safety-Gate verwirft (nonFood), nichts live', async () => {
    const out = await runCrop({ layout: LAYOUT_CROP_GEOMETRIC_NONFOOD, crop: cropOf('49,99') });
    expect(out.counters.priceCropParsedPrices).toBe(1);
    expect(out.counters.cropRawCandidates).toBe(1);
    expect(out.counters.cropSafeCandidates).toBe(0);
    expect(out.priceCropResult.rejections.nonFood).toBe(1);
    expect(out.emittedOffers).toHaveLength(0);
  });

  it('OCR-Müllname + sauberer Crop-Preis → nameQuality-Reject, nichts live', async () => {
    const out = await runCrop({ layout: LAYOUT_CROP_GEOMETRIC_GARBAGE_NAME, crop: cropOf('11,01') });
    expect(out.counters.priceCropParsedPrices).toBe(1); // Preis sauber geparst
    expect(out.counters.cropRawCandidates).toBe(1);
    expect(out.counters.cropSafeCandidates).toBe(0);
    expect(out.priceCropResult.rejections.nameQuality).toBe(1);
    expect(out.emittedOffers).toHaveLength(0);
  });

  it('diagnostic emittiert NIE live (geometrischer Crop sicher, aber 0 emitted)', async () => {
    const out = await runCrop({
      layout: LAYOUT_CROP_GEOMETRIC_FOOD,
      crop: cropOf('1,99'),
      mode: 'diagnostic',
      cropMode: 'live',
    });
    expect(out.priceCropResult.cropSafeCandidates).toBe(1);
    expect(out.emittedOffers).toHaveLength(0);
    expect(out.counters.finalEmittedOffers).toBe(0);
  });
});
