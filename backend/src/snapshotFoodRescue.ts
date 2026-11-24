// Finaler Food-Rescue-Pass über den Filtered-Bucket (Gegenstück zum
// Non-Food-Gate in snapshotNonFoodGate.ts): echte Lebensmittel, die das Modell
// fälschlich als Non-Food in `filteredOffers` einsortiert hat (der Kaufland-
// Fall "41 offizielle Food-Angebote im Filtered-Bucket"), werden regelbasiert
// zurück in `offers`/`nextWeekOffers` verschoben.
//
// Läuft als letzter Pass NACH der Non-Food-Reparatur und VOR jedem
// Persistieren (saveSnapshot), für alle Shops gleichermaßen. Pure (kein IO,
// keine Mutation der Inputs), daher trivially unit-testable.
//
// Entscheidungsregeln (bewusst OHNE Modell-Verdikte und ohne Produktlisten):
//   keep   — ein REGEL-Beleg sagt Non-Food (nonfood-Tag, starkes Keyword,
//            Python-Keyword-Reason, TS-Regel-Check ohne Modell-Flags), oder das
//            Angebot ist editorial gesperrt / Fragment-Quarantäne.
//   rescue — kein Regel-Non-Food-Beleg UND ein starkes, strukturelles
//            Food-Signal (Food-Kategorie, Food-Domänenvokabular, Händler-
//            Quellabteilung, Food-Tag) — oder eine menschliche Allow-Freigabe.
//   review — weder Non-Food-Beleg noch Food-Signal: NIE blind retten, sondern
//            reviewNeeded markieren, damit der Fall im Report erklärt ist.
//
// Der Ziel-Bucket folgt der vorhandenen Gültigkeits-/Wochenlogik
// (classifyLiveWindow + injizierter ISO-Wochen-Fallback) — nie einer
// hardcodierten Kalenderwoche. Abgelaufene Angebote werden nie reanimiert.

import type { Offer } from '../../src/types/models';
import { normalizeText } from '../../src/utils/offers';
import { classifyLiveWindow } from './snapshotLiveWindow';
import {
  classifyFoodDecision,
  isFragmentOrSectionHeader,
  isMovementLocked,
} from './foodDecision';

/** Traceable canonical reason stamped onto every rescued offer. */
export const FOOD_RESCUE_REASON = 'repair:food_rescue';

/** Tag carried by every rescued offer, so Report/Admin can explain the move. */
export const FOOD_RESCUE_TAG = 'food_rescue';

/** reviewReason for filtered offers with neither non-food proof nor food signal. */
export const FOOD_RESCUE_REVIEW_REASON = 'food_filtered_unconfirmed';

/** reviewReason für einen früher (fälschlich) geretteten Eintrag, der bei der
 *  erneuten Reconciliation nicht mehr confirmed_food ist und daher zurück in den
 *  Filter wandert (Task P3). */
export const RESCUE_REVERTED_REVIEW_REASON = 'rescue_reverted_uncertain';

/** Max example names surfaced in warnings/reports (never huge lists). */
const MAX_RESCUE_EXAMPLES = 8;

export type FoodRescueVerdict = 'rescue' | 'keep' | 'review';

export interface FoodRescueBuckets {
  offers: Offer[];
  nextWeekOffers: Offer[];
  filteredOffers: Offer[];
}

export interface FoodRescueOptions {
  now?: Date;
  /** ISO-week bucket fallback for offers with no date signal (`unknown`). */
  weekBucketOf?: (offer: Offer) => 'current' | 'next' | 'other';
  maxValidityDays?: number;
}

export interface FoodRescueResult extends FoodRescueBuckets {
  /** Offers moved out of `filteredOffers` back into the visible buckets. */
  rescuedCount: number;
  rescuedToCurrentCount: number;
  rescuedToNextCount: number;
  /** Up to {@link MAX_RESCUE_EXAMPLES} distinct names of rescued offers. */
  rescuedExamples: string[];
  /** Filtered offers left in review state (no proof either way). */
  reviewNeededCount: number;
  reviewNeededExamples: string[];
}

