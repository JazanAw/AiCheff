import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  listStoreChains,
  mergeScopedRescan,
  normalizeStoreChains,
  offerMatchesStoreChains,
  partitionOffersForScope,
  type SnapshotBuckets,
} from './offerAiRescanScope';

function offer(id: string, storeChain: string): Offer {
  return {
    id,
    name: `Offer ${id}`,
    normalizedName: `offer ${id}`,
    storeChain,
    category: 'food',
    price: 1,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: '2026-06-01',
    validityEnd: '2026-06-07',
    sourceUrl: 'https://example.test',
    tags: [],
    createdAt: '2026-06-01T00:00:00.000Z',
  };
}

describe('normalizeStoreChains', () => {
  it('returns [] (=all) for empty / absent / non-array input', () => {
    expect(normalizeStoreChains(undefined)).toEqual([]);
    expect(normalizeStoreChains(null)).toEqual([]);
    expect(normalizeStoreChains([])).toEqual([]);
    expect(normalizeStoreChains('REWE' as unknown as string[])).toEqual([]);
  });

  it('trims, lowercases and dedupes', () => {
    expect(normalizeStoreChains([' REWE ', 'rewe', 'Lidl', '', '   '])).toEqual([
      'rewe',
      'lidl',
    ]);
  });
});

describe('offerMatchesStoreChains', () => {
  it('matches case-insensitively and trim-normalised', () => {
    expect(offerMatchesStoreChains(offer('a', '  ReWe '), ['rewe'])).toBe(true);
    expect(offerMatchesStoreChains(offer('b', 'Lidl'), ['rewe'])).toBe(false);
  });

  it('treats an empty scope as "all stores"', () => {
    expect(offerMatchesStoreChains(offer('a', 'REWE'), [])).toBe(true);
  });
});

describe('partitionOffersForScope', () => {
  const buckets: SnapshotBuckets = {
    current: [offer('r1', 'REWE'), offer('l1', 'Lidl')],
    next: [offer('r2', 'REWE'), offer('a1', 'ALDI NORD')],
    filtered: [offer('r3', 'REWE'), offer('k1', 'Kaufland')],
  };

  it('selects only the chosen chain across all buckets', () => {
    const { selected, retained } = partitionOffersForScope(buckets, ['rewe']);
    expect(selected.map((o) => o.id).sort()).toEqual(['r1', 'r2', 'r3']);
    // Unselected stores stay in their original bucket — never selected.
    expect(retained.current.map((o) => o.id)).toEqual(['l1']);
    expect(retained.next.map((o) => o.id)).toEqual(['a1']);
    expect(retained.filtered.map((o) => o.id)).toEqual(['k1']);
  });

  it('supports multiple chains', () => {
    const { selected, retained } = partitionOffersForScope(buckets, ['rewe', 'lidl']);
    expect(selected.map((o) => o.id).sort()).toEqual(['l1', 'r1', 'r2', 'r3']);
    expect(retained.current).toEqual([]);
    expect(retained.next.map((o) => o.id)).toEqual(['a1']);
    expect(retained.filtered.map((o) => o.id)).toEqual(['k1']);
  });

  it('with an empty scope selects everything and retains nothing (= all)', () => {
    const { selected, retained } = partitionOffersForScope(buckets, []);
    expect(selected).toHaveLength(6);
    expect(retained.current).toEqual([]);
    expect(retained.next).toEqual([]);
    expect(retained.filtered).toEqual([]);
  });
});

describe('mergeScopedRescan', () => {
  it('preserves retained offers and folds in re-categorized selected offers', () => {
    const retained: SnapshotBuckets = {
      current: [offer('l1', 'Lidl')],
      next: [offer('a1', 'ALDI NORD')],
      filtered: [offer('k1', 'Kaufland')],
    };
    // After re-categorisation: a filtered REWE offer became food (→ current),
    // and a live REWE offer became non-food (→ filtered).
    const recategorized: SnapshotBuckets = {
      current: [offer('r1', 'REWE'), offer('r3', 'REWE')],
      next: [offer('r2', 'REWE')],
      filtered: [offer('r4', 'REWE')],
    };

    const merged = mergeScopedRescan(retained, recategorized);

    // Unselected stores survive untouched.
    expect(merged.current.map((o) => o.id)).toContain('l1');
    expect(merged.next.map((o) => o.id)).toContain('a1');
    expect(merged.filtered.map((o) => o.id)).toContain('k1');
    // Re-categorized REWE offers land in their new buckets.
    expect(merged.current.map((o) => o.id).sort()).toEqual(['l1', 'r1', 'r3']);
    expect(merged.next.map((o) => o.id).sort()).toEqual(['a1', 'r2']);
    expect(merged.filtered.map((o) => o.id).sort()).toEqual(['k1', 'r4']);
  });

  it('dedupes by id', () => {
    const retained: SnapshotBuckets = { current: [offer('x', 'Lidl')], next: [], filtered: [] };
    const recategorized: SnapshotBuckets = { current: [offer('x', 'Lidl')], next: [], filtered: [] };
    expect(mergeScopedRescan(retained, recategorized).current).toHaveLength(1);
  });
});

describe('listStoreChains', () => {
  it('returns distinct chains in first-seen order', () => {
    expect(
      listStoreChains([offer('1', 'REWE'), offer('2', 'Lidl'), offer('3', 'rewe')]),
    ).toEqual(['REWE', 'Lidl']);
  });
});
