import { describe, expect, it } from 'vitest';
import {
  analyzeNameMatch,
  classifyMatchConfidence,
  computeMatchPlan,
  isMatchableDeal,
  matchDealsToRecipeIngredients,
  scoreDealForIngredient,
  type MatcherDeal,
  type MatcherIngredient,
} from './dealRecipeMatcher';

// Fixed "today" used across the suite. Deals validity windows are anchored to it.
const NOW = new Date('2026-06-09T12:00:00Z');

function deal(
  partial: Partial<MatcherDeal> & { id: string; name: string },
): MatcherDeal {
  return {
    store_name: 'REWE',
    current_price: 1.99,
    original_price: 2.99,
    savings_percent: 33,
    valid_from: '2026-06-08',
    valid_to: '2026-06-15',
    ingredients: [],
    is_food: true,
    category: 'other',
    ...partial,
  };
}

function ing(id: string, name: string, recipeId = 'r1'): MatcherIngredient {
  return { id, recipe_id: recipeId, name, is_potential_deal: true };
}

describe('isMatchableDeal', () => {
  it('accepts an active, priced food deal', () => {
    expect(isMatchableDeal(deal({ id: 'd1', name: 'Tomaten' }), NOW)).toBe(true);
  });

  it('rejects non-food deals (is_food=false)', () => {
    expect(
      isMatchableDeal(deal({ id: 'd1', name: 'Spülmittel', is_food: false }), NOW),
    ).toBe(false);
  });

  it('does not blindly match deals with unknown food status (is_food=null)', () => {
    expect(
      isMatchableDeal(deal({ id: 'd1', name: 'Etwas', is_food: null }), NOW),
    ).toBe(false);
  });

  it('rejects expired deals (valid_to before today)', () => {
    expect(
      isMatchableDeal(
        deal({ id: 'd1', name: 'Tomaten', valid_to: '2026-06-01' }),
        NOW,
      ),
    ).toBe(false);
  });

  it('rejects not-yet-started deals (valid_from after today)', () => {
    expect(
      isMatchableDeal(
        deal({ id: 'd1', name: 'Tomaten', valid_from: '2026-06-20', valid_to: '2026-06-25' }),
        NOW,
      ),
    ).toBe(false);
  });

  it('tolerates a missing valid_from', () => {
    expect(
      isMatchableDeal(deal({ id: 'd1', name: 'Tomaten', valid_from: null }), NOW),
    ).toBe(true);
  });

  it('rejects deals without a positive price', () => {
    expect(
      isMatchableDeal(deal({ id: 'd1', name: 'Tomaten', current_price: 0 }), NOW),
    ).toBe(false);
  });
});

