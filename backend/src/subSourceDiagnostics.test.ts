import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  buildSubSourceDiagnostic,
  evaluateSubSourceProspectLoss,
  isSubSourceFailure,
  offerBelongsToSubSource,
  sanitizeSubSourceDiagnostics,
  subSourceErrorCode,
} from '../../src/services/offersIngest/subSourceDiagnostics';
import { renderSubSourceBalanceMarkdown } from './scanReport';

// Task P5/P6 — gemeinsames Subquellen-Diagnosemodell: discriminated union, defensive
// Offer→Subquelle-Migration (sourceId / Gültigkeitsfenster / URL) und die reine
// Per-Subquellen-Verlustprüfung. Konkrete Werte sind reine Fixtures.

function offer(extra: Partial<Offer>): Offer {
  return {
    id: 'o',
    name: 'X',
    normalizedName: 'x',
    storeChain: 'Lidl',
    category: 'Sonstiges',
    price: 1,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: '2026-06-15T00:00:00.000Z',
    validityEnd: '2026-06-20T23:59:59.000Z',
    sourceUrl: 'https://example.com/x',
    tags: [],
    createdAt: '2026-06-15T00:00:00.000Z',
    ...extra,
  } as Offer;
}

describe('SubSourceDiagnostic — discriminated union + Fehlercode', () => {
  it('nur fetch_failed/parse_failed sind Fehlschläge und tragen einen Fehlercode', () => {
    const ok = buildSubSourceDiagnostic({ storeChain: 'Lidl', sourceId: 's', status: 'success' });
    const empty = buildSubSourceDiagnostic({ storeChain: 'Lidl', sourceId: 's', status: 'empty' });
    const failed = buildSubSourceDiagnostic({
      storeChain: 'Lidl',
      sourceId: 's',
      status: 'fetch_failed',
      errorCode: 'http_timeout',
    });
    expect(isSubSourceFailure(ok)).toBe(false);
    expect(isSubSourceFailure(empty)).toBe(false);
    expect(isSubSourceFailure(failed)).toBe(true);
    expect(subSourceErrorCode(failed)).toBe('http_timeout');
    expect(subSourceErrorCode(ok)).toBeUndefined();
  });
});

describe('offerBelongsToSubSource — Zuordnung/Migration', () => {
  const diag = buildSubSourceDiagnostic({
    storeChain: 'Lidl',
    sourceId: 'lidl:next',
    status: 'fetch_failed',
    urlOrSlug: 'aktionsprospekt-22-06-2026',
    expectedValidityStart: '2026-06-22T00:00:00.000Z',
    expectedValidityEnd: '2026-06-27T23:59:59.000Z',
  });

  it('matcht exakt über sourceId, wenn vorhanden', () => {
    expect(offerBelongsToSubSource(offer({ sourceId: 'lidl:next' }), diag)).toBe(true);
    expect(offerBelongsToSubSource(offer({ sourceId: 'lidl:current' }), diag)).toBe(false);
  });

  it('Migration über Gültigkeitsfenster, wenn keine sourceId vorhanden', () => {
    const inWindow = offer({
      validityStart: '2026-06-22T00:00:00.000Z',
      validityEnd: '2026-06-27T23:59:59.000Z',
    });
    const outWindow = offer({
      validityStart: '2026-06-15T00:00:00.000Z',
      validityEnd: '2026-06-20T23:59:59.000Z',
    });
    expect(offerBelongsToSubSource(inWindow, diag)).toBe(true);
    expect(offerBelongsToSubSource(outWindow, diag)).toBe(false);
  });

  it('anderer Shop matcht nie', () => {
    expect(offerBelongsToSubSource(offer({ storeChain: 'REWE', sourceId: 'lidl:next' }), diag)).toBe(
      false,
    );
  });
});

