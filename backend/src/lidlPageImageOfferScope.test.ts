import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  LIDL_PAGE_IMAGE_SCOPE_TAG,
  isLidlPageImageScopeOffer,
  replaceLidlPageImageScopeOffers,
} from './lidlPageImageOfferScope';

const at = new Date('2026-07-22T10:00:00Z');

function lidlPageImageOffer(id: string, name: string, extraTags: string[] = []): Offer {
  return {
    id,
    name,
    normalizedName: name.toLowerCase(),
    storeChain: 'Lidl',
    category: 'Sonstiges',
    price: 1.99,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: at.toISOString(),
    validityEnd: at.toISOString(),
    sourceUrl: 'https://www.lidl.de/x',
    tags: [LIDL_PAGE_IMAGE_SCOPE_TAG, ...extraTags],
    createdAt: at.toISOString(),
  } as Offer;
}

function lidlStructuredOffer(id: string, name: string): Offer {
  return { ...lidlPageImageOffer(id, name), tags: ['lidl-prospekt'] } as Offer;
}

function otherStoreOffer(id: string, store: string): Offer {
  return { ...lidlPageImageOffer(id, `${store} Produkt`), storeChain: store, tags: [store.toLowerCase()] } as Offer;
}

describe('isLidlPageImageScopeOffer', () => {
  it('is true only for Lidl offers carrying the page-image scope tag', () => {
    expect(isLidlPageImageScopeOffer(lidlPageImageOffer('a', 'Erdbeeren'))).toBe(true);
  });
  it('is false for the already-working structured lidl-prospekt offers', () => {
    expect(isLidlPageImageScopeOffer(lidlStructuredOffer('b', 'Wein'))).toBe(false);
  });
  it('is false for other stores even with the same tag', () => {
    expect(isLidlPageImageScopeOffer({ storeChain: 'ALDI NORD', tags: [LIDL_PAGE_IMAGE_SCOPE_TAG] })).toBe(false);
  });
  it('is false for Lidl offers without any tags', () => {
    expect(isLidlPageImageScopeOffer({ storeChain: 'Lidl', tags: [] })).toBe(false);
  });
});

describe('replaceLidlPageImageScopeOffers', () => {
  it('replaces the whole page-image scope, leaves structured Lidl + other stores untouched', () => {
    const previous = {
      current: [lidlPageImageOffer('old1', 'Alt Bildseite 1'), lidlStructuredOffer('struct1', 'Wein')],
      nextWeek: [lidlPageImageOffer('old2', 'Alt Bildseite next')],
      filtered: [lidlPageImageOffer('old3', 'Alt gefiltert'), otherStoreOffer('penny1', 'PENNY')],
    };
    const incoming = {
      current: [lidlPageImageOffer('new1', 'Neu Bildseite 1')],
      nextWeek: [],
      filtered: [lidlPageImageOffer('new2', 'Neu gefiltert')],
    };
    const result = replaceLidlPageImageScopeOffers(previous, incoming);

    expect(result.current.map((o) => o.id)).toEqual(['struct1', 'new1']);
    expect(result.nextWeek.map((o) => o.id)).toEqual([]);
    expect(result.filtered.map((o) => o.id)).toEqual(['penny1', 'new2']);
    expect(result.replacedPreviousCount).toEqual({ current: 1, nextWeek: 1, filtered: 1, total: 3 });
    expect(result.current.some((o) => o.id === 'struct1')).toBe(true);
    expect(result.filtered.some((o) => o.id === 'penny1')).toBe(true);
  });

  it('is pure (does not mutate the previous arrays)', () => {
    const previous = { current: [lidlPageImageOffer('old1', 'Alt')], nextWeek: [], filtered: [] };
    const idsBefore = previous.current.map((o) => o.id);
    replaceLidlPageImageScopeOffers(previous, { current: [lidlPageImageOffer('new', 'Neu')], nextWeek: [], filtered: [] });
    expect(previous.current.map((o) => o.id)).toEqual(idsBefore);
  });

  it('a repeated identical run stays idempotent (no stale duplicates)', () => {
    const incoming = {
      current: [lidlPageImageOffer('a', 'Erdbeeren'), lidlPageImageOffer('b', 'Bananen')],
      nextWeek: [],
      filtered: [],
    };
    const first = replaceLidlPageImageScopeOffers({ current: [], nextWeek: [], filtered: [] }, incoming);
    const second = replaceLidlPageImageScopeOffers(
      { current: first.current, nextWeek: first.nextWeek, filtered: first.filtered },
      incoming,
    );
    expect(second.current.map((o) => o.id)).toEqual(['a', 'b']);
    expect(second.replacedPreviousCount.current).toBe(2);
  });
});
