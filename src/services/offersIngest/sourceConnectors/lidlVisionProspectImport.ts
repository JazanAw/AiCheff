// Lidl-Prospektbild-VISION-Import (Phase-1.5) — ein SEPARATER, kontrollierter Pfad
// NEBEN dem bestehenden OCR-Pfad (lidlProspectOcr.ts), der bewusst NICHT weiter
// verkompliziert wird.
//
// Hintergrund (Root Cause): Der strukturierte Lidl-Flyer-Endpoint liefert
// überwiegend Wein/Online/Non-Food; ein DOM-/Bookmarklet-Import wie bei REWE ist
// nicht machbar (keine sichtbaren DOM-Produktkarten); der klassische OCR-Pfad
// bleibt bei der Preisbox-Lokalisierung fragil. Die Frischeangebote liegen in den
// öffentlich geladenen Prospekt-BILDSEITEN, die der bestehende Lidl-Connector
// bereits kennt. Dieser Pfad analysiert genau diese Bilder mit einer LOKALEN
// Vision-KI (oder einem injizierten Vision-Adapter) und extrahiert generisch
// Produktname + Aktionspreis + Packung/Einheit (+ optional Grundpreis/Gültigkeit).
//
// Sicherheit ist eingebaut, nicht optional:
//   • KEINE Produkt-/Marken-Allowlist, KEINE KW-Logik, KEINE private Lidl-API,
//   • jeder Vision-Kandidat durchläuft DIESELBE zentrale Food-/Non-Food-Sicherheit
//     wie OCR (classifyOcrCandidate / resolveSafetyHelpers aus lidlProspectOcr) —
//     ein Kandidat geht NIE nur wegen einer Modellbehauptung live,
//   • Grundpreis/Pfand/Datum, Badge-Namen, niedrige Confidence und vom Modell
//     selbst markierte Unsicherheit (rejectReason) werden vorab verworfen,
//   • Dedupe gegen die strukturierten Lidl-Angebote (und innerhalb des Vision-Laufs),
//   • jede Verwerfung wird gezählt (rejectedByReason).
//
// `extractLidlVisionOffers` ist pure (kein IO) und damit trivial testbar.
// `runLidlVisionProspectImport` ist die dünne, injizierbare Glue (Bild laden →
// Vision-Analyse → extrahieren → strukturierte Diagnose), die der Connector hinter
// dem LIDL_VISION_MODE-Schalter aufruft. Der reale Vision-Adapter (Ollama) wird
// lazy/injizierbar gehalten, damit Tests Fake-Vision-Antworten einspeisen können.

import { normalizeText } from '../../../utils/offers';
import type { RawOfferCandidate } from '../types';
import {
  buildSubSourceDiagnostic,
  type SubSourceDiagnostic,
} from '../subSourceDiagnostics';
import {
  classifyOcrCandidate,
  detectImageFormat,
  resolveSafetyHelpers,
  type LayoutBox,
  type LidlProspectOcrOptions,
  type OcrSafetyRejectReason,
  type ResolvedOcrSafetyHelpers,
} from './lidlProspectOcr';

/** Tag, das JEDES live geschaltete Vision-Angebot trägt — macht den Pfad im
 *  Snapshot/Report nachvollziehbar und erlaubt eine spätere Re-Bewertung. */
export const LIDL_VISION_OFFER_TAG = 'lidl-vision';

/** Suffix der Vision-Bilanz-Diagnosezeile (status empty/success → blockiert nie das
 *  Safety-Gate; rein diagnostisch), analog zur OCR-Bilanzzeile. */
export const LIDL_VISION_DIAGNOSTIC_SUFFIX = ':prospektseiten:vision';

/** Default-Obergrenze der je Prospekt analysierten Bildseiten (Kosten-/Last-
 *  Schranke; jede Seite ist ein Vision-Modell-Lauf). */
export const LIDL_VISION_DEFAULT_IMAGE_LIMIT = 6;

/** Mindest-Confidence (0..1), ab der ein Vision-Kandidat überhaupt das Safety-Gate
 *  erreichen darf. Darunter bleibt er Review/diagnostic. */
export const LIDL_VISION_DEFAULT_MIN_CONFIDENCE = 0.6;

// ── Tiling-Defaults ─────────────────────────────────────────────────────────
// Root Cause des Full-Page-Timeouts: eine ganze 2400px-Prospektseite ist für ein
// kleines lokales Vision-Modell (llava:7b) zu groß/komplex (analyzeError/Timeout).
// Statt der ganzen Seite werden kleinere, überlappende Raster-Ausschnitte (Tiles)
// einzeln analysiert — jedes Tile ist klein genug, dass das Modell schnell antwortet.

/** Default-Spaltenzahl des Tile-Rasters. */
export const LIDL_VISION_DEFAULT_TILE_COLUMNS = 2;
/** Default-Überlappung benachbarter Tiles als Anteil der Tile-Kante. Bewusst KLEIN
 *  gehalten (0.08): genug, damit Karten an Tile-Grenzen nicht zerschnitten werden, aber
 *  klein genug, dass NICHT die halbe Nachbarkarte ins Tile blutet — größere Überlappung
 *  zog im Live-Befund gemischte Tiles + Halluzinationen + Tile-interne Dubletten nach sich. */
export const LIDL_VISION_DEFAULT_TILE_OVERLAP = 0.08;
/** Default-Obergrenze erzeugter Tiles je Seite (Kosten-/Last-Schranke; jedes Tile ist
 *  ein eigener Vision-Modell-Lauf). Klein gehalten, damit Tests/Probeläufe schnell sind. */
export const LIDL_VISION_DEFAULT_TILE_LIMIT = 8;
/** Default-Timeout je Tile (ms). Bewusst kurz: ein kleines Tile muss schnell antworten;
 *  bei Überschreitung wird das Tile als tileAnalyzeError gezählt und der Scan läuft weiter. */
export const LIDL_VISION_DEFAULT_TILE_TIMEOUT_MS = 40000;
/** Default-Budget erzeugter Subtiles je Lauf (Subtile-Fallback nach Tile-Timeout). Klein
 *  gehalten, damit der Fallback die Laufzeit nicht explodieren lässt. */
export const LIDL_VISION_DEFAULT_SUBTILE_LIMIT = 4;

/** Tile-spezifischer Prompt-Zusatz: das Modell soll NUR den Ausschnitt bewerten und an
 *  den Rändern angeschnittene Karten ignorieren (sie werden vom Nachbar-Tile erfasst).
 *  Bleibt als Marker erhalten (der Runner setzt ihn, damit der Adapter Tile- von
 *  Full-Page-Aufrufen unterscheiden kann); der eigentliche, KURZE Tile-Prompt ist
 *  {@link LIDL_VISION_TILE_PROMPT}. */
export const LIDL_VISION_TILE_PROMPT_HINT = [
  'WICHTIG: Dies ist NUR EIN AUSSCHNITT einer Prospektseite, nicht die ganze Seite.',
  'Analysiere ausschließlich die in diesem Ausschnitt VOLLSTÄNDIG sichtbaren Produktkarten.',
  'Ignoriere an den Rändern angeschnittene/halbe Karten — sie werden in einem anderen Ausschnitt erfasst.',
  'Bleib bei DEUTSCH und rate KEIN Datum/keine Jahreszahl (siehe Regeln oben).',
].join('\n');

/** KURZER Tile-Prompt für kleine Ausschnitte. Root Cause des Tile-Timeouts: der volle
 *  Regel-Prompt ({@link VISION_PROMPT}) ist für ein kleines lokales Modell (llava:7b) je
 *  Tile zu schwer — viele Tokens Anweisung + Bild ⇒ das Modell antwortet nicht im Timeout.
 *  Dieser Prompt ist bewusst minimal (JSON-only, wenige Zeilen); die Detail-/Sicherheits-
 *  regeln (Grundpreis, Pfand, Datum, Badge, Marke, Sprache) erzwingt danach das Code-Gate
 *  (validateVisionCandidateQuality + classifyOcrCandidate), NICHT der Prompt. KEINE Produkt-/
 *  Marken-/KW-Allowlist. */
export const LIDL_VISION_TILE_PROMPT = [
  'Extract visible German supermarket (Lidl) offer cards from this image crop.',
  'Return ONLY JSON: {"candidates":[{"name":string,"price":number,"unitText":string,"evidenceText":string,"confidence":number}]}.',
  'name = full product name as printed (German, no translation). price = action price in EUR as a number (e.g. 1.49).',
  'unitText = pack/amount as printed (e.g. "500 g"); evidenceText = the visible German card text (short).',
  'Only include cards with a clearly visible product name AND action price. No guessing, no invented text.',
  'If unsure or the crop has no clear card: return {"candidates":[]}.',
].join('\n');

/** Tiling-Strategie-Optionen (alle konservativ defaultet). */
export interface VisionTilePlanOptions {
  /** Spaltenzahl des Rasters. Default {@link LIDL_VISION_DEFAULT_TILE_COLUMNS}. */
  columns?: number;
  /** Zeilenzahl; <= 0 ⇒ adaptiv aus dem Seitenverhältnis abgeleitet (Default adaptiv). */
  rows?: number;
  /** Überlappung benachbarter Tiles als Anteil der Tile-Kante (0..0.49).
   *  Default {@link LIDL_VISION_DEFAULT_TILE_OVERLAP}. */
  overlap?: number;
  /** Obergrenze erzeugter Tiles je Seite. Default {@link LIDL_VISION_DEFAULT_TILE_LIMIT}. */
  limit?: number;
  /** Max. Tile-Breite in Quellpixeln; > 0 ⇒ die Spaltenzahl wird so erhöht, dass kein Tile
   *  breiter als dieser Wert ist (weniger Bildinhalt pro Modell-Call). 0/undefined = aus. */
  maxTileWidth?: number;
  /** Max. Tile-Höhe in Quellpixeln; > 0 ⇒ die Zeilenzahl wird so erhöht, dass kein Tile
   *  höher als dieser Wert ist. 0/undefined = aus. */
  maxTileHeight?: number;
}

/** Ein geplantes Tile: Position im Raster + Region in Quellbild-Pixeln. */
export interface VisionTile {
  index: number;
  column: number;
  row: number;
  /** Region im Quellbild (mit Überlappung), in Pixeln. */
  box: LayoutBox;
}

/** Ein gerendertes Tile: zugeschnittene Bildbytes + Geometrie (für die Analyse). */
export interface VisionTileImage extends VisionTile {
  /** JPEG/PNG-Bytes des Ausschnitts. */
  bytes: Uint8Array;
  /** Container-Format der Tile-Bytes ('jpeg' | 'png'). */
  format: string;
}

/** Injizierbarer Tiler: zerlegt EIN dekodierbares Prospektbild in (überlappende) Tiles.
 *  Der reale Tiler nutzt canvas; Tests injizieren synthetische Tiles. Wirft
 *  {@link VisionTileRenderError}, wenn das Bild nicht (canvas-)dekodierbar ist. */
export type LidlVisionImageTiler = (
  image: { bytes: Uint8Array; imageUrl: string; format: string },
  options: VisionTilePlanOptions,
) => Promise<VisionTileImage[]>;

/** Signalisiert, dass ein Prospektbild NICHT in Tiles zerlegt werden konnte (z. B.
 *  canvas kann das Format nicht dekodieren — WebP/AVIF). Nicht fatal: der Lauf zählt
 *  `tileRenderFailed` und macht mit der nächsten Seite weiter. */
export class VisionTileRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisionTileRenderError';
  }
}

/**
 * Pure Tile-Planung: zerlegt eine Bildfläche (width × height) in ein überlappendes
 * Spalten×Zeilen-Raster. Keine Bild-IO — nur Geometrie, damit die Strategie trivial
 * testbar ist. Zeilen sind adaptiv (aus dem Seitenverhältnis), wenn `rows` nicht
 * gesetzt ist, sonst fix. Das Tile-Budget (`limit`) wird strikt eingehalten.
 */
export function planVisionTiles(
  width: number,
  height: number,
  options: VisionTilePlanOptions = {},
): VisionTile[] {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const limit = Math.max(1, Math.floor(options.limit ?? LIDL_VISION_DEFAULT_TILE_LIMIT));
  let columns = Math.max(1, Math.floor(options.columns ?? LIDL_VISION_DEFAULT_TILE_COLUMNS));
  // Max-Pixel-Schranke: erzwingt mehr Spalten, damit kein Tile breiter als maxTileWidth wird
  // (weniger Bildinhalt pro Modell-Call). Greift nur, wenn > 0 gesetzt.
  const maxTileWidth = Math.floor(options.maxTileWidth ?? 0);
  if (maxTileWidth > 0) {
    columns = Math.max(columns, Math.ceil(w / maxTileWidth));
  }
  columns = Math.min(columns, limit);

  const maxTileHeight = Math.floor(options.maxTileHeight ?? 0);
  const requestedRows = Math.floor(options.rows ?? 0);
  let rows: number;
  if (requestedRows > 0) {
    rows = requestedRows;
  } else {
    // Adaptiv: möglichst quadratische Tiles → rows ≈ height / (width/columns).
    const tileWidth = w / columns;
    rows = Math.round(h / Math.max(1, tileWidth));
    rows = Math.min(Math.max(rows, 2), Math.max(1, Math.floor(limit / columns)));
  }
  // Max-Pixel-Schranke für die Höhe: erzwingt mehr Zeilen, damit kein Tile höher als
  // maxTileHeight wird (im Rahmen des Tile-Budgets).
  if (maxTileHeight > 0) {
    rows = Math.max(rows, Math.ceil(h / maxTileHeight));
  }
  rows = Math.max(1, rows);
  if (columns * rows > limit) {
    rows = Math.max(1, Math.floor(limit / columns));
  }

  const overlap = Math.min(Math.max(options.overlap ?? LIDL_VISION_DEFAULT_TILE_OVERLAP, 0), 0.49);
  const baseW = w / columns;
  const baseH = h / rows;
  const padX = baseW * overlap;
  const padY = baseH * overlap;

  const tiles: VisionTile[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      if (tiles.length >= limit) {
        return tiles;
      }
      const x0 = Math.max(0, Math.floor(col * baseW - padX));
      const y0 = Math.max(0, Math.floor(row * baseH - padY));
      const x1 = Math.min(w, Math.ceil((col + 1) * baseW + padX));
      const y1 = Math.min(h, Math.ceil((row + 1) * baseH + padY));
      tiles.push({
        index: tiles.length,
        column: col,
        row,
        box: { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) },
      });
    }
  }
  return tiles;
}