describe('evaluateSubSourceProspectLoss — blockt nur expliziten Fehlschlag mit erheblichem Verlust', () => {
  const inScope = () => true;
  const notExcluded = () => false;

  it('fetch_failed + erheblicher Verlust → blocked', () => {
    const prev = Array.from({ length: 20 }, (_, i) => offer({ id: `p${i}`, sourceId: 'lidl:next' }));
    const result = evaluateSubSourceProspectLoss({
      previousOffers: prev,
      candidateOffers: [],
      diagnostics: [
        buildSubSourceDiagnostic({ storeChain: 'Lidl', sourceId: 'lidl:next', status: 'fetch_failed' }),
      ],
      inScope,
      isExcluded: notExcluded,
      minPrevious: 5,
      dropFraction: 0.5,
    });
    expect(result.blocked).toBe(true);
    expect(result.outcomes[0].gateDecision).toBe('blocked');
    expect(result.outcomes[0].lossCount).toBe(20);
  });

  it('success mit normaler Schwankung → committed (nicht blocked)', () => {
    const prev = Array.from({ length: 20 }, (_, i) => offer({ id: `p${i}`, sourceId: 'lidl:cur' }));
    const cand = Array.from({ length: 18 }, (_, i) => offer({ id: `c${i}`, sourceId: 'lidl:cur' }));
    const result = evaluateSubSourceProspectLoss({
      previousOffers: prev,
      candidateOffers: cand,
      diagnostics: [buildSubSourceDiagnostic({ storeChain: 'Lidl', sourceId: 'lidl:cur', status: 'success' })],
      inScope,
      isExcluded: notExcluded,
      minPrevious: 5,
      dropFraction: 0.5,
    });
    expect(result.blocked).toBe(false);
    expect(result.outcomes[0].gateDecision).toBe('committed');
  });

  it('übernimmt die Diagnose-Note 1:1 in das Outcome (raw=0 bleibt erklärbar)', () => {
    const note = 'OCR diagnostic | Kette: 9 → 0 … Ursache: keine ladbaren CDN-Bild-URLs.';
    const result = evaluateSubSourceProspectLoss({
      previousOffers: [],
      candidateOffers: [],
      diagnostics: [
        buildSubSourceDiagnostic({
          storeChain: 'Lidl',
          sourceId: 'lidl:cur:prospektseiten:ocr',
          status: 'empty',
          rawCount: 0,
          resultCount: 0,
          note,
        }),
      ],
      inScope,
      isExcluded: notExcluded,
      minPrevious: 5,
      dropFraction: 0.5,
    });
    expect(result.outcomes[0].note).toBe(note);
  });

  it('Diagnose ohne Note → Outcome-Note bleibt undefined (kompatibel)', () => {
    const result = evaluateSubSourceProspectLoss({
      previousOffers: [],
      candidateOffers: [],
      diagnostics: [
        buildSubSourceDiagnostic({ storeChain: 'Lidl', sourceId: 'lidl:cur', status: 'success' }),
      ],
      inScope,
      isExcluded: notExcluded,
      minPrevious: 5,
      dropFraction: 0.5,
    });
    expect(result.outcomes[0].note).toBeUndefined();
  });

  it('out-of-scope → unaffected', () => {
    const prev = Array.from({ length: 20 }, (_, i) => offer({ id: `p${i}`, sourceId: 'lidl:next' }));
    const result = evaluateSubSourceProspectLoss({
      previousOffers: prev,
      candidateOffers: [],
      diagnostics: [
        buildSubSourceDiagnostic({ storeChain: 'Lidl', sourceId: 'lidl:next', status: 'fetch_failed' }),
      ],
      inScope: () => false,
      isExcluded: notExcluded,
      minPrevious: 5,
      dropFraction: 0.5,
    });
    expect(result.blocked).toBe(false);
    expect(result.outcomes[0].gateDecision).toBe('unaffected');
  });
});

describe('sanitizeSubSourceDiagnostics + Report-Rendering', () => {
  it('verwirft Einträge ohne storeChain/sourceId', () => {
    expect(sanitizeSubSourceDiagnostics(undefined)).toEqual([]);
    expect(
      sanitizeSubSourceDiagnostics([
        buildSubSourceDiagnostic({ storeChain: '', sourceId: 'x', status: 'success' }),
        buildSubSourceDiagnostic({ storeChain: 'Lidl', sourceId: 'ok', status: 'success' }),
      ]),
    ).toHaveLength(1);
  });

  it('rendert eine strukturierte Markdown-Tabelle ohne Freitextwarnung', () => {
    const md = renderSubSourceBalanceMarkdown([
      {
        storeChain: 'lidl',
        sourceId: 'lidl:aktionsprospekt-22-06-2026',
        urlOrSlug: 'aktionsprospekt-22-06-2026',
        expectedValidityStart: '2026-06-22T00:00:00.000Z',
        expectedValidityEnd: '2026-06-27T23:59:59.000Z',
        status: 'fetch_failed',
        rawCount: 0,
        resultCount: 0,
        errorCode: 'leaflet_fetch_failed',
        previousCount: 20,
        candidateCount: 0,
        lossCount: 20,
        lossRate: 1,
        gateDecision: 'blocked',
        gateReason: 'lidl/lidl:aktionsprospekt-22-06-2026: 20→0 (fetch_failed)',
      },
    ]);
    expect(md).toContain('Subquellen-/Prospektbilanz');
    expect(md).toContain('lidl:aktionsprospekt-22-06-2026');
    expect(md).toContain('🔴 blocked');
    expect(md).toContain('leaflet_fetch_failed');
  });

  it('rendert die Diagnose-Note (OCR primaryReason) unter der Tabelle, nicht null', () => {
    const md = renderSubSourceBalanceMarkdown([
      {
        storeChain: 'lidl',
        sourceId: 'lidl:aktionsprospekt-15-06-2026:prospektseiten:ocr',
        status: 'empty',
        rawCount: 0,
        resultCount: 0,
        note: 'OCR diagnostic | Kette: 9 → 0 … Ursache: keine ladbaren CDN-Bild-URLs.',
        previousCount: 0,
        candidateCount: 0,
        lossCount: 0,
        lossRate: 0,
        gateDecision: 'committed',
      },
    ]);
    expect(md).toContain('Subquellen-Notizen');
    expect(md).toContain('Ursache: keine ladbaren CDN-Bild-URLs');
  });

  it('ohne Note → kein Notizen-Abschnitt', () => {
    const md = renderSubSourceBalanceMarkdown([
      {
        storeChain: 'lidl',
        sourceId: 'lidl:cur',
        status: 'success',
        previousCount: 5,
        candidateCount: 5,
        lossCount: 0,
        lossRate: 0,
        gateDecision: 'committed',
      },
    ]);
    expect(md).not.toContain('Subquellen-Notizen');
  });

  it('leere Bilanz → kein Abschnitt', () => {
    expect(renderSubSourceBalanceMarkdown([])).toBe('');
  });
});
