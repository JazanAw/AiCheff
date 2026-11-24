import type { OcrLayoutPage, OcrLayoutWord } from './lidlProspectOcr';

// Reproduktions-Fixtures für den Lidl-Prospektbild-OCR-Pfad.
//
// Synthetisch nachgebildet nach der Schwarz/Lidl-Leaflet-v4-`flyer.pages`-Form
// (KEINE echten Tracking-IDs, keine rechtlich heiklen Inhalte) — gerade genug
// Struktur, um die Bild-URL-Sammlung reproduzierbar zu testen:
//   • mehrere Renditions je Seite (endungslose CDN-Render-Endpunkte + klassische
//     Endungs-URLs),
//   • ein Nicht-Bild-`self`-Link unter `links` (muss verworfen werden),
//   • ein `.json`-Tracking-Link unter einem Bildfeld (muss verworfen werden),
//   • ein Produktbild unter `flyer.products` (KEINE Prospekt-Bildseite).
// Damit deckt EIN Fixture die Root-Cause-Fragen ab: findet die Sammlung
// verschachtelte/endungslose Bild-URLs, verwirft sie Navigations-/Tracking-Links?

/** Realistische (synthetische) Schwarz/Lidl-`flyer`-Antwort mit Prospekt-Bildseiten. */
export const LIDL_FLYER_PAGES_FIXTURE = {
  flyer: {
    offerStartDate: '2026-06-15',
    offerEndDate: '2026-06-20',
    // Strukturierte Produkte sind überwiegend Wein/Online — KEINE Bildseiten.
    products: {
      '1': { title: 'Rotwein trocken', image: 'https://www.lidl.de/assets/wein.jpg' },
    },
    pages: [
      {
        pageNumber: 1,
        // Mehrere Render-Auflösungen derselben Seite (endungslos, CDN-Endpoint).
        media: [
          { width: 1080, src: 'https://leaflet-cdn.schwarz/v4/render/p1?w=1080' },
          { width: 540, src: 'https://leaflet-cdn.schwarz/v4/render/p1?w=540' },
        ],
        // Klassische Endungs-Variante derselben Seite.
        image: { url: 'https://leaflet-cdn.schwarz/v4/pages/p1-lg.jpg' },
        // Navigations-/Deep-Link unter `links` → KEIN Bild, muss raus.
        links: { self: 'https://www.lidl.de/c/online-prospekte/s10005610' },
        // Tracking unter Bildfeld → `.json`-Denylist greift.
        trackingUrl: 'https://track.schwarz/api/hit.json',
      },
      {
        pageNumber: 2,
        renditions: {
          thumb: 'https://leaflet-cdn.schwarz/v4/pages/p2-thumb.webp',
          full: 'https://leaflet-cdn.schwarz/v4/pages/p2-lg.webp',
        },
      },
    ],
  },
};

/** Minimaler gültiger PNG-Header (Magic-Bytes) + Padding — passiert den Decode-Gate
 *  (`detectImageFormat`), ohne ein echtes Bild zu sein. Die OCR wird in Tests
 *  ohnehin injiziert; nur die Magic-Bytes müssen stimmen. */
export function fakePngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
}

/** Minimaler gültiger JPEG-Header (Magic-Bytes) + Padding. */
export function fakeJpegBytes(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
}

/** Minimaler WebP-Container-Header („RIFF"…„WEBP") — passiert `detectImageFormat`
 *  als 'webp', ist aber von node-canvas NICHT dekodierbar (Tile-Render-Root-Cause). */
export function fakeWebpBytes(): Uint8Array {
  return new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0]);
}

/** Minimaler AVIF-Container-Header („…ftypavif") — `detectImageFormat` ⇒ 'avif',
 *  ebenfalls nicht canvas-dekodierbar. */
export function fakeAvifBytes(): Uint8Array {
  return new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0, 0, 0]);
}

/** HTML-/Fehlerseiten-Bytes — der typische Inhalt, den eine fälschlich gesammelte
 *  Nicht-Bild-URL liefert. Passiert den Decode-Gate NICHT (`notAnImage`). */
