import { describe, expect, it } from 'vitest';
import type { PantryItem, Recipe, RecipeIngredient } from '../types';
import { buildWeeklyOfferPlan, pickDinnerDays } from './weeklyOfferPlanner';

const NOW = new Date('2026-06-08T12:00:00Z');
const VALID = '2026-06-30';
const EXPIRED = '2026-06-01';

function ing(name: string, overrides: Partial<RecipeIngredient> = {}): RecipeIngredient {
  return { id: `i-${name}`, name, amount: 100, unit: 'g', isDeal: false, ...overrides };
}

function deal(name: string, opts: { price?: number; store?: string; validTo?: string } = {}): RecipeIngredient {
  return ing(name, {
    isDeal: true,
    dealId: `d-${name}`,
    dealPrice: opts.price ?? 1.0,
    dealStoreName: opts.store,
    dealValidTo: opts.validTo ?? VALID,
  });
}

function pantry(name: string): PantryItem {
  return {
    id: `p-${name}`,
    name,
    quantity: 1,
    unit: '',
    source: 'manual',
    addedAt: '2026-05-20T00:00:00Z',
  };
}

let seq = 0;
function recipe(overrides: Partial<Recipe> = {}): Recipe {
  seq += 1;
  return {
    id: overrides.id ?? `r${seq}`,
    name: overrides.name ?? `Recipe ${seq}`,
    difficulty: 'easy',
    cookTimeMinutes: 25,
    servings: 2,
    mealType: 'dinner',
    ingredients: [ing('Tomaten'), ing('Spaghetti')],
    instructions: [],
    createdAt: '2026-01-01T00:00:00Z',
    sourceType: 'human_verified',
    verificationStatus: 'published',
    aiNoticeRequired: false,
    ...overrides,
  };
}

const baseOpts = {
  count: 5,
  usePantry: false,
  preferDeals: true,
  quickOnly: false,
  now: NOW,
};

function ids(result: ReturnType<typeof buildWeeklyOfferPlan>): string[] {
  return result.ok ? result.suggestions.map((s) => s.recipe.id) : [];
}

