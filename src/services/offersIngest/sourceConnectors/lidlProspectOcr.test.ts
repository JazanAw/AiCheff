import { describe, expect, it } from 'vitest';
import {
  detectImageFormat,
  extractLidlProspectOcrOffers,
  isOcrNameQualityReject,
  OcrRuntimeUnavailableError,
  runLidlProspectOcr,
  type LidlProspectOcrContext,
} from './lidlProspectOcr';
import {
  fakeHtmlBytes,
  fakeJpegBytes,
  fakePngBytes,
  OCR_BASE_PRICE_ONLY,
  OCR_CTA_HEADING,
  OCR_DEPOSIT_ONLY,
  OCR_DIGIT_ERRORS,
  OCR_GARBAGE_NAME,
  OCR_MULTILINE_NAME,
  OCR_MULTI_PRODUCT_PAGE,
  OCR_NONFOOD_DEVICE,
  OCR_NONFOOD_FOODNEAR,
  OCR_SPACE_PRICE,
  OCR_SPLIT_EURO_CENT,
  OCR_WEAK_NO_FOOD,
} from './lidlProspect.fixture';

// Generischer Lidl-Prospektbild-OCR-Pfad. KEINE KW-spezifischen Produktlisten —
// die konkreten Produktnamen hier sind reine Test-/Reproduktions-Fixtures eines
// OCR-Textes (erlaubt). Es wird NICHTS hardcodiert in den Produktivpfad
// übernommen; getestet wird die generische Extraktion + die Verwerfungs-Zählkette.

const CONTEXT: LidlProspectOcrContext = {
  storeChain: 'Lidl',
  sourceUrl: 'https://www.lidl.de/c/online-prospekte/s10005610',
  sourceId: 'lidl:aktionsprospekt-15-06-2026',
  validityStart: '2026-06-15T00:00:00.000Z',
  validityEnd: '2026-06-20T23:59:59.000Z',
};

// Ein typischer Frische-/Lebensmittel-Prospektseiten-OCR-Text: Name + Preis je
// Block, dazwischen Störer (Seitenzahl, Gültigkeit, Marketing).
const FOOD_PAGE_TEXT = [
  'LIDL Prospekt',
  'gültig 15.06. bis 20.06.',
  'Rispentomaten',
  '500 g',
  'nur 1,49 €',
  'Bio Bananen',
  'je 1 kg',
  '1,79 €',
  'Frische Hähnchenbrust',
  '2,99 €',
  'Seite 3',
].join('\n');

