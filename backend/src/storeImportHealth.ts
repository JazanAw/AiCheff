// Per-shop import health report (Task 3 + 4). After each scan this produces one
// honest quality row per store, combining:
//   • the explicit import STRATEGY (Task 1),
//   • the existing per-store completeness logic (storeCompleteness.ts) — reused,
//     NOT replaced — as the model for "did we import a believable share?",
//   • food vs non-food counts + broken-image counts from the snapshot,
//   • the Kaufland official-vs-imported gap, and
//   • the honest REWE browser/PDF/web-verification status.
//
// Pure (no IO, no global state): the caller passes in the snapshot buckets + the
// captured Kaufland/REWE diagnostics, so it is cheap and trivially unit-testable.

import type { Offer } from '../../src/types/models';
import { classifyOfferBucket } from '../../src/utils/offerBucket';
import { classifyLiveWindow } from './snapshotLiveWindow';
import {
  computeStoreCompleteness,
  DEFAULT_STORE_EXPECTATIONS,
  type StoreCompletenessRow,
  type StoreCoverage,
  type StoreExpectation,
} from './storeCompleteness';
import {
  resolveStoreImportStrategy,
  type ImportStrategy,
} from '../../src/services/offersIngest/sourceConnectors/storeImportStrategy';
import { isStrongNonFoodLeak } from './snapshotNonFoodGate';
import { classifyFilteredOfferForRescue } from './snapshotFoodRescue';
import type {
  KauflandCompleteness,
  EdekaImportDiagnostics,
  AldiNordImportDiagnostics,
  AldiSuedImportDiagnostics,
  NahkaufImportDiagnostics,
} from '../../src/services/offersIngest/sourceConnectors/officialSupermarketConnector';
import type { ReweImportReportData } from './reweBrowserImport';

// 'excluded' = der Store ist bewusst vom automatischen Scan ausgeschlossen
// (manueller Browser-/PDF-Import) und hat (noch) nichts importiert — das ist
// kein Defekt und darf NIE als critical zählen.
// 'disabled' = der Store ist per Policy DEAKTIVIERT (unsichere Quelle, z. B.
// ALDI SÜD/NORD, Lidl): bewusst nicht gescannt, aus dem Snapshot entfernt — kein
// Fehler, niemals critical, erzeugt keine Mindestmengen-Warnung.
export type ImportHealthStatus = 'ok' | 'warning' | 'critical' | 'excluded' | 'disabled';
export type WebVerificationStatus = 'imported' | 'blocked' | 'unverified' | 'ok';

export interface StoreImportHealthRow {
  storeChain: string;
  strategy: ImportStrategy;
  /** Raw offers fetched from the source (only known for the REWE import; null
   *  elsewhere — we never invent a number we cannot measure). */
  fetchedCount: number | null;
  /** Offers actually parsed into the snapshot for this store (food + non-food). */
  parsedCount: number | null;
  currentCount: number;
  nextWeekCount: number;
  /** Food offers (current + next week) — the visible/analysable ones. */
  foodCount: number;
  /** Filtered offers with a rule-confirmed non-food signal — the ONLY honest
   *  "non-food" number (no longer the raw filtered count). Same central verdict
   *  as the Food-Rescue / Scan-Report / REWE completeness. */
  nonFoodCount: number;
  /** Filtered offers with neither a non-food proof nor a food signal (review). */
  reviewCount: number;
  /** Filtered offers with a strong food signal — suspected wrongly filtered. */
  foodSuspectCount: number;
  filteredCount: number;
  /** Honest estimate of how many offers are likely missing, or null when it
   *  cannot be measured (no official count / blocked source). */
  missingEstimate: number | null;
  brokenImageCount: number;
  /** brokenImageCount / (current + next), 0..1, or null when no offers. */
  brokenImageRate: number | null;
  /** Share of VISIBLE (current+next) offers in the Alkohol category, 0..1, or
   *  null when the store has no visible offers. A food feed that is (almost)
   *  only alcohol is one-sided — it must never look like a complete import. */
  alcoholShare: number | null;
  /** Clear non-food offers LEAKED into the visible (current+next) buckets —
   *  after the final gate this must be 0; anything else is a data-quality bug. */
  nonFoodLeakCount: number;
  /** Up to a handful of leaked names (never huge lists). */
  nonFoodLeakExamples: string[];
  /** Partial-source marker, mirrored from the completeness expectation:
   *  'structured_only' (Lidl: nur strukturierte Prospektdaten) bzw.
   *  'national_only' (nahkauf ohne Markt-ID: nur nationale Angebote). Treibt die
   *  Health-Eskalation (full/structured_only/national_only). */
  importCoverage: StoreCoverage;
  /** Die rechtlich sichere öffentliche Quelle, aus der dieser Shop importiert
   *  wird (oder null für unbekannte Shops). */
  sourceUrl: string | null;
  /** Ehrliches Anzeige-Label der Quell-Abdeckung für das Coverage-Audit — wie
   *  {@link importCoverage}, aber verfeinert um die blockierten/Browser-/OCR-
   *  Zustände (unverifiable/browser_import/partial_with_ocr). Reines Label, es
   *  beeinflusst die Health-Eskalation NICHT. */
  sourceCoverage: StoreCoverage;
  /** Angebote, die im LIVE-Bucket (offers) liegen, aber laut Datumsfenster gar
   *  nicht aktiv sind (bereits abgelaufen oder erst künftig) — "false-live". */
  falseLiveCount: number;
  /** Bounded example names of the false-live offers. */
  falseLiveExamples: string[];
  /** Bounded example names of filtered offers with a strong food signal
   *  (verdict 'rescue') — Lebensmittel, die vermutlich falsch gefiltert wurden. */
  foodInFilterExamples: string[];
  warnings: string[];
  webVerification: WebVerificationStatus;
  importHealth: ImportHealthStatus;
  /** REWE/nahkauf only: was data imported via the browser bookmarklet / a PDF?
   *  undefined for stores where this is not applicable. */
  browserImportAvailable?: boolean;
  pdfImportAvailable?: boolean;
  /** ALDI only: pending Review-Kandidaten aus dem manuellen PDF-Import, die auf
   *  manuelle Bestätigung warten (NIE live). Treibt nie 'critical' — ein offener
   *  Review ist kein Import-Defekt. undefined wo nicht anwendbar. */
  pendingReviewCount?: number;
  /** ALDI only: bestätigte (approved), aber noch NICHT committete Kandidaten. */
  approvedNotCommittedCount?: number;
}

export interface StoreImportHealthReport {
  generatedAt: string;
  stores: StoreImportHealthRow[];
}

export interface StoreImportHealthInput {
  offers: Offer[];
  nextWeekOffers: Offer[];
  filteredOffers: Offer[];
  /** Normalized chain -> official current food-offer count (e.g. Kaufland). */
  officialCounts?: Record<string, number>;
  kauflandCompleteness?: KauflandCompleteness | null;
  /** EDEKA-Import-Diagnose des letzten Laufs (Zählkette + blocked/empty-Status).
   *  Treibt die ehrliche EDEKA-Zeile: reachable+parsed vs. blocked vs.
   *  parser_failure vs. empty. null = in diesem Prozess kein EDEKA-Lauf. */
  edeka?: EdekaImportDiagnostics | null;
  /** ALDI-NORD-Import-Diagnose des letzten Laufs (strukturierte Zählkette +
   *  apiData-/blocked-Status). Treibt die ehrliche ALDI-NORD-Zeile: ok bei
   *  belegtem strukturiertem Import, warning bei dünner Coverage / fehlendem
   *  apiData, blocked/critical bei nicht erreichbarer Quelle. null = in diesem
   *  Prozess kein ALDI-NORD-Lauf. */
  aldiNord?: AldiNordImportDiagnostics | null;
  /** ALDI-SÜD-Import-Diagnose des letzten Laufs (strukturierte Zählkette über die
   *  3 öffentlichen Wochenangebot-Kategorieseiten + per-URL blocked-Status).
   *  Treibt die ehrliche ALDI-SÜD-Zeile: ok bei belegtem strukturiertem Import,
   *  warning bei Teilblockade / dünner Coverage, blocked/critical bei nicht
   *  erreichbaren Quellen. null = in diesem Prozess kein ALDI-SÜD-Lauf. */
  aldiSued?: AldiSuedImportDiagnostics | null;
  /** nahkauf-Import-Diagnose des letzten Laufs (Storyblok-Zählkette + belegter
   *  source-gap). Treibt die ehrliche nahkauf-Zeile: ein Storyblok-Space ganz
   *  ohne Offer-Stories, dessen „Angebote"-Link auf rewe.de zeigt, ist ein
   *  source-gap (warning, NIE critical) — kein Import-Defekt. null = in diesem
   *  Prozess kein nahkauf-Lauf. */
  nahkauf?: NahkaufImportDiagnostics | null;
  /** Honest REWE import diagnostics, when an import has run this process.
   *  Applied ONLY to the REWE row — never to nahkauf or any other store. */
  rewe?: {
    report?: ReweImportReportData | null;
    method?: 'browser' | 'pdf' | null;
  } | null;
  /** Stores intentionally excluded from the automatic scan (manual import
   *  only). An excluded store with zero imported offers is 'excluded'/skipped,
   *  never 'critical'. Normalized internally (case-insensitive). */
  excludedStores?: readonly string[];
  /** Stores DISABLED by policy (per OFFERS_DISABLED_STORES; default empty).
   *  They ALWAYS appear in the report with status 'disabled' ("not scanned by
   *  policy"), never critical and never producing a Mindestmengen-/
   *  Completeness-Warning. Normalized internally. */
  disabledStores?: readonly string[];
  /** ALDI-PDF-Review-Queue-Stand pro Store (normalisierter Chain-Key →
   *  pending/approved). Wird NUR auf den ALDI-Zeilen angezeigt; treibt nie
   *  'critical' (ein offener Review ist kein Import-Defekt). */
  aldiReviewByStore?: Record<string, { pending: number; approved: number }>;
  /** Manueller Lidl-Prospekt-Review-Stand (pending/approved). Wird NUR auf der
   *  Lidl-Zeile angezeigt; treibt nie 'critical'. */
  lidlReview?: { pending: number; approved: number };
  expectations?: Record<string, StoreExpectation>;
  now?: Date;
}

