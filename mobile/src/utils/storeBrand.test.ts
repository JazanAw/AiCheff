import { describe, expect, it } from 'vitest';

import { buildStoreFilters, dealMatchesStore, normalizeStoreBrand } from './storeBrand';

describe('normalizeStoreBrand', () => {
  it('maps known chains with varying suffixes/casing to a stable key + label', () => {
    expect(normalizeStoreBrand('REWE')).toEqual({ key: 'rewe', label: 'REWE' });
    expect(normalizeStoreBrand('REWE Markt GmbH')).toEqual({ key: 'rewe', label: 'REWE' });
    expect(normalizeStoreBrand('rewe city')).toEqual({ key: 'rewe', label: 'REWE' });
    expect(normalizeStoreBrand('Lidl')).toEqual({ key: 'lidl', label: 'Lidl' });
    expect(normalizeStoreBrand('ALDI SÜD')).toEqual({ key: 'aldi', label: 'Aldi' });
    expect(normalizeStoreBrand('EDEKA Müller')).toEqual({ key: 'edeka', label: 'Edeka' });
    expect(normalizeStoreBrand('Netto Marken-Discount')).toEqual({ key: 'netto', label: 'Netto' });
    expect(normalizeStoreBrand('PENNY')).toEqual({ key: 'penny', label: 'Penny' });
    expect(normalizeStoreBrand('Kaufland')).toEqual({ key: 'kaufland', label: 'Kaufland' });
  });

  it('matches "dm" only as a standalone token, never inside other words', () => {
    expect(normalizeStoreBrand('dm')).toEqual({ key: 'dm', label: 'dm' });
    expect(normalizeStoreBrand('dm-drogerie markt')).toEqual({ key: 'dm', label: 'dm' });
    // "Admiral" contains the substring "dm" but must NOT be grouped as dm.
    expect(normalizeStoreBrand('Feinkost Admiral').key).not.toBe('dm');
  });

  it('keeps unknown chains under a normalized key with a shortened original label', () => {
    const a = normalizeStoreBrand('Tante Emma Laden');
    const b = normalizeStoreBrand('TANTE EMMA LADEN');
    expect(a.label).toBe('Tante Emma Laden');
    // Case-insensitive grouping: both variants share one key.
    expect(a.key).toBe(b.key);
    expect(a.key.startsWith('raw:')).toBe(true);
  });

  it('truncates very long unknown names', () => {
    const { label } = normalizeStoreBrand('Supermarkt mit sehr langem Namen');
    expect(label.endsWith('…')).toBe(true);
    expect(label.length).toBeLessThanOrEqual(18);
  });

  it('does not crash on empty / missing store names', () => {
    expect(normalizeStoreBrand(undefined)).toEqual({ key: '__none__', label: '' });
    expect(normalizeStoreBrand(null)).toEqual({ key: '__none__', label: '' });
    expect(normalizeStoreBrand('   ')).toEqual({ key: '__none__', label: '' });
  });
});

describe('dealMatchesStore', () => {
  it('matches deals by brand key, tolerating missing names', () => {
    expect(dealMatchesStore('REWE Markt GmbH', 'rewe')).toBe(true);
    expect(dealMatchesStore('Lidl', 'rewe')).toBe(false);
    expect(dealMatchesStore(undefined, 'rewe')).toBe(false);
  });
});

describe('buildStoreFilters', () => {
  it('groups variants, counts them, and sorts by count desc then label', () => {
    const deals = [
      { storeName: 'REWE' },
      { storeName: 'REWE Markt GmbH' },
      { storeName: 'rewe city' },
      { storeName: 'Lidl' },
      { storeName: 'Lidl' },
      { storeName: 'ALDI SÜD' },
    ];
    const result = buildStoreFilters(deals);
    expect(result).toEqual([
      { key: 'rewe', label: 'REWE', count: 3 },
      { key: 'lidl', label: 'Lidl', count: 2 },
      { key: 'aldi', label: 'Aldi', count: 1 },
    ]);
  });

  it('skips deals without a store name (no crash, no empty chip)', () => {
    const result = buildStoreFilters([
      { storeName: 'REWE' },
      { storeName: '' },
      { storeName: undefined },
      {},
    ]);
    expect(result).toEqual([{ key: 'rewe', label: 'REWE', count: 1 }]);
  });

  it('prefers the most frequent original label for unknown chains', () => {
    const result = buildStoreFilters([
      { storeName: 'Bio Markt' },
      { storeName: 'Bio Markt' },
      { storeName: 'bio markt' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].count).toBe(3);
    expect(result[0].label).toBe('Bio Markt');
  });
});
