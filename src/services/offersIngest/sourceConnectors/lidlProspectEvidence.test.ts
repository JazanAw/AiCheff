import { describe, expect, it } from 'vitest';
// Die Repo-Wurzel-.gitignore als Rohtext (vite `?raw`) — belegt im Test, dass der
// Debug-Evidence-Pfad git-ignoriert ist, ohne node:fs im src-Layer zu brauchen.
import gitignoreContents from '../../../../.gitignore?raw';
import {
  buildLidlOcrPageEvidence,
  createLidlOcrEvidenceWriter,
  deriveNoLayoutReason,
  runLidlProspectOcr,
  wordsToLayoutPage,
  type LidlOcrPageEvidence,
  type NodeFsLike,
  type OcrLayoutPage,
  type LidlProspectOcrContext,
  type PriceCropOcr,
} from './lidlProspectOcr';
import {
  fakePngBytes,
  LAYOUT_CROP_GEOMETRIC_FOOD,
  LAYOUT_FOOD_BIG_PRICE,
  makeLayoutPage,
} from './lidlProspect.fixture';

// Debug-Evidence-Pfad für den Lidl-OCR. Getestet wird: (1) das Wortbox-Mapping
// (Tesseract-Boxen → interne Layoutwörter in DENSELBEN Bildkoordinaten + ehrliche
// Drop-Diagnose), (2) die noLayout-Ursachentrennung (Tesseract liefert keine Boxen
// vs. unser Code verliert sie vs. Clustering), (3) der größen-/anzahlbegrenzte
// Evidence-Builder + Datei-Writer (Dateisystem injiziert), (4) Debug aus = keine
// Artefakte/keine Mutation. Synthetische Fixtures — KEINE KW-/Marken-Allowlist.

const CONTEXT: LidlProspectOcrContext = {
  storeChain: 'Lidl',
  sourceUrl: 'https://www.lidl.de/c/online-prospekte/s10005610',
  sourceId: 'lidl:aktionsprospekt-15-06-2026',
  validityStart: '2026-06-15T00:00:00.000Z',
  validityEnd: '2026-06-20T23:59:59.000Z',
};

const fakeFetchBinary = async (): Promise<Uint8Array> => fakePngBytes();

describe('wordsToLayoutPage — Tesseract-Wortbox-Mapping/Normalisierung', () => {
  it('mappt bbox x0/y0/x1/y1 → x/y/w/h in DENSELBEN Bildkoordinaten + sourceWordCount', () => {
    const page = wordsToLayoutPage([
      { text: 'Rispentomaten', bbox: { x0: 120, y0: 175, x1: 440, y1: 213 }, confidence: 91 },
      { text: '1', bbox: { x0: 150, y0: 255, x1: 220, y1: 375 }, confidence: 88 },
    ]);
    expect(page).not.toBeNull();
    const words = page!.words;
    // x=x0, y=y0, w=x1-x0, h=y1-y0 — keine Skalierung, keine Verschiebung.
    expect(words[0].bbox).toEqual({ x: 120, y: 175, w: 320, h: 38 });
    expect(words[0].confidence).toBe(91);
    expect(words[1].bbox).toEqual({ x: 150, y: 255, w: 70, h: 120 });
    // Seitenmaße aus den Wortkoordinaten (max boxRight/boxBottom).
    expect(page!.width).toBe(440);
    expect(page!.height).toBe(375);
    // Roh-Wortboxzahl getragen (hier == normalisiert).
    expect(page!.sourceWordCount).toBe(2);
  });

  it('verwirft Wörter ohne Text/bbox, trägt aber die ROH-Zahl (Normalisierungsverlust)', () => {
    type RawWords = Parameters<typeof wordsToLayoutPage>[0];
    const page = wordsToLayoutPage([
      // gültiges Wort
      { text: 'Bananen', bbox: { x0: 10, y0: 10, x1: 110, y1: 50 } },
      // ungültig: keine bbox (so liefert Tesseract gelegentlich) → fällt weg
      { text: 'x', bbox: undefined },
    ] as unknown as RawWords);
    expect(page!.words).toHaveLength(1);
    // sourceWordCount zählt ALLE Roh-Boxen (2), nicht nur die überlebenden (1).
    expect(page!.sourceWordCount).toBe(2);
  });

  it('alle Roh-Boxen fallen weg → leere Seite MIT sourceWordCount (nicht null)', () => {
    type RawWords = Parameters<typeof wordsToLayoutPage>[0];
    const page = wordsToLayoutPage([{ text: 'x', bbox: undefined }] as unknown as RawWords);
    expect(page).not.toBeNull();
    expect(page!.words).toHaveLength(0);
    expect(page!.sourceWordCount).toBe(1);
  });

  it('0 Roh-Boxen → null (= noWordBoxesFromOcr)', () => {
    expect(wordsToLayoutPage([])).toBeNull();
  });
});

