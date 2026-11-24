// Google Custom Search JSON API client for looking up a real product photo for a
// Lidl page-image offer (see lidlPageOfferImageResolver.ts for how a search
// result becomes an offer's image, lidlPageOfferImport.ts for the full flow).
//
// Deliberately NOT wired into src/config/env.ts / appConfig: that config is
// Vite-prefixed and effectively frontend/mobile-visible, so an API key would
// leak there. Read directly from process.env, the same pattern used for
// SUPABASE_SERVICE_ROLE_KEY elsewhere in backend/src.
//
// Style matches gpuPreflight.ts/ollamaPreflight.ts: pure types, injectable
// fetchImpl, never throws for an expected failure — always a discriminated
// result so the caller can fall back to the flyer-page image without a
// try/catch at the call site.

export interface ImageSearchCandidate {
  url: string;
  contextLink?: string;
  width?: number;
  height?: number;
}

export type ImageSearchResult =
  | { ok: true; candidates: ImageSearchCandidate[] }
  | {
      ok: false;
      reason: 'not_configured' | 'http_error' | 'network_error' | 'empty_response' | 'quota_exceeded';
      message: string;
    };

export interface ImageSearchConfig {
  apiKey: string;
  cx: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Results requested per query (Google caps at 10). Default 5. */
  resultsPerQuery?: number;
}

const GOOGLE_CUSTOM_SEARCH_URL = 'https://customsearch.googleapis.com/customsearch/v1';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RESULTS_PER_QUERY = 5;

export function isGoogleImageSearchConfigured(
  config: Pick<ImageSearchConfig, 'apiKey' | 'cx'> | null | undefined,
): boolean {
  return Boolean(config?.apiKey?.trim() && config?.cx?.trim());
}

/**
 * Builds the plain-text search query for a Lidl page-image offer candidate.
 * Pure + testable: no network, no config. Keeps the query short and
 * product-focused (brand + name + unit, never price/store/marketing copy) so
 * results stay as specific as possible without over-constraining an
 * already-noisy OCR/vision name.
 */
export function buildLidlPageOfferImageQuery(candidate: {
  name: string;
  brand?: string;
  unit?: string;
}): string {
  const parts = [candidate.brand, candidate.name, candidate.unit]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function resolveTimeout(config: Pick<ImageSearchConfig, 'timeoutMs'>): number {
  return config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface GoogleCustomSearchErrorBody {
  error?: { code?: number; message?: string; errors?: Array<{ reason?: string }> };
}

interface GoogleCustomSearchItem {
  link?: string;
  image?: { contextLink?: string; width?: number; height?: number };
}

interface GoogleCustomSearchResponseBody {
  items?: GoogleCustomSearchItem[];
}

/**
 * Search Google Images (Custom Search JSON API, `searchType=image`) for a
 * single plain-text query. Never throws for an expected failure (missing
 * config, HTTP error, timeout, empty result) — always returns a discriminated
 * {@link ImageSearchResult}.
 */
export async function searchProductImage(
  query: string,
  config: ImageSearchConfig,
): Promise<ImageSearchResult> {
  if (!isGoogleImageSearchConfigured(config)) {
    return {
      ok: false,
      reason: 'not_configured',
      message: 'Google Custom Search API-Key/CX nicht konfiguriert.',
    };
  }
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return { ok: false, reason: 'empty_response', message: 'Leere Suchanfrage.' };
  }

  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = resolveTimeout(config);
  const numResults = Math.max(1, Math.min(10, Math.round(config.resultsPerQuery ?? DEFAULT_RESULTS_PER_QUERY)));
  const url = new URL(GOOGLE_CUSTOM_SEARCH_URL);
  url.searchParams.set('key', config.apiKey);
  url.searchParams.set('cx', config.cx);
  url.searchParams.set('searchType', 'image');
  url.searchParams.set('imgType', 'photo');
  url.searchParams.set('safe', 'active');
  url.searchParams.set('num', String(numResults));
  url.searchParams.set('q', trimmedQuery);

  let response: Response;
  try {
    response = await fetchWithTimeout(fetchImpl, url.toString(), timeoutMs);
  } catch {
    return {
      ok: false,
      reason: 'network_error',
      message: `Bildsuche für "${trimmedQuery}" fehlgeschlagen (Netzwerk/Timeout).`,
    };
  }

  if (!response.ok) {
    let body: GoogleCustomSearchErrorBody | null = null;
    try {
      body = (await response.json()) as GoogleCustomSearchErrorBody;
    } catch {
      body = null;
    }
    const reasons = body?.error?.errors?.map((entry) => entry.reason ?? '') ?? [];
    if (reasons.some((reason) => reason === 'rateLimitExceeded' || reason === 'dailyLimitExceeded')) {
      return {
        ok: false,
        reason: 'quota_exceeded',
        message: `Google Custom Search Kontingent erschöpft (HTTP ${response.status}).`,
      };
    }
    return {
      ok: false,
      reason: 'http_error',
      message: `Google Custom Search antwortete mit HTTP ${response.status}${
        body?.error?.message ? `: ${body.error.message}` : ''
      }.`,
    };
  }

  let payload: GoogleCustomSearchResponseBody;
  try {
    payload = (await response.json()) as GoogleCustomSearchResponseBody;
  } catch {
    return { ok: false, reason: 'empty_response', message: 'Google Custom Search lieferte kein gültiges JSON.' };
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  const candidates: ImageSearchCandidate[] = items
    .map((item): ImageSearchCandidate | null => {
      const link = typeof item.link === 'string' ? item.link.trim() : '';
      if (!link) return null;
      return {
        url: link,
        contextLink: typeof item.image?.contextLink === 'string' ? item.image.contextLink : undefined,
        width: typeof item.image?.width === 'number' ? item.image.width : undefined,
        height: typeof item.image?.height === 'number' ? item.image.height : undefined,
      };
    })
    .filter((candidate): candidate is ImageSearchCandidate => candidate !== null);

  if (candidates.length === 0) {
    return { ok: false, reason: 'empty_response', message: `Keine Bildtreffer für "${trimmedQuery}".` };
  }

  return { ok: true, candidates };
}

/**
 * Reads the Google Custom Search credentials from `process.env`. Returns
 * `null` (never throws) when either var is missing — callers treat `null` as
 * "feature not configured", not an error; the flyer-page image stays as an
 * honest fallback.
 */
export function resolveImageSearchConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Pick<ImageSearchConfig, 'apiKey' | 'cx'> | null {
  const apiKey = String(env.GOOGLE_CUSTOM_SEARCH_API_KEY ?? '').trim();
  const cx = String(env.GOOGLE_CUSTOM_SEARCH_CX ?? '').trim();
  if (!apiKey || !cx) return null;
  return { apiKey, cx };
}