export function fakeHtmlBytes(): Uint8Array {
  return new TextEncoder().encode('<!DOCTYPE html><html><head><title>Lidl</title></head></html>');
}

// ---------------------------------------------------------------------------
// OCR-Textzeilen-Fixtures (anonymisiert) — nachgebildet nach dem TYPISCHEN
// tesseract-Output echter Lidl-Prospekt-Bildseiten. Generische Lebensmittelnamen
// (reine Test-Reproduktion, KEINE KW-/Marken-Allowlist) decken die realen
// Parser-Stolperstellen ab: große Preis-Optik (Euro/Cent getrennt), Leerzeichen-
// statt Komma-Preise, Strich-Cents, OCR-Buchstabenverwechsler in Ziffern,
// mehrzeilige Namen, Grundpreis-/Pfandzeilen, Slogans zwischen Produkten.
// ---------------------------------------------------------------------------

/** Mehrzeiliger Name + Angebotspreis auf eigener Zeile → 1 Kandidat. */
export const OCR_MULTILINE_NAME = ['Frische', 'Haehnchenbrust', '2,99 €'].join('\n');

/** Euro und Cent stehen auf GETRENNTEN Zeilen (große Preis-Optik) → 1 Kandidat. */
export const OCR_SPLIT_EURO_CENT = ['Rispentomaten', '500 g Schale', '1', '99'].join('\n');

/** Leerzeichen-getrennter Preis „1 99" (kein Dezimaltrenner) → 1 Kandidat. */
export const OCR_SPACE_PRICE = ['Bio Bananen', 'je 1 kg', '2 49'].join('\n');

/** Nur ein Grundpreis (kein Angebotspreis) → kein Kandidat, basePriceOnly. */
export const OCR_BASE_PRICE_ONLY = ['Speisefruehkartoffeln', '1 kg = 3,98 €'].join('\n');

/** Nur eine Pfandzeile → kein Kandidat, deposit. */
export const OCR_DEPOSIT_ONLY = ['Mineralwasser Classic', 'zzgl. 0,25 € Pfand'].join('\n');

/** Reine CTA-/Heading-/Slogan-Seite ohne Produkt-Preis-Block → kein Kandidat. */
export const OCR_CTA_HEADING = [
  'LIDL LOHNT SICH',
  'Jetzt App laden und sparen',
  'Nur in dieser Woche',
].join('\n');

/** OCR-Buchstabenverwechsler in den Preisziffern (O→0, l→1, I→1) + Strich-Cents
 *  „1,-" → alle vier ergeben plausible Kandidaten. */
export const OCR_DIGIT_ERRORS = [
  'Joghurt Natur',
  'O,99 €',
  'Markenbutter',
  'l.49',
  'Roestkaffee',
  'I,99',
  'Weizenmehl',
  '1,-',
].join('\n');

/** Non-Food-Küchengerät mit OCR-Preis (echter Live-Fehlbefund: „Eiswürfelmaschine"
 *  als OCR „Eiswiirfelmaschine", die fälschlich live als Snacks/Süßes landete). Der
 *  Name trägt den Non-Food-Kompositum-Kopf „maschine" und über das „eis"-Präfix
 *  eine FOOD-Kategorie → categoryConflict. Reine Test-Reproduktion, kein Sollwert. */
export const OCR_NONFOOD_DEVICE = ['Eiswiirfelmaschine', '8,77 €'].join('\n');

/** OCR-Müllname mit Preis (echter Live-Fehlbefund „Fo g i m m"): überwiegend
 *  Einzelbuchstaben-Tokens, kein echtes Wort → nameQuality, nie sicher/live. */
export const OCR_GARBAGE_NAME = ['Fo g i m m', '11,01 €'].join('\n');

/** Non-Food mit LEBENSMITTEL-NAHER Kategorie: „Wasserfilter" trägt über „wasser"
 *  die Food-Kategorie „Getränke Alkoholfrei", ist aber über „…filter" Non-Food →
 *  darf nie live (categoryConflict). */
