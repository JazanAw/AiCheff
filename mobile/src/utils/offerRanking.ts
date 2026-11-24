// Hybrid, rule-based ranking for offers/deals (V1, deterministic).
//
// Instead of "highest discount first" we blend several signals into one score
// and attach explainable reason tags. Everything is pure + side-effect free so
// it unit-tests without Supabase. Missing/poor data degrades the affected
// sub-score to 0 (or applies a small quality penalty) — it never throws.
//
// OfferScore = value + personalRelevance + pantryRecipeFit + storeDistance
//            + expiryUrgency + trend + novelty − fatigue − dataQuality
//
// Data actually used on the client: savingsPercent/Absolute,
// validTo/validFrom, distanceKm/isNational, trendScore + product_trend terms,
// deal-favorites, weekly-plan/recipe missing ingredients, shopping list.
// NOT available client-side: offer_history price-vs-history (valueScore uses
// the discount fields only).

import { normalizeFoodName } from './pantryMatch';

export type OfferReasonTag =
  | 'big_discount'
  | 'good_value'
  | 'favorite'
  | 'on_your_list'
  | 'fits_recipe'
  | 'nearby'
  | 'expiring_soon'
  | 'trending'
  | 'new_this_week';

/** Minimal shape the scorer needs — a superset is fine (e.g. the full Deal). */
export interface RankableOffer {
  id: string;
  /** Wochenstabile Artikel-Identitaet (article_v3). `id` bezeichnet EIN
   *  Haendler-Angebot und wechselt bei Lidl/ALDI NORD woechentlich; nur hierueber
   *  erkennt ein Favorit dasselbe Produkt in der naechsten Woche wieder. */
  articleId?: string;
  name: string;
  savingsPercent?: number;
  savingsAbsolute?: number;
  currentPrice?: number;
  imageUrl?: string;
  validFrom?: string;
  validTo?: string;
  distanceKm?: number;
  isNational?: boolean;
  trendScore?: number;
}

export interface OfferRankContext {
  /** Favourited deal ids (current week). */
  favoriteIds?: Set<string>;
  /** Artikel-Ids der Favoriten. Traegt den Favoriten ueber den Wochenwechsel:
   *  `favoriteIds` greift nur, solange der Haendler dieselbe Angebots-id
   *  vergibt (gemessen 2026-08-17: ALDI NORD 14 %, Lidl 0 von 3). */
  favoriteArticleIds?: Set<string>;
  /** Normalized trend terms from product_trend_30d (see dealTrendsApi). */
  trendTerms?: Set<string>;
  /** Ingredient names still needed by the weekly plan / popular recipes. */
  neededIngredientNames?: string[];
  /** Names currently on the user's open shopping list. */
  shoppingListNames?: string[];
  /** Fatigue: how often a product (normalized name) was recently shown on top. */
  recentSeenCounts?: Map<string, number>;
  /** Override "now" for deterministic tests. */
  now?: Date;
  /** Search radius (km) used to normalize distance; defaults to 15. */
  searchRadiusKm?: number;
}

export interface ScoredOffer<D extends RankableOffer> {
  offer: D;
  score: number;
  reasons: OfferReasonTag[];
}

// Positive weights roughly sum to ~110; penalties subtract. Tunable in one
// place (feature-flag friendly). Keep value dominant but never the only thing.
export const OFFER_WEIGHTS = {
  value: 30,
  personalRelevance: 24,
  pantryRecipeFit: 20,
  storeDistance: 8,
  expiryUrgency: 6,
  trend: 12,
  novelty: 6,
  fatiguePenalty: 14,
  dataQualityPenalty: 10,
} as const;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function daysUntil(dateIso: string | undefined, now: Date): number | null {
  if (!dateIso) return null;
  const d = new Date(dateIso);
  if (Number.isNaN(d.getTime())) return null;
  return (d.getTime() - now.getTime()) / 86400000;
}

function nameMatches(normalizedName: string, candidates: string[] | undefined): boolean {
  if (!normalizedName || !candidates || candidates.length === 0) return false;
  for (const raw of candidates) {
    const other = normalizeFoodName(raw);
    if (!other) continue;
    if (normalizedName === other || normalizedName.includes(other) || other.includes(normalizedName)) {
      return true;
    }
  }
  return false;
}

