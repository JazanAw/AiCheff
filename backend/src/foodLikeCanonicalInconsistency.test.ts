import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { classifyFoodDecision, summarizeFoodDecisions } from './foodDecision';
import { classifyReviewQueueClass, summarizeReviewQueue } from './reviewReductionClasses';
import {
  hasInconsistentCanonicalFoodFlag,
  hasRuleConfirmedNonFoodSignal,
  hasSuspectFoodEvidence,
} from './offersStrictFoodFilter';

// ReviewQueue food_like strukturell korrigieren (Folge-Task). Der echte
// 2026-06-22-Lauf zeigte foodLikeReview=310 mit offensichtlichem Non-Food:
//   - Bedruckte Fußmatte
//   - Beschäftigungsblock / -buch
//   - Bohrer- und Bit-Set
//   - Elektrische Pumpe mit Vakuumbeutel
//
// ROOT CAUSE: Der Python-Pipeline-Repair `repair:sonstiges_nonfood_unverified`
// (core.py) schreibt ein Modell-Non-Food-Verdikt über eine generische
// „Sonstiges"-Quelle vorläufig auf `main=Grundnahrungsmittel`/`isNonFood=false`
// um (conf ≤ 0.66), BEHÄLT aber die ursprünglichen Non-Food-Gründe. TS las den
// reparierten Flag über `hasCanonicalFoodFlag` als positives Food-Verdikt → der
// uncertain-Fall wurde food_like statt nonfood_like.
//
// STRUKTURELLE REGEL (kein Einzelwort-Fix): eine canonicalCategory, deren EIGENE
// Gründe Non-Food erklären, ist KEIN Food-Beleg (hasInconsistentCanonicalFoodFlag)
// → der Fall verlässt food_like. Zusätzlich machen generische Non-Food-Produkt-
// klassen (Werkzeug/Bücher/Matten/Pumpen) die harten Fälle confirmed_non_food.
//
// Produktnamen sind reine Reproduktions-Fixtures — kein Produktivcode kennt eine
// Produkt-/Marken-Allowlist und keinen KW-/Shop-Sonderfall.

const CURRENT = {
  validityStart: '2026-06-20T00:00:00.000Z',
  validityEnd: '2026-06-27T23:59:59.999Z',
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
    price: 9.99,
    currency: 'EUR',
    unit: 'stk',
    validityStart: CURRENT.validityStart,
    validityEnd: CURRENT.validityEnd,
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-06-22T01:03:42.960Z',
    ...extra,
  } as Offer;
}

/** Exakte Snapshot-Shape: foodFlag=unsure, repariert-e canonical
 *  (main=Grundnahrungsmittel/isNonFood=false/conf 0.66) mit erhaltenen
 *  Non-Food-Gründen + `repair:sonstiges_nonfood_unverified`. */
function repairedNonFood(
  id: string,
  name: string,
  reasons: string[],
  extra: Partial<Offer> & Record<string, unknown> = {},
): Offer {
  return offer(id, name, {
    foodFlag: 'unsure',
    reviewReason: 'food_filtered_unconfirmed',
    canonicalCategory: {
      main: 'Grundnahrungsmittel',
      sub: 'unknown',
      isNonFood: false,
      confidence: 0.66,
      reasons: [...reasons, 'repair:sonstiges_nonfood_unverified'],
    },
    ...extra,
  } as Partial<Offer>);
}

const bohrerBitSet = (): Offer =>
  repairedNonFood('bohrer', 'Bohrer- und Bit-Set', [
    "The product is a 'Bohrer- und Bit-Set' which is a tool, typically classified under Non-Food.",
    "The source_department is 'Sonstiges' which aligns with Non-Food categories.",
  ]);

const elektrischePumpe = (): Offer =>
  repairedNonFood('pumpe', 'Elektrische Pumpe mit Vakuumbeutel', [
    'The product is an electrical pump, a kitchen appliance, classified under Non-Food.',
    "The source_department is 'Sonstiges' which aligns with Non-Food categories.",
  ]);

