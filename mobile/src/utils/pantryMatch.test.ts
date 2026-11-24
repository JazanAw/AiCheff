import { describe, expect, it } from 'vitest';
import type { PantryItem, Recipe, RecipeIngredient } from '../types';
import {
  classifyIngredientPantryStatus,
  computeRecipeCoverage,
  filterAlmostReady,
  filterCheapRecipes,
  filterReadyFromStock,
  isIngredientCoveredByPantry,
  normalizeFoodName,
  rankRecipesForCooking,
  scoreRecipe,
  sortRecipesByCoverage,
  splitMissingIngredients,
} from './pantryMatch';

function pantryItem(
  name: string,
  overrides: Partial<PantryItem> = {},
): PantryItem {
  return {
    id: `p-${name}`,
    name,
    quantity: 1,
    unit: '',
    source: 'manual',
    addedAt: '2026-05-18T00:00:00Z',
    ...overrides,
  };
}

function ingredient(name: string, id = `i-${name}`): RecipeIngredient {
  return {
    id,
    name,
    amount: 1,
    unit: '',
    isDeal: false,
  };
}

describe('normalizeFoodName', () => {
  it('lowercases, drops punctuation and short tokens', () => {
    expect(normalizeFoodName('Barilla Spaghetti N. 5')).toBe('barilla spaghetti');
  });

  it('expands umlauts (ä→ae, ö→oe, ü→ue, ß→ss)', () => {
    expect(normalizeFoodName('Müsli')).toBe('muesli');
    expect(normalizeFoodName('Würstchen')).toBe('wuerst');
    expect(normalizeFoodName('Süßkartoffel')).toBe('suesskartoffel');
  });

  it('depluralizes common german forms', () => {
    expect(normalizeFoodName('Tomaten')).toBe('tomat');
    expect(normalizeFoodName('Tomate')).toBe('tomat');
    // Kartoffel/Kartoffeln don't collapse to a stem, but the singular form
    // is the same — that's what matters for matching.
    expect(normalizeFoodName('Kartoffeln')).toBe(normalizeFoodName('Kartoffel'));
    expect(normalizeFoodName('Eier')).toBe('eier');
  });

  it('drops noise tokens (units, packaging)', () => {
    expect(normalizeFoodName('500 g Tomaten')).toBe('tomat');
    expect(normalizeFoodName('Packung Spaghetti')).toBe('spaghetti');
    expect(normalizeFoodName('Frische Tomaten')).toBe('tomat');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeFoodName('')).toBe('');
    expect(normalizeFoodName('   ')).toBe('');
  });
});

describe('isIngredientCoveredByPantry', () => {
  it('matches when the pantry name is a superstring of the ingredient', () => {
    const pantry = [pantryItem('Barilla Spaghetti N. 5')];
    expect(isIngredientCoveredByPantry('Spaghetti', pantry)).toBe(true);
  });

  it('matches via plural/singular normalization', () => {
    const pantry = [pantryItem('Tomate')];
    expect(isIngredientCoveredByPantry('Tomaten', pantry)).toBe(true);
  });

  it('ignores consumed pantry items', () => {
    const pantry = [
      pantryItem('Tomate', { consumedAt: '2026-05-17T00:00:00Z' }),
    ];
    expect(isIngredientCoveredByPantry('Tomaten', pantry)).toBe(false);
  });

  it('does not match across unrelated short tokens', () => {
    // "Ei" (2 chars) would otherwise risk a false positive against "Eis".
    const pantry = [pantryItem('Eis')];
    expect(isIngredientCoveredByPantry('Ei', pantry)).toBe(false);
  });

  it('matches token-wise inside multi-word names', () => {
    const pantry = [pantryItem('Olivenöl Extra Vergine')];
    expect(isIngredientCoveredByPantry('Olivenöl', pantry)).toBe(true);
  });

  it('does not match completely different ingredients', () => {
    const pantry = [pantryItem('Tomate'), pantryItem('Mozzarella')];
    expect(isIngredientCoveredByPantry('Gurke', pantry)).toBe(false);
  });

  it('returns false for an empty pantry', () => {
    expect(isIngredientCoveredByPantry('Tomate', [])).toBe(false);
  });

  it('ignores noise tokens on the ingredient side too', () => {
    const pantry = [pantryItem('Spaghetti')];
    expect(isIngredientCoveredByPantry('Packung Spaghetti', pantry)).toBe(true);
  });
});