function termMatches(normalizedName: string, terms: Set<string> | undefined): boolean {
  if (!normalizedName || !terms || terms.size === 0) return false;
  for (const term of terms) {
    if (term.length >= 4 && normalizedName.includes(term)) return true;
  }
  return false;
}

/**
 * Score a single offer in [roughly −24, +110] and collect reason tags. Pure.
 * Each component is normalized to 0..1 then weighted; penalties subtract.
 */
export function scoreOffer<D extends RankableOffer>(
  offer: D,
  context: OfferRankContext = {},
): ScoredOffer<D> {
  const now = context.now ?? new Date();
  const radius = context.searchRadiusKm && context.searchRadiusKm > 0 ? context.searchRadiusKm : 15;
  const normName = normalizeFoodName(offer.name ?? '');
  const reasons: OfferReasonTag[] = [];

  // 1) value — discount % blended with absolute saving (no history client-side).
  const pct = Number.isFinite(offer.savingsPercent) ? (offer.savingsPercent as number) : 0;
  const abs = Number.isFinite(offer.savingsAbsolute) ? (offer.savingsAbsolute as number) : 0;
  const pctNorm = clamp01(pct / 50); // 50%+ saturates
  const absNorm = clamp01(abs / 4); // 4€+ saturates
  const valueNorm = clamp01(0.7 * pctNorm + 0.3 * absNorm);
  if (pct >= 30) reasons.push('big_discount');
  else if (valueNorm >= 0.4) reasons.push('good_value');

  // 2) personal relevance — favourite (strongest) or on the shopping list.
  let personalNorm = 0;
  const isFavorite =
    context.favoriteIds?.has(offer.id) === true ||
    (offer.articleId !== undefined && context.favoriteArticleIds?.has(offer.articleId) === true);
  if (isFavorite) {
    personalNorm = 1;
    reasons.push('favorite');
  } else if (nameMatches(normName, context.shoppingListNames)) {
    personalNorm = 0.7;
    reasons.push('on_your_list');
  }

  // 3) pantry/recipe fit — offer covers a still-needed ingredient.
  let fitNorm = 0;
  if (nameMatches(normName, context.neededIngredientNames)) {
    fitNorm = 1;
    reasons.push('fits_recipe');
  }

  // 4) store distance — nearer is better; national (no distance) stays neutral,
  //    never hard-punished.
  let distanceNorm = 0.5;
  if (Number.isFinite(offer.distanceKm)) {
    const km = offer.distanceKm as number;
    distanceNorm = clamp01(1 - km / radius);
    if (km <= 5) reasons.push('nearby');
  } else if (offer.isNational) {
    distanceNorm = 0.5; // explicit: national offers are fine, not penalised
  }

  // 5) expiry urgency — small nudge for soon-expiring, never panic.
  let expiryNorm = 0;
  const dleft = daysUntil(offer.validTo, now);
  if (dleft !== null && dleft >= 0) {
    if (dleft <= 1) expiryNorm = 1;
    else if (dleft <= 2) expiryNorm = 0.6;
    else if (dleft <= 3) expiryNorm = 0.3;
    if (dleft <= 2) reasons.push('expiring_soon');
  }

  // 6) trend — backend trendScore (0..100) or a matching aggregated trend term.
  let trendNorm = 0;
  if (Number.isFinite(offer.trendScore) && (offer.trendScore as number) > 0) {
    trendNorm = clamp01((offer.trendScore as number) / 100);
  }
  if (trendNorm < 0.5 && termMatches(normName, context.trendTerms)) {
    trendNorm = Math.max(trendNorm, 0.7);
  }
  if (trendNorm > 0) reasons.push('trending');

  // 7) novelty — started within the last few days.
  let noveltyNorm = 0;
  const startedDaysAgo = (() => {
    const d = daysUntil(offer.validFrom, now);
    return d === null ? null : -d; // positive = days since start
  })();
  if (startedDaysAgo !== null && startedDaysAgo >= 0 && startedDaysAgo <= 3) {
    noveltyNorm = clamp01(1 - startedDaysAgo / 3);
    reasons.push('new_this_week');
  }

  // 8) fatigue penalty — shown on top repeatedly.
  let fatigueNorm = 0;
  const seen = context.recentSeenCounts?.get(normName) ?? 0;
  if (seen > 0) fatigueNorm = clamp01(seen / 3);

  // 9) data-quality penalty — conservative downgrade for incomplete offers.
  let dqNorm = 0;
  if (!offer.imageUrl) dqNorm += 0.4;
  if (!Number.isFinite(offer.currentPrice) || (offer.currentPrice as number) <= 0) dqNorm += 0.4;
  if (pct <= 0 && abs <= 0) dqNorm += 0.2;
  dqNorm = clamp01(dqNorm);

  const score =
    valueNorm * OFFER_WEIGHTS.value +
    personalNorm * OFFER_WEIGHTS.personalRelevance +
    fitNorm * OFFER_WEIGHTS.pantryRecipeFit +
    distanceNorm * OFFER_WEIGHTS.storeDistance +
    expiryNorm * OFFER_WEIGHTS.expiryUrgency +
    trendNorm * OFFER_WEIGHTS.trend +
    noveltyNorm * OFFER_WEIGHTS.novelty -
    fatigueNorm * OFFER_WEIGHTS.fatiguePenalty -
    dqNorm * OFFER_WEIGHTS.dataQualityPenalty;

  return { offer, score: Math.round(score * 100) / 100, reasons };
}

