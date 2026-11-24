// Pure offer-name quality heuristics, shared by the data-quality review queue
// (offersQuality.ts) and the REWE import (reweBrowserImport.ts). Kept in its own
// tiny, dependency-free module so the import pipeline does not pull the whole
// quality/enrichment graph just to ask "is this name a fragment?".

// Connective/preposition words a fragment name often starts with — a leftover
// sub-line that got imported as a product name ("mit milder Rauchnote").
const FRAGMENT_NAME_LEADERS = new Set([
  'mit', 'ohne', 'und', 'in', 'im', 'aus', 'je', 'nach', 'inkl', 'zzgl',
  'ca', 'davon', 'sowie', 'bzw', 'der', 'die', 'das', 'fuer', 'fur', 'per',
]);

// Generic descriptor/flavour tokens that, on their own (or only among each
// other), carry no real product identity. A NAME made up solely of these — or a
// single one of them — is almost certainly a REWE-style fragment, not a product
// ("Original", "Peanut", "Schoko Meersalz"). Curated to descriptors only, never
// product nouns, so "Bananen"/"Erdbeeren"/"Milch" stay legitimate.
const FRAGMENT_DESCRIPTOR_TOKENS = new Set([
  'original', 'classic', 'natur', 'pur', 'peanut', 'mild', 'milder', 'milde',
  'gemischt', 'sortiert', 'verschiedene', 'diverse', 'edition', 'limited',
  'knusprig', 'gesalzen', 'ungesalzen', 'wuerzig', 'pikant', 'schoko',
  'meersalz', 'rauchnote', 'sweet', 'chili', 'fein', 'extra',
  // REWE flavour adjective that orphans as its own line when a card is split
  // across a page/column boundary ("…Frit-Sticks" | "ungarisch").
  'ungarisch',
  // Generic combinability/variety descriptors from REWE card sub-lines
  // ("individuell kombinierbar kernlos" under a grapes card). Product names
  // like "Trauben kernlos" survive via their product noun.
  'individuell', 'kombinierbar', 'kernlos', 'kernlose',
]);

// Promo badges and bare packaging words that leak out of REWE cards as their
// own "product". A name consisting ONLY of these (alone or combined with the
// descriptors above) is never a real offer — "Tiefpreis", "Dose", "Packung",
// "Aktion Knaller". Real products always carry a brand or product noun too.
const FRAGMENT_PROMO_PACKAGING_TOKENS = new Set([
  // promo/badge words
  'tiefpreis', 'dauertiefpreis', 'aktion', 'angebot', 'knaller', 'kracher',
  'hammerpreis', 'hammer', 'preis', 'rabatt', 'sparen', 'deal', 'bonus',
  'coupon', 'app', 'wochenangebot', 'tagesangebot',
  // navigation/page-chrome words that leak out of flyer headers as a "product"
  // ("Märkte & Angebote") — tokens keep their umlauts, so both spellings.
  'angebote', 'markt', 'maerkte', 'märkte',
  // bare packaging words ("Fl." is already a fragment via the length rule)
  'dose', 'dosen', 'packung', 'pckg', 'pck', 'flasche', 'flaschen', 'fl',
  'becher', 'glas', 'beutel', 'schale', 'kasten', 'tray', 'netz', 'stueck',
  'stk', 'je', 'liter',
  // bare measurement units, so packaging fragments like "l-Dose" carry no
  // identity-bearing token after the hyphen split.
  'l', 'ml', 'cl', 'kg', 'g', 'mg',
]);

function isFragmentToken(token: string): boolean {
  return FRAGMENT_DESCRIPTOR_TOKENS.has(token) || FRAGMENT_PROMO_PACKAGING_TOKENS.has(token);
}

function fragmentTokens(name: string): string[] {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    // Hyphens separate tokens too, so "l-Dose"/"Hammer-Preis" decompose into
    // their (identity-free) parts instead of hiding as one unknown token.
    .split(/[\s-]+/)
    .filter(Boolean);
}

/**
 * HARD bad-name check: the name carries NO product identity at all — it is a
 * bare promo badge ("Tiefpreis", "Kracher"), a bare packaging word ("Dose",
 * "Fl.", "Packung"), a descriptor-only combination ("Schoko Meersalz") or
 * digits-only ("0,0 %"). Safe to apply to EVERY store's scraped offers (the
 * scan quarantine + snapshot gate use it), because real product names always
 * contain a brand or product noun. Deliberately does NOT use the
 * connective-leader rule — "Die Streichzarte gesalzen", "Der Große Bauer" and
 * "*Mit Kaufland Card Joghurt mild" are real offers, not fragments.
 */
export function isHardBadOfferName(name: string): boolean {
  const trimmed = String(name ?? '').trim();
  if (trimmed.replace(/[^\p{L}\p{N}]/gu, '').length < 3) {
    return true; // 1–2 character "names" carry no information
  }

  const tokens = fragmentTokens(trimmed);
  if (tokens.length === 0) {
    return true;
  }

  // Digits-only ("0,0 %") → no identity. Mixed digits + real-looking tokens
  // ("5,0 Original" is a real beer brand) deliberately survive.
  if (tokens.every((token) => /^\d+$/.test(token))) {
    return true;
  }

  // Every token is a pure descriptor/promo/packaging word ("Tiefpreis",
  // "Original", "Schoko Meersalz", "Tiefpreis Aktion").
  return tokens.every((token) => isFragmentToken(token));
}

/**
 * Heuristic: is this offer name a fragment / generic descriptor with no real
 * product identity (no brand, no product noun)? Used to send REWE-style broken
 * names ("Peanut", "Original", "Schoko Meersalz", "mit milder Rauchnote") to the
 * review queue instead of presenting them as finished offers. Deliberately
 * conservative — a soft reviewNeeded flag, never a hard delete. Includes the
 * connective-leader rule (OCR/flat-stream sub-lines), so it is ONLY suitable
 * for the REWE import path — scan-wide checks must use
 * {@link isHardBadOfferName}.
 */
export function isLikelyFragmentName(name: string): boolean {
  if (isHardBadOfferName(name)) {
    return true;
  }

  const tokens = fragmentTokens(String(name ?? '').trim());
  if (tokens.length === 0) {
    return true;
  }

  // Starts with a connective/preposition → a leftover sub-line, not a name.
  if (FRAGMENT_NAME_LEADERS.has(tokens[0])) {
    return true;
  }

  // Several tokens, but ALL of them are descriptors/promo/packaging words or
  // bare digits ("2 Dosen") — OCR split lines carry no identity.
  if (
    tokens.length >= 2 &&
    tokens.every((token) => isFragmentToken(token) || /^\d+$/.test(token))
  ) {
    return true;
  }

  return false;
}