/** Plausibler Lebensmittel-Aktionspreis (EUR) — identische Schranken wie der OCR-
 *  Pfad: zwischen 0,10 € und 99,99 €. */
function isPlausibleActionPrice(price: number): boolean {
  return Number.isFinite(price) && price >= 0.1 && price <= 99.99;
}

/**
 * Signalisiert, dass das Vision-MODELL/die Runtime selbst nicht verfügbar ist
 * (Host nicht erreichbar, Modell nicht installiert oder kein Modell konfiguriert)
 * — im Gegensatz zu einem normalen Analysefehler auf EINEM Bild. Erlaubt eine
 * ehrliche Diagnose (`modelUnavailable`) statt eines stillen raw=0.
 */
export class VisionModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisionModelUnavailableError';
  }
}

/**
 * Signalisiert, dass das Modell eine NICHT parsebare Antwort lieferte (kaputtes/
 * kein JSON). NICHT fatal: der Lauf zählt es als `parseError` und macht mit der
 * nächsten Seite weiter — eine kaputte Antwort blockiert nie den Scan.
 */
export class VisionResponseParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisionResponseParseError';
  }
}

/**
 * Signalisiert, dass das Modell mit einem HTTP-Fehler (≠404, ≠leer) antwortete — die
 * Runtime LEBT (Host erreichbar, Modell geladen), aber dieser EINE Aufruf scheiterte
 * (z. B. 500/400). NICHT fatal: der Lauf zählt es und macht weiter. Abgegrenzt von
 * {@link VisionModelUnavailableError} (Host/Modell ganz weg) und
 * {@link VisionResponseParseError} (Antwort kam, war aber kein JSON).
 */
export class VisionHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisionHttpError';
  }
}

/**
 * Signalisiert, dass das Modell eine LEERE Antwort lieferte (kein content/response).
 * NICHT fatal: der Lauf zählt es als `emptyResponse` und macht weiter. Abgegrenzt vom
 * {@link VisionResponseParseError} (es KAM Text, war aber kein JSON).
 */
export class VisionEmptyResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisionEmptyResponseError';
  }
}

/** Cross-realm-sichere Erkennung (Worker/Bundles können eigene Klassen haben). */
function isVisionModelUnavailable(error: unknown): boolean {
  return (
    error instanceof VisionModelUnavailableError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'VisionModelUnavailableError')
  );
}

function isVisionResponseParseError(error: unknown): boolean {
  return (
    error instanceof VisionResponseParseError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'VisionResponseParseError')
  );
}

function isVisionHttpError(error: unknown): boolean {
  return (
    error instanceof VisionHttpError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'VisionHttpError')
  );
}

function isVisionEmptyResponseError(error: unknown): boolean {
  return (
    error instanceof VisionEmptyResponseError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'VisionEmptyResponseError')
  );
}


// ---------------------------------------------------------------------------
// Antwortschema EINER Vision-Produktkarte (vom Adapter/Modell geliefert).
// Bewusst flach + diagnose-freundlich. Der Adapter ist verantwortlich, die strikte
// JSON-Antwort des Modells in dieses Schema zu parsen.
// ---------------------------------------------------------------------------
export interface VisionProspectCandidate {
  /** Produktname (kein Badge, keine Einheit, kein Promo-Wort). */
  name: string;
  /** Aktionspreis in EUR (NICHT Grundpreis/Pfand/Datum). */
  price: number;
  /** Packung/Einheit als Freitext (z. B. „500 g", „je 1 kg"). */
  unitText?: string;
  /** Grundpreis als Freitext (z. B. „1 kg = 2,98 €"), falls sichtbar. */
  basePriceText?: string;
  /** Gültigkeit/Prospekt-Kontext als Freitext (z. B. „gültig ab Mo."). */
  validityText?: string;
  /** Optionale Bounding-Box der Karte in Bildpixeln (nur Diagnose). */
  bbox?: LayoutBox;
  /** Modell-Confidence 0..1. */
  confidence: number;
  /** Vom Modell gesetzter Verwerfungsgrund (z. B. „base_price", „deposit",
   *  „validity_date", „badge", „unsure") — nicht-leer ⇒ Kandidat wird verworfen. */
  rejectReason?: string;
  /** Kurzer Evidenztext (sichtbarer Text der Karte) — nur Diagnose. */
  evidenceText?: string;
}

/** Ergebnis EINER Bildanalyse (vom Adapter geliefert). */
export interface VisionImageAnalysis {
  candidates: VisionProspectCandidate[];
  /** Tatsächlich verwendeter Modellname (für die Diagnose). */
  modelName: string;
  /** Roh-Modell-JSON (NUR Debug; wird NIE im Snapshot gespeichert). */
  rawResponse?: string;
}

/** Kontext, den der Adapter für Prompt/Diagnose braucht. */
export interface VisionAnalysisContext {
  storeChain: string;
  sourceUrl: string;
  imageUrl: string;
  imageFormat: string;
  validityStart?: string;
  validityEnd?: string;
}

/** Zusatzoptionen je Analyse-Aufruf (rückwärtskompatibel/optional). Im Tile-Modus
 *  setzt der Runner ein `signal` (Tile-Timeout-Abbruch) und einen `promptHint`
 *  ("nur diesen Ausschnitt"). Bestehende Adapter ignorieren das Argument. */
export interface VisionAnalyzeOptions {
  /** Abbruch-Signal des Runners (Tile-Timeout) — der reale Adapter bricht damit den
   *  HTTP-Request ab, statt ihn ins Leere weiterlaufen zu lassen. */
  signal?: AbortSignal;
  /** Tile-spezifischer Prompt-Zusatz (Marker, dass es ein Tile ist). Bleibt für die
   *  Rückwärtskompatibilität erhalten; der reale Adapter nutzt bevorzugt {@link prompt}. */
  promptHint?: string;
  /** Vollständiger Prompt-Override (Tile-Modus: der KURZE {@link LIDL_VISION_TILE_PROMPT}).
   *  Ist er gesetzt, verwendet der Adapter genau diesen Prompt statt des Basis-Prompts. */
  prompt?: string;
}

/** Injizierbarer Vision-Adapter: analysiert EIN Prospektbild (oder EIN Tile). Tests
 *  speisen hier Fake-Vision-Antworten ein; der Default (Ollama) wird vom Connector
 *  verdrahtet. Das dritte Argument ist optional/rückwärtskompatibel. */
export type AnalyzeLidlProspectImage = (
  image: { bytes: Uint8Array; imageUrl: string; format: string },
  context: VisionAnalysisContext,
  options?: VisionAnalyzeOptions,
) => Promise<VisionImageAnalysis>;

// ---------------------------------------------------------------------------
// Pure Extraktion: Vision-Kandidaten → sichere Lidl-Angebote + Verwerfungs-Zählkette.
// ---------------------------------------------------------------------------

export type VisionRejectReason =
  /** Modell hat selbst einen rejectReason gesetzt (Grundpreis/Pfand/Datum/Badge/unsicher). */
  | 'modelRejected'
  /** Modell-Confidence < Schwelle. */
  | 'lowConfidence'
  /** Kein belastbarer Produktname. */
  | 'noName'
  /** Kein plausibler Aktionspreis (fehlt / 0 / > 99,99 €). */
  | 'noPrice'
  /** Der „Preis" ist strukturell der GRUNDPREIS (== aus basePriceText geparster Wert). */
  | 'basePrice'
  /** Name ist ein reines Badge/Attribut („3 Stück", „kernarm", „Aktion"). */
  | 'badgeName'
  /** Geteiltes Gate: Fragment-/Störername. */
  | 'fragmentName'
  /** Geteiltes Gate: OCR-/Müllname (kein echtes Wort). */
  | 'nameQuality'
  /** Geteiltes Gate: Duplikat (struktureller / Vision-interner Treffer). */
  | 'duplicate'
  /** Geteiltes Gate: starkes Non-Food-Signal. */
  | 'nonFood'
  /** Geteiltes Gate: Non-Food-Beleg mit irreführend als Food klassifizierter Kategorie. */
  | 'categoryConflict'
  /** Geteiltes Gate: kein starker Food-Beleg. */
  | 'missingStrongFoodEvidence';

export type VisionRejectionCounts = Record<VisionRejectReason, number>;

export function emptyVisionRejections(): VisionRejectionCounts {
  return {
    modelRejected: 0,
    lowConfidence: 0,
    noName: 0,
    noPrice: 0,
    basePrice: 0,
    badgeName: 0,
    fragmentName: 0,
    nameQuality: 0,
    duplicate: 0,
    nonFood: 0,
    categoryConflict: 0,
    missingStrongFoodEvidence: 0,
  };
}

/** Bildet die Reason-Codes des GETEILTEN Safety-Gates (classifyOcrCandidate) auf die
 *  Vision-Zähler ab — `lowConfidence` des Gates ist dort der FRAGMENT-Grund und wird
 *  hier bewusst als `fragmentName` geführt (Vision-`lowConfidence` = Confidence-Schwelle). */
function mapSharedReason(reason: OcrSafetyRejectReason): VisionRejectReason {
  return reason === 'lowConfidence' ? 'fragmentName' : reason;
}

// ---------------------------------------------------------------------------
// MODELL-ANTWORT-QUALITÄT (strenge Validierung VOR dem zentralen Safety-Gate).
// Belegter Live-Befund: llava:7b halluziniert (englische Namen, alte/erfundene Daten
// wie 2023, generische Markennamen, vom Modell selbst markierte Unsicherheit,
// Grundpreis-/Einheiten-Verwechslung). Diese Schicht verwirft solche Kandidaten mit
// EIGENEN, nachvollziehbaren Zählern (modelQualityRejectedByReason), BEVOR sie das
// geteilte Safety-Gate erreichen. Rein STRUKTURELL — KEINE Produkt-/Marken-/KW-
// Allowlist; die konkreten Beispielnamen leben ausschließlich in Tests/Fixtures.
// ---------------------------------------------------------------------------

export type VisionQualityRejectReason =
  /** Modell hat selbst einen rejectReason gesetzt (z. B. "unsure"). */
  | 'visionRejectReason'
  /** validityText enthält eine implausible Jahreszahl außerhalb der Prospektnähe (z. B. 2023). */
  | 'implausibleDate'
  /** evidenceText fehlt oder belegt Name + Aktionspreis nicht. */
  | 'missingEvidenceText'
  /** Name ist nur Marke/Label (kein Produkttyp) — strukturell: Einzeltoken ohne Food-Beleg. */
  | 'brandOnlyName'
  /** Englischer Name ohne sichtbaren deutschen Beleg im evidenceText. */
  | 'languageMismatch'
  /** unitText ist nur Währung ("€", "€ / kg") oder eindeutig Unsinn (kein echtes Maß). */
  | 'unitLooksInvalid';

export type VisionQualityRejectionCounts = Record<VisionQualityRejectReason, number>;

export function emptyVisionQualityRejections(): VisionQualityRejectionCounts {
  return {
    visionRejectReason: 0,
    implausibleDate: 0,
    missingEvidenceText: 0,
    brandOnlyName: 0,
    languageMismatch: 0,
    unitLooksInvalid: 0,
  };
}

export interface VisionPageAnalysis {
  imageUrl?: string;
  candidates: readonly VisionProspectCandidate[];
}

export interface LidlVisionContext {
  storeChain: string;
  sourceUrl: string;
  /** Stabile Prospekt-/Subquellen-Id, an die die Vision-Angebote gebunden werden. */
  sourceId?: string;
  /** Aus dem Flyer abgeleitetes Gültigkeitsfenster (NICHT geraten). */
  validityStart?: string;
  validityEnd?: string;
  /** Normalisierte Namen der bereits strukturiert importierten Lidl-Angebote
   *  (Dedupe-Ziel) — kein neues Wissen, nur die vorhandenen Treffer. */
  existingNameKeys?: Iterable<string>;
}

export interface LidlVisionExtractOptions extends LidlProspectOcrOptions {
  /** Mindest-Confidence (0..1). Default {@link LIDL_VISION_DEFAULT_MIN_CONFIDENCE}. */
  minConfidence?: number;
  /** Strenge Modell-Antwort-Qualität erzwingen (Sprache/Datum/Evidenz/Einheit/Markenname)
   *  VOR dem zentralen Safety-Gate. Default `false` (Rückwärtskompatibilität: ältere
   *  Aufrufer/Tests ohne evidenceText bleiben unberührt). Der Connector aktiviert es. */
  enforceModelQuality?: boolean;
}

export interface LidlVisionExtractResult {
  /** Sichere, deduplizierte Vision-Kandidaten (NUR im Live-Modus emittiert). */
  offers: RawOfferCandidate[];
  /** Roh gelieferte Vision-Kandidaten VOR den Sicherheitsverwerfungen. */
  rawCandidates: number;
  /** Nach allen Verwerfungen verbleibende sichere Kandidaten. */
  safeCandidates: number;
  rejections: VisionRejectionCounts;
  /** Strenge Modell-Antwort-Qualitäts-Verwerfungen VOR dem Safety-Gate (eigene Lens). */
  qualityRejections: VisionQualityRejectionCounts;
  /** Pro-Kandidat-Verdikt (Debug/Evidence): Name + Verdikt + ggf. Grund. */
  decisions: VisionCandidateDecision[];
}

export interface VisionCandidateDecision {
  name: string;
  price: number;
  verdict: 'safe' | VisionRejectReason | VisionQualityRejectReason;
  imageUrl?: string;
}

/** Reine Badge-/Attributnamen, die nie ein Produktname sind. Strukturell (kein
 *  Produkt-/Markenwissen): Mengen-/Promo-/Attributvokabular. Eine vorangestellte
 *  Menge („3 Stück", „2x") wird abgestreift; bleibt nur ein Badge-Token übrig (oder
 *  nichts), ist es kein Produkt. */
const VISION_BADGE_TOKENS: ReadonlySet<string> = new Set([
  'stueck', 'stk', 'kernarm', 'fettarm', 'aktion', 'angebot', 'neu', 'gratis',
  'set', 'pack', 'packung', 'vorteilspack', 'xxl', 'xl', 'bonus', 'rabatt',
  'sparpreis', 'tiefpreis', 'knaller', 'kracher', 'highlight', 'sale', 'frische',
  'frisch', 'original', 'extra', 'mega', 'jumbo',
]);

