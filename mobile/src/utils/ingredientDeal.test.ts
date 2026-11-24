import { describe, expect, it } from 'vitest';
import type { RecipeIngredient } from '../types';
import {
  buildIngredientDealShoppingItem,
  countValidRecipeDeals,
  ingredientHasConcreteDeal,
  isIngredientDealFuture,
} from './ingredientDeal';

function ing(overrides: Partial<RecipeIngredient> = {}): RecipeIngredient {
  return {
    id: 'i1',
    name: 'Hackfleisch',
    amount: 500,
    unit: 'g',
    isDeal: false,
    ...overrides,
  };
}

describe('ingredientHasConcreteDeal', () => {
  it('is true when a dealId is paired with a deal name', () => {
    expect(ingredientHasConcreteDeal(ing({ dealId: 'd1', dealName: 'Gut & Günstig Hack' }))).toBe(true);
  });

  it('is true when a dealId is paired with a price', () => {
    expect(ingredientHasConcreteDeal(ing({ dealId: 'd1', dealPrice: 3.49 }))).toBe(true);
  });

  it('is true when a dealId is paired with a store name', () => {
    expect(ingredientHasConcreteDeal(ing({ dealId: 'd1', dealStoreName: 'Lidl' }))).toBe(true);
  });

  it('is false when only isDeal is set (no concrete deal data)', () => {
    expect(ingredientHasConcreteDeal(ing({ isDeal: true }))).toBe(false);
  });

  it('is false when a dealId exists but carries no name/price/store', () => {
    expect(ingredientHasConcreteDeal(ing({ dealId: 'd1' }))).toBe(false);
  });

  it('is false for a plain ingredient', () => {
    expect(ingredientHasConcreteDeal(ing())).toBe(false);
  });
});

describe('buildIngredientDealShoppingItem', () => {
  it('prefers the deal product name over the ingredient name', () => {
    const item = buildIngredientDealShoppingItem(
      ing({ dealId: 'd1', dealName: 'Gut & Günstig Hack', dealPrice: 3.49, dealStoreName: 'Lidl' }),
      'r1',
    );
    expect(item.name).toBe('Gut & Günstig Hack');
  });

  it('falls back to the ingredient name when the deal has no name', () => {
    const item = buildIngredientDealShoppingItem(ing({ dealId: 'd1', dealPrice: 3.49 }), 'r1');
    expect(item.name).toBe('Hackfleisch');
  });

  it('carries the recipe quantity, unit, store, price, dealId and recipeId', () => {
    const item = buildIngredientDealShoppingItem(
      ing({ amount: 500, unit: 'g', dealId: 'd1', dealName: 'Hack', dealPrice: 3.49, dealStoreName: 'Lidl' }),
      'recipe-9',
    );
    expect(item).toMatchObject({
      quantity: 500,
      unit: 'g',
      storeName: 'Lidl',
      price: 3.49,
      dealId: 'd1',
      recipeId: 'recipe-9',
      isManual: false,
    });
  });

  it('falls back to quantity 1 when the recipe amount is missing or zero', () => {
    const item = buildIngredientDealShoppingItem(ing({ amount: 0, dealId: 'd1', dealName: 'Salz' }), 'r1');
    expect(item.quantity).toBe(1);
  });
});

describe('isIngredientDealFuture', () => {
  const NOW = new Date('2026-06-09T12:00:00');

  it('is true for a concrete deal whose validFrom is after today (nextWeek)', () => {
    expect(
      isIngredientDealFuture(ing({ dealId: 'd1', dealName: 'Hack', dealValidFrom: '2026-06-16' }), NOW),
    ).toBe(true);
  });

  it('is false for a concrete deal that has already started', () => {
    expect(
      isIngredientDealFuture(ing({ dealId: 'd1', dealName: 'Hack', dealValidFrom: '2026-06-08' }), NOW),
    ).toBe(false);
  });

  it('treats a deal starting today as already live (start of day)', () => {
    expect(
      isIngredientDealFuture(ing({ dealId: 'd1', dealName: 'Hack', dealValidFrom: '2026-06-09' }), NOW),
    ).toBe(false);
  });

  it('never claims future when no start date is known', () => {
    expect(isIngredientDealFuture(ing({ dealId: 'd1', dealName: 'Hack' }), NOW)).toBe(false);
  });

  it('is false for a non-concrete deal (bare isDeal flag)', () => {
    expect(isIngredientDealFuture(ing({ isDeal: true, dealValidFrom: '2026-06-16' }), NOW)).toBe(false);
  });
});

describe('countValidRecipeDeals', () => {
  const NOW = new Date('2026-06-09T12:00:00Z');

  it('counts an ingredient on a valid, concrete deal', () => {
    const n = countValidRecipeDeals(
      { ingredients: [ing({ dealId: 'd1', dealName: 'Hack', dealValidTo: '2026-06-15' })] },
      NOW,
    );
    expect(n).toBe(1);
  });

  it('ignores a future (nextWeek) concrete deal', () => {
    const n = countValidRecipeDeals(
      {
        ingredients: [
          ing({
            dealId: 'd1',
            dealName: 'Hack',
            dealValidFrom: '2026-06-16',
            dealValidTo: '2026-06-22',
          }),
        ],
      },
      NOW,
    );
    expect(n).toBe(0);
  });

  it('ignores a bare isDeal flag with no concrete data', () => {
    const n = countValidRecipeDeals({ ingredients: [ing({ isDeal: true })] }, NOW);
    expect(n).toBe(0);
  });

  it('ignores an expired concrete deal', () => {
    const n = countValidRecipeDeals(
      { ingredients: [ing({ dealId: 'd1', dealName: 'Hack', dealValidTo: '2026-06-01' })] },
      NOW,
    );
    expect(n).toBe(0);
  });

  it('counts only the valid concrete deals among mixed ingredients', () => {
    const n = countValidRecipeDeals(
      {
        ingredients: [
          ing({ dealId: 'd1', dealPrice: 2, dealValidTo: '2026-06-15' }), // valid
          ing({ isDeal: true }), // bare → no
          ing({ dealId: 'd2', dealName: 'X', dealValidTo: '2026-06-01' }), // expired → no
          ing(), // plain → no
        ],
      },
      NOW,
    );
    expect(n).toBe(1);
  });
});
