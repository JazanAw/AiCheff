import { describe, expect, it } from 'vitest';
import {
  OFFER_REASON_I18N,
  RECIPE_REASON_I18N,
  getOfferReasonBadges,
  getRecipeReasonBadges,
} from './reasonBadges';
import type { OfferReasonTag } from './offerRanking';
import type { RecipeReasonTag } from './recipeRanking';

describe('getOfferReasonBadges', () => {
  it('returns at most two badges', () => {
    const all: OfferReasonTag[] = [
      'big_discount',
      'favorite',
      'on_your_list',
      'trending',
      'nearby',
    ];
    expect(getOfferReasonBadges(all)).toHaveLength(2);
  });

  it('prefers relevance (favorite) over value (big_discount)', () => {
    expect(getOfferReasonBadges(['big_discount', 'favorite'])).toEqual(['favorite', 'big_discount']);
  });

  it('orders strictly by priority regardless of input order', () => {
    // trending (low) + on_your_list (high) → on_your_list first, then trending.
    expect(getOfferReasonBadges(['trending', 'on_your_list'])).toEqual(['on_your_list', 'trending']);
  });

  it('returns [] for empty / undefined', () => {
    expect(getOfferReasonBadges([])).toEqual([]);
    expect(getOfferReasonBadges(undefined)).toEqual([]);
  });

  it('only maps known offer reasons (i18n keys present for every tag)', () => {
    for (const tag of getOfferReasonBadges(['favorite', 'big_discount'])) {
      expect(OFFER_REASON_I18N[tag]).toMatch(/^deals\.reasons\./);
    }
  });
});

describe('getRecipeReasonBadges', () => {
  it('returns at most two badges, priority-ordered', () => {
    const all: RecipeReasonTag[] = [
      'check_safety',
      'quick',
      'from_pantry',
      'trending',
    ];
    expect(getRecipeReasonBadges(all)).toEqual(['from_pantry', 'quick']);
  });

  it('keeps a single available reason', () => {
    expect(getRecipeReasonBadges(['variety'])).toEqual(['variety']);
  });

  it('puts check_safety last (only shows if nothing better fills the 2 slots)', () => {
    expect(getRecipeReasonBadges(['check_safety', 'low_cost'])).toEqual(['low_cost', 'check_safety']);
    // With two higher reasons, check_safety drops out.
    expect(getRecipeReasonBadges(['check_safety', 'from_pantry', 'quick'])).toEqual([
      'from_pantry',
      'quick',
    ]);
  });

  it('returns [] for empty / undefined', () => {
    expect(getRecipeReasonBadges([])).toEqual([]);
    expect(getRecipeReasonBadges(undefined)).toEqual([]);
  });

  it('has an i18n key for every recipe reason', () => {
    for (const tag of getRecipeReasonBadges(['from_pantry', 'quick'])) {
      expect(RECIPE_REASON_I18N[tag]).toMatch(/^cheffity\.reasons\./);
    }
  });
});
