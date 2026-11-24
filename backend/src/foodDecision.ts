// Zentrale, nachvollziehbare Food-/Non-Food-Entscheidung — die EINE Wahrheit,
// die jede beteiligte Stelle (Phase-1-Split, Phase-2-Kandidaten, finaler
// Gate-/Rescue-Pass, Store Completeness, Store Import Health, Scan Report)
// benutzt. Vorher urteilten Gate, Rescue und Report mit voneinander
// abweichenden Parallelregeln (der Gate vertraute Modell-Flags, der Rescue
// nur Regel-Belegen) — das erzeugte die widersprüchliche Diagnostik
// (likelyFoodWronglyFilteredCount=0 trotz hunderter Review-Fälle) und das
// Gate-/Rescue-Pingpong.
//
// Bewusst KEINE Produkt-/Marken-Allowlist und KEINE shop- oder
// kalenderwochenabhängige Sonderregel: die Entscheidung kommt ausschließlich
// aus den regelbasierten Signalwegen in offersStrictFoodFilter (gelernte
// Allow/Block-Regeln, harte strukturelle Non-Food-/Food-Belege,
// vertrauenswürdige Quellabteilung). Pure (kein IO), daher trivially testbar.
//
// Entscheidungspriorität (Task „Entscheidungspriorität"):
//   1. Menschlicher Lock / manuelle Entscheidung — ein reiner BEWEGUNGS-Schutz
//      (das Angebot wird nie verschoben), KEIN Food-Verdikt; daher hier bewusst
//      NICHT in classifyFoodDecision, sondern als Guard im Reconciliation-Pass.
//   2. Learned Allow  → confirmed_food   (menschliche Freigabe gewinnt vor allem)
//      Learned Block  → confirmed_non_food (steckt in hasRuleConfirmedNonFoodSignal)
//   3. Harte strukturelle Non-Food-Belege (Regel, NIE das Modell-Flag allein):
//      nonfood-Tag, starkes Non-Food-Keyword/Brand, Python-Keyword-Reasons,
//      Kontext-/Botanik-/Einheiten-/Kategorie-/Quellabteilungs-Signale.
//   4. Harte strukturelle Food-Belege: Food-Domänenvokabular, Food-Tag.
//   5. Vertrauenswürdige Food-Quellabteilung (in hasStrongFoodSignal enthalten).
//   6./7. Sonst: uncertain — nie blind Food oder Non-Food. Ein reines
//      Modell-Non-Food-Flag ohne Regel-Beleg ist damit UNCERTAIN (Phase 2 prüft
//      es erneut), nicht confirmed_non_food — so werden Celebrations/Rama/
//      Cerealien nicht allein wegen fehlendem Keyword als Non-Food behandelt.

import type { Offer } from '../../src/types/models';
import { isLockedOrManual } from './offerProductIntelligence';
import { normalizeText } from '../../src/utils/offers';
import { isNameQualityFragment } from './nameQualityQuarantine';
import {
  hasMultiSignalFoodEvidence,
  hasNonFoodTag,
  hasRuleConfirmedNonFoodSignal,
  hasStrongFoodSignal,
  isManuallyAllowedFoodOffer,
} from './offersStrictFoodFilter';
import { allStoresScope, isChainInScope, type ScanV2Scope } from './scanV2Scope';

/** Die drei zentralen Entscheidungswerte. */
export type FoodDecision = 'confirmed_food' | 'confirmed_non_food' | 'uncertain';

/**
 * Zentrale Drei-Wege-Food-Entscheidung für EIN Angebot. Reiner Food-Verdikt —
 * berücksichtigt bewusst KEINEN Lock und KEINE Fragment-Quarantäne; das sind
 * orthogonale Bewegungs-Guards, die der Reconciliation-Pass anwendet (ein
 * gesperrtes Non-Food bleibt non-food, wird aber nie verschoben).
 *
 * Reihenfolge spiegelt die Entscheidungspriorität: menschliche Allow-Freigabe
 * gewinnt, dann der harte Regel-Non-Food-Beleg (schlägt ein essbares Signal —
 * Ziersalbei/Blume bleibt Non-Food), dann der harte Regel-Food-Beleg, sonst
 * uncertain.
 */
