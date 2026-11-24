import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  applyFragmentQuarantineGate,
  checkOffersImages,
  classifyImageProbe,
  countLocked,
  createInitialScanV2Status,
  isImageContentType,
  modeIncludesPhase1,
  modeIncludesPhase2,
  parseScanV2Mode,
  partitionFoodForAnalysis,
  probeImageUrl,
  quarantineFragmentOffers,
  type FetchLike,
} from './offersScanV2';

function makeOffer(overrides: Partial<Offer> & Record<string, unknown> = {}): Offer {
  return {
    id: 'o1',
    name: 'Bio Milch',
    normalizedName: 'bio milch',
    storeChain: 'REWE',
    category: 'dairy',
    price: 1.29,
    currency: 'EUR',
    unit: '1l',
    validityStart: '2026-05-26T00:00:00.000Z',
    validityEnd: '2026-06-01T23:59:59.999Z',
    imageUrl: 'https://example.com/milk.png',
    sourceUrl: 'https://example.com/offer',
    tags: [],
    createdAt: '2026-05-26T08:00:00.000Z',
    ...overrides,
  } as Offer;
}

// Fake fetch: HEAD and GET both answer from the same URL→{status,contentType}
// table unless an override for HEAD is given (to exercise the GET fallback).
function fakeFetch(
  table: Record<string, { status: number; ct: string | null; headStatus?: number; headCt?: string | null }>,
): FetchLike {
  return async (url, init) => {
    const entry = table[url] ?? { status: 500, ct: null };
    const isHead = (init?.method ?? 'GET') === 'HEAD';
    const status = isHead && entry.headStatus !== undefined ? entry.headStatus : entry.status;
    const ct = isHead && entry.headCt !== undefined ? entry.headCt : entry.ct;
    return {
      status,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? ct : null) },
    };
  };
}

describe('parseScanV2Mode', () => {
  it('accepts the three canonical modes', () => {
    expect(parseScanV2Mode('phase1')).toBe('phase1');
    expect(parseScanV2Mode('phase2')).toBe('phase2');
    expect(parseScanV2Mode('phase1_phase2')).toBe('phase1_phase2');
  });

  it('accepts forgiving aliases', () => {
    expect(parseScanV2Mode('both')).toBe('phase1_phase2');
    expect(parseScanV2Mode('1+2')).toBe('phase1_phase2');
    expect(parseScanV2Mode('  PHASE1  ')).toBe('phase1');
    expect(parseScanV2Mode('food')).toBe('phase2');
    expect(parseScanV2Mode('schnellscan')).toBe('phase1');
  });

  it('returns null for empty/unknown input', () => {
    expect(parseScanV2Mode('')).toBeNull();
    expect(parseScanV2Mode(undefined)).toBeNull();
    expect(parseScanV2Mode('phase3')).toBeNull();
    expect(parseScanV2Mode('garbage')).toBeNull();
  });
});

describe('modeIncludesPhaseX', () => {
  it('maps each mode to its phases', () => {
    expect(modeIncludesPhase1('phase1')).toBe(true);
    expect(modeIncludesPhase2('phase1')).toBe(false);
    expect(modeIncludesPhase1('phase2')).toBe(false);
    expect(modeIncludesPhase2('phase2')).toBe(true);
    expect(modeIncludesPhase1('phase1_phase2')).toBe(true);
    expect(modeIncludesPhase2('phase1_phase2')).toBe(true);
  });
});

describe('createInitialScanV2Status', () => {
  it('starts idle with zeroed phase stats', () => {
    const s = createInitialScanV2Status();
    expect(s.running).toBe(false);
    expect(s.phase).toBe('idle');
    expect(s.mode).toBeNull();
    expect(s.phase1.brokenImageCount).toBe(0);
    expect(s.phase2.skippedLockedCount).toBe(0);
    expect(s.phase2.durationMs).toBeNull();
  });

  it('starts not-paused with no checkpoint and no pausedAt', () => {
    const s = createInitialScanV2Status();
    expect(s.paused).toBe(false);
    expect(s.pausedAt).toBeNull();
    expect(s.checkpointAvailable).toBe(false);
  });

  it('liefert die P4-Statusfelder (Phase 1 + Phase 2) und qualityFailure=null', () => {
    const s = createInitialScanV2Status();
    // Phase 1 — getrennte ehrliche Zähler (nie filteredCount = nonFoodFilteredCount).
    expect(s.phase1.nonFoodFilteredCount).toBe(0);
    expect(s.phase1.uncertainFilteredCount).toBe(0);
    // Phase 2 — Recovery-Zähler.
    expect(s.phase2.uncertainFilteredCandidatesCount).toBe(0);
    expect(s.phase2.phase2RecoveredFoodCount).toBe(0);
    expect(s.phase2.phase2ConfirmedNonFoodCount).toBe(0);
    // Strukturierter Qualitäts-Gate-Fehler ist anfangs null.
    expect(s.qualityFailure).toBeNull();
  });
});

