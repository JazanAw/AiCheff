import { describe, expect, it } from 'vitest';
import {
  aggregateTopStoreNames,
  buildSourceHealth,
  buildWarnings,
  countEventsByType,
  countRecentClientErrors,
  listCategorizerRuns,
  maskEmail,
  maskUserLabel,
  mergeUserEvents,
  normalizeProductTrendRow,
  normalizeProfileSignupRow,
  normalizeRecipeTrendRow,
  normalizeStripeEventRow,
  normalizeSubscriptionRow,
  parseCategorizerRunDirName,
  parseOllamaModels,
  probeOllamaModels,
  isValidCategorizerRunDirName,
  resolveCategorizerRunPath,
  withTimeout,
  type AdminUserEvent,
} from './adminAggregator';
import nodePath from 'node:path';
import type { QualityReport } from './offersQuality';
import type { Offer } from '../../src/types/models';

function makeQuality(overrides: Partial<QualityReport> = {}): QualityReport {
  return {
    generatedAt: '2026-05-27T15:00:00.000Z',
    thresholds: { lowOfferCount: 5 },
    kpis: {
      liveTotal: 100,
      filteredTotal: 20,
      nextWeekTotal: 30,
      storeCount: 5,
      imageCoveragePercent: 95,
      nutritionCoveragePercent: 50,
      halalCoveragePercent: 50,
      allergensCoveragePercent: 50,
      updatedAt: '2026-05-27T14:00:00.000Z',
      lastIngest: null,
      lastAiRun: null,
    },
    stores: [],
    review: [],
    reviewCounts: {
      no_image: 0,
      no_price: 0,
      no_category: 0,
      category_other: 0,
      no_nutrition: 0,
      halal_unknown: 0,
      alcohol_unknown_risk: 0,
      allergens_empty_risk: 0,
      name_fragment: 0,
    },
    ...overrides,
  };
}

describe('maskEmail', () => {
  it('keeps first 4 local chars and the domain', () => {
    expect(maskEmail('maxmuster@example.com')).toBe('maxm***@example.com');
  });

  it('keeps n-1 chars when local part is shorter than 4', () => {
    expect(maskEmail('jo@x.de')).toBe('j***@x.de');
  });

  it('returns empty string for invalid input', () => {
    expect(maskEmail(null)).toBe('');
    expect(maskEmail(undefined)).toBe('');
    expect(maskEmail('')).toBe('');
    expect(maskEmail('not-an-email')).toBe('');
  });
});

describe('buildWarnings', () => {
  const base = {
    ollamaRunning: true,
    stripeError: null,
    recentClientErrorCount: 0,
    subscriptionsAvailable: true,
  };

  it('emits no warnings on a healthy snapshot', () => {
    const w = buildWarnings({ ...base, qualityReport: makeQuality() });
    expect(w).toEqual([]);
  });

  it('emits a low-store warning per affected store', () => {
    const qr = makeQuality({
      stores: [
        // The store-quality fields are read selectively, but typing is strict
        // → spread a minimal valid shape with `lowOfferCount` flipped.
        ...['Lidl', 'EDEKA'].map((storeChain, idx) => ({
          storeChain,
          total: idx === 0 ? 2 : 80,
          withImage: 0, withImagePercent: 0,
          withCurrentPrice: 0, withCurrentPricePercent: 0,
          withOriginalPrice: 0, withOriginalPricePercent: 0,
          withSavingsPercent: 0, withSavingsPercentPercent: 0,
          withNutrition: 0, withNutritionPercent: 0,
          withAllergens: 0, withAllergensPercent: 0,
          halalKnown: 0, halalKnownPercent: 0,
          alcoholKnown: 0, alcoholKnownPercent: 0,
          vegetarianKnown: 0, vegetarianKnownPercent: 0,
          veganKnown: 0, veganKnownPercent: 0,
          withValidTo: 0, withValidToPercent: 0,
          withoutCategory: 0, withoutCategoryPercent: 0,
          lowOfferCount: idx === 0,
          status: { tier: 'crit' as const, reasons: ['low_offers' as const] },
        })),
      ],
    });
    const w = buildWarnings({ ...base, qualityReport: qr });
    expect(w.map((entry) => entry.code)).toEqual(['store.low_offers']);
    expect(w[0].message).toMatch(/Lidl/);
  });

  it('does not emit coverage warnings on an empty snapshot', () => {
    const qr = makeQuality({
      kpis: {
        ...makeQuality().kpis,
        liveTotal: 0,
        imageCoveragePercent: 0,
        nutritionCoveragePercent: 0,
        halalCoveragePercent: 0,
        allergensCoveragePercent: 0,
      },
    });
    const w = buildWarnings({ ...base, qualityReport: qr });
    expect(w.find((e) => e.code.startsWith('coverage.'))).toBeUndefined();
  });

  it('emits coverage warnings only below their thresholds', () => {
    const qr = makeQuality({
      kpis: {
        ...makeQuality().kpis,
        imageCoveragePercent: 12,        // < 30 → warn
        nutritionCoveragePercent: 5,     // < 10 → warn
        halalCoveragePercent: 2,         // < 10 → warn
        allergensCoveragePercent: 50,    // ok
      },
    });
    const codes = buildWarnings({ ...base, qualityReport: qr }).map((w) => w.code);
    expect(codes).toContain('coverage.image_low');
    expect(codes).toContain('coverage.nutrition_low');
    expect(codes).toContain('coverage.halal_low');
    expect(codes).not.toContain('coverage.allergens_low');
  });

  it('emits ollama offline + stripe error + client error warnings', () => {
    const w = buildWarnings({
      qualityReport: makeQuality(),
      ollamaRunning: false,
      stripeError: 'JWT expired',
      recentClientErrorCount: 5,
      subscriptionsAvailable: true,
    });
    const codes = w.map((entry) => entry.code);
    expect(codes).toContain('system.ollama_offline');
    expect(codes).toContain('stripe.error');
    expect(codes).toContain('client.errors_present');
  });

  it('emits supabase.unavailable when service-role missing', () => {
    const w = buildWarnings({ ...base, subscriptionsAvailable: false, qualityReport: makeQuality() });
    expect(w.find((e) => e.code === 'supabase.unavailable')).toBeDefined();
  });
});