describe('isIngredientCoveredByPantry — barcode/productName fallback', () => {
  it('matches via productName when name is just a brand', () => {
    // Typical barcode-scan result: name carries the brand, productName carries
    // the actual food. The recipe asks for "Spaghetti", not "Barilla".
    const pantry = [
      pantryItem('Barilla', {
        productName: 'Spaghetti N.5',
        brand: 'Barilla',
        barcode: '8076800195057',
      }),
    ];
    expect(isIngredientCoveredByPantry('Spaghetti', pantry)).toBe(true);
  });

  it('still requires a real overlap when productName is unrelated', () => {
    const pantry = [
      pantryItem('Coca-Cola', {
        productName: 'Coca-Cola Classic 1L',
        brand: 'Coca-Cola',
      }),
    ];
    expect(isIngredientCoveredByPantry('Spaghetti', pantry)).toBe(false);
  });
});

describe('splitMissingIngredients', () => {
  it('partitions ingredients into available and missing in order', () => {
    const pantry = [pantryItem('Tomate'), pantryItem('Spaghetti')];
    const ingredients = [
      ingredient('Spaghetti', 'a'),
      ingredient('Tomaten', 'b'),
      ingredient('Basilikum', 'c'),
      ingredient('Knoblauch', 'd'),
    ];
    const { available, missing } = splitMissingIngredients(ingredients, pantry);
    expect(available.map((i) => i.id)).toEqual(['a', 'b']);
    expect(missing.map((i) => i.id)).toEqual(['c', 'd']);
  });

  it('puts everything in `missing` for an empty pantry', () => {
    const ingredients = [ingredient('Tomate'), ingredient('Basilikum')];
    const { available, missing } = splitMissingIngredients(ingredients, []);
    expect(available).toHaveLength(0);
    expect(missing).toHaveLength(2);
  });

  it('puts everything in `available` when every ingredient matches', () => {
    const pantry = [pantryItem('Spaghetti'), pantryItem('Tomate')];
    const ingredients = [ingredient('Spaghetti'), ingredient('Tomaten')];
    const { available, missing } = splitMissingIngredients(ingredients, pantry);
    expect(available).toHaveLength(2);
    expect(missing).toHaveLength(0);
  });
});

function recipe(
  id: string,
  ingredientNames: string[],
): Pick<Recipe, 'id' | 'ingredients'> {
  return {
    id,
    ingredients: ingredientNames.map((n, i) => ingredient(n, `${id}-${i}`)),
  };
}

describe('computeRecipeCoverage', () => {
  it('returns allHere badge when every ingredient is in the pantry', () => {
    const r = recipe('r1', ['Spaghetti', 'Tomaten']);
    const pantry = [pantryItem('Spaghetti'), pantryItem('Tomate')];
    const cov = computeRecipeCoverage(r, pantry);
    expect(cov).toMatchObject({
      recipeId: 'r1',
      totalCount: 2,
      availableCount: 2,
      missingCount: 0,
      matchPercent: 100,
      badge: 'allHere',
    });
  });

  it('returns oneMissing when exactly one ingredient is missing', () => {
    const r = recipe('r2', ['Spaghetti', 'Tomaten', 'Basilikum']);
    const pantry = [pantryItem('Spaghetti'), pantryItem('Tomate')];
    const cov = computeRecipeCoverage(r, pantry);
    expect(cov.missingCount).toBe(1);
    expect(cov.badge).toBe('oneMissing');
    expect(cov.matchPercent).toBe(67);
    expect(cov.missing.map((i) => i.name)).toEqual(['Basilikum']);
  });

  it('returns almostThere for 2–3 missing ingredients', () => {
    const r = recipe('r3', ['Spaghetti', 'Tomaten', 'Basilikum', 'Knoblauch']);
    const pantry = [pantryItem('Spaghetti'), pantryItem('Tomate')];
    const cov = computeRecipeCoverage(r, pantry);
    expect(cov.missingCount).toBe(2);
    expect(cov.badge).toBe('almostThere');
    expect(cov.matchPercent).toBe(50);
  });

  it('returns moreMissing past the three-missing threshold', () => {
    const r = recipe('r4', ['a-zutat', 'b-zutat', 'c-zutat', 'd-zutat', 'e-zutat']);
    const cov = computeRecipeCoverage(r, []);
    expect(cov.missingCount).toBe(5);
    expect(cov.badge).toBe('moreMissing');
    expect(cov.matchPercent).toBe(0);
  });

  it('handles plural normalisation (Tomate ↔ Tomaten)', () => {
    const r = recipe('r5', ['Tomate']);
    const pantry = [pantryItem('Tomaten')];
    const cov = computeRecipeCoverage(r, pantry);
    expect(cov.badge).toBe('allHere');
    expect(cov.matchPercent).toBe(100);
  });

  it('marks an empty-ingredients recipe as 0% / allHere (edge case)', () => {
    const r = recipe('r6', []);
    const cov = computeRecipeCoverage(r, [pantryItem('Tomate')]);
    expect(cov.totalCount).toBe(0);
    expect(cov.matchPercent).toBe(0);
    expect(cov.badge).toBe('allHere');
  });
});

