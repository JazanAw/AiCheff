import { describe, expect, it, vi } from 'vitest';
import type { RawOfferCandidate } from '../../src/services/offersIngest/types';
import {
  IMAGE_FALLBACK_PAGE_IMAGE_TAG,
  IMAGE_WEB_SEARCH_TAG,
  resolveLidlPageOfferImages,
} from './lidlPageOfferImageResolver';
import { LIDL_PAGE_IMAGE_SCOPE_TAG } from './lidlPageImageOfferScope';
import type { ProbeImageOptions } from './offersScanV2';

function candidate(name: string, imageUrl = 'https://leaflets.schwarz/page-12.jpg'): RawOfferCandidate {
  return { name, storeChain: 'Lidl', price: 1.99, imageUrl, tags: ['lidl-prospekt-ocr'] };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

const okProbe = async () => ({ httpStatus: 200, contentType: 'image/jpeg' });
const brokenProbe = async () => ({ httpStatus: 404, contentType: null });

describe('resolveLidlPageOfferImages', () => {
  it('keeps the flyer-page image and tags fallback when search is not configured', async () => {
    const result = await resolveLidlPageOfferImages([candidate('Erdbeeren')], {
      searchConfig: null,
      probeImpl: okProbe as unknown as (url: string, options?: ProbeImageOptions) => ReturnType<typeof okProbe>,
    });
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].imageUrl).toBe('https://leaflets.schwarz/page-12.jpg');
    expect(result.offers[0].tags).toEqual(
      expect.arrayContaining([LIDL_PAGE_IMAGE_SCOPE_TAG, IMAGE_FALLBACK_PAGE_IMAGE_TAG]),
    );
    expect(result.searched).toBe(0);
    expect(result.keptFallbackPageImage).toBe(1);
    expect(result.replacedWithSearchImage).toBe(0);
  });

  it('replaces the image when the first search candidate probes ok', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ items: [{ link: 'https://real-photo.example/a.jpg' }] }),
    ) as unknown as typeof fetch;
    const result = await resolveLidlPageOfferImages([candidate('Erdbeeren')], {
      searchConfig: { apiKey: 'k', cx: 'c', fetchImpl },
      probeImpl: okProbe as unknown as (url: string, options?: ProbeImageOptions) => ReturnType<typeof okProbe>,
    });
    expect(result.offers[0].imageUrl).toBe('https://real-photo.example/a.jpg');
    expect(result.offers[0].tags).toEqual(expect.arrayContaining([LIDL_PAGE_IMAGE_SCOPE_TAG, IMAGE_WEB_SEARCH_TAG]));
    expect(result.replacedWithSearchImage).toBe(1);
    expect(result.searched).toBe(1);
  });

  it('falls through to the second candidate when the first fails the probe', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        items: [{ link: 'https://broken.example/a.jpg' }, { link: 'https://ok.example/b.jpg' }],
      }),
    ) as unknown as typeof fetch;
    let call = 0;
    const probeImpl = vi.fn(async () => {
      call += 1;
      return call === 1 ? brokenProbe() : okProbe();
    }) as unknown as (url: string, options?: ProbeImageOptions) => ReturnType<typeof okProbe>;
    const result = await resolveLidlPageOfferImages([candidate('Bananen')], {
      searchConfig: { apiKey: 'k', cx: 'c', fetchImpl },
      probeImpl,
    });
    expect(result.offers[0].imageUrl).toBe('https://ok.example/b.jpg');
    expect(result.replacedWithSearchImage).toBe(1);
  });

  it('keeps the fallback image and counts a search error when the search itself fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const result = await resolveLidlPageOfferImages([candidate('Milch')], {
      searchConfig: { apiKey: 'k', cx: 'c', fetchImpl },
      probeImpl: okProbe as unknown as (url: string, options?: ProbeImageOptions) => ReturnType<typeof okProbe>,
    });
    expect(result.offers[0].imageUrl).toBe('https://leaflets.schwarz/page-12.jpg');
    expect(result.offers[0].tags).toContain(IMAGE_FALLBACK_PAGE_IMAGE_TAG);
    expect(result.searchErrors).toBe(1);
    expect(result.keptFallbackPageImage).toBe(1);
  });

  it('keeps the fallback image (no search error) when every returned candidate fails the probe', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ items: [{ link: 'https://broken1.example/a.jpg' }, { link: 'https://broken2.example/b.jpg' }] }),
    ) as unknown as typeof fetch;
    const result = await resolveLidlPageOfferImages([candidate('Kaese')], {
      searchConfig: { apiKey: 'k', cx: 'c', fetchImpl },
      probeImpl: brokenProbe as unknown as (url: string, options?: ProbeImageOptions) => ReturnType<typeof okProbe>,
    });
    expect(result.offers[0].imageUrl).toBe('https://leaflets.schwarz/page-12.jpg');
    expect(result.offers[0].tags).toContain(IMAGE_FALLBACK_PAGE_IMAGE_TAG);
    expect(result.searchErrors).toBe(0);
    expect(result.keptFallbackPageImage).toBe(1);
  });

  it('every offer keeps the page-image scope tag regardless of outcome', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ items: [{ link: 'https://real-photo.example/a.jpg' }] }),
    ) as unknown as typeof fetch;
    const result = await resolveLidlPageOfferImages([candidate('A'), candidate('B')], {
      searchConfig: { apiKey: 'k', cx: 'c', fetchImpl },
      probeImpl: okProbe as unknown as (url: string, options?: ProbeImageOptions) => ReturnType<typeof okProbe>,
    });
    expect(result.offers.every((o) => (o.tags ?? []).includes(LIDL_PAGE_IMAGE_SCOPE_TAG))).toBe(true);
  });

  it('processes every candidate exactly once under bounded concurrency', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ items: [{ link: 'https://real-photo.example/a.jpg' }] }),
    ) as unknown as typeof fetch;
    const candidates = Array.from({ length: 10 }, (_, i) => candidate(`Produkt ${i}`));
    const result = await resolveLidlPageOfferImages(candidates, {
      searchConfig: { apiKey: 'k', cx: 'c', fetchImpl },
      probeImpl: okProbe as unknown as (url: string, options?: ProbeImageOptions) => ReturnType<typeof okProbe>,
      concurrency: 3,
    });
    expect(result.offers).toHaveLength(10);
    expect(result.offers.map((o) => o.name).sort()).toEqual(candidates.map((c) => c.name).sort());
    expect(result.replacedWithSearchImage).toBe(10);
  });

  it('handles an empty candidate list', async () => {
    const result = await resolveLidlPageOfferImages([], { searchConfig: null });
    expect(result.offers).toEqual([]);
    expect(result.searched).toBe(0);
  });
});
