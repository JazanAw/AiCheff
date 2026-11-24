import { z } from 'zod';
import type { Offer } from '../../src/types/models';
import {
  repairSimpleOfferCategory,
  toSimpleOfferCategory,
  SIMPLE_OFFER_CATEGORIES,
  type SimpleOfferCategory,
} from '../../src/utils/offerCategory';
import { normalizeText } from '../../src/utils/offers';
import { isLikelyFragmentName } from './offerNameQuality';
import {
  REWE_BONUS_COUPON_PATTERN,
  REWE_PROMO_ANCHOR_PATTERN,
} from './rewePromoAnchors';
import {
  buildReweMissingReport,
  type ReweImportHealth,
  type ReweKeywordCheck,
  type ReweKnownOfferStatus,
  type ReweMissingLikelyOffer,
  type ReweWebVerification,
} from './reweMissingReport';
import type { ReweParseBlock } from './rewePromoAnchors';

export const reweBrowserImportOfferSchema = z.object({
  name: z.string().trim().min(1).max(240),
  price: z.union([z.number(), z.string()]),
  description: z.string().trim().max(1000).optional(),
  unit: z.string().trim().max(120).optional(),
  basePrice: z.union([z.number(), z.string()]).optional(),
  baseUnit: z.string().trim().max(80).optional(),
  imageUrl: z.string().trim().max(2000).optional(),
  sourceUrl: z.string().trim().max(2000).optional(),
  category: z.string().trim().max(120).optional(),
  validityLabel: z.string().trim().max(120).optional(),
});

/** Counting chain the bookmarklet measured in the DOM, BEFORE the payload was
 *  sent. Lets the import report explain every offer lost between the page and
 *  the snapshot without ever shipping a product list — only counts + reasons. */
const reweCount = z.number().int().min(0).max(1000000);

export const reweBrowserDiagnosticsSchema = z.object({
  /** Unique structural product cards in the DOM. This IS the semantic web-card
   *  count: one product tile each, NOT a raw price-regex hit, heading, button or
   *  variant. Equals {@link uniqueCardCandidates}. */
  domPriceCards: reweCount.optional(),
  /** Raw price-regex hits in the page HTML (old heuristic) — DIAGNOSE ONLY, to
   *  expose over-counting vs. the structural card count. Never the card count. */
  rawPriceMatches: reweCount.optional(),
  /** Every card container observed across all scroll passes (incl. repeats). */
  observedCardOccurrences: reweCount.optional(),
  /** Distinct cards (after collapsing repeated observations of the same card). */
  uniqueCardCandidates: reweCount.optional(),
  /** observed − unique: the same card re-seen while scrolling/virtualising. */
  repeatedCardObservations: reweCount.optional(),
  /** Cards the per-card extractor rejected in the browser, by reason. */
  rejected: z
    .object({
      noPrice: reweCount.optional(),
      noName: reweCount.optional(),
      sectionHeading: reweCount.optional(),
      extractionError: reweCount.optional(),
    })
    .optional(),
  /** A few example card texts per reject reason (honest "why"). */
  rejectedExamples: z
    .object({
      noPrice: z.array(z.string().max(200)).max(20).optional(),
      noName: z.array(z.string().max(200)).max(20).optional(),
      sectionHeading: z.array(z.string().max(200)).max(20).optional(),
    })
    .optional(),
  /** Unique cards that yielded a usable offer BEFORE offer-level dedupe. */
  browserAcceptedBeforeDedupe: reweCount.optional(),
  /** Accepted offers dropped as duplicates of an already-emitted offer. */
  browserOfferDuplicates: reweCount.optional(),
  /** Offers actually placed in the payload (= acceptedBeforeDedupe − duplicates). */
  payloadOffers: reweCount.optional(),
  /** True when every browser-side balance equation held exactly. */
  consistent: z.boolean().optional(),
  // --- legacy field names (kept so older bookmarklets still validate) ---
  cardCandidates: reweCount.optional(),
  deduped: reweCount.optional(),
});

export const reweBrowserImportRequestSchema = z.object({
  source: z.literal('rewe-browser').optional(),
  pageUrl: z.string().trim().max(2000).optional(),
  validityLabel: z.string().trim().max(120).optional(),
  importedAt: z.string().trim().max(80).optional(),
  /** Best-effort count of visible price cards on the loaded REWE page (after the
   *  bookmarklet auto-scrolled + expanded sections). Used ONLY to estimate the
   *  completeness gap vs. the imported offers — never as a product list. The new
   *  bookmarklet sends the STRUCTURAL card count here (= diagnostics.domPriceCards),
   *  not a raw price-regex hit count. */
  webCardCount: z.number().int().min(0).max(100000).optional(),
  /** Optional per-stage counting chain the bookmarklet measured in the DOM. */
  diagnostics: reweBrowserDiagnosticsSchema.optional(),
  offers: z.array(reweBrowserImportOfferSchema).max(1000),
});

export type ReweBrowserImportRequest = z.infer<typeof reweBrowserImportRequestSchema>;

export interface ReweCategoryCorrection {
  name: string;
  /** Simple category the raw section heading alone would have produced. */
  from: SimpleOfferCategory;
  /** Simple category the name-first resolver actually chose. */
  to: SimpleOfferCategory;
}

/** A finalized, persisted offer reduced to the fields the category-correction
 *  diagnosis needs (Task P2). */
export interface FinalCategoryOffer {
  name: string;
  /** Final persisted simple category (after Phase 1/2 categorization). */
  category?: string;
  /** Raw REWE section heading captured at import time. */
  sourceCategoryRaw?: string;
}

const SIMPLE_OFFER_CATEGORY_SET = new Set<string>(SIMPLE_OFFER_CATEGORIES);

function isSimpleOfferCategory(value: string): value is SimpleOfferCategory {
  return SIMPLE_OFFER_CATEGORY_SET.has(value);
}

/**
 * Task P2 — recompute the REWE category-correction diagnosis from the FINAL,
 * persisted offer state instead of an import-time intermediate. For each offer
 * the raw section heading (`sourceCategoryRaw`) maps to a simple category `from`;
 * the offer's persisted `category` is the truthful `to`. A correction is reported
 * ONLY when the raw heading named a real category AND the FINAL state actually
 * changed it — so an Iglo offer that ended up Tiefkühl (= its heading) or a
 * Trollinger that stayed Alkohol produces NO misleading correction, while a real
 * change still shows the correct direction (raw source → final persisted). Pure,
 * no IO; never a product/brand allowlist.
 */