describe('sortRecipesByCoverage', () => {
  it('puts allHere first, then oneMissing, then more-missing buckets', () => {
    const pantry = [pantryItem('Spaghetti'), pantryItem('Tomate')];
    const recipes = [
      recipe('many-missing', ['x', 'y', 'z', 'w', 'v']),
      recipe('all-here', ['Spaghetti', 'Tomaten']),
      recipe('one-missing', ['Spaghetti', 'Tomaten', 'Basilikum']),
      recipe('two-missing', ['Spaghetti', 'Tomaten', 'Basilikum', 'Knoblauch']),
    ];
    const ranked = sortRecipesByCoverage(recipes, pantry);
    expect(ranked.map((r) => r.recipe.id)).toEqual([
      'all-here',
      'one-missing',
      'two-missing',
      'many-missing',
    ]);
  });

  it('uses match% to break ties inside the same missing-count', () => {
    const pantry = [pantryItem('Spaghetti'), pantryItem('Tomate')];
    // Both have exactly one missing ingredient, but A has 2/3=67% and B has
    // 2/4=50% pantry coverage. A should come first.
    const recipes = [
      recipe('b', ['Spaghetti', 'Tomaten', 'fehlt1', 'extra1']),
      recipe('a', ['Spaghetti', 'Tomaten', 'fehlt1']),
    ];
    // Force same missingCount=1 by giving recipe B two pantry items too:
    // pantry covers Spaghetti+Tomate, both recipes miss "fehlt1" (and B
    // misses "extra1"). missingCounts differ (1 vs 2) — so this is really
    // an almostThere-vs-oneMissing test, not a pure %-tiebreak. Add a third
    // pantry item to make B miss only one too.
    const pantryWide = [...pantry, pantryItem('Extra1', { productName: 'extra1' })];
    const ranked = sortRecipesByCoverage(recipes, pantryWide);
    // Now both recipes miss exactly "fehlt1". A has 3/4=75%, B has 3/5=60%.
    // Wait — "a" has 3 ingredients with 2 covered = 67%, "b" has 4 with 3
    // covered = 75%. So the higher-match wins, which here is "b".
    expect(ranked.map((r) => r.recipe.id)).toEqual(['b', 'a']);
  });

  it('does not mutate the input array', () => {
    const pantry = [pantryItem('Tomate')];
    const input = [
      recipe('z', ['a', 'b', 'c']),
      recipe('a', ['Tomaten']),
    ];
    const inputCopy = [...input];
    sortRecipesByCoverage(input, pantry);
    expect(input.map((r) => r.id)).toEqual(inputCopy.map((r) => r.id));
  });
});

describe('filterAlmostReady', () => {
  it('keeps recipes with 1–3 missing AND at least one available', () => {
    const pantry = [pantryItem('Spaghetti'), pantryItem('Tomate')];
    const ranked = sortRecipesByCoverage(
      [
        recipe('all-here', ['Spaghetti', 'Tomaten']),
        recipe('one-missing', ['Spaghetti', 'Tomaten', 'Basilikum']),
        recipe('three-missing', [
          'Spaghetti',
          'Tomaten',
          'Basilikum',
          'Knoblauch',
          'Salz',
        ]),
        recipe('four-missing', [
          'Spaghetti',
          'Tomaten',
          'a',
          'b',
          'c',
          'd',
        ]),
        recipe('all-missing', ['a', 'b', 'c']),
      ],
      pantry,
    );
    const almost = filterAlmostReady(ranked);
    expect(almost.map((r) => r.recipe.id)).toEqual([
      'one-missing',
      'three-missing',
    ]);
  });
});