export const OCR_NONFOOD_FOODNEAR = ['Wasserfilter Kartusche', '14,99 €'].join('\n');

/** Schwacher Name mit Preis, aber OHNE jeden Food-Beleg (kein Food-Keyword, keine
 *  Food-Kategorie, kein Non-Food-Signal) → missingStrongFoodEvidence, nie live. */
export const OCR_WEAK_NO_FOOD = ['Markenprodukt Profi', '3,49 €'].join('\n');

/** Mehrere Produkte auf EINER Seite, Slogans/Gültigkeit/Einheiten dazwischen,
 *  gemischte Preisformate → mehrere Kandidaten. */
export const OCR_MULTI_PRODUCT_PAGE = [
  'LIDL Prospekt',
  'gültig 15.06. bis 20.06.',
  'Rispentomaten',
  '500 g',
  '1 99',
  'Bio Bananen',
  'je 1 kg',
  '1',
  '79',
  'Frische Haehnchenbrust',
  '2,99 €',
  'Deutsche Heidelbeeren',
  'Knaller',
  '0,99 €',
  'Seite 1',
].join('\n');

// ---------------------------------------------------------------------------
// LAYOUT-FIXTURES (synthetisch, anonymisiert) — nachgebildet nach der TYPISCHEN
// Lidl-Prospektkartenoptik: Produktkarte mit großem Aktionspreis, Namensblock,
// kleinem Grundpreis, Top-left-Badge. KEINE echten Produktlisten/Marken — generische
// Lebensmittelnamen als reine Test-Reproduktion. Koordinaten in Bildpixeln; `h`
// (Worthöhe) bildet die Schriftgröße ab (große Preisziffern = große h). Eine Karte je
// Seite (klare Cluster), getrennt durch große Abstände bei Mehrkartenseiten.
// ---------------------------------------------------------------------------

export interface LayoutWordSpec {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  colorTag?: 'action_red' | 'action_yellow';
}

/** Baut eine OcrLayoutPage aus kompakten Wort-Specs (Default-Seitenmaße 1000×1400). */
export function makeLayoutPage(
  words: readonly LayoutWordSpec[],
  options: { width?: number; height?: number; imageUrl?: string } = {},
): OcrLayoutPage {
  const layoutWords: OcrLayoutWord[] = words.map((spec) => ({
    text: spec.text,
    bbox: { x: spec.x, y: spec.y, w: spec.w, h: spec.h },
    colorTag: spec.colorTag,
  }));
  return {
    width: options.width ?? 1000,
    height: options.height ?? 1400,
    words: layoutWords,
    imageUrl: options.imageUrl,
  };
}

/** Produktkarte mit großer Preisbox (Euro/Cent getrennt, große Optik) + Namensblock
 *  darüber → 1 Layout-Kandidat (Haehnchenbrust, 2,99). „Frische" ist ein generisches
 *  Attribut und fällt — wie in der Textzeilenquelle — aus dem Namen. */
export const LAYOUT_FOOD_BIG_PRICE = makeLayoutPage([
  { text: 'Frische', x: 120, y: 120, w: 160, h: 38 },
  { text: 'Haehnchenbrust', x: 120, y: 175, w: 320, h: 38 },
  { text: '2', x: 150, y: 255, w: 70, h: 120 },
  { text: '99', x: 235, y: 270, w: 55, h: 70 },
]);

/** Karte mit NUR einem Grundpreis nahe der Produktbeschreibung („1 kg = 3,98") →
 *  kein Angebotspreis → kein Kandidat (basePriceOnly). Der Grundpreis darf NIE als
 *  Angebotspreis genommen werden. */
export const LAYOUT_BASE_PRICE_ONLY = makeLayoutPage([
  { text: 'Speisefruehkartoffeln', x: 120, y: 120, w: 360, h: 38 },
  { text: '1', x: 120, y: 180, w: 18, h: 24 },
  { text: 'kg', x: 150, y: 180, w: 34, h: 24 },
  { text: '=', x: 196, y: 180, w: 16, h: 24 },
  { text: '3,98', x: 224, y: 180, w: 90, h: 28 },
]);

