// Shared "plan a recipe into the weekly plan" orchestration.
//
// One place that every entry point (swipe-right, recipe details, the
// Lager/Fast/Günstig lists) calls so the behaviour is identical everywhere:
//   1) upsert the weekly_plan_entry for the chosen day + meal + portions
//   2) record the swipe intent (best-effort, never blocks planning)
//   3) optionally push the *missing* ingredients to the shopping list,
//      pantry-aware and keeping deal metadata
//
// Reuses the existing building blocks — plannerApi, the planning util and the
// shopping/pantry APIs — and adds no new backend surface.

import type { MealType, PantryItem, Recipe } from '../types';
import { upsertPlannerEntry, weekStartDate } from './plannerApi';
import { recordSwipe } from './swipesApi';
import { addShoppingItem } from './shoppingListApi';
import { fetchPantryItems } from './pantryApi';
import { buildPlanShoppingItems } from '../utils/planning';

export interface PlanRecipeInput {
  recipe: Recipe;
  /** 0 = Monday … 6 = Sunday. */
  dayOfWeek: number;
  /** Target meal slot (a public.meal_type enum value). */
  mealType: MealType;
  /** Chosen portion count. */
  portions: number;
  /** The user's default portion size — used to decide if an override is set. */
  defaultPortionSize: number;
  /** Whether the missing ingredients should be added to the shopping list. */
  addMissingToShopping: boolean;
  /** Pre-loaded pantry (avoids a refetch); falls back to fetching when absent. */
  pantryItems?: PantryItem[];
  /** Optional explicit week; defaults to the current ISO week. */
  weekStart?: string;
}

export interface PlanRecipeResult {
  weekStart: string;
  dayOfWeek: number;
  mealType: MealType;
  /** How many shopping rows were actually written. */
  addedToShoppingCount: number;
}

/**
 * Persist a recipe into the weekly plan and (optionally) push its missing
 * ingredients to the shopping list. Throws only if the core planner upsert
 * fails — swipe logging and individual shopping inserts are best-effort so a
 * single failure never aborts the whole plan.
 */
export async function planRecipeToWeek(input: PlanRecipeInput): Promise<PlanRecipeResult> {
  const weekStart = input.weekStart ?? weekStartDate();
  const portionOverride =
    input.portions !== input.defaultPortionSize ? input.portions : undefined;

  // 1) Core write — this is the one that must succeed.
  await upsertPlannerEntry({
    dayOfWeek: input.dayOfWeek,
    mealType: input.mealType,
    recipeId: input.recipe.id,
    portionOverride,
    weekStart,
  });

  // 2) Swipe intent — best-effort analytics, never blocks planning.
  recordSwipe(input.recipe.id, 'add_to_plan', {
    mealType: input.mealType,
    weekStartDate: weekStart,
  }).catch((e) =>
    console.warn('[planRecipeFlow] recordSwipe(add_to_plan) failed:', (e as Error).message),
  );

  // 3) Missing ingredients → shopping list (pantry-aware, deal-aware).
  let addedToShoppingCount = 0;
  if (input.addMissingToShopping) {
    let pantryItems = input.pantryItems;
    if (!pantryItems) {
      try {
        pantryItems = await fetchPantryItems();
      } catch (e) {
        console.warn('[planRecipeFlow] fetchPantryItems failed:', (e as Error).message);
        pantryItems = [];
      }
    }

    const portionRatio =
      input.portions / Math.max(1, input.recipe.servings || input.defaultPortionSize || 1);

    const toBuy = buildPlanShoppingItems(input.recipe.ingredients, pantryItems, {
      recipeId: input.recipe.id,
      portionRatio,
    });

    const results = await Promise.all(
      toBuy.map(async (item) => {
        try {
          await addShoppingItem({
            name: item.name,
            quantity: item.quantity,
            unit: item.unit,
            recipeId: item.recipeId,
            dealId: item.dealId,
            storeName: item.storeName,
            price: item.price,
            isManual: item.isManual,
          });
          return true;
        } catch (e) {
          console.warn(
            '[planRecipeFlow] addShoppingItem failed for',
            item.name,
            ':',
            (e as Error).message,
          );
          return false;
        }
      }),
    );
    addedToShoppingCount = results.filter(Boolean).length;
  }

  return {
    weekStart,
    dayOfWeek: input.dayOfWeek,
    mealType: input.mealType,
    addedToShoppingCount,
  };
}
