// Per-store completeness + honest verification status over the offer snapshot.
//
// The existing offersQuality.ts scores per-store DATA quality (images, prices,
// categories). This module answers a different, scraper-focused question: did
// we actually import a believable SHARE of what the store offers this week?
//
// It is deliberately pure (no IO, no global state) so both dashboards and the
// scan report can reuse it, and so it is trivially unit-testable. Three honest
// inputs feed the verdict:
//   1. official current food count (e.g. Kaufland SSR) — the gold standard,
//   2. a per-store expectedMin baseline — used when no official count exists,
//   3. a verification flag — some stores (EDEKA/Netto) block direct checks, so
//      their numbers can NEVER be trusted as "healthy", only "unverified".
//
// currentImported counts offers ACTIVE TODAY (validityStart <= now <= end),
// upcomingImported counts not-yet-started offers — using the same honest
// classifyOfferBucket the export uses, so "337 live" no longer hides 298
// future Kaufland offers.

import type { Offer } from '../../src/types/models';
import { classifyOfferBucket } from '../../src/utils/offerBucket';
import { NAHKAUF_LOCAL_OFFER_TAG } from '../../src/services/offersIngest/sourceConnectors/storeImportStrategy';

export type StoreVerification = 'verified' | 'blocked';

/** How much of the store's real weekly assortment the automated source can
 *  structurally deliver. 'structured_only' = the public source only exposes a
 *  SUBSET as structured data (e.g. Lidl: leaflet JSON carries online/wine
 *  products; Frische offers exist only as leaflet IMAGES) — such a store may
 *  never be reported as fully "healthy", no matter how well the subset
 *  imports. */
export type StoreCoverage =
  | 'full'
  | 'structured_only'
  | 'national_only'
  // Erweiterte, ehrliche Quell-Abdeckungs-Zustände für das Coverage-Audit
  // (StoreImportHealthRow.sourceCoverage). Sie werden NICHT vom internen
  // Completeness-/Eskalations-Pfad erzeugt (der bleibt full/structured_only/
  // national_only) — nur als ehrliches Anzeige-Label abgeleitet:
  //   partial_with_ocr — strukturierter Teilimport zusätzlich mit OCR-Angeboten
  //                       (Lidl-Prospektbild-OCR aktiv, aber noch unvollständig)
  //   partial_with_vision — strukturierter Teilimport zusätzlich mit Vision-Angeboten
  //                       (Lidl-Prospektbild-Vision aktiv, aber noch unvollständig)
  //   partial_with_viewer_json — strukturierter Auto-Teilimport aus der öffentlichen
  //                       Prospekt-Viewer-JSON (Lidl v4/flyer products-Map): nur
  //                       strukturiert bepreiste Angebote sind importiert, preislose
  //                       Frische-Hotspots bleiben pending — NIE eine full-Behauptung
  //   browser_import    — nur über Browser-Bookmarklet/PDF importierbar (REWE)
  //   manual_review_import — bewusst manueller Prospekt-Link-Import mit Review-Queue
  //                       (Lidl): nur approved Angebote live,
  //                       nie eine full-Coverage-Behauptung
  //   unverifiable      — Quelle blockiert/robots-ausgeschlossen, Vollständigkeit
  //                       nicht prüfbar (Netto)
  | 'partial_with_ocr'
  | 'partial_with_vision'
  | 'partial_with_viewer_json'
  | 'browser_import'
  | 'manual_review_import'
  | 'unverifiable';

