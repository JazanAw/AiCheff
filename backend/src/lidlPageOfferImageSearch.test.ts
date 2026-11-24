import { describe, expect, it, vi } from 'vitest';
import {
  buildLidlPageOfferImageQuery,
  isGoogleImageSearchConfigured,
  resolveImageSearchConfigFromEnv,
  searchProductImage,
} from './lidlPageOfferImageSearch';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('isGoogleImageSearchConfigured', () => {
  it('is true when both apiKey and cx are non-empty', () => {
    expect(isGoogleImageSearchConfigured({ apiKey: 'k', cx: 'c' })).toBe(true);
  });
  it('is false when apiKey is missing', () => {
    expect(isGoogleImageSearchConfigured({ apiKey: '', cx: 'c' })).toBe(false);
  });
  it('is false when cx is missing', () => {
    expect(isGoogleImageSearchConfigured({ apiKey: 'k', cx: '' })).toBe(false);
  });
  it('is false for null/undefined', () => {
    expect(isGoogleImageSearchConfigured(null)).toBe(false);
    expect(isGoogleImageSearchConfigured(undefined)).toBe(false);
  });
});

describe('buildLidlPageOfferImageQuery', () => {
  it('joins brand, name, unit with single spaces', () => {
    expect(buildLidlPageOfferImageQuery({ name: 'Erdbeeren', brand: 'REWE Beste Wahl', unit: '500g' })).toBe(
      'REWE Beste Wahl Erdbeeren 500g',
    );
  });
  it('omits missing fields without leaving extra whitespace', () => {
    expect(buildLidlPageOfferImageQuery({ name: 'Bananen' })).toBe('Bananen');
  });
  it('collapses internal whitespace', () => {
    expect(buildLidlPageOfferImageQuery({ name: '  Bio   Milch  ' })).toBe('Bio Milch');
  });
});

describe('searchProductImage', () => {
  const config = { apiKey: 'key123', cx: 'cx456' };

  it('returns not_configured when apiKey/cx are missing', async () => {
    const fetchImpl = vi.fn();
    const result = await searchProductImage('Erdbeeren', {
      apiKey: '',
      cx: '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_configured');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns empty_response for a blank query without calling fetch', async () => {
    const fetchImpl = vi.fn();
    const result = await searchProductImage('   ', { ...config, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('empty_response');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('builds the request URL with searchType=image, imgType=photo, safe=active', async () => {
    let capturedUrl = '';
    const fetchImpl = vi.fn(async (url: string) => {
      capturedUrl = url;
      return jsonResponse({ items: [{ link: 'https://example.com/a.jpg' }] });
    }) as unknown as typeof fetch;
    await searchProductImage('Bio Erdbeeren 500g', { ...config, fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.origin + parsed.pathname).toBe('https://customsearch.googleapis.com/customsearch/v1');
    expect(parsed.searchParams.get('key')).toBe('key123');
    expect(parsed.searchParams.get('cx')).toBe('cx456');
    expect(parsed.searchParams.get('searchType')).toBe('image');
    expect(parsed.searchParams.get('imgType')).toBe('photo');
    expect(parsed.searchParams.get('safe')).toBe('active');
    expect(parsed.searchParams.get('q')).toBe('Bio Erdbeeren 500g');
  });

  it('parses items[] into candidates on success', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        items: [
          { link: 'https://example.com/a.jpg', image: { contextLink: 'https://example.com/a', width: 800, height: 600 } },
          { link: 'https://example.com/b.jpg' },
        ],
      }),
    ) as unknown as typeof fetch;
    const result = await searchProductImage('Erdbeeren', { ...config, fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[0]).toEqual({
        url: 'https://example.com/a.jpg',
        contextLink: 'https://example.com/a',
        width: 800,
        height: 600,
      });
      expect(result.candidates[1].url).toBe('https://example.com/b.jpg');
    }
  });

  it('returns empty_response when items is missing/empty', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const result = await searchProductImage('Erdbeeren', { ...config, fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('empty_response');
  });

  it('returns quota_exceeded when Google reports rateLimitExceeded/dailyLimitExceeded', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: { code: 429, message: 'Quota exceeded', errors: [{ reason: 'dailyLimitExceeded' }] } },
        false,
        429,
      ),
    ) as unknown as typeof fetch;
    const result = await searchProductImage('Erdbeeren', { ...config, fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('quota_exceeded');
  });

  it('returns http_error for other non-2xx responses', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'Bad Request' } }, false, 400)) as unknown as typeof fetch;
    const result = await searchProductImage('Erdbeeren', { ...config, fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('http_error');
  });

  it('returns network_error when fetch throws (incl. timeout/abort)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ETIMEDOUT');
    }) as unknown as typeof fetch;
    const result = await searchProductImage('Erdbeeren', { ...config, fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('network_error');
  });
});

describe('resolveImageSearchConfigFromEnv', () => {
  it('returns null when either var is missing', () => {
    expect(resolveImageSearchConfigFromEnv({ GOOGLE_CUSTOM_SEARCH_API_KEY: 'k' } as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveImageSearchConfigFromEnv({ GOOGLE_CUSTOM_SEARCH_CX: 'c' } as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveImageSearchConfigFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('returns trimmed apiKey/cx when both are present', () => {
    const result = resolveImageSearchConfigFromEnv({
      GOOGLE_CUSTOM_SEARCH_API_KEY: '  key123  ',
      GOOGLE_CUSTOM_SEARCH_CX: '  cx456  ',
    } as NodeJS.ProcessEnv);
    expect(result).toEqual({ apiKey: 'key123', cx: 'cx456' });
  });
});
