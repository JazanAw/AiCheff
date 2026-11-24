// Angebots-Scan 2.0 — pure, testable helpers for the two-phase offer scan.
//
// The legacy "Angebots-Scan 1.0" (formerly "Alles neu + KI" / One-Click-KI) does
// everything in one heavy pass: scrape → category → nutrition/halal/allergens for
// EVERY offer. Scan 2.0 splits this into two independently startable phases:
//
//   Phase 1 — Schnellscan ("make offers visible fast"):
//     scrape → category + food/non-food → broken-image check → snapshot.
//     100 %-sure non-food goes straight to the filtered bucket; food/unsure stay
//     visible. No expensive nutrition/halal/allergen work happens here.
//
//   Phase 2 — Food-Analyse ("deep-analyse only real/unsure food"):
//     only food + unsure offers are sent to the model for nutrition, allergens,
//     halal/haram, vegan/vegetarian and alcohol/gelatine/pork risks. Known
//     products reuse an existing analysis; locked/manual data is never touched.
//
// Everything here is pure and IO-light so server.ts keeps the heavy lifting
// (scrape, Python pipeline, snapshot) and these stay fully unit-testable. The one
// network helper (`checkOffersImages`) takes an injectable `fetch` for tests.

import type { Offer } from '../../src/types/models';
import { isNonFoodOffer, isLockedOrManual } from './offerProductIntelligence';
import { hasHardNonFoodSignal } from './offersStrictFoodFilter';
import { isHardBadOfferName } from './offerNameQuality';
import {
  isNameQualityFragment,
  isNameQualityNormalized,
  markNameQualityFragment,
  repairNonFragmentNameQuality,
} from './nameQualityQuarantine';
import {
  classifyFoodDecision,
  isFragmentOrSectionHeader,
  isMovementLocked,
} from './foodDecision';
import type { ScanV2Scope } from './scanV2Scope';

// ---------------------------------------------------------------------------
// Mode + phase model (Task 4)
// ---------------------------------------------------------------------------

/** Which phase(s) a Scan-2.0 run should execute. */
export type ScanV2Mode = 'phase1' | 'phase2' | 'phase1_phase2';

/** Fine-grained phase the run is currently in (drives the admin status badge). */
export type ScanV2Phase =
  | 'idle'
  | 'phase1_scraping'
  | 'phase1_image_check'
  | 'phase1_done'
  | 'phase2_food_analysis'
  | 'paused'
  | 'resuming'
  | 'done'
  | 'error'
  | 'cancelled';

/** Honest per-offer image verdict (Task 5). `missing` = no URL at all; `broken`
 *  = URL present but unreachable / not an image (the EDEKA 404 case); `ok` = URL
 *  reachable AND served with an `image/*` content-type. `unchecked` = has a URL
 *  but Phase 1 has not probed it yet. */
export type ImageStatus = 'ok' | 'broken' | 'missing' | 'unchecked';

export interface ScanV2Phase1Stats {
  scrapedCount: number;
  liveCount: number;
  nextWeekCount: number;
  filteredCount: number;
  /** Gefilterte Angebote mit REGEL-bestätigtem Non-Food-Beleg (zentrale
   *  classifyFoodDecision === confirmed_non_food). NICHT mehr pauschal
   *  filteredCount — uncertain-Angebote zählen separat (uncertainFilteredCount). */
  nonFoodFilteredCount: number;
  /** Gefilterte Angebote ohne Beleg in beide Richtungen (uncertain) — ehrliche
   *  Review-Fälle / Phase-2-Kandidaten, kein bestätigtes Non-Food. */
  uncertainFilteredCount: number;
  imageCheckedCount: number;
  brokenImageCount: number;
}

