// Pure planning logic for "Woche mit Angeboten planen".
//
// Given the loaded recipes (each carrying deal metadata on its ingredients),
// the pantry, and the user's options, this builds an ordered, varied list of
// recipe suggestions for the week — or a clear empty-state reason when the data
// is too thin. It deliberately prefers FEWER good suggestions over padding the
// week with weak ones.
//
// Slot assignment (which weekday + meal each suggestion lands on) is kept
// separate in `pickDinnerDays` so the screen can apply it against the planner's
// real occupied slots. Both halves are pure + unit-tested; no react-native, no
// IO, no Supabase.

import type { PantryItem, Recipe } from '../types';
import { computeRecipeCoverage } from './pantryMatch';
import { normalizeCuisine, type CuisineSlug } from './cuisine';
import { recipeOfferInfo, type RecipeOfferInfo } from './offerRecipes';

const QUICK_MAX_MIN = 30;

export type OfferPlanReason =
  | { kind: 'on_deal'; count: number }
  | { kind: 'missing'; count: number }
  | { kind: 'cost'; amount: number }
  | { kind: 'from_pantry' }
  | { kind: 'quick' };

export interface OfferPlanSuggestion {
  recipe: Recipe;
  offer: RecipeOfferInfo;
  /** Short, human-explainable reasons for the suggestion card (max 3). */
  reasons: OfferPlanReason[];
}

export interface WeeklyOfferPlanInput {
  recipes: Recipe[];
  pantryItems: PantryItem[];
  /** Requested number of suggestions (3 / 5 / 7). */
  count: number;
  /** Cuisine filter; `'all'` / undefined = mixed. */
  cuisine?: CuisineSlug | 'all';
  /** Reward pantry coverage. When off, the pantry is ignored entirely. */
  usePantry: boolean;
  /** Weight deal-rich recipes higher. */
  preferDeals: boolean;
  /** Hard-filter to recipes <= 30 min. */
  quickOnly: boolean;
  /** Recipe ids already planned in the visible week (excluded). */
  plannedRecipeIds?: Set<string>;
  /** Injectable "now" for deterministic deal-validity checks. */
  now?: Date;
}

export type WeeklyOfferPlanResult =
  | { ok: true; suggestions: OfferPlanSuggestion[] }
  | { ok: false; reason: 'no_offers' | 'too_few' };

interface Candidate {
  recipe: Recipe;
  offer: RecipeOfferInfo;
  coverageRatio: number;
  cuisine: CuisineSlug;
  index: number;
}

function buildReasons(
  offer: RecipeOfferInfo,
  recipe: Recipe,
  usePantry: boolean,
): OfferPlanReason[] {
  const reasons: OfferPlanReason[] = [];
  if (offer.validDealCount > 0) reasons.push({ kind: 'on_deal', count: offer.validDealCount });
  if (usePantry && offer.missingCount === 0) reasons.push({ kind: 'from_pantry' });
  if (offer.missingCount > 0) reasons.push({ kind: 'missing', count: offer.missingCount });
  if (offer.missingCost != null) reasons.push({ kind: 'cost', amount: offer.missingCost });
  if (reasons.length < 3 && recipe.cookTimeMinutes > 0 && recipe.cookTimeMinutes <= QUICK_MAX_MIN) {
    reasons.push({ kind: 'quick' });
  }
  return reasons.slice(0, 3);
}

/**
 * Static (variety-independent) desirability of a candidate. Deals dominate;
 * pantry coverage only counts when the user opted in; quick recipes and a low
 * missing count nudge. Pure.
 */
function baseScore(c: Candidate, opts: WeeklyOfferPlanInput): number {
  let score = 0;
  score += Math.min(c.offer.validDealCount, 3) * (opts.preferDeals ? 10 : 4);
  if (opts.usePantry) score += c.coverageRatio * 18;
  if (c.recipe.cookTimeMinutes > 0 && c.recipe.cookTimeMinutes <= QUICK_MAX_MIN) score += 5;
  score += Math.max(0, 1 - c.offer.missingCount / 6) * 6;
  return score;
}

