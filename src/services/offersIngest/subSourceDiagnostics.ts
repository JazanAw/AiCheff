// Gemeinsames, neutrales Subquellen-/Prospekt-Diagnosemodell (Task P5/P6).
//
// Ein Shop liefert seine Angebote oft aus MEHREREN Subquellen/Prospekten (Lidl:
// aktueller + nächster Wochenprospekt; nahkauf: mehrere Storyblok-Seiten).
// Schlägt eine davon fehl, kann ein KOMPLETTES Zeitfenster verschwinden, während
// der Shop INSGESAMT über dem Gesamtminimum bleibt — bisher unbemerkt. Dieses
// Modul macht Erfolg/Fehler je Subquelle EXPLIZIT und strukturiert, damit
// Connector, Server, Checkpoint, Safety-Gate und Report DENSELBEN Typ benutzen
// (keine Entscheidung mehr aus frei formuliertem Warnungstext).
//
// Bewusst neutral + Leaf-Modul (importiert nur den `Offer`-Typ), damit kein
// zyklischer Import entsteht: Connector (src/services), Gate/Server/Checkpoint/
// Report (backend/src) importieren ALLE VON hier; dieses Modul importiert NICHTS
// von ihnen.

import type { Offer } from '../../types/models';

/** Lokale Shop-Normalisierung (identisch zu backend/scanV2Scope.normalizeChainKey),
 *  damit dieses Leaf-Modul ohne Backend-Import auskommt. */
function normalizeChain(value: string | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/ü/g, 'ue')
    .replace(/ö/g, 'oe')
    .replace(/ä/g, 'ae')
    .replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ');
}

/** Status EINER versuchten Subquelle — discriminated union statt paralleler
 *  Bool-Felder. `success`/`empty` sind ehrliche Ergebnisse, `fetch_failed`/
 *  `parse_failed` sind explizite technische Fehlschläge. */
export type SubSourceStatus = 'success' | 'empty' | 'fetch_failed' | 'parse_failed';

interface SubSourceDiagnosticBase {
  /** Shop, zu dem die Subquelle gehört. */
  storeChain: string;
  /** Stabiler Identifier der Subquelle/des Prospekts (z. B. Prospekt-Slug). */
  sourceId: string;
  /** URL oder Slug der Subquelle (für den Report; begrenzt/sicher darzustellen). */
  urlOrSlug?: string;
  /** Erwarteter Gültigkeitszeitraum der Subquelle (ISO), falls bekannt. */
  expectedValidityStart?: string;
  expectedValidityEnd?: string;
  /** Roh-Anzahl extrahierter Kandidaten dieser Subquelle. */
  rawCount?: number;
  /** Anzahl Angebote, die diese Subquelle ins Ergebnis beitrug. */
  resultCount?: number;
  /** Rein menschenlesbarer Zusatz — NIE Entscheidungsgrundlage. */
  note?: string;
}

/**
 * Strukturierte Connector-Diagnose EINER Subquelle/eines Prospekts. Discriminated
 * union auf `status`: nur `fetch_failed`/`parse_failed` tragen einen
 * strukturierten Fehlercode und gelten als EXPLIZITER technischer Fehlschlag.
 */
export type SubSourceDiagnostic =
  | (SubSourceDiagnosticBase & { status: 'success' })
  | (SubSourceDiagnosticBase & { status: 'empty' })
  | (SubSourceDiagnosticBase & { status: 'fetch_failed'; errorCode?: string })
  | (SubSourceDiagnosticBase & { status: 'parse_failed'; errorCode?: string });

/** True nur bei einem EXPLIZITEN technischen Fehlschlag (Transport-/Parse-Fehler). */
export function isSubSourceFailure(diagnostic: SubSourceDiagnostic): boolean {
  return diagnostic.status === 'fetch_failed' || diagnostic.status === 'parse_failed';
}

/** Strukturierter Fehlercode (nur bei Fehlschlägen vorhanden). */
export function subSourceErrorCode(diagnostic: SubSourceDiagnostic): string | undefined {
  return diagnostic.status === 'fetch_failed' || diagnostic.status === 'parse_failed'
    ? diagnostic.errorCode
    : undefined;
}

