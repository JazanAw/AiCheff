// Post-scan verification report (Task E). Pure aggregation over the snapshot +
// the optional official/Kaufland completeness data, so it is unit-testable and
// reusable by server.ts (log + write) and any dashboard. It does NOT fetch
// anything itself — the caller passes in what was scraped + the official counts.

import {
  computeStoreCompleteness,
  type StoreCompletenessInput,
  type StoreCompletenessReport,
} from './storeCompleteness';
import {
  computeStoreImportHealth,
  renderStoreImportHealthMarkdown,
  type StoreImportHealthReport,
} from './storeImportHealth';
import type {
  KauflandCompleteness,
  EdekaImportDiagnostics,
  AldiNordImportDiagnostics,
  AldiSuedImportDiagnostics,
  NahkaufImportDiagnostics,
} from '../../src/services/offersIngest/sourceConnectors/officialSupermarketConnector';
import {
  computeFinalCategoryCorrections,
  type ReweImportReportData,
} from './reweBrowserImport';
import { findNonFoodLeaks } from './snapshotNonFoodGate';
import { classifyFilteredOfferForRescue, FOOD_RESCUE_TAG } from './snapshotFoodRescue';
import {
  summarizeFoodDecisions,
  summarizeReviewDimension,
  computeChainSnapshotStatus,
  type FoodDecisionSummary,
  type ReviewDimensionSummary,
  type ChainSnapshotStatus,
} from './foodDecision';
import { classifyLiveWindow } from './snapshotLiveWindow';
import {
  summarizeReviewReduction,
  summarizeReviewQueue,
  type ReviewReductionSummary,
  type ReviewQueueSummary,
} from './reviewReductionClasses';
/** Minimaler ALDI-Review-Queue-Summary-Shape (entkoppelt — der manuelle
 *  ALDI-PDF-Import wurde entfernt; das Feld bleibt als inerte Diagnose auf 0). */
interface AldiReviewStoreSummary {
  pending: number;
  approved: number;
  rejected: number;
  committed: number;
}
interface AldiReviewQueueSummary extends AldiReviewStoreSummary {
  total: number;
  byStore: Record<string, AldiReviewStoreSummary>;
}
import type { Offer } from '../../src/types/models';
import type { SubSourceOutcome } from '../../src/services/offersIngest/subSourceDiagnostics';

// ---------------------------------------------------------------------------
// Task P3 — Lauf-Kontext + Diagnose-Frische. Ein Phase-2-only-Lauf führt KEINEN
// neuen REWE-Import / Phase-1-Scrape aus; `reweImport: null` / `subSourceBalance:
// []` bedeuten dann „in diesem Lauf nicht aktualisiert", NICHT „keine Daten /
// alles leer". Diese Felder machen den Zustand ehrlich und strukturiert.
// ---------------------------------------------------------------------------

export type ScanRunContext = 'full' | 'phase1' | 'phase2-only' | 'rewe-browser-import';

/** fresh = in DIESEM Lauf/Prozess frisch erzeugt; not_refreshed = in diesem Lauf
 *  bewusst nicht aktualisiert und keine Daten vorhanden; stale = nicht in diesem
 *  Lauf aktualisiert, aber alte (Snapshot-)Daten vorhanden. */
export type DiagnosticFreshness = 'fresh' | 'not_refreshed' | 'stale';

export interface DiagnosticFreshnessReport {
  runContext: ScanRunContext;
  reweImport: DiagnosticFreshness;
  subSourceBalance: DiagnosticFreshness;
  edeka: DiagnosticFreshness;
  kaufland: DiagnosticFreshness;
}

/** Welche Diagnosen ein Lauf-Kontext überhaupt frisch erzeugt. Ein Phase-2-only-
 *  Lauf aktualisiert keine Phase-1-Diagnose (REWE-Import, Subquellen-Scrape,
 *  EDEKA/Kaufland-Live-Verifikation). KEINE KW-Logik, rein lauftyp-abhängig. */
const REFRESHED_BY_CONTEXT: Record<
  ScanRunContext,
  { reweImport: boolean; subSourceBalance: boolean; edeka: boolean; kaufland: boolean }
> = {
  full: { reweImport: true, subSourceBalance: true, edeka: true, kaufland: true },
  phase1: { reweImport: true, subSourceBalance: true, edeka: true, kaufland: true },
  'phase2-only': { reweImport: false, subSourceBalance: false, edeka: false, kaufland: false },
  'rewe-browser-import': {
    reweImport: true,
    subSourceBalance: false,
    edeka: false,
    kaufland: false,
  },
};

function freshness(refreshedThisRun: boolean, hasData: boolean): DiagnosticFreshness {
  if (refreshedThisRun) {
    return hasData ? 'fresh' : 'not_refreshed';
  }
  return hasData ? 'stale' : 'not_refreshed';
}

/** Berechne die Diagnose-Frische je Lauf-Kontext (Task P3). Pure. */
export function computeDiagnosticFreshness(
  runContext: ScanRunContext,
  present: {
    reweImport: boolean;
    subSourceBalance: boolean;
    edeka: boolean;
    kaufland: boolean;
  },
): DiagnosticFreshnessReport {
  const refreshed = REFRESHED_BY_CONTEXT[runContext];
  return {
    runContext,
    reweImport: freshness(refreshed.reweImport, present.reweImport),
    subSourceBalance: freshness(refreshed.subSourceBalance, present.subSourceBalance),
    edeka: freshness(refreshed.edeka, present.edeka),
    kaufland: freshness(refreshed.kaufland, present.kaufland),
  };
}

const FRESHNESS_LABEL: Record<DiagnosticFreshness, string> = {
  fresh: '🟢 fresh (in diesem Lauf erzeugt)',
  not_refreshed: '⚪ not_refreshed (in diesem Lauf nicht aktualisiert)',
  stale: '🟡 stale (alte Snapshot-/Prozessdaten, in diesem Lauf nicht aktualisiert)',
};

export interface ScanReportInput extends StoreCompletenessInput {
  /** Vollständige Subquellenbilanz des letzten Commit-Versuchs (Task P6) — eine
   *  Zeile je Connector-Subquelle/Prospekt mit Vorher/Nachher/Verlust + Gate-
   *  Entscheidung. Wird vom Safety-Gate (evaluateSnapshotSafety) erzeugt. */
  subSourceOutcomes?: readonly SubSourceOutcome[];
  /** Official-vs-imported comparison for Kaufland (from analyzeKauflandSsr). */
  kauflandCompleteness?: KauflandCompleteness | null;
  /** EDEKA-Import-Diagnose des letzten Laufs (Zählkette + blocked/empty). */
  edeka?: EdekaImportDiagnostics | null;
  /** ALDI-NORD-Import-Diagnose des letzten Laufs (strukturierte Zählkette +
   *  apiData-/blocked-Status). */
  aldiNord?: AldiNordImportDiagnostics | null;
  /** ALDI-SÜD-Import-Diagnose des letzten Laufs (strukturierte Zählkette über die
   *  3 öffentlichen Wochenangebot-Kategorieseiten + per-URL blocked-Status). */
  aldiSued?: AldiSuedImportDiagnostics | null;
  /** nahkauf-Import-Diagnose des letzten Laufs (Storyblok-Zählkette + belegter
   *  source-gap). Ein belegter source-gap hält nahkauf aus criticalStores raus. */
  nahkauf?: NahkaufImportDiagnostics | null;
  /** Quality report from the last REWE PDF/Web import (fragments, prices, …). */
  reweImport?: ReweImportReportData | null;
  /** How the last REWE data was imported (browser bookmarklet vs PDF). */
  reweImportMethod?: 'browser' | 'pdf' | null;
  /** Stores intentionally excluded from the automatic scan (manual import
   *  only) — such a store with zero imported offers is 'excluded'/skipped,
   *  never 'critical'. */
  excludedStores?: readonly string[];
  /** Stores DISABLED by policy (OFFERS_DISABLED_STORES; Default leer) — bewusst
   *  nicht gescannt. Erscheinen im Report als 'disabled', nie 'critical', nie in
   *  criticalStores, ohne Mindestmengen-Warnung. */
  disabledStores?: readonly string[];
  /** Wie der Snapshot zustande kam (Task P3). Steuert die Diagnose-Frische: ein
   *  `phase2-only`-Lauf hat keine Phase-1-Diagnosen frisch erzeugt. Default
   *  `full` (Vollscan) — bestehende Aufrufer bleiben unverändert. */
  runContext?: ScanRunContext;
  /** ALDI-PDF-Review-Queue-Stand (Task 7): pending/approved-not-committed gesamt
   *  + pro Store. Reine Diagnose — treibt NIE criticalStores. */
  aldiPdfReview?: AldiReviewQueueSummary;
  /** Manueller Lidl-Prospekt-Import-Stand: Review-Queue + letzter Import. Reine
   *  Diagnose — der manuelle Import ergänzt den Lidl-Auto-Scan um die preislosen
   *  Frische-Hotspots; diese Zahlen treiben NIE criticalStores und behaupten NIE
   *  eine full-Coverage. */
  lidlManualImport?: LidlManualImportReport;
}

