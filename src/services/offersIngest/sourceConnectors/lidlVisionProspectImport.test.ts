import { describe, expect, it } from 'vitest';
import {
  analyzeLidlProspectImageWithVision,
  createDefaultLidlVisionAdapter,
  createDefaultLidlVisionImageTiler,
  deriveCanvasCompatibleImageUrl,
  extractLidlVisionOffers,
  isVisionBadgeName,
  LIDL_VISION_DEFAULT_TILE_OVERLAP,
  LIDL_VISION_TILE_PROMPT,
  parseVisionResponse,
  planVisionTiles,
  resolveCanvasCompatibleImage,
  runLidlVisionProspectImport,
  VisionEmptyResponseError,
  VisionHttpError,
  VisionModelUnavailableError,
  VisionResponseParseError,
  VisionTileRenderError,
  type AnalyzeLidlProspectImage,
  type LidlVisionContext,
  type LidlVisionImageTiler,
  type LidlVisionPageEvidence,
  type VisionImageAnalysis,
  type VisionProspectCandidate,
  type VisionTileImage,
} from './lidlVisionProspectImport';
import { fakeAvifBytes, fakeHtmlBytes, fakeJpegBytes, fakeWebpBytes } from './lidlProspect.fixture';

// Lidl-Prospektbild-VISION-Import. KEINE KW-spezifischen Produktlisten — die
// konkreten Produktnamen hier sind reine Test-/Reproduktions-Fixtures einer
// fingierten Modellantwort. Getestet wird die generische Extraktion + das geteilte
// zentrale Safety-Gate + die Verwerfungs-Zählkette + die Connector-Glue.

const CONTEXT: LidlVisionContext = {
  storeChain: 'Lidl',
  sourceUrl: 'https://www.lidl.de/c/online-prospekte/s10005610',
  sourceId: 'lidl:aktionsprospekt-15-06-2026',
  validityStart: '2026-06-15T00:00:00.000Z',
  validityEnd: '2026-06-20T23:59:59.000Z',
};

function candidate(overrides: Partial<VisionProspectCandidate>): VisionProspectCandidate {
  return {
    name: 'Frische Hähnchenbrust',
    price: 2.99,
    unitText: '500 g',
    confidence: 0.9,
    ...overrides,
  };
}

const SAFE_FOOD: VisionProspectCandidate[] = [
  candidate({ name: 'Rispentomaten', price: 1.49, unitText: '500 g' }),
  candidate({ name: 'Bio Bananen', price: 1.79, unitText: 'je 1 kg' }),
  candidate({ name: 'Frische Hähnchenbrust', price: 2.99 }),
];

describe('extractLidlVisionOffers — sichere Food-Kandidaten', () => {
  it('emittiert sichere Food-Kandidaten mit aus dem Flyer abgeleiteter Gültigkeit', () => {
    const result = extractLidlVisionOffers([{ imageUrl: 'p1.jpg', candidates: SAFE_FOOD }], CONTEXT);

    expect(result.rawCandidates).toBe(3);
    expect(result.safeCandidates).toBe(3);
    expect(result.offers).toHaveLength(3);
    for (const offer of result.offers) {
      expect(typeof offer.price).toBe('number');
      expect(offer.price as number).toBeGreaterThan(0);
      expect(offer.validityStart).toBe(CONTEXT.validityStart);
      expect(offer.validityEnd).toBe(CONTEXT.validityEnd);
      expect(offer.tags).toContain('lidl-vision');
      expect(offer.sourceId).toBe(CONTEXT.sourceId);
    }
  });
});

describe('extractLidlVisionOffers — Sicherheitsverwerfungen', () => {
  it('verwirft Grundpreis (price == basePriceText) und vom Modell markierte Pfand-/Datum-Zeilen', () => {
    const result = extractLidlVisionOffers(
      [
        {
          imageUrl: 'p1.jpg',
          candidates: [
            // Modell hat den Grundpreis als Aktionspreis ausgegeben → strukturell erkannt.
            candidate({ name: 'Tomaten', price: 2.98, basePriceText: '1 kg = 2,98 €' }),
            // Modell markiert Pfand/Datum selbst.
            candidate({ name: 'Mehrweg Pfand', price: 0.25, rejectReason: 'deposit' }),
            candidate({ name: 'Gültig ab Montag', price: 15.6, rejectReason: 'validity_date' }),
          ],
        },
      ],
      CONTEXT,
    );

    expect(result.offers).toHaveLength(0);
    expect(result.rejections.basePrice).toBe(1);
    expect(result.rejections.modelRejected).toBe(2);
  });

  it('verwirft Badge-Namen ("3 Stück", "kernarm", "Aktion")', () => {
    const result = extractLidlVisionOffers(
      [
        {
          imageUrl: 'p1.jpg',
          candidates: [
            candidate({ name: '3 Stück', price: 1.99 }),
            candidate({ name: 'kernarm', price: 1.99 }),
            candidate({ name: 'Aktion', price: 1.99 }),
          ],
        },
      ],
      CONTEXT,
    );

    expect(result.offers).toHaveLength(0);
    expect(result.rejections.badgeName).toBe(3);
  });

  it('verwirft Non-Food-Artikel mit Preis (geteiltes Non-Food-Veto)', () => {
    const result = extractLidlVisionOffers(
      [{ imageUrl: 'p1.jpg', candidates: [candidate({ name: 'Akku-Bohrmaschine', price: 49.99 })] }],
      CONTEXT,
    );

    expect(result.offers).toHaveLength(0);
    expect(result.rejections.nonFood).toBe(1);
  });

  it('verwirft Non-Food über die injizierte zentrale Non-Food-Logik (Connector-Mechanismus)', () => {
    const result = extractLidlVisionOffers(
      [{ imageUrl: 'p1.jpg', candidates: [candidate({ name: 'Spielekonsole', price: 79.99 })] }],
      CONTEXT,
      { classifyNonFood: ({ name }) => /konsole/i.test(name) },
    );

    expect(result.offers).toHaveLength(0);
    expect(result.rejections.nonFood + result.rejections.categoryConflict).toBeGreaterThanOrEqual(1);
  });

  it('verwirft OCR-Müll-/Fragmentnamen (Namensqualität)', () => {
    const result = extractLidlVisionOffers(
      [
        {
          imageUrl: 'p1.jpg',
          candidates: [
            candidate({ name: 'Fo g i m m', price: 1.99 }),
            candidate({ name: 'X', price: 1.99 }),
          ],
        },
      ],
      CONTEXT,
    );

    expect(result.offers).toHaveLength(0);
    expect(result.rejections.nameQuality).toBeGreaterThanOrEqual(1);
  });

  it('dedupliziert gegen ein bereits strukturiert importiertes Lidl-Angebot', () => {
    const result = extractLidlVisionOffers(
      [{ imageUrl: 'p1.jpg', candidates: [candidate({ name: 'Bio Bananen', price: 1.79 })] }],
      { ...CONTEXT, existingNameKeys: ['bio bananen'] },
    );

    expect(result.offers).toHaveLength(0);
    expect(result.rejections.duplicate).toBe(1);
  });

  it('dedupliziert innerhalb des Vision-Laufs (zweiter identischer Treffer)', () => {
    const result = extractLidlVisionOffers(
      [
        {
          imageUrl: 'p1.jpg',
          candidates: [
            candidate({ name: 'Rispentomaten', price: 1.49 }),
            candidate({ name: 'Rispentomaten', price: 1.49 }),
          ],
        },
      ],
      CONTEXT,
    );

    expect(result.offers).toHaveLength(1);
    expect(result.rejections.duplicate).toBe(1);
  });

  it('hält niedrige Confidence aus dem Live-Ergebnis (Review/diagnostic)', () => {
    const result = extractLidlVisionOffers(
      [{ imageUrl: 'p1.jpg', candidates: [candidate({ name: 'Frische Erdbeeren', price: 2.49, confidence: 0.3 })] }],
      CONTEXT,
    );

    expect(result.offers).toHaveLength(0);
    expect(result.rejections.lowConfidence).toBe(1);
  });

  it('verwirft fehlenden/implausiblen Aktionspreis', () => {
    const result = extractLidlVisionOffers(
      [
        {
          imageUrl: 'p1.jpg',
          candidates: [
            candidate({ name: 'Rispentomaten', price: Number.NaN }),
            candidate({ name: 'Bio Bananen', price: 199.99 }),
          ],
        },
      ],
      CONTEXT,
    );

    expect(result.offers).toHaveLength(0);
    expect(result.rejections.noPrice).toBe(2);
  });
});