export interface StoreExpectation {
  /** Lowest believable current food-offer count for a healthy weekly scrape.
   *  For structured_only stores this stays the FULL-assortment expectation —
   *  it must never be lowered just to paint a partial import green. */
  expectedMin?: number;
  /** 'blocked' => source/images 403/captcha; completeness can't be trusted. */
  verification?: StoreVerification;
  /** Partial-source marker (see {@link StoreCoverage}). Default 'full'. */
  coverage?: StoreCoverage;
  /** Verifikationsanker für coverage 'full' bei marktbezogenen Quellen
   *  (nahkauf): 'full' ist nur ein ANSPRUCH aus der Konfiguration. Erst wenn
   *  mindestens ein sichtbares Angebot dieses Tag trägt, gilt der lokale
   *  Import als belegt — sonst fällt die effektive Coverage ehrlich auf
   *  'national_only' zurück (keine false-positive "ok"-Bewertung bei
   *  ungültiger/wirkungsloser Markt-ID). */
  localVerificationTag?: string;
  /** Human-readable reason shown in the report. */
  note?: string;
}

// Conservative defaults. Only the stores the external check flagged get a
// baseline/blocked marker so we don't paint healthy stores yellow. Keys are
// normalized (lowercase, trimmed) store chains.
export const DEFAULT_STORE_EXPECTATIONS: Record<string, StoreExpectation> = {
  edeka: {
    // Die Angebotsseite ist direkt lesbar (serverseitig gerendertes HTML), zeigt
    // OHNE Marktauswahl aber nur die NATIONALEN Angebote — lokale/regionale
    // Angebote (nur im Browser wählbar) sind nicht abgedeckt. Coverage daher
    // dauerhaft 'national_only' (nie 'full'); ein tatsächlich blockierter Lauf
    // (403/Captcha) wird zur Laufzeit über die EDEKA-Import-Diagnose ehrlich als
    // blocked gemeldet (siehe storeImportHealth).
    coverage: 'national_only',
    note: 'Nationale EDEKA-Angebote importiert (serverseitiges HTML); lokale/regionale Marktangebote nicht abgedeckt — Vollständigkeit nicht verifizierbar.',
  },
  netto: {
    verification: 'blocked',
    // Ohne Filialwahl zeigt netto-online.de national nur das ~24-Tile-Widget
    // "Filial-Angebote"; die Filialwahl läuft über /INTERSHOP/-Pipelines, die
    // robots.txt ausschließt — wir nutzen sie deshalb bewusst NICHT. 20 ist
    // die ehrliche Untergrenze für ein funktionierendes Widget.
    expectedMin: 20,
    note: 'Netto zeigt ohne Filialwahl nur die nationalen Filial-Highlights (~24); die Filialwahl-API ist per robots.txt ausgeschlossen — Vollsortiment nicht verifizierbar.',
  },
  lidl: {
    // VOLLE Wochen-Erwartung (~60 Food-Angebote im Filialprospekt). Der
    // Auto-Import liest die öffentliche v4/flyer-Viewer-JSON (products-Map) der
    // serverseitig gelisteten Aktionsprospekte — strukturiert bepreist sind dort
    // aber nur Onlineshop-verlinkte Produkte (Wein/Spirituosen + Non-Food);
    // Frische-Angebote existieren ausschließlich als Prospekt-BILDER/preislose
    // Hotspots (verifiziert: Food-Seiten tragen nur recipe-Links, keine
    // Produktpreise). coverage 'structured_only' hält Lidl deshalb dauerhaft
    // auf "warn" — expectedMin wird NICHT gesenkt, um den Teilimport grün zu
    // färben; das Anzeige-Label verfeinert auf partial_with_viewer_json.
    expectedMin: 60,
    coverage: 'structured_only',
    note: 'Lidl-Teilimport aus der öffentlichen Prospekt-Viewer-JSON (v4/flyer products-Map): strukturiert bepreist sind nur Onlineshop-verlinkte Produkte (Wein/Spirituosen + Non-Food); Frische-/Lebensmittelangebote existieren nur als preislose Prospekt-Hotspots und bleiben pending (manueller Review-Import als Ergänzung).',
  },
  kaufland: {
    expectedMin: 400,
  },
  nahkauf: {
    // Ohne Markt-ID liefert die Storyblok-CDN-API nur die national_all-Angebote
    // (~30–40/Woche von ~600 Stories) — die lokalen Marktangebote des jeweiligen
    // nahkauf bleiben unverifiziert. coverage 'national_only' hält den Status
    // deshalb auf "warn", bis NAHKAUF_MARKET_ID gesetzt ist (siehe
    // buildStoreExpectations).
    expectedMin: 30,
    coverage: 'national_only',
    note: 'Nationale Angebote importiert, lokale Marktangebote nicht verifiziert — NAHKAUF_MARKET_ID setzen für marktbezogenen Import.',
  },
};

