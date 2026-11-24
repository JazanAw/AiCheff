// Derivations for the redesigned recipe-detail screen ("Mit Vorrat + Angeboten
// günstig kochen"). Pure; no react-native, no IO — so the status/cost rules and
// the offer-expiry rule stay unit-testable and identical everywhere.
//
// Honesty rules baked in here, per the design handoff:
//   - An expired deal is NOT a valid offer and never counts toward cost.
//   - We never fabricate a price: cost sums only the deal prices we actually
//     have; `undefined` means "nothing known", not "0 €".
//   - Pantry status wins over deal status, so an ingredient you already own is
//     never counted as something to buy (preserves the tested coverage
//     invariant in `classifyIngredientPantryStatus`).

import type { PantryItem, RecipeIngredient } from '../types';
import { classifyIngredientPantryStatus } from './pantryMatch';
import { isIngredientDealExpired, isIngredientDealValid } from './ingredientDeal';

// The deal validity/expiry/future rule lives in `ingredientDeal` (pure deal-field
// logic, no pantry dependency) so `pantryMatch` can reuse it without a circular
// import. Re-exported here so existing importers (`offerRecipes`, the detail
// screen, tests) keep their `./recipeShop` import path unchanged.
export {
  isIngredientDealExpired,
  isIngredientDealValid,
  isIngredientDealFuture,
} from './ingredientDeal';

/** Exactly one status per ingredient on the detail screen. */
export type DetailIngredientStatus = 'pantry' | 'deal' | 'missing' | 'unclear';

/**
 * Resolve the single status for one ingredient. Order (per the handoff, with
 * pantry kept ahead of deal so owned items are never billed):
 *   pantry 'available' → 'pantry'
 *   pantry 'unclear'   → 'unclear'   (honest "offen", never guessed)
 *   concrete VALID deal → 'deal'
 *   otherwise          → 'missing'   (incl. expired or non-concrete deals)
 * Pure.
 */
export function classifyDetailIngredient(
  ingredient: RecipeIngredient,
  pantryItems: PantryItem[],
  now: Date = new Date(),
): DetailIngredientStatus {
  const pantry = classifyIngredientPantryStatus(ingredient, pantryItems);
  if (pantry === 'available') return 'pantry';
  if (pantry === 'unclear') return 'unclear';
  if (isIngredientDealValid(ingredient, now)) return 'deal';
  return 'missing';
}

/**
 * The ingredients shown in the "Im Angebot für dieses Rezept" section: those
 * resolving to a valid, concrete deal (and not already covered by the pantry).
 * Order is preserved. Pure.
 */
export function selectRecipeOffers(
  ingredients: RecipeIngredient[],
  pantryItems: PantryItem[],
  now: Date = new Date(),
): RecipeIngredient[] {
  return ingredients.filter(
    (ing) => classifyDetailIngredient(ing, pantryItems, now) === 'deal',
  );
}

export interface RecipeShopSummary {
  /** Confidently in stock. */
  pantry: number;
  /** On a valid, concrete deal (tappable offers). */
  deal: number;
  /** Must be bought, no current deal (incl. expired/non-concrete deals). */
  missing: number;
  /** Name match but amount/identity not confirmable — shown, never billed. */
  unclear: number;
  /** Sum of valid deal prices (× portion factor), rounded to cents. `undefined`
   *  when no deal price is known — never a fabricated 0. */
  estimatedCost?: number;
  /** At least one not-owned ingredient had a deal that has expired. */
  hasExpiredDeals: boolean;
  /** portions / baseServings — the live scaling factor. */
  factor: number;
}

export interface SummarizeOptions {
  /** Currently selected portions (from the stepper). */
  portions: number;
  /** Recipe base servings (the amounts are stored per this count). */
  baseServings: number;
  now?: Date;
}

/**
 * Counts + estimated cost for the summary band and the sticky buy-bar, for a
 * given portion selection. Cost scales with portions; counts do not. Pure.
 */
export function summarizeRecipeShop(
  ingredients: RecipeIngredient[],
  pantryItems: PantryItem[],
  options: SummarizeOptions,
): RecipeShopSummary {
  const base = Math.max(1, options.baseServings || 1);
  const chosen = options.portions > 0 ? options.portions : base;
  const factor = chosen / base;
  const now = options.now ?? new Date();

  let pantry = 0;
  let deal = 0;
  let missing = 0;
  let unclear = 0;
  let cost: number | undefined;
  let hasExpiredDeals = false;

  for (const ing of ingredients) {
    const status = classifyDetailIngredient(ing, pantryItems, now);
    if (status === 'pantry') {
      pantry += 1;
    } else if (status === 'unclear') {
      unclear += 1;
    } else if (status === 'deal') {
      deal += 1;
      if (ing.dealPrice != null) {
        cost = (cost ?? 0) + ing.dealPrice * factor;
      }
    } else {
      missing += 1;
      // A missing ingredient that *had* a concrete deal which lapsed — surface
      // the "Angebote abgelaufen" hint instead of a stale price.
      if (isIngredientDealExpired(ing, now)) hasExpiredDeals = true;
    }
  }

  if (cost != null) {
    // Round to cents — avoids 0.1 + 0.2 float noise leaking into the UI.
    cost = Math.round(cost * 100) / 100;
  }

  return { pantry, deal, missing, unclear, estimatedCost: cost, hasExpiredDeals, factor };
}

/**
 * Scale a recipe ingredient amount by a portion factor and round it for
 * display: amounts ≥ 50 (g/ml scale) snap to the nearest 5, smaller counts to
 * the nearest 0.5. Returns null for non-positive/non-finite amounts ("Salz nach
 * Geschmack", amount 0) so the UI can omit the quantity instead of showing 0.
 * Pure.
 */
export function scaleIngredientAmount(amount: number, factor: number): number | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const v = amount * factor;
  return v >= 50 ? Math.round(v / 5) * 5 : Math.round(v * 2) / 2;
}
