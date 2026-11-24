// Angebots-Scan 2.0 — reine Phase-2-Reassembly (Task P2).
//
// Der finale Phase-2-Schritt baute die Snapshot-Buckets bisher inline in
// server.ts zusammen und war damit nur über den vollen (IO-gebundenen) Scan
// testbar. Diese Datei extrahiert AUSSCHLIESSLICH die reine Reassembly-/
// Finalize-Logik — von dem bereits analysierten, kombinierten Food-Universum
// (`restored`) zu den drei Buckets (current / nextWeek / filtered) — damit die
// Phase-2-Recovery (uncertain-filtered → Food/Non-Food, Follower-Übernahme,
// keine Dubletten, Idempotenz) end-to-end unit-testbar wird. Keine
// Architekturänderung: server.ts ruft diese Funktion an genau der Stelle auf,
// an der vorher der Inline-Code stand.
//
// Pure (kein IO): alle Bausteine (splitFoodAndNonFood, splitOffersByLiveWindow,
// quarantineFragmentOffers, applyFinalNonFoodGate, classifyInternationalFood)
// sind selbst rein, daher trivial testbar.

import type { Offer } from '../../src/types/models';
import { normalizeText } from '../../src/utils/offers';
import {
  isPhase2Recheck,
  quarantineFragmentOffers,
  type ScanV2Offer,
} from './offersScanV2';
import { isNonFoodOffer } from './offerProductIntelligence';
import { classifyFoodDecision, isMovementLocked } from './foodDecision';
import { hasUntrustworthyCacheNonFood } from './offersStrictFoodFilter';
import { splitOffersByLiveWindow } from './snapshotLiveWindow';
import { applyFinalNonFoodGate } from './snapshotNonFoodGate';
import { classifyInternationalFood } from './internationalFood';

/** Audit-/Bewegungs-Tag (siehe snapshotFoodRescue/foodDecision). */
const NON_FOOD_TAG = 'nonfood';

/**
 * Bereinigt veraltete Non-Food-Artefakte eines re-analysierten Angebots, das die
 * ZENTRALE Entscheidung jetzt als confirmed_food sieht (Task P2): ein veralteter
 * oder schwacher Cache-Hit kann `foodFlag='nonfood'`, `canonicalCategory.isNonFood`
 * und ein `nonfood`-Tag hinterlassen, die sonst Report/Gate weiter vergiften. Pure
 * + idempotent — ohne Artefakt wird das Original unverändert zurückgegeben. Preis/
 * Gültigkeit/Store/Bild bleiben unberührt.
 */
function clearStalePhase2NonFoodArtifacts(offer: Offer): Offer {
  const o = offer as Offer & {
    foodFlag?: unknown;
    canonicalCategory?: { isNonFood?: unknown; main?: unknown } | unknown;
  };
  const tags = offer.tags ?? [];
  const hasNonFoodTag = tags.some((tag) => normalizeText(tag) === NON_FOOD_TAG);
  const flagNonFood = o.foodFlag === 'nonfood';
  const cc = o.canonicalCategory;
  const ccNonFood =
    !!cc && typeof cc === 'object' && (cc as { isNonFood?: unknown }).isNonFood === true;
  if (!hasNonFoodTag && !flagNonFood && !ccNonFood) {
    return offer;
  }
  const cleaned = { ...o } as Record<string, unknown>;
  if (flagNonFood) cleaned.foodFlag = 'food';
  if (hasNonFoodTag) cleaned.tags = tags.filter((tag) => normalizeText(tag) !== NON_FOOD_TAG);
  if (ccNonFood) {
    cleaned.canonicalCategory = {
      ...(cc as Record<string, unknown>),
      isNonFood: false,
      main: undefined,
    };
  }
  return cleaned as unknown as Offer;
}

/**
 * Food/Non-Food-Split für die Phase-2-Reassembly (Task P2). Für RE-ANALYSIERTE
 * Kandidaten (phase2_recheck-Tag) entscheidet ausschließlich die ZENTRALE
 * {@link classifyFoodDecision}: ein belastbarer struktureller Food-Beleg schlägt
 * einen veralteten/schwachen Cache-Hit mit `canonicalCategory.isNonFood`; nur
 * confirmed_food wird sichtbar (Artefakte bereinigt), uncertain UND
 * confirmed_non_food bleiben gefiltert — ein mehrdeutiges Item wird NIE blind
 * sichtbar, ein strukturell bestätigter Haushaltsgegenstand bleibt Non-Food.
 * Nicht-reanalysierte Angebote (preserved manuelle Importe, Phase-1-Food) behalten
 * exakt das bisherige `isNonFoodOffer`-Verhalten, damit keine Regression entsteht.
 */