/** Diagnose-Block des manuellen Lidl-Prospekt-Imports (Section 7). Reine
 *  Sichtbarkeit der Review-/Import-Zahlen; keine Coverage-Behauptung. */
export interface LidlManualImportReport {
  /** Vorschläge, die auf eine manuelle Entscheidung warten. */
  queuePending: number;
  /** Bestätigt, aber noch nicht committet (Phase 2 / Commit ausstehend). */
  approvedNotCommitted: number;
  /** Bereits committete (live übernommene) manuelle Lidl-Angebote. */
  committedCount: number;
  /** Zeitpunkt des letzten Vorschlags-Laufs (ISO) oder null. */
  lastImportAt: string | null;
  /** Im letzten Lauf abgerufene Prospektseiten. */
  pagesScanned: number;
  /** Im letzten Lauf erzeugte Vorschläge (vor manueller Entscheidung). */
  candidatesFound: number;
  /** Aufschlüsselung der harten Reject-Gründe der Queue. */
  rejectedByReason: Record<string, number>;
  /** Einträge mit Belegbild (Crop oder Seitenbild). */
  imageEvidenceCount: number;
}

/** Konservativer Default — alles 0, keine Coverage-Behauptung. */
export function emptyLidlManualImportReport(): LidlManualImportReport {
  return {
    queuePending: 0,
    approvedNotCommitted: 0,
    committedCount: 0,
    lastImportAt: null,
    pagesScanned: 0,
    candidatesFound: 0,
    rejectedByReason: {},
    imageEvidenceCount: 0,
  };
}

/** Mindest-Schnittstelle einer Lidl-Review-Queue-Summary (entkoppelt von
 *  lidlReviewQueue.ts, damit scanReport keine Importabhängigkeit aufbaut). */
export interface LidlReviewQueueSummaryLike {
  pending: number;
  approved: number;
  committed: number;
  withCropImageCount: number;
  rejectedByReason: Record<string, number>;
}

export interface LidlManualImportMeta {
  lastImportAt?: string | null;
  pagesScanned?: number;
  candidatesFound?: number;
}

/**
 * Baut den Diagnose-Block aus dem Queue-Summary + den Metadaten des letzten Laufs.
 * Pure. `approvedNotCommitted` = approved (committed wird separat gezählt).
 */
export function buildLidlManualImportReport(
  summary: LidlReviewQueueSummaryLike,
  meta: LidlManualImportMeta = {},
): LidlManualImportReport {
  return {
    queuePending: summary.pending,
    approvedNotCommitted: summary.approved,
    committedCount: summary.committed,
    lastImportAt: meta.lastImportAt ?? null,
    pagesScanned: Math.max(0, meta.pagesScanned ?? 0),
    candidatesFound: Math.max(0, meta.candidatesFound ?? 0),
    rejectedByReason: { ...summary.rejectedByReason },
    imageEvidenceCount: summary.withCropImageCount,
  };
}

export interface FoodRescueStoreRow {
  storeChain: string;
  rescuedCount: number;
  rescuedExamples: string[];
  reviewNeededCount: number;
  reviewNeededExamples: string[];
}

export interface FoodRescueReportSection {
  /** Visible offers carrying the `food_rescue` tag (rescued from filtered). */
  rescuedCount: number;
  /** Filtered offers with neither a rule-confirmed non-food proof nor a strong
   *  food signal — honest review cases, never rescued blindly. */
  reviewNeededFoodFilteredCount: number;
  stores: FoodRescueStoreRow[];
}

export interface ScanReport {
  generatedAt: string;
  completeness: StoreCompletenessReport;
  /** Per-shop import health (Task 3+4): strategy, counts, food/non-food,
   *  broken images, missing estimate and honest REWE web verification. */
  storeImportHealth: StoreImportHealthReport;
  kauflandCompleteness: KauflandCompleteness | null;
  /** EDEKA-Import-Diagnose (Zählkette + blocked/empty) des letzten Laufs. */
  edeka: EdekaImportDiagnostics | null;
  /** ALDI-NORD-Import-Diagnose (strukturierte Zählkette + apiData/blocked). */
  aldiNord: AldiNordImportDiagnostics | null;
  /** ALDI-SÜD-Import-Diagnose (strukturierte Zählkette über 3 Kategorieseiten). */
  aldiSued: AldiSuedImportDiagnostics | null;
  /** nahkauf-Import-Diagnose (Storyblok-Zählkette + belegter source-gap). */
  nahkauf: NahkaufImportDiagnostics | null;
  reweImport: ReweImportReportData | null;
  /** Stores whose completeness can't be trusted (source blocked). */
  blockedStores: string[];
  /** Stores whose import is clearly incomplete/broken. */
  criticalStores: string[];
  /** Clear non-food offers leaked into the VISIBLE buckets (current + next).
   *  After the final non-food gate this must be 0 — anything else means the
   *  repair pass did not run and the scan must not look "ok". */
  nonFoodLeakCount: number;
  /** Bounded example names of leaked offers (never huge lists). */
  nonFoodLeakExamples: string[];
  /** Diagnose: gefilterte Angebote mit STARKEM, regelbasiertem Food-Signal (und
   *  ohne Non-Food-Beleg) — verdächtig fälschlich gefiltertes Lebensmittel. Nach
   *  dem Food-Rescue-Pass über einem frischen Snapshot 0; >0 zeigt, dass der
   *  Rescue (noch) nicht lief oder ein Konflikt ungelöst ist. */
  likelyFoodWronglyFilteredCount: number;
  /** Bounded example names of likely-wrongly-filtered food offers. */
  likelyFoodWronglyFilteredExamples: string[];
  /** Food-Rescue-Sicht: gerettete Lebensmittel (filtered → sichtbar) und
   *  erklärte Review-Fälle im Filtered-Bucket, pro Store mit Beispielen. */
  foodRescue: FoodRescueReportSection;
  /** Ehrliche, ZENTRALE Drei-Wege-Aufschlüsselung (classifyFoodDecision): trennt
   *  confirmed_food / confirmed_non_food / uncertain über sichtbare UND gefilterte
   *  Buckets — ersetzt die irreführende „filteredCount = Non-Food"-Sicht.
   *  `wrongFoodFilteredCount` (zeitlich gültiges confirmed_food im Filter) muss
   *  nach der Reconciliation 0 sein; `uncertainFilteredCount` sind die ehrlich
   *  ausgewiesenen Review-Fälle (kein Food-Verlust-Beweis, aber Phase-2-Kandidat). */
  foodDecisionSummary: FoodDecisionSummary;
  /** Review-Flag-Dimension (Task F) — STRIKT getrennt von der FoodDecision-
   *  Dimension: unresolvedFilteredReviewCount/unresolvedVisibleReviewCount zählen
   *  das `reviewNeeded`-Flag, uncertain*Count die FoodDecision. Aus denselben
   *  Buckets berechnet, daher rechnerisch konsistent. */
  reviewDimension: ReviewDimensionSummary;
  /** AKTUELLER REWE-Snapshot-Zustand (Task E) — frisch aus den Buckets NACH
   *  Phase 2 berechnet, NICHT die (historische) Import-Zählkette in
   *  `reweImport.completeness`. */
  reweSnapshotStatus: ChainSnapshotStatus;
  /** Ungelöste Review-Fälle (Task P4): gefilterte uncertain-Angebote ohne Beleg
   *  in beide Richtungen — Phase-2-Kandidaten, kein Food-Verlust-Beweis. Identisch
   *  zu foodDecisionSummary.uncertainFilteredCount, hier als first-class Feld. */
  unresolvedReviewCount: number;
  /** Task P3 — Review-Reduktion: welche generischen, hochpräzisen Evidenzklassen
   *  gefilterte Fälle SICHER entschieden haben (und damit aus dem Review gehalten
   *  haben), plus die ehrlich verbleibenden Review-Fälle. Reine Diagnostik über
   *  classifyFoodDecision; keine pauschale Rettung, keine Produkt-/Marken-Liste. */
  reviewReduction: ReviewReductionSummary;
  /** Task P4 — offene Review-Fälle nach KLASSE getrennt (food-like / non-food-like
   *  / name-quality / cache-conflict), je mit begrenzten Beispielen + Top „Store ×
   *  Klasse". Ein Cache-Konflikt (Spritzring) und ein Namensfragment (kernarm)
   *  landen so nie in derselben Liste wie echte unsichere Lebensmittel. */
  reviewQueue: ReviewQueueSummary;
  /** Task P3 — Diagnose-Frische je Lauf-Kontext: zeigt ehrlich, dass ein
   *  Phase-2-only-Lauf REWE-Import / Subquellenbilanz NICHT aktualisiert hat
   *  (`not_refreshed`), statt die Felder kontextlos leer zu lassen. */
  diagnosticFreshness: DiagnosticFreshnessReport;
  /** Qualitäts-Gate-Konflikte (Task P1/P4): zeitlich gültiges confirmed_food, das
   *  noch im Filter liegt. `count` MUSS vor einem Commit strukturell 0 sein; >0
   *  ⇒ Reconciliation unvollständig (das Pre-Commit-Gate blockiert). Begrenzte
   *  Beispiele, nie riesige Listen. */
  gateConflicts: { count: number; examples: string[] };
  /** ALDI-PDF-Review-Queue-Stand (Task 7): pending + approved-not-committed gesamt
   *  und pro Store. Reine Diagnose — diese Zahlen treiben NIE criticalStores. */
  aldiPdfReview: AldiReviewQueueSummary;
  /** Manueller Lidl-Prospekt-Import-Stand. Reine Diagnose — Lidl bleibt disabled,
   *  diese Zahlen treiben NIE criticalStores und behaupten NIE full-Coverage. */
  lidlManualImport: LidlManualImportReport;
  /** Vollständige Subquellen-/Prospektbilanz (Task P6): Shop, sourceId/prospectId,
   *  URL/Slug, erwartetes Gültigkeitsfenster, Status, rawCount/resultCount,
   *  vorherige Anzahl, Kandidatenanzahl, Verlustzahl/-quote, Gate-Entscheidung
   *  (committed/blocked/unaffected), strukturierter Fehlercode + betroffener
   *  Gate-Grund. Keine zurückgeparsten Freitextwarnungen. */
  subSourceBalance: SubSourceOutcome[];
}

