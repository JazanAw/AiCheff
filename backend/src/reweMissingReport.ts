// REWE "missing offer" diagnostics — answers the question the raw import report
// could not: "an offer that is officially on REWE is not in my list — is that
// because the PDF never contained it, or because we parsed it badly?"
//
// All functions here are PURE (string in, data out) so they are trivially
// testable and never touch the live snapshot. The PDF/OCR text and (when
// available) the REWE web text are fed in by the caller (dry-run script or the
// /api/offers/rewe-pdf-import endpoint).
import { normalizeText } from '../../src/utils/offers';
import type { SimpleOfferCategory } from '../../src/utils/offerCategory';
import { type ReweParseBlock, detectRewePromoAnchors } from './rewePromoAnchors';
import { isLikelyFragmentName } from './offerNameQuality';

/**
 * A known, officially visible REWE offer we want to be able to flag when an
 * import silently drops it. The price is a SOFT reference hint sourced from the
 * public REWE page — the concrete local-market PDF may legitimately differ.
 */
export interface ReweKnownOffer {
  name: string;
  /** Identifying tokens/phrases as they appear in PDF/OCR/web text. */
  keywords: string[];
  expectedPrice?: number;
  category?: SimpleOfferCategory;
  /** Provenance, e.g. "official_web_snippet" — purely informational; it never
   *  counts as evidence that the offer exists in the CURRENT week's source. */
  source: string;
}

/**
 * Deliberately EMPTY: offers change weekly, so a concrete product name in
 * production code would become a stale "expected offer" that wrongly degrades
 * or blocks future imports. Known offers must be passed in by the caller via
 * `knownOffers` (e.g. derived from the current source, or test fixtures).
 */
export const KNOWN_REWE_OFFERS: ReweKnownOffer[] = [];

export type ReweMissingStatus =
  | 'imported'
  | 'presentInPdfButNotParsed'
  | 'presentInWebButPdfMissing'
  | 'missingFromPdf'
  | 'blockedWebVerification';

export interface ReweKeywordCheck {
  keyword: string;
  inPdf: boolean;
  inOcr: boolean;
  inWeb: boolean;
  found: boolean;
}

export interface ReweKnownOfferStatus {
  name: string;
  expectedPrice?: number;
  source: string;
  status: ReweMissingStatus;
  inPdf: boolean;
  inWeb: boolean;
  imported: boolean;
}

export type ReweImportHealth = 'ok' | 'warning' | 'critical';
export type ReweWebVerification = 'ok' | 'blocked';

export interface ReweMissingLikelyOffer {
  name: string;
  reason: string;
}

export interface ReweMissingReport {
  keywordChecks: ReweKeywordCheck[];
  /** Every known offer with its resolved status (including imported ones). */
  knownOfferStatuses: ReweKnownOfferStatus[];
  /** Subset of knownOfferStatuses that are NOT imported but provably present
   *  in the CURRENT source (PDF/OCR or live web text). Offers without such
   *  evidence are never reported as missing. */
  missingKnownOffers: ReweKnownOfferStatus[];
  /** Distinct promo/deal badges detected in the PDF/OCR text. */
  promoAnchorsDetected: string[];
  /** Price blocks anchored by a promo badge that produced no live offer. */
  promoAnchorsWithoutImportedOffer: ReweParseBlock[];
  /** Dropped blocks that had a real price + a plausible product name. */
  suspiciousDroppedOfferBlocks: ReweParseBlock[];
  /** Prices that look tied to a REWE Bonus/App/Coupon, not a normal offer. */
  bonusOrCouponPriceCandidates: ReweParseBlock[];
  /** Officially-visible / plausibly-real offers that did NOT make the live feed. */
  missingLikelyOffers: ReweMissingLikelyOffer[];
  /** Review fragments ("ungarisch", "Original") that need to be re-joined with a
   *  product line — present means the import is NOT clean. */
  fragmentReconstructionNeeded: string[];
  /** Fragment names that wrongly slipped into the LIVE feed (must be empty). */
  falseLiveFragments: string[];
  /** True when a page's layout could not be parsed reliably from the text stream
   *  and a layout/OCR fallback (or manual check) is needed. */
  requiresLayoutFallback: boolean;
  /** Overall import health — never "ok" when real offers are likely lost. */
  health: ReweImportHealth;
  /** Was the REWE web independently verified, or 403/captcha-blocked? */
  webVerification: ReweWebVerification;
  warnings: string[];
}

