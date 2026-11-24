// Deal ⇄ recipe-ingredient matcher.
//
// Builds the bridge that was missing between Supabase `public.deals` and
// `public.recipe_ingredients`: it scores active food deals against active
// recipe ingredients and fills `public.deal_recipe_matches` so the Cheffity
// mobile app can surface real, currently-valid offer products inside recipe
// details (mobile reads matches via recipesApi.fetchDealsForIngredients).
//
// Design goals (see task brief):
//   • Quality over quantity — fewer, correct matches beat many wrong ones.
//   • The scoring is a PURE function (computeMatchPlan / scoreDealForIngredient)
//     so it is fully unit-tested without a database.
//   • The IO wrapper (matchDealsToRecipeIngredients) is a thin shell: fetch →
//     compute → upsert/cleanup. It never throws into the offers-sync caller —
//     every failure is captured in `errors[]`.
//
// Linguistic core: German compound nouns put the head noun LAST, so
// `dealToken.endsWith(ingredientHead)` means "is a kind of <ingredient>".
// That single rule lets "Rinderhackfleisch" match "Hackfleisch" and "Vollmilch"
// match "Milch", while correctly rejecting "Reiswaffeln" (head=waffeln) for
// "Reis" and "Milchschokolade" (head=schokolade) for "Milch".

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { normalizeText } from '../../../src/utils/offers';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MatcherDeal {
  id: string;
  name: string;
  store_name?: string | null;
  current_price: number;
  original_price?: number | null;
  savings_percent?: number | null;
  valid_from?: string | null;
  valid_to: string;
  ingredients?: string[] | null;
  is_food?: boolean | null;
  category?: string | null;
}

export interface MatcherIngredient {
  id: string;
  recipe_id: string;
  name: string;
  is_potential_deal?: boolean;
}

export interface MatchScore {
  score: number;
  strength: MatchStrength;
  /** Structural confidence band derived from the score (see classifyMatchConfidence). */
  confidence: MatchConfidence;
  fromIngredientsArray: boolean;
}

type MatchStrength = 'exact' | 'plural' | 'compound';

/**
 * Structural confidence class of a match.
 *   high   — exact/plural head-noun match → may auto-apply.
 *   medium — compound/variety match (Rinderhackfleisch↔Hackfleisch) → reviewable.
 *   low    — weak, near the floor → review candidate.
 *   reject — no head-noun evidence or a derived-product conflict → never a match.
 */
export type MatchConfidence = 'high' | 'medium' | 'low' | 'reject';

/** Score floor below which a match is rejected. Shared by matcher + report. */
export const MATCH_MIN_SCORE = 0.65;
/** Lowest score still counted as high confidence. */
export const MATCH_HIGH_MIN = 0.85;
/** Lowest score still counted as medium confidence (review). Below → low. */
export const MATCH_MEDIUM_MIN = 0.72;

/**
 * Map a numeric match score onto a structural confidence band. Pure + shared so
 * the matcher and the quality report classify identically.
 */
export function classifyMatchConfidence(score: number, minScore = MATCH_MIN_SCORE): MatchConfidence {
  if (!(score >= minScore)) return 'reject';
  if (score >= MATCH_HIGH_MIN) return 'high';
  if (score >= MATCH_MEDIUM_MIN) return 'medium';
  return 'low';
}

export interface SelectedMatch {
  deal_id: string;
  recipe_ingredient_id: string;
  recipe_id: string;
  match_score: number;
  dealName: string;
  ingredientName: string;
  savingsPercent: number;
  price: number;
}

export interface WriteMatch {
  deal_id: string;
  recipe_ingredient_id: string;
  match_score: number;
}

export interface MatchPlanOptions {
  now?: Date;
  minScore?: number;
  maxMatchesPerIngredient?: number;
  /** Set of `${deal_id}|${recipe_ingredient_id}` pairs that are admin-verified
   *  and must never be re-written or overwritten. */
  verifiedPairs?: Set<string>;
}

export interface MatchPlan {
  scannedDeals: number;
  eligibleDeals: number;
  scannedIngredients: number;
  /** Number of (deal, ingredient) pairs kept after per-ingredient capping. */
  candidateMatches: number;
  selectedMatches: SelectedMatch[];
  /** selectedMatches minus verified pairs — the rows we would upsert. */
  writeMatches: WriteMatch[];
  recipesWithMatches: number;
}

export interface MatchJobOptions extends MatchPlanOptions {
  dryRun?: boolean;
  limitDeals?: number;
  limitIngredients?: number;
}