describe('aggregateTopStoreNames', () => {
  it('counts and sorts non-blank store_name values', () => {
    const top = aggregateTopStoreNames([
      { store_name: 'REWE' },
      { store_name: 'REWE' },
      { store_name: 'EDEKA' },
      { store_name: '   ' },
      { store_name: null },
    ]);
    expect(top).toEqual([
      { storeName: 'REWE', count: 2 },
      { storeName: 'EDEKA', count: 1 },
    ]);
  });

  it('caps to the requested limit', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ store_name: `Store${i}` }));
    const top = aggregateTopStoreNames(rows, 3);
    expect(top.length).toBe(3);
  });
});

describe('normalize trend rows', () => {
  it('produces null when the key field is missing', () => {
    expect(normalizeProductTrendRow({})).toBeNull();
    expect(normalizeRecipeTrendRow({})).toBeNull();
  });

  it('coerces missing numeric fields to 0', () => {
    const product = normalizeProductTrendRow({ name_key: 'milch' });
    expect(product).toEqual({
      nameKey: 'milch',
      displayName: 'milch',
      addedCount: 0,
      purchasedCount: 0,
      uniqueUsers: 0,
      latestAddedAt: null,
    });
  });

  it('preserves sample_name when present', () => {
    const product = normalizeProductTrendRow({
      name_key: 'milch',
      sample_name: 'Vollmilch 1,5%',
      added_count: 12,
      purchased_count: 5,
    });
    expect(product?.displayName).toBe('Vollmilch 1,5%');
    expect(product?.addedCount).toBe(12);
  });
});

