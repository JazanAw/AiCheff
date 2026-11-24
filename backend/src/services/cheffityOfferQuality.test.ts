import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  computeOfferQuality,
  getCheffityOfferQuality,
  type QualityDeal,
  type QualityIngredient,
  type QualityMatch,
  type QualityRecipe,
} from './cheffityOfferQuality';

const NOW = new Date('2026-06-09T12:00:00Z'); // today = 2026-06-09

function deal(partial: Partial<QualityDeal> & { id: string }): QualityDeal {
  return {
    name: partial.id,
    store_name: 'REWE',
    current_price: 1.99,
    savings_percent: 10,
    valid_from: '2026-06-08',
    valid_to: '2026-06-15',
    is_food: true,
    category: 'other',
    ...partial,
  };
}

function recipe(id: string, name = id): QualityRecipe {
  return { id, name };
}

function ing(
  id: string,
  recipeId: string,
  name: string,
  partial: Partial<QualityIngredient> = {},
): QualityIngredient {
  return { id, recipe_id: recipeId, name, is_potential_deal: true, ...partial };
}

function match(dealId: string, ingredientId: string, score = 0.9): QualityMatch {
  return { deal_id: dealId, recipe_ingredient_id: ingredientId, match_score: score };
}

describe('computeOfferQuality — KPIs', () => {
  it('computes the core KPIs for a representative dataset', () => {
    const deals = [
      deal({ id: 'd1' }), // active + matchable, matched
      deal({ id: 'd2' }), // active + matchable, matched (low score)
      deal({ id: 'd3', is_food: false }), // active, NOT matchable (non-food)
      deal({ id: 'd4', is_food: null }), // active, NOT matchable (unknown food)
      deal({ id: 'd5', valid_from: '2026-05-01', valid_to: '2026-06-01' }), // expired
      deal({ id: 'd6', savings_percent: 40 }), // active + matchable, UNMATCHED
    ];
    const recipes = [recipe('r1'), recipe('r2')];
    const ingredients = [
      ing('i1', 'r1', 'Tomaten'),
      ing('i2', 'r1', 'Reis'),
      ing('i3', 'r2', 'Salz', { is_potential_deal: false }),
    ];
    const matches = [
      match('d1', 'i1', 0.95), // valid
      match('d2', 'i2', 0.66), // valid + low score
      match('d5', 'i3', 0.9), // deal expired
    ];

    const report = computeOfferQuality({ deals, recipes, ingredients, matches }, { now: NOW });
    const k = report.kpis;

    expect(k.activeDeals).toBe(5); // d1,d2,d3,d4,d6 (d5 expired)
    expect(k.matchableDeals).toBe(3); // d1,d2,d6 (d3 non-food, d4 null excluded)
    expect(k.activeRecipes).toBe(2);
    expect(k.recipeIngredients).toBe(3);
    expect(k.validDealMatches).toBe(2); // d1↔i1, d2↔i2
    expect(k.recipesWithValidDeals).toBe(1); // only r1
    expect(k.ingredientsWithValidDeals).toBe(2); // i1, i2
    expect(k.expiredMatches).toBe(1); // d5↔i3
    expect(k.lowScoreMatches).toBe(1); // d2↔i2 @ 0.66
    expect(k.matchCoveragePercent).toBe(67); // 2/3
    expect(k.recipeCoveragePercent).toBe(50); // 1/2
  });

  it('counts only is_food=true deals as matchable (never null or false)', () => {
    const deals = [
      deal({ id: 'food' }),
      deal({ id: 'unknown', is_food: null }),
      deal({ id: 'nonfood', is_food: false }),
    ];
    const report = computeOfferQuality(
      { deals, recipes: [], ingredients: [], matches: [] },
      { now: NOW },
    );
    expect(report.kpis.activeDeals).toBe(3);
    expect(report.kpis.matchableDeals).toBe(1);
  });

  it('separates current vs future (nextWeek) deals and never counts future as current', () => {
    const deals = [
      deal({ id: 'cur' }), // valid_from 2026-06-08 → current
      deal({ id: 'fut', valid_from: '2026-06-15', valid_to: '2026-06-22' }), // nextWeek
      deal({ id: 'old', valid_from: '2026-05-01', valid_to: '2026-06-01' }), // expired
    ];
    const report = computeOfferQuality(
      { deals, recipes: [], ingredients: [], matches: [] },
      { now: NOW },
    );
    const k = report.kpis;
    expect(k.activeDeals).toBe(2); // cur + fut (old expired)
    expect(k.currentDeals).toBe(1); // only cur
    expect(k.futureDeals).toBe(1); // only fut
    expect(k.matchableDeals).toBe(1); // future excluded by isMatchableDeal too
  });

  it('counts matches on a future deal as futureMatches, not validDealMatches', () => {
    const deals = [
      deal({ id: 'cur' }),
      deal({ id: 'fut', valid_from: '2026-06-15', valid_to: '2026-06-22' }),
    ];
    const ingredients = [ing('i1', 'r1', 'Tomaten'), ing('i2', 'r1', 'Lachs')];
    const matches = [match('cur', 'i1', 0.9), match('fut', 'i2', 0.9)];
    const report = computeOfferQuality(
      { deals, recipes: [recipe('r1')], ingredients, matches },
      { now: NOW },
    );
    const k = report.kpis;
    expect(k.validDealMatches).toBe(1); // only cur↔i1
    expect(k.futureMatches).toBe(1); // fut↔i2 — excluded from current UI
    expect(k.expiredMatches).toBe(0);
    expect(k.ingredientsWithValidDeals).toBe(1); // only i1
    expect(report.warnings.some((w) => w.includes('zukünftige'))).toBe(true);
  });

  it('counts matches whose deal has expired as expiredMatches', () => {
    const deals = [deal({ id: 'old', valid_from: '2026-05-01', valid_to: '2026-06-01' })];
    const ingredients = [ing('i1', 'r1', 'Tomaten')];
    const matches = [match('old', 'i1', 0.9)];
    const report = computeOfferQuality(
      { deals, recipes: [recipe('r1')], ingredients, matches },
      { now: NOW },
    );
    expect(report.kpis.expiredMatches).toBe(1);
    expect(report.kpis.validDealMatches).toBe(0);
  });

  it('flags valid matches below the (configurable) low-score threshold', () => {
    const deals = [deal({ id: 'd1' }), deal({ id: 'd2' })];
    const ingredients = [ing('i1', 'r1', 'A'), ing('i2', 'r1', 'B')];
    const matches = [match('d1', 'i1', 0.71), match('d2', 'i2', 0.9)];
    const report = computeOfferQuality(
      { deals, recipes: [recipe('r1')], ingredients, matches },
      { now: NOW, lowScoreThreshold: 0.72 },
    );
    expect(report.kpis.lowScoreMatches).toBe(1);
  });

  it('derives recipeCoveragePercent from recipes with at least one valid deal', () => {
    const deals = [deal({ id: 'd1' })];
    const recipes = [recipe('r1'), recipe('r2'), recipe('r3'), recipe('r4')];
    const ingredients = [ing('i1', 'r1', 'Tomaten')];
    const matches = [match('d1', 'i1', 0.9)];
    const report = computeOfferQuality({ deals, recipes, ingredients, matches }, { now: NOW });
    expect(report.kpis.recipeCoveragePercent).toBe(25); // 1/4
  });

  it('derives matchCoveragePercent from ingredients with at least one valid deal', () => {
    const deals = [deal({ id: 'd1' })];
    const ingredients = [
      ing('i1', 'r1', 'Tomaten'),
      ing('i2', 'r1', 'Reis'),
      ing('i3', 'r1', 'Salz'),
      ing('i4', 'r1', 'Pfeffer'),
    ];
    const matches = [match('d1', 'i1', 0.9)];
    const report = computeOfferQuality(
      { deals, recipes: [recipe('r1')], ingredients, matches },
      { now: NOW },
    );
    expect(report.kpis.matchCoveragePercent).toBe(25); // 1/4
  });

  it('returns stable zero KPIs and empty lists for empty input', () => {
    const report = computeOfferQuality(
      { deals: [], recipes: [], ingredients: [], matches: [] },
      { now: NOW },
    );
    expect(report.kpis).toMatchObject({
      activeDeals: 0,
      matchableDeals: 0,
      activeRecipes: 0,
      recipeIngredients: 0,
      validDealMatches: 0,
      recipesWithValidDeals: 0,
      ingredientsWithValidDeals: 0,
      expiredMatches: 0,
      lowScoreMatches: 0,
      matchCoveragePercent: 0,
      recipeCoveragePercent: 0,
    });
    expect(report.topUnmatchedDeals).toEqual([]);
    expect(report.topUnmatchedIngredients).toEqual([]);
    expect(report.reviewCandidates).toEqual([]);
  });
});

