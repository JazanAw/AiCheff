import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { evaluateSnapshotSafety, type SnapshotBucketsLike } from './snapshotSafetyGate';
import {
  buildSubSourceDiagnostic,
  sanitizeSubSourceDiagnostics,
  type SubSourceDiagnostic,
} from '../../src/services/offersIngest/subSourceDiagnostics';

// P5 — partieller Subquellen-/Prospektverlust wird über die STRUKTURIERTE
// Connector-Diagnose (storeChain + sourceId + Gültigkeitsfenster) erkannt, NICHT
// mehr aus Warnungstext. Generisch für ALLE Shops, keine Lidl-Sonderlogik.
// Konkrete Zahlen/Slugs sind reine Reproduktions-Fixtures.

const NOW = new Date('2026-06-15T08:00:00.000Z');

const CURRENT_SOURCE = 'lidl:aktionsprospekt-15-06-2026';
const NEXT_SOURCE = 'lidl:aktionsprospekt-22-06-2026';

function offer(storeChain: string, idx: number, extra: Partial<Offer> = {}): Offer {
  return {
    id: `${storeChain}_${extra.sourceId ?? 'x'}_${idx}`,
    name: `${storeChain} Angebot ${idx}`,
    normalizedName: `${storeChain.toLowerCase()} angebot ${idx}`,
    storeChain,
    category: 'Sonstiges',
    price: 1.99,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: '2026-06-15T00:00:00.000Z',
    validityEnd: '2026-06-20T23:59:59.000Z',
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-06-15T00:00:00.000Z',
    ...extra,
  } as Offer;
}

function many(storeChain: string, count: number, extra: Partial<Offer> = {}): Offer[] {
  return Array.from({ length: count }, (_, i) => offer(storeChain, i, extra));
}

const currentOk = (resultCount: number): SubSourceDiagnostic =>
  buildSubSourceDiagnostic({
    storeChain: 'Lidl',
    sourceId: CURRENT_SOURCE,
    status: 'success',
    urlOrSlug: 'aktionsprospekt-15-06-2026',
    expectedValidityStart: '2026-06-15T00:00:00.000Z',
    expectedValidityEnd: '2026-06-20T23:59:59.000Z',
    rawCount: resultCount,
    resultCount,
  });

const nextFetchFailed = (): SubSourceDiagnostic =>
  buildSubSourceDiagnostic({
    storeChain: 'Lidl',
    sourceId: NEXT_SOURCE,
    status: 'fetch_failed',
    urlOrSlug: 'aktionsprospekt-22-06-2026',
    expectedValidityStart: '2026-06-22T00:00:00.000Z',
    expectedValidityEnd: '2026-06-27T23:59:59.000Z',
    rawCount: 0,
    resultCount: 0,
    errorCode: 'http_timeout',
  });

