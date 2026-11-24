// Zuordnung der Deal-Kategorie — RN-frei in einem eigenen Modul, damit sie in
// der Node-Testumgebung geprueft werden kann (offersApi.ts zieht die
// react-native-Runtime). Gleiches Muster wie backendUrl.ts.
import type { DealCategory } from '../types';

/** Minimale Sicht auf das Backend-Angebot, die diese Zuordnung braucht. */
export interface CategorizableOffer {
  category?: string;
  name?: string;
  tags?: string[];
  canonicalCategory?: { main?: string; sub?: string } | null;
}

// Das Backend liefert auf JEDEM Angebot `canonicalCategory.main` — das Ergebnis
// der Regel- und KI-Pipeline inkl. Reparaturen und Konflikt-Gates. Diese Zuordnung
// uebernimmt es, statt es wegzuwerfen und aus dem Produktnamen neu zu raten.
//
// Warum: Die fruehere Namens-Heuristik (unten als Fallback erhalten) trifft blind
// per Substring. Gemessen am Lauf 2026-08-17 wichen dadurch 214 von 1071 sichtbaren
// Angeboten (20 %) von der Backend-Kategorie ab. Beispiele: "Sp-eis-emoehren" wurde
// ueber /eis/ zu Suessigkeiten, "Haribo Fruchtgummi" ueber /frucht/ zu Obst & Gemuese,
// "Corny Muesliriegel Milch" ueber /milch/ zu Milchprodukten.
export const CANONICAL_MAIN_TO_DEAL_CATEGORY: Record<string, DealCategory> = {
  'Fleisch & Wurst': 'meat_fish',
  'Fisch & Meeresfrüchte': 'meat_fish',
  'Milchprodukte & Eier': 'dairy',
  'Obst & Gemüse': 'fruits_vegetables',
  'Getränke alkoholfrei': 'drinks',
  Alkohol: 'drinks',
  'Süßwaren & Snacks': 'snacks_sweets',
  Tiefkühl: 'frozen',
  Backwaren: 'bakery',
  // Vorrat: haltbare Grundzutaten und alles, was dauerhaft im Schrank steht.
  Grundnahrungsmittel: 'pantry',
  'Gewürze/Saucen/Aufstriche': 'pantry',
  // Fertig: Gerichte und Konserven, die kaum noch Zubereitung brauchen. Die
  // Feinkost-/Kuehlregal-Ware (Salate, Tofu, Convenience) sitzt sachlich naeher
  // hieran als an Milchprodukten und bekommt deshalb keinen eigenen Eimer.
  'Konserven & Fertiggerichte': 'ready_meals',
  'Feinkost & Kühlung': 'ready_meals',
  // Non-Food hat in einem Lebensmittel-Feed keine sinnvolle Kategorie; der
  // Food-Filter sortiert es ohnehin aus, bevor es hier ankommt.
  'Non-Food': 'other',
};

export function dealCategoryFromCanonical(offer: CategorizableOffer): DealCategory | null {
  const main = offer.canonicalCategory?.main;
  if (typeof main !== 'string' || !main.trim()) {
    return null;
  }
  return CANONICAL_MAIN_TO_DEAL_CATEGORY[main.trim()] ?? null;
}

/** Fallback fuer Angebote ohne (mappbare) canonicalCategory — z. B. manuelle
 *  Importe, die die Kategorisierung nie durchlaufen haben. Bewusst unveraendert
 *  belassen, damit dieser Pfad sich wie bisher verhaelt. */
export function mapCategoryFromName(
  category: string,
  name: string,
  tags: string[] = [],
): DealCategory {
  const source = `${category} ${name} ${tags.join(' ')}`
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');

  if (/obst|gemuese|gemuse|frucht|salat|tomate|apfel|banane|kartoffel|spargel|artischock/.test(source)) {
    return 'fruits_vegetables';
  }
  if (/fleisch|fisch|wurst|schinken|lachs|thunfisch|haehnchen|huhn|rind|schwein/.test(source)) {
    return 'meat_fish';
  }
  if (/not mlk|haferdrink|sojadrink|mandeldrink/.test(source)) {
    return 'dairy';
  }
  if (/alkoholfrei|krombacher|gordon|likoer|likor/.test(source)) {
    return 'drinks';
  }
  if (/berliner|ruehrkuchen|magdalenas/.test(source)) {
    return 'snacks_sweets';
  }
  if (/milch|kaese|käse|joghurt|quark|butter|sahne|mozzarella/.test(source)) {
    return 'dairy';
  }
  if (/getraenk|getränk|wasser|saft|cola|limonade|bier|wein|kaffee|tee/.test(source)) {
    return 'drinks';
  }
  if (/snack|suess|süß|schokolade|chips|keks|bonbon|eis/.test(source)) {
    return 'snacks_sweets';
  }
  if (/tiefkuehl|tiefkühl|frozen|tk-|pizza/.test(source)) {
    return 'frozen';
  }

  return 'other';
}

/** Endgueltige Deal-Kategorie: Backend-Kategorie fuehrt, Namensheuristik faengt
 *  nur Angebote ohne (mappbare) canonicalCategory ab. */
export function resolveDealCategory(offer: CategorizableOffer): DealCategory {
  return (
    dealCategoryFromCanonical(offer) ??
    mapCategoryFromName(offer.category ?? '', offer.name ?? '', offer.tags ?? [])
  );
}