describe('deriveNoLayoutReason — die EINE Stufe, an der die Layoutkette fiel', () => {
  it('Layout aus/unverfügbar', () => {
    expect(
      deriveNoLayoutReason({ layoutRan: false, rawWordBoxCount: 0, normalizedWordCount: 0, validDimensions: false, cardsDetected: 0 }),
    ).toBe('layoutDisabledOrUnavailable');
  });

  it('Karten vorhanden → keine Ursache', () => {
    expect(
      deriveNoLayoutReason({ layoutRan: true, rawWordBoxCount: 50, normalizedWordCount: 50, validDimensions: true, cardsDetected: 3 }),
    ).toBeUndefined();
  });

  it('keine Roh-Wortboxen → noWordBoxesFromOcr', () => {
    expect(
      deriveNoLayoutReason({ layoutRan: true, rawWordBoxCount: 0, normalizedWordCount: 0, validDimensions: false, cardsDetected: 0 }),
    ).toBe('noWordBoxesFromOcr');
  });

  it('Roh-Boxen da, aber bei Normalisierung verloren → wordBoxesDroppedDuringNormalization', () => {
    expect(
      deriveNoLayoutReason({ layoutRan: true, rawWordBoxCount: 80, normalizedWordCount: 0, validDimensions: false, cardsDetected: 0 }),
    ).toBe('wordBoxesDroppedDuringNormalization');
  });

  it('normalisierte Wörter da, aber Bildmaße ungültig → imageTooSmallOrInvalidDimensions', () => {
    expect(
      deriveNoLayoutReason({ layoutRan: true, rawWordBoxCount: 80, normalizedWordCount: 80, validDimensions: false, cardsDetected: 0 }),
    ).toBe('imageTooSmallOrInvalidDimensions');
  });

  it('alles vorhanden, aber Clustering ohne Karte → clusteringRejectedAll', () => {
    expect(
      deriveNoLayoutReason({ layoutRan: true, rawWordBoxCount: 80, normalizedWordCount: 80, validDimensions: true, cardsDetected: 0 }),
    ).toBe('clusteringRejectedAll');
  });

  it('strukturierte Ausgabe nicht angefordert (alte tesseract.js-Version/Mock) → noStructuredOutputRequested', () => {
    expect(
      deriveNoLayoutReason({
        layoutRan: true,
        rawWordBoxCount: 0,
        normalizedWordCount: 0,
        validDimensions: false,
        cardsDetected: 0,
        structuredOutputRequested: false,
      }),
    ).toBe('noStructuredOutputRequested');
  });

  it('angefordert, aber kein blocks-/tsv-Feld zurück → noStructuredOutputAvailable', () => {
    expect(
      deriveNoLayoutReason({
        layoutRan: true,
        rawWordBoxCount: 0,
        normalizedWordCount: 0,
        validDimensions: false,
        cardsDetected: 0,
        structuredOutputRequested: true,
        structuredOutputAvailable: false,
      }),
    ).toBe('noStructuredOutputAvailable');
  });

  it('angefordert + blocks vorhanden, aber leer → noWordBoxesFromOcr (kein falscher noStructured-Befund)', () => {
    expect(
      deriveNoLayoutReason({
        layoutRan: true,
        rawWordBoxCount: 0,
        normalizedWordCount: 0,
        validDimensions: false,
        cardsDetected: 0,
        structuredOutputRequested: true,
        structuredOutputAvailable: true,
      }),
    ).toBe('noWordBoxesFromOcr');
  });
});