export interface MatchJobResult {
  scannedDeals: number;
  scannedIngredients: number;
  candidateMatches: number;
  writtenMatches: number;
  deletedExpiredMatches: number;
  ignoredExpiredMatches: number;
  recipesWithMatches: number;
  errors: string[];
  durationMs: number;
  dryRun: boolean;
  examples: Array<{ deal: string; ingredient: string; score: number }>;
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

// Adjectives, packaging and stop words that are never the head noun of an
// ingredient/product. Removing them keeps the head-noun heuristic clean.
// Kept deliberately small + high-precision (German). normalizeText() has already
// transliterated umlauts (ä→ae, ö→oe, ü→ue, ß→ss) and lowercased.
const FILLER_WORDS = new Set<string>([
  'frisch', 'frische', 'frischer', 'frisches', 'bio', 'naturell', 'naturelle',
  'fein', 'feine', 'feiner', 'grob', 'grobe', 'gross', 'grosse', 'klein', 'kleine',
  'ganze', 'ganz', 'gehackt', 'gehackte', 'passiert', 'passierte', 'mild', 'milde',
  'original', 'classic', 'klassik', 'premium', 'gut', 'guenstig', 'neu', 'neue',
  'der', 'die', 'das', 'ein', 'eine', 'und', 'oder', 'mit', 'ohne', 'im', 'in',
  'aus', 'je', 'pro', 'ca', 'zum', 'zur', 'fuer', 'extra', 'nativ', 'natives',
  'stueck', 'stk', 'packung', 'pack', 'beutel', 'dose', 'glas', 'flasche',
  'tafel', 'becher', 'tuete', 'sorte', 'sorten', 'versch', 'verschiedene',
  'verschiedenen', 'angebot', 'aktion', 'tk',
]);

// Irregular / too-short-to-suffix plurals. Generic suffixing is unsafe for
// 2-char stems ("ei"+"s"="eis"), so egg is mapped explicitly.
const SHORT_PLURALS: Record<string, string[]> = {
  ei: ['eier'],
};

const PLURAL_SUFFIXES = ['n', 'en', 'e', 'er', 's', 'nen'] as const;

const MIN_COMPOUND_HEAD = 3;

// Derived-product HEAD NOUNS: a structural (not product/brand) class of German
// head nouns that denote a *processed/prepared product distinct from the raw
// ingredient*. When such a noun is the HEAD of a deal name, the deal is that
// derived product — e.g. "…kuchen", "…dessert", "…sauce", "…waffeln". This is
// the linguistic mirror of FILLER_WORDS and lets us reject the dangerous
// false positives (Reis↔Reiswaffeln, Käse↔Käsekuchen, Sahne↔Sahnedessert,
// Tomate↔Tomatensauce) including when the compound is written with a space
// ("Reis Waffeln") — where the raw-ingredient prefix would otherwise match
// exactly. No raw-ingredient names belong here (reis, milch, sahne, …).
const DERIVED_PRODUCT_NOUNS = new Set<string>([
  'kuchen', 'torte', 'torten', 'muffin', 'muffins', 'gebaeck', 'keks', 'kekse',
  'waffel', 'waffeln', 'dessert', 'desserts', 'pudding', 'creme', 'kreme',
  'mousse', 'kompott', 'sauce', 'saucen', 'sosse', 'sossen', 'dip', 'dips',
  'riegel', 'snack', 'snacks', 'chips', 'flips', 'bonbon', 'bonbons',
  'schokolade', 'praline', 'pralinen', 'eis', 'aufstrich',
]);

/** Is this single token a derived-product noun, or a compound ending in one
 *  ("Käsekuchen" → ends with "kuchen")? */
function isDerivedProductToken(token: string): boolean {
  if (DERIVED_PRODUCT_NOUNS.has(token)) return true;
  for (const noun of DERIVED_PRODUCT_NOUNS) {
    if (token.length > noun.length && token.endsWith(noun)) return true;
  }
  return false;
}

/** Is this token a pure quantity / packaging-size token (250, 1kg, 500ml, 6er)? */
function isQuantityToken(token: string): boolean {
  if (/^\d+([.,]\d+)?$/.test(token)) return true;
  if (/^\d+([.,]\d+)?(g|kg|mg|ml|cl|l|stk|x|er|pack|prozent)$/.test(token)) return true;
  return false;
}

/** Tokenize a raw name into meaningful, normalized content tokens. */
function tokenize(raw: string): string[] {
  const norm = normalizeText(raw ?? '');
  if (!norm) return [];
  return norm
    .split(/[\s-]+/)
    .filter((t) => t.length > 0 && !isQuantityToken(t) && !FILLER_WORDS.has(t));
}

/** Generic plural equality: is `plural` === `base` + a German plural suffix? */
function genericPluralEq(base: string, plural: string): boolean {
  if (base.length < MIN_COMPOUND_HEAD) return false;
  if (plural.length <= base.length) return false;
  return PLURAL_SUFFIXES.some((suffix) => plural === base + suffix);
}

function shortPluralEq(a: string, b: string): boolean {
  return (SHORT_PLURALS[a]?.includes(b) ?? false) || (SHORT_PLURALS[b]?.includes(a) ?? false);
}

/** Strength of the match between a recipe ingredient head token and one deal
 *  token, or null when they are unrelated. */
function tokenMatch(head: string, dealToken: string): MatchStrength | null {
  if (head === dealToken) return 'exact';
  if (genericPluralEq(head, dealToken) || genericPluralEq(dealToken, head)) return 'plural';
  if (shortPluralEq(head, dealToken)) return 'plural';
  // German compound head-noun: the deal token ENDS with the ingredient head.
  if (head.length >= MIN_COMPOUND_HEAD && dealToken.endsWith(head)) return 'compound';
  return null;
}

const STRENGTH_RANK: Record<MatchStrength, number> = { exact: 3, plural: 2, compound: 1 };
const STRENGTH_BASE: Record<MatchStrength, number> = { exact: 1.0, plural: 0.9, compound: 0.82 };

function bestTokenMatch(head: string, tokens: string[]): MatchStrength | null {
  let best: MatchStrength | null = null;
  for (const token of tokens) {
    const strength = tokenMatch(head, token);
    if (strength && (!best || STRENGTH_RANK[strength] > STRENGTH_RANK[best])) {
      best = strength;
      if (best === 'exact') break;
    }
  }
  return best;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Negative token conflict: does the deal NAME describe a derived product whose
 * head noun the recipe ingredient does NOT ask for? If the deal's head noun is
 * a derived-product noun (sauce/cake/dessert/…) and the ingredient head does
 * not match that head noun, the deal is a different product class than the raw
 * ingredient and must never be matched (e.g. "Reis Waffeln" for "Reis"). When
 * the ingredient itself asks for the derived noun (head "Tomatensauce" vs deal
 * "Tomatensauce", or "Sauce" vs "Tomatensauce") there is no conflict.
 */
function detectDerivedConflict(dealNameTokens: string[], ingredientHead: string): boolean {
  const dealHead = dealNameTokens[dealNameTokens.length - 1];
  if (!dealHead || !isDerivedProductToken(dealHead)) return false;
  // The ingredient genuinely references the derived head noun → not a conflict.
  if (tokenMatch(ingredientHead, dealHead)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Scoring (pure)
// ---------------------------------------------------------------------------

/**
 * Score how well a deal matches a single recipe ingredient.
 * Returns null when there is no head-noun match at all (no fake matches).
 */
export function scoreDealForIngredient(
  deal: MatcherDeal,
  ingredient: MatcherIngredient,
): MatchScore | null {
  const ingTokens = tokenize(ingredient.name);
  if (ingTokens.length === 0) return null;
  const head = ingTokens[ingTokens.length - 1];

  const nameTokens = tokenize(deal.name);

  // Negative token conflict: the deal name is a derived product (sauce/cake/
  // dessert/…) the ingredient does not ask for → never a raw-ingredient match.
  if (detectDerivedConflict(nameTokens, head)) return null;

  const arrayTokens = (deal.ingredients ?? []).flatMap((entry) => tokenize(entry));

  const fromName = bestTokenMatch(head, nameTokens);
  const fromArray = bestTokenMatch(head, arrayTokens);

  let strength: MatchStrength | null = fromName;
  let fromIngredientsArray = false;
  // Prefer the array source when it matches at least as strongly — the brief
  // asks to weight structured ingredients[] more than the free-text name.
  if (fromArray && (!strength || STRENGTH_RANK[fromArray] >= STRENGTH_RANK[strength])) {
    strength = fromArray;
    fromIngredientsArray = true;
  }
  if (!strength) return null;

  let score = STRENGTH_BASE[strength];

  // Multi-token ingredient ("Gehackte Tomaten"): reward additional matched
  // tokens, but never punish below 0.85× of the head base — a plain "Tomaten"
  // deal is still a valid match for "Gehackte Tomaten".
  const extraTokens = ingTokens.slice(0, -1);
  if (extraTokens.length > 0) {
    const allDealTokens = nameTokens.concat(arrayTokens);
    const matchedExtra = extraTokens.filter((t) => bestTokenMatch(t, allDealTokens)).length;
    const coverage = matchedExtra / extraTokens.length;
    score = score * (0.85 + 0.15 * coverage);
  }

  if (fromIngredientsArray) score = Math.min(1, score + 0.03);

  const rounded = round3(score);
  return {
    score: rounded,
    strength,
    confidence: classifyMatchConfidence(rounded),
    fromIngredientsArray,
  };
}

// ---------------------------------------------------------------------------
// Name-only structural analysis (for the quality report)
// ---------------------------------------------------------------------------

export interface NameMatchAnalysis {
  /** Would the current matcher accept this (deal name ⇄ ingredient) pair? */
  matched: boolean;
  strength: MatchStrength | null;
  confidence: MatchConfidence;
  /** When matched=false, why — so the report can explain a suspicious row. */
  rejectReason: 'no_ingredient_tokens' | 'derived_product' | 'no_head_noun' | null;
}

/**
 * Structural verdict for a (deal name, ingredient name) pair using the same
 * rules as the scorer but without price/validity/array context. The quality
 * report uses this to flag persisted matches the *current* rules would reject
 * (e.g. rows written by older logic or by hand): a derived-product conflict or
 * no head-noun evidence at all — the "Teilwort-Match ohne Head-Noun" risk.
 */
export function analyzeNameMatch(dealName: string, ingredientName: string): NameMatchAnalysis {
  const ingTokens = tokenize(ingredientName);
  if (ingTokens.length === 0) {
    return { matched: false, strength: null, confidence: 'reject', rejectReason: 'no_ingredient_tokens' };
  }
  const head = ingTokens[ingTokens.length - 1];
  const nameTokens = tokenize(dealName);

  if (detectDerivedConflict(nameTokens, head)) {
    return { matched: false, strength: null, confidence: 'reject', rejectReason: 'derived_product' };
  }

  const strength = bestTokenMatch(head, nameTokens);
  if (!strength) {
    return { matched: false, strength: null, confidence: 'reject', rejectReason: 'no_head_noun' };
  }
  const score = STRENGTH_BASE[strength];
  return { matched: true, strength, confidence: classifyMatchConfidence(score), rejectReason: null };
}

// ---------------------------------------------------------------------------
// Deal eligibility (pure)
// ---------------------------------------------------------------------------

function toDateOnly(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * A deal is matchable when it is an active, currently-valid FOOD deal with a
 * real price. Unknown food status (is_food=null) is intentionally NOT matched —
 * we never blindly assume a deal is food.
 */
export function isMatchableDeal(deal: MatcherDeal, now: Date): boolean {
  if (deal.is_food !== true) return false;
  if (!(Number(deal.current_price) > 0)) return false;

  const today = toDateOnly(now);
  if (!deal.valid_to || deal.valid_to < today) return false;
  // valid_from is optional / may be missing; only reject when it is clearly future.
  if (deal.valid_from && deal.valid_from > today) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Plan computation (pure)
// ---------------------------------------------------------------------------

function compareSelected(a: SelectedMatch, b: SelectedMatch): number {
  if (b.match_score !== a.match_score) return b.match_score - a.match_score;
  if (b.savingsPercent !== a.savingsPercent) return b.savingsPercent - a.savingsPercent;
  return a.price - b.price;
}

/**
 * Pure planning step: from raw deals + ingredients, produce the per-ingredient
 * top-N matches, the rows to write (verified pairs excluded) and summary stats.
 */
export function computeMatchPlan(
  deals: MatcherDeal[],
  ingredients: MatcherIngredient[],
  options: MatchPlanOptions = {},
): MatchPlan {
  const now = options.now ?? new Date();
  const minScore = options.minScore ?? 0.65;
  const maxPerIngredient = options.maxMatchesPerIngredient ?? 3;
  const verifiedPairs = options.verifiedPairs ?? new Set<string>();

  const eligibleDeals = deals.filter((d) => isMatchableDeal(d, now));

  const selectedMatches: SelectedMatch[] = [];
  const recipesWithMatches = new Set<string>();

  for (const ingredient of ingredients) {
    const perIngredient: SelectedMatch[] = [];
    for (const deal of eligibleDeals) {
      const scored = scoreDealForIngredient(deal, ingredient);
      if (!scored || scored.score < minScore) continue;
      perIngredient.push({
        deal_id: deal.id,
        recipe_ingredient_id: ingredient.id,
        recipe_id: ingredient.recipe_id,
        match_score: scored.score,
        dealName: deal.name,
        ingredientName: ingredient.name,
        savingsPercent: Number(deal.savings_percent ?? 0),
        price: Number(deal.current_price ?? 0),
      });
    }
    perIngredient.sort(compareSelected);
    const top = perIngredient.slice(0, maxPerIngredient);
    for (const match of top) {
      selectedMatches.push(match);
      recipesWithMatches.add(match.recipe_id);
    }
  }

  const writeMatches: WriteMatch[] = selectedMatches
    .filter((m) => !verifiedPairs.has(`${m.deal_id}|${m.recipe_ingredient_id}`))
    .map((m) => ({
      deal_id: m.deal_id,
      recipe_ingredient_id: m.recipe_ingredient_id,
      match_score: m.match_score,
    }));

  return {
    scannedDeals: deals.length,
    eligibleDeals: eligibleDeals.length,
    scannedIngredients: ingredients.length,
    candidateMatches: selectedMatches.length,
    selectedMatches,
    writeMatches,
    recipesWithMatches: recipesWithMatches.size,
  };
}

// ---------------------------------------------------------------------------
// IO wrapper
// ---------------------------------------------------------------------------

const DEAL_COLUMNS =
  'id, name, store_name, current_price, original_price, savings_percent, valid_from, valid_to, ingredients, is_food, category';

/** Resolve the German (de) name from a recipe_ingredients.name jsonb value. */
function resolveIngredientName(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const de = obj.de ?? obj.en;
    if (typeof de === 'string') return de;
    for (const value of Object.values(obj)) {
      if (typeof value === 'string' && value.trim()) return value;
    }
  }
  return '';
}

/**
 * Run the full match job against Supabase. Never throws — failures land in
 * `result.errors`, so a caller running this after a deals-sync is never broken
 * by a matcher problem.
 */
export async function matchDealsToRecipeIngredients(
  client: SupabaseClient,
  options: MatchJobOptions = {},
): Promise<MatchJobResult> {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;
  const today = toDateOnly(now);

  const result: MatchJobResult = {
    scannedDeals: 0,
    scannedIngredients: 0,
    candidateMatches: 0,
    writtenMatches: 0,
    deletedExpiredMatches: 0,
    ignoredExpiredMatches: 0,
    recipesWithMatches: 0,
    errors: [],
    durationMs: 0,
    dryRun,
    examples: [],
  };

  // 1) Fetch active food deals.
  let deals: MatcherDeal[] = [];
  try {
    const { data, error } = await client
      .from('deals')
      .select(DEAL_COLUMNS)
      .eq('is_food', true)
      .gte('valid_to', today)
      .limit(options.limitDeals ?? 3000);
    if (error) throw new Error(error.message);
    deals = (data ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r.id),
        name: String(r.name ?? ''),
        store_name: (r.store_name as string | null) ?? null,
        current_price: Number(r.current_price ?? 0),
        original_price: r.original_price == null ? null : Number(r.original_price),
        savings_percent: r.savings_percent == null ? null : Number(r.savings_percent),
        valid_from: (r.valid_from as string | null) ?? null,
        valid_to: String(r.valid_to ?? ''),
        ingredients: Array.isArray(r.ingredients) ? (r.ingredients as string[]) : [],
        is_food: r.is_food as boolean | null,
        category: (r.category as string | null) ?? null,
      };
    });
  } catch (e) {
    result.errors.push(`fetch deals: ${(e as Error).message}`);
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  // 2) Fetch active recipe ingredients (recipe.status = 'active').
  let ingredients: MatcherIngredient[] = [];
  try {
    const { data, error } = await client
      .from('recipe_ingredients')
      .select('id, recipe_id, name, is_potential_deal, recipes!inner(status)')
      .eq('recipes.status', 'active')
      .limit(options.limitIngredients ?? 8000);
    if (error) throw new Error(error.message);
    ingredients = (data ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r.id),
        recipe_id: String(r.recipe_id),
        name: resolveIngredientName(r.name),
        is_potential_deal: r.is_potential_deal !== false,
      };
    });
  } catch (e) {
    result.errors.push(`fetch ingredients: ${(e as Error).message}`);
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  // 3) Fetch admin-curated pairs so we never overwrite them. A pair is curated
  //    when it is verified (is_verified=true) OR was set by an admin
  //    (matched_by_admin not null) — both are protected from auto-rewrite.
  const verifiedPairs = new Set<string>();
  try {
    const { data, error } = await client
      .from('deal_recipe_matches')
      .select('deal_id, recipe_ingredient_id, is_verified, matched_by_admin')
      .or('is_verified.eq.true,matched_by_admin.not.is.null');
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      const r = row as Record<string, unknown>;
      if (r.is_verified === true || (r.matched_by_admin != null && r.matched_by_admin !== '')) {
        verifiedPairs.add(`${String(r.deal_id)}|${String(r.recipe_ingredient_id)}`);
      }
    }
  } catch (e) {
    // Non-fatal: degrade by treating none as verified, but record it.
    result.errors.push(`fetch verified matches: ${(e as Error).message}`);
  }