function splitRestoredFoodAndNonFood(
  restored: readonly Offer[],
  isPreserved: (offer: Offer) => boolean,
): { food: Offer[]; nonFood: Offer[] } {
  const food: Offer[] = [];
  const nonFood: Offer[] = [];
  for (const offer of restored) {
    if (isPreserved(offer)) {
      // Manueller Import (REWE/nahkauf) bleibt immer sichtbar.
      food.push(offer);
      continue;
    }
    if (isPhase2Recheck(offer) && !isMovementLocked(offer)) {
      const decision = classifyFoodDecision(offer);
      if (decision === 'confirmed_food') {
        food.push(clearStalePhase2NonFoodArtifacts(offer));
      } else if (decision === 'uncertain' && hasUntrustworthyCacheNonFood(offer)) {
        // Task P1: ein veralteter/widersprüchlicher Cache-Non-Food-Hit (cache:hit
        // gegen foodFlag='food', ohne unabhängigen Beleg) bleibt NICHT als
        // confirmed Non-Food persistiert — das Artefakt wird neutralisiert, das
        // Angebot aber ehrlich gefiltert gelassen (downstream reviewNeeded).
        nonFood.push(clearStalePhase2NonFoodArtifacts(offer));
      } else {
        nonFood.push(offer);
      }
      continue;
    }
    if (isNonFoodOffer(offer)) {
      nonFood.push(offer);
    } else {
      food.push(offer);
    }
  }
  return { food, nonFood };
}

/** Lokale id-Deduplizierung (erste Vorkommen gewinnt) — identisch zu server.ts,
 *  damit die Reassembly dieselbe Garantie „kein Angebot doppelt" liefert. */
function dedupeOffersById(offers: Offer[]): Offer[] {
  const seen = new Set<string>();
  const deduped: Offer[] = [];
  for (const offer of offers) {
    if (seen.has(offer.id)) continue;
    seen.add(offer.id);
    deduped.push(offer);
  }
  return deduped;
}

export interface Phase2ReassemblyInput {
  /** Vollständiges, bereits kombiniertes + analysiertes Food-Universum (baseFood
   *  + analyzedFood + analyzedFiltered + Follower + stillNeedAi, inkl. Bild-
   *  Restore). Wird per splitFoodAndNonFood neu in Food/Non-Food getrennt. */
  restored: Offer[];
  /** Bisheriger Filtered-Bucket (snapshot.filteredOffers) — die Original-Kopien
   *  der reanalysierten Angebote werden per id ausgeschlossen (keine Dublette). */
  previousFiltered: Offer[];
  /** In Phase 2 sicher als Non-Food übersprungene Angebote (bleiben filtered). */
  skippedNonFood: Offer[];
  /**
   * Phase-1-NextWeek-Bucket, der in Phase 2 NICHT verarbeitet wird (keine KI,
   * kein Enrichment, keine Re-Klassifikation). Diese Angebote sind NICHT in
   * `restored` enthalten; sie werden unverändert (deep-equal, gleiche Referenz)
   * wieder in den NextWeek-Bucket gestellt, ohne Fragment-/Non-Food-Gate. So
   * bleibt der NextWeek-Bucket erhalten, ohne KI-Kosten zu verursachen. Optional,
   * damit reine Recovery-Tests ohne NextWeek unverändert laufen.
   */
  preservedNextWeek?: Offer[];
  now?: Date;
  /** ISO-Wochen-Fallback für Angebote ohne Datumssignal. */
  weekBucketOf: (offer: Offer) => 'current' | 'next' | 'other';
  /** Manuelle Importe (REWE/nahkauf), die nie verloren gehen dürfen. */
  isPreserved?: (offer: Offer) => boolean;
  maxValidityDays?: number;
}

export interface Phase2ReassemblyResult {
  /** Gated Buckets VOR dem Strip des transienten phase2_recheck-Tags (der
   *  Aufrufer entfernt den Tag nach dem Safety-Gate und persistiert). */
  offers: Offer[];
  nextWeekOffers: Offer[];
  filteredOffers: Offer[];
  /** uncertain-filtered, die Phase 2 als Food zurückgeholt hat. */
  phase2RecoveredFoodCount: number;
  /** uncertain-filtered, die Phase 2 als Non-Food bestätigt hat (bleiben filtered). */
  phase2ConfirmedNonFoodCount: number;
  /** Distinct Fragmentnamen, die in die Review-Quarantäne verschoben wurden. */
  quarantinedFragmentNames: string[];
  nonFoodGateMovedCount: number;
  nonFoodGateMovedExamples: string[];
}