// --- Strenge Modell-Antwort-Qualität (vor dem zentralen Safety-Gate) -------------
//
// Belegter Live-Befund: llava:7b halluziniert (englische Namen, alte/erfundene Daten
// wie 2023, generische Markennamen, vom Modell selbst markierte Unsicherheit,
// Einheiten-Müll). Diese Tests pinnen die echten Fehlerklassen an EIGENE Zähler
// (modelQualityRejectedByReason), die VOR dem Safety-Gate greifen. KEINE Produkt-/
// Marken-/KW-Allowlist — die konkreten Namen sind reine Reproduktions-Fixtures.
describe('extractLidlVisionOffers — strenge Modell-Antwort-Qualität', () => {
  const QUALITY = { enforceModelQuality: true } as const;

  it('verwirft einen englischen Kandidaten ohne deutschen Evidenztext → languageMismatch', () => {
    const result = extractLidlVisionOffers(
      [
        {
          imageUrl: 'p1.jpg',
          candidates: [
            candidate({
              name: 'Fresh Strawberries',
              price: 1.99,
              evidenceText: 'Fresh Strawberries 1.99',
            }),
          ],
        },
      ],
      CONTEXT,
      QUALITY,
    );

    expect(result.offers).toHaveLength(0);
    expect(result.qualityRejections.languageMismatch).toBe(1);
  });

  it('verwirft einen Kandidaten mit erfundener/alter Jahreszahl (2023) → implausibleDate', () => {
    const result = extractLidlVisionOffers(
      [
        {
          imageUrl: 'p1.jpg',
          candidates: [
            candidate({
              name: 'Rispentomaten',
              price: 1.49,
              evidenceText: 'Rispentomaten 1,49 €',
              validityText: 'gültig ab 12.06.2023',
            }),
          ],
        },
      ],
      CONTEXT,
      QUALITY,
    );

    expect(result.offers).toHaveLength(0);
    expect(result.qualityRejections.implausibleDate).toBe(1);
  });

  it('verwirft rejectReason:"unsure" — nicht safety-safe → visionRejectReason', () => {
    const result = extractLidlVisionOffers(
      [
        {
          imageUrl: 'p1.jpg',
          candidates: [
            candidate({
              name: 'Frische Erdbeeren',
              price: 2.49,
              rejectReason: 'unsure',
              evidenceText: 'Frische Erdbeeren 2,49 €',
            }),
          ],
        },
      ],
      CONTEXT,
      QUALITY,
    );

    expect(result.offers).toHaveLength(0);
    expect(result.qualityRejections.visionRejectReason).toBe(1);
    // Rückwärtskompatibilität: der Safety-Lens führt es weiterhin als modelRejected.
    expect(result.rejections.modelRejected).toBe(1);
  });

  it('verwirft reine Markennamen ohne Produktbezeichnung → brandOnlyName', () => {
    const result = extractLidlVisionOffers(
      [
        {
          imageUrl: 'p1.jpg',
          candidates: [
            candidate({ name: 'Lidl', price: 1.49, evidenceText: 'Lidl 1,49 €' }),
            candidate({ name: 'Fairtrade', price: 1.99, evidenceText: 'Fairtrade 1,99 €' }),
            candidate({ name: 'Haribo', price: 0.99, evidenceText: 'Haribo 0,99 €' }),
          ],
        },
      ],
      CONTEXT,
      QUALITY,
    );

    expect(result.offers).toHaveLength(0);
    expect(result.qualityRejections.brandOnlyName).toBe(3);
  });

  it('verwirft Währungs-/Müll-Einheiten ("€", "€ / kg") → unitLooksInvalid', () => {
    const result = extractLidlVisionOffers(
      [
        {
          imageUrl: 'p1.jpg',
          candidates: [
            candidate({ name: 'Rispentomaten', price: 1.49, unitText: '€', evidenceText: 'Rispentomaten 1,49 €' }),
            candidate({ name: 'Bio Bananen', price: 1.79, unitText: '€ / kg', evidenceText: 'Bio Bananen 1,79 €' }),
          ],
        },
      ],
      CONTEXT,
      QUALITY,
    );

    expect(result.offers).toHaveLength(0);
    expect(result.qualityRejections.unitLooksInvalid).toBe(2);
  });

  it('verwirft fehlenden/unbelegten Evidenztext (kein Name/Preis sichtbar) → missingEvidenceText', () => {
    const result = extractLidlVisionOffers(
      [
        {
          imageUrl: 'p1.jpg',
          candidates: [
            // evidenceText fehlt ganz
            candidate({ name: 'Rispentomaten', price: 1.49 }),
            // evidenceText belegt weder Name noch Preis dieses Kandidaten
            candidate({ name: 'Bio Bananen', price: 1.79, evidenceText: 'Frische Tomaten 9,99 €' }),
          ],
        },
      ],
      CONTEXT,
      QUALITY,
    );

    expect(result.offers).toHaveLength(0);
    expect(result.qualityRejections.missingEvidenceText).toBe(2);
  });

  it('lässt einen guten Kandidaten (deutscher Evidenztext) durch das Qualitäts-Gate ans Safety-Gate', () => {
    const result = extractLidlVisionOffers(
      [
        {
          imageUrl: 'p1.jpg',
          candidates: [
            candidate({
              name: 'Heinz Tomato Ketchup',
              price: 1.49,
              unitText: '500 ml',
              evidenceText: 'Heinz Tomato Ketchup, 500 ml, je 1,49 €',
            }),
          ],
        },
      ],
      CONTEXT,
      QUALITY,
    );

    // Keine Qualitäts-Verwerfung; der Kandidat ist durch das Safety-Gate gegangen (sicher).
    for (const reason of Object.values(result.qualityRejections)) {
      expect(reason).toBe(0);
    }
    expect(result.safeCandidates).toBe(1);
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].name).toBe('Heinz Tomato Ketchup');
    expect(result.decisions.find((d) => d.name === 'Heinz Tomato Ketchup')?.verdict).toBe('safe');
  });

  it('ohne enforceModelQuality bleibt das Verhalten unverändert (Qualitäts-Lens leer)', () => {
    const result = extractLidlVisionOffers(
      [
        {
          imageUrl: 'p1.jpg',
          candidates: [candidate({ name: 'Fresh Strawberries', price: 1.99, evidenceText: 'Fresh Strawberries 1.99' })],
        },
      ],
      CONTEXT,
    );

    for (const reason of Object.values(result.qualityRejections)) {
      expect(reason).toBe(0);
    }
  });
});

describe('runLidlVisionProspectImport — modelQualityRejectedByReason im Report', () => {
  const fetchJpeg = async () => fakeJpegBytes();

  it('zählt die Qualitäts-Verwerfungen separat und weist sie in der Note aus', async () => {
    const run = await runLidlVisionProspectImport({
      imageUrls: ['p1.jpg'],
      context: RUN_CONTEXT,
      mode: 'diagnostic',
      analyzeImage: fakeAdapter({
        'p1.jpg': {
          candidates: [
            candidate({
              name: 'Heinz Tomato Ketchup',
              price: 1.49,
              unitText: '500 ml',
              evidenceText: 'Heinz Tomato Ketchup, 500 ml, je 1,49 €',
            }),
            candidate({ name: 'Fresh Strawberries', price: 1.99, evidenceText: 'Fresh Strawberries 1.99' }),
            candidate({ name: 'Lidl', price: 0.99, evidenceText: 'Lidl 0,99 €' }),
          ],
          modelName: 'fake-vision',
        },
      }),
      fetchBinary: fetchJpeg,
      options: { enforceModelQuality: true },
    });

    expect(run.counters.rawVisionCandidates).toBe(3);
    expect(run.counters.modelQualityRejectedByReason.languageMismatch).toBe(1);
    expect(run.counters.modelQualityRejectedByReason.brandOnlyName).toBe(1);
    expect(run.counters.safeVisionCandidates).toBe(1);
    // diagnostic bleibt diagnostic — nichts geht live.
    expect(run.emittedOffers).toHaveLength(0);
    expect(run.diagnostic.note).toContain('modelQualityRejectedByReason');
    expect(run.diagnostic.note).toMatch(/languageMismatch 1/);
  });
});

