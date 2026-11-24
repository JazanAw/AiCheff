// Post-processing pass over OCR-/Vision-derived Lidl page-image candidates
// (lidlPageOfferImport.ts): looks up a real product photo via Google Custom
// Search and replaces the flyer-page image with it. lidlProspectOcr.ts /
// lidlVisionProspectImport.ts always set a candidate's imageUrl to the WHOLE
// flyer page image (shared across every product found on that page, never a
// per-product crop) — this module is a distinct pass over the returned
// RawOfferCandidate[], not a change to either extractor.
//
// Never drops a candidate and never fabricates a URL: when the search isn't
// configured, finds nothing, or every candidate image fails the reachability
// probe, the original page image is kept as an honest fallback and tagged as
// such — worst case is exactly what the codebase already accepted as valid
// before this feature existed.

import type { RawOfferCandidate } from '../../src/services/offersIngest/types';
import { classifyImageProbe, probeImageUrl } from './offersScanV2';
import {
  buildLidlPageOfferImageQuery,
  isGoogleImageSearchConfigured,
  searchProductImage,
  type ImageSearchConfig,
} from './lidlPageOfferImageSearch';
import { LIDL_PAGE_IMAGE_SCOPE_TAG } from './lidlPageImageOfferScope';

/** Tag: the image now shown is a Google-Bildsuche result, not the flyer page. */
export const IMAGE_WEB_SEARCH_TAG = 'image-web-search';
/** Tag: no usable web-search image was found — the flyer-page image was kept. */
export const IMAGE_FALLBACK_PAGE_IMAGE_TAG = 'image-fallback-page-image';

export interface ResolveLidlPageOfferImagesOptions {
  /** `null` = feature not configured (no API key/cx) — resolver no-ops
   *  honestly: every offer keeps its flyer-page image, tagged as fallback. */
  searchConfig: ImageSearchConfig | null;
  /** Injectable for tests; default = the real, source-agnostic prober from
   *  offersScanV2.ts (already used to validate every other store's images). */
  probeImpl?: typeof probeImageUrl;
  /** Max simultaneous candidates in flight. Default 4 (Google-CSE-quota-friendly,
   *  deliberately lower than checkOffersImages' default 8). */
  concurrency?: number;
  timeoutMs?: number;
}

export interface ResolveLidlPageOfferImagesExample {
  name: string;
  before: string | undefined;
  after: string | undefined;
  outcome: 'replaced' | 'fallback' | 'search_error';
}

export interface ResolveLidlPageOfferImagesResult {
  offers: RawOfferCandidate[];
  searched: number;
  replacedWithSearchImage: number;
  keptFallbackPageImage: number;
  searchErrors: number;
  examples: ResolveLidlPageOfferImagesExample[];
}

const MAX_EXAMPLES = 20;

function withFallbackTags(candidate: RawOfferCandidate): RawOfferCandidate {
  const baseTags = Array.isArray(candidate.tags) ? candidate.tags : [];
  return { ...candidate, tags: [...baseTags, LIDL_PAGE_IMAGE_SCOPE_TAG, IMAGE_FALLBACK_PAGE_IMAGE_TAG] };
}

/**
 * Resolve a real product photo for every candidate, falling back to the
 * flyer-page image whenever the search isn't configured, finds nothing, or
 * every returned image fails the reachability probe. Bounded-concurrency
 * worker pool, same shape as `checkOffersImages` in offersScanV2.ts.
 */
export async function resolveLidlPageOfferImages(
  candidates: readonly RawOfferCandidate[],
  options: ResolveLidlPageOfferImagesOptions,
): Promise<ResolveLidlPageOfferImagesResult> {
  const probe = options.probeImpl ?? probeImageUrl;
  const timeoutMs = options.timeoutMs;
  const concurrency = Math.max(1, Math.min(16, Math.round(options.concurrency ?? 4)));
  const searchConfig = options.searchConfig;
  const configured = isGoogleImageSearchConfigured(searchConfig);

  const results = new Array<RawOfferCandidate>(candidates.length);
  let searched = 0;
  let replacedWithSearchImage = 0;
  let keptFallbackPageImage = 0;
  let searchErrors = 0;
  const examples: ResolveLidlPageOfferImagesExample[] = [];

  const recordExample = (
    name: string,
    before: string | undefined,
    after: string | undefined,
    outcome: ResolveLidlPageOfferImagesExample['outcome'],
  ): void => {
    if (examples.length < MAX_EXAMPLES) {
      examples.push({ name, before, after, outcome });
    }
  };

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < candidates.length) {
      const index = cursor;
      cursor += 1;
      const candidate = candidates[index];

      if (!configured || !searchConfig) {
        keptFallbackPageImage += 1;
        results[index] = withFallbackTags(candidate);
        continue;
      }

      searched += 1;
      const query = buildLidlPageOfferImageQuery(candidate);
      const searchResult = query
        ? await searchProductImage(query, { ...searchConfig, timeoutMs })
        : ({ ok: false, reason: 'empty_response', message: 'Kein Produktname für Suchanfrage.' } as const);

      if (!searchResult.ok) {
        searchErrors += 1;
        keptFallbackPageImage += 1;
        recordExample(candidate.name, candidate.imageUrl, candidate.imageUrl, 'fallback');
        results[index] = withFallbackTags(candidate);
        continue;
      }

      let accepted: string | null = null;
      for (const imageCandidate of searchResult.candidates) {
        const probed = await probe(imageCandidate.url, { timeoutMs });
        const verdict = classifyImageProbe({
          url: imageCandidate.url,
          httpStatus: probed.httpStatus,
          contentType: probed.contentType,
        });
        if (verdict === 'ok') {
          accepted = imageCandidate.url;
          break;
        }
      }

      if (accepted) {
        replacedWithSearchImage += 1;
        recordExample(candidate.name, candidate.imageUrl, accepted, 'replaced');
        const baseTags = Array.isArray(candidate.tags) ? candidate.tags : [];
        results[index] = {
          ...candidate,
          imageUrl: accepted,
          tags: [...baseTags, LIDL_PAGE_IMAGE_SCOPE_TAG, IMAGE_WEB_SEARCH_TAG],
        };
      } else {
        keptFallbackPageImage += 1;
        recordExample(candidate.name, candidate.imageUrl, candidate.imageUrl, 'fallback');
        results[index] = withFallbackTags(candidate);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()));

  return {
    offers: results,
    searched,
    replacedWithSearchImage,
    keptFallbackPageImage,
    searchErrors,
    examples,
  };
}