// Stores that must ALWAYS appear in the report even with zero imported offers,
// so the report stays honest about REWE (browser/PDF import), nahkauf (Storyblok
// API; 0 offers must be visible), ALDI NORD (structured website import; a
// fetch_failed / missing-apiData run must show as warning, never silently absent)
// and Lidl (structured viewer-JSON auto import; a broken discovery/fetch must
// surface as critical/warning instead of a silently missing row).
const ALWAYS_REPORT_STORES = ['REWE', 'nahkauf', 'EDEKA', 'ALDI NORD', 'ALDI SUED', 'Lidl'] as const;

// Broken-image thresholds (share of visible current+next offers).
const BROKEN_IMAGE_WARN_RATE = 0.3;
const BROKEN_IMAGE_CRITICAL_RATE = 0.8;

// A visible feed that is ≥ 70 % alcohol (with a believable sample size) is a
// one-sided import — the Lidl case where the structured leaflet data carries
// only Wein/Spirituosen as "food". Such a store is at best a warning.
const ALCOHOL_DOMINANT_SHARE = 0.7;
const ALCOHOL_SHARE_MIN_SAMPLE = 10;

// Kaufland-Vollständigkeit: ab diesem Anteil fehlender offizieller Food-Namen
// (missing / officialDistinct) ist der Import höchstens "warning".
const KAUFLAND_MISSING_WARN_SHARE = 0.1;

// Non-Food-Leaks im sichtbaren Feed: jedes klare Non-Food-Angebot in
// current/next ist mindestens "warning"; ab dieser Anzahl ist der Store
// "critical" (der Repair-Pass ist dann offensichtlich nicht gelaufen).
const NONFOOD_LEAK_CRITICAL_COUNT = 10;
const NONFOOD_LEAK_EXAMPLES_MAX = 4;
// Beispiel-Obergrenze für die Audit-Felder (false-live / food-in-filter) — nie
// riesige Listen, nur eine Handvoll belegender Beispiele.
const AUDIT_EXAMPLES_MAX = 4;

// Web-Beleg für einen unvollständigen REWE-Import: zeigt die geladene Seite
// mindestens REWE_WEB_MISSING_MIN Preis-Kacheln mehr als importiert wurden UND
// mindestens diesen Anteil des Imports, ist der Import vermutlich unvollständig
// (Lazy-Load nicht ausgelöst, Tabs/„mehr anzeigen" nicht expandiert).
const REWE_WEB_MISSING_MIN = 10;
const REWE_WEB_MISSING_SHARE = 0.3;

// 'excluded'/'disabled' rangieren als am wenigsten alarmierend (bewusst
// übersprungen/deaktiviert, kein Defekt).
const healthRank: Record<ImportHealthStatus, number> = {
  critical: 0,
  warning: 1,
  ok: 2,
  excluded: 3,
  disabled: 4,
};

function normalizeChainKey(storeChain: string): string {
  return storeChain.trim().toLowerCase();
}

function isBrokenImage(offer: Offer): boolean {
  const o = offer as Offer & { brokenImage?: unknown; imageStatus?: unknown };
  return o.brokenImage === true || String(o.imageStatus ?? '').toLowerCase() === 'broken';
}

interface StorePass {
  current: number;
  next: number;
  filtered: number;
  /** Filtered offers per central rescue verdict (keep/review/rescue). */
  ruleNonFood: number;
  review: number;
  foodSuspect: number;
  broken: number;
  /** Broken images among the VISIBLE (current+next) offers only — the honest
   *  numerator for brokenImageRate (filtered non-food must not inflate it). */
  brokenVisible: number;
  /** Visible (current+next) offers in the Alkohol category. */
  alcoholVisible: number;
  /** Clear non-food offers leaked into the visible buckets. */
  nonFoodLeaks: number;
  /** Bounded example names of the leaked offers. */
  nonFoodLeakExamples: string[];
  /** True when any offer for this store carries the REWE browser-import tag. */
  browserTagged: boolean;
  /** True when any offer carries the manual ALDI-PDF-import tag — ein per Policy
   *  deaktivierter Store, der dennoch bewusst hochgeladene PDF-Angebote hat. */
  manualImportTagged: boolean;
  /** True when any offer carries the manual Lidl-Prospekt-Import-Tag — ein per
   *  Policy deaktivierter Store mit bewusst manuell importierten (approved)
   *  Review-Angeboten. Verfeinert die manual-Zeile auf manual_review_import. */
  lidlManualTagged: boolean;
  /** True when any offer carries the Lidl-Prospektbild-OCR tag — refines the
   *  structured_only coverage to partial_with_ocr (OCR active, aber unvollständig). */
  ocrTagged: boolean;
  /** True when any offer carries the Lidl-Prospektbild-VISION tag — refines the
   *  structured_only coverage to partial_with_vision (Vision active, aber unvollständig). */
  visionTagged: boolean;
  /** True when any offer carries the Lidl-Prospekt-Viewer-JSON tag
   *  ('lidl-prospekt') — refines the structured_only coverage to
   *  partial_with_viewer_json (strukturierter Auto-Teilimport aus der
   *  öffentlichen v4/flyer products-Map, nie full). */
  viewerJsonTagged: boolean;
  /** Offers in the LIVE bucket whose date window is NOT active today. */
  falseLive: number;
  falseLiveExamples: string[];
  /** Names of filtered offers with a strong food signal (verdict 'rescue'). */
  foodInFilterExamples: string[];
}

function emptyPass(): StorePass {
  return {
    current: 0,
    next: 0,
    filtered: 0,
    ruleNonFood: 0,
    review: 0,
    foodSuspect: 0,
    broken: 0,
    brokenVisible: 0,
    alcoholVisible: 0,
    nonFoodLeaks: 0,
    nonFoodLeakExamples: [],
    browserTagged: false,
    manualImportTagged: false,
    lidlManualTagged: false,
    ocrTagged: false,
    visionTagged: false,
    viewerJsonTagged: false,
    falseLive: 0,
    falseLiveExamples: [],
    foodInFilterExamples: [],
  };
}

/** Tageszahl seit einem ISO-Zeitpunkt (für "letzte erfolgreiche Verifikation"). */
function ageInDays(iso: string | undefined, now: Date): number | null {
  if (!iso) {
    return null;
  }
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return null;
  }
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
}

/**
 * Ehrliche EDEKA-Web-Verifikation + Health aus der Import-Diagnose (P4). Pure +
 * testbar. Unterscheidet die vom Auftrag geforderten Zustände:
 *   • blockiert (403/Captcha/Block-200) → blocked, warning (alter Bestand da)
 *     bzw. critical (nichts da). Niemals healthy/full.
 *   • erreichbar + geparst → ok, Health aus der Completeness (national_only).
 *   • erreichbar, aber 0 trotz Angebotsstruktur → parser_failure/critical.
 *   • erreichbar, nachweislich 0 Angebote → empty_with_reason (ok/warning).
 *   • keine Diagnose in diesem Prozess → unverified (Zahlen aus Snapshot).
 */
