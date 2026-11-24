// Task P3 — Review-Reduktion ohne falsche Rettung.
//
// Der Filtered-Bucket trägt zu viele offene Review-Fälle (uncertain). Diese reine
// Diagnostik macht TRANSPARENT, welche generischen, HOCHPRÄZISEN strukturellen
// Evidenzklassen einen gefilterten Fall sicher entschieden haben (und ihn damit
// aus dem Review herausgehalten haben) — und welche Fälle ehrlich uncertain
// bleiben. Sie trifft KEINE neue Entscheidung: sie liest ausschließlich die
// ZENTRALE {@link classifyFoodDecision} und ordnet den bereits gefällten Verdikt
// der generischen Regelklasse zu, die ihn getragen hat.
//
// Bewusst KEINE pauschale Rettung aller foodFlag=food, KEINE Produkt-/Marken-
// Allowlist, kein KW-/Shop-Sonderfall: mehrdeutige Kurznamen ("Gold"/"Auslese"/
// "Hausmarke") bleiben `review`. Nur eindeutige Klassen reduzieren Reviews —
// Lebensmittel-Quellabteilung, Food-Domänenvokabular, starke Non-Food-Keywords,
// vertrauenswürdiges Non-Food-Tag, strukturelle Non-Food-Kontexte (Produktklasse/
// Botanik/Einheit/Kategorie). Pure (kein IO), trivially unit-testbar.

import type { Offer } from '../../src/types/models';
import {
  classifyFoodDecision,
  isFragmentOrSectionHeader,
  isMovementLocked,
} from './foodDecision';
import { isNameQualityFragment } from './nameQualityQuarantine';
import {
  hasNonFoodTag,
  hasStrongFoodSourceSignal,
  hasStrongNonFoodSignal,
  hasSuspectFoodEvidence,
  hasUntrustworthyCacheNonFood,
  isManuallyAllowedFoodOffer,
} from './offersStrictFoodFilter';

/** Generische Evidenzklasse, die einen gefilterten Fall entschieden hat (oder
 *  ihn ehrlich als Review belassen hat). */
export type ReviewReductionClass =
  | 'manual_allow'
  | 'food_source_department'
  | 'food_name_vocabulary'
  | 'nonfood_strong_keyword'
  | 'nonfood_tag'
  | 'nonfood_structural_context'
  | 'movement_guard'
  | 'review';

/** Klassen, die einen Review-Fall SICHER entschieden haben (alles außer dem
 *  ehrlich verbleibenden `review`). */
export const REVIEW_RESOLVING_CLASSES: readonly ReviewReductionClass[] = [
  'manual_allow',
  'food_source_department',
  'food_name_vocabulary',
  'nonfood_strong_keyword',
  'nonfood_tag',
  'nonfood_structural_context',
  'movement_guard',
];

/**
 * Ordne EIN gefiltertes Angebot der generischen Evidenzklasse zu, die seinen
 * zentralen Food-Verdikt getragen hat. `review` ⇒ classifyFoodDecision=uncertain:
 * weder Food- noch Non-Food-Beleg, bleibt offener Review-Fall (NIE blind
 * gerettet). Bewegungs-Guards (editorial Lock / Fragment-Quarantäne) sind kein
 * Food-Verdikt und werden separat als `movement_guard` ausgewiesen.
 */
export function classifyReviewReductionClass(offer: Offer): ReviewReductionClass {
  if (isMovementLocked(offer) || isFragmentOrSectionHeader(offer)) {
    return 'movement_guard';
  }
  const decision = classifyFoodDecision(offer);
  if (decision === 'uncertain') {
    return 'review';
  }
  if (decision === 'confirmed_food') {
    if (isManuallyAllowedFoodOffer(offer)) return 'manual_allow';
    if (hasStrongFoodSourceSignal(offer)) return 'food_source_department';
    return 'food_name_vocabulary';
  }
  // confirmed_non_food
  if (hasStrongNonFoodSignal(offer)) return 'nonfood_strong_keyword';
  if (hasNonFoodTag(offer)) return 'nonfood_tag';
  return 'nonfood_structural_context';
}

