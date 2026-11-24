import { describe, expect, it } from 'vitest';
import type { Offer } from '../../../src/types/models';
import {
  absolutizeDealImageUrl,
  deriveDealSource,
  mapCategory,
  normalizeStoreKey,
  offerToDealRow,
  resolveValidFrom,
  resolveValidTo,
  storeScopedExternalId,
  DEFAULT_DEAL_WINDOW_DAYS,
  STORE_SCOPED_ID_SEP,
} from './supabaseDealsSync';
import { computeOfferQuality, type QualityDeal } from './cheffityOfferQuality';

describe('absolutizeDealImageUrl (Lidl-Kachel-Crops für die Mobile-App)', () => {
  it('prefixt RELATIVE Backend-Bilder mit DEALS_IMAGE_BASE_URL', () => {
    expect(
      absolutizeDealImageUrl('/lidl-hotspot-crops/lidl_rev_abc.jpg', 'http://192.168.1.20:8787'),
    ).toBe('http://192.168.1.20:8787/lidl-hotspot-crops/lidl_rev_abc.jpg');
    // Trailing Slash der Basis wird normalisiert.
    expect(absolutizeDealImageUrl('/x.jpg', 'http://host:8787/')).toBe('http://host:8787/x.jpg');
  });

  it('lässt absolute CDN-URLs unverändert und rät NIE einen Host', () => {
    expect(absolutizeDealImageUrl('https://www.lidl.de/assets/a.jpg', 'http://host:8787')).toBe(
      'https://www.lidl.de/assets/a.jpg',
    );
    // Ohne (oder mit kaputter) Basis bleibt die relative URL ehrlich stehen.
    expect(absolutizeDealImageUrl('/x.jpg', undefined)).toBe('/x.jpg');
    expect(absolutizeDealImageUrl('/x.jpg', 'not-a-url')).toBe('/x.jpg');
    expect(absolutizeDealImageUrl(undefined, 'http://host:8787')).toBeNull();
    expect(absolutizeDealImageUrl('', 'http://host:8787')).toBeNull();
  });
});

describe('storeScopedExternalId (REWE/nahkauf collision fix)', () => {
  it('prefixes the normalized store so a shared connector id splits per store', () => {
    expect(storeScopedExternalId({ id: 'official_coq5xx', storeChain: 'REWE' })).toBe(
      'rewe::official_coq5xx',
    );
    expect(storeScopedExternalId({ id: 'official_coq5xx', storeChain: 'nahkauf' })).toBe(
      'nahkauf::official_coq5xx',
    );
    // Same physical id, two different stores → two different keys.
    expect(storeScopedExternalId({ id: 'official_coq5xx', storeChain: 'REWE' })).not.toBe(
      storeScopedExternalId({ id: 'official_coq5xx', storeChain: 'nahkauf' }),
    );
  });

  it('keeps the original connector id recoverable as the suffix', () => {
    const scoped = storeScopedExternalId({ id: 'official_dgi241', storeChain: 'ALDI NORD' });
    expect(scoped).toBe('aldi_nord::official_dgi241');
    expect(scoped.split(STORE_SCOPED_ID_SEP).slice(1).join(STORE_SCOPED_ID_SEP)).toBe(
      'official_dgi241',
    );
  });

  it('normalizes store names stably (umlauts, spaces, case) and falls back to unbekannt', () => {
    expect(normalizeStoreKey('REWE')).toBe('rewe');
    expect(normalizeStoreKey('ALDI NORD')).toBe('aldi_nord');
    expect(normalizeStoreKey('Müller Markt')).toBe('mueller_markt');
    expect(normalizeStoreKey('')).toBe('unbekannt');
    expect(normalizeStoreKey(undefined)).toBe('unbekannt');
  });
});