export function isVisionBadgeName(name: string): boolean {
  const normalized = normalizeText(name)
    // führende Menge abstreifen: „3", „2x", „6er", „500 g"
    .replace(/^\s*\d+(?:[.,]\d+)?\s*(?:x|er|stk|stueck|g|kg|ml|l|cl)?\s*/i, '')
    .trim();
  if (normalized.length === 0) {
    // Nur eine Menge/Einheit, kein Wort übrig.
    return true;
  }
  if (!/\p{L}/u.test(normalized)) {
    return true;
  }
  const tokens = normalized.split(' ').filter(Boolean);
  // Ein einzelnes Badge-Token (oder ausschließlich Badge-Tokens) ist kein Produkt.
  return tokens.length > 0 && tokens.every((token) => VISION_BADGE_TOKENS.has(token));
}

/** Erster Euro-Betrag aus einem Grundpreis-Freitext („1 kg = 2,98 €"). */
function parsePriceFromText(text: string | undefined): number | null {
  if (!text) {
    return null;
  }
  const match = text.match(/(\d{1,3})\s*[,.]\s*(\d{2})/);
  if (!match) {
    return null;
  }
  const price = Number(`${match[1]}.${match[2]}`);
  return Number.isFinite(price) ? Number(price.toFixed(2)) : null;
}

/** Ist der gemeldete „Preis" strukturell der Grundpreis? Wahr NUR, wenn der aus
 *  basePriceText geparste Grundpreis dem gemeldeten Preis (≈) entspricht — dann hat
 *  das Modell den Grundpreis als Aktionspreis ausgegeben. */
function priceIsBasePrice(candidate: VisionProspectCandidate): boolean {
  const base = parsePriceFromText(candidate.basePriceText);
  return base !== null && Math.abs(base - candidate.price) < 0.005;
}

// ── Strukturelle Bausteine der Modell-Antwort-Qualität ──────────────────────────
// Alle rein strukturell/sprachlich — KEIN Produkt-/Marken-/KW-Wissen.

/** Eindeutig englische Funktions-/Beschreibungswörter (Sprachdetektion, KEINE
 *  Produktliste): tauchen sie im NAMEN auf, hat das Modell vermutlich ins Englische
 *  übersetzt. Bewusst ohne konkrete Produkt-/Markennamen. */
const ENGLISH_NAME_MARKERS: ReadonlySet<string> = new Set([
  'fresh', 'with', 'and', 'the', 'for', 'of', 'sweet', 'frozen', 'organic',
  'natural', 'free', 'whole', 'low', 'fat', 'red', 'green', 'roasted', 'smoked',
  'sliced', 'creamy', 'crispy', 'flavour', 'flavor', 'boneless',
]);

/** Klare deutsche Sprachsignale (Diakritika, Komma-Preis, deutsche Füllwörter). Units
 *  wie g/kg/ml sind sprachneutral und zählen NICHT. */
const GERMAN_EVIDENCE_MARKERS: ReadonlySet<string> = new Set([
  'und', 'mit', 'je', 'ab', 'fuer', 'pro', 'nur', 'gueltig', 'packung', 'stueck',
  'angebot', 'preis', 'frische', 'jede', 'jeder', 'sorten', 'verschiedene',
]);

/** Sieht der NAME nach englischer Übersetzung aus (mind. ein eindeutig englischer Marker)? */
function looksEnglishName(name: string): boolean {
  const tokens = normalizeText(name).split(' ').filter(Boolean);
  return tokens.some((token) => ENGLISH_NAME_MARKERS.has(token));
}

/** Trägt der Evidenztext ein klares deutsches Sprachsignal (Umlaut/ß, Komma-Preis oder
 *  deutsches Füllwort)? Umlaut/Komma werden am ROHTEXT geprüft (normalizeText würde sie
 *  transliterieren/entfernen). */
function evidenceHasGermanSignal(text: string): boolean {
  if (/[äöüßÄÖÜ]/.test(text)) {
    return true;
  }
  if (/\d\s*,\s*\d{2}/.test(text)) {
    return true; // deutscher Komma-Preis ("1,49")
  }
  const tokens = normalizeText(text).split(' ').filter(Boolean);
  return tokens.some((token) => GERMAN_EVIDENCE_MARKERS.has(token));
}

/** Enthält `text` den Aktionspreis als ablesbaren Betrag (Komma ODER Punkt)? */
function evidenceContainsPrice(text: string, price: number): boolean {
  if (!Number.isFinite(price)) {
    return false;
  }
  const cents = Math.round(price * 100);
  const euros = Math.floor(cents / 100);
  const rest = String(cents % 100).padStart(2, '0');
  return new RegExp(`(?:^|[^\\d])${euros}\\s*[.,]\\s*${rest}(?:[^\\d]|$)`).test(text);
}

/** Belegt der Evidenztext Name UND Aktionspreis? Fehlender/leerer Evidenztext gilt als
 *  NICHT belegt. Name = mind. ein signifikantes Wort (≥3 Buchstaben) taucht (normalisiert)
 *  im Evidenztext auf; trägt der Name kein signifikantes Wort, genügt der Preisbeleg. */
function evidenceSupportsCandidate(
  evidenceText: string | undefined,
  name: string,
  price: number,
): boolean {
  if (!evidenceText || evidenceText.trim().length === 0) {
    return false;
  }
  if (!evidenceContainsPrice(evidenceText, price)) {
    return false;
  }
  const evidenceNorm = normalizeText(evidenceText);
  const nameTokens = normalizeText(name).split(' ').filter((token) => token.length >= 3);
  if (nameTokens.length === 0) {
    return true;
  }
  return nameTokens.some((token) => evidenceNorm.includes(token));
}

/** Enthält `validityText` eine Jahreszahl AUSSERHALB der plausiblen Prospektnähe? Ohne
 *  erkennbare Jahreszahl ⇒ kein Verstoß (fehlende/„ab Montag"-Angaben sind erlaubt). */
function validityTextHasImplausibleYear(
  validityText: string | undefined,
  plausibleYears: ReadonlySet<number>,
): boolean {
  if (!validityText) {
    return false;
  }
  const years = validityText.match(/\b(?:19|20)\d{2}\b/g);
  if (!years) {
    return false;
  }
  return years.some((year) => !plausibleYears.has(Number(year)));
}

/** Plausible Prospekt-Jahre (Gültigkeitsjahr ± 1; Fallback = aktuelles Jahr ± 1). */
function plausibleProspectYears(validityStart?: string): Set<number> {
  let base = validityStart ? new Date(validityStart).getFullYear() : Number.NaN;
  if (!Number.isFinite(base)) {
    base = new Date().getFullYear();
  }
  return new Set([base - 1, base, base + 1]);
}

/** Ist `unitText` strukturell Unsinn? Eine Packungs-/Mengenangabe ("500 g", "je 1 kg")
 *  trägt NIE ein Währungszeichen — tut sie es ("€", "€ / kg"), hat das Modell einen
 *  (Grund-)PREIS in die Einheit geschrieben. Auch reiner Symbol-/Leermüll ist ungültig. */
function unitTextLooksInvalid(unitText: string | undefined): boolean {
  if (!unitText) {
    return false; // Einheit ist optional — fehlend ist NICHT „ungültig".
  }
  const trimmed = unitText.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (/€|eur\b/i.test(trimmed)) {
    return true; // Währung gehört nie in eine Packungseinheit.
  }
  return !/[a-z0-9]/i.test(trimmed); // kein einziges alphanumerisches Zeichen → Müll.
}

/** Ist der Name strukturell NUR eine Marke/ein Label (kein Produkttyp)? Heuristik ohne
 *  Markenliste: ein EINZELNES Wort (nach Abstreifen einer führenden Menge) OHNE jeden
 *  Food-Beleg ist als Produktname unbrauchbar (z. B. "Lidl", "Fairtrade", "Haribo").
 *  Mehrwortnamen ("Heinz Tomato Ketchup", "Bio Bananen") tragen Produktstruktur und
 *  bleiben unberührt; ein bekanntes Food-Wort ("Bananen") ebenfalls. */
function isVisionBrandOnlyName(name: string, helpers: ResolvedOcrSafetyHelpers): boolean {
  const normalized = normalizeText(name)
    .replace(/^\s*\d+(?:[.,]\d+)?\s*(?:x|er|stk|stueck|g|kg|ml|l|cl)?\s*/i, '')
    .trim();
  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.length !== 1) {
    return false;
  }
  // Einzelwort: nur dann „Marke", wenn KEIN starker Food-Beleg vorliegt.
  return !helpers.hasStrongFoodEvidence({ name: normalized, category: '' });
}

/** Strenge Modell-Antwort-Qualität EINES Kandidaten (vor dem Safety-Gate). Gibt den
 *  ersten verletzten Grund zurück oder null (Kandidat ist qualitativ brauchbar). Der
 *  vom Modell selbst gesetzte rejectReason wird HIER NICHT geprüft (das übernimmt die
 *  bestehende modelRejected-Vorstufe und spiegelt zusätzlich `visionRejectReason`). */
function validateVisionCandidateQuality(
  candidate: VisionProspectCandidate,
  helpers: ResolvedOcrSafetyHelpers,
  plausibleYears: ReadonlySet<number>,
): VisionQualityRejectReason | null {
  if (validityTextHasImplausibleYear(candidate.validityText, plausibleYears)) {
    return 'implausibleDate';
  }
  if (unitTextLooksInvalid(candidate.unitText)) {
    return 'unitLooksInvalid';
  }
  if (!evidenceSupportsCandidate(candidate.evidenceText, candidate.name, candidate.price)) {
    return 'missingEvidenceText';
  }
  if (looksEnglishName(candidate.name) && !evidenceHasGermanSignal(candidate.evidenceText ?? '')) {
    return 'languageMismatch';
  }
  if (isVisionBrandOnlyName(candidate.name, helpers)) {
    return 'brandOnlyName';
  }
  return null;
}

function stableLidlVisionId(storeChain: string, name: string, price: number, validityStart: string): string {
  const source = `${storeChain}|vision|${normalizeText(name)}|${price}|${validityStart}`;
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash << 5) - hash + source.charCodeAt(index);
    hash |= 0;
  }
  return `lidl_vision_${Math.abs(hash).toString(36)}`;
}

function buildVisionOfferCandidate(args: {
  context: LidlVisionContext;
  candidate: VisionProspectCandidate;
  name: string;
  category: string;
  imageUrl?: string;
}): RawOfferCandidate {
  const validityStart = args.context.validityStart;
  const unit = args.candidate.unitText
    ? args.candidate.unitText.replace(/\s+/g, ' ').trim() || undefined
    : undefined;
  return {
    id: stableLidlVisionId(args.context.storeChain, args.name, args.candidate.price, validityStart ?? ''),
    name: args.name,
    storeChain: args.context.storeChain,
    category: args.category,
    price: args.candidate.price,
    currency: 'EUR',
    unit,
    validityStart,
    validityEnd: args.context.validityEnd,
    imageUrl: args.imageUrl,
    sourceUrl: args.context.sourceUrl,
    sourceId: args.context.sourceId,
    sourceCategoryRaw: 'Lidl Prospekt Vision',
    sourceContextRaw: args.candidate.evidenceText,
    // Quelle klar markieren: lidl-vision (Health/Coverage) + neutrale Herkunftstags.
    tags: [LIDL_VISION_OFFER_TAG, 'vision', 'vision_card'],
  };
}

/**
 * Pure Extraktion: Vision-Seitenanalysen → sichere Lidl-Angebotskandidaten + die
 * vollständige Verwerfungs-Zählkette. Keine Netzwerkzugriffe, keine Mutation der
 * Eingaben. Reihenfolge nach abnehmender Sicherheit:
 *   noName → modelRejected → lowConfidence → badgeName → noPrice → basePrice →
 *   GETEILTES zentrales Safety-Gate (Fragment → Namensqualität → Duplikat →
 *   Non-Food-/CategoryConflict-Veto → Pflicht-Food-Beleg).
 */
export function extractLidlVisionOffers(
  pages: readonly VisionPageAnalysis[],
  context: LidlVisionContext,
  options: LidlVisionExtractOptions = {},
): LidlVisionExtractResult {
  const helpers = resolveSafetyHelpers(options);
  const minConfidence = options.minConfidence ?? LIDL_VISION_DEFAULT_MIN_CONFIDENCE;
  const enforceModelQuality = options.enforceModelQuality ?? false;
  const plausibleYears = plausibleProspectYears(context.validityStart);
  const rejections = emptyVisionRejections();
  const qualityRejections = emptyVisionQualityRejections();
  const decisions: VisionCandidateDecision[] = [];
  const offers: RawOfferCandidate[] = [];
  // Dedupe-Set: gegen die bereits strukturiert importierten Namen UND innerhalb des
  // Vision-Laufs (das geteilte Gate mutiert `seen` exakt wie beim OCR-Pfad).
  const seen = new Set<string>(
    [...(context.existingNameKeys ?? [])].map((key) => normalizeText(String(key))),
  );
  let rawCandidates = 0;

  const reject = (
    candidate: VisionProspectCandidate,
    reason: VisionRejectReason,
    imageUrl?: string,
  ): void => {
    rejections[reason] += 1;
    decisions.push({ name: candidate.name, price: candidate.price, verdict: reason, imageUrl });
  };

  const rejectQuality = (
    candidate: VisionProspectCandidate,
    reason: VisionQualityRejectReason,
    imageUrl?: string,
  ): void => {
    qualityRejections[reason] += 1;
    decisions.push({ name: candidate.name, price: candidate.price, verdict: reason, imageUrl });
  };

  for (const page of pages) {
    for (const candidate of page.candidates) {
      rawCandidates += 1;
      const name = (candidate.name ?? '').trim();

      if (name.length === 0) {
        reject(candidate, 'noName', page.imageUrl);
        continue;
      }
      // Vom Modell selbst markierte Unsicherheit (Grundpreis/Pfand/Datum/Badge/„unsure").
      if (typeof candidate.rejectReason === 'string' && candidate.rejectReason.trim().length > 0) {
        if (enforceModelQuality) {
          // Modell-eigene Unsicherheit in den Qualitäts-Lens spiegeln (visionRejectReason);
          // modelRejected bleibt im Safety-Lens für die Rückwärtskompatibilität erhalten.
          qualityRejections.visionRejectReason += 1;
        }
        reject(candidate, 'modelRejected', page.imageUrl);
        continue;
      }
      if (!(typeof candidate.confidence === 'number') || candidate.confidence < minConfidence) {
        reject(candidate, 'lowConfidence', page.imageUrl);
        continue;
      }
      // Strukturelle Badge-Erkennung (unabhängig von der Modellbehauptung).
      if (isVisionBadgeName(name)) {
        reject(candidate, 'badgeName', page.imageUrl);
        continue;
      }
      if (!isPlausibleActionPrice(candidate.price)) {
        reject(candidate, 'noPrice', page.imageUrl);
        continue;
      }
      // Strukturell: der gemeldete Preis ist der Grundpreis (== basePriceText-Wert).
      if (priceIsBasePrice(candidate)) {
        reject(candidate, 'basePrice', page.imageUrl);
        continue;
      }
      // STRENGE MODELL-ANTWORT-QUALITÄT (opt-in) VOR dem zentralen Safety-Gate: verwirft
      // halluzinierte Kandidaten (engl. Name ohne dt. Beleg, implausibles Jahr, fehlender
      // Evidenzbeleg, Marken-Only-Name, Währungs-/Müll-Einheit) mit eigener Zähler-Lens.
      if (enforceModelQuality) {
        const qualityReason = validateVisionCandidateQuality(candidate, helpers, plausibleYears);
        if (qualityReason) {
          rejectQuality(candidate, qualityReason, page.imageUrl);
          continue;
        }
      }
      // GETEILTES zentrales Safety-Gate — exakt dieselbe Logik wie der OCR-Pfad.
      // Kein Kandidat geht nur wegen einer Modellbehauptung live.
      const verdict = classifyOcrCandidate(name, helpers, seen);
      if (!verdict.ok) {
        const reason = mapSharedReason(verdict.reason);
        rejections[reason] += 1;
        decisions.push({ name, price: candidate.price, verdict: reason, imageUrl: page.imageUrl });
        continue;
      }
      offers.push(
        buildVisionOfferCandidate({
          context,
          candidate,
          name,
          category: verdict.category,
          imageUrl: page.imageUrl,
        }),
      );
      decisions.push({ name, price: candidate.price, verdict: 'safe', imageUrl: page.imageUrl });
    }
  }

  return {
    offers,
    rawCandidates,
    safeCandidates: offers.length,
    rejections,
    qualityRejections,
    decisions,
  };
}