export function edekaImportVerdict(
  diag: EdekaImportDiagnostics | null | undefined,
  opts: { currentCount: number; nextWeekCount: number; now?: Date },
): { webVerification: WebVerificationStatus; importHealth: ImportHealthStatus; warnings: string[] } {
  const now = opts.now ?? new Date();
  const visible = opts.currentCount + opts.nextWeekCount;
  const warnings: string[] = [];

  if (!diag) {
    // Kein EDEKA-Lauf in diesem Prozess (z. B. nach Neustart): Zahlen stammen aus
    // dem persistierten Snapshot — niemals als frisch verifiziert ausgeben.
    return {
      webVerification: 'unverified',
      importHealth: visible > 0 ? 'warning' : 'critical',
      warnings: [
        visible > 0
          ? `EDEKA: in diesem Prozess kein Scan gelaufen — ${visible} Angebote stammen aus dem letzten Snapshot (Aktualität nicht verifiziert). Nächste Aktion: EDEKA-Scan ausführen.`
          : 'EDEKA: in diesem Prozess kein Scan gelaufen und keine Angebote im Snapshot — EDEKA-Scan ausführen.',
      ],
    };
  }

  // Zählkette als maschinenlesbare Diagnose immer mitschreiben.
  warnings.push(
    `EDEKA Zählkette: ${diag.offerBlocks} Angebotskarten → ${diag.candidates} Kandidaten → ` +
      `${diag.withOfferPrice} mit Angebotspreis → ${diag.importedDistinct} importiert ` +
      `(${diag.duplicatesMerged} Dublette(n) zusammengeführt).`,
  );
  const rej = diag.rejectedByReason;
  const rejTotal = rej.kein_name + rej.kein_angebotspreis + rej.kein_preis;
  if (rejTotal > 0) {
    warnings.push(
      `EDEKA Ablehnungen: ${rej.kein_angebotspreis} ohne echten Angebotspreis (nur Normalpreis/PAYBACK), ` +
        `${rej.kein_preis} ohne Preis, ${rej.kein_name} ohne Namen` +
        (diag.rejectedExamples.length > 0 ? ` (z. B. ${diag.rejectedExamples.slice(0, 4).join(', ')})` : '') +
        '.',
    );
  }
  const verifiedAge = ageInDays(diag.lastSuccessfulAt, now);
  if (diag.lastSuccessfulAt) {
    warnings.push(
      `EDEKA letzte erfolgreiche Verifikation: ${diag.lastSuccessfulAt}` +
        (verifiedAge !== null ? ` (vor ${verifiedAge} Tag(en))` : '') + '.',
    );
  }

  if (diag.blocked) {
    warnings.push(
      `EDEKA-Quelle blockiert (${diag.blockReason ?? 'Block-/Captcha-Seite'}${
        diag.httpStatus ? `, HTTP ${diag.httpStatus}` : ''
      }) — Vollständigkeit nicht verifizierbar. Nächste Aktion: ` +
        (visible > 0
          ? 'alter EDEKA-Bestand bleibt erhalten; später erneut scannen oder Browser-Import nutzen.'
          : 'Browser-Import der sichtbar geladenen EDEKA-Seite nutzen.'),
    );
    return {
      webVerification: 'blocked',
      importHealth: visible > 0 ? 'warning' : 'critical',
      warnings,
    };
  }

  if (diag.importedDistinct > 0) {
    // Erreichbar + geparst: ehrlich verifiziert. Health bleibt mind. warning,
    // weil coverage national_only (nie full) — das setzt der Coverage-Block.
    warnings.push(
      `EDEKA: ${diag.importedDistinct} nationale Angebote aus dem offiziellen HTML importiert ` +
        `(${diag.brokenImageCount} ohne Produktbild). Lokale/regionale Marktangebote nicht abgedeckt.`,
    );
    return { webVerification: 'ok', importHealth: 'warning', warnings };
  }

  // 0 importiert, nicht blockiert:
  if (diag.pageLooksLikeOffers && diag.offerBlocks > 0) {
    // Struktur da, aber nichts geparst → echter Parser-Fehler.
    warnings.push(
      `EDEKA: Seite erreichbar mit ${diag.offerBlocks} Angebotskarten, aber 0 importiert — Parser-Fehler. ` +
        'Nächste Aktion: EDEKA-Karten-Parser prüfen (Layout evtl. geändert).',
    );
    return { webVerification: 'ok', importHealth: 'critical', warnings };
  }
  if (diag.pageLooksLikeOffers && diag.offerBlocks === 0) {
    warnings.push(
      'EDEKA: Seite erreichbar, aber keine Angebotskarten vorhanden — derzeit nachweislich keine Angebote (oder Layout geändert). Nächste Aktion: Quelle manuell prüfen.',
    );
    return { webVerification: 'ok', importHealth: 'critical', warnings };
  }
  warnings.push(
    'EDEKA: keine bekannte Angebots-Struktur auf der geladenen Seite — Quelle nicht verifizierbar. Nächste Aktion: Quelle/URL prüfen oder Browser-Import nutzen.',
  );
  return { webVerification: 'unverified', importHealth: 'critical', warnings };
}

// Unter diesem Bildanteil (productsWithImage / strukturierte Produkte) ist die
// ALDI-NORD-Bildabdeckung zu dünn — höchstens 'warning'.
const ALDI_NORD_IMAGE_WARN_SHARE = 0.5;

/**
 * Ehrliche ALDI-NORD-Web-Verifikation + Health aus der strukturierten Import-
 * Diagnose. Pure + testbar. ALDI NORD wird über den strukturierten Website-
 * Connector (apiData/__NEXT_DATA__ OFFER_GET) importiert — NIE per PDF/Vision.
 * Zustände:
 *   • kein Lauf in diesem Prozess → unverified (Zahlen aus Snapshot).
 *   • Quelle nicht erreichbar (fetch_failed/403) → blocked.
 *   • erreichbar, aber kein apiData/__NEXT_DATA__ → warning (Layout geprüft).
 *   • apiData da, 0 importiert → warning (Parser/Quelle prüfen), nie still ok.
 *   • importiert, aber dünne Bildabdeckung → warning.
 *   • belegter strukturierter Import → ok.
 */
export function aldiNordImportVerdict(
  diag: AldiNordImportDiagnostics | null | undefined,
  opts: { currentCount: number; nextWeekCount: number },
): { webVerification: WebVerificationStatus; importHealth: ImportHealthStatus; warnings: string[] } {
  const visible = opts.currentCount + opts.nextWeekCount;
  const warnings: string[] = [];

  if (!diag) {
    return {
      webVerification: 'unverified',
      importHealth: visible > 0 ? 'warning' : 'critical',
      warnings: [
        visible > 0
          ? `ALDI NORD: in diesem Prozess kein strukturierter Scan gelaufen — ${visible} Angebote stammen aus dem letzten Snapshot (Aktualität nicht verifiziert).`
          : 'ALDI NORD: in diesem Prozess kein strukturierter Scan gelaufen und keine Angebote im Snapshot — ALDI-NORD-Scan ausführen.',
      ],
    };
  }

  if (diag.blocked) {
    warnings.push(
      `ALDI NORD-Quelle nicht erreichbar (${diag.blockReason ?? 'fetch_failed'}${
        diag.httpStatus ? `, HTTP ${diag.httpStatus}` : ''
      }) — keine strukturierten Angebote importiert.`,
    );
    return {
      webVerification: 'blocked',
      importHealth: visible > 0 ? 'warning' : 'critical',
      warnings,
    };
  }

  if (!diag.apiDataFound) {
    warnings.push(
      'ALDI NORD: kein apiData/__NEXT_DATA__ auf der Angebotsseite gefunden — Layout evtl. geändert. Nächste Aktion: Quelle prüfen.',
    );
    return { webVerification: 'unverified', importHealth: 'warning', warnings };
  }

  warnings.push(
    `ALDI NORD Zählkette: ${diag.structuredProductsFound} strukturierte Produkte → ` +
      `${diag.productsWithPrice} mit Preis → ${diag.importedDistinct} importiert ` +
      `(${diag.currentProducts} aktuell, ${diag.futureProducts} künftig/ab Datum, ${diag.areaCount} Bereiche).`,
  );

  if (diag.importedDistinct === 0) {
    warnings.push(
      `ALDI NORD: apiData gefunden, aber 0 Angebote importiert (${diag.structuredProductsFound} Produkte, ${diag.productsWithPrice} mit Preis) — Parser/Quelle prüfen.`,
    );
    return { webVerification: 'unverified', importHealth: 'warning', warnings };
  }

  const structured = diag.structuredProductsFound || diag.importedDistinct;
  const imageShare = structured > 0 ? diag.productsWithImage / structured : 1;
  if (imageShare < ALDI_NORD_IMAGE_WARN_SHARE) {
    warnings.push(
      `ALDI NORD: nur ${diag.productsWithImage}/${structured} strukturierte Produkte mit Bild — Bildabdeckung niedrig.`,
    );
    return { webVerification: 'imported', importHealth: 'warning', warnings };
  }

  return { webVerification: 'imported', importHealth: 'ok', warnings };
}

const ALDI_SUED_IMAGE_WARN_SHARE = 0.5;

/**
 * Ehrliche ALDI-SÜD-Zeile aus der strukturierten Import-Diagnose. Pure + testbar.
 * ALDI SÜD wird über den strukturierten Website-Connector (zentrale Wochenangebote-
 * Sammelseite mit Pagination, Nuxt __NUXT_DATA__ + DOM-Kacheln) importiert —
 * NIE per PDF/Vision, kein Anti-Bot-Bypass. Zustände spiegeln das verdict-Feld:
 *   • kein Lauf in diesem Prozess → unverified (Zahlen aus Snapshot).
 *   • Seite 1 blockiert (403/Timeout) → blocked.
 *   • Sammelseite erreichbar, aber 0 strukturierte Produkte → unavailable/warning.
 *   • spätere Seite blockiert (Teilimport) ODER dünne Bildabdeckung → warning.
 *   • belegter strukturierter Import → ok.
 */
