import { describe, expect, it } from 'vitest';
import type { PantryItem, Recipe, RecipeIngredient } from '../types';
import { recipeOfferInfo, rankRecipesWithOffers } from './offerRecipes';

// Fixed "now" so dealValidTo comparisons are deterministic.
const NOW = new Date('2026-06-08T12:00:00Z');
const VALID = '2026-06-30'; // after NOW
const EXPIRED = '2026-06-01'; // before NOW
const FUTURE_FROM = '2026-06-15'; // validFrom after NOW → nextWeek/upcoming

function ing(name: string, overrides: Partial<RecipeIngredient> = {}): RecipeIngredient {
  return { id: `i-${name}`, name, amount: 100, unit: 'g', isDeal: false, ...overrides };
}

function deal(
  name: string,
  opts: { price?: number; store?: string; validTo?: string; validFrom?: string } = {},
): RecipeIngredient {
  return ing(name, {
    isDeal: true,
    dealId: `d-${name}`,
    dealPrice: opts.price ?? 1.0,
    dealStoreName: opts.store,
    dealValidTo: opts.validTo ?? VALID,
    dealValidFrom: opts.validFrom,
  });
}

function pantry(name: string, overrides: Partial<PantryItem> = {}): PantryItem {
  return {
    id: `p-${name}`,
    name,
    quantity: 1,
    unit: '',
    source: 'manual',
    addedAt: '2026-05-20T00:00:00Z',
    ...overrides,
  };
}

function recipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: overrides.id ?? 'r1',
    name: 'Recipe',
    difficulty: 'easy',
    cookTimeMinutes: 25,
    servings: 2,
    mealType: 'lunch',
    ingredients: [ing('Tomaten'), ing('Spaghetti')],
    instructions: [],
    createdAt: '2026-01-01T00:00:00Z',
    sourceType: 'human_verified',
    verificationStatus: 'published',
    aiNoticeRequired: false,
    ...overrides,
  };
}

describe('recipeOfferInfo', () => {
  it('counts only valid (non-expired) deals as on-offer', () => {
    const r = recipe({
      ingredients: [
        deal('Tomaten', { validTo: VALID }),
        deal('Hack', { validTo: EXPIRED }),
        ing('Spaghetti'),
      ],
    });
    const info = recipeOfferInfo(r, [], NOW);
    expect(info.validDealCount).toBe(1);
    expect(info.hasExpiredDeals).toBe(true);
  });

  it('does NOT count a future (nextWeek) deal and does not flag it as expired', () => {
    const r = recipe({
      ingredients: [
        deal('Tomaten', { validTo: VALID }), // current
        deal('Lachs', { validFrom: FUTURE_FROM, validTo: '2026-06-22' }), // nextWeek
        ing('Spaghetti'),
      ],
    });
    const info = recipeOfferInfo(r, [], NOW);
    expect(info.validDealCount).toBe(1); // only the current deal
    expect(info.hasExpiredDeals).toBe(false); // future is not expired
    expect(info.stores).toEqual([]);
  });

  it('treats a deal without a valid-to date as still valid', () => {
    const r = recipe({
      ingredients: [deal('Tomaten', { validTo: undefined as unknown as string })],
    });
    const info = recipeOfferInfo(r, [], NOW);
    expect(info.validDealCount).toBe(1);
    expect(info.hasExpiredDeals).toBe(false);
  });

  it('counts missing ingredients pantry-aware and sums missing deal cost', () => {
    const r = recipe({
      ingredients: [
        deal('Tomaten', { price: 0.99 }), // missing → on deal → counted in cost
        deal('Zwiebel', { price: 0.5 }), // in pantry → not missing, not in cost
        ing('Spaghetti'), // missing, no deal
      ],
    });
    const info = recipeOfferInfo(r, [pantry('Zwiebel')], NOW);
    expect(info.missingCount).toBe(2); // Tomaten + Spaghetti
    expect(info.missingCost).toBeCloseTo(0.99, 2);
  });

  it('collects distinct store names of valid deals in order', () => {
    const r = recipe({
      ingredients: [
        deal('Tomaten', { store: 'Lidl' }),
        deal('Hack', { store: 'REWE' }),
        deal('Paprika', { store: 'Lidl' }),
        deal('Alt', { store: 'Aldi', validTo: EXPIRED }), // expired → not listed
      ],
    });
    const info = recipeOfferInfo(r, [], NOW);
    expect(info.stores).toEqual(['Lidl', 'REWE']);
  });

  it('leaves missingCost undefined when no missing ingredient has a deal price', () => {
    const r = recipe({ ingredients: [ing('Tomaten'), ing('Spaghetti')] });
    const info = recipeOfferInfo(r, [], NOW);
    expect(info.missingCost).toBeUndefined();
  });
});

