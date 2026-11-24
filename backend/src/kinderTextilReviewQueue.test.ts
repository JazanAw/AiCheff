import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { classifyFoodDecision } from './foodDecision';
import { classifyReviewQueueClass, summarizeReviewQueue } from './reviewReductionClasses';
import {
  hasRuleConfirmedNonFoodSignal,
  hasStrongNonFoodSignal,
  hasUntrustworthyCacheNonFood,
} from './offersStrictFoodFilter';

// Phase-2-Review-Queue-Reduktion: drei `food_like`-Fälle aus dem echten
// 2026-06-16-Lauf strukturell klären.
//   1. „Kinder-Poncho »Paw Patrol«"  (Kaufland) — Kleidung, offensichtlich Non-Food
//   2. „Kinder-Tankini »Paw Patrol«" (Kaufland) — Badebekleidung, Non-Food
//   3. „Spritzring"                  (Netto)    — echter Grenzfall (Backautomat)
//
// Root Cause 1+2: das Textil-/Badebekleidungs-Vokabular „poncho"/„tankini" fehlte
// als generische Non-Food-Produktklasse (nur „badeponcho"/„bikini" waren bekannt).
// Der Modell-/Cache-Hit sagte fälschlich isNonFood=false und foodFlag=food
// (rule:category_food über die halluzinierte Kategorie „Snacks/Süßes"), also blieb
// der Fall uncertain + foodFlag=food = food_like. Ein generisches Garment-Klassen-
// Keyword (KEINE Produkt-/Marken-Allowlist, kein KW-/Shop-Sonderfall) überstimmt
// das jetzt zu confirmed_non_food.
//
// Spritzring (3) ist BEWUSST anders: der alte Küchenutensil-Cache wurde bereits
// korrekt auf isNonFood=false entschärft, übrig bleibt nur das Modell-Food-Votum
// ohne unabhängigen Beleg. Das ist ehrlich `food_like` (verdächtig falsch
// gefiltertes Food, das ein Mensch prüft) — NICHT hart Non-Food aus Cache, NICHT
// blind gerettet.
//
// Produktnamen sind reine Reproduktions-Fixtures.

const CURRENT = {
  validityStart: '2026-06-11T00:00:00.000Z',
  validityEnd: '2026-06-17T23:59:59.999Z',
};

function offer(
  id: string,
  name: string,
  extra: Partial<Offer> & Record<string, unknown> = {},
): Offer {
  return {
    id,
    name,
    normalizedName: name.toLowerCase(),
    storeChain: 'Kaufland',
    category: 'Sonstiges',
    price: 4.99,
    currency: 'EUR',
    unit: 'stk',
    validityStart: CURRENT.validityStart,
    validityEnd: CURRENT.validityEnd,
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-06-16T01:03:42.960Z',
    ...extra,
  } as Offer;
}

/** Exakte Kaufland-Shape: Modell-Cache-Hit isNonFood=false + foodFlag=food über
 *  die halluzinierte Kategorie „Snacks/Süßes". */
function kinderPoncho(id = 'poncho'): Offer {
  return offer(id, 'Kinder-Poncho »Paw Patrol«', {
    category: 'Snacks/Süßes',
    price: 7.99,
    unit: 'je',
    sourceCategoryRaw: 'Badespaß für die Kleinen',
    foodFlag: 'food',
    foodReasons: ['rule:category_food'],
    canonicalCategory: {
      sub: 'Küche & Geräte',
      isNonFood: false,
      confidence: 0.8,
      reasons: [
        "The product is a children's poncho, which is not a food item.",
        'cache:hit',
      ],
    },
  } as Partial<Offer>);
}

function kinderTankini(id = 'tankini'): Offer {
  return offer(id, 'Kinder-Tankini »Paw Patrol«', {
    category: 'Snacks/Süßes',
    price: 4.99,
    unit: '2-teilig',
    sourceCategoryRaw: 'Badespaß für die Kleinen',
    foodFlag: 'food',
    foodReasons: ['rule:category_food'],
    canonicalCategory: {
      sub: 'Körperpflege',
      isNonFood: false,
      confidence: 0.8,
      reasons: ['The product is a swimsuit, which is not a food item.', 'cache:hit'],
    },
  } as Partial<Offer>);
}

/** Exakte Netto-Shape: der stale Küchenutensil-Cache-Hit wurde bereits auf
 *  isNonFood=false korrigiert; foodFlag=food bleibt (rule:category_food). */