/** Karte mit großem Aktionspreis (1,99) UND kleinem Grundpreis (1 kg = 3,98) →
 *  Kandidat nimmt den prominenten Aktionspreis, NIE den Grundpreis. */
export const LAYOUT_OFFER_OVER_BASE = makeLayoutPage([
  { text: 'Rispentomaten', x: 120, y: 120, w: 280, h: 40 },
  { text: '1', x: 150, y: 200, w: 60, h: 110 },
  { text: '99', x: 225, y: 215, w: 50, h: 65 },
  { text: '1', x: 120, y: 350, w: 16, h: 22 },
  { text: 'kg', x: 144, y: 350, w: 30, h: 22 },
  { text: '=', x: 184, y: 350, w: 14, h: 22 },
  { text: '3,98', x: 210, y: 350, w: 78, h: 26 },
]);

/** Karte mit Top-left-Badge „3 Stück" (oben links, kurz) + echtem Namensblock
 *  darunter + großem Preis → Kandidat nimmt „Bio Bananen", NIE das Badge. */
export const LAYOUT_TOPLEFT_BADGE = makeLayoutPage([
  { text: '3', x: 120, y: 100, w: 24, h: 30 },
  { text: 'Stück', x: 152, y: 100, w: 90, h: 30 },
  { text: 'Bio', x: 120, y: 185, w: 60, h: 40 },
  { text: 'Bananen', x: 190, y: 185, w: 170, h: 40 },
  { text: '1', x: 150, y: 270, w: 65, h: 115 },
  { text: '79', x: 230, y: 285, w: 50, h: 65 },
]);

/** Non-Food-Karte mit großer Preisbox (Akkuschrauber, 49,99) → verworfen (nonFood
 *  über den strukturellen Kompositum-Kopf „…schrauber"/„akku"). */
export const LAYOUT_NONFOOD_DEVICE = makeLayoutPage([
  { text: 'Akkuschrauber', x: 120, y: 120, w: 280, h: 40 },
  { text: '49', x: 150, y: 205, w: 95, h: 110 },
  { text: '99', x: 260, y: 220, w: 50, h: 65 },
]);

/** Non-Food-Küchengerät mit Food-naher Kategorie (Eiswiirfelmaschine, 8,77) →
 *  categoryConflict (Kategorie über „eis"-Präfix Food, Beleg „…maschine" Non-Food).
 *  Reproduziert den echten Live-Fehlbefund auch für die Layoutquelle. */
export const LAYOUT_NONFOOD_ICEMAKER = makeLayoutPage([
  { text: 'Eiswiirfelmaschine', x: 120, y: 120, w: 340, h: 40 },
  { text: '8', x: 150, y: 205, w: 70, h: 110 },
  { text: '77', x: 235, y: 220, w: 50, h: 65 },
]);

/** OCR-Müllname mit großer Preisbox (Fo g i m m, 11,01) → nameQuality, nie sicher.
 *  Reproduziert den echten Live-Fehlbefund auch für die Layoutquelle. */
export const LAYOUT_GARBAGE_NAME = makeLayoutPage([
  { text: 'Fo', x: 120, y: 120, w: 40, h: 38 },
  { text: 'g', x: 170, y: 120, w: 18, h: 38 },
  { text: 'i', x: 200, y: 120, w: 10, h: 38 },
  { text: 'm', x: 220, y: 120, w: 24, h: 38 },
  { text: 'm', x: 252, y: 120, w: 24, h: 38 },
  { text: '11', x: 150, y: 205, w: 90, h: 110 },
  { text: '01', x: 255, y: 220, w: 50, h: 65 },
]);

/** Food-Karte ohne starken Food-Beleg (kein Food-Keyword, keine Food-Kategorie)
 *  mit Preisbox → missingStrongFoodEvidence, bleibt nicht live. */
