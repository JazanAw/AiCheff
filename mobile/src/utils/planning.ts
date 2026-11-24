import type { MealType, PantryItem, RecipeIngredient, WeeklyPlanEntry } from '../types';
import { canonicalUnitKey, normalizeFoodName, splitMissingIngredients } from './pantryMatch';

/**
 * Meal types offered by the "Zum Wochenplan" sheet. These are exactly the
 * `public.meal_type` enum values that make sense as plannable slots — there
 * is intentionally NO new enum value: "Snack" maps onto `sweet_baked`, the
 * non-main-meal slot, so no migration is required.
 */
export const PLAN_SHEET_MEALS: MealType[] = [
  'breakfast',
  'lunch',
  'dinner',
  'sweet_baked',
];

/**
 * Pick the meal chip that should be pre-selected when planning a recipe.
 * Uses the recipe's own meal_type when it is one of the sheet's options,
 * otherwise falls back to lunch (e.g. `drinks` has no plan slot). Pure.
 */
export function defaultPlanMeal(recipeMealType: MealType | undefined): MealType {
  if (recipeMealType && PLAN_SHEET_MEALS.includes(recipeMealType)) {
    return recipeMealType;
  }
  return 'lunch';
}

/** Count how many recipe ingredients still need buying given the pantry. */
export function countMissingIngredients(
  ingredients: RecipeIngredient[],
  pantryItems: PantryItem[],
): number {
  return splitMissingIngredients(ingredients, pantryItems).missing.length;
}

/** A shopping-list payload derived from planning a recipe. */
export interface PlannedShoppingItem {
  name: string;
  quantity: number;
  unit: string;
  recipeId: string;
  dealId?: string;
  storeName?: string;
  price?: number;
  /** Recipe-/deal-driven rows are never "manual". */
  isManual: false;
}

export interface BuildPlanOptions {
  recipeId: string;
  /** portions chosen / recipe base servings — scales each amount. */
  portionRatio: number;
}

/**
 * Decide what actually needs to be bought when planning a recipe:
 *   - ingredients already covered by an active pantry item are skipped
 *   - the rest are scaled by portionRatio and carry their deal data
 *     (dealId / storeName / price) so the shopping row reflects the offer
 *
 * Pure + side-effect free so it can be unit-tested without Supabase.
 * shopping_list_items requires quantity > 0, so a scaled amount of 0
 * (e.g. "Salz nach Geschmack", amount=0) falls back to 1.
 */
export function buildPlanShoppingItems(
  ingredients: RecipeIngredient[],
  pantryItems: PantryItem[],
  options: BuildPlanOptions,
): PlannedShoppingItem[] {
  const { missing } = splitMissingIngredients(ingredients, pantryItems);
  return missing.map((ing) => {
    const scaled = Number((ing.amount * options.portionRatio).toFixed(2));
    const quantity = scaled > 0 ? scaled : 1;
    return {
      name: ing.name,
      quantity,
      unit: ing.unit,
      recipeId: options.recipeId,
      dealId: ing.dealId,
      storeName: ing.dealStoreName,
      price: ing.dealPrice,
      isManual: false,
    };
  });
}

// ─── Weekly shopping list (all planned recipes of a week) ──────────────────

/** Planned portions for an entry: the override if set, else the recipe base. */
function entryPortionRatio(entry: WeeklyPlanEntry): number {
  const base = Math.max(1, entry.recipe.servings || 1);
  const portions = entry.portionOverride ?? entry.recipe.servings ?? base;
  return portions / base;
}

/**
 * Merge a flat list of shopping items by normalized food name + canonical
 * unit. Same name AND comparable unit → quantities are summed; different
 * units stay separate (no cross-scale conversion, so no wrong sums). The
 * first occurrence wins for the display name; deal metadata is taken from the
 * first item in the group that carries a dealId. Stable insertion order. Pure.
 */
export function mergeShoppingItems(items: PlannedShoppingItem[]): PlannedShoppingItem[] {
  const groups = new Map<string, PlannedShoppingItem>();
  const order: string[] = [];
  for (const item of items) {
    const key = `${normalizeFoodName(item.name)}|${canonicalUnitKey(item.unit)}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...item });
      order.push(key);
      continue;
    }
    existing.quantity = Number((existing.quantity + item.quantity).toFixed(2));
    // Preserve deal metadata if the running group has none yet.
    if (!existing.dealId && item.dealId) {
      existing.dealId = item.dealId;
      existing.storeName = item.storeName;
      existing.price = item.price;
    }
  }
  return order.map((key) => groups.get(key) as PlannedShoppingItem);
}

/**
 * Build the merged "what to buy" list for every planned recipe of a week.
 * Per entry: pantry-aware missing ingredients (scaled by the entry's planned
 * portions), then merged across recipes. Pure — IO (pantry/shopping fetch)
 * happens in the caller.
 */
export function buildWeeklyShoppingItems(
  entries: WeeklyPlanEntry[],
  pantryItems: PantryItem[],
): PlannedShoppingItem[] {
  const all: PlannedShoppingItem[] = [];
  for (const entry of entries) {
    const perRecipe = buildPlanShoppingItems(entry.recipe.ingredients, pantryItems, {
      recipeId: entry.recipeId,
      portionRatio: entryPortionRatio(entry),
    });
    all.push(...perRecipe);
  }
  return mergeShoppingItems(all);
}

/** Minimal shape of an existing shopping row needed for dedupe. */
export interface ExistingShoppingRow {
  name: string;
  unit: string;
  checked: boolean;
}

/**
 * Drop items that already exist as an OPEN (unchecked) shopping row with the
 * same normalized name + canonical unit. Conservative: when in doubt we skip
 * re-adding rather than risk a duplicate or a wrong quantity bump. Checked /
 * purchased rows do not block a fresh add. Pure.
 */
export function filterAlreadyOnList(
  items: PlannedShoppingItem[],
  existing: ExistingShoppingRow[],
): PlannedShoppingItem[] {
  const openKeys = new Set<string>();
  for (const row of existing) {
    if (row.checked) continue;
    openKeys.add(`${normalizeFoodName(row.name)}|${canonicalUnitKey(row.unit)}`);
  }
  return items.filter(
    (item) => !openKeys.has(`${normalizeFoodName(item.name)}|${canonicalUnitKey(item.unit)}`),
  );
}
