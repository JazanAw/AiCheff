// Shared, name-based risk heuristics for diet/allergen detection.
//
// These are deliberately CONSERVATIVE keyword checks over an offer's name +
// tags. They never assert a positive fact ("contains milk") — they only flag a
// *risk* that warrants a manual look or an honest "Allergen-Risiko" hint in the
// app. The actual allergen/halal/alcohol facts come from the enrichment
// pipeline (dealFields.ts); when those are missing we fall back to these hints
// instead of pretending the product is safe.
//
// Lives in its own module so both offersQuality.ts (admin review) and
// dealFields.ts (app-facing enrichment) use the exact same keyword lists.

import type { Offer } from '../../src/types/models';

// Begriffe, deren Vorkommen im Namen ein bestimmtes Allergen-Risiko stark
// wahrscheinlich machen. Konservativ — lieber einen Hinweis zuviel als ein
// Risiko-Produkt unter dem Radar lassen.
export const ALLERGEN_RISK_KEYWORDS = [
  'milch', 'milk', 'joghurt', 'yoghurt', 'käse', 'kaese', 'butter', 'quark',
  'sahne', 'mozzarella', 'feta',
  'nuss', 'nüsse', 'nuesse', 'mandel', 'haselnuss', 'walnuss', 'pistazie',
  'cashew',
  'fisch', 'lachs', 'thunfisch', 'forelle', 'shrimps', 'garnele', 'krabbe',
  'ei ', 'eier', 'omelette',
  'weizen', 'mehl', 'brot', 'brötchen', 'broetchen', 'nudel', 'pasta',
  'müsli', 'muesli', 'cracker',
];

export const ALCOHOL_RISK_KEYWORDS = [
  'bier', 'pils', 'helles', 'weizenbier', 'wein', 'sekt', 'schaumwein',
  'champagner', 'prosecco', 'whisky', 'rum', 'gin', 'wodka', 'vodka',
  'likör', 'likoer', 'liqueur', 'aperol', 'aperitif', 'cocktail',
];

export function nameContainsAny(offer: Offer, keywords: string[]): boolean {
  const text = `${offer.name ?? ''} ${(offer.tags ?? []).join(' ')}`.toLowerCase();
  for (const keyword of keywords) {
    if (text.includes(keyword)) return true;
  }
  return false;
}

/** True when the name/tags suggest a common allergen, regardless of whether the
 *  enrichment confirmed it. Used only to raise a *risk* hint, never a fact. */
export function isAllergenRiskName(offer: Offer): boolean {
  return nameContainsAny(offer, ALLERGEN_RISK_KEYWORDS);
}

/** True when the name/tags suggest alcohol. Category-based checks are layered on
 *  top by callers that have a normalized category. */
export function isAlcoholRiskName(offer: Offer): boolean {
  return nameContainsAny(offer, ALCOHOL_RISK_KEYWORDS);
}

// --- Per-Allergen-Risiko-Erkennung ---------------------------------------
// Konservative, gruppierte Keyword-Listen. Sie behaupten NIE "enthält X" als
// Fakt — sie markieren nur ein *Risiko* (allergenStatus = 'risk'), wenn der
// Produktname/Kategorie ein typisches Allergen nahelegt. Echte Allergen-Listen
// (allergenStatus = 'known') kommen ausschließlich aus der Pipeline.
//
// Die Werte sind die App-/Backend-Allergen-Slugs (siehe dealFields.Allergen).
const ALLERGEN_RISK_GROUPS: Record<string, string[]> = {
  lactose: [
    'milch', 'milk', 'joghurt', 'yoghurt', 'kaese', 'käse', 'butter', 'quark',
    'sahne', 'rahm', 'schmand', 'mozzarella', 'feta', 'skyr', 'gouda',
    'camembert', 'frischkaese', 'frischkäse', 'parmesan', 'pudding', 'milchreis',
  ],
  nuts: [
    'nuss', 'nuesse', 'nüsse', 'mandel', 'haselnuss', 'walnuss', 'pistazie',
    'cashew', 'erdnuss', 'erdnuesse', 'erdnüsse', 'peanut', 'nougat', 'marzipan',
  ],
  gluten: [
    'weizen', 'mehl', 'brot', 'broetchen', 'brötchen', 'nudel', 'pasta',
    'spaghetti', 'muesli', 'müsli', 'cracker', 'toast', 'baguette', 'croissant',
    'kuchen', 'gebaeck', 'gebäck', 'keks', 'dinkel', 'gerste',
  ],
  eggs: ['eier', 'vollei', 'eigelb', 'eiklar', 'omelette', 'mayonnaise', 'spaetzle', 'spätzle'],
  fish: ['fisch', 'lachs', 'thunfisch', 'forelle', 'hering', 'makrele', 'sardine', 'seelachs', 'kabeljau'],
  seafood: ['garnele', 'shrimp', 'krabbe', 'muscheln', 'calamari', 'scampi', 'meeresfruechte', 'meeresfrüchte'],
  soy: ['soja', 'tofu', 'edamame', 'tempeh'],
  sesame: ['sesam', 'tahin', 'hummus'],
};