export interface ReviewReductionClassRow {
  class: ReviewReductionClass;
  count: number;
  examples: string[];
}

export interface ReviewReductionSummary {
  /** Gefilterte Angebote, die ehrlich uncertain bleiben (offener Review-Fall). */
  reviewRemaining: number;
  /** Gefilterte Angebote, die eine generische Evidenzklasse sicher entschieden
   *  hat (und damit aus dem Review herausgehalten hat). */
  resolvedByClassTotal: number;
  /** Pro Evidenzklasse: Anzahl + begrenzte Beispiele (absteigend sortiert). */
  resolvedByClass: ReviewReductionClassRow[];
}

const DEFAULT_MAX_EXAMPLES = 4;

/**
 * Aggregiere den Filtered-Bucket nach Evidenzklasse (Task P3): wie viele Fälle hat
 * jede generische Klasse sicher entschieden, und wie viele bleiben ehrlich Review.
 * Pure; mutiert die Eingabe nicht.
 */
export function summarizeReviewReduction(
  filteredOffers: readonly Offer[],
  maxExamples = DEFAULT_MAX_EXAMPLES,
): ReviewReductionSummary {
  const rows = new Map<ReviewReductionClass, ReviewReductionClassRow>();
  let reviewRemaining = 0;
  let resolvedByClassTotal = 0;

  for (const offer of filteredOffers) {
    const cls = classifyReviewReductionClass(offer);
    if (cls === 'review') {
      reviewRemaining += 1;
      continue;
    }
    resolvedByClassTotal += 1;
    let row = rows.get(cls);
    if (!row) {
      row = { class: cls, count: 0, examples: [] };
      rows.set(cls, row);
    }
    row.count += 1;
    if (row.examples.length < maxExamples && !row.examples.includes(offer.name)) {
      row.examples.push(offer.name);
    }
  }

  const resolvedByClass = [...rows.values()].sort(
    (a, b) => b.count - a.count || a.class.localeCompare(b.class),
  );
  return { reviewRemaining, resolvedByClassTotal, resolvedByClass };
}

// ---------------------------------------------------------------------------
// Task P4 — Review-Report nutzbarer machen: die offenen Review-Fälle nach KLASSE
// getrennt ausweisen, damit ein Cache-Konflikt (Spritzring) und ein Namens-
// fragment (kernarm) nicht in derselben Liste wie echte unsichere Lebensmittel
// landen. Reine Diagnostik über die ZENTRALE classifyFoodDecision +
// hasUntrustworthyCacheNonFood + isNameQualityFragment — keine neue Entscheidung,
// keine Produkt-/Marken-Liste.
// ---------------------------------------------------------------------------

/** Trennklasse der offenen Review-Queue (Task P4). */
export type ReviewQueueClass =
  | 'food_like' // uncertain, Modell stimmt für Food — verdächtig falsch gefiltert
  | 'nonfood_like' // uncertain, ohne Food-Votum — eher Non-Food, aber unbelegt
  | 'name_quality' // Fragment/isoliertes Attributwort — kein echtes Angebot
  | 'cache_conflict'; // veralteter Non-Food-Cache vs. eigenes foodFlag=food

/**
 * Ordne EIN gefiltertes Angebot seiner Review-Queue-Klasse zu — oder `null`, wenn
 * es KEIN offener Review-Fall ist (menschlicher Lock, oder bereits sicher
 * entschieden: confirmed_food/confirmed_non_food ohne Cache-Konflikt). Reihenfolge:
 *   1. Lock          → null (menschliche Entscheidung, kein offener Review)
 *   2. name_quality  → Namensfragment (kernarm) — vor allem anderen, damit es nie
 *                      in der Food-/Non-Food-Liste landet
 *   3. cache_conflict→ untrustworthy Cache-Non-Food + uncertain (Spritzring)
 *   4. sonst nur uncertain → food_like / nonfood_like je nach Modell-Votum
 */