export interface ReweMissingReportInput {
  pdfText?: string;
  ocrText?: string;
  /** Text scraped from the live REWE web page, when available. */
  webText?: string;
  /** Did we manage to read the REWE web at all? Defaults to: webText non-empty.
   *  Set false explicitly when REWE 403/captcha-blocked the verification. */
  webChecked?: boolean;
  /** Normalized OR raw names of the offers that were actually imported (live). */
  importedNames: string[];
  /** Per-price diagnostic blocks from analyzeReweScreenshotOcrText. */
  parseBlocks?: ReweParseBlock[];
  /** Names held back for review (fragments needing reconstruction). */
  reviewNames?: string[];
  /** Override the keyword list shown in keywordChecks (defaults derived). */
  keywords?: string[];
  knownOffers?: ReweKnownOffer[];
}

// Drop reasons that are fully EXPLAINED — the price was a base/secondary price
// (its real offer was imported elsewhere), a duplicate, or a sub-threshold
// teaser. These are NOT lost offers and must not inflate the risk signals,
// otherwise the dense promo badges in a flat PDF would make every import "noisy".
const EXPLAINED_DROP_REASONS = new Set<NonNullable<ReweParseBlock['dropReason']>>([
  'anchorHadInterveningPrice',
  'duplicate',
  'belowMinPrice',
]);

function isExplainedDrop(block: ReweParseBlock): boolean {
  return block.dropReason !== null && EXPLAINED_DROP_REASONS.has(block.dropReason);
}

/** A dropped block is "suspicious" when it had a real price AND a plausible
 *  product name yet did not become a live offer, and the drop is NOT explained
 *  by being a base/duplicate/sub-threshold price. */
function isSuspiciousDroppedBlock(block: ReweParseBlock): boolean {
  return (
    !block.accepted &&
    block.priceValue >= 0.39 &&
    block.nameGuess.trim().length >= 3 &&
    !isExplainedDrop(block)
  );
}

/** True if `keyword` (normalized) appears anywhere in `text` (normalized). */
export function reweTextContains(text: string | undefined, keyword: string): boolean {
  const normalizedKeyword = normalizeText(keyword);
  if (!normalizedKeyword) {
    return false;
  }
  return normalizeText(String(text ?? '')).includes(normalizedKeyword);
}

export function checkReweKeywords(
  keywords: string[],
  sources: { pdfText?: string; ocrText?: string; webText?: string },
): ReweKeywordCheck[] {
  return keywords.map((keyword) => {
    const inPdf = reweTextContains(sources.pdfText, keyword);
    const inOcr = reweTextContains(sources.ocrText, keyword);
    const inWeb = reweTextContains(sources.webText, keyword);
    return { keyword, inPdf, inOcr, inWeb, found: inPdf || inOcr || inWeb };
  });
}

/**
 * Decide the honest status of a known offer. Precedence is deliberate: an
 * offer that is actually imported is never "missing"; a name present in the PDF
 * text points at a PARSER problem (presentInPdfButNotParsed); only when the PDF
 * lacks it do web evidence / web-reachability decide between
 * presentInWebButPdfMissing, blockedWebVerification and missingFromPdf. We never
 * claim an offer is importable when the PDF does not contain it.
 */
export function classifyReweOfferPresence(input: {
  imported: boolean;
  inPdf: boolean;
  inWeb: boolean;
  webChecked: boolean;
}): ReweMissingStatus {
  if (input.imported) {
    return 'imported';
  }
  if (input.inPdf) {
    return 'presentInPdfButNotParsed';
  }
  if (input.inWeb) {
    return 'presentInWebButPdfMissing';
  }
  if (!input.webChecked) {
    return 'blockedWebVerification';
  }
  return 'missingFromPdf';
}