export const LAYOUT_WEAK_NO_FOOD = makeLayoutPage([
  { text: 'Markenprodukt', x: 120, y: 120, w: 240, h: 38 },
  { text: 'Profi', x: 370, y: 120, w: 90, h: 38 },
  { text: '3', x: 150, y: 205, w: 70, h: 110 },
  { text: '49', x: 235, y: 220, w: 50, h: 65 },
]);

/** Karte mit ZWEI gleichprominenten Aktionspreisen (mehrdeutig: welcher ist der
 *  echte Angebotspreis?) → lowLayoutConfidence, nicht live (obwohl der Name food
 *  ist). Beweist: Layout-Konfidenz blockt, nicht das Food-Gate. */
export const LAYOUT_AMBIGUOUS_PRICE = makeLayoutPage([
  { text: 'Apfelsaft', x: 120, y: 120, w: 200, h: 38 },
  { text: '1,99', x: 140, y: 205, w: 120, h: 100 },
  { text: '2,49', x: 140, y: 330, w: 120, h: 100 },
]);

/** Karte mit NORMALER Schrift, aber roter Aktionsfarbfläche um den Preis →
 *  prominent über die Farbe (nicht über die Größe) → Kandidat (Joghurt, 0,99). */
export const LAYOUT_COLOR_PRICE = makeLayoutPage([
  { text: 'Joghurt', x: 120, y: 120, w: 160, h: 38 },
  { text: '0,99', x: 140, y: 200, w: 110, h: 40, colorTag: 'action_red' },
]);

/** OCR-Buchstabenverwechsler MITTEN im Layout-Preis (große Optik): Euro als „l"
 *  (Kleinbuchstabe L → 1), Cent „99" → muss zu 1,99 zerfallen. Beweist die
 *  Digit-Verwechsler-Robustheit auch in der Layoutquelle. */
export const LAYOUT_DIGIT_CONFUSION = makeLayoutPage([
  { text: 'Speisequark', x: 120, y: 120, w: 220, h: 38 },
  { text: 'l', x: 150, y: 205, w: 55, h: 110 },
  { text: '99', x: 225, y: 220, w: 50, h: 65 },
]);

/** Layout-Pfandzeile (kein Angebotspreis): „zzgl. 0,25 Pfand" als eigene Zeile →
 *  deposit, NIE als Angebotspreis. */
export const LAYOUT_DEPOSIT_ONLY = makeLayoutPage([
  { text: 'Mineralwasser', x: 120, y: 120, w: 240, h: 38 },
  { text: 'zzgl.', x: 120, y: 200, w: 60, h: 24 },
  { text: '0,25', x: 190, y: 200, w: 70, h: 24 },
  { text: 'Pfand', x: 270, y: 200, w: 80, h: 24 },
]);

// ---------------------------------------------------------------------------
// REAL-ABGELEITETE noPriceRegion-Fixtures — Wortboxen 1:1 aus echten Lidl-Full-Scan-
// Debug-Artefakten (backend/data/debug/lidl-ocr/lidl-2026-06-20T20-43-31-647Z),
// nur Produkt-/Markenwörter anonymisiert. Sie belegen die ECHTE Root-Cause von
// noPriceRegion: die stylisierten Großpreis-Tiles werden vom OCR zu Low-Conf-Glyphen
// verstümmelt (z. B. „£08"), es gibt KEINE preisförmigen Tokens — nur Gültigkeitsdaten
// und Grundpreise. Der Extractor erfindet daraus korrekt KEINEN Preis.
// ---------------------------------------------------------------------------

/** Echte Karte (Debug card[3], page-002) verbatim: nur ein Gültigkeits-Tagesdatum
 *  („15.6.") + dekorative Striche, sonst keine Ziffern → noPriceRegion /
 *  onlyDateOrLegal. KEIN KW-/Kalenderrechnen — das Datum wird nur NICHT als Preis
 *  gewertet. */