function offerHaystack(offer: Offer): string {
  return `${offer.name ?? ''} ${(offer.tags ?? []).join(' ')} ${offer.category ?? ''}`.toLowerCase();
}

/**
 * Returns the allergen slugs a product's NAME/category make likely. Never a
 * confirmed fact — only a conservative risk signal (callers map to
 * allergenStatus = 'risk'). Returns [] when nothing is recognized; that must
 * never be presented as "allergen-free".
 *
 * Substring-Match (kein Wortgrenzen-Check): deutsche Komposita tragen das
 * Allergen oft am Wortende ("Vollmilch", "Buttermilch", "Nussriegel"). Ein
 * seltener Fehltreffer (z. B. "Genuss" → nuss) ist hier bewusst akzeptiert —
 * es ist nur ein Risiko-Hinweis, niemals eine Tatsachenbehauptung.
 */
export function detectAllergenRisks(offer: Offer): string[] {
  const text = offerHaystack(offer);
  const out: string[] = [];
  for (const [allergen, keywords] of Object.entries(ALLERGEN_RISK_GROUPS)) {
    if (keywords.some((keyword) => text.includes(keyword))) {
      out.push(allergen);
    }
  }
  return out;
}

// Unmissverständliche Alkohol-Namens-Signale. Bewusst OHNE kurze, mehrdeutige
// Stämme wie 'wein' (→ Weintrauben), 'rum' (→ Rumpsteak/Rumkugel), 'gin'
// (→ Ingwer): die echte Alkohol-Kategorie ('Alkohol') ist das Hauptsignal.
const ALCOHOL_STRONG_KEYWORDS = [
  'bier', 'pils', 'weizenbier', 'lagerbier', 'sekt', 'prosecco', 'champagner',
  'wodka', 'vodka', 'whisky', 'whiskey', 'likoer', 'likör', 'liqueur', 'aperol',
  'schnaps', 'tequila', 'weinbrand', 'gluehwein', 'glühwein', 'cognac', 'rotwein',
  'weisswein', 'weißwein', 'rosewein', 'roséwein',
];

/**
 * Honest alcohol detection: trusts the (already reliable) "Alkohol" category
 * first, then a conservative set of unambiguous name keywords. Returns true
 * only when alcohol is genuinely likely — never asserts the absence of alcohol.
 */
export function detectAlcohol(offer: Offer): boolean {
  const category = (offer.category ?? '').toLowerCase();
  // "Getränke Alkoholfrei"/"alkoholfrei" enthält den Teilstring "alkohol".
  // Eine explizite Alkoholfrei-Kategorie hat Vorrang vor Namens-Keywords
  // (z. B. "Weizenbier alkoholfrei").
  if (category.includes('alkoholfrei')) {
    return false;
  }
  if (category.includes('alkohol')) {
    return true;
  }
  return nameContainsAny(offer, ALCOHOL_STRONG_KEYWORDS);
}