describe('Tile-Overlap-Default (bessere Karten-Isolation, Goal 2)', () => {
  it('Default-Overlap ist klein, Tiles bleiben in den Bildgrenzen', () => {
    expect(LIDL_VISION_DEFAULT_TILE_OVERLAP).toBeLessThanOrEqual(0.08);
    const tiles = planVisionTiles(1200, 2400);
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      expect(tile.box.x).toBeGreaterThanOrEqual(0);
      expect(tile.box.y).toBeGreaterThanOrEqual(0);
      expect(tile.box.x + tile.box.w).toBeLessThanOrEqual(1200);
      expect(tile.box.y + tile.box.h).toBeLessThanOrEqual(2400);
    }
  });
});

describe('isVisionBadgeName', () => {
  it('erkennt Badges/Mengen, lässt echte Produktnamen durch', () => {
    expect(isVisionBadgeName('3 Stück')).toBe(true);
    expect(isVisionBadgeName('kernarm')).toBe(true);
    expect(isVisionBadgeName('Aktion')).toBe(true);
    expect(isVisionBadgeName('500 g')).toBe(true);
    expect(isVisionBadgeName('Frische Hähnchenbrust')).toBe(false);
    expect(isVisionBadgeName('Bio Bananen')).toBe(false);
  });
});

// --- Runner-Glue (mit injiziertem Fake-Adapter) ---------------------------------

function fakeAdapter(byUrl: Record<string, VisionImageAnalysis>): AnalyzeLidlProspectImage {
  return async (image) => {
    const analysis = byUrl[image.imageUrl];
    if (!analysis) {
      return { candidates: [], modelName: 'fake-vision' };
    }
    return analysis;
  };
}

const RUN_CONTEXT: LidlVisionContext = CONTEXT;

describe('runLidlVisionProspectImport', () => {
  const fetchJpeg = async () => fakeJpegBytes();

  it('diagnostic emittiert 0 Angebote, bilanziert aber die sicheren Kandidaten', async () => {
    const run = await runLidlVisionProspectImport({
      imageUrls: ['p1.jpg'],
      context: RUN_CONTEXT,
      mode: 'diagnostic',
      analyzeImage: fakeAdapter({ 'p1.jpg': { candidates: SAFE_FOOD, modelName: 'fake-vision' } }),
      fetchBinary: fetchJpeg,
      prospectPageCount: 1,
    });

    expect(run.emittedOffers).toHaveLength(0);
    expect(run.counters.safeVisionCandidates).toBe(3);
    expect(run.counters.rawVisionCandidates).toBe(3);
    expect(run.counters.emittedOffers).toBe(0);
    expect(run.diagnostic.status).toBe('empty');
    expect(run.diagnostic.resultCount).toBe(0);
    expect(run.diagnostic.sourceId).toBe('lidl:aktionsprospekt-15-06-2026:prospektseiten:vision');
    expect(run.coverage).toBe('vision_diagnostic');
  });

  it('live emittiert die sicheren Kandidaten und meldet partial_with_vision', async () => {
    const run = await runLidlVisionProspectImport({
      imageUrls: ['p1.jpg'],
      context: RUN_CONTEXT,
      mode: 'live',
      analyzeImage: fakeAdapter({ 'p1.jpg': { candidates: SAFE_FOOD, modelName: 'fake-vision' } }),
      fetchBinary: fetchJpeg,
      prospectPageCount: 1,
    });

    expect(run.emittedOffers).toHaveLength(3);
    expect(run.counters.emittedOffers).toBe(3);
    expect(run.diagnostic.status).toBe('success');
    expect(run.coverage).toBe('partial_with_vision');
    for (const offer of run.emittedOffers) {
      expect(offer.tags).toContain('lidl-vision');
    }
  });

  it('Coverage ist nie "full"', async () => {
    const run = await runLidlVisionProspectImport({
      imageUrls: ['p1.jpg'],
      context: RUN_CONTEXT,
      mode: 'live',
      analyzeImage: fakeAdapter({ 'p1.jpg': { candidates: SAFE_FOOD, modelName: 'fake-vision' } }),
      fetchBinary: fetchJpeg,
    });
    expect(['vision_diagnostic', 'partial_with_vision']).toContain(run.coverage);
    expect(run.coverage).not.toBe('full');
  });

  it('spiegelt die Safety-Gate-Counter korrekt in den Report (rejectedByReason)', async () => {
    const run = await runLidlVisionProspectImport({
      imageUrls: ['p1.jpg'],
      context: RUN_CONTEXT,
      mode: 'live',
      analyzeImage: fakeAdapter({
        'p1.jpg': {
          candidates: [
            candidate({ name: 'Rispentomaten', price: 1.49 }),
            candidate({ name: 'Akku-Bohrmaschine', price: 49.99 }),
            candidate({ name: '3 Stück', price: 1.99 }),
            candidate({ name: 'Frische Erdbeeren', price: 2.49, confidence: 0.2 }),
          ],
          modelName: 'fake-vision',
        },
      }),
      fetchBinary: fetchJpeg,
    });

    expect(run.counters.rawVisionCandidates).toBe(4);
    expect(run.counters.safeVisionCandidates).toBe(1);
    expect(run.counters.emittedOffers).toBe(1);
    expect(run.counters.rejectedByReason.nonFood).toBe(1);
    expect(run.counters.rejectedByReason.badgeName).toBe(1);
    expect(run.counters.rejectedByReason.lowConfidence).toBe(1);
  });

  it('eine kaputte JSON-Antwort blockiert den Scan nicht, sondern wird als Diagnose-Fehler gezählt', async () => {
    const run = await runLidlVisionProspectImport({
      imageUrls: ['p1.jpg', 'p2.jpg'],
      context: RUN_CONTEXT,
      mode: 'live',
      analyzeImage: async (image) => {
        if (image.imageUrl === 'p1.jpg') {
          throw new VisionResponseParseError('kaputtes JSON');
        }
        return { candidates: SAFE_FOOD, modelName: 'fake-vision' };
      },
      fetchBinary: fetchJpeg,
    });

    expect(run.failures.parseError).toBe(1);
    expect(run.counters.imageAnalyzed).toBe(1); // p2 wurde trotzdem analysiert
    expect(run.emittedOffers.length).toBeGreaterThan(0);
  });

  it('meldet ein nicht verfügbares Vision-Modell ehrlich (model unavailable) und bricht ab', async () => {
    const run = await runLidlVisionProspectImport({
      imageUrls: ['p1.jpg', 'p2.jpg'],
      context: RUN_CONTEXT,
      mode: 'live',
      analyzeImage: async () => {
        throw new VisionModelUnavailableError('kein Modell');
      },
      fetchBinary: fetchJpeg,
      modelName: '',
    });

    expect(run.failures.modelUnavailable).toBe(1);
    expect(run.counters.imageAnalyzed).toBe(0);
    expect(run.emittedOffers).toHaveLength(0);
    expect(run.counters.modelName).toBe('(unavailable)');
    expect(run.primaryReason).toMatch(/nicht verfügbar/i);
  });

  it('zählt Nicht-Bild-Antworten als notAnImage (kein OCR/Vision auf HTML)', async () => {
    const run = await runLidlVisionProspectImport({
      imageUrls: ['p1.jpg'],
      context: RUN_CONTEXT,
      mode: 'diagnostic',
      analyzeImage: fakeAdapter({ 'p1.jpg': { candidates: SAFE_FOOD, modelName: 'fake-vision' } }),
      fetchBinary: async () => fakeHtmlBytes(),
    });

    expect(run.failures.notAnImage).toBe(1);
    expect(run.counters.imageAnalyzed).toBe(0);
  });

  it('schreibt Debug-Evidence je Seite ohne Bilddaten (Sink injiziert)', async () => {
    const evidence: unknown[] = [];
    await runLidlVisionProspectImport({
      imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg'],
      context: RUN_CONTEXT,
      mode: 'diagnostic',
      analyzeImage: fakeAdapter({
        'https://leaflet.cdn.schwarz/p1-lg.jpg': {
          candidates: SAFE_FOOD,
          modelName: 'fake-vision',
          rawResponse: '{"candidates":[]}',
        },
      }),
      fetchBinary: fetchJpeg,
      recordPageEvidence: (entry) => evidence.push(entry),
    });

    expect(evidence).toHaveLength(1);
    const entry = evidence[0] as Record<string, unknown>;
    expect(entry.imageUrlTail).toBe('p1-lg.jpg');
    expect(typeof entry.imageUrlHash).toBe('string');
    expect(entry).not.toHaveProperty('bytes');
    expect(Array.isArray(entry.decisions)).toBe(true);
  });
});