export function classifyFoodDecision(offer: Offer): FoodDecision {
  if (isManuallyAllowedFoodOffer(offer)) {
    return 'confirmed_food';
  }
  if (hasRuleConfirmedNonFoodSignal(offer)) {
    return 'confirmed_non_food';
  }
  if (hasStrongFoodSignal(offer)) {
    return 'confirmed_food';
  }
  // Provenienz des nonfood-Tags (Task P1): ein ISOLIERTES, nicht strukturell
  // belegtes Modell-/Legacy-/Browser-Import-Tag ist KEIN harter Regelbeleg mehr
  // (es steht nicht in hasRuleConfirmedNonFoodSignal). Starke Food-Belege oben
  // reparieren es daher (Karottini → confirmed_food). OHNE jedes Food-Signal
  // bleibt es konservativ confirmed_non_food — es wurde irgendwann als Non-Food
  // markiert und trägt kein Food-Indiz, das einen Live-Auftritt rechtfertigt.
  if (hasNonFoodTag(offer)) {
    return 'confirmed_non_food';
  }
  // Task P1 — strukturelle Mehrsignal-Evidenz: ein unsicherer (gefilterter oder
  // sichtbarer) Fall ohne Regel-Non-Food-Beleg, ohne nonfood-Tag und ohne
  // einzelnes hartes Food-Signal darf NUR dann confirmed_food werden, wenn MEHRERE
  // unabhängige strukturelle Belege zusammenkommen (foodFlag=food + ≥2 von
  // Einheit/Quellabteilung/Food-Kategorie). foodFlag allein reicht nie; der
  // Spritzring-Fall (nur Food-Kategorie + foodFlag, Stück-Einheit) bleibt uncertain.
  if (hasMultiSignalFoodEvidence(offer)) {
    return 'confirmed_food';
  }
  return 'uncertain';
}

/** True für ein editorial gesperrtes / manuell entschiedenes Angebot. Re-Export
 *  als zentraler Bewegungs-Guard, damit Aufrufer eine Quelle nutzen. */
export function isMovementLocked(offer: Offer): boolean {
  return isLockedOrManual(offer);
}

/** Tag der HARTEN Fragment-Quarantäne (quarantineFragmentOffers) — Promo-/
 *  Packungs-/Beschreibungs-Schrottnamen, dürfen nie live. Bleibt sticky. */
const FRAGMENT_TAG = 'name_fragment';

/**
 * True, wenn das Angebot ein Fragment/Section-Header/Namensqualitäts-Fragment ist
 * (harter Promo-/Packungs-Schrottname über das sticky `name_fragment`-Tag oder ein
 * generisches Namensqualitäts-Fragment wie ein isoliertes Attributwort — Task P2).
 * Das `name_quality`-Tag wird hier NICHT mehr direkt geprüft, sondern über
 * {@link isNameQualityFragment} re-validiert — sonst bliebe ein falsch persistiertes
 * name_quality-Tag auf einem echten Ein-Wort-Produkt (z. B. „Gewichte") dauerhaft
 * als Fragment hängen und die Diagnostik (summarizeFoodDecisions vs.
 * summarizeReviewQueue) liefe auseinander. Solche Einträge sind weder Food noch
 * Non-Food, sondern Namensmüll: nie live zeigen, nie an die KI senden, nie retten.
 */
export function isFragmentOrSectionHeader(offer: Offer): boolean {
  if ((offer.tags ?? []).some((tag) => normalizeText(tag) === FRAGMENT_TAG)) {
    return true;
  }
  return isNameQualityFragment(offer);
}

// ---------------------------------------------------------------------------
// Ehrliche Diagnostik (Task „Ehrliche Diagnostik")
// ---------------------------------------------------------------------------

/** Max Beispielnamen je Counter — nie riesige Listen. */
const MAX_DECISION_EXAMPLES = 8;

export interface FoodDecisionBuckets {
  offers: readonly Offer[];
  nextWeekOffers: readonly Offer[];
  filteredOffers: readonly Offer[];
}