export interface ScanV2Phase2Stats {
  candidatesCount: number;
  sentToModel: number;
  aiClassifiedCount: number;
  reusedProductAnalysis: number;
  fallbackCount: number;
  reviewNeededCount: number;
  skippedNonFoodCount: number;
  skippedLockedCount: number;
  /** NextWeek-Angebote, die Phase 2 BEWUSST nicht verarbeitet hat: der NextWeek-
   *  Bucket läuft nicht durch KI/Enrichment, bleibt aber unverändert im Snapshot.
   *  Macht im Admin sichtbar, wie viele Angebote gezielt übersprungen wurden. */
  skippedNextWeekCount: number;
  /** Uncertain-Angebote, die Phase 2 aus dem Filtered-Bucket geholt hat. */
  uncertainFilteredCandidatesCount: number;
  /** Davon nach der Analyse als Food zurück in den sichtbaren Feed gerettet. */
  phase2RecoveredFoodCount: number;
  /** Davon nach der Analyse als Non-Food bestätigt (bleiben gefiltert). */
  phase2ConfirmedNonFoodCount: number;
  durationMs: number | null;
}

/** Strukturierter Qualitäts-Gate-Fehler des letzten Laufs (Task P1): welche
 *  Check-ID(s) blockiert haben, die Begründungen und begrenzte Beispielnamen.
 *  null, solange kein Qualitäts-Gate fehlgeschlagen ist. */
export interface ScanV2QualityFailure {
  /** Maschinenlesbare Check-IDs, z. B. 'foodLeftInFilter' oder Snapshot-Gate-IDs. */
  failedChecks: string[];
  /** Menschenlesbare Begründungen (eine je fehlgeschlagenem Check). */
  reasons: string[];
  /** Begrenzte Beispielnamen der blockierenden Angebote (nie riesige Listen). */
  examples: string[];
}

export interface ScanV2Status {
  running: boolean;
  /** True while the run is paused (running=false, but NOT done/cancelled/error).
   *  A paused run has a persisted checkpoint that `resume` continues from. */
  paused: boolean;
  phase: ScanV2Phase;
  mode: ScanV2Mode | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** When the run was paused (null unless paused). */
  pausedAt: string | null;
  /** Active store scope of the run (which shops the quality gate checks). null
   *  until a run starts; `all_stores` for a full scrape, an explicit store set
   *  (e.g. ["rewe"]) for a Phase-2-only run on an existing snapshot. */
  scope: ScanV2Scope | null;
  /** True when a resumable checkpoint exists on disk (survives a backend restart). */
  checkpointAvailable: boolean;
  total: number;
  processed: number;
  message: string;
  lastError: string | null;
  /** Strukturierter Qualitäts-Gate-Fehler des letzten Laufs (null = keiner). */
  qualityFailure: ScanV2QualityFailure | null;
  phase1: ScanV2Phase1Stats;
  phase2: ScanV2Phase2Stats;
  durationMs: number | null;
}

export function emptyPhase1Stats(): ScanV2Phase1Stats {
  return {
    scrapedCount: 0,
    liveCount: 0,
    nextWeekCount: 0,
    filteredCount: 0,
    nonFoodFilteredCount: 0,
    uncertainFilteredCount: 0,
    imageCheckedCount: 0,
    brokenImageCount: 0,
  };
}

export function emptyPhase2Stats(): ScanV2Phase2Stats {
  return {
    candidatesCount: 0,
    sentToModel: 0,
    aiClassifiedCount: 0,
    reusedProductAnalysis: 0,
    fallbackCount: 0,
    reviewNeededCount: 0,
    skippedNonFoodCount: 0,
    skippedLockedCount: 0,
    skippedNextWeekCount: 0,
    uncertainFilteredCandidatesCount: 0,
    phase2RecoveredFoodCount: 0,
    phase2ConfirmedNonFoodCount: 0,
    durationMs: null,
  };
}

