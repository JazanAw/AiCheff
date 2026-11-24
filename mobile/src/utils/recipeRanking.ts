// Hybrid, rule-based "Für dich" recipe ranking (V1, deterministic).
//
// Complements the pantry-tab ranking (rankRecipesForCooking in pantryMatch):
// that one is coverage-only for the "Aus Lager" tabs; this one mixes coverage
// with deals, cost, time, preference, cuisine variety, trends and novelty for
// the swipe/"Für dich" feed, with explainable reason tags. Pure + testable;
// missing data degrades the affected sub-score to 0 (never throws).
//
// RecipeScore = pantryCoverage + missingOnDeal + lowCost + timeFit
//             + preferenceFit + cuisineVariety + trend + novelty
//             − recentlySeen − tooManyMissing − safetyUnclear

import type { Recipe } from '../types';
import { computeRecipeCoverage, type RecipeCoverage } from './pantryMatch';
import type { PantryItem } from '../types';
import { normalizeCuisine } from './cuisine';

export type RecipeReasonTag =
  | 'from_pantry'
  | 'almost_ready'
  | 'ingredients_on_deal'
  | 'low_cost'
  | 'quick'
  | 'favorite'
  | 'variety'
  | 'trending'
  | 'new_to_try'
  | 'check_safety';

export interface RecipeRankContext {
  pantryItems?: PantryItem[];
  /** Favourited recipe ids. */
  favoriteIds?: Set<string>;
  /** recipe_trend_30d planned counts keyed by recipeId (popularity signal). */
  trendByRecipeId?: Map<string, number>;
  /** Recently shown recipe ids (fatigue / repetition control). */
  recentlySeenIds?: Set<string>;
  /** Override "now" for deterministic tests + time-of-day fit. */
  now?: Date;
}

export interface ScoredRecipe<R extends { id: string }> {
  recipe: R;
  coverage: RecipeCoverage;
  score: number;
  reasons: RecipeReasonTag[];
}

export const RECIPE_WEIGHTS = {
  pantryCoverage: 28,
  missingOnDeal: 16,
  lowCost: 10,
  timeFit: 10,
  preferenceFit: 18,
  cuisineVariety: 10,
  trend: 12,
  novelty: 8,
  recentlySeenPenalty: 20,
  tooManyMissingPenalty: 14,
  safetyUnclearPenalty: 10,
} as const;

const QUICK_PIVOT_MIN = 30; // <= 30 min counts as quick
const NOVELTY_DAYS = 14; // created within 2 weeks = novel
const TREND_SATURATION = 10; // planned count that saturates the trend score

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Score one recipe for the "Für dich" feed. `seenCuisines` lets the caller
 * enforce variety across the feed (a cuisine already shown scores lower on the
 * variety component). Pure.
 */