export function computeFinalCategoryCorrections(
  offers: readonly FinalCategoryOffer[],
): ReweCategoryCorrection[] {
  const corrections: ReweCategoryCorrection[] = [];
  const seen = new Set<string>();
  for (const offer of offers) {
    const rawHeading = cleanText(offer.sourceCategoryRaw);
    if (!rawHeading) {
      continue;
    }
    const from = toSimpleOfferCategory(rawHeading, '');
    if (from === 'Sonstiges') {
      continue;
    }
    const finalCategory = (offer.category ?? '').trim();
    if (!isSimpleOfferCategory(finalCategory) || from === finalCategory) {
      // No meaningful net correction in the FINAL state — never show it (Task P2).
      continue;
    }
    const key = `${offer.name}|${from}|${finalCategory}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    corrections.push({ name: offer.name, from, to: finalCategory });
  }
  return corrections;
}

export interface ReweSuspiciousPrice {
  name: string;
  /** The chosen main/action price (the largest on the card). */
  usedPrice: number;
  /** Other prices on the same card that were NOT used (base/part prices). */
  ignoredPrices: number[];
}

export interface ReweLowPriceCandidate {
  name: string;
  price: number;
}

/** End-to-end counting chain so every REWE offer lost between the loaded page
 *  and the live snapshot is rechnerisch nachvollziehbar (Akzeptanzkriterium).
 *  The browser stages are only present for the bookmarklet path. */
export interface ReweImportCountingChain {
  /** Stage 0 — raw price-regex hits in the HTML. DIAGNOSE ONLY (over-counting). */
  rawPriceMatches?: number;
  /** Stage 1 — every card container observed across all scroll passes. */
  observedCardOccurrences?: number;
  /** Stage 1 — distinct cards after collapsing repeats. = webCardCount. */
  uniqueCardCandidates?: number;
  /** Stage 1 — observed − unique (same card re-seen while scrolling). */
  repeatedCardObservations?: number;
  /** Stage 1 — alias of {@link uniqueCardCandidates} for the report header. */
  domPriceCards?: number;
  /** Stage 2 — extractor rejections in the browser, by reason. */
  browserRejected?: {
    noPrice: number;
    noName: number;
    sectionHeading: number;
    extractionError: number;
  };
  /** Stage 2 — unique cards that yielded an offer before offer-level dedupe. */
  browserAcceptedBeforeDedupe?: number;
  /** Stage 2 — accepted offers dropped as duplicates of an emitted offer. */
  browserOfferDuplicates?: number;
  /** Stage 3 — offers actually received in the payload. */
  payloadOffers: number;
  /** Stage 4 — server-side rejections, by reason. `nonProduct` covers promo
   *  badges, CTA/time-window phrases, property fragments and layout artifacts —
   *  names that carry no product identity (P2), counted, never live nor food-review. */
  serverSkipped: { noName: number; noPrice: number; sectionHeading: number; nonProduct: number };
  /** Stage 5 — duplicate card lines merged into one offer (same name). */
  serverDuplicatesMerged: number;
  /** @deprecated alias of {@link serverDuplicatesMerged}. */
  duplicatesMerged: number;
  /** Stage 6 — live offers normalized. */
  liveNormalized: number;
  /** Stage 7 — held back for review (fragment names). */
  reviewHeldBack: number;
  /** True when EVERY balance equation (browser + server) held exactly. When
   *  false the import report is flagged inconsistent and health is downgraded. */
  balanced: boolean;
  /** The equations that failed, for the report (empty when balanced). */
  balanceErrors: string[];
}

/**
 * Completeness accounting (Problem 5). A balanced chain is NOT incomplete just
 * because uniqueCardCandidates > liveNormalized — every card is accounted for as
 * imported, review, an explained rejection, a duplicate, or filtered non-food.
 * `unexplainedMissing` is the ONLY honest "missing" number; it is 0 for a
 * balanced chain. Completeness and data-quality are judged separately.
 */
export interface ReweImportCompleteness {
  /** Distinct DOM cards seen (web upper bound). */
  uniqueCardCandidates?: number;
  /** Offers normalized into the feed (live + later non-food filtered). */
  imported: number;
  /** Held back for review (fragments / promo / property fragments). */
  reviewHeldBack: number;
  /** Browser + server rejections with a concrete reason (noPrice/noName/section). */
  explainedRejected: number;
  /** Browser offer-duplicates + server duplicate merges. */
  duplicates: number;
  /** Imported offers filtered out WITH a rule-confirmed non-food signal
   *  (Drogerie/Tier/Haushalt/Reinigung/…) — the ONLY honest "non-food" number.
   *  Set by the server from {@link partitionFilteredOffersForCompleteness}, no
   *  longer the raw count of every filtered REWE offer. */
  filteredNonFood?: number;
  /** Filtered offers with a STRONG food signal (rescue verdict) — suspected
   *  wrongly-filtered food the Food-Rescue moves back to the visible feed. */
  filteredFoodSuspect?: number;
  /** Filtered offers with neither a non-food proof nor a food signal (review
   *  verdict) — honest "unclear" cases, never silently counted as non-food. */
  filteredReview?: number;
  /** uniqueCardCandidates − imported − review − explainedRejected − duplicates.
   *  0 for a balanced chain; >0 only when cards truly vanished unaccounted. */
  unexplainedMissing?: number;
}

/** A single REWE product card resolved into name/price/context — the pure,
 *  unit-tested shape of what the bookmarklet extracts per DOM card. */
export interface ReweCardExtraction {
  name: string;
  price: string;
  description: string;
  /** null when the card produced a usable offer; otherwise WHY it was dropped. */
  rejectReason: 'no_price' | 'no_name' | 'section_heading' | null;
}

// Unter diesem Preis (in €) ist ein einzelner Kartenpreis ungewöhnlich niedrig:
// meist ein echter REWE-Bonus-/App-/Coupon-Preis ("0,10 €"), gelegentlich ein
// Parser-Artefakt. Solche Angebote werden NICHT gelöscht, sondern transparent
// als Prüf-Kandidat gemeldet (Task 5).
const REWE_UNUSUAL_LOW_PRICE = 0.5;

export interface ReweImportReportData {
  rawCount: number;
  /** Live offers actually produced. */
  normalizedCount: number;
  /** Offers held back for review (fragment names). */
  reviewCount: number;
  /** Raw offers dropped because they had no usable name/price (or were a bare
   *  section heading). Sum of {@link skippedNoName} + {@link skippedNoPrice} +
   *  {@link skippedSectionHeadingCount}. */
  skippedCount: number;
  /** Payload entries dropped because they carried no usable name. */
  skippedNoName?: number;
  /** Payload entries dropped because they carried no usable price. */
  skippedNoPrice?: number;
  /** Payload entries dropped because the "name" was only a REWE section heading
   *  ("An der Bedientheke", "Tiefkühl", "Freizeit und Mode") — never an offer. */
  skippedSectionHeadingCount?: number;
  /** The section-heading "names" that were skipped (for the report, not live). */
  skippedSectionHeadings?: string[];
  /** Payload entries dropped because the "name" was a promo badge, CTA/time-window
   *  phrase ("nur noch heute"), property fragment or layout artifact — no product
   *  identity (P2). Skipped with a reason, never live nor counted as food-review. */
  skippedNonProductCount?: number;
  /** A few skipped non-product "names" with their reason (honest "why"). */
  skippedNonProductExamples?: string[];
  /** Card lines merged away because another line shared the same product name. */
  duplicateMergedCount?: number;
  /** Honest completeness accounting (Problem 5) — separate from data quality. */
  completeness?: ReweImportCompleteness;
  /** Previous REWE-browser-scope offers replaced by this import, per bucket
   *  (server-set on commit; absent for a pure normalize call). */
  replacedPreviousCount?: { current: number; nextWeek: number; filtered: number; total: number };
  /** End-to-end counting chain (DOM → payload → snapshot). */
  countingChain?: ReweImportCountingChain;
  /** Raw browser diagnostics, when the bookmarklet sent them. */
  browserDiagnostics?: ReweBrowserImportRequest['diagnostics'];
  skippedFragments: string[];
  suspiciousPrices: ReweSuspiciousPrice[];
  /** Live offers with an unusually low single price (≤ {@link REWE_UNUSUAL_LOW_PRICE})
   *  from a visible bonus/app/coupon tile — kept, not deleted, but surfaced so a
   *  human can verify they are real loyalty prices and not a parser glitch. */
  unusualLowPrices?: ReweLowPriceCandidate[];
  duplicateCandidates: string[];
  categoryCorrections: ReweCategoryCorrection[];
  /** Estimated offers on the REWE web page minus the imported live count, when a
   *  web card count is available (REWE often blocks scraping → may be null). */
  possibleWebMissingEstimate?: number | null;
  /** Per-keyword presence check across PDF/OCR/web text (PDF import only). */
  keywordChecks?: ReweKeywordCheck[];
  /** Known officially-visible offers that did NOT make it into the live feed,
   *  each classified (presentInPdfButNotParsed / presentInWebButPdfMissing / …)
   *  so the report never claims importability the PDF cannot back up. */
  missingKnownOffers?: ReweKnownOfferStatus[];
  /** Distinct promo/deal badges detected in the PDF (PDF import only). */
  promoAnchorsDetected?: string[];
  /** Promo-anchored prices that produced no live offer (lost-offer risk). */
  promoAnchorsWithoutImportedOffer?: ReweParseBlock[];
  /** Dropped blocks that had a real price + a plausible product name. */
  suspiciousDroppedOfferBlocks?: ReweParseBlock[];
  /** Prices that look tied to a REWE Bonus/App/Coupon, not a normal offer. */
  bonusOrCouponPriceCandidates?: ReweParseBlock[];
  /** Overall import health — "warning"/"critical" when offers are likely lost. */
  importHealth?: ReweImportHealth;
  /** Whether the REWE web was independently verified or 403/captcha-blocked. */
  webVerification?: ReweWebVerification;
  /** Officially-visible / plausibly-real offers that did not reach the live feed. */
  missingLikelyOffers?: ReweMissingLikelyOffer[];
  /** Review fragments that need re-joining with a product line. */
  fragmentReconstructionNeeded?: string[];
  /** Fragment names that wrongly slipped into the live feed (must be empty). */
  falseLiveFragments?: string[];
  /** True when one or more pages need a layout/OCR fallback. */
  requiresLayoutFallback?: boolean;
}

export interface ReweBrowserImportNormalizeResult {
  offers: Offer[];
  skippedCount: number;
  /** Fragment/low-quality names held back from the live feed (reviewNeeded). */
  reviewOffers: Offer[];
  report: ReweImportReportData;
}

/**
 * Does this offer belong to the authoritative REWE manual-import scope (Problem
 * 1)? Browser, Screenshot and PDF imports all run through
 * {@link normalizeReweBrowserImportRequest}, share the `rewe_browser_` id prefix
 * and the `browser-import` tag, and are already classified uniformly as
 * `manual_rewe_import` by the admin aggregator — so they ARE one scope. A new
 * REWE import atomically replaces this whole scope (no stale duplicates), while
 * non-REWE offers and other stores are never touched.
 */
export function isReweBrowserScopeOffer(offer: Pick<Offer, 'storeChain' | 'tags' | 'id'>): boolean {
  if (String(offer.storeChain ?? '').toUpperCase() !== 'REWE') {
    return false;
  }
  const tags = Array.isArray(offer.tags) ? offer.tags : [];
  return tags.includes('browser-import') || String(offer.id ?? '').startsWith('rewe_browser_');
}

export interface ReweScopeBuckets {
  current: Offer[];
  nextWeek: Offer[];
  filtered: Offer[];
}

export interface ReweScopeReplacementResult extends ReweScopeBuckets {
  replacedPreviousCount: { current: number; nextWeek: number; filtered: number; total: number };
}

/**
 * Atomically replace the REWE manual-import scope (Problem 1). Every previous
 * REWE-browser-scope offer is dropped from each bucket and the freshly imported
 * ones take their place; non-REWE offers and other stores are kept verbatim and
 * in order. Pure (no snapshot mutation) so the caller decides when/if to commit
 * — a rejected import simply never calls this and the snapshot stays intact.
 */
export function replaceReweScopeOffers(
  previous: ReweScopeBuckets,
  incoming: ReweScopeBuckets,
): ReweScopeReplacementResult {
  const replacedPreviousCount = {
    current: previous.current.filter(isReweBrowserScopeOffer).length,
    nextWeek: previous.nextWeek.filter(isReweBrowserScopeOffer).length,
    filtered: previous.filtered.filter(isReweBrowserScopeOffer).length,
    total: 0,
  };
  replacedPreviousCount.total =
    replacedPreviousCount.current + replacedPreviousCount.nextWeek + replacedPreviousCount.filtered;
  return {
    current: [...previous.current.filter((offer) => !isReweBrowserScopeOffer(offer)), ...incoming.current],
    nextWeek: [...previous.nextWeek.filter((offer) => !isReweBrowserScopeOffer(offer)), ...incoming.nextWeek],
    filtered: [...previous.filtered.filter((offer) => !isReweBrowserScopeOffer(offer)), ...incoming.filtered],
    replacedPreviousCount,
  };
}

function cleanText(value: string | undefined): string {
  return String(value ?? '')
    .replace(/\u00ad/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDecimal(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Number(value.toFixed(2)) : undefined;
  }
  if (!value) {
    return undefined;
  }

  const cleaned = value.replace(/[^\d,.-]/g, '').replace(/^-([,.])/, '0$1');
  if (!cleaned) {
    return undefined;
  }

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;

  if (lastComma >= 0 && lastDot >= 0) {
    normalized =
      lastComma > lastDot
        ? cleaned.replace(/\./g, '').replace(',', '.')
        : cleaned.replace(/,/g, '');
  } else if (lastComma >= 0) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? Number(parsed.toFixed(2)) : undefined;
}

function stableReweImportId(name: string, price: number, unit: string, sourceUrl: string): string {
  const source = `REWE|${normalizeText(name)}|${price}|${normalizeText(unit)}|${sourceUrl}`;
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash << 5) - hash + source.charCodeAt(index);
    hash |= 0;
  }
  return `rewe_browser_${Math.abs(hash).toString(36)}`;
}

function defaultValidity(now: Date): { start: string; end: string } {
  const start = new Date(now);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function berlinLikeUtcDate(year: number, month: number, day: number, endOfDay = false): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (endOfDay) {
    date.setUTCHours(23, 59, 59, 999);
  }
  return date.toISOString();
}

export function parseGermanDateRange(
  value: string | undefined,
  now = new Date(),
): { start: string; end: string } | undefined {
  const text = cleanText(value);
  const match = text.match(
    /(\d{1,2})\.(\d{1,2})\.?\s*(?:bis|-|–)\s*(\d{1,2})\.(\d{1,2})\.?/i,
  );
  if (!match) {
    return undefined;
  }

  const startDay = Number(match[1]);
  const startMonth = Number(match[2]);
  const endDay = Number(match[3]);
  const endMonth = Number(match[4]);
  const startYear = now.getFullYear();
  const endYear = endMonth < startMonth ? startYear + 1 : startYear;

  if (
    !Number.isFinite(startDay) ||
    !Number.isFinite(startMonth) ||
    !Number.isFinite(endDay) ||
    !Number.isFinite(endMonth)
  ) {
    return undefined;
  }

  return {
    start: berlinLikeUtcDate(startYear, startMonth, startDay),
    end: berlinLikeUtcDate(endYear, endMonth, endDay, true),
  };
}

function parseBasePriceFromText(
  value: string | undefined,
): { basePrice?: number; baseUnit?: string } {
  const text = cleanText(value);
  const match = text.match(
    /(?:\(|,|\s)(\d+(?:[,.]\d+)?\s*(?:kg|g|l|ml|cl|stk|stueck|stück))\s*=\s*([\d.,-]+)\s*(?:€|EUR)?/i,
  );
  if (!match) {
    return {};
  }

  return {
    baseUnit: cleanText(match[1]),
    basePrice: parseDecimal(match[2]),
  };
}

function inferUnit(name: string, description: string, explicitUnit: string | undefined): string {
  const normalizedExplicit = cleanText(explicitUnit);
  if (normalizedExplicit) {
    return normalizedExplicit;
  }

  const source = `${description} ${name}`;
  const packagedUnitMatch = source.match(
    /\b(?:je\s+)?(\d+(?:[,.]\d+)?[\s-]*(?:kg|g|l|ml|cl)[\s-]*(?:pckg\.?|packung|becher|fl\.?|flasche|schale))\b/i,
  );
  if (packagedUnitMatch) {
    return cleanText(packagedUnitMatch[1]);
  }

  const jeMatch = source.match(
    /\bje\s+([^,()]+?(?:pckg\.?|packung|becher|flasche|schale|stück|stk|kg|ml|cl|g|l|fl\.?))\b/i,
  );
  if (jeMatch) {
    return cleanText(jeMatch[1]);
  }

  const unitMatch = source.match(
    /\b(\d+(?:[,.]\d+)?[\s-]*(?:pckg\.?|packung|becher|flasche|schale|stück|stk|kg|ml|cl|g|l|fl\.?))\b/i,
  );
  if (unitMatch) {
    return cleanText(unitMatch[1]);
  }

  return 'Stk';
}

/**
 * Resolve the simple category for a REWE-imported offer.
 *
 * The REWE PDF/Screenshot section heading ("Tiefkühl", "Kühlung", …) is read
 * from a FLAT text stream whose order interleaves columns, so a heading routinely
 * "carries over" onto products from other sections (the snapshot bug where
 * Barilla Pesto / Nimm 2 / Alpro showed up as "Tiefkühl"). We therefore decide
 * the category from the PRODUCT NAME first; the heading is only a fallback when
 * the name is inconclusive — and a bare heading may NEVER promote a product to
 * "Tiefkühl" (the one heading that also forces a strong, visible "frozen" label
 * in the app). Frozen products keep "Tiefkühl" when their NAME says so (e.g. an
 * "Iglo"/"tiefgekühlt" keyword). Everything else stays honestly "Sonstiges" and
 * is re-classified by the KI categorizer in both scan versions.
 */
export function resolveReweCategory(
  rawHeading: string | undefined,
  name: string,
  description: string,
  /** True when the section heading is STRUCTURALLY the card's own department (the
   *  browser DOM walk assigns the nearest preceding section). Then a "Tiefkühl"
   *  heading is trustworthy and kept (P3). For the PDF/screenshot FLAT text stream
   *  the heading routinely bleeds across columns, so it defaults to false and a
   *  bare "Tiefkühl" heading is never allowed to force the frozen label. */
  headingReliable = false,
): SimpleOfferCategory {
  // 1) The product NAME alone is the strongest, cleanest signal. Try it first so
  //    a description contaminated by a neighbouring card (OCR/flat-stream bleed,
  //    e.g. "Likör" landing on "Lindt Lindor") cannot override it.
  const byNameOnly = toSimpleOfferCategory(undefined, name);
  if (byNameOnly !== 'Sonstiges') {
    return byNameOnly;
  }
  // 2) Name + description, for products whose name alone is inconclusive.
  const hint = `${name} ${description}`.trim();
  const byName = toSimpleOfferCategory(undefined, hint);
  if (byName !== 'Sonstiges') {
    return byName;
  }
  // 2b) High-precision COMPOUND product repair (level 2 of the priority): a
  //     distinctive product term in the name ("Nimm 2 Lachgummi" → Snacks,
  //     "Falafel" → Konserven) wins over the section context before we fall back
  //     to the department heading — so a candy never keeps a carried "Tiefkühl".
  const repaired = repairSimpleOfferCategory({ name, category: 'Sonstiges' });
  if (repaired !== 'Sonstiges') {
    return repaired as SimpleOfferCategory;
  }
  const byHeading = toSimpleOfferCategory(rawHeading, hint);
  // A possibly mis-carried (PDF flat-stream) section heading must never force the
  // visible frozen label when the product name gave no frozen signal. When the
  // heading is structurally reliable (browser DOM), the Tiefkühl department is
  // trustworthy and kept — Mini Laugen-Mix / Wildlachs Filets stay frozen (P3).
  if (byHeading === 'Tiefkühl' && !headingReliable) {
    return 'Sonstiges';
  }
  return byHeading;
}

function resolveUrl(value: string | undefined, baseUrl: string): string | undefined {
  const raw = cleanText(value);
  if (!raw) {
    return undefined;
  }

  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return undefined;
  }
}

/**
 * Resolve a value to an http(s) URL only (Problem 6). `javascript:;`, `data:`,
 * `blob:`, `about:` and empty/relative-without-base values are rejected — a
 * product link that is not a real navigable URL must never become a sourceUrl
 * (it would also poison the stable offer id via stableReweImportId). Returns
 * undefined when no safe http(s) URL can be produced; the caller falls back to
 * the real REWE page URL.
 */
export function resolveHttpUrl(value: string | undefined, baseUrl: string): string | undefined {
  const raw = cleanText(value);
  if (!raw) {
    return undefined;
  }
  // Reject dangerous/non-navigable schemes outright before URL resolution.
  if (/^(?:javascript|data|blob|about|mailto|tel|vbscript|file):/i.test(raw)) {
    return undefined;
  }
  let resolved: URL;
  try {
    resolved = new URL(raw, baseUrl);
  } catch {
    return undefined;
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    return undefined;
  }
  return resolved.toString();
}

// Generic REWE department/section VOCABULARY (not a product list): the words
// REWE uses for its flyer sections and page chrome. A "name" made up ONLY of
// these words (plus connectors) is a section heading carried into the offer
// list, never a product — exactly the live leak seen in the last bookscan
// ("An der Bedientheke", "Tiefkühl", "Freizeit und Mode" all became offers).
// Kept structural so it survives future weeks; real product nouns are absent.
const REWE_SECTION_VOCAB = new Set([
  'obst', 'gemuese', 'gemüse', 'kuehlung', 'kühlung', 'tiefkuehl', 'tiefkühl',
  'tiefkuehlung', 'tiefkühlung', 'drogerie', 'tier', 'tiere', 'freizeit', 'mode',
  'getraenke', 'getränke', 'bedientheke', 'theke', 'haushalt', 'spielwaren',
  'baby', 'garten', 'blumen', 'pflanzen', 'kosmetik', 'hygiene', 'wein',
  'spirituosen', 'suesses', 'süßes', 'salziges', 'frische', 'molkerei',
  'backwaren', 'snacks', 'knabbereien', 'vorratskammer', 'fruehstueck',
  'frühstück', 'suessigkeiten', 'süßigkeiten', 'aktion', 'aktionen', 'angebot',
  'angebote', 'bonus', 'knaller', 'wochenangebote', 'highlights', 'momente',
  'angrillen', 'grillen', 'sortiment', 'entdecken', 'markt', 'maerkte', 'märkte',
  'schnell', 'einfach', 'fan', 'fleisch', 'wurst', 'fisch', 'kaese', 'käse',
  'brot', 'feinkost',
]);

const REWE_SECTION_CONNECTORS = new Set([
  'an', 'der', 'die', 'das', 'und', 'oder', 'im', 'in', 'am', 'zum', 'zur',
  'fuer', 'für', 'mit', 'dein', 'deine', 'jetzt', 'neu', 'alle', 'mehr',
  'unsere', 'unser', 'beim', 'zu', 'de',
]);

/**
 * Is this "name" only a REWE section heading / page-chrome label rather than a
 * product? True when EVERY token is a department word or connector AND at least
 * one is a real section word. Deliberately conservative: a brand or product noun
 * (e.g. "Le Gruyère AOP", "Bratwurst-Gemüse-Spieße", "Snack Äpfel") contains a
 * token outside the vocabulary and stays a valid offer. Never a product list.
 */
export function isReweSectionHeadingName(name: string): boolean {
  const tokens = String(name ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s&-]/gu, ' ')
    .split(/[\s&-]+/)
    .filter(Boolean)
    // a trailing bare index ("Blumenstrauß 1") is column noise, ignore digits
    .filter((token) => !/^\d+$/.test(token));
  if (tokens.length === 0) {
    return false;
  }
  let hasSectionWord = false;
  for (const token of tokens) {
    if (REWE_SECTION_VOCAB.has(token)) {
      hasSectionWord = true;
      continue;
    }
    if (REWE_SECTION_CONNECTORS.has(token)) {
      continue;
    }
    return false; // a token outside both sets ⇒ carries product identity
  }
  return hasSectionWord;
}

// Adverbs/connectors that, at the START of a "name", only ever introduce a
// product PROPERTY, never a product itself ("auch alkoholfrei", "wahlweise …").
const REWE_PROPERTY_LEADERS =
  /^(?:auch|ebenfalls|wahlweise|wahlw\.?|optional|inkl\.?|inklusive|dazu|sowie|alternativ)\b/i;
// Property adjectives that, alone (with a leader/connectors), carry no product
// identity. Generic claims only — never product nouns.
const REWE_PROPERTY_WORDS = new Set([
  'alkoholfrei', 'vegan', 'vegetarisch', 'laktosefrei', 'glutenfrei', 'bio',
  'fettarm', 'fettreduziert', 'zuckerfrei', 'zuckerreduziert', 'koffeinfrei',
  'kalorienarm', 'ungesüßt', 'ungesuesst', 'gekühlt', 'gekuehlt', 'tiefgekühlt',
  'tiefgekuehlt', 'erhältlich', 'erhaeltlich', 'verfügbar', 'verfuegbar',
  'haltbar', 'frisch', 'mild', 'würzig', 'wuerzig', 'auch', 'oder', 'und', 'mit',
]);

// Generic CTA / time-window / navigation VOCABULARY (P2). The words REWE uses for
// urgency, call-to-action and page navigation — never a product. A "name" made up
// ONLY of these (plus connectors) is a promo/period/CTA label that leaked into the
// card text ("nur noch heute", "solange der Vorrat reicht", "Jetzt entdecken",
// "Mehr anzeigen"). Kept structural with a NARROW generic vocabulary: a real
// product carrying an action word ("Coca-Cola nur diese Woche") still owns a token
// outside both sets and stays a valid offer. No product/brand/week list.
const REWE_CTA_VOCAB = new Set([
  // urgency / time window
  'heute', 'morgen', 'woche', 'wochen', 'tag', 'tage', 'taeglich', 'täglich',
  'solange', 'vorrat', 'vorraet', 'vorräte', 'vorraete', 'reicht', 'reichts',
  'reichen', 'schluss', 'letzte', 'letzten', 'letztmalig', 'gleich', 'sofort',
  'bald', 'endspurt', 'ab', 'gueltig', 'gültig',
  // call to action / navigation / shop chrome
  'hier', 'entlang', 'klick', 'klicken', 'anzeigen', 'laden', 'weitere',
  'entdecken', 'entdecke', 'sichern', 'sichere', 'dir', 'sparen', 'spare',
  'sparst', 'gewinnen', 'gewinne', 'mitmachen', 'shoppen', 'kaufen', 'ansehen',
  'gratis', 'jetzt', 'neu', 'schnell', 'einfach', 'los', 'geht', 'dabei',
]);

// Connectors that may glue a CTA/time phrase together without giving it product
// identity. Superset-ish of the section connectors plus the urgency-typical ones.
const REWE_CTA_CONNECTORS = new Set([
  'nur', 'noch', 'und', 'oder', 'der', 'die', 'das', 'den', 'dem', 'dein',
  'deine', 'deinen', 'dich', 'du', 'sie', 'wir', 'es', 'so', 'am', 'im', 'in',
  'auf', 'zu', 'zum', 'zur', 'mit', 'bei', 'beim', 'vom', 'von', 'fuer', 'für',
  'ein', 'eine', 'einen', 'mehr', 'alle', 'aller', 'allen',
]);

export type ReweNonProductReason =
  | 'section'
  | 'promo_badge'
  | 'cta_phrase'
  | 'property_fragment'
  | 'layout_artifact';

/**
 * Is this "name" only a CTA / time-window / navigation phrase rather than a
 * product (P2)? True when EVERY token is a CTA word or connector AND at least one
 * is a real CTA/urgency word — e.g. "nur noch heute", "solange der Vorrat reicht",
 * "Jetzt entdecken", "Mehr anzeigen". A product noun anywhere ("Coca-Cola nur
 * diese Woche") leaves a token outside both sets ⇒ stays a valid offer.
 */
export function isReweCtaPhraseName(name: string): boolean {
  const tokens = String(name ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s&-]/gu, ' ')
    .split(/[\s&-]+/)
    .filter(Boolean)
    .filter((token) => !/^\d+$/.test(token));
  if (tokens.length === 0) {
    return false;
  }
  let hasCtaWord = false;
  for (const token of tokens) {
    if (REWE_CTA_VOCAB.has(token)) {
      hasCtaWord = true;
      continue;
    }
    if (REWE_CTA_CONNECTORS.has(token) || REWE_SECTION_CONNECTORS.has(token)) {
      continue;
    }
    return false; // a token outside all sets ⇒ carries product identity
  }
  return hasCtaWord;
}

/**
 * Generic detector for "names" that are NOT a product (Problem 3) — used both in
 * the browser extraction (skip as a name candidate) and server-side (route to
 * review, never live). Categories, kept structural with NO product/week list:
 *  - `section`          a department/section label ("Tiefkühl", "An der Bedientheke")
 *  - `promo_badge`      a price/promo badge only ("Probierpreis", "Tiefpreis")
 *  - `cta_phrase`       a CTA/time-window/navigation phrase ("nur noch heute")
 *  - `property_fragment`a bare product property ("auch alkoholfrei")
 *  - `layout_artifact`  no letters at all / bare index ("1", "·")
 * Returns null when the name carries real product identity.
 */
export function reweNonProductNameReason(name: string): ReweNonProductReason | null {
  const trimmed = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!trimmed || !/\p{L}/u.test(trimmed)) {
    return 'layout_artifact';
  }
  if (isReweSectionHeadingName(trimmed)) {
    return 'section';
  }
  const tokens = trimmed
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);
  // Promo badge: every token is a promo word or ends in "-preis"
  // ("Probierpreis", "Tiefpreis", "Aktion Knaller"). A real product carrying a
  // promo word too ("Coca-Cola Tiefpreis") keeps a product token ⇒ not flagged.
  const promoWord = /^(?:aktion|aktionen|angebot|angebote|knaller|kracher|hammer|hammerpreis|rabatt|bonus|coupon|deal|probierpreis|tiefpreis|dauertiefpreis|sparpreis|preis)$/;
  if (tokens.length > 0 && tokens.every((token) => promoWord.test(token) || /preis$/.test(token))) {
    return 'promo_badge';
  }
  // CTA / time-window / navigation phrase ("nur noch heute", "Jetzt entdecken").
  if (isReweCtaPhraseName(trimmed)) {
    return 'cta_phrase';
  }
  // Property fragment: starts with a property leader and every remaining token is
  // a generic property word/connector ("auch alkoholfrei", "wahlweise vegan").
  if (REWE_PROPERTY_LEADERS.test(trimmed)) {
    const rest = tokens.slice(1);
    if (rest.length > 0 && rest.every((token) => REWE_PROPERTY_WORDS.has(token))) {
      return 'property_fragment';
    }
  }
  return null;
}

/**
 * Resolve ONE REWE product card (its visible text lines, in DOM order) into a
 * name/price/description — the pure core of the bookmarklet's per-card
 * extraction, so the browser logic is unit-testable and can never silently drop
 * a card without a reason. The product NAME is the first line that is not a
 * price, base/strike/deposit/Grundpreis line, bare unit, validity range, promo
 * badge or section heading; the price comes from the shared {@link pickReweCardPrice}.
 *
 * The bookmarklet injects this function verbatim (alongside pickReweCardPrice and
 * isReweSectionHeadingName), so the structural card capture matches these tests.
 */
export function extractReweCardFields(lines: string[]): ReweCardExtraction {
  const cleaned = (lines || [])
    .map((line) => String(line || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const text = cleaned.join('\n');
  const price = pickReweCardPrice(text);
  if (!price) {
    return { name: '', price: '', description: '', rejectReason: 'no_price' };
  }
  const isMoney = /\d{1,3}[,.]\d{2}\s*€/;
  const isControl = /grundpreis|pfand|zzgl|statt|uvp|^\(|=\s*[\d.,]+\s*€/i;
  const isBareUnit =
    /^\d*[\s-]*(?:kg|g|l|ml|cl|stk|stück|pckg\.?|packung|becher|flasche|fl\.?|schale|dose|glas|netz|beutel)\.?$/i;
  const isValidity = /\d{1,2}\.\d{1,2}\.?\s*(?:bis|-|–)\s*\d{1,2}\.\d{1,2}/;
  const isPromoBadge = (line: string): boolean =>
    REWE_PROMO_ANCHOR_PATTERN.test(line) || REWE_BONUS_COUPON_PATTERN.test(line);

  let name = '';
  for (const line of cleaned) {
    if (isMoney.test(line) || isControl.test(line) || isBareUnit.test(line) || isValidity.test(line)) {
      continue;
    }
    if (isPromoBadge(line)) {
      continue;
    }
    if (!/[a-zA-ZÀ-ÿ]/.test(line)) {
      continue;
    }
    if (line.replace(/[^\p{L}\p{N}]/gu, '').length < 3) {
      continue;
    }
    // Skip section labels, promo badges, property fragments and layout artifacts
    // as name candidates (Problem 3) — a real product line follows in the card.
    if (reweNonProductNameReason(line)) {
      continue;
    }
    name = line;
    break;
  }
  if (!name) {
    return { name: '', price, description: '', rejectReason: 'no_name' };
  }
  const nonProduct = reweNonProductNameReason(name);
  if (nonProduct === 'section') {
    return { name, price, description: '', rejectReason: 'section_heading' };
  }
  if (nonProduct) {
    // promo_badge / property_fragment / layout_artifact ⇒ no usable product name.
    return { name, price, description: '', rejectReason: 'no_name' };
  }
  const description = cleaned
    .filter((line) => line !== name)
    .filter((line) => !isMoney.test(line) && !isControl.test(line) && !isPromoBadge(line))
    .join(' ')
    .slice(0, 400);
  return { name, price, description, rejectReason: null };
}

// ───────────────────────── Shared DOM collector ─────────────────────────
// ONE implementation of the live DOM walk, used BOTH by the bookmarklet (which
// injects these functions verbatim via .toString()) AND by executable jsdom
// fixture tests. Typed against minimal structural DOM interfaces so the backend
// tsconfig needs no `dom` lib and the same code runs against a real browser DOM
// and a jsdom DOM. No CSS class or product name is hardcoded anywhere here.

export interface ReweDomNode {
  nodeType?: number;
  nodeValue?: string | null;
  tagName?: string;
  innerText?: string;
  textContent?: string | null;
  childNodes?: ArrayLike<ReweDomNode>;
}

export interface ReweDomElement extends ReweDomNode {
  children: ArrayLike<ReweDomElement>;
  parentElement: ReweDomElement | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): ReweDomElement | null;
  querySelectorAll(selector: string): ArrayLike<ReweDomElement>;
  closest(selector: string): ReweDomElement | null;
  contains(other: ReweDomElement | null): boolean;
  compareDocumentPosition(other: ReweDomElement): number;
  alt?: string;
  src?: string;
  currentSrc?: string;
  href?: string;
}

export interface ReweDomDocument {
  body: ReweDomElement | null;
  documentElement: ReweDomElement | null;
  querySelectorAll(selector: string): ArrayLike<ReweDomElement>;
}

export interface ReweCollectOptions {
  /** Visibility predicate (real getComputedStyle/rect in the browser; in jsdom
   *  tests rects are 0×0 so pass `() => true`). */
  isVisible?: (element: ReweDomElement) => boolean;
  /** Fallback sourceUrl when a card has no product link. */
  pageUrl?: string;
}

export interface ReweBrowserCounters {
  observedCardOccurrences: number;
  uniqueCardCandidates: number;
  repeatedCardObservations: number;
  browserRejected: { noPrice: number; noName: number; sectionHeading: number; extractionError: number };
  browserAcceptedBeforeDedupe: number;
  browserOfferDuplicates: number;
  /** A few example card texts per reject reason — honest "why", not just counts. */
  rejectedExamples: { noPrice: string[]; noName: string[]; sectionHeading: string[] };
}

export interface ReweBrowserDiagnostics {
  domPriceCards: number;
  observedCardOccurrences: number;
  uniqueCardCandidates: number;
  repeatedCardObservations: number;
  rejected: { noPrice: number; noName: number; sectionHeading: number; extractionError: number };
  rejectedExamples?: { noPrice: string[]; noName: string[]; sectionHeading: string[] };
  browserAcceptedBeforeDedupe: number;
  browserOfferDuplicates: number;
  payloadOffers: number;
  consistent: boolean;
  rawPriceMatches?: number;
}

export interface ReweCollectedOffer {
  name: string;
  price: string;
  description: string;
  unit: string;
  imageUrl: string;
  sourceUrl: string;
  category: string;
  validityLabel: string;
}

// Inline formatting tags kept WITHIN a line; every other element boundary starts
// a new line (so name/desc/price in separate <div>/<span> are separate lines).
const REWE_INLINE_KEEP = new Set([
  'STRONG', 'EM', 'B', 'I', 'U', 'SUP', 'SUB', 'SMALL', 'MARK', 'ABBR', 'WBR',
  'TIME', 'BDI', 'BDO', 'CITE', 'Q', 'S', 'INS', 'DEL', 'CODE', 'VAR', 'SAMP', 'KBD', 'FONT',
]);

function reweNormalizeLine(value: string | null | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Build visible text LINES from a DOM element by walking the tree and inserting
 * a break at every non-inline element boundary — WITHOUT collapsing the whole
 * text first (Problem 1). A card whose name/description/price live in separate
 * block/`<span>` nodes is no longer flattened into one price-bearing line (which
 * made extraction return no_name). Inline formatting tags stay within their line.
 */
export function reweDomTextLines(element: ReweDomNode): string[] {
  const lines: string[] = [];
  let current = '';
  const flush = (): void => {
    const text = reweNormalizeLine(current);
    if (text) lines.push(text);
    current = '';
  };
  const walk = (node: ReweDomNode): void => {
    const children = node.childNodes ? Array.from(node.childNodes) : [];
    for (const child of children) {
      if (child.nodeType === 3) {
        current += ` ${child.nodeValue ?? ''}`;
      } else if (child.nodeType === 1) {
        const inline = REWE_INLINE_KEEP.has(String(child.tagName ?? '').toUpperCase());
        if (!inline) flush();
        walk(child);
        if (!inline) flush();
      }
    }
  };
  walk(element);
  flush();
  return lines;
}

/**
 * Split one element into normalized lines. Prefer the browser's innerText (true
 * visual line breaks); when it is unavailable/unreliable (≤1 line — e.g. jsdom,
 * or a card the browser collapsed onto one line) fall back to the structural
 * block walker {@link reweDomTextLines}. Either way the lines are normalized
 * AFTER splitting, never before, so no line break is lost.
 */
export function reweSplitElementLines(element: ReweDomNode): string[] {
  const raw = typeof element.innerText === 'string' ? element.innerText : '';
  let lines = raw ? raw.split(/\r?\n/).map(reweNormalizeLine).filter(Boolean) : [];
  if (lines.length <= 1) {
    const blockLines = reweDomTextLines(element);
    if (blockLines.length > lines.length) {
      lines = blockLines;
    }
  }
  return lines;
}

function reweTextOf(element: ReweDomElement): string {
  return reweNormalizeLine(element.textContent ?? '');
}

/** Only http(s) URLs are kept (Problem 6). A `javascript:;`/`data:`/`blob:`
 *  pseudo-link (REWE wraps some tiles in `<a href="javascript:;">`) returns ''
 *  so it never becomes a sourceUrl, an identity key, or part of a stable id. */
function reweSafeHttpUrl(value: string | null | undefined): string {
  const raw = String(value ?? '').trim();
  return /^https?:\/\//i.test(raw) ? raw : '';
}

/**
 * Harvest SALE prices that live only in SEMANTIC ATTRIBUTES of a card (P1) —
 * `aria-label`, `title`, `content`, `data-price`/`data-offer-price` — which REWE
 * uses on the price/add-to-cart control while the visible text shows just a
 * Grundpreis. Returned as clean "E,CC €" lines the extractor can pick. A price
 * tied to a Grundpreis ("= 22,43 €", "je …") or a per-unit/deposit context is
 * skipped, so an attribute base price can never become the offer price. No price
 * is invented — only what an attribute literally spells out is surfaced.
 */
export function reweAttributePriceLines(card: ReweDomElement): string[] {
  const ATTRS = ['aria-label', 'title', 'content', 'data-price', 'data-offer-price'];
  const values: string[] = [];
  const read = (el: ReweDomElement | null): void => {
    if (!el || typeof el.getAttribute !== 'function') {
      return;
    }
    for (const attr of ATTRS) {
      const value = el.getAttribute(attr);
      if (value) {
        values.push(value);
      }
    }
  };
  read(card);
  try {
    const selector = ATTRS.map((attr) => `[${attr}]`).join(',');
    for (const el of Array.from(card.querySelectorAll(selector)).slice(0, 16)) {
      read(el);
    }
  } catch {
    // querySelector may reject the attribute selector in exotic DOMs — ignore.
  }

  const lines: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const text = reweNormalizeLine(raw);
    for (const match of text.matchAll(/(\d{1,3}[,.]\d{2})\s*(?:€|eur)/gi)) {
      const index = match.index ?? 0;
      const before = text.slice(Math.max(0, index - 14), index);
      // Skip Grundpreis ("= 22,43 €") and per-unit/deposit prices.
      if (/[=/]|\bje\b|grundpreis|pfand|zzgl|statt|uvp/i.test(before)) {
        continue;
      }
      const token = `${match[1]} €`;
      if (!seen.has(token)) {
        seen.add(token);
        lines.push(token);
      }
    }
  }
  return lines;
}

/**
 * Count the OFFER prices in a block of card text (one product = one offer
 * price). Uses the SAME line-local exclusions as {@link pickReweCardPrice} —
 * base ("1 l = …"), deposit ("zzgl. … Pfand"), strike ("statt …"), UVP,
 * Grundpreis and Bonus/Coupon prices do NOT count — so a single card with an
 * action + base + strike + Pfand still counts as ONE product, while two real
 * products count as two. Must receive LINE-separated text (not collapsed),
 * otherwise a later "Pfand" on the same flattened line would void the real price.
 */
export function reweCountOfferPrices(text: string): number {
  const joined = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
  const looksLikeBonusTile = REWE_BONUS_COUPON_PATTERN.test(joined);
  const nonOfferBefore = /[=/]|bonus|pfand|zzgl|statt|uvp|grundpreis/i;
  const nonOfferAfter = /pfand|grundpreis/i;
  let count = 0;
  for (const match of joined.matchAll(/(\d{1,3}[,.]\d{2})\s*€/g)) {
    const index = match.index ?? 0;
    const lineStart = joined.lastIndexOf('\n', index) + 1;
    const lineEndRaw = joined.indexOf('\n', index);
    const lineEnd = lineEndRaw < 0 ? joined.length : lineEndRaw;
    const lineLocal = joined.slice(lineStart, lineEnd);
    if (nonOfferBefore.test(joined.slice(lineStart, index))) {
      continue;
    }
    if (nonOfferAfter.test(joined.slice(index, lineEnd))) {
      continue;
    }
    if (REWE_BONUS_COUPON_PATTERN.test(lineLocal) || looksLikeBonusTile) {
      continue;
    }
    count += 1;
  }
  return count;
}

/** Distinct product images in an element (logo/icon/bonus art excluded). */
function reweCountProductImages(element: ReweDomElement): number {
  let count = 0;
  for (const img of Array.from(element.querySelectorAll('img'))) {
    if (!/bonus|logo|icon/i.test(reweNormalizeLine(img.alt ?? img.getAttribute('alt') ?? ''))) {
      count += 1;
    }
  }
  return count;
}

/** True when `parent` carries a REWE SECTION heading that is not inside `card`
 *  — i.e. `parent` is a section wrapper and adopting it would swallow the
 *  heading (and risk merging neighbouring cards). A product-name heading
 *  (e.g. an `<h3>Bananen`) is NOT a section label, so it never blocks the climb. */
function reweParentHasSectionHeadingOutside(parent: ReweDomElement, card: ReweDomElement): boolean {
  for (const heading of Array.from(parent.querySelectorAll('h1,h2,h3,h4'))) {
    if (card.contains(heading)) {
      continue;
    }
    if (isReweSectionHeadingName(reweNormalizeLine(heading.textContent ?? ''))) {
      return true;
    }
  }
  return false;
}

/**
 * Structural REWE product-card delimitation (Problem 2). Anchors on price
 * "leaves" (smallest element whose own text shows a price) and climbs to the
 * card boundary, allowing MULTIPLE related prices per card (action + base +
 * strike + Pfand + bonus) but never crossing into a second product. The climb
 * stops when the parent would (a) hold ≥2 offer prices, (b) hold ≥2 product
 * images, (c) add a section heading, or (d) exceed a card-sized text budget.
 * Two adjacent product cards therefore never merge. CSS classes are never used;
 * link/image/offer-price-group/size are the only signals.
 */
export function findReweCardElements(
  doc: ReweDomDocument,
  opts: ReweCollectOptions = {},
): ReweDomElement[] {
  const isVisible = opts.isVisible ?? ((): boolean => true);
  const moneyToken = /\d{1,3}[,.]\d{2}\s*€/;
  const body = doc.body;
  const docEl = doc.documentElement;

  const leaves: ReweDomElement[] = [];
  for (const element of Array.from(doc.querySelectorAll('body *'))) {
    if (!isVisible(element)) {
      continue;
    }
    if (!moneyToken.test(element.textContent ?? '')) {
      continue;
    }
    let childHasPrice = false;
    for (const child of Array.from(element.children)) {
      if (moneyToken.test(child.textContent ?? '')) {
        childHasPrice = true;
        break;
      }
    }
    if (!childHasPrice) {
      leaves.push(element);
    }
  }

  const cards = new Set<ReweDomElement>();
  for (const leaf of leaves) {
    let card = leaf;
    let node: ReweDomElement = leaf;
    for (let depth = 0; depth < 12 && node.parentElement; depth += 1) {
      const parent = node.parentElement;
      if (parent === body || parent === docEl) {
        break;
      }
      // (a) a second independent OFFER price ⇒ a second product. Counted over
      //     line-separated text so base/deposit/strike of ONE card never read
      //     as a second product.
      if (reweCountOfferPrices(reweDomTextLines(parent).join('\n')) >= 2) {
        break;
      }
      // (b) a second product image ⇒ a second product.
      if (reweCountProductImages(parent) >= 2) {
        break;
      }
      // (c) a section heading ⇒ section wrapper, not a single card.
      if (reweParentHasSectionHeadingOutside(parent, card)) {
        break;
      }
      // (d) card-sized text budget.
      if (reweTextOf(parent).length > 600) {
        break;
      }
      card = parent;
      node = parent;
    }
    cards.add(card);
  }

  // Keep only the innermost cards: never represent two real cards by a shared
  // ancestor (defensive — the climb already stops before merging products).
  const all = Array.from(cards);
  return all.filter((candidate) => !all.some((other) => other !== candidate && candidate.contains(other)));
}

/** Verify every browser-side balance equation; returns the failed ones. */
export function reweBrowserBalanceErrors(
  counters: ReweBrowserCounters,
  payloadOffers: number,
): string[] {
  const errors: string[] = [];
  const rejectedTotal =
    counters.browserRejected.noPrice +
    counters.browserRejected.noName +
    counters.browserRejected.sectionHeading +
    counters.browserRejected.extractionError;
  if (counters.observedCardOccurrences !== counters.uniqueCardCandidates + counters.repeatedCardObservations) {
    errors.push('observed ≠ unique + repeated');
  }
  if (counters.uniqueCardCandidates !== counters.browserAcceptedBeforeDedupe + rejectedTotal) {
    errors.push('unique ≠ acceptedBeforeDedupe + rejected');
  }
  if (counters.browserAcceptedBeforeDedupe !== payloadOffers + counters.browserOfferDuplicates) {
    errors.push('acceptedBeforeDedupe ≠ payloadOffers + offerDuplicates');
  }
  return errors;
}

export function buildReweBrowserDiagnostics(
  counters: ReweBrowserCounters,
  payloadOffers: number,
): ReweBrowserDiagnostics {
  return {
    domPriceCards: counters.uniqueCardCandidates,
    observedCardOccurrences: counters.observedCardOccurrences,
    uniqueCardCandidates: counters.uniqueCardCandidates,
    repeatedCardObservations: counters.repeatedCardObservations,
    rejected: { ...counters.browserRejected },
    rejectedExamples: {
      noPrice: counters.rejectedExamples.noPrice.slice(0, 5),
      noName: counters.rejectedExamples.noName.slice(0, 5),
      sectionHeading: counters.rejectedExamples.sectionHeading.slice(0, 5),
    },
    browserAcceptedBeforeDedupe: counters.browserAcceptedBeforeDedupe,
    browserOfferDuplicates: counters.browserOfferDuplicates,
    payloadOffers,
    consistent: reweBrowserBalanceErrors(counters, payloadOffers).length === 0,
  };
}

/**
 * Verify the full DOM→snapshot counting chain. The server equation always holds
 * by construction; the browser equations + the browser↔payload bridge are only
 * checked when the bookmarklet sent the needed counters (older payloads skip
 * them rather than false-fail). Returns the failed equations (empty = balanced).
 */
export function computeReweChainBalanceErrors(input: {
  diagnostics?: ReweBrowserImportRequest['diagnostics'];
  browserRejected?: { noPrice: number; noName: number; sectionHeading: number; extractionError: number };
  payloadReceived: number;
  serverSkipped: { noName: number; noPrice: number; sectionHeading: number; nonProduct: number };
  duplicatesMerged: number;
  liveNormalized: number;
  reviewHeldBack: number;
}): string[] {
  const errors: string[] = [];
  const serverSkippedTotal =
    input.serverSkipped.noName +
    input.serverSkipped.noPrice +
    input.serverSkipped.sectionHeading +
    input.serverSkipped.nonProduct;
  if (
    input.payloadReceived !==
    input.liveNormalized + input.reviewHeldBack + serverSkippedTotal + input.duplicatesMerged
  ) {
    errors.push('payloadOffers ≠ live + review + serverSkips + serverDuplicatesMerged');
  }

  const d = input.diagnostics;
  const r = input.browserRejected;
  if (
    d &&
    r &&
    typeof d.observedCardOccurrences === 'number' &&
    typeof d.uniqueCardCandidates === 'number' &&
    typeof d.repeatedCardObservations === 'number' &&
    typeof d.browserAcceptedBeforeDedupe === 'number' &&
    typeof d.browserOfferDuplicates === 'number'
  ) {
    const rejectedTotal = r.noPrice + r.noName + r.sectionHeading + r.extractionError;
    if (d.observedCardOccurrences !== d.uniqueCardCandidates + d.repeatedCardObservations) {
      errors.push('observed ≠ unique + repeated');
    }
    if (d.uniqueCardCandidates !== d.browserAcceptedBeforeDedupe + rejectedTotal) {
      errors.push('unique ≠ acceptedBeforeDedupe + browserRejected');
    }
    const browserPayload =
      typeof d.payloadOffers === 'number'
        ? d.payloadOffers
        : d.browserAcceptedBeforeDedupe - d.browserOfferDuplicates;
    if (d.browserAcceptedBeforeDedupe !== browserPayload + d.browserOfferDuplicates) {
      errors.push('acceptedBeforeDedupe ≠ browserPayload + offerDuplicates');
    }
    // Bridge: what the browser emitted must equal what the server received.
    if (browserPayload !== input.payloadReceived) {
      errors.push('browser payloadOffers ≠ server payloadReceived');
    }
  }

  return errors;
}

function reweFindUnit(description: string): string {
  return (
    (description.match(
      /\b(?:je\s+)?(\d+(?:[,.]\d+)?[\s-]*(?:kg|g|l|ml|cl)[\s-]*(?:pckg\.?|packung|becher|fl\.?|flasche|schale))\b/i,
    ) || [])[1] ||
    (description.match(
      /\bje\s+([^,()]+?(?:pckg\.?|packung|becher|flasche|schale|stück|stk|kg|ml|cl|g|l|fl\.?))\b/i,
    ) || [])[1] ||
    (description.match(
      /\b(\d+(?:[,.]\d+)?[\s-]*(?:pckg\.?|packung|becher|flasche|schale|stück|stk|kg|ml|cl|g|l|fl\.?))\b/i,
    ) || [])[1] ||
    ''
  );
}

interface ReweHeadingEntry {
  node: ReweDomElement;
  label: string;
}

/**
 * Resolve the SECTION category for a card (Problem 2). `sectionHeadings` is the
 * already-filtered list of REAL section headings (isReweSectionHeadingName) —
 * product-name headings (an `<h3>Mars m&m's`) are NOT in it, so the previous
 * product's title can never bleed in as the next card's category. We take the
 * nearest section heading that PRECEDES the card and is not inside it; if none
 * exists the category is left empty (never a neighbouring product name).
 */
function reweFindCategory(card: ReweDomElement, sectionHeadings: ReweHeadingEntry[]): string {
  let category = '';
  for (const entry of sectionHeadings) {
    if (card.contains(entry.node)) {
      continue; // a heading inside this card is never its section label
    }
    // DOCUMENT_POSITION_FOLLOWING (4): `card` comes after the heading ⇒ keep the
    // nearest preceding one (the loop overwrites with each later-preceding label).
    if (entry.node.compareDocumentPosition(card) & 4) {
      category = entry.label;
    }
  }
  return category;
}

function reweFindValidityLabel(doc: ReweDomDocument): string {
  const text = reweNormalizeLine(doc.body?.textContent ?? '');
  const match =
    text.match(/Diese Woche\s*(\d{1,2}\.\d{1,2}\.\s*bis\s*\d{1,2}\.\d{1,2}\.?)/i) ||
    text.match(/Nächste Woche\s*(\d{1,2}\.\d{1,2}\.\s*bis\s*\d{1,2}\.\d{1,2}\.?)/i);
  return match ? match[1] : '';
}

export interface ReweDomCollector {
  collect(doc: ReweDomDocument): void;
  offerCount(): number;
  result(): { offers: ReweCollectedOffer[]; counters: ReweBrowserCounters; diagnostics: ReweBrowserDiagnostics };
}

/**
 * Stateful collector shared by the bookmarklet and the DOM tests. `collect(doc)`
 * runs ONE pass (the bookmarklet calls it repeatedly while auto-scrolling, the
 * tests call it once or several times); `result()` returns the offers plus the
 * fully-balanced counting chain. Every card is counted BEFORE the repeat/dedupe
 * checks, so no card disappears silently and the balance equations always hold.
 */
export function createReweDomCollector(opts: ReweCollectOptions = {}): ReweDomCollector {
  const isVisible = opts.isVisible ?? ((): boolean => true);
  const pageUrl = opts.pageUrl ?? '';
  const offers: ReweCollectedOffer[] = [];
  const seenCards = new Set<string>();
  const seenOffers = new Set<string>();
  const counters: ReweBrowserCounters = {
    observedCardOccurrences: 0,
    uniqueCardCandidates: 0,
    repeatedCardObservations: 0,
    browserRejected: { noPrice: 0, noName: 0, sectionHeading: 0, extractionError: 0 },
    browserAcceptedBeforeDedupe: 0,
    browserOfferDuplicates: 0,
    rejectedExamples: { noPrice: [], noName: [], sectionHeading: [] },
  };
  const sample = (lines: string[]): string => lines.join(' · ').slice(0, 80);

  function collect(doc: ReweDomDocument): void {
    // ONLY real section headings become categories (Problem 2): a product-name
    // heading is excluded here, so it can never be carried onto the next card.
    const headings: ReweHeadingEntry[] = Array.from(doc.querySelectorAll('h1,h2,h3,h4'))
      .map((node) => ({ node, label: reweNormalizeLine(node.textContent ?? '') }))
      .filter((entry) => entry.label.length > 0 && isReweSectionHeadingName(entry.label));

    for (const card of findReweCardElements(doc, { isVisible })) {
      // Counted FIRST, before any repeat/dedupe check (Problem 3).
      counters.observedCardOccurrences += 1;
      const visibleLines = reweSplitElementLines(card);
      // P1: append any sale price found ONLY in semantic attributes (aria-label,
      // data-price …) so a card whose visible text shows just a Grundpreis still
      // yields its real action price instead of an honest-but-wrong no_price.
      const attributePrices = reweAttributePriceLines(card);
      const lines = attributePrices.length > 0 ? [...visibleLines, ...attributePrices] : visibleLines;
      const imgs = Array.from(card.querySelectorAll('img'));
      const image =
        imgs.find((img) => !/bonus|logo|icon/i.test(reweNormalizeLine(img.alt ?? img.getAttribute('alt') ?? ''))) ||
        imgs[0] ||
        null;
      const link = (card.closest && card.closest('a[href]')) || card.querySelector('a[href]');
      // P6: only an http(s) product link counts; javascript:;/data:/blob: → ''.
      const linkHref = reweSafeHttpUrl(link ? link.href ?? link.getAttribute('href') ?? '' : '');
      const rawImageSrc = image ? image.currentSrc ?? image.src ?? image.getAttribute('src') ?? image.getAttribute('data-src') ?? '' : '';
      const imageSrc = reweSafeHttpUrl(rawImageSrc) || (/^data:image\//i.test(rawImageSrc) ? rawImageSrc : '');
      const identity = linkHref || imageSrc || '';

      const observationKey = `${lines.join('')}${identity}`;
      if (seenCards.has(observationKey)) {
        counters.repeatedCardObservations += 1;
        continue;
      }
      seenCards.add(observationKey);
      counters.uniqueCardCandidates += 1;

      let extracted: ReweCardExtraction;
      try {
        extracted = extractReweCardFields(lines);
      } catch {
        counters.browserRejected.extractionError += 1;
        continue;
      }
      if (extracted.rejectReason === 'no_price') {
        counters.browserRejected.noPrice += 1;
        if (counters.rejectedExamples.noPrice.length < 5) counters.rejectedExamples.noPrice.push(sample(lines));
        continue;
      }
      if (extracted.rejectReason === 'no_name') {
        counters.browserRejected.noName += 1;
        if (counters.rejectedExamples.noName.length < 5) counters.rejectedExamples.noName.push(sample(lines));
        continue;
      }
      if (extracted.rejectReason === 'section_heading') {
        counters.browserRejected.sectionHeading += 1;
        if (counters.rejectedExamples.sectionHeading.length < 5) counters.rejectedExamples.sectionHeading.push(sample(lines));
        continue;
      }
      if (extracted.rejectReason !== null) {
        counters.browserRejected.extractionError += 1;
        continue;
      }

      counters.browserAcceptedBeforeDedupe += 1;
      const offerKey = `${extracted.name.toLowerCase()}|${extracted.price}|${reweNormalizeLine(extracted.description).toLowerCase()}|${identity}`;
      if (seenOffers.has(offerKey)) {
        counters.browserOfferDuplicates += 1;
        continue;
      }
      seenOffers.add(offerKey);

      offers.push({
        name: extracted.name,
        price: extracted.price,
        description: extracted.description,
        unit: reweFindUnit(extracted.description),
        imageUrl: imageSrc,
        sourceUrl: linkHref || pageUrl,
        category: reweFindCategory(card, headings),
        validityLabel: reweFindValidityLabel(doc),
      });
    }
  }

  return {
    collect,
    offerCount: () => offers.length,
    result: () => ({ offers, counters, diagnostics: buildReweBrowserDiagnostics(counters, offers.length) }),
  };
}

interface ReweCandidate {
  name: string;
  description: string;
  price: number;
  rawOffer: ReweBrowserImportRequest['offers'][number];
}

export function normalizeReweBrowserImportRequest(
  input: ReweBrowserImportRequest,
  now = new Date(),
): ReweBrowserImportNormalizeResult {
  const createdAt = now.toISOString();
  const pageUrl = resolveUrl(input.pageUrl, 'https://www.rewe.de/angebote/nationale-angebote/') ??
    'https://www.rewe.de/angebote/nationale-angebote/';
  const defaultDates = defaultValidity(now);
  const globalValidity = parseGermanDateRange(input.validityLabel, now);

  const rawCount = input.offers.length;
  let skippedNoName = 0;
  let skippedNoPrice = 0;
  let skippedSectionHeadingCount = 0;
  let skippedNonProductCount = 0;
  const skippedSectionHeadings: string[] = [];
  const skippedNonProductExamples: string[] = [];

  // 1) Parse each raw offer into a candidate, dropping the ones with no usable
  //    name/price (each drop counted by REASON, never silently). A "name" that
  //    is only a REWE section heading ("An der Bedientheke", "Tiefkühl") is a
  //    page-chrome label, not an offer — skipped with its own reason so it can
  //    never leak live (the exact bug from the last bookscan). Group remaining
  //    candidates by normalized name so multiple price lines from the SAME card
  //    can be reconciled (action vs base price).
  const groups = new Map<string, ReweCandidate[]>();
  const groupOrder: string[] = [];
  for (const rawOffer of input.offers) {
    const name = cleanText(rawOffer.name);
    const description = cleanText(rawOffer.description);
    const price = parseDecimal(rawOffer.price);
    if (!name) {
      skippedNoName += 1;
      continue;
    }
    if (!price) {
      skippedNoPrice += 1;
      continue;
    }
    // P2/P3: a "name" that carries no product identity is SKIPPED with a concrete
    // reason here — section headings, promo badges, CTA/time-window phrases
    // ("nur noch heute"), property fragments and layout artifacts. They must never
    // become live AND must never reach the food-review bucket (so they are not
    // mistaken for wrongly-filtered groceries). Section keeps its own counter for
    // backward compatibility; the others are summed in skippedNonProductCount.
    const nonProductReason = reweNonProductNameReason(name);
    if (nonProductReason === 'section') {
      skippedSectionHeadingCount += 1;
      skippedSectionHeadings.push(name);
      continue;
    }
    if (nonProductReason) {
      skippedNonProductCount += 1;
      if (skippedNonProductExamples.length < 10) {
        skippedNonProductExamples.push(`${name} [${nonProductReason}]`);
      }
      continue;
    }
    const key = normalizeText(name);
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
      groupOrder.push(key);
    }
    group.push({ name, description, price, rawOffer });
  }
  const skippedCount =
    skippedNoName + skippedNoPrice + skippedSectionHeadingCount + skippedNonProductCount;

  const offers: Offer[] = [];
  const reviewOffers: Offer[] = [];
  const skippedFragments: string[] = [];
  const suspiciousPrices: ReweSuspiciousPrice[] = [];
  const unusualLowPrices: ReweLowPriceCandidate[] = [];
  const duplicateCandidates: string[] = [];
  const categoryCorrections: ReweCategoryCorrection[] = [];
  let duplicateMergedCount = 0;

  for (const key of groupOrder) {
    const group = groups.get(key);
    if (!group || group.length === 0) {
      continue;
    }

    // The big action price wins; smaller prices on the same card are base/part
    // prices and must NOT become the offer price.
    const sortedByPrice = [...group].sort((a, b) => b.price - a.price);
    const winner = sortedByPrice[0];
    const distinctPrices = [...new Set(group.map((entry) => entry.price))];

    if (group.length > 1) {
      duplicateCandidates.push(winner.name);
      duplicateMergedCount += group.length - 1;
    }
    if (distinctPrices.length > 1) {
      const ignoredPrices = distinctPrices
        .filter((value) => value !== winner.price)
        .sort((a, b) => a - b);
      suspiciousPrices.push({ name: winner.name, usedPrice: winner.price, ignoredPrices });
    }
    // Task 5: ungewöhnlich niedriger Einzelpreis (≤ 0,50 €) — meist ein echter
    // REWE-Bonus-/App-Preis. Nicht löschen, sondern transparent als Prüf-
    // Kandidat melden, damit Bonus-Preise im Report sichtbar werden.
    if (winner.price <= REWE_UNUSUAL_LOW_PRICE) {
      unusualLowPrices.push({ name: winner.name, price: winner.price });
    }

    const { name, description, price, rawOffer } = winner;
    const unit = inferUnit(name, description, rawOffer.unit);
    const basePartsFromText = parseBasePriceFromText(
      `${description} ${rawOffer.baseUnit ?? ''} ${rawOffer.basePrice ?? ''}`,
    );
    const basePrice = parseDecimal(rawOffer.basePrice) ?? basePartsFromText.basePrice;
    const baseUnit = cleanText(rawOffer.baseUnit) || basePartsFromText.baseUnit;
    // P6: only a real http(s) product link may become the sourceUrl; a
    // `javascript:;`/`data:`/`blob:` pseudo-link falls back to the REWE page URL
    // so it never lands in the snapshot nor poisons the stable id.
    const sourceUrl = resolveHttpUrl(rawOffer.sourceUrl, pageUrl) ?? pageUrl;
    const validity =
      parseGermanDateRange(rawOffer.validityLabel, now) ??
      globalValidity ??
      defaultDates;

    // Browser import: the section heading came from the structural DOM walk
    // (nearest preceding section), so it is reliable — Tiefkühl is kept (P3).
    const category = resolveReweCategory(rawOffer.category, name, description, true);
    // Record a correction whenever the raw section heading alone would have
    // produced a DIFFERENT (and non-empty) category than the name-first result.
    const rawHeading = cleanText(rawOffer.category);
    if (rawHeading) {
      const headingCategory = toSimpleOfferCategory(rawHeading, '');
      if (headingCategory !== 'Sonstiges' && headingCategory !== category) {
        categoryCorrections.push({ name, from: headingCategory, to: category });
      }
    }

    // Non-product names (section/promo/CTA/property/layout) were already skipped
    // with a reason above (P2), so here only genuine truncated PRODUCT names remain
    // ("Peanut", "Original") — those are held back for review/reconstruction, never
    // deleted. The live feed therefore never carries page-chrome nor fragments.
    const isFragment = isLikelyFragmentName(name);
    const baseTags = ['rewe', 'browser-import'];
    const reviewTags = ['reviewNeeded', 'name_fragment'];
    const offer: Offer = {
      id: stableReweImportId(name, price, unit, sourceUrl),
      name,
      normalizedName: normalizeText(name),
      storeChain: 'REWE',
      category,
      price,
      currency: 'EUR',
      unit,
      basePrice,
      baseUnit,
      validityStart: validity.start,
      validityEnd: validity.end,
      imageUrl: resolveUrl(rawOffer.imageUrl, pageUrl),
      sourceUrl,
      tags: isFragment ? [...baseTags, ...reviewTags] : baseTags,
      createdAt,
      // Roh-Quellsignale (Task 2): die ungekürzte REWE-Sektionsüberschrift und
      // der Produktkontext, bevor `category` name-first neu aufgelöst wurde —
      // hilft der KI/Klassifikation (u. a. internationale Lebensmittel).
      sourceCategoryRaw: cleanText(rawOffer.category) || undefined,
      sourceContextRaw: description || undefined,
    };

    if (isFragment) {
      // A fragment/generic name is held back from the live feed — not deleted.
      reviewOffers.push(offer);
      skippedFragments.push(name);
    } else {
      offers.push(offer);
    }
  }

  // Missing-offer diagnostics for the browser path. The raw payload text came
  // straight from the live REWE page, so it serves as the honest "web text".
  // No static knownOffers are passed: only evidence from THIS payload (fragments,
  // promo anchors, dropped blocks) may flag the import — never a product list.
  const webText = input.offers
    .map((rawOffer) => `${rawOffer.name ?? ''} ${rawOffer.description ?? ''}`)
    .join('\n');
  const missing = buildReweMissingReport({
    webText,
    webChecked: true,
    importedNames: offers.map((offer) => offer.name),
    reviewNames: reviewOffers.map((offer) => offer.name),
  });

  const diagnostics = input.diagnostics;
  const uniqueCards = diagnostics?.uniqueCardCandidates ?? diagnostics?.domPriceCards ?? diagnostics?.cardCandidates;
  const browserRejectedTotal = diagnostics?.rejected
    ? (diagnostics.rejected.noPrice ?? 0) +
      (diagnostics.rejected.noName ?? 0) +
      (diagnostics.rejected.sectionHeading ?? 0) +
      (diagnostics.rejected.extractionError ?? 0)
    : 0;
  const serverSkippedTotalForCompleteness =
    skippedNoName + skippedNoPrice + skippedSectionHeadingCount + skippedNonProductCount;
  const completeness: ReweImportCompleteness = {
    uniqueCardCandidates: uniqueCards,
    imported: offers.length,
    reviewHeldBack: reviewOffers.length,
    explainedRejected: browserRejectedTotal + serverSkippedTotalForCompleteness,
    duplicates: (diagnostics?.browserOfferDuplicates ?? diagnostics?.deduped ?? 0) + duplicateMergedCount,
    unexplainedMissing:
      typeof uniqueCards === 'number'
        ? Math.max(
            0,
            uniqueCards -
              offers.length -
              reviewOffers.length -
              (browserRejectedTotal + serverSkippedTotalForCompleteness) -
              ((diagnostics?.browserOfferDuplicates ?? diagnostics?.deduped ?? 0) + duplicateMergedCount),
          )
        : undefined,
  };

  // Vollständigkeit (Problem 5): eine BALANCIERTE Zählkette gilt NICHT allein
  // wegen uniqueCardCandidates − liveNormalized als unvollständig. Die ehrliche
  // Lücke ist `unexplainedMissing` (0 bei balancierter Kette). Nur ohne
  // Browser-Diagnose fällt es auf die alte Web-Karten-Schätzung zurück.
  const possibleWebMissingEstimate =
    typeof uniqueCards === 'number'
      ? completeness.unexplainedMissing
      : typeof input.webCardCount === 'number' && input.webCardCount > 0
        ? estimateReweWebMissing(input.webCardCount, offers.length)
        : undefined;

  // End-to-end counting chain: stages 0–2 come from the browser diagnostics (DOM
  // cards/candidates/rejections), stages 3–7 are computed server-side. Every drop
  // between the loaded page and the live feed is rechnerisch erklärbar; if any
  // balance equation fails the chain is flagged `balanced: false` and the report
  // health is downgraded (so a silent loss can never read as "ok").
  const browserRejected = diagnostics?.rejected
    ? {
        noPrice: diagnostics.rejected.noPrice ?? 0,
        noName: diagnostics.rejected.noName ?? 0,
        sectionHeading: diagnostics.rejected.sectionHeading ?? 0,
        extractionError: diagnostics.rejected.extractionError ?? 0,
      }
    : undefined;
  const serverSkipped = {
    noName: skippedNoName,
    noPrice: skippedNoPrice,
    sectionHeading: skippedSectionHeadingCount,
    nonProduct: skippedNonProductCount,
  };
  const balanceErrors = computeReweChainBalanceErrors({
    diagnostics,
    browserRejected,
    payloadReceived: rawCount,
    serverSkipped,
    duplicatesMerged: duplicateMergedCount,
    liveNormalized: offers.length,
    reviewHeldBack: reviewOffers.length,
  });
  const countingChain: ReweImportCountingChain = {
    rawPriceMatches: diagnostics?.rawPriceMatches,
    observedCardOccurrences: diagnostics?.observedCardOccurrences,
    uniqueCardCandidates: diagnostics?.uniqueCardCandidates ?? diagnostics?.domPriceCards ?? diagnostics?.cardCandidates,
    repeatedCardObservations: diagnostics?.repeatedCardObservations,
    domPriceCards: diagnostics?.domPriceCards ?? diagnostics?.uniqueCardCandidates ?? diagnostics?.cardCandidates,
    browserRejected,
    browserAcceptedBeforeDedupe: diagnostics?.browserAcceptedBeforeDedupe,
    browserOfferDuplicates: diagnostics?.browserOfferDuplicates ?? diagnostics?.deduped,
    payloadOffers: rawCount,
    serverSkipped,
    serverDuplicatesMerged: duplicateMergedCount,
    duplicatesMerged: duplicateMergedCount,
    liveNormalized: offers.length,
    reviewHeldBack: reviewOffers.length,
    balanced: balanceErrors.length === 0,
    balanceErrors,
  };

  return {
    offers,
    skippedCount,
    reviewOffers,
    report: {
      rawCount,
      normalizedCount: offers.length,
      reviewCount: reviewOffers.length,
      skippedCount,
      skippedNoName,
      skippedNoPrice,
      skippedSectionHeadingCount,
      skippedSectionHeadings,
      skippedNonProductCount,
      skippedNonProductExamples,
      duplicateMergedCount,
      completeness,
      countingChain,
      browserDiagnostics: diagnostics,
      skippedFragments,
      suspiciousPrices,
      unusualLowPrices,
      duplicateCandidates,
      categoryCorrections,
      possibleWebMissingEstimate,
      keywordChecks: missing.keywordChecks,
      missingKnownOffers: missing.missingKnownOffers,
      missingLikelyOffers: missing.missingLikelyOffers,
      fragmentReconstructionNeeded: missing.fragmentReconstructionNeeded,
      falseLiveFragments: missing.falseLiveFragments,
      requiresLayoutFallback: missing.requiresLayoutFallback,
      importHealth: missing.health,
      webVerification: missing.webVerification,
    },
  };
}

/**
 * Verdict on the duplicate share of a REWE import (separate from the raw count):
 *  - `ok`       duplicate share is within the normal range.
 *  - `warning`  a HIGH duplicate share that was fully deduplicated AND proven
 *               benign (balanced/complete counting chain) — lazy/virtualised
 *               render repeats, no card loss. Surfaced, never blocked.
 *  - `blocking` a HIGH duplicate share COUPLED with a real loss/conflict signal
 *               (or with no proof the chain stayed complete) — card assignment
 *               is unsafe, the import is rejected.
 */
export type ReweDuplicateQuality = 'ok' | 'warning' | 'blocking';

export interface ReweImportQualityAssessment {
  health: ReweImportHealth;
  /** True when the import is too broken to be committed into the snapshot. */
  blockCommit: boolean;
  /** Benign-vs-dangerous verdict on the duplicate share (see the type doc). */
  duplicateQuality: ReweDuplicateQuality;
  reasons: string[];
}

/**
 * Hard quality gate over a REWE import report (browser or PDF): fragments that
 * slipped live, a known offer present in the source but not parsed, an empty
 * result, or massively suspicious prices/duplicates make the import unfit for
 * the live snapshot — the caller must reject it instead of committing.
 */
export function assessReweImportQuality(
  report: ReweImportReportData,
): ReweImportQualityAssessment {
  const reasons: string[] = [];
  let blockCommit = false;

  if ((report.falseLiveFragments?.length ?? 0) > 0) {
    blockCommit = true;
    reasons.push(
      `Fragment-Namen im Live-Feed: ${report.falseLiveFragments!.slice(0, 6).join(', ')}.`,
    );
  }
  if (report.normalizedCount === 0) {
    blockCommit = true;
    reasons.push('0 Live-Angebote normalisiert — Import liefert nichts Brauchbares.');
  }
  const parserBrokenOffers = (report.missingKnownOffers ?? []).filter(
    (offer) => offer.status === 'presentInPdfButNotParsed',
  );
  if (parserBrokenOffers.length > 0) {
    blockCommit = true;
    reasons.push(
      `Bekannte Angebote in der Quelle, aber nicht geparst: ${parserBrokenOffers
        .map((offer) => offer.name)
        .join(', ')}.`,
    );
  }
  // Duplicate quality is judged SEPARATELY from the raw duplicate count (live
  // bug 2026-06-22, REWE 190/118/69): the REWE page renders lazily/virtualised,
  // so the bookmarklet re-sees the same card across scroll passes and produces
  // many BENIGN merge duplicates. A high duplicate SHARE alone is therefore NOT
  // a defect — it is only dangerous when COUPLED with a real loss/conflict
  // signal (unbalanced chain, unexplained/web miss, inconsistent diagnostics,
  // conflicting prices, fragments live, unparsed known offers) OR when there is
  // no positive proof the chain stayed complete (e.g. a PDF import with no
  // counting chain — then the old block is preserved).
  let duplicateQuality: ReweDuplicateQuality = 'ok';
  if (report.normalizedCount > 0) {
    if (report.suspiciousPrices.length > report.normalizedCount * 0.5) {
      blockCommit = true;
      reasons.push(
        `${report.suspiciousPrices.length} von ${report.normalizedCount} Angeboten haben verdächtige Preise — Preiszuordnung kaputt.`,
      );
    }
    if (report.duplicateCandidates.length > report.normalizedCount * 0.5) {
      const unexplainedMissingForDupes = report.completeness?.unexplainedMissing ?? 0;
      const dangerousDuplicateSignals: string[] = [];
      if (report.countingChain?.balanced === false) {
        dangerousDuplicateSignals.push('Zählkette unbalanciert');
      }
      if (unexplainedMissingForDupes > 0) {
        dangerousDuplicateSignals.push(`${unexplainedMissingForDupes} Karte(n) ohne erklärten Verbleib`);
      }
      if (report.browserDiagnostics?.consistent === false) {
        dangerousDuplicateSignals.push('Browser-Diagnose inkonsistent');
      }
      if (typeof report.possibleWebMissingEstimate === 'number' && report.possibleWebMissingEstimate > 0) {
        dangerousDuplicateSignals.push(
          `${report.possibleWebMissingEstimate} möglicherweise fehlende Web-Angebote`,
        );
      }
      if ((report.falseLiveFragments?.length ?? 0) > 0) {
        dangerousDuplicateSignals.push('Fragmente im Live-Feed');
      }
      if (report.suspiciousPrices.length > report.normalizedCount * 0.5) {
        dangerousDuplicateSignals.push('viele widersprüchliche Preise');
      }
      if (parserBrokenOffers.length > 0) {
        dangerousDuplicateSignals.push('bekannte Angebote nicht geparst');
      }
      // A high duplicate share is downgraded to a WARNING only with POSITIVE
      // proof of a complete, balanced chain — balanced === true, no unexplained
      // miss, consistent browser diagnostics and a 0 web-miss estimate. Without
      // that proof (or with any dangerous signal) we keep the old safety block.
      const balancedEvidence =
        dangerousDuplicateSignals.length === 0 &&
        report.countingChain?.balanced === true &&
        unexplainedMissingForDupes === 0 &&
        report.browserDiagnostics?.consistent === true &&
        report.possibleWebMissingEstimate === 0;
      if (balancedEvidence) {
        duplicateQuality = 'warning';
        reasons.push(
          `${report.duplicateCandidates.length} Dubletten bei ${report.normalizedCount} Angeboten wurden dedupliziert (Lazy-/Virtual-Rendering), aber die Zählkette ist vollständig und balanciert — kein Kartenverlust.`,
        );
      } else {
        duplicateQuality = 'blocking';
        blockCommit = true;
        reasons.push(
          `${report.duplicateCandidates.length} Dubletten-Kandidaten bei ${report.normalizedCount} Angeboten gekoppelt mit ${
            dangerousDuplicateSignals.length > 0
              ? dangerousDuplicateSignals.join(', ')
              : 'fehlendem Vollständigkeitsnachweis'
          } — Karten-Zuordnung unsicher.`,
        );
      }
    }
  }

  const missingCount = report.missingKnownOffers?.length ?? 0;
  if (!blockCommit && missingCount > 0) {
    reasons.push(
      `${missingCount} bekannte(s) Angebot(e) fehlen im Live-Feed (siehe missingKnownOffers).`,
    );
  }

  // An inconsistent counting chain means a card was lost without an accounted
  // reason — never block the import over it, but report it honestly as warning.
  const chainInconsistent = report.countingChain?.balanced === false;
  if (chainInconsistent) {
    reasons.push(
      `Zählkette inkonsistent (${(report.countingChain?.balanceErrors ?? []).join('; ')}) — möglicher unerklärter Kartenverlust.`,
    );
  }

  // COMPLETENESS vs DATA-QUALITY are judged separately (Problem 5).
  // Completeness: only a real `unexplainedMissing` (a card that vanished without
  // an accounted reason) is an incompleteness — NOT uniqueCardCandidates−live.
  const completeness = report.completeness;
  const unexplainedMissing = completeness?.unexplainedMissing ?? 0;
  const completenessWarning = unexplainedMissing > 0;
  if (completenessWarning) {
    reasons.push(
      `${unexplainedMissing} DOM-Karte(n) ohne erklärten Verbleib (unexplainedMissing) — Vollständigkeit prüfen.`,
    );
  }

  // Data quality: a HIGH share of cards rejected for noName/noPrice is a quality
  // signal (parser/markup drift), reported honestly with counts + examples —
  // never as "N Angebote fehlen".
  const chain = report.countingChain;
  const unique = chain?.uniqueCardCandidates ?? 0;
  const rejectNoNamePrice = (chain?.browserRejected?.noPrice ?? 0) + (chain?.browserRejected?.noName ?? 0);
  const rejectRate = unique > 0 ? rejectNoNamePrice / unique : 0;
  const dataQualityWarning = unique >= 20 && rejectRate > 0.35;
  if (dataQualityWarning) {
    const ex = report.browserDiagnostics?.rejectedExamples;
    const examples = [...(ex?.noName ?? []), ...(ex?.noPrice ?? [])].slice(0, 4);
    reasons.push(
      `Hohe Ablehnungsrate: ${rejectNoNamePrice}/${unique} Karten ohne Name/Preis (${Math.round(
        rejectRate * 100,
      )} %)${examples.length ? ` — z. B. ${examples.join(' | ')}` : ''}.`,
    );
  }

  const health: ReweImportHealth = blockCommit
    ? 'critical'
    : report.importHealth === 'critical'
      ? 'critical'
      : missingCount > 0 ||
          chainInconsistent ||
          completenessWarning ||
          dataQualityWarning ||
          duplicateQuality === 'warning' ||
          report.importHealth === 'warning'
        ? 'warning'
        : 'ok';

  return { health, blockCommit, duplicateQuality, reasons };
}

/**
 * Estimate how many offer cards a REWE web page exposes, by counting visible
 * offer prices and excluding base prices ("1 l = …"), strike-through/UVP prices
 * ("statt …") and REWE-Bonus/Pfand amounts. REWE often 403/captcha-blocks direct
 * scraping and may not put product names in the HTML, so a price-card count is
 * the most robust completeness proxy we can get from whatever HTML is available.
 */
export function countReweWebOfferCards(html: string | undefined): number {
  // Strip HTML tags first so the "/" in closing tags ("</span>") is not mistaken
  // for a per-unit base-price separator ("X / kg").
  const text = String(html ?? '').replace(/<[^>]*>/g, ' ');
  if (!text.trim()) {
    return 0;
  }
  const priceRe = /(\d{1,3})[.,](\d{2})\s*(?:€|&euro;|EUR)/gi;
  let count = 0;
  for (const match of text.matchAll(priceRe)) {
    const index = match.index ?? 0;
    const before = text.slice(Math.max(0, index - 20), index).toLowerCase();
    if (/[=/]|bonus|pfand|statt|uvp|grundpreis/.test(before)) {
      continue;
    }
    count += 1;
  }
  return count;
}

/**
 * Pick the real offer (action) price from a single REWE product card's text.
 *
 * REWE cards interleave the headline price with a base price ("1 l = …"), a
 * deposit ("zzgl. 0,25 € Pfand") and sometimes a strike/UVP price ("statt …").
 * The headline price is tagged with a promo/deal badge (Aktion, Angebot,
 * Knaller, Hammerpreis, Kracher, Top-Angebot, …). We prefer the price right
 * after such a badge; otherwise we fall back to the first price that is NOT a
 * base/deposit/strike price, and — when the card has no badge but reads like a
 * REWE Bonus/App/Coupon tile — refuse to take a loyalty price as a shelf price.
 *
 * Uses the SHARED REWE_PROMO_ANCHOR_PATTERN / REWE_BONUS_COUPON_PATTERN so the
 * PDF parser and this browser path can never drift apart. The bookmarklet embeds
 * those two regexes plus this function verbatim (see the bookmarklet builder).
 */
/**
 * Reassemble a REWE sale price whose EURO and CENT parts live in SEPARATE DOM
 * nodes (P1). The block walker renders such a tile as adjacent lines — "6" / "99"
 * / "€" or a single "6 99 €" — which the one-token price regex
 * (\d{1,3}[,.]\d{2}\s*€) never matches, so a card with a real action price wrongly
 * read as `no_price` (the Senseo/Jacobs/Philadelphia/Dr. Oetker pattern, where
 * only a Grundpreis "1 kg = 22,43 €" stayed on one line and was — correctly —
 * excluded). We only join a BARE euro integer directly followed by a 2-digit cent
 * part WITH currency evidence (a € on either part or a standalone €/EUR line), and
 * NEVER invent a price. A preceding strike/Grundpreis/Pfand/Bonus marker is kept
 * on the SAME line as the joined price so the existing line-local exclusions still
 * drop it — a base price can never become the offer price. Pure + injected into
 * the bookmarklet, so the live walk uses the exact same reassembly.
 */
export function reweReassembleSplitPrices(lines: string[]): string[] {
  // A line that is purely a unit/strike/base/deposit marker — never a euro part.
  const isCtrl = /[=/]|grundpreis|pfand|zzgl|statt|uvp|\bkg\b|\bg\b|\bl\b|\bml\b|\bcl\b|\bstk\b|stück|stueck/i;
  // A base/strike/deposit marker DIRECTLY preceding the price (the marker is the
  // tail of the previous line) — only then is the joined price a non-offer price.
  const markerPrev = /(?:statt|uvp|grundpreis|pfand|zzgl|bonus|coupon|gutschein|payback|app)\s*$/i;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const cur = lines[i];
    // 1) single line "6 99 €" / "€ 6 99" — euro and cents split only by a space.
    const single = cur.match(/^€?\s*(\d{1,3})\s+(\d{2})\s*€?$/);
    if (single && /€/.test(cur) && !isCtrl.test(cur)) {
      out.push(`${single[1]},${single[2]} €`);
      continue;
    }
    // 2) bare euro integer line followed by a 2-digit cent line (+ optional € line).
    const euro = cur.match(/^€?\s*(\d{1,3})$/);
    if (euro && !isCtrl.test(cur)) {
      const next = lines[i + 1] ?? '';
      const cents = next.match(/^(\d{2})\s*€?$/);
      if (cents && !isCtrl.test(next)) {
        const after = (lines[i + 2] ?? '').trim();
        const standaloneCurrency = /^(?:€|eur)$/i.test(after);
        const hasCurrency = /€/.test(cur) || /€/.test(next) || standaloneCurrency;
        if (hasCurrency) {
          const joined = `${euro[1]},${cents[1]} €`;
          const prev = out.length > 0 ? out[out.length - 1] : '';
          if (markerPrev.test(prev)) {
            // Strike/base/deposit context ⇒ glue onto the marker so it is excluded.
            out[out.length - 1] = `${prev} ${joined}`;
          } else {
            out.push(joined);
          }
          i += standaloneCurrency ? 2 : 1;
          continue;
        }
      }
    }
    out.push(cur);
  }
  return out;
}

export function pickReweCardPrice(cardText: string): string {
  const lines = reweReassembleSplitPrices(
    String(cardText ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const text = lines.join('\n');

  const anchorIndex = lines.findIndex((line) => REWE_PROMO_ANCHOR_PATTERN.test(line));
  if (anchorIndex >= 0) {
    for (let index = anchorIndex + 1; index < Math.min(lines.length, anchorIndex + 5); index += 1) {
      const match = lines[index].match(/^(\d{1,3}[,.]\d{2})\s*€?$/);
      if (match) {
        return match[1];
      }
    }
  }

  // Without a badge, a card that reads like a REWE Bonus/App/Coupon tile must not
  // surrender a loyalty price as if it were a normal shelf price.
  const looksLikeBonusTile = anchorIndex < 0 && REWE_BONUS_COUPON_PATTERN.test(text);

  // Base/deposit/strike markers, checked LINE-LOCALLY so a previous line ending
  // in "Pfand" cannot disqualify the real price on the next line.
  const nonOfferBefore = /[=/]|bonus|pfand|zzgl|statt|uvp|grundpreis/i;
  const nonOfferAfter = /pfand|grundpreis/i;
  for (const match of text.matchAll(/(\d{1,3}[,.]\d{2})\s*€/g)) {
    const index = match.index ?? 0;
    const lineStart = text.lastIndexOf('\n', index) + 1;
    const lineEndRaw = text.indexOf('\n', index);
    const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
    const lineLocal = text.slice(lineStart, lineEnd);
    if (nonOfferBefore.test(text.slice(lineStart, index))) {
      continue;
    }
    if (nonOfferAfter.test(text.slice(index, lineEnd))) {
      continue;
    }
    if (REWE_BONUS_COUPON_PATTERN.test(lineLocal) || looksLikeBonusTile) {
      continue;
    }
    return match[1];
  }
  return '';
}

/** Possible missing offers = web card estimate minus what we actually imported. */
export function estimateReweWebMissing(webCardCount: number, liveCount: number): number {
  if (!Number.isFinite(webCardCount) || !Number.isFinite(liveCount)) {
    return 0;
  }
  return Math.max(0, Math.round(webCardCount) - Math.round(liveCount));
}

export function renderReweBrowserImportHtml(): string {
  const bookmarklet = `javascript:(()=>{fetch('http://localhost:8787/api/offers/rewe-browser-import/bookmarklet.js?ts='+Date.now()).then(r=>r.text()).then(code=>(0,eval)(code)).catch(e=>alert('AICheff REWE Import konnte nicht geladen werden: '+e.message));})()`;

  return `<!doctype html>
<html lang="de">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>REWE Browser-Import</title>
    <style>
      :root {
        color: #182028;
        background: #f7f8fb;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 20px; }
      main { width: min(900px, 100%); display: grid; gap: 12px; }
      section {
        border: 1px solid #e3e8f2;
        border-radius: 14px;
        background: #fff;
        padding: 16px;
        display: grid;
        gap: 12px;
        box-shadow: 0 12px 28px rgba(20, 28, 40, 0.06);
      }
      h1, h2, p { margin: 0; }
      h1 { font-size: 1.35rem; }
      h2 { font-size: 1rem; }
      p, li { color: #5d6b7a; line-height: 1.5; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; }
      a, button {
        border: 1px solid #d0d8e6;
        border-radius: 10px;
        padding: 9px 12px;
        color: #182028;
        background: #fff;
        text-decoration: none;
        font: inherit;
        cursor: pointer;
      }
      .primary { background: #d8432f; border-color: #d8432f; color: #fff; font-weight: 700; }
      code, textarea {
        font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
        font-size: 0.82rem;
      }
      textarea {
        width: 100%;
        min-height: 96px;
        border: 1px solid #d0d8e6;
        border-radius: 10px;
        padding: 10px;
        color: #182028;
      }
      .status { min-height: 22px; color: #117d6b; font-weight: 600; }
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>REWE Browser-Import</h1>
        <p>Dieser Import nutzt deinen normalen Browser. Öffne REWE, löse falls nötig Cookie/Captcha/Marktauswahl, und starte dann das Bookmarklet auf der REWE-Angebotsseite.</p>
        <div class="actions">
          <a class="primary" href="https://www.rewe.de/angebote/nationale-angebote/" target="_blank" rel="noreferrer">REWE Angebote öffnen</a>
          <a id="bookmarklet" href="${bookmarklet}">AICheff REWE importieren</a>
          <button id="copy" type="button">Bookmarklet kopieren</button>
          <a href="/">Zurück zum Backend</a>
        </div>
        <p class="status" id="status"></p>
      </section>
      <section>
        <h2>Bookmarklet-Code</h2>
        <textarea readonly id="code">${bookmarklet}</textarea>
      </section>
    </main>
    <script>
      const code = document.getElementById('code');
      const status = document.getElementById('status');
      document.getElementById('copy').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(code.value);
          status.textContent = 'Bookmarklet kopiert.';
        } catch {
          code.select();
          status.textContent = 'Code markieren und kopieren.';
        }
      });
    </script>
  </body>
</html>`;
}

export function createReweBrowserImportBookmarkletScript(): string {
  // The DOM collector is the SAME code the jsdom fixture tests exercise: the
  // shared functions are injected verbatim via .toString() so the live browser
  // walk can never drift from the tested implementation (price picking, section-
  // heading rejection, structural card delimitation, counting chain). Only the
  // env-specific bits (real isVisible, scrolling, expander clicks, fetch, overlay)
  // live here. Helpers are injected in dependency order; each references the
  // others by name, exactly as in the module.
  return `
(async () => {
  const ENDPOINTS = [
    'http://localhost:8787/api/offers/rewe-browser-import',
    'http://127.0.0.1:8787/api/offers/rewe-browser-import',
  ];
  // Function#toString output from tsx/esbuild may retain calls to its internal
  // __name helper. The bookmarklet runs outside the backend bundle, so define
  // the helper before evaluating any serialized function.
  const __name = (target, value) => {
    try {
      Object.defineProperty(target, 'name', { value, configurable: true });
    } catch (error) {
      // Function names are diagnostic only; a frozen function still works.
    }
    return target;
  };
  const REWE_PROMO_ANCHOR_PATTERN = ${REWE_PROMO_ANCHOR_PATTERN.toString()};
  const REWE_BONUS_COUPON_PATTERN = ${REWE_BONUS_COUPON_PATTERN.toString()};
  const REWE_SECTION_VOCAB = new Set(${JSON.stringify([...REWE_SECTION_VOCAB])});
  const REWE_SECTION_CONNECTORS = new Set(${JSON.stringify([...REWE_SECTION_CONNECTORS])});
  const REWE_PROPERTY_LEADERS = ${REWE_PROPERTY_LEADERS.toString()};
  const REWE_PROPERTY_WORDS = new Set(${JSON.stringify([...REWE_PROPERTY_WORDS])});
  const REWE_CTA_VOCAB = new Set(${JSON.stringify([...REWE_CTA_VOCAB])});
  const REWE_CTA_CONNECTORS = new Set(${JSON.stringify([...REWE_CTA_CONNECTORS])});
  const REWE_INLINE_KEEP = new Set(${JSON.stringify([...REWE_INLINE_KEEP])});
  const reweReassembleSplitPrices = ${reweReassembleSplitPrices.toString()};
  const pickReweCardPrice = ${pickReweCardPrice.toString()};
  const isReweSectionHeadingName = ${isReweSectionHeadingName.toString()};
  const isReweCtaPhraseName = ${isReweCtaPhraseName.toString()};
  const reweNonProductNameReason = ${reweNonProductNameReason.toString()};
  const extractReweCardFields = ${extractReweCardFields.toString()};
  const countReweWebOfferCards = ${countReweWebOfferCards.toString()};
  const reweNormalizeLine = ${reweNormalizeLine.toString()};
  const reweDomTextLines = ${reweDomTextLines.toString()};
  const reweSplitElementLines = ${reweSplitElementLines.toString()};
  const reweTextOf = ${reweTextOf.toString()};
  const reweSafeHttpUrl = ${reweSafeHttpUrl.toString()};
  const reweAttributePriceLines = ${reweAttributePriceLines.toString()};
  const reweCountOfferPrices = ${reweCountOfferPrices.toString()};
  const reweCountProductImages = ${reweCountProductImages.toString()};
  const reweParentHasSectionHeadingOutside = ${reweParentHasSectionHeadingOutside.toString()};
  const findReweCardElements = ${findReweCardElements.toString()};
  const reweBrowserBalanceErrors = ${reweBrowserBalanceErrors.toString()};
  const buildReweBrowserDiagnostics = ${buildReweBrowserDiagnostics.toString()};
  const reweFindUnit = ${reweFindUnit.toString()};
  const reweFindCategory = ${reweFindCategory.toString()};
  const reweFindValidityLabel = ${reweFindValidityLabel.toString()};
  const createReweDomCollector = ${createReweDomCollector.toString()};

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = reweNormalizeLine;

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function overlay(message, kind = 'info') {
    let node = document.getElementById('aichef-rewe-import-status');
    if (!node) {
      node = document.createElement('div');
      node.id = 'aichef-rewe-import-status';
      node.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:360px;padding:12px 14px;border-radius:12px;background:#182028;color:#fff;font:14px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 14px 36px rgba(0,0,0,.25)';
      document.body.appendChild(node);
    }
    node.textContent = message;
    node.style.background = kind === 'error' ? '#b72f1d' : kind === 'ok' ? '#117d6b' : '#182028';
  }

  async function postImport(payload) {
    let lastError = null;
    for (const endpoint of ENDPOINTS) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body.error || 'HTTP ' + response.status);
        }
        return body;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Backend nicht erreichbar');
  }

  // Klickt nur die NUTZER-SICHTBAREN Aufklapp-Buttons ("mehr anzeigen", …) — das
  // macht bereits geladene Inhalte sichtbar, kein Schutz-/Captcha-Bypass.
  function clickExpanders() {
    const wanted = /mehr anzeigen|mehr laden|alle anzeigen|weitere angebote|mehr entdecken|mehr angebote|alle angebote/i;
    const buttons = [...document.querySelectorAll('button, a, [role="button"]')].filter((el) => {
      if (!isVisible(el)) return false;
      const label = normalize((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || ''));
      return wanted.test(label);
    });
    for (const el of buttons.slice(0, 25)) {
      try { el.click(); } catch (error) { /* ignore */ }
    }
  }

  // EIN Collector über alle Scroll-Positionen: collect(document) sammelt
  // strukturell, zählt jede Karte (auch wiederholt sichtbare) und dedupt erst
  // danach. So bleiben Lazy-/virtualisierte Karten erhalten und die Zählkette
  // bleibt rechnerisch nachvollziehbar.
  const collector = createReweDomCollector({ isVisible, pageUrl: location.href });

  async function autoLoad() {
    const step = Math.max(500, Math.floor((window.innerHeight || 800) * 0.85));
    let pos = 0;
    let stagnant = 0;
    let lastTotal = 0;
    for (let i = 0; i < 80; i++) {
      collector.collect(document);
      clickExpanders();
      pos += step;
      try { window.scrollTo(0, pos); } catch (error) { /* ignore */ }
      await sleep(320);
      collector.collect(document);
      const max = document.body ? document.body.scrollHeight : pos;
      if (pos >= max) {
        stagnant = collector.offerCount() === lastTotal ? stagnant + 1 : 0;
        lastTotal = collector.offerCount();
        if (stagnant >= 2) break;
      }
    }
    try { window.scrollTo(0, 0); } catch (error) { /* ignore */ }
    await sleep(150);
    collector.collect(document);
  }

  overlay('AICheff lädt alle REWE-Angebote (scrollen)…');
  await autoLoad();

  const finalResult = collector.result();
  const offers = finalResult.offers;
  const diagnostics = finalResult.diagnostics;

  if (offers.length === 0) {
    overlay('Keine sichtbaren REWE-Angebote gefunden. Bitte Angebotsseite öffnen und ggf. Cookies/Captcha/Markt erledigen.', 'error');
    return;
  }

  // rawPriceMatches ist NUR Diagnose (zeigt Über-/Unterzählung der alten
  // Preis-Regex). webCardCount = einzigartige strukturelle Kartenkandidaten.
  let rawPriceMatches = 0;
  try { rawPriceMatches = countReweWebOfferCards(document.documentElement.innerHTML); } catch (error) { /* ignore */ }
  diagnostics.rawPriceMatches = rawPriceMatches;
  const webCardCount = diagnostics.uniqueCardCandidates;

  overlay('AICheff importiert ' + offers.length + ' REWE-Angebot(e)…');
  postImport({
    source: 'rewe-browser',
    pageUrl: location.href,
    validityLabel: reweFindValidityLabel(document),
    importedAt: new Date().toISOString(),
    webCardCount,
    diagnostics,
    offers,
  })
    .then((result) => {
      overlay('REWE Import fertig: ' + result.importedCount + ' übernommen, ' + result.filteredCount + ' gefiltert.', 'ok');
      window.open('http://localhost:8787/', '_blank', 'noopener,noreferrer');
    })
    .catch((error) => {
      overlay('REWE Import fehlgeschlagen: ' + (error && error.message ? error.message : error), 'error');
    });
})();
`;
}