const fussmatte = (): Offer =>
  repairedNonFood('matte', 'Bedruckte Fußmatte', [
    'The product is a printed doormat, a household item, classified under Non-Food.',
  ]);

const beschaeftigungsblock = (): Offer =>
  repairedNonFood('block', 'Beschäftigungsblock / -buch', [
    'The product is an activity book, classified under Non-Food.',
  ]);

const ALL_FOUR = [bohrerBitSet, elektrischePumpe, fussmatte, beschaeftigungsblock];

describe('food_like-Korrektur — die vier offensichtlichen Non-Food-Beispiele', () => {
  for (const make of ALL_FOUR) {
    const sample = make();
    it(`„${sample.name}" ist NICHT food_like`, () => {
      expect(classifyReviewQueueClass(make())).not.toBe('food_like');
    });
  }

  it('harte Produktklassen (Werkzeug/Pumpe/Matte/Buch) werden confirmed_non_food', () => {
    for (const make of ALL_FOUR) {
      const o = make();
      expect(hasRuleConfirmedNonFoodSignal(o), o.name).toBe(true);
      expect(classifyFoodDecision(o), o.name).toBe('confirmed_non_food');
      // confirmed_non_food ⇒ gar kein offener Review-Fall mehr.
      expect(classifyReviewQueueClass(o), o.name).toBeNull();
    }
  });
});

describe('strukturelle Regel — inkonsistente canonical ist kein Food-Beleg', () => {
  // Generischer Fall OHNE Keyword-Treffer: der einzige food-ähnliche Hinweis ist
  // der repariert-e canonical-Flag. Vorher → food_like, jetzt → nonfood_like.
  const genericRepaired = (): Offer =>
    repairedNonFood('generic', 'Saison-Sortiment Überraschung', [
      'The product is a seasonal non-food assortment item, classified under Non-Food.',
    ]);

  it('der reparierte Food-Flag ist inkonsistent und zählt nicht als Food-Verdacht', () => {
    const o = genericRepaired();
    expect(hasInconsistentCanonicalFoodFlag(o)).toBe(true);
    expect(hasSuspectFoodEvidence(o)).toBe(false);
  });

  it('kein Keyword-Treffer ⇒ bleibt uncertain, aber nonfood_like statt food_like', () => {
    const o = genericRepaired();
    expect(hasRuleConfirmedNonFoodSignal(o)).toBe(false);
    expect(classifyFoodDecision(o)).toBe('uncertain');
    expect(classifyReviewQueueClass(o)).toBe('nonfood_like');
  });

  it('die Regel ist symmetrisch: nur Modelltext, NIE harter Non-Food-Beleg', () => {
    // Schwacher Modelltext darf nicht zu confirmed_non_food führen.
    expect(classifyFoodDecision(genericRepaired())).not.toBe('confirmed_non_food');
  });
});

