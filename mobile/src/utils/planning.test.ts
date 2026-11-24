import { describe, expect, it } from 'vitest';
import type { PantryItem, Recipe, RecipeIngredient, WeeklyPlanEntry } from '../types';
import {
  PLAN_SHEET_MEALS,
  buildPlanShoppingItems,
  buildWeeklyShoppingItems,
  countMissingIngredients,
  defaultPlanMeal,
  filterAlreadyOnList,
  mergeShoppingItems,
  type PlannedShoppingItem,
} from './planning';

function pantryItem(name: string, overrides: Partial<PantryItem> = {}): PantryItem {
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

function ingredient(
  name: string,
  overrides: Partial<RecipeIngredient> = {},
): RecipeIngredient {
  return {
    id: `i-${name}`,
    name,
    amount: 100,
    unit: 'g',
    isDeal: false,
    ...overrides,
  };
}

describe('buildPlanShoppingItems', () => {
  it('skips ingredients already covered by an active pantry item', () => {
    const pantry = [pantryItem('Spaghetti')];
    const ingredients = [ingredient('Spaghetti'), ingredient('Tomaten')];
    const items = buildPlanShoppingItems(ingredients, pantry, {
      recipeId: 'r1',
      portionRatio: 1,
    });
    expect(items.map((i) => i.name)).toEqual(['Tomaten']);
  });

  it('does NOT skip ingredients whose pantry match was consumed', () => {
    const pantry = [
      pantryItem('Spaghetti', { consumedAt: '2026-05-19T00:00:00Z' }),
    ];
    const items = buildPlanShoppingItems([ingredient('Spaghetti')], pantry, {
      recipeId: 'r1',
      portionRatio: 1,
    });
    expect(items.map((i) => i.name)).toEqual(['Spaghetti']);
  });

  it('carries deal data and marks rows non-manual', () => {
    const ingredients = [
      ingredient('Tomaten', {
        isDeal: true,
        dealId: '11111111-1111-1111-1111-111111111111',
        dealStoreName: 'REWE',
        dealPrice: 0.99,
      }),
    ];
    const [item] = buildPlanShoppingItems(ingredients, [], {
      recipeId: 'r1',
      portionRatio: 1,
    });
    expect(item).toMatchObject({
      name: 'Tomaten',
      recipeId: 'r1',
      dealId: '11111111-1111-1111-1111-111111111111',
      storeName: 'REWE',
      price: 0.99,
      isManual: false,
    });
  });

  it('scales quantity by portionRatio and clamps 0 → 1', () => {
    const ingredients = [
      ingredient('Mehl', { amount: 200 }),
      ingredient('Salz', { amount: 0, unit: 'Prise' }),
    ];
    const items = buildPlanShoppingItems(ingredients, [], {
      recipeId: 'r1',
      portionRatio: 2,
    });
    expect(items.find((i) => i.name === 'Mehl')?.quantity).toBe(400);
    // amount 0 would violate the quantity > 0 DB check → falls back to 1.
    expect(items.find((i) => i.name === 'Salz')?.quantity).toBe(1);
  });

  it('returns an empty list when the pantry covers everything', () => {
    const pantry = [pantryItem('Tomaten'), pantryItem('Spaghetti')];
    const ingredients = [ingredient('Tomaten'), ingredient('Spaghetti')];
    expect(
      buildPlanShoppingItems(ingredients, pantry, { recipeId: 'r1', portionRatio: 1 }),
    ).toEqual([]);
  });
});

describe('defaultPlanMeal', () => {
  it('keeps the recipe meal type when it is a plannable slot', () => {
    expect(defaultPlanMeal('breakfast')).toBe('breakfast');
    expect(defaultPlanMeal('lunch')).toBe('lunch');
    expect(defaultPlanMeal('dinner')).toBe('dinner');
    expect(defaultPlanMeal('sweet_baked')).toBe('sweet_baked');
  });

  it('falls back to lunch for non-plannable / missing meal types', () => {
    expect(defaultPlanMeal('drinks')).toBe('lunch');
    expect(defaultPlanMeal(undefined)).toBe('lunch');
  });

  it('PLAN_SHEET_MEALS holds the four plannable enum slots', () => {
    expect(PLAN_SHEET_MEALS).toEqual(['breakfast', 'lunch', 'dinner', 'sweet_baked']);
  });
});

describe('countMissingIngredients', () => {
  it('counts only ingredients not covered by the active pantry', () => {
    const pantry = [pantryItem('Spaghetti')];
    const ingredients = [ingredient('Spaghetti'), ingredient('Tomaten'), ingredient('Basilikum')];
    expect(countMissingIngredients(ingredients, pantry)).toBe(2);
  });

  it('is zero when the pantry covers everything', () => {
    const pantry = [pantryItem('Tomaten'), pantryItem('Spaghetti')];
    const ingredients = [ingredient('Tomaten'), ingredient('Spaghetti')];
    expect(countMissingIngredients(ingredients, pantry)).toBe(0);
  });
});

function plannedItem(overrides: Partial<PlannedShoppingItem> = {}): PlannedShoppingItem {
  return {
    name: 'Tomaten',
    quantity: 100,
    unit: 'g',
    recipeId: 'r1',
    isManual: false,
    ...overrides,
  };
}

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'r1',
    name: 'Recipe',
    difficulty: 'easy',
    cookTimeMinutes: 20,
    servings: 2,
    mealType: 'lunch',
    ingredients: [],
    instructions: [],
    createdAt: '2026-05-20T00:00:00Z',
    sourceType: 'human_verified',
    verificationStatus: 'published',
    aiNoticeRequired: false,
    ...overrides,
  };
}

