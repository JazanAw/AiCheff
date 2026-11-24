import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  classifyReviewQueueClass,
  classifyReviewReductionClass,
  summarizeReviewQueue,
  summarizeReviewReduction,
} from './reviewReductionClasses';
import { classifyFoodDecision, summarizeFoodDecisions } from './foodDecision';

// Task P3 — Review-Reduktion ohne falsche Rettung. Nur eindeutige, generische
// Evidenzklassen entscheiden sicher; mehrdeutige Kurznamen bleiben Review.
// Produktnamen sind reine Reproduktions-Fixtures — keine Produktiv-Allowlist.

function offer(name: string, extra: Partial<Offer> & Record<string, unknown> = {}): Offer {
  return {
    id: `id_${name}_${JSON.stringify(extra).length}`,
    name,
    normalizedName: name.toLowerCase(),
    storeChain: 'REWE',
    category: 'Sonstiges',
    price: 1.99,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: '2026-06-14T00:00:00.000Z',
    validityEnd: '2026-06-21T23:59:59.000Z',
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-06-14T00:00:00.000Z',
    ...extra,
  } as Offer;
}

describe('classifyReviewReductionClass — generische Evidenzklassen', () => {
  it('eindeutige Lebensmittel-Quellabteilung ⇒ food_source_department', () => {
    const o = offer('Hausmarke Spezial', { sourceCategoryRaw: 'Molkerei' } as Partial<Offer>);
    expect(classifyFoodDecision(o)).toBe('confirmed_food');
    expect(classifyReviewReductionClass(o)).toBe('food_source_department');
  });

  it('Food-Domänenvokabular im Namen ⇒ food_name_vocabulary', () => {
    const o = offer('Frische Vollmilch 3,8 %');
    expect(classifyReviewReductionClass(o)).toBe('food_name_vocabulary');
  });

  it('starkes Non-Food-Keyword ⇒ nonfood_strong_keyword', () => {
    const o = offer('LIVARNO UV-Insektenfalle');
    expect(classifyReviewReductionClass(o)).toBe('nonfood_strong_keyword');
  });

  it('vertrauenswürdiges nonfood-Tag ⇒ nonfood_tag', () => {
    const o = offer('Irgendetwas', { tags: ['nonfood'] });
    expect(classifyReviewReductionClass(o)).toBe('nonfood_tag');
  });

  it('eindeutige Non-Food-Produktklasse (Heimtextil) ⇒ nonfood_structural_context', () => {
    const o = offer('Kopfkissen 80x80');
    expect(classifyFoodDecision(o)).toBe('confirmed_non_food');
    expect(classifyReviewReductionClass(o)).toBe('nonfood_structural_context');
  });

  it('Bewegungs-Guard (Fragment) ⇒ movement_guard, nie Review', () => {
    const o = offer('Tiefpreis');
    expect(classifyReviewReductionClass(o)).toBe('movement_guard');
  });
});

describe('Review-Reduktion reduziert NUR sichere Klassen', () => {
  it('mehrdeutige Marken-/Kurznamen bleiben Review (keine pauschale Rettung)', () => {
    for (const o of [
      offer('Gold', { brand: 'Jacobs' }),
      offer('Auslese', { brand: 'Melitta' }),
      offer('Hausmarke Spezial Edition'),
    ]) {
      expect(classifyReviewReductionClass(o), o.name).toBe('review');
    }
  });

  it('Summary trennt sicher entschiedene Klassen von verbleibenden Reviews', () => {
    const filtered: Offer[] = [
      offer('Hausmarke Spezial', { sourceCategoryRaw: 'Molkerei' } as Partial<Offer>), // food_source_department
      offer('Frische Vollmilch 3,8 %'), // food_name_vocabulary
      offer('LIVARNO UV-Insektenfalle'), // nonfood_strong_keyword
      offer('Kopfkissen 80x80'), // nonfood_structural_context
      offer('Gold', { brand: 'Jacobs' }), // review
      offer('Auslese', { brand: 'Melitta' }), // review
    ];
    const summary = summarizeReviewReduction(filtered);
    expect(summary.reviewRemaining).toBe(2);
    expect(summary.resolvedByClassTotal).toBe(4);
    const byClass = Object.fromEntries(summary.resolvedByClass.map((r) => [r.class, r.count]));
    expect(byClass.food_source_department).toBe(1);
    expect(byClass.food_name_vocabulary).toBe(1);
    expect(byClass.nonfood_strong_keyword).toBe(1);
    expect(byClass.nonfood_structural_context).toBe(1);
    // Karottini bleibt live Food (Regression): trotz Non-Food-Artefakten ein
    // harter Food-Beleg ⇒ kein Review, sondern Food-Vokabular-Klasse.
    const karottini = offer('Karottini mit Frischkäse-Lauch-Dip', {
      tags: ['nonfood'],
      foodFlag: 'nonfood',
      canonicalCategory: { isNonFood: true, main: 'Non-Food' },
    } as Partial<Offer>);
    expect(classifyReviewReductionClass(karottini)).toBe('food_name_vocabulary');
  });
});