describe('deriveDealSource', () => {
  it('maps OfficialSupermarketSourceConnector IDs to "official"', () => {
    expect(deriveDealSource({ id: 'official_abc123' })).toBe('official');
    expect(deriveDealSource({ id: 'official_zzz' })).toBe('official');
  });

  it('maps LocalMarketConnector IDs to "local_ocr"', () => {
    expect(deriveDealSource({ id: 'local_xyz789' })).toBe('local_ocr');
  });

  it('maps the manual REWE bookmarklet/PDF/screenshot import to "manual_rewe_import"', () => {
    expect(deriveDealSource({ id: 'rewe_browser_42' })).toBe('manual_rewe_import');
  });

  it('falls back to "manual" for unknown / extracted offer IDs', () => {
    // Pipeline-normalized hash from normalize.ts
    expect(deriveDealSource({ id: 'offer_8a7b6c' })).toBe('manual');
    // Empty / missing IDs should also be safe — never silently classify as
    // "official" or "marktguru".
    expect(deriveDealSource({ id: '' })).toBe('manual');
  });

  it('never returns the legacy "marktguru" value for new offers', () => {
    const ids = [
      'official_x',
      'local_x',
      'rewe_browser_x',
      'offer_x',
      'unknown_x',
      '',
    ];
    for (const id of ids) {
      expect(deriveDealSource({ id })).not.toBe('marktguru');
    }
  });
});

describe('mapCategory', () => {
  const conf = (main: string, confidence = 0.95, isNonFood = false) => ({
    main,
    confidence,
    isNonFood,
  });

  it('maps the real Python canonical mains onto the coarse mobile DealCategory', () => {
    expect(mapCategory('Sonstiges', 'x', [], conf('Obst & Gemüse'))).toBe('fruits_vegetables');
    expect(mapCategory('Sonstiges', 'x', [], conf('Fleisch & Wurst'))).toBe('meat_fish');
    // Fish collapses into the same meat_fish mobile bucket.
    expect(mapCategory('Sonstiges', 'x', [], conf('Fisch & Meeresfrüchte'))).toBe('meat_fish');
    expect(mapCategory('Sonstiges', 'x', [], conf('Milchprodukte & Eier'))).toBe('dairy');
    expect(mapCategory('Sonstiges', 'x', [], conf('Getränke alkoholfrei'))).toBe('drinks');
    // Alcohol shares the drinks bucket (no separate mobile category).
    expect(mapCategory('Sonstiges', 'x', [], conf('Alkohol'))).toBe('drinks');
    expect(mapCategory('Sonstiges', 'x', [], conf('Süßwaren & Snacks'))).toBe('snacks_sweets');
    expect(mapCategory('Sonstiges', 'x', [], conf('Tiefkühl'))).toBe('frozen');
    // Backwaren, Vorrat und Fertiggerichte haben seit Migration 20260819000001
    // eigene Eimer — vorher fielen sie alle in "other" und Brot landete in der
    // App neben Süßigkeiten. Muss identisch zu
    // mobile/src/services/dealCategory.ts bleiben.
    expect(mapCategory('Sonstiges', 'x', [], conf('Backwaren'))).toBe('bakery');
    expect(mapCategory('Sonstiges', 'x', [], conf('Grundnahrungsmittel'))).toBe('pantry');
    expect(mapCategory('Sonstiges', 'x', [], conf('Gewürze/Saucen/Aufstriche'))).toBe('pantry');
    expect(mapCategory('Sonstiges', 'x', [], conf('Konserven & Fertiggerichte'))).toBe('ready_meals');
    expect(mapCategory('Sonstiges', 'x', [], conf('Feinkost & Kühlung'))).toBe('ready_meals');
  });

  it('treats Non-Food as "other" regardless of main', () => {
    expect(mapCategory('Sonstiges', 'Shampoo', [], conf('Obst & Gemüse', 0.95, true))).toBe('other');
  });

  it('ignores low-confidence canonical and falls back to name regex', () => {
    // Low confidence -> do NOT trust canonical; name regex still finds dairy.
    expect(mapCategory('Sonstiges', 'Gouda Käse', [], conf('Alkohol', 0.42))).toBe('dairy');
    // No canonical at all -> name regex.
    expect(mapCategory('Sonstiges', 'Coca Cola', [])).toBe('drinks');
  });
});