// ---------------------------------------------------------------------------
// Runner-Glue: Bilder laden (begrenzt) → Vision-Analyse → extrahieren → Diagnose.
// Wirft nie fatal: ein fehlgeschlagener Bildabruf/Analyse zählt; eine nicht
// verfügbare Modell-Runtime bricht den Lauf ehrlich ab (modelUnavailable).
// ---------------------------------------------------------------------------

/** Ehrliche Coverage-Stufe des Vision-Pfads — NIE `full`. */
export type LidlVisionCoverage = 'vision_diagnostic' | 'partial_with_vision';

export interface LidlVisionCounters {
  /** Versuchte Bildabrufe (innerhalb imageLimit). */
  imageAttempted: number;
  /** Bilder/Seiten, die tatsächlich analysiert wurden (Full-Page: erfolgreiche
   *  Analyse; Tile-Modus: mind. ein Tile analysiert). */
  imageAnalyzed: number;
  /** Erzeugte Tiles über alle Seiten (0 im Full-Page-Modus). */
  tilesGenerated: number;
  /** Tiles, die das Vision-Modell tatsächlich analysiert hat. */
  tilesAnalyzed: number;
  /** Tiles, deren Analyse fehlschlug (Umbrella = Summe der vier Gründe darunter) —
   *  blockieren weder andere Tiles noch den Scan. */
  tileAnalyzeErrors: number;
  /** Tile-Analyse lief in den Timeout. */
  tileTimeouts: number;
  /** Tile-Analyse scheiterte an einem HTTP-Fehler (Runtime lebt, Aufruf scheiterte). */
  tileHttpErrors: number;
  /** Tile-Analyse lieferte kein gültiges JSON. */
  tileParseErrors: number;
  /** Tile-Analyse lieferte eine leere Antwort. */
  tileEmptyResponses: number;
  /** Subtile-Fallback: nach Timeout erzeugte kleinere Subtiles (0 = aus/ungenutzt). */
  subtilesGenerated: number;
  /** Subtile-Fallback: erfolgreich analysierte Subtiles. */
  subtilesAnalyzed: number;
  /** Seiten, für die eine canvas-kompatible Alternativ-Rendition VERSUCHT wurde
   *  (Original WebP/AVIF → JPEG/PNG-Rendition). */
  tileRenditionsTried: number;
  /** Seiten, für die die Alternativ-Rendition canvas-kompatible Bytes lieferte. */
  tileRenditionsSucceeded: number;
  /** Roh gelieferte Vision-Kandidaten VOR den Sicherheitsverwerfungen. */
  rawVisionCandidates: number;
  /** Sichere Kandidaten nach allen Verwerfungen. */
  safeVisionCandidates: number;
  /** Tatsächlich live freigegebene Angebote (nur im Live-Modus > 0). */
  emittedOffers: number;
  rejectedByReason: VisionRejectionCounts;
  /** Strenge Modell-Antwort-Qualitäts-Verwerfungen VOR dem Safety-Gate (eigene Lens). */
  modelQualityRejectedByReason: VisionQualityRejectionCounts;
  /** Verwendeter Modellname (oder „(unavailable)"). */
  modelName: string;
  mode: 'diagnostic' | 'live';
  /** Aktive Tile-Strategie (off = Full-Page). */
  tileMode: 'off' | 'grid';
}

export interface LidlVisionFailures {
  /** Bildabruf warf (HTTP-Fehler/Timeout/Netz). */
  fetchFailed: number;
  /** Abruf ok, aber die Bytes sind KEIN dekodierbares Bild. */
  notAnImage: number;
  /** Das Vision-Modell/die Runtime war nicht verfügbar (Host/Modell/kein Modell). */
  modelUnavailable: number;
  /** Modell lieferte eine NICHT parsebare (kaputte/keine JSON-)Antwort. */
  parseError: number;
  /** Sonstiger Analysefehler auf EINEM Bild (kein Runtime-/Parse-Problem). */
  analyzeError: number;
  /** Tile-Modus: eine Seite konnte nicht in Tiles zerlegt werden (z. B. canvas kann
   *  das Format nicht dekodieren — WebP/AVIF). Umbrella-Zähler = Summe der drei
   *  spezifischen Gründe darunter. Die Seite zählt, blockiert aber nicht. */
  tileRenderFailed: number;
  /** Original-Format ist nicht canvas-kompatibel (WebP/AVIF/…) UND es war keine
   *  Alternativ-Rendition ableitbar/verfügbar (z. B. kein Rendition-Fetch). */
  unsupportedImageFormatForCanvas: number;
  /** Eine Alternativ-Rendition wurde versucht, lieferte aber erneut kein canvas-
   *  kompatibles Bild (CDN ignorierte die Format-Aushandlung / Fetch schlug fehl). */
  alternativeRenditionFailed: number;
  /** Das (als kompatibel erkannte) Bild ließ sich von canvas doch nicht dekodieren
   *  (loadImage warf — z. B. abgeschnittene/kaputte Bytes). */
  canvasDecodeFailed: number;
}

function emptyVisionFailures(): LidlVisionFailures {
  return {
    fetchFailed: 0,
    notAnImage: 0,
    modelUnavailable: 0,
    parseError: 0,
    analyzeError: 0,
    tileRenderFailed: 0,
    unsupportedImageFormatForCanvas: 0,
    alternativeRenditionFailed: 0,
    canvasDecodeFailed: 0,
  };
}

/** Fehlerklasse EINER Tile-Analyse — getrennt nach Ursache (Report/Debug). */
export type VisionTileErrorKind =
  /** Tile-Timeout (Runner-Abbruch via Signal). */
  | 'timeout'
  /** Modell antwortete mit HTTP-Fehler (≠404/≠leer) — Runtime lebt, Aufruf scheiterte. */
  | 'httpError'
  /** Antwort kam, war aber kein gültiges JSON. */
  | 'parseError'
  /** Leere Modellantwort (kein content/response). */
  | 'emptyResponse'
  /** Sonstiger Analysefehler (kein Timeout/HTTP/Parse/Leer). */
  | 'analyzeError';

/** Kompaktes Tile-Metadatum (KEINE Bilddaten) für die Debug-Evidence. */
export interface LidlVisionTileEvidence {
  index: number;
  column: number;
  row: number;
  /** Region im Quellbild (Pixel) — kompakt, keine Bytes. */
  box: LayoutBox;
  /** Byte-Länge der analysierten Tile-Bytes (Diagnose der „Schwere" je Call). */
  byteLength?: number;
  /** Dauer der Tile-Analyse in ms (Erfolg ODER Fehler/Timeout). */
  durationMs?: number;
  /** Geparste Kandidaten dieses Tiles. */
  candidateCount: number;
  /** Geparste Kandidaten dieses Tiles (seitenversetzte bbox; NUR Debug). Erlaubt es,
   *  Roh-Modellantwort → geparste Kandidaten → Verdikt je Tile nachzuvollziehen. */
  candidates?: VisionProspectCandidate[];
  /** Fehlerart, falls die Tile-Analyse fehlschlug. */
  error?: VisionTileErrorKind;
  /** Subtile-Fallback (nach Timeout): erzeugte/analysierte kleinere Subtiles. */
  subtilesGenerated?: number;
  subtilesAnalyzed?: number;
  /** Roh-Modell-JSON dieses Tiles (best-effort gekürzt; NUR Debug). */
  rawResponse?: string;
}

/** Kompaktes Debug-Artefakt EINER Vision-analysierten Seite (KEINE Bilddaten). */
export interface LidlVisionPageEvidence {
  capturedAt: string;
  storeChain: string;
  /** Stabile Prospekt-/Subquellen-Id der Seite (Diagnose; aus dem Kontext). */
  sourceId?: string;
  mode: 'diagnostic' | 'live';
  modelName: string;
  /** Aktive Tile-Strategie dieser Seite (off = Full-Page). */
  tileMode: 'off' | 'grid';
  /** Letztes Pfadsegment der Bild-URL (kompakt, kein vollständiger Tracking-Link). */
  imageUrlTail: string;
  /** Stabiler Hash der vollständigen Bild-URL (reidentifizierbar ohne URL-Speicherung). */
  imageUrlHash: string;
  imageFormat: string;
  imageByteLength: number;
  // ── Render-/Rendition-Diagnose (auch bei Render-Failure gesetzt) ───────────────
  /** Status der canvas-Renditionsauflösung dieser Seite. */
  renderStatus?: VisionCanvasRenderStatus;
  /** Ursprünglich geladenes Bildformat (Magic-Bytes), vor jeder Renditionsauflösung. */
  originalImageFormat?: string | null;
  /** Canvas-kompatibles Format, mit dem getilet wurde (jpeg/png), falls aufgelöst. */
  canvasImageFormat?: string;
  /** Hex der ersten Magic-Bytes des geladenen Bildes (Diagnose, keine Bilddaten). */
  magicBytes?: string;
  /** Letztes Pfadsegment/Hash der versuchten Alternativ-Rendition-URL (falls versucht). */
  renditionUrlTail?: string;
  renditionUrlHash?: string;
  /** Name/Message des Render-/Decode-Fehlers (falls fehlgeschlagen). */
  renderErrorName?: string;
  renderErrorMessage?: string;
  /** Ob auf dieser Seite überhaupt ein Tile-Plan ausgeführt wurde. */
  tilePlanAttempted?: boolean;
  /** Roh-Modell-JSON (best-effort gekürzt) — im Full-Page-Modus die Seitenantwort. */
  rawResponse?: string;
  /** Geparste Kandidaten dieser Seite (aggregiert über alle Tiles). */
  candidates: VisionProspectCandidate[];
  /** Finale Gate-Verdikte/Verwerfungsgründe dieser Seite. */
  decisions: VisionCandidateDecision[];
  /** Pro-Tile-Metadaten (nur im Tile-Modus gesetzt). */
  tiles?: LidlVisionTileEvidence[];
}

export interface RunLidlVisionImportInput {
  imageUrls: readonly string[];
  context: LidlVisionContext;
  mode: 'diagnostic' | 'live';
  /** Injizierbarer Vision-Adapter (Tests: Fake; Connector: Ollama-Default). */
  analyzeImage: AnalyzeLidlProspectImage;
  fetchBinary: (url: string) => Promise<Uint8Array>;
  /** OPTIONALER Rendition-Fetch für canvas-inkompatible Bilder (WebP/AVIF). Lädt eine
   *  JPEG/PNG-bevorzugende Rendition DERSELBEN öffentlichen Quelle (Content-Negotiation
   *  ohne URL-/Signaturänderung, ggf. sichere `.jpg`-URL-Variante). Fehlt er, bleibt
   *  ein nicht-dekodierbares Format ehrlich `unsupportedImageFormatForCanvas`. Wird nur
   *  im Tile-Modus für nicht canvas-kompatible Formate aufgerufen. */
  fetchCanvasRendition?: (url: string) => Promise<Uint8Array>;
  imageLimit?: number;
  /** Modellname für die Diagnose, falls VOR der ersten Analyse abgebrochen wird. */
  modelName?: string;
  /** Anzahl der Prospekt-Bildseiten (Kopf der Zählkette; nur Diagnose). */
  prospectPageCount?: number;
  options?: LidlVisionExtractOptions;
  // ── Tiling (opt-in; Default off ⇒ Full-Page wie bisher) ─────────────────────
  /** 'grid' ⇒ jede Seite wird (sofern dekodierbar) in überlappende Tiles zerlegt und
   *  Tile-weise analysiert. 'off' (Default) ⇒ bisheriges Full-Page-Verhalten. */
  tileMode?: 'off' | 'grid';
  /** Injizierbarer Tiler (Tests: synthetische Tiles; Connector: canvas). Pflicht für
   *  tileMode 'grid' — fehlt er, fällt der Lauf ehrlich auf Full-Page zurück. */
  tileImage?: LidlVisionImageTiler;
  tilePlanOptions?: VisionTilePlanOptions;
  /** Timeout je Tile (ms). Default {@link LIDL_VISION_DEFAULT_TILE_TIMEOUT_MS}. */
  tileTimeoutMs?: number;
  /** Subtile-Fallback: timeoutet ein Tile, wird es (sofern ein Tiler verfügbar ist) in
   *  kleinere Subtiles zerlegt, die einzeln versucht werden — gedacht für den diagnostic-
   *  Lauf, strikt budgetiert ({@link subtileLimit}). Default false. */
  subtileFallback?: boolean;
  /** Globales Budget erzeugter Subtiles über den ganzen Lauf (Default {@link LIDL_VISION_DEFAULT_SUBTILE_LIMIT}). */
  subtileLimit?: number;
  /** OPTIONALER Tile-Preview-Sink (nur DEBUG, gated): erhält je Tile die Bytes +
   *  Geometrie. Wird NIE im Snapshot gespeichert. */
  recordTilePreview?: (preview: {
    imageUrl: string;
    imageUrlTail: string;
    tile: VisionTileImage;
  }) => void;
  /** DEBUG-EVIDENCE-Sink (config-gesteuert über LIDL_VISION_DEBUG_EVIDENCE). */
  recordPageEvidence?: (evidence: LidlVisionPageEvidence) => void;
  debugEvidenceLimit?: number;
  debugEvidencePath?: string;
}

