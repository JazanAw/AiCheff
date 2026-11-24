// Angebots-Scan 2.0 — snapshot safety gate (Datenqualität #5).
//
// A scan must NEVER replace the productive snapshot with an obviously broken one.
// The 2026-06-07 incident wrote a snapshot where every large shop had 0 *current*
// offers (all future), the live count looked fine (765) but was upcoming-only,
// and the REWE manual import had vanished. This pure gate compares the candidate
// snapshot against the previous one and refuses the commit when any hard failure
// fires — the caller then keeps the old snapshot and surfaces a clear error.
//
// Pure (no IO): the finalize passes the previous + candidate buckets; the gate
// only counts and compares, so it is trivially unit-testable.

import type { Offer } from '../../src/types/models';
import { classifyLiveWindow } from './snapshotLiveWindow';
import { isHardBadOfferName } from './offerNameQuality';
import { findNonFoodLeaks } from './snapshotNonFoodGate';
import {
  allStoresScope,
  isChainInScope,
  normalizeChainKey,
  type ScanV2Scope,
} from './scanV2Scope';
import {
  evaluateSubSourceProspectLoss,
  sanitizeSubSourceDiagnostics,
  type SubSourceDiagnostic,
  type SubSourceOutcome,
} from '../../src/services/offersIngest/subSourceDiagnostics';

export type { SubSourceDiagnostic } from '../../src/services/offersIngest/subSourceDiagnostics';

export interface SnapshotBucketsLike {
  offers: Offer[];
  nextWeekOffers: Offer[];
  filteredOffers: Offer[];
}

export type SnapshotSafetyCheck =
  | 'excludedStoreLost'
  | 'manyLargeShopsZeroCurrent'
  | 'liveCollapse'
  | 'liveOnlyUpcoming'
  | 'storeBelowMinimum'
  | 'requiredStoreEmptyWithoutReason'
  | 'reweImportCritical'
  | 'fragmentOffersLive'
  | 'nonFoodLive'
  | 'scopedOfferLoss'
  | 'prospectWindowLost';

export interface SnapshotSafetyInput {
  previous: SnapshotBucketsLike;
  candidate: SnapshotBucketsLike;
  /** Manual-import stores that must survive every scan (default REWE + nahkauf). */
  excludedStores?: readonly string[];
  /** Web-scanned large shops we expect current offers from. */
  largeShops?: readonly string[];
  /** Stores DISABLED by policy (ALDI SÜD/NORD, Lidl) — never fetched, purged from
   *  the snapshot. They are removed from BOTH previous + candidate views here so
   *  no store-specific check (minimum, large-shop-zero, required, loss) can ever
   *  block a commit because a disabled store dropped to 0. Default: the policy set. */
  disabledStores?: readonly string[];
  now?: Date;
  /** Min previous live size before a collapse can fire (avoids tiny-snapshot noise). */
  minPreviousLiveForCollapse?: number;
  /** Hard per-store minimum (current+next, normalized chain key). Below the
   *  minimum the commit is blocked — a Lidl scrape with 1 offer must never
   *  replace a snapshot. No default; the scan passes SCAN_STORE_MINIMUMS. */
  storeMinimums?: Record<string, number>;
  /** Stores that must either have offers in the candidate or an honest scrape
   *  warning naming them — silently-0 blocks the commit. Default: nahkauf
   *  (unless it is in excludedStores, i.e. manual-import only). */
  requiredStores?: readonly string[];
  /** Scrape warnings of this run — the "honest reason" source for required
   *  stores (a warning naming the store explains its 0 offers). */
  scrapeWarnings?: readonly string[];
  /** Health of the last REWE import; 'critical' blocks the commit. */
  reweImportHealth?: 'ok' | 'warning' | 'critical' | null;
  /**
   * Active store scope of THIS run. When omitted (or `all_stores`) the gate
   * behaves exactly as before: every required shop is checked. When an explicit
   * store set is given (e.g. a REWE-only Phase-2 run) only those shops trigger
   * store-specific rules (minimum, required-store, large-shop-zero, store loss);
   * stores OUTSIDE the scope are carried unchanged and never blamed for "0
   * offers". Global protections (fragments, non-food, REWE import health) still
   * apply within the scoped feed.
   */
  scope?: ScanV2Scope;
  /** Strukturierte Connector-Diagnosen je Subquelle/Prospekt dieses Laufs (Task
   *  P5). NUR eine Subquelle mit Status `fetch_failed`/`parse_failed` gilt als
   *  EXPLIZITER Fehlschlag und löst die Prospekt-Verlust-Prüfung aus — verglichen
   *  wird pro storeChain + sourceId/Gültigkeitsfenster, NICHT mehr aus
   *  Warnungstext. `success`/`empty` blockieren nie (ehrlicher Leerstand). */
  subSourceDiagnostics?: readonly SubSourceDiagnostic[];
  /** Mindest-Vorbestand eines Fensters, ab dem ein Verlust geprüft wird (Rauschen
   *  bei winzigen Beständen vermeiden). Default 5. */
  prospectWindowMinPrevious?: number;
  /** Bruchteil, UNTER den ein Fenster fallen muss, damit der Verlust als
   *  „erheblich" gilt (mit explizitem Fetch-Fehler). Default 0.5 (< 50 %). */
  prospectWindowDropFraction?: number;
}

