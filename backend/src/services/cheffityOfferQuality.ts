// Cheffity "deals ⇄ recipes" quality report for the Admin/Backend.
//
// Answers the questions you otherwise only notice once the mobile app looks
// empty: are offers actually connected to recipe ingredients? how many recipes
// have real offers? which deals/ingredients stay unmatched? which matches look
// weak? It reads the same tables the matcher writes (`deals`,
// `recipe_ingredients`, `deal_recipe_matches`) and the same validity rules, so
// the admin numbers agree with what Cheffity shows.
//
// The heavy logic (`computeOfferQuality`) is a PURE function over already-fetched
// rows — fully unit-tested without a database. The IO wrapper
// (`getCheffityOfferQuality` / `runCheffityOfferQuality`) is a thin fetch→map→
// compute shell. Service-Role key stays backend-only and is never logged.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { normalizeText } from '../../../src/utils/offers';
import {
  analyzeNameMatch,
  classifyMatchConfidence,
  isMatchableDeal,
  type MatchConfidence,
} from './dealRecipeMatcher';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface QualityDeal {
  id: string;
  name: string;
  store_name?: string | null;
  current_price: number;
  savings_percent?: number | null;
  valid_from?: string | null;
  valid_to: string;
  is_food?: boolean | null;
  category?: string | null;
}

export interface QualityRecipe {
  id: string;
  name: string;
}

export interface QualityIngredient {
  id: string;
  recipe_id: string;
  name: string;
  is_potential_deal?: boolean;
}

export interface QualityMatch {
  deal_id: string;
  recipe_ingredient_id: string;
  match_score: number;
  is_verified?: boolean;
  /** Admin-set match (uuid) — protected like is_verified. */
  matched_by_admin?: string | null;
}

export interface OfferQualityInput {
  /** All deals (active + expired). Expired ones are needed to count expired matches. */
  deals: QualityDeal[];
  /** Active recipes only. */
  recipes: QualityRecipe[];
  /** Ingredients of active recipes only. */
  ingredients: QualityIngredient[];
  /** All deal_recipe_matches rows. */
  matches: QualityMatch[];
}

export interface OfferQualityOptions {
  now?: Date;
  /** Valid matches below this score are flagged as review candidates. Default 0.72. */
  lowScoreThreshold?: number;
  /** Max rows per quality list. Default 20. */
  listLimit?: number;
}

export interface OfferQualityKpis {
  /** Not-expired deals (valid_to >= today). Includes current AND future. */
  activeDeals: number;
  /** Active AND already started (valid_from <= today) — what Cheffity-current may use. */
  currentDeals: number;
  /** Active but NOT started yet (valid_from > today) — nextWeek/upcoming, never current. */
  futureDeals: number;
  matchableDeals: number;
  activeRecipes: number;
  recipeIngredients: number;
  /** Matches on a current (started, not expired), food, priced deal — Cheffity-current. */
  validDealMatches: number;
  recipesWithValidDeals: number;
  ingredientsWithValidDeals: number;
  expiredMatches: number;
  /** Matches pointing at a future/nextWeek deal — must NOT appear in current UI. */
  futureMatches: number;
  lowScoreMatches: number;
  /** Valid current matches with high structural confidence (score ≥ 0.85). */
  highConfidenceMatches: number;
  /** Valid current matches in the medium/low band — review candidates. */
  reviewMatches: number;
  /** Valid current matches the *current* rules would reject (derived-product
   *  conflict / no head-noun). Curated (verified/admin) matches are excluded. */
  suspiciousMatches: number;
  matchCoveragePercent: number;
  recipeCoveragePercent: number;
}

export interface UnmatchedDeal {
  id: string;
  name: string;
  storeName: string | null;
  price: number;
  validTo: string;
  category: string | null;
  reason: 'no_recipe_ingredient_match';
}

export interface UnmatchedIngredient {
  id: string;
  recipeId: string;
  recipeName: string;
  ingredientName: string;
  /** How many active ingredients share this (normalized) name. */
  count: number;
  reason: 'no_active_deal_match';
}