describe('scoreDealForIngredient — linguistic rules', () => {
  it('matches "Tomaten" against "Cherry Tomaten" with a strong exact score', () => {
    const m = scoreDealForIngredient(deal({ id: 'd', name: 'Cherry Tomaten' }), ing('i', 'Tomaten'));
    expect(m).not.toBeNull();
    expect(m!.score).toBeGreaterThanOrEqual(0.9);
  });

  it('matches singular "Tomate" against plural "Cherry Tomaten"', () => {
    const m = scoreDealForIngredient(deal({ id: 'd', name: 'Cherry Tomaten' }), ing('i', 'Tomate'));
    expect(m).not.toBeNull();
    expect(m!.score).toBeGreaterThanOrEqual(0.85);
  });

  it('matches "Hackfleisch" against the compound "Rinderhackfleisch"', () => {
    const m = scoreDealForIngredient(
      deal({ id: 'd', name: 'Rinderhackfleisch' }),
      ing('i', 'Hackfleisch'),
    );
    expect(m).not.toBeNull();
    expect(m!.score).toBeGreaterThanOrEqual(0.65);
  });

  it('matches "Reis" against "Basmati Reis"', () => {
    const m = scoreDealForIngredient(deal({ id: 'd', name: 'Basmati Reis' }), ing('i', 'Reis'));
    expect(m).not.toBeNull();
  });

  it('does NOT match "Reis" against "Reiswaffeln"', () => {
    const m = scoreDealForIngredient(deal({ id: 'd', name: 'Reiswaffeln' }), ing('i', 'Reis'));
    expect(m).toBeNull();
  });

  it('matches the short/dangerous "Öl" only on a strong compound (Rapsöl)', () => {
    expect(
      scoreDealForIngredient(deal({ id: 'd', name: 'Rapsöl' }), ing('i', 'Öl')),
    ).not.toBeNull();
    // a weak, unrelated food deal must not match the dangerous "Öl"
    expect(
      scoreDealForIngredient(deal({ id: 'd', name: 'Tomaten' }), ing('i', 'Öl')),
    ).toBeNull();
  });

  it('matches "Milch" against "Milch" and "Vollmilch" but not "Milchschokolade"', () => {
    expect(
      scoreDealForIngredient(deal({ id: 'd', name: 'Frische Milch' }), ing('i', 'Milch')),
    ).not.toBeNull();
    expect(
      scoreDealForIngredient(deal({ id: 'd', name: 'Vollmilch 3,5%' }), ing('i', 'Milch')),
    ).not.toBeNull();
    expect(
      scoreDealForIngredient(deal({ id: 'd', name: 'Milchschokolade' }), ing('i', 'Milch')),
    ).toBeNull();
  });

  it('handles the short plural "Ei" → "Eier" but not the look-alike "Eis"', () => {
    expect(scoreDealForIngredient(deal({ id: 'd', name: 'Bio Eier' }), ing('i', 'Ei'))).not.toBeNull();
    expect(scoreDealForIngredient(deal({ id: 'd', name: 'Eis am Stiel' }), ing('i', 'Ei'))).toBeNull();
  });

  // --- Positive variety/compound matches (must keep working) ---------------
  it('matches "Tomaten" against the compound "Rispentomaten"', () => {
    const m = scoreDealForIngredient(deal({ id: 'd', name: 'Rispentomaten' }), ing('i', 'Tomaten'));
    expect(m).not.toBeNull();
  });

  it('matches "Käse" against "Gouda Käse" (exact) and "Reibekäse" (compound)', () => {
    expect(
      scoreDealForIngredient(deal({ id: 'd', name: 'Gouda Käse' }), ing('i', 'Käse')),
    ).not.toBeNull();
    expect(
      scoreDealForIngredient(deal({ id: 'd', name: 'Reibekäse' }), ing('i', 'Käse')),
    ).not.toBeNull();
  });

  // --- Negative token conflicts: derived products (sauce/cake/dessert/…) -----
  it('does NOT match a raw ingredient against a derived product, incl. spaced compounds', () => {
    const cases: Array<[string, string]> = [
      ['Reiswaffeln', 'Reis'],
      ['Reis Waffeln', 'Reis'],
      ['Käsekuchen', 'Käse'],
      ['Käse Kuchen', 'Käse'],
      ['Sahnedessert', 'Sahne'],
      ['Sahne Dessert', 'Sahne'],
      ['Tomatensauce', 'Tomate'],
      ['Tomaten Sauce', 'Tomaten'],
      ['Milchreis', 'Milch'],
    ];
    for (const [dealName, ingName] of cases) {
      expect(
        scoreDealForIngredient(deal({ id: 'd', name: dealName }), ing('i', ingName)),
        `${dealName} ↔ ${ingName} must not match`,
      ).toBeNull();
    }
  });

  it('still matches when the ingredient itself asks for the derived product', () => {
    // "Tomatensauce" recipe ingredient ↔ "Tomatensauce" deal is a real match.
    expect(
      scoreDealForIngredient(deal({ id: 'd', name: 'Tomatensauce' }), ing('i', 'Tomatensauce')),
    ).not.toBeNull();
    // generic "Sauce" ↔ "Tomatensauce" (compound) is allowed.
    expect(
      scoreDealForIngredient(deal({ id: 'd', name: 'Tomatensauce' }), ing('i', 'Sauce')),
    ).not.toBeNull();
  });

  it('does not reject a non-derived compound by mistake (Rinderhackfleisch)', () => {
    expect(
      scoreDealForIngredient(deal({ id: 'd', name: 'Rinderhackfleisch' }), ing('i', 'Hackfleisch')),
    ).not.toBeNull();
  });

  // --- Confidence classes --------------------------------------------------
  it('classifies exact/plural matches as high and compound matches as medium', () => {
    const exact = scoreDealForIngredient(deal({ id: 'd', name: 'Frische Milch' }), ing('i', 'Milch'));
    const plural = scoreDealForIngredient(deal({ id: 'd', name: 'Cherry Tomaten' }), ing('i', 'Tomate'));
    const compound = scoreDealForIngredient(
      deal({ id: 'd', name: 'Rinderhackfleisch' }),
      ing('i', 'Hackfleisch'),
    );
    expect(exact!.confidence).toBe('high');
    expect(plural!.confidence).toBe('high');
    expect(compound!.confidence).toBe('medium');
  });

  it('classifyMatchConfidence maps the score bands and the floor', () => {
    expect(classifyMatchConfidence(0.95)).toBe('high');
    expect(classifyMatchConfidence(0.85)).toBe('high');
    expect(classifyMatchConfidence(0.8)).toBe('medium');
    expect(classifyMatchConfidence(0.72)).toBe('medium');
    expect(classifyMatchConfidence(0.7)).toBe('low');
    expect(classifyMatchConfidence(0.64)).toBe('reject');
  });

  it('weights a match coming from the deal ingredients[] array', () => {
    const viaName = scoreDealForIngredient(
      deal({ id: 'd', name: 'Cherry Tomaten' }),
      ing('i', 'Tomaten'),
    );
    const viaArray = scoreDealForIngredient(
      deal({ id: 'd', name: 'Pizza Margherita', ingredients: ['Tomaten', 'Mozzarella'] }),
      ing('i', 'Tomaten'),
    );
    expect(viaArray).not.toBeNull();
    expect(viaArray!.fromIngredientsArray).toBe(true);
    expect(viaName!.fromIngredientsArray).toBe(false);
  });
});