// --- Default-Adapter (Ollama) ----------------------------------------------------

describe('parseVisionResponse', () => {
  it('parst ein {candidates:[…]}-Objekt', () => {
    const out = parseVisionResponse('{"candidates":[{"name":"Bananen","price":1.79,"confidence":0.9}]}');
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Bananen');
    expect(out[0].price).toBe(1.79);
  });

  it('parst ein in ```json … ``` umrahmtes Array und Komma-Preise', () => {
    const out = parseVisionResponse('```json\n[{"name":"Tomaten","price":"1,49","confidence":0.8}]\n```');
    expect(out).toHaveLength(1);
    expect(out[0].price).toBeCloseTo(1.49);
  });

  it('wirft VisionResponseParseError bei nicht-JSON', () => {
    expect(() => parseVisionResponse('Entschuldigung, ich kann das Bild nicht lesen.')).toThrow(
      VisionResponseParseError,
    );
  });
});

describe('analyzeLidlProspectImageWithVision / createDefaultLidlVisionAdapter', () => {
  it('meldet model unavailable, wenn kein Modell konfiguriert ist', async () => {
    const adapter = createDefaultLidlVisionAdapter({ host: 'http://localhost:11434', model: '' });
    await expect(
      adapter(
        { bytes: fakeJpegBytes(), imageUrl: 'p1.jpg', format: 'jpeg' },
        { storeChain: 'Lidl', sourceUrl: 'x', imageUrl: 'p1.jpg', imageFormat: 'jpeg' },
      ),
    ).rejects.toBeInstanceOf(VisionModelUnavailableError);
  });

  it('ruft Ollama mit dem Bild auf und parst die Modellantwort (injizierter fetch)', async () => {
    let capturedBody: string | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          message: { content: '{"candidates":[{"name":"Bananen","price":1.79,"confidence":0.9}]}' },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const analysis = await analyzeLidlProspectImageWithVision(
      { bytes: fakeJpegBytes(), imageUrl: 'p1.jpg', format: 'jpeg' },
      { storeChain: 'Lidl', sourceUrl: 'x', imageUrl: 'p1.jpg', imageFormat: 'jpeg' },
      { host: 'http://localhost:11434', model: 'qwen2.5vl:7b', fetchImpl },
    );

    expect(analysis.modelName).toBe('qwen2.5vl:7b');
    expect(analysis.candidates).toHaveLength(1);
    expect(capturedBody).toContain('"images"');
  });

  it('meldet model unavailable bei HTTP 404 (Modell nicht installiert)', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    await expect(
      analyzeLidlProspectImageWithVision(
        { bytes: fakeJpegBytes(), imageUrl: 'p1.jpg', format: 'jpeg' },
        { storeChain: 'Lidl', sourceUrl: 'x', imageUrl: 'p1.jpg', imageFormat: 'jpeg' },
        { host: 'http://localhost:11434', model: 'missing:7b', fetchImpl },
      ),
    ).rejects.toBeInstanceOf(VisionModelUnavailableError);
  });
});

// --- Tiling (Crop-basierte Analyse statt Full-Page) ------------------------------
//
// Root Cause: eine ganze 2400px-Prospektseite ist für llava:7b zu groß (Full-Page-
// Analyse timeoutet). Die Tile-Strategie zerlegt die Seite in kleine, überlappende
// Ausschnitte, die einzeln schnell analysiert werden. Tests injizieren einen Fake-
// Tiler (synthetische Tile-Bytes mit Index-Marker) + eine Fake-Vision pro Tile.

/** Synthetische Tiles: das vierte Byte trägt den Tile-Index, sodass der Fake-Adapter
 *  je Tile eine andere Antwort liefern kann (der Runner reicht die Tile-Bytes durch). */
function makeFakeTiles(count: number): VisionTileImage[] {
  const tiles: VisionTileImage[] = [];
  for (let index = 0; index < count; index += 1) {
    tiles.push({
      index,
      column: index % 2,
      row: Math.floor(index / 2),
      box: { x: index * 50, y: 0, w: 120, h: 120 },
      bytes: new Uint8Array([0xff, 0xd8, 0xff, index]),
      format: 'jpeg',
    });
  }
  return tiles;
}

/** Fake-Tiler, der genau `count` synthetische Tiles liefert (ignoriert die Bildbytes). */
function fakeTiler(count: number) {
  return async () => makeFakeTiles(count);
}

/** Canvas-naher Fake-Tiler: liefert nur Tiles, wenn er canvas-kompatible Bytes bekommt
 *  (jpeg/png) — sonst wirft er wie der reale node-canvas-Tiler. So beweisen Tests, dass
 *  die canvas-kompatible Rendition den Tiler tatsächlich erreicht. */
const canvasAwareTiler: LidlVisionImageTiler = async (image) => {
  if (image.format !== 'jpeg' && image.format !== 'png') {
    throw new VisionTileRenderError(`canvas kann "${image.format}" nicht dekodieren`);
  }
  return makeFakeTiles(2);
};

/** Fake-Vision pro Tile, gekeyt auf den Index-Marker (bytes[3]). `'timeout'` liefert
 *  eine Promise, die erst beim Abbruch (Runner-Tile-Timeout via Signal) rejectet. */