describe('extractLidlProspectOcrOffers', () => {
  it('extrahiert Kandidaten mit Name + plausiblem Preis und leitet die Gültigkeit aus dem Flyer ab', () => {
    const result = extractLidlProspectOcrOffers([{ text: FOOD_PAGE_TEXT, imageUrl: 'https://leaflet.cdn.schwarz/p3-lg.jpg' }], CONTEXT);

    expect(result.ocrCandidatePages).toBe(1);
    expect(result.offers.length).toBeGreaterThanOrEqual(3);
    const names = result.offers.map((o) => o.name.toLowerCase());
    expect(names.some((n) => n.includes('tomaten'))).toBe(true);
    expect(names.some((n) => n.includes('bananen'))).toBe(true);

    for (const offer of result.offers) {
      // Preis plausibel + aus dem Flyer abgeleitete Gültigkeit (nicht geraten).
      expect(typeof offer.price).toBe('number');
      expect(offer.price as number).toBeGreaterThan(0);
      expect(offer.validityStart).toBe(CONTEXT.validityStart);
      expect(offer.validityEnd).toBe(CONTEXT.validityEnd);
      expect(offer.storeChain).toBe('Lidl');
      expect(offer.sourceId).toBe(CONTEXT.sourceId);
      expect(offer.tags ?? []).toContain('lidl-prospekt-ocr');
    }
  });

  it('zählt Verwerfungen ohne Preis und ohne Namen', () => {
    const text = [
      'Markenartikel der Woche', // kein Preis → wird ignoriert (kein Kandidat)
      '0,01 €', // implausibler Preis (zu niedrig) → noPrice
      '1,29 €', // Preis ohne erkennbaren Produktnamen davor → noName
    ].join('\n');
    const result = extractLidlProspectOcrOffers([{ text }], CONTEXT);
    expect(result.rejections.noPrice).toBeGreaterThanOrEqual(1);
    expect(result.rejections.noName).toBeGreaterThanOrEqual(1);
    expect(result.offers).toHaveLength(0);
  });

  it('verwirft Fragment-/Störernamen als lowConfidence', () => {
    const text = ['extra', '0,99 €'].join('\n');
    const result = extractLidlProspectOcrOffers([{ text }], CONTEXT, {
      isFragment: (name) => name.trim().toLowerCase() === 'extra',
    });
    expect(result.rejections.lowConfidence).toBe(1);
    expect(result.offers).toHaveLength(0);
  });

  it('verwirft reine Grundpreise als basePrice — der Betrag wird nicht zum Angebot', () => {
    // Ohne Guard würde der Grundpreis 1,79 an „Bio Bananen" geklebt (Zeile direkt
    // unter dem Namen, kein dazwischenliegender Preis) → falscher Angebotspreis.
    const text = ['Bio Bananen', '1 kg = 1,79 €'].join('\n');
    const result = extractLidlProspectOcrOffers([{ text }], CONTEXT);
    expect(result.rejections.basePrice).toBeGreaterThanOrEqual(1);
    expect(result.offers).toHaveLength(0);
  });

  it('lässt den Angebotspreis stehen, wenn der Grundpreis NACHgestellt in Klammern steht', () => {
    // findPriceToken liefert den ERSTEN Preis (1,49) — der nachgestellte
    // Grundpreis darf das echte Angebot nicht verwerfen.
    const text = ['Rispentomaten', '1,49 € (1 kg = 2,98 €)'].join('\n');
    const result = extractLidlProspectOcrOffers([{ text }], CONTEXT);
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].price).toBe(1.49);
  });

  it('verwirft Pfand-only Zeilen als deposit (zzgl. … und „… € Pfand")', () => {
    const text = [
      'Mineralwasser',
      '0,99 €',
      'zzgl. 0,25 € Pfand', // reine Pfandzeile → deposit
      'Apfelschorle',
      '0,89 €',
      '0,25 € Pfand', // Pfand ohne „zzgl." → ebenfalls deposit
    ].join('\n');
    const result = extractLidlProspectOcrOffers([{ text }], CONTEXT);
    expect(result.rejections.deposit).toBeGreaterThanOrEqual(2);
    // Die echten Getränke-Angebote bleiben; der Pfandbetrag 0,25 wird nie emittiert.
    expect(result.offers.map((o) => o.price)).toEqual([0.99, 0.89]);
    expect(result.offers.every((o) => o.price !== 0.25)).toBe(true);
  });

  it('dedupliziert gegen strukturierte Angebote und innerhalb des OCR', () => {
    const text = ['Rispentomaten', '1,49 €', 'Rispentomaten', '1,49 €'].join('\n');
    const result = extractLidlProspectOcrOffers([{ text }], {
      ...CONTEXT,
      existingNameKeys: ['rispentomaten'],
    });
    // Beide OCR-Treffer sind Duplikate (struktureller Treffer + interner Treffer).
    expect(result.offers).toHaveLength(0);
    expect(result.rejections.duplicate).toBeGreaterThanOrEqual(1);
  });

  it('verwirft Non-Food über die injizierte zentrale Non-Food-Logik (keine neue Allowlist)', () => {
    const text = ['Akkuschrauber', '19,99 €', 'Rispentomaten', '1,49 €'].join('\n');
    const result = extractLidlProspectOcrOffers([{ text }], CONTEXT, {
      classifyNonFood: ({ name }) => /akkuschrauber/i.test(name),
    });
    expect(result.rejections.nonFood).toBe(1);
    expect(result.offers.map((o) => o.name.toLowerCase()).some((n) => n.includes('tomaten'))).toBe(true);
    expect(result.offers.some((o) => /akkuschrauber/i.test(o.name))).toBe(false);
  });

  it('zählt parseError, wenn eine Seite die Extraktion wirft', () => {
    const result = extractLidlProspectOcrOffers(
      [{ text: FOOD_PAGE_TEXT }],
      CONTEXT,
      {
        // Wirft kontrolliert für jede Zeile → erzwingt den parseError-Pfad.
        isFragment: () => {
          throw new Error('boom');
        },
      },
    );
    expect(result.rejections.parseError).toBeGreaterThanOrEqual(1);
  });
});