function planEntry(
  recipe: Recipe,
  overrides: Partial<WeeklyPlanEntry> = {},
): WeeklyPlanEntry {
  return {
    id: `e-${recipe.id}`,
    dayOfWeek: 0,
    mealType: 'lunch',
    recipeId: recipe.id,
    recipe,
    ...overrides,
  };
}

describe('mergeShoppingItems', () => {
  it('sums quantities for the same name + same canonical unit', () => {
    const merged = mergeShoppingItems([
      plannedItem({ name: 'Tomaten', quantity: 100, unit: 'g' }),
      plannedItem({ name: 'Tomaten', quantity: 250, unit: 'gramm' }), // synonym → g
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].quantity).toBe(350);
  });

  it('keeps different (non-convertible) units separate — no wrong sums', () => {
    const merged = mergeShoppingItems([
      plannedItem({ name: 'Mehl', quantity: 500, unit: 'g' }),
      plannedItem({ name: 'Mehl', quantity: 1, unit: 'kg' }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('preserves deal metadata from the first item that carries it', () => {
    const merged = mergeShoppingItems([
      plannedItem({ name: 'Tomaten', quantity: 100, unit: 'g' }),
      plannedItem({
        name: 'Tomaten',
        quantity: 100,
        unit: 'g',
        dealId: '11111111-1111-1111-1111-111111111111',
        storeName: 'REWE',
        price: 0.99,
      }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ dealId: '11111111-1111-1111-1111-111111111111', storeName: 'REWE', price: 0.99 });
  });
});

describe('buildWeeklyShoppingItems', () => {
  it('collects missing ingredients across entries, pantry-aware + merged', () => {
    const r1 = makeRecipe({
      id: 'r1',
      servings: 2,
      ingredients: [ingredient('Tomaten', { amount: 100, unit: 'g' }), ingredient('Spaghetti', { amount: 200, unit: 'g' })],
    });
    const r2 = makeRecipe({
      id: 'r2',
      servings: 2,
      ingredients: [ingredient('Tomaten', { amount: 150, unit: 'g' }), ingredient('Salz', { amount: 0, unit: 'Prise' })],
    });
    const pantry = [pantryItem('Spaghetti')]; // covered → excluded
    const items = buildWeeklyShoppingItems([planEntry(r1), planEntry(r2)], pantry);
    const tomaten = items.find((i) => i.name === 'Tomaten');
    const spaghetti = items.find((i) => i.name === 'Spaghetti');
    expect(spaghetti).toBeUndefined(); // in pantry
    expect(tomaten?.quantity).toBe(250); // 100 + 150 merged
    expect(items.find((i) => i.name === 'Salz')).toBeDefined();
  });

  it('scales by the entry portionOverride relative to recipe servings', () => {
    const r = makeRecipe({
      id: 'r1',
      servings: 2,
      ingredients: [ingredient('Tomaten', { amount: 100, unit: 'g' })],
    });
    const items = buildWeeklyShoppingItems([planEntry(r, { portionOverride: 4 })], []);
    expect(items[0].quantity).toBe(200); // ratio 4/2
  });

  it('uses recipe servings (ratio 1) when no portionOverride', () => {
    const r = makeRecipe({
      id: 'r1',
      servings: 2,
      ingredients: [ingredient('Tomaten', { amount: 100, unit: 'g' })],
    });
    const items = buildWeeklyShoppingItems([planEntry(r)], []);
    expect(items[0].quantity).toBe(100);
  });
});

describe('filterAlreadyOnList', () => {
  it('drops items already present as an OPEN shopping row (same name + unit)', () => {
    const items = [
      plannedItem({ name: 'Tomaten', unit: 'g' }),
      plannedItem({ name: 'Basilikum', unit: 'g' }),
    ];
    const out = filterAlreadyOnList(items, [{ name: 'Tomaten', unit: 'gramm', checked: false }]);
    expect(out.map((i) => i.name)).toEqual(['Basilikum']);
  });

  it('does NOT block when the existing row is checked off', () => {
    const items = [plannedItem({ name: 'Tomaten', unit: 'g' })];
    const out = filterAlreadyOnList(items, [{ name: 'Tomaten', unit: 'g', checked: true }]);
    expect(out).toHaveLength(1);
  });

  it('treats different units as different items', () => {
    const items = [plannedItem({ name: 'Mehl', unit: 'kg' })];
    const out = filterAlreadyOnList(items, [{ name: 'Mehl', unit: 'g', checked: false }]);
    expect(out).toHaveLength(1);
  });
});
