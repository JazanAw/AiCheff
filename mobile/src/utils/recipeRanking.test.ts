import { describe, expect, it } from 'vitest';
import type { PantryItem, Recipe, RecipeIngredient } from '../types';
import { rankRecipesForYou, scoreRecipeForYou } from './recipeRanking';

const NOW = new Date('2026-05-28T12:00:00Z');

function ing(name: string, overrides: Partial<RecipeIngredient> = {}): RecipeIngredient {
  return { id: `i-${name}`, name, amount: 100, unit: 'g', isDeal: false, ...overrides };
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

describe('scoreRecipeForYou', () => {
  it('rewards higher pantry coverage', () => {
    const r = recipe();
    const covered = scoreRecipeForYou(r, { now: NOW, pantryItems: [pantry('Tomaten'), pantry('Spaghetti')] });
    const empty = scoreRecipeForYou(r, { now: NOW, pantryItems: [] });
    expect(covered.score).toBeGreaterThan(empty.score);
    expect(covered.reasons).toContain('from_pantry');
  });

  it('flags almost-ready recipes', () => {
    const r = recipe({ ingredients: [ing('Tomaten'), ing('Spaghetti'), ing('Basilikum')] });
    const s = scoreRecipeForYou(r, { now: NOW, pantryItems: [pantry('Tomaten'), pantry('Spaghetti')] });
    expect(s.reasons).toContain('almost_ready');
  });

  it('rewards missing ingredients that are on a concrete, valid deal', () => {
    const r = recipe({
      ingredients: [
        ing('Tomaten', { dealId: 'd1', dealName: 'Tomaten', dealPrice: 0.99, dealValidTo: '2026-06-15' }),
        ing('Spaghetti'),
      ],
    });
    const s = scoreRecipeForYou(r, { now: NOW, pantryItems: [] });
    expect(s.reasons).toContain('ingredients_on_deal');
  });

  it('does NOT flag ingredients_on_deal for a bare isDeal flag', () => {
    const r = recipe({ ingredients: [ing('Tomaten', { isDeal: true }), ing('Spaghetti')] });
    const s = scoreRecipeForYou(r, { now: NOW, pantryItems: [] });
    expect(s.reasons).not.toContain('ingredients_on_deal');
  });

  it('gives no deal score boost for a bare isDeal flag', () => {
    const bare = recipe({ ingredients: [ing('Tomaten', { isDeal: true }), ing('Spaghetti')] });
    const plain = recipe({ ingredients: [ing('Tomaten'), ing('Spaghetti')] });
    const bareScore = scoreRecipeForYou(bare, { now: NOW, pantryItems: [] }).score;
    const plainScore = scoreRecipeForYou(plain, { now: NOW, pantryItems: [] }).score;
    expect(bareScore).toBe(plainScore);
  });

  it('does NOT flag ingredients_on_deal for an expired concrete deal', () => {
    const r = recipe({
      ingredients: [
        ing('Tomaten', { dealId: 'd1', dealName: 'Tomaten', dealPrice: 0.99, dealValidTo: '2026-05-01' }),
        ing('Spaghetti'),
      ],
    });
    const s = scoreRecipeForYou(r, { now: NOW, pantryItems: [] });
    expect(s.reasons).not.toContain('ingredients_on_deal');
  });

  it('marks quick recipes', () => {
    const quick = scoreRecipeForYou(recipe({ cookTimeMinutes: 15 }), { now: NOW });
    const slow = scoreRecipeForYou(recipe({ cookTimeMinutes: 90 }), { now: NOW });
    expect(quick.score).toBeGreaterThan(slow.score);
    expect(quick.reasons).toContain('quick');
  });

  it('boosts favourites', () => {
    const base = scoreRecipeForYou(recipe({ id: 'f' }), { now: NOW });
    const fav = scoreRecipeForYou(recipe({ id: 'f' }), { now: NOW, favoriteIds: new Set(['f']) });
    expect(fav.score).toBeGreaterThan(base.score);
    expect(fav.reasons).toContain('favorite');
  });

  it('penalises recently-seen recipes and unsafe/unclear ones', () => {
    const fresh = scoreRecipeForYou(recipe({ id: 'x' }), { now: NOW });
    const seen = scoreRecipeForYou(recipe({ id: 'x' }), { now: NOW, recentlySeenIds: new Set(['x']) });
    expect(seen.score).toBeLessThan(fresh.score);

    const ai = scoreRecipeForYou(
      recipe({ id: 'ai', sourceType: 'ai_generated', verificationStatus: 'draft' }),
      { now: NOW },
    );
    expect(ai.reasons).toContain('check_safety');
    expect(ai.score).toBeLessThan(fresh.score);
  });

  it('penalises recipes with far too many missing ingredients', () => {
    const many = recipe({
      ingredients: Array.from({ length: 8 }, (_, i) => ing(`Zutat${i}`)),
    });
    const s = scoreRecipeForYou(many, { now: NOW, pantryItems: [] });
    const few = scoreRecipeForYou(recipe(), { now: NOW, pantryItems: [] });
    expect(s.score).toBeLessThan(few.score);
  });

  it('never throws on empty data', () => {
    expect(() => scoreRecipeForYou(recipe({ ingredients: [] }), {})).not.toThrow();
  });
});

describe('rankRecipesForYou', () => {
  it('enforces cuisine variety — does not stack the same cuisine on top', () => {
    const recipes = [
      recipe({ id: 'it1', cuisine: 'italienisch', cookTimeMinutes: 20 }),
      recipe({ id: 'it2', cuisine: 'italienisch', cookTimeMinutes: 20 }),
      recipe({ id: 'de1', cuisine: 'deutsch', cookTimeMinutes: 20 }),
    ];
    const ranked = rankRecipesForYou(recipes, { now: NOW });
    // Top two should not both be italian (variety penalty kicks in).
    const top2 = ranked.slice(0, 2).map((r) => r.recipe.cuisine);
    expect(new Set(top2).size).toBe(2);
  });

  it('ranks a pantry-rich favourite above an empty unknown recipe', () => {
    const recipes = [
      recipe({ id: 'low', cuisine: 'deutsch', ingredients: [ing('Trüffel'), ing('Hummer')] }),
      recipe({ id: 'high', cuisine: 'italienisch', ingredients: [ing('Tomaten'), ing('Spaghetti')] }),
    ];
    const ranked = rankRecipesForYou(recipes, {
      now: NOW,
      pantryItems: [pantry('Tomaten'), pantry('Spaghetti')],
      favoriteIds: new Set(['high']),
    });
    expect(ranked[0].recipe.id).toBe('high');
  });

  it('returns every recipe exactly once', () => {
    const recipes = [recipe({ id: 'a' }), recipe({ id: 'b' }), recipe({ id: 'c' })];
    const ranked = rankRecipesForYou(recipes, { now: NOW });
    expect(ranked.map((r) => r.recipe.id).sort()).toEqual(['a', 'b', 'c']);
  });
});
