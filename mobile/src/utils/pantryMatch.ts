import type { PantryItem, Recipe, RecipeIngredient } from '../types';
import { isIngredientDealValid } from './ingredientDeal';

const MIN_TOKEN_LENGTH = 3;

const UMLAUT_MAP: Record<string, string> = {
  'ä': 'ae',
  'ö': 'oe',
  'ü': 'ue',
  'ß': 'ss',
};

// Common German unit / packaging words that show up in shopping/pantry
// strings ("500g Tomaten", "Packung Spaghetti") and would otherwise dilute
// the match. Kept short on purpose — only obvious noise.
const NOISE_TOKENS = new Set<string>([
  'gramm', 'gram',
  'kilo', 'kilogramm',
  'liter', 'milliliter',
  'stueck', 'stueckchen',
  'packung', 'packungen',
  'flasche', 'flaschen',
  'dose', 'dosen',
  'becher',
  'beutel',
  'glas',
  'tube',
  'paket',
  'tafel',
  'scheibe', 'scheiben',
  'frisch', 'frische', 'frischer',
  'bio',
  'tk',
]);

function applyUmlautMap(input: string): string {
  let out = input;
  for (const [from, to] of Object.entries(UMLAUT_MAP)) {
    out = out.split(from).join(to);
  }
  return out;
}

// Unicode range ̀–ͯ = combining diacritical marks (the accents
// produced by NFD normalization). Written as escape sequence so source
// stays ASCII.
const DIACRITIC_MARKS_RE = /[̀-ͯ]/g;

function stripDiacritics(input: string): string {
  // Normalize accents (NFD) and drop the combining marks. Keeps umlauts that
  // were already expanded by applyUmlautMap above.
  return input.normalize('NFD').replace(DIACRITIC_MARKS_RE, '');
}