describe('classifyIngredientPantryStatus', () => {
  const ing = (name: string, amount: number, unit: string): RecipeIngredient => ({
    id: `i-${name}`,
    name,
    amount,
    unit,
    isDeal: false,
  });

  it('returns missing when nothing in the pantry matches the name', () => {
    expect(
      classifyIngredientPantryStatus(ing('Gurke', 2, 'Stück'), [pantryItem('Tomate')]),
    ).toBe('missing');
  });

  it('is available when the same unit has enough on hand', () => {
    const pantry = [pantryItem('Mehl', { quantity: 1000, unit: 'g' })];
    expect(classifyIngredientPantryStatus(ing('Mehl', 200, 'g'), pantry)).toBe('available');
  });

  it('is unclear when the same unit does not have enough on hand', () => {
    const pantry = [pantryItem('Mehl', { quantity: 100, unit: 'g' })];
    expect(classifyIngredientPantryStatus(ing('Mehl', 200, 'g'), pantry)).toBe('unclear');
  });

  it('is unclear when units are not comparable (g vs Stück)', () => {
    const pantry = [pantryItem('Tomate', { quantity: 3, unit: 'Stück' })];
    expect(classifyIngredientPantryStatus(ing('Tomaten', 200, 'g'), pantry)).toBe('unclear');
  });

  it('treats g and kg as different scales (conservative → unclear)', () => {
    const pantry = [pantryItem('Mehl', { quantity: 1, unit: 'kg' })];
    expect(classifyIngredientPantryStatus(ing('Mehl', 200, 'g'), pantry)).toBe('unclear');
  });

  it('canonicalizes unit synonyms (gramm == g)', () => {
    const pantry = [pantryItem('Zucker', { quantity: 500, unit: 'gramm' })];
    expect(classifyIngredientPantryStatus(ing('Zucker', 100, 'g'), pantry)).toBe('available');
  });

  it('is available for seasoning-scale units regardless of stocked amount', () => {
    const pantry = [pantryItem('Salz', { quantity: 1, unit: 'g' })];
    expect(classifyIngredientPantryStatus(ing('Salz', 1, 'TL'), pantry)).toBe('available');
    expect(classifyIngredientPantryStatus(ing('Salz', 2, 'Prise'), pantry)).toBe('available');
  });

  it('is available when the recipe states no meaningful amount', () => {
    const pantry = [pantryItem('Salz', { quantity: 1, unit: 'g' })];
    expect(classifyIngredientPantryStatus(ing('Salz', 0, ''), pantry)).toBe('available');
  });

  it('compares matching empty units by count', () => {
    expect(
      classifyIngredientPantryStatus(ing('Zwiebel', 1, ''), [
        pantryItem('Zwiebel', { quantity: 3, unit: '' }),
      ]),
    ).toBe('available');
    expect(
      classifyIngredientPantryStatus(ing('Zwiebel', 3, ''), [
        pantryItem('Zwiebel', { quantity: 1, unit: '' }),
      ]),
    ).toBe('unclear');
  });

  it('ignores consumed pantry items (→ missing)', () => {
    const pantry = [
      pantryItem('Mehl', {
        quantity: 1000,
        unit: 'g',
        consumedAt: '2026-05-17T00:00:00Z',
      }),
    ];
    expect(classifyIngredientPantryStatus(ing('Mehl', 200, 'g'), pantry)).toBe('missing');
  });

  it('subdivides the covered set without moving the covered/missing boundary', () => {
    // Invariant: status !== 'missing'  ⟺  isIngredientCoveredByPantry === true.
    const pantry = [
      pantryItem('Mehl', { quantity: 1000, unit: 'g' }),
      pantryItem('Tomate', { quantity: 3, unit: 'Stück' }),
    ];
    const samples: RecipeIngredient[] = [
      ing('Mehl', 200, 'g'), // available
      ing('Tomaten', 200, 'g'), // unclear — name matches, units don't
      ing('Gurke', 1, 'Stück'), // missing
    ];
    for (const s of samples) {
      const covered = isIngredientCoveredByPantry(s.name, pantry);
      const status = classifyIngredientPantryStatus(s, pantry);
      expect(status === 'missing').toBe(!covered);
    }
  });
});

