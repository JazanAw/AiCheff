// IO orchestration for the manual Lidl page-image import: fetches the Lidl
// prospect overview page, runs the existing Lidl connector with OCR/Vision
// explicitly turned ON (the automatic weekly scan never does this — see the
// hardcoded 'off'/'off' at the connector's live call site in
// officialSupermarketConnector.ts), keeps only the newly extracted page-image
// candidates, and resolves a real product photo for each via
// lidlPageOfferImageResolver.ts. One module per import source, mirroring the
// role reweBrowserImport.ts plays for the REWE browser import.

import {
  fetchLidlLeafletOffers,
  fetchOfficialHtml,
  selectOfficialStores,
  type OfficialStoreConfig,
} from '../../src/services/offersIngest/sourceConnectors/officialSupermarketConnector';
import { LIDL_OCR_OFFER_TAG, type LidlOcrMode } from '../../src/services/offersIngest/sourceConnectors/lidlProspectOcr';
import { LIDL_VISION_OFFER_TAG } from '../../src/services/offersIngest/sourceConnectors/lidlVisionProspectImport';
import type { RawOfferCandidate } from '../../src/services/offersIngest/types';
import type { SubSourceDiagnostic } from '../../src/services/offersIngest/subSourceDiagnostics';
import { normalizeChainKey } from './scanV2Scope';
import {
  resolveLidlPageOfferImages,
  type ResolveLidlPageOfferImagesOptions,
  type ResolveLidlPageOfferImagesResult,
} from './lidlPageOfferImageResolver';

export interface RunLidlPageImageImportOptions {
  ocrMode?: LidlOcrMode;
  visionMode?: LidlOcrMode;
  imageLimit?: number;
  /** Injectable for tests; default = the real fetch used by the live connector. */
  fetchStoreHtml?: (store: OfficialStoreConfig) => Promise<string>;
  /** Injectable for tests; default = the real (now-exported) connector function. */
  fetchLidlLeafletOffersImpl?: typeof fetchLidlLeafletOffers;
  /** Injectable for tests (e.g. to simulate a missing Lidl store config);
   *  default = the real connector store list. */
  selectOfficialStoresImpl?: typeof selectOfficialStores;
  imageSearch: ResolveLidlPageOfferImagesOptions;
}

export interface RunLidlPageImageImportResult {
  /** Page-image-scope candidates only — image resolved, tagged. Never includes
   *  the structured `lidl-prospekt` offers (real Lidl CDN photos). */
  offers: RawOfferCandidate[];
  warnings: string[];
  diagnostics: SubSourceDiagnostic[];
  imageStats: ResolveLidlPageOfferImagesResult;
}

function emptyImageStats(): ResolveLidlPageOfferImagesResult {
  return {
    offers: [],
    searched: 0,
    replacedWithSearchImage: 0,
    keptFallbackPageImage: 0,
    searchErrors: 0,
    examples: [],
  };
}

/**
 * Runs the Lidl page-image import end to end. Keeps ONLY the OCR-/Vision-
 * derived candidates — the structured `lidl-prospekt` offers this call also
 * computes (needed internally so OCR/Vision can dedupe against them) are
 * deliberately discarded here; they already work today and are never part of
 * this import's scope.
 */
export async function runLidlPageImageImport(
  options: RunLidlPageImageImportOptions,
): Promise<RunLidlPageImageImportResult> {
  const store = (options.selectOfficialStoresImpl ?? selectOfficialStores)([]).find(
    (candidate) => normalizeChainKey(candidate.storeChain) === 'lidl',
  );
  if (!store) {
    return {
      offers: [],
      warnings: ['Lidl-Store-Konfiguration nicht gefunden.'],
      diagnostics: [],
      imageStats: emptyImageStats(),
    };
  }

  const html = await (options.fetchStoreHtml ?? fetchOfficialHtml)(store);
  const warnings: string[] = [];
  const diagnostics: SubSourceDiagnostic[] = [];

  const allOffers = await (options.fetchLidlLeafletOffersImpl ?? fetchLidlLeafletOffers)(
    html,
    store,
    warnings,
    diagnostics,
    { ocrMode: options.ocrMode, visionMode: options.visionMode, imageLimit: options.imageLimit },
  );

  const pageImageCandidates = allOffers.filter((offer) => {
    const tags = offer.tags ?? [];
    return tags.includes(LIDL_OCR_OFFER_TAG) || tags.includes(LIDL_VISION_OFFER_TAG);
  });

  const imageStats = await resolveLidlPageOfferImages(pageImageCandidates, options.imageSearch);

  return { offers: imageStats.offers, warnings, diagnostics, imageStats };
}