type RescueOffer = Offer & {
  foodFlag?: string;
  reviewNeeded?: boolean;
  reviewReason?: string;
  canonicalCategory?: {
    main?: string;
    sub?: string;
    isNonFood?: boolean;
    confidence?: number;
    reasons?: unknown;
  };
};

/**
 * Verdict for ONE filtered offer — abgeleitet aus der ZENTRALEN
 * {@link classifyFoodDecision}, damit Rescue, Non-Food-Gate und Report exakt
 * dieselbe Wahrheit nutzen (keine abweichenden Parallelregeln mehr). Die zwei
 * Bewegungs-Guards bleiben hier, weil sie kein Food-Verdikt sind:
 *   keep   — editorial gesperrt / manuell entschieden ODER Fragment/Section-
 *            Header (Namensmüll, nie live), ODER confirmed_non_food.
 *   rescue — confirmed_food (menschliche Allow-Freigabe oder harter Food-Beleg).
 *   review — uncertain: weder Non-Food-Beleg noch starkes Food-Signal — NIE
 *            blind retten, sondern reviewNeeded markieren.
 */
export function classifyFilteredOfferForRescue(offer: Offer): FoodRescueVerdict {
  if (isMovementLocked(offer) || isFragmentOrSectionHeader(offer)) {
    return 'keep';
  }
  switch (classifyFoodDecision(offer)) {
    case 'confirmed_food':
      return 'rescue';
    case 'confirmed_non_food':
      return 'keep';
    default:
      return 'review';
  }
}

/** Dreiteilung des Filtered-Buckets für die Kaufland-Vollständigkeit —
 *  EXAKT nach dem Rescue-Verdict, damit Report und Rescue identisch urteilen:
 *    suspectNames     'rescue'-würdig (starkes Food-Signal), sitzt trotzdem in
 *                     filtered ⇒ echter Verdacht auf falsch gefiltertes Food.
 *    ruleNonFoodNames 'keep' (Regel-Non-Food-Beleg, editorial Lock oder
 *                     Fragment-Quarantäne) ⇒ erklärt, kein Fehler.
 *    unconfirmedNames 'review' (kein Beleg in beide Richtungen) ⇒ nur bei
 *                     offizieller Food-Kategorie ein Verdacht (entscheidet
 *                     buildKauflandCompleteness über foodCategoryConfirmed). */
export interface FilteredCompletenessPartition {
  suspectNames: string[];
  ruleNonFoodNames: string[];
  unconfirmedNames: string[];
}

export function partitionFilteredOffersForCompleteness(
  filteredOffers: readonly Offer[],
): FilteredCompletenessPartition {
  const partition: FilteredCompletenessPartition = {
    suspectNames: [],
    ruleNonFoodNames: [],
    unconfirmedNames: [],
  };
  for (const offer of filteredOffers) {
    const verdict = classifyFilteredOfferForRescue(offer);
    if (verdict === 'rescue') {
      partition.suspectNames.push(offer.name);
    } else if (verdict === 'keep') {
      partition.ruleNonFoodNames.push(offer.name);
    } else {
      partition.unconfirmedNames.push(offer.name);
    }
  }
  return partition;
}

/**
 * Mark a rescued offer honestly as food (mirrors the bridge rescue style):
 * `foodFlag="food"`, `nonfood`-Tag entfernt, `food_rescue`-Tag + traceable
 * reason gesetzt, `canonicalCategory.isNonFood=false` (ein falscher Non-Food-
 * `main` wird geleert, damit er nie zurück in eine Kategorie mappt). Never
 * touches price/validity/store/image data.
 */
