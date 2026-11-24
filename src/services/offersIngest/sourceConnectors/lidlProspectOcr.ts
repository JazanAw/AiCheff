// Generischer Lidl-Prospektbild-OCR-Pfad.
//
// Hintergrund (Root Cause): Der strukturierte Lidl-Flyer-Endpoint liefert nur
// `flyer.products` (überwiegend Online/Wein/Non-Food). Die Frische-/Lebensmittel-
// angebote des Wochenprospekts existieren ausschließlich als Prospekt-BILDSEITEN
// (`flyer.pages`). Dieses Modul liest den OCR-TEXT solcher Seiten und extrahiert
// generisch Kandidaten (Produktname + Angebotspreis) — OHNE KW-spezifische
// Produkt-/Marken-Allowlist und OHNE hardcodierte Wochenangebote.
//
// Sicherheit ist eingebaut, nicht optional:
//   • nur Kandidaten mit klar erkennbarem Namen + plausiblem Preis,
//   • Fragment-/Störertexte werden verworfen,
//   • Dedupe gegen die strukturierten Lidl-Angebote UND innerhalb des OCR,
//   • Food-/Non-Food-Gate über eine INJIZIERTE zentrale Logik (kein neuer Allowlist),
//   • Gültigkeit wird aus dem Flyer ABGELEITET (Kontext), nie geraten,
//   • jede Verwerfung wird gezählt: noName, noPrice, lowConfidence, duplicate,
//     nonFood, parseError.
//
// `extractLidlProspectOcrOffers` ist pure (kein IO) und damit trivial testbar.
// `runLidlProspectOcr` ist die dünne, injizierbare Glue (Bild laden → OCR →
// extrahieren → strukturierte Diagnose), die der Connector hinter dem
// LIDL_OCR_MODE-Schalter aufruft. canvas/tesseract.js werden lazy geladen.

import { toSimpleOfferCategory } from '../../../utils/offerCategory';
import { normalizeText } from '../../../utils/offers';
import type { RawOfferCandidate } from '../types';
import {
  buildSubSourceDiagnostic,
  type SubSourceDiagnostic,
} from '../subSourceDiagnostics';

// Dieses Modul liegt in der shared `src`-Schicht (tsconfig.app: DOM-Libs, KEINE
// Node-Typen → kein `Buffer`). Die Bildbytes laufen deshalb als `Uint8Array`;
// tesseract.js wird lazy + über ein schmales Interface geladen, damit weder
// dessen Typen noch `canvas`/`Buffer` in dieser Schicht aufgelöst werden müssen.
// Die canvas/tesseract-RUNTIME existiert ohnehin schon (localMarketConnector).
interface MinimalOcrWord {
  text: string;
  /** tesseract liefert je Wort eine Bounding-Box in Bildpixeln. */
  bbox: { x0: number; y0: number; x1: number; y1: number };
  /** 0–100; nur diagnostisch verwendet. */
  confidence?: number;
}
// tesseract.js v7 legt die Wortdaten NICHT mehr top-level unter `data.words`, sondern
// (nur wenn als Output-Option angefordert) in der `data.blocks`-Hierarchie:
//   blocks[] → paragraphs[] → lines[] → words[]
// Diese schmalen Knoten-Typen bilden genau diesen Pfad ab (kein tesseract.js-Typ-
// Import in der shared src-Schicht).
interface MinimalOcrLine {
  words?: MinimalOcrWord[];
}
interface MinimalOcrParagraph {
  lines?: MinimalOcrLine[];
}
interface MinimalOcrBlock {
  paragraphs?: MinimalOcrParagraph[];
}
/** Die für uns relevanten Felder von `RecognizeResult.data`. In v7 sind
 *  `blocks`/`tsv` NUR gesetzt, wenn sie als Output-Option angefordert wurden;
 *  ältere Versionen/Mocks liefern stattdessen top-level `words`. Alle strukturierten
 *  Felder daher optional + defensiv ausgewertet. */
interface MinimalRecognizeData {
  text?: string;
  words?: MinimalOcrWord[];
  blocks?: MinimalOcrBlock[] | null;
  tsv?: string;
}
/** Output-Schalter (3. Argument von `worker.recognize` in tesseract.js v7) — schaltet
 *  die strukturierten Ausgaben gezielt frei (v7-Default liefert NUR `text`). */
interface MinimalRecognizeOutput {
  text?: boolean;
  blocks?: boolean;
  tsv?: boolean;
}
interface MinimalOcrWorker {
  // 2. Arg = recognize-Optionen (rectangle/PSM …; hier leer), 3. Arg = Output-Schalter.
  // Beide optional, damit alte Mocks `recognize(image)` weiter erfüllen.
  recognize(
    image: Uint8Array,
    options?: Record<string, unknown>,
    output?: MinimalRecognizeOutput,
  ): Promise<{ data: MinimalRecognizeData }>;
  terminate(): Promise<unknown>;
}
interface MinimalTesseract {
  createWorker(lang: string): Promise<MinimalOcrWorker>;
}

/** Woher die Roh-Wortboxen eines OCR-Laufs kamen — macht den v7-Mapping-Pfad im
 *  Debug-Artefakt nachvollziehbar (blocks bevorzugt, dann Legacy top-level, dann TSV). */
export type LidlOcrWordBoxSource = 'blocks' | 'topLevelWords' | 'tsv' | 'none';

/** Ergebnis der robusten Wortbox-Extraktion aus einem tesseract.js-`data`-Objekt:
 *  die geflatteten Roh-Wörter PLUS die Struktur-Diagnose (welche Quelle, wie viele
 *  Wörter je Quelle). */
export interface LidlOcrWordExtraction {
  words: MinimalOcrWord[];
  wordBoxSource: LidlOcrWordBoxSource;
  blocksPresent: boolean;
  blockWordCount: number;
  tsvPresent: boolean;
  tsvWordCount: number;
}

let tesseractModulePromise: Promise<MinimalTesseract> | null = null;
function loadTesseractModule(): Promise<MinimalTesseract> {
  return (tesseractModulePromise ??= import('tesseract.js') as unknown as Promise<MinimalTesseract>);
}

/** Tag, das JEDES live geschaltete OCR-Angebot trägt — macht den Pfad im
 *  Snapshot/Report nachvollziehbar und erlaubt eine spätere Re-Bewertung. */
export const LIDL_OCR_OFFER_TAG = 'lidl-prospekt-ocr';

/** Suffix der OCR-Bilanz-Diagnosezeile (status empty/success → blockiert nie das
 *  Safety-Gate; rein diagnostisch). */
export const LIDL_OCR_DIAGNOSTIC_SUFFIX = ':prospektseiten:ocr';

/** Default-Obergrenze der je Prospekt per OCR gelesenen Bildseiten — begrenzt die
 *  Kosten (jede Seite ist ein Tesseract-Lauf) und die Netzwerklast. */
export const LIDL_OCR_DEFAULT_IMAGE_LIMIT = 8;

/**
 * Erkennt das Container-Format anhand der Magic-Bytes (Header-Signatur). Rein
 * strukturell — KEIN Produkt-/Markenwissen. Dient als ehrlicher DECODE-GATE:
 * eine vom CDN gelieferte HTML-/JSON-/Fehlerseite (häufig, wenn die Bild-URL-
 * Sammlung versehentlich eine Nicht-Bild-URL erwischt hat) ist KEIN dekodierbares
 * Bild und wird mit klarem Grund (`notAnImage`) gezählt, statt leeren OCR-Text als
 * stilles `raw=0` zu verschleiern. Unterstützt jpeg/png/gif/bmp/tiff/webp sowie
 * die ISO-BMFF-Bildcontainer avif/heif (Lidl-CDN liefert teils avif/webp).
 */
export function detectImageFormat(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (
    b.length >= 4 &&
    ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))
  ) {
    return 'tiff';
  }
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'webp';
  }
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]).toLowerCase();
    if (brand.startsWith('avi')) return 'avif';
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1)/.test(brand)) return 'heif';
    return 'isobmff';
  }
  return null;
}

/**
 * Signalisiert, dass die OCR-RUNTIME selbst nicht verfügbar ist (tesseract.js bzw.
 * der Worker konnte nicht geladen/erzeugt werden) — im Gegensatz zu einem normalen
 * OCR-Fehler auf EINEM Bild. Erlaubt eine ehrliche Diagnose
 * (`ocrRuntimeUnavailable`) statt eines stillen raw=0.
 */
export class OcrRuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrRuntimeUnavailableError';
  }
}

/** Cross-realm-sichere Erkennung (Worker/Bundles können eigene Klassen haben). */
function isOcrRuntimeUnavailable(error: unknown): boolean {
  return (
    error instanceof OcrRuntimeUnavailableError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'OcrRuntimeUnavailableError')
  );
}

export interface LidlOcrRejectionCounts {
  /** Preis erkannt, aber kein belastbarer Produktname davor. */
  noName: number;
  /** Kein plausibler Angebotspreis (z. B. 0,01 € oder > 99,99 €). */
  noPrice: number;
  /** Reiner Grundpreis (z. B. „1 kg = 4,99") — kein Angebotspreis. */
  basePrice: number;
  /** Pfand-/Leergut-only Zeile (z. B. „zzgl. 0,25 € Pfand") — kein Angebotspreis. */
  deposit: number;
  /** Name ist ein Fragment/Störer (kernarm, Promo-/Attributwort). */
  lowConfidence: number;
  /** OCR-Müllname: zu viele Einzelbuchstaben-/Fragment-Tokens, kein echtes Wort
   *  (z. B. „Fo g i m m"). Strukturell unbrauchbar → nie live. */
  nameQuality: number;
  /** Duplikat (struktureller Treffer oder bereits im OCR gesehen). */
  duplicate: number;
  /** Starkes strukturelles Non-Food-Signal (Gerät/Maschine/Werkzeug/Haushalt/
   *  Kleidung/Garten) ODER injizierte zentrale Non-Food-Logik. */
  nonFood: number;
  /** Starkes Non-Food-Signal, das eine (über ein irreführendes Präfix) als FOOD
   *  klassifizierte Kategorie trägt — z. B. „Eiswürfelmaschine" → „Snacks/Süßes".
   *  Die Kategorie widerspricht dem Non-Food-Beleg → nie live. */
  categoryConflict: number;
  /** Kein starker Food-Beleg (kein Food-Keyword im Namen, keine Food-Kategorie) —
   *  ohne positiven Food-Beleg geht ein OCR-Kandidat nie live. */
  missingStrongFoodEvidence: number;
  /** Eine Seite/Kandidat warf beim Parsen (defensiv gezählt, nie geworfen). */
  parseError: number;
}

export interface LidlProspectOcrResult {
  /** Sichere, deduplizierte Food/uncertain-Kandidaten (gehen NUR im Live-Modus
   *  durch den nachgelagerten zentralen Food-Gate live). */
  offers: RawOfferCandidate[];
  /** Anzahl per OCR gelesener (Text-tragender) Prospektseiten. */
  ocrCandidatePages: number;
  /** Anzahl versuchter OCR-Läufe (inkl. fehlgeschlagener Bildabrufe). */
  ocrAttempted: number;
  /** Gesamtzahl nicht-leerer OCR-Textzeilen über alle gelesenen Seiten (Zählketten-
   *  Schritt „raw OCR line/block count" — belegt, dass OCR-Text ankam, auch wenn
   *  daraus keine Kandidaten entstanden). */
  ocrTextLines: number;
  /** Roh extrahierte preisbehaftete Kandidaten VOR den Sicherheitsverwerfungen.
   *  Identisch mit `groupedCandidates` (Preis + Name erfolgreich gruppiert). */
  ocrParsedOffers: number;
  /** Zeilen mit erkanntem plausiblem ANGEBOTSpreis (ohne reine Grundpreise/Pfand).
   *  Trennt „kein Preis erkannt" von „Preis erkannt, aber nicht gruppierbar". */
  priceLinesFound: number;
  /** Zeilen, die strukturell wie ein Produktname aussehen (unabhängig von der
   *  Gruppierung). Trennt „keine Namen" von „keine Preise". */
  productNameBlocksFound: number;
  /** Preis + Name erfolgreich zu einem Roh-Kandidaten gruppiert (== ocrParsedOffers). */
  groupedCandidates: number;
  rejections: LidlOcrRejectionCounts;
}

export interface LidlProspectOcrPage {
  text: string;
  imageUrl?: string;
}

export interface LidlProspectOcrContext {
  storeChain: string;
  sourceUrl: string;
  /** Stabile Prospekt-/Subquellen-Id, an die die OCR-Angebote gebunden werden. */
  sourceId?: string;
  /** Aus dem Flyer abgeleitetes Gültigkeitsfenster (NICHT geraten). */
  validityStart?: string;
  validityEnd?: string;
  /** Normalisierte Namen der bereits strukturiert importierten Lidl-Angebote
   *  (Dedupe-Ziel) — kein neues Wissen, nur die vorhandenen Treffer. */
  existingNameKeys?: Iterable<string>;
}

export interface LidlProspectOcrOptions {
  /** ZUSÄTZLICHE Non-Food-Entscheidung (vom Connector injiziert: nutzt die
   *  bestehende `isLidlLeafletNonFoodCategory`/Kategorie-Logik). Kein neuer
   *  Allowlist. Wird mit dem eingebauten strukturellen Non-Food-Signal (Geräte/
   *  Werkzeug/Haushalt/Kleidung/Garten) als ODER kombiniert — beide blocken. */
  classifyNonFood?: (candidate: { name: string; category?: string }) => boolean;
  /** Fragment-/Störer-Erkennung. Default: konservativer generischer Check. */
  isFragment?: (name: string) => boolean;
  /** OCR-Müllnamen-Erkennung (zu viele Einzelbuchstaben/Fragmenttokens, kein
   *  echtes Wort). Default: {@link isOcrNameQualityReject}. */
  isNameQualityReject?: (name: string) => boolean;
  /** STARKER Food-Beleg (Pflicht für Live-Emission). Vom Connector injizierbar,
   *  um die zentrale Food-Logik (`classifyFoodDecision`==confirmed_food) als
   *  zusätzlichen Beleg einzuspeisen. Wird mit dem eingebauten strukturellen
   *  Food-Beleg (Food-Keyword im Namen / Food-Kategorie) als ODER kombiniert.
   *  Default: nur der eingebaute strukturelle Beleg. */
  hasStrongFoodEvidence?: (candidate: { name: string; category: string }) => boolean;
}

// ---------------------------------------------------------------------------
// Layout-/Vision-Datenmodell (Task: layout-aware Prospektkarten-Extractor).
//
// Statt nur OCR-TEXTZEILEN auszuwerten, kann der Pfad pro Bild eine optionale
// LAYOUTANALYSE bekommen: Wörter MIT Bounding-Box (Position + Schriftgröße) und
// — falls der Vision-/OCR-Layer es liefert — ein Promo-Hintergrund-Tag (rote/gelbe
// Aktionsbox). Daraus werden Produktkarten (räumliche Cluster), Preisflächen
// (prominente/auffällige Preise) und der räumlich nächste Namensblock abgeleitet.
// Bewusst KEINE perfekte CV, sondern robuste strukturelle Heuristik. Es werden
// KEINE Bilddaten gespeichert — nur kompakte Regionskoordinaten zur Diagnose.
// ---------------------------------------------------------------------------

/** Herkunft eines OCR-Kandidaten — macht die Quelle im Snapshot/Report sichtbar. */
export type OcrCandidateSourceKind = 'text_line' | 'layout_card' | 'vision_card' | 'price_crop';

/** Achsenparallele Region in Bildpixeln (kompakt, keine Bilddaten). */
export interface LayoutBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Ein OCR-Wort mit Position/Schriftgröße (h) und optionalem Promo-Farb-Tag. Der
 *  Farb-Tag ist NUR ein positives Gewicht (rote/gelbe Aktionspreisfläche) und
 *  optional — die Heuristik funktioniert auch ohne Farbe über die Schriftgröße. */
export interface OcrLayoutWord {
  text: string;
  bbox: LayoutBox;
  confidence?: number;
  colorTag?: 'action_red' | 'action_yellow';
}

/** Eine layout-analysierte Prospektseite: Wörter mit Boxen + Bildmaße. */
export interface OcrLayoutPage {
  imageUrl?: string;
  width: number;
  height: number;
  words: readonly OcrLayoutWord[];
  /** DIAGNOSE (optional): Roh-Wortboxen, die der OCR-Layer VOR der Normalisierung
   *  lieferte. Erlaubt es der Zählkette, `noWordBoxesFromOcr` (Tesseract gab keine
   *  Boxen) von `wordBoxesDroppedDuringNormalization` (Boxen kamen, fielen aber bei
   *  der Koordinaten-/Textnormalisierung weg) zu unterscheiden. Nur vom realen
   *  Default-Pair gesetzt; injizierte Test-Seiten lassen es offen (Fallback:
   *  `words.length`). */
  sourceWordCount?: number;
  // ── Struktur-Diagnose des OCR-Laufs (nur vom realen Default-Pair gesetzt) ──
  /** Wurde überhaupt strukturierte Ausgabe (blocks/tsv) angefordert? */
  structuredOutputRequested?: boolean;
  /** Quelle der Roh-Wortboxen (blocks bevorzugt → Legacy words → TSV). */
  wordBoxSource?: LidlOcrWordBoxSource;
  /** Lieferte das `data`-Objekt ein `blocks`-Array (auch leer)? */
  blocksPresent?: boolean;
  /** Anzahl aus `blocks` geflatteter Wörter. */
  blockWordCount?: number;
  /** Lieferte das `data`-Objekt einen nicht-leeren `tsv`-String? */
  tsvPresent?: boolean;
  /** Anzahl aus `tsv` geparster Wörter. */
  tsvWordCount?: number;
}

/** Verwerfungs-Zählkette der LAYOUT-Quelle (separat nach Quelle gehalten). Enthält
 *  die geteilten Sicherheits-Gründe (lowConfidence/nameQuality/…) PLUS die
 *  layout-spezifischen Vorstufen (keine Preisfläche / kein Name nahe Preis /
 *  nur Grundpreis / Layout-Konfidenz zu niedrig). */
export interface LidlOcrLayoutRejectionCounts {
  /** Karte ohne erkennbare (plausible) Angebots-Preisfläche. */
  noPriceRegion: number;
  /** Karte trug nur Grundpreis(e) (z. B. „1 kg = …") — kein Angebotspreis. */
  basePrice: number;
  /** Karte trug nur Pfand-/Leergut-Beträge. */
  deposit: number;
  /** Preisfläche erkannt, aber kein plausibler Namensblock räumlich nah. */
  noNameNearPrice: number;
  /** Karte/Kandidat unter der Layout-Konfidenzschwelle (z. B. mehrere
   *  gleichprominente Preise → mehrdeutig). */
  lowLayoutConfidence: number;
  /** Geteiltes Sicherheits-Gate (Fragment-/Störername). */
  lowConfidence: number;
  /** Geteiltes Gate: OCR-Müllname. */
  nameQuality: number;
  /** Geteiltes Gate: Duplikat (struktureller/OCR-/Quellen-übergreifender Treffer). */
  duplicate: number;
  /** Geteiltes Gate: strukturelles Non-Food-Signal. */
  nonFood: number;
  /** Geteiltes Gate: Non-Food-Beleg mit irreführend als Food klassifizierter Kategorie. */
  categoryConflict: number;
  /** Geteiltes Gate: kein starker Food-Beleg. */
  missingStrongFoodEvidence: number;
}

/** Feinursache EINER `noPriceRegion`-Karte. `noPriceRegion` allein verschleiert,
 *  WARUM keine Preisfläche entstand. Aus echter Lidl-Full-Scan-Evidence sind die
 *  Großpreis-Tiles OCR-verstümmelt (£08/£8/£4, conf<45) — es existieren gar keine
 *  preisförmigen Tokens, nur Gültigkeitsdaten/Rechts-/Adressnummern. Die Feinursache
 *  benennt das, statt einen blanken Zähler zu liefern. */
export type NoPriceRegionDetail =
  /** Keine ziffernhaltigen Tokens (oder nur Einheiten) — gar nichts Preisförmiges. */
  | 'noPriceLikeWords'
  /** Ziffern vorhanden, aber ausschließlich Gültigkeitsdaten/Rechts-/Adressnummern
   *  (15.6., 74206, 25/2026) — kein Angebotspreis recoverbar. */
  | 'onlyDateOrLegal'
  /** Euro- und Cent-Token räumlich benachbart, aber NICHT in EINER Zeile gruppiert
   *  (Großpreis-Optik mit auseinanderliegendem Euro/Cent) → Gruppierung griff nicht. */
  | 'splitPriceNotCombined';

export interface NoPriceRegionDetailCounts {
  noPriceLikeWords: number;
  onlyDateOrLegal: number;
  splitPriceNotCombined: number;
}

function emptyNoPriceRegionDetail(): NoPriceRegionDetailCounts {
  return { noPriceLikeWords: 0, onlyDateOrLegal: 0, splitPriceNotCombined: 0 };
}

export interface LidlLayoutOcrResult {
  /** Sichere, deduplizierte Layout-Kandidaten (sourceKind=layout_card). */
  offers: RawOfferCandidate[];
  /** Erkannte Produktkarten (räumliche Cluster) über alle Layout-Seiten. */
  layoutCardsDetected: number;
  /** Roh extrahierte Layout-Kandidaten (Karte → Name + Angebotspreis gruppiert)
   *  VOR den Sicherheitsverwerfungen. */
  layoutRawCandidates: number;
  /** Nach allen Verwerfungen verbleibende sichere Layout-Kandidaten. */
  layoutSafeCandidates: number;
  rejections: LidlOcrLayoutRejectionCounts;
  /** Feinaufschlüsselung des `noPriceRegion`-Zählers (dominante Ursache benennen). */
  noPriceRegionDetail: NoPriceRegionDetailCounts;
}

function emptyLayoutRejections(): LidlOcrLayoutRejectionCounts {
  return {
    noPriceRegion: 0,
    basePrice: 0,
    deposit: 0,
    noNameNearPrice: 0,
    lowLayoutConfidence: 0,
    lowConfidence: 0,
    nameQuality: 0,
    duplicate: 0,
    nonFood: 0,
    categoryConflict: 0,
    missingStrongFoodEvidence: 0,
  };
}

function emptyRejections(): LidlOcrRejectionCounts {
  return {
    noName: 0,
    noPrice: 0,
    basePrice: 0,
    deposit: 0,
    lowConfidence: 0,
    nameQuality: 0,
    duplicate: 0,
    nonFood: 0,
    categoryConflict: 0,
    missingStrongFoodEvidence: 0,
    parseError: 0,
  };
}

function cleanOcrLine(value: string): string {
  return value
    .replace(/­/g, '')
    .replace(/[|_]+/g, ' ')
    .replace(/[€]/g, ' EUR ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDateRangeLine(value: string): boolean {
  return /\d{1,2}\.\d{1,2}\.?\s*(?:bis|-|–)\s*\d{1,2}\.\d{1,2}/i.test(value);
}

/** Reine Seiten-/Header-/Footer-/Störertexte, die nie ein Produktname sind. */
function isIgnoredOcrLine(value: string): boolean {
  const normalized = normalizeText(value);
  return (
    normalized.length < 2 ||
    isDateRangeLine(value) ||
    /^(angebote?|prospekt|aktion|aktionen|seite|tel|telefon|fax|www|http|lidl|filiale|oeffnungszeiten|gueltig)$/.test(
      normalized,
    ) ||
    /^(nur|je|ab|kg|g|l|ml|cl|stk|stk\.|stueck|packung|becher|dose|flasche|beutel|netz|schale)$/.test(
      normalized,
    )
  );
}

interface PriceToken {
  price: number;
  index: number;
  raw: string;
  plausible: boolean;
}

// „Preis-Ziffer ODER OCR-Verwechsler": tesseract liest in der großen Lidl-Preis-
// Optik (fette €-Ziffer, hochgestellte Cents) Ziffern oft als Buchstaben — I/l→1,
// O/o→0. Die Verwechsler werden NUR innerhalb eines bereits preisförmigen Tokens
// (Ziffergruppe + Trenner + 2 Cents / Strich) zugelassen, nie in Namen: die
// `\w`-Wortgrenze davor verhindert, dass ein Buchstabe MITTEN in einem Wort
// („Cola", „Voll") als Preis fehlgelesen wird. Kein Produkt-/Markenwissen.
const PRICE_DIGIT = '[0-9IlOo]';
function ocrDigits(value: string): string {
  return value.replace(/[Il]/g, '1').replace(/[Oo]/g, '0');
}

// 1,99 / 1.99 / I,99 / l.99 / O,99 — Dezimaltrenner + 2 Cents.
const PRICE_DECIMAL = new RegExp(`(^|[^\\w])(${PRICE_DIGIT}{1,2})\\s*[,.]\\s*(${PRICE_DIGIT}{2})(?=$|[^\\w])`);
// 1,- / 1.- — ganzer Euro, Strich-Cents (= ,00).
const PRICE_DASH = new RegExp(`(^|[^\\w])(${PRICE_DIGIT}{1,2})\\s*[,.]\\s*[-–](?=$|[^\\w])`);
// 1 99 — große Preis-Optik mit Leerzeichen zwischen Euro und Cent auf EINER Zeile.
const PRICE_SPACE = new RegExp(`(^|[^\\w])(${PRICE_DIGIT}{1,2})\\s+(${PRICE_DIGIT}{2})(?=$|[^\\w])`);

/** Erkennt das ERSTE Preis-Token einer Zeile (1–2 € + 2 Cent, robust gegen OCR-
 *  Schreibweisen) und sagt, ob es plausibel ist. Ein Lebensmittel-Angebotspreis
 *  liegt zwischen 0,10 € und 99,99 €. Über mehrere Schreibweisen (Dezimaltrenner,
 *  Strich-Cents, Leerzeichen-getrennt) gewinnt das früheste Token; bei
 *  Index-Gleichstand die zuverlässigste Form (Dezimal vor Strich vor Leerzeichen),
 *  damit ein nachgestellter Grundpreis nie das echte Angebot verdrängt. */
function findPriceToken(value: string): PriceToken | null {
  const found: { index: number; euro: string; cent: string; prio: number }[] = [];
  const collect = (re: RegExp, prio: number, dashCents: boolean): void => {
    const match = value.match(re);
    if (!match || match.index === undefined) {
      return;
    }
    const lead = match[1] ?? '';
    found.push({
      index: match.index + lead.length,
      euro: match[2],
      cent: dashCents ? '00' : match[3],
      prio,
    });
  };
  collect(PRICE_DECIMAL, 0, false);
  collect(PRICE_DASH, 1, true);
  collect(PRICE_SPACE, 2, false);
  if (found.length === 0) {
    return null;
  }
  found.sort((a, b) => a.index - b.index || a.prio - b.prio);
  const token = found[0];
  const euro = ocrDigits(token.euro);
  const cent = ocrDigits(token.cent);
  const price = Number(`${euro}.${cent}`);
  if (!Number.isFinite(price)) {
    return null;
  }
  return {
    price: Number(price.toFixed(2)),
    index: token.index,
    raw: `${euro},${cent}`,
    plausible: price >= 0.1 && price <= 99,
  };
}

// Lone-Euro / Lone-Cent für die große Preis-Optik, bei der OCR Euro und Cent auf
// GETRENNTE Zeilen legt („Rispentomaten" / „1" / „99"). Konservativ: 1–2 Ziffern
// (Euro) bzw. genau 2 Ziffern (Cent), optional € / Strich, sonst nichts.
const LONE_EURO = new RegExp(`^(?:nur|ab|je|EUR)?\\s*(${PRICE_DIGIT}{1,2})\\s*(?:EUR)?\\s*[-–]?\\s*$`, 'i');
const LONE_CENT = new RegExp(`^(${PRICE_DIGIT}{2})\\s*(?:EUR)?\\s*$`, 'i');

/** Fügt eine getrennt auf zwei Zeilen stehende Euro/Cent-Preis-Optik zu EINER
 *  Preiszeile („1,99") zusammen, damit die nachgelagerte Gruppierung sie wie jeden
 *  anderen Preis behandeln kann. Greift NUR, wenn eine Lone-Euro-Zeile UNMITTELBAR
 *  von einer Lone-Cent-Zeile gefolgt wird — eine isolierte Zahl (Seitenzahl/Menge)
 *  ohne folgenden Cent bleibt unangetastet. Verändert die Eingabe nicht. */
function mergeSplitPriceLines(lines: readonly string[]): string[] {
  const merged: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];
    const next = lines[index + 1];
    const euroMatch = current.match(LONE_EURO);
    // Eine bereits vollständige Preiszeile (mit Trenner+Cent) NICHT als Lone-Euro
    // behandeln — sonst würde „1,99" fälschlich mit der Folgezeile verschmolzen.
    if (euroMatch && next !== undefined && !findPriceToken(current)) {
      const centMatch = next.match(LONE_CENT);
      if (centMatch && !findPriceToken(next)) {
        merged.push(`${ocrDigits(euroMatch[1])},${ocrDigits(centMatch[1])}`);
        index += 1;
        continue;
      }
    }
    merged.push(current);
  }
  return merged;
}