export interface BuildStoreExpectationsOptions {
  /** Konfigurierte nahkauf Markt-ID (appConfig.nahkaufMarketId). Wenn gesetzt,
   *  importiert der Connector zusätzlich die lokalen Angebote dieses Markts —
   *  nahkauf gilt dann als voll abgedeckt. */
  nahkaufMarketId?: string;
}

/**
 * Laufzeit-Erwartungen: wie {@link DEFAULT_STORE_EXPECTATIONS}, aber mit der
 * tatsächlichen Konfiguration abgeglichen. Pure + testbar — der Server reicht
 * appConfig hier hinein statt dass dieses Modul global liest.
 */
export function buildStoreExpectations(
  options: BuildStoreExpectationsOptions = {},
): Record<string, StoreExpectation> {
  const expectations: Record<string, StoreExpectation> = { ...DEFAULT_STORE_EXPECTATIONS };
  const marketId = (options.nahkaufMarketId ?? '').trim();
  if (marketId) {
    expectations.nahkauf = {
      ...expectations.nahkauf,
      coverage: 'full',
      // 'full' gilt erst als belegt, wenn der Snapshot lokale Marktangebote
      // (Connector-Tag) enthält — sonst degradiert die Auswertung ehrlich auf
      // national_only (siehe computeStoreCompleteness).
      localVerificationTag: NAHKAUF_LOCAL_OFFER_TAG,
      note: `nahkauf-Markt ${marketId} konfiguriert — nationale + lokale Marktangebote werden importiert.`,
    };
  }
  return expectations;
}

export type StoreCompletenessStatus = 'healthy' | 'warn' | 'critical' | 'unverified';

export interface StoreCompletenessRow {
  storeChain: string;
  currentImported: number;
  upcomingImported: number;
  filteredCount: number;
  expectedMin: number | null;
  officialCount: number | null;
  /** importedCurrent / (officialCount ?? expectedMin), 0..1, or null if unknown. */
  completenessScore: number | null;
  /** EFFEKTIVE Abdeckung: wie expectation.coverage, aber ein 'full'-Anspruch
   *  mit localVerificationTag degradiert auf 'national_only', solange kein
   *  sichtbares Angebot das Tag trägt (lokaler Import nicht belegt). */
  coverage: StoreCoverage;
  status: StoreCompletenessStatus;
  reasons: string[];
}

export interface StoreCompletenessInput {
  offers: Offer[];
  nextWeekOffers: Offer[];
  filteredOffers: Offer[];
  /** Normalized store chain -> official current food-offer count (e.g. Kaufland). */
  officialCounts?: Record<string, number>;
  expectations?: Record<string, StoreExpectation>;
  now?: Date;
}

export interface StoreCompletenessReport {
  generatedAt: string;
  stores: StoreCompletenessRow[];
}

// Thresholds for the completeness score (importedCurrent / denominator).
const SCORE_HEALTHY = 0.8;
const SCORE_WARN = 0.5;
// Absolute fallbacks when a store has NO official count and NO expectedMin.
const ABS_CRITICAL = 5; // <5 current offers ⇒ scraper almost certainly broken
const ABS_WARN = 25; // <25 ⇒ suspiciously thin

function normalizeChainKey(storeChain: string): string {
  return storeChain.trim().toLowerCase();
}

function roundScore(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
}

interface StoreAccumulator {
  storeChain: string;
  currentImported: number;
  upcomingImported: number;
  filteredCount: number;
  /** True, sobald ein sichtbares Angebot das localVerificationTag trägt. */
  localVerified: boolean;
}