export function aldiSuedImportVerdict(
  diag: AldiSuedImportDiagnostics | null | undefined,
  opts: { currentCount: number; nextWeekCount: number },
): { webVerification: WebVerificationStatus; importHealth: ImportHealthStatus; warnings: string[] } {
  const visible = opts.currentCount + opts.nextWeekCount;
  const warnings: string[] = [];

  if (!diag) {
    return {
      webVerification: 'unverified',
      importHealth: visible > 0 ? 'warning' : 'critical',
      warnings: [
        visible > 0
          ? `ALDI SÜD: in diesem Prozess kein strukturierter Scan gelaufen — ${visible} Angebote stammen aus dem letzten Snapshot (Aktualität nicht verifiziert).`
          : 'ALDI SÜD: in diesem Prozess kein strukturierter Scan gelaufen und keine Angebote im Snapshot — ALDI-SÜD-Scan ausführen.',
      ],
    };
  }

  const checked = diag.pagesChecked ?? diag.sourceUrlsChecked.length;
  const blockedSources = diag.sourceUrlsChecked.filter((source) => source.blocked).length;

  if (diag.verdict === 'blocked') {
    warnings.push(
      `ALDI SÜD-Sammelseite nicht erreichbar (${blockedSources}/${checked} Seiten blockiert${
        diag.blockReason ? `: ${diag.blockReason}` : ''
      }) — keine strukturierten Angebote importiert.`,
    );
    return {
      webVerification: 'blocked',
      importHealth: visible > 0 ? 'warning' : 'critical',
      warnings,
    };
  }

  if (diag.verdict === 'unavailable') {
    warnings.push(
      `ALDI SÜD: ${checked - blockedSources}/${checked} Seiten erreichbar (HTTP 200), aber 0 strukturierte Produkte importiert (${diag.structuredProductsFound} gefunden) — Quelle/Parser prüfen.`,
    );
    return { webVerification: 'unverified', importHealth: 'warning', warnings };
  }

  warnings.push(
    `ALDI SÜD Zählkette: ${diag.structuredProductsFound} strukturierte Produkte → ` +
      `${diag.productsWithPrice} mit Preis → ${diag.importedDistinct} importiert ` +
      `(${diag.currentProducts} aktuell, ${diag.futureProducts} künftig/ab Datum, ${blockedSources}/${checked} Seiten blockiert).`,
  );

  const structured = diag.structuredProductsFound || diag.importedDistinct;
  const imageShare = structured > 0 ? diag.productsWithImage / structured : 1;

  if (diag.verdict === 'warning' || blockedSources > 0 || imageShare < ALDI_SUED_IMAGE_WARN_SHARE) {
    if (blockedSources > 0) {
      warnings.push(
        `ALDI SÜD: ${blockedSources}/${checked} Seiten blockiert — Teilimport, einige Angebote können fehlen.`,
      );
    }
    if (imageShare < ALDI_SUED_IMAGE_WARN_SHARE) {
      warnings.push(
        `ALDI SÜD: nur ${diag.productsWithImage}/${structured} strukturierte Produkte mit Bild — Bildabdeckung niedrig.`,
      );
    }
    return { webVerification: 'imported', importHealth: 'warning', warnings };
  }

  return { webVerification: 'imported', importHealth: 'ok', warnings };
}

/**
 * Ehrliche nahkauf-Zeile aus der Storyblok-Import-Diagnose. Pure + testbar.
 * nahkauf wird über die öffentliche Storyblok-CDN-API importiert (Token aus dem
 * Seiten-HTML, notfalls Startseiten-Fallback). Zustände:
 *   • kein Lauf in diesem Prozess → unverified (Zahlen aus Snapshot).
 *   • Angebotsseite UND Startseite nicht lesbar → blocked.
 *   • Token nicht im HTML → unverified/warning (Seitenformat geändert).
 *   • BELEGTER source-gap (0 Offer-Stories + „Angebote"-Link auf rewe.de) →
 *     warning mit klarer Erklärung, NIE critical — nahkauf publiziert derzeit
 *     keine eigenen Online-Angebote; kein Import-Defekt, keine Aktion nötig.
 *   • Stories vorhanden, aber 0 importiert → warning (Markt-ID/Quelle prüfen).
 *   • belegter Import → ok.
 */
export function nahkaufImportVerdict(
  diag: NahkaufImportDiagnostics | null | undefined,
  opts: { currentCount: number; nextWeekCount: number },
): { webVerification: WebVerificationStatus; importHealth: ImportHealthStatus; warnings: string[] } {
  const visible = opts.currentCount + opts.nextWeekCount;
  const warnings: string[] = [];

  if (!diag) {
    return {
      webVerification: 'unverified',
      importHealth: visible > 0 ? 'warning' : 'critical',
      warnings: [
        visible > 0
          ? `nahkauf: in diesem Prozess kein Scan gelaufen — ${visible} Angebote stammen aus dem letzten Snapshot (Aktualität nicht verifiziert).`
          : 'nahkauf: in diesem Prozess kein Scan gelaufen und keine Angebote im Snapshot — nahkauf-Scan ausführen.',
      ],
    };
  }

  if (diag.blocked) {
    warnings.push(
      `nahkauf-Quelle nicht erreichbar (${diag.blockReason ?? 'fetch_failed'}) — weder Angebotsseite noch Startseite lesbar.`,
    );
    return {
      webVerification: 'blocked',
      importHealth: visible > 0 ? 'warning' : 'critical',
      warnings,
    };
  }

  if (!diag.tokenFound) {
    warnings.push(
      'nahkauf: Storyblok-Token nicht im Seiten-HTML gefunden — Seitenformat evtl. geändert. Nächste Aktion: Quelle prüfen.',
    );
    return { webVerification: 'unverified', importHealth: 'warning', warnings };
  }

  warnings.push(
    `nahkauf Zählkette: ${diag.offerStoryCount} Offer-Stories → ${diag.importedDistinct} importiert` +
      (diag.pageSource === 'home_fallback'
        ? ' (Token via Startseiten-Fallback, Angebotsseite nicht erreichbar)'
        : '') +
      '.',
  );

  // BELEGTER source-gap: die Quelle ist erreichbar und nachweislich leer — das
  // ist der Zustand der Quelle, kein Defekt unseres Imports. Warning (nicht ok,
  // es fehlen ja Angebote), aber NIEMALS critical.
  if (diag.sourceGap) {
    warnings.push(
      'nahkauf publiziert derzeit keine eigenen Online-Angebote: Storyblok-Space ohne Offer-Stories, ' +
        'die nahkauf-Seite verlinkt „Angebote" auf rewe.de (source-gap, kein Import-Defekt). ' +
        'Keine Aktion nötig — der Import erholt sich automatisch, sobald wieder Offer-Stories vorhanden sind.',
    );
    return { webVerification: 'ok', importHealth: 'warning', warnings };
  }

  if (diag.importedDistinct === 0) {
    warnings.push(
      diag.marketIdConfigured
        ? `nahkauf: ${diag.offerStoryCount} Offer-Stories vorhanden, aber 0 importiert — Markt-ID/Parser prüfen.`
        : `nahkauf: ${diag.offerStoryCount} Offer-Stories vorhanden, aber 0 nationale Angebote — ohne NAHKAUF_MARKET_ID werden nur national_all-Angebote importiert.`,
    );
    return { webVerification: 'unverified', importHealth: 'warning', warnings };
  }

  return { webVerification: 'imported', importHealth: 'ok', warnings };
}

function statusToHealth(status: StoreCompletenessRow['status']): ImportHealthStatus {
  switch (status) {
    case 'critical':
      return 'critical';
    case 'healthy':
      return 'ok';
    default:
      // 'warn' and 'unverified' are both honestly a "warning" — never silently ok.
      return 'warning';
  }
}