describe('computeOfferQuality — confidence & suspicious', () => {
  it('counts high-confidence vs review (medium/low) valid matches', () => {
    const deals = [deal({ id: 'd1' }), deal({ id: 'd2' }), deal({ id: 'd3' })];
    const ingredients = [ing('i1', 'r1', 'A'), ing('i2', 'r1', 'B'), ing('i3', 'r1', 'C')];
    const matches = [
      match('d1', 'i1', 0.95), // high
      match('d2', 'i2', 0.8), // medium → review
      match('d3', 'i3', 0.68), // low → review
    ];
    const report = computeOfferQuality(
      { deals, recipes: [recipe('r1')], ingredients, matches },
      { now: NOW },
    );
    expect(report.kpis.highConfidenceMatches).toBe(1);
    expect(report.kpis.reviewMatches).toBe(2);
    expect(report.kpis.validDealMatches).toBe(3);
  });

  it('flags a valid match that the current rules would reject as suspicious', () => {
    // A persisted match Reis ↔ "Reis Waffeln" (derived product) — a false positive.
    const deals = [
      deal({ id: 'good', name: 'Basmati Reis' }),
      deal({ id: 'bad', name: 'Reis Waffeln' }),
    ];
    const ingredients = [ing('i1', 'r1', 'Reis'), ing('i2', 'r1', 'Reis')];
    const matches = [match('good', 'i1', 0.95), match('bad', 'i2', 0.9)];
    const report = computeOfferQuality(
      { deals, recipes: [recipe('r1')], ingredients, matches },
      { now: NOW },
    );
    expect(report.kpis.suspiciousMatches).toBe(1);
    expect(report.suspiciousMatches).toHaveLength(1);
    expect(report.suspiciousMatches[0]).toMatchObject({
      dealName: 'Reis Waffeln',
      ingredientName: 'Reis',
      reason: 'derived_product',
    });
    expect(report.warnings.some((w) => w.includes('verdächtige'))).toBe(true);
  });

  it('does NOT flag a curated (verified/admin) match as suspicious', () => {
    const deals = [deal({ id: 'bad', name: 'Reis Waffeln' })];
    const ingredients = [ing('i1', 'r1', 'Reis')];
    const matches: QualityMatch[] = [
      { deal_id: 'bad', recipe_ingredient_id: 'i1', match_score: 0.9, is_verified: true },
    ];
    const report = computeOfferQuality(
      { deals, recipes: [recipe('r1')], ingredients, matches },
      { now: NOW },
    );
    expect(report.kpis.suspiciousMatches).toBe(0);
    expect(report.suspiciousMatches).toEqual([]);

    const adminMatches: QualityMatch[] = [
      { deal_id: 'bad', recipe_ingredient_id: 'i1', match_score: 0.9, matched_by_admin: 'admin-uuid' },
    ];
    const adminReport = computeOfferQuality(
      { deals, recipes: [recipe('r1')], ingredients, matches: adminMatches },
      { now: NOW },
    );
    expect(adminReport.kpis.suspiciousMatches).toBe(0);
  });

  it('never flags a future-deal match as suspicious (current-only)', () => {
    const deals = [deal({ id: 'fut', name: 'Reis Waffeln', valid_from: '2026-06-15', valid_to: '2026-06-22' })];
    const ingredients = [ing('i1', 'r1', 'Reis')];
    const matches = [match('fut', 'i1', 0.9)];
    const report = computeOfferQuality(
      { deals, recipes: [recipe('r1')], ingredients, matches },
      { now: NOW },
    );
    expect(report.kpis.futureMatches).toBe(1);
    expect(report.kpis.suspiciousMatches).toBe(0);
  });
});