function defaultKeywords(knownOffers: ReweKnownOffer[]): string[] {
  const keywords = new Set<string>();
  for (const offer of knownOffers) {
    for (const word of offer.name.split(/\s+/)) {
      if (word.replace(/[^\p{L}\p{N}]/gu, '').length > 2) {
        keywords.add(word);
      }
    }
    for (const keyword of offer.keywords) {
      keywords.add(keyword);
    }
    if (typeof offer.expectedPrice === 'number') {
      const fixed = offer.expectedPrice.toFixed(2);
      keywords.add(fixed.replace('.', ','));
      keywords.add(fixed);
    }
  }
  return [...keywords];
}

export function buildReweMissingReport(input: ReweMissingReportInput): ReweMissingReport {
  const knownOffers = input.knownOffers ?? KNOWN_REWE_OFFERS;
  const webChecked = input.webChecked ?? Boolean((input.webText ?? '').trim());
  const importedText = normalizeText(input.importedNames.join(' \n '));

  const knownOfferStatuses: ReweKnownOfferStatus[] = knownOffers.map((offer) => {
    const imported = offer.keywords.some((keyword) =>
      importedText.includes(normalizeText(keyword)),
    );
    const inPdf = offer.keywords.some(
      (keyword) =>
        reweTextContains(input.pdfText, keyword) || reweTextContains(input.ocrText, keyword),
    );
    // Only an actual hit in the CURRENT web text counts as web evidence — a
    // web-derived `source` label is provenance, not proof for this week.
    const inWeb = offer.keywords.some((keyword) => reweTextContains(input.webText, keyword));
    const status = classifyReweOfferPresence({ imported, inPdf, inWeb, webChecked });
    return {
      name: offer.name,
      expectedPrice: offer.expectedPrice,
      source: offer.source,
      status,
      inPdf,
      inWeb,
      imported,
    };
  });

  // Only offers PROVABLY present in the current source (PDF/OCR or live web
  // text) may be reported as missing. An offer without such evidence is simply
  // not on offer this week — never a "missing" finding, never a health malus.
  const missingKnownOffers = knownOfferStatuses.filter(
    (offer) =>
      offer.status === 'presentInPdfButNotParsed' ||
      offer.status === 'presentInWebButPdfMissing',
  );

  const blocks = input.parseBlocks ?? [];
  const promoAnchorsDetected = detectRewePromoAnchors(
    `${input.pdfText ?? ''}\n${input.ocrText ?? ''}`,
  );
  const promoAnchorsWithoutImportedOffer = blocks.filter(
    (block) => block.promoAnchor !== null && !block.accepted && !isExplainedDrop(block),
  );
  const suspiciousDroppedOfferBlocks = blocks.filter(isSuspiciousDroppedBlock);
  const bonusOrCouponPriceCandidates = blocks.filter((block) => block.bonusOrCoupon);

  const liveOfferCount = input.importedNames.length;
  const reviewNames = input.reviewNames ?? [];
  const webVerification: ReweWebVerification = webChecked ? 'ok' : 'blocked';
  const warnings: string[] = [];

  // Review fragments that should be re-joined with a product line ("ungarisch").
  const fragmentReconstructionNeeded = reviewNames.filter(
    (name) => name.trim().length > 0,
  );
  // Fragment names that wrongly went LIVE (must never happen).
  const falseLiveFragments = input.importedNames.filter((name) => isLikelyFragmentName(name));

  // Officially-visible / plausibly-real offers that did not make the live feed.
  const missingLikelyOffers: ReweMissingLikelyOffer[] = [
    ...missingKnownOffers.map((offer) => ({ name: offer.name, reason: offer.status })),
    ...suspiciousDroppedOfferBlocks.map((block) => ({
      name: block.nameGuess,
      reason: `dropped:${block.dropReason ?? 'unknown'}`,
    })),
  ];

  const controlArticleInPdfButNotParsed = knownOfferStatuses.some(
    (offer) => offer.status === 'presentInPdfButNotParsed',
  );
  // Alarm when badge-anchored prices we could NOT explain away outnumber the
  // offers we imported — i.e. unusually many badges, few live offers.
  const tooManyUnexplainedAnchors = promoAnchorsWithoutImportedOffer.length > liveOfferCount;

  const requiresLayoutFallback =
    fragmentReconstructionNeeded.length > 0 ||
    suspiciousDroppedOfferBlocks.length >= 3 ||
    tooManyUnexplainedAnchors;

  if (controlArticleInPdfButNotParsed) {
    warnings.push(
      'Kontrollartikel ist im PDF vorhanden, wurde aber nicht als Live-Angebot importiert.',
    );
  }
  if (falseLiveFragments.length > 0) {
    warnings.push(`Fragment(e) fälschlich live: ${falseLiveFragments.join(', ')}.`);
  }
  if (fragmentReconstructionNeeded.length > 0) {
    warnings.push(
      `${fragmentReconstructionNeeded.length} Review-Fragment(e) brauchen Rekonstruktion: ${fragmentReconstructionNeeded.join(', ')}.`,
    );
  }
  if (tooManyUnexplainedAnchors) {
    warnings.push(
      `${promoAnchorsWithoutImportedOffer.length} Promo-Anker mit Preis ergaben kein Live-Angebot (nur ${liveOfferCount} live).`,
    );
  }
  if (requiresLayoutFallback) {
    warnings.push('Einzelne Seiten/Blöcke brauchen einen Layout-Fallback (requiresLayoutFallback).');
  }
  if (webVerification === 'blocked') {
    warnings.push(
      'REWE-Web konnte nicht unabhängig geprüft werden (403/Captcha) — als blockedWebVerification markiert.',
    );
  }

  const health: ReweImportHealth =
    controlArticleInPdfButNotParsed || falseLiveFragments.length > 0
      ? 'critical'
      : requiresLayoutFallback || missingKnownOffers.length > 0
        ? 'warning'
        : 'ok';

  return {
    keywordChecks: checkReweKeywords(input.keywords ?? defaultKeywords(knownOffers), {
      pdfText: input.pdfText,
      ocrText: input.ocrText,
      webText: input.webText,
    }),
    knownOfferStatuses,
    missingKnownOffers,
    promoAnchorsDetected,
    promoAnchorsWithoutImportedOffer,
    suspiciousDroppedOfferBlocks,
    bonusOrCouponPriceCandidates,
    missingLikelyOffers,
    fragmentReconstructionNeeded,
    falseLiveFragments,
    requiresLayoutFallback,
    health,
    webVerification,
    warnings,
  };
}

const MISSING_STATUS_LABEL: Record<ReweMissingStatus, string> = {
  imported: 'importiert',
  presentInPdfButNotParsed: 'im PDF vorhanden, aber nicht als Angebot erkannt',
  presentInWebButPdfMissing: 'offiziell bei REWE sichtbar, aber nicht im PDF (Web-Import nötig)',
  blockedWebVerification: 'nicht im PDF; Web-Prüfung war nicht möglich',
  missingFromPdf: 'nicht im PDF enthalten',
};

/**
 * Build a single user-facing warning for missing known offers. Deliberately
 * honest: it never says "importable", it states WHERE the offer is (or is not)
 * so the user knows whether to re-parse, re-export the PDF, or use a web import.
 */
export function describeReweMissingOffers(
  missing: ReweKnownOfferStatus[],
): string | undefined {
  if (missing.length === 0) {
    return undefined;
  }
  const parts = missing.map((offer) => `${offer.name} (${MISSING_STATUS_LABEL[offer.status]})`);
  return `Hinweis: REWE Angebote evtl. fehlend: ${parts.join('; ')}.`;
}