export interface RunLidlVisionImportResult {
  extract: LidlVisionExtractResult;
  diagnostic: SubSourceDiagnostic;
  /** Nur im Live-Modus befüllt — die freigegebenen sicheren Kandidaten. */
  emittedOffers: RawOfferCandidate[];
  counters: LidlVisionCounters;
  failures: LidlVisionFailures;
  /** EINE klare Hauptursache des Laufs (nie leer). */
  primaryReason: string;
  /** Ehrliche Coverage-Stufe — nie `full`. */
  coverage: LidlVisionCoverage;
  debug?: { evidencePath?: string; pagesRecorded: number };
}

function urlTail(url: string): string {
  const clean = url.split(/[?#]/)[0];
  const segments = clean.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? clean;
}

function stableUrlHash(url: string): string {
  let hash = 0;
  for (let index = 0; index < url.length; index += 1) {
    hash = (hash << 5) - hash + url.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function summarizeVisionRejections(rejections: VisionRejectionCounts): string {
  return (Object.keys(rejections) as VisionRejectReason[])
    .map((reason) => `${reason} ${rejections[reason]}`)
    .join(', ');
}

function summarizeVisionQualityRejections(rejections: VisionQualityRejectionCounts): string {
  return (Object.keys(rejections) as VisionQualityRejectReason[])
    .map((reason) => `${reason} ${rejections[reason]}`)
    .join(', ');
}

function summarizeVisionFailures(failures: LidlVisionFailures): string {
  return (
    `fetchFailed ${failures.fetchFailed}, notAnImage ${failures.notAnImage}, ` +
    `modelUnavailable ${failures.modelUnavailable}, parseError ${failures.parseError}, ` +
    `analyzeError ${failures.analyzeError}, tileRenderFailed ${failures.tileRenderFailed} ` +
    `(unsupportedImageFormatForCanvas ${failures.unsupportedImageFormatForCanvas}, ` +
    `alternativeRenditionFailed ${failures.alternativeRenditionFailed}, ` +
    `canvasDecodeFailed ${failures.canvasDecodeFailed})`
  );
}

function dominantVisionRejection(rejections: VisionRejectionCounts): string | null {
  const ranked = (Object.keys(rejections) as VisionRejectReason[])
    .map((reason) => [reason, rejections[reason]] as const)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])[0];
  return ranked ? `${ranked[0]} (${ranked[1]})` : null;
}

function determineVisionPrimaryReason(args: {
  collectedImageUrls: number;
  fetchAttempted: number;
  fetchSucceeded: number;
  imageDecoded: number;
  imageAnalyzed: number;
  failures: LidlVisionFailures;
  extract: LidlVisionExtractResult;
  emitted: number;
  mode: 'diagnostic' | 'live';
  tileMode: 'off' | 'grid';
  tilesGenerated: number;
  tilesAnalyzed: number;
  tileAnalyzeErrors: number;
}): string {
  const {
    collectedImageUrls, fetchAttempted, fetchSucceeded, imageDecoded, imageAnalyzed,
    failures, extract, emitted, mode, tileMode, tilesGenerated, tilesAnalyzed, tileAnalyzeErrors,
  } = args;
  if (collectedImageUrls === 0) {
    return 'keine ladbaren Prospekt-Bild-URLs aus den Prospektseiten extrahiert';
  }
  if (fetchAttempted === 0) {
    return 'imageLimit 0 — keine Bildseite versucht';
  }
  if (failures.modelUnavailable > 0 && imageAnalyzed === 0) {
    return 'Vision-Modell nicht verfügbar (Host/Modell nicht erreichbar oder LIDL_VISION_MODEL nicht gesetzt)';
  }
  if (fetchSucceeded === 0) {
    return `alle ${fetchAttempted} Bildabrufe fehlgeschlagen (fetchFailed ${failures.fetchFailed})`;
  }
  if (imageDecoded === 0) {
    return `abgerufene Antworten waren keine dekodierbaren Bilder (${failures.notAnImage} Nicht-Bild)`;
  }
  // Tile-spezifische Ursachen VOR dem generischen „keine Seite analysiert".
  if (tileMode === 'grid') {
    if (tilesGenerated === 0) {
      const parts: string[] = [];
      if (failures.unsupportedImageFormatForCanvas > 0) {
        parts.push(`unsupportedImageFormatForCanvas ${failures.unsupportedImageFormatForCanvas}`);
      }
      if (failures.alternativeRenditionFailed > 0) {
        parts.push(`alternativeRenditionFailed ${failures.alternativeRenditionFailed}`);
      }
      if (failures.canvasDecodeFailed > 0) {
        parts.push(`canvasDecodeFailed ${failures.canvasDecodeFailed}`);
      }
      const detail = parts.length > 0 ? parts.join(', ') : `tileRenderFailed ${failures.tileRenderFailed}`;
      return `kein Prospektbild in canvas-kompatible Tiles zerlegbar (${detail})`;
    }
    if (tilesAnalyzed === 0) {
      return `${tilesGenerated} Tiles erzeugt, aber 0 analysiert (tileAnalyzeErrors ${tileAnalyzeErrors}, parseError ${failures.parseError})`;
    }
  }
  if (imageAnalyzed === 0) {
    return `keine Bildseite analysiert (parseError ${failures.parseError}, analyzeError ${failures.analyzeError})`;
  }
  if (extract.rawCandidates === 0) {
    return tileMode === 'grid'
      ? `${tilesAnalyzed} Tile(s) analysiert, aber 0 Vision-Kandidaten geliefert`
      : `${imageAnalyzed} Bild(er) analysiert, aber 0 Vision-Kandidaten geliefert`;
  }
  if (extract.safeCandidates === 0) {
    const dominant = dominantVisionRejection(extract.rejections);
    return `alle ${extract.rawCandidates} Roh-Kandidaten verworfen${dominant ? ` — überwiegend ${dominant}` : ''}`;
  }
  return mode === 'live'
    ? `${extract.safeCandidates} sichere Kandidat(en), ${emitted} live freigegeben`
    : `${extract.safeCandidates} sichere Kandidat(en) (Modus diagnostic → nicht live)`;
}

/** Render-/Renditions-Status einer Tile-Seite (Diagnose; auch bei Failure). */
export type VisionCanvasRenderStatus =
  /** Original-Bytes waren bereits canvas-kompatibel (jpeg/png). */
  | 'compatible'
  /** Eine canvas-kompatible Alternativ-Rendition (JPEG/PNG) wurde geladen. */
  | 'alternativeRenditionSucceeded'
  /** Eine Alternative wurde versucht, lieferte aber kein canvas-kompatibles Bild. */
  | 'alternativeRenditionFailed'
  /** Original nicht canvas-kompatibel UND keine Alternative ableitbar/verfügbar. */
  | 'unsupportedImageFormatForCanvas'
  /** Das (kompatible) Bild ließ sich von canvas doch nicht dekodieren (loadImage warf). */
  | 'canvasDecodeFailed';

interface AnalyzedVisionPage {
  imageUrl: string;
  imageFormat: string;
  imageByteLength: number;
  rawResponse?: string;
  candidates: VisionProspectCandidate[];
  tiles?: LidlVisionTileEvidence[];
  /** Render-/Renditions-Diagnose dieser Seite (gesetzt im Tile-Modus). */
  render?: VisionPageRenderInfo;
}

/** Render-/Renditions-Diagnose EINER Tile-Seite (kompakt, keine Bilddaten). */
interface VisionPageRenderInfo {
  status: VisionCanvasRenderStatus;
  originalImageFormat: string | null;
  canvasImageFormat?: string;
  magicBytes: string;
  renditionUrlTail?: string;
  renditionUrlHash?: string;
  renderErrorName?: string;
  renderErrorMessage?: string;
  tilePlanAttempted: boolean;
}

// ---------------------------------------------------------------------------
// Canvas-Renditions-Auflösung: node-canvas dekodiert KEIN WebP/AVIF, die Lidl-
// imgproxy-Standardrendition liefert aber genau das (Accept-Aushandlung des Bild-
// Fetchs). Ohne diesen Schritt scheitert JEDER Tile-Render an einer WebP/AVIF-Seite
// (der belegte Live-Befund: tilesGenerated 0, tileRenderFailed = Seitenanzahl).
// Lösung: für nicht canvas-kompatible Formate eine JPEG/PNG-Rendition DERSELBEN
// öffentlichen Quelle laden (Content-Negotiation ohne URL-/Signaturänderung; optional
// eine sichere `.jpg`-URL-Variante für unsignierte URLs). Signierte imgproxy-URLs
// werden NICHT geraten (Endungs-/Größenänderung würde die Signatur brechen).
// ---------------------------------------------------------------------------

/** Canvas-dekodierbare Container-Formate (node-canvas: nur jpeg/png zuverlässig). */
export function isCanvasCompatibleFormat(format: string | null): format is 'jpeg' | 'png' {
  return format === 'jpeg' || format === 'png';
}

/** Hex-Dump der ersten `count` Magic-Bytes (Diagnose; keine Bilddaten). */
function magicBytesHex(bytes: Uint8Array, count = 12): string {
  return Array.from(bytes.subarray(0, count), (b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** Sieht eine URL nach einer SIGNIERTEN imgproxy-URL aus (langes base64url-Signatur-
 *  Segment als erstes Pfadsegment, NICHT `insecure`)? Bei signierten URLs würde eine
 *  Endungs-/Größenänderung die Signatur ungültig machen → wir raten dann NICHT. */
function looksLikeSignedImgproxyUrl(url: string): boolean {
  let host: string;
  let pathname: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    pathname = parsed.pathname;
  } catch {
    return false;
  }
  if (!/imgproxy/i.test(host)) {
    return false;
  }
  const first = pathname.split('/').filter(Boolean)[0] ?? '';
  if (first.toLowerCase() === 'insecure') {
    return false; // explizit unsigniert
  }
  // base64url-Signatur: lang genug und ausschließlich [A-Za-z0-9_-].
  return /^[A-Za-z0-9_-]{16,}$/.test(first);
}

/**
 * Leitet — NUR wenn sicher (kein Raten an signierten imgproxy-URLs) — eine canvas-
 * kompatible JPEG-Renditions-URL aus einer WebP/AVIF/HEIF-Bild-URL ab, indem die
 * Bildendung im Pfad auf `.jpg` gesetzt wird. Gibt null zurück, wenn keine sichere
 * Variante ableitbar ist (signierte URL oder keine erkennbare Bildendung) — dann bleibt
 * nur die (signaturneutrale) Content-Negotiation auf der Original-URL.
 */
export function deriveCanvasCompatibleImageUrl(url: string): string | null {
  if (looksLikeSignedImgproxyUrl(url)) {
    return null;
  }
  const hashIndex = url.indexOf('#');
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const beforeHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = beforeHash.indexOf('?');
  const query = queryIndex >= 0 ? beforeHash.slice(queryIndex) : '';
  const path = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;
  const swapped = path.replace(/\.(webp|avif|heic|heif|jxl)$/i, '.jpg');
  if (swapped === path) {
    return null;
  }
  return `${swapped}${query}${hash}`;
}

export interface CanvasCompatibleImageResult {
  status: VisionCanvasRenderStatus;
  /** Canvas-kompatible Bytes (nur bei compatible/alternativeRenditionSucceeded). */
  bytes?: Uint8Array;
  /** Format der gelieferten canvas-kompatiblen Bytes ('jpeg' | 'png'). */
  canvasImageFormat?: 'jpeg' | 'png';
  /** Ursprünglich geladenes Format (oder null = nicht erkannt). */
  originalImageFormat: string | null;
  /** Hex der ersten Magic-Bytes (Diagnose). */
  magicBytes: string;
  /** Ob überhaupt eine Alternativ-Rendition versucht wurde. */
  alternativeTried: boolean;
  /** Versuchte/erfolgreiche Alternativ-Rendition-URL (falls versucht). */
  renditionUrl?: string;
  renditionUrlTail?: string;
  renditionUrlHash?: string;
  /** Kurzer Grund bei Fehlschlag. */
  reason?: string;
}

/**
 * Stellt sicher, dass der Tiler canvas-dekodierbare Bytes bekommt: gibt jpeg/png
 * unverändert durch; lädt für WebP/AVIF/… (sofern ein Rendition-Fetch verfügbar ist)
 * eine JPEG/PNG-Rendition derselben öffentlichen Quelle (Content-Negotiation auf der
 * Original-URL — signaturneutral — und optional eine sichere `.jpg`-URL-Variante).
 * Schlägt das fehl oder fehlt der Fetch, wird das ehrlich als
 * `unsupportedImageFormatForCanvas`/`alternativeRenditionFailed` gemeldet (kein Raten).
 * Keine private API, kein Hotspot, kein Login — nur dieselbe öffentliche Bildquelle.
 */
export async function resolveCanvasCompatibleImage(args: {
  imageUrl: string;
  bytes: Uint8Array;
  format: string | null;
  fetchRendition?: (url: string) => Promise<Uint8Array>;
}): Promise<CanvasCompatibleImageResult> {
  const { imageUrl, bytes, format } = args;
  const originalImageFormat = format;
  const magicBytes = magicBytesHex(bytes);

  if (isCanvasCompatibleFormat(format)) {
    return {
      status: 'compatible',
      bytes,
      canvasImageFormat: format,
      originalImageFormat,
      magicBytes,
      alternativeTried: false,
    };
  }

  if (!args.fetchRendition) {
    return {
      status: 'unsupportedImageFormatForCanvas',
      originalImageFormat,
      magicBytes,
      alternativeTried: false,
      reason: `canvas dekodiert "${format ?? 'unbekannt'}" nicht und kein Rendition-Fetch verfügbar`,
    };
  }

  // Kandidaten-Renditions in Sicherheitsreihenfolge:
  //  1) Original-URL erneut laden — die JPEG-bevorzugende Accept-Aushandlung im
  //     injizierten fetchRendition ändert die URL/Signatur NICHT (immer sicher).
  //  2) eine sicher abgeleitete `.jpg`-URL-Variante (nur bei unsignierten URLs).
  const candidateUrls = [imageUrl];
  const derived = deriveCanvasCompatibleImageUrl(imageUrl);
  if (derived && derived !== imageUrl) {
    candidateUrls.push(derived);
  }

  let lastUrl = imageUrl;
  let lastReason = `keine canvas-kompatible Rendition unter ${candidateUrls.length} URL-Variante(n)`;
  for (const candidateUrl of candidateUrls) {
    lastUrl = candidateUrl;
    let renditionBytes: Uint8Array;
    try {
      renditionBytes = await args.fetchRendition(candidateUrl);
    } catch (error) {
      lastReason = `Rendition-Fetch fehlgeschlagen: ${error instanceof Error ? error.message : 'unbekannt'}`;
      continue;
    }
    const renditionFormat = detectImageFormat(renditionBytes);
    if (isCanvasCompatibleFormat(renditionFormat)) {
      return {
        status: 'alternativeRenditionSucceeded',
        bytes: renditionBytes,
        canvasImageFormat: renditionFormat,
        originalImageFormat,
        magicBytes,
        alternativeTried: true,
        renditionUrl: candidateUrl,
        renditionUrlTail: urlTail(candidateUrl),
        renditionUrlHash: stableUrlHash(candidateUrl),
      };
    }
    lastReason = `Rendition lieferte "${renditionFormat ?? 'kein Bild'}" (nicht canvas-kompatibel)`;
  }

  return {
    status: 'alternativeRenditionFailed',
    originalImageFormat,
    magicBytes,
    alternativeTried: true,
    renditionUrl: lastUrl,
    renditionUrlTail: urlTail(lastUrl),
    renditionUrlHash: stableUrlHash(lastUrl),
    reason: lastReason,
  };
}

/** Verschiebt eine tile-lokale bbox in Seitenkoordinaten (Diagnose; best-effort). */
function offsetCandidateToPage(
  candidate: VisionProspectCandidate,
  tileBox: LayoutBox,
): VisionProspectCandidate {
  if (!candidate.bbox) {
    return candidate;
  }
  return {
    ...candidate,
    bbox: {
      x: candidate.bbox.x + tileBox.x,
      y: candidate.bbox.y + tileBox.y,
      w: candidate.bbox.w,
      h: candidate.bbox.h,
    },
  };
}

export async function runLidlVisionProspectImport(
  input: RunLidlVisionImportInput,
): Promise<RunLidlVisionImportResult> {
  const limit = Math.max(0, input.imageLimit ?? LIDL_VISION_DEFAULT_IMAGE_LIMIT);
  const urls = input.imageUrls.slice(0, limit);
  const failures = emptyVisionFailures();
  const analyzedPages: AnalyzedVisionPage[] = [];
  // Tiling nur, wenn explizit verlangt UND ein Tiler injiziert ist — sonst ehrlich
  // Full-Page (unverändertes Default-Verhalten; bestehende Aufrufer/Tests bleiben gleich).
  const tileMode: 'off' | 'grid' = input.tileMode === 'grid' && input.tileImage ? 'grid' : 'off';
  const tileImage = input.tileImage;
  const tileTimeoutMs = Math.max(1, input.tileTimeoutMs ?? LIDL_VISION_DEFAULT_TILE_TIMEOUT_MS);
  const subtileFallback = input.subtileFallback === true && Boolean(tileImage);
  let subtileBudget = Math.max(0, input.subtileLimit ?? LIDL_VISION_DEFAULT_SUBTILE_LIMIT);
  let fetchAttempted = 0;
  let fetchSucceeded = 0;
  let imageDecoded = 0;
  let imageAnalyzedCount = 0;
  let tilesGenerated = 0;
  let tilesAnalyzed = 0;
  let tileAnalyzeErrors = 0;
  let tileTimeouts = 0;
  let tileHttpErrors = 0;
  let tileParseErrors = 0;
  let tileEmptyResponses = 0;
  let subtilesGenerated = 0;
  let subtilesAnalyzed = 0;
  let tileRenditionsTried = 0;
  let tileRenditionsSucceeded = 0;
  let modelName = input.modelName ?? '';

  // Analysiert EIN (Sub-)Tile mit eigenem Timeout (Runner besitzt den Timer, Abbruch via
  // Signal) und dem KURZEN Tile-Prompt. Klassifiziert den Fehler nach Ursache. Wirft NICHT;
  // gibt { analysis|null, error, durationMs } zurück. modelUnavailable wird hochgereicht
  // (Host/Modell ganz weg ⇒ weitere Tiles bringen nichts).
  const analyzeTileWithTimeout = async (
    tileBytes: Uint8Array,
    tileFormat: string,
    url: string,
  ): Promise<{
    analysis: VisionImageAnalysis | null;
    error?: VisionTileErrorKind;
    modelUnavailable?: boolean;
    durationMs: number;
  }> => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, tileTimeoutMs);
    const startedAt = Date.now();
    try {
      const analysis = await input.analyzeImage(
        { bytes: tileBytes, imageUrl: url, format: tileFormat },
        adapterContext(url, tileFormat),
        {
          signal: controller.signal,
          promptHint: LIDL_VISION_TILE_PROMPT_HINT,
          prompt: LIDL_VISION_TILE_PROMPT,
        },
      );
      return { analysis, durationMs: Date.now() - startedAt };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (timedOut) {
        return { analysis: null, error: 'timeout', durationMs };
      }
      if (isVisionModelUnavailable(error)) {
        return { analysis: null, modelUnavailable: true, durationMs };
      }
      if (isVisionEmptyResponseError(error)) {
        return { analysis: null, error: 'emptyResponse', durationMs };
      }
      if (isVisionResponseParseError(error)) {
        return { analysis: null, error: 'parseError', durationMs };
      }
      if (isVisionHttpError(error)) {
        return { analysis: null, error: 'httpError', durationMs };
      }
      return { analysis: null, error: 'analyzeError', durationMs };
    } finally {
      clearTimeout(timer);
    }
  };

  // Bucht einen Tile-Fehler in die getrennten Zähler (Umbrella + Ursache).
  const countTileError = (kind: VisionTileErrorKind): void => {
    tileAnalyzeErrors += 1;
    if (kind === 'timeout') {
      tileTimeouts += 1;
    } else if (kind === 'httpError') {
      tileHttpErrors += 1;
    } else if (kind === 'parseError') {
      tileParseErrors += 1;
      failures.parseError += 1;
    } else if (kind === 'emptyResponse') {
      tileEmptyResponses += 1;
    }
  };

  const adapterContext = (url: string, format: string): VisionAnalysisContext => ({
    storeChain: input.context.storeChain,
    sourceUrl: input.context.sourceUrl,
    imageUrl: url,
    imageFormat: format,
    validityStart: input.context.validityStart,
    validityEnd: input.context.validityEnd,
  });

  for (const url of urls) {
    fetchAttempted += 1;
    let bytes: Uint8Array;
    try {
      bytes = await input.fetchBinary(url);
    } catch {
      failures.fetchFailed += 1;
      continue;
    }
    fetchSucceeded += 1;

    const format = detectImageFormat(bytes);
    if (format === null) {
      failures.notAnImage += 1;
      continue;
    }
    imageDecoded += 1;

    if (tileMode === 'grid' && tileImage) {
      // ── Tile-Pfad: Seite in überlappende Ausschnitte zerlegen, je Tile analysieren ──
      // Zuerst eine canvas-kompatible Rendition sicherstellen: node-canvas dekodiert kein
      // WebP/AVIF (die Lidl-imgproxy-Standardrendition) — ohne diesen Schritt schlägt jeder
      // Tile-Render fehl. Für nicht-kompatible Formate wird eine JPEG/PNG-Rendition
      // derselben öffentlichen Quelle geladen (signaturneutral) oder ehrlich verworfen.
      const resolved = await resolveCanvasCompatibleImage({
        imageUrl: url,
        bytes,
        format,
        fetchRendition: input.fetchCanvasRendition,
      });
      if (resolved.alternativeTried) {
        tileRenditionsTried += 1;
      }
      if (resolved.status === 'alternativeRenditionSucceeded') {
        tileRenditionsSucceeded += 1;
      }
      // Keine canvas-kompatible Rendition → Tile-Plan NICHT ausführen, aber ehrlich zählen
      // UND Debug-Evidence schreiben (Seite mit Render-Failure aufnehmen, damit der
      // Debug-Ordner auch im Fehlerfall mit der echten Ursache entsteht).
      if (resolved.status === 'unsupportedImageFormatForCanvas') {
        failures.tileRenderFailed += 1;
        failures.unsupportedImageFormatForCanvas += 1;
        analyzedPages.push({
          imageUrl: url,
          imageFormat: format,
          imageByteLength: bytes.length,
          candidates: [],
          render: {
            status: resolved.status,
            originalImageFormat: resolved.originalImageFormat,
            magicBytes: resolved.magicBytes,
            renderErrorName: 'VisionTileRenderError',
            renderErrorMessage: resolved.reason,
            tilePlanAttempted: false,
          },
        });
        continue;
      }
      if (resolved.status === 'alternativeRenditionFailed') {
        failures.tileRenderFailed += 1;
        failures.alternativeRenditionFailed += 1;
        analyzedPages.push({
          imageUrl: url,
          imageFormat: format,
          imageByteLength: bytes.length,
          candidates: [],
          render: {
            status: resolved.status,
            originalImageFormat: resolved.originalImageFormat,
            magicBytes: resolved.magicBytes,
            renditionUrlTail: resolved.renditionUrlTail,
            renditionUrlHash: resolved.renditionUrlHash,
            renderErrorName: 'VisionTileRenderError',
            renderErrorMessage: resolved.reason,
            tilePlanAttempted: false,
          },
        });
        continue;
      }

      const canvasBytes = resolved.bytes ?? bytes;
      const canvasFormat = resolved.canvasImageFormat ?? format;
      let tiles: VisionTileImage[];
      try {
        tiles = await tileImage(
          { bytes: canvasBytes, imageUrl: url, format: canvasFormat },
          input.tilePlanOptions ?? {},
        );
      } catch (error) {
        if (isVisionModelUnavailable(error)) {
          failures.modelUnavailable += 1;
          break;
        }
        // Das (kompatible) Bild ließ sich von canvas doch nicht dekodieren (loadImage warf).
        failures.tileRenderFailed += 1;
        failures.canvasDecodeFailed += 1;
        analyzedPages.push({
          imageUrl: url,
          imageFormat: format,
          imageByteLength: bytes.length,
          candidates: [],
          render: {
            status: 'canvasDecodeFailed',
            originalImageFormat: resolved.originalImageFormat,
            canvasImageFormat: canvasFormat,
            magicBytes: resolved.magicBytes,
            renditionUrlTail: resolved.renditionUrlTail,
            renditionUrlHash: resolved.renditionUrlHash,
            renderErrorName: error instanceof Error ? error.name : 'Error',
            renderErrorMessage: error instanceof Error ? error.message : String(error),
            tilePlanAttempted: true,
          },
        });
        continue;
      }
      tilesGenerated += tiles.length;

      const pageCandidates: VisionProspectCandidate[] = [];
      const tileEvidences: LidlVisionTileEvidence[] = [];
      let pageHadAnalysis = false;
      let abortRun = false;

      for (const tile of tiles) {
        if (input.recordTilePreview) {
          try {
            input.recordTilePreview({ imageUrl: url, imageUrlTail: urlTail(url), tile });
          } catch {
            /* Debug darf den Scan nie brechen. */
          }
        }
        const outcome = await analyzeTileWithTimeout(tile.bytes, tile.format, url);
        if (outcome.modelUnavailable) {
          // Host/Modell wirklich weg → weitere Tiles/Seiten bringen nichts.
          failures.modelUnavailable += 1;
          abortRun = true;
          tileEvidences.push({
            index: tile.index,
            column: tile.column,
            row: tile.row,
            box: tile.box,
            byteLength: tile.bytes.length,
            durationMs: outcome.durationMs,
            candidateCount: 0,
            error: 'analyzeError',
          });
          break;
        }
        const analysis = outcome.analysis;

        if (analysis) {
          tilesAnalyzed += 1;
          pageHadAnalysis = true;
          if (analysis.modelName) {
            modelName = analysis.modelName;
          }
          const offsetCandidates = (analysis.candidates ?? []).map((candidate) =>
            offsetCandidateToPage(candidate, tile.box),
          );
          pageCandidates.push(...offsetCandidates);
          tileEvidences.push({
            index: tile.index,
            column: tile.column,
            row: tile.row,
            box: tile.box,
            byteLength: tile.bytes.length,
            durationMs: outcome.durationMs,
            candidateCount: offsetCandidates.length,
            candidates: offsetCandidates,
            rawResponse: analysis.rawResponse ? analysis.rawResponse.slice(0, 2000) : undefined,
          });
          continue;
        }

        // Tile fehlgeschlagen → nach Ursache zählen.
        const tileError = outcome.error ?? 'analyzeError';
        countTileError(tileError);
        const tileEvidence: LidlVisionTileEvidence = {
          index: tile.index,
          column: tile.column,
          row: tile.row,
          box: tile.box,
          byteLength: tile.bytes.length,
          durationMs: outcome.durationMs,
          candidateCount: 0,
          error: tileError,
        };

        // Subtile-Fallback NUR nach Timeout (das große Tile war zu schwer): das Tile in
        // kleinere Subtiles zerlegen und einzeln versuchen, strikt budgetiert. Re-Tiler =
        // derselbe Tiler auf den Tile-Bytes (jpeg/png) mit erzwungenem 2×2-Raster.
        if (subtileFallback && tileImage && tileError === 'timeout' && subtileBudget > 0) {
          let subtiles: VisionTileImage[] = [];
          try {
            subtiles = await tileImage(
              { bytes: tile.bytes, imageUrl: url, format: tile.format },
              { columns: 2, rows: 2, limit: Math.min(subtileBudget, 4), overlap: 0 },
            );
          } catch {
            subtiles = [];
          }
          subtiles = subtiles.slice(0, subtileBudget);
          let subAnalyzed = 0;
          for (const subtile of subtiles) {
            subtileBudget -= 1;
            subtilesGenerated += 1;
            const subOutcome = await analyzeTileWithTimeout(subtile.bytes, subtile.format, url);
            if (subOutcome.modelUnavailable) {
              failures.modelUnavailable += 1;
              abortRun = true;
              break;
            }
            if (subOutcome.analysis) {
              subtilesAnalyzed += 1;
              subAnalyzed += 1;
              pageHadAnalysis = true;
              if (subOutcome.analysis.modelName) {
                modelName = subOutcome.analysis.modelName;
              }
              // Subtile-bbox erst im Tile, dann auf der Seite versetzen.
              const combinedBox: LayoutBox = {
                x: tile.box.x + subtile.box.x,
                y: tile.box.y + subtile.box.y,
                w: subtile.box.w,
                h: subtile.box.h,
              };
              const offsetCandidates = (subOutcome.analysis.candidates ?? []).map((candidate) =>
                offsetCandidateToPage(candidate, combinedBox),
              );
              pageCandidates.push(...offsetCandidates);
            } else {
              countTileError(subOutcome.error ?? 'analyzeError');
            }
            if (subtileBudget <= 0) {
              break;
            }
          }
          tileEvidence.subtilesGenerated = subtiles.length;
          tileEvidence.subtilesAnalyzed = subAnalyzed;
        }

        tileEvidences.push(tileEvidence);
        if (abortRun) {
          break;
        }
      }

      if (pageHadAnalysis) {
        imageAnalyzedCount += 1;
      }
      // Seite IMMER aufnehmen, sobald Tiles erzeugt wurden (Extract + Debug-Evidence;
      // die Kandidaten können leer sein, wenn alle Tiles fehlschlugen).
      analyzedPages.push({
        imageUrl: url,
        imageFormat: format,
        imageByteLength: bytes.length,
        candidates: pageCandidates,
        tiles: tileEvidences,
        render: {
          status: resolved.status,
          originalImageFormat: resolved.originalImageFormat,
          canvasImageFormat: canvasFormat,
          magicBytes: resolved.magicBytes,
          renditionUrlTail: resolved.renditionUrlTail,
          renditionUrlHash: resolved.renditionUrlHash,
          tilePlanAttempted: true,
        },
      });
      if (abortRun) {
        break;
      }
      continue;
    }

    // ── Full-Page-Pfad (unverändertes Default-Verhalten) ──
    let analysis: VisionImageAnalysis;
    try {
      analysis = await input.analyzeImage({ bytes, imageUrl: url, format }, adapterContext(url, format));
    } catch (error) {
      if (isVisionModelUnavailable(error)) {
        // Runtime/Modell weg → weitere Seiten bringen nichts; ehrlich abbrechen.
        failures.modelUnavailable += 1;
        break;
      }
      if (isVisionResponseParseError(error) || isVisionEmptyResponseError(error)) {
        // Kaputte/leere Modellantwort blockiert NICHT den Scan — Diagnose-Fehler, weiter.
        failures.parseError += 1;
        continue;
      }
      // HTTP-Fehler (Runtime lebt) wie sonstige Analysefehler behandeln — nicht fatal.
      failures.analyzeError += 1;
      continue;
    }
    if (analysis.modelName) {
      modelName = analysis.modelName;
    }
    imageAnalyzedCount += 1;
    analyzedPages.push({
      imageUrl: url,
      imageFormat: format,
      imageByteLength: bytes.length,
      rawResponse: analysis.rawResponse,
      candidates: analysis.candidates ?? [],
    });
  }

  const pages: VisionPageAnalysis[] = analyzedPages.map((page) => ({
    imageUrl: page.imageUrl,
    candidates: page.candidates,
  }));
  const extract = extractLidlVisionOffers(pages, input.context, input.options);
  const emittedOffers = input.mode === 'live' ? extract.offers : [];

  // Debug-Evidence je analysierter Seite (anzahlbegrenzt) — KEINE Bilddaten.
  let debugPagesRecorded = 0;
  if (input.recordPageEvidence) {
    const debugLimit = Math.max(0, input.debugEvidenceLimit ?? LIDL_VISION_DEFAULT_IMAGE_LIMIT);
    for (const page of analyzedPages) {
      if (debugPagesRecorded >= debugLimit) {
        break;
      }
      try {
        input.recordPageEvidence({
          capturedAt: new Date().toISOString(),
          storeChain: input.context.storeChain,
          sourceId: input.context.sourceId,
          mode: input.mode,
          modelName: modelName || '(unavailable)',
          tileMode,
          imageUrlTail: urlTail(page.imageUrl),
          imageUrlHash: stableUrlHash(page.imageUrl),
          imageFormat: page.imageFormat,
          imageByteLength: page.imageByteLength,
          // Render-/Rendition-Diagnose (auch bei Render-Failure gesetzt).
          renderStatus: page.render?.status,
          originalImageFormat: page.render?.originalImageFormat,
          canvasImageFormat: page.render?.canvasImageFormat,
          magicBytes: page.render?.magicBytes,
          renditionUrlTail: page.render?.renditionUrlTail,
          renditionUrlHash: page.render?.renditionUrlHash,
          renderErrorName: page.render?.renderErrorName,
          renderErrorMessage: page.render?.renderErrorMessage,
          tilePlanAttempted: page.render?.tilePlanAttempted,
          rawResponse: page.rawResponse ? page.rawResponse.slice(0, 8000) : undefined,
          candidates: [...page.candidates],
          decisions: extract.decisions.filter((decision) => decision.imageUrl === page.imageUrl),
          tiles: page.tiles,
        });
        debugPagesRecorded += 1;
      } catch {
        /* Debug darf den Scan nie brechen. */
      }
    }
  }

  const coverage: LidlVisionCoverage =
    input.mode === 'live' && emittedOffers.length > 0 ? 'partial_with_vision' : 'vision_diagnostic';

  const counters: LidlVisionCounters = {
    imageAttempted: fetchAttempted,
    imageAnalyzed: imageAnalyzedCount,
    tilesGenerated,
    tilesAnalyzed,
    tileAnalyzeErrors,
    tileTimeouts,
    tileHttpErrors,
    tileParseErrors,
    tileEmptyResponses,
    subtilesGenerated,
    subtilesAnalyzed,
    tileRenditionsTried,
    tileRenditionsSucceeded,
    rawVisionCandidates: extract.rawCandidates,
    safeVisionCandidates: extract.safeCandidates,
    emittedOffers: emittedOffers.length,
    rejectedByReason: extract.rejections,
    modelQualityRejectedByReason: extract.qualityRejections,
    modelName: modelName || '(unavailable)',
    mode: input.mode,
    tileMode,
  };

  const primaryReason = determineVisionPrimaryReason({
    collectedImageUrls: input.imageUrls.length,
    fetchAttempted,
    fetchSucceeded,
    imageDecoded,
    imageAnalyzed: imageAnalyzedCount,
    failures,
    extract,
    emitted: emittedOffers.length,
    mode: input.mode,
    tileMode,
    tilesGenerated,
    tilesAnalyzed,
    tileAnalyzeErrors,
  });

  const subtileSegment =
    subtilesGenerated > 0
      ? `subtiles ${subtilesAnalyzed}/${subtilesGenerated} analysiert; `
      : '';
  const tileSegment =
    tileMode === 'grid'
      ? `Renditions ${tileRenditionsTried} versucht/${tileRenditionsSucceeded} erfolgreich → ` +
        `tilesGenerated ${tilesGenerated} → tilesAnalyzed ${tilesAnalyzed} ` +
        `(tileAnalyzeErrors ${tileAnalyzeErrors}: tileTimeout ${tileTimeouts}, ` +
        `tileHttpError ${tileHttpErrors}, tileParseError ${tileParseErrors}, ` +
        `tileEmptyResponse ${tileEmptyResponses}; ${subtileSegment}` +
        `tileRenderFailed ${failures.tileRenderFailed}: ` +
        `unsupportedImageFormatForCanvas ${failures.unsupportedImageFormatForCanvas}, ` +
        `alternativeRenditionFailed ${failures.alternativeRenditionFailed}, ` +
        `canvasDecodeFailed ${failures.canvasDecodeFailed}) → `
      : '';

  const note =
    `Vision ${input.mode} (Modell ${counters.modelName}, tileMode ${tileMode}) | Kette: ` +
    `${Math.max(0, input.prospectPageCount ?? 0)} Prospektseiten → ${input.imageUrls.length} Bild-URL(s) → ` +
    `${fetchAttempted} pagesAttempted (${fetchSucceeded} ok, ${failures.fetchFailed} fehlgeschlagen) → ` +
    `${imageDecoded} dekodierbare Bilder (${failures.notAnImage} kein Bild) → ` +
    tileSegment +
    `${counters.imageAnalyzed} Seite(n) analysiert → ${counters.rawVisionCandidates} rawVisionCandidates → ` +
    `${counters.safeVisionCandidates} safeVisionCandidates → ${counters.emittedOffers} emittedOffers. ` +
    `Ursache: ${primaryReason}. coverage ${coverage}; ` +
    `rejectedByReason: ${summarizeVisionRejections(extract.rejections)}; ` +
    `modelQualityRejectedByReason: ${summarizeVisionQualityRejections(extract.qualityRejections)}; ` +
    `${summarizeVisionFailures(failures)}.`;

  const diagnostic = buildSubSourceDiagnostic({
    storeChain: input.context.storeChain,
    sourceId: `${input.context.sourceId ?? input.context.storeChain.toLowerCase()}${LIDL_VISION_DIAGNOSTIC_SUFFIX}`,
    status: emittedOffers.length > 0 ? 'success' : 'empty',
    urlOrSlug: input.context.sourceId,
    rawCount: extract.rawCandidates,
    resultCount: emittedOffers.length,
    note,
  });

  return {
    extract,
    diagnostic,
    emittedOffers,
    counters,
    failures,
    primaryReason,
    coverage,
    debug: input.recordPageEvidence
      ? { evidencePath: input.debugEvidencePath, pagesRecorded: debugPagesRecorded }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Default-Vision-Adapter (lokales Ollama-Vision-Modell). Schichtsauber: nutzt nur
// `fetch` (keine backend/src-Importe). Tests injizieren stattdessen Fakes.
// ---------------------------------------------------------------------------

export interface LidlVisionAdapterConfig {
  /** Ollama-Host (z. B. http://localhost:11434). */
  host: string;
  /** Vision-Modell (z. B. „qwen2.5vl:7b"). Leer ⇒ modelUnavailable. */
  model: string;
  /** Gesamt-Timeout je Bildanalyse (ms). */
  timeoutMs?: number;
  /** Max. erzeugte Tokens je Antwort (Ollama `num_predict`). Klein halten (z. B. 384):
   *  ein Tile braucht nur ein kurzes JSON — das verkürzt die Generierungszeit deutlich. */
  numPredict?: number;
  /** Ollama `top_p` (Nucleus-Sampling). Niedrig ⇒ deterministischere/kürzere Antwort. */
  topP?: number;
  fetchImpl?: typeof fetch;
}

/** Default-Obergrenze erzeugter Tokens je Vision-Antwort (Ollama `num_predict`). */
export const LIDL_VISION_DEFAULT_NUM_PREDICT = 384;

/** Strenger Extraktions-Prompt: NUR JSON, nur eindeutige Produktkarten, Aktionspreis
 *  (kein Grundpreis/Pfand/Datum), kein Badge als Name, Unsicherheit ⇒ rejectReason
 *  oder niedrige confidence. KEINE Produkt-/Marken-Allowlist, keine KW-Logik. */
const VISION_PROMPT = [
  'Du extrahierst Angebote von EINER deutschen Supermarkt-Prospektseite (Bild).',
  'Antworte AUSSCHLIESSLICH mit JSON, kein Fließtext, keine Erklärung.',
  'Schema: {"candidates":[{"name":string,"price":number,"unitText":string,',
  '"basePriceText":string,"validityText":string,"confidence":number,',
  '"rejectReason":string,"evidenceText":string}]}.',
  'SPRACHE (zwingend):',
  '- Gib ALLE Texte WORTWÖRTLICH auf DEUTSCH zurück, genau wie im Bild gedruckt.',
  '- ÜBERSETZE NICHTS ins Englische. Erfinde keine englischen Produktnamen.',
  '- Wenn du den deutschen Text nicht sicher lesen kannst: rejectReason="unsure".',
  'NAME:',
  '- name = der VOLLSTÄNDIGE Produktname, wie auf der Karte (Marke + Produktbezeichnung).',
  '- NICHT nur die Marke allein (z. B. nicht nur "Lidl", "Fairtrade") und KEIN Badge/Attribut',
  '  ("3 Stück", "kernarm", "Aktion", "%", "neu").',
  'PREIS:',
  '- price = AKTIONSPREIS in Euro als Zahl (z. B. 1.49). NICHT Grundpreis, NICHT Pfand, NICHT Datum.',
  '- Grundpreis gehört NUR in basePriceText (z. B. "1 kg = 2,98 €").',
  '- unitText = NUR die Packungs-/Mengenangabe (z. B. "500 g", "je 1 kg"). NIEMALS ein € im unitText.',
  'GÜLTIGKEIT/DATUM:',
  '- validityText NUR setzen, wenn ein Datum/Zeitraum EINDEUTIG im Bild lesbar ist.',
  '- Rate NIEMALS ein Datum und erfinde KEINE Jahreszahl. Unsicher ⇒ validityText="".',
  'EINDEUTIGKEIT:',
  '- Nimm einen Kandidaten NUR auf, wenn Name UND Aktionspreis EINDEUTIG in DERSELBEN',
  '  Angebotskarte sichtbar zusammengehören.',
  '- confidence 0..1: wie sicher die Karte eindeutig lesbar ist; im Zweifel niedrig.',
  '- Ist die Karte nicht eindeutig: rejectReason="unsure" ODER confidence niedrig.',
  '- evidenceText = der TATSÄCHLICH sichtbare deutsche Kartentext (kurz), inkl. Name und Preis. Erfinde nichts.',
].join('\n');

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  // btoa ist sowohl im DOM als auch in Node (>=16) global verfügbar.
  return btoa(binary);
}

function coerceNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value.replace(',', '.').replace(/[^\d.]/g, ''));
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function coerceString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Parst die (bereits als finaler Text vorliegende) Modellantwort in Kandidaten.
 *  Akzeptiert ein Top-Level-Array, `{candidates:[…]}` oder `{offers:[…]}`. Wirft
 *  {@link VisionResponseParseError}, wenn gar kein JSON erkennbar ist. */
export function parseVisionResponse(content: string): VisionProspectCandidate[] {
  const trimmed = content.trim();
  // Tolerantes Extrahieren des ersten JSON-Objekts/Arrays (Modelle umrahmen JSON
  // gern mit ```json … ``` oder Prosa).
  const start = trimmed.search(/[[{]/);
  if (start < 0) {
    throw new VisionResponseParseError('keine JSON-Struktur in der Modellantwort gefunden');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start));
  } catch {
    // Letzter Versuch: bis zur letzten schließenden Klammer schneiden.
    const end = Math.max(trimmed.lastIndexOf(']'), trimmed.lastIndexOf('}'));
    if (end <= start) {
      throw new VisionResponseParseError('Modellantwort war kein gültiges JSON');
    }
    try {
      parsed = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      throw new VisionResponseParseError('Modellantwort war kein gültiges JSON');
    }
  }
  const rawList: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { candidates?: unknown }).candidates)
      ? ((parsed as { candidates: unknown[] }).candidates)
      : Array.isArray((parsed as { offers?: unknown }).offers)
        ? ((parsed as { offers: unknown[] }).offers)
        : [];
  const candidates: VisionProspectCandidate[] = [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = coerceString(record.name) ?? '';
    const price = coerceNumber(record.price);
    const confidence = coerceNumber(record.confidence);
    candidates.push({
      name,
      price: Number.isFinite(price) ? price : NaN,
      unitText: coerceString(record.unitText),
      basePriceText: coerceString(record.basePriceText),
      validityText: coerceString(record.validityText),
      confidence: Number.isFinite(confidence) ? confidence : 0,
      rejectReason: coerceString(record.rejectReason),
      evidenceText: coerceString(record.evidenceText),
    });
  }
  return candidates;
}