export interface SnapshotSafetyResult {
  ok: boolean;
  reasons: string[];
  failedChecks: SnapshotSafetyCheck[];
  /** Begrenzte Beispielnamen je fehlgeschlagenem Check, direkt während der
   *  Gate-Auswertung gesammelt (kein Rückparsen aus Reason-Strings). Nur Checks
   *  mit konkreten Angebotsnamen (fragmentOffersLive, nonFoodLive) füllen das. */
  examplesByCheck: Partial<Record<SnapshotSafetyCheck, string[]>>;
  /** Zusammengefasste, deduplizierte Beispielliste über alle fehlgeschlagenen
   *  Checks — begrenzt auf {@link MAX_GATE_EXAMPLES}. Leer bei ok. */
  examples: string[];
  /** Diagnostics: which scope was applied and which stores it checked/skipped. */
  scope: {
    type: ScanV2Scope['type'];
    /** Stores present in the data that the gate actually evaluated. */
    checkedStores: string[];
    /** Stores present in the data but OUTSIDE the scope (carried, not blamed). */
    skippedStores: string[];
  };
  /** Vollständige Subquellenbilanz dieses Laufs (Task P6) — eine Zeile je
   *  übergebener Connector-Diagnose mit Vorher/Nachher/Verlust + Gate-Entscheidung
   *  (committed/blocked/unaffected). Leer, wenn keine Diagnosen übergeben wurden. */
  subSourceOutcomes: SubSourceOutcome[];
}

/** Max example product names surfaced per check / in the summary list — never
 *  huge lists (Task P3). Kept in sync with the central gate/report example caps. */
const MAX_GATE_EXAMPLES = 8;

const DEFAULT_EXCLUDED = ['rewe', 'nahkauf'] as const;
// Lidl must deliver a believable share of its weekly Aktionsprospekt. Counted
// over current + next + filtered (the leaflet is mostly non-food + wine, which
// correctly lands in `filtered`): a healthy week imports ~250–300 products, so
// 40 only blocks a clearly broken scrape (the historic 1-offer case).
// Passed EXPLICITLY by the scan finalize (assertSnapshotSafeToCommit) — the
// bare gate applies no minimums so non-scan callers/tests are unaffected.
export const SCAN_STORE_MINIMUMS: Record<string, number> = { lidl: 40 };
const DEFAULT_REQUIRED_STORES = ['nahkauf'] as const;
// Large web-scanned chains; matched normalized so "ALDI SÜD"/"ALDI SUED" both hit.
const DEFAULT_LARGE_SHOPS = [
  'aldi nord',
  'aldi sued',
  'aldi sud',
  'kaufland',
  'lidl',
  'norma',
  'penny',
] as const;