describe('buildLidlOcrPageEvidence — tesseract.js-v7-Struktur-Diagnose', () => {
  // Layout-Seite, wie sie das reale Pair (recognitionToLayoutPage) liefert: Wörter
  // aus blocks geflattet + die Struktur-Diagnose angehängt.
  const blocksPage: OcrLayoutPage = {
    ...LAYOUT_FOOD_BIG_PRICE,
    sourceWordCount: LAYOUT_FOOD_BIG_PRICE.words.length,
    structuredOutputRequested: true,
    wordBoxSource: 'blocks',
    blocksPresent: true,
    blockWordCount: LAYOUT_FOOD_BIG_PRICE.words.length,
    tsvPresent: false,
    tsvWordCount: 0,
  };

  it('zählt blocksPresent/blockWordCount/tsvWordCount/wordBoxSource korrekt und meldet NICHT noWordBoxesFromOcr', () => {
    const ev = buildLidlOcrPageEvidence({
      context: CONTEXT,
      ocrMode: 'live',
      capturedAt: '2026-06-18T00:00:00.000Z',
      imageUrl: 'https://leaflet.cdn.schwarz/p1-lg.jpg',
      imageFormat: 'png',
      imageByteLength: 1024,
      ocrLanguage: 'deu+eng',
      text: ['Frische Haehnchenbrust', '2,99 €'].join('\n'),
      layoutPage: blocksPage,
      layoutRan: true,
    });
    expect(ev.structuredOutputRequested).toBe(true);
    expect(ev.wordBoxSource).toBe('blocks');
    expect(ev.blocksPresent).toBe(true);
    expect(ev.blockWordCount).toBe(LAYOUT_FOOD_BIG_PRICE.words.length);
    expect(ev.tsvPresent).toBe(false);
    expect(ev.tsvWordCount).toBe(0);
    expect(ev.rawWordBoxCount).toBeGreaterThan(0);
    // blocks trugen Wörter → Karte erkannt → kein noLayout-Befund.
    expect(ev.cardsDetected).toBeGreaterThan(0);
    expect(ev.noLayoutReason).toBeUndefined();
  });

  it('angefordert, aber leer (v6/Mock) → noStructuredOutputAvailable im Artefakt', () => {
    const emptyStructuredPage: OcrLayoutPage = {
      width: 0,
      height: 0,
      words: [],
      sourceWordCount: 0,
      structuredOutputRequested: true,
      wordBoxSource: 'none',
      blocksPresent: false,
      blockWordCount: 0,
      tsvPresent: false,
      tsvWordCount: 0,
    };
    const ev = buildLidlOcrPageEvidence({
      context: CONTEXT,
      ocrMode: 'diagnostic',
      capturedAt: '2026-06-18T00:00:00.000Z',
      imageUrl: 'https://leaflet.cdn.schwarz/p2-lg.jpg',
      imageFormat: 'png',
      imageByteLength: 512,
      ocrLanguage: 'deu+eng',
      text: 'Prospekt der Woche',
      layoutPage: emptyStructuredPage,
      layoutRan: true,
    });
    expect(ev.wordBoxSource).toBe('none');
    expect(ev.rawWordBoxCount).toBe(0);
    expect(ev.noLayoutReason).toBe('noStructuredOutputAvailable');
  });
});