export function createInitialScanV2Status(): ScanV2Status {
  return {
    running: false,
    paused: false,
    phase: 'idle',
    mode: null,
    startedAt: null,
    finishedAt: null,
    pausedAt: null,
    scope: null,
    checkpointAvailable: false,
    total: 0,
    processed: 0,
    message: 'idle',
    lastError: null,
    qualityFailure: null,
    phase1: emptyPhase1Stats(),
    phase2: emptyPhase2Stats(),
    durationMs: null,
  };
}

const SCAN_V2_MODES: readonly ScanV2Mode[] = ['phase1', 'phase2', 'phase1_phase2'];

/**
 * Parse + validate the requested mode from the start payload. Accepts the three
 * canonical values plus a couple of forgiving aliases ("both", "all", "1+2").
 * Returns null for anything unrecognised so the endpoint can 400 cleanly.
 */
export function parseScanV2Mode(raw: unknown): ScanV2Mode | null {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value.length === 0) return null;
  if ((SCAN_V2_MODES as readonly string[]).includes(value)) {
    return value as ScanV2Mode;
  }
  if (value === 'both' || value === 'all' || value === '1+2' || value === 'phase1+phase2') {
    return 'phase1_phase2';
  }
  if (value === '1' || value === 'p1' || value === 'schnellscan') return 'phase1';
  if (value === '2' || value === 'p2' || value === 'food' || value === 'food-analyse') return 'phase2';
  return null;
}

/** Whether the given mode includes Phase 1 (Schnellscan). */
export function modeIncludesPhase1(mode: ScanV2Mode): boolean {
  return mode === 'phase1' || mode === 'phase1_phase2';
}

/** Whether the given mode includes Phase 2 (Food-Analyse). */
export function modeIncludesPhase2(mode: ScanV2Mode): boolean {
  return mode === 'phase2' || mode === 'phase1_phase2';
}

// ---------------------------------------------------------------------------
// Image quality (Task 5 + Phase 1 broken-image check)
// ---------------------------------------------------------------------------

/** Offer plus the optional image-verdict fields Phase 1 stamps on. */
export type ScanV2Offer = Offer & {
  imageStatus?: ImageStatus;
  brokenImage?: boolean;
} & Record<string, unknown>;

function trimmedUrl(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** True when the content-type header denotes an image (`image/png`, …). */
export function isImageContentType(contentType: unknown): boolean {
  return String(contentType ?? '').trim().toLowerCase().startsWith('image/');
}

export interface ImageProbeInput {
  url?: string | null;
  /** HTTP status from the probe, or null when the request errored/timed out. */
  httpStatus?: number | null;
  contentType?: string | null;
}

/**
 * Decide the honest image verdict from a probe result. An image only counts as
 * `ok` when the URL is reachable (2xx) AND the server says it is an image. A
 * present-but-404 URL, an HTML error page served with status 200 (the EDEKA
 * case), or a network error all count as `broken` — never as a valid image.
 */
export function classifyImageProbe(input: ImageProbeInput): Exclude<ImageStatus, 'unchecked'> {
  if (trimmedUrl(input.url).length === 0) return 'missing';
  const status = input.httpStatus;
  if (typeof status !== 'number' || !Number.isFinite(status)) return 'broken';
  if (status < 200 || status >= 300) return 'broken';
  return isImageContentType(input.contentType) ? 'ok' : 'broken';
}

/** Minimal shape of a fetch implementation (so tests can inject a fake). */
export type FetchLike = (
  url: string,
  init?: { method?: string; signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
}>;

export interface ProbeImageOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  signal?: AbortSignal;
}

// Browser-like headers for image probes. Several CDNs/WAFs (Netto's
// media_nfs host among them) return 403 for requests WITHOUT a User-Agent —
// the very same URL serves the image fine with the browser headers the scrape
// itself already uses. Without this, every Netto image was wrongly "broken".
export const IMAGE_PROBE_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'image/avif,image/webp,image/png,image/*,*/*;q=0.8',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5',
};