describe('P5 — strukturierte Subquellen-Diagnostik im Safety-Gate', () => {
  it('aktueller Prospekt success, nächster fetch_failed → nur nächster Vorbestand weg → blockiert', () => {
    const previous: SnapshotBucketsLike = {
      offers: many('Lidl', 17, { sourceId: CURRENT_SOURCE }),
      nextWeekOffers: many('Lidl', 17, {
        sourceId: NEXT_SOURCE,
        validityStart: '2026-06-22T00:00:00.000Z',
        validityEnd: '2026-06-27T23:59:59.000Z',
      }),
      filteredOffers: many('Lidl', 200, { sourceId: CURRENT_SOURCE }),
    };
    const candidate: SnapshotBucketsLike = {
      offers: many('Lidl', 17, { sourceId: CURRENT_SOURCE }),
      nextWeekOffers: [],
      filteredOffers: many('Lidl', 132, { sourceId: CURRENT_SOURCE }),
    };
    const result = evaluateSnapshotSafety({
      previous,
      candidate,
      now: NOW,
      subSourceDiagnostics: [currentOk(17), nextFetchFailed()],
    });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('prospectWindowLost');
    // Nur der fehlerhafte Prospekt wird als Ursache (blocked) genannt.
    const blocked = result.subSourceOutcomes.filter((o) => o.gateDecision === 'blocked');
    expect(blocked.map((o) => o.sourceId)).toEqual([NEXT_SOURCE]);
    const current = result.subSourceOutcomes.find((o) => o.sourceId === CURRENT_SOURCE);
    expect(current?.gateDecision).toBe('committed');
  });

  it('parse_failed mit erheblichem Verlust → blockiert', () => {
    const previous: SnapshotBucketsLike = {
      offers: many('Penny', 40, { sourceId: 'penny:current' }),
      nextWeekOffers: [],
      filteredOffers: [],
    };
    const candidate: SnapshotBucketsLike = {
      offers: many('Penny', 8, { sourceId: 'penny:current' }),
      nextWeekOffers: [],
      filteredOffers: [],
    };
    const result = evaluateSnapshotSafety({
      previous,
      candidate,
      now: NOW,
      subSourceDiagnostics: [
        buildSubSourceDiagnostic({
          storeChain: 'Penny',
          sourceId: 'penny:current',
          status: 'parse_failed',
          rawCount: 8,
          resultCount: 8,
          errorCode: 'json_parse_error',
        }),
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('prospectWindowLost');
  });

  it('success mit normaler Mengenänderung → erlaubt', () => {
    const previous: SnapshotBucketsLike = {
      offers: many('Lidl', 30, { sourceId: CURRENT_SOURCE }),
      nextWeekOffers: [],
      filteredOffers: [],
    };
    const candidate: SnapshotBucketsLike = {
      offers: many('Lidl', 26, { sourceId: CURRENT_SOURCE }), // -13 %, normal
      nextWeekOffers: [],
      filteredOffers: [],
    };
    const result = evaluateSnapshotSafety({
      previous,
      candidate,
      now: NOW,
      subSourceDiagnostics: [currentOk(26)],
    });
    expect(result.failedChecks).not.toContain('prospectWindowLost');
  });

  it('empty ohne vorherigen Bestand → erlaubt und diagnostiziert', () => {
    const previous: SnapshotBucketsLike = {
      offers: many('Lidl', 17, { sourceId: CURRENT_SOURCE }),
      nextWeekOffers: [],
      filteredOffers: [],
    };
    const candidate: SnapshotBucketsLike = {
      offers: many('Lidl', 17, { sourceId: CURRENT_SOURCE }),
      nextWeekOffers: [],
      filteredOffers: [],
    };
    const result = evaluateSnapshotSafety({
      previous,
      candidate,
      now: NOW,
      subSourceDiagnostics: [
        currentOk(17),
        buildSubSourceDiagnostic({
          storeChain: 'Lidl',
          sourceId: NEXT_SOURCE,
          status: 'empty',
          expectedValidityStart: '2026-06-22T00:00:00.000Z',
          expectedValidityEnd: '2026-06-27T23:59:59.000Z',
          rawCount: 0,
          resultCount: 0,
        }),
      ],
    });
    expect(result.failedChecks).not.toContain('prospectWindowLost');
    const empty = result.subSourceOutcomes.find((o) => o.sourceId === NEXT_SOURCE);
    expect(empty?.status).toBe('empty');
    expect(empty?.gateDecision).toBe('committed');
  });

  it('harmlose Warnung mit Shopnamen löst KEINEN Prospektverlust aus', () => {
    const previous: SnapshotBucketsLike = {
      offers: many('Lidl', 17, { sourceId: CURRENT_SOURCE }),
      nextWeekOffers: many('Lidl', 17, {
        sourceId: NEXT_SOURCE,
        validityStart: '2026-06-22T00:00:00.000Z',
      }),
      filteredOffers: [],
    };
    const candidate: SnapshotBucketsLike = {
      offers: many('Lidl', 17, { sourceId: CURRENT_SOURCE }),
      nextWeekOffers: [],
      filteredOffers: [],
    };
    const result = evaluateSnapshotSafety({
      previous,
      candidate,
      now: NOW,
      // Eine Warnung, die "Lidl" nennt, aber KEINE strukturierte Fehlschlag-Diagnose.
      scrapeWarnings: ['Lidl: 3 Karten ohne Bild übersprungen (kosmetisch).'],
      subSourceDiagnostics: [currentOk(17)],
    });
    expect(result.failedChecks).not.toContain('prospectWindowLost');
  });

  it('REWE-only-Scope ignoriert Lidl-Diagnosen', () => {
    const previous: SnapshotBucketsLike = {
      offers: [...many('Lidl', 17, { sourceId: NEXT_SOURCE }), ...many('REWE', 30)],
      nextWeekOffers: [],
      filteredOffers: [],
    };
    const candidate: SnapshotBucketsLike = {
      offers: [...many('Lidl', 0), ...many('REWE', 30)],
      nextWeekOffers: [],
      filteredOffers: [],
    };
    const result = evaluateSnapshotSafety({
      previous,
      candidate,
      now: NOW,
      scope: { type: 'stores', stores: ['rewe'] },
      subSourceDiagnostics: [nextFetchFailed()],
    });
    expect(result.failedChecks).not.toContain('prospectWindowLost');
    const lidl = result.subSourceOutcomes.find((o) => o.sourceId === NEXT_SOURCE);
    expect(lidl?.gateDecision).toBe('unaffected');
  });

  it('zwei Prospekte desselben Shops: nur der fehlerhafte wird als Ursache genannt', () => {
    const previous: SnapshotBucketsLike = {
      offers: [
        ...many('Lidl', 20, { sourceId: CURRENT_SOURCE }),
        ...many('Lidl', 20, {
          sourceId: NEXT_SOURCE,
          validityStart: '2026-06-22T00:00:00.000Z',
        }),
      ],
      nextWeekOffers: [],
      filteredOffers: [],
    };
    const candidate: SnapshotBucketsLike = {
      offers: many('Lidl', 20, { sourceId: CURRENT_SOURCE }), // next weg
      nextWeekOffers: [],
      filteredOffers: [],
    };
    const result = evaluateSnapshotSafety({
      previous,
      candidate,
      now: NOW,
      subSourceDiagnostics: [currentOk(20), nextFetchFailed()],
    });
    expect(result.failedChecks).toContain('prospectWindowLost');
    const blocked = result.subSourceOutcomes.filter((o) => o.gateDecision === 'blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0].sourceId).toBe(NEXT_SOURCE);
    expect(result.reasons.some((r) => r.includes(NEXT_SOURCE))).toBe(true);
    expect(result.reasons.some((r) => r.includes(CURRENT_SOURCE))).toBe(false);
  });

  it('Gate-Fehler mutiert die übergebenen Buckets nicht (alter Snapshot bleibt unverändert)', () => {
    const previous: SnapshotBucketsLike = {
      offers: many('Lidl', 30, { sourceId: NEXT_SOURCE }),
      nextWeekOffers: [],
      filteredOffers: [],
    };
    const candidate: SnapshotBucketsLike = { offers: [], nextWeekOffers: [], filteredOffers: [] };
    const previousSnapshotJson = JSON.stringify(previous);
    const result = evaluateSnapshotSafety({
      previous,
      candidate,
      now: NOW,
      subSourceDiagnostics: [nextFetchFailed()],
    });
    expect(result.ok).toBe(false);
    // Reine Funktion: der vorherige Snapshot ist byte-/inhaltlich unverändert,
    // der Aufrufer behält ihn (assertSnapshotSafeToCommit wirft VOR dem Schreiben).
    expect(JSON.stringify(previous)).toBe(previousSnapshotJson);
  });

  it('leere :prospektseiten:ocr-Diagnose erscheint in subSourceBalance und blockiert nie', () => {
    // Live-Befund-Regression: die OCR-Bilanzzeile muss bis ins Gate/Report
    // durchlaufen (sichtbar) UND als ehrlicher Leerstand non-blocking sein.
    const previous: SnapshotBucketsLike = {
      offers: many('Lidl', 17, { sourceId: CURRENT_SOURCE }),
      nextWeekOffers: [],
      filteredOffers: [],
    };
    const candidate: SnapshotBucketsLike = {
      offers: many('Lidl', 17, { sourceId: CURRENT_SOURCE }),
      nextWeekOffers: [],
      filteredOffers: [],
    };
    const OCR_NOTE =
      'OCR diagnostic | Kette: 9 Prospektseiten → 0 Bild-URL(s) … ' +
      'Ursache: keine ladbaren CDN-Bild-URLs aus den Prospektseiten extrahiert.';
    const ocrLine = buildSubSourceDiagnostic({
      storeChain: 'Lidl',
      sourceId: `${CURRENT_SOURCE}:prospektseiten:ocr`,
      status: 'empty',
      urlOrSlug: 'aktionsprospekt-15-06-2026',
      rawCount: 0,
      resultCount: 0,
      note: OCR_NOTE,
    });
    const result = evaluateSnapshotSafety({
      previous,
      candidate,
      now: NOW,
      subSourceDiagnostics: [currentOk(17), ocrLine],
    });
    expect(result.ok).toBe(true);
    expect(result.failedChecks).not.toContain('prospectWindowLost');
    const ocr = result.subSourceOutcomes.find((o) =>
      o.sourceId.endsWith(':prospektseiten:ocr'),
    );
    expect(ocr).toBeDefined();
    expect(ocr?.status).toBe('empty');
    expect(ocr?.gateDecision).toBe('committed');
    // Root-Cause-Regression: die Note (mit primaryReason) MUSS durch das Mapping
    // SubSourceDiagnostic → SubSourceOutcome erhalten bleiben — vorher hier
    // verloren, daher note=null im echten /api/offers/scan-report.
    expect(ocr?.note).toBe(OCR_NOTE);
    expect(ocr?.note).toMatch(/Ursache:/);
  });

  it('Subquelle OHNE Note bleibt kompatibel (note bleibt undefined)', () => {
    // Regression: bestehende Diagnosen ohne `note` dürfen durch das ergänzte
    // Mapping nicht plötzlich einen Wert tragen.
    const previous: SnapshotBucketsLike = {
      offers: many('Lidl', 17, { sourceId: CURRENT_SOURCE }),
      nextWeekOffers: [],
      filteredOffers: [],
    };
    const candidate: SnapshotBucketsLike = {
      offers: many('Lidl', 17, { sourceId: CURRENT_SOURCE }),
      nextWeekOffers: [],
      filteredOffers: [],
    };
    const result = evaluateSnapshotSafety({
      previous,
      candidate,
      now: NOW,
      subSourceDiagnostics: [currentOk(17)],
    });
    const current = result.subSourceOutcomes.find((o) => o.sourceId === CURRENT_SOURCE);
    expect(current).toBeDefined();
    expect(current?.note).toBeUndefined();
  });

  it('Diagnose übersteht Checkpoint/Resume (JSON-Roundtrip + Sanitize)', () => {
    const diagnostics: SubSourceDiagnostic[] = [currentOk(17), nextFetchFailed()];
    const roundTripped = sanitizeSubSourceDiagnostics(
      JSON.parse(JSON.stringify(diagnostics)) as SubSourceDiagnostic[],
    );
    expect(roundTripped).toHaveLength(2);
    expect(roundTripped[1].status).toBe('fetch_failed');
    expect(roundTripped[1].sourceId).toBe(NEXT_SOURCE);
    // Defekte/teilweise verlorene Einträge werden verworfen, nicht still verwendet.
    expect(
      sanitizeSubSourceDiagnostics([{ storeChain: '', sourceId: '' } as SubSourceDiagnostic]),
    ).toHaveLength(0);
  });
});