describe('runLidlProspectOcr — Struktur-Diagnose aus dem injizierten Layout-Pfad', () => {
  it('blocks lieferten Wörter → totalBlockWords/structuredAvailablePages gezählt, kein noWordBoxesFromOcr', async () => {
    const out = await runLidlProspectOcr({
      imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg'],
      context: CONTEXT,
      mode: 'live',
      ocrImage: async () => ['Frische Haehnchenbrust', '2,99 €'].join('\n'),
      ocrLayout: async (): Promise<OcrLayoutPage> => ({
        ...LAYOUT_FOOD_BIG_PRICE,
        sourceWordCount: LAYOUT_FOOD_BIG_PRICE.words.length,
        structuredOutputRequested: true,
        wordBoxSource: 'blocks',
        blocksPresent: true,
        blockWordCount: LAYOUT_FOOD_BIG_PRICE.words.length,
        tsvPresent: false,
        tsvWordCount: 0,
      }),
      fetchBinary: fakeFetchBinary,
    });
    expect(out.layoutDiagnostics.totalBlockWords).toBe(LAYOUT_FOOD_BIG_PRICE.words.length);
    expect(out.layoutDiagnostics.structuredOutputRequestedPages).toBe(1);
    expect(out.layoutDiagnostics.structuredOutputAvailablePages).toBe(1);
    expect(out.layoutDiagnostics.dominantNoLayoutReason).toBeUndefined();
    expect(out.diagnostic.note).toMatch(/blockWords 4/);
  });

  it('angefordert, aber leer → dominantNoLayoutReason noStructuredOutputAvailable', async () => {
    const out = await runLidlProspectOcr({
      imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg'],
      context: CONTEXT,
      mode: 'diagnostic',
      ocrImage: async () => ['Prospekt der Woche'].join('\n'),
      ocrLayout: async (): Promise<OcrLayoutPage> => ({
        width: 0,
        height: 0,
        words: [],
        sourceWordCount: 0,
        structuredOutputRequested: true,
        wordBoxSource: 'none',
        blocksPresent: false,
        blockWordCount: 0,
        tsvPresent: false,
        tsvWordCount: 0,
      }),
      fetchBinary: fakeFetchBinary,
    });
    expect(out.layoutDiagnostics.dominantNoLayoutReason).toBe('noStructuredOutputAvailable');
    expect(out.diagnostic.note).toMatch(/dominantNoLayoutReason noStructuredOutputAvailable/);
  });
});

describe('runLidlProspectOcr — Debug-Evidence aus (Default)', () => {
  it('ohne recordPageEvidence: kein Debug-Feld, keine Debug-Referenz in der Note', async () => {
    const out = await runLidlProspectOcr({
      imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg'],
      context: CONTEXT,
      mode: 'diagnostic',
      ocrImage: async () => ['Frische Haehnchenbrust', '2,99 €'].join('\n'),
      fetchBinary: fakeFetchBinary,
    });
    expect(out.debug).toBeUndefined();
    expect(out.diagnostic.note).not.toMatch(/Debug-Evidence/);
  });
});