/**
 * Probe a single image URL: a HEAD request first (cheap), falling back to a tiny
 * ranged GET when HEAD is unsupported (405/501) or returns no content-type.
 * Sends browser-like headers (see {@link IMAGE_PROBE_HEADERS}). Never throws —
 * a network error / timeout resolves to `{ httpStatus: null }`,
 * which {@link classifyImageProbe} treats as broken.
 */
export async function probeImageUrl(
  url: string,
  options: ProbeImageOptions = {},
): Promise<{ httpStatus: number | null; contentType: string | null }> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchImpl) return { httpStatus: null, contentType: null };
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 5000;

  const runOnce = async (method: 'HEAD' | 'GET'): Promise<{ httpStatus: number | null; contentType: string | null }> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const onParentAbort = (): void => ac.abort();
    options.signal?.addEventListener('abort', onParentAbort, { once: true });
    try {
      const res = await fetchImpl(url, {
        method,
        signal: ac.signal,
        headers:
          method === 'GET'
            ? { ...IMAGE_PROBE_HEADERS, Range: 'bytes=0-0' }
            : { ...IMAGE_PROBE_HEADERS },
      });
      return { httpStatus: res.status, contentType: res.headers.get('content-type') };
    } catch {
      return { httpStatus: null, contentType: null };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onParentAbort);
    }
  };

  const head = await runOnce('HEAD');
  // Some CDNs reject HEAD or omit the content-type — retry with a ranged GET so
  // the EDEKA-style "URL exists but not an image" case is still judged honestly.
  if (head.httpStatus === 405 || head.httpStatus === 501 || (head.httpStatus !== null && !head.contentType)) {
    return runOnce('GET');
  }
  return head;
}

export interface CheckOffersImagesOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Max simultaneous probes. */
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (checked: number, total: number, broken: number) => void;
}

export interface CheckOffersImagesResult {
  offers: ScanV2Offer[];
  /** Offers that had a URL and were actually probed. */
  imageCheckedCount: number;
  /** Of those, how many resolved to `broken`. */
  brokenImageCount: number;
  /** Offers with no URL at all. */
  missingImageCount: number;
}

/**
 * Stamp an honest `imageStatus` + `brokenImage` onto every offer by probing its
 * image URL. URLs are deduped so a shared image is fetched once. Bounded
 * concurrency + per-request timeout keep a full-snapshot check tractable; the
 * AbortSignal cancels in-flight work. Offers without a URL are marked `missing`
 * (not broken) and never probed.
 */