describe('runLidlProspectOcr', () => {
  const imageUrls = ['https://leaflet.cdn.schwarz/p3-lg.jpg', 'https://leaflet.cdn.schwarz/p4-lg.jpg'];

  // Gültige Bild-Magic-Bytes — passieren den Decode-Gate (die OCR selbst wird in
  // den Tests injiziert; nur die Bytes müssen ein erkennbares Bildformat sein).
  const fakeFetchBinary = async (): Promise<Uint8Array> => fakePngBytes();

  it('diagnostic: liest OCR, bilanziert die Zählkette, gibt aber KEINE Angebote live', async () => {
    let ocrCalls = 0;
    const out = await runLidlProspectOcr({
      imageUrls,
      context: CONTEXT,
      mode: 'diagnostic',
      ocrImage: async () => {
        ocrCalls += 1;
        return FOOD_PAGE_TEXT;
      },
      fetchBinary: fakeFetchBinary,
    });
    expect(ocrCalls).toBe(2);
    expect(out.result.ocrAttempted).toBe(2);
    expect(out.result.ocrParsedOffers).toBeGreaterThan(0);
    // Diagnose: nichts geht live.
    expect(out.emittedOffers).toHaveLength(0);
    expect(out.diagnostic.storeChain).toBe('Lidl');
    expect(out.diagnostic.sourceId).toContain(':prospektseiten:ocr');
    expect(out.diagnostic.note).toMatch(/diagnostic/i);
  });

  it('live: gibt die sicheren, deduplizierten Angebote frei', async () => {
    const out = await runLidlProspectOcr({
      imageUrls: [imageUrls[0]],
      context: CONTEXT,
      mode: 'live',
      ocrImage: async () => FOOD_PAGE_TEXT,
      fetchBinary: fakeFetchBinary,
    });
    expect(out.emittedOffers.length).toBeGreaterThan(0);
    expect(out.emittedOffers).toEqual(out.result.offers);
    expect(out.diagnostic.resultCount).toBe(out.emittedOffers.length);
  });

  it('zählt einen fehlgeschlagenen Bildabruf getrennt als fetchFailed (kein still raw=0)', async () => {
    const out = await runLidlProspectOcr({
      imageUrls: [imageUrls[0]],
      context: CONTEXT,
      mode: 'diagnostic',
      ocrImage: async () => FOOD_PAGE_TEXT,
      fetchBinary: async () => {
        throw new Error('HTTP 503');
      },
    });
    expect(out.result.ocrAttempted).toBe(1);
    expect(out.counters.fetchAttempted).toBe(1);
    expect(out.counters.fetchSucceeded).toBe(0);
    expect(out.failures.fetchFailed).toBe(1);
    // Kein Sammel-parseError mehr — der Grund ist konkret.
    expect(out.result.rejections.parseError).toBe(0);
    expect(out.emittedOffers).toHaveLength(0);
    expect(out.primaryReason).toMatch(/Bildabruf.*fehlgeschlagen/i);
    expect(out.diagnostic.note).toMatch(/fetchFailed 1/);
  });

  it('zählt eine Nicht-Bild-Antwort (HTML) als notAnImage und erklärt raw=0', async () => {
    let ocrCalls = 0;
    const out = await runLidlProspectOcr({
      imageUrls: [imageUrls[0]],
      context: CONTEXT,
      mode: 'diagnostic',
      ocrImage: async () => {
        ocrCalls += 1;
        return FOOD_PAGE_TEXT;
      },
      // Eine fälschlich gesammelte Nicht-Bild-URL liefert HTML, kein Bild.
      fetchBinary: async () => fakeHtmlBytes(),
    });
    // Decode-Gate verhindert, dass HTML überhaupt an die OCR geht.
    expect(ocrCalls).toBe(0);
    expect(out.counters.fetchSucceeded).toBe(1);
    expect(out.counters.imageDecoded).toBe(0);
    expect(out.failures.notAnImage).toBe(1);
    expect(out.result.ocrParsedOffers).toBe(0);
    expect(out.primaryReason).toMatch(/keine dekodierbaren Bilder/i);
  });

  it('meldet eine fehlende OCR-Runtime klar (ocrRuntimeUnavailable) statt still raw=0', async () => {
    let ocrCalls = 0;
    const out = await runLidlProspectOcr({
      imageUrls,
      context: CONTEXT,
      mode: 'diagnostic',
      ocrImage: async () => {
        ocrCalls += 1;
        throw new OcrRuntimeUnavailableError('tesseract.js nicht installiert');
      },
      fetchBinary: fakeFetchBinary,
    });
    // Runtime weg → nach dem ersten Versuch ehrlich abbrechen (keine Schleife).
    expect(ocrCalls).toBe(1);
    expect(out.failures.ocrRuntimeUnavailable).toBe(1);
    expect(out.counters.ocrTextPages).toBe(0);
    expect(out.result.ocrParsedOffers).toBe(0);
    expect(out.primaryReason).toMatch(/Runtime nicht verfügbar/i);
    expect(out.diagnostic.note).toMatch(/Runtime fehlt 1/);
  });

  it('meldet leeren OCR-Text klar (ocrTextEmpty) statt still raw=0', async () => {
    const out = await runLidlProspectOcr({
      imageUrls: [imageUrls[0]],
      context: CONTEXT,
      mode: 'diagnostic',
      ocrImage: async () => '   \n  \n', // dekodiert, aber kein lesbarer Text
      fetchBinary: fakeFetchBinary,
    });
    expect(out.counters.imageDecoded).toBe(1);
    expect(out.failures.ocrTextEmpty).toBe(1);
    expect(out.counters.ocrTextPages).toBe(0);
    expect(out.primaryReason).toMatch(/keinen Text/i);
  });

  it('meldet Text-ohne-Kandidaten klar (textReadButNoCandidates) statt still raw=0', async () => {
    const out = await runLidlProspectOcr({
      imageUrls: [imageUrls[0]],
      context: CONTEXT,
      mode: 'diagnostic',
      // Text vorhanden, aber rein dekorativ — kein Name+Preis-Block.
      ocrImage: async () => ['Prospekt der Woche', 'Jetzt entdecken', 'lidl.de'].join('\n'),
      fetchBinary: fakeFetchBinary,
    });
    expect(out.counters.ocrTextPages).toBe(1);
    expect(out.counters.rawOcrLines).toBeGreaterThan(0);
    expect(out.counters.rawCandidates).toBe(0);
    expect(out.primaryReason).toMatch(/textReadButNoCandidates/i);
  });

  it('füllt die vollständige Zählkette (counters) bei echtem Food-Text', async () => {
    const out = await runLidlProspectOcr({
      imageUrls: [imageUrls[0]],
      prospectPageCount: 9,
      context: CONTEXT,
      mode: 'live',
      ocrImage: async () => FOOD_PAGE_TEXT,
      fetchBinary: async () => fakeJpegBytes(),
    });
    expect(out.counters).toMatchObject({
      prospectPages: 9,
      collectedImageUrls: 1,
      fetchAttempted: 1,
      fetchSucceeded: 1,
      imageDecoded: 1,
      ocrTextPages: 1,
    });
    expect(out.counters.rawOcrLines).toBeGreaterThan(0);
    expect(out.counters.rawCandidates).toBeGreaterThanOrEqual(3);
    expect(out.counters.safeCandidates).toBeGreaterThanOrEqual(3);
    expect(out.counters.emittedOffers).toBe(out.counters.safeCandidates);
    // Die Note enthält die ganze Kette für den nächsten Live-Scan.
    expect(out.diagnostic.note).toMatch(/Kette:/);
    expect(out.diagnostic.note).toMatch(/9 Prospektseiten/);
  });

  it('begrenzt die Anzahl OCR-Bilder (imageLimit)', async () => {
    let ocrCalls = 0;
    const out = await runLidlProspectOcr({
      imageUrls: ['a', 'b', 'c', 'd', 'e'].map((p) => `https://leaflet.cdn.schwarz/${p}.jpg`),
      context: CONTEXT,
      mode: 'diagnostic',
      imageLimit: 2,
      ocrImage: async () => {
        ocrCalls += 1;
        return FOOD_PAGE_TEXT;
      },
      fetchBinary: fakeFetchBinary,
    });
    expect(ocrCalls).toBe(2);
    expect(out.result.ocrAttempted).toBe(2);
    expect(out.counters.fetchAttempted).toBe(2);
  });
});