// ─── Coverage three-state + deals / scoring / ranking / tab filters ─────────

function dealIng(
  name: string,
  overrides: Partial<RecipeIngredient> = {},
): RecipeIngredient {
  return { id: `i-${name}`, name, amount: 1, unit: '', isDeal: false, ...overrides };
}

function cookRecipe(
  id: string,
  cookTimeMinutes: number,
  ingredients: RecipeIngredient[],
): Pick<Recipe, 'id' | 'ingredients' | 'cookTimeMinutes'> {
  return { id, ingredients, cookTimeMinutes };
}

describe('computeRecipeCoverage — three-state + deals', () => {
  it('separates unclear from missing and never counts unclear as missing', () => {
    const pantry = [pantryItem('Tomate', { quantity: 1, unit: '' })];
    const cov = computeRecipeCoverage(
      {
        id: 'r',
        ingredients: [
          dealIng('Tomate', { amount: 3, unit: '' }), // name match, 1 < 3 → unclear
          dealIng('Gurke'), // no match → missing
        ],
      },
      pantry,
    );
    expect(cov.availableCount).toBe(0);
    expect(cov.unclearCount).toBe(1);
    expect(cov.missingCount).toBe(1);
    expect(cov.unclear.map((i) => i.name)).toEqual(['Tomate']);
    expect(cov.missing.map((i) => i.name)).toEqual(['Gurke']);
  });

  it('flags missing-on-deal and sums cost only from priced deals', () => {
    const cov = computeRecipeCoverage(
      {
        id: 'r',
        ingredients: [
          dealIng('Lachs', { dealId: 'd1', dealName: 'Lachsfilet', dealPrice: 4.99 }), // concrete + priced
          dealIng('Reis', { dealId: 'd2', dealName: 'Reis Aktion' }), // concrete deal, no price
          dealIng('Salz'), // missing, no deal
        ],
      },
      [], // empty pantry → everything missing
    );
    expect(cov.missingCount).toBe(3);
    expect(cov.missingOnDealCount).toBe(2);
    expect(cov.estimatedMissingCost).toBeCloseTo(4.99, 2);
  });

  it('leaves estimatedMissingCost undefined when no missing deal has a price', () => {
    const cov = computeRecipeCoverage(
      { id: 'r', ingredients: [dealIng('Reis', { dealId: 'd1', dealStoreName: 'REWE' })] },
      [],
    );
    expect(cov.missingOnDealCount).toBe(1);
    expect(cov.estimatedMissingCost).toBeUndefined();
  });

  it('does not flag a deal ingredient as missing when it is in the pantry', () => {
    const cov = computeRecipeCoverage(
      { id: 'r', ingredients: [dealIng('Reis', { isDeal: true, dealPrice: 2 })] },
      [pantryItem('Reis', { quantity: 1, unit: '' })],
    );
    expect(cov.availableCount).toBe(1);
    expect(cov.missingOnDealCount).toBe(0);
    expect(cov.estimatedMissingCost).toBeUndefined();
  });
});