export interface ReviewCandidate {
  dealId: string;
  ingredientId: string;
  dealName: string;
  ingredientName: string;
  recipeName: string;
  score: number;
  reason: 'low_score';
}

export interface SuspiciousMatch {
  dealId: string;
  ingredientId: string;
  dealName: string;
  ingredientName: string;
  recipeName: string;
  score: number;
  /** Why the current rules would reject this persisted match. */
  reason: 'derived_product' | 'no_head_noun' | 'no_ingredient_tokens';
}

export interface OfferQualityReport {
  kpis: OfferQualityKpis;
  topUnmatchedDeals: UnmatchedDeal[];
  topUnmatchedIngredients: UnmatchedIngredient[];
  reviewCandidates: ReviewCandidate[];
  /** Valid current matches that look like false positives (structural reject). */
  suspiciousMatches: SuspiciousMatch[];
  warnings: string[];
}

const DEFAULT_LOW_SCORE = 0.72;
const DEFAULT_LIST_LIMIT = 20;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function toDateOnly(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Active = not expired (valid_to >= today). Includes current + future. */
function isActiveDeal(deal: QualityDeal, today: string): boolean {
  return Boolean(deal.valid_to) && deal.valid_to >= today;
}

/** Future = not started yet (valid_from clearly after today). A null/empty
 *  valid_from is treated as already started — never guessed as future. */
function isFutureDeal(deal: QualityDeal, today: string): boolean {
  return Boolean(deal.valid_from) && (deal.valid_from as string) > today;
}

/** Current = active AND already started — the only deals Cheffity-current may use. */
function isCurrentDeal(deal: QualityDeal, today: string): boolean {
  return isActiveDeal(deal, today) && !isFutureDeal(deal, today);
}

/** A match is "valid" for Cheffity-current when its deal is current (started,
 *  not expired), food and priced. Future/nextWeek deals are excluded so a
 *  nextWeek match is never counted as a live recipe offer. */
function isValidMatchDeal(deal: QualityDeal, today: string): boolean {
  return isCurrentDeal(deal, today) && deal.is_food === true && Number(deal.current_price) > 0;
}

function pct(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
}

/** Group key for condensing duplicate ingredient names ("Tomaten" 20×). */
function ingredientGroupKey(name: string): string {
  const norm = normalizeText(name);
  return norm || name.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Pure report
// ---------------------------------------------------------------------------

/**
 * Compute the full deals⇄recipes quality report from already-fetched rows.
 * Pure; no IO. `now` is injectable so expiry comparisons stay deterministic.
 */
export function computeOfferQuality(
  input: OfferQualityInput,
  options: OfferQualityOptions = {},
): OfferQualityReport {
  const now = options.now ?? new Date();
  const today = toDateOnly(now);
  const lowScoreThreshold = options.lowScoreThreshold ?? DEFAULT_LOW_SCORE;
  const listLimit = options.listLimit ?? DEFAULT_LIST_LIMIT;

  const { deals, recipes, ingredients, matches } = input;

  const dealById = new Map(deals.map((d) => [d.id, d]));
  const ingredientById = new Map(ingredients.map((i) => [i.id, i]));
  const recipeById = new Map(recipes.map((r) => [r.id, r]));

  const activeDeals = deals.filter((d) => isActiveDeal(d, today));
  const currentDeals = activeDeals.filter((d) => !isFutureDeal(d, today));
  const futureDeals = activeDeals.filter((d) => isFutureDeal(d, today));
  const matchableDeals = deals.filter((d) => isMatchableDeal(d, now));

  let validDealMatches = 0;
  let expiredMatches = 0;
  let futureMatches = 0;
  let lowScoreMatches = 0;
  let highConfidenceMatches = 0;
  let reviewMatches = 0;
  let suspiciousCount = 0;
  const recipesWithValidDeals = new Set<string>();
  const ingredientsWithValidDeals = new Set<string>();
  const matchedDealIds = new Set<string>();
  const matchedIngredientIds = new Set<string>();
  const reviewRaw: ReviewCandidate[] = [];
  const suspiciousRaw: SuspiciousMatch[] = [];

  for (const m of matches) {
    const deal = dealById.get(m.deal_id);
    if (!deal) continue; // orphan match (deal gone) — can't classify
    if (!isActiveDeal(deal, today)) {
      expiredMatches += 1;
      continue;
    }
    if (isFutureDeal(deal, today)) {
      // Match references a future/nextWeek deal — tracked so the admin can see
      // it, but it must never count as a current recipe offer.
      futureMatches += 1;
      continue;
    }
    if (!isValidMatchDeal(deal, today)) continue; // current but non-food / no price

    validDealMatches += 1;
    matchedDealIds.add(deal.id);
    const ing = ingredientById.get(m.recipe_ingredient_id);
    if (ing) {
      ingredientsWithValidDeals.add(ing.id);
      recipesWithValidDeals.add(ing.recipe_id);
      matchedIngredientIds.add(ing.id);
    }

    const score = Number(m.match_score);
    const confidence: MatchConfidence = classifyMatchConfidence(score);
    if (confidence === 'high') highConfidenceMatches += 1;
    else reviewMatches += 1; // medium + low (+ anything below floor that slipped in)

    if (score < lowScoreThreshold) {
      lowScoreMatches += 1;
      reviewRaw.push({
        dealId: deal.id,
        ingredientId: m.recipe_ingredient_id,
        dealName: deal.name,
        ingredientName: ing ? ing.name : '',
        recipeName: ing ? recipeById.get(ing.recipe_id)?.name ?? '' : '',
        score,
        reason: 'low_score',
      });
    }

    // Suspicious = a *valid current* match the current rules would reject on a
    // name basis (derived-product conflict / no head-noun) — a likely false
    // positive from older logic. Curated (verified/admin) matches are trusted.
    const protectedMatch = m.is_verified === true || (m.matched_by_admin != null && m.matched_by_admin !== '');
    if (!protectedMatch && ing) {
      const analysis = analyzeNameMatch(deal.name, ing.name);
      if (!analysis.matched && analysis.rejectReason) {
        suspiciousCount += 1;
        suspiciousRaw.push({
          dealId: deal.id,
          ingredientId: m.recipe_ingredient_id,
          dealName: deal.name,
          ingredientName: ing.name,
          recipeName: recipeById.get(ing.recipe_id)?.name ?? '',
          score,
          reason: analysis.rejectReason,
        });
      }
    }
  }

  const kpis: OfferQualityKpis = {
    activeDeals: activeDeals.length,
    currentDeals: currentDeals.length,
    futureDeals: futureDeals.length,
    matchableDeals: matchableDeals.length,
    activeRecipes: recipes.length,
    recipeIngredients: ingredients.length,
    validDealMatches,
    recipesWithValidDeals: recipesWithValidDeals.size,
    ingredientsWithValidDeals: ingredientsWithValidDeals.size,
    expiredMatches,
    futureMatches,
    lowScoreMatches,
    highConfidenceMatches,
    reviewMatches,
    suspiciousMatches: suspiciousCount,
    matchCoveragePercent: pct(ingredientsWithValidDeals.size, ingredients.length),
    recipeCoveragePercent: pct(recipesWithValidDeals.size, recipes.length),
  };

  const topUnmatchedDeals = buildUnmatchedDeals(matchableDeals, matchedDealIds, listLimit);
  const topUnmatchedIngredients = buildUnmatchedIngredients(
    ingredients,
    matchedIngredientIds,
    recipeById,
    listLimit,
  );
  const reviewCandidates = buildReviewCandidates(reviewRaw, listLimit);
  const suspiciousMatches = buildSuspiciousMatches(suspiciousRaw, listLimit);
  const warnings = buildWarnings(kpis, matches.length);

  return {
    kpis,
    topUnmatchedDeals,
    topUnmatchedIngredients,
    reviewCandidates,
    suspiciousMatches,
    warnings,
  };
}

function buildUnmatchedDeals(
  matchableDeals: QualityDeal[],
  matchedDealIds: Set<string>,
  listLimit: number,
): UnmatchedDeal[] {
  return matchableDeals
    .filter((d) => !matchedDealIds.has(d.id))
    .slice()
    .sort((a, b) => {
      const sa = Number(a.savings_percent ?? 0);
      const sb = Number(b.savings_percent ?? 0);
      if (sb !== sa) return sb - sa; // higher discount first
      if (a.current_price !== b.current_price) return a.current_price - b.current_price; // cheaper first
      return b.valid_to.localeCompare(a.valid_to); // longer validity first
    })
    .slice(0, listLimit)
    .map((d) => ({
      id: d.id,
      name: d.name,
      storeName: d.store_name ?? null,
      price: d.current_price,
      validTo: d.valid_to,
      category: d.category ?? null,
      reason: 'no_recipe_ingredient_match' as const,
    }));
}

function buildUnmatchedIngredients(
  ingredients: QualityIngredient[],
  matchedIngredientIds: Set<string>,
  recipeById: Map<string, QualityRecipe>,
  listLimit: number,
): UnmatchedIngredient[] {
  // Condense duplicate names so "Tomaten" doesn't fill the whole list. Each
  // group keeps a representative (preferring an is_potential_deal ingredient)
  // and a count. First-seen order is preserved for stability.
  const groups = new Map<string, { rep: QualityIngredient; count: number }>();
  for (const ing of ingredients) {
    if (matchedIngredientIds.has(ing.id)) continue;
    const key = ingredientGroupKey(ing.name);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { rep: ing, count: 1 });
    } else {
      existing.count += 1;
      if (!existing.rep.is_potential_deal && ing.is_potential_deal) existing.rep = ing;
    }
  }

  return [...groups.values()]
    .sort((a, b) => {
      const pa = a.rep.is_potential_deal ? 1 : 0;
      const pb = b.rep.is_potential_deal ? 1 : 0;
      if (pb !== pa) return pb - pa; // potential-deal ingredients first
      return b.count - a.count; // then the most-repeated
    })
    .slice(0, listLimit)
    .map(({ rep, count }) => ({
      id: rep.id,
      recipeId: rep.recipe_id,
      recipeName: recipeById.get(rep.recipe_id)?.name ?? '',
      ingredientName: rep.name,
      count,
      reason: 'no_active_deal_match' as const,
    }));
}