export function classifyReviewQueueClass(offer: Offer): ReviewQueueClass | null {
  if (isMovementLocked(offer)) {
    return null;
  }
  if (isNameQualityFragment(offer)) {
    return 'name_quality';
  }
  const decision = classifyFoodDecision(offer);
  if (hasUntrustworthyCacheNonFood(offer) && decision === 'uncertain') {
    return 'cache_conflict';
  }
  if (decision !== 'uncertain') {
    return null; // sicher entschieden (Food gerettet bzw. Non-Food erklärt)
  }
  // Food-Verdacht statt nur „foodFlag=food": ein unsicherer Fall mit TEILWEISEM
  // strukturellem Food-Indiz (Marke/Bierstil/Food-Einheit+Kategorie/untrustworthy
  // Cache) wird sichtbar als food_like, nicht still als nonfood_like vergraben.
  return hasSuspectFoodEvidence(offer) ? 'food_like' : 'nonfood_like';
}

export interface ReviewQueueClassRow {
  class: ReviewQueueClass;
  count: number;
  examples: string[];
}

export interface ReviewQueueSummary {
  /** Verdächtig falsch gefiltertes Food (uncertain + foodFlag=food). */
  foodLikeReview: ReviewQueueClassRow;
  /** Unsichere Fälle ohne Food-Votum (uncertain, eher Non-Food). */
  nonFoodLikeReview: ReviewQueueClassRow;
  /** Namensqualitäts-/Fragmentfälle (kernarm) — NIE in der Food-Liste. */
  nameQualityReview: ReviewQueueClassRow;
  /** Cache-Konflikte (Spritzring) — explizit als solche ausgewiesen. */
  cacheConflictReview: ReviewQueueClassRow;
  /** Pro Store + Klasse: Top-Review-Gründe (absteigend, begrenzt). */
  byStoreAndClass: Array<{ storeChain: string; class: ReviewQueueClass; count: number }>;
}

const REVIEW_QUEUE_EXAMPLES_MAX = 4;
const REVIEW_QUEUE_STORE_ROWS_MAX = 12;

/**
 * Teile den Filtered-Bucket in die vier Review-Queue-Klassen (Task P4) — getrennte
 * Anzeige von food-like / non-food-like / name-quality / cache-conflict, je mit
 * begrenzten Beispielen, plus eine Top-Liste „Store × Klasse". Die uncertain-
 * Klassen (food_like + nonfood_like + cache_conflict) summieren sich exakt zu
 * `summarizeFoodDecisions().uncertainFilteredCount` (name_quality ist ein
 * Bewegungs-Guard und zählt dort als confirmed_non_food). Pure.
 */
export function summarizeReviewQueue(
  filteredOffers: readonly Offer[],
  maxExamples = REVIEW_QUEUE_EXAMPLES_MAX,
): ReviewQueueSummary {
  const rows: Record<ReviewQueueClass, ReviewQueueClassRow> = {
    food_like: { class: 'food_like', count: 0, examples: [] },
    nonfood_like: { class: 'nonfood_like', count: 0, examples: [] },
    name_quality: { class: 'name_quality', count: 0, examples: [] },
    cache_conflict: { class: 'cache_conflict', count: 0, examples: [] },
  };
  const storeMap = new Map<string, { storeChain: string; class: ReviewQueueClass; count: number }>();

  for (const offer of filteredOffers) {
    const cls = classifyReviewQueueClass(offer);
    if (!cls) {
      continue;
    }
    const row = rows[cls];
    row.count += 1;
    if (row.examples.length < maxExamples && !row.examples.includes(offer.name)) {
      row.examples.push(offer.name);
    }
    const storeChain = (offer.storeChain ?? '').trim() || 'Unbekannt';
    const key = `${storeChain}::${cls}`;
    const storeRow = storeMap.get(key) ?? { storeChain, class: cls, count: 0 };
    storeRow.count += 1;
    storeMap.set(key, storeRow);
  }

  const byStoreAndClass = [...storeMap.values()]
    .sort((a, b) => b.count - a.count || a.storeChain.localeCompare(b.storeChain, 'de'))
    .slice(0, REVIEW_QUEUE_STORE_ROWS_MAX);

  return {
    foodLikeReview: rows.food_like,
    nonFoodLikeReview: rows.nonfood_like,
    nameQualityReview: rows.name_quality,
    cacheConflictReview: rows.cache_conflict,
    byStoreAndClass,
  };
}
