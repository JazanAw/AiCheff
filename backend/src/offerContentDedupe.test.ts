import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { dedupeOffersByContent, offerContentFingerprint } from './offerContentDedupe';

// P3 — inhaltliche Dedupe des „Auslese"-Falls. Konkrete Namen sind reine
// Reproduktions-Fixtures; die Dedupe ist rein strukturell, ohne Marken-Sonderregel.

function offer(name: string, extra: Partial<Offer> & Record<string, unknown> = {}): Offer {
  return {
    id: `id_${Math.random()}`,
    name,
    normalizedName: name.toLowerCase(),
    storeChain: 'NORMA',
    category: 'Sonstiges',
    price: 2.49,
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

describe('P3 — inhaltliche Angebots-Dedupe (Auslese)', () => {
  it('führt dasselbe Wochenangebot mit verschiedenen ids zusammen', () => {
    const a = offer('Auslese', { id: 'a1' });
    const b = offer('Auslese', { id: 'a2' }); // andere id, gleicher Inhalt
    const result = dedupeOffersByContent([a, b]);
    expect(result.offers).toHaveLength(1);
    expect(result.removedCount).toBe(1);
    expect(result.offers[0].id).toBe('a1'); // erstes Vorkommen gewinnt
  });

  it('hält UNTERSCHIEDLICHE echte Wochenangebote getrennt (andere Gültigkeit)', () => {
    const week1 = offer('Auslese', { id: 'a1' });
    const week2 = offer('Auslese', {
      id: 'a2',
      validityStart: '2026-06-22T00:00:00.000Z',
      validityEnd: '2026-06-27T23:59:59.000Z',
    });
    const result = dedupeOffersByContent([week1, week2]);
    expect(result.offers).toHaveLength(2);
    expect(result.removedCount).toBe(0);
  });

  it('hält Angebote mit anderem Preis getrennt', () => {
    const result = dedupeOffersByContent([
      offer('Auslese', { id: 'a1', price: 2.49 }),
      offer('Auslese', { id: 'a2', price: 1.99 }),
    ]);
    expect(result.offers).toHaveLength(2);
  });

  it('berücksichtigt die relevante Quelle im Fingerprint', () => {
    const a = offer('Auslese', { sourceCategoryRaw: 'Kaffee' } as Partial<Offer>);
    const b = offer('Auslese', { sourceCategoryRaw: 'Wein' } as Partial<Offer>);
    expect(offerContentFingerprint(a)).not.toBe(offerContentFingerprint(b));
    expect(dedupeOffersByContent([a, b]).offers).toHaveLength(2);
  });

  it('ist idempotent', () => {
    const offers = [offer('Auslese', { id: 'a1' }), offer('Auslese', { id: 'a2' })];
    const first = dedupeOffersByContent(offers);
    const second = dedupeOffersByContent(first.offers);
    expect(second.removedCount).toBe(0);
    expect(second.offers).toHaveLength(1);
  });

  it('verschiedene Shops bleiben getrennt (kein Cross-Shop-Merge)', () => {
    const result = dedupeOffersByContent([
      offer('Auslese', { storeChain: 'NORMA' }),
      offer('Auslese', { storeChain: 'ALDI NORD' }),
    ]);
    expect(result.offers).toHaveLength(2);
  });
});