function buildReviewCandidates(reviewRaw: ReviewCandidate[], listLimit: number): ReviewCandidate[] {
  // Collapse the same product/ingredient pair (by name) to its lowest score so
  // the list shows distinct review items, not the same combo many times.
  const byPair = new Map<string, ReviewCandidate>();
  for (const c of reviewRaw) {
    const key = `${c.dealName.toLowerCase()}|${c.ingredientName.toLowerCase()}`;
    const existing = byPair.get(key);
    if (!existing || c.score < existing.score) byPair.set(key, c);
  }
  return [...byPair.values()].sort((a, b) => a.score - b.score).slice(0, listLimit);
}

function buildSuspiciousMatches(raw: SuspiciousMatch[], listLimit: number): SuspiciousMatch[] {
  // Dedupe by (dealName|ingredientName), keep the lowest score example. Sort
  // derived_product first (the clearest false positives), then by score asc.
  const byPair = new Map<string, SuspiciousMatch>();
  for (const s of raw) {
    const key = `${s.dealName.toLowerCase()}|${s.ingredientName.toLowerCase()}`;
    const existing = byPair.get(key);
    if (!existing || s.score < existing.score) byPair.set(key, s);
  }
  const reasonRank: Record<SuspiciousMatch['reason'], number> = {
    derived_product: 0,
    no_head_noun: 1,
    no_ingredient_tokens: 2,
  };
  return [...byPair.values()]
    .sort((a, b) => reasonRank[a.reason] - reasonRank[b.reason] || a.score - b.score)
    .slice(0, listLimit);
}