export function computeStoreImportHealth(
  input: StoreImportHealthInput,
): StoreImportHealthReport {
  const now = input.now ?? new Date();
  const expectations = input.expectations ?? DEFAULT_STORE_EXPECTATIONS;

  // ALDI-PDF-Review-Stand pro normalisiertem Chain-Key (für die ALDI-Zeilen).
  const reviewByKey = new Map<string, { pending: number; approved: number }>();
  for (const [chain, counts] of Object.entries(input.aldiReviewByStore ?? {})) {
    reviewByKey.set(normalizeChainKey(chain), counts);
  }
  // Manueller Lidl-Prospekt-Review-Stand auf den Lidl-Key legen (reine Anzeige).
  if (input.lidlReview && (input.lidlReview.pending > 0 || input.lidlReview.approved > 0)) {
    reviewByKey.set(normalizeChainKey('Lidl'), input.lidlReview);
  }

  // Reuse the proven completeness logic (Kaufland as the model) for status/score.
  const completeness = computeStoreCompleteness({
    offers: input.offers,
    nextWeekOffers: input.nextWeekOffers,
    filteredOffers: input.filteredOffers,
    officialCounts: input.officialCounts,
    expectations,
    now,
  });
  const completenessByKey = new Map<string, StoreCompletenessRow>();
  for (const row of completeness.stores) {
    completenessByKey.set(normalizeChainKey(row.storeChain), row);
  }

  // One pass over the snapshot for broken images + browser-import tagging.
  const passByKey = new Map<string, StorePass>();
  const ensurePass = (storeChain: string): StorePass => {
    const key = normalizeChainKey(storeChain || 'Unbekannt');
    let pass = passByKey.get(key);
    if (!pass) {
      pass = emptyPass();
      passByKey.set(key, pass);
    }
    return pass;
  };
  for (const offer of [...input.offers, ...input.nextWeekOffers]) {
    const pass = ensurePass(offer.storeChain);
    if (classifyOfferBucket(offer, now) === 'upcoming') pass.next += 1;
    else pass.current += 1;
    if (isBrokenImage(offer)) {
      pass.broken += 1;
      pass.brokenVisible += 1;
    }
    if (offer.category === 'Alkohol') pass.alcoholVisible += 1;
    if (isStrongNonFoodLeak(offer)) {
      pass.nonFoodLeaks += 1;
      if (
        pass.nonFoodLeakExamples.length < NONFOOD_LEAK_EXAMPLES_MAX &&
        !pass.nonFoodLeakExamples.includes(offer.name)
      ) {
        pass.nonFoodLeakExamples.push(offer.name);
      }
    }
    const tags = offer.tags ?? [];
    if (tags.includes('browser-import')) pass.browserTagged = true;
    if (tags.includes('aldi-pdf-import')) pass.manualImportTagged = true;
    if (tags.includes('lidl-manual-import')) {
      pass.manualImportTagged = true;
      pass.lidlManualTagged = true;
    }
    // Lidl-Prospektbild-OCR-Tag (lidlProspectOcr.ts) — inline statt Import, um
    // die OCR-/Tesseract-Abhängigkeiten nicht in dieses Modul zu ziehen.
    if (tags.includes('lidl-prospekt-ocr') || tags.includes('ocr')) pass.ocrTagged = true;
    // Lidl-Prospektbild-VISION-Tag (lidlVisionProspectImport.ts) — inline statt
    // Import, um die Vision-Abhängigkeiten nicht in dieses Modul zu ziehen.
    if (tags.includes('lidl-vision') || tags.includes('vision')) pass.visionTagged = true;
    // Lidl-Viewer-JSON-Tag ('lidl-prospekt', officialSupermarketConnector) —
    // strukturierter Auto-Teilimport aus der öffentlichen v4/flyer products-Map.
    if (tags.includes('lidl-prospekt')) pass.viewerJsonTagged = true;
  }
  // False-live: Angebote, die im LIVE-Bucket (input.offers) liegen, deren
  // Datumsfenster sie aber NICHT als heute aktiv ausweist (abgelaufen → 'other'
  // oder erst künftig → 'next'). Dieselbe kanonische Datumsentscheidung wie der
  // Live-Window-Split — kein Shop-/KW-Sonderfall.
  for (const offer of input.offers) {
    const window = classifyLiveWindow(offer, now);
    if (window === 'other' || window === 'next') {
      const pass = ensurePass(offer.storeChain);
      pass.falseLive += 1;
      if (pass.falseLiveExamples.length < AUDIT_EXAMPLES_MAX && !pass.falseLiveExamples.includes(offer.name)) {
        pass.falseLiveExamples.push(offer.name);
      }
    }
  }
  for (const offer of input.filteredOffers) {
    const pass = ensurePass(offer.storeChain);
    pass.filtered += 1;
    const verdict = classifyFilteredOfferForRescue(offer);
    if (verdict === 'rescue') {
      pass.foodSuspect += 1;
      if (pass.foodInFilterExamples.length < AUDIT_EXAMPLES_MAX && !pass.foodInFilterExamples.includes(offer.name)) {
        pass.foodInFilterExamples.push(offer.name);
      }
    } else if (verdict === 'review') pass.review += 1;
    else pass.ruleNonFood += 1;
    if (isBrokenImage(offer)) pass.broken += 1;
    const filteredTags = offer.tags ?? [];
    if (filteredTags.includes('aldi-pdf-import')) pass.manualImportTagged = true;
    if (filteredTags.includes('lidl-manual-import')) {
      pass.manualImportTagged = true;
      pass.lidlManualTagged = true;
    }
  }

  // Per Policy deaktivierte Shops (OFFERS_DISABLED_STORES; Default leer)
  // erscheinen IMMER (auch mit 0 Angeboten, da aus dem Snapshot entfernt) — mit
  // ihrem schön formatierten Anzeigenamen aus der Konfiguration.
  const disabledDisplayByKey = new Map<string, string>();
  for (const chain of input.disabledStores ?? []) {
    const key = normalizeChainKey(chain);
    if (key) disabledDisplayByKey.set(key, chain);
  }
  const disabledKeys = new Set(disabledDisplayByKey.keys());

  // Resolve the display name for every store we will report on.
  const displayByKey = new Map<string, string>();
  for (const row of completeness.stores) displayByKey.set(normalizeChainKey(row.storeChain), row.storeChain);
  for (const chain of ALWAYS_REPORT_STORES) displayByKey.set(normalizeChainKey(chain), chain);
  for (const [key, chain] of disabledDisplayByKey) displayByKey.set(key, chain);

  const rewe = input.rewe ?? null;
  const excludedKeys = new Set((input.excludedStores ?? []).map((chain) => normalizeChainKey(chain)));
  const stores: StoreImportHealthRow[] = [];

  for (const [key, storeChain] of displayByKey) {
    // Policy-DEAKTIVIERT: bewusst nicht gescannt, aus dem Snapshot entfernt —
    // eine klare, ehrliche 'disabled'-Zeile, niemals critical/warning, keine
    // Completeness-/Mindestmengen-Eskalation. Kurzschluss vor jeder Bewertung.
    if (disabledKeys.has(key)) {
      const strategyInfo = resolveStoreImportStrategy(storeChain);
      const disabledPass = passByKey.get(key);
      const manualVisible =
        (disabledPass?.current ?? 0) + (disabledPass?.next ?? 0);
      const manualFiltered = disabledPass?.filtered ?? 0;
      const hasManualImport =
        disabledPass?.manualImportTagged === true && manualVisible + manualFiltered > 0;

      // Deaktiviert, ABER mit bewusst hochgeladenen manuellen PDF-Angeboten:
      // ehrliche manual_import/pdf_import-Zeile statt der nackten disabled-Zeile.
      // Auto-Scan bleibt deaktiviert (wird nicht als aktiv ausgegeben), niemals
      // critical — der Import ist gewollt, kein Defekt.
      // ALDI-PDF-Review-Stand (pending/approved-not-committed) — reine Anzeige,
      // niemals 'critical'. Ein offener Review ist kein Import-Defekt.
      const review = reviewByKey.get(key) ?? { pending: 0, approved: 0 };
      const reviewWarning =
        review.pending > 0 || review.approved > 0
          ? `${storeChain} Review-Queue: ${review.pending} pending` +
            (review.approved > 0 ? `, ${review.approved} bestätigt (noch nicht committet)` : '') +
            ' — warten auf manuelle Bestätigung, gehen NICHT automatisch live.'
          : null;

      if (hasManualImport) {
        // Lidl ist der manuelle Prospekt-Link-/Review-Import (kein PDF-Upload wie
        // ALDI). Ehrliches manual_review_import-Label + nie eine full-Coverage-
        // Behauptung; Auto-Scan bleibt deaktiviert.
        const isLidlManual = disabledPass?.lidlManualTagged === true;
        const importKind = isLidlManual ? 'Prospekt-Review-Angebote' : 'PDF-Angebote';
        stores.push({
          storeChain,
          strategy: isLidlManual ? 'manual_import' : 'pdf_import',
          fetchedCount: null,
          parsedCount: manualVisible + manualFiltered,
          currentCount: disabledPass?.current ?? 0,
          nextWeekCount: disabledPass?.next ?? 0,
          foodCount: manualVisible,
          nonFoodCount: disabledPass?.ruleNonFood ?? 0,
          reviewCount: disabledPass?.review ?? 0,
          foodSuspectCount: disabledPass?.foodSuspect ?? 0,
          filteredCount: manualFiltered,
          missingEstimate: null,
          brokenImageCount: disabledPass?.broken ?? 0,
          brokenImageRate: null,
          alcoholShare: null,
          nonFoodLeakCount: disabledPass?.nonFoodLeaks ?? 0,
          nonFoodLeakExamples: [...(disabledPass?.nonFoodLeakExamples ?? [])],
          // Nie 'full': ein manueller Review-Import ist bewusst ein Teilimport.
          importCoverage: isLidlManual ? 'manual_review_import' : 'full',
          sourceUrl: strategyInfo.publicSourceUrl ?? null,
          sourceCoverage: isLidlManual ? 'manual_review_import' : 'browser_import',
          falseLiveCount: disabledPass?.falseLive ?? 0,
          falseLiveExamples: [...(disabledPass?.falseLiveExamples ?? [])],
          foodInFilterExamples: [...(disabledPass?.foodInFilterExamples ?? [])],
          warnings: [
            `${storeChain}: Auto-Scan deaktiviert; manuelle ${importKind} importiert: ${manualVisible}` +
              (manualFiltered > 0 ? ` (+${manualFiltered} gefiltert)` : '') +
              '. Auto-Scrape bleibt aus, der manuelle Import bleibt erhalten' +
              (isLidlManual ? ' (keine full-Coverage-Behauptung).' : '.'),
            ...(reviewWarning ? [reviewWarning] : []),
          ],
          webVerification: 'imported',
          // Committed Angebote → ok; nur offener Review/0 committed → warning.
          importHealth: manualVisible > 0 ? 'ok' : 'warning',
          pdfImportAvailable: !isLidlManual,
          pendingReviewCount: review.pending,
          approvedNotCommittedCount: review.approved,
        });
        continue;
      }

      stores.push({
        storeChain,
        strategy: strategyInfo.strategy,
        fetchedCount: null,
        parsedCount: null,
        currentCount: 0,
        nextWeekCount: 0,
        foodCount: 0,
        nonFoodCount: 0,
        reviewCount: 0,
        foodSuspectCount: 0,
        filteredCount: 0,
        missingEstimate: null,
        brokenImageCount: 0,
        brokenImageRate: null,
        alcoholShare: null,
        nonFoodLeakCount: 0,
        nonFoodLeakExamples: [],
        importCoverage: 'full',
        sourceUrl: strategyInfo.publicSourceUrl ?? null,
        sourceCoverage: 'unverifiable',
        falseLiveCount: 0,
        falseLiveExamples: [],
        foodInFilterExamples: [],
        warnings: [
          `${storeChain} ist per Policy deaktiviert (unsichere Quelle) — bewusst nicht gescannt, ` +
            `Angebote aus dem Snapshot entfernt. Kein Fehler, kein Import nötig.`,
          ...(reviewWarning ? [reviewWarning] : []),
        ],
        webVerification: 'unverified',
        importHealth: 'disabled',
        pendingReviewCount: review.pending,
        approvedNotCommittedCount: review.approved,
      });
      continue;
    }
    const strategyInfo = resolveStoreImportStrategy(storeChain);
    const completenessRow = completenessByKey.get(key);
    const pass = passByKey.get(key) ?? emptyPass();
    const expectation = expectations[key] ?? {};

    const currentCount = completenessRow?.currentImported ?? pass.current;
    const nextWeekCount = completenessRow?.upcomingImported ?? pass.next;
    const filteredCount = completenessRow?.filteredCount ?? pass.filtered;
    const foodCount = currentCount + nextWeekCount;
    // Ehrliche Aufteilung des Filtered-Buckets (zentrale Klassifikation): nur
    // regelbestätigtes Non-Food zählt als non-food; Review- und Food-Verdachts-
    // fälle erscheinen getrennt, damit "non-food" nicht falsch gefiltertes Food
    // verschleiert.
    const nonFoodCount = pass.ruleNonFood;
    const reviewCount = pass.review;
    const foodSuspectCount = pass.foodSuspect;
    const parsedCount = foodCount + filteredCount > 0 ? foodCount + filteredCount : null;

    const isBrowserStore = strategyInfo.strategy === 'browser_required';
    // The REWE import report describes ONE store's import. It must never be
    // attached to another chain (the old code copied REWE fetched/parsed counts
    // onto nahkauf, which then looked imported despite 0 real offers).
    const reweReport = isBrowserStore && key === 'rewe' ? rewe?.report ?? null : null;

    const warnings: string[] = [];
    if (strategyInfo.note) warnings.push(strategyInfo.note);
    if (completenessRow) warnings.push(...completenessRow.reasons);

    // ── missingEstimate ────────────────────────────────────────────────────
    let missingEstimate: number | null;
    if (key === 'kaufland' && input.kauflandCompleteness) {
      missingEstimate = input.kauflandCompleteness.missingEstimate;
    } else if (isBrowserStore) {
      missingEstimate =
        typeof reweReport?.possibleWebMissingEstimate === 'number'
          ? reweReport.possibleWebMissingEstimate
          : reweReport?.missingLikelyOffers?.length ?? null;
    } else {
      const denom = completenessRow?.officialCount ?? completenessRow?.expectedMin ?? null;
      missingEstimate = denom !== null ? Math.max(0, denom - currentCount) : null;
    }

    // ── REWE/nahkauf: fetched/parsed from the import report ──────────────────
    let fetchedCount: number | null = null;
    let storeParsedCount: number | null = parsedCount;
    if (isBrowserStore && reweReport) {
      fetchedCount = reweReport.rawCount;
      storeParsedCount = reweReport.normalizedCount;
    }

    // ── web verification + import health ─────────────────────────────────────
    let webVerification: WebVerificationStatus;
    let importHealth: ImportHealthStatus;
    let browserImportAvailable: boolean | undefined;
    let pdfImportAvailable: boolean | undefined;
    // Default: the resolved strategy (REWE/nahkauf → browser_required). Once a
    // manual import actually produced offers we show the real path instead.
    let strategy: ImportStrategy = strategyInfo.strategy;

    if (isBrowserStore) {
      // The import method also only describes the REWE import.
      const importMethod = key === 'rewe' ? rewe?.method ?? null : null;
      browserImportAvailable = importMethod === 'browser' || pass.browserTagged;
      pdfImportAvailable = importMethod === 'pdf';
      if (foodCount > 0) {
        webVerification = 'imported';
        // A successful manual import means REWE is NOT critical just because the
        // direct web fetch is 403/captcha-blocked or layout fragments were seen.
        // With offers in the snapshot the import worked, so the worst honest
        // status is "warning" — critical stays only for a truly broken import.
        const reported = reweReport?.importHealth ?? 'ok';
        importHealth = reported === 'critical' ? 'warning' : reported;
        // Ehrliche Dünnheit: die Completeness-Prüfung flaggt einen verdächtig
        // dünnen aktuellen Feed (REWE hat keinen expectedMin, daher greift der
        // ABS_WARN-Schutz unter 25 aktuellen Angeboten). Ein sauberer reweReport
        // (16 Angebote, keine Fragmente) darf das nicht grün übermalen.
        if (completenessRow) {
          const completenessHealth = statusToHealth(completenessRow.status);
          if (healthRank[completenessHealth] < healthRank[importHealth]) {
            importHealth = completenessHealth;
          }
        }
        // Web-Beleg: zeigt die geladene Seite deutlich mehr Preis-Kacheln als
        // importiert wurden, ist der Import unvollständig (Lazy-Load nicht
        // ausgelöst, „mehr anzeigen"/Tabs nicht expandiert).
        const webMissing = reweReport?.possibleWebMissingEstimate;
        if (
          typeof webMissing === 'number' &&
          webMissing >= Math.max(REWE_WEB_MISSING_MIN, Math.round(foodCount * REWE_WEB_MISSING_SHARE))
        ) {
          if (healthRank['warning'] < healthRank[importHealth]) {
            importHealth = 'warning';
          }
          warnings.push(
            `REWE-Seite zeigt ~${webMissing} Angebot(e) mehr als importiert (${foodCount} aktuell sichtbar) — Import vermutlich unvollständig (Seite vollständig laden/scrollen, „mehr anzeigen" öffnen).`,
          );
        }
        // Show the actual import path (browser/pdf/manual) instead of the bare
        // "browser_required" requirement, so the report reflects reality.
        strategy = pdfImportAvailable
          ? 'pdf_import'
          : browserImportAvailable
            ? 'browser_import'
            : 'manual_import';
      } else if (reweReport?.webVerification === 'blocked') {
        webVerification = 'blocked';
        importHealth = reweReport?.importHealth ?? 'critical';
        warnings.push('REWE-Web 403/Captcha-blockiert und keine Angebote importiert — Browser-/PDF-Import nötig.');
      } else {
        webVerification = 'unverified';
        importHealth = 'critical';
        warnings.push(
          `${storeChain} ist nur über Browser-Bookmarklet oder Screenshot/PDF importierbar — bisher keine Angebote importiert.`,
        );
      }
    } else if (key === 'edeka') {
      // EDEKA: ehrliche Web-Verifikation aus der Import-Diagnose (reachable+
      // parsed vs. blocked vs. parser_failure vs. empty) — EDEKA erscheint immer
      // im Report (ALWAYS_REPORT_STORES), auch bei 0 Angeboten/Blockade.
      const verdict = edekaImportVerdict(input.edeka, {
        currentCount,
        nextWeekCount,
        now,
      });
      webVerification = verdict.webVerification;
      importHealth = verdict.importHealth;
      // Die Completeness-Sicht (national_only/warn) darf nie grün übermalen.
      if (completenessRow) {
        const completenessHealth = statusToHealth(completenessRow.status);
        if (healthRank[completenessHealth] < healthRank[importHealth]) {
          importHealth = completenessHealth;
        }
      }
      warnings.push(...verdict.warnings);
      if (input.edeka) {
        fetchedCount = input.edeka.offerBlocks;
        storeParsedCount = input.edeka.withOfferPrice;
      }
    } else if (key === 'aldi nord') {
      // ALDI NORD: strukturierter Website-Import (apiData/__NEXT_DATA__). Ehrliche
      // Coverage statt 'disabled' — ok bei belegtem Import, warning bei dünner
      // Coverage / fehlendem apiData, blocked/critical bei nicht erreichbarer
      // Quelle. Kein PDF/Vision als Hauptpfad.
      const verdict = aldiNordImportVerdict(input.aldiNord, { currentCount, nextWeekCount });
      webVerification = verdict.webVerification;
      importHealth = verdict.importHealth;
      // Die Completeness-Sicht darf eine 'ok'-Diagnose nie grün übermalen.
      if (completenessRow) {
        const completenessHealth = statusToHealth(completenessRow.status);
        if (healthRank[completenessHealth] < healthRank[importHealth]) {
          importHealth = completenessHealth;
        }
      }
      warnings.push(...verdict.warnings);
      if (input.aldiNord) {
        fetchedCount = input.aldiNord.structuredProductsFound;
        storeParsedCount = input.aldiNord.importedDistinct;
      }
    } else if (key === 'aldi sued') {
      // ALDI SÜD: strukturierter Website-Import (zentrale Wochenangebote-
      // Sammelseite mit Pagination, Nuxt __NUXT_DATA__ + DOM-Kacheln). Ehrliche
      // Coverage statt 'disabled' — ok bei belegtem Import, warning bei Teilblockade
      // / dünner Coverage, blocked/critical bei nicht erreichbarer Sammelseite. Kein
      // PDF/Vision als Hauptpfad.
      const verdict = aldiSuedImportVerdict(input.aldiSued, { currentCount, nextWeekCount });
      webVerification = verdict.webVerification;
      importHealth = verdict.importHealth;
      // Die Completeness-Sicht darf eine 'ok'-Diagnose nie grün übermalen.
      if (completenessRow) {
        const completenessHealth = statusToHealth(completenessRow.status);
        if (healthRank[completenessHealth] < healthRank[importHealth]) {
          importHealth = completenessHealth;
        }
      }
      warnings.push(...verdict.warnings);
      if (input.aldiSued) {
        fetchedCount = input.aldiSued.structuredProductsFound;
        storeParsedCount = input.aldiSued.importedDistinct;
      }
    } else if (key === 'nahkauf') {
      // nahkauf: ehrliche Zeile aus der Storyblok-Import-Diagnose. Der BELEGTE
      // source-gap (Space ohne Offer-Stories, „Angebote"-Link auf rewe.de) ist
      // der Zustand der Quelle — warning mit Erklärung, NIE critical.
      const verdict = nahkaufImportVerdict(input.nahkauf, { currentCount, nextWeekCount });
      webVerification = verdict.webVerification;
      importHealth = verdict.importHealth;
      // Die Completeness-Sicht (expectedMin 30 → critical bei 0 Angeboten) darf
      // eine 'ok'-Diagnose nie grün übermalen — AUSSER beim belegten source-gap:
      // eine Mindestmengen-Erwartung darf einen nachweislich leeren Publisher
      // nicht als Import-Defekt eskalieren.
      if (completenessRow && input.nahkauf?.sourceGap !== true) {
        const completenessHealth = statusToHealth(completenessRow.status);
        if (healthRank[completenessHealth] < healthRank[importHealth]) {
          importHealth = completenessHealth;
        }
      }
      warnings.push(...verdict.warnings);
      if (input.nahkauf) {
        fetchedCount = input.nahkauf.offerStoryCount;
        storeParsedCount = input.nahkauf.importedDistinct;
      }
    } else if (expectation.verification === 'blocked') {
      webVerification = 'blocked';
      importHealth = currentCount === 0 ? 'critical' : 'warning';
    } else {
      webVerification = 'ok';
      importHealth = completenessRow ? statusToHealth(completenessRow.status) : 'critical';
    }

    // ── Broken-image escalation ──────────────────────────────────────────────
    // Images are part of the product promise. A store whose visible offers are
    // mostly broken images (the Netto 24/24 case) must never look "ok": at
    // ≥ 80 % broken the row is critical, at ≥ 30 % at least a warning.
    const visibleCount = currentCount + nextWeekCount;
    const brokenImageRate =
      visibleCount > 0 ? Math.round((pass.brokenVisible / visibleCount) * 1000) / 1000 : null;
    if (brokenImageRate !== null && brokenImageRate >= BROKEN_IMAGE_WARN_RATE) {
      const escalated: ImportHealthStatus =
        brokenImageRate >= BROKEN_IMAGE_CRITICAL_RATE ? 'critical' : 'warning';
      if (healthRank[escalated] < healthRank[importHealth]) {
        importHealth = escalated;
      }
      warnings.push(
        `${Math.round(brokenImageRate * 100)} % der sichtbaren ${storeChain}-Angebote haben kaputte Bilder (${pass.brokenVisible}/${visibleCount}) — Bilder nicht verifizierbar.`,
      );
    }

    // ── Partial-source + one-sided-assortment honesty (the Lidl case) ────────
    // A store whose public source structurally exposes only a subset, or whose
    // visible feed is (almost) only alcohol, must never read as an
    // unrestricted "ok" — cap at warning and say WHY, with concrete counts.
    // EFFEKTIVE Coverage aus der Completeness (degradiert einen 'full'-Anspruch
    // mit Markt-ID auf 'national_only', solange der Lokal-Beleg fehlt). Ohne
    // Completeness-Zeile (0 Angebote) gilt ein unbestätigter Markt-Anspruch
    // ebenfalls nicht als 'full' — nie false-positive melden.
    const requestedCoverage = expectation.coverage ?? 'full';
    const importCoverage: StoreCoverage =
      completenessRow?.coverage ??
      (requestedCoverage === 'full' && expectation.localVerificationTag
        ? 'national_only'
        : requestedCoverage);
    // sourceCoverage = ehrliches Anzeige-Label (reines Audit-Feld, eskaliert die
    // Health NICHT — das macht weiterhin importCoverage). Verfeinert die
    // strukturierte Coverage um die blockierten/Browser-/OCR-Zustände:
    //   • blockierte Quelle (Netto) → unverifiable
    //   • Browser-/PDF-Import (REWE) mit Daten → browser_import
    //   • strukturierter Teilimport + OCR-Angebote (Lidl) → partial_with_ocr
    //   • strukturierter Teilimport + Vision-Angebote (Lidl) → partial_with_vision
    let sourceCoverage: StoreCoverage = importCoverage;
    if (expectation.verification === 'blocked') {
      sourceCoverage = 'unverifiable';
    } else if (isBrowserStore && (foodCount > 0 || browserImportAvailable === true || pdfImportAvailable === true)) {
      sourceCoverage = 'browser_import';
    } else if (importCoverage === 'structured_only' && pass.ocrTagged) {
      sourceCoverage = 'partial_with_ocr';
    } else if (importCoverage === 'structured_only' && pass.visionTagged) {
      sourceCoverage = 'partial_with_vision';
    } else if (importCoverage === 'structured_only' && pass.viewerJsonTagged) {
      // Lidl-Auto-Import aus der öffentlichen Prospekt-Viewer-JSON: nur die
      // strukturiert bepreisten products-Map-Angebote sind importiert, die
      // preislosen Frische-Hotspots bleiben pending — ehrliches Label, nie full.
      sourceCoverage = 'partial_with_viewer_json';
    }
    const alcoholShare =
      visibleCount > 0 ? Math.round((pass.alcoholVisible / visibleCount) * 1000) / 1000 : null;
    // Die Teilimport-/national_only-Begründung nur anhängen, wenn tatsächlich
    // etwas importiert wurde — bei einer blockierten/leeren Quelle (0 sichtbar)
    // erklärt schon die store-spezifische Diagnose (z. B. EDEKA-Verdict) die Lage.
    if (importCoverage !== 'full' && visibleCount + filteredCount > 0) {
      if (healthRank['warning'] < healthRank[importHealth]) {
        importHealth = 'warning';
      }
      warnings.push(
        importCoverage === 'national_only'
          ? `Nationale Angebote importiert (${visibleCount} sichtbar + ${filteredCount} gefiltert), lokale Marktangebote nicht verifiziert.`
          : `Teilimport: nur die strukturiert verfügbaren Quelldaten importiert (${visibleCount} sichtbare + ${filteredCount} gefilterte Angebote) — das volle Wochensortiment ist nicht strukturiert verfügbar.`,
      );
    }
    if (
      alcoholShare !== null &&
      visibleCount >= ALCOHOL_SHARE_MIN_SAMPLE &&
      alcoholShare >= ALCOHOL_DOMINANT_SHARE
    ) {
      if (healthRank['warning'] < healthRank[importHealth]) {
        importHealth = 'warning';
      }
      warnings.push(
        `${Math.round(alcoholShare * 100)} % der sichtbaren ${storeChain}-Angebote sind Alkohol/Wein/Spirituosen (${pass.alcoholVisible}/${visibleCount}) — Sortiment einseitig, Frische-/Lebensmittelangebote fehlen.`,
      );
    }

    // ── Non-Food-Leaks im sichtbaren Feed ────────────────────────────────────
    // Klares Non-Food in current/next ist nach dem finalen Repair-Pass ein
    // Datenqualitätsfehler: der Store darf nie "ok" wirken — warning ab dem
    // ersten Leak, critical wenn der Gate offensichtlich nicht gelaufen ist.
    if (pass.nonFoodLeaks > 0) {
      const escalated: ImportHealthStatus =
        pass.nonFoodLeaks >= NONFOOD_LEAK_CRITICAL_COUNT ? 'critical' : 'warning';
      if (healthRank[escalated] < healthRank[importHealth]) {
        importHealth = escalated;
      }
      warnings.push(
        `${pass.nonFoodLeaks} klare(s) Non-Food-Angebot(e) im sichtbaren ${storeChain}-Feed ` +
          `(z. B. ${pass.nonFoodLeakExamples.join(', ')}) — gehört in den Filtered-Bucket.`,
      );
    }

    // ── Kaufland-Vollständigkeit (definierte Metriken, s. KauflandCompleteness) ─
    // Health darf nur "ok" sein, wenn der Vergleich konsistent UND der Verlust
    // klein ist: > 10 % fehlende offizielle Food-Namen oder offizielles Food im
    // Filtered-Bucket ⇒ höchstens warning, mit konkreten Zahlen.
    if (key === 'kaufland' && input.kauflandCompleteness) {
      const completeness = input.kauflandCompleteness;
      const base = completeness.officialDistinctFoodCount;
      if (base > 0 && completeness.missingEstimate / base > KAUFLAND_MISSING_WARN_SHARE) {
        if (healthRank['warning'] < healthRank[importHealth]) {
          importHealth = 'warning';
        }
        warnings.push(
          `Kaufland: ${completeness.missingEstimate} von ${base} offiziellen Food-Angeboten (distinct, aktuelle Woche) fehlen im Snapshot (${completeness.matchedCount} sichtbar, ${completeness.matchedFilteredCount} gefiltert).`,
        );
      }
      // Nur eskalieren, wenn der ECHTE aktuelle Live-Befund das deckt:
      // `matchedFilteredCount` zählt offizielle Food-Namen, deren Snapshot-Kopie
      // im Filter liegt — inklusive 'review'-Fälle aus offiziell food-bestätigten
      // Mischabteilungen (Zierpflanzen in "Obst, Gemüse, Pflanzen"), die KEIN
      // echtes falsch-gefiltertes Food sind. `foodSuspectCount` ist die zentrale
      // Live-Klassifikation der tatsächlichen Filtered-Offers (Rescue-Verdict
      // 'rescue'). Ohne aktuellen Food-Verdacht (foodSuspect=0) ist die
      // Completeness-Differenz ein erklärter Review-Fall, kein Import-Fehler —
      // dann keine stale "offizielle Food-Angebote im Filtered-Bucket"-Warnung.
      if (completeness.matchedFilteredCount > 0 && foodSuspectCount > 0) {
        if (healthRank['warning'] < healthRank[importHealth]) {
          importHealth = 'warning';
        }
        warnings.push(
          `Kaufland: ${completeness.matchedFilteredCount} offizielle Food-Angebot(e) liegen im Filtered-Bucket (falsch als Non-Food einsortiert).`,
        );
      }
    }

    // ── Excluded/Skipped statt critical ──────────────────────────────────────
    // Ein bewusst ausgeschlossener Store (manueller Import) ohne jegliche
    // importierte Angebote ist übersprungen, nicht defekt — der Scan soll dafür
    // nicht „critical" melden. Erst greifen, wenn wirklich NICHTS importiert
    // wurde (kein Food, kein Non-Food); ein dünner manueller Import bleibt warning.
    if (
      excludedKeys.has(key) &&
      foodCount === 0 &&
      filteredCount === 0 &&
      importHealth === 'critical'
    ) {
      importHealth = 'excluded';
      warnings.push(
        `${storeChain} ist vom automatischen Scan ausgeschlossen — Import übersprungen (nur manueller Browser-/PDF-Import). Kein Fehler.`,
      );
    }

    stores.push({
      storeChain,
      strategy,
      fetchedCount,
      parsedCount: storeParsedCount,
      currentCount,
      nextWeekCount,
      foodCount,
      nonFoodCount,
      reviewCount,
      foodSuspectCount,
      filteredCount,
      missingEstimate,
      brokenImageCount: pass.broken,
      brokenImageRate,
      alcoholShare,
      nonFoodLeakCount: pass.nonFoodLeaks,
      nonFoodLeakExamples: [...pass.nonFoodLeakExamples],
      importCoverage,
      sourceUrl: strategyInfo.publicSourceUrl ?? null,
      sourceCoverage,
      falseLiveCount: pass.falseLive,
      falseLiveExamples: [...pass.falseLiveExamples],
      foodInFilterExamples: [...pass.foodInFilterExamples],
      warnings: [...new Set(warnings)],
      webVerification,
      importHealth,
      browserImportAvailable,
      pdfImportAvailable,
    });
  }

  stores.sort(
    (a, b) =>
      healthRank[a.importHealth] - healthRank[b.importHealth] ||
      b.currentCount - a.currentCount ||
      a.storeChain.localeCompare(b.storeChain, 'de'),
  );

  return { generatedAt: now.toISOString(), stores };
}