// Strukturelle Kandidatenbildung aus realistischen OCR-Textzeilen-Fixtures: deckt
// die echten Parser-Stolperstellen ab (große Preis-Optik, getrennte/Leerzeichen-/
// Strich-/OCR-fehlerhafte Preise, mehrzeilige Namen, Grundpreis/Pfand/CTA), gegen
// die der echte Lauf bei `textReadButNoCandidates` strandete.
describe('extractLidlProspectOcrOffers — robuste OCR-Kandidatenbildung', () => {
  it('mehrzeiliger Name + Angebotspreis → 1 Kandidat', () => {
    const result = extractLidlProspectOcrOffers([{ text: OCR_MULTILINE_NAME }], CONTEXT);
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].name.toLowerCase()).toContain('haehnchenbrust');
    expect(result.offers[0].price).toBe(2.99);
    expect(result.priceLinesFound).toBe(1);
    expect(result.groupedCandidates).toBe(1);
  });

  it('getrennter Euro/Cent-Preis über zwei Zeilen → 1 Kandidat (1,99)', () => {
    const result = extractLidlProspectOcrOffers([{ text: OCR_SPLIT_EURO_CENT }], CONTEXT);
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].name.toLowerCase()).toContain('rispentomaten');
    expect(result.offers[0].price).toBe(1.99);
  });

  it('Leerzeichen-getrennter Preis „2 49" (kein Dezimaltrenner) → 1 Kandidat (2,49)', () => {
    const result = extractLidlProspectOcrOffers([{ text: OCR_SPACE_PRICE }], CONTEXT);
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].name.toLowerCase()).toContain('bananen');
    expect(result.offers[0].price).toBe(2.49);
  });

  it('OCR-Buchstabenverwechsler in Preisziffern (O→0, l→1, I→1) + Strich-Cents „1,-" → 4 Kandidaten', () => {
    const result = extractLidlProspectOcrOffers([{ text: OCR_DIGIT_ERRORS }], CONTEXT);
    const prices = result.offers.map((o) => o.price as number).sort((a, b) => a - b);
    expect(prices).toEqual([0.99, 1.0, 1.49, 1.99]);
  });

  it('nur Grundpreis → kein Kandidat, basePrice gezählt', () => {
    const result = extractLidlProspectOcrOffers([{ text: OCR_BASE_PRICE_ONLY }], CONTEXT);
    expect(result.offers).toHaveLength(0);
    expect(result.rejections.basePrice).toBeGreaterThanOrEqual(1);
    expect(result.priceLinesFound).toBe(0);
    expect(result.productNameBlocksFound).toBeGreaterThanOrEqual(1);
  });

  it('nur Pfandzeile → kein Kandidat, deposit gezählt', () => {
    const result = extractLidlProspectOcrOffers([{ text: OCR_DEPOSIT_ONLY }], CONTEXT);
    expect(result.offers).toHaveLength(0);
    expect(result.rejections.deposit).toBeGreaterThanOrEqual(1);
    expect(result.priceLinesFound).toBe(0);
  });

  it('reine CTA-/Heading-Seite → kein Kandidat, keine Preiszeile', () => {
    const result = extractLidlProspectOcrOffers([{ text: OCR_CTA_HEADING }], CONTEXT);
    expect(result.offers).toHaveLength(0);
    expect(result.groupedCandidates).toBe(0);
    expect(result.priceLinesFound).toBe(0);
  });

  it('mehrere Produkte auf einer Seite (gemischte Preisformate, Slogan dazwischen) → mehrere Kandidaten', () => {
    const result = extractLidlProspectOcrOffers([{ text: OCR_MULTI_PRODUCT_PAGE }], CONTEXT);
    const names = result.offers.map((o) => o.name.toLowerCase());
    expect(result.offers.length).toBeGreaterThanOrEqual(4);
    expect(names.some((n) => n.includes('rispentomaten'))).toBe(true);
    expect(names.some((n) => n.includes('bananen'))).toBe(true);
    expect(names.some((n) => n.includes('heidelbeeren'))).toBe(true);
    // Der Slogan „Knaller" zwischen Name und Preis darf den Namen nicht anwachsen.
    expect(names.some((n) => n.includes('knaller'))).toBe(false);
    // Gemischte Formate korrekt geparst.
    expect(result.offers.map((o) => o.price)).toEqual(expect.arrayContaining([1.99, 1.79, 2.99, 0.99]));
  });
});

