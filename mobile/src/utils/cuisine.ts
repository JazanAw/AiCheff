// Central cuisine ("Küche") taxonomy for recipes.
//
// The DB stores cuisine as a free German string from the seed
// (`deutsch`, `italienisch`, …). This module is the single place that maps any
// raw value to a STABLE slug (`german`, `italian`, …) and back to a localized
// label via i18n (`cheffity.cuisine.<slug>`). Keep it free of react-native
// imports so it stays unit-testable.

export const CUISINE_SLUGS = [
  'german',
  'italian',
  'turkish',
  'japanese',
  'indian',
  'mexican',
  'mediterranean',
  'asian',
  'oriental',
  'french',
  'greek',
  'international',
] as const;

export type CuisineSlug = (typeof CUISINE_SLUGS)[number];

/** Fallback slug for unknown / empty cuisines. */
export const CUISINE_FALLBACK: CuisineSlug = 'international';

const SLUG_SET = new Set<string>(CUISINE_SLUGS);

// Raw value (German seed words, English synonyms) → canonical slug. Keys are
// lowercase + trimmed; slugs themselves are also accepted (see normalizeCuisine).
const CUISINE_ALIASES: Record<string, CuisineSlug> = {
  // German seed values (incl. common inflected/adjective forms)
  deutsch: 'german',
  deutsche: 'german',
  italienisch: 'italian',
  italienische: 'italian',
  türkisch: 'turkish',
  tuerkisch: 'turkish',
  türkische: 'turkish',
  japanisch: 'japanese',
  japanische: 'japanese',
  indisch: 'indian',
  indische: 'indian',
  mexikanisch: 'mexican',
  mexikanische: 'mexican',
  mediterran: 'mediterranean',
  mediterrane: 'mediterranean',
  asiatisch: 'asian',
  asiatische: 'asian',
  orientalisch: 'oriental',
  orientalische: 'oriental',
  französisch: 'french',
  franzoesisch: 'french',
  französische: 'french',
  griechisch: 'greek',
  griechische: 'greek',
  // English country/synonym forms (robust against future English seeds)
  germany: 'german',
  italy: 'italian',
  turkey: 'turkish',
  japan: 'japanese',
  india: 'indian',
  mexico: 'mexican',
  greece: 'greek',
  france: 'french',
  asia: 'asian',
};

/**
 * Map any raw cuisine string to a stable slug. Accepts the canonical slug
 * itself, German seed words, and a few English synonyms. Unknown / empty →
 * `international`. Pure and case/whitespace-insensitive.
 */
export function normalizeCuisine(raw: string | null | undefined): CuisineSlug {
  if (typeof raw !== 'string') return CUISINE_FALLBACK;
  const key = raw.trim().toLowerCase();
  if (key.length === 0) return CUISINE_FALLBACK;
  if (SLUG_SET.has(key)) return key as CuisineSlug;
  return CUISINE_ALIASES[key] ?? CUISINE_FALLBACK;
}

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

/** Localized label for a slug, e.g. `german` → „Deutsch" (de). */
export function getCuisineLabel(slug: CuisineSlug, t: TFunc): string {
  return t(`cheffity.cuisine.${slug}`);
}

/** Localized label straight from a raw DB value (normalizes first). */
export function getCuisineLabelFromRaw(
  raw: string | null | undefined,
  t: TFunc,
): string {
  return getCuisineLabel(normalizeCuisine(raw), t);
}

// Curated candidate set for the mobile filter chips (Aufgabe 2 V1 order). The
// UI shows „Alle" plus the subset of these that actually has recipes, so chips
// for not-yet-seeded cuisines (e.g. turkish/japanese) don't render empty but
// appear automatically once such recipes exist.
export const CUISINE_FILTER_CANDIDATES: CuisineSlug[] = [
  'german',
  'italian',
  'turkish',
  'japanese',
  'mediterranean',
  'asian',
  'international',
];