describe('buildSourceHealth', () => {
  function offer(overrides: Partial<Offer>): Offer {
    return {
      id: 'official_a',
      name: 'X',
      normalizedName: 'x',
      storeChain: 'REWE',
      category: 'other',
      price: 1,
      currency: 'EUR',
      unit: '1',
      validityStart: '2026-05-27T00:00:00.000Z',
      validityEnd: '2026-06-03T00:00:00.000Z',
      imageUrl: 'https://example.com/i.png',
      sourceUrl: 'https://example.com',
      tags: [],
      createdAt: '2026-05-27T10:00:00.000Z',
      ...overrides,
    } as Offer;
  }

  it('groups by source-kind × storeChain and counts coverage', () => {
    const sources = buildSourceHealth([
      offer({ id: 'official_1', storeChain: 'REWE' }),
      offer({ id: 'official_2', storeChain: 'REWE', imageUrl: undefined }),
      offer({ id: 'local_1', storeChain: 'Yazgülü Darmstadt' }),
      offer({ id: 'rewe_browser_1', storeChain: 'REWE' }),
    ]);
    const rewe = sources.find((s) => s.kind === 'official' && s.displayName === 'REWE');
    expect(rewe?.total).toBe(2);
    expect(rewe?.imageCoveragePercent).toBe(50);
    expect(sources.find((s) => s.kind === 'local_ocr')?.total).toBe(1);
    expect(sources.find((s) => s.kind === 'manual_rewe_import')?.total).toBe(1);
  });

  it('warns about low offer counts and low image coverage', () => {
    const sources = buildSourceHealth([
      offer({ id: 'official_x', storeChain: 'Lidl', imageUrl: undefined }),
    ]);
    const lidl = sources.find((s) => s.displayName === 'Lidl');
    expect(lidl?.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('ignores offers with unknown ID prefixes', () => {
    const sources = buildSourceHealth([offer({ id: 'offer_random' })]);
    expect(sources).toEqual([]);
  });
});

describe('countRecentClientErrors', () => {
  it('counts only debug.clientError errors in the recent window', () => {
    const logs = [
      { level: 'info', message: 'health.check' },
      { level: 'error', message: 'debug.clientError' },
      { level: 'error', message: 'http.unhandledError' },
      { level: 'error', message: 'debug.clientError' },
    ];
    expect(countRecentClientErrors(logs)).toBe(2);
  });

  it('respects the window size', () => {
    const logs = Array.from({ length: 500 }, () => ({
      level: 'error',
      message: 'debug.clientError',
    }));
    expect(countRecentClientErrors(logs, 100)).toBe(100);
  });
});

describe('maskUserLabel', () => {
  it('returns the first 8 chars followed by ellipsis for long ids', () => {
    expect(maskUserLabel('11111111-2222-3333-4444-555555555555')).toBe('11111111…');
  });
  it('returns the value as-is for short input', () => {
    expect(maskUserLabel('abcd1234')).toBe('abcd1234');
  });
  it('returns null on empty/blank input', () => {
    expect(maskUserLabel(null)).toBeNull();
    expect(maskUserLabel(undefined)).toBeNull();
    expect(maskUserLabel('   ')).toBeNull();
  });
});

describe('normalizeStripeEventRow', () => {
  it('produces an AdminUserEvent without PII', () => {
    const ev = normalizeStripeEventRow({
      id: 'evt_abc123',
      event_type: 'checkout.session.completed',
      processed_at: '2026-05-27T09:14:02.000Z',
    });
    expect(ev).toEqual({
      id: 'stripe:evt_abc123',
      type: 'checkout.session.completed',
      label: 'checkout.session.completed',
      tier: null,
      status: null,
      occurredAt: '2026-05-27T09:14:02.000Z',
      userLabelMasked: null,
      source: 'stripe_events',
    });
  });
  it('returns null when required fields are missing', () => {
    expect(normalizeStripeEventRow({})).toBeNull();
    expect(normalizeStripeEventRow({ id: 'x' })).toBeNull();
    expect(normalizeStripeEventRow({ id: 'x', event_type: 'y' })).toBeNull();
  });
});

describe('normalizeSubscriptionRow', () => {
  it('coerces unknown tier/status to "unknown"', () => {
    const ev = normalizeSubscriptionRow({
      user_id: '11111111-2222-3333-4444-555555555555',
      tier: 'mystery',
      status: 'wat',
      updated_at: '2026-05-27T09:14:02.000Z',
    });
    expect(ev?.tier).toBe('unknown');
    expect(ev?.status).toBe('unknown');
    expect(ev?.userLabelMasked).toBe('11111111…');
  });
  it('keeps known tier/status', () => {
    const ev = normalizeSubscriptionRow({
      user_id: 'abc',
      tier: 'premium',
      status: 'active',
      updated_at: '2026-05-27T09:14:02.000Z',
    });
    expect(ev?.tier).toBe('premium');
    expect(ev?.status).toBe('active');
    expect(ev?.label).toContain('premium');
  });
  it('returns null without user_id or updated_at', () => {
    expect(normalizeSubscriptionRow({})).toBeNull();
    expect(normalizeSubscriptionRow({ user_id: 'x' })).toBeNull();
  });
});

describe('normalizeProfileSignupRow', () => {
  it('drops email and produces a free/active signup event', () => {
    const ev = normalizeProfileSignupRow({
      id: 'abc-123',
      created_at: '2026-05-27T09:14:02.000Z',
      email: 'should-not-be-read@example.com',
    });
    expect(ev?.tier).toBe('free');
    expect(ev?.status).toBe('active');
    expect(ev?.type).toBe('user.signup');
    // explicitly: no leaked email anywhere in the serialized event
    expect(JSON.stringify(ev)).not.toContain('example.com');
  });
});

describe('mergeUserEvents', () => {
  function ev(overrides: Partial<AdminUserEvent>): AdminUserEvent {
    return {
      id: 'x',
      type: 't',
      label: 't',
      tier: null,
      status: null,
      occurredAt: '2026-05-27T09:14:02.000Z',
      userLabelMasked: null,
      source: 'stripe_events',
      ...overrides,
    };
  }
  it('dedupes by id and sorts newest first', () => {
    const out = mergeUserEvents([
      [ev({ id: 'a', occurredAt: '2026-05-27T08:00:00.000Z' })],
      [ev({ id: 'a', occurredAt: '2026-05-27T09:00:00.000Z' }), ev({ id: 'b', occurredAt: '2026-05-27T10:00:00.000Z' })],
    ]);
    expect(out.map((e) => e.id)).toEqual(['b', 'a']);
  });
  it('caps to limit', () => {
    const events = Array.from({ length: 60 }, (_, i) =>
      ev({ id: 'id-' + i, occurredAt: '2026-05-27T09:14:0' + (i % 10) + '.000Z' }),
    );
    expect(mergeUserEvents([events], 20).length).toBe(20);
  });
});

describe('countEventsByType', () => {
  it('aggregates the type field across events', () => {
    const events: AdminUserEvent[] = [
      { id: '1', type: 'a', label: 'a', tier: null, status: null, occurredAt: '', userLabelMasked: null, source: 'stripe_events' },
      { id: '2', type: 'a', label: 'a', tier: null, status: null, occurredAt: '', userLabelMasked: null, source: 'stripe_events' },
      { id: '3', type: 'b', label: 'b', tier: null, status: null, occurredAt: '', userLabelMasked: null, source: 'stripe_events' },
    ];
    expect(countEventsByType(events)).toEqual({ a: 2, b: 1 });
  });
});

describe('parseOllamaModels', () => {
  it('returns [] for null / wrong shapes', () => {
    expect(parseOllamaModels(null)).toEqual([]);
    expect(parseOllamaModels({})).toEqual([]);
    expect(parseOllamaModels({ models: 'no' })).toEqual([]);
  });
  it('parses the real Ollama /api/tags shape and sorts by name', () => {
    const out = parseOllamaModels({
      models: [
        {
          name: 'qwen2.5:14b-instruct',
          size: 8_000_000_000,
          modified_at: '2026-05-20T09:00:00.000Z',
          details: { family: 'qwen2', parameter_size: '14B', quantization_level: 'Q4_K_M' },
        },
        {
          name: 'llama3.1:8b',
          size: 4_700_000_000,
          modified_at: '2026-05-10T08:00:00.000Z',
          details: { family: 'llama' },
        },
        // Skip entries without name
        { size: 1 },
      ],
    });
    expect(out.map((m) => m.name)).toEqual(['llama3.1:8b', 'qwen2.5:14b-instruct']);
    expect(out[1].parameterSize).toBe('14B');
    expect(out[1].quantization).toBe('Q4_K_M');
    expect(out[0].quantization).toBeNull();
  });
});

describe('probeOllamaModels', () => {
  it('returns { available: false } on a network error', async () => {
    const failingFetch: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const r = await probeOllamaModels('http://localhost:11434', failingFetch, 200);
    expect(r.available).toBe(false);
    expect(r.models).toEqual([]);
    expect(r.error).toContain('ECONNREFUSED');
  });

  it('returns models when the fetch succeeds', async () => {
    const okFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ models: [{ name: 'qwen2.5:14b' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const r = await probeOllamaModels('http://localhost:11434', okFetch);
    expect(r.available).toBe(true);
    expect(r.models.map((m) => m.name)).toEqual(['qwen2.5:14b']);
  });

  it('returns { available: false } on non-2xx response', async () => {
    const failFetch: typeof fetch = async () => new Response('nope', { status: 500 });
    const r = await probeOllamaModels('http://localhost:11434', failFetch);
    expect(r.available).toBe(false);
    expect(r.error).toContain('HTTP 500');
  });
});

describe('parseCategorizerRunDirName', () => {
  it('parses a real categorizer-run directory name', () => {
    const r = parseCategorizerRunDirName(
      '2026-05-27T11-51-56-537Z-149d57a4-3692-4da0-b245-f0688649b645',
    );
    expect(r?.startedAt).toBe('2026-05-27T11:51:56.537Z');
    expect(r?.runId).toBe('149d57a4-3692-4da0-b245-f0688649b645');
    expect(r?.kind).toBe('categorizer');
  });
  it('returns null for malformed names', () => {
    expect(parseCategorizerRunDirName('foo')).toBeNull();
    expect(parseCategorizerRunDirName('2026-05-27_bad')).toBeNull();
  });
  it('exposes the full dirName as the delete handle', () => {
    const name = '2026-05-27T11-51-56-537Z-149d57a4-3692-4da0-b245-f0688649b645';
    expect(parseCategorizerRunDirName(name)?.dirName).toBe(name);
  });
});

describe('isValidCategorizerRunDirName + resolveCategorizerRunPath (path safety)', () => {
  const root = nodePath.resolve('/srv/app/backend/data/categorizer-runs');
  const valid = '2026-05-27T11-51-56-537Z-149d57a4-3692-4da0-b245-f0688649b645';

  it('accepts a well-formed categorizer-run dir name', () => {
    expect(isValidCategorizerRunDirName(valid)).toBe(true);
  });

  it('rejects traversal, separators, absolute paths and junk', () => {
    for (const bad of [
      '..',
      '../../etc/passwd',
      'foo',
      'offers.json',
      `${valid}/../../secret`,
      `${valid}/..`,
      'subdir/' + valid,
      '..\\..\\windows',
      '/etc/passwd',
      'C:\\Windows',
      '',
      '   ',
    ]) {
      expect(isValidCategorizerRunDirName(bad)).toBe(false);
    }
  });

  it('resolves a valid name to a DIRECT child of runRoot', () => {
    const resolved = resolveCategorizerRunPath(root, valid);
    expect(resolved).toBe(nodePath.join(root, valid));
    expect(nodePath.dirname(resolved as string)).toBe(root);
  });

  it('returns null for any traversal / escape attempt (never escapes runRoot)', () => {
    for (const bad of [
      '..',
      '../../../etc',
      `${valid}/../../../../etc/passwd`,
      'subdir/' + valid,
      '/etc/passwd',
      'totally-not-a-run',
      '',
    ]) {
      const resolved = resolveCategorizerRunPath(root, bad);
      if (resolved !== null) {
        // If it ever resolved, it must still be strictly inside runRoot.
        expect(resolved.startsWith(root + nodePath.sep)).toBe(true);
      } else {
        expect(resolved).toBeNull();
      }
    }
  });
});

describe('listCategorizerRuns', () => {
  it('returns [] when the directory does not exist', async () => {
    const out = await listCategorizerRuns(
      '/nonexistent',
      async () => { throw new Error('ENOENT'); },
      async () => null,
    );
    expect(out).toEqual([]);
  });
  it('skips entries that do not match the timestamp format', async () => {
    const out = await listCategorizerRuns(
      '/runs',
      async () => ['junk-folder', '2026-05-27T11-51-56-537Z-abc'],
      async () => ({ isDirectory: () => true }),
    );
    expect(out.length).toBe(1);
    expect(out[0].runId).toBe('abc');
    expect(out[0].hasOutput).toBe(true);
  });
  it('sorts newest first', async () => {
    const out = await listCategorizerRuns(
      '/runs',
      async () => [
        '2026-01-01T00-00-00-000Z-old',
        '2026-12-01T00-00-00-000Z-new',
      ],
      async () => ({ isDirectory: () => false }),
    );
    expect(out.map((r) => r.runId)).toEqual(['new', 'old']);
    expect(out[0].hasOutput).toBe(false);
  });
});

describe('withTimeout — bounds slow admin Supabase calls', () => {

  it('resolves with the value when the promise wins the race', async () => {

    const out = await withTimeout(Promise.resolve('ok'), 1000, () => 'fallback');

    expect(out).toBe('ok');

  });



  it('resolves with the fallback when the promise hangs past the timeout', async () => {

    const hanging = new Promise<string>(() => {}); // never settles

    const start = Date.now();

    const out = await withTimeout(hanging, 30, () => 'fallback');

    expect(out).toBe('fallback');

    expect(Date.now() - start).toBeLessThan(500);

  });



  it('resolves with the fallback when the promise rejects (no unhandled rejection)', async () => {

    const out = await withTimeout(Promise.reject(new Error('boom')), 1000, () => 'fallback');

    expect(out).toBe('fallback');

  });

});