export interface FoodDecisionSummaryOptions {
  /** Ob ein gefiltertes Angebot zeitlich noch gültig ist (für wrongFoodFiltered).
   *  Ohne Predicate gilt jedes Angebot als gültig (konservativ: meldet eher). */
  isTimeValid?: (offer: Offer) => boolean;
  maxExamples?: number;
}

/**
 * Ehrliche, zentrale Aufschlüsselung der Snapshot-Buckets nach der EINEN
 * Food-Entscheidung — ersetzt die irreführende „filteredCount = Non-Food"- und
 * „likelyFoodWronglyFiltered=0 nach dem Rescue"-Diagnostik:
 *
 *   confirmedFoodVisibleCount     sichtbares confirmed_food (current+next)
 *   confirmedNonFoodFilteredCount gefiltertes confirmed_non_food (erklärt, korrekt)
 *   uncertainFilteredCount        gefiltertes uncertain = die echten Review-Fälle
 *   uncertainVisibleCount         sichtbares uncertain (live, aber unbelegt)
 *   nonFoodLeakCount              confirmed_non_food, das fälschlich LIVE liegt
 *   wrongFoodFilteredCount        confirmed_food, das zeitlich gültig im Filter
 *                                 verbleibt — MUSS nach der Reconciliation 0 sein;
 *                                 > 0 ⇒ echter Bug (Qualitäts-Gate blockiert).
 *
 * Locks und Fragmente sind Bewegungs-Guards: ein gesperrtes/fragmentiertes
 * Angebot zählt nie als Leak oder wrongFoodFiltered.
 */
export interface FoodDecisionSummary {
  confirmedFoodVisibleCount: number;
  confirmedNonFoodFilteredCount: number;
  uncertainFilteredCount: number;
  uncertainVisibleCount: number;
  nonFoodLeakCount: number;
  nonFoodLeakExamples: string[];
  wrongFoodFilteredCount: number;
  wrongFoodFilteredExamples: string[];
  uncertainFilteredExamples: string[];
}

function pushExample(list: string[], name: string, max: number): void {
  if (list.length < max && !list.includes(name)) {
    list.push(name);
  }
}