function tileAnalysisByIndex(
  byIndex: Record<number, VisionProspectCandidate[] | 'timeout'>,
): AnalyzeLidlProspectImage {
  return async (image, _context, options) => {
    const index = image.bytes[3] ?? 0;
    const entry = byIndex[index];
    if (entry === 'timeout') {
      return new Promise<VisionImageAnalysis>((_resolve, reject) => {
        const signal = options?.signal;
        if (!signal) {
          return;
        }
        if (signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    return { candidates: entry ?? [], modelName: 'fake-vision' };
  };
}

describe('planVisionTiles', () => {
  it('erzeugt ein überlappendes Spalten×Zeilen-Raster innerhalb der Bildgrenzen', () => {
    const tiles = planVisionTiles(1000, 2400, { columns: 2, rows: 3, overlap: 0.1, limit: 8 });

    expect(tiles).toHaveLength(6);
    for (const tile of tiles) {
      expect(tile.box.x).toBeGreaterThanOrEqual(0);
      expect(tile.box.y).toBeGreaterThanOrEqual(0);
      expect(tile.box.x + tile.box.w).toBeLessThanOrEqual(1000);
      expect(tile.box.y + tile.box.h).toBeLessThanOrEqual(2400);
    }
    // Überlappung: das rechte Tile beginnt LINKS der nominalen Spaltengrenze (500).
    const topRight = tiles.find((tile) => tile.row === 0 && tile.column === 1);
    expect(topRight).toBeDefined();
    expect(topRight!.box.x).toBeLessThan(500);
    // Und es überlappt das linke Tile derselben Zeile.
    const topLeft = tiles.find((tile) => tile.row === 0 && tile.column === 0)!;
    expect(topLeft.box.x + topLeft.box.w).toBeGreaterThan(topRight!.box.x);
  });

  it('hält das Tile-Limit ein und leitet Zeilen adaptiv ab', () => {
    const tiles = planVisionTiles(1200, 3600, { columns: 2, limit: 6 });
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThanOrEqual(6);
  });
});

describe('createDefaultLidlVisionImageTiler', () => {
  it('wirft VisionTileRenderError für nicht canvas-dekodierbare Formate (WebP)', async () => {
    const tiler = createDefaultLidlVisionImageTiler();
    await expect(
      tiler({ bytes: new Uint8Array([1, 2, 3, 4]), imageUrl: 'p.webp', format: 'webp' }, {}),
    ).rejects.toBeInstanceOf(VisionTileRenderError);
  });
});

// --- Canvas-Renditions-Auflösung (WebP/AVIF → JPEG) ------------------------------
//
// Root Cause der leeren Tiles im echten Scan: node-canvas dekodiert KEIN WebP/AVIF,
// die Lidl-imgproxy-Standardrendition liefert aber genau das. Der Helper sorgt vor
// dem Tiling für canvas-kompatible Bytes ODER meldet die echte Ursache ehrlich.

describe('resolveCanvasCompatibleImage', () => {
  it('lässt JPEG/PNG unverändert (compatible, kein Rendition-Fetch)', async () => {
    let fetched = 0;
    const result = await resolveCanvasCompatibleImage({
      imageUrl: 'https://cdn/p1.jpg',
      bytes: fakeJpegBytes(),
      format: 'jpeg',
      fetchRendition: async () => {
        fetched += 1;
        return fakeJpegBytes();
      },
    });

    expect(result.status).toBe('compatible');
    expect(result.canvasImageFormat).toBe('jpeg');
    expect(result.alternativeTried).toBe(false);
    expect(result.bytes).toBeDefined();
    expect(fetched).toBe(0);
  });

  it('versucht für WebP eine Alternativ-Rendition und nimmt die JPEG-Antwort', async () => {
    const result = await resolveCanvasCompatibleImage({
      imageUrl: 'https://leaflet-cdn.schwarz/v4/pages/p1-lg.webp',
      bytes: fakeWebpBytes(),
      format: 'webp',
      fetchRendition: async () => fakeJpegBytes(),
    });

    expect(result.status).toBe('alternativeRenditionSucceeded');
    expect(result.canvasImageFormat).toBe('jpeg');
    expect(result.alternativeTried).toBe(true);
    expect(result.originalImageFormat).toBe('webp');
    expect(typeof result.renditionUrlHash).toBe('string');
  });

  it('ohne Rendition-Fetch: unsupportedImageFormatForCanvas mit Grund + Magic-Bytes', async () => {
    const result = await resolveCanvasCompatibleImage({
      imageUrl: 'https://leaflet-cdn.schwarz/v4/pages/p1-lg.avif',
      bytes: fakeAvifBytes(),
      format: 'avif',
    });

    expect(result.status).toBe('unsupportedImageFormatForCanvas');
    expect(result.alternativeTried).toBe(false);
    expect(result.bytes).toBeUndefined();
    expect(result.reason).toMatch(/avif/);
    expect(result.magicBytes.length).toBeGreaterThan(0);
  });

  it('Alternative bleibt nicht canvas-kompatibel → alternativeRenditionFailed mit Grund', async () => {
    const result = await resolveCanvasCompatibleImage({
      imageUrl: 'https://leaflet-cdn.schwarz/v4/pages/p1-lg.webp',
      bytes: fakeWebpBytes(),
      format: 'webp',
      fetchRendition: async () => fakeWebpBytes(),
    });

    expect(result.status).toBe('alternativeRenditionFailed');
    expect(result.alternativeTried).toBe(true);
    expect(result.reason).toMatch(/nicht canvas-kompatibel/);
  });

  it('Rendition-Fetch wirft → alternativeRenditionFailed (kein throw nach außen)', async () => {
    const result = await resolveCanvasCompatibleImage({
      imageUrl: 'https://leaflet-cdn.schwarz/v4/pages/p1-lg.webp',
      bytes: fakeWebpBytes(),
      format: 'webp',
      fetchRendition: async () => {
        throw new Error('HTTP 403');
      },
    });

    expect(result.status).toBe('alternativeRenditionFailed');
    expect(result.reason).toMatch(/fehlgeschlagen|403/);
  });
});

describe('deriveCanvasCompatibleImageUrl', () => {
  it('setzt die WebP/AVIF-Endung einer unsignierten URL auf .jpg (Query/Hash bleiben)', () => {
    expect(deriveCanvasCompatibleImageUrl('https://leaflet-cdn.schwarz/v4/pages/p1-lg.webp')).toBe(
      'https://leaflet-cdn.schwarz/v4/pages/p1-lg.jpg',
    );
    expect(deriveCanvasCompatibleImageUrl('https://cdn/p.avif?x=1#h')).toBe('https://cdn/p.jpg?x=1#h');
  });

  it('rät NICHT an signierten imgproxy-URLs (Signatur würde brechen)', () => {
    expect(
      deriveCanvasCompatibleImageUrl(
        'https://imgproxy.leaflets.schwarz/AbCdEf012345_-XyZ9876/rs:fit/page.webp',
      ),
    ).toBeNull();
  });

  it('gibt null für bereits kompatible/endungslose URLs', () => {
    expect(deriveCanvasCompatibleImageUrl('https://cdn/p1.jpg')).toBeNull();
    expect(
      deriveCanvasCompatibleImageUrl('https://imgproxy.leaflets.schwarz/insecure/rs:fit/page'),
    ).toBeNull();
  });
});

describe('runLidlVisionProspectImport — Tiling', () => {
  const fetchJpeg = async () => fakeJpegBytes();

  it('Full-Page-Analyse timeoutet, aber die Tile-Analyse liefert Kandidaten', async () => {
    // EIN Adapter: Full-Page (ohne promptHint) wirft (simuliert den Full-Page-Timeout);
    // ein Tile (mit promptHint) liefert Kandidaten.
    const adapter: AnalyzeLidlProspectImage = async (image, _context, options) => {
      if (!options?.promptHint) {
        throw new Error('full-page analyze timed out');
      }
      const index = image.bytes[3] ?? 0;
      return index === 0
        ? { candidates: [candidate({ name: 'Rispentomaten', price: 1.49 })], modelName: 'fake-vision' }
        : { candidates: [], modelName: 'fake-vision' };
    };

    const fullPage = await runLidlVisionProspectImport({
      imageUrls: ['p1.jpg'],
      context: RUN_CONTEXT,
      mode: 'diagnostic',
      analyzeImage: adapter,
      fetchBinary: fetchJpeg,
      tileMode: 'off',
    });
    expect(fullPage.counters.imageAnalyzed).toBe(0);
    expect(fullPage.failures.analyzeError).toBe(1);
    expect(fullPage.counters.rawVisionCandidates).toBe(0);

    const tiled = await runLidlVisionProspectImport({
      imageUrls: ['p1.jpg'],
      context: RUN_CONTEXT,
      mode: 'diagnostic',
      analyzeImage: adapter,
      fetchBinary: fetchJpeg,
      tileMode: 'grid',
      tileImage: fakeTiler(2),
    });
    expect(tiled.counters.tileMode).toBe('grid');
    expect(tiled.counters.tilesGenerated).toBe(2);
    expect(tiled.counters.tilesAnalyzed).toBe(2);
    expect(tiled.counters.rawVisionCandidates).toBeGreaterThan(0);
    expect(tiled.counters.safeVisionCandidates).toBeGreaterThan(0);
  });

  it('ein Tile-Timeout blockiert die anderen Tiles nicht (kein Seiten-/Scan-Abbruch)', async () => {
    const run = await runLidlVisionProspectImport({
      imageUrls: ['p1.jpg'],
      context: RUN_CONTEXT,
      mode: 'live',
      analyzeImage: tileAnalysisByIndex({
        0: 'timeout',
        1: [candidate({ name: 'Bio Bananen', price: 1.79 })],
      }),
      fetchBinary: fetchJpeg,
      tileMode: 'grid',
      tileImage: fakeTiler(2),
      tileTimeoutMs: 30,
    });

    expect(run.counters.tilesGenerated).toBe(2);
    expect(run.counters.tilesAnalyzed).toBe(1);
    expect(run.counters.tileAnalyzeErrors).toBe(1);
    expect(run.counters.rawVisionCandidates).toBe(1);
    expect(run.emittedOffers).toHaveLength(1);
    // Timeout ist KEIN „model unavailable" → der Lauf bricht nicht ab.
    expect(run.failures.modelUnavailable).toBe(0);
  });

  it('diagnostic emittiert 0 Angebote, zählt aber raw/safe Tile-Kandidaten', async () => {
    const run = await runLidlVisionProspectImport({
      imageUrls: ['p1.jpg'],
      context: RUN_CONTEXT,
      mode: 'diagnostic',
      analyzeImage: tileAnalysisByIndex({
        0: [candidate({ name: 'Rispentomaten', price: 1.49 })],
        1: [candidate({ name: 'Bio Bananen', price: 1.79 })],
      }),
      fetchBinary: fetchJpeg,
      tileMode: 'grid',
      tileImage: fakeTiler(2),
    });

    expect(run.emittedOffers).toHaveLength(0);
    expect(run.counters.rawVisionCandidates).toBe(2);
    expect(run.counters.safeVisionCandidates).toBe(2);
    expect(run.coverage).toBe('vision_diagnostic');
  });

  it('live emittiert nur die safety-geprüften Tile-Kandidaten', async () => {
    const run = await runLidlVisionProspectImport({
      imageUrls: ['p1.jpg'],
      context: RUN_CONTEXT,
      mode: 'live',
      analyzeImage: tileAnalysisByIndex({
        0: [candidate({ name: 'Rispentomaten', price: 1.49 })],
        1: [candidate({ name: 'Akku-Bohrmaschine', price: 49.99 })],
      }),
      fetchBinary: fetchJpeg,
      tileMode: 'grid',
      tileImage: fakeTiler(2),
    });

    expect(run.counters.rawVisionCandidates).toBe(2);
    expect(run.emittedOffers).toHaveLength(1);
    expect(run.emittedOffers[0].name).toBe('Rispentomaten');
    expect(run.counters.rejectedByReason.nonFood).toBe(1);
    expect(run.coverage).toBe('partial_with_vision');
  });

  it('überlappende Tiles erzeugen Dubletten, die dedupliziert werden', async () => {
    const duplicate = candidate({ name: 'Rispentomaten', price: 1.49 });
    const run = await runLidlVisionProspectImport({
      imageUrls: ['p1.jpg'],
      context: RUN_CONTEXT,
      mode: 'live',
      analyzeImage: tileAnalysisByIndex({ 0: [duplicate], 1: [duplicate] }),
      fetchBinary: fetchJpeg,
      tileMode: 'grid',
      tileImage: fakeTiler(2),
    });

    expect(run.counters.rawVisionCandidates).toBe(2);
    expect(run.counters.safeVisionCandidates).toBe(1);
    expect(run.counters.rejectedByReason.duplicate).toBe(1);
    expect(run.emittedOffers).toHaveLength(1);
  });

  it('verwirft Badge-/Grundpreis-/Non-Food-/Low-Confidence-Tile-Kandidaten', async () => {
    const run = await runLidlVisionProspectImport({
      imageUrls: ['p1.jpg'],
      context: RUN_CONTEXT,
      mode: 'live',
      analyzeImage: tileAnalysisByIndex({
        0: [candidate({ name: '3 Stück', price: 1.99 })],
        1: [candidate({ name: 'Tomaten', price: 2.98, basePriceText: '1 kg = 2,98 €' })],
        2: [candidate({ name: 'Akku-Bohrmaschine', price: 49.99 })],
        3: [candidate({ name: 'Frische Erdbeeren', price: 2.49, confidence: 0.2 })],
      }),
      fetchBinary: fetchJpeg,
      tileMode: 'grid',
      tileImage: fakeTiler(4),
    });

    expect(run.emittedOffers).toHaveLength(0);
    expect(run.counters.rejectedByReason.badgeName).toBe(1);
    expect(run.counters.rejectedByReason.basePrice).toBe(1);
    expect(run.counters.rejectedByReason.nonFood).toBe(1);
    expect(run.counters.rejectedByReason.lowConfidence).toBe(1);
  });

  it('schreibt Tile-Metadaten in die Debug-Evidence, ohne Bilddaten im Snapshot', async () => {
    const evidence: LidlVisionPageEvidence[] = [];
    await runLidlVisionProspectImport({
      imageUrls: ['https://leaflet.cdn.schwarz/p1-lg.jpg'],
      context: RUN_CONTEXT,
      mode: 'diagnostic',
      analyzeImage: tileAnalysisByIndex({
        0: [candidate({ name: 'Rispentomaten', price: 1.49 })],
        1: [],
      }),
      fetchBinary: fetchJpeg,
      tileMode: 'grid',
      tileImage: fakeTiler(2),
      recordPageEvidence: (entry) => evidence.push(entry),
    });

    expect(evidence).toHaveLength(1);
    const entry = evidence[0];
    expect(entry.tileMode).toBe('grid');
    expect(entry.tiles).toHaveLength(2);
    expect(entry.tiles?.[0].box).toBeDefined();
    expect(entry.tiles?.[0].candidateCount).toBe(1);
    // Keine Bilddaten/Bytes im Snapshot.
    expect(JSON.stringify(entry)).not.toContain('"bytes"');
  });

  it('zählt eine nicht zerlegbare Seite als tileRenderFailed, ohne den Scan abzubrechen', async () => {
    const run = await runLidlVisionProspectImport({
      imageUrls: ['p1.webp', 'p2.jpg'],
      context: RUN_CONTEXT,
      mode: 'live',
      analyzeImage: tileAnalysisByIndex({ 0: [candidate({ name: 'Rispentomaten', price: 1.49 })] }),
      fetchBinary: fetchJpeg,
      tileMode: 'grid',
      tileImage: async (image) => {
        if (image.imageUrl === 'p1.webp') {
          throw new VisionTileRenderError('webp nicht dekodierbar');
        }
        return makeFakeTiles(1);
      },
    });

    expect(run.failures.tileRenderFailed).toBe(1);
    expect(run.counters.tilesGenerated).toBe(1);
    expect(run.emittedOffers).toHaveLength(1);
  });

  it('Coverage bleibt maximal partial_with_vision (nie full)', async () => {
    const run = await runLidlVisionProspectImport({
      imageUrls: ['p1.jpg'],
      context: RUN_CONTEXT,
      mode: 'live',
      analyzeImage: tileAnalysisByIndex({ 0: [candidate({ name: 'Rispentomaten', price: 1.49 })] }),
      fetchBinary: fetchJpeg,
      tileMode: 'grid',
      tileImage: fakeTiler(1),
    });
    expect(['vision_diagnostic', 'partial_with_vision']).toContain(run.coverage);
    expect(run.coverage).not.toBe('full');
  });

  // --- Canvas-Renditions-Auflösung im echten Tile-Pfad ---------------------------

  it('WebP-Seite + JPEG-Rendition: tilesGenerated > 0 und tilesAnalyzed > 0', async () => {
    let renditionCalls = 0;
    const run = await runLidlVisionProspectImport({
      imageUrls: ['https://leaflet-cdn.schwarz/v4/pages/p1-lg.webp'],
      context: RUN_CONTEXT,
      mode: 'diagnostic',
      analyzeImage: tileAnalysisByIndex({
        0: [candidate({ name: 'Rispentomaten', price: 1.49 })],
        1: [],
      }),
      fetchBinary: async () => fakeWebpBytes(),
      fetchCanvasRendition: async () => {
        renditionCalls += 1;
        return fakeJpegBytes();
      },
      tileMode: 'grid',
      tileImage: canvasAwareTiler,
    });

    expect(renditionCalls).toBeGreaterThan(0);
    expect(run.counters.tileRenditionsTried).toBe(1);
    expect(run.counters.tileRenditionsSucceeded).toBe(1);
    expect(run.counters.tilesGenerated).toBeGreaterThan(0);
    expect(run.counters.tilesAnalyzed).toBeGreaterThan(0);
    expect(run.failures.tileRenderFailed).toBe(0);
    expect(run.counters.rawVisionCandidates).toBeGreaterThan(0);
  });

  it('WebP-Seite ohne Rendition-Fetch: tileRenderFailed, klare Note + Debug-Evidence', async () => {
    const evidence: LidlVisionPageEvidence[] = [];
    const run = await runLidlVisionProspectImport({
      imageUrls: ['https://leaflet-cdn.schwarz/v4/pages/p1-lg.webp'],
      context: RUN_CONTEXT,
      mode: 'diagnostic',
      analyzeImage: tileAnalysisByIndex({ 0: [candidate({ name: 'Rispentomaten', price: 1.49 })] }),
      fetchBinary: async () => fakeWebpBytes(),
      // KEIN fetchCanvasRendition → keine canvas-kompatible Rendition verfügbar.
      tileMode: 'grid',
      tileImage: canvasAwareTiler,
      recordPageEvidence: (entry) => evidence.push(entry),
    });

    expect(run.counters.tilesGenerated).toBe(0);
    expect(run.counters.tilesAnalyzed).toBe(0);
    expect(run.failures.tileRenderFailed).toBe(1);
    expect(run.failures.unsupportedImageFormatForCanvas).toBe(1);
    expect(run.emittedOffers).toHaveLength(0);
    expect(run.primaryReason).toMatch(/unsupportedImageFormatForCanvas/);

    // Debug-Evidence MUSS auch bei Render-Failure entstehen (mit echter Ursache).
    expect(evidence).toHaveLength(1);
    expect(evidence[0].renderStatus).toBe('unsupportedImageFormatForCanvas');
    expect(evidence[0].originalImageFormat).toBe('webp');
    expect(typeof evidence[0].magicBytes).toBe('string');
    expect(evidence[0].tilePlanAttempted).toBe(false);
    expect(evidence[0].renderErrorName).toBe('VisionTileRenderError');
    expect(evidence[0].sourceId).toBe(RUN_CONTEXT.sourceId);
  });

  it('Rendition liefert erneut WebP → alternativeRenditionFailed mit Grund + Evidence', async () => {
    const evidence: LidlVisionPageEvidence[] = [];
    const run = await runLidlVisionProspectImport({
      imageUrls: ['https://leaflet-cdn.schwarz/v4/pages/p1-lg.webp'],
      context: RUN_CONTEXT,
      mode: 'diagnostic',
      analyzeImage: tileAnalysisByIndex({ 0: [] }),
      fetchBinary: async () => fakeWebpBytes(),
      fetchCanvasRendition: async () => fakeWebpBytes(),
      tileMode: 'grid',
      tileImage: canvasAwareTiler,
      recordPageEvidence: (entry) => evidence.push(entry),
    });

    expect(run.counters.tileRenditionsTried).toBe(1);
    expect(run.counters.tileRenditionsSucceeded).toBe(0);
    expect(run.failures.alternativeRenditionFailed).toBe(1);
    expect(run.failures.tileRenderFailed).toBe(1);
    expect(evidence[0].renderStatus).toBe('alternativeRenditionFailed');
    expect(evidence[0].renderErrorMessage).toMatch(/nicht canvas-kompatibel/);
    expect(typeof evidence[0].renditionUrlHash).toBe('string');
  });

  it('canvas-loadImage-Fehler auf kompatiblem Bild → canvasDecodeFailed + Evidence', async () => {
    const evidence: LidlVisionPageEvidence[] = [];
    const run = await runLidlVisionProspectImport({
      imageUrls: ['https://leaflet-cdn.schwarz/v4/pages/p1-lg.jpg'],
      context: RUN_CONTEXT,
      mode: 'diagnostic',
      analyzeImage: tileAnalysisByIndex({ 0: [] }),
      fetchBinary: async () => fakeJpegBytes(),
      tileMode: 'grid',
      tileImage: async () => {
        throw new VisionTileRenderError('canvas loadImage scheiterte');
      },
      recordPageEvidence: (entry) => evidence.push(entry),
    });

    expect(run.failures.canvasDecodeFailed).toBe(1);
    expect(run.failures.tileRenderFailed).toBe(1);
    expect(run.counters.tilesGenerated).toBe(0);
    expect(evidence[0].renderStatus).toBe('canvasDecodeFailed');
    expect(evidence[0].tilePlanAttempted).toBe(true);
    expect(evidence[0].renderErrorName).toBe('VisionTileRenderError');
    expect(evidence[0].originalImageFormat).toBe('jpeg');
  });
});

// --- Optimierte Tile-Analyse: kurzer Prompt, num_predict, Fehler-Klassen, Subtiles ----
//
// Root Cause des Tile-Timeouts (belegt): der volle Regel-Prompt + ganze Tiles sind für
// llava:7b je Call zu schwer. Diese Tests pinnen die Optimierungen: KURZER Tile-Prompt,
// begrenztes num_predict, nach Ursache getrennte Tile-Fehler-Zähler, Tile-Debug mit
// durationMs/Größe und den budgetierten Subtile-Fallback nach Timeout.

describe('Tile-Prompt + Ollama-Optionen (kurzer Prompt, num_predict)', () => {
  it('verwendet den KURZEN Tile-Prompt und setzt num_predict im Ollama-Request', async () => {
    let capturedBody: string | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return {
        ok: true,
        status: 200,
        json: async () => ({ message: { content: '{"candidates":[]}' } }),
        text: async () => '',
      } as Response;
    }) as unknown as typeof fetch;

    await analyzeLidlProspectImageWithVision(
      { bytes: fakeJpegBytes(), imageUrl: 'tile.jpg', format: 'jpeg' },
      { storeChain: 'Lidl', sourceUrl: 'x', imageUrl: 'tile.jpg', imageFormat: 'jpeg' },
      { host: 'http://localhost:11434', model: 'llava:7b', fetchImpl, numPredict: 256, topP: 0.4 },
      { prompt: LIDL_VISION_TILE_PROMPT, promptHint: 'marker' },
    );

    expect(capturedBody).toBeDefined();
    // Kurzer Prompt verwendet, NICHT der lange deutsche Regelblock.
    expect(capturedBody).toContain('Extract visible German supermarket');
    expect(capturedBody).not.toContain('Du extrahierst Angebote');
    // num_predict + top_p begrenzt.
    expect(capturedBody).toContain('"num_predict":256');
    expect(capturedBody).toContain('"top_p":0.4');
  });

  it('setzt num_predict per Default, auch ohne explizite Konfiguration', async () => {
    let capturedBody: string | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return {
        ok: true,
        status: 200,
        json: async () => ({ message: { content: '{"candidates":[]}' } }),
        text: async () => '',
      } as Response;
    }) as unknown as typeof fetch;

    await analyzeLidlProspectImageWithVision(
      { bytes: fakeJpegBytes(), imageUrl: 'p1.jpg', format: 'jpeg' },
      { storeChain: 'Lidl', sourceUrl: 'x', imageUrl: 'p1.jpg', imageFormat: 'jpeg' },
      { host: 'http://localhost:11434', model: 'llava:7b', fetchImpl },
    );

    expect(capturedBody).toMatch(/"num_predict":\d+/);
    // top_p NICHT gesetzt, wenn nicht konfiguriert.
    expect(capturedBody).not.toContain('top_p');
  });
});