describe('analyzeNameMatch', () => {
  it('accepts a clean head-noun match', () => {
    const a = analyzeNameMatch('Cherry Tomaten', 'Tomaten');
    expect(a.matched).toBe(true);
    expect(a.rejectReason).toBeNull();
    expect(a.confidence).toBe('high');
  });

  it('flags a derived-product conflict as the rejection reason', () => {
    const a = analyzeNameMatch('Reis Waffeln', 'Reis');
    expect(a.matched).toBe(false);
    expect(a.rejectReason).toBe('derived_product');
  });

  it('flags a no-head-noun pair (unrelated names)', () => {
    const a = analyzeNameMatch('Spülmittel', 'Tomaten');
    expect(a.matched).toBe(false);
    expect(a.rejectReason).toBe('no_head_noun');
  });
});

describe('computeMatchPlan', () => {
  it('excludes non-food, expired and unknown-food deals from candidates', () => {
    const deals = [
      deal({ id: 'ok', name: 'Tomaten' }),
      deal({ id: 'nonfood', name: 'Tomaten', is_food: false }),
      deal({ id: 'unknown', name: 'Tomaten', is_food: null }),
      deal({ id: 'expired', name: 'Tomaten', valid_to: '2026-06-01' }),
    ];
    const plan = computeMatchPlan(deals, [ing('i', 'Tomaten')], { now: NOW });
    const dealIds = plan.selectedMatches.map((m) => m.deal_id);
    expect(dealIds).toEqual(['ok']);
  });

  it('keeps at most 3 matches per ingredient, preferring higher discount', () => {
    const deals = [10, 20, 30, 40, 50].map((s) =>
      deal({ id: `d${s}`, name: 'Tomaten', savings_percent: s }),
    );
    const plan = computeMatchPlan(deals, [ing('i', 'Tomaten')], { now: NOW });
    expect(plan.selectedMatches).toHaveLength(3);
    expect(plan.selectedMatches.map((m) => m.savingsPercent)).toEqual([50, 40, 30]);
  });

  it('ranks a stronger (exact) match above a weaker (compound) one', () => {
    const deals = [
      deal({ id: 'compound', name: 'Rinderhackfleisch', savings_percent: 90 }),
      deal({ id: 'exact', name: 'Hackfleisch', savings_percent: 10 }),
    ];
    const plan = computeMatchPlan(deals, [ing('i', 'Hackfleisch')], { now: NOW });
    expect(plan.selectedMatches[0].deal_id).toBe('exact');
  });

  it('breaks score ties by discount, then by lower price', () => {
    const deals = [
      deal({ id: 'cheapHighSave', name: 'Tomaten', savings_percent: 50, current_price: 0.99 }),
      deal({ id: 'pricyHighSave', name: 'Tomaten', savings_percent: 50, current_price: 1.99 }),
      deal({ id: 'lowSave', name: 'Tomaten', savings_percent: 20, current_price: 0.5 }),
    ];
    const plan = computeMatchPlan(deals, [ing('i', 'Tomaten')], { now: NOW });
    expect(plan.selectedMatches.map((m) => m.deal_id)).toEqual([
      'cheapHighSave',
      'pricyHighSave',
      'lowSave',
    ]);
  });

  it('drops matches below the minimum score and reports no fake matches', () => {
    const plan = computeMatchPlan(
      [deal({ id: 'd', name: 'Reiswaffeln' })],
      [ing('i', 'Reis')],
      { now: NOW },
    );
    expect(plan.selectedMatches).toHaveLength(0);
    expect(plan.candidateMatches).toBe(0);
  });

  it('counts distinct recipes that received matches', () => {
    const deals = [deal({ id: 'd', name: 'Tomaten' })];
    const plan = computeMatchPlan(
      deals,
      [ing('a', 'Tomaten', 'r1'), ing('b', 'Tomaten', 'r2'), ing('c', 'Zucker', 'r3')],
      { now: NOW },
    );
    expect(plan.recipesWithMatches).toBe(2);
  });

  it('does not schedule verified admin pairs for writing', () => {
    const deals = [deal({ id: 'd', name: 'Tomaten' })];
    const verifiedPairs = new Set(['d|i']);
    const plan = computeMatchPlan(deals, [ing('i', 'Tomaten')], {
      now: NOW,
      verifiedPairs,
    });
    // the pair is still a recognised candidate …
    expect(plan.selectedMatches.map((m) => m.deal_id)).toContain('d');
    // … but it is excluded from the rows we would upsert, leaving the admin row intact
    expect(plan.writeMatches).toHaveLength(0);
  });
});