/** Ist das erkannte Preis-Token ein reiner GRUNDPREIS (kein Angebotspreis)? Wahr
 *  NUR, wenn unmittelbar vor dem Preis eine Grundpreis-Gleichung/-Marke steht
 *  („… 1 kg = 4,99", „Grundpreis: 4,99"). Eine Angebotszeile mit nachgestelltem
 *  Grundpreis in Klammern („Tomaten 1,49 (1 kg = 2,98)") trifft NICHT zu, weil
 *  findPriceToken den ERSTEN Preis (1,49) liefert — davor steht kein „=". */
function priceIsBasePrice(line: string, priceIndex: number): boolean {
  const before = line.slice(0, priceIndex);
  return /=\s*(?:ca\.?\s*)?$/.test(before) || /grundpreis/i.test(before);
}

/** Ist das erkannte Preis-Token ein reiner PFAND-/Leergut-Betrag? Wahr, wenn der
 *  Preis direkt auf „zzgl." folgt oder unmittelbar von „Pfand" gefolgt wird
 *  (Standalone-Pfandzeile). Eine Angebotszeile mit eigenem Preis und separatem
 *  Pfand-Token trifft nicht zu, weil findPriceToken nur den ersten Preis liefert. */
function priceIsDeposit(line: string, priceIndex: number): boolean {
  const before = line.slice(0, priceIndex);
  if (/\bzzgl\.?\s*$/i.test(before)) {
    return true;
  }
  const afterPrice = line
    .slice(priceIndex)
    .replace(/^\s*\d{1,2}\s*[,.]\s*\d{2}\s*/, '')
    .replace(/^\s*EUR\s*/i, '')
    .trim();
  return /^pfand\b/i.test(afterPrice);
}

function unitFromText(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, ' ');
  const match =
    normalized.match(/\b(?:je\s+)?(\d+(?:[,.]\d+)?\s*(?:kg|g|l|ml|cl))\b/i) ??
    normalized.match(/\b(?:je\s+)?(kg|g|l|ml|cl|stk|stueck|stück|dose|flasche|becher|packung|beutel|netz|schale)\b/i);
  if (!match) {
    return undefined;
  }
  return match[1].replace(/\s+/g, '').replace(',', '.').replace(/stück/i, 'Stk');
}

function cleanOfferName(value: string): string {
  return value
    .replace(/\d{1,2}\s*[,.]\s*\d{2}.*/g, '')
    .replace(/\b(?:je|nur|ab)\b/gi, ' ')
    .replace(/\b\d+(?:[,.]\d+)?\s*(?:kg|g|l|ml|cl)\b/gi, ' ')
    .replace(/\b(?:kg|g|l|ml|cl|stk|stueck|stück|dose|flasche|becher|packung|beutel|netz|schale)\b$/i, '')
    .replace(/[^\p{L}\p{N}&%+.\- ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Konservativer generischer Fragment-Check (Default). Verwirft NUR offensichtlich
 *  nicht-identifizierende Namen: zu kurz, ohne Buchstaben, oder ein isoliertes
 *  Promo-/Attribut-Wort. Mehrwortnamen ("Frische Hähnchenbrust") bleiben gültig. */
const GENERIC_FRAGMENT_TOKENS = new Set([
  'extra',
  'original',
  'neu',
  'aktion',
  'angebot',
  'tiefpreis',
  'frisch',
  'frische',
  'knaller',
  'kracher',
  'highlight',
  'sale',
  'rabatt',
  'sparpreis',
]);

function isGenericFragment(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 3 || !/\p{L}/u.test(trimmed)) {
    return true;
  }
  const normalized = normalizeText(trimmed);
  return !normalized.includes(' ') && GENERIC_FRAGMENT_TOKENS.has(normalized);
}

/** Generische Promo-/Rabatt-/App-Verbindungstexte, die in der Flyer-Optik zwischen
 *  Produktname und Preis stehen können („20% Rabatt", „mit App sparen"). Sie sind
 *  kein Produktname und dürfen einen Namensblock nicht anwachsen lassen — werden in
 *  der Namensfensterung ÜBERSPRUNGEN (nicht als Grenze gewertet). Bewusst eng
 *  gehalten (Retail-Promo-Vokabular, KEIN Produkt-/Markenwissen). */
const CONNECTIVE_NOISE_RE = /\b(rabatt|gratis|gutschein|coupon|sparen|sparst|aktionspreis|tiefpreis|dauertiefpreis)\b/i;
function isConnectiveNoise(line: string): boolean {
  return CONNECTIVE_NOISE_RE.test(line) || /\bapp\b/i.test(line);
}

/** Sammelt einen (ggf. mehrzeiligen) Produktnamen ab `start` in Richtung `step`,
 *  bis ein Preis/Datum/leere Zeile das Fenster begrenzt. Reine Stör-/Einheitszeilen
 *  werden übersprungen, nicht als Grenze gewertet. */
function collectNameBlock(lines: string[], start: number, step: -1 | 1): string[] {
  const block: string[] = [];
  for (let index = start; index >= 0 && index < lines.length; index += step) {
    if (Math.abs(index - start) > 6) {
      break;
    }
    const line = lines[index];
    if (findPriceToken(line) || isDateRangeLine(line)) {
      break;
    }
    // Stör-/Promo-/Slogan-Zeilen ÜBERSPRINGEN (nicht abbrechen) — der echte
    // Produktname kann eine Zeile weiter vom Preis weg stehen.
    if (isIgnoredOcrLine(line) || isConnectiveNoise(line)) {
      continue;
    }
    const cleaned = cleanOfferName(line);
    if (!cleaned || cleaned.length < 3 || unitFromText(cleaned) === cleaned) {
      continue;
    }
    if (step === -1) {
      block.unshift(cleaned);
    } else {
      block.push(cleaned);
    }
  }
  return block;
}

/** Findet den Produktnamen zu einem Preis. Reihenfolge nach abnehmender Sicherheit:
 *  (1) Präfix auf DERSELBEN Zeile vor dem Preis, (2) Namensblock OBERHALB (Name
 *  steht typischerweise über dem Preis), (3) Namensblock UNTERHALB (große
 *  Preis-Optik: Preis zuerst, Name darunter). Mehrzeilige Namen werden auf die zwei
 *  preis-nächsten Zeilen begrenzt, damit kein Nachbar-Slogan anwächst. */
function nameFromWindow(lines: string[], priceLineIndex: number, priceIndex: number): string | null {
  const sameLinePrefix = cleanOfferName(lines[priceLineIndex].slice(0, priceIndex));
  if (sameLinePrefix.length >= 3 && !isIgnoredOcrLine(sameLinePrefix)) {
    return sameLinePrefix;
  }

  const above = collectNameBlock(lines, priceLineIndex - 1, -1);
  if (above.length > 0) {
    return joinNameBlock(above).slice(-2).join(' ').trim();
  }

  const below = collectNameBlock(lines, priceLineIndex + 1, 1);
  if (below.length > 0) {
    return joinNameBlock(below).slice(0, 2).join(' ').trim();
  }

  return null;
}

/** Entfernt reine Promo-/Fragment-Zeilen (z. B. ein zwischen Name und Preis
 *  stehendes „Knaller"), SOLANGE ein echter Namensteil übrig bleibt. Besteht der
 *  Block NUR aus Fragmenten, bleibt er unverändert — so feuert die nachgelagerte
 *  isFragment-Prüfung weiter (lowConfidence) statt eines stillen noName. */
function joinNameBlock(block: readonly string[]): string[] {
  const meaningful = block.filter((line) => !isGenericFragment(line));
  return meaningful.length > 0 ? meaningful : [...block];
}

/** Strukturelles Signal „diese Zeile sieht wie ein Produktname aus" — unabhängig
 *  davon, ob sie später einem Preis zugeordnet werden kann. Speist die Diagnose
 *  (`productNameBlocksFound`), damit ein raw=0 zwischen „keine Namen" und „keine
 *  Preise" unterscheidbar wird. */
function isProductNameLine(line: string): boolean {
  if (isIgnoredOcrLine(line) || findPriceToken(line)) {
    return false;
  }
  const cleaned = cleanOfferName(line);
  return cleaned.length >= 3 && unitFromText(cleaned) !== cleaned;
}

// ---------------------------------------------------------------------------
// OCR-Sicherheitsgate: starker Food-Beleg, starkes Non-Food-Veto, Namensqualität.
//
// Bewusst KEINE Produkt-/Marken-Allowlist und KEINE KW-Logik: ausschließlich
// strukturelles FOOD-/NON-FOOD-Domänenvokabular (Lebensmittel- bzw. Geräte-/
// Haushalts-/Kleidungs-/Garten-KATEGORIEN). Das ist dieselbe Art Signal wie die
// bereits etablierten `categoryRules`/`NON_FOOD_DEPARTMENT_VETO` — kein Sollwert
// einzelner Wochenangebote. Ein OCR-Kandidat geht nur live, wenn er einen STARKEN
// Food-Beleg hat UND kein starkes Non-Food-/Namensqualitäts-Veto.
// ---------------------------------------------------------------------------

/** Generisches Food-Domänenvokabular (Wortstämme der Lebensmittelkategorien). Als
 *  Wort/Token, Kompositum-Kopf (Wortende) oder — bei langen Stämmen — Teilwort
 *  geprüft. Kein Markenname. Bewusst OHNE kurzes/mehrdeutiges „eis" (träfe sonst
 *  „Eiswürfelmaschine"): Speiseeis ist über „eiscreme/eistee/speiseeis" abgedeckt. */
const FOOD_STEMS: readonly string[] = [
  // Obst/Gemüse
  'obst', 'gemuese', 'gemuse', 'tomate', 'banane', 'apfel', 'aepfel', 'birne',
  'beere', 'traube', 'melone', 'zitrone', 'orange', 'mandarine', 'clementine',
  'kartoffel', 'moehre', 'karotte', 'zwiebel', 'paprika', 'gurke', 'salat',
  'brokkoli', 'spinat', 'champignon', 'pilz', 'avocado', 'mango', 'kiwi',
  'pfirsich', 'nektarine', 'pflaume', 'kirsche', 'spargel', 'lauch', 'kohl',
  'rettich', 'radieschen', 'sellerie', 'ingwer', 'kraeuter', 'rucola', 'aubergine',
  'zucchini', 'kuerbis', 'fenchel', 'bohnen', 'erbsen', 'mais',
  // Fleisch
  'fleisch', 'haehnchen', 'huhn', 'pute', 'rind', 'schwein', 'hack', 'wurst',
  'schinken', 'salami', 'steak', 'schnitzel', 'gulasch', 'frikadelle', 'bratwurst',
  'mett', 'leberkaese', 'gefluegel', 'geflugel', 'lamm', 'kotelett', 'filet',
  // Fisch
  'fisch', 'lachs', 'thunfisch', 'garnele', 'forelle', 'hering', 'makrele',
  'scholle', 'kabeljau', 'pangasius', 'seelachs', 'shrimp', 'krabbe',
  // Milch & Eier
  'milch', 'joghurt', 'jogurt', 'kaese', 'quark', 'sahne', 'butter', 'skyr',
  'mozzarella', 'gouda', 'feta', 'frischkaese', 'eier', 'schmand', 'kefir',
  'camembert', 'edamer', 'parmesan', 'pudding', 'dessert', 'mascarpone',
  // Milchalternativen
  'haferdrink', 'sojadrink', 'mandeldrink', 'kokosdrink', 'tofu', 'hummus',
  // Backwaren
  'brot', 'broetchen', 'toast', 'croissant', 'baguette', 'kuchen', 'gebaeck',
  'brezel', 'brioche', 'semmel', 'knaecke', 'zwieback', 'waffel',
  // Getränke
  'wasser', 'saft', 'schorle', 'limonade', 'cola', 'kaffee', 'kakao', 'smoothie',
  'nektar', 'eistee', 'energy', 'brause', 'sirup',
  // Alkohol
  'bier', 'wein', 'sekt', 'prosecco', 'vodka', 'wodka', 'whisky', 'likoer',
  'schnaps', 'aperol', 'sangria',
  // Cerealien / Frühstück / Aufstrich
  'muesli', 'cornflakes', 'haferflocken', 'flocken', 'cerealien', 'porridge',
  'marmelade', 'konfituere', 'honig', 'aufstrich',
  // Snacks / Süßes
  'schokolade', 'keks', 'bonbon', 'praline', 'gummi', 'riegel', 'chips',
  'popcorn', 'nuesse', 'mandel', 'cracker', 'salzstange', 'eiscreme', 'speiseeis',
  // Trockenware / Gewürze / Saucen
  'reis', 'nudel', 'pasta', 'spaghetti', 'penne', 'mehl', 'zucker', 'olivenoel',
  'essig', 'gewuerz', 'sauce', 'suppe', 'bruehe', 'ketchup', 'senf', 'mayonnaise',
  'linsen', 'kichererbsen', 'couscous', 'bulgur', 'pesto',
  // Babyfood
  'babynahrung', 'babybrei', 'folgemilch', 'beikost', 'quetschie',
];

/** Strukturelle Non-Food-Stämme, geprüft als Token-ENDE (Kompositum-Kopf) oder —
 *  bei langen Stämmen — als Teilwort. Bewusst nur Köpfe, hinter denen NIE ein
 *  Lebensmittel steht: „…maschine/…filter/…pfanne/…schuh/…pflanze/…blume". So
 *  bleibt „Blumenkohl"/„Pflanzendrink"/„Eintopf" unberührt (kein Präfix-Match). */
const NON_FOOD_COMPOUND_HEADS: readonly string[] = [
  'maschine', 'automat', 'schrauber', 'bohrer', 'staubsauger', 'filter', 'pfanne',
  'werkzeug', 'batterie', 'spielzeug', 'pflanze', 'blume', 'lampe', 'leuchte',
  'schrank', 'kommode', 'sessel', 'matratze', 'schuh', 'stiefel', 'jacke', 'shirt',
  'hose', 'socken', 'handtuch', 'teppich', 'kissen', 'vorhang', 'moebel', 'kerze',
  'tisch', 'stuhl', 'regal', 'decke', 'besteck', 'geschirr', 'messer', 'topf',
];

/** Strukturelle Non-Food-Stämme als Token-ANFANG (Wortpräfix), nur wo KEIN
 *  Lebensmittel denselben Anfang trägt. */
const NON_FOOD_PREFIXES: readonly string[] = ['textil', 'bekleidung', 'werkzeug'];

/** Strukturelle Non-Food-Stämme als GANZES Token (mehrdeutige Kurzwörter, die als
 *  Präfix ein Lebensmittel träfen — „grill" → „Grillkäse", „garten" → „Gartenkräuter"). */
const NON_FOOD_EXACT: ReadonlySet<string> = new Set(['grill', 'akku', 'garten', 'mode']);

function nameTokens(name: string): string[] {
  return normalizeText(name).split(' ').filter(Boolean);
}

/** Hat der Name einen starken strukturellen Food-Beleg (Food-Keyword)? Stamm als
 *  ganzes Token, als Kompositum-Kopf (Wortende, mind. +2 Zeichen länger, damit
 *  „reis" nicht „Preis" trifft) oder — bei langen Stämmen — als Teilwort. */
function hasFoodStem(name: string): boolean {
  const tokens = nameTokens(name);
  return tokens.some((token) =>
    FOOD_STEMS.some(
      (stem) =>
        token === stem ||
        (token.length >= stem.length + 2 && token.endsWith(stem)) ||
        (stem.length >= 5 && token.includes(stem)) ||
        (stem.length >= 6 && token.startsWith(stem)),
    ),
  );
}

/** Hat der Name ein starkes strukturelles Non-Food-Signal (Gerät/Werkzeug/
 *  Haushalt/Kleidung/Garten)? */
function hasStructuralNonFoodSignal(name: string): boolean {
  const tokens = nameTokens(name);
  return tokens.some((token) => {
    if (NON_FOOD_EXACT.has(token)) {
      return true;
    }
    if (NON_FOOD_PREFIXES.some((stem) => token.startsWith(stem))) {
      return true;
    }
    return NON_FOOD_COMPOUND_HEADS.some(
      (stem) => token === stem || token.endsWith(stem) || (stem.length >= 6 && token.includes(stem)),
    );
  });
}

/** Eine Kategorie ist „food", wenn sie nicht das Auffangbecken `Sonstiges` ist. */
function isFoodCategory(category: string): boolean {
  return category !== 'Sonstiges' && category.length > 0;
}

/**
 * OCR-Müllname-Erkennung: ein Name aus überwiegend Einzelbuchstaben-/Fragment-
 * Tokens ohne ein einziges echtes Wort (≥4 Buchstaben) ist strukturell
 * unbrauchbar (z. B. „Fo g i m m"). Echte Mehrwortnamen („Bio Bananen",
 * „Frische Hähnchenbrust") bleiben unberührt — sie tragen mindestens ein echtes
 * Wort. Einzeltoken-Namen werden hier NICHT verworfen (das übernimmt isFragment/
 * der Food-Beleg), damit kurze echte Produkte nicht fälschlich strandet.
 */
export function isOcrNameQualityReject(name: string): boolean {
  const tokens = nameTokens(name);
  if (tokens.length < 2) {
    return false;
  }
  const realWordTokens = tokens.filter((token) => token.length >= 4).length;
  if (realWordTokens === 0) {
    return true;
  }
  const tinyTokens = tokens.filter((token) => token.length <= 1).length;
  return tinyTokens / tokens.length > 0.5;
}

// ---------------------------------------------------------------------------
// Geteiltes OCR-Sicherheits-Gate — EINE Single Source of Truth, die SOWOHL die
// Textzeilen- ALS AUCH die Layout-Kandidatenquelle durchlaufen. So gilt für jeden
// Kandidaten — egal welcher Quelle — exakt dieselbe Reihenfolge: Fragment →
// Namensqualität → Duplikat → Non-Food-/CategoryConflict-Veto → Pflicht-Food-Beleg.
// (Vorher war diese Kette inline in extractLidlProspectOcrOffers; das Layout würde
// sie sonst dupliziert/abweichend prüfen.)
// ---------------------------------------------------------------------------

export type OcrSafetyRejectReason =
  | 'lowConfidence'
  | 'nameQuality'
  | 'duplicate'
  | 'nonFood'
  | 'categoryConflict'
  | 'missingStrongFoodEvidence';

export type OcrSafetyVerdict =
  | { ok: true; category: string }
  | { ok: false; reason: OcrSafetyRejectReason };

export interface ResolvedOcrSafetyHelpers {
  isFragment: (name: string) => boolean;
  isNameQualityReject: (name: string) => boolean;
  classifyNonFood: (candidate: { name: string; category?: string }) => boolean;
  hasStrongFoodEvidence: (candidate: { name: string; category: string }) => boolean;
}

export function resolveSafetyHelpers(options: LidlProspectOcrOptions): ResolvedOcrSafetyHelpers {
  return {
    isFragment: options.isFragment ?? isGenericFragment,
    isNameQualityReject: options.isNameQualityReject ?? isOcrNameQualityReject,
    classifyNonFood: options.classifyNonFood ?? (() => false),
    // Starker Food-Beleg = eingebauter struktureller Beleg (Food-Keyword/-Kategorie)
    // ODER der vom Connector injizierte zentrale Beleg.
    hasStrongFoodEvidence: (candidate) =>
      hasFoodStem(candidate.name) ||
      isFoodCategory(candidate.category) ||
      (options.hasStrongFoodEvidence?.(candidate) ?? false),
  };
}

/**
 * Das geteilte Sicherheits-Gate für EINEN bereits gruppierten Roh-Kandidaten
 * (Name + plausibler Angebotspreis). Reihenfolge nach abnehmender Sicherheit.
 * Mutiert `seen` exakt wie zuvor inline: Non-Food/CategoryConflict/missingFood/ok
 * markieren den Key (Dedupe identischer Folgetreffer), Fragment/Namensqualität/
 * Duplikat NICHT. Gibt bei `ok` die abgeleitete Kategorie zurück (wird NICHT blind
 * aus einem schwachen Signal gesetzt — ein bestätigter Food-Beleg ohne erkennbare
 * Kategorie bleibt ehrlich `Sonstiges`).
 */
export function classifyOcrCandidate(
  name: string,
  helpers: ResolvedOcrSafetyHelpers,
  seen: Set<string>,
): OcrSafetyVerdict {
  // (1) Promo-/Attribut-Fragment (generischer Störer-Check).
  if (helpers.isFragment(name)) {
    return { ok: false, reason: 'lowConfidence' };
  }
  // (2) OCR-Müllname (Einzelbuchstaben-/Fragmenttokens, kein echtes Wort).
  if (helpers.isNameQualityReject(name)) {
    return { ok: false, reason: 'nameQuality' };
  }
  const key = normalizeText(name);
  if (seen.has(key)) {
    return { ok: false, reason: 'duplicate' };
  }
  // Kategorie nur diagnostisch ableiten — sie wird NICHT blind übernommen: ein
  // irreführendes Präfix („eis" → Snacks) darf kein Food-Verdikt setzen.
  const rawCategory = toSimpleOfferCategory('Lidl Prospekt', name);
  // (3) Starkes Non-Food-Veto (strukturell ODER injizierte zentrale Logik). Trägt
  // der Kandidat dabei eine (über ein Präfix) als FOOD klassifizierte Kategorie,
  // ist das ein categoryConflict, sonst ein gewöhnliches nonFood.
  if (hasStructuralNonFoodSignal(name) || helpers.classifyNonFood({ name, category: rawCategory })) {
    seen.add(key);
    return { ok: false, reason: isFoodCategory(rawCategory) ? 'categoryConflict' : 'nonFood' };
  }
  // (4) Pflicht-Food-Beleg: ohne starken Food-Beleg geht nichts live.
  if (!helpers.hasStrongFoodEvidence({ name, category: rawCategory })) {
    seen.add(key);
    return { ok: false, reason: 'missingStrongFoodEvidence' };
  }
  seen.add(key);
  return { ok: true, category: rawCategory };
}

function stableLidlOcrId(storeChain: string, name: string, price: number, validityStart: string): string {
  const source = `${storeChain}|ocr|${normalizeText(name)}|${price}|${validityStart}`;
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash << 5) - hash + source.charCodeAt(index);
    hash |= 0;
  }
  return `lidl_ocr_${Math.abs(hash).toString(36)}`;
}

/** Baut EIN emittierbares OCR-Angebot — geteilt von der Textzeilen- UND der
 *  Layout-Quelle, damit beide dieselbe Form/Tags tragen. Der `sourceKind` landet
 *  als Tag (text_line | layout_card | vision_card) → die Herkunft ist im
 *  Snapshot/Report sichtbar, ohne Bilddaten zu speichern. */
function buildOcrOfferCandidate(args: {
  context: LidlProspectOcrContext;
  name: string;
  category: string;
  price: number;
  unit?: string;
  imageUrl?: string;
  sourceKind: OcrCandidateSourceKind;
}): RawOfferCandidate {
  const validityStart = args.context.validityStart;
  return {
    id: stableLidlOcrId(args.context.storeChain, args.name, args.price, validityStart ?? ''),
    name: args.name,
    storeChain: args.context.storeChain,
    category: args.category,
    price: args.price,
    currency: 'EUR',
    unit: args.unit,
    validityStart,
    validityEnd: args.context.validityEnd,
    imageUrl: args.imageUrl,
    sourceUrl: args.context.sourceUrl,
    sourceId: args.context.sourceId,
    sourceCategoryRaw: 'Lidl Prospekt OCR',
    tags: [LIDL_OCR_OFFER_TAG, 'ocr', args.sourceKind],
  };
}

/**
 * Pure Extraktion: OCR-Seitentexte → sichere Lidl-Angebotskandidaten + die
 * vollständige Verwerfungs-Zählkette. Keine Netzwerkzugriffe, keine Mutation der
 * Eingaben.
 */