export const LAYOUT_REAL_ONLY_DATE = makeLayoutPage(
  [
    { text: 'Ab', x: 140, y: 597, w: 44, h: 26 },
    { text: 'Mo.', x: 195, y: 582, w: 51, h: 55 },
    { text: '15.6.', x: 259, y: 582, w: 77, h: 55 },
    { text: 'f', x: 268, y: 680, w: 45, h: 97 },
    { text: '\\', x: 336, y: 683, w: 23, h: 19 },
  ],
  { width: 1400, height: 2480 },
);

/** Food-Karte nachgebildet aus echter Debug card[13] (page-002), Produktname
 *  anonymisiert, Koordinaten kompakt zu EINEM Cluster verdichtet (die echten
 *  Glyph-TEXTE sind unverändert): der Angebotspreis-Tile ist OCR-verstümmelt
 *  („£08", real conf 20 — KEIN preisförmiges Token); das EINZIGE preisförmige Token
 *  ist der GRUNDPREIS „1kg = 39.96". Korrektes Verhalten: basePrice (Grundpreis wird
 *  NIE Angebotspreis), nichts live. */
export const LAYOUT_REAL_GARBLED_TILE_BASEPRICE = makeLayoutPage([
  // OCR-Müll-Glyphen des großen Preis-Tiles (real „£08"/Streuziffern) — kein Preis.
  { text: '4', x: 220, y: 140, w: 32, h: 25 },
  { text: '7', x: 300, y: 140, w: 14, h: 24 },
  { text: '£08', x: 150, y: 175, w: 112, h: 49 },
  { text: 'Rindersteak', x: 120, y: 240, w: 133, h: 40 },
  { text: 'Frisch', x: 270, y: 245, w: 74, h: 27 },
  // Grundpreiszeile (real, hohe conf): „250 g; 1kg = 39.96".
  { text: '250', x: 120, y: 300, w: 31, h: 17 },
  { text: '1kg', x: 160, y: 300, w: 32, h: 22 },
  { text: '=', x: 200, y: 300, w: 12, h: 17 },
  { text: '39.96', x: 220, y: 300, w: 48, h: 17 },
]);

/** Wie oben, aber OHNE die Grundpreiszeile: nur der verstümmelte Preis-Tile („£08")
 *  + Streuglyphen + Name → es existiert GAR kein preisförmiges Token → noPriceRegion /
 *  noPriceLikeWords. Belegt: aus OCR-Müll wird kein Preis erfunden. */
export const LAYOUT_REAL_GARBLED_TILE_NO_PRICE = makeLayoutPage([
  { text: '4', x: 220, y: 140, w: 32, h: 25 },
  { text: '7', x: 300, y: 140, w: 14, h: 24 },
  { text: '£08', x: 150, y: 175, w: 112, h: 49 },
  { text: 'Rindersteak', x: 120, y: 240, w: 133, h: 40 },
  { text: 'Frisch', x: 270, y: 245, w: 74, h: 27 },
]);

/** Synthetisch (real-strukturiert): großer Euro-Ziffernblock und ein 2-stelliger
 *  Cent-Block liegen räumlich BENACHBART, aber in GETRENNTEN Zeilen (zu großer
 *  y-Abstand für die Zeilengruppierung) → kein Preis-Token entsteht, die Feindiagnose
 *  meldet splitPriceNotCombined (Hinweis für die nächste Gruppierungs-Justierung). */
export const LAYOUT_SPLIT_NOT_COMBINED = makeLayoutPage([
  { text: 'Tafeltrauben', x: 120, y: 120, w: 240, h: 40 },
  { text: '5', x: 150, y: 200, w: 60, h: 110 },
  { text: '55', x: 235, y: 330, w: 50, h: 60 },
]);

// ---------------------------------------------------------------------------
// PREISBOX-CROP-FIXTURES — Karten mit verstümmeltem Großpreis-Tile, die der
// reguläre Layout-Preisextractor NICHT lesen kann (noPriceRegion) → erst der
// gezielte Preisbox-Crop-Pass (separates Re-OCR der Tile-Region) kann den Preis
// recovern. „£08" ist die echte OCR-Verstümmelung der großen Lidl-Preisziffern
// (real conf ~20). Eine Crop-OCR wird in den Tests injiziert (kein echtes Bild).
// ---------------------------------------------------------------------------