/** Connector-Factory: baut eine Diagnose aus rohen Feldern + Status. */
export function buildSubSourceDiagnostic(input: {
  storeChain: string;
  sourceId: string;
  status: SubSourceStatus;
  urlOrSlug?: string;
  expectedValidityStart?: string;
  expectedValidityEnd?: string;
  rawCount?: number;
  resultCount?: number;
  errorCode?: string;
  note?: string;
}): SubSourceDiagnostic {
  const base: SubSourceDiagnosticBase = {
    storeChain: input.storeChain,
    sourceId: input.sourceId,
    urlOrSlug: input.urlOrSlug,
    expectedValidityStart: input.expectedValidityStart,
    expectedValidityEnd: input.expectedValidityEnd,
    rawCount: input.rawCount,
    resultCount: input.resultCount,
    note: input.note,
  };
  if (input.status === 'fetch_failed' || input.status === 'parse_failed') {
    return { ...base, status: input.status, errorCode: input.errorCode };
  }
  return { ...base, status: input.status };
}

/** Gibt nur valide Diagnosen mit nicht-leerem storeChain + sourceId zurück
 *  (defensiv gegen verlorene/teilweise Checkpoint-Daten beim Resume). */
export function sanitizeSubSourceDiagnostics(
  diagnostics: readonly SubSourceDiagnostic[] | undefined,
): SubSourceDiagnostic[] {
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics.filter(
    (d) =>
      !!d &&
      typeof d.storeChain === 'string' &&
      d.storeChain.trim().length > 0 &&
      typeof d.sourceId === 'string' &&
      d.sourceId.trim().length > 0,
  );
}