function buildWarnings(kpis: OfferQualityKpis, totalMatches: number): string[] {
  const warnings: string[] = [];
  if (kpis.activeDeals === 0) {
    warnings.push('Keine aktiven Deals (valid_to >= heute).');
  } else if (kpis.matchableDeals === 0) {
    warnings.push('Aktive Deals vorhanden, aber keine matchbaren (Food + Preis + Gültigkeit).');
  }
  // Honest hint for the Sunday/nextWeek state: active deals exist, but none has
  // started yet — Cheffity-current is legitimately empty (not a data error).
  if (kpis.activeDeals > 0 && kpis.currentDeals === 0 && kpis.futureDeals > 0) {
    warnings.push(
      `Keine aktuellen (current) Deals — ${kpis.futureDeals} zukünftige (nächste Woche) warten auf den Start.`,
    );
  }
  if (kpis.activeRecipes === 0) warnings.push('Keine aktiven Rezepte.');
  else if (kpis.recipeIngredients === 0) warnings.push('Aktive Rezepte ohne Zutaten.');
  if (totalMatches === 0) {
    warnings.push('deal_recipe_matches ist leer — lief der Matcher schon?');
  } else if (kpis.validDealMatches === 0) {
    warnings.push('deal_recipe_matches vorhanden, aber keine gültigen (Deal abgelaufen/non-food/zukünftig).');
  }
  if (kpis.futureMatches > 0) {
    warnings.push(
      `${kpis.futureMatches} Matches zeigen auf zukünftige (nächste Woche) Deals — aus Cheffity-current ausgeschlossen.`,
    );
  }
  if (kpis.suspiciousMatches > 0) {
    warnings.push(
      `${kpis.suspiciousMatches} verdächtige Matches (Derived-Produkt/kein Head-Noun) — als False-Positive prüfen.`,
    );
  }
  return warnings;
}

