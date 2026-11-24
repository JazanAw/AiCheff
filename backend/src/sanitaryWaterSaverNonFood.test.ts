import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { classifyFoodDecision } from './foodDecision';
import {
  classifyFilteredOfferForRescue,
  partitionFilteredOffersForCompleteness,
} from './snapshotFoodRescue';
import { buildScanReport } from './scanReport';

// Live-Befund 2026-06-29: „PUREGREEN Dusch-Wassersparer" (Kaufland) wurde über das
// Food-Wort „Wasser" (foodKeywords) fälschlich als food_like / likelyFoodWrongly-
// Filtered / foodSuspect gemeldet, obwohl es ein eindeutiges Sanitär-/Bad-Produkt
// ist. Die Fixtures sind AUSSCHLIESSLICH Reproduktion — der Produktivcode kennt
// KEINE Produkt-/Marken-Allowlist („PUREGREEN" steht nirgends), keine KW-/Kalender-
// und keine Shop-Sonderlogik. Geprüft wird die generische, strukturelle Sanitär-/
// Wasserspar-Regel in offersStrictFoodFilter (NON_FOOD_PRODUCT_CLASS_KEYWORDS), die
// über hasRuleConfirmedNonFoodSignal VOR jedem Food-Signal gewinnt.

function offer(name: string, extra: Partial<Offer> = {}): Offer {
  return {
    id: `id_${name}`,
    name,
    normalizedName: name.toLowerCase(),
    storeChain: 'Kaufland',
    category: '',
    price: 4.99,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: '2026-06-08T00:00:00.000Z',
    validityEnd: '2026-06-13T23:59:59.000Z',
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-06-08T00:00:00.000Z',
    ...extra,
  } as Offer;
}

describe('Sanitär-/Wasserspar-Produkte sind generisch confirmed_non_food', () => {
  // Positive Non-Food-Fälle: eindeutige Sanitär-/Bad-/Dusch-/Armatur-Produkte.
  const sanitaryNonFood = [
    'PUREGREEN Dusch-Wassersparer',
    'Dusch-Wassersparer',
    'Wasserhahn-Aufsatz',
    'Duschkopf',
    'Spardusche',
    'Wassersparer für Dusche',
    'Sanitär-Armatur',
  ];
  for (const name of sanitaryNonFood) {
    it(`„${name}" → confirmed_non_food`, () => {
      expect(classifyFoodDecision(offer(name))).toBe('confirmed_non_food');
    });
  }

  it('gewinnt auch gegen ein Modell-Flag foodFlag=food (nicht food_like)', () => {
    const o = offer('PUREGREEN Dusch-Wassersparer', {
      foodFlag: 'food',
      category: 'Getränke',
      canonicalCategory: { isNonFood: false, main: 'Getränke', confidence: 0.4 },
    } as Partial<Offer>);
    expect(classifyFoodDecision(o)).toBe('confirmed_non_food');
  });
});

describe('Echte Wasser-Lebensmittel bleiben Food (kein pauschales „wasser=non-food")', () => {
  // Negative Schutzfälle: das Food-Wort „Wasser" darf weiter greifen.
  const realFoodWater = [
    'Mineralwasser',
    'Tafelwasser',
    'Trinkwasser 1,5 l',
    'Wasser mit Geschmack',
    'Kokoswasser',
    'Wassermelone',
    'Eiswasser',
    'Wasser Eis',
  ];
  for (const name of realFoodWater) {
    it(`„${name}" ist NICHT confirmed_non_food`, () => {
      expect(classifyFoodDecision(offer(name))).not.toBe('confirmed_non_food');
    });
  }

  it('„Mineralwasser" bleibt confirmed_food (positiver Food-Beleg, nicht nur uncertain)', () => {
    expect(classifyFoodDecision(offer('Mineralwasser'))).toBe('confirmed_food');
  });
});

describe('Rescue-/Completeness-Verdict: der Sanitär-Verdacht ist kein Food-Suspect', () => {
  it('classifyFilteredOfferForRescue → keep (kein rescue/suspect)', () => {
    expect(classifyFilteredOfferForRescue(offer('PUREGREEN Dusch-Wassersparer'))).toBe('keep');
  });

  it('partitionFilteredOffersForCompleteness: ruleNonFood statt suspect', () => {
    const partition = partitionFilteredOffersForCompleteness([
      offer('PUREGREEN Dusch-Wassersparer'),
    ]);
    expect(partition.suspectNames).toHaveLength(0);
    expect(partition.ruleNonFoodNames).toContain('PUREGREEN Dusch-Wassersparer');
  });
});

describe('Scan-Report + Store-Health: kein likelyFoodWronglyFiltered/foodSuspect mehr', () => {
  it('ein gefilterter „Dusch-Wassersparer" erhöht keine der Verdachts-Zähler', () => {
    const report = buildScanReport({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [offer('PUREGREEN Dusch-Wassersparer')],
      now: new Date('2026-06-10T12:00:00.000Z'),
    });

    expect(report.likelyFoodWronglyFilteredCount).toBe(0);
    expect(report.likelyFoodWronglyFilteredExamples).not.toContain('PUREGREEN Dusch-Wassersparer');
    expect(report.nonFoodLeakCount).toBe(0);

    const kaufland = report.storeImportHealth.stores.find((s) => s.storeChain === 'Kaufland');
    expect(kaufland).toBeDefined();
    expect(kaufland?.foodSuspectCount).toBe(0);
    expect(kaufland?.foodInFilterExamples).not.toContain('PUREGREEN Dusch-Wassersparer');
  });
});