describe('Regressionsschutz — echte Verdachts-/Sonderfälle bleiben stabil', () => {
  it('echter Food-Verdachtsfall (Modell-Food-Votum) bleibt food_like', () => {
    // foodFlag=food ohne unabhängigen Beleg = ehrlich food_like (Mensch prüft).
    const suspect = offer('suspect', 'Hausmarke Aktion', {
      category: 'Getränke Alkoholfrei',
      foodFlag: 'food',
      foodReasons: ['rule:category_food'],
      canonicalCategory: {
        sub: 'unknown',
        isNonFood: false,
        confidence: 0.8,
        reasons: ['Spritzring ist ein Küchenutensil', 'cache:hit'],
      },
    } as Partial<Offer>);
    expect(classifyFoodDecision(suspect)).toBe('uncertain');
    expect(classifyReviewQueueClass(suspect)).toBe('food_like');
  });

  it('echter Food-Flag OHNE Non-Food-Gründe bleibt food_like (nicht neutralisiert)', () => {
    const realFood = repairedNonFoodWithoutNonFoodReasons();
    expect(hasInconsistentCanonicalFoodFlag(realFood)).toBe(false);
    expect(classifyReviewQueueClass(realFood)).toBe('food_like');
  });

  function repairedNonFoodWithoutNonFoodReasons(): Offer {
    // Neutraler Name (kein Food-Keyword) + echtes positives canonical-Food-Verdikt
    // OHNE Non-Food-Gründe ⇒ bleibt ein ehrlicher Food-Verdacht (food_like).
    return offer('realfood', 'Marktkauf Eigenmarke Spezial', {
      category: 'Sonstiges',
      foodFlag: 'unsure',
      canonicalCategory: {
        main: 'Grundnahrungsmittel',
        sub: 'unknown',
        isNonFood: false,
        confidence: 0.74,
        reasons: ['The product is a packaged grocery food item.'],
      },
    } as Partial<Offer>);
  }

  it('Name-Fragment bleibt name_quality', () => {
    const fragment = offer('frag', 'extra', {
      foodFlag: 'unsure',
      canonicalCategory: { isNonFood: true, confidence: 0.3, reasons: ['cache:hit'] },
    } as Partial<Offer>);
    expect(classifyReviewQueueClass(fragment)).toBe('name_quality');
  });

  it('Cache-Konflikt bleibt cache_conflict', () => {
    const cacheConflict = offer('cc', 'Spritzring', {
      category: 'Getränke Alkoholfrei',
      foodFlag: 'food',
      canonicalCategory: {
        main: 'Non-Food',
        sub: 'Küche & Geräte',
        isNonFood: true,
        confidence: 0.55,
        reasons: ['Spritzring ist ein Küchenutensil', 'cache:hit'],
      },
    } as Partial<Offer>);
    expect(classifyReviewQueueClass(cacheConflict)).toBe('cache_conflict');
  });
});

describe('Report-Invarianten — Zähler + ReviewQueue-Invariante', () => {
  const filteredOffers: Offer[] = [
    bohrerBitSet(),
    elektrischePumpe(),
    fussmatte(),
    beschaeftigungsblock(),
    // Ein verbleibender echter food_like-Verdacht.
    offer('suspect', 'Hausmarke Aktion', {
      category: 'Getränke Alkoholfrei',
      foodFlag: 'food',
    } as Partial<Offer>),
    // Ein name_quality-Fragment.
    offer('frag', 'extra', {
      foodFlag: 'unsure',
      canonicalCategory: { isNonFood: true, confidence: 0.3, reasons: ['cache:hit'] },
    } as Partial<Offer>),
  ];

  it('nonFoodLeakCount und likelyFoodWronglyFilteredCount bleiben 0', () => {
    const fd = summarizeFoodDecisions({
      offers: [],
      nextWeekOffers: [],
      filteredOffers,
    });
    expect(fd.nonFoodLeakCount).toBe(0);
    expect(fd.wrongFoodFilteredCount).toBe(0); // = likelyFoodWronglyFilteredCount
  });

  it('die uncertain-ReviewQueue-Klassen summieren sich exakt zu uncertainFilteredCount', () => {
    const fd = summarizeFoodDecisions({ offers: [], nextWeekOffers: [], filteredOffers });
    const rq = summarizeReviewQueue(filteredOffers);
    expect(rq.foodLikeReview.count + rq.nonFoodLikeReview.count + rq.cacheConflictReview.count).toBe(
      fd.uncertainFilteredCount,
    );
  });

  it('die vier Beispiele tauchen nicht mehr in foodLikeReview.examples auf', () => {
    const rq = summarizeReviewQueue(filteredOffers);
    for (const make of ALL_FOUR) {
      expect(rq.foodLikeReview.examples).not.toContain(make().name);
    }
    // Nur der echte Verdacht bleibt food_like.
    expect(rq.foodLikeReview.count).toBe(1);
    expect(rq.foodLikeReview.examples).toEqual(['Hausmarke Aktion']);
  });
});