/** A zero report for the not-configured / failed-query case (no fake KPIs). */
export function emptyOfferQualityReport(): OfferQualityReport {
  return computeOfferQuality({ deals: [], recipes: [], ingredients: [], matches: [] });
}

// ---------------------------------------------------------------------------
// IO wrapper (thin)
// ---------------------------------------------------------------------------

const DEAL_COLUMNS =
  'id, name, store_name, current_price, savings_percent, valid_from, valid_to, is_food, category';

// PostgREST caps a single response at the server `max-rows` setting (commonly
// 1000 on Supabase). A bare `.limit(10000)` is silently truncated to that cap,
// and WITHOUT an explicit `.order(...)` the returned slice is in arbitrary
// physical/insertion order — so a freshly-synced batch of active deals can fall
// entirely outside the window while only old expired rows come back. We page
// through every table with a stable order so counts never depend on table size.
const PAGE_SIZE = 1000;
// `.in('id', [...])` chunk size for back-filling expired, match-referenced deals.
const ID_CHUNK = 300;

interface PagedResponse {
  data: unknown;
  error: { message: string } | null;
}

/**
 * Page through a table with `.range()` until a short page is returned, so the
 * full result is read regardless of the server `max-rows` cap. The caller's
 * `fetchPage` MUST apply a stable `.order(...)` or pages may overlap/skip.
 */