/** FOOD-Karte mit verstümmeltem Großpreis-Tile (kein parsebarer Layout-Preis) →
 *  noPriceRegion → der Crop-Pass greift; der Name ist food (Rispentomaten). */
export const LAYOUT_CROP_FOOD_GARBLED = makeLayoutPage([
  { text: 'Rispentomaten', x: 120, y: 120, w: 280, h: 40 },
  { text: '£08', x: 150, y: 205, w: 120, h: 100 },
]);

/** NON-FOOD-Karte mit verstümmeltem Großpreis-Tile → der Crop-Pass kann zwar einen
 *  Preis recovern, das geteilte Safety-Gate verwirft den Kandidaten aber
 *  (Akkuschrauber → strukturelles Non-Food-Signal). */
export const LAYOUT_CROP_NONFOOD_GARBLED = makeLayoutPage([
  { text: 'Akkuschrauber', x: 120, y: 120, w: 280, h: 40 },
  { text: '£08', x: 150, y: 205, w: 120, h: 100 },
]);

/** Karte, in der das EINZIGE preisförmige Token ein Grundpreis ist (1 kg = 3,98) und
 *  KEIN prominenter ziffern-tragender Tile existiert → der Crop-Pass findet keine
 *  Anker-Region (cropLooksLikeBasePrice), erfindet keinen Preis. */
export const LAYOUT_CROP_BASEPRICE_ONLY = makeLayoutPage([
  { text: 'Speisefruehkartoffeln', x: 120, y: 120, w: 360, h: 38 },
  { text: '1', x: 120, y: 185, w: 16, h: 22 },
  { text: 'kg', x: 144, y: 185, w: 30, h: 22 },
  { text: '=', x: 184, y: 185, w: 14, h: 22 },
  { text: '3,98', x: 210, y: 185, w: 78, h: 24 },
]);

/** Karte mit NUR einem Gültigkeits-Tagesdatum als prominentem Ziffernblock (kein
 *  Preis-Tile) → der Crop-Pass meldet cropLooksLikeDateOrLegal (keine KW-Logik). */
export const LAYOUT_CROP_DATE_ONLY = makeLayoutPage([
  { text: 'Heidelbeeren', x: 120, y: 120, w: 240, h: 38 },
  { text: '15.6.', x: 150, y: 205, w: 120, h: 95 },
]);

// ---------------------------------------------------------------------------
// GEOMETRISCHE PREISBOX-FALLBACK-FIXTURES — der belegte Blocker: die großen
// stilisierten Lidl-Aktionspreise werden vom Seiten-OCR NICHT als saubere Preis-/
// Ziffernwörter erkannt (kein ziffern-Anker), sondern allenfalls als kurze Nicht-
// Ziffern-Glyphen an der Preisposition. Hier als generischer Junk-Token (`ae`/`oe`)
// nachgebildet (KEINE Ziffer, KEIN Name, KEINE Einheit) — der geometrische Finder
// muss die Preiszone trotzdem aus der Kartengeometrie ableiten und re-OCRn.
// ---------------------------------------------------------------------------

/** FOOD-Karte: Produktname oben, große Preisbox unten rechts — aber der Preis wurde
 *  NICHT als Ziffernwort gelesen (nur ein Nicht-Ziffern-Glyph `ae`). Kein ziffern-
 *  Anker → der GEOMETRISCHE Fallback muss die untere/rechte Preiszone finden. */
export const LAYOUT_CROP_GEOMETRIC_FOOD = makeLayoutPage([
  { text: 'Rispentomaten', x: 120, y: 120, w: 280, h: 40 },
  { text: 'ae', x: 230, y: 215, w: 130, h: 95 },
]);