describe('resolveValidFrom (bucket-dominant valid_from rule)', () => {
  // Fixed clock so "today"/"tomorrow"/"yesterday" are deterministic.
  const now = new Date('2026-06-21T10:00:00.000Z');
  const today = '2026-06-21';
  const tomorrow = '2026-06-22';
  const yesterday = '2026-06-20';

  // --- current bucket -------------------------------------------------------
  it('current + validityStart in the past → keeps that past start', () => {
    expect(resolveValidFrom(yesterday, 'current', now)).toEqual({
      validFrom: yesterday,
      forced: null,
    });
  });

  it('current + validityStart == today → keeps today', () => {
    expect(resolveValidFrom(today, 'current', now)).toEqual({ validFrom: today, forced: null });
  });

  it('current + validityStart in the FUTURE → clamped to today (forced), never future', () => {
    const resolved = resolveValidFrom('2026-07-01', 'current', now);
    expect(resolved.validFrom).toBe(today);
    expect(resolved.validFrom > today).toBe(false); // not future → Cheffity current
    expect(resolved.forced).toBe('current_forced_today');
  });

  it('current + no validityStart → today, not flagged as forced', () => {
    expect(resolveValidFrom('', 'current', now)).toEqual({ validFrom: today, forced: null });
    expect(resolveValidFrom(undefined, 'current', now)).toEqual({
      validFrom: today,
      forced: null,
    });
  });

  // --- next bucket ----------------------------------------------------------
  it('next + future validityStart → keeps that future start, not forced', () => {
    expect(resolveValidFrom('2026-07-01T00:00:00Z', 'next', now)).toEqual({
      validFrom: '2026-07-01',
      forced: null,
    });
    expect(resolveValidFrom(tomorrow, 'next', now)).toEqual({ validFrom: tomorrow, forced: null });
  });

  it('next + no validityStart → future fallback today+1 (forced), strictly future', () => {
    const resolved = resolveValidFrom('', 'next', now);
    expect(resolved.validFrom).toBe(tomorrow);
    expect(resolved.validFrom > today).toBe(true); // strictly future → excluded from current
    expect(resolved.forced).toBe('next_forced_tomorrow');
  });

  it('next + non-future validityStart (today/past) → future fallback today+1 (forced)', () => {
    const resolvedToday = resolveValidFrom(today, 'next', now);
    expect(resolvedToday.validFrom).toBe(tomorrow);
    expect(resolvedToday.validFrom > today).toBe(true);
    expect(resolvedToday.forced).toBe('next_forced_tomorrow');

    const resolvedPast = resolveValidFrom(yesterday, 'next', now);
    expect(resolvedPast.validFrom).toBe(tomorrow);
    expect(resolvedPast.validFrom > today).toBe(true); // nextWeek never becomes current
    expect(resolvedPast.forced).toBe('next_forced_tomorrow');
  });
});

describe('resolveValidTo (no zero-day windows)', () => {
  const validFrom = '2026-06-22';

  it('keeps a real validityEnd that is at or after valid_from', () => {
    expect(resolveValidTo('2026-06-28', validFrom)).toEqual({
      validTo: '2026-06-28',
      derived: null,
    });
    // Same day is a legitimate one-day promo IF the offer itself says so.
    expect(resolveValidTo(validFrom, validFrom)).toEqual({ validTo: validFrom, derived: null });
    // ISO datetimes are accepted, the date part wins.
    expect(resolveValidTo('2026-06-28T23:59:59.999Z', validFrom).validTo).toBe('2026-06-28');
  });

  it('missing or unparseable validityEnd → default window, flagged missing_end', () => {
    for (const bad of [undefined, '', 'kaputt']) {
      expect(resolveValidTo(bad, validFrom)).toEqual({
        validTo: '2026-06-28', // 2026-06-22 + 6
        derived: 'missing_end',
      });
    }
  });

  it('stale validityEnd (older than the clamped valid_from) → default window, flagged stale_end', () => {
    // This is the production case: bucket "next" forced valid_from to tomorrow
    // while the offer still carried LAST week's end date.
    expect(resolveValidTo('2026-06-15', validFrom)).toEqual({
      validTo: '2026-06-28',
      derived: 'stale_end',
    });
  });

  it('the default window is 6 days, i.e. a 7-day inclusive promo week', () => {
    expect(DEFAULT_DEAL_WINDOW_DAYS).toBe(6);
    const { validTo } = resolveValidTo(undefined, '2026-06-22');
    const days = (Date.parse(validTo) - Date.parse('2026-06-22')) / (24 * 60 * 60 * 1000);
    expect(days).toBe(6);
  });

  it('crosses month and year boundaries correctly', () => {
    expect(resolveValidTo(undefined, '2026-06-28').validTo).toBe('2026-07-04');
    expect(resolveValidTo(undefined, '2026-12-29').validTo).toBe('2027-01-04');
  });

  it('never returns a valid_to below valid_from (DB CHECK constraint)', () => {
    for (const end of [undefined, '', '1999-01-01', '2026-06-21', '2030-01-01']) {
      expect(resolveValidTo(end, validFrom).validTo >= validFrom).toBe(true);
    }
  });
});

