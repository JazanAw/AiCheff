// Scope helpers for the Lidl page-image manual import (lidlPageOfferImport.ts).
// Mirrors reweBrowserImport.ts's isReweBrowserScopeOffer/replaceReweScopeOffers
// pattern exactly: one tag identifies "this import's own offers", so a re-run
// can atomically replace ONLY its own prior output while every other offer —
// including Lidl's already-working structured `lidl-prospekt` offers with real
// Lidl CDN photos — is kept verbatim and in order.

import type { Offer } from '../../src/types/models';
import { normalizeChainKey } from './scanV2Scope';

/** Tag applied to EVERY Lidl page-image offer by lidlPageOfferImageResolver.ts,
 *  in addition to the extractor's own tag (LIDL_OCR_OFFER_TAG / LIDL_VISION_OFFER_TAG
 *  from lidlProspectOcr.ts / lidlVisionProspectImport.ts). One tag to scope-check
 *  against regardless of which extractor produced the candidate. */
export const LIDL_PAGE_IMAGE_SCOPE_TAG = 'lidl-prospekt-bildseite';

/**
 * Does this offer belong to the Lidl page-image manual-import scope? Only Lidl
 * offers carrying {@link LIDL_PAGE_IMAGE_SCOPE_TAG} — the already-working
 * structured `lidl-prospekt` offers (real Lidl CDN photos, mostly
 * Wein/Spirituosen/Non-Food) are NEVER in this scope and must never be touched
 * by a re-run of this import.
 */
export function isLidlPageImageScopeOffer(offer: Pick<Offer, 'storeChain' | 'tags'>): boolean {
  if (normalizeChainKey(offer.storeChain) !== 'lidl') {
    return false;
  }
  const tags = Array.isArray(offer.tags) ? offer.tags : [];
  return tags.includes(LIDL_PAGE_IMAGE_SCOPE_TAG);
}

export interface LidlPageImageScopeBuckets {
  current: Offer[];
  nextWeek: Offer[];
  filtered: Offer[];
}

export interface LidlPageImageScopeReplacementResult extends LidlPageImageScopeBuckets {
  replacedPreviousCount: { current: number; nextWeek: number; filtered: number; total: number };
}

/**
 * Atomically replace the Lidl page-image scope: every previous
 * `lidl-prospekt-bildseite` offer is dropped from each bucket and the freshly
 * resolved ones take their place. Every other offer (incl. Lidl's structured
 * offers and every other store) is kept verbatim and in order. Pure — no
 * snapshot mutation — so the caller decides when/if to persist the result.
 */
export function replaceLidlPageImageScopeOffers(
  previous: LidlPageImageScopeBuckets,
  incoming: LidlPageImageScopeBuckets,
): LidlPageImageScopeReplacementResult {
  const replacedPreviousCount = {
    current: previous.current.filter(isLidlPageImageScopeOffer).length,
    nextWeek: previous.nextWeek.filter(isLidlPageImageScopeOffer).length,
    filtered: previous.filtered.filter(isLidlPageImageScopeOffer).length,
    total: 0,
  };
  replacedPreviousCount.total =
    replacedPreviousCount.current + replacedPreviousCount.nextWeek + replacedPreviousCount.filtered;

  return {
    current: [...previous.current.filter((offer) => !isLidlPageImageScopeOffer(offer)), ...incoming.current],
    nextWeek: [...previous.nextWeek.filter((offer) => !isLidlPageImageScopeOffer(offer)), ...incoming.nextWeek],
    filtered: [...previous.filtered.filter((offer) => !isLidlPageImageScopeOffer(offer)), ...incoming.filtered],
    replacedPreviousCount,
  };
}
