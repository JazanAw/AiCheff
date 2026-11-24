import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  PHASE2_RECHECK_TAG,
  isPhase2Recheck,
  selectUncertainFilteredForPhase2,
  stripPhase2RecheckTag,
} from './offersScanV2';

// Phase-2-Kandidatenauswahl aus dem Filtered-Bucket. Produktnamen sind Fixtures.

function offer(overrides: Partial<Offer> & { id: string; name: string }): Offer {
  return {
    normalizedName: overrides.name.toLowerCase(),
    storeChain: 'REWE',
    category: '',
    price: 1.99,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: '2026-06-08T00:00:00.000Z',
    validityEnd: '2026-06-13T23:59:59.000Z',
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-06-08T00:00:00.000Z',
    ...overrides,
  } as Offer;
}

describe('selectUncertainFilteredForPhase2', () => {
  it('Test 7: nimmt uncertain-filtered als Kandidaten auf (mit Recheck-Tag)', () => {
    const result = selectUncertainFilteredForPhase2([
      offer({ id: 'u1', name: 'Celebrations' }),
      offer({ id: 'u2', name: 'Rama' }),
    ]);
    expect(result.candidates.map((o) => o.id).sort()).toEqual(['u1', 'u2']);
    expect(result.candidates.every(isPhase2Recheck)).toBe(true);
    expect(result.skipped).toHaveLength(0);
  });

  it('Test 8: regelbestätigtes Non-Food wird NICHT an die KI gesendet (skipped)', () => {
    const result = selectUncertainFilteredForPhase2([
      offer({ id: 'nf1', name: 'Damen BH-Top' }),
      offer({ id: 'nf2', name: 'Pizzamaker' }),
      offer({ id: 'nf3', name: 'Ziersalbei' }),
      offer({ id: 'nf4', name: 'Irgendwas', tags: ['nonfood'] }),
    ]);
    expect(result.candidates).toHaveLength(0);
    expect(result.skipped.map((o) => o.id).sort()).toEqual(['nf1', 'nf2', 'nf3', 'nf4']);
  });

  it('Fragmente und gesperrte/manuell entschiedene Angebote werden nie gesendet', () => {
    const result = selectUncertainFilteredForPhase2([
      offer({ id: 'frag', name: 'Tiefpreis' }),
      offer({ id: 'lock', name: 'Celebrations', ...({ manualReviewed: true } as Partial<Offer>) }),
      offer({ id: 'ok', name: 'Celebrations' }),
    ]);
    expect(result.candidates.map((o) => o.id)).toEqual(['ok']);
    expect(result.skipped.map((o) => o.id).sort()).toEqual(['frag', 'lock']);
  });

  it('confirmed_food im Filter geht nicht an die KI (rettet der Reconciliation-Pass)', () => {
    const result = selectUncertainFilteredForPhase2([
      offer({ id: 'f1', name: 'Steinofen-Pizza Salami' }),
    ]);
    expect(result.candidates).toHaveLength(0);
    expect(result.skipped.map((o) => o.id)).toEqual(['f1']);
  });

  it('stripPhase2RecheckTag entfernt den transienten Tag wieder', () => {
    const tagged = selectUncertainFilteredForPhase2([offer({ id: 'u1', name: 'Celebrations' })])
      .candidates[0];
    expect(tagged.tags).toContain(PHASE2_RECHECK_TAG);
    const stripped = stripPhase2RecheckTag(tagged);
    expect(stripped.tags).not.toContain(PHASE2_RECHECK_TAG);
    expect(isPhase2Recheck(stripped)).toBe(false);
  });
});