describe('runLidlProspectOcr — differenzierte Diagnose + Debug-Hook', () => {
  const fakeFetchBinary = async (): Promise<Uint8Array> => fakePngBytes();

  it('emittiert sichere Food-Kandidaten live aus realistischem OCR-Text', async () => {
    const out = await runLidlProspectOcr({
      imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg'],
      context: CONTEXT,
      mode: 'live',
      ocrImage: async () => OCR_MULTI_PRODUCT_PAGE,
      fetchBinary: fakeFetchBinary,
    });
    expect(out.emittedOffers.length).toBeGreaterThanOrEqual(4);
    expect(out.counters.priceLinesFound).toBeGreaterThanOrEqual(4);
    expect(out.counters.productNameBlocksFound).toBeGreaterThanOrEqual(4);
    expect(out.counters.rawCandidates).toBeGreaterThanOrEqual(4);
    expect(out.primaryReason).toMatch(/live freigegeben/i);
  });

  it('diagnostic-Modus emittiert NIE live, auch bei sicheren Kandidaten', async () => {
    const out = await runLidlProspectOcr({
      imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg'],
      context: CONTEXT,
      mode: 'diagnostic',
      ocrImage: async () => OCR_MULTI_PRODUCT_PAGE,
      fetchBinary: fakeFetchBinary,
    });
    expect(out.counters.safeCandidates).toBeGreaterThanOrEqual(4);
    expect(out.emittedOffers).toHaveLength(0);
    expect(out.counters.emittedOffers).toBe(0);
  });

  it('differenziert „nur Grundpreise/Pfand" statt pauschalem textReadButNoCandidates', async () => {
    const out = await runLidlProspectOcr({
      imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg'],
      context: CONTEXT,
      mode: 'diagnostic',
      ocrImage: async () => OCR_BASE_PRICE_ONLY,
      fetchBinary: fakeFetchBinary,
    });
    expect(out.counters.rawCandidates).toBe(0);
    expect(out.counters.priceLinesFound).toBe(0);
    expect(out.counters.productNameBlocksFound).toBeGreaterThanOrEqual(1);
    expect(out.primaryReason).toMatch(/Grundpreise\/Pfand/i);
  });

  it('Non-Food-OCR-Kandidat wird über die injizierte Logik nicht live', async () => {
    const out = await runLidlProspectOcr({
      imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg'],
      context: CONTEXT,
      mode: 'live',
      ocrImage: async () => ['Akkuschrauber Profi', '49,99 €'].join('\n'),
      fetchBinary: fakeFetchBinary,
      options: { classifyNonFood: ({ name }) => /akkuschrauber/i.test(name) },
    });
    expect(out.emittedOffers).toHaveLength(0);
    expect(out.result.rejections.nonFood).toBe(1);
  });

  it('ruft den sicheren Debug-Hook je Seite mit OCR-Text auf (Fixture-Erfassung)', async () => {
    const captured: { imageUrl: string; lineCount: number }[] = [];
    await runLidlProspectOcr({
      imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg'],
      context: CONTEXT,
      mode: 'diagnostic',
      ocrImage: async () => OCR_MULTI_PRODUCT_PAGE,
      fetchBinary: fakeFetchBinary,
      onOcrPage: (page) => captured.push({ imageUrl: page.imageUrl, lineCount: page.lineCount }),
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].imageUrl).toContain('p1-lg.jpg');
    expect(captured[0].lineCount).toBeGreaterThan(0);
  });
});

