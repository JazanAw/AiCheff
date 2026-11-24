import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { classifyFoodDecision, summarizeFoodDecisions } from './foodDecision';
import { classifyReviewQueueClass, summarizeReviewQueue } from './reviewReductionClasses';
import { hasRuleConfirmedNonFoodSignal } from './offersStrictFoodFilter';

// Letzter offensichtlicher ReviewQueue-False-Positive (Live-Befund 2026-06-22):
// foodLikeReview enthielt noch „Getränke- / Lunchbehälter, Trinkbecher, Blau".
//
// ROOT CAUSE: Ein Trinkbecher/Lunchbehälter ist ein GEGENSTAND (Non-Food), aber
// keine Regel erkannte ihn — `lunchbehaelter`/`trinkbecher` standen in keiner
// Liste. Daher hasRuleConfirmedNonFoodSignal=false ⇒ classifyFoodDecision=uncertain.
// Das Wort „Getränke" bzw. das Modell-Food-Votum machten hasSuspectFoodEvidence=true
// ⇒ der Fall wurde food_like statt confirmed_non_food.
//
// STRUKTURELLE REGEL (kein Einzelwort-Fix, keine Marken-/Produkt-/Shop-Liste): eine
// generische Behälter-/Geschirr-/Aufbewahrungs-Klasse (hasContainerObjectNonFood)
// macht den Fall confirmed_non_food. Sie ist zweistufig:
//   1. eindeutige Behälter-Komposita (Trinkbecher/Lunchbehälter/Brotdose/…),
//   2. ein mehrdeutiges Kopfnomen (becher/behaelter/flasche/dose/box) NUR mit einem
//      Behälter-Kontextwort (trink/lunch/getraenke/aufbewahr/vorrat/thermo/…).
// Echte Lebensmittel im Becher/in der Dose (Joghurt-/Pudding-/Eisbecher, Tomaten-
// dose) tragen einen FOOD-Modifikator, KEINEN Behälter-Kontext, und bleiben Food.
//
// Produktnamen sind reine Reproduktions-Fixtures.

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

describe('Behälter-/Becher-Klasse — der Live-False-Positive', () => {
  // Exakte Live-Shape: das Modell stimmte wegen „Getränke" für Food (foodFlag=food,
  // Kategorie Getränke). Vor dem Fix ⇒ food_like.
  const lunchbehaelter = (): Offer =>
    offer('lunch', 'Getränke- / Lunchbehälter, Trinkbecher, Blau', {
      category: 'Getränke Alkoholfrei',
      foodFlag: 'food',
    } as Partial<Offer>);

  it('„Getränke- / Lunchbehälter, Trinkbecher, Blau" ist NICHT food_like', () => {
    expect(classifyReviewQueueClass(lunchbehaelter())).not.toBe('food_like');
  });

  it('der Behälter wird confirmed_non_food (Regel schlägt das Getränke-/Food-Votum)', () => {
    const o = lunchbehaelter();
    expect(hasRuleConfirmedNonFoodSignal(o)).toBe(true);
    expect(classifyFoodDecision(o)).toBe('confirmed_non_food');
    // confirmed_non_food ⇒ gar kein offener Review-Fall mehr.
    expect(classifyReviewQueueClass(o)).toBeNull();
  });
});

describe('generische Behälter-/Geschirr-Klasse wird Non-Food', () => {
  const NON_FOOD_CONTAINERS = [
    'Trinkbecher',
    'Lunchbox',
    'Brotdose',
    'Vorratsdose',
    'Aufbewahrungsdose',
    'Thermobecher',
    'Isolierbecher',
    'Vakuumbecher',
    'Reisebecher',
    'Trinkflasche Edelstahl',
    'Thermobehälter Lunch',
    'Getränke-Behälter',
  ];

  for (const name of NON_FOOD_CONTAINERS) {
    it(`„${name}" ist confirmed_non_food`, () => {
      const o = offer(name, name, { foodFlag: 'food' } as Partial<Offer>);
      expect(classifyFoodDecision(o)).toBe('confirmed_non_food');
      expect(classifyReviewQueueClass(o)).toBeNull();
    });
  }
});