describe('ReviewQueue (Live-Befund 2026-06-22) — offensichtliches Non-Food nie food_like', () => {
  // Echte Befund-Shapes: das Modell lieferte foodFlag='food' + geratene Food-
  // Kategorie. Vor dem Fix landeten diese als food_like; jetzt entscheidet die
  // harte Produktklassen-Regel zentral auf confirmed_non_food (raus aus der
  // Review-Queue, rein in confirmedNonFoodFiltered).
  function modelFood(name: string): Offer {
    return offer(name, {
      foodFlag: 'food',
      category: 'Sonstiges',
      canonicalCategory: { isNonFood: false, main: 'Grundnahrungsmittel', confidence: 0.4 },
    } as Partial<Offer>);
  }

  for (const name of ['Anbau-Regal', 'Auto-Accessoires', 'Autopflege', 'Badeschlappen']) {
    it(`„${name}" → confirmed_non_food, classifyReviewQueueClass=null (nicht food_like)`, () => {
      const o = modelFood(name);
      expect(classifyFoodDecision(o)).toBe('confirmed_non_food');
      // confirmed_* ⇒ kein offener Review-Fall mehr (auch nicht nonfood_like).
      expect(classifyReviewQueueClass(o)).toBeNull();
    });
  }

  it('echter Food-Verdacht bleibt food_like; Fragment bleibt name_quality; Cache-Konflikt bleibt cache_conflict', () => {
    const foodSuspect = offer('Mysterium A', { foodFlag: 'food', unit: 'stück' });
    const fragment = offer('kernarm', {
      foodFlag: 'unsure',
      unit: '1-kg',
      canonicalCategory: {
        main: 'Non-Food',
        isNonFood: true,
        confidence: 0.4,
        reasons: ["Product name 'kernarm' does not indicate a food item.", 'cache:hit'],
      },
    } as Partial<Offer>);
    const cacheConflict = offer('Spritzring', {
      category: 'Getränke Alkoholfrei',
      unit: 'stück',
      foodFlag: 'food',
      canonicalCategory: {
        main: 'Non-Food',
        isNonFood: true,
        confidence: 0.8,
        reasons: ['Küchenutensil', 'cache:hit'],
      },
    } as Partial<Offer>);
    expect(classifyReviewQueueClass(foodSuspect)).toBe('food_like');
    expect(classifyReviewQueueClass(fragment)).toBe('name_quality');
    expect(classifyReviewQueueClass(cacheConflict)).toBe('cache_conflict');
  });

  it('Report-Invariante: keine offensichtlichen Non-Food-Beispiele in foodLikeReview; nonFoodLeak/likelyFoodWronglyFiltered bleiben 0', () => {
    const filtered: Offer[] = [
      modelFood('Anbau-Regal'),
      modelFood('Auto-Accessoires'),
      modelFood('Autopflege'),
      modelFood('Badeschlappen'),
      offer('Mysterium A', { foodFlag: 'food', unit: 'stück' }), // bleibt food_like
    ];
    const queue = summarizeReviewQueue(filtered);
    for (const blocked of ['Anbau-Regal', 'Auto-Accessoires', 'Autopflege', 'Badeschlappen']) {
      expect(queue.foodLikeReview.examples).not.toContain(blocked);
      expect(queue.nonFoodLikeReview.examples).not.toContain(blocked);
    }
    expect(queue.foodLikeReview.examples).toContain('Mysterium A');
    // Die vier offensichtlichen Non-Food fallen aus der uncertain-Review-Queue.
    const fd = summarizeFoodDecisions({ offers: [], nextWeekOffers: [], filteredOffers: filtered });
    expect(fd.nonFoodLeakCount).toBe(0);
    expect(fd.wrongFoodFilteredCount).toBe(0);
    expect(fd.confirmedNonFoodFilteredCount).toBe(4);
    expect(fd.uncertainFilteredCount).toBe(1);
    // Invariante P4: uncertain-Klassen summieren sich exakt zu uncertainFilteredCount.
    expect(
      queue.foodLikeReview.count + queue.nonFoodLikeReview.count + queue.cacheConflictReview.count,
    ).toBe(fd.uncertainFilteredCount);
  });
});