describe('isImageContentType', () => {
  it('only image/* counts', () => {
    expect(isImageContentType('image/png')).toBe(true);
    expect(isImageContentType('IMAGE/JPEG')).toBe(true);
    expect(isImageContentType('text/html')).toBe(false);
    expect(isImageContentType('')).toBe(false);
    expect(isImageContentType(null)).toBe(false);
  });
});

describe('classifyImageProbe', () => {
  it('missing when no url', () => {
    expect(classifyImageProbe({ url: '', httpStatus: 200, contentType: 'image/png' })).toBe('missing');
    expect(classifyImageProbe({ url: '   ' })).toBe('missing');
  });

  it('ok only for 2xx AND image/*', () => {
    expect(classifyImageProbe({ url: 'u', httpStatus: 200, contentType: 'image/png' })).toBe('ok');
    expect(classifyImageProbe({ url: 'u', httpStatus: 206, contentType: 'image/jpeg' })).toBe('ok');
  });

  it('broken for 404', () => {
    expect(classifyImageProbe({ url: 'u', httpStatus: 404, contentType: 'text/html' })).toBe('broken');
  });

  it('broken for 200 + html (EDEKA error page served with 200)', () => {
    expect(classifyImageProbe({ url: 'u', httpStatus: 200, contentType: 'text/html' })).toBe('broken');
  });

  it('broken for a network error (null status)', () => {
    expect(classifyImageProbe({ url: 'u', httpStatus: null })).toBe('broken');
  });
});

describe('probeImageUrl', () => {
  it('falls back to GET when HEAD is 405', async () => {
    const fetchImpl = fakeFetch({
      'https://cdn/img.png': { status: 200, ct: 'image/png', headStatus: 405, headCt: null },
    });
    const res = await probeImageUrl('https://cdn/img.png', { fetchImpl });
    expect(res.httpStatus).toBe(200);
    expect(res.contentType).toBe('image/png');
  });

  it('returns null status on fetch error', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('boom');
    };
    const res = await probeImageUrl('https://x/y.png', { fetchImpl });
    expect(res.httpStatus).toBeNull();
  });
});

describe('checkOffersimages — Broken Image Check (Task 5/8)', () => {
  it('200 image/* counts, 404 + 200-html count as broken, no URL = missing', async () => {
    const fetchImpl = fakeFetch({
      'https://ok/img.png': { status: 200, ct: 'image/png' },
      'https://broken/404.png': { status: 404, ct: 'text/html' },
      'https://edeka/exists.jpg': { status: 200, ct: 'text/html' },
    });
    const offers = [
      makeOffer({ id: 'ok', imageUrl: 'https://ok/img.png' }),
      makeOffer({ id: 'gone', imageUrl: 'https://broken/404.png' }),
      makeOffer({ id: 'edeka', imageUrl: 'https://edeka/exists.jpg' }),
      makeOffer({ id: 'noimg', imageUrl: undefined }),
    ];

    const result = await checkOffersImages(offers, { fetchImpl, concurrency: 4 });

    const byId = new Map(result.offers.map((o) => [o.id, o]));
    expect(byId.get('ok')?.imageStatus).toBe('ok');
    expect(byId.get('ok')?.brokenImage).toBe(false);
    expect(byId.get('gone')?.imageStatus).toBe('broken');
    expect(byId.get('gone')?.brokenImage).toBe(true);
    // EDEKA: URL exists (200) but is NOT an image → broken, never "100 %".
    expect(byId.get('edeka')?.imageStatus).toBe('broken');
    expect(byId.get('edeka')?.brokenImage).toBe(true);
    expect(byId.get('noimg')?.imageStatus).toBe('missing');
    expect(byId.get('noimg')?.brokenImage).toBe(false);

    expect(result.imageCheckedCount).toBe(3);
    expect(result.brokenImageCount).toBe(2);
    expect(result.missingImageCount).toBe(1);
  });

  it('dedupes shared image URLs (one probe per distinct URL)', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return { status: 200, headers: { get: () => 'image/png' } };
    };
    const offers = [
      makeOffer({ id: 'a', imageUrl: 'https://same/x.png' }),
      makeOffer({ id: 'b', imageUrl: 'https://same/x.png' }),
    ];
    const result = await checkOffersImages(offers, { fetchImpl });
    expect(calls).toBe(1); // single distinct URL probed once
    expect(result.offers.every((o) => o.imageStatus === 'ok')).toBe(true);
  });
});