export function extractLidlProspectOcrOffers(
  pages: readonly LidlProspectOcrPage[],
  context: LidlProspectOcrContext,
  options: LidlProspectOcrOptions = {},
): LidlProspectOcrResult {
  const helpers = resolveSafetyHelpers(options);
  const rejections = emptyRejections();
  const offers: RawOfferCandidate[] = [];
  let ocrParsedOffers = 0;
  let ocrTextLines = 0;
  let priceLinesFound = 0;
  let productNameBlocksFound = 0;

  const seen = new Set<string>(
    [...(context.existingNameKeys ?? [])].map((key) => normalizeText(String(key))),
  );

  for (const page of pages) {
    const rawLines = String(page.text ?? '')
      .split(/\r?\n/)
      .map(cleanOcrLine)
      .filter(Boolean);
    // Zählung der RAW-OCR-Zeilen vor dem Zusammenführen getrennter Euro/Cent-Preise,
    // damit `rawOcrLines` die tatsächlich gelesenen Zeilen belegt.
    ocrTextLines += rawLines.length;
    productNameBlocksFound += rawLines.filter(isProductNameLine).length;
    const lines = mergeSplitPriceLines(rawLines);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (isIgnoredOcrLine(line)) {
        continue;
      }
      const priceToken = findPriceToken(line);
      if (!priceToken) {
        continue;
      }
      // Ab hier ist die Zeile ein Preis-tragender Kandidat — jede Verwerfung zählt.
      try {
        if (!priceToken.plausible) {
          rejections.noPrice += 1;
          continue;
        }
        // Pfand-/Grundpreis-Token tragen einen plausiblen Betrag, sind aber KEIN
        // Angebotspreis — sonst würde der Betrag an den davorstehenden echten
        // Produktnamen „geklebt" (false-positive). Vor der Namensextraktion raus.
        if (priceIsDeposit(line, priceToken.index)) {
          rejections.deposit += 1;
          continue;
        }
        if (priceIsBasePrice(line, priceToken.index)) {
          rejections.basePrice += 1;
          continue;
        }
        // Plausibler ANGEBOTSpreis (kein Grundpreis/Pfand) — jetzt zählt die Zeile
        // als Preiszeile, auch wenn anschließend kein Name gruppierbar ist.
        priceLinesFound += 1;
        const name = nameFromWindow(lines, index, priceToken.index);
        if (!name || isIgnoredOcrLine(name) || name.length < 3) {
          rejections.noName += 1;
          continue;
        }
        ocrParsedOffers += 1;
        // Geteiltes Sicherheits-Gate (Single Source of Truth, identisch zur
        // Layout-Quelle): Fragment → Namensqualität → Duplikat → Non-Food →
        // Pflicht-Food-Beleg. Mutiert `seen` wie zuvor inline.
        const verdict = classifyOcrCandidate(name, helpers, seen);
        if (!verdict.ok) {
          rejections[verdict.reason] += 1;
          continue;
        }
        const nearby = lines
          .slice(Math.max(0, index - 3), index + 1)
          .filter((entry) => !isIgnoredOcrLine(entry))
          .join(' ');
        offers.push(
          buildOcrOfferCandidate({
            context,
            name,
            category: verdict.category,
            price: priceToken.price,
            unit: unitFromText(nearby),
            imageUrl: page.imageUrl,
            sourceKind: 'text_line',
          }),
        );
      } catch {
        // Ein einzelner Kandidat darf den OCR-Lauf nie abbrechen.
        rejections.parseError += 1;
      }
    }
  }

  return {
    offers,
    ocrCandidatePages: pages.length,
    ocrAttempted: pages.length,
    ocrTextLines,
    ocrParsedOffers,
    priceLinesFound,
    productNameBlocksFound,
    groupedCandidates: ocrParsedOffers,
    rejections,
  };
}

// ===========================================================================
// LAYOUT-AWARE EXTRAKTOR (Produktkarten statt nur Textzeilen).
//
// Pure Funktion: layout-analysierte Seiten (Wörter mit Boxen + optionalem Promo-
// Farb-Tag) → sichere Layout-Kandidaten + getrennte Verwerfungs-Zählkette. Die
// Reihenfolge je Karte:
//   1. Wörter zu Produktkarten clustern (räumliche Nähe).
//   2. Preisflächen erkennen; der ANGEBOTSpreis ist der prominenteste plausible
//      Preis (große Optik / Farbfläche / Aktionswort), NIE Grundpreis/Pfand.
//   3. Namensblock aus dem räumlich nächsten Textcluster ableiten; Top-left-
//      Badges / Einheiten / Promo-Wörter werden ausgeschlossen.
//   4. Layout-Konfidenz (mehrere gleichprominente Preise → mehrdeutig → raus).
//   5. Geteiltes Sicherheits-Gate (identisch zur Textzeilenquelle).
// ===========================================================================

const ACTION_PRICE_WORDS = new Set(['aktion', 'statt', 'knaller', 'kracher']);
// Top-left-Badge-Vokabular: Stückzahl-/Promo-/Coupon-Labels, die NIE ein
// Produktname sind. Strukturell (kein Produkt-/Markenwissen).
const LAYOUT_BADGE_RE =
  /(\b\d+\s*(st(?:ü|ue|u)?ck|stk|x)\b)|kernarm|\bbonus\b|\bcoupon\b|\bgutschein\b|\bgratis\b|%/i;

function boxRight(box: LayoutBox): number {
  return box.x + box.w;
}
function boxBottom(box: LayoutBox): number {
  return box.y + box.h;
}
function boxCenterX(box: LayoutBox): number {
  return box.x + box.w / 2;
}
function boxCenterY(box: LayoutBox): number {
  return box.y + box.h / 2;
}
function unionBox(boxes: readonly LayoutBox[]): LayoutBox {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map(boxRight));
  const b = Math.max(...boxes.map(boxBottom));
  return { x, y, w: r - x, h: b - y };
}
function boxGapX(a: LayoutBox, b: LayoutBox): number {
  return Math.max(0, Math.max(a.x, b.x) - Math.min(boxRight(a), boxRight(b)));
}
function boxGapY(a: LayoutBox, b: LayoutBox): number {
  return Math.max(0, Math.max(a.y, b.y) - Math.min(boxBottom(a), boxBottom(b)));
}
function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface LayoutRow {
  words: OcrLayoutWord[];
  text: string;
  bbox: LayoutBox;
  /** Schrifthöhe = größte Worthöhe der Zeile (große Lidl-Preisziffern = groß). */
  fontHeight: number;
  hasColorTag: boolean;
}

export interface LayoutCard {
  bbox: LayoutBox;
  rows: LayoutRow[];
  words: OcrLayoutWord[];
}

/** Gruppiert die Wörter einer Karte zu Zeilen (Zeilenbildung über y-Nähe). */
function groupWordsIntoRows(words: readonly OcrLayoutWord[]): LayoutRow[] {
  const usable = words.filter((word) => cleanOcrLine(word.text).length > 0);
  if (usable.length === 0) {
    return [];
  }
  const sorted = [...usable].sort((a, b) => boxCenterY(a.bbox) - boxCenterY(b.bbox));
  const rows: OcrLayoutWord[][] = [];
  for (const word of sorted) {
    const last = rows[rows.length - 1];
    if (last) {
      const rowFont = Math.max(...last.map((w) => w.bbox.h));
      const rowCenterY = median(last.map((w) => boxCenterY(w.bbox)));
      const tolerance = 0.6 * Math.max(word.bbox.h, rowFont);
      if (Math.abs(boxCenterY(word.bbox) - rowCenterY) <= tolerance) {
        last.push(word);
        continue;
      }
    }
    rows.push([word]);
  }
  return rows.map((rowWords) => {
    const ordered = [...rowWords].sort((a, b) => a.bbox.x - b.bbox.x);
    return {
      words: ordered,
      text: cleanOcrLine(ordered.map((w) => w.text).join(' ')),
      bbox: unionBox(ordered.map((w) => w.bbox)),
      fontHeight: Math.max(...ordered.map((w) => w.bbox.h)),
      hasColorTag: ordered.some((w) => Boolean(w.colorTag)),
    };
  });
}

/** Clustert die Wörter einer Seite über räumliche Nähe zu Produktkarten (Union-
 *  Find). Schwellen sind relativ zur Median-Worthöhe + Seitenmaßen, damit die
 *  Heuristik unabhängig von der Bildauflösung trägt. Exportiert für gezielte
 *  Karten-/Crop-Tests (eine Seite → Karten). */
export function clusterWordsIntoCards(page: OcrLayoutPage): LayoutCard[] {
  const words = page.words.filter((word) => cleanOcrLine(word.text).length > 0);
  if (words.length === 0) {
    return [];
  }
  const mh = median(words.map((w) => w.bbox.h)) || 1;
  const gapX = Math.max(mh * 3, page.width * 0.05);
  const gapY = Math.max(mh * 1.6, page.height * 0.025);

  const parent = words.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root];
    }
    let cursor = index;
    while (parent[cursor] !== root) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    parent[find(a)] = find(b);
  };
  for (let i = 0; i < words.length; i += 1) {
    for (let j = i + 1; j < words.length; j += 1) {
      if (boxGapX(words[i].bbox, words[j].bbox) <= gapX && boxGapY(words[i].bbox, words[j].bbox) <= gapY) {
        union(i, j);
      }
    }
  }
  const groups = new Map<number, OcrLayoutWord[]>();
  for (let index = 0; index < words.length; index += 1) {
    const root = find(index);
    const bucket = groups.get(root) ?? [];
    bucket.push(words[index]);
    groups.set(root, bucket);
  }
  return [...groups.values()].map((cardWords) => ({
    bbox: unionBox(cardWords.map((w) => w.bbox)),
    rows: groupWordsIntoRows(cardWords),
    words: cardWords,
  }));
}

/** Ist die Zeile ein Top-left-Badge (Stückzahl/Promo/Coupon/kurzes Label)? Rein
 *  über Position (obere linke Kartenecke) + strukturelles Badge-Vokabular —
 *  niemals ein Produktname. */
function isLayoutBadgeRow(row: LayoutRow, card: LayoutCard): boolean {
  const topLeft =
    boxCenterX(row.bbox) <= card.bbox.x + card.bbox.w * 0.5 &&
    row.bbox.y <= card.bbox.y + card.bbox.h * 0.28;
  if (!topLeft) {
    return false;
  }
  const norm = normalizeText(row.text);
  const tokens = norm.split(' ').filter(Boolean);
  return LAYOUT_BADGE_RE.test(row.text) || (tokens.length === 1 && norm.length <= 4);
}

function actionWordNearby(card: LayoutCard): boolean {
  return card.words.some((word) => ACTION_PRICE_WORDS.has(normalizeText(word.text)));
}

/** Ist die Zeile als Produktname brauchbar? Schließt Preise, Einheiten, Badges,
 *  Promo-/Verbindungstexte und reine Fragmente aus (analog zur Textzeilenquelle). */
function isLayoutNameRow(row: LayoutRow, card: LayoutCard): boolean {
  if (isIgnoredOcrLine(row.text) || isConnectiveNoise(row.text) || findPriceToken(row.text)) {
    return false;
  }
  if (isLayoutBadgeRow(row, card) || isGenericFragment(row.text)) {
    return false;
  }
  const cleaned = cleanOfferName(row.text);
  return cleaned.length >= 3 && unitFromText(cleaned) !== cleaned;
}

interface PricedRow {
  row: LayoutRow;
  token: PriceToken;
  isBase: boolean;
  isDeposit: boolean;
  prominence: number;
}

/** DEBUG-Trace EINER Kartenauswertung (nur für die Evidence). Bildet die
 *  Preis-/Namens-Kandidaten ab, aus denen {@link buildLayoutCandidateFromCard} den
 *  Angebotspreis + Namensblock wählt. Wird NUR befüllt, wenn ein Trace-Objekt
 *  übergeben wird — die Entscheidung selbst bleibt unverändert. */
export interface LayoutCardPriceCandidate {
  text: string;
  price: number;
  /** Prominenz-Score (fontRatio + Farbtag-Bonus + Aktionswort-Bonus). */
  prominence: number;
  fontRatio: number;
  hasColorTag: boolean;
  isBasePrice: boolean;
  isDeposit: boolean;
  /** Als Angebotspreis gewählt (prominentester Nicht-Grundpreis/-Pfand). */
  chosen: boolean;
  bbox: LayoutBox;
}
export interface LayoutCardNameCandidate {
  text: string;
  bbox: LayoutBox;
  /** Teil des gewählten Namensblocks (preis-nächste 1–2 Namenszeilen). */
  chosen: boolean;
}
export interface LayoutCardTrace {
  priceCandidates: LayoutCardPriceCandidate[];
  nameCandidates: LayoutCardNameCandidate[];
  /** Feinursache, falls die Karte keine Preisfläche ergab (nur bei noPriceRegion). */
  noPriceDetail?: NoPriceRegionDetail;
  /** Ziffernhaltige Wörter, die NICHT als Angebotspreis akzeptiert wurden (Evidence:
   *  zeigt, ob überhaupt preis-ähnliche Tokens vorlagen und welche). */
  rejectedPriceLikeWords?: string[];
  /** Versuche, ein Euro- und ein Cent-Token räumlich zu einem Preis zu verbinden
   *  (`"1,99"`), die NICHT in einer Zeile gruppiert waren. */
  combinedPriceAttempts?: string[];
}

// Gültigkeitsdatum-/Rechts-/Adressziffern, die NIE ein Angebotspreis sind: KW-freie
// Tagesdaten (15.6.), Postleitzahl-/Telefon-/Hausnummern (≥3 Ziffern), Ausgaben-
// nummern (25/2026), Prozentangaben. Rein strukturell, kein Datums-/KW-Rechnen.
function isDateOrLegalToken(text: string): boolean {
  const t = text.trim().replace(/[()€]/g, '');
  return (
    /^\d{1,2}\.\d{1,2}\.?$/.test(t) || // 15.6. / 27.6
    /^\d{3,}\.?$/.test(t) || // 030, 2200, 74206, 026, 250, 5500.
    /\d\/\d{3,4}/.test(t) || // 25/2026
    /^\d{1,3}\s*%$/.test(t) // 105%
  );
}

/** Feinursache, WARUM eine Karte keine Angebots-Preisfläche ergab. Wird nur
 *  aufgerufen, wenn {@link buildLayoutCandidateFromCard} `noPriceRegion` zurückgibt
 *  (kein plausibles Preis-Token in irgendeiner Zeile). Rein diagnostisch — ändert
 *  die Entscheidung nicht und erfindet keinen Preis. */
function classifyNoPriceRegion(card: LayoutCard): {
  detail: NoPriceRegionDetail;
  combinedPriceAttempts: string[];
} {
  const words = card.words;
  const digitWords = words.filter((word) => /\d/.test(word.text));
  // Euro/Cent räumlich benachbart, aber in GETRENNTEN Zeilen (Gruppierung griff
  // nicht): genau die „splitPriceNotCombined"-Optik. Hätte ein Euro+Cent-Paar in
  // DERSELBEN Zeile gestanden, hätte PRICE_SPACE bereits einen Preis erkannt.
  const euros = words.filter((word) => LONE_EURO.test(cleanOcrLine(word.text)));
  const cents = words.filter((word) => LONE_CENT.test(cleanOcrLine(word.text)));
  const combinedPriceAttempts: string[] = [];
  let splitPair = false;
  for (const euro of euros) {
    for (const cent of cents) {
      if (cent === euro) {
        continue;
      }
      const sameRow =
        Math.abs(boxCenterY(cent.bbox) - boxCenterY(euro.bbox)) <=
        0.6 * Math.max(cent.bbox.h, euro.bbox.h);
      const adjacentX =
        cent.bbox.x >= euro.bbox.x &&
        cent.bbox.x - boxRight(euro.bbox) <= 0.8 * Math.max(euro.bbox.w, euro.bbox.h);
      const verticallyClose =
        Math.abs(cent.bbox.y - euro.bbox.y) <= 1.2 * Math.max(euro.bbox.h, cent.bbox.h);
      if (!sameRow && adjacentX && verticallyClose) {
        splitPair = true;
        combinedPriceAttempts.push(`${ocrDigits(cleanOcrLine(euro.text))},${ocrDigits(cleanOcrLine(cent.text))}`);
      }
    }
  }
  if (splitPair) {
    return { detail: 'splitPriceNotCombined', combinedPriceAttempts };
  }
  if (digitWords.length === 0) {
    return { detail: 'noPriceLikeWords', combinedPriceAttempts };
  }
  if (digitWords.every((word) => isDateOrLegalToken(word.text))) {
    return { detail: 'onlyDateOrLegal', combinedPriceAttempts };
  }
  return { detail: 'noPriceLikeWords', combinedPriceAttempts };
}

type LayoutCardResult =
  | {
      ok: true;
      name: string;
      price: number;
      unit?: string;
      confidence: number;
      isLowConfidence: boolean;
      priceRegion: LayoutBox;
      nameRegion: LayoutBox;
      cardRegion: LayoutBox;
      colorTag?: 'action_red' | 'action_yellow';
    }
  | {
      ok: false;
      reason: 'noPriceRegion' | 'basePrice' | 'deposit' | 'noNameNearPrice';
      /** Nur bei reason==='noPriceRegion': WARUM keine Preisfläche (Feindiagnose). */
      noPriceDetail?: NoPriceRegionDetail;
    };

/** Wertet EINE Produktkarte aus: Preisfläche bestimmen, Namensblock ableiten,
 *  Layout-Konfidenz bewerten. Gibt entweder einen Roh-Kandidaten oder einen
 *  Vor-Verwerfungsgrund (keine Preisfläche / nur Grundpreis-Pfand / kein Name nah)
 *  zurück. Das Food-/Non-Food-/Namensqualitäts-Gate läuft danach geteilt. */
function buildLayoutCandidateFromCard(card: LayoutCard, trace?: LayoutCardTrace): LayoutCardResult {
  const rows = card.rows;
  if (rows.length === 0) {
    return { ok: false, reason: 'noPriceRegion', noPriceDetail: 'noPriceLikeWords' };
  }
  const medianFont = median(rows.map((row) => row.fontHeight)) || 1;
  const hasAction = actionWordNearby(card);

  const priced: PricedRow[] = [];
  for (const row of rows) {
    const token = findPriceToken(row.text);
    if (!token || !token.plausible) {
      continue;
    }
    const ratio = row.fontHeight / medianFont;
    const prominence = ratio + (row.hasColorTag ? 0.6 : 0) + (hasAction ? 0.3 : 0);
    priced.push({
      row,
      token,
      isBase: priceIsBasePrice(row.text, token.index),
      isDeposit: priceIsDeposit(row.text, token.index),
      prominence,
    });
  }
  // DEBUG-Trace: alle erkannten Preiskandidaten (chosen wird unten markiert).
  if (trace) {
    trace.priceCandidates = priced.map((entry) => ({
      text: entry.row.text,
      price: entry.token.price,
      prominence: entry.prominence,
      fontRatio: entry.row.fontHeight / medianFont,
      hasColorTag: entry.row.hasColorTag,
      isBasePrice: entry.isBase,
      isDeposit: entry.isDeposit,
      chosen: false,
      bbox: entry.row.bbox,
    }));
  }
  if (priced.length === 0) {
    const { detail, combinedPriceAttempts } = classifyNoPriceRegion(card);
    if (trace) {
      trace.noPriceDetail = detail;
      trace.rejectedPriceLikeWords = card.words
        .filter((word) => /\d/.test(word.text))
        .map((word) => word.text);
      trace.combinedPriceAttempts = combinedPriceAttempts;
    }
    return { ok: false, reason: 'noPriceRegion', noPriceDetail: detail };
  }
  const offerRows = priced.filter((entry) => !entry.isBase && !entry.isDeposit);
  if (offerRows.length === 0) {
    // Nur Grundpreis(e)/Pfand → kein Angebotspreis. Der echte Angebotspreis darf
    // NIE aus Grundpreis/Pfand kommen.
    return { ok: false, reason: priced.some((entry) => entry.isBase) ? 'basePrice' : 'deposit' };
  }
  offerRows.sort((a, b) => b.prominence - a.prominence || b.row.fontHeight - a.row.fontHeight);
  const offer = offerRows[0];
  if (trace) {
    const chosenIndex = priced.indexOf(offer);
    if (chosenIndex >= 0) {
      trace.priceCandidates[chosenIndex].chosen = true;
    }
  }
  // Mehrere gleichprominente Angebotspreise in EINER Karte → mehrdeutig (welcher
  // ist der echte Aktionspreis?). Layout-Konfidenz drückt das aus.
  const ambiguous = offerRows.length >= 2 && offerRows[1].prominence >= 0.8 * offer.prominence;

  const pricedRowSet = new Set(priced.map((entry) => entry.row));
  const nameRows = rows.filter((row) => !pricedRowSet.has(row) && isLayoutNameRow(row, card));

  let name = '';
  let nameRegion: LayoutBox = offer.row.bbox;
  if (nameRows.length > 0) {
    const offerCenterY = boxCenterY(offer.row.bbox);
    const nearest = [...nameRows]
      .sort((a, b) => Math.abs(boxCenterY(a.bbox) - offerCenterY) - Math.abs(boxCenterY(b.bbox) - offerCenterY))
      .slice(0, 2)
      .sort((a, b) => a.bbox.y - b.bbox.y);
    name = cleanOfferName(nearest.map((row) => row.text).join(' '));
    nameRegion = unionBox(nearest.map((row) => row.bbox));
    if (trace) {
      const chosenRows = new Set(nearest);
      trace.nameCandidates = nameRows.map((row) => ({
        text: row.text,
        bbox: row.bbox,
        chosen: chosenRows.has(row),
      }));
    }
  } else {
    // Fallback: Name als Präfix auf DERSELBEN Zeile vor dem Preis (z. B. „Tomaten 1,49").
    const prefix = cleanOfferName(offer.row.text.slice(0, offer.token.index));
    if (prefix.length >= 3 && !isIgnoredOcrLine(prefix)) {
      name = prefix;
    }
  }
  if (!name || name.length < 3) {
    return { ok: false, reason: 'noNameNearPrice' };
  }

  // Layout-Konfidenz: prominente/auffällige Preisfläche + echtes Namenswort +
  // Eindeutigkeit. Großoptik/Farbfläche/Aktionswort werden positiv gewichtet.
  const prominent = offer.prominence >= 1.4 || offer.row.hasColorTag || hasAction;
  const nameHasRealWord = nameTokens(name).some((token) => token.length >= 4);
  let confidence = 0.5;
  if (prominent) {
    confidence += 0.25;
  }
  if (nameHasRealWord) {
    confidence += 0.15;
  }
  if (ambiguous) {
    confidence = Math.min(confidence, 0.4);
  }
  confidence = Math.max(0, Math.min(1, confidence));

  return {
    ok: true,
    name,
    price: offer.token.price,
    unit: unitFromText(card.words.map((word) => word.text).join(' ')),
    confidence,
    isLowConfidence: confidence < 0.5,
    priceRegion: offer.row.bbox,
    nameRegion,
    cardRegion: card.bbox,
    colorTag: offer.row.words.find((word) => word.colorTag)?.colorTag,
  };
}

/**
 * Pure Layout-Extraktion: layout-analysierte Seiten → sichere Layout-Kandidaten +
 * getrennte Verwerfungs-Zählkette. Keine Netzwerkzugriffe, keine Mutation der
 * Eingaben. Das Sicherheits-Gate (`classifyOcrCandidate`) ist IDENTISCH zur
 * Textzeilenquelle — unsichere Kandidaten gehen nie live.
 */
export function extractLidlLayoutOffers(
  pages: readonly OcrLayoutPage[],
  context: LidlProspectOcrContext,
  options: LidlProspectOcrOptions = {},
): LidlLayoutOcrResult {
  const helpers = resolveSafetyHelpers(options);
  const rejections = emptyLayoutRejections();
  const noPriceRegionDetail = emptyNoPriceRegionDetail();
  const offers: RawOfferCandidate[] = [];
  let layoutCardsDetected = 0;
  let layoutRawCandidates = 0;
  let layoutSafeCandidates = 0;

  const seen = new Set<string>(
    [...(context.existingNameKeys ?? [])].map((key) => normalizeText(String(key))),
  );

  for (const page of pages) {
    const cards = clusterWordsIntoCards(page);
    layoutCardsDetected += cards.length;
    for (const card of cards) {
      try {
        const built = buildLayoutCandidateFromCard(card);
        if (!built.ok) {
          rejections[built.reason] += 1;
          if (built.reason === 'noPriceRegion' && built.noPriceDetail) {
            noPriceRegionDetail[built.noPriceDetail] += 1;
          }
          continue;
        }
        // Roh-Kandidat (Name + Angebotspreis gruppiert) — ab hier wird gezählt.
        layoutRawCandidates += 1;
        if (built.isLowConfidence) {
          rejections.lowLayoutConfidence += 1;
          continue;
        }
        const verdict = classifyOcrCandidate(built.name, helpers, seen);
        if (!verdict.ok) {
          rejections[verdict.reason] += 1;
          continue;
        }
        offers.push(
          buildOcrOfferCandidate({
            context,
            name: built.name,
            category: verdict.category,
            price: built.price,
            unit: built.unit,
            imageUrl: page.imageUrl,
            sourceKind: 'layout_card',
          }),
        );
        layoutSafeCandidates += 1;
      } catch {
        // Eine einzelne Karte darf den Layout-Lauf nie abbrechen; als
        // niedrige Konfidenz behandeln (nie live).
        rejections.lowLayoutConfidence += 1;
      }
    }
  }

  return {
    offers,
    layoutCardsDetected,
    layoutRawCandidates,
    layoutSafeCandidates,
    rejections,
    noPriceRegionDetail,
  };
}

// ===========================================================================
// PREISBOX-OCR-CROP-PASS (DRITTE Kandidatenquelle: sourceKind='price_crop').
//
// Hintergrund (belegter Root Cause aus echter Lidl-Full-Scan-Evidence): Layout
// erkennt Produktkarten (z. B. 29 Karten/Seite), aber die GROSSEN, stylisierten
// Lidl-Aktionspreis-Tiles werden vom Seiten-OCR zu kaputten Low-Confidence-Glyphen
// verstümmelt (z. B. „£08"/conf20) — es entsteht KEIN preisförmiges Token, also
// 0 layoutRawCandidates / noPriceRegion dominant. Statt im Preisregion-Extractor
// weiter zu raten, OCRt dieser Pass GEZIELT nur die kleine Preisbox-Region einer
// Karte separat, hochskaliert + ziffern-whitelisted.
//
// Sicherheit unverändert eingebaut:
//   • Crop-Region wird aus echter Wortbox-GEOMETRIE abgeleitet (prominente,
//     ziffern-tragende Glyphen) — NIE eine blind gewählte leere Fläche.
//   • Grundpreis-/Pfand-/Datums-/Legal-Glyphen sind kein Anker.
//   • Preis wird NUR akzeptiert, wenn die Crop-OCR eine klare, EINDEUTIGE Preisform
//     liefert (kein Raten aus kaputten Glyphen; mehrere Preise → mehrdeutig).
//   • Produktname kommt weiter aus der Layout-Karte (Text-Words), NIE aus dem Crop.
//   • Danach das GETEILTE Food-/Non-Food-/Namensqualitäts-Gate (classifyOcrCandidate).
//   • diagnostic emittiert nie live; live nur sichere Kandidaten.
//   • KEINE KW-Logik, KEINE Produkt-/Marken-Allowlist.
//
// Die reine Logik (Region-Geometrie, Preis-Parse, Preprocessing-Parameter +
// Graustufen-Transform) ist pure und testbar; die echte Bild-/OCR-Runtime
// (canvas-Crop + tesseract-Digit-Pass) ist injizierbar (createDefaultPriceCropOcr).
// ===========================================================================

/** Verwerfungsgründe des Preisbox-Crop-Passes (Region-, Parse- und Kandidatstufe). */
export type PriceCropRejectReason =
  /** Karte ergab gar keine geometrisch eindeutige Preisbox-Region. */
  | 'noCropRegion'
  /** Crop-OCR lief, lieferte aber keinen lesbaren/parsebaren Preis. */
  | 'cropOcrUnreadable'
  /** Crop-Bild konnte gar nicht gerendert/decodiert werden (z. B. WebP via
   *  node-canvas) — es lief KEIN OCR-Pass. Getrennt von cropOcrUnreadable, damit
   *  die Zählkette „Decode tot" nicht als „OCR unlesbar" tarnt. */
  | 'cropRenderFailed'
  /** Mehrere plausible Preise im Crop → nicht eindeutig. */
  | 'cropPriceAmbiguous'
  /** Crop-Preis erkannt, aber OCR-Confidence zu niedrig. */
  | 'cropPriceLowConfidence'
  /** Crop-Region/Inhalt ist ein Grundpreis (kein Angebotspreis). */
  | 'cropLooksLikeBasePrice'
  /** Crop-Region/Inhalt ist ein Datum/Rechts-/Adressnummer (kein Preis). */
  | 'cropLooksLikeDateOrLegal'
  /** Crop-Region liegt außerhalb/unklar zur Karte (Geometrie inkonsistent). */
  | 'cropOutsideCard'
  /** Preis geparst, aber die Karte trägt keinen brauchbaren Produktnamen. */
  | 'cropNoLinkedName';