export async function checkOffersImages(
  offers: readonly Offer[],
  options: CheckOffersImagesOptions = {},
): Promise<CheckOffersImagesResult> {
  const concurrency = Math.max(1, Math.min(32, Math.round(options.concurrency ?? 8)));

  // 1) Collect the distinct URLs that actually need probing.
  const urlStatus = new Map<string, Exclude<ImageStatus, 'unchecked' | 'missing'>>();
  const distinctUrls: string[] = [];
  for (const offer of offers) {
    const url = trimmedUrl((offer as ScanV2Offer).imageUrl);
    if (url && !urlStatus.has(url)) {
      urlStatus.set(url, 'broken'); // placeholder until probed
      distinctUrls.push(url);
    }
  }

  let probed = 0;
  let cursor = 0;
  const total = distinctUrls.length;

  const worker = async (): Promise<void> => {
    while (cursor < total) {
      if (options.signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      const url = distinctUrls[index];
      const probe = await probeImageUrl(url, {
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
      const verdict = classifyImageProbe({
        url,
        httpStatus: probe.httpStatus,
        contentType: probe.contentType,
      });
      // verdict can only be 'ok' or 'broken' here (url is non-empty).
      urlStatus.set(url, verdict === 'ok' ? 'ok' : 'broken');
      probed += 1;
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));

  // 2) Apply the verdicts back onto each offer (URLs map to the same verdict).
  let brokenImageCount = 0;
  let imageCheckedCount = 0;
  let missingImageCount = 0;
  const stamped: ScanV2Offer[] = offers.map((offer) => {
    const url = trimmedUrl((offer as ScanV2Offer).imageUrl);
    if (!url) {
      missingImageCount += 1;
      return { ...(offer as ScanV2Offer), imageStatus: 'missing', brokenImage: false };
    }
    const verdict = urlStatus.get(url) ?? 'broken';
    imageCheckedCount += 1;
    const broken = verdict === 'broken';
    if (broken) brokenImageCount += 1;
    return { ...(offer as ScanV2Offer), imageStatus: verdict, brokenImage: broken };
  });

  options.onProgress?.(probed, total, brokenImageCount);

  return { offers: stamped, imageCheckedCount, brokenImageCount, missingImageCount };
}

// ---------------------------------------------------------------------------
// Phase 2 candidate partitioning
// ---------------------------------------------------------------------------

export interface Phase2Partition<T extends Offer> {
  /** Real/unsure food offers that may be deep-analysed. */
  food: T[];
  /** Sure non-food offers — skipped in Phase 2 (no nutrition/halal work). */
  skippedNonFood: T[];
}

/**
 * Split the Phase-2 input into food (analyse) and sure non-food (skip). Phase 2
 * runs on the snapshot's live/current food bucket only (the NextWeek bucket is
 * intentionally skipped — no AI cost/enrichment for the upcoming week), but we
 * still defensively drop anything flagged non-food so a mislabeled offer never
 * triggers an expensive + nonsensical nutrition/halal analysis.
 */
export function partitionFoodForAnalysis<T extends Offer>(
  offers: readonly T[],
): Phase2Partition<T> {
  const food: T[] = [];
  const skippedNonFood: T[] = [];
  for (const offer of offers) {
    // Defense in depth: a stale snapshot may still hold a non-food offer that
    // never went through the bridge repair — a LIVARNO/Insektenschutz name, a
    // Kaufland "nonfood" tag, a Drogerie category, or a structured isNonFood/
    // foodFlag=nonfood verdict. `hasHardNonFoodSignal` ORs every hard signal so
    // none can slip into Phase 2 deep analysis; `isNonFoodOffer` stays as a
    // belt-and-suspenders check on the same structured flags.
    if (isNonFoodOffer(offer) || hasHardNonFoodSignal(offer)) skippedNonFood.push(offer);
    else food.push(offer);
  }
  return { food, skippedNonFood };
}

/** Tag, der ein aus dem Filtered-Bucket zur erneuten Phase-2-Analyse gezogenes
 *  uncertain-Angebot markiert. Rein transient: erlaubt es der Phase-2-Reassembly,
 *  recovered-Food vs. confirmed-Non-Food zu zählen, und wird vor dem Speichern
 *  wieder entfernt (siehe stripPhase2RecheckTag). */
export const PHASE2_RECHECK_TAG = 'phase2_recheck';

export interface UncertainFilteredSelection<T extends Offer> {
  /** uncertain-Angebote aus dem Filter — Phase-2-Kandidaten (mit Recheck-Tag). */
  candidates: T[];
  /** Regelbestätigtes Non-Food / Fragmente / Locks / confirmed_food — NICHT an
   *  das Modell gesendet (Non-Food bleibt gefiltert, confirmed_food rettet der
   *  Reconciliation-Pass, Fragmente/Locks bleiben unangetastet). */
  skipped: T[];
}

/**
 * Wähle aus dem Filtered-Bucket die uncertain-Angebote als zusätzliche
 * Phase-2-Kandidaten (Task „Phase-2-Kandidaten"). So kann Phase 2 frühe
 * Phase-1-Fehler korrigieren — ohne regelbestätigtes Non-Food, Fragmente,
 * Sektionsüberschriften oder gesperrte/manuell entschiedene Angebote an das
 * Modell zu senden. Pure; markiert Kandidaten mit {@link PHASE2_RECHECK_TAG}.
 */
export function selectUncertainFilteredForPhase2<T extends Offer>(
  filtered: readonly T[],
): UncertainFilteredSelection<T> {
  const candidates: T[] = [];
  const skipped: T[] = [];
  for (const offer of filtered) {
    if (isMovementLocked(offer) || isFragmentOrSectionHeader(offer)) {
      skipped.push(offer);
      continue;
    }
    if (classifyFoodDecision(offer) === 'uncertain') {
      candidates.push({
        ...offer,
        tags: [...new Set([...(offer.tags ?? []), PHASE2_RECHECK_TAG])],
      } as T);
    } else {
      // confirmed_non_food bleibt gefiltert; confirmed_food rettet der
      // Reconciliation-Pass (kein Modell-Aufruf nötig).
      skipped.push(offer);
    }
  }
  return { candidates, skipped };
}

/** Entferne den transienten Phase-2-Recheck-Tag wieder (vor dem Persistieren). */
export function stripPhase2RecheckTag<T extends Offer>(offer: T): T {
  if (!(offer.tags ?? []).includes(PHASE2_RECHECK_TAG)) {
    return offer;
  }
  return { ...offer, tags: (offer.tags ?? []).filter((tag) => tag !== PHASE2_RECHECK_TAG) } as T;
}

/** True, wenn das Angebot zur erneuten Phase-2-Prüfung aus dem Filter kam. */
export function isPhase2Recheck(offer: Offer): boolean {
  return (offer.tags ?? []).includes(PHASE2_RECHECK_TAG);
}

export interface FragmentQuarantine<T extends Offer> {
  /** Offers safe to show live (no fragment/promo-badge names). */
  clean: T[];
  /** Fragment-named offers ("Tiefpreis", "Fl.", "Dose") — routed to the
   *  filtered bucket with a reviewNeeded tag, never silently deleted. */
  quarantined: T[];
}

/**
 * Keep fragment/promo-badge names ("Tiefpreis", "Fl.", "Dose", "Packung") out
 * of the VISIBLE buckets. They are quarantined into `filtered` (tagged
 * name_fragment + reviewNeeded) instead of deleted, so a preserved manual
 * import can be repaired later. Uses the HARD bad-name check (promo/packaging/
 * descriptor-only) — never the REWE-OCR leader rule, which would wrongly
 * quarantine real products like "Die Streichzarte gesalzen". The snapshot
 * safety gate keeps a `fragmentOffersLive` backstop in case a caller forgets
 * this step.
 */
export function quarantineFragmentOffers<T extends Offer>(
  offers: readonly T[],
): FragmentQuarantine<T> {
  const clean: T[] = [];
  const quarantined: T[] = [];
  for (const offer of offers) {
    if (isHardBadOfferName(offer.name)) {
      quarantined.push({
        ...offer,
        tags: [...new Set([...(offer.tags ?? []), 'name_fragment', 'reviewNeeded'])],
      } as T);
    } else if (isNameQualityFragment(offer)) {
      // Task P2 — generisches Namensqualitäts-Fragment (isoliertes Attributwort
      // wie „kernarm"): die ZENTRALE Normalisierung setzt Tag + reviewReason und
      // neutralisiert die Non-Food-Optik (canonicalCategory/foodFlag), damit der
      // PERSISTIERTE Offer als name_quality erscheint (nicht als Food-/Non-Food-
      // Review). Editorial gesperrte Angebote bleiben unberührt (Guard innen).
      quarantined.push(markNameQualityFragment(offer));
    } else {
      clean.push(offer);
    }
  }
  return { clean, quarantined };
}

export interface FragmentQuarantineGateBuckets {
  offers: Offer[];
  nextWeekOffers: Offer[];
  filteredOffers: Offer[];
}

export interface FragmentQuarantineGateResult extends FragmentQuarantineGateBuckets {
  /** Fragment offers moved out of the visible buckets into `filteredOffers`. */
  movedCount: number;
  movedExamples: string[];
  /** Name-Quality-Fragmente, die bereits im Filter lagen und nur strukturell
   *  normalisiert wurden (Felder repariert, kein Bucket-Wechsel). */
  normalizedCount: number;
  normalizedExamples: string[];
  /** Echte Ein-Wort-PRODUKTE, denen ein früherer Pass fälschlich name_quality
   *  aufgestempelt hatte und die hier denormalisiert wurden (Tag entfernt,
   *  Non-Food-Verdikt wiederhergestellt) — kein Bucket-Wechsel. */
  repairedCount: number;
  repairedExamples: string[];
}

/**
 * Fragment gate over ALL snapshot buckets: every hard bad-name offer in
 * `offers`/`nextWeekOffers` is quarantined into `filteredOffers` (tagged
 * name_fragment + reviewNeeded, deduped by id). Counterpart to
 * applyFinalNonFoodGate for names instead of food signals, so a persisted
 * snapshot with fragment leaks ("l-Dose") is repaired on boot/save — not only
 * during a fresh scan. Pure + idempotent.
 */
export function applyFragmentQuarantineGate(
  buckets: FragmentQuarantineGateBuckets,
): FragmentQuarantineGateResult {
  const current = quarantineFragmentOffers(buckets.offers);
  const next = quarantineFragmentOffers(buckets.nextWeekOffers);

  // Name-Quality-Fragmente, die BEREITS im Filter liegen (der „kernarm"-Repro-Fall:
  // gefiltert, aber Felder unsauber/Non-Food-Optik), werden hier in-place
  // normalisiert — der Move-Pfad oben sieht nur die sichtbaren Buckets. Idempotent
  // über isNameQualityNormalized; echtes Non-Food / Cache-Konflikt / Food bleiben
  // unberührt (isNameQualityFragment schließt sie aus).
  const normalizedExamples: string[] = [];
  let normalizedCount = 0;
  const repairedExamples: string[] = [];
  let repairedCount = 0;
  const filteredOffers = buckets.filteredOffers.map((offer) => {
    // Zuerst ein FALSCH persistiertes name_quality-Tag auf einem echten Produkt
    // denormalisieren (Tag entfernen, Non-Food-Verdikt wiederherstellen), bevor
    // die Fragment-Normalisierung greift — sonst würde markNameQualityFragment es
    // sofort wieder quarantänisieren. Echte Fragmente (kernarm) bleiben unberührt.
    const repaired = repairNonFragmentNameQuality(offer);
    if (repaired !== offer) {
      repairedCount += 1;
      if (repairedExamples.length < 8) {
        repairedExamples.push(offer.name);
      }
      return repaired;
    }
    if (!isNameQualityFragment(offer) || isNameQualityNormalized(offer)) {
      return offer;
    }
    normalizedCount += 1;
    if (normalizedExamples.length < 8) {
      normalizedExamples.push(offer.name);
    }
    return markNameQualityFragment(offer);
  });

  const filteredIds = new Set(filteredOffers.map((offer) => offer.id));
  const moved = [...current.quarantined, ...next.quarantined];
  for (const offer of moved) {
    if (!filteredIds.has(offer.id)) {
      filteredIds.add(offer.id);
      filteredOffers.push(offer);
    }
  }
  return {
    offers: current.clean,
    nextWeekOffers: next.clean,
    filteredOffers,
    movedCount: moved.length,
    movedExamples: [...new Set(moved.map((offer) => offer.name))].slice(0, 8),
    normalizedCount,
    normalizedExamples: [...new Set(normalizedExamples)].slice(0, 8),
    repairedCount,
    repairedExamples: [...new Set(repairedExamples)].slice(0, 8),
  };
}

/** Count editorially locked/manual offers (never sent to the model in Phase 2). */
export function countLocked(offers: readonly Offer[]): number {
  let count = 0;
  for (const offer of offers) {
    if (isLockedOrManual(offer)) count += 1;
  }
  return count;
}