function markRescuedFood(offer: RescueOffer): RescueOffer {
  const prior = offer.canonicalCategory ?? {};
  const priorReasons = Array.isArray(prior.reasons) ? prior.reasons : [];
  return {
    ...offer,
    foodFlag: 'food',
    tags: [
      ...new Set([
        ...(offer.tags ?? []).filter((tag) => normalizeText(tag) !== 'nonfood'),
        FOOD_RESCUE_TAG,
      ]),
    ],
    canonicalCategory: {
      ...prior,
      main: undefined,
      isNonFood: false,
      reasons: priorReasons.includes(FOOD_RESCUE_REASON)
        ? priorReasons
        : [...priorReasons, FOOD_RESCUE_REASON],
    },
  };
}

/** Stamp an unsure filtered offer reviewNeeded; never overwrite a prior reason. */
function markFilteredReviewNeeded(offer: RescueOffer): RescueOffer {
  if (offer.reviewNeeded === true) {
    return offer;
  }
  return { ...offer, reviewNeeded: true, reviewReason: FOOD_RESCUE_REVIEW_REASON };
}

/**
 * Final rescue pass over the snapshot buckets: every filtered offer with a
 * strong rule-based food signal (and no rule-confirmed non-food proof) is
 * marked food and moved back into `offers`/`nextWeekOffers` (deduped by id);
 * the target bucket follows classifyLiveWindow + the injected week fallback.
 * Expired offers are never resurrected. Pure + idempotent — a second run moves
 * nothing and re-stamps nothing.
 */
export function applyFoodRescuePass(
  buckets: FoodRescueBuckets,
  options: FoodRescueOptions = {},
): FoodRescueResult {
  const now = options.now ?? new Date();
  const weekBucketOf = options.weekBucketOf ?? (() => 'current' as const);
  const maxValidityDays = options.maxValidityDays ?? 21;

  const offers: Offer[] = [...buckets.offers];
  const nextWeekOffers: Offer[] = [...buckets.nextWeekOffers];
  const filteredOffers: Offer[] = [];
  const visibleIds = new Set([...offers, ...nextWeekOffers].map((offer) => offer.id));

  let rescuedCount = 0;
  let rescuedToCurrentCount = 0;
  let rescuedToNextCount = 0;
  const rescuedNames: string[] = [];
  let reviewNeededCount = 0;
  const reviewNames: string[] = [];

  for (const offer of buckets.filteredOffers) {
    const verdict = classifyFilteredOfferForRescue(offer);

    if (verdict === 'keep') {
      filteredOffers.push(offer);
      continue;
    }

    if (verdict === 'review') {
      reviewNeededCount += 1;
      reviewNames.push(offer.name);
      filteredOffers.push(markFilteredReviewNeeded(offer as RescueOffer));
      continue;
    }

    // rescue — Ziel-Bucket über die vorhandene Gültigkeits-/Wochenlogik.
    let window = classifyLiveWindow(offer, now, maxValidityDays);
    if (window === 'unknown') {
      window = weekBucketOf(offer);
    }
    if (window === 'other') {
      // Abgelaufen (oder Wochenlogik sagt "weder noch"): nie reanimieren.
      filteredOffers.push(offer);
      continue;
    }

    rescuedCount += 1;
    rescuedNames.push(offer.name);
    if (window === 'next') {
      rescuedToNextCount += 1;
    } else {
      rescuedToCurrentCount += 1;
    }
    if (!visibleIds.has(offer.id)) {
      visibleIds.add(offer.id);
      const rescued = markRescuedFood(offer as RescueOffer);
      if (window === 'next') {
        nextWeekOffers.push(rescued);
      } else {
        offers.push(rescued);
      }
    }
  }

  return {
    offers,
    nextWeekOffers,
    filteredOffers,
    rescuedCount,
    rescuedToCurrentCount,
    rescuedToNextCount,
    rescuedExamples: [...new Set(rescuedNames)].slice(0, MAX_RESCUE_EXAMPLES),
    reviewNeededCount,
    reviewNeededExamples: [...new Set(reviewNames)].slice(0, MAX_RESCUE_EXAMPLES),
  };
}