/**
 * Reine Phase-2-Reassembly: trennt das analysierte Food-Universum in sichtbares
 * Food + neu erkanntes Non-Food, splittet Food zeitlich gültig in current/next,
 * quarantänisiert Fragmentnamen, schließt die Original-Filter-Kopien der
 * reanalysierten Angebote per id aus und wendet den finalen Non-Food-Gate an.
 * Garantiert: jedes Angebot landet in GENAU EINEM Bucket (id-dedupe + id-
 * Ausschluss), reanalysierte Kandidaten verschwinden aus dem alten Filter, und
 * ein erneuter Lauf über das Ergebnis ist idempotent.
 */
export function reassemblePhase2Buckets(input: Phase2ReassemblyInput): Phase2ReassemblyResult {
  const { restored, previousFiltered, skippedNonFood } = input;

  // In Food (sichtbar) + Non-Food/uncertain (filtered) aufteilen — re-analysierte
  // Kandidaten über die ZENTRALE classifyFoodDecision (Task P2), damit ein
  // veralteter/schwacher Cache-Non-Food-Flag einen belastbaren Food-Beleg nicht
  // überstimmt und uncertain nie blind sichtbar wird.
  const splitFood = splitRestoredFoodAndNonFood(restored, input.isPreserved ?? (() => false));
  const foodWithIntl = splitFood.food.map((offer) => ({
    ...(offer as ScanV2Offer),
    internationalFood: classifyInternationalFood(offer),
  }));
  // live/next nach echter Gültigkeit am Scan-Datum, manuelle Importe preserved.
  const liveSplit = splitOffersByLiveWindow(dedupeOffersById(foodWithIntl), {
    now: input.now ?? new Date(),
    weekBucketOf: input.weekBucketOf,
    isPreserved: input.isPreserved ?? (() => false),
    maxValidityDays: input.maxValidityDays,
  });
  // Fragment-Quarantäne: Fragmentnamen nie live, nur filtered.
  const fragCurrent = quarantineFragmentOffers(liveSplit.current);
  const fragNext = quarantineFragmentOffers(liveSplit.next);
  const quarantinedFragmentNames = [
    ...new Set([...fragCurrent.quarantined, ...fragNext.quarantined].map((offer) => offer.name)),
  ];

  const phase2RecoveredFoodCount = splitFood.food.filter(isPhase2Recheck).length;
  const phase2ConfirmedNonFoodCount = splitFood.nonFood.filter(isPhase2Recheck).length;

  // Die Original-Kopien der reanalysierten Angebote (jetzt in `restored`) werden
  // per id aus dem alten Filter ausgeschlossen, damit kein Angebot gleichzeitig
  // sichtbar UND gefiltert auftaucht.
  const analyzedIds = new Set(restored.map((offer) => offer.id));
  const nextFilteredOffers = dedupeOffersById([
    ...previousFiltered.filter((offer) => !analyzedIds.has(offer.id)),
    ...skippedNonFood,
    ...splitFood.nonFood,
    ...fragCurrent.quarantined,
    ...fragNext.quarantined,
  ]);

  // Finaler Non-Food-Gate (wie Phase 1): kein starkes Non-Food in current/next.
  const nonFoodGate = applyFinalNonFoodGate({
    offers: fragCurrent.clean,
    nextWeekOffers: fragNext.clean,
    filteredOffers: nextFilteredOffers,
  });

  // NextWeek läuft NICHT durch Phase 2: der unveränderte Phase-1-NextWeek-Bucket
  // wird (de-dupliziert, ohne Gate/Quarantäne anzufassen) wieder vorangestellt.
  // Die preserved Angebote sind nicht in `restored`, daher keine echte Dublette;
  // dedupeOffersById gibt dieselben Referenzen zurück → deep-equal erhalten.
  const preservedNextWeek = input.preservedNextWeek ?? [];
  const nextWeekOffers = dedupeOffersById([...preservedNextWeek, ...nonFoodGate.nextWeekOffers]);

  return {
    offers: nonFoodGate.offers,
    nextWeekOffers,
    filteredOffers: nonFoodGate.filteredOffers,
    phase2RecoveredFoodCount,
    phase2ConfirmedNonFoodCount,
    quarantinedFragmentNames,
    nonFoodGateMovedCount: nonFoodGate.movedCount,
    nonFoodGateMovedExamples: nonFoodGate.movedExamples,
  };
}