const HEALTH_LABEL: Record<ImportHealthStatus, string> = {
  ok: '🟢 ok',
  warning: '🟡 warning',
  critical: '🔴 critical',
  excluded: '⚪ excluded/skipped',
  disabled: '⚫ disabled (Policy)',
};

/** Render the per-store import health as a Markdown table (logs and reports). */
export function renderStoreImportHealthMarkdown(report: StoreImportHealthReport): string {
  const lines: string[] = [];
  lines.push('## Import-Health pro Shop');
  lines.push('');
  lines.push(
    '| Store | Strategie | fetched | parsed | current | next | food | non-food | fehlt~ | broken Bilder | Web | Health |',
  );
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |');
  for (const store of report.stores) {
    const strategyLabel =
      store.importCoverage === 'structured_only'
        ? `${store.strategy} (Teilimport)`
        : store.importCoverage === 'national_only'
          ? `${store.strategy} (nur national)`
          : store.strategy;
    // "non-food" zeigt regelbestätigtes Non-Food; Review-/Food-Verdachtsfälle
    // werden getrennt angehängt, damit die Zahl nichts verschleiert.
    const extra: string[] = [];
    if (store.reviewCount > 0) extra.push(`${store.reviewCount} Review`);
    if (store.foodSuspectCount > 0) extra.push(`${store.foodSuspectCount} Food-Verdacht`);
    const nonFoodCell = extra.length > 0 ? `${store.nonFoodCount} (+${extra.join(', ')})` : `${store.nonFoodCount}`;
    lines.push(
      `| ${store.storeChain} | ${strategyLabel} | ${store.fetchedCount ?? '—'} | ${
        store.parsedCount ?? '—'
      } | ${store.currentCount} | ${store.nextWeekCount} | ${store.foodCount} | ${nonFoodCell} | ${
        store.missingEstimate ?? '—'
      } | ${store.brokenImageCount} | ${store.webVerification} | ${HEALTH_LABEL[store.importHealth]} |`,
    );
  }
  const problems = report.stores.filter((store) => store.importHealth !== 'ok');
  if (problems.length > 0) {
    lines.push('');
    lines.push('### Auffällige Shops');
    lines.push('');
    for (const store of problems) {
      const reason = store.warnings[0] ?? '';
      lines.push(`- **${store.storeChain}** — ${HEALTH_LABEL[store.importHealth]}: ${reason}`);
    }
  }

  // ── Quellen-Coverage-Audit pro Shop (welche öffentliche Quelle, Abdeckung,
  //    false-live + food-in-filter Beispiele) — ehrliche Pro-Shop-Sicht. ──────
  lines.push('');
  lines.push('### Quellen-Coverage pro Shop');
  lines.push('');
  for (const store of report.stores) {
    const parts: string[] = [`Coverage: ${SOURCE_COVERAGE_LABEL[store.sourceCoverage]}`];
    if (store.sourceUrl) parts.push(`Quelle: ${store.sourceUrl}`);
    if (store.falseLiveCount > 0) {
      const ex = store.falseLiveExamples.length > 0 ? ` (z. B. ${store.falseLiveExamples.join(', ')})` : '';
      parts.push(`false-live: ${store.falseLiveCount}${ex}`);
    }
    if (store.foodInFilterExamples.length > 0) {
      parts.push(`Food im Filter: ${store.foodSuspectCount} (z. B. ${store.foodInFilterExamples.join(', ')})`);
    }
    lines.push(`- **${store.storeChain}** — ${parts.join(' · ')}`);
  }
  return lines.join('\n');
}