const FOOD_RESCUE_EXAMPLES_MAX = 4;

/** Aggregate the food-rescue view from the snapshot buckets: rescued offers are
 *  recognised by their `food_rescue` tag, review cases are re-derived from the
 *  same pure verdict the rescue pass uses — so the report stays honest even
 *  over an old snapshot where the pass has not run yet. */
function buildFoodRescueSection(
  offers: Offer[],
  nextWeekOffers: Offer[],
  filteredOffers: Offer[],
): FoodRescueReportSection {
  const byStore = new Map<string, FoodRescueStoreRow>();
  const ensure = (storeChain: string): FoodRescueStoreRow => {
    const chain = storeChain?.trim() || 'Unbekannt';
    let row = byStore.get(chain);
    if (!row) {
      row = {
        storeChain: chain,
        rescuedCount: 0,
        rescuedExamples: [],
        reviewNeededCount: 0,
        reviewNeededExamples: [],
      };
      byStore.set(chain, row);
    }
    return row;
  };

  let rescuedCount = 0;
  for (const offer of [...offers, ...nextWeekOffers]) {
    if (!(offer.tags ?? []).includes(FOOD_RESCUE_TAG)) {
      continue;
    }
    rescuedCount += 1;
    const row = ensure(offer.storeChain);
    row.rescuedCount += 1;
    if (row.rescuedExamples.length < FOOD_RESCUE_EXAMPLES_MAX && !row.rescuedExamples.includes(offer.name)) {
      row.rescuedExamples.push(offer.name);
    }
  }

  let reviewNeededFoodFilteredCount = 0;
  for (const offer of filteredOffers) {
    if (classifyFilteredOfferForRescue(offer) !== 'review') {
      continue;
    }
    reviewNeededFoodFilteredCount += 1;
    const row = ensure(offer.storeChain);
    row.reviewNeededCount += 1;
    if (
      row.reviewNeededExamples.length < FOOD_RESCUE_EXAMPLES_MAX &&
      !row.reviewNeededExamples.includes(offer.name)
    ) {
      row.reviewNeededExamples.push(offer.name);
    }
  }

  const stores = [...byStore.values()].sort(
    (a, b) =>
      b.rescuedCount + b.reviewNeededCount - (a.rescuedCount + a.reviewNeededCount) ||
      a.storeChain.localeCompare(b.storeChain, 'de'),
  );

  return { rescuedCount, reviewNeededFoodFilteredCount, stores };
}