function depluralizeToken(token: string): string {
  // Very small German/English plural heuristic. Order matters — longest
  // suffix first. 'n' covers German -el / -er plurals ("Kartoffeln",
  // "Schwestern"), guarded by length so short words ("Tor", "Mann") don't
  // get stripped.
  if (token.length <= MIN_TOKEN_LENGTH) return token;
  const suffixes = ['innen', 'chen', 'lein', 'en', 'er', 'es', 'e', 'n', 's'];
  for (const suffix of suffixes) {
    if (token.length > suffix.length + MIN_TOKEN_LENGTH && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

/**
 * Normalize a food name for fuzzy matching. v1 heuristic — not a stemmer.
 * Lowercases, expands umlauts, strips diacritics + punctuation, drops short
 * tokens and common packaging/unit noise, depluralizes the rest.
 */
export function normalizeFoodName(input: string): string {
  if (!input) return '';
  const lowered = input.toLowerCase();
  const withoutUmlauts = applyUmlautMap(lowered);
  const withoutDiacritics = stripDiacritics(withoutUmlauts);
  const onlyAlnumSpace = withoutDiacritics.replace(/[^a-z0-9\s]/g, ' ');
  const tokens = onlyAlnumSpace
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= MIN_TOKEN_LENGTH)
    // Drop pure-number tokens — they are quantities ("500 g Tomaten"), not
    // part of the food name.
    .filter((t) => !/^\d+$/.test(t))
    .filter((t) => !NOISE_TOKENS.has(t))
    .map(depluralizeToken)
    .filter((t) => t.length >= MIN_TOKEN_LENGTH);
  return tokens.join(' ');
}

function tokensOf(normalized: string): string[] {
  return normalized.split(' ').filter((t) => t.length >= MIN_TOKEN_LENGTH);
}

/**
 * Collect every searchable label of a pantry item that could plausibly match a
 * recipe ingredient. `name` is the user-facing/typed value; `productName` and
 * `brand` come from barcode/OFF lookups and frequently carry the *generic*
 * product name (e.g. name="Barilla" + productName="Spaghetti N.5"), which
 * is exactly the term a recipe uses.
 */
function pantrySearchLabels(item: PantryItem): string[] {
  const labels = [item.name];
  if (item.productName && item.productName !== item.name) {
    labels.push(item.productName);
  }
  // brand alone rarely helps ("Barilla"), but combined with the product name
  // it doesn't hurt — kept simple, no concatenation gymnastics.
  return labels;
}

// Single-item predicate shared by `isIngredientCoveredByPantry` and
// `findCoveringPantryItem` so both use exactly the same name-match rule.
// Consumed items never match. `ingredientNormalized` / `ingredientTokens` are
// precomputed by the caller so this stays cheap inside the pantry loop.
function pantryItemMatchesIngredient(
  item: PantryItem,
  ingredientNormalized: string,
  ingredientTokens: string[],
): boolean {
  if (item.consumedAt) return false;
  for (const label of pantrySearchLabels(item)) {
    const pantryNormalized = normalizeFoodName(label);
    if (!pantryNormalized) continue;
    if (
      ingredientNormalized === pantryNormalized ||
      ingredientNormalized.includes(pantryNormalized) ||
      pantryNormalized.includes(ingredientNormalized)
    ) {
      return true;
    }
    const pantryTokens = tokensOf(pantryNormalized);
    for (const token of ingredientTokens) {
      if (pantryTokens.includes(token)) return true;
    }
  }
  return false;
}

/**
 * The first active pantry item whose normalized name covers the ingredient, or
 * null. Same match rule as `isIngredientCoveredByPantry`; returns the row so a
 * caller can inspect its quantity/unit (see `classifyIngredientPantryStatus`).
 */
export function findCoveringPantryItem(
  ingredientName: string,
  pantryItems: PantryItem[],
): PantryItem | null {
  const ingredientNormalized = normalizeFoodName(ingredientName);
  if (!ingredientNormalized) return null;
  const ingredientTokens = tokensOf(ingredientNormalized);
  if (ingredientTokens.length === 0) return null;
  for (const item of pantryItems) {
    if (pantryItemMatchesIngredient(item, ingredientNormalized, ingredientTokens)) {
      return item;
    }
  }
  return null;
}

/**
 * True iff some active pantry item's normalized name shares a meaningful
 * token with the ingredient. Consumed items are ignored. Short tokens (<3
 * chars) cannot drive a match — they would yield obvious false positives
 * (e.g. "Ei" vs "Eis").
 *
 * Searches every label returned by `pantrySearchLabels` so a barcode-scanned
 * item ("Barilla" + productName "Spaghetti N.5") still matches "Spaghetti".
 */
export function isIngredientCoveredByPantry(
  ingredientName: string,
  pantryItems: PantryItem[],
): boolean {
  return findCoveringPantryItem(ingredientName, pantryItems) !== null;
}

// ─── Quantity-aware status (Im Lager / Unklar / Fehlt) ─────────────────────

export type IngredientPantryStatus = 'available' | 'unclear' | 'missing';

// Seasoning-scale units: if a name-matching item is stocked at all, you almost
// certainly have enough for a recipe that only calls for a pinch / a spoon.
// Stored umlaut-expanded ("essloeffel") to match `normalizeUnitString`.
const NEGLIGIBLE_UNITS = new Set<string>([
  'el', 'essloeffel',
  'tl', 'teeloeffel',
  'prise', 'prisen',
  'msp', 'messerspitze',
  'spritzer', 'schuss', 'etwas',
]);

// Unit synonyms → canonical token. Deliberately NO cross-scale conversion
// (g↔kg, ml↔l): different scales compare as "not the same unit", so we fall
// back to 'unclear' rather than risk a false 'available'. v1 is conservative.
const UNIT_SYNONYMS: Record<string, string> = {
  g: 'g', gr: 'g', gramm: 'g',
  kg: 'kg', kilo: 'kg', kilogramm: 'kg',
  ml: 'ml', milliliter: 'ml',
  l: 'l', liter: 'l',
  stueck: 'stueck', stk: 'stueck', stueckchen: 'stueck',
};

function normalizeUnitString(unit: string | undefined): string {
  if (!unit) return '';
  return stripDiacritics(applyUmlautMap(unit.toLowerCase())).trim();
}

function canonicalUnit(normalizedUnit: string): string {
  return UNIT_SYNONYMS[normalizedUnit] ?? normalizedUnit;
}

/**
 * Canonical key for a unit string, used to decide whether two shopping
 * quantities may be summed. Synonyms collapse (g/gr/gramm → 'g') but scales
 * are deliberately NOT converted (g vs kg stay distinct), so merging never
 * produces a wrong sum. Empty/unknown units return '' and only merge with
 * other empty units. Pure.
 */
export function canonicalUnitKey(unit: string | undefined): string {
  return canonicalUnit(normalizeUnitString(unit));
}

/**
 * Three-state pantry status for the recipe detail UI:
 *   - 'available' — name match AND we can confirm the amount (comparable unit
 *      with enough on hand, a seasoning-scale unit, or no meaningful amount).
 *   - 'unclear'   — name match but the amount can't be compared (units differ
 *      or are unknown, or stocked quantity is below what the recipe needs).
 *   - 'missing'   — no name match at all.
 *
 * Invariant: the *covered* set is identical to `isIngredientCoveredByPantry` —
 * status is 'missing' iff that helper returns false. This function only
 * subdivides the covered set into confident vs. uncertain; it never reclassifies
 * a covered ingredient as missing (so the shopping-list skip logic is unaffected).
 *
 * v1 is name-based and conservative on quantity, per spec ("Keine perfekte
 * Mengenlogik erzwingen, wenn Einheiten unklar sind").
 */
export function classifyIngredientPantryStatus(
  ingredient: Pick<RecipeIngredient, 'name' | 'amount' | 'unit'>,
  pantryItems: PantryItem[],
): IngredientPantryStatus {
  const match = findCoveringPantryItem(ingredient.name, pantryItems);
  if (!match) return 'missing';

  const required = ingredient.amount;
  // No meaningful amount to compare ("Salz nach Geschmack", amount 0/NaN): a
  // name match is enough confidence.
  if (!Number.isFinite(required) || required <= 0) return 'available';

  const requiredUnit = normalizeUnitString(ingredient.unit);
  if (NEGLIGIBLE_UNITS.has(requiredUnit)) return 'available';

  const requiredCanonical = canonicalUnit(requiredUnit);
  const haveCanonical = canonicalUnit(normalizeUnitString(match.unit));

  // Same canonical unit → an apples-to-apples amount comparison is possible.
  if (requiredCanonical === haveCanonical) {
    return match.quantity >= required ? 'available' : 'unclear';
  }

  // Units not comparable → we have *something* matching but can't confirm the
  // amount.
  return 'unclear';
}

export interface IngredientCoverage {
  available: RecipeIngredient[];
  missing: RecipeIngredient[];
}

/**
 * Partition a recipe's ingredients into "already in the pantry" vs "still
 * needs to be bought". Order is preserved within each bucket.
 */
export function splitMissingIngredients(
  ingredients: RecipeIngredient[],
  pantryItems: PantryItem[],
): IngredientCoverage {
  const available: RecipeIngredient[] = [];
  const missing: RecipeIngredient[] = [];
  for (const ingredient of ingredients) {
    if (isIngredientCoveredByPantry(ingredient.name, pantryItems)) {
      available.push(ingredient);
    } else {
      missing.push(ingredient);
    }
  }
  return { available, missing };
}

/**
 * Coverage badge for the "Aus Lager" UI. The label is decided purely by how
 * many ingredients are still missing — the match percent only refines the
 * sort order, not the badge.
 *
 *   allHere      → nothing missing, ready to cook
 *   oneMissing   → exactly one trip to fix it
 *   almostThere  → 2–3 missing, a single quick shop covers it
 *   moreMissing  → larger gap, deprioritized
 */
export type CoverageBadge =
  | 'allHere'
  | 'oneMissing'
  | 'almostThere'
  | 'moreMissing';

export interface RecipeCoverage {
  recipeId: string;
  totalCount: number;
  /** Confidently in the pantry (classify → 'available'). */
  availableCount: number;
  /** Name match but amount not confirmable (classify → 'unclear'). */
  unclearCount: number;
  /** Not in the pantry at all (classify → 'missing'). */
  missingCount: number;
  /** Subset of `missing` that is currently on a deal. */
  missingOnDealCount: number;
  /** Rounded percentage 0–100 of confidently-available ingredients. */
  matchPercent: number;
  badge: CoverageBadge;
  available: RecipeIngredient[];
  unclear: RecipeIngredient[];
  missing: RecipeIngredient[];
  missingOnDeal: RecipeIngredient[];
  /** Sum of deal prices for missing-on-deal ingredients that carry a price.
   *  `undefined` when no missing ingredient has a known deal price — never a
   *  fabricated 0, so the UI can hide the line instead of showing "0 €". */
  estimatedMissingCost?: number;
}

function coverageBadgeFor(missingCount: number): CoverageBadge {
  if (missingCount <= 0) return 'allHere';
  if (missingCount === 1) return 'oneMissing';
  if (missingCount <= 3) return 'almostThere';
  return 'moreMissing';
}

/**
 * Build the full coverage report for one recipe. Pure; no IO.
 *
 * Uses the three-state `classifyIngredientPantryStatus` so the report cleanly
 * separates "confidently in stock" / "unclear (have something, amount unknown)"
 * / "missing". The covered/missing boundary is identical to the binary
 * `isIngredientCoveredByPantry` (invariant in `classifyIngredientPantryStatus`),
 * so `missing` here equals exactly what `buildPlanShoppingItems` would buy —
 * unclear items are NOT counted as missing and are never auto-added to a list.
 *
 * "On deal" (missingOnDeal / estimatedMissingCost) follows the single honest
 * Cheffity rule via `isIngredientDealValid`: a CONCRETE, currently-valid deal
 * only — never a bare `isDeal: true` flag, never an expired deal. `now` is
 * injectable so expiry stays deterministic in tests.
 *
 * An ingredient-less recipe (shouldn't happen in practice) gets `allHere`
 * with 0%-match so it sorts to the bottom of the "Aus Lager" view — better
 * than pretending it's a perfect match.
 */
export function computeRecipeCoverage(
  recipe: Pick<Recipe, 'id' | 'ingredients'>,
  pantryItems: PantryItem[],
  now: Date = new Date(),
): RecipeCoverage {
  const available: RecipeIngredient[] = [];
  const unclear: RecipeIngredient[] = [];
  const missing: RecipeIngredient[] = [];
  const missingOnDeal: RecipeIngredient[] = [];
  let estimatedMissingCost: number | undefined;

  for (const ingredient of recipe.ingredients) {
    const status = classifyIngredientPantryStatus(ingredient, pantryItems);
    if (status === 'available') {
      available.push(ingredient);
    } else if (status === 'unclear') {
      unclear.push(ingredient);
    } else {
      missing.push(ingredient);
      if (isIngredientDealValid(ingredient, now)) {
        missingOnDeal.push(ingredient);
        if (ingredient.dealPrice != null) {
          estimatedMissingCost =
            (estimatedMissingCost ?? 0) + ingredient.dealPrice;
        }
      }
    }
  }

  if (estimatedMissingCost != null) {
    // Round to cents — avoids 0.1 + 0.2 float noise leaking into the UI.
    estimatedMissingCost = Math.round(estimatedMissingCost * 100) / 100;
  }

  const totalCount = recipe.ingredients.length;
  const availableCount = available.length;
  const missingCount = missing.length;
  const matchPercent =
    totalCount > 0 ? Math.round((availableCount / totalCount) * 100) : 0;
  return {
    recipeId: recipe.id,
    totalCount,
    availableCount,
    unclearCount: unclear.length,
    missingCount,
    missingOnDealCount: missingOnDeal.length,
    matchPercent,
    badge: coverageBadgeFor(missingCount),
    available,
    unclear,
    missing,
    missingOnDeal,
    estimatedMissingCost,
  };
}

const BADGE_RANK: Record<CoverageBadge, number> = {
  allHere: 0,
  oneMissing: 1,
  almostThere: 2,
  moreMissing: 3,
};

export interface RecipeWithCoverage<R extends { id: string }> {
  recipe: R;
  coverage: RecipeCoverage;
}

/**
 * Rank recipes for the "Aus Lager" view:
 *   1) badge rank (allHere → oneMissing → almostThere → moreMissing)
 *   2) fewer missing ingredients first (inside the same badge)
 *   3) higher match% first
 *   4) input order preserved as the final tie-breaker (kept stable)
 *
 * Returns a new array; the input is not mutated. The original ranking that
 * `fetchRecipes` produces (rating × created_at) survives as the implicit
 * tie-breaker — i.e. when two recipes tie on coverage, the better-rated one
 * wins.
 */
export function sortRecipesByCoverage<R extends Pick<Recipe, 'id' | 'ingredients'>>(
  recipes: R[],
  pantryItems: PantryItem[],
  now: Date = new Date(),
): RecipeWithCoverage<R>[] {
  const withCoverage = recipes.map((recipe, index) => ({
    recipe,
    coverage: computeRecipeCoverage(recipe, pantryItems, now),
    originalIndex: index,
  }));
  withCoverage.sort((a, b) => {
    const ar = BADGE_RANK[a.coverage.badge];
    const br = BADGE_RANK[b.coverage.badge];
    if (ar !== br) return ar - br;
    if (a.coverage.missingCount !== b.coverage.missingCount) {
      return a.coverage.missingCount - b.coverage.missingCount;
    }
    if (a.coverage.matchPercent !== b.coverage.matchPercent) {
      return b.coverage.matchPercent - a.coverage.matchPercent;
    }
    return a.originalIndex - b.originalIndex;
  });
  return withCoverage.map(({ recipe, coverage }) => ({ recipe, coverage }));
}

/**
 * "Fast fertig" subset: you already have at least one ingredient (confidently
 * available OR unclear) AND between 1 and 3 are missing. Recipes with 0 missing
 * don't qualify (those are the "Aus Lager" bucket); recipes with > 3 missing
 * aren't close enough to feel almost-ready.
 *
 * Generic over any `{ coverage }` shape so it works on both
 * `sortRecipesByCoverage` and `rankRecipesForCooking` output without losing the
 * extra fields (e.g. the score).
 */
export function filterAlmostReady<T extends { coverage: RecipeCoverage }>(
  ranked: T[],
): T[] {
  return ranked.filter(
    ({ coverage }) =>
      coverage.availableCount + coverage.unclearCount > 0 &&
      coverage.missingCount >= 1 &&
      coverage.missingCount <= 3,
  );
}

// ─── Cooking score & pantry-aware ranking (powers the tabs) ────────────────

// Weights for the recipe cooking score (per ingredient, ratio-normalised by
// total so recipes with many vs. few ingredients compare fairly). Coverage
// dominates; a confident pantry hit is worth most, an unclear hit counts
// partially, a missing-but-on-deal item still earns a little (cheap to get),
// a missing-no-deal item earns nothing.
const SCORE_COVERAGE = {
  available: 1,
  unclear: 0.4,
  missingOnDeal: 0.15,
  missingNoDeal: 0,
} as const;
// Cook time only nudges: recipes at/under the pivot earn up to +TIME_BONUS,
// longer ones down to −TIME_BONUS. Small on purpose so it breaks ties but never
// overrides coverage ("kurze Kochzeit leicht bevorzugen").
const SCORE_TIME_PIVOT_MIN = 45;
const SCORE_TIME_BONUS = 5;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Weighted desirability score for "cook with your pantry". Pure. Higher = more
 * cookable-right-now. Driven almost entirely by coverage; cook time is a small
 * tie-breaker. Dietary prefs/allergies are intentionally NOT scored here —
 * `fetchRecipes` already filters them out upstream as a hard gate, so there's
 * nothing to reward twice and no risk of false positives.
 */
export function scoreRecipe(
  recipe: Pick<Recipe, 'cookTimeMinutes'>,
  coverage: RecipeCoverage,
): number {
  const { totalCount } = coverage;
  if (totalCount === 0) return 0;
  const missingNoDealCount = coverage.missingCount - coverage.missingOnDealCount;
  const coverageScore =
    (100 *
      (SCORE_COVERAGE.available * coverage.availableCount +
        SCORE_COVERAGE.unclear * coverage.unclearCount +
        SCORE_COVERAGE.missingOnDeal * coverage.missingOnDealCount +
        SCORE_COVERAGE.missingNoDeal * missingNoDealCount)) /
    totalCount;
  const cookTime = recipe.cookTimeMinutes;
  const timeBonus =
    Number.isFinite(cookTime) && cookTime > 0
      ? clampNumber(
          (SCORE_TIME_PIVOT_MIN - cookTime) / SCORE_TIME_PIVOT_MIN,
          -1,
          1,
        ) * SCORE_TIME_BONUS
      : 0;
  return coverageScore + timeBonus;
}

export interface RankedRecipe<R extends { id: string }> {
  recipe: R;
  coverage: RecipeCoverage;
  score: number;
}

/**
 * Rank recipes for the pantry-aware cooking tabs by the weighted `scoreRecipe`
 * (descending). Stable: original input order breaks ties. Pure; the input is
 * not mutated.
 */
export function rankRecipesForCooking<
  R extends Pick<Recipe, 'id' | 'ingredients' | 'cookTimeMinutes'>,
>(recipes: R[], pantryItems: PantryItem[], now: Date = new Date()): RankedRecipe<R>[] {
  const scored = recipes.map((recipe, index) => {
    const coverage = computeRecipeCoverage(recipe, pantryItems, now);
    return {
      recipe,
      coverage,
      score: scoreRecipe(recipe, coverage),
      originalIndex: index,
    };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.originalIndex - b.originalIndex;
  });
  return scored.map(({ recipe, coverage, score }) => ({
    recipe,
    coverage,
    score,
  }));
}

/**
 * "Aus Lager" subset: nothing missing. Unclear ingredients are allowed (they're
 * flagged separately on the card), per spec. Preserves input order.
 */
export function filterReadyFromStock<T extends { coverage: RecipeCoverage }>(
  ranked: T[],
): T[] {
  return ranked.filter(({ coverage }) => coverage.missingCount === 0);
}

function dealCoverageRatio(coverage: RecipeCoverage): number {
  return coverage.missingCount > 0
    ? coverage.missingOnDealCount / coverage.missingCount
    : 0;
}

/**
 * "Günstig kochen" subset: recipes whose missing ingredients can largely be
 * bought on a deal. Keeps only recipes with at least one missing-on-deal
 * ingredient, then re-orders by:
 *   1) higher share of missing covered by deals
 *   2) lower estimated missing cost (unknown cost sorts last)
 *   3) fewer missing overall
 *   4) original order (stable)
 * Pure; the input is not mutated.
 */
export function filterCheapRecipes<T extends { coverage: RecipeCoverage }>(
  ranked: T[],
): T[] {
  return ranked
    .filter(({ coverage }) => coverage.missingOnDealCount > 0)
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const da = dealCoverageRatio(a.item.coverage);
      const db = dealCoverageRatio(b.item.coverage);
      if (db !== da) return db - da;
      const ca = a.item.coverage.estimatedMissingCost ?? Number.POSITIVE_INFINITY;
      const cb = b.item.coverage.estimatedMissingCost ?? Number.POSITIVE_INFINITY;
      if (ca !== cb) return ca - cb;
      if (a.item.coverage.missingCount !== b.item.coverage.missingCount) {
        return a.item.coverage.missingCount - b.item.coverage.missingCount;
      }
      return a.index - b.index;
    })
    .map(({ item }) => item);
}