describe('Adapter-Fehlerklassen (httpError / emptyResponse / nicht-visionfähig)', () => {
  const img = { bytes: fakeJpegBytes(), imageUrl: 'p1.jpg', format: 'jpeg' };
  const ctx = { storeChain: 'Lidl', sourceUrl: 'x', imageUrl: 'p1.jpg', imageFormat: 'jpeg' };

  it('wirft VisionHttpError bei einem HTTP-Fehler (500) — Runtime lebt', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'internal error',
    }) as Response) as unknown as typeof fetch;

    await expect(
      analyzeLidlProspectImageWithVision(img, ctx, { host: 'http://h', model: 'llava:7b', fetchImpl }),
    ).rejects.toBeInstanceOf(VisionHttpError);
  });

  it('wirft VisionEmptyResponseError bei leerer Modellantwort', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ message: { content: '' } }),
      text: async () => '',
    }) as Response) as unknown as typeof fetch;

    await expect(
      analyzeLidlProspectImageWithVision(img, ctx, { host: 'http://h', model: 'llava:7b', fetchImpl }),
    ).rejects.toBeInstanceOf(VisionEmptyResponseError);
  });

  it('meldet ein nicht visionfähiges Modell als modelUnavailable (HTTP 400 + Bild-Hinweis)', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({}),
      text: async () => 'this model does not support images',
    }) as Response) as unknown as typeof fetch;

    await expect(
      analyzeLidlProspectImageWithVision(img, ctx, { host: 'http://h', model: 'qwen3:14b', fetchImpl }),
    ).rejects.toBeInstanceOf(VisionModelUnavailableError);
  });
});