describe('todayDate uses Europe/Berlin, not UTC', () => {
  // ROOT CAUSE: between 00:00 and 02:00 Berlin (CEST = UTC+2) the UTC date is
  // still yesterday. A sync started then stamped valid_from one day into the
  // past — that is how the 2026-06-22 REWE import wrote 103 rows dated 06-21.
  it('a sync just after Berlin midnight uses the NEW day, not the UTC yesterday', () => {
    // 2026-06-22T00:30 Berlin == 2026-06-21T22:30Z
    const justAfterBerlinMidnight = new Date('2026-06-21T22:30:00.000Z');
    expect(resolveValidFrom(undefined, 'current', justAfterBerlinMidnight).validFrom).toBe(
      '2026-06-22',
    );
    expect(resolveValidFrom(undefined, 'next', justAfterBerlinMidnight).validFrom).toBe(
      '2026-06-23',
    );
  });

  it('midday is unaffected (Berlin and UTC agree on the date)', () => {
    const midday = new Date('2026-06-21T10:00:00.000Z');
    expect(resolveValidFrom(undefined, 'current', midday).validFrom).toBe('2026-06-21');
  });

  it('also holds in winter (CET = UTC+1)', () => {
    // 2026-01-15T00:30 Berlin == 2026-01-14T23:30Z
    const winterAfterMidnight = new Date('2026-01-14T23:30:00.000Z');
    expect(resolveValidFrom(undefined, 'current', winterAfterMidnight).validFrom).toBe(
      '2026-01-15',
    );
  });
});