describe('buildWeeklyOfferPlan', () => {
  it('prefers recipes with more valid deal ingredients', () => {
    const oneDeal = recipe({ id: 'one', ingredients: [deal('Tomaten'), ing('Spaghetti')] });
    const twoDeals = recipe({ id: 'two', ingredients: [deal('Tomaten'), deal('Hack')] });
    const res = buildWeeklyOfferPlan({ ...baseOpts, recipes: [oneDeal, twoDeals], pantryItems: [] });
    expect(ids(res)).toEqual(['two', 'one']);
  });

  it('considers pantry coverage when usePantry is on', () => {
    // both have one valid deal; "covered" additionally has a pantry-stocked ingredient.
    const plain = recipe({ id: 'plain', ingredients: [deal('Tomaten'), ing('Spaghetti')] });
    const covered = recipe({ id: 'covered', ingredients: [deal('Tomaten'), ing('Reis')] });
    const res = buildWeeklyOfferPlan({
      ...baseOpts,
      usePantry: true,
      recipes: [plain, covered],
      pantryItems: [pantry('Reis')],
    });
    expect(ids(res)[0]).toBe('covered');
  });

  it('ignores pantry when usePantry is off (stable order, pantry gives no edge)', () => {
    const plain = recipe({ id: 'plain', ingredients: [deal('Tomaten'), ing('Spaghetti')] });
    const covered = recipe({ id: 'covered', ingredients: [deal('Tomaten'), ing('Reis')] });
    const res = buildWeeklyOfferPlan({
      ...baseOpts,
      usePantry: false,
      recipes: [plain, covered],
      pantryItems: [pantry('Reis')],
    });
    // Equal score (pantry ignored) → input order preserved.
    expect(ids(res)).toEqual(['plain', 'covered']);
  });

  it('avoids duplicate recipes', () => {
    const r = recipe({ id: 'dup', ingredients: [deal('Tomaten')] });
    const res = buildWeeklyOfferPlan({ ...baseOpts, recipes: [r, r], pantryItems: [] });
    expect(ids(res)).toEqual(['dup']);
  });

  it('excludes recipes already planned in the visible week', () => {
    const a = recipe({ id: 'a', ingredients: [deal('Tomaten')] });
    const b = recipe({ id: 'b', ingredients: [deal('Hack')] });
    const res = buildWeeklyOfferPlan({
      ...baseOpts,
      recipes: [a, b],
      pantryItems: [],
      plannedRecipeIds: new Set(['a']),
    });
    expect(ids(res)).toEqual(['b']);
  });

  it('varies cuisine across the suggestions', () => {
    const it1 = recipe({ id: 'it1', cuisine: 'italian', ingredients: [deal('Tomaten'), deal('Hack')] });
    const it2 = recipe({ id: 'it2', cuisine: 'italian', ingredients: [deal('Tomaten'), deal('Hack')] });
    const tr1 = recipe({ id: 'tr1', cuisine: 'turkish', ingredients: [deal('Tomaten')] });
    const res = buildWeeklyOfferPlan({
      ...baseOpts,
      count: 2,
      recipes: [it1, it2, tr1],
      pantryItems: [],
    });
    // Raw score favours the two italians, but variety pulls the turkish into #2.
    expect(ids(res)).toEqual(['it1', 'tr1']);
  });

  it('ignores expired deals (expired-only recipes are not good candidates)', () => {
    const valid = recipe({ id: 'valid', ingredients: [deal('Tomaten', { validTo: VALID })] });
    const expired = recipe({ id: 'expired', ingredients: [deal('Hack', { validTo: EXPIRED })] });
    const res = buildWeeklyOfferPlan({ ...baseOpts, recipes: [valid, expired], pantryItems: [] });
    expect(ids(res)).toEqual(['valid']);
  });

  it('returns an empty-state reason when there are no good candidates', () => {
    const noDeals = recipe({ id: 'x', ingredients: [ing('Tomaten'), ing('Spaghetti')] });
    const res = buildWeeklyOfferPlan({ ...baseOpts, recipes: [noDeals], pantryItems: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no_offers');
  });

  it('does not treat a bare isDeal flag as a real offer (no concrete deal data)', () => {
    // Same honesty rule as the recipe-detail card: `isDeal: true` alone, with no
    // dealId/price/store/name, is a potential — not a current — offer.
    const bareOnly = recipe({ id: 'bare', ingredients: [ing('Tomaten', { isDeal: true })] });
    const res = buildWeeklyOfferPlan({ ...baseOpts, recipes: [bareOnly], pantryItems: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no_offers');
  });

  it('filters out slow recipes when quickOnly is set', () => {
    const quick = recipe({ id: 'quick', cookTimeMinutes: 20, ingredients: [deal('Tomaten')] });
    const slow = recipe({ id: 'slow', cookTimeMinutes: 60, ingredients: [deal('Hack')] });
    const res = buildWeeklyOfferPlan({ ...baseOpts, quickOnly: true, recipes: [quick, slow], pantryItems: [] });
    expect(ids(res)).toEqual(['quick']);
  });

  it('limits the number of suggestions to count', () => {
    const recipes = [1, 2, 3, 4, 5].map((n) =>
      recipe({ id: `r-${n}`, cuisine: 'italian', ingredients: [deal(`Z${n}`)] }),
    );
    const res = buildWeeklyOfferPlan({ ...baseOpts, count: 3, recipes, pantryItems: [] });
    expect(ids(res)).toHaveLength(3);
  });

  it('only keeps recipes of the chosen cuisine when one is set', () => {
    const it1 = recipe({ id: 'it1', cuisine: 'italian', ingredients: [deal('Tomaten')] });
    const tr1 = recipe({ id: 'tr1', cuisine: 'turkish', ingredients: [deal('Hack')] });
    const res = buildWeeklyOfferPlan({
      ...baseOpts,
      cuisine: 'italian',
      recipes: [it1, tr1],
      pantryItems: [],
    });
    expect(ids(res)).toEqual(['it1']);
  });
});

describe('pickDinnerDays', () => {
  it('fills consecutive free dinner days from the start day', () => {
    expect(pickDinnerDays(3, new Set(), 0)).toEqual([0, 1, 2]);
  });

  it('skips already-occupied dinner days', () => {
    expect(pickDinnerDays(3, new Set([1]), 0)).toEqual([0, 2, 3]);
  });

  it('returns fewer days when not enough remain in the week', () => {
    expect(pickDinnerDays(5, new Set(), 5)).toEqual([5, 6]);
  });
});