/**
 * Der reale Vision-Adapter: analysiert EIN Prospektbild mit einem lokalen Ollama-
 * Vision-Modell. Wirft {@link VisionModelUnavailableError}, wenn kein Modell
 * konfiguriert oder der Host/das Modell nicht verfügbar ist, und
 * {@link VisionResponseParseError} bei einer nicht parsebaren Antwort.
 */
export async function analyzeLidlProspectImageWithVision(
  image: { bytes: Uint8Array; imageUrl: string; format: string },
  _context: VisionAnalysisContext,
  config: LidlVisionAdapterConfig,
  options?: VisionAnalyzeOptions,
): Promise<VisionImageAnalysis> {
  const model = config.model.trim();
  if (model.length === 0) {
    throw new VisionModelUnavailableError(
      'LIDL_VISION_MODEL ist nicht gesetzt — kein lokales Vision-Modell konfiguriert.',
    );
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const host = config.host.trim().replace(/\/+$/, '');
  const timeoutMs = config.timeoutMs ?? 120000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Externes Abbruch-Signal (Tile-Timeout des Runners) mit dem internen Timer
  // verschmelzen — so bricht ein Tile-Timeout den HTTP-Request wirklich ab.
  const externalSignal = options?.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }
  // Prompt-Wahl: ein expliziter Override (Tile-Modus ⇒ KURZER LIDL_VISION_TILE_PROMPT)
  // gewinnt; sonst der Basis-Prompt (+ optionalem promptHint, rückwärtskompatibel).
  const prompt = options?.prompt
    ? options.prompt
    : options?.promptHint
      ? `${VISION_PROMPT}\n${options.promptHint}`
      : VISION_PROMPT;
  // Modell-Optionen begrenzen: temperature 0 (deterministisch), num_predict klein (kurzes
  // JSON statt langer Generierung — der Haupthebel gegen den Tile-Timeout), top_p optional.
  const modelOptions: Record<string, number> = {
    temperature: 0,
    num_predict: Math.max(1, Math.round(config.numPredict ?? LIDL_VISION_DEFAULT_NUM_PREDICT)),
  };
  if (typeof config.topP === 'number' && Number.isFinite(config.topP)) {
    modelOptions.top_p = config.topP;
  }
  let response: Response;
  try {
    response = await fetchImpl(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        format: 'json',
        keep_alive: '10m',
        options: modelOptions,
        messages: [
          { role: 'user', content: prompt, images: [bytesToBase64(image.bytes)] },
        ],
      }),
    });
  } catch {
    // Netz/Timeout/Abort → Modell-/Runtime nicht verfügbar (ehrlich abbrechen).
    throw new VisionModelUnavailableError(
      `Vision-Modell „${model}" unter ${host} nicht erreichbar (Timeout/Verbindungsabbruch).`,
    );
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
  if (response.status === 404) {
    throw new VisionModelUnavailableError(
      `Vision-Modell „${model}" ist unter ${host} nicht installiert (HTTP 404).`,
    );
  }
  if (!response.ok) {
    // Ollama meldet ein NICHT visionfähiges Modell typischerweise mit 400 + einer Meldung
    // über fehlende Bild-/Multimodal-Unterstützung. Das ist ein Konfigurationsfehler des
    // Modells (kein vorübergehender Call-Fehler) → ehrlich als modelUnavailable melden,
    // damit ein falsch gesetztes LIDL_VISION_MODEL nicht als „HTTP-Fehler" verschleiert wird.
    const errorText = await response.text().catch(() => '');
    if (response.status === 400 && /image|vision|multimodal|does not support/i.test(errorText)) {
      throw new VisionModelUnavailableError(
        `Modell „${model}" ist nicht visionfähig (Ollama HTTP 400: ${errorText.slice(0, 200)}).`,
      );
    }
    // Sonst: Runtime lebt, aber dieser Aufruf scheiterte (z. B. 500) → nicht-fatal.
    throw new VisionHttpError(`Ollama-Vision antwortete mit HTTP ${response.status}.`);
  }
  const payload = (await response.json().catch(() => null)) as
    | { message?: { content?: unknown }; response?: unknown }
    | null;
  const contentRaw = payload?.message?.content;
  const content =
    typeof contentRaw === 'string' && contentRaw.trim().length > 0
      ? contentRaw
      : typeof payload?.response === 'string'
        ? payload.response
        : '';
  if (content.trim().length === 0) {
    throw new VisionEmptyResponseError('leere Modellantwort (weder message.content noch response).');
  }
  const candidates = parseVisionResponse(content);
  return { candidates, modelName: model, rawResponse: content };
}