async function fetchAllPaged(
  label: string,
  fetchPage: (from: number, to: number) => PromiseLike<PagedResponse>,
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await fetchPage(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

/** Fetch specific deals by id (chunked) — used to back-fill expired deals that a
 *  match still references, so `expiredMatches` stays correct without loading the
 *  entire historical deals table. */
async function fetchDealsByIds(
  client: SupabaseClient,
  ids: string[],
): Promise<Record<string, unknown>[]> {
  if (ids.length === 0) return [];
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const { data, error } = await client.from('deals').select(DEAL_COLUMNS).in('id', chunk);
    if (error) throw new Error(`deals(by id): ${error.message}`);
    if (Array.isArray(data)) out.push(...(data as Record<string, unknown>[]));
  }
  return out;
}

/** Resolve a German (de) label from a jsonb name value. */
function resolveLangName(raw: unknown): string {
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

export function isOfferQualityConfigured(): boolean {
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
 * Fetch the rows and compute the report. Thin IO; throws on a Supabase error so
 * the caller can decide how to surface it (the endpoint degrades fail-soft).
 */
export async function getCheffityOfferQuality(
  client: SupabaseClient,
  options: OfferQualityOptions = {},
): Promise<OfferQualityReport> {
  const now = options.now ?? new Date();
  const today = toDateOnly(now);

  // Read strategy (size-independent):
  //  • active/current/future deals via `valid_to >= today` — always fully paged
  //    in, so they can NEVER be pushed out of the window by old expired rows.
  //  • recipes / ingredients / matches — fully paged in (each could also exceed
  //    the server max-rows cap).
  //  • expired deals are NOT bulk-loaded; only the ones a match still references
  //    are back-filled by id afterwards (needed for `expiredMatches`).
  const [activeDealRows, recipeRows, ingredientRows, matchRows] = await Promise.all([
    fetchAllPaged('deals', (from, to) =>
      client
        .from('deals')
        .select(DEAL_COLUMNS)
        .gte('valid_to', today)
        .order('id', { ascending: true })
        .range(from, to),
    ),
    fetchAllPaged('recipes', (from, to) =>
      client
        .from('recipes')
        .select('id, name')
        .eq('status', 'active')
        .order('id', { ascending: true })
        .range(from, to),
    ),
    fetchAllPaged('recipe_ingredients', (from, to) =>
      client
        .from('recipe_ingredients')
        .select('id, recipe_id, name, is_potential_deal, recipes!inner(status)')
        .eq('recipes.status', 'active')
        .order('id', { ascending: true })
        .range(from, to),
    ),
    fetchAllPaged('deal_recipe_matches', (from, to) =>
      client
        .from('deal_recipe_matches')
        .select('deal_id, recipe_ingredient_id, match_score, is_verified, matched_by_admin')
        .order('deal_id', { ascending: true })
        .order('recipe_ingredient_id', { ascending: true })
        .range(from, to),
    ),
  ]);

  // Back-fill the expired deals that matches still point at (so expiredMatches is
  // exact) without dragging the whole historical table into the report.
  const activeDealIds = new Set(activeDealRows.map((r) => String(r.id)));
  const missingDealIds = [
    ...new Set(
      matchRows
        .map((r) => String(r.deal_id))
        .filter((id) => id && !activeDealIds.has(id)),
    ),
  ];
  const expiredDealRows = await fetchDealsByIds(client, missingDealIds);
  const dealRows = [...activeDealRows, ...expiredDealRows];

  const deals: QualityDeal[] = dealRows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id),
      name: String(r.name ?? ''),
      store_name: (r.store_name as string | null) ?? null,
      current_price: Number(r.current_price ?? 0),
      savings_percent: r.savings_percent == null ? null : Number(r.savings_percent),
      valid_from: (r.valid_from as string | null) ?? null,
      valid_to: String(r.valid_to ?? ''),
      is_food: r.is_food as boolean | null,
      category: (r.category as string | null) ?? null,
    };
  });

  const recipes: QualityRecipe[] = recipeRows.map((row) => {
    const r = row as Record<string, unknown>;
    return { id: String(r.id), name: resolveLangName(r.name) };
  });

  const ingredients: QualityIngredient[] = ingredientRows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id),
      recipe_id: String(r.recipe_id),
      name: resolveLangName(r.name),
      is_potential_deal: r.is_potential_deal !== false,
    };
  });

  const matches: QualityMatch[] = matchRows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      deal_id: String(r.deal_id),
      recipe_ingredient_id: String(r.recipe_ingredient_id),
      match_score: Number(r.match_score ?? 0),
      is_verified: r.is_verified === true,
      matched_by_admin: (r.matched_by_admin as string | null) ?? null,
    };
  });

  // Pass the same `now` we filtered deals with, so the date boundary is consistent.
  return computeOfferQuality({ deals, recipes, ingredients, matches }, { ...options, now });
}

/**
 * Convenience entrypoint for server.ts: builds the Service-Role client and runs
 * the report. Returns null when Supabase is not configured.
 */
export async function runCheffityOfferQuality(
  options: OfferQualityOptions = {},
): Promise<OfferQualityReport | null> {
  const client = getClient();
  if (!client) return null;
  return getCheffityOfferQuality(client, options);
}