describe('Regressionsschutz — echte Lebensmittel im Becher/in der Dose bleiben Food', () => {
  const FOOD_IN_CONTAINER = [
    'Joghurtbecher',
    'Puddingbecher',
    'Sahnebecher',
    'Eisbecher',
    'Frucht-Joghurt im Becher',
    'Tomatendose',
  ];

  for (const name of FOOD_IN_CONTAINER) {
    it(`„${name}" ist NICHT confirmed_non_food (kein Behälter-Beleg)`, () => {
      const o = offer(name, name, {
        category: 'Milchprodukte',
        foodFlag: 'food',
      } as Partial<Offer>);
      expect(hasRuleConfirmedNonFoodSignal(o)).toBe(false);
      expect(classifyFoodDecision(o)).not.toBe('confirmed_non_food');
    });
  }

  it('„Joghurtbecher" im Filter ist genau EIN falsch gefiltertes Lebensmittel (wrongFoodFiltered=1)', () => {
    // Echtes Food-Signal (Wortstamm „joghurt" + Food-Kategorie): ein Joghurtbecher
    // ist confirmed_food. Liegt er im Filter, MUSS wrongFoodFilteredCount=1 sein —
    // das ist KEIN Behälter-Fehlverhalten, sondern korrektes Aufdecken eines falsch
    // gefilterten Lebensmittels. Daher gehört er NIE in eine 0-Invariante-Fixture.
    const joghurt = offer('joghurt', 'Joghurtbecher', {
      category: 'Milchprodukte',
      foodFlag: 'food',
    } as Partial<Offer>);
    expect(classifyFoodDecision(joghurt)).toBe('confirmed_food');
    const fd = summarizeFoodDecisions({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [joghurt],
    });
    expect(fd.wrongFoodFilteredCount).toBe(1);
    expect(fd.nonFoodLeakCount).toBe(0);
  });

  it('„Top Cup" bleibt food_like (kein harter Behälter-Beleg, Mensch prüft)', () => {
    // category Milchprodukte + ProductAnalysis-Milchsignal ⇒ echter Food-Verdacht.
    const topCup = offer('topcup', 'Top Cup', {
      category: 'Milchprodukte',
      foodFlag: 'food',
    } as Partial<Offer>);
    expect(hasRuleConfirmedNonFoodSignal(topCup)).toBe(false);
    expect(classifyFoodDecision(topCup)).toBe('uncertain');
    expect(classifyReviewQueueClass(topCup)).toBe('food_like');
  });
});

describe('Report-Invarianten — Zähler + ReviewQueue-Invariante', () => {
  const filteredOffers: Offer[] = [
    offer('lunch', 'Getränke- / Lunchbehälter, Trinkbecher, Blau', {
      category: 'Getränke Alkoholfrei',
      foodFlag: 'food',
    } as Partial<Offer>),
    offer('becher', 'Trinkbecher', { foodFlag: 'food' } as Partial<Offer>),
    // Echter food_like-Verdacht bleibt (Top Cup). Bewusst KEIN echtes Lebensmittel
    // (z. B. Joghurtbecher) in dieser Fixture: ein confirmed_food im Filter wäre ein
    // wrongFoodFiltered-Fall und würde die 0-Invariante korrekt verletzen — das wird
    // separat oben getestet, nicht hier vermischt.
    offer('topcup', 'Top Cup', {
      category: 'Milchprodukte',
      foodFlag: 'food',
    } as Partial<Offer>),
  ];

  it('nonFoodLeakCount und wrongFoodFilteredCount bleiben 0', () => {
    const fd = summarizeFoodDecisions({ offers: [], nextWeekOffers: [], filteredOffers });
    expect(fd.nonFoodLeakCount).toBe(0);
    expect(fd.wrongFoodFilteredCount).toBe(0); // = likelyFoodWronglyFilteredCount
  });

  it('die uncertain-ReviewQueue-Klassen summieren sich exakt zu uncertainFilteredCount', () => {
    const fd = summarizeFoodDecisions({ offers: [], nextWeekOffers: [], filteredOffers });
    const rq = summarizeReviewQueue(filteredOffers);
    expect(
      rq.foodLikeReview.count + rq.nonFoodLikeReview.count + rq.cacheConflictReview.count,
    ).toBe(fd.uncertainFilteredCount);
  });

  it('die Behälter tauchen nicht mehr in foodLikeReview auf', () => {
    const rq = summarizeReviewQueue(filteredOffers);
    expect(rq.foodLikeReview.examples).not.toContain('Getränke- / Lunchbehälter, Trinkbecher, Blau');
    expect(rq.foodLikeReview.examples).not.toContain('Trinkbecher');
    // Top Cup + Joghurtbecher bleiben ehrlicher Food-Verdacht.
    expect(rq.foodLikeReview.examples).toContain('Top Cup');
  });
});