/**
 * Build the ordered, cuisine-varied list of weekly offer suggestions, or an
 * empty-state reason. A "good candidate" must have at least one currently-valid
 * deal (or, when usePantry is on, some confirmed pantry coverage) — generic
 * recipes with no offer and no stock are dropped rather than shown as filler.
 */
export function buildWeeklyOfferPlan(input: WeeklyOfferPlanInput): WeeklyOfferPlanResult {
  const now = input.now ?? new Date();
  // "Ignore pantry" means exactly that: compute coverage/offers against an
  // empty pantry so a stocked item gives no hidden edge anywhere.
  const effPantry = input.usePantry ? input.pantryItems : [];
  const planned = input.plannedRecipeIds ?? new Set<string>();

  const seenIds = new Set<string>();
  // Was there ANY valid-deal recipe at all (before the cuisine/quick/planned
  // filters)? Lets us distinguish "no offers anywhere" from "filtered to none".
  let anyOffer = false;

  const candidates: Candidate[] = [];
  input.recipes.forEach((recipe, index) => {
    if (seenIds.has(recipe.id)) return; // dedupe
    seenIds.add(recipe.id);

    const offer = recipeOfferInfo(recipe, effPantry, now);
    if (offer.validDealCount > 0) anyOffer = true;

    if (planned.has(recipe.id)) return; // already in the visible week
    if (input.quickOnly && !(recipe.cookTimeMinutes > 0 && recipe.cookTimeMinutes <= QUICK_MAX_MIN)) {
      return;
    }
    const cuisine = normalizeCuisine(recipe.cuisine);
    if (input.cuisine && input.cuisine !== 'all' && cuisine !== input.cuisine) return;

    const coverage = computeRecipeCoverage(recipe, effPantry, now);
    const coverageRatio =
      coverage.totalCount > 0
        ? (coverage.availableCount + 0.5 * coverage.unclearCount) / coverage.totalCount
        : 0;

    const isGood = offer.validDealCount > 0 || (input.usePantry && coverage.availableCount > 0);
    if (!isGood) return;

    candidates.push({ recipe, offer, coverageRatio, cuisine, index });
  });

  if (candidates.length === 0) {
    return { ok: false, reason: anyOffer ? 'too_few' : 'no_offers' };
  }

  // Greedy variety pass: repeatedly take the best-scoring remaining candidate,
  // penalising a cuisine that has already been picked so the week doesn't end
  // up all-italian. Stable on ties via original index.
  const remaining = [...candidates];
  const seenCuisines = new Set<CuisineSlug>();
  const suggestions: OfferPlanSuggestion[] = [];
  const limit = Math.min(input.count, candidates.length);

  while (suggestions.length < limit && remaining.length > 0) {
    let bestPos = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      const variety = seenCuisines.has(c.cuisine) ? -12 : 0;
      const score = baseScore(c, input) + variety;
      if (
        score > bestScore ||
        (score === bestScore && c.index < remaining[bestPos].index)
      ) {
        bestScore = score;
        bestPos = i;
      }
    }
    const chosen = remaining.splice(bestPos, 1)[0];
    seenCuisines.add(chosen.cuisine);
    suggestions.push({
      recipe: chosen.recipe,
      offer: chosen.offer,
      reasons: buildReasons(chosen.offer, chosen.recipe, input.usePantry),
    });
  }

  return { ok: true, suggestions };
}

/**
 * Choose the weekday dinner slots to write the suggestions into. Walks forward
 * from `startDay` (0=Mon … 6=Sun) through the rest of the week, skipping days
 * whose dinner slot is already occupied, until `count` days are collected or the
 * week runs out. Never wraps to earlier days — we only plan forward from the
 * start. Returns at most `count` day indices (may be fewer). Pure.
 */
export function pickDinnerDays(
  count: number,
  occupiedDinnerDays: Set<number>,
  startDay: number,
): number[] {
  const days: number[] = [];
  for (let day = startDay; day <= 6 && days.length < count; day++) {
    if (occupiedDinnerDays.has(day)) continue;
    days.push(day);
  }
  return days;
}