export function buildScanReport(input: ScanReportInput): ScanReport {
  const completeness = computeStoreCompleteness(input);
  // ALDI-PDF-Review-Stand: für die Health-Zeilen pro Store auf {pending, approved}
  // reduzieren (approved = bestätigt, aber noch nicht committet).
  const aldiPdfReview: AldiReviewQueueSummary = input.aldiPdfReview ?? {
    pending: 0,
    approved: 0,
    rejected: 0,
    committed: 0,
    total: 0,
    byStore: {},
  };
  const aldiReviewByStore: Record<string, { pending: number; approved: number }> = {};
  for (const [chain, counts] of Object.entries(aldiPdfReview.byStore)) {
    aldiReviewByStore[chain] = { pending: counts.pending, approved: counts.approved };
  }
  const storeImportHealth = computeStoreImportHealth({
    offers: input.offers,
    nextWeekOffers: input.nextWeekOffers,
    filteredOffers: input.filteredOffers,
    officialCounts: input.officialCounts,
    expectations: input.expectations,
    kauflandCompleteness: input.kauflandCompleteness ?? null,
    edeka: input.edeka ?? null,
    aldiNord: input.aldiNord ?? null,
    aldiSued: input.aldiSued ?? null,
    nahkauf: input.nahkauf ?? null,
    rewe: { report: input.reweImport ?? null, method: input.reweImportMethod ?? null },
    excludedStores: input.excludedStores,
    disabledStores: input.disabledStores,
    aldiReviewByStore,
    lidlReview: input.lidlManualImport
      ? {
          pending: input.lidlManualImport.queuePending,
          approved: input.lidlManualImport.approvedNotCommitted,
        }
      : undefined,
    now: input.now,
  });
  const blockedStores = completeness.stores
    .filter((store) => store.status === 'unverified')
    .map((store) => store.storeChain);
  // criticalStores führt BEIDE Sichten zusammen: die Completeness (zu wenig
  // importiert) UND die Import-Health (z. B. 100 % kaputte Bilder). Vorher
  // zählte nur die Completeness — ein Store mit Status "unverified" konnte
  // importHealth=critical melden und trotzdem aus criticalStores fehlen
  // (der widersprüchliche Netto-Fall: critical in der Tabelle, Report "ok").
  // Per Policy deaktivierte Shops (ALDI SÜD/NORD, Lidl) dürfen NIE in
  // criticalStores landen — sie sind bewusst nicht gescannt (defensiv, falls ein
  // Rest doch in der Completeness auftaucht, bevor der Purge gelaufen ist).
  const disabledKeys = new Set(
    (input.disabledStores ?? []).map((chain) => chain.trim().toLowerCase()),
  );
  const isDisabledChain = (chain: string): boolean =>
    disabledKeys.has(chain.trim().toLowerCase());
  // Belegter nahkauf-source-gap (Storyblok ohne Offer-Stories, „Angebote"-Link
  // auf rewe.de): der Publisher liefert nachweislich nichts — die verfehlte
  // Mindestmengen-Erwartung der Completeness ist dann KEIN Import-Defekt und
  // darf nahkauf nicht in criticalStores heben (die Health-Zeile erklärt die
  // Lage als warning mit source-gap-Text).
  const nahkaufSourceGap = input.nahkauf?.sourceGap === true;
  const isExplainedSourceGapChain = (chain: string): boolean =>
    nahkaufSourceGap && chain.trim().toLowerCase() === 'nahkauf';
  const criticalStores = [
    ...new Set([
      ...completeness.stores
        .filter(
          (store) =>
            store.status === 'critical' &&
            !isDisabledChain(store.storeChain) &&
            !isExplainedSourceGapChain(store.storeChain),
        )
        .map((store) => store.storeChain),
      ...storeImportHealth.stores
        .filter((store) => store.importHealth === 'critical' && !isDisabledChain(store.storeChain))
        .map((store) => store.storeChain),
    ]),
  ];

  // Non-Food-Leaks über den gesamten sichtbaren Feed (current + next): der
  // Report macht sie zentral sichtbar; die Pro-Store-Eskalation (warning/
  // critical) passiert in computeStoreImportHealth.
  const nonFoodLeaks = findNonFoodLeaks([...input.offers, ...input.nextWeekOffers]);

  // Diagnose-Gegenstück: gefilterte Angebote mit starkem Food-Signal (Verdict
  // 'rescue') sind verdächtig fälschlich gefilterte Lebensmittel — dieselbe
  // reine Wahrheit wie der Food-Rescue-Pass, damit Report und Rescue identisch
  // urteilen. Wenige Beispiele, keine riesigen Listen.
  const likelyFoodWronglyFiltered: string[] = [];
  let likelyFoodWronglyFilteredCount = 0;
  for (const offer of input.filteredOffers) {
    if (classifyFilteredOfferForRescue(offer) !== 'rescue') {
      continue;
    }
    likelyFoodWronglyFilteredCount += 1;
    if (likelyFoodWronglyFiltered.length < FOOD_RESCUE_EXAMPLES_MAX && !likelyFoodWronglyFiltered.includes(offer.name)) {
      likelyFoodWronglyFiltered.push(offer.name);
    }
  }

  // Zentrale, ehrliche Drei-Wege-Aufschlüsselung über dieselbe classifyFoodDecision,
  // die Gate/Rescue nutzen. `wrongFoodFiltered` nur für zeitlich gültige Angebote
  // (abgelaufenes confirmed_food wird nie reanimiert und zählt als korrekt
  // gefiltert), damit das Qualitäts-Gate nur echte Food-Verluste blockiert.
  const reportNow = input.now ? new Date(input.now) : new Date();
  const decisionBuckets = {
    offers: input.offers,
    nextWeekOffers: input.nextWeekOffers,
    filteredOffers: input.filteredOffers,
  };
  const isTimeValid = (offer: Offer): boolean =>
    classifyLiveWindow(offer, reportNow) !== 'other';
  const foodDecisionSummary = summarizeFoodDecisions(decisionBuckets, { isTimeValid });
  // Task F: Review-Flag-Dimension getrennt von der FoodDecision-Dimension.
  const reviewDimension = summarizeReviewDimension(decisionBuckets);
  // Task E: aktueller REWE-Snapshot-Zustand, frisch aus den Buckets (nach Phase 2)
  // — getrennt von der historischen Import-Zählkette (reweImport.completeness).
  const reweSnapshotStatus = computeChainSnapshotStatus(decisionBuckets, 'REWE', { isTimeValid });

  // Task P2: die angezeigten Kategorie-Korrekturen aus dem FINALEN persistierten
  // Offer-Zustand neu berechnen — NICHT aus dem (möglicherweise stale) Import-
  // Zwischenstand. Iglo Tiefkühl (bleibt Tiefkühl) / Trollinger (bleibt Alkohol)
  // erzeugen so keine irreführende Korrektur mehr.
  const reweFinalOffers = [
    ...input.offers,
    ...input.nextWeekOffers,
    ...input.filteredOffers,
  ].filter((offer) => (offer.storeChain ?? '').trim().toLowerCase() === 'rewe');
  const reweImport: ReweImportReportData | null = input.reweImport
    ? { ...input.reweImport, categoryCorrections: computeFinalCategoryCorrections(reweFinalOffers) }
    : null;

  return {
    generatedAt: completeness.generatedAt,
    completeness,
    storeImportHealth,
    kauflandCompleteness: input.kauflandCompleteness ?? null,
    edeka: input.edeka ?? null,
    aldiNord: input.aldiNord ?? null,
    aldiSued: input.aldiSued ?? null,
    nahkauf: input.nahkauf ?? null,
    reweImport,
    blockedStores,
    criticalStores,
    nonFoodLeakCount: nonFoodLeaks.count,
    nonFoodLeakExamples: nonFoodLeaks.examples,
    likelyFoodWronglyFilteredCount,
    likelyFoodWronglyFilteredExamples: likelyFoodWronglyFiltered,
    foodRescue: buildFoodRescueSection(input.offers, input.nextWeekOffers, input.filteredOffers),
    foodDecisionSummary,
    reviewDimension,
    reweSnapshotStatus,
    unresolvedReviewCount: foodDecisionSummary.uncertainFilteredCount,
    reviewReduction: summarizeReviewReduction(input.filteredOffers),
    reviewQueue: summarizeReviewQueue(input.filteredOffers),
    diagnosticFreshness: computeDiagnosticFreshness(input.runContext ?? 'full', {
      reweImport: !!input.reweImport,
      subSourceBalance: (input.subSourceOutcomes ?? []).length > 0,
      edeka: !!input.edeka,
      kaufland: !!input.kauflandCompleteness,
    }),
    gateConflicts: {
      count: foodDecisionSummary.wrongFoodFilteredCount,
      examples: foodDecisionSummary.wrongFoodFilteredExamples,
    },
    subSourceBalance: [...(input.subSourceOutcomes ?? [])],
    aldiPdfReview,
    lidlManualImport: input.lidlManualImport ?? emptyLidlManualImportReport(),
  };
}

/** URL/Slug begrenzt + sicher darstellen (nie riesige/aktive Links im Report). */
function safeUrlOrSlug(value: string | undefined): string {
  if (!value) return '—';
  const trimmed = value.length > 80 ? `${value.slice(0, 77)}…` : value;
  return trimmed.replace(/\|/g, '/');
}

const SUB_SOURCE_STATUS_LABEL: Record<string, string> = {
  success: '🟢 success',
  empty: '⚪ empty',
  fetch_failed: '🔴 fetch_failed',
  parse_failed: '🔴 parse_failed',
};

const SUB_SOURCE_GATE_LABEL: Record<string, string> = {
  committed: '✅ committed',
  blocked: '🔴 blocked',
  unaffected: '➖ unaffected',
};

/** Rendert die vollständige Subquellen-/Prospektbilanz als Markdown-Tabelle
 *  (Task P6). Keine Freitextwarnungen — nur strukturierte Felder. */
export function renderSubSourceBalanceMarkdown(outcomes: readonly SubSourceOutcome[]): string {
  if (outcomes.length === 0) {
    return '';
  }
  const lines: string[] = [];
  lines.push('## Subquellen-/Prospektbilanz (pro Subquelle, strukturiert)');
  lines.push('');
  lines.push(
    '| Shop | sourceId | URL/Slug | Gültig ab | Gültig bis | Status | raw | result | vorher | Kandidat | Verlust | Quote | Gate | Fehlercode | Grund |',
  );
  lines.push(
    '| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |',
  );
  for (const o of outcomes) {
    lines.push(
      `| ${o.storeChain} | ${o.sourceId} | ${safeUrlOrSlug(o.urlOrSlug)} | ${
        o.expectedValidityStart ?? '—'
      } | ${o.expectedValidityEnd ?? '—'} | ${SUB_SOURCE_STATUS_LABEL[o.status] ?? o.status} | ${
        o.rawCount ?? '—'
      } | ${o.resultCount ?? '—'} | ${o.previousCount} | ${o.candidateCount} | ${o.lossCount} | ${(
        o.lossRate * 100
      ).toFixed(0)} % | ${SUB_SOURCE_GATE_LABEL[o.gateDecision] ?? o.gateDecision} | ${
        o.errorCode ?? '—'
      } | ${o.gateReason ?? '—'} |`,
    );
  }
  // Diagnose-Notes (z. B. die Lidl-OCR-Zählkette mit primaryReason) sind zu lang
  // für eine Tabellenspalte — sie werden darunter je Subquelle ausgegeben, damit
  // ein `raw=0` im Report erklärbar bleibt (nicht nur im JSON).
  const withNote = outcomes.filter(
    (o) => typeof o.note === 'string' && o.note.trim().length > 0,
  );
  if (withNote.length > 0) {
    lines.push('');
    lines.push('### Subquellen-Notizen');
    lines.push('');
    for (const o of withNote) {
      lines.push(`- **${o.storeChain} / ${o.sourceId}**: ${o.note}`);
    }
  }
  return lines.join('\n');
}