/** Verwerfungs-Zählkette der Crop-Quelle: die Crop-spezifischen Vorstufen PLUS die
 *  geteilten Sicherheits-Gründe (lowConfidence/nameQuality/… nach Preis + Name). */
export interface LidlPriceCropRejectionCounts {
  noCropRegion: number;
  cropOcrUnreadable: number;
  cropRenderFailed: number;
  cropPriceAmbiguous: number;
  cropPriceLowConfidence: number;
  cropLooksLikeBasePrice: number;
  cropLooksLikeDateOrLegal: number;
  cropOutsideCard: number;
  cropNoLinkedName: number;
  // ── Geteiltes Sicherheits-Gate (nach Preis + verknüpftem Namen) ──
  lowConfidence: number;
  nameQuality: number;
  duplicate: number;
  nonFood: number;
  categoryConflict: number;
  missingStrongFoodEvidence: number;
}

export function emptyPriceCropRejections(): LidlPriceCropRejectionCounts {
  return {
    noCropRegion: 0,
    cropOcrUnreadable: 0,
    cropRenderFailed: 0,
    cropPriceAmbiguous: 0,
    cropPriceLowConfidence: 0,
    cropLooksLikeBasePrice: 0,
    cropLooksLikeDateOrLegal: 0,
    cropOutsideCard: 0,
    cropNoLinkedName: 0,
    lowConfidence: 0,
    nameQuality: 0,
    duplicate: 0,
    nonFood: 0,
    categoryConflict: 0,
    missingStrongFoodEvidence: 0,
  };
}

/** Warum eine Crop-Region als Preisbox-Kandidat gewählt wurde.
 *  - `prominentDigitTile`/`lowerRightDigitCluster`/`nearActionWord`: ziffern-ANKER-Pfad
 *    (das Seiten-OCR hat den Preis als ziffern-tragendes Wort erkannt).
 *  - `geometric*`: rein GEOMETRISCHER Fallback — die Region wird aus der Kartengeometrie
 *    abgeleitet, OHNE dass der Preis vorher als Wort/Ziffer erkannt sein muss (genau der
 *    belegte Blocker: die großen stilisierten Lidl-Aktionspreise werden zu Nicht-Ziffern-
 *    Glyphen verstümmelt). */
export type PriceCropRegionReason =
  | 'prominentDigitTile'
  | 'lowerRightDigitCluster'
  | 'nearActionWord'
  | 'geometricLowerRight'
  | 'geometricLowerCenterRight'
  | 'geometricBottomBand';

/** Trägt eine Region-Reason den geometrischen (anker-freien) Fallback? */
function isGeometricRegionReason(reason: PriceCropRegionReason): boolean {
  return reason.startsWith('geometric');
}

/** Eine aus einer Layout-Karte abgeleitete Preisbox-Crop-Region (Geometrie). */
export interface PriceCropRegion {
  /** Crop-Box in Bildkoordinaten (mit Padding, auf Seitenmaße geklemmt). */
  bbox: LayoutBox;
  reason: PriceCropRegionReason;
  /** Stabile Id der Karte, zu der die Region gehört. */
  linkedCardId: string;
  /** Wörter, die die Region berühren (Diagnose; gekappt). */
  nearbyWords: string[];
  accepted: boolean;
  /** Falls nicht akzeptiert: warum (Region-Stufe). */
  rejectReason?: Extract<
    PriceCropRejectReason,
    'noCropRegion' | 'cropLooksLikeBasePrice' | 'cropLooksLikeDateOrLegal' | 'cropOutsideCard'
  >;
}

/** Optionen der Crop-Preprocessing-/OCR-Stufe (vom Connector aus appConfig). */
export interface PriceCropOptions {
  /** Max. Crop-Regionen je Karte (Default 1 — die prominenteste Preisbox). */
  limitPerCard?: number;
  /** Max. Crop-OCR-Läufe je Seite (Kosten-Schranke, Default 6). */
  limitPerPage?: number;
  /** Min. Tesseract-Confidence (0–100) für einen sicheren Crop-Preis (Default 55). */
  minConfidence?: number;
  /** Upscale-Faktor-Override (sonst aus Boxgröße abgeleitet 2–4). */
  scale?: number;
  /** Binarisierungs-Schwellwert 0–255 (Default undefined = keine Binarisierung). */
  threshold?: number;
  /** Invertierung der Graustufen testen (Default false). */
  invert?: boolean;
  /** Tesseract PSM (Default 7 = single line). */
  psm?: number;
  /** Tesseract Zeichen-Whitelist (Default Ziffern + Preis-Trenner). */
  whitelist?: string;
}

/** Konkrete Preprocessing-/OCR-Parameter EINER Crop-Box (aus {@link PriceCropOptions}
 *  + Boxgröße abgeleitet). */
export interface PriceCropOcrOptions {
  scale: number;
  grayscale: boolean;
  contrast: number;
  threshold?: number;
  invert: boolean;
  whitelist: string;
  psm: number;
  /** Nur DEBUG: stabiler Tag (cardId + Strategie) für optionale Crop-Preview-Dateien.
   *  Die pure Crop-Logik ignoriert ihn; nur die reale Glue nutzt ihn als Dateinamen. */
  debugTag?: string;
}

export interface PriceCropOcrOutput {
  text: string;
  /** 0–100; tesseract-Gesamtconfidence des Crops. */
  confidence: number;
}

/** Injizierte Crop-OCR: crop + preprocess + tesseract-Digit-Pass EINER Region. */
export type PriceCropOcr = (
  imageBytes: Uint8Array,
  box: LayoutBox,
  opts: PriceCropOcrOptions,
) => Promise<PriceCropOcrOutput>;

/** Default-Zeichen-Whitelist des Crop-Passes: nur Ziffern + Preis-Trenner (kein
 *  Buchstabe), damit die ziffern-fokussierte Erkennung nicht von Resttext gestört
 *  wird. „€" und „-" erlauben „1,99 €" und Strich-Cents „1,-". */
const CROP_PRICE_WHITELIST = '0123456789,.-€ ';
const CROP_PROMINENCE_RATIO = 1.2;
const CROP_PADDING_RATIO = 0.15;
const CROP_MAX_NEARBY_WORDS = 12;

// ── Geometrischer Fallback-Finder (anker-frei) ───────────────────────────────
/** Absolute Mindest-Kantenlänge (px) einer geometrischen Crop-Region — verhindert
 *  winzige Einzelzeichen-Crops. */
const CROP_GEOMETRIC_MIN_PX = 28;
/** Mindestbreite/-höhe einer geometrischen Region relativ zur Kartengröße. */
const CROP_GEOMETRIC_MIN_W_RATIO = 0.18;
const CROP_GEOMETRIC_MIN_H_RATIO = 0.1;
/** Proximity-Gap (× Median-Schrifthöhe) zum Trennen von Content-Clustern in EINER
 *  Karte — damit eine zu groß zusammengeclusterte (Mehrprodukt-)Karte lokale
 *  Teil-Crops statt EINES Ganzkarten-Junk-Crops erzeugt. Gleiche Größenordnung wie
 *  die Karten-Clusterschwelle (mh×1.6), damit Content dort zerfällt, wo die Karte ohne
 *  überbrückende Namen ebenfalls zerfallen würde. */
const CROP_GEOMETRIC_CLUSTER_GAP = 1.6;
/** Max. geometrische Regionen je Karte (geordnete, robuste Varianten — der Runner
 *  testet sie der Reihe nach und stoppt beim ersten sicheren Preis). */
const CROP_GEOMETRIC_MAX_REGIONS = 3;

/** Stabile Karten-Id aus der Karten-Bounding-Box (für linkedCardId in der Evidence). */
export function layoutCardId(card: LayoutCard): string {
  const b = card.bbox;
  return `card_${Math.round(b.x)}_${Math.round(b.y)}_${Math.round(b.w)}x${Math.round(b.h)}`;
}

/** Trägt das Wort eine Ziffer (echtes Preis-Glyph)? Eine ECHTE Ziffer zählt immer
 *  (£08 / 3,98 / 15.6.). Die OCR-Digit-Korrektur I/l→1, O/o→0 wird NUR auf SEHR kurze
 *  Tokens (≤3 Zeichen) angewandt, um voll-verbuchstabte Großpreis-Glyphen („lOO",
 *  „O8") zu fangen — sonst würde ein langer Produktname mit o/l („Kartoffeln",
 *  „Heidelbeeren") fälschlich als Preis-Tile gelesen. */
function wordLooksDigitBearing(text: string): boolean {
  const cleaned = cleanOcrLine(text);
  if (/\d/.test(cleaned)) {
    return true;
  }
  const compact = cleaned.replace(/\s/g, '');
  return compact.length <= 3 && /\d/.test(ocrDigits(compact));
}

function boxesOverlap(a: LayoutBox, b: LayoutBox): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Klemmt eine Box auf die Seitenmaße (sofern > 0). Eine Box, deren Anker außerhalb
 *  der Seite liegt, kollabiert dabei zu w/h ≤ 0 (= cropOutsideCard). */
function clampBoxToPage(box: LayoutBox, page: { width: number; height: number }): LayoutBox {
  const maxRight = page.width > 0 ? page.width : box.x + box.w;
  const maxBottom = page.height > 0 ? page.height : box.y + box.h;
  const x = Math.max(0, Math.min(box.x, maxRight));
  const y = Math.max(0, Math.min(box.y, maxBottom));
  const right = Math.min(box.x + box.w, maxRight);
  const bottom = Math.min(box.y + box.h, maxBottom);
  return { x, y, w: right - x, h: bottom - y };
}

/** Räumliche Proximity-Clusterung einer kleinen Wortmenge (Union-Find), für die
 *  prominenten Preisbox-Glyphen einer Karte. */