  // 4) Plan (pure).
  const plan = computeMatchPlan(deals, ingredients, {
    now,
    minScore: options.minScore,
    maxMatchesPerIngredient: options.maxMatchesPerIngredient,
    verifiedPairs,
  });

  result.scannedDeals = plan.scannedDeals;
  result.scannedIngredients = plan.scannedIngredients;
  result.candidateMatches = plan.candidateMatches;
  result.recipesWithMatches = plan.recipesWithMatches;
  result.examples = plan.selectedMatches
    .slice()
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, 10)
    .map((m) => ({ deal: m.dealName, ingredient: m.ingredientName, score: m.match_score }));

  if (dryRun) {
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  // 5) Upsert new/updated matches (verified pairs already excluded).
  if (plan.writeMatches.length > 0) {
    const BATCH = 500;
    for (let i = 0; i < plan.writeMatches.length; i += BATCH) {
      const slice = plan.writeMatches.slice(i, i + BATCH);
      try {
        const { error } = await client
          .from('deal_recipe_matches')
          .upsert(slice, { onConflict: 'deal_id,recipe_ingredient_id' });
        if (error) throw new Error(error.message);
        result.writtenMatches += slice.length;
      } catch (e) {
        result.errors.push(`upsert matches ${i}-${i + slice.length}: ${(e as Error).message}`);
      }
    }
  }

  // 6) Clean up non-curated matches (not verified, not admin-set) that point at
  //    expired deals. Mobile already
  //    ignores expired deals at read time, so this is best-effort housekeeping.
  try {
    const { data, error } = await client
      .from('deals')
      .select('id')
      .lt('valid_to', today)
      .limit(5000);
    if (error) throw new Error(error.message);
    const expiredIds = (data ?? []).map((row) => String((row as Record<string, unknown>).id));
    if (expiredIds.length > 0) {
      const BATCH = 100;
      for (let i = 0; i < expiredIds.length; i += BATCH) {
        const slice = expiredIds.slice(i, i + BATCH);
        const { error: delError } = await client
          .from('deal_recipe_matches')
          .delete()
          .eq('is_verified', false)
          .is('matched_by_admin', null)
          .in('deal_id', slice);
        if (delError) throw new Error(delError.message);
        result.deletedExpiredMatches += slice.length; // upper bound (rows targeted)
      }
    }
  } catch (e) {
    result.errors.push(`cleanup expired matches: ${(e as Error).message}`);
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}

export function isDealMatcherConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

let cachedClient: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  cachedClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cachedClient;
}

/**
 * Convenience entrypoint used by server.ts: builds the Service-Role client
 * (Service-Role key stays backend-only, never logged) and runs the match job.
 * Returns a result with a populated `errors[]` instead of throwing when the
 * Supabase env is missing, so it is safe to call right after a deals-sync.
 */
export async function runDealRecipeMatch(
  options: MatchJobOptions = {},
): Promise<MatchJobResult> {
  const client = getClient();
  if (!client) {
    return {
      scannedDeals: 0,
      scannedIngredients: 0,
      candidateMatches: 0,
      writtenMatches: 0,
      deletedExpiredMatches: 0,
      ignoredExpiredMatches: 0,
      recipesWithMatches: 0,
      errors: ['SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — match skipped.'],
      durationMs: 0,
      dryRun: options.dryRun ?? false,
      examples: [],
    };
  }
  return matchDealsToRecipeIngredients(client, options);
}