function spritzringReal(id = 'spritzring'): Offer {
  return offer(id, 'Spritzring', {
    storeChain: 'Netto',
    category: 'Getränke Alkoholfrei',
    price: 0.49,
    unit: 'stück',
    sourceCategoryRaw: 'Filialangebote',
    sourceTagsRaw: ['filiale'],
    tags: ['filiale', 'reduziert'],
    foodFlag: 'food',
    foodReasons: ['rule:category_food'],
    canonicalCategory: {
      sub: 'Küche & Geräte',
      isNonFood: false,
      confidence: 0.8,
      reasons: ['Spritzring ist ein Küchenutensil', 'cache:hit'],
    },
  } as Partial<Offer>);
}

describe('Kinder-Poncho/Tankini — Textil/Badebekleidung ist Non-Food, nie food_like', () => {
  for (const make of [kinderPoncho, kinderTankini]) {
    const sample = make();
    it(`„${sample.name}" ⇒ confirmed_non_food, nicht food_like`, () => {
      const o = make();
      expect(hasStrongNonFoodSignal(o)).toBe(true);
      expect(hasRuleConfirmedNonFoodSignal(o)).toBe(true);
      expect(classifyFoodDecision(o)).toBe('confirmed_non_food');
      // confirmed_non_food ⇒ kein offener Review-Fall mehr (kein food_like).
      expect(classifyReviewQueueClass(o)).toBeNull();
    });
  }

  it('generisch (keine Produkt-/Marken-Allowlist): auch ohne „Paw Patrol"/„Kinder"', () => {
    for (const name of [
      'Damen-Poncho',
      'Strandtuch oder -Poncho',
      'Tankini zweiteilig',
      'Herren-Tankini',
    ]) {
      const o = offer(`g_${name}`, name);
      expect(classifyFoodDecision(o), name).toBe('confirmed_non_food');
    }
  });

  it('Regression: echtes Food bleibt unberührt (Vollmilch confirmed_food)', () => {
    expect(classifyFoodDecision(offer('milk', 'Frische Vollmilch 3,8 %'))).toBe('confirmed_food');
  });
});

describe('Spritzring — bewusst food_like (Backautomat-Grenzfall), nie Cache-Non-Food', () => {
  it('zentrale Entscheidung bleibt uncertain (nie confirmed_non_food aus stale Cache)', () => {
    const sr = spritzringReal();
    expect(classifyFoodDecision(sr)).toBe('uncertain');
  });

  it('der korrigierte Cache (isNonFood=false) ist KEIN untrustworthy-Cache-Konflikt mehr', () => {
    // Der stale „Küchenutensil"-Hit wurde bereits auf isNonFood=false entschärft,
    // es gibt also gar keinen Non-Food-Cache-Flag, der widersprechen könnte.
    expect(hasUntrustworthyCacheNonFood(spritzringReal())).toBe(false);
  });

  it('landet ehrlich in food_like — NICHT cache_conflict, NICHT confirmed Non-Food', () => {
    const sr = spritzringReal();
    expect(classifyReviewQueueClass(sr)).toBe('food_like');
  });
});

describe('summarizeReviewQueue — Vorher/Nachher der drei food_like-Fälle', () => {
  it('Poncho/Tankini verlassen food_like; nur Spritzring bleibt; name_quality stabil', () => {
    const nameQualityFragment = offer('frag', 'extra', {
      foodFlag: 'unsure',
      canonicalCategory: { isNonFood: true, confidence: 0.3, reasons: ['cache:hit'] },
    } as Partial<Offer>);

    const summary = summarizeReviewQueue([
      kinderPoncho(),
      kinderTankini(),
      spritzringReal(),
      nameQualityFragment,
    ]);

    expect(summary.foodLikeReview.count).toBe(1);
    expect(summary.foodLikeReview.examples).toEqual(['Spritzring']);
    expect(summary.foodLikeReview.examples).not.toContain('Kinder-Poncho »Paw Patrol«');
    expect(summary.foodLikeReview.examples).not.toContain('Kinder-Tankini »Paw Patrol«');
    // name_quality bleibt erhalten.
    expect(summary.nameQualityReview.count).toBe(1);
    expect(summary.nameQualityReview.examples).toEqual(['extra']);
    // Poncho/Tankini sind confirmed_non_food ⇒ in keiner Review-Klasse.
    expect(summary.nonFoodLikeReview.count).toBe(0);
    expect(summary.cacheConflictReview.count).toBe(0);
  });
});