/** Factory: bindet die {@link LidlVisionAdapterConfig} an den Adapter, sodass der
 *  Connector ihn als {@link AnalyzeLidlProspectImage} durchreichen kann. Reicht das
 *  optionale {@link VisionAnalyzeOptions} (Tile-Signal/Prompt-Hint) durch. */
export function createDefaultLidlVisionAdapter(config: LidlVisionAdapterConfig): AnalyzeLidlProspectImage {
  return (image, context, options) => analyzeLidlProspectImageWithVision(image, context, config, options);
}

// ---------------------------------------------------------------------------
// Realer canvas-basierter Tiler (NICHT unit-getestet; die pure Geometrie darüber —
// planVisionTiles — ist getestet, und in Tests wird ein Fake-Tiler injiziert). canvas
// wird — wie im OCR-Pfad — lazy über ein schmales Interface geladen (src-Schicht ohne
// Node-Typen). node-canvas dekodiert KEIN WebP/AVIF; dafür liefert die Lidl-imgproxy
// auch JPEG-Renditionen, mit denen canvas zuverlässig umgehen kann.
// ---------------------------------------------------------------------------

interface VisionCanvasImage {
  width: number;
  height: number;
}
interface VisionCanvasContext {
  fillStyle: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(
    image: VisionCanvasImage,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
}
interface VisionCanvas {
  getContext(kind: '2d'): VisionCanvasContext;
  toBuffer(mime: 'image/png'): Uint8Array;
  toBuffer(mime: 'image/jpeg', config?: { quality?: number }): Uint8Array;
}
interface VisionCanvasModule {
  createCanvas(width: number, height: number): VisionCanvas;
  loadImage(src: Uint8Array): Promise<VisionCanvasImage>;
}

let visionCanvasModulePromise: Promise<VisionCanvasModule> | null = null;
function loadVisionCanvasModule(): Promise<VisionCanvasModule> {
  return (visionCanvasModulePromise ??= import('canvas') as unknown as Promise<VisionCanvasModule>);
}

export interface LidlVisionTilerConfig {
  /** Ausgabeformat der Tile-Bytes ('jpeg' | 'png'). Default 'jpeg' (kompakt, robust). */
  outputFormat?: 'jpeg' | 'png';
  /** JPEG-Qualität 0..1 (Default 0.85). */
  jpegQuality?: number;
}

/**
 * Der reale Tiler: dekodiert EIN Prospektbild (JPEG/PNG) per node-canvas und
 * schneidet die von {@link planVisionTiles} berechneten überlappenden Regionen zu
 * eigenständigen JPEG/PNG-Tile-Bytes. Wirft {@link VisionTileRenderError}, wenn das
 * Format nicht (canvas-)dekodierbar ist (WebP/AVIF) — der Runner zählt das ehrlich
 * als `tileRenderFailed` und macht mit der nächsten Seite weiter.
 */
export function createDefaultLidlVisionImageTiler(
  config: LidlVisionTilerConfig = {},
): LidlVisionImageTiler {
  const outputFormat = config.outputFormat === 'png' ? 'png' : 'jpeg';
  const jpegQuality = Math.min(Math.max(config.jpegQuality ?? 0.85, 0.1), 1);
  return async (image, options) => {
    if (image.format !== 'jpeg' && image.format !== 'png') {
      throw new VisionTileRenderError(
        `canvas kann Format "${image.format}" nicht dekodieren (nur jpeg/png) — JPEG-Prospektrendition anfordern.`,
      );
    }
    const canvasMod = await loadVisionCanvasModule();
    const nodeBuffer = (globalThis as { Buffer?: { from(b: Uint8Array): Uint8Array } }).Buffer;
    let decoded: VisionCanvasImage;
    try {
      decoded = await canvasMod.loadImage(nodeBuffer ? nodeBuffer.from(image.bytes) : image.bytes);
    } catch (error) {
      throw new VisionTileRenderError(
        `canvas konnte das Prospektbild nicht dekodieren: ${
          error instanceof Error ? error.message : 'unbekannt'
        }`,
      );
    }
    const plan = planVisionTiles(decoded.width, decoded.height, options);
    const tiles: VisionTileImage[] = [];
    for (const tile of plan) {
      const canvas = canvasMod.createCanvas(tile.box.w, tile.box.h);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, tile.box.w, tile.box.h);
      ctx.drawImage(decoded, tile.box.x, tile.box.y, tile.box.w, tile.box.h, 0, 0, tile.box.w, tile.box.h);
      const bytes =
        outputFormat === 'png'
          ? canvas.toBuffer('image/png')
          : canvas.toBuffer('image/jpeg', { quality: jpegQuality });
      tiles.push({ ...tile, bytes, format: outputFormat });
    }
    return tiles;
  };
}