describe('computeRecipeCoverage — honest deal rule (concrete + valid only)', () => {
  const NOW = new Date('2026-06-09T12:00:00Z');

  it('does NOT count a bare isDeal flag as missing-on-deal', () => {
    const cov = computeRecipeCoverage(
      { id: 'r', ingredients: [dealIng('Lachs', { isDeal: true })] },
      [],
      NOW,
    );
    expect(cov.missingCount).toBe(1);
    expect(cov.missingOnDealCount).toBe(0);
    expect(cov.estimatedMissingCost).toBeUndefined();
  });

  it('counts a concrete, currently-valid deal as missing-on-deal', () => {
    const cov = computeRecipeCoverage(
      {
        id: 'r',
        ingredients: [
          dealIng('Lachs', { dealId: 'd1', dealName: 'Lachsfilet', dealPrice: 4.99, dealValidTo: '2026-06-15' }),
        ],
      },
      [],
      NOW,
    );
    expect(cov.missingOnDealCount).toBe(1);
    expect(cov.estimatedMissingCost).toBeCloseTo(4.99, 2);
  });

  it('does NOT count a concrete deal that has already expired', () => {
    const cov = computeRecipeCoverage(
      {
        id: 'r',
        ingredients: [
          dealIng('Lachs', { dealId: 'd1', dealName: 'Lachsfilet', dealPrice: 4.99, dealValidTo: '2026-06-01' }),
        ],
      },
      [],
      NOW,
    );
    expect(cov.missingOnDealCount).toBe(0);
    expect(cov.estimatedMissingCost).toBeUndefined();
  });

  it('sums estimatedMissingCost only from valid, concrete, priced deals', () => {
    const cov = computeRecipeCoverage(
      {
        id: 'r',
        ingredients: [
          dealIng('Lachs', { dealId: 'd1', dealName: 'Lachs', dealPrice: 4.99, dealValidTo: '2026-06-15' }), // valid priced
          dealIng('Reis', { dealId: 'd2', dealName: 'Reis', dealValidTo: '2026-06-15' }), // valid, no price
          dealIng('Butter', { isDeal: true, dealPrice: 1.5 }), // bare → ignored
          dealIng('Salz', { dealId: 'd3', dealName: 'Salz', dealPrice: 0.5, dealValidTo: '2026-06-01' }), // expired → ignored
        ],
      },
      [],
      NOW,
    );
    expect(cov.missingOnDealCount).toBe(2); // Lachs + Reis
    expect(cov.estimatedMissingCost).toBeCloseTo(4.99, 2); // only the valid, priced Lachs
  });

  it('does NOT count a pantry-covered ingredient even if it has a valid deal', () => {
    const cov = computeRecipeCoverage(
      {
        id: 'r',
        ingredients: [
          dealIng('Reis', { dealId: 'd1', dealName: 'Reis', dealPrice: 2, dealValidTo: '2026-06-15' }),
        ],
      },
      [pantryItem('Reis', { quantity: 1, unit: '' })],
      NOW,
    );
    expect(cov.availableCount).toBe(1);
    expect(cov.missingOnDealCount).toBe(0);
  });
});

describe('scoreRecipe', () => {
  it('scores a missing-on-deal ingredient higher than missing-no-deal', () => {
    const onDeal = computeRecipeCoverage(
      { id: 'a', ingredients: [dealIng('Reis'), dealIng('Lachs', { dealId: 'd1', dealName: 'Lachs', dealPrice: 2 })] },
      [pantryItem('Reis')],
    );
    const noDeal = computeRecipeCoverage(
      { id: 'b', ingredients: [dealIng('Reis'), dealIng('Lachs')] },
      [pantryItem('Reis')],
    );
    expect(scoreRecipe({ cookTimeMinutes: 30 }, onDeal)).toBeGreaterThan(
      scoreRecipe({ cookTimeMinutes: 30 }, noDeal),
    );
  });

  it('counts unclear as partial coverage, beating a missing-no-deal version', () => {
    const unclearCov = computeRecipeCoverage(
      { id: 'a', ingredients: [dealIng('Reis'), dealIng('Tomate', { amount: 5 })] },
      [pantryItem('Reis'), pantryItem('Tomate', { quantity: 1, unit: '' })],
    );
    expect(unclearCov.missingCount).toBe(0);
    expect(unclearCov.unclearCount).toBe(1);
    const missingCov = computeRecipeCoverage(
      { id: 'b', ingredients: [dealIng('Reis'), dealIng('Gurke')] },
      [pantryItem('Reis')],
    );
    expect(scoreRecipe({ cookTimeMinutes: 30 }, unclearCov)).toBeGreaterThan(
      scoreRecipe({ cookTimeMinutes: 30 }, missingCov),
    );
  });

  it('slightly prefers shorter cook time on equal coverage', () => {
    const cov = computeRecipeCoverage(
      { id: 'a', ingredients: [dealIng('Reis')] },
      [pantryItem('Reis')],
    );
    expect(scoreRecipe({ cookTimeMinutes: 10 }, cov)).toBeGreaterThan(
      scoreRecipe({ cookTimeMinutes: 90 }, cov),
    );
  });

  it('returns 0 for an ingredient-less recipe', () => {
    const cov = computeRecipeCoverage({ id: 'x', ingredients: [] }, []);
    expect(scoreRecipe({ cookTimeMinutes: 20 }, cov)).toBe(0);
  });
});