describe('planVisionTiles — Max-Tile-Größe erzwingt kleinere Tiles', () => {
  it('maxTileWidth erhöht die Spaltenzahl (kein Tile breiter als die Schranke)', () => {
    const wide = planVisionTiles(1200, 1200, { columns: 2, limit: 16 });
    const narrow = planVisionTiles(1200, 1200, { columns: 2, limit: 16, maxTileWidth: 300 });
    // Mehr/engere Spalten ⇒ mehr Tiles; jedes Tile bleibt in den Grenzen und ist klar
    // schmaler als die nominale 600px-Spalte des 2-Spalten-Rasters (Basis 300 + Overlap).
    expect(narrow.length).toBeGreaterThan(wide.length);
    for (const tile of narrow) {
      expect(tile.box.w).toBeLessThan(600);
      expect(tile.box.x + tile.box.w).toBeLessThanOrEqual(1200);
    }
  });

  it('maxTileHeight erhöht die Zeilenzahl im Rahmen des Budgets', () => {
    const tiles = planVisionTiles(600, 2400, { columns: 1, limit: 12, maxTileHeight: 400 });
    expect(tiles.length).toBeGreaterThan(1);
    expect(tiles.length).toBeLessThanOrEqual(12);
  });
});

describe('runLidlVisionProspectImport — Tile-Fehler nach Ursache getrennt', () => {
  const fetchJpeg = async () => fakeJpegBytes();

  /** Fake-Vision, die je Tile-Index eine bestimmte Fehlerklasse wirft (außer Timeout, der
   *  über das Runner-Signal entsteht). */
  function tileErrorByIndex(
    byIndex: Record<number, 'http' | 'parse' | 'empty' | VisionProspectCandidate[]>,
  ): AnalyzeLidlProspectImage {
    return async (image) => {
      const index = image.bytes[3] ?? 0;
      const entry = byIndex[index];
      if (entry === 'http') {
        throw new VisionHttpError('HTTP 500');
      }
      if (entry === 'parse') {
        throw new VisionResponseParseError('kein JSON');
      }
      if (entry === 'empty') {
        throw new VisionEmptyResponseError('leer');
      }
      return { candidates: entry ?? [], modelName: 'fake-vision' };
    };
  }

  it('zählt tileTimeout/tileHttpError/tileParseError/tileEmptyResponse getrennt', async () => {
    const run = await runLidlVisionProspectImport({
      imageUrls: ['p1.jpg'],
      context: RUN_CONTEXT,
      mode: 'diagnostic',
      analyzeImage: tileErrorByIndex({ 0: 'http', 1: 'parse', 2: 'empty', 3: [] }),
      fetchBinary: fetchJpeg,
      tileMode: 'grid',
      tileImage: fakeTiler(4),
    });

    expect(run.counters.tileHttpErrors).toBe(1);
    expect(run.counters.tileParseErrors).toBe(1);
    expect(run.counters.tileEmptyResponses).toBe(1);
    expect(run.counters.tileTimeouts).toBe(0);
    // Umbrella = Summe der Ursachen (index 3 lieferte [] → kein Fehler).
    expect(run.counters.tileAnalyzeErrors).toBe(3);
    // Report weist die getrennten Zähler aus.
    expect(run.diagnostic.note).toMatch(/tileHttpError 1/);
    expect(run.diagnostic.note).toMatch(/tileParseError 1/);
    expect(run.diagnostic.note).toMatch(/tileEmptyResponse 1/);
  });

  it('Tile-Debug enthält durationMs, Tilegröße (byteLength) und die Fehlerart', async () => {
    const evidence: LidlVisionPageEvidence[] = [];
    await runLidlVisionProspectImport({
      imageUrls: ['p1.jpg'],
      context: RUN_CONTEXT,
      mode: 'diagnostic',
      analyzeImage: tileErrorByIndex({ 0: [candidate({ name: 'Rispentomaten', price: 1.49 })], 1: 'http' }),
      fetchBinary: fetchJpeg,
      tileMode: 'grid',
      tileImage: fakeTiler(2),
      recordPageEvidence: (entry) => evidence.push(entry),
    });

    const tiles = evidence[0].tiles ?? [];
    expect(tiles).toHaveLength(2);
    for (const tile of tiles) {
      expect(typeof tile.durationMs).toBe('number');
      expect(tile.byteLength).toBeGreaterThan(0);
    }
    expect(tiles.find((t) => t.index === 1)?.error).toBe('httpError');
  });
});