// Honesty parity with the recipe-detail card: only a CONCRETE, currently-valid
// deal (real dealId + identifying detail) counts as "im Angebot". A bare
// `isDeal: true` flag carries no offer data and must never inflate the count.
describe('recipeOfferInfo — concrete-deal parity with the detail card', () => {
  it('does NOT count a bare isDeal flag (no concrete deal data) as an offer', () => {
    const r = recipe({
      ingredients: [
        ing('Tomaten', { isDeal: true }), // flag only: no dealId/price/store/name
        ing('Spaghetti'),
      ],
    });
    const info = recipeOfferInfo(r, [], NOW);
    expect(info.validDealCount).toBe(0);
    expect(info.hasExpiredDeals).toBe(false);
    expect(info.stores).toEqual([]);
  });

  it('counts a concrete valid deal as an offer', () => {
    const r = recipe({ ingredients: [deal('Tomaten'), ing('Spaghetti')] });
    const info = recipeOfferInfo(r, [], NOW);
    expect(info.validDealCount).toBe(1);
    expect(info.hasExpiredDeals).toBe(false);
  });

  it('does NOT count an expired concrete deal but sets hasExpiredDeals', () => {
    const r = recipe({ ingredients: [deal('Tomaten', { validTo: EXPIRED })] });
    const info = recipeOfferInfo(r, [], NOW);
    expect(info.validDealCount).toBe(0);
    expect(info.hasExpiredDeals).toBe(true);
  });

  it('lists store badges only for concrete valid deals, not bare isDeal flags', () => {
    const r = recipe({
      ingredients: [
        deal('Tomaten', { store: 'Lidl' }), // concrete valid → Lidl badge
        ing('Brot', { isDeal: true, dealStoreName: 'REWE' }), // bare flag → no badge
      ],
    });
    const info = recipeOfferInfo(r, [], NOW);
    expect(info.stores).toEqual(['Lidl']);
    expect(info.validDealCount).toBe(1);
  });

  it('does not bill a bare isDeal flag into missingCost', () => {
    const r = recipe({
      ingredients: [ing('Tomaten', { isDeal: true, dealPrice: 0.99 })], // no dealId → not concrete
    });
    const info = recipeOfferInfo(r, [], NOW);
    expect(info.missingCost).toBeUndefined();
  });
});

describe('rankRecipesWithOffers', () => {
  it('keeps only recipes that have at least one valid deal', () => {
    const withDeal = recipe({ id: 'a', ingredients: [deal('Tomaten')] });
    const noDeal = recipe({ id: 'b', ingredients: [ing('Tomaten')] });
    const expiredOnly = recipe({ id: 'c', ingredients: [deal('Tomaten', { validTo: EXPIRED })] });
    const ranked = rankRecipesWithOffers([withDeal, noDeal, expiredOnly], [], NOW);
    expect(ranked.map((x) => x.recipe.id)).toEqual(['a']);
  });

  it('drops a recipe whose only "deal" is a bare isDeal flag', () => {
    const concrete = recipe({ id: 'a', ingredients: [deal('Tomaten')] });
    const bareOnly = recipe({ id: 'b', ingredients: [ing('Tomaten', { isDeal: true })] });
    const ranked = rankRecipesWithOffers([concrete, bareOnly], [], NOW);
    expect(ranked.map((x) => x.recipe.id)).toEqual(['a']);
  });

  it('drops a recipe whose only "deal" is a future (nextWeek) offer', () => {
    const current = recipe({ id: 'a', ingredients: [deal('Tomaten')] });
    const futureOnly = recipe({
      id: 'b',
      ingredients: [deal('Lachs', { validFrom: FUTURE_FROM, validTo: '2026-06-22' })],
    });
    const ranked = rankRecipesWithOffers([current, futureOnly], [], NOW);
    expect(ranked.map((x) => x.recipe.id)).toEqual(['a']);
  });

  it('orders recipes with more ingredients on offer first', () => {
    const one = recipe({ id: 'one', ingredients: [deal('Tomaten'), ing('Spaghetti')] });
    const two = recipe({ id: 'two', ingredients: [deal('Tomaten'), deal('Hack')] });
    const ranked = rankRecipesWithOffers([one, two], [], NOW);
    expect(ranked.map((x) => x.recipe.id)).toEqual(['two', 'one']);
  });

  it('breaks ties on equal offers by fewer missing ingredients', () => {
    // both have 1 valid deal; "few" has fewer missing because of pantry.
    const few = recipe({ id: 'few', ingredients: [deal('Tomaten'), ing('Spaghetti')] });
    const many = recipe({
      id: 'many',
      ingredients: [deal('Tomaten'), ing('Spaghetti'), ing('Basilikum')],
    });
    const ranked = rankRecipesWithOffers([many, few], [pantry('Spaghetti')], NOW);
    expect(ranked.map((x) => x.recipe.id)).toEqual(['few', 'many']);
  });
});