export function scoreRecipeForYou<R extends Recipe>(
  recipe: R,
  context: RecipeRankContext,
  seenCuisines?: Set<string>,
): ScoredRecipe<R> {
  const now = context.now ?? new Date();
  const coverage = computeRecipeCoverage(recipe, context.pantryItems ?? [], now);
  const reasons: RecipeReasonTag[] = [];

  // 1) pantry coverage. Counts confident hits fully and "unclear" hits (have
  //    the item, amount uncertain) at half — matchPercent alone would ignore
  //    unclear coverage and under-rank pantry-rich recipes.
  const coverageNorm =
    coverage.totalCount > 0
      ? clamp01((coverage.availableCount + 0.5 * coverage.unclearCount) / coverage.totalCount)
      : 0;
  if (coverage.totalCount > 0 && coverage.missingCount === 0) reasons.push('from_pantry');
  else if (coverage.missingCount >= 1 && coverage.missingCount <= 3) reasons.push('almost_ready');

  // 2) missing ingredients on deal (share of missing that's on offer).
  const dealNorm =
    coverage.missingCount > 0
      ? clamp01(coverage.missingOnDealCount / coverage.missingCount)
      : 0;
  if (coverage.missingOnDealCount > 0) reasons.push('ingredients_on_deal');

  // 3) low estimated missing cost (cheaper completion → higher). Unknown = 0.
  let costNorm = 0;
  if (coverage.estimatedMissingCost != null) {
    costNorm = clamp01(1 - coverage.estimatedMissingCost / 10); // 10€+ → 0
    if (coverage.estimatedMissingCost <= 5) reasons.push('low_cost');
  }

  // 4) time fit — quicker is better.
  const cookTime = recipe.cookTimeMinutes;
  let timeNorm = 0;
  if (Number.isFinite(cookTime) && cookTime > 0) {
    timeNorm = clamp01((QUICK_PIVOT_MIN * 2 - cookTime) / (QUICK_PIVOT_MIN * 2));
    if (cookTime <= QUICK_PIVOT_MIN) reasons.push('quick');
  }

  // 5) preference fit — favourite (allergies/halal already hard-filtered upstream).
  let prefNorm = 0;
  if (context.favoriteIds?.has(recipe.id)) {
    prefNorm = 1;
    reasons.push('favorite');
  }

  // 6) cuisine variety — full credit if this cuisine hasn't been shown yet.
  const cuisineSlug = normalizeCuisine(recipe.cuisine);
  let varietyNorm = 1;
  if (seenCuisines && seenCuisines.has(cuisineSlug)) {
    varietyNorm = 0.3;
  } else if (seenCuisines) {
    reasons.push('variety');
  }

  // 7) trend — planned count from recipe_trend_30d.
  let trendNorm = 0;
  const planned = context.trendByRecipeId?.get(recipe.id) ?? 0;
  if (planned > 0) {
    trendNorm = clamp01(planned / TREND_SATURATION);
    reasons.push('trending');
  }

  // 8) novelty — created recently.
  let noveltyNorm = 0;
  if (recipe.createdAt) {
    const created = new Date(recipe.createdAt);
    if (!Number.isNaN(created.getTime())) {
      const daysAgo = (now.getTime() - created.getTime()) / 86400000;
      if (daysAgo >= 0 && daysAgo <= NOVELTY_DAYS) {
        noveltyNorm = clamp01(1 - daysAgo / NOVELTY_DAYS);
        reasons.push('new_to_try');
      }
    }
  }

  // 9) penalties.
  const recentlySeenNorm = context.recentlySeenIds?.has(recipe.id) ? 1 : 0;
  const tooManyMissingNorm = coverage.missingCount > 4 ? clamp01((coverage.missingCount - 4) / 6) : 0;
  // Safety: AI-generated / explicit notice / unclear halal → small caution.
  const unclearHalal = recipe.halalStatus === 'unclear';
  const aiUnverified =
    recipe.aiNoticeRequired === true ||
    ((recipe.sourceType === 'ai_generated' || recipe.sourceType === 'ai_adapted') &&
      recipe.verificationStatus !== 'reviewed');
  const safetyNorm = aiUnverified || unclearHalal ? 1 : 0;
  if (safetyNorm > 0) reasons.push('check_safety');

  const score =
    coverageNorm * RECIPE_WEIGHTS.pantryCoverage +
    dealNorm * RECIPE_WEIGHTS.missingOnDeal +
    costNorm * RECIPE_WEIGHTS.lowCost +
    timeNorm * RECIPE_WEIGHTS.timeFit +
    prefNorm * RECIPE_WEIGHTS.preferenceFit +
    varietyNorm * RECIPE_WEIGHTS.cuisineVariety +
    trendNorm * RECIPE_WEIGHTS.trend +
    noveltyNorm * RECIPE_WEIGHTS.novelty -
    recentlySeenNorm * RECIPE_WEIGHTS.recentlySeenPenalty -
    tooManyMissingNorm * RECIPE_WEIGHTS.tooManyMissingPenalty -
    safetyNorm * RECIPE_WEIGHTS.safetyUnclearPenalty;

  return { recipe, coverage, score: Math.round(score * 100) / 100, reasons };
}

/**
 * Rank recipes for the "Für dich" feed. Two-pass so cuisine variety is enforced
 * across the result: a greedy pass picks the best remaining recipe, marks its
 * cuisine as seen, and re-scores the rest with the variety penalty. Stable on
 * ties via original order. Pure; input not mutated.
 */
export function rankRecipesForYou<R extends Recipe>(
  recipes: R[],
  context: RecipeRankContext = {},
): ScoredRecipe<R>[] {
  const remaining = recipes.map((recipe, index) => ({ recipe, index }));
  const seenCuisines = new Set<string>();
  const out: ScoredRecipe<R>[] = [];

  while (remaining.length > 0) {
    let bestPos = 0;
    let best: ScoredRecipe<R> | null = null;
    for (let i = 0; i < remaining.length; i++) {
      const scored = scoreRecipeForYou(remaining[i].recipe, context, seenCuisines);
      if (
        best === null ||
        scored.score > best.score ||
        (scored.score === best.score && remaining[i].index < remaining[bestPos].index)
      ) {
        best = scored;
        bestPos = i;
      }
    }
    if (best) {
      out.push(best);
      seenCuisines.add(normalizeCuisine(best.recipe.cuisine));
    }
    remaining.splice(bestPos, 1);
  }
  return out;
}
