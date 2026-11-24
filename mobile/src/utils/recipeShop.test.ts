import { describe, expect, it } from 'vitest';
import type { PantryItem, RecipeIngredient } from '../types';
import {
  classifyDetailIngredient,
  isIngredientDealExpired,
  isIngredientDealValid,
  scaleIngredientAmount,
  selectRecipeOffers,
  summarizeRecipeShop,
} from './recipeShop';

const NOW = new Date('2026-06-09T12:00:00');

function ing(overrides: Partial<RecipeIngredient> = {}): RecipeIngredient {
  return {
    id: overrides.id ?? 'i1',
    name: 'Hähnchenbrust',
    amount: 500,
    unit: 'g',
    isDeal: false,
    ...overrides,
  };
}

function pantry(overrides: Partial<PantryItem> = {}): PantryItem {
  return {
    id: 'p1',
    name: 'Reis',
    quantity: 500,
    unit: 'g',
    source: 'manual',
    addedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

// A concrete deal valid through 14 Jun.
const VALID_DEAL: Partial<RecipeIngredient> = {
  dealId: 'd1',
  dealName: 'Hähnchenbrust-Filet 500 g',
  dealPrice: 2.99,
  dealOriginalPrice: 4.49,
  discountPercent: 33,
  dealStoreName: 'REWE',
  dealValidTo: '2026-06-14',
  isDeal: true,
};

// A concrete deal that only starts next week (validFrom after NOW) — upcoming,
// not live yet.
const FUTURE_DEAL: Partial<RecipeIngredient> = {
  ...VALID_DEAL,
  dealValidFrom: '2026-06-16',
  dealValidTo: '2026-06-22',
};

describe('isIngredientDealExpired', () => {
  it('is false for a concrete deal still within its validity', () => {
    expect(isIngredientDealExpired(ing(VALID_DEAL), NOW)).toBe(false);
  });

  it('is true for a concrete deal whose validTo is in the past', () => {
    expect(isIngredientDealExpired(ing({ ...VALID_DEAL, dealValidTo: '2026-06-01' }), NOW)).toBe(true);
  });

  it('treats the whole validTo day as valid (not expired on the last day)', () => {
    expect(isIngredientDealExpired(ing({ ...VALID_DEAL, dealValidTo: '2026-06-09' }), NOW)).toBe(false);
  });

  it('never claims expiry when no end date is known', () => {
    expect(isIngredientDealExpired(ing({ ...VALID_DEAL, dealValidTo: undefined }), NOW)).toBe(false);
  });

  it('is false for a non-concrete deal (bare isDeal flag)', () => {
    expect(isIngredientDealExpired(ing({ isDeal: true, dealValidTo: '2026-06-01' }), NOW)).toBe(false);
  });
});

describe('isIngredientDealValid', () => {
  it('is true for a concrete, unexpired deal', () => {
    expect(isIngredientDealValid(ing(VALID_DEAL), NOW)).toBe(true);
  });

  it('is false once the deal has expired', () => {
    expect(isIngredientDealValid(ing({ ...VALID_DEAL, dealValidTo: '2026-06-01' }), NOW)).toBe(false);
  });

  it('is false for a bare isDeal flag with no concrete data', () => {
    expect(isIngredientDealValid(ing({ isDeal: true }), NOW)).toBe(false);
  });

  it('is false for a future (nextWeek) deal that has not started yet', () => {
    expect(isIngredientDealValid(ing(FUTURE_DEAL), NOW)).toBe(false);
  });
});

describe('classifyDetailIngredient', () => {
  it('marks a name+amount pantry match as pantry (wins over a deal)', () => {
    const onHand = [pantry({ name: 'Hähnchenbrust', quantity: 800, unit: 'g' })];
    expect(classifyDetailIngredient(ing(VALID_DEAL), onHand, NOW)).toBe('pantry');
  });

  it('marks a name match with non-comparable unit as unclear', () => {
    const onHand = [pantry({ name: 'Hähnchenbrust', quantity: 1, unit: 'Packung' })];
    expect(classifyDetailIngredient(ing({ amount: 500, unit: 'g' }), onHand, NOW)).toBe('unclear');
  });

  it('marks a not-owned, valid concrete deal as deal', () => {
    expect(classifyDetailIngredient(ing(VALID_DEAL), [], NOW)).toBe('deal');
  });

  it('demotes an expired deal to missing', () => {
    expect(classifyDetailIngredient(ing({ ...VALID_DEAL, dealValidTo: '2026-06-01' }), [], NOW)).toBe('missing');
  });

  it('demotes a future (nextWeek) deal to missing — not a current offer', () => {
    expect(classifyDetailIngredient(ing(FUTURE_DEAL), [], NOW)).toBe('missing');
  });

  it('treats a bare isDeal flag without concrete data as missing', () => {
    expect(classifyDetailIngredient(ing({ isDeal: true }), [], NOW)).toBe('missing');
  });

  it('marks a plain, not-owned ingredient as missing', () => {
    expect(classifyDetailIngredient(ing({ name: 'Ingwer', amount: 20, unit: 'g' }), [], NOW)).toBe('missing');
  });
});

describe('selectRecipeOffers', () => {
  it('returns only valid, not-owned concrete deals, in order', () => {
    const ingredients = [
      ing({ id: 'a', name: 'Hähnchenbrust', ...VALID_DEAL }),
      ing({ id: 'b', name: 'Reis', isDeal: false }),
      ing({ id: 'c', name: 'Paprika', dealId: 'd2', dealName: 'Paprika', dealPrice: 0.79, dealValidTo: '2026-06-15', isDeal: true }),
      ing({ id: 'd', name: 'Zwiebel', ...VALID_DEAL, dealValidTo: '2026-06-01' }), // expired
      ing({ id: 'e', name: 'Lachs', ...FUTURE_DEAL }), // future (nextWeek) → excluded
    ];
    const offers = selectRecipeOffers(ingredients, [], NOW);
    expect(offers.map((o) => o.id)).toEqual(['a', 'c']);
  });
});

describe('summarizeRecipeShop', () => {
  const ingredients = [
    ing({ id: 'a', name: 'Hähnchenbrust', ...VALID_DEAL }), // deal, 2.99
    ing({ id: 'b', name: 'Reis', amount: 250, unit: 'g' }), // pantry (matched below)
    ing({ id: 'c', name: 'Ingwer', amount: 20, unit: 'g' }), // missing, no price
    ing({ id: 'd', name: 'Sesamöl', amount: 50, unit: 'ml' }), // unclear: matched but ml vs Flasche
    ing({ id: 'e', name: 'Zwiebel', ...VALID_DEAL, dealId: 'd9', dealValidTo: '2026-06-01' }), // expired -> missing
  ];
  const onHand = [
    pantry({ id: 'r', name: 'Reis', quantity: 1000, unit: 'g' }),
    pantry({ id: 's', name: 'Sesamöl', quantity: 1, unit: 'Flasche' }),
  ];

  it('counts each status bucket exactly once', () => {
    const s = summarizeRecipeShop(ingredients, onHand, { portions: 4, baseServings: 4, now: NOW });
    expect(s.pantry).toBe(1);
    expect(s.deal).toBe(1);
    expect(s.unclear).toBe(1);
    expect(s.missing).toBe(2); // Ingwer + expired Zwiebel
    expect(s.pantry + s.deal + s.unclear + s.missing).toBe(ingredients.length);
  });

  it('sums only known deal prices and flags expired deals', () => {
    const s = summarizeRecipeShop(ingredients, onHand, { portions: 4, baseServings: 4, now: NOW });
    expect(s.estimatedCost).toBe(2.99);
    expect(s.hasExpiredDeals).toBe(true);
  });

  it('scales the cost with the portion factor', () => {
    const s = summarizeRecipeShop(ingredients, onHand, { portions: 8, baseServings: 4, now: NOW });
    expect(s.factor).toBe(2);
    expect(s.estimatedCost).toBe(5.98);
  });

  it('reports undefined cost (never a fabricated 0) when no deal price is known', () => {
    const s = summarizeRecipeShop(
      [ing({ id: 'x', name: 'Ingwer', amount: 20, unit: 'g' })],
      [],
      { portions: 4, baseServings: 4, now: NOW },
    );
    expect(s.estimatedCost).toBeUndefined();
    expect(s.missing).toBe(1);
  });
});

describe('scaleIngredientAmount', () => {
  it('keeps amounts unchanged at factor 1', () => {
    expect(scaleIngredientAmount(500, 1)).toBe(500);
  });

  it('snaps large (g/ml) amounts to the nearest 5', () => {
    expect(scaleIngredientAmount(250, 1.5)).toBe(375);
    expect(scaleIngredientAmount(200, 0.5)).toBe(100);
  });

  it('snaps small counts to the nearest 0.5', () => {
    expect(scaleIngredientAmount(2, 1.5)).toBe(3);
    expect(scaleIngredientAmount(1, 0.5)).toBe(0.5);
    expect(scaleIngredientAmount(3, 0.5)).toBe(1.5);
  });

  it('returns null for non-positive amounts (e.g. "Salz nach Geschmack")', () => {
    expect(scaleIngredientAmount(0, 2)).toBeNull();
    expect(scaleIngredientAmount(Number.NaN, 2)).toBeNull();
  });
});