describe('offerToDealRow valid_from per bucket', () => {
  const now = new Date('2026-06-21T10:00:00.000Z');
  const today = '2026-06-21';
  const tomorrow = '2026-06-22';

  function makeOffer(overrides: Partial<Offer> = {}): Offer & Record<string, unknown> {
    return {
      id: 'official_abc',
      name: 'Tomaten',
      normalizedName: 'tomaten',
      storeChain: 'REWE',
      category: 'Obst & Gemüse',
      price: 1.99,
      currency: 'EUR',
      unit: 'kg',
      validityStart: '',
      validityEnd: '',
      sourceUrl: '',
      tags: [],
      createdAt: now.toISOString(),
      ...overrides,
    } as Offer & Record<string, unknown>;
  }

  it('current offer without validityStart → valid_from today, usable as current', () => {
    const row = offerToDealRow(makeOffer(), {}, 'current', now);
    expect(row.valid_from).toBe(today);
    expect(row.valid_from > today).toBe(false); // not future → current
  });

  it('current offer with a FUTURE validityStart (migrated from next) → clamped to today, current', () => {
    // The Kaufland/ALDI symptom: splitOffersByWeek moved the offer into
    // snapshot.offers, but its own validityStart is still tomorrow. The bucket
    // must win so Cheffity reads it as current, not future.
    const row = offerToDealRow(
      makeOffer({ validityStart: '2026-07-01', validityEnd: '2026-07-05' }),
      {},
      'current',
      now,
    );
    expect(row.valid_from).toBe(today);
    expect(row.valid_from > today).toBe(false); // current, not future
    // The real offer end is preserved (it is already >= today).
    expect(row.valid_to).toBe('2026-07-05');
    expect(row.valid_to >= row.valid_from).toBe(true);
  });

  it('current offer with a PAST validityStart → keeps the past start', () => {
    const row = offerToDealRow(
      makeOffer({ validityStart: '2026-06-15', validityEnd: '2026-06-28' }),
      {},
      'current',
      now,
    );
    expect(row.valid_from).toBe('2026-06-15');
    expect(row.valid_to).toBe('2026-06-28');
  });

  it('next offer with a non-future validityStart → forced future, valid_to gets a real window', () => {
    // validityEnd is "today", i.e. BEFORE the forced tomorrow valid_from. The old
    // rule collapsed valid_to onto valid_from and produced a zero-day window that
    // expired the same evening; now the bucket-consistent default window applies.
    const row = offerToDealRow(
      makeOffer({ validityStart: '2026-06-20', validityEnd: '2026-06-21' }),
      {},
      'next',
      now,
    );
    expect(row.valid_from).toBe(tomorrow);
    expect(row.valid_from > today).toBe(true); // never current
    expect(row.valid_to >= row.valid_from).toBe(true);
    expect(row.valid_to).toBe('2026-06-28'); // tomorrow + 6 days, not tomorrow
    expect(row.valid_to > row.valid_from).toBe(true); // never a zero-day window
  });

  it('nextWeek offer WITH a future validityStart → that start, not current', () => {
    const row = offerToDealRow(
      makeOffer({ validityStart: '2026-06-22', validityEnd: '2026-06-28' }),
      {},
      'next',
      now,
    );
    expect(row.valid_from).toBe(tomorrow);
    expect(row.valid_from > today).toBe(true); // future → excluded from current
    expect(row.valid_to).toBe('2026-06-28');
  });

  it('nextWeek offer WITHOUT a validityStart → future marker, never current', () => {
    const row = offerToDealRow(makeOffer(), {}, 'next', now);
    expect(row.valid_from).toBe(tomorrow);
    expect(row.valid_from > today).toBe(true); // future → not in Cheffity-current
    // valid_to is never below valid_from, and never equal to it either — a
    // zero-day window would expire the deal the day it was written.
    expect(row.valid_to >= row.valid_from).toBe(true);
    expect(row.valid_to > today).toBe(true);
    expect(row.valid_to > row.valid_from).toBe(true);
  });

  it('regression: a zero-day window may only come from the offer itself, never from a fallback', () => {
    // The production defect: 3.178 of 14.174 rows (22,4 %) had valid_from ===
    // valid_to and therefore expired the same day they were synced. REWE was left
    // with 5 usable offers out of 717.
    //
    // The invariant is NOT "never same-day" — an offer that genuinely ends today
    // is real data and must be preserved. The invariant is that a same-day window
    // may only exist when the offer's OWN validityEnd says so. A missing or stale
    // end must never silently collapse onto valid_from.
    const ends = [undefined, '', '2026-06-01', '2026-06-21', '2026-06-28', 'kaputt'];
    const starts = [undefined, '', '2026-06-01', '2026-06-21', '2026-07-01'];

    for (const bucket of ['current', 'next'] as const) {
      for (const validityStart of starts) {
        for (const validityEnd of ends) {
          const row = offerToDealRow(makeOffer({ validityStart, validityEnd }), {}, bucket, now);
          const label = `bucket=${bucket} start=${validityStart} end=${validityEnd}`;

          // DB CHECK constraint: valid_to >= valid_from, always.
          expect(row.valid_to >= row.valid_from, `constraint violated for ${label}`).toBe(true);

          if (row.valid_to === row.valid_from) {
            // Only acceptable when the offer itself declared exactly this end.
            expect(validityEnd, `unexplained zero-day window for ${label}`).toBe(row.valid_from);
          }
        }
      }
    }
  });

  it('regression: the exact production case — stale end + forced future start', () => {
    // What actually happened on 2026-08-28: offers still carrying the PREVIOUS
    // week's end date were synced into the "next" bucket, valid_from was forced
    // to tomorrow, and valid_to collapsed onto it. 74 REWE rows ended up valid
    // for a single already-past day.
    const row = offerToDealRow(
      makeOffer({ validityStart: '2026-06-15', validityEnd: '2026-06-20' }),
      {},
      'next',
      now,
    );
    expect(row.valid_from).toBe(tomorrow);
    expect(row.valid_to).toBe('2026-06-28');
    expect(row.valid_to > row.valid_from).toBe(true);
  });

  it('quality report classifies the synced rows as current vs future correctly', () => {
    // Mixed snapshot: a current offer without start and a nextWeek offer
    // without start, both produced by the real sync mapping.
    const currentRow = offerToDealRow(makeOffer({ id: 'official_cur' }), {}, 'current', now);
    const nextRow = offerToDealRow(makeOffer({ id: 'official_next' }), {}, 'next', now);

    const toQualityDeal = (r: ReturnType<typeof offerToDealRow>): QualityDeal => ({
      id: r.source_external_id,
      name: r.name,
      store_name: r.store_name,
      current_price: r.current_price,
      savings_percent: r.savings_percent,
      valid_from: r.valid_from,
      valid_to: r.valid_to,
      is_food: r.is_food,
      category: r.category,
    });

    const report = computeOfferQuality(
      { deals: [currentRow, nextRow].map(toQualityDeal), recipes: [], ingredients: [], matches: [] },
      { now },
    );

    expect(report.kpis.currentDeals).toBe(1); // only the current-bucket offer
    expect(report.kpis.futureDeals).toBe(1); // nextWeek-without-start is future, not current
  });
});