// ---------------------------------------------------------------------------
// Stale-Rescue-Reconciliation (Task P3) — der food_rescue-Tag ist ein AUDIT-Tag,
// kein dauerhafter Food-Beweis. Ein sichtbares Angebot, das den Tag trägt, aber
// bei erneuter Bewertung NICHT mehr confirmed_food ist (z. B. ein mehrdeutiger
// Einwortname „Gold"/„Auslese", den ein früherer Lauf blind gerettet hat), wird
// hier wieder in den Filter verschoben und reviewNeeded markiert. So korrigiert
// sich ein falsch geretteter Eintrag bei jedem Gate/Scan selbst.
// ---------------------------------------------------------------------------

export interface RescueReconciliationResult extends FoodRescueBuckets {
  /** Offers moved back out of the visible buckets into `filteredOffers`. */
  revertedCount: number;
  /** Up to {@link MAX_RESCUE_EXAMPLES} distinct names of reverted offers. */
  revertedExamples: string[];
}

/**
 * True for a VISIBLE offer that carries the `food_rescue` audit tag but no longer
 * classifies as `confirmed_food` (uncertain or — defensively — non-food). The tag
 * itself is never a food proof (classifyFoodDecision ignores it), so such an offer
 * is a stale/blind rescue that must move back to filtered/review. Locked/manual
 * offers are a movement guard and are never reverted.
 */
export function isStaleRescue(offer: Offer): boolean {
  if (isMovementLocked(offer)) {
    return false;
  }
  if (!(offer.tags ?? []).some((tag) => normalizeText(tag) === FOOD_RESCUE_TAG)) {
    return false;
  }
  return classifyFoodDecision(offer) !== 'confirmed_food';
}

/** Strip the audit tag and mark reviewNeeded — the rescue is undone honestly. */
function markRevertedRescue(offer: RescueOffer): RescueOffer {
  return {
    ...offer,
    tags: (offer.tags ?? []).filter((tag) => normalizeText(tag) !== FOOD_RESCUE_TAG),
    reviewNeeded: true,
    reviewReason: offer.reviewNeeded === true ? offer.reviewReason : RESCUE_REVERTED_REVIEW_REASON,
  };
}

/**
 * Reconciliation-Pass über die SICHTBAREN Buckets (Task P3): jeder früher
 * geretteter Eintrag (food_rescue-Tag), der nicht mehr confirmed_food ist, wird
 * zurück in `filteredOffers` verschoben (deduped by id), der Audit-Tag entfernt
 * und reviewNeeded gesetzt. Pure + idempotent — ein zweiter Lauf bewegt nichts,
 * weil der zurückverschobene Eintrag den Tag nicht mehr trägt. Legitime
 * confirmed_food-Rettungen behalten Tag und Sichtbarkeit.
 */
export function revertStaleRescues(buckets: FoodRescueBuckets): RescueReconciliationResult {
  const filteredOffers: Offer[] = [...buckets.filteredOffers];
  const filteredIds = new Set(filteredOffers.map((offer) => offer.id));
  const revertedNames: string[] = [];
  let revertedCount = 0;

  const sift = (liveOffers: readonly Offer[]): Offer[] => {
    const kept: Offer[] = [];
    for (const offer of liveOffers) {
      if (!isStaleRescue(offer)) {
        kept.push(offer);
        continue;
      }
      revertedCount += 1;
      revertedNames.push(offer.name);
      if (!filteredIds.has(offer.id)) {
        filteredIds.add(offer.id);
        filteredOffers.push(markRevertedRescue(offer as RescueOffer));
      }
    }
    return kept;
  };

  const offers = sift(buckets.offers);
  const nextWeekOffers = sift(buckets.nextWeekOffers);

  return {
    offers,
    nextWeekOffers,
    filteredOffers,
    revertedCount,
    revertedExamples: [...new Set(revertedNames)].slice(0, MAX_RESCUE_EXAMPLES),
  };
}