/**
 * Rank offers by the hybrid score (descending). Stable: original order breaks
 * ties. Returns scored entries (offer + score + reasons). Pure.
 */
export function rankOffers<D extends RankableOffer>(
  offers: D[],
  context: OfferRankContext = {},
): ScoredOffer<D>[] {
  const scored = offers.map((offer, index) => ({ ...scoreOffer(offer, context), index }));
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index));
  return scored.map(({ offer, score, reasons }) => ({ offer, score, reasons }));
}

// ─── Mixed "Für dich" feed (Part C) ────────────────────────────────────────
//
// A diverse top section instead of a pure score list: pick the best offer for
// each intent bucket, in priority order, never repeating an offer. Falls back
// to score order to fill the remaining slots.

export type OfferFeedBucket =
  | 'personal'
  | 'recipe'
  | 'trending'
  | 'expiring'
  | 'new'
  | 'value';

const BUCKET_ORDER: OfferFeedBucket[] = [
  'personal',
  'recipe',
  'value',
  'trending',
  'new',
  'expiring',
];

function bucketReason(bucket: OfferFeedBucket): OfferReasonTag {
  switch (bucket) {
    case 'personal':
      return 'favorite';
    case 'recipe':
      return 'fits_recipe';
    case 'trending':
      return 'trending';
    case 'expiring':
      return 'expiring_soon';
    case 'new':
      return 'new_this_week';
    case 'value':
      return 'big_discount';
  }
}

/**
 * Build a diverse top feed: one best offer per intent bucket (in priority
 * order), de-duplicated, then score-order fills up to `limit`. Pure.
 */
export function buildMixedOfferFeed<D extends RankableOffer>(
  offers: D[],
  context: OfferRankContext = {},
  limit = 6,
): ScoredOffer<D>[] {
  const ranked = rankOffers(offers, context);
  const used = new Set<string>();
  const out: ScoredOffer<D>[] = [];

  for (const bucket of BUCKET_ORDER) {
    if (out.length >= limit) break;
    const wantReason = bucketReason(bucket);
    const pick = ranked.find((r) => !used.has(r.offer.id) && r.reasons.includes(wantReason));
    if (pick) {
      used.add(pick.offer.id);
      out.push(pick);
    }
  }
  // Fill remaining slots with the best leftover by score.
  for (const r of ranked) {
    if (out.length >= limit) break;
    if (!used.has(r.offer.id)) {
      used.add(r.offer.id);
      out.push(r);
    }
  }
  return out;
}