export function summarizeFoodDecisions(
  buckets: FoodDecisionBuckets,
  options: FoodDecisionSummaryOptions = {},
): FoodDecisionSummary {
  const isTimeValid = options.isTimeValid ?? (() => true);
  const max = options.maxExamples ?? MAX_DECISION_EXAMPLES;

  const summary: FoodDecisionSummary = {
    confirmedFoodVisibleCount: 0,
    confirmedNonFoodFilteredCount: 0,
    uncertainFilteredCount: 0,
    uncertainVisibleCount: 0,
    nonFoodLeakCount: 0,
    nonFoodLeakExamples: [],
    wrongFoodFilteredCount: 0,
    wrongFoodFilteredExamples: [],
    uncertainFilteredExamples: [],
  };

  for (const offer of [...buckets.offers, ...buckets.nextWeekOffers]) {
    if (isMovementLocked(offer)) {
      // Menschliche Entscheidung — zählt nach Verdikt, aber nie als Leak.
      if (classifyFoodDecision(offer) === 'confirmed_food') summary.confirmedFoodVisibleCount += 1;
      continue;
    }
    const decision = classifyFoodDecision(offer);
    if (decision === 'confirmed_non_food') {
      summary.nonFoodLeakCount += 1;
      pushExample(summary.nonFoodLeakExamples, offer.name, max);
    } else if (decision === 'confirmed_food') {
      summary.confirmedFoodVisibleCount += 1;
    } else {
      summary.uncertainVisibleCount += 1;
    }
  }

  for (const offer of buckets.filteredOffers) {
    if (isMovementLocked(offer) || isFragmentOrSectionHeader(offer)) {
      summary.confirmedNonFoodFilteredCount += 1;
      continue;
    }
    const decision = classifyFoodDecision(offer);
    if (decision === 'confirmed_non_food') {
      summary.confirmedNonFoodFilteredCount += 1;
    } else if (decision === 'confirmed_food') {
      if (isTimeValid(offer)) {
        summary.wrongFoodFilteredCount += 1;
        pushExample(summary.wrongFoodFilteredExamples, offer.name, max);
      } else {
        // Abgelaufenes confirmed_food bleibt korrekt gefiltert (nie reanimieren).
        summary.confirmedNonFoodFilteredCount += 1;
      }
    } else {
      summary.uncertainFilteredCount += 1;
      pushExample(summary.uncertainFilteredExamples, offer.name, max);
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Review-Dimension (Task F) — strikt getrennt von der FoodDecision-Dimension
// ---------------------------------------------------------------------------
//
// `reviewNeeded` (ein Flag auf dem Angebot) und die FoodDecision (confirmed_food /
// confirmed_non_food / uncertain) sind ZWEI UNABHÄNGIGE Dimensionen und dürfen
// nicht synonym verwendet werden: ein confirmed_food-Angebot kann reviewNeeded
// tragen (z. B. Konflikt-Markierung), ein uncertain-Angebot muss es nicht. Vorher
// las der Report `unresolvedReviewCount` = `uncertainFilteredCount` und mischte so
// beide Dimensionen. Diese Aufschlüsselung berechnet beide getrennt und macht die
// Summen aus den tatsächlichen Buckets nachvollziehbar.

/** True, wenn das Angebot explizit reviewNeeded markiert ist (Flag-Dimension,
 *  NICHT die FoodDecision). */
function isReviewNeeded(offer: Offer): boolean {
  return (offer as Offer & { reviewNeeded?: unknown }).reviewNeeded === true;
}

export interface ReviewDimensionSummary {
  /** Sichtbar (current+next) UND reviewNeeded — offene Review-Fälle im Feed. */
  unresolvedVisibleReviewCount: number;
  /** Gefiltert UND reviewNeeded — offene Review-Fälle im Filter. */
  unresolvedFilteredReviewCount: number;
  /** FoodDecision=uncertain, sichtbar (FoodDecision-Dimension, kein Review-Flag). */
  uncertainVisibleCount: number;
  /** FoodDecision=uncertain, gefiltert. */
  uncertainFilteredCount: number;
  /** FoodDecision=confirmed_non_food UND reviewNeeded (beide Dimensionen wahr). */
  confirmedNonFoodWithReviewCount: number;
  /** FoodDecision=confirmed_food UND reviewNeeded. */
  confirmedFoodWithReviewCount: number;
}

/**
 * Trennt die Review-Flag-Dimension klar von der FoodDecision-Dimension (Task F +
 * P4). Die FoodDecision-Zähler (`uncertainVisibleCount`/`uncertainFilteredCount`)
 * werden NICHT mehr eigenständig berechnet, sondern aus DERSELBEN zentralen
 * {@link summarizeFoodDecisions} übernommen — damit gilt strukturell die
 * Invariante (Task P4):
 *   reviewDimension.uncertainFilteredCount === foodDecisionSummary.uncertainFilteredCount
 *   reviewDimension.uncertainVisibleCount  === foodDecisionSummary.uncertainVisibleCount
 * Insbesondere identische Lock-/Fragment-Behandlung: ein gesperrtes oder
 * fragment-quarantänisiertes gefiltertes Angebot zählt in BEIDEN Dimensionen
 * NICHT als uncertain (es ist ein Bewegungs-Guard = confirmed_non_food-Bucket),
 * statt — wie früher — nur hier. Abgelaufene Angebote beeinflussen die
 * uncertain-Zähler nicht (Zeitvalidität betrifft nur wrongFoodFiltered).
 * Die reinen Review-Flag-Zähler werden weiter aus denselben Buckets berechnet.
 * Pure (kein IO).
 */
export function summarizeReviewDimension(buckets: FoodDecisionBuckets): ReviewDimensionSummary {
  const decisions = summarizeFoodDecisions(buckets);
  const summary: ReviewDimensionSummary = {
    unresolvedVisibleReviewCount: 0,
    unresolvedFilteredReviewCount: 0,
    uncertainVisibleCount: decisions.uncertainVisibleCount,
    uncertainFilteredCount: decisions.uncertainFilteredCount,
    confirmedNonFoodWithReviewCount: 0,
    confirmedFoodWithReviewCount: 0,
  };

  const visitReviewFlag = (offer: Offer, visible: boolean): void => {
    if (!isReviewNeeded(offer)) return;
    if (visible) summary.unresolvedVisibleReviewCount += 1;
    else summary.unresolvedFilteredReviewCount += 1;
    const decision = classifyFoodDecision(offer);
    if (decision === 'confirmed_non_food') summary.confirmedNonFoodWithReviewCount += 1;
    else if (decision === 'confirmed_food') summary.confirmedFoodWithReviewCount += 1;
  };

  for (const offer of [...buckets.offers, ...buckets.nextWeekOffers]) visitReviewFlag(offer, true);
  for (const offer of buckets.filteredOffers) visitReviewFlag(offer, false);

  return summary;
}

// ---------------------------------------------------------------------------
// Aktueller Snapshot-Zustand pro Shop (Task E) — frisch aus den Buckets
// ---------------------------------------------------------------------------
//
// Streng getrennt von der (historischen, unveränderlichen) Import-Zählkette:
// dieser Status wird NACH Phase 2 aus den AKTUELLEN Snapshot-Buckets berechnet,
// nicht aus dem Importbeleg. Die Feldnamen machen die zeitliche Bedeutung
// eindeutig (current/next = aktuell sichtbar; *Filtered = aktuell gefiltert).

export interface ChainSnapshotStatus {
  storeChain: string;
  /** Aktuell sichtbare current-Angebote dieses Shops. */
  current: number;
  /** Aktuell sichtbare next-week-Angebote dieses Shops. */
  nextWeek: number;
  /** Aktuell gefiltertes confirmed_non_food (erklärt, korrekt). */
  confirmedNonFoodFiltered: number;
  /** Aktuell gefiltertes uncertain (Phase-2-Kandidaten). */
  uncertainFiltered: number;
  /** Aktuell gefiltertes, zeitlich gültiges confirmed_food (MUSS 0 sein). */
  wrongFoodFiltered: number;
  /** Aktuell gefiltert UND reviewNeeded. */
  unresolvedReview: number;
}

/**
 * Berechnet den AKTUELLEN Snapshot-Zustand eines Shops frisch aus den Buckets
 * (Task E). Bucket-Zugehörigkeit (offers=current, nextWeekOffers=next) bestimmt
 * sichtbar/gefiltert — es wird NICHT erneut ein Live-Fenster abgeleitet. Pure.
 */
export function computeChainSnapshotStatus(
  buckets: FoodDecisionBuckets,
  storeChain: string,
  options: { isTimeValid?: (offer: Offer) => boolean } = {},
): ChainSnapshotStatus {
  const isTimeValid = options.isTimeValid ?? (() => true);
  const matches = (offer: Offer): boolean =>
    (offer.storeChain ?? '').trim().toLowerCase() === storeChain.trim().toLowerCase();

  const status: ChainSnapshotStatus = {
    storeChain,
    current: buckets.offers.filter(matches).length,
    nextWeek: buckets.nextWeekOffers.filter(matches).length,
    confirmedNonFoodFiltered: 0,
    uncertainFiltered: 0,
    wrongFoodFiltered: 0,
    unresolvedReview: 0,
  };

  for (const offer of buckets.filteredOffers) {
    if (!matches(offer)) continue;
    if (isReviewNeeded(offer)) status.unresolvedReview += 1;
    if (isMovementLocked(offer) || isFragmentOrSectionHeader(offer)) {
      status.confirmedNonFoodFiltered += 1;
      continue;
    }
    const decision = classifyFoodDecision(offer);
    if (decision === 'confirmed_non_food') {
      status.confirmedNonFoodFiltered += 1;
    } else if (decision === 'confirmed_food') {
      if (isTimeValid(offer)) status.wrongFoodFiltered += 1;
      else status.confirmedNonFoodFiltered += 1;
    } else {
      status.uncertainFiltered += 1;
    }
  }

  return status;
}

// ---------------------------------------------------------------------------
// Blockierendes Qualitäts-Gate (Task P1 „Qualitäts-Gate muss wirklich blockieren")
// ---------------------------------------------------------------------------

/** Check-ID des blockierenden Reconciliation-Gates (für Status + Diagnose). */
export type FoodReconciliationCheck = 'foodLeftInFilter';

export interface FoodReconciliationOptions {
  /** Aktiver Shop-Scope dieses Commits. `all_stores` (Default) prüft alle Shops;
   *  ein expliziter Store-Set (z. B. eine REWE-only Phase-2-Reanalyse) prüft NUR
   *  diese Shops — fremde Shops im Filter werden nie geprüft/blockiert. */
  scope?: ScanV2Scope;
  /** Ob ein gefiltertes Angebot zeitlich noch gültig ist. Ohne Predicate gilt
   *  jedes Angebot als gültig (konservativ). Abgelaufenes confirmed_food
   *  blockiert NIE (wird nie reanimiert). */
  isTimeValid?: (offer: Offer) => boolean;
  maxExamples?: number;
}

export interface FoodReconciliationResult {
  /** false ⇒ Commit MUSS blockiert werden (zeitlich gültiges confirmed_food im
   *  Filter), true ⇒ Reconciliation vollständig, Commit erlaubt. */
  ok: boolean;
  /** Zeitlich gültiges confirmed_food, das im Filter verbleibt (scope-bewusst,
   *  Lock + Fragment-Quarantäne ausgenommen). MUSS 0 sein, um zu committen. */
  wrongFoodFilteredCount: number;
  wrongFoodFilteredExamples: string[];
  /** Diagnose: uncertain im Filter blockiert NICHT, wird aber als Hinweis gezählt. */
  uncertainFilteredCount: number;
  failedChecks: FoodReconciliationCheck[];
  reasons: string[];
}

/**
 * Reiner, scope-bewusster PRE-COMMIT-Schutz (Task P1): NACH der vollständigen
 * Reconciliation (Fragment-Gate + Non-Food-Gate + Food-Rescue) darf KEIN zeitlich
 * gültiges confirmed_food mehr im Filtered-Bucket liegen. Verbleibt eines, ist die
 * Reconciliation unvollständig (echter Bug) — der Commit MUSS blockiert werden,
 * damit der vorherige gültige Snapshot erhalten bleibt.
 *
 * Bewusst NICHT blockierend: uncertain (nur Warning/Diagnostik), confirmed_non_food
 * (korrekt gefiltert), abgelaufenes confirmed_food (nie reanimiert), Fragment-
 * Quarantäne und menschliche Locks (orthogonale Bewegungs-Guards). Out-of-scope-
 * Shops werden nie geprüft. Pure (kein IO), mutiert die Eingabe nicht.
 */
export function evaluateFoodReconciliation(
  buckets: Pick<FoodDecisionBuckets, 'filteredOffers'>,
  options: FoodReconciliationOptions = {},
): FoodReconciliationResult {
  const scope = options.scope ?? allStoresScope();
  const isTimeValid = options.isTimeValid ?? (() => true);
  const max = options.maxExamples ?? MAX_DECISION_EXAMPLES;

  let wrongFoodFilteredCount = 0;
  let uncertainFilteredCount = 0;
  const wrongFoodFilteredExamples: string[] = [];

  for (const offer of buckets.filteredOffers) {
    if (!isChainInScope(scope, offer.storeChain)) continue;
    if (isMovementLocked(offer) || isFragmentOrSectionHeader(offer)) continue;
    const decision = classifyFoodDecision(offer);
    if (decision === 'confirmed_food') {
      if (!isTimeValid(offer)) continue; // abgelaufen ⇒ korrekt gefiltert
      wrongFoodFilteredCount += 1;
      pushExample(wrongFoodFilteredExamples, offer.name, max);
    } else if (decision === 'uncertain') {
      uncertainFilteredCount += 1;
    }
  }

  const ok = wrongFoodFilteredCount === 0;
  return {
    ok,
    wrongFoodFilteredCount,
    wrongFoodFilteredExamples,
    uncertainFilteredCount,
    failedChecks: ok ? [] : ['foodLeftInFilter'],
    reasons: ok
      ? []
      : [
          `${wrongFoodFilteredCount} zeitlich gültige(s) confirmed_food-Angebot(e) verbleiben im Filter ` +
            `(z. B. ${wrongFoodFilteredExamples.slice(0, 4).join(', ')}) — Reconciliation unvollständig, Commit blockiert.`,
        ],
  };
}
