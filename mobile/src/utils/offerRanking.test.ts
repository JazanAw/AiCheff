import { describe, expect, it } from 'vitest';
import {
  buildMixedOfferFeed,
  rankOffers,
  scoreOffer,
  type RankableOffer,
} from './offerRanking';

const NOW = new Date('2026-05-28T12:00:00Z');

function offer(overrides: Partial<RankableOffer> = {}): RankableOffer {
  return {
    id: overrides.id ?? 'o1',
    name: 'Tomaten',
    savingsPercent: 10,
    savingsAbsolute: 0.5,
    currentPrice: 1.99,
    imageUrl: 'https://x/a.png',
    validFrom: '2026-05-25',
    validTo: '2026-06-05',
    isNational: true,
    ...overrides,
  };
}

describe('scoreOffer', () => {
  it('rewards a big discount with the big_discount reason', () => {
    const low = scoreOffer(offer({ id: 'a', savingsPercent: 5, savingsAbsolute: 0.2 }), { now: NOW });
    const high = scoreOffer(offer({ id: 'b', savingsPercent: 45, savingsAbsolute: 3 }), { now: NOW });
    expect(high.score).toBeGreaterThan(low.score);
    expect(high.reasons).toContain('big_discount');
  });

  it('boosts a favourited deal and tags it', () => {
    const base = scoreOffer(offer({ id: 'fav' }), { now: NOW });
    const fav = scoreOffer(offer({ id: 'fav' }), { now: NOW, favoriteIds: new Set(['fav']) });
    expect(fav.score).toBeGreaterThan(base.score);
    expect(fav.reasons).toContain('favorite');
  });

  // Der eigentliche Zweck des Artikel-Ankers: Lidl und ALDI NORD vergeben pro
  // Aktionswoche eine NEUE Angebots-id fuer dieselbe Ware (gemessen 2026-08-17:
  // ALDI NORD 14 % id-Stabilitaet, Lidl 0 von 3). Ohne diesen Treffer verloere
  // der Nutzer seinen Favoriten stillschweigend beim Wochenwechsel.
  it('erkennt einen Favoriten in der naechsten Woche an der Artikel-Id wieder', () => {
    const naechsteWoche = offer({ id: 'lidl-woche-36', articleId: 'article_v3_0123456789abcdef' });
    const ergebnis = scoreOffer(naechsteWoche, {
      now: NOW,
      // Die favorisierte Angebots-id von letzter Woche passt NICHT mehr.
      favoriteIds: new Set(['lidl-woche-35']),
      favoriteArticleIds: new Set(['article_v3_0123456789abcdef']),
    });
    expect(ergebnis.reasons).toContain('favorite');
    expect(ergebnis.score).toBeGreaterThan(scoreOffer(naechsteWoche, { now: NOW }).score);
  });

  it('markiert ein Angebot ohne passenden Anker nicht als Favorit', () => {
    const fremd = scoreOffer(offer({ id: 'x', articleId: 'article_v3_aaaaaaaaaaaaaaaa' }), {
      now: NOW,
      favoriteIds: new Set(['anderes-angebot']),
      favoriteArticleIds: new Set(['article_v3_bbbbbbbbbbbbbbbb']),
    });
    expect(fremd.reasons).not.toContain('favorite');
  });

  // Angebote ohne Artikel-Id (aeltere Snapshots) duerfen nicht versehentlich
  // treffen, nur weil der Favoriten-Set leer/undefiniert ist.
  it('behandelt Angebote ohne Artikel-Id unauffaellig', () => {
    const ohne = scoreOffer(offer({ id: 'x' }), {
      now: NOW,
      favoriteArticleIds: new Set(['article_v3_0123456789abcdef']),
    });
    expect(ohne.reasons).not.toContain('favorite');
  });

  it('boosts an offer that matches a still-needed recipe ingredient', () => {
    const ctx = { now: NOW, neededIngredientNames: ['frische Tomaten'] };
    const fit = scoreOffer(offer({ name: 'Bio Tomaten 500g' }), ctx);
    const noFit = scoreOffer(offer({ name: 'Schokoriegel' }), ctx);
    expect(fit.score).toBeGreaterThan(noFit.score);
    expect(fit.reasons).toContain('fits_recipe');
  });

  it('matches the shopping list as a personal signal', () => {
    const r = scoreOffer(offer({ name: 'Spaghetti' }), {
      now: NOW,
      shoppingListNames: ['spaghetti'],
    });
    expect(r.reasons).toContain('on_your_list');
  });

  it('does not hard-punish national offers without a distance', () => {
    const national = scoreOffer(offer({ id: 'n', isNational: true, distanceKm: undefined }), { now: NOW });
    const far = scoreOffer(offer({ id: 'f', isNational: false, distanceKm: 14 }), { now: NOW, searchRadiusKm: 15 });
    // National keeps a neutral 0.5 distance score → at least as good as a far local one.
    expect(national.score).toBeGreaterThanOrEqual(far.score);
  });

  it('flags soon-expiring offers without exploding the score', () => {
    const soon = scoreOffer(offer({ id: 's', validTo: '2026-05-29' }), { now: NOW });
    expect(soon.reasons).toContain('expiring_soon');
  });

  it('applies a data-quality penalty for missing image + price', () => {
    const good = scoreOffer(offer({ id: 'g' }), { now: NOW });
    const bad = scoreOffer(
      offer({ id: 'b', imageUrl: undefined, currentPrice: 0, savingsPercent: 0, savingsAbsolute: 0 }),
      { now: NOW },
    );
    expect(bad.score).toBeLessThan(good.score);
  });

  it('penalises fatigue (repeatedly shown product)', () => {
    const fresh = scoreOffer(offer({ name: 'Gouda' }), { now: NOW });
    const tired = scoreOffer(offer({ name: 'Gouda' }), {
      now: NOW,
      recentSeenCounts: new Map([[ 'gouda', 3 ]]),
    });
    expect(tired.score).toBeLessThan(fresh.score);
  });

  it('never throws and degrades on empty/garbage data', () => {
    expect(() => scoreOffer({ id: 'x', name: '' }, { now: NOW })).not.toThrow();
    const r = scoreOffer({ id: 'x', name: '' }, { now: NOW });
    expect(Number.isFinite(r.score)).toBe(true);
  });
});

