// Central, extendable vocabulary for the REWE import: the promo/badge words that
// mark an action price, the bonus/coupon context that must NOT be taken as a
// normal offer price, and the shared parse-block diagnostic type.
//
// This module is DEPENDENCY-FREE on purpose: both the PDF parser
// (reweScreenshotImport) and the diagnostics (reweMissingReport) import from it,
// so keeping it a sink avoids an import cycle. The browser bookmarklet embeds the
// derived regexes verbatim (see reweBrowserImport), so the live DOM extraction
// uses the exact same anchor list as the server.

/**
 * REWE headline-deal badges. A price next to one of these is the ACTION price.
 * Extend this list when REWE introduces a new badge — every consumer (PDF parser,
 * browser import, report) picks it up automatically. The badge words are used as
 * price anchors but are NEVER kept as a product name.
 */
export const REWE_PROMO_ANCHORS = [
  'Aktion',
  'Angebot',
  'Knaller',
  'Knüller',
  'Kracher',
  'Hammerpreis',
  'Top-Angebot',
  'Top Angebot',
  'Deal',
  'Nur diese Woche',
  'Vorteilspreis',
  'Wochenangebot',
  'Preishit',
  'Superpreis',
] as const;

const UMLAUT_ALTERNATIVES: Array<[RegExp, string]> = [
  [/ü/gi, '(?:ü|ue)'],
  [/ö/gi, '(?:ö|oe)'],
  [/ä/gi, '(?:ä|ae)'],
  [/ß/g, '(?:ß|ss)'],
];

/** Turn a badge phrase into a separator-/umlaut-tolerant regex fragment, so
 *  "Top-Angebot" also matches "Top Angebot" and "Knüller" matches "Knueller". */
function anchorToPattern(anchor: string): string {
  let pattern = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [matcher, replacement] of UMLAUT_ALTERNATIVES) {
    pattern = pattern.replace(matcher, replacement);
  }
  return pattern.replace(/[\s-]+/g, '[\\s-]+');
}

// Unique (canonical-label, fragment) pairs — "Top-Angebot" and "Top Angebot"
// collapse to one fragment, the first label wins.
const ANCHOR_FRAGMENTS: Array<{ anchor: string; fragment: string }> = (() => {
  const seen = new Set<string>();
  const result: Array<{ anchor: string; fragment: string }> = [];
  for (const anchor of REWE_PROMO_ANCHORS) {
    const fragment = anchorToPattern(anchor);
    if (!seen.has(fragment)) {
      seen.add(fragment);
      result.push({ anchor, fragment });
    }
  }
  return result;
})();

const ANCHOR_ALTERNATION = ANCHOR_FRAGMENTS.map((entry) => entry.fragment).join('|');
/** Matches any configured promo/deal badge (case-insensitive). Exported so the
 *  browser bookmarklet can embed the exact same anchor list as the server. */
export const REWE_PROMO_ANCHOR_PATTERN = new RegExp(ANCHOR_ALTERNATION, 'i');
const PROMO_ANCHOR_PATTERN = REWE_PROMO_ANCHOR_PATTERN;
const STANDALONE_ANCHOR_PATTERN = new RegExp(`^(?:${ANCHOR_ALTERNATION})[\\s!.:·•-]*$`, 'i');

/** REWE Bonus / App / Coupon / PAYBACK context — a price tied to one of these is
 *  a loyalty/coupon price, not a normal shelf-offer price. */
export const REWE_BONUS_COUPON_PATTERN =
  /\bbonus\b|coupon|payback|gutschein|cashback|\bapp\b/i;

export function isRewePromoAnchorLine(value: string): boolean {
  return PROMO_ANCHOR_PATTERN.test(value);
}

/** Returns the canonical badge label matched in `value`, or null. When several
 *  badges match (e.g. "Top Angebot" matches both "Angebot" and "Top-Angebot"),
 *  the most specific (longest) one wins. */
export function matchRewePromoAnchor(value: string): string | null {
  let best: { anchor: string; length: number } | null = null;
  for (const entry of ANCHOR_FRAGMENTS) {
    if (new RegExp(entry.fragment, 'i').test(value) && entry.anchor.length > (best?.length ?? 0)) {
      best = { anchor: entry.anchor, length: entry.anchor.length };
    }
  }
  return best?.anchor ?? null;
}

/** Distinct badge labels that appear anywhere in `text` (config order). */
export function detectRewePromoAnchors(text: string): string[] {
  const haystack = String(text ?? '');
  return ANCHOR_FRAGMENTS.filter((entry) => new RegExp(entry.fragment, 'i').test(haystack)).map(
    (entry) => entry.anchor,
  );
}

/** True when the WHOLE line is just a badge (so it must be stripped from names). */
export function isStandaloneRewePromoAnchor(value: string): boolean {
  return STANDALONE_ANCHOR_PATTERN.test(String(value ?? '').trim());
}

export function isReweBonusCouponContext(value: string): boolean {
  return REWE_BONUS_COUPON_PATTERN.test(String(value ?? ''));
}

export type ReweParseDropReason =
  | 'belowMinPrice'
  | 'anchorHadInterveningPrice'
  | 'emptyBlock'
  | 'badName'
  | 'bonusOrCoupon'
  | 'duplicate';

/**
 * One price location the parser considered, with enough context for the report
 * to explain WHY it did or did not become a live offer.
 */
export interface ReweParseBlock {
  /** 0-based index of the price line in the cleaned line list. */
  lineIndex: number;
  price: string;
  priceValue: number;
  /** The promo badge anchoring this price, if any. */
  promoAnchor: string | null;
  /** Best-effort product name from the block (may be empty/garbage). */
  nameGuess: string;
  accepted: boolean;
  /** Why the block did not become a live offer (null when accepted). */
  dropReason: ReweParseDropReason | null;
  /** The price looks tied to a REWE Bonus/App/Coupon context. */
  bonusOrCoupon: boolean;
}
