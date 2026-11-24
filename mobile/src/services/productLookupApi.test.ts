import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupProductByBarcode } from './productLookupApi';

interface MockFetchOptions {
  status?: number;
  body?: unknown;
  reject?: Error;
}

function installMockFetch(options: MockFetchOptions): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    if (options.reject) throw options.reject;
    return {
      ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
      status: options.status ?? 200,
      json: async () => options.body,
    } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('lookupProductByBarcode', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects an empty barcode synchronously', async () => {
    installMockFetch({ status: 200, body: { status: 1, product: {} } });
    await expect(lookupProductByBarcode('   ')).rejects.toThrow(/barcode is required/);
  });

  it('returns null when OFF reports status: 0', async () => {
    installMockFetch({
      status: 200,
      body: { status: 0, status_verbose: 'product not found' },
    });
    expect(await lookupProductByBarcode('0000000000000')).toBeNull();
  });

  it('returns null on HTTP 404', async () => {
    installMockFetch({ status: 404, body: null });
    expect(await lookupProductByBarcode('1234567890123')).toBeNull();
  });

  it('throws on HTTP 5xx', async () => {
    installMockFetch({ status: 500, body: 'oops' });
    await expect(lookupProductByBarcode('1234567890123')).rejects.toThrow(/HTTP 500/);
  });

  it('throws when fetch itself fails (network/timeout)', async () => {
    installMockFetch({ reject: new Error('network down') });
    await expect(lookupProductByBarcode('1234567890123')).rejects.toThrow(
      /Open Food Facts request failed: network down/,
    );
  });

  it('prefers the requested locale for product name (tr → de fallback)', async () => {
    installMockFetch({
      status: 200,
      body: {
        status: 1,
        product: {
          code: '1234567890123',
          product_name: 'Generic Pasta',
          product_name_de: 'Spaghetti',
          product_name_en: 'Spaghetti',
          // no product_name_tr → expect de fallback
        },
      },
    });
    const result = await lookupProductByBarcode('1234567890123', 'tr');
    expect(result?.productName).toBe('Spaghetti');
  });

  it('falls back to en when neither requested locale nor de is present', async () => {
    installMockFetch({
      status: 200,
      body: {
        status: 1,
        product: {
          code: '1234567890123',
          product_name: 'Generic Pasta',
          product_name_en: 'Spaghetti EN',
        },
      },
    });
    const result = await lookupProductByBarcode('1234567890123', 'tr');
    expect(result?.productName).toBe('Spaghetti EN');
  });

  it('falls back to the unlocalized product_name as last resort', async () => {
    installMockFetch({
      status: 200,
      body: {
        status: 1,
        product: {
          code: '1234567890123',
          product_name: 'Plain Pasta',
        },
      },
    });
    const result = await lookupProductByBarcode('1234567890123', 'tr');
    expect(result?.productName).toBe('Plain Pasta');
  });

  it('maps brand, image, category and nutriments', async () => {
    installMockFetch({
      status: 200,
      body: {
        status: 1,
        product: {
          code: '1234567890123',
          product_name_de: 'Spaghetti N. 5',
          brands: 'Barilla, Mulino Bianco',
          categories: 'Plant-based foods, Cereals, Pasta',
          categories_tags: ['en:plant-based-foods', 'en:cereals', 'en:pasta'],
          image_url: 'https://example.test/spaghetti.jpg',
          image_front_url: 'https://example.test/spaghetti-front.jpg',
          nutriments: {
            'energy-kcal_100g': 350,
            proteins_100g: 12,
            carbohydrates_100g: 70,
            fat_100g: 1.5,
            sugars_100g: '3.2',
            salt_100g: 0.01,
          },
        },
      },
    });
    const result = await lookupProductByBarcode('1234567890123', 'de');
    expect(result).not.toBeNull();
    expect(result?.brand).toBe('Barilla');
    expect(result?.imageUrl).toBe('https://example.test/spaghetti-front.jpg');
    expect(result?.category).toBe('pasta');
    expect(result?.nutrition).toEqual({
      calories: 350,
      protein: 12,
      carbs: 70,
      fat: 1.5,
      sugar: 3.2,
      salt: 0.01,
    });
  });

  it('returns undefined nutrition when all nutriments are missing/empty', async () => {
    installMockFetch({
      status: 200,
      body: {
        status: 1,
        product: {
          code: '1234567890123',
          product_name: 'Sparkling Water',
          nutriments: {
            'energy-kcal_100g': '',
            proteins_100g: undefined,
          },
        },
      },
    });
    const result = await lookupProductByBarcode('1234567890123');
    expect(result?.nutrition).toBeUndefined();
  });

  it('splits ingredients_text on commas + semicolons', async () => {
    installMockFetch({
      status: 200,
      body: {
        status: 1,
        product: {
          code: '1234567890123',
          ingredients_text_de: 'Weizenmehl, Wasser; Salz, (Hefe), Zucker.',
        },
      },
    });
    const result = await lookupProductByBarcode('1234567890123', 'de');
    expect(result?.ingredientsText).toEqual([
      'Weizenmehl',
      'Wasser',
      'Salz',
      'Hefe',
      'Zucker.',
    ]);
  });

  it('omits ingredientsText when OFF has no ingredients_text*', async () => {
    installMockFetch({
      status: 200,
      body: {
        status: 1,
        product: { code: '1234567890123', product_name_de: 'Water' },
      },
    });
    const result = await lookupProductByBarcode('1234567890123', 'de');
    expect(result?.ingredientsText).toBeUndefined();
  });

  it('keeps rawProductPayload small (whitelist only)', async () => {
    installMockFetch({
      status: 200,
      body: {
        status: 1,
        product: {
          code: '1234567890123',
          product_name: 'Pasta',
          product_name_de: 'Nudeln',
          brands: 'Barilla',
          categories: 'Pasta',
          categories_tags: ['en:pasta'],
          selected_images: { front: { display: { de: 'd', en: 'e' } } },
          // Fields below should not survive into rawProductPayload.
          big_blob: 'x'.repeat(10000),
          nutriments: { 'energy-kcal_100g': 1 },
          ingredients_text: 'foo',
        },
      },
    });
    const result = await lookupProductByBarcode('1234567890123');
    const raw = result?.rawProductPayload as Record<string, unknown>;
    expect(raw).toBeDefined();
    expect(Object.keys(raw).sort()).toEqual([
      'brands',
      'categories',
      'categories_tags',
      'code',
      'product_name',
      'product_name_de',
      'product_name_en',
      'selected_images',
    ]);
    expect(raw.big_blob).toBeUndefined();
    expect(raw.nutriments).toBeUndefined();
  });

  it('preserves the barcode the caller supplied (incl. leading zero)', async () => {
    installMockFetch({
      status: 200,
      body: { status: 1, product: { code: '01234567' } },
    });
    const result = await lookupProductByBarcode('01234567');
    expect(result?.barcode).toBe('01234567');
  });

  it('sets a User-Agent on the OFF request (OFF ToS)', async () => {
    const fetchMock = installMockFetch({
      status: 200,
      body: { status: 1, product: { code: '1234567890123' } },
    });
    await lookupProductByBarcode('1234567890123');
    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.['User-Agent']).toMatch(/Cheffity/);
  });
});