describe('rankRecipesForCooking', () => {
  it('orders full-pantry > deal-missing > plain-missing > all-missing', () => {
    const pantry = [pantryItem('Reis'), pantryItem('Mehl')];
    const recipes = [
      cookRecipe('all-missing', 30, [dealIng('Lachs'), dealIng('Gurke')]),
      cookRecipe('full', 30, [dealIng('Reis'), dealIng('Mehl')]),
      cookRecipe('one-missing-deal', 30, [
        dealIng('Reis'),
        dealIng('Zucchini', { dealId: 'd1', dealName: 'Zucchini', dealPrice: 1 }),
      ]),
      cookRecipe('one-missing', 30, [dealIng('Reis'), dealIng('Pesto')]),
    ];
    const ranked = rankRecipesForCooking(recipes, pantry);
    expect(ranked.map((r) => r.recipe.id)).toEqual([
      'full',
      'one-missing-deal',
      'one-missing',
      'all-missing',
    ]);
  });

  it('is stable on ties (preserves input order)', () => {
    const ranked = rankRecipesForCooking(
      [cookRecipe('b', 30, [dealIng('x')]), cookRecipe('a', 30, [dealIng('y')])],
      [],
    );
    expect(ranked.map((r) => r.recipe.id)).toEqual(['b', 'a']);
  });
});

describe('filterReadyFromStock', () => {
  it('keeps only recipes with nothing missing (unclear allowed)', () => {
    const pantry = [
      pantryItem('Reis'),
      pantryItem('Tomate', { quantity: 1, unit: '' }),
    ];
    const ranked = rankRecipesForCooking(
      [
        cookRecipe('ready', 20, [dealIng('Reis')]),
        cookRecipe('ready-unclear', 20, [dealIng('Reis'), dealIng('Tomate', { amount: 5 })]),
        cookRecipe('missing', 20, [dealIng('Reis'), dealIng('Gurke')]),
      ],
      pantry,
    );
    expect(filterReadyFromStock(ranked).map((r) => r.recipe.id).sort()).toEqual([
      'ready',
      'ready-unclear',
    ]);
  });
});

describe('filterCheapRecipes', () => {
  it('keeps only recipes with a missing-on-deal ingredient', () => {
    const ranked = rankRecipesForCooking(
      [
        cookRecipe('has-deal', 20, [dealIng('a', { dealId: 'd1', dealName: 'A', dealPrice: 2 })]),
        cookRecipe('no-deal', 20, [dealIng('b')]),
      ],
      [],
    );
    expect(filterCheapRecipes(ranked).map((r) => r.recipe.id)).toEqual(['has-deal']);
  });

  it('drops a recipe whose only deal is a bare isDeal flag, keeps a concrete one', () => {
    const ranked = rankRecipesForCooking(
      [
        cookRecipe('bare', 20, [dealIng('a', { isDeal: true })]),
        cookRecipe('concrete', 20, [dealIng('b', { dealId: 'd1', dealName: 'B', dealPrice: 2 })]),
      ],
      [],
    );
    expect(filterCheapRecipes(ranked).map((r) => r.recipe.id)).toEqual(['concrete']);
  });

  it('orders by deal share of missing, then lower estimated cost', () => {
    const ranked = rankRecipesForCooking(
      [
        cookRecipe('half', 20, [
          dealIng('a', { isDeal: true, dealId: 'd', dealPrice: 5 }),
          dealIng('b'),
        ]),
        cookRecipe('cheap-full', 20, [
          dealIng('c', { isDeal: true, dealId: 'd', dealPrice: 1 }),
          dealIng('d', { isDeal: true, dealId: 'd', dealPrice: 2 }),
        ]),
        cookRecipe('pricey-full', 20, [
          dealIng('e', { isDeal: true, dealId: 'd', dealPrice: 4 }),
          dealIng('f', { isDeal: true, dealId: 'd', dealPrice: 4 }),
        ]),
      ],
      [],
    );
    expect(filterCheapRecipes(ranked).map((r) => r.recipe.id)).toEqual([
      'cheap-full',
      'pricey-full',
      'half',
    ]);
  });
});