function emptyAcc(storeChain: string): StoreAccumulator {
  return {
    storeChain,
    currentImported: 0,
    upcomingImported: 0,
    filteredCount: 0,
    localVerified: false,
  };
}

export function computeStoreCompleteness(
  input: StoreCompletenessInput,
): StoreCompletenessReport {
  const now = input.now ?? new Date();
  const expectations = input.expectations ?? DEFAULT_STORE_EXPECTATIONS;
  const officialCounts = input.officialCounts ?? {};
  const byStore = new Map<string, StoreAccumulator>();

  const ensure = (storeChain: string): StoreAccumulator => {
    const chain = storeChain?.trim() || 'Unbekannt';
    let acc = byStore.get(chain);
    if (!acc) {
      acc = emptyAcc(chain);
      byStore.set(chain, acc);
    }
    return acc;
  };

  // Live + next-week buckets re-classified honestly into active vs upcoming.
  for (const offer of [...input.offers, ...input.nextWeekOffers]) {
    const acc = ensure(offer.storeChain);
    const bucket = classifyOfferBucket(offer, now);
    if (bucket === 'upcoming') {
      acc.upcomingImported += 1;
    } else if (bucket === 'current') {
      acc.currentImported += 1;
    } else {
      // Abgelaufene Angebote belegen keinen funktionierenden Import dieser Woche.
      continue;
    }
    const localTag = expectations[normalizeChainKey(offer.storeChain)]?.localVerificationTag;
    if (localTag && (offer.tags ?? []).includes(localTag)) {
      acc.localVerified = true;
    }
  }
  for (const offer of input.filteredOffers) {
    ensure(offer.storeChain).filteredCount += 1;
  }

  const stores = [...byStore.values()].map((acc) => {
    const key = normalizeChainKey(acc.storeChain);
    const expectation = expectations[key] ?? {};
    const officialCount =
      typeof officialCounts[key] === 'number' ? officialCounts[key] : null;
    const expectedMin =
      typeof expectation.expectedMin === 'number' ? expectation.expectedMin : null;
    const denominator = officialCount ?? expectedMin;
    const completenessScore =
      denominator && denominator > 0 ? roundScore(acc.currentImported / denominator) : null;

    const reasons: string[] = [];
    let status: StoreCompletenessStatus;

    // Effektive Coverage: ein konfigurierter 'full'-Anspruch (Markt-ID) zählt
    // erst, wenn der Snapshot ihn belegt — sonst ehrlich national_only.
    const requestedCoverage = expectation.coverage ?? 'full';
    const localUnverified =
      requestedCoverage === 'full' &&
      Boolean(expectation.localVerificationTag) &&
      !acc.localVerified;
    const coverage: StoreCoverage = localUnverified ? 'national_only' : requestedCoverage;
    if (coverage !== 'full') {
      // Partial source: the automated import can structurally never reach the
      // full weekly assortment (structured_only: Frische nur als Bilder;
      // national_only: lokale Marktangebote ohne Markt-ID unverifiziert).
      // A working subset is honestly "warn" (never healthy); a collapsed
      // import (almost nothing) stays critical.
      if (acc.currentImported < ABS_CRITICAL && acc.upcomingImported < ABS_CRITICAL) {
        status = 'critical';
        reasons.push(
          `Nur ${acc.currentImported} aktuelle Angebote — Import vermutlich defekt (auch der verfügbare Teil fehlt).`,
        );
      } else if (acc.currentImported < ABS_CRITICAL && acc.upcomingImported >= ABS_CRITICAL) {
        // Der Import funktioniert nachweislich (kommende Angebote geparst) — die
        // Quelle liefert nur (noch) die nächste Aktionswoche (z. B. am Wochenende
        // vor dem Wochenwechsel). Quellzustand, kein Defekt: ehrlich "warn".
        status = 'warn';
        reasons.push(
          `Keine aktuellen Angebote, aber ${acc.upcomingImported} kommende importiert — die Quelle liefert aktuell nur die nächste Aktionswoche.`,
        );
      } else {
        status = 'warn';
        reasons.push(
          coverage === 'national_only'
            ? localUnverified
              ? `Markt-ID konfiguriert, aber keine lokalen Marktangebote im Snapshot (${acc.currentImported} nationale aktuelle) — Markt-ID prüfen oder neuen Scan ausführen.`
              : `Nur nationale Angebote importiert (${acc.currentImported} aktuelle) — lokale Marktangebote nicht verifiziert.`
            : `Teilimport: ${acc.currentImported} strukturierte aktuelle Angebote` +
                (denominator ? ` von ~${denominator} erwarteten Wochen-Angeboten` : '') +
                ' — Rest nicht strukturiert verfügbar.',
        );
      }
    } else if (expectation.verification === 'blocked') {
      status = 'unverified';
      reasons.push(
        expectation.note ??
          'Quelle blockiert die Prüfung — Vollständigkeit nicht verifizierbar.',
      );
      // Still surface a thinness hint even when unverified.
      if (denominator && completenessScore !== null && completenessScore < SCORE_WARN) {
        reasons.push(
          `Nur ${acc.currentImported} aktuelle Angebote (erwartet ~${denominator}).`,
        );
      }
    } else if (acc.currentImported === 0) {
      if (acc.upcomingImported > 0) {
        // Der Import funktioniert nachweislich (kommende Angebote wurden
        // geparst) — die Quelle liefert nur (noch) keine aktuelle Kampagne,
        // z. B. kurz vor dem Wochenwechsel. Das ist ein Quellzustand, kein
        // Scraper-Defekt: ehrlich "warn" mit Erklärung statt critical.
        status = 'warn';
        reasons.push(
          `Keine aktuellen Angebote, aber ${acc.upcomingImported} kommende importiert — die Quelle liefert aktuell nur die nächste Aktionswoche.`,
        );
      } else {
        status = 'critical';
        reasons.push('Keine aktuellen Angebote importiert — Scraper vermutlich defekt.');
      }
    } else if (completenessScore !== null) {
      if (completenessScore >= SCORE_HEALTHY) {
        status = 'healthy';
      } else if (completenessScore >= SCORE_WARN) {
        status = 'warn';
        reasons.push(
          `Nur ${Math.round(completenessScore * 100)} % der erwarteten ~${denominator} Angebote importiert.`,
        );
      } else {
        status = 'critical';
        reasons.push(
          `Nur ${acc.currentImported} von erwarteten ~${denominator} aktuellen Angeboten (${Math.round(
            completenessScore * 100,
          )} %).`,
        );
      }
    } else if (acc.currentImported < ABS_CRITICAL) {
      status = 'critical';
      reasons.push(`Nur ${acc.currentImported} aktuelle Angebote — Scraper vermutlich defekt.`);
    } else if (acc.currentImported < ABS_WARN) {
      status = 'warn';
      reasons.push(`Nur ${acc.currentImported} aktuelle Angebote — verdächtig wenig.`);
    } else {
      status = 'healthy';
    }

    if (expectation.note && status !== 'unverified' && !reasons.includes(expectation.note)) {
      reasons.push(expectation.note);
    }

    return {
      storeChain: acc.storeChain,
      currentImported: acc.currentImported,
      upcomingImported: acc.upcomingImported,
      filteredCount: acc.filteredCount,
      expectedMin,
      officialCount,
      completenessScore,
      coverage,
      status,
      reasons,
    } satisfies StoreCompletenessRow;
  });

  // Worst status first, then by current count, so broken stores surface on top.
  const statusRank: Record<StoreCompletenessStatus, number> = {
    critical: 0,
    unverified: 1,
    warn: 2,
    healthy: 3,
  };
  stores.sort(
    (a, b) =>
      statusRank[a.status] - statusRank[b.status] ||
      b.currentImported - a.currentImported ||
      a.storeChain.localeCompare(b.storeChain, 'de'),
  );

  return { generatedAt: now.toISOString(), stores };
}