// ---------------------------------------------------------------------------
// Debug-Evidence-Writer (git-ignoriert: backend/data/debug/lidl-vision/<run-id>/).
// Best-effort: Schreibfehler/keine Node-Runtime brechen den Scan NIE. KEINE Bilddaten.
// ---------------------------------------------------------------------------

export interface VisionNodeFsLike {
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  // `data` darf binär sein (Tile-Preview-PNG/JPEG) oder Text (Evidence-JSON).
  writeFile(path: string, data: string | Uint8Array, encoding?: string): Promise<unknown>;
}

async function loadNodeFsPromises(): Promise<VisionNodeFsLike | null> {
  try {
    const spec = ['node', 'fs/promises'].join(':');
    const mod = (await import(/* @vite-ignore */ spec)) as { default?: VisionNodeFsLike } & VisionNodeFsLike;
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

export interface LidlVisionEvidenceWriter {
  recordPageEvidence: (evidence: LidlVisionPageEvidence) => void;
  /** OPTIONALER Tile-Preview-Sink: schreibt die Tile-Bytes als Bild (nur DEBUG; nur
   *  wenn ein previewLimit > 0 gesetzt ist). Best-effort, bounded, nie fatal. */
  recordTilePreview: (preview: { imageUrlTail: string; tile: VisionTileImage }) => void;
  flush: () => Promise<void>;
  evidenceDir: string;
  pagesRecorded: () => number;
}

export function createLidlVisionEvidenceWriter(args: {
  runId: string;
  limit: number;
  /** Obergrenze geschriebener Tile-Preview-Bilder (Default 0 = aus). */
  previewLimit?: number;
  baseDir?: string;
  fs?: VisionNodeFsLike | null;
  loadFs?: () => Promise<VisionNodeFsLike | null>;
}): LidlVisionEvidenceWriter {
  const baseDir = args.baseDir ?? 'backend/data/debug/lidl-vision';
  const evidenceDir = `${baseDir}/${args.runId}`;
  const limit = Math.max(0, args.limit);
  const previewLimit = Math.max(0, args.previewLimit ?? 0);
  const pending: Promise<void>[] = [];
  let recorded = 0;
  let previewsRecorded = 0;
  let ensureDirPromise: Promise<VisionNodeFsLike | null> | null = null;

  const ensureDir = (): Promise<VisionNodeFsLike | null> => {
    if (!ensureDirPromise) {
      ensureDirPromise = (async () => {
        const fs = args.fs !== undefined ? args.fs : await (args.loadFs ?? loadNodeFsPromises)();
        if (fs) {
          try {
            await fs.mkdir(evidenceDir, { recursive: true });
          } catch {
            /* Debug darf den Scan nie brechen. */
          }
        }
        return fs;
      })();
    }
    return ensureDirPromise;
  };

  return {
    recordPageEvidence: (evidence) => {
      if (recorded >= limit) {
        return;
      }
      const index = recorded;
      recorded += 1;
      pending.push(
        (async () => {
          const fs = await ensureDir();
          if (!fs) {
            return;
          }
          const file = `${evidenceDir}/page-${String(index + 1).padStart(3, '0')}.json`;
          try {
            await fs.writeFile(file, JSON.stringify(evidence, null, 2), 'utf8');
          } catch {
            /* Debug darf den Scan nie brechen. */
          }
        })(),
      );
    },
    recordTilePreview: ({ imageUrlTail, tile }) => {
      if (previewsRecorded >= previewLimit) {
        return;
      }
      previewsRecorded += 1;
      const safeTail = imageUrlTail.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'page';
      const ext = tile.format === 'png' ? 'png' : 'jpg';
      const file = `${evidenceDir}/tile-${safeTail}-r${tile.row}-c${tile.column}-${String(
        tile.index,
      ).padStart(2, '0')}.${ext}`;
      pending.push(
        (async () => {
          const fs = await ensureDir();
          if (!fs) {
            return;
          }
          try {
            await fs.writeFile(file, tile.bytes);
          } catch {
            /* Debug darf den Scan nie brechen. */
          }
        })(),
      );
    },
    flush: async () => {
      await Promise.all(pending);
    },
    evidenceDir,
    pagesRecorded: () => recorded,
  };
}