const SOURCE_COVERAGE_LABEL: Record<StoreCoverage, string> = {
  full: 'voll',
  structured_only: 'nur strukturiert (Teilimport)',
  national_only: 'nur national',
  partial_with_ocr: 'Teilimport + OCR',
  partial_with_vision: 'Teilimport + Vision',
  partial_with_viewer_json: 'Teilimport (Viewer-JSON, preislose Frische pending)',
  browser_import: 'Browser-/PDF-Import',
  manual_review_import: 'manueller Review-Import',
  unverifiable: 'nicht verifizierbar',
};

/**
 * Generischer Source-Gap-Check (Task 3/4): meldet, welche der referenzierten
 * Produktnamen für einen Shop in KEINEM Snapshot-Bucket (current/next/filtered)
 * vorkommen — d. h. nicht in der importierten öffentlichen Quelle gefunden
 * wurden. Pure + ohne Produkt-Hardcode: die Namen kommen vom Aufrufer (z. B. aus
 * einer Filtered-Review-Liste oder einem Test), NICHT aus einer Allowlist im
 * Produktivcode. Ein gemeldeter Name ist ein ehrlicher source-gap — mögliche
 * Ursache: regionale/App-/Prospektbild-/Filialquelle, die der automatische
 * Import strukturell nicht abdeckt (siehe storeImportStrategy-Quellnotiz).
 */
export function findStoreSourceGaps(
  storeChain: string,
  referencedNames: readonly string[],
  buckets: { offers: Offer[]; nextWeekOffers: Offer[]; filteredOffers: Offer[] },
): string[] {
  const key = normalizeChainKey(storeChain);
  const haystack = [...buckets.offers, ...buckets.nextWeekOffers, ...buckets.filteredOffers]
    .filter((offer) => normalizeChainKey(offer.storeChain) === key)
    .map((offer) => `${offer.name ?? ''} ${offer.normalizedName ?? ''}`.toLowerCase());
  const gaps: string[] = [];
  for (const name of referencedNames) {
    const needle = name.trim().toLowerCase();
    if (!needle) continue;
    const present = haystack.some((text) => text.includes(needle));
    if (!present && !gaps.includes(name)) gaps.push(name);
  }
  return gaps;
}