// article_id ist der Anker, mit dem ein Favorit den Wochenwechsel überlebt.
// `source_external_id` enthält `offer.id`, und `offer.id` hasht die sourceUrl —
// Lidl und ALDI NORD legen pro Aktionswoche eine NEUE Produktseite für dieselbe
// Ware an, weshalb die id wöchentlich wechselt (gemessen 2026-08-17: Lidl 0 von
// 3 Cross-Wochen-Produkten behielten ihre id, ALDI NORD 1 von 7). Ohne
// article_id auf der Deal-Zeile könnte die Favoritenliste ein neu gelistetes
// Angebot nicht mehr demselben Produkt zuordnen.
// Namen sind Reproduktions-Fixtures aus dem echten Lauf.
describe('offerToDealRow article_id (Favoriten-Anker über den Wochenwechsel)', () => {
  const now = new Date('2026-08-17T10:00:00.000Z');

  function lidlOffer(id: string, sourceUrl: string): Offer & Record<string, unknown> {
    return {
      id,
      name: 'CRIVIT Damen Funktionsshirt',
      normalizedName: 'crivit damen funktionsshirt',
      brand: 'CRIVIT',
      storeChain: 'Lidl',
      category: 'Sonstiges',
      price: 3.99,
      currency: 'EUR',
      unit: 'stk',
      validityStart: '2026-08-17',
      validityEnd: '2026-08-22',
      sourceUrl,
      tags: [],
      createdAt: now.toISOString(),
    } as Offer & Record<string, unknown>;
  }

  it('vergibt dieselbe article_id, obwohl Lidl das Produkt neu listet', () => {
    const week1 = offerToDealRow(
      lidlOffer('official_rwu3cb', 'https://www.lidl.de/p/crivit-damen-funktionsshirt/p100408786'),
      {},
      'current',
      now,
    );
    const week2 = offerToDealRow(
      lidlOffer('official_sinqne', 'https://www.lidl.de/p/crivit-damen-funktionsshirt/p100396383'),
      {},
      'current',
      now,
    );

    // Das konkrete Angebot ist ein anderes …
    expect(week1.source_external_id).not.toBe(week2.source_external_id);
    // … das Produkt aber dasselbe.
    expect(week1.article_id).toBe(week2.article_id);
    expect(week1.article_id).toMatch(/^article_v3_[0-9a-f]{16}$/);
  });

  it('trennt verschiedene Produkte weiterhin', () => {
    const shirt = offerToDealRow(
      lidlOffer('official_a', 'https://www.lidl.de/p/crivit-damen-funktionsshirt/p1'),
      {},
      'current',
      now,
    );
    const mixer = offerToDealRow(
      {
        ...lidlOffer('official_b', 'https://www.lidl.de/p/silvercrest-standmixer/p2'),
        name: 'SILVERCREST Standmixer',
        normalizedName: 'silvercrest standmixer',
        brand: 'SILVERCREST',
      },
      {},
      'current',
      now,
    );

    expect(shirt.article_id).not.toBe(mixer.article_id);
  });
});