function clusterByProximity(words: readonly OcrLayoutWord[], gapX: number, gapY: number): OcrLayoutWord[][] {
  const parent = words.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root];
    }
    let cursor = index;
    while (parent[cursor] !== root) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  for (let i = 0; i < words.length; i += 1) {
    for (let j = i + 1; j < words.length; j += 1) {
      if (boxGapX(words[i].bbox, words[j].bbox) <= gapX && boxGapY(words[i].bbox, words[j].bbox) <= gapY) {
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map<number, OcrLayoutWord[]>();
  for (let index = 0; index < words.length; index += 1) {
    const root = find(index);
    const bucket = groups.get(root) ?? [];
    bucket.push(words[index]);
    groups.set(root, bucket);
  }
  return [...groups.values()];
}

/**
 * Bestimmt Preisbox-Crop-Regionen EINER Karte aus der GEOMETRIE — in ZWEI Stufen:
 *
 *  1. Ziffern-ANKER-Pfad (präzise): Anker = prominente (großschriftige), ziffern-
 *     tragende Glyphen, die KEIN Datum/Rechts-/Grundpreis-/Pfand-Glyph sind — die
 *     stylisierten Großpreis-Tiles, sofern das Seiten-OCR sie ÜBERHAUPT als Ziffern
 *     gelesen hat. Bevorzugt (Scoring) den unteren/rechten Kartenbereich + Aktionswort.
 *
 *  2. Geometrischer FALLBACK (anker-frei, {@link determineGeometricPriceRegions}):
 *     greift, wenn KEIN prominenter Ziffern-Anker existiert, die Karte aber Nicht-
 *     Namens-/Nicht-Badge-Content trägt — genau der belegte Blocker (die großen Lidl-
 *     Preise werden zu Nicht-Ziffern-Glyphen verstümmelt, es entsteht kein Ziffern-
 *     Anker). Dann werden mehrere robuste Regionen pro Content-Cluster rein aus der
 *     Kartengeometrie erzeugt.
 *
 * Verworfen wird nur, wenn die Karte NUR Grundpreis/Pfand (cropLooksLikeBasePrice),
 * NUR ein Datum/Legal (cropLooksLikeDateOrLegal) oder gar keine plausible Preiszone
 * (noCropRegion) trägt. Erfindet nie eine Region aus einer leeren/reinen Textfläche.
 */
export function determinePriceCropRegions(
  card: LayoutCard,
  cardId: string,
  page: { width: number; height: number },
  opts: PriceCropOptions = {},
): PriceCropRegion[] {
  const limitPerCard = Math.max(1, opts.limitPerCard ?? 1);
  const words = card.words.filter((word) => cleanOcrLine(word.text).length > 0);
  const reject = (
    rejectReason: PriceCropRegion['rejectReason'],
    nearbyWords: string[],
  ): PriceCropRegion[] => [
    {
      bbox: card.bbox,
      reason: 'prominentDigitTile',
      linkedCardId: cardId,
      nearbyWords: nearbyWords.slice(0, CROP_MAX_NEARBY_WORDS),
      accepted: false,
      rejectReason,
    },
  ];
  if (words.length === 0) {
    return reject('noCropRegion', []);
  }
  const medianFont = median(words.map((word) => word.bbox.h)) || 1;

  // Grundpreis-/Pfand-Zeilen: deren Wörter dürfen NIE Preis-Anker sein (sonst würde
  // der Crop den Grundpreis re-lesen). Reihenweise über das geteilte Preis-Gate.
  const baseDepositWords = new Set<OcrLayoutWord>();
  for (const row of card.rows) {
    const token = findPriceToken(row.text);
    if (token && (priceIsBasePrice(row.text, token.index) || priceIsDeposit(row.text, token.index))) {
      for (const word of row.words) {
        baseDepositWords.add(word);
      }
    }
  }

  const digitWords = words.filter((word) => wordLooksDigitBearing(word.text));
  const anchorWords = digitWords.filter(
    (word) =>
      !isDateOrLegalToken(word.text) &&
      !baseDepositWords.has(word) &&
      word.bbox.h >= CROP_PROMINENCE_RATIO * medianFont,
  );
  if (anchorWords.length === 0) {
    const digitTexts = digitWords.map((word) => word.text);
    // KEIN prominenter Ziffern-Anker. Trägt die Karte aber NICHT-KLASSIFIZIERBAREN
    // Content (verstümmelte Preis-Glyphen, KEIN Name/Badge/Einheit/Grundpreis/Datum)?
    // Dann wurde der Preis-Tile nur als Nicht-Ziffern-Glyph gelesen → geometrischer
    // Fallback (Regionen rein aus der Kartengeometrie). Sonst die ehrliche Feinursache.
    const geometric = determineGeometricPriceRegions(card, cardId, page, medianFont, baseDepositWords, opts);
    if (geometric.some((region) => region.accepted)) {
      return geometric;
    }
    if (digitWords.length > 0 && digitWords.every((word) => isDateOrLegalToken(word.text))) {
      return reject('cropLooksLikeDateOrLegal', digitTexts);
    }
    if (
      digitWords.length > 0 &&
      digitWords.every((word) => baseDepositWords.has(word) || isDateOrLegalToken(word.text))
    ) {
      return reject('cropLooksLikeBasePrice', digitTexts);
    }
    return reject('noCropRegion', digitTexts);
  }

  const gap = 1.6 * medianFont;
  const clusters = clusterByProximity(anchorWords, gap, gap);
  const hasAction = actionWordNearby(card);
  const cardCenterX = boxCenterX(card.bbox);
  const cardLowerY = card.bbox.y + card.bbox.h * 0.4;

  const scored = clusters.map((cluster) => {
    const core = unionBox(cluster.map((word) => word.bbox));
    const padX = core.w * CROP_PADDING_RATIO + medianFont * 0.5;
    const padY = core.h * CROP_PADDING_RATIO + medianFont * 0.5;
    const padded: LayoutBox = {
      x: core.x - padX,
      y: core.y - padY,
      w: core.w + 2 * padX,
      h: core.h + 2 * padY,
    };
    const clamped = clampBoxToPage(padded, page);
    const lowerOrRight = boxCenterY(core) >= cardLowerY || boxCenterX(core) >= cardCenterX;
    const fontSum = cluster.reduce((sum, word) => sum + word.bbox.h, 0);
    const score = fontSum + (lowerOrRight ? medianFont : 0) + (hasAction ? medianFont : 0);
    const reason: PriceCropRegionReason = hasAction
      ? 'nearActionWord'
      : lowerOrRight
        ? 'lowerRightDigitCluster'
        : 'prominentDigitTile';
    const nearbyWords = words
      .filter((word) => boxesOverlap(word.bbox, padded))
      .map((word) => word.text)
      .slice(0, CROP_MAX_NEARBY_WORDS);
    if (clamped.w <= 0 || clamped.h <= 0) {
      return {
        score,
        region: {
          bbox: clamped,
          reason,
          linkedCardId: cardId,
          nearbyWords,
          accepted: false,
          rejectReason: 'cropOutsideCard' as const,
        } satisfies PriceCropRegion,
      };
    }
    return {
      score,
      region: { bbox: clamped, reason, linkedCardId: cardId, nearbyWords, accepted: true } satisfies PriceCropRegion,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  const accepted = scored.filter((entry) => entry.region.accepted).slice(0, limitPerCard).map((entry) => entry.region);
  // Alle Cluster kollabierten beim Clampen (Anker außerhalb der Seite) → der
  // höchstbewertete cropOutsideCard-Eintrag trägt die Ursache.
  return accepted.length > 0 ? accepted : [scored[0].region];
}

/** Wächst eine Crop-Region auf eine Mindestgröße (um den Mittelpunkt) und SCHIEBT sie
 *  in die Seite hinein (statt sie am Rand zu beschneiden), damit eine spekulative
 *  Region nie zu einem winzigen Einzelzeichen-Crop kollabiert. Auf Seitenmaße gekappt. */
function fitGeometricRegion(
  box: LayoutBox,
  minW: number,
  minH: number,
  page: { width: number; height: number },
): LayoutBox {
  const pageW = page.width > 0 ? page.width : box.x + box.w;
  const pageH = page.height > 0 ? page.height : box.y + box.h;
  const w = Math.min(Math.max(box.w, minW), pageW);
  const h = Math.min(Math.max(box.h, minH), pageH);
  const cx = boxCenterX(box);
  const cy = boxCenterY(box);
  const x = Math.max(0, Math.min(cx - w / 2, pageW - w));
  const y = Math.max(0, Math.min(cy - h / 2, pageH - h));
  return { x, y, w, h };
}

/**
 * Geometrischer (anker-freier) Preisbox-Finder — der Kern des Fixes. Leitet Crop-
 * Regionen aus der KARTENGEOMETRIE ab, OHNE dass der Preis vom Seiten-OCR als Wort/
 * Ziffer erkannt sein muss (belegter Blocker: die großen stilisierten Lidl-Aktions-
 * preise werden zu Nicht-Ziffern-Glyphen verstümmelt). Vorgehen:
 *
 *  • Content = Wörter, die WEDER ein Namens- NOCH ein Badge-Wort sind (Top-left-Badges
 *    wie „3 Stück"/„kernarm"/„%"/„Bonus" sind nie Teil einer Region und nie ein Name).
 *  • Hat die Karte keinen solchen Content → keine plausible Preiszone → noCropRegion
 *    (eine reine Text-/Überschriftskarte bekommt keinen erfundenen Crop).
 *  • Sonst werden die Content-Wörter lokal geclustert (große Mehrprodukt-Karten
 *    zerfallen in Teilbereiche statt EINES Ganzkarten-Junk-Crops) und je Cluster
 *    mehrere robuste, auf Mindestgröße gewachsene Regionen erzeugt (lower-right,
 *    breite untere Aktionspreis-Zone, lower-center-right) — geordnet best→Fallback.
 *
 * Rein geometrisch: der Preis selbst kommt erst aus der (strengen) Crop-OCR
 * ({@link parseCropPrice}), der Name aus {@link deriveCardName}.
 */
function determineGeometricPriceRegions(
  card: LayoutCard,
  cardId: string,
  page: { width: number; height: number },
  medianFont: number,
  baseDepositWords: ReadonlySet<OcrLayoutWord>,
  opts: PriceCropOptions = {},
): PriceCropRegion[] {
  const maxRegions = Math.max(1, opts.limitPerCard ?? CROP_GEOMETRIC_MAX_REGIONS);
  const nameRows = card.rows.filter((row) => isLayoutNameRow(row, card));
  const nameWords = new Set(nameRows.flatMap((row) => row.words));
  const badgeWords = new Set(
    card.rows.filter((row) => isLayoutBadgeRow(row, card)).flatMap((row) => row.words),
  );
  // Content = genau die NICHT-klassifizierbaren Glyphen (der verstümmelte Preis-Tile).
  // Ausgeschlossen sind Namen, Badges, Einheiten/Header/Einzelzeichen, Promo-Verbindungs-
  // text, bekannte Attribut-Wörter sowie Grundpreis-/Pfand- und Datum-/Legal-Glyphen —
  // damit nie eine Einheit, ein Attribut oder ein Grundpreis spekulativ gecroppt wird.
  const isContentWord = (word: OcrLayoutWord): boolean => {
    if (cleanOcrLine(word.text).length === 0) {
      return false;
    }
    if (nameWords.has(word) || badgeWords.has(word) || baseDepositWords.has(word)) {
      return false;
    }
    if (isDateOrLegalToken(word.text) || isIgnoredOcrLine(word.text) || isConnectiveNoise(word.text)) {
      return false;
    }
    const norm = normalizeText(word.text);
    return !(norm.length > 0 && !norm.includes(' ') && GENERIC_FRAGMENT_TOKENS.has(norm));
  };
  const contentWords = card.words.filter(isContentWord);
  if (contentWords.length === 0) {
    // Reine Text-/Namenskarte (oder nur Badges) → keine plausible Preiszone.
    return [
      {
        bbox: card.bbox,
        reason: 'geometricBottomBand',
        linkedCardId: cardId,
        nearbyWords: nameRows.map((row) => row.text).slice(0, CROP_MAX_NEARBY_WORDS),
        accepted: false,
        rejectReason: 'noCropRegion',
      },
    ];
  }

  const gap = CROP_GEOMETRIC_CLUSTER_GAP * medianFont;
  const clusters = clusterByProximity(contentWords, gap, gap);
  const hasAction = actionWordNearby(card);
  const cardCenterX = boxCenterX(card.bbox);
  const cardLowerY = card.bbox.y + card.bbox.h * 0.4;
  const minW = Math.max(CROP_GEOMETRIC_MIN_PX, card.bbox.w * CROP_GEOMETRIC_MIN_W_RATIO, 3 * medianFont);
  const minH = Math.max(CROP_GEOMETRIC_MIN_PX * 0.6, card.bbox.h * CROP_GEOMETRIC_MIN_H_RATIO, 1.5 * medianFont);

  // Je Content-Cluster (Produkt) ein eigener, geordneter Satz robuster Region-Varianten.
  // Cluster-weise gruppiert (nicht global gemischt), damit bei einer Mehrprodukt-Karte
  // JEDER Cluster eigene Teil-Crops behält statt von einem großen Cluster verdrängt zu
  // werden.
  const perCluster: { clusterScore: number; regions: PriceCropRegion[]; fallback: PriceCropRegion }[] = [];
  for (const cluster of clusters) {
    const core = unionBox(cluster.map((word) => word.bbox));
    const padX = core.w * CROP_PADDING_RATIO + medianFont * 0.5;
    const padY = core.h * CROP_PADDING_RATIO + medianFont * 0.5;
    const probe: LayoutBox = {
      x: core.x - padX,
      y: core.y - padY,
      w: core.w + 2 * padX,
      h: core.h + 2 * padY,
    };
    const nearbyWords = card.words
      .filter((word) => boxesOverlap(word.bbox, probe))
      .map((word) => word.text)
      .slice(0, CROP_MAX_NEARBY_WORDS);
    const lowerOrRight = boxCenterY(core) >= cardLowerY || boxCenterX(core) >= cardCenterX;
    const clusterScore = core.w * core.h + (lowerOrRight ? medianFont : 0) + (hasAction ? medianFont : 0);
    // Lokale (cluster-relative) Varianten — nie der Ganzkarten-Bereich, damit eine
    // große/zusammengeclusterte Karte sinnvolle Teil-Crops statt eines Junk-Crops
    // erzeugt. Bonus ordnet best→Fallback.
    const variants: { reason: PriceCropRegionReason; box: LayoutBox; bonus: number }[] = [
      {
        reason: 'geometricLowerRight',
        box: { x: core.x - padX, y: core.y - padY, w: core.w * 1.4 + 2 * padX, h: core.h * 1.3 + 2 * padY },
        bonus: 2,
      },
      {
        reason: 'geometricBottomBand',
        box: {
          x: core.x - core.w * 0.4 - padX,
          y: core.y - padY,
          w: core.w * 1.8 + 2 * padX,
          h: core.h * 1.2 + 2 * padY,
        },
        bonus: 1,
      },
      {
        reason: 'geometricLowerCenterRight',
        box: { x: core.x - padX, y: core.y - padY, w: core.w + 2 * padX, h: core.h + 2 * padY },
        bonus: 0,
      },
    ];
    const sortedVariants = [...variants].sort((a, b) => b.bonus - a.bonus);
    const regions: PriceCropRegion[] = [];
    let fallback: PriceCropRegion | null = null;
    for (const variant of sortedVariants.slice(0, maxRegions)) {
      const fitted = fitGeometricRegion(variant.box, minW, minH, page);
      if (fitted.w <= 0 || fitted.h <= 0) {
        fallback ??= {
          bbox: fitted,
          reason: variant.reason,
          linkedCardId: cardId,
          nearbyWords,
          accepted: false,
          rejectReason: 'cropOutsideCard',
        };
        continue;
      }
      regions.push({ bbox: fitted, reason: variant.reason, linkedCardId: cardId, nearbyWords, accepted: true });
    }
    perCluster.push({
      clusterScore,
      regions,
      fallback: fallback ?? {
        bbox: clampBoxToPage(probe, page),
        reason: 'geometricLowerRight',
        linkedCardId: cardId,
        nearbyWords,
        accepted: false,
        rejectReason: 'cropOutsideCard',
      },
    });
  }
  // Beste Cluster zuerst; je Cluster die geordneten Varianten. So testet der Runner pro
  // Karte best→Fallback und über die Cluster hinweg jedes Produkt.
  perCluster.sort((a, b) => b.clusterScore - a.clusterScore);
  const accepted = perCluster.flatMap((entry) => entry.regions);
  return accepted.length > 0 ? accepted : [perCluster[0].fallback];
}

/** Leitet den Produktnamen einer Karte für einen Crop-Preis ab — aus den Layout-
 *  Text-Words (NICHT aus dem Crop). Nimmt die 1–2 zum Crop-Anker nächsten echten
 *  Namenszeilen (analog zu {@link buildLayoutCandidateFromCard}). */
export function deriveCardName(card: LayoutCard, anchorY: number): string | null {
  const nameRows = card.rows.filter((row) => isLayoutNameRow(row, card));
  if (nameRows.length === 0) {
    return null;
  }
  const nearest = [...nameRows]
    .sort((a, b) => Math.abs(boxCenterY(a.bbox) - anchorY) - Math.abs(boxCenterY(b.bbox) - anchorY))
    .slice(0, 2)
    .sort((a, b) => a.bbox.y - b.bbox.y);
  const name = cleanOfferName(nearest.map((row) => row.text).join(' '));
  return name.length >= 3 ? name : null;
}

// „-,99" — Strich-Euro (unter 1 €): der Euro-Platz ist durch einen Strich ersetzt.
const PRICE_DASH_EURO = new RegExp(`(^|[^\\w])[-–]\\s*[,.]\\s*(${PRICE_DIGIT}{2})(?=$|[^\\w])`);

/** Sammelt ALLE plausiblen ANGEBOTS-Preise (0,10–99 €) aus einem Crop-Text, über
 *  alle Schreibweisen (Dezimal / Strich-Cents / Strich-Euro / Leerzeichen). Grund-
 *  preis-/Pfand-Token (vor „=", nach „zzgl." …) werden ausgeschlossen und separat
 *  vermerkt. Mehrere DISTINKTE Werte = mehrdeutig. */
function collectCropPrices(clean: string): { values: number[]; hadBaseOrDeposit: boolean } {
  const values: number[] = [];
  let hadBaseOrDeposit = false;
  const consider = (price: number, index: number): void => {
    if (!Number.isFinite(price) || price < 0.1 || price > 99) {
      return;
    }
    if (priceIsBasePrice(clean, index) || priceIsDeposit(clean, index)) {
      hadBaseOrDeposit = true;
      return;
    }
    const rounded = Number(price.toFixed(2));
    if (!values.includes(rounded)) {
      values.push(rounded);
    }
  };
  const scan = (
    source: RegExp,
    build: (match: RegExpMatchArray) => { euro: string; cent: string },
  ): void => {
    const globalRe = new RegExp(source.source, 'g');
    for (const match of clean.matchAll(globalRe)) {
      const lead = match[1] ?? '';
      const index = (match.index ?? 0) + lead.length;
      const { euro, cent } = build(match);
      consider(Number(`${euro}.${cent}`), index);
    }
  };
  scan(PRICE_DECIMAL, (m) => ({ euro: ocrDigits(m[2]), cent: ocrDigits(m[3]) }));
  scan(PRICE_DASH, (m) => ({ euro: ocrDigits(m[2]), cent: '00' }));
  scan(PRICE_DASH_EURO, (m) => ({ euro: '0', cent: ocrDigits(m[2]) }));
  scan(PRICE_SPACE, (m) => ({ euro: ocrDigits(m[2]), cent: ocrDigits(m[3]) }));
  return { values, hadBaseOrDeposit };
}

export interface PriceCropParseOptions {
  /** Min. Tesseract-Confidence (0–100) für einen sicheren Preis (Default 55). */
  minConfidence?: number;
}

export type PriceCropParseResult =
  | { ok: true; price: number; raw: string }
  | {
      ok: false;
      reason: Extract<
        PriceCropRejectReason,
        'cropOcrUnreadable' | 'cropPriceAmbiguous' | 'cropPriceLowConfidence' | 'cropLooksLikeBasePrice' | 'cropLooksLikeDateOrLegal'
      >;
    };

/**
 * Parst einen Crop-OCR-Text SICHER zu einem Angebotspreis. Akzeptiert nur klare,
 * EINDEUTIGE Preisformen (1,99 / 1.99 / „1 99" / 1,- / -,99 / getrennte Euro/Cent).
 * Verwirft Grundpreis/Pfand, Datums-/Rechts-/Adressnummern, zu niedrige Confidence
 * und MEHRERE plausible Preise (mehrdeutig). Errät NIE einen Preis aus kaputten
 * Glyphen.
 */
export function parseCropPrice(
  text: string,
  confidence: number | undefined,
  options: PriceCropParseOptions = {},
): PriceCropParseResult {
  const minConfidence = options.minConfidence ?? 55;
  const clean = cleanOcrLine(text);
  if (clean.length === 0) {
    return { ok: false, reason: 'cropOcrUnreadable' };
  }
  const { values, hadBaseOrDeposit } = collectCropPrices(clean);
  if (values.length === 0) {
    if (hadBaseOrDeposit) {
      return { ok: false, reason: 'cropLooksLikeBasePrice' };
    }
    const tokens = clean.split(' ').filter(Boolean);
    if (tokens.length > 0 && tokens.every((token) => isDateOrLegalToken(token))) {
      return { ok: false, reason: 'cropLooksLikeDateOrLegal' };
    }
    return { ok: false, reason: 'cropOcrUnreadable' };
  }
  if (values.length > 1) {
    return { ok: false, reason: 'cropPriceAmbiguous' };
  }
  if (confidence !== undefined && confidence < minConfidence) {
    return { ok: false, reason: 'cropPriceLowConfidence' };
  }
  const price = values[0];
  return { ok: true, price, raw: price.toFixed(2).replace('.', ',') };
}

/** Leitet die Preprocessing-/OCR-Parameter EINER Crop-Box ab: kleine Boxen werden
 *  stärker hochskaliert (mehr Pixel für die Ziffern). Konservative Defaults. */
export function derivePriceCropOcrOptions(box: LayoutBox, opts: PriceCropOptions = {}): PriceCropOcrOptions {
  const longSide = Math.max(box.w, box.h);
  const scale = opts.scale ?? (longSide <= 80 ? 4 : longSide <= 160 ? 3 : 2);
  return {
    scale: Math.max(1, Math.min(4, scale)),
    grayscale: true,
    contrast: 1.4,
    threshold: opts.threshold,
    invert: opts.invert ?? false,
    whitelist: opts.whitelist ?? CROP_PRICE_WHITELIST,
    psm: opts.psm ?? 7,
  };
}

/**
 * Pure Crop-Preprocessing-Transform auf einem RGBA-Pixelpuffer (IN-PLACE): Graustufen
 * (Luminanz) + Kontrast um 128, optional Binarisierung (Schwellwert) und Invertierung.
 * Testbar ohne canvas — die echte canvas-Glue ruft sie zwischen getImageData/
 * putImageData auf. Alpha bleibt unberührt.
 */
export function applyGrayscaleContrast(
  rgba: Uint8ClampedArray | Uint8Array,
  opts: { contrast?: number; threshold?: number; invert?: boolean } = {},
): void {
  const contrast = opts.contrast ?? 1;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    let v = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    v = (v - 128) * contrast + 128;
    if (opts.threshold !== undefined) {
      v = v >= opts.threshold ? 255 : 0;
    }
    if (opts.invert) {
      v = 255 - v;
    }
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    rgba[i] = v;
    rgba[i + 1] = v;
    rgba[i + 2] = v;
  }
}

/** EIN tesseract-Lauf (deu+eng) über ein Prospektbild → Text + Wort-Bounding-Boxen.
 *  Konvertiert die Bytes zur Laufzeit in einen node-`Buffer` (über globalThis, ohne
 *  den Typ in dieser Schicht zu referenzieren). Die Runtime-Beschaffung (Modul +
 *  Worker) ist vom eigentlichen recognize getrennt: scheitert sie, ist die
 *  OCR-RUNTIME nicht verfügbar (`OcrRuntimeUnavailableError`) — ein anderer,
 *  ehrlich zu meldender Zustand als ein OCR-Fehler auf einem einzelnen Bild. */
/** Behält ein Roh-Wort nur, wenn es einen nicht-leeren Text trägt. Die bbox darf
 *  fehlen/ungültig sein — das fällt erst in {@link wordsToLayoutPage} als
 *  Normalisierungsverlust auf (eigener, ehrlicher Befund). */
function hasUsableText(word: MinimalOcrWord | undefined | null): word is MinimalOcrWord {
  return !!word && typeof word.text === 'string' && word.text.trim().length > 0;
}

/** Flacht die tesseract.js-v7-`data.blocks`-Hierarchie (blocks → paragraphs →
 *  lines → words) zu einer flachen Wortliste ab. Defensiv gegen fehlende Ebenen. */
function flattenBlocksWords(blocks: readonly MinimalOcrBlock[]): MinimalOcrWord[] {
  const out: MinimalOcrWord[] = [];
  for (const block of blocks) {
    for (const paragraph of block?.paragraphs ?? []) {
      for (const line of paragraph?.lines ?? []) {
        for (const word of line?.words ?? []) {
          if (hasUsableText(word)) {
            out.push(word);
          }
        }
      }
    }
  }
  return out;
}

/** Parst tesseract.js-TSV (Spalten: level, page, block, par, line, word, left, top,
 *  width, height, conf, text) zu Wortboxen. NUR Wort-Ebene (level 5). Ungültige/zu
 *  kurze Zeilen werden verworfen; Koordinaten unverändert übernommen (kein Scaling). */
function parseTsvWords(tsv: string): MinimalOcrWord[] {
  const out: MinimalOcrWord[] = [];
  for (const rawLine of tsv.split(/\r?\n/)) {
    if (!rawLine) {
      continue;
    }
    const cols = rawLine.split('\t');
    if (cols.length < 12) {
      continue; // ungültige TSV-Zeile (Header/Teilzeile) verwerfen
    }
    if (Number(cols[0]) !== 5) {
      continue; // nur die Wort-Ebene trägt eine echte Wortbox
    }
    const left = Number(cols[6]);
    const top = Number(cols[7]);
    const width = Number(cols[8]);
    const height = Number(cols[9]);
    const conf = Number(cols[10]);
    const text = cols.slice(11).join('\t').trim();
    if (text.length === 0) {
      continue;
    }
    if (![left, top, width, height].every((v) => Number.isFinite(v))) {
      continue;
    }
    out.push({
      text,
      bbox: { x0: left, y0: top, x1: left + width, y1: top + height },
      confidence: Number.isFinite(conf) ? conf : undefined,
    });
  }
  return out;
}

/**
 * Robuste Wortbox-Extraktion aus einem tesseract.js-`data`-Objekt. Reihenfolge nach
 * abnehmender Zuverlässigkeit:
 *   (1) `data.blocks` flatten (v7-Standardweg bei `blocks:true`),
 *   (2) Legacy top-level `data.words` (ältere Versionen / Mocks),
 *   (3) `data.tsv` parsen (falls blocks/words fehlen).
 * Koordinaten werden NICHT skaliert/verschoben. Liefert zusätzlich die Struktur-
 * Diagnose (welche Quelle gewann, wie viele Wörter blocks/TSV trugen), damit die
 * Zählkette `noStructuredOutputAvailable`/`noWordBoxesFromOcr` unterscheiden kann.
 */
export function extractOcrWordBoxes(data: MinimalRecognizeData): LidlOcrWordExtraction {
  const blocksPresent = Array.isArray(data.blocks);
  const blockWords = blocksPresent ? flattenBlocksWords(data.blocks as MinimalOcrBlock[]) : [];
  const tsvPresent = typeof data.tsv === 'string' && data.tsv.trim().length > 0;
  const tsvWords = tsvPresent ? parseTsvWords(data.tsv as string) : [];
  const topLevelWords = Array.isArray(data.words) ? data.words.filter(hasUsableText) : [];

  let words: MinimalOcrWord[] = [];
  let wordBoxSource: LidlOcrWordBoxSource = 'none';
  if (blockWords.length > 0) {
    words = blockWords;
    wordBoxSource = 'blocks';
  } else if (topLevelWords.length > 0) {
    words = topLevelWords;
    wordBoxSource = 'topLevelWords';
  } else if (tsvWords.length > 0) {
    words = tsvWords;
    wordBoxSource = 'tsv';
  }

  return {
    words,
    wordBoxSource,
    blocksPresent,
    blockWordCount: blockWords.length,
    tsvPresent,
    tsvWordCount: tsvWords.length,
  };
}

async function recognizeLidlImage(
  imageBytes: Uint8Array,
): Promise<{ text: string } & LidlOcrWordExtraction> {
  const nodeBuffer = (globalThis as { Buffer?: { from(b: Uint8Array): Uint8Array } }).Buffer;
  const image = nodeBuffer ? nodeBuffer.from(imageBytes) : imageBytes;
  let worker: MinimalOcrWorker;
  try {
    const tesseract = await loadTesseractModule();
    worker = await tesseract.createWorker('deu+eng');
  } catch (error) {
    throw new OcrRuntimeUnavailableError(
      `tesseract.js-OCR-Runtime nicht verfügbar: ${
        error instanceof Error ? error.message : 'unbekannter Fehler'
      }`,
    );
  }
  try {
    // tesseract.js v7: Text UND strukturierte Word-/Blockdaten in EINEM Lauf
    // anfordern. Der v7-Default liefert NUR `text`; ohne den Output-Schalter bleibt
    // `data.blocks`/`data.tsv` leer → die frühere `data.words`-Lesung lief auf 0
    // Wortboxen (genau der belegte Root Cause). 2. Arg = recognize-Optionen (leer),
    // 3. Arg = Output-Schalter. Ältere Versionen/Mocks ignorieren die Extra-Args und
    // liefern weiter `data.text` (+ ggf. `data.words`) — robust behandelt. KEIN
    // zweiter OCR-Lauf.
    const result = await worker.recognize(image, {}, { text: true, blocks: true, tsv: true });
    const data: MinimalRecognizeData = result?.data ?? {};
    return { text: data.text ?? '', ...extractOcrWordBoxes(data) };
  } finally {
    await worker.terminate();
  }
}

/** Default-OCR über ein Prospektbild (nur Text). Läuft nur im Node-Backend zur
 *  Scan-Zeit, wenn LIDL_OCR_MODE != off. */
export async function defaultLidlOcrImage(imageBytes: Uint8Array): Promise<string> {
  return (await recognizeLidlImage(imageBytes)).text;
}

/** Wandelt tesseract-Wortboxen (data.words; je Wort `bbox{x0,y0,x1,y1}` in
 *  Bildpixeln + confidence) in eine layout-analysierte Seite. Die internen
 *  Layout-Boxen liegen in DENSELBEN Bildkoordinaten wie die Tesseract-Boxen
 *  (`x=x0, y=y0, w=x1-x0, h=y1-y0`) — keine Skalierung, keine Verschiebung —, damit
 *  der Cluster-/Karten-Extractor mit den OCR-Koordinaten rechnet. Seitenmaße aus den
 *  Wortkoordinaten abgeleitet (für die relativen Cluster-Schwellen genügt das).
 *  KEINE Farb-/Pixelanalyse (Promo-Farb-Tag bleibt leer) — die Heuristik trägt über
 *  Position + Schriftgröße.
 *
 *  Rückgabe-Semantik (für die ehrliche Layout-Diagnose):
 *   • Tesseract lieferte 0 Roh-Boxen → `null` (= `noWordBoxesFromOcr`).
 *   • Roh-Boxen kamen, fielen aber ALLE bei der Normalisierung weg (fehlender
 *     Text/keine bbox) → Seite MIT `words: []` + `sourceWordCount` der Roh-Boxen,
 *     damit die Zählkette `wordBoxesDroppedDuringNormalization` belegen kann (statt
 *     es als „keine Boxen" zu verschleiern). */
export function wordsToLayoutPage(words: readonly MinimalOcrWord[]): OcrLayoutPage | null {
  const rawWordCount = words.length;
  const layoutWords: OcrLayoutWord[] = words
    .filter((word) => typeof word.text === 'string' && Boolean(word.bbox))
    .map((word) => ({
      text: word.text,
      bbox: {
        x: word.bbox.x0,
        y: word.bbox.y0,
        w: Math.max(0, word.bbox.x1 - word.bbox.x0),
        h: Math.max(0, word.bbox.y1 - word.bbox.y0),
      },
      confidence: word.confidence,
    }));
  if (layoutWords.length === 0) {
    // Keine verwertbaren Boxen. War schon die Rohmenge leer, gab es schlicht keine
    // (null). Kamen Roh-Boxen und fielen erst hier weg, das ehrlich als leere Seite
    // MIT sourceWordCount tragen (Normalisierungsverlust ist ein eigener Befund).
    return rawWordCount === 0 ? null : { width: 0, height: 0, words: [], sourceWordCount: rawWordCount };
  }
  return {
    width: Math.max(...layoutWords.map((word) => boxRight(word.bbox))),
    height: Math.max(...layoutWords.map((word) => boxBottom(word.bbox))),
    words: layoutWords,
    sourceWordCount: rawWordCount,
  };
}

/** Wandelt EIN Recognize-Ergebnis in eine Layout-Seite UND hängt die Struktur-
 *  Diagnose des Laufs an (woher die Wortboxen kamen, ob blocks/tsv vorlagen). Lieferte
 *  der Lauf KEINE verwertbaren Wörter, wird trotzdem eine leere Seite MIT der Diagnose
 *  getragen (statt `null`) — so kann die Zählkette `noStructuredOutputAvailable`
 *  (blocks/tsv fehlten) von `noWordBoxesFromOcr` (angefordert, aber leer) trennen. */
function recognitionToLayoutPage(rec: LidlOcrWordExtraction): OcrLayoutPage {
  const diag = {
    structuredOutputRequested: true,
    wordBoxSource: rec.wordBoxSource,
    blocksPresent: rec.blocksPresent,
    blockWordCount: rec.blockWordCount,
    tsvPresent: rec.tsvPresent,
    tsvWordCount: rec.tsvWordCount,
  };
  const base = wordsToLayoutPage(rec.words);
  if (base) {
    return { ...base, ...diag };
  }
  return { width: 0, height: 0, words: [], sourceWordCount: 0, ...diag };
}

/** Default-Layoutanalyse über ein Prospektbild (eigener tesseract-Lauf). */
export async function defaultLidlOcrLayout(imageBytes: Uint8Array): Promise<OcrLayoutPage | null> {
  return recognitionToLayoutPage(await recognizeLidlImage(imageBytes));
}

/** Erzeugt ein gekoppeltes (ocrImage, ocrLayout)-Paar, das je Bild-URL EINEN
 *  tesseract-Lauf teilt (Memo) — so liefert der Layout-Pfad zusätzlich Wortboxen,
 *  ohne das Bild ein zweites Mal zu OCR-en. Für reale Scans gedacht; in Tests wird
 *  stattdessen injiziert. */
export function createDefaultLidlOcrPair(): {
  ocrImage: (imageBytes: Uint8Array, imageUrl: string) => Promise<string>;
  ocrLayout: (imageBytes: Uint8Array, imageUrl: string) => Promise<OcrLayoutPage | null>;
} {
  type Recognition = { text: string } & LidlOcrWordExtraction;
  const cache = new Map<string, Promise<Recognition>>();
  const run = (imageBytes: Uint8Array, imageUrl: string): Promise<Recognition> => {
    let pending = cache.get(imageUrl);
    if (!pending) {
      pending = recognizeLidlImage(imageBytes);
      cache.set(imageUrl, pending);
    }
    return pending;
  };
  return {
    ocrImage: async (imageBytes, imageUrl) => (await run(imageBytes, imageUrl)).text,
    ocrLayout: async (imageBytes, imageUrl) => recognitionToLayoutPage(await run(imageBytes, imageUrl)),
  };
}

// ===========================================================================
// PREISBOX-CROP-ORCHESTRIERUNG + reale canvas/tesseract-Glue.
// ===========================================================================

/** Ergebnis des Preisbox-Crop-Passes über alle Layout-Seiten eines Laufs. */
export interface LidlPriceCropResult {
  /** Sichere, deduplizierte Crop-Kandidaten (sourceKind='price_crop'). */
  offers: RawOfferCandidate[];
  /** Crop-OCR-Versuche (akzeptierte Regionen × OCR). */
  priceCropAttempts: number;
  /** Crops mit nicht-leerem OCR-Text. */
  priceCropOcrSucceeded: number;
  /** Crops mit sicher geparstem, EINDEUTIGEM Preis. */
  priceCropParsedPrices: number;
  /** Roh-Kandidaten (Crop-Preis + verknüpfter Kartenname) VOR dem Sicherheits-Gate. */
  cropRawCandidates: number;
  /** Nach Gate + Dedupe verbleibende sichere Crop-Kandidaten. */
  cropSafeCandidates: number;
  /** Davon: Crop-OCR-Versuche aus dem GEOMETRISCHEN (anker-freien) Fallback-Finder. */
  geometricCropAttempts: number;
  /** Davon: sicher geparste Preise aus dem geometrischen Fallback-Finder. */
  geometricCropParsedPrices: number;
  rejections: LidlPriceCropRejectionCounts;
}

/** Ein roh geparster Crop-Kandidat (Preis + Kartenname), VOR Gate/Dedupe. */
interface CropRawCandidate {
  name: string;
  price: number;
  unit?: string;
  imageUrl?: string;
  cardId: string;
  confidence: number;
}

/** Ergebnis der Crop-Auswertung EINER Layout-Seite (Region-/Parse-Stufen schon
 *  bilanziert; die geteilte Gate-/Dedupe-Stufe folgt zentral nach dem Bild-Loop,
 *  damit gegen Text- + Layout-Treffer dedupliziert werden kann). */
interface PriceCropPageOutcome {
  rawCandidates: CropRawCandidate[];
  attempts: number;
  ocrSucceeded: number;
  parsedPrices: number;
  /** Davon aus dem geometrischen (anker-freien) Fallback-Finder. */
  geometricAttempts: number;
  geometricParsedPrices: number;
  /** Nur die Region-/Parse-/noLinkedName-Stufen (Gate-Stufen bleiben 0). */
  rejections: LidlPriceCropRejectionCounts;
  evidence: PriceCropCardEvidence[];
}

function regionEvidenceBase(region: PriceCropRegion): PriceCropRegionEvidence {
  return {
    bbox: region.bbox,
    reason: region.reason,
    accepted: region.accepted,
    rejectReason: region.rejectReason,
    nearbyWords: region.nearbyWords,
  };
}

/**
 * Crop-Pass EINER Layout-Seite: clustert Karten, sucht NUR bei Karten OHNE sauberen
 * Angebotspreis (noPriceRegion / basePrice) geometrische Preisbox-Regionen, OCRt die
 * akzeptierten Regionen separat (injizierte Crop-OCR) und parst den Preis SICHER.
 * Liefert Roh-Kandidaten (Preis + Kartenname) plus die Region-/Parse-Bilanz + die
 * Debug-Evidence. Das Sicherheits-Gate + Dedupe folgen zentral.
 */
async function runPriceCropForPage(args: {
  page: OcrLayoutPage;
  imageBytes: Uint8Array;
  imageUrl?: string;
  cropOcr: PriceCropOcr;
  cropOptions: PriceCropOptions;
}): Promise<PriceCropPageOutcome> {
  const { page, imageBytes, imageUrl, cropOcr, cropOptions } = args;
  const out: PriceCropPageOutcome = {
    rawCandidates: [],
    attempts: 0,
    ocrSucceeded: 0,
    parsedPrices: 0,
    geometricAttempts: 0,
    geometricParsedPrices: 0,
    rejections: emptyPriceCropRejections(),
    evidence: [],
  };
  const limitPerPage = Math.max(0, cropOptions.limitPerPage ?? 6);
  const minConfidence = cropOptions.minConfidence ?? 55;
  if (limitPerPage === 0) {
    return out;
  }
  const cards = clusterWordsIntoCards(page);
  for (const card of cards) {
    if (out.attempts >= limitPerPage) {
      break;
    }
    // Nur Karten, deren regulärer Layout-Preis FEHLTE (noPriceRegion) oder nur ein
    // Grundpreis war (basePrice) — genau die verstümmelten Großpreis-Tiles. Karten
    // mit sauberem Preis (built.ok), reiner Pfand- oder kein-Name-Karte überspringen.
    const built = buildLayoutCandidateFromCard(card);
    if (built.ok || (built.reason !== 'noPriceRegion' && built.reason !== 'basePrice')) {
      continue;
    }
    const cardId = layoutCardId(card);
    const regions = determinePriceCropRegions(
      card,
      cardId,
      { width: page.width, height: page.height },
      cropOptions,
    );
    const cardEvidence: PriceCropCardEvidence = { cardId, regions: [] };
    // Mehrere robuste Regionen je Karte werden DER REIHE NACH getestet (best→Fallback);
    // beim ERSTEN sicher geparsten Preis bricht die Karte ab (ein Preis je Karte,
    // begrenzte Crop-Kosten — geometrische Fallback-Varianten verbrennen kein Budget,
    // sobald eine Region trägt). Zusätzlich kappt eine Per-Karten-Schranke die OCR-
    // Versuche, damit EINE (z. B. mehrfach geclusterte) Karte nie das ganze Seiten-
    // budget aufbraucht.
    const perCardCap = Math.max(1, cropOptions.limitPerCard ?? CROP_GEOMETRIC_MAX_REGIONS);
    let cardAttempts = 0;
    for (const region of regions) {
      if (!region.accepted) {
        out.rejections[region.rejectReason ?? 'noCropRegion'] += 1;
        cardEvidence.regions.push(regionEvidenceBase(region));
        continue;
      }
      if (out.attempts >= limitPerPage || cardAttempts >= perCardCap) {
        break;
      }
      cardAttempts += 1;
      const geometric = isGeometricRegionReason(region.reason);
      out.attempts += 1;
      if (geometric) {
        out.geometricAttempts += 1;
      }
      const ocrOpts = derivePriceCropOcrOptions(region.bbox, cropOptions);
      ocrOpts.debugTag = `${cardId}_${region.reason}`;
      const evidence = regionEvidenceBase(region);
      let ocr: PriceCropOcrOutput;
      try {
        ocr = await cropOcr(imageBytes, region.bbox, ocrOpts);
      } catch {
        // Crop-OCR WARF — das Crop-Bild ließ sich nicht rendern/decodieren (z. B.
        // WebP via node-canvas) → es lief KEIN OCR-Pass. Ehrlich als cropRenderFailed
        // bilanzieren, NICHT als cropOcrUnreadable (nicht-fatal; der Lauf bricht nie).
        out.rejections.cropRenderFailed += 1;
        evidence.parseReason = 'cropRenderFailed';
        cardEvidence.regions.push(evidence);
        continue;
      }
      evidence.ocrText = ocr.text;
      evidence.ocrConfidence = ocr.confidence;
      if (cleanOcrLine(ocr.text).length > 0) {
        out.ocrSucceeded += 1;
      }
      const parsed = parseCropPrice(ocr.text, ocr.confidence, { minConfidence });
      if (!parsed.ok) {
        out.rejections[parsed.reason] += 1;
        evidence.parseReason = parsed.reason;
        cardEvidence.regions.push(evidence);
        continue;
      }
      out.parsedPrices += 1;
      if (geometric) {
        out.geometricParsedPrices += 1;
      }
      evidence.parsedPrice = parsed.price;
      // Name aus der LAYOUT-KARTE (Text-Words), NIE aus dem Crop-Preis.
      const name = deriveCardName(card, boxCenterY(region.bbox));
      if (!name) {
        // Karte trägt keinen brauchbaren Namen → weitere Regionen helfen nicht.
        out.rejections.cropNoLinkedName += 1;
        cardEvidence.regions.push(evidence);
        break;
      }
      cardEvidence.linkedName = name;
      out.rawCandidates.push({
        name,
        price: parsed.price,
        unit: unitFromText(card.words.map((word) => word.text).join(' ')),
        imageUrl,
        cardId,
        confidence: ocr.confidence,
      });
      cardEvidence.regions.push(evidence);
      // Sicherer Preis + Name für diese Karte gefunden → keine weiteren Regionen testen.
      break;
    }
    if (cardEvidence.regions.length > 0) {
      out.evidence.push(cardEvidence);
    }
  }
  return out;
}

function summarizeCropRejections(rejections: LidlPriceCropRejectionCounts): string {
  return (
    `noCropRegion ${rejections.noCropRegion}, cropRenderFailed ${rejections.cropRenderFailed}, ` +
    `cropOcrUnreadable ${rejections.cropOcrUnreadable}, ` +
    `cropPriceAmbiguous ${rejections.cropPriceAmbiguous}, cropPriceLowConfidence ${rejections.cropPriceLowConfidence}, ` +
    `cropLooksLikeBasePrice ${rejections.cropLooksLikeBasePrice}, cropLooksLikeDateOrLegal ${rejections.cropLooksLikeDateOrLegal}, ` +
    `cropOutsideCard ${rejections.cropOutsideCard}, cropNoLinkedName ${rejections.cropNoLinkedName}, ` +
    `nonFood ${rejections.nonFood}, categoryConflict ${rejections.categoryConflict}, ` +
    `missingStrongFoodEvidence ${rejections.missingStrongFoodEvidence}, nameQuality ${rejections.nameQuality}, ` +
    `duplicate ${rejections.duplicate}, lowConfidence ${rejections.lowConfidence}`
  );
}

// ── Reale canvas/tesseract-Crop-OCR (NICHT unit-getestet; pure Logik darüber ist
//    getestet). canvas wird — wie tesseract.js — lazy über ein schmales Interface
//    geladen (src-Schicht ohne Node-Typen). ──────────────────────────────────────
interface MinimalCanvasImage {
  width: number;
  height: number;
}
interface MinimalCanvasImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}
interface MinimalCanvasContext {
  fillStyle: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(
    image: MinimalCanvasImage,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  getImageData(x: number, y: number, w: number, h: number): MinimalCanvasImageData;
  putImageData(data: MinimalCanvasImageData, x: number, y: number): void;
}
interface MinimalCanvas {
  getContext(kind: '2d'): MinimalCanvasContext;
  toBuffer(mime: string): Uint8Array;
}
interface MinimalCanvasModule {
  createCanvas(width: number, height: number): MinimalCanvas;
  loadImage(src: Uint8Array): Promise<MinimalCanvasImage>;
}
interface MinimalCropWorker {
  setParameters(params: Record<string, unknown>): Promise<unknown>;
  recognize(image: Uint8Array, options?: Record<string, unknown>): Promise<{ data: { text?: string; confidence?: number } }>;
  terminate(): Promise<unknown>;
}

let canvasModulePromise: Promise<MinimalCanvasModule> | null = null;
function loadCanvasModule(): Promise<MinimalCanvasModule> {
  return (canvasModulePromise ??= import('canvas') as unknown as Promise<MinimalCanvasModule>);
}

/** Crop + Hochskalierung + Graustufen/Kontrast (+ optional Binarisierung/Invertierung)
 *  einer Bildregion zu einem PNG-Puffer. Lokal (canvas), keine Cloud. */
async function cropAndPreprocessImage(
  imageBytes: Uint8Array,
  box: LayoutBox,
  opts: PriceCropOcrOptions,
): Promise<Uint8Array> {
  const canvasMod = await loadCanvasModule();
  const nodeBuffer = (globalThis as { Buffer?: { from(b: Uint8Array): Uint8Array } }).Buffer;
  const image = await canvasMod.loadImage(nodeBuffer ? nodeBuffer.from(imageBytes) : imageBytes);
  const sx = Math.max(0, Math.min(Math.floor(box.x), Math.max(0, image.width - 1)));
  const sy = Math.max(0, Math.min(Math.floor(box.y), Math.max(0, image.height - 1)));
  const sw = Math.max(1, Math.min(image.width - sx, Math.ceil(box.w)));
  const sh = Math.max(1, Math.min(image.height - sy, Math.ceil(box.h)));
  const scale = Math.max(1, Math.min(4, opts.scale));
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const canvas = canvasMod.createCanvas(dw, dh);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, dw, dh);
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, dw, dh);
  if (opts.grayscale || opts.threshold !== undefined || opts.invert) {
    const imageData = ctx.getImageData(0, 0, dw, dh);
    applyGrayscaleContrast(imageData.data, {
      contrast: opts.contrast,
      threshold: opts.threshold,
      invert: opts.invert,
    });
    ctx.putImageData(imageData, 0, 0);
  }
  return canvas.toBuffer('image/png');
}

/** Bildet eine (auf Seitenmaße geklemmte) Crop-Box auf ein Tesseract-`rectangle` ab:
 *  ganzzahliger Ursprung (floor), aufgerundete Maße (ceil), nie negativ, min. 1px.
 *  Für den WebP-Fallback, bei dem tesseract das Originalbild selbst decodiert und nur
 *  diese Region erkennt (node-canvas decodiert WebP nicht). Pure + testbar. */
export function layoutBoxToTesseractRectangle(box: LayoutBox): {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  return {
    left: Math.max(0, Math.floor(box.x)),
    top: Math.max(0, Math.floor(box.y)),
    width: Math.max(1, Math.ceil(box.w)),
    height: Math.max(1, Math.ceil(box.h)),
  };
}

/**
 * Reale Preisbox-Crop-OCR-Glue: ein eigener, ziffern-whitelisteter tesseract-Worker
 * (single line / single word) über die hochskalierte, vorverarbeitete Crop-Region.
 * Der Worker wird über alle Crops EINES Laufs wiederverwendet und am Ende via
 * `dispose()` terminiert. Für reale Scans gedacht; in Tests wird `cropOcr` injiziert.
 *
 * Decode-Strategie: bevorzugt canvas-Crop + Preprocessing (Upscale/Graustufen/
 * Kontrast) — nur für von node-canvas decodierbare Formate (PNG/JPEG). Lidl-
 * Prospektbilder sind WebP; das vorgebaute canvas-Binary kann WebP NICHT decodieren
 * (loadImage wirft „Unsupported image type"). Dafür greift der Rectangle-Fallback:
 * tesseract decodiert das Originalbild selbst und erkennt nur die Preisbox-Region —
 * ohne Upscale/Preprocessing, aber ein echter OCR-Pass statt eines harten Wurfs.
 */
export function createDefaultPriceCropOcr(options: {
  /** OPTIONALER Crop-Preview-Sink (nur DEBUG): erhält je gecroptem Bild das
   *  hochskalierte, vorverarbeitete PNG + den Region-Tag. Greift NUR auf dem canvas-
   *  Pfad (PNG/JPEG-Seiten); für WebP-Seiten gibt es keinen Crop-Puffer (Tesseract
   *  decodiert dort intern via Rectangle-Fallback) → dann wird nichts geschrieben. */
  previewWriter?: (tag: string, png: Uint8Array) => void;
} = {}): {
  cropOcr: PriceCropOcr;
  dispose: () => Promise<void>;
} {
  let workerPromise: Promise<MinimalCropWorker> | null = null;
  const ensureWorker = (): Promise<MinimalCropWorker> => {
    if (!workerPromise) {
      workerPromise = (async () => {
        const tesseract = (await loadTesseractModule()) as unknown as {
          createWorker(lang: string): Promise<MinimalCropWorker>;
        };
        return tesseract.createWorker('eng');
      })();
    }
    return workerPromise;
  };
  const readOcrOutput = (result: { data?: { text?: string; confidence?: number } }): PriceCropOcrOutput => {
    const data = result?.data ?? {};
    return {
      text: data.text ?? '',
      confidence: typeof data.confidence === 'number' ? data.confidence : 0,
    };
  };
  const cropOcr: PriceCropOcr = async (imageBytes, box, opts) => {
    const worker = await ensureWorker();
    await worker.setParameters({
      tessedit_char_whitelist: opts.whitelist,
      tessedit_pageseg_mode: String(opts.psm),
    });
    // 1) canvas-Crop + Preprocessing (Upscale/Graustufen/Kontrast). Schlägt das
    //    Decodieren fehl (z. B. WebP), fällt nur DIESER Schritt weg — kein harter Wurf.
    let cropped: Uint8Array | null = null;
    try {
      cropped = await cropAndPreprocessImage(imageBytes, box, opts);
    } catch {
      cropped = null;
    }
    if (cropped) {
      // Best-effort Crop-Preview (nur DEBUG, nur canvas-Pfad) — nie fatal.
      if (options.previewWriter && opts.debugTag) {
        try {
          options.previewWriter(opts.debugTag, cropped);
        } catch {
          /* Preview darf den Scan nie brechen. */
        }
      }
      return readOcrOutput(await worker.recognize(cropped, {}));
    }
    // 2) Rectangle-Fallback: tesseract decodiert das Originalbild selbst (inkl. WebP)
    //    und erkennt nur die geklemmte Preisbox-Region. Wirft auch das, propagiert der
    //    Fehler → der Orchestrator bilanziert ehrlich cropRenderFailed.
    return readOcrOutput(await worker.recognize(imageBytes, { rectangle: layoutBoxToTesseractRectangle(box) }));
  };
  const dispose = async (): Promise<void> => {
    if (workerPromise) {
      const pending = workerPromise;
      workerPromise = null;
      try {
        await (await pending).terminate();
      } catch {
        /* Aufräumen darf nie werfen. */
      }
    }
  };
  return { cropOcr, dispose };
}

export type LidlOcrMode = 'off' | 'diagnostic' | 'live';

// ===========================================================================
// DEBUG-EVIDENCE (config-gesteuert über LIDL_OCR_DEBUG_EVIDENCE). Pro verarbeiteter
// Prospektseite EIN kompaktes JSON-Artefakt, aus dem ein echter Live-Scan
// reproduzierbare Fixtures liefert — damit der nächste Fix BELEGT statt geraten
// ist. Es werden KEINE Bilddaten gespeichert, nur OCR-Text + kompakte
// Regionskoordinaten. Anzahl (LIDL_OCR_DEBUG_LIMIT) und Größe (Wortbox-/Karten-
// Caps) sind begrenzt. Die Datei-Persistenz ist injizierbar (Writer); der reine
// Builder erzeugt nur die Struktur.
// ===========================================================================

const EVIDENCE_SCHEMA_VERSION = 1;
/** Größenschranke: max. gespeicherte Wortboxen je Seite. */
const EVIDENCE_MAX_WORD_BOXES = 400;
/** Größenschranke: max. getracte Karten je Seite. */
const EVIDENCE_MAX_CARDS = 60;

/** Warum keine Layout-Karte entstand — die EINE Stufe, an der die Layoutkette fiel.
 *  Trennt „Tesseract liefert keine Wortboxen" von „unser Code verliert sie". */
export type LidlOcrNoLayoutReason =
  | 'noStructuredOutputRequested'
  | 'noStructuredOutputAvailable'
  | 'noWordBoxesFromOcr'
  | 'wordBoxesDroppedDuringNormalization'
  | 'imageTooSmallOrInvalidDimensions'
  | 'clusteringRejectedAll'
  | 'layoutDisabledOrUnavailable';

export interface LidlOcrEvidenceWordBox {
  text: string;
  confidence?: number;
  /** Bounding-Box in BILDKOORDINATEN (identisch zu den Tesseract-Boxen). */
  bbox: LayoutBox;
}

export type LidlOcrCandidateVerdict = 'safe' | 'lowLayoutConfidence' | OcrSafetyRejectReason;

/** Debug-Evidence EINER Preisbox-Crop-Region: Geometrie + (falls OCR lief) Ausgang. */
export interface PriceCropRegionEvidence {
  bbox: LayoutBox;
  reason: PriceCropRegionReason;
  accepted: boolean;
  /** Falls die Region selbst abgelehnt wurde (Region-Stufe). */
  rejectReason?: PriceCropRejectReason;
  nearbyWords: string[];
  /** Roher Crop-OCR-Text (nur wenn die Region akzeptiert + OCRt wurde). */
  ocrText?: string;
  ocrConfidence?: number;
  /** Geparster Preis (nur bei erfolgreichem, eindeutigem Parse). */
  parsedPrice?: number;
  /** Falls Parse fehlschlug: warum (Parse-Stufe). */
  parseReason?: PriceCropRejectReason;
}

/** Debug-Evidence der Crop-Auswertung EINER Karte (für backend/data/debug/lidl-ocr). */
export interface PriceCropCardEvidence {
  cardId: string;
  /** Aus der Karte abgeleiteter Produktname (NICHT aus dem Crop), falls vorhanden. */
  linkedName?: string;
  regions: PriceCropRegionEvidence[];
}

export interface LidlOcrEvidenceCard {
  bbox: LayoutBox;
  wordCount: number;
  rowTexts: string[];
  /** Preisregion-Kandidaten der Karte (Text, Score, Position, base/deposit). */
  priceCandidates: LayoutCardPriceCandidate[];
  /** Namensblock-Kandidaten der Karte (Text, Position, gewählt?). */
  nameCandidates: LayoutCardNameCandidate[];
  /** Karten-Vorentscheidung VOR dem geteilten Sicherheits-Gate. */
  cardDecision: 'candidate' | 'noPriceRegion' | 'basePrice' | 'deposit' | 'noNameNearPrice';
  /** Nur bei cardDecision==='noPriceRegion': Feinursache (noPriceLikeWords /
   *  onlyDateOrLegal / splitPriceNotCombined). */
  noPriceDetail?: NoPriceRegionDetail;
  /** Ziffernhaltige Wörter, die nicht als Angebotspreis akzeptiert wurden. */
  rejectedPriceLikeWords?: string[];
  /** Räumliche Euro/Cent-Verbindungsversuche (getrennte Zeilen), die nicht griffen. */
  combinedPriceAttempts?: string[];
  chosenName?: string;
  chosenPrice?: number;
  confidence?: number;
  /** Verdikt des geteilten Food-/Namens-Gates (nur wenn cardDecision==candidate). */
  gateVerdict?: LidlOcrCandidateVerdict;
}

/** Finale Kandidatenentscheidung (Text- ODER Layoutquelle) für die Debug-Evidence. */
export interface LidlOcrCandidateDecision {
  sourceKind: OcrCandidateSourceKind;
  name: string;
  price: number;
  confidence?: number;
  /** 'safe' = würde im live-Modus emittiert; sonst der Verwerfungsgrund. */
  verdict: LidlOcrCandidateVerdict;
}

/** Ein kompaktes Debug-Artefakt EINER verarbeiteten Prospektseite. */
export interface LidlOcrPageEvidence {
  schemaVersion: number;
  capturedAt: string;
  // ── Seiten-Metadaten ──────────────────────────────────────────────────
  storeChain: string;
  sourceId?: string;
  /** Gekürzte URL (letztes Pfadsegment ohne Query) — keine vollen Tracking-URLs. */
  imageUrlTail: string;
  /** Stabiler Kurz-Hash der vollen URL (Wiedererkennung ohne URL-Speicherung). */
  imageUrlHash: string;
  imageFormat: string | null;
  imageByteLength: number;
  ocrMode: LidlOcrMode;
  /** OCR-Parameter. `psm`/`oem` sind die tesseract.js-Defaults (wir konfigurieren
   *  sie aktuell NICHT explizit) — als `'default'` getragen, statt Werte zu raten. */
  ocr: { language: string; engine: string; psm: string; oem: string };
  /** Aus den Wortboxen abgeleitete Bildmaße (0, wenn keine Layoutboxen). */
  imageWidth: number;
  imageHeight: number;
  // ── OCR-Text ──────────────────────────────────────────────────────────
  textLineCount: number;
  textLines: string[];
  // ── tesseract.js-v7-Struktur-Diagnose (Output-Schalter + Wortbox-Quelle) ──
  /** Wurde der Output-Schalter `{ text, blocks, tsv }` gesetzt? (real: immer true). */
  structuredOutputRequested: boolean;
  /** Lieferte `data` ein blocks-Array (auch leer)? */
  blocksPresent: boolean;
  /** Aus blocks geflattete Wortzahl. */
  blockWordCount: number;
  /** Lieferte `data` einen nicht-leeren tsv-String? */
  tsvPresent: boolean;
  /** Aus tsv geparste Wortzahl. */
  tsvWordCount: number;
  /** Quelle der gemappten Wortboxen: blocks | topLevelWords | tsv | none. */
  wordBoxSource: LidlOcrWordBoxSource;
  // ── Wortboxen (TSV/hOCR-äquivalent: text + confidence + bbox) ───────────
  rawWordBoxCount: number;
  normalizedWordCount: number;
  droppedDuringNormalization: number;
  wordBoxes: LidlOcrEvidenceWordBox[];
  wordBoxesTruncated: boolean;
  // ── Layout / Karten-Clusterung ──────────────────────────────────────────
  layoutRan: boolean;
  layoutClusterAttempted: boolean;
  cardsDetected: number;
  /** Gesetzt, wenn 0 Karten — die EINE Stufe, an der die Layoutkette fiel. */
  noLayoutReason?: LidlOcrNoLayoutReason;
  cards: LidlOcrEvidenceCard[];
  cardsTruncated: boolean;
  // ── Preisbox-OCR-Crop-Pass (nur wenn aktiv) ─────────────────────────────
  /** Lief der Preisbox-Crop-Pass für diese Seite? */
  priceCropRan: boolean;
  /** Crop-Auswertung je Karte (Regionen: bbox/reason/linkedCardId/nearbyWords +
   *  why accepted/rejected; bei akzeptierten Regionen OCR-Text/Confidence/Preis). */
  priceCropCards: PriceCropCardEvidence[];
  /** Crop-Versuche (akzeptierte Regionen × OCR) dieser Seite. */
  priceCropAttempts: number;
  /** Crops mit nicht-leerem OCR-Text. */
  priceCropOcrSucceeded: number;
  /** Crops mit sicher geparstem, eindeutigem Preis. */
  priceCropParsedPrices: number;
  // ── Finale Kandidatenentscheidungen (Text- + Layoutquelle) ──────────────
  candidates: LidlOcrCandidateDecision[];
  textRejections: LidlOcrRejectionCounts;
}

function stableShortHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/** Letztes Pfadsegment einer URL ohne Query/Fragment (keine vollen Tracking-URLs
 *  im Debug-Artefakt). Fällt bei Unparsbarem auf die letzten 48 Zeichen zurück. */
function urlTail(url: string): string {
  const noQuery = url.split('?')[0].split('#')[0];
  const segments = noQuery.split('/').filter(Boolean);
  const tail = segments[segments.length - 1] ?? '';
  return tail.length > 0 ? tail.slice(0, 80) : url.slice(-48);
}

/**
 * Leitet die EINE Ursache ab, warum (für eine Seite oder den Lauf gesamt) keine
 * Layout-Karte entstand. Reihenfolge nach der Layoutkette: erst „Layout aus/
 * unverfügbar", dann „keine Roh-Wortboxen", dann „Boxen bei Normalisierung
 * verloren", dann „Bildmaße ungültig", sonst „Clustering verwarf alles".
 */
export function deriveNoLayoutReason(args: {
  layoutRan: boolean;
  rawWordBoxCount: number;
  normalizedWordCount: number;
  validDimensions: boolean;
  cardsDetected: number;
  /** Wurde strukturierte Ausgabe (blocks/tsv) angefordert? `false` → der OCR-Layer
   *  lief ohne Output-Schalter (alte Version/Mock). `undefined` → unbekannt
   *  (Legacy-Aufrufer ohne Struktur-Diagnose) → wie bisher `noWordBoxesFromOcr`. */
  structuredOutputRequested?: boolean;
  /** Lag tatsächlich ein blocks-/tsv-Feld vor (auch leer)? Nur relevant, wenn
   *  angefordert; `false` → der Lauf gab keine strukturierte Ausgabe zurück. */
  structuredOutputAvailable?: boolean;
}): LidlOcrNoLayoutReason | undefined {
  if (!args.layoutRan) {
    return 'layoutDisabledOrUnavailable';
  }
  if (args.cardsDetected > 0) {
    return undefined;
  }
  if (args.rawWordBoxCount === 0) {
    // Strukturierte Ausgabe gar nicht angefordert (alte tesseract.js-Version/Mock).
    if (args.structuredOutputRequested === false) {
      return 'noStructuredOutputRequested';
    }
    // Angefordert, aber der Lauf lieferte kein blocks-/tsv-Feld zurück.
    if (args.structuredOutputAvailable === false) {
      return 'noStructuredOutputAvailable';
    }
    return 'noWordBoxesFromOcr';
  }
  if (args.normalizedWordCount === 0) {
    return 'wordBoxesDroppedDuringNormalization';
  }
  if (!args.validDimensions) {
    return 'imageTooSmallOrInvalidDimensions';
  }
  return 'clusteringRejectedAll';
}

/**
 * PURE Evidence-Builder EINER Seite: OCR-Text + (optionale) Layoutseite →
 * strukturiertes Debug-Artefakt. Re-führt die Karten-Clusterung + Kartenauswertung
 * in einem getracten Modus aus (debug-only, anzahl-/größenbegrenzt) — verändert den
 * Produktivpfad NICHT. Speichert keine Bilddaten.
 */
export function buildLidlOcrPageEvidence(args: {
  context: LidlProspectOcrContext;
  options?: LidlProspectOcrOptions;
  ocrMode: LidlOcrMode;
  capturedAt: string;
  imageUrl: string;
  imageFormat: string | null;
  imageByteLength: number;
  ocrLanguage: string;
  text: string;
  layoutPage: OcrLayoutPage | null;
  layoutRan: boolean;
  /** Lief der Preisbox-Crop-Pass für diese Seite? */
  priceCropRan?: boolean;
  /** Crop-Auswertung je Karte dieser Seite (vom Lauf befüllt). */
  priceCropCards?: PriceCropCardEvidence[];
}): LidlOcrPageEvidence {
  const { context, layoutPage, layoutRan } = args;
  const options = args.options ?? {};
  const helpers = resolveSafetyHelpers(options);
  const priceCropCards = args.priceCropCards ?? [];

  const textLines = String(args.text ?? '')
    .split(/\r?\n/)
    .map(cleanOcrLine)
    .filter(Boolean);

  const rawWordBoxCount = layoutPage?.sourceWordCount ?? layoutPage?.words.length ?? 0;
  const normalizedWordCount = layoutPage?.words.length ?? 0;
  const width = layoutPage?.width ?? 0;
  const height = layoutPage?.height ?? 0;
  const validDimensions = width > 0 && height > 0;

  // tesseract.js-v7-Struktur-Diagnose (nur das reale Default-Pair setzt diese Felder;
  // injizierte Test-Seiten lassen sie offen → ehrliche Defaults).
  const structuredOutputRequested = layoutPage?.structuredOutputRequested === true;
  const blocksPresent = layoutPage?.blocksPresent ?? false;
  const blockWordCount = layoutPage?.blockWordCount ?? 0;
  const tsvPresent = layoutPage?.tsvPresent ?? false;
  const tsvWordCount = layoutPage?.tsvWordCount ?? 0;
  const wordBoxSource: LidlOcrWordBoxSource = layoutPage?.wordBoxSource ?? 'none';

  const allWordBoxes: LidlOcrEvidenceWordBox[] = (layoutPage?.words ?? []).map((word) => ({
    text: word.text,
    confidence: word.confidence,
    bbox: word.bbox,
  }));
  const wordBoxes = allWordBoxes.slice(0, EVIDENCE_MAX_WORD_BOXES);

  // Layoutquelle: Karten clustern + je Karte getract auswerten (Preis-/Namens-
  // Kandidaten, Vorentscheidung, geteiltes Gate-Verdikt).
  const cards: LidlOcrEvidenceCard[] = [];
  const layoutCandidates: LidlOcrCandidateDecision[] = [];
  let cardsDetected = 0;
  const layoutClusterAttempted = layoutRan && normalizedWordCount > 0;
  const layoutSeen = new Set<string>(
    [...(context.existingNameKeys ?? [])].map((key) => normalizeText(String(key))),
  );
  if (layoutClusterAttempted && layoutPage) {
    const clustered = clusterWordsIntoCards(layoutPage);
    cardsDetected = clustered.length;
    for (const card of clustered.slice(0, EVIDENCE_MAX_CARDS)) {
      const trace: LayoutCardTrace = { priceCandidates: [], nameCandidates: [] };
      const built = buildLayoutCandidateFromCard(card, trace);
      const evCard: LidlOcrEvidenceCard = {
        bbox: card.bbox,
        wordCount: card.words.length,
        rowTexts: card.rows.map((row) => row.text),
        priceCandidates: trace.priceCandidates,
        nameCandidates: trace.nameCandidates,
        cardDecision: built.ok ? 'candidate' : built.reason,
      };
      if (!built.ok && built.reason === 'noPriceRegion') {
        evCard.noPriceDetail = trace.noPriceDetail ?? built.noPriceDetail;
        evCard.rejectedPriceLikeWords = trace.rejectedPriceLikeWords;
        evCard.combinedPriceAttempts = trace.combinedPriceAttempts;
      }
      if (built.ok) {
        evCard.chosenName = built.name;
        evCard.chosenPrice = built.price;
        evCard.confidence = built.confidence;
        // Reihenfolge wie extractLidlLayoutOffers: erst Layout-Konfidenz, dann das
        // geteilte Food-/Namens-Gate (mit getrenntem `seen` — debug-only).
        const verdict: LidlOcrCandidateVerdict = built.isLowConfidence
          ? 'lowLayoutConfidence'
          : ((result) => (result.ok ? 'safe' : result.reason))(
              classifyOcrCandidate(built.name, helpers, layoutSeen),
            );
        evCard.gateVerdict = verdict;
        layoutCandidates.push({
          sourceKind: 'layout_card',
          name: built.name,
          price: built.price,
          confidence: built.confidence,
          verdict,
        });
      }
      cards.push(evCard);
    }
  }

  // Textquelle: dieselbe pure Extraktion (für die finalen Text-Kandidaten +
  // Verwerfungs-Zählkette dieser Seite).
  const textResult = extractLidlProspectOcrOffers(
    [{ text: args.text, imageUrl: args.imageUrl }],
    context,
    options,
  );
  const textCandidates: LidlOcrCandidateDecision[] = textResult.offers.map((offer) => ({
    sourceKind: 'text_line',
    name: offer.name,
    price: typeof offer.price === 'number' ? offer.price : 0,
    verdict: 'safe',
  }));

  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    capturedAt: args.capturedAt,
    storeChain: context.storeChain,
    sourceId: context.sourceId,
    imageUrlTail: urlTail(args.imageUrl),
    imageUrlHash: stableShortHash(args.imageUrl),
    imageFormat: args.imageFormat,
    imageByteLength: args.imageByteLength,
    ocrMode: args.ocrMode,
    ocr: { language: args.ocrLanguage, engine: 'tesseract.js', psm: 'default', oem: 'default' },
    imageWidth: width,
    imageHeight: height,
    textLineCount: textLines.length,
    textLines,
    structuredOutputRequested,
    blocksPresent,
    blockWordCount,
    tsvPresent,
    tsvWordCount,
    wordBoxSource,
    rawWordBoxCount,
    normalizedWordCount,
    droppedDuringNormalization: Math.max(0, rawWordBoxCount - normalizedWordCount),
    wordBoxes,
    wordBoxesTruncated: allWordBoxes.length > wordBoxes.length,
    layoutRan,
    layoutClusterAttempted,
    cardsDetected,
    noLayoutReason: deriveNoLayoutReason({
      layoutRan,
      rawWordBoxCount,
      normalizedWordCount,
      validDimensions,
      cardsDetected,
      // Nur wenn die Struktur-Diagnose vorlag (reales Pair), die neuen Ursachen
      // unterscheiden; sonst undefined → wie bisher noWordBoxesFromOcr.
      structuredOutputRequested: layoutPage?.structuredOutputRequested,
      structuredOutputAvailable: structuredOutputRequested
        ? blocksPresent || tsvPresent
        : undefined,
    }),
    cards,
    cardsTruncated: cardsDetected > cards.length,
    priceCropRan: args.priceCropRan ?? false,
    priceCropCards,
    priceCropAttempts: priceCropCards.reduce(
      (sum, card) => sum + card.regions.filter((region) => region.accepted).length,
      0,
    ),
    priceCropOcrSucceeded: priceCropCards.reduce(
      (sum, card) => sum + card.regions.filter((region) => cleanOcrLine(region.ocrText ?? '').length > 0).length,
      0,
    ),
    priceCropParsedPrices: priceCropCards.reduce(
      (sum, card) => sum + card.regions.filter((region) => region.parsedPrice !== undefined).length,
      0,
    ),
    candidates: [...textCandidates, ...layoutCandidates],
    textRejections: textResult.rejections,
  };
}

// ---------------------------------------------------------------------------
// DEBUG-EVIDENCE-WRITER — persistiert je Seite ein JSON-Artefakt unter einem
// git-ignorierten Pfad (backend/data/debug/lidl-ocr/<run-id>/). Liegt in der
// `src`-Schicht (tsconfig.app, KEINE Node-Typen) → `node:fs/promises` wird über
// einen NICHT-literalen Spezifizierer lazy geladen (TS leitet `any` ab; vite
// ignoriert den dynamischen Import). Läuft nur im Node-Backend zur Scan-Zeit, wenn
// LIDL_OCR_DEBUG_EVIDENCE gesetzt ist. Für Tests ist `fs` injizierbar.
// ---------------------------------------------------------------------------

export interface NodeFsLike {
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  // `data` ist Text (JSON-Evidence) ODER binär (optionale Crop-Preview-PNGs); ein
  // String trägt ein Encoding, ein Puffer wird roh geschrieben (encoding entfällt).
  writeFile(path: string, data: string | Uint8Array, encoding?: string): Promise<unknown>;
}

async function loadNodeFsPromises(): Promise<NodeFsLike | null> {
  try {
    // Nicht-literaler Spezifizierer: TS leitet `any` ab (kein @types/node nötig),
    // vite lässt den dynamischen Import in Ruhe. Zur Laufzeit (Node/tsx) auflösbar.
    const spec = ['node', 'fs/promises'].join(':');
    const mod = (await import(/* @vite-ignore */ spec)) as { default?: NodeFsLike } & NodeFsLike;
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

export interface LidlOcrEvidenceWriter {
  /** Sink für {@link RunLidlProspectOcrInput.recordPageEvidence}. */
  recordPageEvidence: (evidence: LidlOcrPageEvidence) => void;
  /** OPTIONALER Preview-Sink für den realen Crop-Pass: schreibt das hochskalierte,
   *  vorverarbeitete Crop-PNG EINER Preisbox best-effort nach `<evidenceDir>/crops/`.
   *  Nur DEBUG, nie Snapshot; anzahlbegrenzt; Schreibfehler brechen den Scan nie. */
  writeCropPreview: (tag: string, png: Uint8Array) => void;
  /** Wartet, bis alle ausstehenden Schreibvorgänge abgeschlossen sind. */
  flush: () => Promise<void>;
  /** Relativer Debug-Ordner dieses Laufs (für die Note/Diagnose). */
  evidenceDir: string;
  /** Anzahl angenommener Seiten (≤ limit). */
  pagesRecorded: () => number;
}

/**
 * Erzeugt einen größen-/anzahlbegrenzten Debug-Evidence-Writer. Schreibt je Seite
 * `page-NNN.json` in `<baseDir>/<runId>/`. Schreibfehler brechen den Scan NIE
 * (Debug ist best-effort). `fs`/`loadFs` sind injizierbar (Tests fälschen das
 * Dateisystem). Wird die Runtime nicht gefunden (kein Node), passiert nichts.
 */
export function createLidlOcrEvidenceWriter(args: {
  runId: string;
  limit: number;
  baseDir?: string;
  fs?: NodeFsLike | null;
  loadFs?: () => Promise<NodeFsLike | null>;
}): LidlOcrEvidenceWriter {
  const baseDir = args.baseDir ?? 'backend/data/debug/lidl-ocr';
  const evidenceDir = `${baseDir}/${args.runId}`;
  const cropsDir = `${evidenceDir}/crops`;
  const limit = Math.max(0, args.limit);
  // Preview-Schranke: ein paar Crops je Seite, damit das Debug-Verzeichnis nicht
  // explodiert (rein heuristisch; Crops sind klein).
  const cropPreviewLimit = limit * 8;
  const pending: Promise<void>[] = [];
  let recorded = 0;
  let cropPreviewsWritten = 0;
  let ensureDirPromise: Promise<NodeFsLike | null> | null = null;
  let ensureCropsDirPromise: Promise<NodeFsLike | null> | null = null;

  const ensureDir = (): Promise<NodeFsLike | null> => {
    if (!ensureDirPromise) {
      ensureDirPromise = (async () => {
        // `fs: null` = EXPLIZIT kein Dateisystem (Tests) → nichts laden; nur ein
        // ausgelassenes `fs` lädt die echte node:fs/promises-Runtime lazy.
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

  const ensureCropsDir = (): Promise<NodeFsLike | null> => {
    if (!ensureCropsDirPromise) {
      ensureCropsDirPromise = (async () => {
        const fs = await ensureDir();
        if (fs) {
          try {
            await fs.mkdir(cropsDir, { recursive: true });
          } catch {
            /* Debug darf den Scan nie brechen. */
          }
        }
        return fs;
      })();
    }
    return ensureCropsDirPromise;
  };

  /** Dateinamen-sicherer Tag (nur [A-Za-z0-9_.-], gekappt). */
  const safeTag = (tag: string): string =>
    (tag.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) || 'crop');

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
    writeCropPreview: (tag, png) => {
      if (cropPreviewsWritten >= cropPreviewLimit || png.length === 0) {
        return;
      }
      const index = cropPreviewsWritten;
      cropPreviewsWritten += 1;
      pending.push(
        (async () => {
          const fs = await ensureCropsDir();
          if (!fs) {
            return;
          }
          const file = `${cropsDir}/${String(index + 1).padStart(3, '0')}_${safeTag(tag)}.png`;
          try {
            await fs.writeFile(file, png);
          } catch {
            /* Debug (Preview) darf den Scan nie brechen. */
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

export interface RunLidlProspectOcrInput {
  imageUrls: readonly string[];
  context: LidlProspectOcrContext;
  /** 'diagnostic' liest + bilanziert, schaltet aber NICHTS live; 'live' gibt die
   *  sicheren Kandidaten frei (sie durchlaufen anschließend den nachgelagerten
   *  zentralen Food-Gate). 'off' ruft diese Funktion gar nicht erst auf. */
  mode: 'diagnostic' | 'live';
  ocrImage: (imageBytes: Uint8Array, imageUrl: string) => Promise<string>;
  /** OPTIONALE Layoutanalyse je Bild (Wörter mit Boxen). Wenn gesetzt, läuft der
   *  layout-aware Kartenextraktor als ZWEITE Kandidatenquelle (sourceKind=
   *  layout_card) zusätzlich zur Textzeilenquelle. Wirft die Layoutanalyse, wird
   *  das nicht-fatal als Layout-Fehlschlag gezählt (der Textpfad bleibt
   *  unberührt). Default: keine Layoutanalyse (reines Textzeilenverhalten). */
  ocrLayout?: (imageBytes: Uint8Array, imageUrl: string) => Promise<OcrLayoutPage | null>;
  /** OPTIONALE Preisbox-Crop-OCR (crop + preprocess + ziffern-Digit-Pass EINER
   *  Region). Wenn gesetzt UND {@link priceCropMode} != 'off', läuft der Preisbox-
   *  Crop-Pass als DRITTE Kandidatenquelle (sourceKind='price_crop') für Karten ohne
   *  sauberen Angebotspreis. Default: kein Crop-Pass. Braucht eine Layoutanalyse
   *  (ocrLayout) — ohne Wortboxen gibt es keine Karten/Regionen. */
  cropPriceOcr?: PriceCropOcr;
  /** Crop-Pass-Modus: 'off' (Default) = kein Crop; 'diagnostic' = liest + bilanziert,
   *  emittiert NICHTS live; 'live' = sichere Crop-Kandidaten zusätzlich (nur wenn der
   *  Lauf insgesamt mode='live' ist — diagnostic emittiert nie live). */
  priceCropMode?: 'off' | 'diagnostic' | 'live';
  /** Crop-Optionen (limitPerPage/limitPerCard/minConfidence/Preprocessing). */
  cropOptions?: PriceCropOptions;
  fetchBinary: (url: string) => Promise<Uint8Array>;
  imageLimit?: number;
  /** Anzahl der Prospekt-Bildseiten (flyer.pages) — Kopf der Zählkette. Nur für
   *  die Diagnose; steuert nichts. */
  prospectPageCount?: number;
  options?: LidlProspectOcrOptions;
  /** Sicherer Debug-/Diagnose-Hook: wird je Seite mit nicht-leerem OCR-Text
   *  aufgerufen (für Fixture-Erfassung aus einem echten Lauf oder gezielte
   *  Diagnose). NICHT für Massen-Produktivlogging gedacht — der Connector reicht
   *  ihn nur durch, wenn ein expliziter Debug-Schalter gesetzt ist. */
  onOcrPage?: (page: { imageUrl: string; text: string; lineCount: number }) => void;
  /** DEBUG-EVIDENCE-Sink (config-gesteuert über LIDL_OCR_DEBUG_EVIDENCE): wenn
   *  gesetzt, baut der Lauf je verarbeiteter Seite ein {@link LidlOcrPageEvidence}-
   *  Artefakt (anzahlbegrenzt über {@link debugEvidenceLimit}) und reicht es hier
   *  durch. Der Aufrufer entscheidet über die Persistenz ({@link createLidlOcrEvidenceWriter}
   *  schreibt Dateien; Tests sammeln in-memory). Debug-Fehler brechen den Lauf nie. */
  recordPageEvidence?: (evidence: LidlOcrPageEvidence) => void;
  /** Obergrenze der Seiten, für die Debug-Evidence gebaut wird (Default = imageLimit). */
  debugEvidenceLimit?: number;
  /** Relativer Debug-Ordner dieses Laufs (nur für die Note-Referenz). */
  debugEvidencePath?: string;
}

/**
 * Vollständige, je Schritt gemessene OCR-Zählkette EINES Prospekt-OCR-Laufs.
 * Macht den Weg „Prospektseite → Bild-URL → Fetch → Bild → OCR-Text → Roh-
 * Kandidat → sicherer Kandidat → live" lückenlos sichtbar, sodass ein `raw=0` nie
 * unerklärt bleibt. Jeder Schritt ist eine getrennte Zahl (nicht ein gemeinsamer
 * Sammeltopf).
 */
export interface LidlOcrPipelineCounters {
  /** 1. erkannte Prospekt-Bildseiten (flyer.pages). */
  prospectPages: number;
  /** 2. gesammelte (verfügbare) Prospekt-Bild-URLs. */
  collectedImageUrls: number;
  /** 3. tatsächlich versuchte Bildabrufe (innerhalb imageLimit). */
  fetchAttempted: number;
  /** 4. erfolgreiche Bildabrufe (HTTP ok, Bytes erhalten). */
  fetchSucceeded: number;
  /** 5. abgerufene Antworten, die als dekodierbares Bild erkannt wurden. */
  imageDecoded: number;
  /** 6. Seiten, deren OCR nicht-leeren Text lieferte. */
  ocrTextPages: number;
  /** 7. nicht-leere OCR-Textzeilen über alle gelesenen Seiten. */
  rawOcrLines: number;
  /** 7a. Zeilen mit erkanntem plausiblem Angebotspreis (ohne Grundpreis/Pfand). */
  priceLinesFound: number;
  /** 7b. Zeilen, die strukturell wie ein Produktname aussehen. */
  productNameBlocksFound: number;
  /** 8. roh extrahierte preisbehaftete Kandidaten (= Preis+Name gruppiert, vor den
   *  Sicherheitsverwerfungen). Summe beider Quellen (Textzeile + Layout). */
  rawCandidates: number;
  /** 9. nach allen Sicherheitsverwerfungen verbleibende sichere Kandidaten. */
  safeCandidates: number;
  /** 10. tatsächlich live freigegebene Angebote (nur im Live-Modus > 0). */
  emittedOffers: number;
  /** 8a. Roh-Kandidaten ausschließlich aus der Textzeilenquelle. */
  textLineRawCandidates: number;
  /** 11. erkannte Produktkarten (räumliche Cluster) der Layoutquelle. */
  layoutCardsDetected: number;
  /** 12. Roh-Kandidaten der Layoutquelle (Karte → Name + Angebotspreis). */
  layoutRawCandidates: number;
  /** 13. sichere Layout-Kandidaten nach allen Verwerfungen. */
  layoutSafeCandidates: number;
  /** 15. Preisbox-Crop-OCR-Versuche (akzeptierte Regionen × OCR). */
  priceCropAttempts: number;
  /** 16. Crops mit nicht-leerem OCR-Text. */
  priceCropOcrSucceeded: number;
  /** 17. Crops mit sicher geparstem, EINDEUTIGEM Preis. */
  priceCropParsedPrices: number;
  /** 18. Crop-Roh-Kandidaten (Crop-Preis + Kartenname) VOR dem Gate — GETRENNT von
   *  {@link layoutRawCandidates} (textbasierte Preisregion). */
  cropRawCandidates: number;
  /** 19. sichere Crop-Kandidaten nach Gate + Dedupe. */
  cropSafeCandidates: number;
  /** 15a. Crop-OCR-Versuche aus dem GEOMETRISCHEN (anker-freien) Fallback-Finder. */
  geometricCropAttempts: number;
  /** 17a. sicher geparste Preise aus dem geometrischen Fallback-Finder. */
  geometricCropParsedPrices: number;
  /** 14. tatsächlich live freigegebene Angebote über ALLE Quellen. */
  finalEmittedOffers: number;
}

/** Getrennte technische Fehlschläge je Zählkettenschritt — kein Sammel-`parseError`
 *  mehr, damit ein `raw=0` IMMER eine konkrete Ursache trägt. */
export interface LidlOcrPipelineFailures {
  /** Bildabruf warf (HTTP-Fehler/Timeout/Netz). */
  fetchFailed: number;
  /** Abruf ok, aber die Bytes sind KEIN dekodierbares Bild (z. B. HTML-/JSON-
   *  Antwort einer fälschlich gesammelten Nicht-Bild-URL). */
  notAnImage: number;
  /** Die OCR-Runtime selbst war nicht verfügbar (tesseract.js/Worker). */
  ocrRuntimeUnavailable: number;
  /** OCR warf auf einem dekodierbaren Bild (kein Runtime-Problem). */
  ocrError: number;
  /** OCR lief, lieferte aber leeren/whitespace-only Text. */
  ocrTextEmpty: number;
  /** Optionale Layoutanalyse warf auf einem Bild (nicht-fatal; Textpfad bleibt). */
  layoutFailed: number;
}

export interface RunLidlProspectOcrResult {
  result: LidlProspectOcrResult;
  /** Ergebnis der Layoutquelle (leer, wenn keine Layoutanalyse lief). */
  layoutResult: LidlLayoutOcrResult;
  /** Ergebnis des Preisbox-Crop-Passes (leer, wenn kein Crop-Pass lief). */
  priceCropResult: LidlPriceCropResult;
  /** Strukturierte Bilanz-Diagnosezeile (status empty/success → blockiert nie das
   *  Gate). */
  diagnostic: SubSourceDiagnostic;
  /** Nur im Live-Modus befüllt — die freigegebenen Angebote BEIDER Quellen. */
  emittedOffers: RawOfferCandidate[];
  /** Vollständige, je Schritt gemessene Zählkette (auch maschinenlesbar testbar). */
  counters: LidlOcrPipelineCounters;
  /** Getrennte technische Fehlschläge je Schritt. */
  failures: LidlOcrPipelineFailures;
  /** Verwerfungen der Layoutquelle, getrennt nach Grund (sourceKind=layout_card). */
  layoutRejectedByReason: LidlOcrLayoutRejectionCounts;
  /** EINE klare Hauptursache für den OCR-Stand dieses Laufs (warum raw/emitted so
   *  ist). Nie leer — auch bei Erfolg. */
  primaryReason: string;
  /** Layout-Wortbox-Diagnose über alle Seiten (trennt „Tesseract liefert keine
   *  Boxen" von „unser Code verliert sie"). Befüllt, sobald die Layoutanalyse lief. */
  layoutDiagnostics: LidlOcrLayoutDiagnostics;
  /** Nur befüllt, wenn der Debug-Evidence-Pfad aktiv war (recordPageEvidence gesetzt). */
  debug?: { evidencePath?: string; pagesRecorded: number };
}

/** Aggregierte Layout-Wortbox-/Clusterdiagnose über alle Seiten eines Laufs. */
export interface LidlOcrLayoutDiagnostics {
  layoutRan: boolean;
  /** Seiten, für die die Layoutanalyse einen (auch leeren) Befund lieferte. */
  pagesProbed: number;
  /** Seiten, auf denen der OCR-Layer ≥1 ROH-Wortbox lieferte (vor Normalisierung). */
  pagesWithWordBoxes: number;
  /** Summe der ROH-Wortboxen über alle Seiten (Tesseract-Ausgabe). */
  totalWordBoxes: number;
  /** Summe der NORMALISIERTEN Layoutwörter (die ins Clustering gehen). */
  totalNormalizedWords: number;
  /** Seiten mit ≥1 normalisiertem Layoutwort (ans Clustering übergeben). */
  pagesWithLayoutInput: number;
  /** Seiten mit gültigen Bildmaßen (width>0 && height>0). */
  pagesWithValidDimensions: number;
  /** Anzahl Seiten, auf denen das Karten-Clustering versucht wurde. */
  layoutClusterAttempts: number;
  /** Erkannte Produktkarten über alle Seiten. */
  layoutCardsDetected: number;
  /** Bei 0 Karten: die EINE dominante Ursache des Laufs. */
  dominantNoLayoutReason?: LidlOcrNoLayoutReason;
  /** Seiten, auf denen strukturierte Ausgabe (blocks/tsv) angefordert wurde. */
  structuredOutputRequestedPages: number;
  /** Seiten, auf denen tatsächlich ein blocks-/tsv-Feld zurückkam (auch leer). */
  structuredOutputAvailablePages: number;
  /** Summe der aus blocks geflatteten Wörter über alle Seiten. */
  totalBlockWords: number;
  /** Summe der aus tsv geparsten Wörter über alle Seiten. */
  totalTsvWords: number;
}

function emptyPipelineFailures(): LidlOcrPipelineFailures {
  return {
    fetchFailed: 0,
    notAnImage: 0,
    ocrRuntimeUnavailable: 0,
    ocrError: 0,
    ocrTextEmpty: 0,
    layoutFailed: 0,
  };
}

function emptyLayoutResult(): LidlLayoutOcrResult {
  return {
    offers: [],
    layoutCardsDetected: 0,
    layoutRawCandidates: 0,
    layoutSafeCandidates: 0,
    rejections: emptyLayoutRejections(),
    noPriceRegionDetail: emptyNoPriceRegionDetail(),
  };
}

function summarizeLayoutRejections(rejections: LidlOcrLayoutRejectionCounts): string {
  return (
    `noPriceRegion ${rejections.noPriceRegion}, basePrice ${rejections.basePrice}, ` +
    `deposit ${rejections.deposit}, noNameNearPrice ${rejections.noNameNearPrice}, ` +
    `lowLayoutConfidence ${rejections.lowLayoutConfidence}, lowConfidence ${rejections.lowConfidence}, ` +
    `nameQuality ${rejections.nameQuality}, duplicate ${rejections.duplicate}, ` +
    `nonFood ${rejections.nonFood}, categoryConflict ${rejections.categoryConflict}, ` +
    `missingStrongFoodEvidence ${rejections.missingStrongFoodEvidence}`
  );
}

/** Hängt — wenn `noPriceRegion` der dominante Grund ist — dessen Feinaufschlüsselung
 *  an (noPriceLikeWords/onlyDateOrLegal/splitPriceNotCombined). So zeigt der Report
 *  bei „keine Preisfläche" die ECHTE Ursache (OCR liest die Preis-Tiles nicht),
 *  statt eines blanken Zählers. Leer, wenn noPriceRegion nicht dominiert. */
function noPriceRegionDetailSuffix(layout: LidlLayoutOcrResult): string {
  const detail = layout.noPriceRegionDetail;
  const total = detail.noPriceLikeWords + detail.onlyDateOrLegal + detail.splitPriceNotCombined;
  if (total === 0 || layout.rejections.noPriceRegion < total) {
    return '';
  }
  const parts = (
    [
      ['noPriceLikeWords', detail.noPriceLikeWords],
      ['onlyDateOrLegal', detail.onlyDateOrLegal],
      ['splitPriceNotCombined', detail.splitPriceNotCombined],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label} ${count}`);
  return parts.length > 0 ? ` — noPriceRegion: ${parts.join(', ')}` : '';
}

/** Dominanter Layout-Verwerfungsgrund (für die differenzierte primaryReason). */
function dominantLayoutReason(rejections: LidlOcrLayoutRejectionCounts): string | null {
  const ranked = (
    [
      ['noPriceRegion', rejections.noPriceRegion],
      ['noNameNearPrice', rejections.noNameNearPrice],
      ['basePriceOnly', rejections.basePrice],
      ['deposit', rejections.deposit],
      ['lowLayoutConfidence', rejections.lowLayoutConfidence],
      ['nonFood', rejections.nonFood],
      ['categoryConflict', rejections.categoryConflict],
      ['missingStrongFoodEvidence', rejections.missingStrongFoodEvidence],
      ['nameQuality', rejections.nameQuality],
      ['duplicate', rejections.duplicate],
      ['lowConfidence', rejections.lowConfidence],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])[0];
  return ranked ? `${ranked[0]} (${ranked[1]})` : null;
}

function summarizeRejections(rejections: LidlOcrRejectionCounts): string {
  return (
    `verworfen: noName ${rejections.noName}, noPrice ${rejections.noPrice}, ` +
    `basePrice ${rejections.basePrice}, deposit ${rejections.deposit}, ` +
    `lowConfidence ${rejections.lowConfidence}, nameQuality ${rejections.nameQuality}, ` +
    `duplicate ${rejections.duplicate}, nonFood ${rejections.nonFood}, ` +
    `categoryConflict ${rejections.categoryConflict}, ` +
    `missingStrongFoodEvidence ${rejections.missingStrongFoodEvidence}, ` +
    `parseError ${rejections.parseError}`
  );
}

function summarizeFailures(failures: LidlOcrPipelineFailures): string {
  return (
    `fetchFailed ${failures.fetchFailed}, notAnImage ${failures.notAnImage}, ` +
    `ocrRuntimeUnavailable ${failures.ocrRuntimeUnavailable}, ocrError ${failures.ocrError}, ` +
    `ocrTextEmpty ${failures.ocrTextEmpty}, layoutFailed ${failures.layoutFailed}`
  );
}

/** Die Textzeilen-Teilursache (raw=0 differenziert / alle verworfen / Erfolg). */
function textLineCandidateReason(
  counters: LidlOcrPipelineCounters,
  rejections: LidlOcrRejectionCounts,
  textRaw: number,
  textSafe: number,
  textEmitted: number,
  mode: 'diagnostic' | 'live',
): string {
  if (textRaw === 0) {
    // Text gelesen, aber 0 gruppierte Kandidaten — differenziert nach DEM Grund,
    // statt eines pauschalen textReadButNoCandidates.
    const base = `textReadButNoCandidates (${counters.rawOcrLines} Zeilen, ` +
      `${counters.priceLinesFound} Preiszeilen, ${counters.productNameBlocksFound} Namensblöcke): `;
    if (counters.priceLinesFound > 0 && counters.productNameBlocksFound === 0) {
      return `${base}Angebotspreise erkannt, aber keine gruppierbaren Produktnamen`;
    }
    if (counters.priceLinesFound === 0 && counters.productNameBlocksFound > 0) {
      const onlyBaseOrDeposit = rejections.basePrice + rejections.deposit > 0;
      return onlyBaseOrDeposit
        ? `${base}Produktnamen erkannt, aber nur Grundpreise/Pfand (basePrice ${rejections.basePrice}, deposit ${rejections.deposit})`
        : `${base}Produktnamen erkannt, aber keine Angebotspreise`;
    }
    if (counters.priceLinesFound === 0 && rejections.basePrice + rejections.deposit > 0) {
      return `${base}nur Grundpreise/Pfand (basePrice ${rejections.basePrice}, deposit ${rejections.deposit})`;
    }
    if (counters.priceLinesFound > 0 && counters.productNameBlocksFound > 0) {
      return `${base}Preise und Namen erkannt, aber nicht zu Kandidaten gruppierbar (Layout-Konfidenz zu niedrig, noName ${rejections.noName})`;
    }
    return `${base}weder Angebotspreise noch Produktnamen erkennbar`;
  }
  if (textSafe === 0) {
    // Roh-Kandidaten entstanden, aber alle verworfen — DEN dominanten Grund nennen.
    const dominant = (
      [
        ['nonFood', rejections.nonFood],
        ['categoryConflict', rejections.categoryConflict],
        ['missingStrongFoodEvidence', rejections.missingStrongFoodEvidence],
        ['nameQuality', rejections.nameQuality],
        ['duplicate', rejections.duplicate],
        ['lowConfidence (Layout)', rejections.lowConfidence],
        ['noName', rejections.noName],
      ] as const
    )
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])[0];
    const lead = dominant ? `überwiegend ${dominant[0]} (${dominant[1]}) — ` : '';
    return `alle ${textRaw} Roh-Kandidaten verworfen: ${lead}${summarizeRejections(rejections)}`;
  }
  return mode === 'live'
    ? `${textSafe} sichere Kandidat(en) extrahiert, ${textEmitted} live freigegeben`
    : `${textSafe} sichere Kandidat(en) extrahiert (Modus diagnostic → nicht live)`;
}

/** Die Layout-Teilursache (keine Karten / keine Preisfläche / kein Name nah / nur
 *  Grundpreis / Layout-Konfidenz / Sicherheits-Veto / Erfolg). Bei 0 Karten benennt
 *  sie zusätzlich die WORTBOX-Ursache (noWordBoxesFromOcr vs. …Dropped… vs.
 *  clusteringRejectedAll …), damit der nächste Scan nicht raten muss. */
function layoutCandidateReason(
  layout: LidlLayoutOcrResult,
  mode: 'diagnostic' | 'live',
  noLayoutReason?: LidlOcrNoLayoutReason,
): string {
  if (layout.layoutCardsDetected === 0) {
    return `Layout: keine Produktkarten erkannt (${noLayoutReason ?? 'clusteringRejectedAll'})`;
  }
  if (layout.layoutRawCandidates === 0) {
    const reason = dominantLayoutReason(layout.rejections);
    const detail = noPriceRegionDetailSuffix(layout);
    return `Layout: ${layout.layoutCardsDetected} Karten, aber keine Kandidaten (${reason ?? 'keine Preis-/Namensfläche'}${detail})`;
  }
  if (layout.layoutSafeCandidates === 0) {
    return `Layout: alle ${layout.layoutRawCandidates} Karten-Kandidaten verworfen — überwiegend ${
      dominantLayoutReason(layout.rejections) ?? 'unbekannt'
    }`;
  }
  return mode === 'live'
    ? `Layout: ${layout.layoutSafeCandidates} sichere Karten-Kandidat(en) live freigegeben`
    : `Layout: ${layout.layoutSafeCandidates} sichere Karten-Kandidat(en) (Modus diagnostic → nicht live)`;
}

/** Die Preisbox-Crop-Teilursache (keine Region OCRt / keine sicheren Preise / alle
 *  verworfen / Erfolg). Getrennt von der textbasierten Preisregion benannt. */
function cropCandidateReason(
  crop: LidlPriceCropResult,
  cropMode: 'off' | 'diagnostic' | 'live',
  mode: 'diagnostic' | 'live',
): string {
  // Anteil des geometrischen (anker-freien) Fallback-Finders explizit mitführen.
  const visual = `visuell ${crop.geometricCropAttempts}/${crop.geometricCropParsedPrices}`;
  if (crop.priceCropAttempts === 0) {
    return `Crop: keine Preisbox-Region OCRt (noCropRegion ${crop.rejections.noCropRegion}, ${visual})`;
  }
  if (crop.priceCropParsedPrices === 0) {
    return `Crop: ${crop.priceCropAttempts} Crops (${visual}), 0 sichere Crop-Preise (${summarizeCropRejections(crop.rejections)})`;
  }
  if (crop.cropSafeCandidates === 0) {
    return `Crop: ${crop.priceCropParsedPrices} Crop-Preise geparst (${visual}), alle verworfen (${summarizeCropRejections(crop.rejections)})`;
  }
  const live = mode === 'live' && cropMode === 'live';
  return `Crop: ${crop.cropSafeCandidates} sichere Crop-Kandidat(en) (${visual})${live ? ' live freigegeben' : ' (nicht live)'}`;
}

/**
 * Leitet die EINE klare Hauptursache des Laufs aus der Zählkette ab — die erste
 * Stufe, an der die Kette auf 0 fiel. So ist `raw=0` nie unerklärt; bei Erfolg
 * benennt sie die freigegebene Menge. Differenziert SOWOHL die Textzeilen- ALS
 * AUCH (falls aktiv) die Layoutquelle (noPriceRegion/noNameNearPrice/basePriceOnly/
 * lowLayoutConfidence/nameQuality/categoryConflict/missingStrongFoodEvidence …).
 */
function determinePrimaryReason(args: {
  counters: LidlOcrPipelineCounters;
  failures: LidlOcrPipelineFailures;
  textRejections: LidlOcrRejectionCounts;
  textRaw: number;
  textSafe: number;
  textEmitted: number;
  layout: LidlLayoutOcrResult;
  layoutRan: boolean;
  noLayoutReason?: LidlOcrNoLayoutReason;
  mode: 'diagnostic' | 'live';
}): string {
  const { counters, failures, textRejections, textRaw, textSafe, textEmitted, layout, layoutRan, noLayoutReason, mode } = args;
  if (counters.collectedImageUrls === 0) {
    return 'keine ladbaren CDN-Bild-URLs aus den Prospektseiten extrahiert (Bildseiten vorhanden, aber keine direkt ladbare Bild-URL)';
  }
  if (counters.fetchAttempted === 0) {
    return 'imageLimit 0 — keine Bildseite versucht';
  }
  if (failures.ocrRuntimeUnavailable > 0 && counters.ocrTextPages === 0) {
    return 'OCR-Runtime nicht verfügbar (tesseract.js/Worker konnte nicht geladen werden)';
  }
  if (counters.fetchSucceeded === 0) {
    return `alle ${counters.fetchAttempted} Bildabrufe fehlgeschlagen (fetchFailed ${failures.fetchFailed})`;
  }
  if (counters.imageDecoded === 0) {
    return `abgerufene Antworten waren keine dekodierbaren Bilder (${failures.notAnImage} Nicht-Bild/HTML) — vermutlich Nicht-Bild-URLs gesammelt`;
  }
  if (counters.ocrTextPages === 0) {
    return `OCR lieferte keinen Text (${counters.imageDecoded} Bild(er) dekodiert, ${failures.ocrTextEmpty} leer, ${failures.ocrError} OCR-Fehler)`;
  }
  const textClause = textLineCandidateReason(counters, textRejections, textRaw, textSafe, textEmitted, mode);
  return layoutRan ? `${textClause} | ${layoutCandidateReason(layout, mode, noLayoutReason)}` : textClause;
}

/**
 * Dünne, injizierbare Glue: lädt die Prospektbilder (begrenzt) aus der regulären
 * öffentlichen CDN-Quelle, OCR-t sie, extrahiert sicher und baut die strukturierte
 * Bilanz-Diagnose. Wirft nie — ein fehlgeschlagener Bildabruf/OCR zählt als
 * parseError. Im Live-Modus werden die sicheren Kandidaten zurückgegeben.
 */
export async function runLidlProspectOcr(
  input: RunLidlProspectOcrInput,
): Promise<RunLidlProspectOcrResult> {
  const limit = Math.max(0, input.imageLimit ?? LIDL_OCR_DEFAULT_IMAGE_LIMIT);
  const urls = input.imageUrls.slice(0, limit);
  const pages: LidlProspectOcrPage[] = [];
  const layoutPages: OcrLayoutPage[] = [];
  const failures = emptyPipelineFailures();
  let fetchAttempted = 0;
  let fetchSucceeded = 0;
  let imageDecoded = 0;

  const layoutRan = input.ocrLayout != null;
  // Layout-Wortbox-/Clusterdiagnose (trennt „Tesseract liefert keine Boxen" von
  // „unser Code verliert sie"). Über alle Seiten akkumuliert.
  let layoutPagesProbed = 0;
  let pagesWithWordBoxes = 0;
  let totalWordBoxes = 0;
  let totalNormalizedWords = 0;
  let pagesWithLayoutInput = 0;
  let pagesWithValidDimensions = 0;
  // tesseract.js-v7-Struktur-Diagnose, über alle Seiten akkumuliert (trennt „blocks/
  // tsv gar nicht zurückgekommen" von „angefordert, aber leer").
  let pagesWithStructuredRequested = 0;
  let pagesWithStructuredAvailable = 0;
  let totalBlockWords = 0;
  let totalTsvWords = 0;
  // Debug-Evidence: aktiv, sobald ein Sink gesetzt ist (config-gesteuert im Connector).
  const debugActive = input.recordPageEvidence != null;
  const debugLimit = Math.max(0, input.debugEvidenceLimit ?? LIDL_OCR_DEFAULT_IMAGE_LIMIT);
  let debugPagesRecorded = 0;

  // Preisbox-Crop-Pass (DRITTE Kandidatenquelle): aktiv, sobald eine Crop-OCR
  // injiziert ist UND der Crop-Modus != 'off'. Braucht Layout-Wortboxen (ohne Karten
  // keine Regionen). Roh-Kandidaten werden je Bild gesammelt; Gate + Dedupe folgen
  // zentral nach dem Loop (gegen Text- + Layout-Treffer).
  const cropMode = input.priceCropMode ?? 'off';
  const cropActive = input.cropPriceOcr != null && cropMode !== 'off';
  const cropOptions = input.cropOptions ?? {};
  const cropRawAll: CropRawCandidate[] = [];
  const cropRejections = emptyPriceCropRejections();
  let cropAttemptsTotal = 0;
  let cropOcrSucceededTotal = 0;
  let cropParsedPricesTotal = 0;
  let cropGeometricAttemptsTotal = 0;
  let cropGeometricParsedTotal = 0;

  for (const url of urls) {
    fetchAttempted += 1;
    // Schritt 3→4: Abruf. Ein Fehlschlag ist NICHT dasselbe wie „kein Bild".
    let buffer: Uint8Array;
    try {
      buffer = await input.fetchBinary(url);
    } catch {
      failures.fetchFailed += 1;
      continue;
    }
    fetchSucceeded += 1;

    // Schritt 5: Decode-Gate. Eine HTML-/JSON-/Fehlerseite (häufig bei einer
    // versehentlich gesammelten Nicht-Bild-URL) ist KEIN OCR-bares Bild — mit
    // klarem Grund zählen statt leeren Text als raw=0 zu verschleiern.
    const imageFormat = detectImageFormat(buffer);
    if (imageFormat === null) {
      failures.notAnImage += 1;
      continue;
    }
    imageDecoded += 1;

    // Schritt 6: OCR. Runtime-Ausfall ≠ Einzelbild-Fehler ≠ leerer Text.
    let text: string;
    try {
      text = await input.ocrImage(buffer, url);
    } catch (error) {
      if (isOcrRuntimeUnavailable(error)) {
        // Runtime ist weg → weitere Seiten bringen nichts; ehrlich abbrechen.
        failures.ocrRuntimeUnavailable += 1;
        break;
      }
      failures.ocrError += 1;
      continue;
    }
    // OPTIONALE Layoutanalyse je dekodiertem Bild — NICHT-FATAL: wirft sie, bleibt
    // der Textpfad unberührt (Layout ist eine ZUSÄTZLICHE Kandidatenquelle). Die
    // Runtime ist hier verfügbar (sonst hätte `ocrImage` schon geworfen).
    let currentLayoutPage: OcrLayoutPage | null = null;
    if (input.ocrLayout) {
      try {
        currentLayoutPage = await input.ocrLayout(buffer, url);
        if (currentLayoutPage) {
          layoutPagesProbed += 1;
          // Roh-Wortboxen (Tesseract) vs. normalisierte Layoutwörter getrennt
          // bilanzieren — das ist der Kern der noLayout-Ursachentrennung.
          const rawCount = currentLayoutPage.sourceWordCount ?? currentLayoutPage.words.length;
          const normCount = currentLayoutPage.words.length;
          totalWordBoxes += rawCount;
          totalNormalizedWords += normCount;
          // Struktur-Diagnose (nur das reale Pair setzt die Felder).
          if (currentLayoutPage.structuredOutputRequested) {
            pagesWithStructuredRequested += 1;
            if (currentLayoutPage.blocksPresent || currentLayoutPage.tsvPresent) {
              pagesWithStructuredAvailable += 1;
            }
          }
          totalBlockWords += currentLayoutPage.blockWordCount ?? 0;
          totalTsvWords += currentLayoutPage.tsvWordCount ?? 0;
          if (rawCount > 0) {
            pagesWithWordBoxes += 1;
          }
          if (normCount > 0) {
            pagesWithLayoutInput += 1;
            if (currentLayoutPage.width > 0 && currentLayoutPage.height > 0) {
              pagesWithValidDimensions += 1;
            }
            layoutPages.push({ ...currentLayoutPage, imageUrl: url });
          }
        }
      } catch {
        failures.layoutFailed += 1;
      }
    }

    // Preisbox-Crop-Pass je Bild (NICHT-FATAL): nur Karten OHNE sauberen
    // Angebotspreis (noPriceRegion / basePrice) bekommen einen gezielten Crop-OCR-
    // Lauf der verstümmelten Großpreis-Tiles. Roh-Kandidaten werden gesammelt; das
    // geteilte Gate + Dedupe folgen zentral nach dem Loop. Ein Fehler hier bleibt
    // nicht-fatal (Crop ist eine ZUSÄTZLICHE Quelle).
    let currentPageCropEvidence: PriceCropCardEvidence[] = [];
    if (cropActive && input.cropPriceOcr && currentLayoutPage && currentLayoutPage.words.length > 0) {
      try {
        const pageCrop = await runPriceCropForPage({
          page: { ...currentLayoutPage, imageUrl: url },
          imageBytes: buffer,
          imageUrl: url,
          cropOcr: input.cropPriceOcr,
          cropOptions,
        });
        cropAttemptsTotal += pageCrop.attempts;
        cropOcrSucceededTotal += pageCrop.ocrSucceeded;
        cropParsedPricesTotal += pageCrop.parsedPrices;
        cropGeometricAttemptsTotal += pageCrop.geometricAttempts;
        cropGeometricParsedTotal += pageCrop.geometricParsedPrices;
        for (const key of Object.keys(cropRejections) as (keyof LidlPriceCropRejectionCounts)[]) {
          cropRejections[key] += pageCrop.rejections[key];
        }
        cropRawAll.push(...pageCrop.rawCandidates);
        currentPageCropEvidence = pageCrop.evidence;
      } catch {
        /* Crop ist eine ZUSÄTZLICHE Quelle; ein Fehler bricht den Scan nie. */
      }
    }

    // Debug-Evidence je Seite (anzahlbegrenzt) — VOR dem ocrTextEmpty-continue,
    // damit auch eine textlose Seite ihre Wortbox-/Layout-Evidence trägt. Best-
    // effort: ein Debug-Fehler bricht den Scan nie.
    if (debugActive && debugPagesRecorded < debugLimit) {
      try {
        const evidence = buildLidlOcrPageEvidence({
          context: input.context,
          options: input.options,
          ocrMode: input.mode,
          capturedAt: new Date().toISOString(),
          imageUrl: url,
          imageFormat,
          imageByteLength: buffer.length,
          ocrLanguage: 'deu+eng',
          text,
          layoutPage: currentLayoutPage,
          layoutRan,
          priceCropRan: cropActive,
          priceCropCards: currentPageCropEvidence,
        });
        input.recordPageEvidence?.(evidence);
        debugPagesRecorded += 1;
      } catch {
        /* Debug darf den Scan nie brechen. */
      }
    }

    if (normalizeText(text).length === 0) {
      failures.ocrTextEmpty += 1;
      continue;
    }
    // Sicherer Debug-/Diagnose-Hook (nur wenn der Aufrufer ihn explizit setzt) —
    // erlaubt das Erfassen echter OCR-Textzeilen als Fixture, ohne sie massenhaft
    // in Produktivlogs zu schreiben.
    input.onOcrPage?.({
      imageUrl: url,
      text,
      lineCount: text.split(/\r?\n/).filter((entry) => cleanOcrLine(entry)).length,
    });
    pages.push({ text, imageUrl: url });
  }

  const result = extractLidlProspectOcrOffers(pages, input.context, input.options);
  result.ocrAttempted = fetchAttempted;

  // Layoutquelle (zweite Kandidatenquelle): dedupliziert ZUSÄTZLICH gegen die
  // bereits per Textzeile extrahierten Namen, damit ein von beiden Quellen
  // erkanntes Produkt nicht doppelt emittiert wird.
  const layoutResult = layoutRan
    ? extractLidlLayoutOffers(layoutPages, input.context, input.options)
    : emptyLayoutResult();
  // Quellenübergreifendes Dedupe: Layout-Offer raus, wenn der Name schon als
  // Textzeilen-Offer (oder strukturell) gesehen wurde.
  const textKeys = new Set(
    [...(input.context.existingNameKeys ?? [])].map((key) => normalizeText(String(key))),
  );
  for (const offer of result.offers) {
    textKeys.add(normalizeText(offer.name));
  }
  const dedupedLayoutOffers = layoutResult.offers.filter((offer) => !textKeys.has(normalizeText(offer.name)));
  const layoutDuplicates = layoutResult.offers.length - dedupedLayoutOffers.length;
  if (layoutDuplicates > 0) {
    layoutResult.rejections.duplicate += layoutDuplicates;
    layoutResult.layoutSafeCandidates -= layoutDuplicates;
  }
  layoutResult.offers = dedupedLayoutOffers;

  // Preisbox-Crop-Quelle (DRITTE Quelle): das geteilte Sicherheits-Gate + Dedupe
  // gegen existierende + Text- + Layout-Namen. Die Roh-Kandidaten (Crop-Preis +
  // verknüpfter Kartenname) wurden je Bild gesammelt; ihre Region-/Parse-Stufen sind
  // bereits in `cropRejections` bilanziert. Hier folgen die Gate-Stufen (nonFood/
  // categoryConflict/missingStrongFoodEvidence/nameQuality/duplicate/lowConfidence).
  const cropHelpers = resolveSafetyHelpers(input.options ?? {});
  const cropSeen = new Set<string>(
    [...(input.context.existingNameKeys ?? [])].map((key) => normalizeText(String(key))),
  );
  for (const offer of result.offers) {
    cropSeen.add(normalizeText(offer.name));
  }
  for (const offer of dedupedLayoutOffers) {
    cropSeen.add(normalizeText(offer.name));
  }
  const cropOffers: RawOfferCandidate[] = [];
  for (const raw of cropRawAll) {
    const verdict = classifyOcrCandidate(raw.name, cropHelpers, cropSeen);
    if (!verdict.ok) {
      cropRejections[verdict.reason] += 1;
      continue;
    }
    cropOffers.push(
      buildOcrOfferCandidate({
        context: input.context,
        name: raw.name,
        category: verdict.category,
        price: raw.price,
        unit: raw.unit,
        imageUrl: raw.imageUrl,
        sourceKind: 'price_crop',
      }),
    );
  }
  const cropSafe = cropOffers.length;
  const priceCropResult: LidlPriceCropResult = {
    offers: cropOffers,
    priceCropAttempts: cropAttemptsTotal,
    priceCropOcrSucceeded: cropOcrSucceededTotal,
    priceCropParsedPrices: cropParsedPricesTotal,
    cropRawCandidates: cropRawAll.length,
    cropSafeCandidates: cropSafe,
    geometricCropAttempts: cropGeometricAttemptsTotal,
    geometricCropParsedPrices: cropGeometricParsedTotal,
    rejections: cropRejections,
  };

  const textSafe = result.offers.length;
  const layoutSafe = dedupedLayoutOffers.length;
  const textEmitted = input.mode === 'live' ? textSafe : 0;
  // Crop-Offer gehen NUR live, wenn der Lauf live ist UND der Crop-Modus live ist
  // (diagnostic emittiert nie live, selbst bei cropMode='live').
  const cropEmitted = input.mode === 'live' && cropMode === 'live' ? cropOffers : [];
  const emittedOffers =
    input.mode === 'live' ? [...result.offers, ...dedupedLayoutOffers, ...cropEmitted] : [];

  const counters: LidlOcrPipelineCounters = {
    prospectPages: Math.max(0, input.prospectPageCount ?? 0),
    collectedImageUrls: input.imageUrls.length,
    fetchAttempted,
    fetchSucceeded,
    imageDecoded,
    ocrTextPages: result.ocrCandidatePages,
    rawOcrLines: result.ocrTextLines,
    priceLinesFound: result.priceLinesFound,
    productNameBlocksFound: result.productNameBlocksFound,
    rawCandidates: result.ocrParsedOffers + layoutResult.layoutRawCandidates,
    safeCandidates: textSafe + layoutSafe,
    emittedOffers: emittedOffers.length,
    textLineRawCandidates: result.ocrParsedOffers,
    layoutCardsDetected: layoutResult.layoutCardsDetected,
    layoutRawCandidates: layoutResult.layoutRawCandidates,
    layoutSafeCandidates: layoutSafe,
    priceCropAttempts: cropAttemptsTotal,
    priceCropOcrSucceeded: cropOcrSucceededTotal,
    priceCropParsedPrices: cropParsedPricesTotal,
    cropRawCandidates: cropRawAll.length,
    cropSafeCandidates: cropSafe,
    geometricCropAttempts: cropGeometricAttemptsTotal,
    geometricCropParsedPrices: cropGeometricParsedTotal,
    finalEmittedOffers: emittedOffers.length,
  };
  // Dominante noLayout-Ursache des Laufs (nur relevant, wenn 0 Karten entstanden):
  // die EINE Stufe, an der die Layoutkette fiel. Aus den über alle Seiten
  // akkumulierten Roh-/Normalisierten-Wortboxzahlen + Bildmaßen abgeleitet.
  const dominantNoLayoutReason = deriveNoLayoutReason({
    layoutRan,
    rawWordBoxCount: totalWordBoxes,
    normalizedWordCount: totalNormalizedWords,
    validDimensions: pagesWithValidDimensions > 0,
    cardsDetected: layoutResult.layoutCardsDetected,
    // Nur wenn mindestens eine Seite die Struktur-Diagnose trug (reales Pair) die
    // neuen Ursachen unterscheiden; sonst undefined → wie bisher noWordBoxesFromOcr.
    structuredOutputRequested:
      layoutPagesProbed > 0 ? pagesWithStructuredRequested > 0 : undefined,
    structuredOutputAvailable:
      pagesWithStructuredRequested > 0 ? pagesWithStructuredAvailable > 0 : undefined,
  });
  const layoutDiagnostics: LidlOcrLayoutDiagnostics = {
    layoutRan,
    pagesProbed: layoutPagesProbed,
    pagesWithWordBoxes,
    totalWordBoxes,
    totalNormalizedWords,
    pagesWithLayoutInput,
    pagesWithValidDimensions,
    layoutClusterAttempts: pagesWithLayoutInput,
    layoutCardsDetected: layoutResult.layoutCardsDetected,
    dominantNoLayoutReason,
    structuredOutputRequestedPages: pagesWithStructuredRequested,
    structuredOutputAvailablePages: pagesWithStructuredAvailable,
    totalBlockWords,
    totalTsvWords,
  };

  const basePrimaryReason = determinePrimaryReason({
    counters,
    failures,
    textRejections: result.rejections,
    textRaw: result.ocrParsedOffers,
    textSafe,
    textEmitted,
    layout: layoutResult,
    layoutRan,
    noLayoutReason: dominantNoLayoutReason,
    mode: input.mode,
  });
  // Crop-Teilursache anhängen (nur wenn der Crop-Pass lief) — die textbasierte
  // Preisregion und der Crop-Pass bleiben getrennt benannt.
  const primaryReason = cropActive
    ? `${basePrimaryReason} | ${cropCandidateReason(priceCropResult, cropMode, input.mode)}`
    : basePrimaryReason;

  // Vollständige Zählkette in EINER Note — der nächste Live-Scan ist daran
  // erklärbar, ohne in den Code schauen zu müssen. Bei aktiver Layoutanalyse trägt
  // die Note zusätzlich die Layout-Bilanz (Karten/raw/safe + Verwerfungsgründe) und
  // — bei 0 Karten — die getrennte Wortbox-Ursache.
  const layoutSegment = layoutRan
    ? ` | Layout: ${layoutResult.layoutCardsDetected} Karten → ` +
      `${layoutResult.layoutRawCandidates} layoutRawCandidates → ` +
      `${layoutSafe} layoutSafeCandidates (Fehlschläge ${failures.layoutFailed}); ` +
      `Wortboxen: pagesWithWords ${pagesWithWordBoxes}, totalWordBoxes ${totalWordBoxes}, ` +
      `pagesWithLayoutInput ${pagesWithLayoutInput}, layoutClusterAttempts ${pagesWithLayoutInput}, ` +
      `layoutCardsDetected ${layoutResult.layoutCardsDetected}; ` +
      `struktur: blockWords ${totalBlockWords}, tsvWords ${totalTsvWords}, ` +
      `structuredRequestedPages ${pagesWithStructuredRequested}, ` +
      `structuredAvailablePages ${pagesWithStructuredAvailable}` +
      (dominantNoLayoutReason ? `, dominantNoLayoutReason ${dominantNoLayoutReason}` : '') +
      `; layoutRejectedByReason: ${summarizeLayoutRejections(layoutResult.rejections)}`
    : '';
  // Preisbox-Crop-Segment (nur wenn aktiv) — getrennt von der textbasierten
  // layoutRawCandidates-Bilanz: priceCropAttempts/OcrSucceeded/ParsedPrices,
  // cropRawCandidates, cropSafeCandidates, emittedOffers + cropRejectedByReason.
  // Der GEOMETRISCHE (anker-freie) Fallback-Finder wird getrennt ausgewiesen
  // (visualCropAttempts/visualCropParsedPrices), damit die Note belegt, ob der NEUE
  // visuelle Crop Preise fand — statt nur noCropRegion/cropOcrUnreadable zu zeigen.
  const cropSegment = cropActive
    ? ` | Preis-Crop (${cropMode}): ${cropAttemptsTotal} Versuche → ${cropOcrSucceededTotal} OCR-Text → ` +
      `${cropParsedPricesTotal} priceCropParsedPrices → ${cropRawAll.length} cropRawCandidates → ` +
      `${cropSafe} cropSafeCandidates → ${cropEmitted.length} emittedOffers; ` +
      `visuell (geometrisch): ${cropGeometricAttemptsTotal} visualCropAttempts → ` +
      `${cropGeometricParsedTotal} visualCropParsedPrices; ` +
      `cropRejectedByReason: ${summarizeCropRejections(cropRejections)}`
    : '';
  // Debug-Evidence-Referenz (nur im Debug-Modus) — wo der nächste Scan die
  // reproduzierbaren Fixtures findet.
  const debugSegment =
    debugActive
      ? ` | Debug-Evidence: debugEvidencePath ${input.debugEvidencePath ?? '(in-memory)'}, ` +
        `pagesRecorded ${debugPagesRecorded}`
      : '';
  const note =
    `OCR ${input.mode} | Kette: ${counters.prospectPages} Prospektseiten → ` +
    `${counters.collectedImageUrls} Bild-URL(s) → ${counters.fetchAttempted} abgerufen ` +
    `(${counters.fetchSucceeded} ok, ${failures.fetchFailed} fehlgeschlagen) → ` +
    `${counters.imageDecoded} dekodierbare Bilder (${failures.notAnImage} kein Bild) → ` +
    `${counters.ocrTextPages} mit OCR-Text ` +
    `(leer ${failures.ocrTextEmpty}, Runtime fehlt ${failures.ocrRuntimeUnavailable}, OCR-Fehler ${failures.ocrError}) → ` +
    `${counters.rawOcrLines} Textzeilen ` +
    `(${counters.priceLinesFound} Preiszeilen, ${counters.productNameBlocksFound} Namensblöcke) → ` +
    `${counters.textLineRawCandidates} textLineRawCandidates / ${counters.rawCandidates} Roh-Kandidaten (Text+Layout) → ` +
    `${counters.safeCandidates} sicher → ${counters.finalEmittedOffers} finalEmittedOffers.` +
    layoutSegment +
    cropSegment +
    debugSegment +
    ` Ursache: ${primaryReason}. ${summarizeRejections(result.rejections)}; ` +
    `${summarizeFailures(failures)}.`;
  const diagnostic = buildSubSourceDiagnostic({
    storeChain: input.context.storeChain,
    sourceId: `${input.context.sourceId ?? input.context.storeChain.toLowerCase()}${LIDL_OCR_DIAGNOSTIC_SUFFIX}`,
    status: emittedOffers.length > 0 ? 'success' : 'empty',
    urlOrSlug: input.context.sourceId,
    // Roh-Zahl = textbasierte (Text+Layout) PLUS Crop-Roh-Kandidaten (crop off → +0).
    rawCount: counters.rawCandidates + counters.cropRawCandidates,
    resultCount: emittedOffers.length,
    note,
  });

  return {
    result,
    layoutResult,
    priceCropResult,
    diagnostic,
    emittedOffers,
    counters,
    failures,
    layoutRejectedByReason: layoutResult.rejections,
    primaryReason,
    layoutDiagnostics,
    debug: debugActive ? { evidencePath: input.debugEvidencePath, pagesRecorded: debugPagesRecorded } : undefined,
  };
}