// ---- IO-level behaviour with a fake Supabase client -----------------------

interface FakeRow {
  [key: string]: unknown;
}

function makeFakeClient(data: {
  deals: FakeRow[];
  ingredients: FakeRow[];
  verified?: FakeRow[];
  expiredDealIds?: string[];
}) {
  const calls = {
    upserts: [] as { rows: FakeRow[] }[],
    deletes: [] as { dealIds: unknown }[],
  };

  function resolve(state: { table: string; op: string; cols: string }): {
    data: FakeRow[] | null;
    error: null;
  } {
    if (state.op === 'select') {
      if (state.table === 'deals') {
        if (state.cols.trim() === 'id') {
          return { data: (data.expiredDealIds ?? []).map((id) => ({ id })), error: null };
        }
        return { data: data.deals, error: null };
      }
      if (state.table === 'recipe_ingredients') return { data: data.ingredients, error: null };
      if (state.table === 'deal_recipe_matches') return { data: data.verified ?? [], error: null };
    }
    return { data: [], error: null };
  }

  const client = {
    from(table: string) {
      const state = { table, op: 'select', cols: '' };
      const builder: Record<string, unknown> = {
        select(cols: string) {
          state.op = 'select';
          state.cols = cols;
          return builder;
        },
        upsert(rows: FakeRow[]) {
          state.op = 'upsert';
          calls.upserts.push({ rows });
          return builder;
        },
        delete() {
          state.op = 'delete';
          return builder;
        },
        eq() {
          return builder;
        },
        or() {
          return builder;
        },
        is() {
          return builder;
        },
        gte() {
          return builder;
        },
        lte() {
          return builder;
        },
        lt() {
          return builder;
        },
        in(col: string, vals: unknown) {
          if (state.op === 'delete') calls.deletes.push({ dealIds: vals });
          return builder;
        },
        limit() {
          return builder;
        },
        then(onFulfilled: (value: unknown) => unknown, onRejected?: (r: unknown) => unknown) {
          if (state.op === 'upsert' || state.op === 'delete') {
            return Promise.resolve({ error: null }).then(onFulfilled, onRejected);
          }
          return Promise.resolve(resolve(state)).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };

  return { client, calls };
}

describe('matchDealsToRecipeIngredients (dryRun)', () => {
  it('computes candidates without writing or deleting anything', async () => {
    const { client, calls } = makeFakeClient({
      deals: [
        {
          id: 'd1',
          name: 'Cherry Tomaten',
          store_name: 'REWE',
          current_price: 1.49,
          original_price: 2.49,
          savings_percent: 40,
          valid_from: '2026-06-08',
          valid_to: '2026-06-15',
          ingredients: [],
          is_food: true,
          category: 'fruits_vegetables',
        },
      ],
      ingredients: [
        { id: 'i1', recipe_id: 'r1', name: { de: 'Tomaten' }, is_potential_deal: true },
      ],
    });

    const result = await matchDealsToRecipeIngredients(client as never, {
      dryRun: true,
      now: NOW,
    });

    expect(result.dryRun).toBe(true);
    expect(result.candidateMatches).toBeGreaterThan(0);
    expect(result.writtenMatches).toBe(0);
    expect(calls.upserts).toHaveLength(0);
    expect(calls.deletes).toHaveLength(0);
    expect(result.examples.length).toBeGreaterThan(0);
  });
});

describe('matchDealsToRecipeIngredients (write)', () => {
  it('upserts new matches but skips verified pairs, and cleans up expired matches', async () => {
    const { client, calls } = makeFakeClient({
      deals: [
        {
          id: 'd1',
          name: 'Cherry Tomaten',
          store_name: 'REWE',
          current_price: 1.49,
          original_price: 2.49,
          savings_percent: 40,
          valid_from: '2026-06-08',
          valid_to: '2026-06-15',
          ingredients: [],
          is_food: true,
          category: 'fruits_vegetables',
        },
        {
          id: 'd2',
          name: 'Basmati Reis',
          store_name: 'ALDI',
          current_price: 0.99,
          original_price: 1.49,
          savings_percent: 33,
          valid_from: '2026-06-08',
          valid_to: '2026-06-15',
          ingredients: [],
          is_food: true,
          category: 'other',
        },
      ],
      ingredients: [
        { id: 'i1', recipe_id: 'r1', name: { de: 'Tomaten' }, is_potential_deal: true },
        { id: 'i2', recipe_id: 'r1', name: { de: 'Reis' }, is_potential_deal: true },
      ],
      // i1↔d1 is an admin-verified pair; it must not be re-written.
      verified: [{ deal_id: 'd1', recipe_ingredient_id: 'i1', is_verified: true }],
      expiredDealIds: ['old-deal-1'],
    });

    const result = await matchDealsToRecipeIngredients(client as never, {
      dryRun: false,
      now: NOW,
    });

    expect(result.dryRun).toBe(false);
    expect(calls.upserts).toHaveLength(1);
    const writtenPairs = calls.upserts[0].rows.map(
      (r) => `${r.deal_id}|${r.recipe_ingredient_id}`,
    );
    // the Reis match is written …
    expect(writtenPairs).toContain('d2|i2');
    // … the verified Tomaten pair is left untouched
    expect(writtenPairs).not.toContain('d1|i1');
    expect(result.writtenMatches).toBe(writtenPairs.length);
    // expired matches were cleaned up
    expect(calls.deletes.length).toBeGreaterThan(0);
  });

  it('protects admin-set pairs (matched_by_admin) from being re-written', async () => {
    const { client, calls } = makeFakeClient({
      deals: [
        {
          id: 'd1',
          name: 'Cherry Tomaten',
          store_name: 'REWE',
          current_price: 1.49,
          original_price: 2.49,
          savings_percent: 40,
          valid_from: '2026-06-08',
          valid_to: '2026-06-15',
          ingredients: [],
          is_food: true,
          category: 'fruits_vegetables',
        },
      ],
      ingredients: [
        { id: 'i1', recipe_id: 'r1', name: { de: 'Tomaten' }, is_potential_deal: true },
      ],
      // not is_verified, but set by an admin → still protected.
      verified: [
        { deal_id: 'd1', recipe_ingredient_id: 'i1', is_verified: false, matched_by_admin: 'admin-uuid' },
      ],
    });

    const result = await matchDealsToRecipeIngredients(client as never, { now: NOW });

    // the only candidate (d1↔i1) is admin-set → nothing is written.
    expect(calls.upserts).toHaveLength(0);
    expect(result.writtenMatches).toBe(0);
  });
});