describe('runLidlProspectOcr — Debug-Evidence an (in-memory-Sink)', () => {
  it('baut je Seite ein Artefakt, referenziert es in der Note, ist anzahlbegrenzt', async () => {
    const captured: LidlOcrPageEvidence[] = [];
    const out = await runLidlProspectOcr({
      imageUrls: ['p1', 'p2', 'p3'].map((p) => `https://leaflet.cdn.schwarz/${p}-lg.jpg`),
      context: CONTEXT,
      mode: 'diagnostic',
      ocrImage: async () => ['Frische Haehnchenbrust', '2,99 €'].join('\n'),
      ocrLayout: async () => LAYOUT_FOOD_BIG_PRICE,
      fetchBinary: fakeFetchBinary,
      recordPageEvidence: (e) => captured.push(e),
      debugEvidenceLimit: 2,
      debugEvidencePath: 'backend/data/debug/lidl-ocr/test-run',
    });
    // 3 Seiten, aber Limit 2 → nur 2 Artefakte gebaut.
    expect(captured).toHaveLength(2);
    expect(out.debug?.pagesRecorded).toBe(2);
    expect(out.debug?.evidencePath).toBe('backend/data/debug/lidl-ocr/test-run');
    expect(out.diagnostic.note).toMatch(/Debug-Evidence/);
    expect(out.diagnostic.note).toMatch(/pagesRecorded 2/);
  });

  it('Artefakt enthält Metadaten, Wortboxen, Karten, Kandidatenentscheidungen', async () => {
    const captured: LidlOcrPageEvidence[] = [];
    await runLidlProspectOcr({
      imageUrls: ['https://leaflet.cdn.schwarz/v4/pages/p1-lg.jpg?token=secret'],
      context: CONTEXT,
      mode: 'live',
      ocrImage: async () => ['Frische Haehnchenbrust', '2,99 €'].join('\n'),
      ocrLayout: async () => LAYOUT_FOOD_BIG_PRICE,
      fetchBinary: fakeFetchBinary,
      recordPageEvidence: (e) => captured.push(e),
    });
    const ev = captured[0];
    // Metadaten: gekürzte URL ohne Query, Hash, Format, Modus, Sprache.
    expect(ev.imageUrlTail).toBe('p1-lg.jpg');
    expect(ev.imageUrlHash).toMatch(/^[0-9a-z]+$/);
    expect(ev.imageFormat).toBe('png');
    expect(ev.ocrMode).toBe('live');
    expect(ev.ocr.language).toBe('deu+eng');
    expect(ev.storeChain).toBe('Lidl');
    // OCR-Textzeilen.
    expect(ev.textLines).toContain('Frische Haehnchenbrust');
    // Wortboxen (TSV/hOCR-äquivalent) mit bbox in Bildkoordinaten.
    expect(ev.rawWordBoxCount).toBeGreaterThan(0);
    expect(ev.wordBoxes[0].bbox).toHaveProperty('w');
    // Layout-Karten + Preis-/Namenskandidaten.
    expect(ev.cardsDetected).toBe(1);
    expect(ev.cards[0].priceCandidates.some((p) => p.chosen)).toBe(true);
    expect(ev.cards[0].cardDecision).toBe('candidate');
    expect(ev.cards[0].gateVerdict).toBe('safe');
    // Finale Kandidatenentscheidungen (Text- + Layoutquelle) mit Verdikt.
    expect(ev.candidates.some((c) => c.sourceKind === 'text_line' && c.verdict === 'safe')).toBe(true);
    expect(ev.candidates.some((c) => c.sourceKind === 'layout_card' && c.verdict === 'safe')).toBe(true);
    // Karten vorhanden → keine noLayout-Ursache.
    expect(ev.noLayoutReason).toBeUndefined();
  });

  it('begrenzt die Anzahl gespeicherter Wortboxen (Größenschranke) + setzt das Truncated-Flag', () => {
    // 450 synthetische Wörter > Cap (400).
    const manyWords = Array.from({ length: 450 }, (_, i) => ({
      text: `w${i}`,
      x: (i % 50) * 18,
      y: Math.floor(i / 50) * 30,
      w: 16,
      h: 24,
    }));
    const page = makeLayoutPage(manyWords);
    const ev = buildLidlOcrPageEvidence({
      context: CONTEXT,
      ocrMode: 'diagnostic',
      capturedAt: '2026-06-18T00:00:00.000Z',
      imageUrl: 'https://leaflet.cdn.schwarz/p-big.jpg',
      imageFormat: 'png',
      imageByteLength: 1024,
      ocrLanguage: 'deu+eng',
      text: 'kein Produkt-Preis-Block',
      layoutPage: page,
      layoutRan: true,
    });
    expect(ev.wordBoxes).toHaveLength(400);
    expect(ev.wordBoxesTruncated).toBe(true);
    expect(ev.normalizedWordCount).toBe(450);
  });
});

describe('runLidlProspectOcr — Note unterscheidet die noLayout-Ursachen', () => {
  it('noWordBoxesFromOcr: ocrLayout liefert keine Seite', async () => {
    const out = await runLidlProspectOcr({
      imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg'],
      context: CONTEXT,
      mode: 'diagnostic',
      ocrImage: async () => ['Prospekt der Woche'].join('\n'),
      ocrLayout: async () => null,
      fetchBinary: fakeFetchBinary,
    });
    expect(out.layoutDiagnostics.layoutCardsDetected).toBe(0);
    expect(out.layoutDiagnostics.dominantNoLayoutReason).toBe('noWordBoxesFromOcr');
    expect(out.diagnostic.note).toMatch(/dominantNoLayoutReason noWordBoxesFromOcr/);
    expect(out.primaryReason).toMatch(/noWordBoxesFromOcr/);
  });

  it('wordBoxesDroppedDuringNormalization: Roh-Boxen kamen, fielen aber bei der Normalisierung weg', async () => {
    const out = await runLidlProspectOcr({
      imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg'],
      context: CONTEXT,
      mode: 'diagnostic',
      ocrImage: async () => ['Prospekt der Woche'].join('\n'),
      // Layout-Seite ohne verwertbare Wörter, aber mit Roh-Wortboxzahl (Drop-Befund).
      ocrLayout: async (): Promise<OcrLayoutPage> => ({ width: 0, height: 0, words: [], sourceWordCount: 12 }),
      fetchBinary: fakeFetchBinary,
    });
    expect(out.layoutDiagnostics.totalWordBoxes).toBe(12);
    expect(out.layoutDiagnostics.totalNormalizedWords).toBe(0);
    expect(out.layoutDiagnostics.dominantNoLayoutReason).toBe('wordBoxesDroppedDuringNormalization');
    expect(out.diagnostic.note).toMatch(/dominantNoLayoutReason wordBoxesDroppedDuringNormalization/);
  });

  it('layoutDisabledOrUnavailable: ohne ocrLayout-Injektor (kein Layout-Segment in der Note)', async () => {
    const out = await runLidlProspectOcr({
      imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg'],
      context: CONTEXT,
      mode: 'diagnostic',
      ocrImage: async () => ['Frische Haehnchenbrust', '2,99 €'].join('\n'),
      fetchBinary: fakeFetchBinary,
    });
    expect(out.layoutDiagnostics.layoutRan).toBe(false);
    expect(out.layoutDiagnostics.dominantNoLayoutReason).toBe('layoutDisabledOrUnavailable');
    // Kein Layout lief → kein "Layout:"-Segment in der Note (Verhalten unverändert).
    expect(out.diagnostic.note).not.toMatch(/Layout:/);
  });
});

