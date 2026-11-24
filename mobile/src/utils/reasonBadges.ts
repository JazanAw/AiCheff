// Maps ranking reason tags → at most two prioritised, i18n-keyed badges for
// the deal/recipe cards. Pure + typed; the components only render what these
// helpers return (or nothing when there are no reasons).

import type { OfferReasonTag } from './offerRanking';
import type { RecipeReasonTag } from './recipeRanking';

const MAX_BADGES = 2;

// Priority order (highest first). A reason only becomes a visible badge if the
// item actually carries it; we then keep at most MAX_BADGES, preserving this
// order so the most meaningful "why" wins on a crowded card.
const OFFER_PRIORITY: OfferReasonTag[] = [
  'favorite',
  'on_your_list',
  'fits_recipe',
  'big_discount',
  'good_value',
  'expiring_soon',
  'nearby',
  'trending',
  'new_this_week',
];

const RECIPE_PRIORITY: RecipeReasonTag[] = [
  'from_pantry',
  'almost_ready',
  'ingredients_on_deal',
  'low_cost',
  'quick',
  'favorite',
  'trending',
  'new_to_try',
  'variety',
  'check_safety',
];

/** i18n keys — texts live in the locale files (de/en/…), never hard-coded. */
export const OFFER_REASON_I18N: Record<OfferReasonTag, string> = {
  big_discount: 'deals.reasons.big_discount',
  good_value: 'deals.reasons.good_value',
  favorite: 'deals.reasons.favorite',
  on_your_list: 'deals.reasons.on_your_list',
  fits_recipe: 'deals.reasons.fits_recipe',
  nearby: 'deals.reasons.nearby',
  expiring_soon: 'deals.reasons.expiring_soon',
  trending: 'deals.reasons.trending',
  new_this_week: 'deals.reasons.new_this_week',
};

export const RECIPE_REASON_I18N: Record<RecipeReasonTag, string> = {
  from_pantry: 'cheffity.reasons.from_pantry',
  almost_ready: 'cheffity.reasons.almost_ready',
  ingredients_on_deal: 'cheffity.reasons.ingredients_on_deal',
  low_cost: 'cheffity.reasons.low_cost',
  quick: 'cheffity.reasons.quick',
  favorite: 'cheffity.reasons.favorite',
  variety: 'cheffity.reasons.variety',
  trending: 'cheffity.reasons.trending',
  new_to_try: 'cheffity.reasons.new_to_try',
  check_safety: 'cheffity.reasons.check_safety',
};

function pickByPriority<T extends string>(reasons: T[], priority: T[]): T[] {
  if (!reasons || reasons.length === 0) return [];
  const present = new Set(reasons);
  const out: T[] = [];
  for (const tag of priority) {
    if (present.has(tag)) {
      out.push(tag);
      if (out.length >= MAX_BADGES) break;
    }
  }
  return out;
}

/** Up to two offer reason tags, ordered by display priority. Pure. */
export function getOfferReasonBadges(reasons: OfferReasonTag[] | undefined): OfferReasonTag[] {
  return pickByPriority(reasons ?? [], OFFER_PRIORITY);
}

/** Up to two recipe reason tags, ordered by display priority. Pure. */
export function getRecipeReasonBadges(reasons: RecipeReasonTag[] | undefined): RecipeReasonTag[] {
  return pickByPriority(reasons ?? [], RECIPE_PRIORITY);
}