describe('runLidlVisionProspectImport — Subtile-Fallback nach Timeout', () => {
  const fetchJpeg = async () => fakeJpegBytes();

  it('zerlegt ein timeoutendes Tile in budgetierte Subtiles → liefert Kandidaten', async () => {
    // Erster Tiler-Call (Seite) → 1 großes Tile (Index 0). Zweiter Call (Subtile-Fallback)
    // → 1 kleines Subtile (Index 5). Der Adapter timeoutet Index 0 und liefert für Index 5.
    let tilerCalls = 0;
    const tiler: LidlVisionImageTiler = async () => {
      tilerCalls += 1;
      if (tilerCalls === 1) {
        return makeFakeTiles(1); // großes Tile, Index 0
      }
      return [
        {
          index: 5,
          column: 0,
          row: 0,
          box: { x: 0, y: 0, w: 60, h: 60 },
          bytes: new Uint8Array([0xff, 0xd8, 0xff, 5]),
          format: 'jpeg',
        },
      ];
    };

    const run = await runLidlVisionProspectImport({
      imageUrls: ['p1.jpg'],
      context: RUN_CONTEXT,
      mode: 'diagnostic',
      analyzeImage: tileAnalysisByIndex({
        0: 'timeout',
        5: [candidate({ name: 'Rispentomaten', price: 1.49 })],
      }),
      fetchBinary: fetchJpeg,
      tileMode: 'grid',
      tileImage: tiler,
      tileTimeoutMs: 30,
      subtileFallback: true,
      subtileLimit: 4,
    });

    expect(run.counters.tileTimeouts).toBe(1);
    expect(run.counters.subtilesGenerated).toBeGreaterThan(0);
    expect(run.counters.subtilesAnalyzed).toBeGreaterThan(0);
    expect(run.counters.rawVisionCandidates).toBeGreaterThan(0);
    // diagnostic bleibt 0 emittedOffers.
    expect(run.emittedOffers).toHaveLength(0);
    expect(run.diagnostic.note).toMatch(/subtiles \d+\/\d+/);
  });

  it('ohne subtileFallback bleibt ein Timeout ein reiner tileTimeout (kein Subtiling)', async () => {
    const run = await runLidlVisionProspectImport({
      imageUrls: ['p1.jpg'],
      context: RUN_CONTEXT,
      mode: 'diagnostic',
      analyzeImage: tileAnalysisByIndex({ 0: 'timeout' }),
      fetchBinary: fetchJpeg,
      tileMode: 'grid',
      tileImage: fakeTiler(1),
      tileTimeoutMs: 30,
    });

    expect(run.counters.tileTimeouts).toBe(1);
    expect(run.counters.subtilesGenerated).toBe(0);
    expect(run.counters.rawVisionCandidates).toBe(0);
  });
});