function scorePercent(score: number | null): string {
  return score === null ? '—' : `${Math.round(score * 100)} %`;
}

const STATUS_LABEL: Record<string, string> = {
  healthy: '🟢 healthy',
  warn: '🟡 warn',
  critical: '🔴 critical',
  unverified: '⚪ unverified',
};

/** Render the report as Markdown for logs and reports. */
export function renderScanReportMarkdown(report: ScanReport): string {
  const lines: string[] = [];
  lines.push(`# Angebots-Scan Verifikations-Report (${report.generatedAt})`);
  lines.push('');
  // Ehrliche Drei-Wege-Aufschlüsselung (zentrale classifyFoodDecision): nie mehr
  // „filteredCount pauschal = Non-Food". uncertainFiltered sind die echten
  // Review-Fälle; wrongFoodFiltered MUSS nach der Reconciliation 0 sein.
  const fd = report.foodDecisionSummary;
  lines.push('## Food-/Non-Food-Entscheidung (zentral, ehrlich)');
  lines.push('');
  lines.push(`- Sichtbar confirmed_food: **${fd.confirmedFoodVisibleCount}**`);
  lines.push(`- Sichtbar uncertain: **${fd.uncertainVisibleCount}**`);
  lines.push(`- Gefiltert confirmed_non_food (erklärt): **${fd.confirmedNonFoodFilteredCount}**`);
  lines.push(`- Gefiltert uncertain (Review-Fälle, Phase-2-Kandidaten): **${fd.uncertainFilteredCount}**`);
  lines.push(`- Sichtbar fälschlich non-food (sollte 0 sein): **${fd.nonFoodLeakCount}** ${fd.nonFoodLeakCount > 0 ? '🔴' : '✅'}`);
  lines.push(
    `- Gefiltert fälschlich confirmed_food, zeitlich gültig (MUSS 0): **${fd.wrongFoodFilteredCount}** ${fd.wrongFoodFilteredCount > 0 ? '🔴' : '✅'}`,
  );
  if (fd.wrongFoodFilteredExamples.length > 0) {
    lines.push(`  - z. B. ${fd.wrongFoodFilteredExamples.join(', ')}`);
  }
  lines.push('');
  // Task F: Review-Flag-Dimension — getrennt von der FoodDecision-Dimension.
  const rv = report.reviewDimension;
  lines.push('### Review-Flag (separate Dimension, nicht = FoodDecision)');
  lines.push('');
  lines.push(`- Offene Review-Fälle gefiltert (reviewNeeded): **${rv.unresolvedFilteredReviewCount}**`);
  lines.push(`- Offene Review-Fälle sichtbar (reviewNeeded): **${rv.unresolvedVisibleReviewCount}**`);
  lines.push(`- davon confirmed_food mit reviewNeeded: **${rv.confirmedFoodWithReviewCount}**`);
  lines.push(`- davon confirmed_non_food mit reviewNeeded: **${rv.confirmedNonFoodWithReviewCount}**`);
  lines.push(
    `- Zur Einordnung — uncertain gefiltert/sichtbar (FoodDecision): **${rv.uncertainFilteredCount}** / **${rv.uncertainVisibleCount}**`,
  );
  lines.push('');
  // Task P3: welche generischen, hochpräzisen Evidenzklassen Reviews reduziert
  // haben (Filtered-Bucket) — und was ehrlich Review bleibt.
  const rr = report.reviewReduction;
  lines.push('### Review-Reduktion — generische Evidenzklassen (Filtered-Bucket)');
  lines.push('');
  lines.push(`- Durch sichere Klassen entschieden: **${rr.resolvedByClassTotal}**`);
  lines.push(`- Ehrlich offen (uncertain, bleibt Review): **${rr.reviewRemaining}**`);
  for (const row of rr.resolvedByClass) {
    const examples = row.examples.length > 0 ? ` — z. B. ${row.examples.join(', ')}` : '';
    lines.push(`  - ${row.class}: **${row.count}**${examples}`);
  }
  lines.push('');
  // Task P4: offene Review-Fälle nach Klasse getrennt — Cache-Konflikt (Spritzring)
  // und Namensfragment (kernarm) nie in derselben Liste wie echte Lebensmittel.
  const rq = report.reviewQueue;
  const renderQueueRow = (label: string, row: ReviewQueueSummary['foodLikeReview']): void => {
    const examples = row.examples.length > 0 ? ` — z. B. ${row.examples.join(', ')}` : '';
    lines.push(`- ${label}: **${row.count}**${examples}`);
  };
  lines.push('### Review-Queue — nach Klasse getrennt (Task P4)');
  lines.push('');
  renderQueueRow('Verdächtig falsch gefiltertes Food (food-like)', rq.foodLikeReview);
  renderQueueRow('Unsicher, eher Non-Food (non-food-like)', rq.nonFoodLikeReview);
  renderQueueRow('Cache-Konflikt (alter Non-Food-Cache vs. foodFlag=food)', rq.cacheConflictReview);
  renderQueueRow('Namensqualität / Fragment (kein echtes Angebot)', rq.nameQualityReview);
  if (rq.byStoreAndClass.length > 0) {
    lines.push('');
    lines.push('Top Review-Gründe (Store × Klasse):');
    for (const row of rq.byStoreAndClass) {
      lines.push(`  - ${row.storeChain} · ${row.class}: **${row.count}**`);
    }
  }
  lines.push('');
  // Task P3: Diagnose-Frische je Lauf-Kontext — Phase-2-only aktualisiert keine
  // Phase-1-Diagnose; das wird hier ehrlich gezeigt statt als leeres Feld.
  const df = report.diagnosticFreshness;
  lines.push('### Diagnose-Frische (Lauf-Kontext)');
  lines.push('');
  lines.push(`- Lauf-Kontext: **${df.runContext}**`);
  lines.push(`- REWE-Import-Diagnose: ${FRESHNESS_LABEL[df.reweImport]}`);
  lines.push(`- Subquellenbilanz: ${FRESHNESS_LABEL[df.subSourceBalance]}`);
  lines.push(`- EDEKA Live-Verifikation: ${FRESHNESS_LABEL[df.edeka]}`);
  lines.push(`- Kaufland Live-Verifikation: ${FRESHNESS_LABEL[df.kaufland]}`);
  lines.push('');
  if (report.nonFoodLeakCount > 0) {
    lines.push('## Non-Food-Leaks im sichtbaren Feed (current/next)');
    lines.push('');
    lines.push(
      `> 🔴 ${report.nonFoodLeakCount} klare(s) Non-Food-Angebot(e) sind live statt im Filtered-Bucket — der finale Non-Food-Gate hat nicht gegriffen.`,
    );
    lines.push('');
    for (const example of report.nonFoodLeakExamples) {
      lines.push(`- ${example}`);
    }
    lines.push('');
  }
  if (report.likelyFoodWronglyFilteredCount > 0) {
    lines.push('## Verdacht: falsch gefiltertes Lebensmittel (Filtered-Bucket)');
    lines.push('');
    lines.push(
      `> 🟡 ${report.likelyFoodWronglyFilteredCount} gefiltertes(n) Angebot(e) mit starkem Food-Signal — vom Food-Rescue rettbar.`,
    );
    lines.push('');
    for (const example of report.likelyFoodWronglyFilteredExamples) {
      lines.push(`- ${example}`);
    }
    lines.push('');
  }
  const foodRescue = report.foodRescue;
  if (foodRescue.rescuedCount + foodRescue.reviewNeededFoodFilteredCount > 0) {
    lines.push('## Food-Rescue (Filtered → sichtbar)');
    lines.push('');
    if (foodRescue.rescuedCount > 0) {
      lines.push(
        `> ✅ ${foodRescue.rescuedCount} Lebensmittel-Angebot(e) aus dem Filtered-Bucket zurück in den sichtbaren Feed verschoben (Tag \`food_rescue\`).`,
      );
    }
    if (foodRescue.reviewNeededFoodFilteredCount > 0) {
      lines.push(
        `> 🟡 ${foodRescue.reviewNeededFoodFilteredCount} gefiltertes(n) Angebot(e) ohne Non-Food-Beleg und ohne starkes Food-Signal — als Review-Fall markiert, nicht blind gerettet.`,
      );
    }
    lines.push('');
    for (const store of foodRescue.stores) {
      const parts: string[] = [];
      if (store.rescuedCount > 0) {
        parts.push(`${store.rescuedCount} gerettet (${store.rescuedExamples.join(', ')})`);
      }
      if (store.reviewNeededCount > 0) {
        parts.push(`${store.reviewNeededCount} Review (${store.reviewNeededExamples.join(', ')})`);
      }
      lines.push(`- **${store.storeChain}** — ${parts.join(' · ')}`);
    }
    lines.push('');
  }
  lines.push(renderStoreImportHealthMarkdown(report.storeImportHealth));
  lines.push('');
  // ALDI-PDF-Review-Queue (Task 7) — optionaler Hinweis, nie criticalStores.
  const rev = report.aldiPdfReview;
  if (rev.total > 0) {
    lines.push('## ALDI-PDF Review-Queue');
    lines.push('');
    lines.push(
      `- pending: **${rev.pending}** · bestätigt (noch nicht committet): **${rev.approved}** · ` +
        `abgelehnt: ${rev.rejected} · committet: ${rev.committed} (gesamt ${rev.total}).`,
    );
    for (const [store, counts] of Object.entries(rev.byStore)) {
      lines.push(
        `  - ${store}: ${counts.pending} pending · ${counts.approved} bestätigt · ` +
          `${counts.committed} committet`,
      );
    }
    lines.push('Nur manuell bestätigte Kandidaten werden live übernommen — pending zählt nie als critical.');
    lines.push('');
  }
  const lidl = report.lidlManualImport;
  if (
    lidl.queuePending > 0 ||
    lidl.approvedNotCommitted > 0 ||
    lidl.committedCount > 0 ||
    lidl.candidatesFound > 0
  ) {
    lines.push('## Lidl Prospekt-Import (manuell)');
    lines.push('');
    lines.push(
      `- pending: **${lidl.queuePending}** · bestätigt (noch nicht committet): **${lidl.approvedNotCommitted}** · ` +
        `committet: ${lidl.committedCount} · Belegbilder: ${lidl.imageEvidenceCount}.`,
    );
    lines.push(
      `- letzter Lauf: ${lidl.lastImportAt ?? '—'} · Seiten gescannt: ${lidl.pagesScanned} · ` +
        `Vorschläge: ${lidl.candidatesFound}.`,
    );
    const rejReasons = Object.entries(lidl.rejectedByReason);
    if (rejReasons.length > 0) {
      lines.push(
        `- automatisch verworfen: ${rejReasons.map(([r, n]) => `${r}=${n}`).join(', ')}.`,
      );
    }
    lines.push(
      'Der manuelle Review-Import ergänzt den Lidl-Auto-Scan (Viewer-JSON, partial_with_viewer_json) ' +
        'um die preislosen Frische-Hotspots. Nichts geht ohne manuellen Approve live; ' +
        'keine full-Coverage-Behauptung.',
    );
    lines.push('');
  }
  const subSourceMarkdown = renderSubSourceBalanceMarkdown(report.subSourceBalance);
  if (subSourceMarkdown) {
    lines.push(subSourceMarkdown);
    lines.push('');
  }
  lines.push('## Store-Vollständigkeit');
  lines.push('');
  lines.push(
    '| Store | current | upcoming | filtered | erwartet/offiziell | Score | Status |',
  );
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const store of report.completeness.stores) {
    const expected =
      store.officialCount ?? store.expectedMin ?? null;
    lines.push(
      `| ${store.storeChain} | ${store.currentImported} | ${store.upcomingImported} | ${store.filteredCount} | ${
        expected ?? '—'
      } | ${scorePercent(store.completenessScore)} | ${STATUS_LABEL[store.status] ?? store.status} |`,
    );
  }

  const problemStores = report.completeness.stores.filter(
    (store) => store.status !== 'healthy',
  );
  if (problemStores.length > 0) {
    lines.push('');
    lines.push('## Auffällige Stores');
    lines.push('');
    for (const store of problemStores) {
      const reason = store.reasons[0] ?? '';
      lines.push(
        `- **${store.storeChain}** — ${STATUS_LABEL[store.status] ?? store.status}: ${reason}`,
      );
    }
  }

  if (report.blockedStores.length > 0) {
    lines.push('');
    lines.push(
      `> ⚪ Nicht verifizierbar (Quelle blockiert): ${report.blockedStores.join(', ')}.`,
    );
  }

  const kaufland = report.kauflandCompleteness;
  if (kaufland) {
    lines.push('');
    lines.push('## Kaufland — offiziell vs. importiert');
    lines.push('');
    lines.push(`> ${kaufland.comparisonScope}`);
    lines.push('');
    lines.push(
      `- Offizielle Food-Angebots-OBJEKTE (aktuelle Woche, inkl. Kategorie-Dubletten): **${kaufland.officialFoodishCount}**`,
    );
    lines.push(
      `- Davon distinct Namen (Vergleichsbasis): **${kaufland.officialDistinctFoodCount}**`,
    );
    lines.push(`- Im sichtbaren Snapshot gefunden (current + next): **${kaufland.matchedCount}**`);
    lines.push(
      `- Gefiltert mit regelbestätigtem Non-Food-Signal (gemischte offizielle Kategorie, kein Fehler): **${kaufland.matchedFilteredNonFoodCount}**`,
    );
    lines.push(
      `- Gefiltert ohne Beleg in beide Richtungen aus gemischter offizieller Aktionskategorie (Review-Fälle, reviewNeeded — kein Food-Verlust-Indiz): **${kaufland.matchedFilteredUnconfirmedCount}**`,
    );
    lines.push(
      `- Gefiltert OHNE Non-Food-Beleg (Verdacht auf falsch gefiltertes Food): **${kaufland.matchedFilteredCount}**`,
    );
    lines.push(
      `- Fehlend (nirgends gefunden = ${kaufland.officialDistinctFoodCount} − ${kaufland.matchedCount} − ${kaufland.matchedFilteredNonFoodCount} − ${kaufland.matchedFilteredUnconfirmedCount} − ${kaufland.matchedFilteredCount}): **${kaufland.missingEstimate}**`,
    );
    lines.push(
      `- Importierte aktuelle Namen ohne offizielles Gegenstück (Diagnose): **${kaufland.unmatchedImportedCount}**`,
    );
    if (kaufland.missingExamples.length > 0) {
      lines.push('');
      lines.push('Beispiele fehlender Kaufland-Angebote (unmatched official):');
      for (const example of kaufland.missingExamples) {
        lines.push(`- ${example}`);
      }
    }
  }

  const edeka = report.edeka;
  if (edeka) {
    lines.push('');
    lines.push('## EDEKA — Import-Diagnose (national, serverseitiges HTML)');
    lines.push('');
    lines.push(`> Quelle: ${edeka.sourceUrl}`);
    if (edeka.blocked) {
      lines.push(
        `> 🔴 Blockiert: ${edeka.blockReason ?? 'Block-/Captcha-Seite'}${
          edeka.httpStatus ? ` (HTTP ${edeka.httpStatus})` : ''
        } — Vollständigkeit nicht verifizierbar.`,
      );
    }
    lines.push('');
    lines.push('Zählkette (Quelle → importiert):');
    lines.push(`- Angebotskarten (\`<dialog>\`): **${edeka.offerBlocks}**`);
    lines.push(`- Kandidaten (mit Name): **${edeka.candidates}**`);
    lines.push(`- Mit echtem Angebotspreis: **${edeka.withOfferPrice}**`);
    lines.push(`- Importiert (distinct): **${edeka.importedDistinct}**`);
    lines.push(`- Dubletten zusammengeführt: **${edeka.duplicatesMerged}**`);
    lines.push(
      `- Abgelehnt — kein Angebotspreis (nur Normalpreis/PAYBACK): **${edeka.rejectedByReason.kein_angebotspreis}**, ` +
        `kein Preis: **${edeka.rejectedByReason.kein_preis}**, kein Name: **${edeka.rejectedByReason.kein_name}**`,
    );
    lines.push(`- Karten ohne Produktbild: **${edeka.brokenImageCount}**`);
    lines.push(`- Marktbezug: **${edeka.marketScope}** (national_only — nie 'full')`);
    if (edeka.validityStartSeen) {
      lines.push(`- Frühestes "Gültig ab": **${edeka.validityStartSeen}**`);
    }
    lines.push(
      `- Letzte erfolgreiche Verifikation: **${edeka.lastSuccessfulAt ?? 'in diesem Prozess keine'}**`,
    );
    if (edeka.rejectedExamples.length > 0) {
      lines.push('');
      lines.push(`Abgelehnte Beispiele: ${edeka.rejectedExamples.slice(0, 8).join(', ')}.`);
    }
  }

  const aldiNord = report.aldiNord;
  if (aldiNord) {
    lines.push('');
    lines.push('## ALDI NORD — Import-Diagnose (strukturierter Website-Connector)');
    lines.push('');
    lines.push(`> Quelle: ${aldiNord.sourceUrl} (apiData/__NEXT_DATA__ OFFER_GET — kein PDF/Vision)`);
    if (aldiNord.blocked) {
      lines.push(
        `> 🔴 Quelle nicht erreichbar: ${aldiNord.blockReason ?? 'fetch_failed'}${
          aldiNord.httpStatus ? ` (HTTP ${aldiNord.httpStatus})` : ''
        } — keine strukturierten Angebote importiert.`,
      );
    } else if (!aldiNord.apiDataFound) {
      lines.push('> 🟡 Kein apiData/__NEXT_DATA__ auf der Angebotsseite gefunden — Layout evtl. geändert.');
    }
    lines.push('');
    lines.push('Zählkette (Struktur → importiert):');
    lines.push(`- Strukturierte Produkte (algoliaDataMap): **${aldiNord.structuredProductsFound}**`);
    lines.push(`- Mit Preis: **${aldiNord.productsWithPrice}**`);
    lines.push(`- Mit Gültigkeit: **${aldiNord.productsWithValidity}**`);
    lines.push(`- Mit Bild: **${aldiNord.productsWithImage}**`);
    lines.push(`- Angebotsbereiche (mit productIds): **${aldiNord.areaCount}**`);
    lines.push(`- Importiert (distinct, über objectID): **${aldiNord.importedDistinct}**`);
    lines.push(`- Dubletten zusammengeführt: **${aldiNord.duplicatesMerged}**`);
    lines.push(
      `- Aktuell vs. künftig (ab Datum): **${aldiNord.currentProducts}** aktuell, **${aldiNord.futureProducts}** künftig/upcoming`,
    );
    lines.push(
      `- Letzte erfolgreiche Verifikation: **${aldiNord.lastSuccessfulAt ?? 'in diesem Prozess keine'}**`,
    );
    if (aldiNord.missingPriceExamples.length > 0) {
      lines.push(`- Beispiele ohne Preis: ${aldiNord.missingPriceExamples.slice(0, 8).join(', ')}`);
    }
    if (aldiNord.missingValidityExamples.length > 0) {
      lines.push(`- Beispiele ohne Datum: ${aldiNord.missingValidityExamples.slice(0, 8).join(', ')}`);
    }
    if (aldiNord.missingImageExamples.length > 0) {
      lines.push(`- Beispiele ohne Bild: ${aldiNord.missingImageExamples.slice(0, 8).join(', ')}`);
    }
  }

  const aldiSued = report.aldiSued;
  if (aldiSued) {
    const verdictIcon =
      aldiSued.verdict === 'ok'
        ? '🟢'
        : aldiSued.verdict === 'warning'
          ? '🟡'
          : '🔴';
    lines.push('');
    lines.push('## ALDI SÜD — Import-Diagnose (strukturierter Website-Connector)');
    lines.push('');
    lines.push(
      '> Quelle: zentrale Wochenangebote-Sammelseite mit Pagination (Nuxt __NUXT_DATA__ + DOM-Kacheln, HTTP 200 — kein PDF/Vision, kein Anti-Bot-Bypass)',
    );
    lines.push(`> ${verdictIcon} Verdict: **${aldiSued.verdict}**`);
    lines.push('');
    lines.push('Geprüfte Seiten:');
    for (const source of aldiSued.sourceUrlsChecked) {
      const statusText = source.blocked
        ? `🔴 blockiert (${source.blockReason ?? source.status ?? 'fetch_failed'})`
        : `🟢 HTTP ${source.status ?? 200}`;
      lines.push(
        `- Seite ${source.page ?? '?'}: ${statusText} — ${source.productsParsed} Produkte ` +
          `(neu: ${source.newProducts ?? '?'}), ` +
          `${source.htmlProductCards} DOM-Kacheln, __NUXT_DATA__=${source.embeddedJsonFound ? 'ja' : 'nein'}, ` +
          `JSON-LD-Offers=${source.jsonLdOffers}, data-grid-data=${source.dataGridDataCount}, ` +
          `API-Kandidaten=${source.apiCandidatesFound} (${source.url})`,
      );
    }
    lines.push('');
    lines.push(
      `Seiten geprüft: **${aldiSued.pagesChecked ?? aldiSued.sourceUrlsChecked.length}**, ` +
        `davon mit Produkten: **${aldiSued.pagesWithProducts ?? '?'}**`,
    );
    lines.push('');
    lines.push('Zählkette (Struktur → importiert):');
    lines.push(`- Strukturierte Produkte (__NUXT_DATA__): **${aldiSued.structuredProductsFound}**`);
    lines.push(`- Mit Preis: **${aldiSued.productsWithPrice}**`);
    lines.push(`- Mit Bild: **${aldiSued.productsWithImage}**`);
    lines.push(`- Mit Gültigkeit (bestimmbar): **${aldiSued.productsWithValidity}**`);
    lines.push(`- Importiert (distinct, über sku): **${aldiSued.importedDistinct}**`);
    lines.push(`- Dubletten zusammengeführt: **${aldiSued.duplicatesMerged}**`);
    lines.push(
      `- Aktuell vs. künftig (ab Datum): **${aldiSued.currentProducts}** aktuell, **${aldiSued.futureProducts}** künftig/upcoming`,
    );
    lines.push(
      `- Letzte erfolgreiche Verifikation: **${aldiSued.lastSuccessfulAt ?? 'in diesem Prozess keine'}**`,
    );
    if (aldiSued.missingPriceExamples.length > 0) {
      lines.push(`- Beispiele ohne Preis: ${aldiSued.missingPriceExamples.slice(0, 8).join(', ')}`);
    }
    if (aldiSued.missingValidityExamples.length > 0) {
      lines.push(`- Beispiele ohne Datum: ${aldiSued.missingValidityExamples.slice(0, 8).join(', ')}`);
    }
    if (aldiSued.missingImageExamples.length > 0) {
      lines.push(`- Beispiele ohne Bild: ${aldiSued.missingImageExamples.slice(0, 8).join(', ')}`);
    }
  }

  // Task E: AKTUELLER REWE-Snapshot-Zustand (nach Phase 2), frisch aus den
  // Buckets — bewusst VOR und getrennt von der historischen Import-Zählkette.
  const rs = report.reweSnapshotStatus;
  lines.push('');
  lines.push('## REWE — Aktueller Snapshot-Zustand (nach Phase 2)');
  lines.push('');
  lines.push('> Frisch aus den aktuellen Buckets berechnet — NICHT der Importbeleg.');
  lines.push('');
  lines.push(`- current sichtbar: **${rs.current}**`);
  lines.push(`- nextWeek sichtbar: **${rs.nextWeek}**`);
  lines.push(`- confirmed_non_food gefiltert: **${rs.confirmedNonFoodFiltered}**`);
  lines.push(`- uncertain gefiltert: **${rs.uncertainFiltered}**`);
  lines.push(
    `- confirmed_food gefiltert, zeitlich gültig (MUSS 0): **${rs.wrongFoodFiltered}** ${rs.wrongFoodFiltered > 0 ? '🔴' : '✅'}`,
  );
  lines.push(`- offene Review-Fälle gefiltert (reviewNeeded): **${rs.unresolvedReview}**`);

  const rewe = report.reweImport;
  if (rewe) {
    lines.push('');
    lines.push('## REWE — Import-Zählkette (historischer Importbeleg, Importzeitpunkt)');
    lines.push('');
    lines.push(
      '> Unveränderlicher Beleg des Imports — beschreibt den Importzeitpunkt, NICHT den aktuellen Snapshot (s. „Aktueller Snapshot-Zustand" oben).',
    );
    lines.push('');
    lines.push(`- Roh-Angebote: **${rewe.rawCount}**`);
    lines.push(`- Live übernommen: **${rewe.normalizedCount}**`);
    lines.push(`- Review/Fragment zurückgehalten: **${rewe.reviewCount}**`);
    lines.push(`- Übersprungen (ohne Name/Preis): **${rewe.skippedCount}**`);
    lines.push(`- Verdächtige Preise: **${rewe.suspiciousPrices.length}**`);
    lines.push(`- Dubletten-Kandidaten: **${rewe.duplicateCandidates.length}**`);
    lines.push(`- Kategorie-Korrekturen: **${rewe.categoryCorrections.length}**`);
    if (rewe.replacedPreviousCount && rewe.replacedPreviousCount.total > 0) {
      const r = rewe.replacedPreviousCount;
      lines.push(
        `- Vorherigen REWE-Scope ersetzt: **${r.total}** (current ${r.current}, next ${r.nextWeek}, filtered ${r.filtered})`,
      );
    }

    // Vollständigkeit (Problem 5): eine balancierte Kette ist NICHT unvollständig,
    // nur weil uniqueCards > live. Ehrliche Lücke = unexplainedMissing.
    const comp = rewe.completeness;
    if (comp) {
      lines.push('');
      lines.push('Vollständigkeit (ehrlich, getrennt von Datenqualität):');
      if (typeof comp.uniqueCardCandidates === 'number') {
        lines.push(`- Einzigartige DOM-Karten: **${comp.uniqueCardCandidates}**`);
      }
      lines.push(`- Importiert (normalisiert): **${comp.imported}**`);
      if (typeof comp.filteredNonFood === 'number') {
        lines.push(
          `- davon gefiltert mit regelbestätigtem Non-Food-Signal: **${comp.filteredNonFood}**`,
        );
      }
      if (typeof comp.filteredFoodSuspect === 'number' && comp.filteredFoodSuspect > 0) {
        lines.push(
          `- davon gefiltert mit starkem Food-Signal (Verdacht falsch gefiltert, Food-Rescue): **${comp.filteredFoodSuspect}**`,
        );
      }
      if (typeof comp.filteredReview === 'number' && comp.filteredReview > 0) {
        lines.push(
          `- davon gefiltert ohne Beleg in beide Richtungen (Review, reviewNeeded): **${comp.filteredReview}**`,
        );
      }
      lines.push(`- Review zurückgehalten: **${comp.reviewHeldBack}**`);
      lines.push(`- Erklärte Ablehnungen: **${comp.explainedRejected}**`);
      lines.push(`- Dubletten: **${comp.duplicates}**`);
      lines.push(
        `- Unerklärt fehlend (unexplainedMissing): **${comp.unexplainedMissing ?? 'n/a'}**` +
          (comp.unexplainedMissing === 0 ? ' ✅' : ''),
      );
    } else if (typeof rewe.possibleWebMissingEstimate === 'number') {
      lines.push(`- Mögliche Lücke vs. Web (ohne Diagnose): **${rewe.possibleWebMissingEstimate}**`);
    }

    // Zählkette: macht jeden Verlust zwischen DOM, Payload und Snapshot
    // rechnerisch nachvollziehbar (kein großer unerklärter Verlust).
    const chain = rewe.countingChain;
    if (chain) {
      lines.push('');
      lines.push(`Zählkette (DOM → Live)${chain.balanced ? '' : ' — ⚠️ INKONSISTENT'}:`);
      if (typeof chain.rawPriceMatches === 'number') {
        lines.push(`- 0. Rohe Preis-Treffer im HTML (nur Diagnose): **${chain.rawPriceMatches}**`);
      }
      if (typeof chain.observedCardOccurrences === 'number') {
        lines.push(`- 1a. Beobachtete Karten-Vorkommen (inkl. Wiederholungen): **${chain.observedCardOccurrences}**`);
      }
      if (typeof chain.uniqueCardCandidates === 'number') {
        lines.push(`- 1b. Einzigartige Karten-Kandidaten (= webCardCount): **${chain.uniqueCardCandidates}**`);
      }
      if (typeof chain.repeatedCardObservations === 'number') {
        lines.push(`- 1c. Wiederholt beobachtete Karten: **${chain.repeatedCardObservations}**`);
      }
      if (chain.browserRejected) {
        lines.push(
          `- 2a. Browser-Ablehnungen — kein Preis: **${chain.browserRejected.noPrice}**, ` +
            `kein Name: **${chain.browserRejected.noName}**, ` +
            `Sektionsüberschrift: **${chain.browserRejected.sectionHeading}**, ` +
            `Extraktionsfehler: **${chain.browserRejected.extractionError}**`,
        );
      }
      if (typeof chain.browserAcceptedBeforeDedupe === 'number') {
        lines.push(`- 2b. Browser akzeptiert (vor Dedupe): **${chain.browserAcceptedBeforeDedupe}**`);
      }
      if (typeof chain.browserOfferDuplicates === 'number') {
        lines.push(`- 2c. Browser-Angebots-Dubletten: **${chain.browserOfferDuplicates}**`);
      }
      lines.push(`- 3. Payload empfangen: **${chain.payloadOffers}**`);
      lines.push(
        `- 4. Server übersprungen — kein Name: **${chain.serverSkipped.noName}**, ` +
          `kein Preis: **${chain.serverSkipped.noPrice}**, ` +
          `Sektionsüberschrift: **${chain.serverSkipped.sectionHeading}**, ` +
          `Promo-/CTA-/Nicht-Produkt-Name: **${chain.serverSkipped.nonProduct ?? 0}**`,
      );
      lines.push(`- 5. Server-Dubletten zusammengeführt: **${chain.serverDuplicatesMerged}**`);
      lines.push(`- 6. Live normalisiert: **${chain.liveNormalized}**`);
      lines.push(`- 7. Review zurückgehalten: **${chain.reviewHeldBack}**`);
      if (!chain.balanced && chain.balanceErrors.length > 0) {
        lines.push(`- ⚠️ Bilanz-Fehler: ${chain.balanceErrors.join('; ')}`);
      }
    }
    if ((rewe.skippedSectionHeadings?.length ?? 0) > 0) {
      lines.push('');
      lines.push(
        `Als Sektionsüberschrift verworfen (nie live): ${rewe
          .skippedSectionHeadings!.slice(0, 12)
          .join(', ')}.`,
      );
    }
    if ((rewe.skippedNonProductExamples?.length ?? 0) > 0) {
      lines.push('');
      lines.push(
        `Als Promo-/CTA-/Nicht-Produkt-Name verworfen (nie live, kein Food-Review): ${rewe
          .skippedNonProductExamples!.slice(0, 12)
          .join(', ')}.`,
      );
    }
    if (rewe.skippedFragments.length > 0) {
      lines.push('');
      lines.push(`Fragmente (Review): ${rewe.skippedFragments.slice(0, 12).join(', ')}.`);
    }
    if (rewe.suspiciousPrices.length > 0) {
      lines.push('');
      lines.push('Verdächtige Preise:');
      for (const suspicious of rewe.suspiciousPrices.slice(0, 12)) {
        lines.push(
          `- ${suspicious.name}: ${suspicious.usedPrice} € (ignoriert: ${suspicious.ignoredPrices.join(', ')})`,
        );
      }
    }
    const lowPrices = rewe.unusualLowPrices ?? [];
    if (lowPrices.length > 0) {
      lines.push('');
      lines.push(
        `Ungewöhnlich niedrige Preise (vermutlich REWE-Bonus/App — geprüft behalten, nicht gelöscht): **${lowPrices.length}**`,
      );
      for (const low of lowPrices.slice(0, 12)) {
        lines.push(`- ${low.name}: ${low.price.toFixed(2)} €`);
      }
    }
    if (rewe.categoryCorrections.length > 0) {
      lines.push('');
      lines.push('Kategorie-Korrekturen:');
      for (const correction of rewe.categoryCorrections.slice(0, 12)) {
        lines.push(`- ${correction.name}: ${correction.from} → ${correction.to}`);
      }
    }
  }

  return lines.join('\n');
}
