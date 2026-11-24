import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { classifyFoodDecision } from './foodDecision';
import { hasMultiSignalFoodEvidence } from './offersStrictFoodFilter';

// Task P1 — strukturelle Mehrsignal-Evidenz für gefilterte uncertain/Review-Fälle.
// Ein veralteter Cache-Hit darf nicht hart Non-Food sein; foodFlag=food ALLEIN
// reicht nie; erst mehrere unabhängige strukturelle Belege machen einen Fall zu
// confirmed_food. Produktnamen sind reine Reproduktions-Fixtures — KEIN
// Produktivcode kennt eine Produkt-/Marken-Allowlist oder KW-Sonderregel.

const CURRENT = {
  validityStart: '2026-06-14T00:00:00.000Z',
  validityEnd: '2026-06-21T23:59:59.000Z',
};

function offer(name: string, extra: Partial<Offer> & Record<string, unknown> = {}): Offer {
  return {
    id: name,
    name,
    normalizedName: name.toLowerCase(),
    storeChain: 'Netto',
    category: 'Sonstiges',
    price: 1.99,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: CURRENT.validityStart,
    validityEnd: CURRENT.validityEnd,
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-06-14T00:00:00.000Z',
    ...extra,
  } as Offer;
}

describe('P1 — Mehrsignal-Evidenz hebt einen gefilterten Fall NUR bei genug Belegen', () => {
  it('foodFlag=food ALLEIN reicht nicht (bleibt uncertain)', () => {
    const o = offer('Irgendwas', { foodFlag: 'food', category: 'Sonstiges', unit: 'stück' });
    expect(hasMultiSignalFoodEvidence(o)).toBe(false);
    expect(classifyFoodDecision(o)).toBe('uncertain');
  });

  it('foodFlag=food + Food-Kategorie ALLEIN reicht nicht (Spritzring-ähnlich, Stück-Einheit)', () => {
    const o = offer('Spritzring', {
      foodFlag: 'food',
      category: 'Getränke Alkoholfrei',
      unit: 'stück',
      sourceCategoryRaw: 'Filialangebote',
      canonicalCategory: {
        main: 'Non-Food',
        sub: 'Küche & Geräte',
        isNonFood: true,
        confidence: 0.8,
        reasons: ['Küchenutensil', 'cache:hit'],
      },
    });
    // Nur EIN unabhängiges Signal (Food-Kategorie) ⇒ ehrlich uncertain.
    expect(hasMultiSignalFoodEvidence(o)).toBe(false);
    expect(classifyFoodDecision(o)).toBe('uncertain');
  });

  it('foodFlag=food + Food-Einheit + Food-Kategorie ⇒ confirmed_food (zwei unabhängige Belege)', () => {
    const o = offer('Mystery Drink', {
      foodFlag: 'food',
      category: 'Getränke Alkoholfrei',
      unit: '1l',
      sourceCategoryRaw: 'Filialangebote',
      canonicalCategory: { main: 'Non-Food', isNonFood: true, confidence: 0.55, reasons: ['cache:hit'] },
    });
    expect(hasMultiSignalFoodEvidence(o)).toBe(true);
    expect(classifyFoodDecision(o)).toBe('confirmed_food');
  });

  it('ein hartes Non-Food-Signal schlägt die Mehrsignal-Evidenz (kein blindes Retten)', () => {
    const o = offer('Spülmittel Zitrone', {
      foodFlag: 'food',
      category: 'Getränke Alkoholfrei',
      unit: '1l',
    });
    // 'spuelmittel' ist ein starkes Non-Food-Keyword ⇒ Regel gewinnt.
    expect(classifyFoodDecision(o)).toBe('confirmed_non_food');
  });

  it('Mehrsignal-Evidenz greift nie ohne foodFlag=food', () => {
    const o = offer('Mystery', { foodFlag: 'unsure', category: 'Getränke Alkoholfrei', unit: '1l' });
    expect(hasMultiSignalFoodEvidence(o)).toBe(false);
    expect(classifyFoodDecision(o)).toBe('uncertain');
  });
});