describe('createLidlOcrEvidenceWriter — Datei-Persistenz (Dateisystem injiziert)', () => {
  interface FakeFs extends NodeFsLike {
    mkdirs: string[];
    writes: { path: string; data: string | Uint8Array }[];
  }
  const makeFakeFs = (): FakeFs => {
    const mkdirs: string[] = [];
    const writes: { path: string; data: string | Uint8Array }[] = [];
    return {
      mkdirs,
      writes,
      mkdir: async (path) => {
        mkdirs.push(path);
      },
      writeFile: async (path, data) => {
        writes.push({ path, data });
      },
    };
  };

  const sampleEvidence = (): LidlOcrPageEvidence =>
    buildLidlOcrPageEvidence({
      context: CONTEXT,
      ocrMode: 'diagnostic',
      capturedAt: '2026-06-18T00:00:00.000Z',
      imageUrl: 'https://leaflet.cdn.schwarz/p1-lg.jpg',
      imageFormat: 'png',
      imageByteLength: 512,
      ocrLanguage: 'deu+eng',
      text: ['Frische Haehnchenbrust', '2,99 €'].join('\n'),
      layoutPage: LAYOUT_FOOD_BIG_PRICE,
      layoutRan: true,
    });

  it('schreibt je Seite ein page-NNN.json unter den git-ignorierten Run-Ordner', async () => {
    const fs = makeFakeFs();
    const writer = createLidlOcrEvidenceWriter({ runId: 'lidl-run-1', limit: 8, fs });
    writer.recordPageEvidence(sampleEvidence());
    writer.recordPageEvidence(sampleEvidence());
    await writer.flush();

    expect(writer.evidenceDir).toBe('backend/data/debug/lidl-ocr/lidl-run-1');
    expect(fs.mkdirs).toContain('backend/data/debug/lidl-ocr/lidl-run-1');
    expect(fs.writes.map((w) => w.path)).toEqual([
      'backend/data/debug/lidl-ocr/lidl-run-1/page-001.json',
      'backend/data/debug/lidl-ocr/lidl-run-1/page-002.json',
    ]);
    // Alle Schreibpfade liegen UNTER dem Debug-Ordner — nie im Snapshot/Offers.
    expect(fs.writes.every((w) => w.path.startsWith('backend/data/debug/'))).toBe(true);
    // Inhalt ist valides JSON der Evidence.
    const parsed = JSON.parse(fs.writes[0].data as string) as LidlOcrPageEvidence;
    expect(parsed.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(parsed.cardsDetected).toBe(1);
  });

  it('ist anzahlbegrenzt (limit) — überschüssige Seiten werden nicht geschrieben', async () => {
    const fs = makeFakeFs();
    const writer = createLidlOcrEvidenceWriter({ runId: 'lidl-run-2', limit: 1, fs });
    writer.recordPageEvidence(sampleEvidence());
    writer.recordPageEvidence(sampleEvidence());
    writer.recordPageEvidence(sampleEvidence());
    await writer.flush();
    expect(fs.writes).toHaveLength(1);
    expect(writer.pagesRecorded()).toBe(1);
  });

  it('limit 0 → keine Datei, kein Verzeichnis', async () => {
    const fs = makeFakeFs();
    const writer = createLidlOcrEvidenceWriter({ runId: 'lidl-run-3', limit: 0, fs });
    writer.recordPageEvidence(sampleEvidence());
    await writer.flush();
    expect(fs.writes).toHaveLength(0);
    expect(fs.mkdirs).toHaveLength(0);
  });

  it('fehlende Runtime (fs=null) bricht nie — schluckt still', async () => {
    const writer = createLidlOcrEvidenceWriter({ runId: 'lidl-run-4', limit: 8, fs: null });
    writer.recordPageEvidence(sampleEvidence());
    await expect(writer.flush()).resolves.toBeUndefined();
  });

  it('writeCropPreview schreibt das Crop-PNG (binär) unter <run>/crops/ — nur DEBUG', async () => {
    const fs = makeFakeFs();
    const writer = createLidlOcrEvidenceWriter({ runId: 'lidl-run-5', limit: 8, fs });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG-Magic (Stellvertreter)
    writer.writeCropPreview('card_12_geometricLowerRight', png);
    await writer.flush();
    expect(fs.mkdirs).toContain('backend/data/debug/lidl-ocr/lidl-run-5/crops');
    expect(fs.writes).toHaveLength(1);
    expect(fs.writes[0].path).toMatch(
      /^backend\/data\/debug\/lidl-ocr\/lidl-run-5\/crops\/001_card_12_geometricLowerRight\.png$/,
    );
    // Binärdaten werden roh (kein String) durchgereicht.
    expect(fs.writes[0].data).toBeInstanceOf(Uint8Array);
    // Alle Crop-Previews liegen UNTER dem git-ignorierten Debug-Ordner.
    expect(String(fs.writes[0].path).startsWith('backend/data/debug/')).toBe(true);
  });

  it('leeres Preview-PNG wird nicht geschrieben (kein leeres Artefakt)', async () => {
    const fs = makeFakeFs();
    const writer = createLidlOcrEvidenceWriter({ runId: 'lidl-run-6', limit: 8, fs });
    writer.writeCropPreview('card_x', new Uint8Array());
    await writer.flush();
    expect(fs.writes).toHaveLength(0);
  });
});

describe('Debug-Evidence trägt die GEOMETRISCHE Crop-Strategie je Preisbox', () => {
  const cropOf =
    (text: string): PriceCropOcr =>
    async () => ({ text, confidence: 90 });
  const layoutOf = (page: OcrLayoutPage) => async (): Promise<OcrLayoutPage> => page;

  it('priceCropCards[].regions[] zeigt strategy (geometric*), bbox, ocrText, parsedPrice, cardId', async () => {
    const recorded: LidlOcrPageEvidence[] = [];
    await runLidlProspectOcr({
      imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg'],
      context: CONTEXT,
      mode: 'live',
      ocrImage: async () => ['Prospekt der Woche'].join('\n'),
      ocrLayout: layoutOf(LAYOUT_CROP_GEOMETRIC_FOOD),
      cropPriceOcr: cropOf('1,99'),
      priceCropMode: 'live',
      fetchBinary: fakeFetchBinary,
      recordPageEvidence: (evidence) => recorded.push(evidence),
    });
    expect(recorded).toHaveLength(1);
    const page = recorded[0];
    expect(page.priceCropRan).toBe(true);
    expect(page.priceCropCards.length).toBeGreaterThanOrEqual(1);
    const region = page.priceCropCards[0].regions.find((r) => r.parsedPrice !== undefined);
    expect(region).toBeDefined();
    expect(region!.reason.startsWith('geometric')).toBe(true);
    expect(region!.bbox.w).toBeGreaterThan(0);
    expect(region!.ocrText).toBe('1,99');
    expect(region!.parsedPrice).toBe(1.99);
    expect(page.priceCropCards[0].cardId).toMatch(/^card_/);
    expect(page.priceCropCards[0].linkedName?.toLowerCase()).toContain('rispentomaten');
  });
});

describe('Debug-Evidence-Pfad ist git-ignoriert', () => {
  it('.gitignore enthält backend/data/debug/', () => {
    expect(gitignoreContents).toMatch(/^backend\/data\/debug\/$/m);
  });
});
