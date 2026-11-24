// Finaler Non-Food-Gate/Repair über die Snapshot-Buckets (globaler
// Datenqualitäts-Fix): Non-Food darf NIE in `offers` oder `nextWeekOffers`
// live bleiben — auch nicht, wenn das Modell eine Food-Kategorie
// ("Grundnahrungsmittel" für Puppe/Matratze/Kleidung) halluziniert hat.
//
// Läuft als letzter Pass über alle drei Buckets, bevor ein Snapshot
// committed/gespeichert wird (Scan 1.0, Scan 2.0 Phase 1 + Phase 2, Boot).
// Pure (kein IO, keine Mutation der Inputs), daher trivially unit-testable.
//
// Bewusst KEINE Produktlisten: die Erkennung kommt ausschließlich aus den
// regelbasierten Signalwegen in offersStrictFoodFilter (Domänen-Vokabular,
// nonfood-Tags, Kontext-/Einheiten-Signale, kanonische Non-Food-Flags).
// Menschliche Entscheidungen gewinnen immer: editorial gesperrte/manuell
// geprüfte Angebote und die learned-Allow-Liste werden nie verschoben.

import type { Offer } from '../../src/types/models';
import { classifyFoodDecision, isMovementLocked } from './foodDecision';

/** Traceable canonical reason stamped onto every offer the gate moves. */
export const NON_FOOD_GATE_REASON = 'repair:final_gate';

/** Max example names surfaced in warnings/reports (never huge lists). */
const MAX_LEAK_EXAMPLES = 8;

export interface NonFoodGateBuckets {
  offers: Offer[];
  nextWeekOffers: Offer[];
  filteredOffers: Offer[];
}

export interface NonFoodGateResult extends NonFoodGateBuckets {
  /** Offers moved out of the live buckets into `filteredOffers`. */
  movedCount: number;
  /** Up to {@link MAX_LEAK_EXAMPLES} distinct names of moved offers. */
  movedExamples: string[];
}

type GateOffer = Offer & {
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
 * True when a LIVE offer is a strong non-food leak that must move to
 * `filteredOffers`. Nutzt die ZENTRALE {@link classifyFoodDecision} (Gate und
 * Food-Rescue urteilen damit garantiert identisch — kein Pingpong mehr): nur ein
 * REGEL-bestätigtes confirmed_non_food (Domänen-Vokabular, nonfood-Tag, Kontext/
 * Botanik/Einheit/Kategorie/Quellabteilung) verschiebt. Ein reines Modell-Non-
 * Food-Flag ohne Regel-Beleg gilt als uncertain und bleibt live (Phase 2 prüft).
 * Menschliche Overrides (editorial Lock, learned Allow) gewinnen immer und werden
 * nie verschoben.
 */
export function isStrongNonFoodLeak(offer: Offer): boolean {
  if (isMovementLocked(offer)) {
    return false;
  }
  return classifyFoodDecision(offer) === 'confirmed_non_food';
}

/** Count strong non-food leaks in a (visible) bucket, with bounded examples. */
export function findNonFoodLeaks(
  offers: readonly Offer[],
  maxExamples = MAX_LEAK_EXAMPLES,
): { count: number; examples: string[] } {
  let count = 0;
  const examples: string[] = [];
  const seen = new Set<string>();
  for (const offer of offers) {
    if (!isStrongNonFoodLeak(offer)) {
      continue;
    }
    count += 1;
    if (examples.length < maxExamples && !seen.has(offer.name)) {
      seen.add(offer.name);
      examples.push(offer.name);
    }
  }
  return { count, examples };
}

/**
 * Mark a moved offer honestly as non-food: `foodFlag="nonfood"`,
 * `canonicalCategory.isNonFood=true` (a wrong food `main` is cleared so it can
 * never map back into a food category), traceable gate reason, `nonfood` tag.
 * When the model explicitly claimed food (isNonFood === false), the conflict is
 * flagged `reviewNeeded` so it shows up in the admin review. Never touches
 * price/validity/store/image data.
 */
function markGateNonFood(offer: GateOffer): GateOffer {
  const prior = offer.canonicalCategory ?? {};
  const priorReasons = Array.isArray(prior.reasons) ? prior.reasons : [];
  const modelClaimedFood = prior.isNonFood === false;
  const next: GateOffer = {
    ...offer,
    foodFlag: 'nonfood',
    tags: [...new Set([...(offer.tags ?? []), 'nonfood'])],
    canonicalCategory: {
      ...prior,
      main: undefined,
      isNonFood: true,
      reasons: priorReasons.includes(NON_FOOD_GATE_REASON)
        ? priorReasons
        : [...priorReasons, NON_FOOD_GATE_REASON],
    },
  };
  if (modelClaimedFood && next.reviewNeeded !== true) {
    next.reviewNeeded = true;
    next.reviewReason = 'nonfood_gate_conflict';
  }
  return next;
}

/**
 * Final gate/repair pass over all snapshot buckets: every strong non-food leak
 * in `offers`/`nextWeekOffers` is marked non-food and moved into
 * `filteredOffers` (deduped by id). Pure + idempotent — a second run moves
 * nothing. Food, locked/manual and learned-allowed offers stay untouched.
 */
export function applyFinalNonFoodGate(buckets: NonFoodGateBuckets): NonFoodGateResult {
  const filtered: Offer[] = [...buckets.filteredOffers];
  const filteredIds = new Set(filtered.map((offer) => offer.id));
  const movedNames: string[] = [];
  let movedCount = 0;

  const repairBucket = (liveOffers: readonly Offer[]): Offer[] => {
    const kept: Offer[] = [];
    for (const offer of liveOffers) {
      if (!isStrongNonFoodLeak(offer)) {
        kept.push(offer);
        continue;
      }
      movedCount += 1;
      movedNames.push(offer.name);
      if (!filteredIds.has(offer.id)) {
        filteredIds.add(offer.id);
        filtered.push(markGateNonFood(offer as GateOffer));
      }
    }
    return kept;
  };

  const offers = repairBucket(buckets.offers);
  const nextWeekOffers = repairBucket(buckets.nextWeekOffers);

  return {
    offers,
    nextWeekOffers,
    filteredOffers: filtered,
    movedCount,
    movedExamples: [...new Set(movedNames)].slice(0, MAX_LEAK_EXAMPLES),
  };
}