/** Wie oben, aber mit Top-left-Badge „3 Stück" (oben links). Der geometrische Finder
 *  darf das Badge NIE als Preis croppen und NIE als Name nehmen — Preis aus der unteren
 *  Zone, Name aus dem echten Namensblock. */
export const LAYOUT_CROP_GEOMETRIC_TOPLEFT_BADGE = makeLayoutPage([
  { text: '3', x: 120, y: 100, w: 24, h: 30 },
  { text: 'Stück', x: 152, y: 100, w: 90, h: 30 },
  { text: 'Bio', x: 120, y: 185, w: 60, h: 40 },
  { text: 'Bananen', x: 190, y: 185, w: 170, h: 40 },
  { text: 'ae', x: 150, y: 280, w: 130, h: 95 },
]);

/** NON-FOOD-Karte mit gut „lesbarem" (vom Crop recoverbarem) Preis, aber Non-Food-Name
 *  (Akkuschrauber) → der geometrische Crop findet zwar einen Preis, das geteilte
 *  Safety-Gate verwirft ihn (nonFood) → bleibt NIE live. */
export const LAYOUT_CROP_GEOMETRIC_NONFOOD = makeLayoutPage([
  { text: 'Akkuschrauber', x: 120, y: 120, w: 300, h: 40 },
  { text: 'ae', x: 230, y: 215, w: 130, h: 95 },
]);

/** OCR-Müllname (überwiegend Einzelbuchstaben, kein echtes Wort) + geometrisch
 *  recoverbarer Preis → der Crop-Preis ist sauber, aber der verknüpfte Name bleibt
 *  nameQuality-Reject → nie live. */
export const LAYOUT_CROP_GEOMETRIC_GARBAGE_NAME = makeLayoutPage([
  { text: 'Fa', x: 120, y: 120, w: 36, h: 38 },
  { text: 'g', x: 168, y: 120, w: 16, h: 38 },
  { text: 'i', x: 196, y: 120, w: 10, h: 38 },
  { text: 'm', x: 216, y: 120, w: 24, h: 38 },
  { text: 'm', x: 248, y: 120, w: 24, h: 38 },
  { text: 'ae', x: 150, y: 205, w: 130, h: 95 },
]);

/** Eine GROSSE, zusammengeclusterte Karte mit ZWEI Produkten (Namen überbrücken den
 *  vertikalen Abstand, sodass das Karten-Clustering beide zu EINER Karte verschmilzt),
 *  jeweils mit einem Nicht-Ziffern-Preis-Glyph. Der geometrische Finder muss lokale
 *  TEIL-Crops je Produkt erzeugen statt EINES Ganzkarten-Junk-Crops. */
export const LAYOUT_CROP_GEOMETRIC_BIG_CLUSTER = makeLayoutPage([
  { text: 'Rispentomaten', x: 120, y: 120, w: 280, h: 40 },
  { text: 'ae', x: 300, y: 200, w: 120, h: 90 },
  { text: 'Haehnchenbrust', x: 120, y: 360, w: 300, h: 40 },
  { text: 'se', x: 300, y: 440, w: 120, h: 90 },
]);

/** Zwei klar getrennte Produktkarten auf EINER Seite (großer Abstand) → 2 Karten,
 *  2 Food-Kandidaten. Beweist die Karten-Clusterung. */
export const LAYOUT_TWO_CARDS_PAGE = makeLayoutPage([
  // Karte A: oben links
  { text: 'Rispentomaten', x: 120, y: 120, w: 280, h: 40 },
  { text: '1', x: 150, y: 205, w: 60, h: 110 },
  { text: '99', x: 225, y: 220, w: 50, h: 65 },
  // Karte B: weit rechts (horizontaler Abstand > Cluster-Schwelle)
  { text: 'Frische', x: 660, y: 120, w: 150, h: 38 },
  { text: 'Haehnchenbrust', x: 660, y: 175, w: 300, h: 38 },
  { text: '2', x: 690, y: 255, w: 70, h: 120 },
  { text: '99', x: 775, y: 270, w: 55, h: 70 },
]);
