// Offer-led recipe info for the "Mit Angeboten" Cheffity tab (and the weekly
// offer planner). Reads the deal metadata that recipesApi attaches to each
// RecipeIngredient (isDeal / dealId / dealPrice / dealStoreName / dealValidTo)
// and combines it with the existing pantry coverage to answer, per recipe:
//   - how many ingredients are on a *currently valid* offer
//   - how many are still missing (pantry-aware) and at what est. deal cost
//   - which stores the offers come from
//   - whether some of its deals have already expired
//
// SOURCE OF TRUTH: an offer counts here exactly as it does on the recipe-detail
// card. A "real current offer" is a CONCRETE, still-valid deal
// (`ingredientHasConcreteDeal` + not expired), never a bare `isDeal: true` flag
// — that flag is only a *potential* offer with no data behind it, and inflating
// the "X im Angebot" count with it is what made the list disagree with the
// detail view. Validity/expiry are delegated to `recipeShop` so the list and the
// detail card can never drift apart.
//
// Pure + testable; no react-native imports.

import type { PantryItem, Recipe } from '../types';
import { computeRecipeCoverage } from './pantryMatch';
import { ingredientHasConcreteDeal } from './ingredientDeal';
import {
  isIngredientDealExpired,
  isIngredientDealFuture,
  isIngredientDealValid,
} from './recipeShop';

export interface RecipeOfferInfo {
  /** Ingredients on a currently-valid offer ("X im Angebot"). */
  validDealCount: number;
  /** Ingredients still to buy (pantry-aware), identical to coverage.missingCount. */
  missingCount: number;
  /** Sum of valid deal prices for the *missing* ingredients, or undefined when
   *  none of them carries a known deal price (never a fabricated 0). */
  missingCost?: number;
  /** Distinct store names of the valid-deal ingredients, in first-seen order. */
  stores: string[];
  /** True when the recipe has at least one deal whose validity already lapsed. */
  hasExpiredDeals: boolean;
}

/**
 * Build the offer report for one recipe. Pure; no IO. `now` is injectable so
 * dealValidTo comparisons stay deterministic in tests.
 */
export function recipeOfferInfo(
  recipe: Pick<Recipe, 'id' | 'ingredients'>,
  pantryItems: PantryItem[],
  now: Date = new Date(),
): RecipeOfferInfo {
  let validDealCount = 0;
  let hasExpiredDeals = false;
  const stores: string[] = [];
  const seenStores = new Set<string>();

  for (const ing of recipe.ingredients) {
    // Bare `isDeal: true` (no dealId + identifying detail) is NOT a concrete
    // offer — skip it so it never reaches the count, stores, or expiry flag.
    if (!ingredientHasConcreteDeal(ing)) continue;
    if (isIngredientDealExpired(ing, now)) {
      hasExpiredDeals = true;
      continue;
    }
    // A future ("nächste Woche") deal is not live yet — never counted, ranked or
    // surfaced as a current offer. It is not expired either, so no expiry hint.
    if (isIngredientDealFuture(ing, now)) continue;
    validDealCount += 1;
    if (ing.dealStoreName && !seenStores.has(ing.dealStoreName)) {
      seenStores.add(ing.dealStoreName);
      stores.push(ing.dealStoreName);
    }
  }

  const coverage = computeRecipeCoverage(recipe, pantryItems, now);
  let missingCost: number | undefined;
  for (const ing of coverage.missing) {
    if (isIngredientDealValid(ing, now) && ing.dealPrice != null) {
      missingCost = (missingCost ?? 0) + ing.dealPrice;
    }
  }
  if (missingCost != null) {
    missingCost = Math.round(missingCost * 100) / 100;
  }

  return {
    validDealCount,
    missingCount: coverage.missingCount,
    missingCost,
    stores,
    hasExpiredDeals,
  };
}

export interface RecipeWithOffers<R extends { id: string }> {
  recipe: R;
  offer: RecipeOfferInfo;
}

/**
 * Rank recipes for the "Mit Angeboten" tab. Keeps only recipes with at least
 * one currently-valid offer, then orders:
 *   1) more ingredients on offer first
 *   2) fewer missing ingredients
 *   3) cheaper missing deal cost (unknown sorts last)
 *   4) shorter cook time
 *   5) original order (stable)
 * Pure; the input is not mutated.
 */
export function rankRecipesWithOffers<
  R extends Pick<Recipe, 'id' | 'ingredients' | 'cookTimeMinutes'>,
>(recipes: R[], pantryItems: PantryItem[], now: Date = new Date()): RecipeWithOffers<R>[] {
  return recipes
    .map((recipe, index) => ({ recipe, offer: recipeOfferInfo(recipe, pantryItems, now), index }))
    .filter((x) => x.offer.validDealCount > 0)
    .sort((a, b) => {
      if (b.offer.validDealCount !== a.offer.validDealCount) {
        return b.offer.validDealCount - a.offer.validDealCount;
      }
      if (a.offer.missingCount !== b.offer.missingCount) {
        return a.offer.missingCount - b.offer.missingCount;
      }
      const ca = a.offer.missingCost ?? Number.POSITIVE_INFINITY;
      const cb = b.offer.missingCost ?? Number.POSITIVE_INFINITY;
      if (ca !== cb) return ca - cb;
      if (a.recipe.cookTimeMinutes !== b.recipe.cookTimeMinutes) {
        return a.recipe.cookTimeMinutes - b.recipe.cookTimeMinutes;
      }
      return a.index - b.index;
    })
    .map(({ recipe, offer }) => ({ recipe, offer }));
}