function toMillis(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Gültigkeitsfenster-Überlappung (defensive Migration für Angebote ohne
 *  sourceId): das Angebots-Fenster [start,end] überlappt das erwartete
 *  Subquellen-Fenster. Offene Grenzen gelten als unendlich. */
function validityOverlaps(offer: Offer, diagnostic: SubSourceDiagnostic): boolean {
  const expStart = toMillis(diagnostic.expectedValidityStart);
  const expEnd = toMillis(diagnostic.expectedValidityEnd);
  if (expStart === null && expEnd === null) return false;
  const offStart = toMillis(offer.validityStart) ?? -Infinity;
  const offEnd = toMillis(offer.validityEnd) ?? Infinity;
  const lo = expStart ?? -Infinity;
  const hi = expEnd ?? Infinity;
  return offStart <= hi && offEnd >= lo;
}

/**
 * Ordnet ein Angebot EINER Subquelle zu (Task P5). Priorität:
 *   1. stabile `sourceId` (beide vorhanden) — exakte Zuordnung,
 *   2. defensive Migration über das erwartete Gültigkeitsfenster (alte Angebote
 *      ohne sourceId),
 *   3. defensive Migration über URL/Slug.
 * NIE allein über den Produktnamen. Shop muss immer übereinstimmen.
 */
export function offerBelongsToSubSource(offer: Offer, diagnostic: SubSourceDiagnostic): boolean {
  if (normalizeChain(offer.storeChain) !== normalizeChain(diagnostic.storeChain)) {
    return false;
  }
  if (offer.sourceId && diagnostic.sourceId) {
    return offer.sourceId === diagnostic.sourceId;
  }
  if (validityOverlaps(offer, diagnostic)) {
    return true;
  }
  if (diagnostic.urlOrSlug && offer.sourceUrl) {
    return offer.sourceUrl.includes(diagnostic.urlOrSlug);
  }
  return false;
}

/** Gate-Entscheidung je Subquelle (für Report/Store-Health). */
export type SubSourceGateDecision = 'committed' | 'blocked' | 'unaffected';

/** Vollständige Subquellenbilanz EINER Subquelle (Task P6). */
export interface SubSourceOutcome {
  storeChain: string;
  sourceId: string;
  urlOrSlug?: string;
  expectedValidityStart?: string;
  expectedValidityEnd?: string;
  status: SubSourceStatus;
  rawCount?: number;
  resultCount?: number;
  errorCode?: string;
  /** Rein menschenlesbarer Diagnose-Zusatz der Subquelle (z. B. die OCR-Zählkette
   *  mit primaryReason) — NIE Entscheidungsgrundlage, aber MUSS bis in den Report
   *  durchgereicht werden, damit ein `raw=0` erklärbar bleibt. Wird 1:1 aus der
   *  {@link SubSourceDiagnostic.note} übernommen. */
  note?: string;
  /** Vorheriger Bestand der Subquelle (über alle Buckets). */
  previousCount: number;
  /** Aktueller Bestand der Subquelle im Kandidaten. */
  candidateCount: number;
  /** Verlustzahl (max(0, vorher − aktuell)). */
  lossCount: number;
  /** Verlustquote (0..1) relativ zum Vorbestand. */
  lossRate: number;
  gateDecision: SubSourceGateDecision;
  /** Betroffener Gate-Grund (nur bei `blocked`). */
  gateReason?: string;
}

export interface SubSourceLossInput {
  /** Alle vorherigen Angebote (current+next+filtered) — Vorbestandsbasis. */
  previousOffers: readonly Offer[];
  /** Alle Kandidaten-Angebote (current+next+filtered). */
  candidateOffers: readonly Offer[];
  diagnostics: readonly SubSourceDiagnostic[];
  /** True, wenn der Shop im aktiven Scope liegt. */
  inScope: (chain: string) => boolean;
  /** True, wenn der Shop ein manueller Import (excluded) ist. */
  isExcluded: (chain: string) => boolean;
  /** Mindest-Vorbestand des Fensters, ab dem ein Verlust geprüft wird. */
  minPrevious: number;
  /** Bruchteil, UNTER den der Bestand fallen muss, damit der Verlust „erheblich" gilt. */
  dropFraction: number;
}

export interface SubSourceLossResult {
  /** Vollständige Bilanz je Subquelle (für Report/Store-Health). */
  outcomes: SubSourceOutcome[];
  /** Kurzlabels der blockierenden Fenster (für die Gate-Reason). */
  lostWindows: string[];
  /** True, wenn mindestens eine Subquelle den Commit blockiert. */
  blocked: boolean;
}

/**
 * Reine Per-Subquellen-Verlustprüfung (Task P5). Vergleicht den Vorbestand JEDER
 * Subquelle mit dem Kandidaten und blockiert NUR, wenn die Subquelle EXPLIZIT
 * fehlgeschlagen ist (`fetch_failed`/`parse_failed`) UND ein erheblicher Verlust
 * des betroffenen Vorbestands vorliegt. `success` mit normaler Mengenänderung und
 * `empty` ohne Vorbestand blockieren nie. Out-of-scope/excluded Subquellen werden
 * als `unaffected` geführt. KEINE Entscheidung aus Warnungstext.
 */
export function evaluateSubSourceProspectLoss(input: SubSourceLossInput): SubSourceLossResult {
  const outcomes: SubSourceOutcome[] = [];
  const lostWindows: string[] = [];

  for (const diagnostic of input.diagnostics) {
    const chain = normalizeChain(diagnostic.storeChain);
    const prevCount = input.previousOffers.filter((o) => offerBelongsToSubSource(o, diagnostic)).length;
    const candCount = input.candidateOffers.filter((o) => offerBelongsToSubSource(o, diagnostic)).length;
    const lossCount = Math.max(0, prevCount - candCount);
    const lossRate = prevCount > 0 ? lossCount / prevCount : 0;

    const base: SubSourceOutcome = {
      storeChain: chain,
      sourceId: diagnostic.sourceId,
      urlOrSlug: diagnostic.urlOrSlug,
      expectedValidityStart: diagnostic.expectedValidityStart,
      expectedValidityEnd: diagnostic.expectedValidityEnd,
      status: diagnostic.status,
      rawCount: diagnostic.rawCount,
      resultCount: diagnostic.resultCount,
      errorCode: subSourceErrorCode(diagnostic),
      // Diagnose-Note 1:1 übernehmen — vorher hier verloren gegangen, weshalb die
      // OCR-Zählkette/primaryReason nie im `/api/offers/scan-report` ankam.
      note: diagnostic.note,
      previousCount: prevCount,
      candidateCount: candCount,
      lossCount,
      lossRate,
      gateDecision: 'committed',
    };

    if (input.isExcluded(chain) || !input.inScope(chain)) {
      outcomes.push({ ...base, gateDecision: 'unaffected' });
      continue;
    }

    const significantLoss =
      isSubSourceFailure(diagnostic) &&
      prevCount >= input.minPrevious &&
      candCount < prevCount * input.dropFraction;

    if (significantLoss) {
      const reason = `${chain}/${diagnostic.sourceId}: ${prevCount}→${candCount} (${diagnostic.status})`;
      lostWindows.push(reason);
      outcomes.push({ ...base, gateDecision: 'blocked', gateReason: reason });
    } else {
      outcomes.push(base);
    }
  }

  return { outcomes, lostWindows, blocked: lostWindows.length > 0 };
}