// Verschärftes OCR-Sicherheitsgate: ein OCR-Kandidat geht nur live, wenn er einen
// STARKEN Food-Beleg hat UND kein starkes Non-Food-/Namensqualitäts-Veto. Die
// konkreten Namen (Eiswürfelmaschine, Fo g i m m, Wasserfilter) sind reine
// Test-Reproduktionen echter Live-Fehlbefunde — KEIN Produktiv-Allowlist.
describe('extractLidlProspectOcrOffers — verschärftes Food-/Non-Food-Sicherheitsgate', () => {
  it('Non-Food-Küchengerät (Eiswürfelmaschine) → rawCandidate ja, safe nein, reject categoryConflict', () => {
    const result = extractLidlProspectOcrOffers([{ text: OCR_NONFOOD_DEVICE }], CONTEXT);
    // Roh-Kandidat entsteht (Preis + Name gruppiert) …
    expect(result.groupedCandidates).toBe(1);
    // … aber er ist NICHT sicher und wird NICHT emittiert.
    expect(result.offers).toHaveLength(0);
    // „eis"-Präfix vergibt fälschlich Snacks/Süßes → Kategorie widerspricht dem
    // „…maschine"-Non-Food-Beleg → categoryConflict (nie als Snacks/Süßes live).
    expect(result.rejections.categoryConflict).toBe(1);
    expect(result.offers.some((o) => /maschine/i.test(o.name))).toBe(false);
  });

  it('OCR-Müllname (Fo g i m m) → rawCandidate ja, safe nein, reject nameQuality', () => {
    const result = extractLidlProspectOcrOffers([{ text: OCR_GARBAGE_NAME }], CONTEXT);
    expect(result.groupedCandidates).toBe(1);
    expect(result.offers).toHaveLength(0);
    expect(result.rejections.nameQuality).toBe(1);
  });

  it('Non-Food mit Lebensmittel-naher Kategorie (Wasserfilter) → nicht live (categoryConflict)', () => {
    const result = extractLidlProspectOcrOffers([{ text: OCR_NONFOOD_FOODNEAR }], CONTEXT);
    expect(result.offers).toHaveLength(0);
    expect(result.rejections.categoryConflict).toBe(1);
  });

  it('schwacher Name ohne Food-Beleg → reject missingStrongFoodEvidence', () => {
    const result = extractLidlProspectOcrOffers([{ text: OCR_WEAK_NO_FOOD }], CONTEXT);
    expect(result.groupedCandidates).toBe(1);
    expect(result.offers).toHaveLength(0);
    expect(result.rejections.missingStrongFoodEvidence).toBe(1);
  });

  it('sicherer Food-Kandidat mit starkem Food-Beleg → safe ja', () => {
    const result = extractLidlProspectOcrOffers(
      [{ text: ['Frische Haehnchenbrust', '2,99 €'].join('\n') }],
      CONTEXT,
    );
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].name.toLowerCase()).toContain('haehnchenbrust');
    expect(result.rejections.missingStrongFoodEvidence).toBe(0);
    expect(result.rejections.nonFood).toBe(0);
  });

  it('Reines strukturelles Non-Food-Veto (Akkuschrauber) ohne Injektion → nonFood', () => {
    const result = extractLidlProspectOcrOffers(
      [{ text: ['Akkuschrauber Profi', '19,99 €', 'Rispentomaten', '1,49 €'].join('\n') }],
      CONTEXT,
    );
    // Kein injiziertes classifyNonFood — das eingebaute strukturelle Signal blockt.
    expect(result.rejections.nonFood).toBe(1);
    expect(result.offers.map((o) => o.name.toLowerCase()).some((n) => n.includes('tomaten'))).toBe(true);
    expect(result.offers.some((o) => /akkuschrauber/i.test(o.name))).toBe(false);
  });

  it('injizierter starker Food-Beleg rettet einen kategorie-losen Namen', () => {
    const result = extractLidlProspectOcrOffers([{ text: ['Karottini', '1,29 €'].join('\n') }], CONTEXT, {
      hasStrongFoodEvidence: ({ name }) => /karottini/i.test(name),
    });
    expect(result.offers).toHaveLength(1);
    expect(result.rejections.missingStrongFoodEvidence).toBe(0);
  });
});