// Single source of truth for store identity (umlaut-folded, case-insensitive),
// shared with the scope model so scope membership + gate counting always agree.
const normalizeChain = normalizeChainKey;

function countByChain(offers: readonly Offer[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const offer of offers) {
    const key = normalizeChain(offer.storeChain);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

function totalForExcluded(b: SnapshotBucketsLike, excluded: ReadonlySet<string>): Map<string, number> {
  const map = new Map<string, number>();
  for (const offer of [...b.offers, ...b.nextWeekOffers, ...b.filteredOffers]) {
    const key = normalizeChain(offer.storeChain);
    if (excluded.has(key)) map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

/** Live offers that are genuinely active today (date-less counts as active). */
function activeTodayCount(offers: readonly Offer[], now: Date): number {
  let count = 0;
  for (const offer of offers) {
    const window = classifyLiveWindow(offer, now);
    if (window === 'current' || window === 'unknown') count += 1;
  }
  return count;
}

export interface PreserveBlockedStoreInput {
  previous: SnapshotBucketsLike;
  candidate: SnapshotBucketsLike;
  /** Store chain to protect (normalized internally). */
  storeChain: string;
  /** True when THIS run could not read the store (403/Captcha/Block-Seite). */
  blocked: boolean;
}

export interface PreserveBlockedStoreResult {
  buckets: SnapshotBucketsLike;
  /** True when the previous stock was carried over (blocked + candidate empty). */
  preserved: boolean;
  preservedCount: number;
}

function countStoreInBuckets(b: SnapshotBucketsLike, key: string): number {
  let count = 0;
  for (const offer of [...b.offers, ...b.nextWeekOffers, ...b.filteredOffers]) {
    if (normalizeChain(offer.storeChain) === key) count += 1;
  }
  return count;
}

/**
 * Schützt einen automatisch gescrapten Store (z. B. EDEKA) davor, dass ein
 * BLOCKIERTER Lauf einen vorhandenen gültigen Bestand durch 0 ersetzt
 * (Auftrag P4): liefert der neue Lauf für den Store 0 Angebote UND war die
 * Quelle blockiert UND hatte der vorherige Snapshot einen Bestand, werden die
 * vorherigen Store-Angebote atomar in den Kandidaten übernommen. Andere Stores
 * bleiben unberührt. Pure (kein IO), trivial testbar.
 *
 * Bewusst NUR bei `blocked` — eine Quelle, die nachweislich erreichbar ist und
 * 0 Angebote zeigt (echtes Wochenende-/Leerstand-Szenario), darf ihren alten
 * Bestand nicht künstlich „aktuell" halten.
 */
export function preserveBlockedStoreOffers(
  input: PreserveBlockedStoreInput,
): PreserveBlockedStoreResult {
  const key = normalizeChain(input.storeChain);
  const candidateCount = countStoreInBuckets(input.candidate, key);
  const previousCount = countStoreInBuckets(input.previous, key);

  if (!input.blocked || candidateCount > 0 || previousCount === 0) {
    return { buckets: input.candidate, preserved: false, preservedCount: 0 };
  }

  const carry = (
    candidateOffers: readonly Offer[],
    previousOffers: readonly Offer[],
  ): Offer[] => [
    ...candidateOffers,
    ...previousOffers.filter((offer) => normalizeChain(offer.storeChain) === key),
  ];

  return {
    buckets: {
      offers: carry(input.candidate.offers, input.previous.offers),
      nextWeekOffers: carry(input.candidate.nextWeekOffers, input.previous.nextWeekOffers),
      filteredOffers: carry(input.candidate.filteredOffers, input.previous.filteredOffers),
    },
    preserved: true,
    preservedCount: previousCount,
  };
}

export function evaluateSnapshotSafety(input: SnapshotSafetyInput): SnapshotSafetyResult {
  const now = input.now ?? new Date();
  const excluded = new Set((input.excludedStores ?? DEFAULT_EXCLUDED).map(normalizeChain));
  // DISABLED stores (ALDI SÜD/NORD, Lidl) are not this run's responsibility: they
  // are never scraped and are purged from the snapshot. Filter them out of BOTH
  // previous + candidate up front so every count below (live-collapse,
  // large-shop-zero, store loss) simply never sees them. The store-keyed checks
  // (minimum, required) additionally skip disabled chains for clarity.
  //
  // Defaults to EMPTY: the bare gate (and the existing test suite, which still
  // uses Lidl/ALDI as generic large-shop fixtures) is unaffected. The scan
  // finalize passes the policy set explicitly (see assertSnapshotSafeToCommit).
  const disabled = new Set((input.disabledStores ?? []).map(normalizeChain));
  const dropDisabled = (b: SnapshotBucketsLike): SnapshotBucketsLike => ({
    offers: b.offers.filter((o) => !disabled.has(normalizeChain(o.storeChain))),
    nextWeekOffers: b.nextWeekOffers.filter((o) => !disabled.has(normalizeChain(o.storeChain))),
    filteredOffers: b.filteredOffers.filter((o) => !disabled.has(normalizeChain(o.storeChain))),
  });
  const previousInput = dropDisabled(input.previous);
  const candidateInput = dropDisabled(input.candidate);
  const largeShops = (input.largeShops ?? DEFAULT_LARGE_SHOPS)
    .map(normalizeChain)
    .filter((chain) => !disabled.has(chain));
  const minPreviousLiveForCollapse = input.minPreviousLiveForCollapse ?? 50;

  // SCOPE: which stores is THIS run responsible for? `all_stores` (a full web
  // scan) checks every required shop exactly as before; an explicit store set
  // (e.g. a REWE-only Phase-2 run) only blames the shops it actually touched.
  const scope = input.scope ?? allStoresScope();
  const scopedRun = scope.type === 'stores';
  const inScope = (chain: string | undefined): boolean => isChainInScope(scope, chain);

  // Scope-filtered views. For `all_stores` these are identical to the full
  // buckets (every chain is in scope), so the all-store path is unchanged.
  const filterScoped = (offers: readonly Offer[]): Offer[] =>
    scopedRun ? offers.filter((offer) => inScope(offer.storeChain)) : [...offers];
  const prevOffersS = filterScoped(previousInput.offers);
  const candOffersS = filterScoped(candidateInput.offers);
  const candNextS = filterScoped(candidateInput.nextWeekOffers);
  const candFilteredS = filterScoped(candidateInput.filteredOffers);
  const candVisible = [...candOffersS, ...candNextS];

  const reasons: string[] = [];
  const failedChecks: SnapshotSafetyCheck[] = [];
  // Beispiele werden DIREKT während der Auswertung gesammelt (Task P3) — nie aus
  // den Reason-Strings zurückgeparst. Nur Checks mit konkreten Angebotsnamen.
  const examplesByCheck: Partial<Record<SnapshotSafetyCheck, string[]>> = {};

  // 1) Excluded manual imports (REWE/nahkauf) must not vanish — but only for
  //    excluded stores that are IN SCOPE (an out-of-scope manual import is
  //    carried untouched by this run, never its responsibility).
  const prevExcluded = totalForExcluded(previousInput, excluded);
  const candExcluded = totalForExcluded(candidateInput, excluded);
  for (const [chain, prevCount] of prevExcluded) {
    if (!inScope(chain)) continue;
    if (prevCount > 0 && (candExcluded.get(chain) ?? 0) === 0) {
      failedChecks.push('excludedStoreLost');
      reasons.push(
        `Manueller Import "${chain}" verloren: vorher ${prevCount} Angebote, danach 0 — alter Snapshot wird behalten.`,
      );
    }
  }

  // 2) Several large shops with 0 *current* (active-today) live offers. Only
  //    large shops INSIDE the scope count — a REWE-only run never has Lidl in
  //    scope, so it can never trip this (web-scrape-shaped) protection.
  const candLiveByChain = countByChain(candOffersS);
  const candActiveByChain = (() => {
    const map = new Map<string, number>();
    for (const offer of candOffersS) {
      const window = classifyLiveWindow(offer, now);
      if (window === 'current' || window === 'unknown') {
        const key = normalizeChain(offer.storeChain);
        map.set(key, (map.get(key) ?? 0) + 1);
      }
    }
    return map;
  })();
  const prevLiveByChain = countByChain(prevOffersS);
  const candNextByChain = countByChain(candNextS);

  const zeroCurrentShops: string[] = [];
  for (const chain of largeShops) {
    if (!inScope(chain)) continue;
    const candActive = candActiveByChain.get(chain) ?? 0;
    if (candActive > 0) continue;
    const hadDataBefore = (prevLiveByChain.get(chain) ?? 0) > 0;
    const hasOffersNow =
      (candLiveByChain.get(chain) ?? 0) > 0 || (candNextByChain.get(chain) ?? 0) > 0;
    if (hadDataBefore || hasOffersNow) zeroCurrentShops.push(chain);
  }
  if (zeroCurrentShops.length >= 3) {
    failedChecks.push('manyLargeShopsZeroCurrent');
    reasons.push(
      `${zeroCurrentShops.length} große Shops haben 0 aktuelle Angebote (${zeroCurrentShops.join(', ')}) — Scan wird verworfen.`,
    );
  }

  const prevLive = prevOffersS.length;
  const candLive = candOffersS.length;

  // 3+4) Live-collapse / upcoming-only are tuned for a FULL web scrape (the
  //   2026-06-07 "765 live but all upcoming" incident). They only run for an
  //   all-store scan; a scoped run uses the scoped-loss check (10) instead,
  //   because preserved manual imports legitimately look date-expired.
  if (!scopedRun) {
    if (prevLive >= minPreviousLiveForCollapse && candLive < prevLive * 0.2) {
      failedChecks.push('liveCollapse');
      reasons.push(
        `Live-Einbruch: vorher ${prevLive} live, danach nur ${candLive} (< 20 %) — Scan wird verworfen.`,
      );
    }
    const candActiveTotal = activeTodayCount(candOffersS, now);
    if (candLive >= 20 && candActiveTotal === 0) {
      failedChecks.push('liveOnlyUpcoming');
      reasons.push(
        `Live-Liste enthält ${candLive} Angebote, aber 0 sind heute gültig (nur upcoming) — Scan wird verworfen.`,
      );
    }
  }

  // Per-store TOTAL import volume (current + next + filtered). The minimum
  // gate measures "did the scrape deliver believable volume" — non-food that
  // was correctly routed to `filtered` still counts as successfully imported
  // (the Lidl leaflet is mostly non-food + wine; only ~1 offer = broken).
  const candTotalByChain = new Map<string, number>();
  for (const offer of [...candVisible, ...candFilteredS]) {
    const key = normalizeChain(offer.storeChain);
    candTotalByChain.set(key, (candTotalByChain.get(key) ?? 0) + 1);
  }
  const scrapeWarnings = input.scrapeWarnings ?? [];
  const warningMentions = (chain: string): boolean =>
    scrapeWarnings.some((warning) => normalizeChain(warning).includes(chain));

  // 5) Hard per-store minimum: a clearly broken scrape (Lidl with 1 offer)
  //    must never replace the snapshot — but only for IN-SCOPE stores. A
  //    REWE-only run does not have Lidl in scope, so Lidl=0 is irrelevant.
  const storeMinimums = input.storeMinimums ?? {};
  for (const [chainRaw, minimum] of Object.entries(storeMinimums)) {
    const chain = normalizeChain(chainRaw);
    if (excluded.has(chain) || disabled.has(chain) || !inScope(chain) || !(minimum > 0)) continue;
    const count = candTotalByChain.get(chain) ?? 0;
    if (count < minimum) {
      failedChecks.push('storeBelowMinimum');
      reasons.push(
        `${chainRaw}: nur ${count} Angebote (Minimum ${minimum}) — Scan wird verworfen.` +
          (warningMentions(chain) ? ' (Scrape-Warnung vorhanden, Quelle prüfen.)' : ''),
      );
    }
  }

  // 6) Required stores must have offers or an HONEST reason (a scrape warning
  //    naming them) — but only when the store is IN SCOPE. nahkauf is not part
  //    of a REWE-only run, so its absence must not block that run.
  const requiredStores = (input.requiredStores ?? DEFAULT_REQUIRED_STORES).map(normalizeChain);
  for (const chain of requiredStores) {
    if (excluded.has(chain) || disabled.has(chain) || !inScope(chain)) continue;
    const count = candTotalByChain.get(chain) ?? 0;
    if (count === 0 && !warningMentions(chain)) {
      failedChecks.push('requiredStoreEmptyWithoutReason');
      reasons.push(
        `${chain}: 0 Angebote ohne ehrlichen Blocked-/Fehlergrund — Scan wird verworfen.`,
      );
    }
  }

  // 7) A critical REWE import must be fixed before any snapshot commit. This is
  //    store-independent import-health and stays global.
  if (input.reweImportHealth === 'critical') {
    failedChecks.push('reweImportCritical');
    reasons.push(
      'REWE Import-Health ist critical — erst Import reparieren, dann erneut scannen.',
    );
  }

  // 8) Fragment/promo names ("Tiefpreis", "Fl.", "Dose") must never go live.
  //    HARD check only — the REWE-OCR leader rule would false-positive on real
  //    scraped names ("Die Streichzarte gesalzen", "Der Große Bauer").
  const fragmentNames = [
    ...new Set(
      candVisible
        .filter((offer) => isHardBadOfferName(offer.name))
        .map((offer) => offer.name),
    ),
  ];
  if (fragmentNames.length > 0) {
    failedChecks.push('fragmentOffersLive');
    examplesByCheck.fragmentOffersLive = fragmentNames.slice(0, MAX_GATE_EXAMPLES);
    reasons.push(
      `${fragmentNames.length} Fragment-Angebot(e) im sichtbaren Feed (${fragmentNames
        .slice(0, 6)
        .join(', ')}) — Scan wird verworfen.`,
    );
  }

  // 9) Non-Food im sichtbaren Feed — über die EINE zentrale Wahrheit
  //    (classifyFoodDecision via {@link findNonFoodLeaks}/isStrongNonFoodLeak),
  //    NICHT mehr über eine eigene Parallelregel aus isNonFoodOffer /
  //    hasHardNonFoodSignal / Modell-Flags. Dadurch urteilen Safety-Gate,
  //    finaler Non-Food-Gate und Scan-Report für dasselbe Angebot garantiert
  //    identisch: nur ein REGEL-bestätigtes confirmed_non_food blockiert; ein
  //    reines Modell-Non-Food-Flag ohne Regel-Beleg gilt als uncertain und
  //    blockiert nie (der Live-Vorfall mit 23 falsch blockierten Angeboten).
  //    Menschliche Locks (isMovementLocked) und Learned-Allow behalten ihre
  //    Priorität, weil sie bereits in findNonFoodLeaks/classifyFoodDecision
  //    berücksichtigt sind.
  const nonFoodLeak = findNonFoodLeaks(candVisible, MAX_GATE_EXAMPLES);
  if (nonFoodLeak.count > 0) {
    failedChecks.push('nonFoodLive');
    examplesByCheck.nonFoodLive = nonFoodLeak.examples;
    reasons.push(
      `${nonFoodLeak.count} Non-Food-Angebot(e) im sichtbaren Feed (${nonFoodLeak.examples
        .slice(0, 6)
        .join(', ')}) — Scan wird verworfen.`,
    );
  }

  // 10) Scoped offer loss (explicit scope only). Phase 2 only enriches / shifts
  //    offers between live/next/filtered — it must NEVER reduce the scoped TOTAL
  //    (current+next+filtered). A drop is a silent loss of really-processed
  //    offers and blocks the commit; pure bucket shifts (total preserved) pass.
  if (scopedRun) {
    const prevScopedTotal =
      prevOffersS.length +
      filterScoped(previousInput.nextWeekOffers).length +
      filterScoped(previousInput.filteredOffers).length;
    const candScopedTotal = candVisible.length + candFilteredS.length;
    if (prevScopedTotal > 0 && candScopedTotal < prevScopedTotal) {
      failedChecks.push('scopedOfferLoss');
      reasons.push(
        `Scoped-Verlust: vorher ${prevScopedTotal} Angebote im Scope (${scope.stores.join(', ')}), ` +
          `danach nur ${candScopedTotal} — stiller Verlust, Scan wird verworfen.`,
      );
    }
  }

  // 11) Partieller Subquellen-/Prospektverlust (Task P5): ein Shop liefert oft
  //    aus mehreren Subquellen (aktueller + nächster Wochenprospekt). Schlägt
  //    eine davon fehl, kann ihr KOMPLETTER Bestand verschwinden, während der
  //    Shop INSGESAMT über dem Gesamtminimum bleibt (historischer Lidl-Vorfall:
  //    nächster Prospekt fetch failed → nextWeek 0, Gesamt-Lidl trotzdem groß
  //    genug). Generisch für ALLE Shops, KEINE Lidl-Sonderlogik, KEINE festen
  //    Wochenzahlen: verglichen wird pro storeChain + sourceId/Gültigkeitsfenster
  //    der STRUKTURIERTEN Connector-Diagnose. Geblockt wird NUR bei einem
  //    EXPLIZITEN Fehlschlag (`fetch_failed`/`parse_failed`) UND erheblichem
  //    Verlust des betroffenen Vorbestands — eine beliebige Shop-Warnung löst
  //    KEINEN Prospektverlust mehr aus, ein ehrlicher Leerstand blockiert nie.
  const prospectLoss = evaluateSubSourceProspectLoss({
    previousOffers: [
      ...previousInput.offers,
      ...previousInput.nextWeekOffers,
      ...previousInput.filteredOffers,
    ],
    candidateOffers: [
      ...candidateInput.offers,
      ...candidateInput.nextWeekOffers,
      ...candidateInput.filteredOffers,
    ],
    diagnostics: sanitizeSubSourceDiagnostics(input.subSourceDiagnostics),
    inScope: (chain) => inScope(chain),
    isExcluded: (chain) => excluded.has(chain),
    minPrevious: input.prospectWindowMinPrevious ?? 5,
    dropFraction: input.prospectWindowDropFraction ?? 0.5,
  });
  const subSourceOutcomes = prospectLoss.outcomes;
  if (prospectLoss.blocked) {
    failedChecks.push('prospectWindowLost');
    reasons.push(
      `Subquellen-/Prospektverlust mit Fetch-/Parse-Fehler: ${prospectLoss.lostWindows.join('; ')} — eine ` +
        `fehlgeschlagene Subquelle darf kein Zeitfenster still löschen, alter Snapshot wird behalten.`,
    );
  }

  // Diagnostics: which stores were checked vs. carried-but-skipped.
  const presentChains = new Set<string>();
  for (const offer of [
    ...previousInput.offers,
    ...previousInput.nextWeekOffers,
    ...previousInput.filteredOffers,
    ...candidateInput.offers,
    ...candidateInput.nextWeekOffers,
    ...candidateInput.filteredOffers,
  ]) {
    presentChains.add(normalizeChain(offer.storeChain));
  }
  const checkedStores: string[] = [];
  const skippedStores: string[] = [];
  for (const chain of presentChains) {
    if (!chain) continue;
    (inScope(chain) ? checkedStores : skippedStores).push(chain);
  }

  // Zusammengefasste, deduplizierte Beispielliste über alle fehlgeschlagenen
  // Checks (Task P3) — begrenzt, leer bei einem erfolgreichen Lauf.
  const examples = [
    ...new Set(Object.values(examplesByCheck).flat()),
  ].slice(0, MAX_GATE_EXAMPLES);

  return {
    ok: failedChecks.length === 0,
    reasons,
    failedChecks: [...new Set(failedChecks)],
    examplesByCheck,
    examples,
    scope: { type: scope.type, checkedStores: checkedStores.sort(), skippedStores: skippedStores.sort() },
    subSourceOutcomes,
  };
}