describe('partitionFoodForAnalysis — Phase 2 skips sure non-food (Task 8)', () => {
  it('separates non-food from food candidates', () => {
    const offers = [
      makeOffer({ id: 'food1', foodFlag: 'food' }),
      makeOffer({ id: 'unsure', foodFlag: undefined }),
      makeOffer({ id: 'nonfood1', foodFlag: 'nonfood' }),
      makeOffer({ id: 'nonfood2', canonicalCategory: { isNonFood: true } }),
    ];
    const { food, skippedNonFood } = partitionFoodForAnalysis(offers);
    expect(food.map((o) => o.id).sort()).toEqual(['food1', 'unsure']);
    expect(skippedNonFood.map((o) => o.id).sort()).toEqual(['nonfood1', 'nonfood2']);
  });

  it('skips a Kaufland "nonfood"-tagged offer even without foodFlag/isNonFood', () => {
    const offers = [
      makeOffer({ id: 'food1', name: 'Bio Milch', foodFlag: 'food' }),
      // Kaufland Drogerie/Technik etc.: only the connector "nonfood" tag is set.
      makeOffer({
        id: 'duschgel',
        name: 'NIVEA Duschgel',
        normalizedName: 'nivea duschgel',
        category: 'Sonstiges',
        tags: ['filiale', 'nonfood'],
      }),
    ];
    const { food, skippedNonFood } = partitionFoodForAnalysis(offers);
    expect(food.map((o) => o.id)).toEqual(['food1']);
    expect(skippedNonFood.map((o) => o.id)).toEqual(['duschgel']);
  });

  it('keeps international foods (Sriracha/Ayran/Basmati) IN Phase 2 (not skipped)', () => {
    const offers = [
      makeOffer({ id: 'sriracha', name: 'Sriracha Hot Chili Sauce', normalizedName: 'sriracha hot chili sauce', category: 'Sonstiges' }),
      makeOffer({ id: 'ayran', name: 'Ayran', normalizedName: 'ayran', category: 'Milchprodukte' }),
      makeOffer({ id: 'basmati', name: 'Basmati Reis', normalizedName: 'basmati reis', category: 'Sonstiges' }),
    ];
    const { food, skippedNonFood } = partitionFoodForAnalysis(offers);
    expect(food.map((o) => o.id).sort()).toEqual(['ayran', 'basmati', 'sriracha']);
    expect(skippedNonFood).toHaveLength(0);
  });

  it('skips a strong non-food (LIVARNO/Insektenschutz) even when foodFlag=unsure', () => {
    const offers = [
      makeOffer({ id: 'food1', name: 'Bio Milch', foodFlag: 'food' }),
      // The exact snapshot leak: unsure + isNonFood=false, but a LIVARNO name.
      makeOffer({
        id: 'livarno',
        name: 'LIVARNO UV-Insektenfalle',
        normalizedName: 'livarno uv insektenfalle',
        foodFlag: 'unsure',
        canonicalCategory: { isNonFood: false },
      }),
    ];
    const { food, skippedNonFood } = partitionFoodForAnalysis(offers);
    expect(food.map((o) => o.id)).toEqual(['food1']);
    expect(skippedNonFood.map((o) => o.id)).toEqual(['livarno']);
  });
});

describe('countLocked — Phase 2 never sends locked offers (Task 8)', () => {
  it('counts editorially locked/manual offers', () => {
    const offers = [
      makeOffer({ id: 'a' }),
      makeOffer({ id: 'b', aiLocked: true }),
      makeOffer({ id: 'c', manualReviewed: true }),
      makeOffer({ id: 'd', reviewLocked: true }),
    ];
    expect(countLocked(offers)).toBe(3);
  });
});

describe('quarantineFragmentOffers — Fragmentnamen nie live', () => {
  const base = {
    normalizedName: 'x',
    storeChain: 'REWE',
    category: 'Sonstiges',
    price: 0.85,
    currency: 'EUR',
    unit: 'Stk',
    sourceUrl: 'https://example.com',
    createdAt: '2026-06-01T00:00:00.000Z',
  };

  it('verschiebt "Tiefpreis"/"Fl." in die Quarantäne und taggt sie reviewNeeded', () => {
    const { clean, quarantined } = quarantineFragmentOffers([
      { ...base, id: 'a', name: 'Tiefpreis', tags: ['rewe'] },
      { ...base, id: 'b', name: 'Fl.', tags: [] },
      { ...base, id: 'c', name: 'Red Bull Energy Drink', tags: ['rewe'] },
    ] as never[]);
    expect(clean.map((offer) => offer.name)).toEqual(['Red Bull Energy Drink']);
    expect(quarantined.map((offer) => offer.name).sort()).toEqual(['Fl.', 'Tiefpreis']);
    for (const offer of quarantined) {
      expect(offer.tags).toContain('name_fragment');
      expect(offer.tags).toContain('reviewNeeded');
    }
  });

  it('laesst eine saubere Liste unveraendert', () => {
    const offers = [
      { ...base, id: 'a', name: 'Bananen', tags: [] },
      { ...base, id: 'b', name: 'Coca-Cola Dose 0,33l', tags: [] },
    ] as never[];
    const { clean, quarantined } = quarantineFragmentOffers(offers);
    expect(clean).toHaveLength(2);
    expect(quarantined).toHaveLength(0);
  });
});