describe('isOcrNameQualityReject', () => {
  it('verwirft Namen aus überwiegend Einzelbuchstaben ohne echtes Wort', () => {
    expect(isOcrNameQualityReject('Fo g i m m')).toBe(true);
    expect(isOcrNameQualityReject('a b c')).toBe(true);
  });

  it('lässt echte Mehrwortnamen und kurze Einzelnamen unberührt', () => {
    expect(isOcrNameQualityReject('Bio Bananen')).toBe(false);
    expect(isOcrNameQualityReject('Frische Haehnchenbrust')).toBe(false);
    expect(isOcrNameQualityReject('Tofu')).toBe(false);
    expect(isOcrNameQualityReject('Mineralwasser Classic')).toBe(false);
  });
});

describe('runLidlProspectOcr — Sicherheitsgate live/diagnostic', () => {
  const fakeFetchBinary = async (): Promise<Uint8Array> => fakePngBytes();

  it('live: emittiert NICHT die Non-Food-Eiswürfelmaschine, aber den Food-Kandidaten', async () => {
    const out = await runLidlProspectOcr({
      imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg'],
      context: CONTEXT,
      mode: 'live',
      ocrImage: async () =>
        ['Eiswiirfelmaschine', '8,77 €', 'Frische Haehnchenbrust', '2,99 €'].join('\n'),
      fetchBinary: fakeFetchBinary,
    });
    expect(out.counters.rawCandidates).toBe(2);
    expect(out.counters.safeCandidates).toBe(1);
    expect(out.counters.emittedOffers).toBe(1);
    expect(out.emittedOffers.some((o) => /maschine/i.test(o.name))).toBe(false);
    expect(out.emittedOffers.some((o) => /haehnchenbrust/i.test(o.name))).toBe(true);
    expect(out.result.rejections.categoryConflict).toBe(1);
    expect(out.diagnostic.note).toMatch(/categoryConflict 1/);
  });

  it('diagnostic: ein sicherer Food-Kandidat wird nie emittiert', async () => {
    const out = await runLidlProspectOcr({
      imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg'],
      context: CONTEXT,
      mode: 'diagnostic',
      ocrImage: async () => ['Frische Haehnchenbrust', '2,99 €'].join('\n'),
      fetchBinary: fakeFetchBinary,
    });
    expect(out.counters.safeCandidates).toBe(1);
    expect(out.emittedOffers).toHaveLength(0);
    expect(out.counters.emittedOffers).toBe(0);
  });
});

describe('detectImageFormat (Decode-Gate)', () => {
  it('erkennt gängige Bildformate an den Magic-Bytes', () => {
    expect(detectImageFormat(fakePngBytes())).toBe('png');
    expect(detectImageFormat(fakeJpegBytes())).toBe('jpeg');
    // WEBP: "RIFF"...."WEBP"
    expect(
      detectImageFormat(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe('webp');
    // AVIF: ftyp-Box mit avif-Brand
    expect(
      detectImageFormat(
        new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]),
      ),
    ).toBe('avif');
  });

  it('verwirft Nicht-Bild-Antworten (HTML/JSON/Text)', () => {
    expect(detectImageFormat(fakeHtmlBytes())).toBeNull();
    expect(detectImageFormat(new TextEncoder().encode('{"error":"not found"}'))).toBeNull();
    expect(detectImageFormat(new TextEncoder().encode('img'))).toBeNull();
    expect(detectImageFormat(new Uint8Array())).toBeNull();
  });
});
