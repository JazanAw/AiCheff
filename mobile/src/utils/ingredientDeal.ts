// Helpers for the "tap an offer ingredient → see the concrete deal" flow in
// the recipe detail screen. Pure; no react-native, no IO — so the clickability
// rule and the shopping payload stay unit-testable and identical everywhere.

import type { Recipe, RecipeIngredient } from '../types';
import type { AddShoppingItemInput } from '../services/shoppingListApi';

type DealFields = Pick<
  RecipeIngredient,
  'dealId' | 'dealName' | 'dealPrice' | 'dealStoreName'
>;

function nonEmpty(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * True iff the ingredient carries a CONCRETE deal worth opening a detail sheet
 * for: a real deal id PLUS at least one identifying detail (product name, price
 * or store). A bare `isDeal` flag (potential deal, no data) is deliberately NOT
 * concrete — we never invent details we don't have. Pure.
 */
export function ingredientHasConcreteDeal(ingredient: DealFields): boolean {
  if (!nonEmpty(ingredient.dealId)) return false;
  return (
    nonEmpty(ingredient.dealName) ||
    ingredient.dealPrice != null ||
    nonEmpty(ingredient.dealStoreName)
  );
}

// ─── Deal validity / expiry ────────────────────────────────────────────────
// The single "is this a real current offer?" rule, used everywhere in Cheffity
// (swipe card, pantry coverage, "Für dich" ranking, offers tab, recipe detail).
// Kept here next to `ingredientHasConcreteDeal` — pure deal-field logic with no
// pantry dependency — so callers like `pantryMatch` can reuse it without a
// circular import. `recipeShop` re-exports these for backwards compatibility.

/** Parse a deal date string; null when absent or unparseable. */
function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Last instant (local) of the given date's day — a "gültig bis" date is valid
 *  through the whole of that day. */
function endOfDay(date: Date): Date {
  const e = new Date(date);
  e.setHours(23, 59, 59, 999);
  return e;
}

/** First instant (local) of the given date's day — a "gültig ab" date becomes
 *  valid at the very start of that day. */
function startOfDay(date: Date): Date {
  const s = new Date(date);
  s.setHours(0, 0, 0, 0);
  return s;
}

/**
 * True iff the ingredient carries a CONCRETE deal whose `dealValidTo` lies in
 * the past (relative to `now`). A deal with no parseable end date can't be
 * proven expired, so it is treated as still valid — we never invent an expiry.
 * Pure.
 */
export function isIngredientDealExpired(
  ingredient: RecipeIngredient,
  now: Date = new Date(),
): boolean {
  if (!ingredientHasConcreteDeal(ingredient)) return false;
  const end = parseDate(ingredient.dealValidTo);
  if (!end) return false;
  return now.getTime() > endOfDay(end).getTime();
}

/**
 * True iff the ingredient carries a CONCRETE deal whose `dealValidFrom` lies in
 * the FUTURE (relative to `now`) — a "nächste Woche" / upcoming offer that is not
 * live yet and must never be shown or counted as a current Cheffity offer. A deal
 * with no parseable start date can't be proven future, so it is treated as
 * already started — we never invent a future start. Pure.
 */
export function isIngredientDealFuture(
  ingredient: RecipeIngredient,
  now: Date = new Date(),
): boolean {
  if (!ingredientHasConcreteDeal(ingredient)) return false;
  const start = parseDate(ingredient.dealValidFrom);
  if (!start) return false;
  return now.getTime() < startOfDay(start).getTime();
}

/**
 * True iff the ingredient carries a concrete deal that is CURRENT right now:
 * concrete data present, not expired (`dealValidTo`) AND not future
 * (`dealValidFrom`). NextWeek/upcoming offers are excluded so the swipe card,
 * pantry coverage, "Für dich" ranking, offers tab and recipe detail all agree on
 * "real current offer". Pure.
 */
export function isIngredientDealValid(
  ingredient: RecipeIngredient,
  now: Date = new Date(),
): boolean {
  return (
    ingredientHasConcreteDeal(ingredient) &&
    !isIngredientDealExpired(ingredient, now) &&
    !isIngredientDealFuture(ingredient, now)
  );
}

/**
 * Count a recipe's ingredients that are on a currently-valid, concrete deal.
 * Pantry-independent and identical to `recipeOfferInfo(...).validDealCount`, so
 * the Cheffity swipe-card badge agrees with the offers tab and the detail view.
 * A bare `isDeal: true` flag never counts. Pure.
 */
export function countValidRecipeDeals(
  recipe: Pick<Recipe, 'ingredients'>,
  now: Date = new Date(),
): number {
  let count = 0;
  for (const ingredient of recipe.ingredients) {
    if (isIngredientDealValid(ingredient, now)) count += 1;
  }
  return count;
}

/**
 * Build the shopping-list payload for an offer ingredient. Uses the concrete
 * deal product name when available (so the row reflects the actual product),
 * else the recipe ingredient name. Quantity/unit come from the recipe; deal
 * id/store/price are carried through so the row stays a non-manual deal row.
 * shopping_list_items requires quantity > 0, so a 0/NaN amount falls back to 1.
 * Pure.
 */
export function buildIngredientDealShoppingItem(
  ingredient: RecipeIngredient,
  recipeId: string,
): AddShoppingItemInput {
  const name = nonEmpty(ingredient.dealName) ? ingredient.dealName!.trim() : ingredient.name;
  const amount = ingredient.amount;
  const quantity = Number.isFinite(amount) && amount > 0 ? amount : 1;
  return {
    name,
    quantity,
    unit: ingredient.unit,
    storeName: ingredient.dealStoreName,
    price: ingredient.dealPrice,
    dealId: ingredient.dealId,
    recipeId,
    isManual: false,
  };
}