describe('applyFragmentQuarantineGate — persistierte Fragment-Leaks reparieren', () => {
  const base = {
    normalizedName: 'x',
    storeChain: 'REWE',
    category: 'Sonstiges',
    price: 0.85,
    currency: 'EUR',
    unit: 'Stk',
    sourceUrl: 'https://example.com',
    createdAt: '2026-06-01T00:00:00.000Z',
  };
  const mk = (id: string, name: string, tags: string[] = []) =>
    ({ ...base, id, name, tags }) as Offer;

  it('verschiebt Fragmente aus offers UND nextWeekOffers nach filtered', () => {
    // Real beobachtete Live-Leaks aus einem persistierten Snapshot: "l-Dose"
    // (REWE-Verpackungs-OCR) und "individuell kombinierbar kernlos"
    // (Beschreibungszeile), die der alte Rescue nach live verschoben hatte.
    const result = applyFragmentQuarantineGate({
      offers: [mk('a', 'l-Dose'), mk('b', 'Red Bull Energy Drink')],
      nextWeekOffers: [mk('c', 'individuell kombinierbar kernlos', ['food_rescue'])],
      filteredOffers: [mk('d', 'Spülmittel Ultra')],
    });

    expect(result.offers.map((o) => o.name)).toEqual(['Red Bull Energy Drink']);
    expect(result.nextWeekOffers).toHaveLength(0);
    expect(result.filteredOffers.map((o) => o.id).sort()).toEqual(['a', 'c', 'd']);
    expect(result.movedCount).toBe(2);
    expect(result.movedExamples.sort()).toEqual(['individuell kombinierbar kernlos', 'l-Dose']);
    for (const moved of result.filteredOffers.filter((o) => o.id !== 'd')) {
      expect(moved.tags).toContain('name_fragment');
      expect(moved.tags).toContain('reviewNeeded');
    }
  });

  it('ist idempotent und mutiert die Eingabe-Buckets nicht', () => {
    const buckets = {
      offers: [mk('a', 'l-Dose'), mk('b', 'Bananen')],
      nextWeekOffers: [] as Offer[],
      filteredOffers: [] as Offer[],
    };
    const first = applyFragmentQuarantineGate(buckets);
    expect(buckets.offers).toHaveLength(2);
    expect(first.movedCount).toBe(1);

    const second = applyFragmentQuarantineGate({
      offers: first.offers,
      nextWeekOffers: first.nextWeekOffers,
      filteredOffers: first.filteredOffers,
    });
    expect(second.movedCount).toBe(0);
    expect(second.filteredOffers).toHaveLength(1);
  });

  it('dedupliziert nach id, wenn das Fragment bereits in filtered liegt', () => {
    const result = applyFragmentQuarantineGate({
      offers: [mk('a', 'l-Dose')],
      nextWeekOffers: [],
      filteredOffers: [mk('a', 'l-Dose', ['name_fragment', 'reviewNeeded'])],
    });
    expect(result.filteredOffers).toHaveLength(1);
    expect(result.movedCount).toBe(1);
  });
});

describe('probeImageUrl — Browser-Header gegen UA-lose 403s (Netto media_nfs)', () => {
  it('sendet User-Agent + Accept bei HEAD und beim GET-Fallback', async () => {
    const seen: Array<{ method?: string; headers?: Record<string, string> }> = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      seen.push({ method: init?.method, headers: init?.headers });
      // HEAD ohne content-type erzwingt den GET-Fallback.
      return {
        status: init?.method === 'HEAD' ? 200 : 200,
        headers: { get: (name: string) => (init?.method === 'GET' && name === 'content-type' ? 'image/webp' : null) },
      };
    };
    const result = await probeImageUrl('https://www.netto-online.de/media_nfs/x.webp', { fetchImpl });
    expect(result).toEqual({ httpStatus: 200, contentType: 'image/webp' });
    expect(seen.length).toBe(2); // HEAD ohne content-type -> GET-Fallback
    for (const call of seen) {
      expect(call.headers?.['User-Agent']).toMatch(/Mozilla/);
      expect(call.headers?.Accept).toMatch(/image\//);
    }
    // Der GET-Fallback bleibt ein 1-Byte-Range-Request.
    expect(seen[1].headers?.Range).toBe('bytes=0-0');
  });
});