describe('computeOfferQuality — quality lists', () => {
  it('topUnmatchedDeals excludes matched deals and sorts by discount then price', () => {
    const deals = [
      deal({ id: 'matched', savings_percent: 90 }),
      deal({ id: 'lowSave', savings_percent: 30, current_price: 0.99 }),
      deal({ id: 'highSavePricy', savings_percent: 50, current_price: 1.99 }),
      deal({ id: 'highSaveCheap', savings_percent: 50, current_price: 0.5 }),
    ];
    const ingredients = [ing('i1', 'r1', 'Tomaten')];
    const matches = [match('matched', 'i1', 0.9)];
    const report = computeOfferQuality(
      { deals, recipes: [recipe('r1')], ingredients, matches },
      { now: NOW },
    );
    expect(report.topUnmatchedDeals.map((d) => d.id)).toEqual([
      'highSaveCheap',
      'highSavePricy',
      'lowSave',
    ]);
    expect(report.topUnmatchedDeals[0].reason).toBe('no_recipe_ingredient_match');
  });

  it('topUnmatchedIngredients groups duplicate ingredient names into one row with a count', () => {
    const ingredients = [
      ing('i1', 'r1', 'Tomaten'),
      ing('i2', 'r2', 'Tomaten'),
      ing('i3', 'r1', 'tomaten'), // same after normalization
      ing('i4', 'r2', 'Reis'),
    ];
    const report = computeOfferQuality(
      { deals: [], recipes: [recipe('r1'), recipe('r2')], ingredients, matches: [] },
      { now: NOW },
    );
    expect(report.topUnmatchedIngredients).toHaveLength(2);
    const tomato = report.topUnmatchedIngredients.find((x) =>
      x.ingredientName.toLowerCase().includes('tomaten'),
    );
    expect(tomato?.count).toBe(3);
    expect(report.topUnmatchedIngredients[0].reason).toBe('no_active_deal_match');
  });

  it('topUnmatchedIngredients prefers is_potential_deal ingredients first', () => {
    const ingredients = [
      ing('i1', 'r1', 'Beilage', { is_potential_deal: false }),
      ing('i2', 'r1', 'Tomaten', { is_potential_deal: true }),
    ];
    const report = computeOfferQuality(
      { deals: [], recipes: [recipe('r1')], ingredients, matches: [] },
      { now: NOW },
    );
    expect(report.topUnmatchedIngredients[0].ingredientName).toBe('Tomaten');
  });

  it('reviewCandidates lists low-score matches ascending and dedupes equal deal/ingredient pairs', () => {
    const deals = [
      deal({ id: 'd1', name: 'Tomaten Aktion' }),
      deal({ id: 'd2', name: 'Reis Aktion' }),
      deal({ id: 'd3', name: 'Tomaten Aktion' }), // same product name as d1
    ];
    const ingredients = [
      ing('i1', 'r1', 'Tomaten'),
      ing('i2', 'r1', 'Reis'),
      ing('i3', 'r2', 'Tomaten'),
    ];
    const matches = [
      match('d1', 'i1', 0.7),
      match('d2', 'i2', 0.5),
      match('d3', 'i3', 0.6), // dedupes with d1↔i1 (Tomaten Aktion / Tomaten), keeps lowest 0.6
      match('d1', 'i1', 0.71), // (same pair as first; defensive — keep lowest)
    ];
    const report = computeOfferQuality(
      { deals, recipes: [recipe('r1'), recipe('r2')], ingredients, matches },
      { now: NOW, lowScoreThreshold: 0.72 },
    );
    // Two distinct (dealName|ingredientName) combos: "Reis Aktion|Reis" @0.5 and
    // "Tomaten Aktion|Tomaten" @0.6 — sorted ascending.
    expect(report.reviewCandidates.map((r) => r.score)).toEqual([0.5, 0.6]);
    expect(report.reviewCandidates[0].reason).toBe('low_score');
  });

  it('respects the listLimit option across all lists', () => {
    const deals = Array.from({ length: 30 }, (_, i) =>
      deal({ id: `u${i}`, savings_percent: i }),
    );
    const report = computeOfferQuality(
      { deals, recipes: [], ingredients: [], matches: [] },
      { now: NOW, listLimit: 5 },
    );
    expect(report.topUnmatchedDeals).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// IO read strategy — guards against the Supabase `max-rows` truncation bug
// where active deals fell out of the report behind thousands of expired rows.
// ---------------------------------------------------------------------------

/** Minimal Supabase query stub that faithfully emulates the bits the report
 *  uses (`select`/`eq`/`gte`/`in`/`order`/`range`) AND the server `max-rows`
 *  cap: a query without an honored `.range()` returns at most MAX_ROWS rows. */
const MAX_ROWS = 1000;

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: ((r: Row) => boolean)[] = [];
  private orders: { col: string; asc: boolean }[] = [];
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;

  constructor(private rows: Row[]) {}

  select(): this {
    return this;
  }
  eq(col: string, val: unknown): this {
    // Dotted columns (e.g. "recipes.status") are embedded-table filters — the
    // fixtures only hold already-active rows, so treat them as a no-op.
    if (!col.includes('.')) this.filters.push((r) => r[col] === val);
    return this;
  }
  gte(col: string, val: unknown): this {
    this.filters.push((r) => String(r[col] ?? '') >= String(val));
    return this;
  }
  in(col: string, vals: unknown[]): this {
    const set = new Set(vals.map(String));
    this.filters.push((r) => set.has(String(r[col])));
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orders.push({ col, asc: opts?.ascending !== false });
    return this;
  }
  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  private result(): { data: Row[]; error: null } {
    let data = this.rows.filter((r) => this.filters.every((f) => f(r)));
    for (const { col, asc } of [...this.orders].reverse()) {
      data = data
        .slice()
        .sort((a, b) => String(a[col]).localeCompare(String(b[col])) * (asc ? 1 : -1));
    }
    if (this.rangeFrom != null && this.rangeTo != null) {
      // PostgREST still caps a page at max-rows even when range asks for more.
      const end = Math.min(this.rangeTo + 1, this.rangeFrom + MAX_ROWS);
      data = data.slice(this.rangeFrom, end);
    } else {
      data = data.slice(0, MAX_ROWS); // unbounded query → silent server cap
    }
    return { data, error: null };
  }

  // Thenable so `await query` resolves like a real PostgREST builder.
  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    return Promise.resolve(this.result()).then(resolve);
  }
}

function fakeClient(tables: {
  deals: Row[];
  recipes?: Row[];
  recipe_ingredients?: Row[];
  deal_recipe_matches?: Row[];
}): SupabaseClient {
  const store: Record<string, Row[]> = {
    deals: tables.deals,
    recipes: tables.recipes ?? [],
    recipe_ingredients: tables.recipe_ingredients ?? [],
    deal_recipe_matches: tables.deal_recipe_matches ?? [],
  };
  return {
    from(table: string) {
      return new FakeQuery(store[table] ?? []);
    },
  } as unknown as SupabaseClient;
}

describe('getCheffityOfferQuality — read strategy (max-rows / pagination)', () => {
  it('counts active/future deals even behind >1000 old expired rows', async () => {
    // 1500 expired (small ids → would sort/page first) + 365 future deals.
    const expired: Row[] = Array.from({ length: 1500 }, (_, i) => ({
      id: `e${String(i).padStart(5, '0')}`,
      name: `Alt ${i}`,
      store_name: 'REWE',
      current_price: 1.99,
      savings_percent: 10,
      valid_from: '2026-05-01',
      valid_to: '2026-06-01', // < today
      is_food: true,
      category: 'other',
    }));
    const future: Row[] = Array.from({ length: 365 }, (_, i) => ({
      id: `z${String(i).padStart(5, '0')}`,
      name: `Neu ${i}`,
      store_name: 'REWE',
      current_price: 2.49,
      savings_percent: 20,
      valid_from: '2026-06-29', // > today → future
      valid_to: '2026-07-05',
      is_food: true,
      category: 'other',
    }));

    const client = fakeClient({ deals: [...expired, ...future] });
    const report = await getCheffityOfferQuality(client, { now: NOW });
    const k = report.kpis;

    expect(k.activeDeals).toBe(365); // future deals are active (valid_to >= today)
    expect(k.futureDeals).toBe(365);
    expect(k.currentDeals).toBe(0);
    expect(k.matchableDeals).toBe(0); // future excluded from matchable
    // The fatal "no active deals" warning must NOT fire when active > 0.
    expect(report.warnings.some((w) => w.includes('Keine aktiven Deals'))).toBe(false);
    // Honest nextWeek hint instead.
    expect(report.warnings.some((w) => w.includes('zukünftige'))).toBe(true);
  });

  it('back-fills an expired deal referenced by a match so expiredMatches is exact', async () => {
    const deals: Row[] = [
      // one current active deal
      {
        id: 'cur1',
        name: 'Tomaten',
        store_name: 'REWE',
        current_price: 1.0,
        savings_percent: 10,
        valid_from: '2026-06-08',
        valid_to: '2026-06-15',
        is_food: true,
        category: 'other',
      },
      // an expired deal — NOT returned by the active (valid_to>=today) query,
      // only reachable via the by-id back-fill.
      {
        id: 'old1',
        name: 'Reis',
        store_name: 'REWE',
        current_price: 1.0,
        savings_percent: 10,
        valid_from: '2026-05-01',
        valid_to: '2026-06-01',
        is_food: true,
        category: 'other',
      },
    ];
    const recipes: Row[] = [{ id: 'r1', name: 'Rezept', status: 'active' }];
    const recipe_ingredients: Row[] = [
      { id: 'i1', recipe_id: 'r1', name: 'Tomaten', is_potential_deal: true },
      { id: 'i2', recipe_id: 'r1', name: 'Reis', is_potential_deal: true },
    ];
    const deal_recipe_matches: Row[] = [
      { deal_id: 'cur1', recipe_ingredient_id: 'i1', match_score: 0.95 },
      { deal_id: 'old1', recipe_ingredient_id: 'i2', match_score: 0.95 }, // expired
    ];

    const client = fakeClient({ deals, recipes, recipe_ingredients, deal_recipe_matches });
    const report = await getCheffityOfferQuality(client, { now: NOW });
    const k = report.kpis;

    expect(k.validDealMatches).toBe(1); // cur1↔i1
    expect(k.expiredMatches).toBe(1); // old1↔i2 — only correct if old1 was back-filled
  });

  it('counts futureMatches separately, never as validDealMatches', async () => {
    const deals: Row[] = [
      {
        id: 'fut1',
        name: 'Lachs',
        store_name: 'REWE',
        current_price: 5.0,
        savings_percent: 10,
        valid_from: '2026-06-29',
        valid_to: '2026-07-05',
        is_food: true,
        category: 'other',
      },
    ];
    const recipes: Row[] = [{ id: 'r1', name: 'Rezept', status: 'active' }];
    const recipe_ingredients: Row[] = [
      { id: 'i1', recipe_id: 'r1', name: 'Lachs', is_potential_deal: true },
    ];
    const deal_recipe_matches: Row[] = [
      { deal_id: 'fut1', recipe_ingredient_id: 'i1', match_score: 0.95 },
    ];

    const client = fakeClient({ deals, recipes, recipe_ingredients, deal_recipe_matches });
    const report = await getCheffityOfferQuality(client, { now: NOW });

    expect(report.kpis.futureMatches).toBe(1);
    expect(report.kpis.validDealMatches).toBe(0);
    expect(report.kpis.expiredMatches).toBe(0);
  });

  it('pages recipes/ingredients/matches past the max-rows cap', async () => {
    // 365 future deals + a matches table larger than one page.
    const deals: Row[] = Array.from({ length: 365 }, (_, i) => ({
      id: `z${String(i).padStart(5, '0')}`,
      name: `Neu ${i}`,
      store_name: 'REWE',
      current_price: 2.49,
      savings_percent: 20,
      valid_from: '2026-06-08', // current
      valid_to: '2026-06-15',
      is_food: true,
      category: 'other',
    }));
    const recipes: Row[] = [{ id: 'r1', name: 'Rezept', status: 'active' }];
    const recipe_ingredients: Row[] = deals.map((d, i) => ({
      id: `i${String(i).padStart(5, '0')}`,
      recipe_id: 'r1',
      name: `Zutat ${i}`,
      is_potential_deal: true,
    }));
    // 1200 matches → 2 pages; all valid (current food deals).
    const deal_recipe_matches: Row[] = Array.from({ length: 1200 }, (_, i) => ({
      deal_id: `z${String(i % 365).padStart(5, '0')}`,
      recipe_ingredient_id: `i${String(i % 365).padStart(5, '0')}`,
      match_score: 0.95,
    }));

    const client = fakeClient({ deals, recipes, recipe_ingredients, deal_recipe_matches });
    const report = await getCheffityOfferQuality(client, { now: NOW });

    expect(report.kpis.activeDeals).toBe(365);
    expect(report.kpis.currentDeals).toBe(365);
    // 365 distinct (deal,ingredient) pairs are valid; the extra duplicates are
    // also valid matches → all 1200 counted (proves the 2nd page was read).
    expect(report.kpis.validDealMatches).toBe(1200);
  });
});