describe('rankOffers', () => {
  it('orders by hybrid score, not by raw discount alone', () => {
    const offers = [
      offer({ id: 'discount', name: 'Chips', savingsPercent: 40, imageUrl: undefined, currentPrice: 0 }),
      offer({ id: 'relevant', name: 'Tomaten', savingsPercent: 12 }),
    ];
    const ranked = rankOffers(offers, {
      now: NOW,
      neededIngredientNames: ['tomaten'],
      favoriteIds: new Set(['relevant']),
    });
    expect(ranked[0].offer.id).toBe('relevant'); // relevance + clean data beat raw 40%
  });

  it('is stable for ties and returns reasons', () => {
    const offers = [offer({ id: 'a' }), offer({ id: 'b' })];
    const ranked = rankOffers(offers, { now: NOW });
    expect(ranked.map((r) => r.offer.id)).toEqual(['a', 'b']);
    expect(Array.isArray(ranked[0].reasons)).toBe(true);
  });
});

describe('buildMixedOfferFeed', () => {
  it('mixes intent buckets instead of stacking the same kind', () => {
    const offers = [
      offer({ id: 'fav', name: 'Kaffee' }),
      offer({ id: 'recipe', name: 'Zwiebeln' }),
      offer({ id: 'deal', name: 'Kekse', savingsPercent: 45, savingsAbsolute: 3 }),
      offer({ id: 'plain1', name: 'Wasser' }),
      offer({ id: 'plain2', name: 'Mehl' }),
    ];
    const feed = buildMixedOfferFeed(offers, {
      now: NOW,
      favoriteIds: new Set(['fav']),
      neededIngredientNames: ['zwiebeln'],
    }, 4);
    const ids = feed.map((f) => f.offer.id);
    // The favourite, the recipe-fit and the big-discount all surface (diverse).
    expect(ids).toContain('fav');
    expect(ids).toContain('recipe');
    expect(ids).toContain('deal');
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
  });

  it('fills remaining slots by score when buckets run out', () => {
    const offers = [offer({ id: 'a' }), offer({ id: 'b' }), offer({ id: 'c' })];
    const feed = buildMixedOfferFeed(offers, { now: NOW }, 2);
    expect(feed).toHaveLength(2);
  });

  it('caps at the limit, returns distinct ids, and is not pure-discount order', () => {
    // 10 offers: one strong-discount, one favourite, one recipe-fit, rest plain.
    const offers = [
      offer({ id: 'fav', name: 'Kaffee', savingsPercent: 8 }),
      offer({ id: 'recipe', name: 'Zwiebeln', savingsPercent: 8 }),
      offer({ id: 'discount', name: 'Kekse', savingsPercent: 50, savingsAbsolute: 4 }),
      ...Array.from({ length: 7 }, (_, i) =>
        offer({ id: `p${i}`, name: `Produkt ${i}`, savingsPercent: 5 }),
      ),
    ];
    const feed = buildMixedOfferFeed(offers, {
      now: NOW,
      favoriteIds: new Set(['fav']),
      neededIngredientNames: ['zwiebeln'],
    }, 8);
    expect(feed).toHaveLength(8);
    const ids = feed.map((f) => f.offer.id);
    expect(new Set(ids).size).toBe(8); // no duplicates
    // Personal + recipe-fit surface near the top — not just the 50%-off deal.
    expect(ids.slice(0, 3)).toEqual(expect.arrayContaining(['fav', 'recipe']));
  });
});
