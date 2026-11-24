import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { classifyFoodDecision } from './foodDecision';

// Generische, strukturelle Non-Food-Produktklassen (Task A–D). Produktnamen sind
// AUSSCHLIESSLICH Reproduktions-Fixtures — der Produktivcode kennt keine Produkt-/
// Marken-Allowlist und keinen KW-/Shop-Sonderfall. Geprüft wird die ZENTRALE
// classifyFoodDecision (Single Source of Truth).

function offer(name: string, extra: Partial<Offer> = {}): Offer {
  return {
    id: `id_${name}`,
    name,
    normalizedName: name.toLowerCase(),
    storeChain: 'REWE',
    category: '',
    price: 9.99,
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

describe('Problem A — generische Non-Food-Produktklassen sind confirmed_non_food', () => {
  // Test 1: jede generische Klasse aus Problem A.
  const nonFoodClasses = [
    '3-fach-Steckdosenleiste',
    'LED-Tischleuchte',
    'In-Ear-Kopfhörer',
    'All-in-One-Drucker',
    'Druckerpatrone',
    'BENCH Roll-Top-Rucksack',
    'PUMA Sporttasche',
    'Grillbürste',
    'Leinen-Mix-Bettwäsche',
    'Kopfkissen',
    'Reise-Packtaschen-Set',
    'Kinder-Cap',
    'Eisschale',
    'Eiswürfelform',
    'Steckdosenadapter',
    'Solarleuchte Garten',
    'WEINBERGER Schrank-Schiebekorb',
    'Flexibler Wasserhahnanschluss',
    'Unkrautvlies 2m',
  ];
  for (const name of nonFoodClasses) {
    it(`„${name}" → confirmed_non_food`, () => {
      expect(classifyFoodDecision(offer(name))).toBe('confirmed_non_food');
    });
  }
});

describe('Live-Befund 2026-06-22 — offensichtliche Non-Food-Klassen dürfen NIE food_like werden', () => {
  // Reproduziert die im Phase-2-Report fälschlich als food_like gemeldeten Namen.
  // Das Modell-Flag foodFlag='food' DARF eine harte/regelbestätigte Non-Food-
  // Produktklasse (Möbel/Regal, Autozubehör/Autopflege, Schuhwerk) NICHT
  // hochziehen — hasRuleConfirmedNonFoodSignal läuft VOR jedem Food-Signal.
  const obviousNonFood = [
    'Anbau-Regal', // Möbel/Einrichtung
    'Auto-Accessoires', // Autozubehör
    'Autopflege', // Autopflege/Drogerie
    'Badeschlappen', // Schuhwerk
  ];
  for (const name of obviousNonFood) {
    it(`„${name}" → confirmed_non_food trotz foodFlag=food (nicht food_like)`, () => {
      const o = offer(name, {
        foodFlag: 'food',
        category: 'Sonstiges',
        canonicalCategory: { isNonFood: false, main: 'Grundnahrungsmittel', confidence: 0.4 },
      } as Partial<Offer>);
      expect(classifyFoodDecision(o)).toBe('confirmed_non_food');
    });
  }
});

describe('Problem A — Food-Komposita werden NICHT versehentlich getroffen', () => {
  // Test 2: essbare Komposita mit „-tasche"/„-topf"/„cap"/„lampe" bleiben Food/uncertain.
  const ediblesNotNonFood = [
    'Quarktasche',
    'Maultaschen',
    'Kartoffeltaschen',
    'Hähnchen-Grilltasche',
    'Cappuccino',
    'Eintopf',
    'Pilzpfanne Tiefkühl',
  ];
  for (const name of ediblesNotNonFood) {
    it(`„${name}" ist NICHT confirmed_non_food`, () => {
      expect(classifyFoodDecision(offer(name))).not.toBe('confirmed_non_food');
    });
  }
});

describe('Problem B — Pflanzen/Gegenstände werden nicht vom Food-Rescue zurückgeholt', () => {
  // Ein starkes Produktklassen-Signal gewinnt gegen schwache Food-Keywords
  // (Wein/Wasser/Milch), weil hasRuleConfirmedNonFoodSignal VOR hasStrongFoodSignal
  // ausgewertet wird (classifyFoodDecision-Priorität).
  it('Test 3+4: Zierpflanze/Übertopf und Blumen-/Rosenstrauß bleiben Non-Food', () => {
    for (const name of [
      'Bromelie oder Calla im Keramik-Übertopf',
      'Citrus-Stämmchen im Keramik-Übertopf',
      'Sprayrosen Mixstrauß',
    ]) {
      expect(classifyFoodDecision(offer(name)), name).toBe('confirmed_non_food');
    }
  });

  it('Test 5: Schrank-Schiebekorb gewinnt gegen „Wein"(berger)', () => {
    expect(classifyFoodDecision(offer('WEINBERGER Schrank-Schiebekorb'))).toBe(
      'confirmed_non_food',
    );
  });

  it('Test 6: Wasserhahnanschluss gewinnt gegen „Wasser"', () => {
    expect(classifyFoodDecision(offer('Flexibler Wasserhahnanschluss'))).toBe(
      'confirmed_non_food',
    );
  });

  it('Magic Milk Mix Milchtrink-Halme: Milch-/Aroma-Kontext macht den Halm essbar (Food)', () => {
    // Policy-Umkehr: aromatisierende Milchtrink-Halme sind essbares Lebensmittel-
    // zubehör, kein Gegenstand. Der Milch-Kontext hebt das Halm-Non-Food-Signal auf.
    expect(classifyFoodDecision(offer('Magic Milk Mix Milchtrink-Halme'))).toBe('confirmed_food');
  });

  it('Gegentest: PLAINE Trinkhalme/Strohhalme ohne Food-Kontext bleiben Non-Food', () => {
    for (const name of ['Trinkhalme 100 Stück', 'Papier-Strohhalme', 'Trinkhalm wiederverwendbar']) {
      expect(classifyFoodDecision(offer(name)), name).toBe('confirmed_non_food');
    }
  });
});

describe('Problem C — mehrdeutige Einwortnamen bleiben uncertain', () => {
  // Test 7: ohne Produkt-/Einheiten-/Quellen-/Kategoriesignal nie blind gerettet.
  it('„Gold"/„Auslese" allein → uncertain', () => {
    for (const name of ['Gold', 'Auslese']) {
      expect(classifyFoodDecision(offer(name)), name).toBe('uncertain');
    }
  });

  it('mehrdeutiger Name + nur niedrig-vertrauende KI-/Cache-Kategorie → uncertain', () => {
    const withWeakCanonical = offer('Auslese', {
      canonicalCategory: { isNonFood: false, main: 'Wein', confidence: 0.3 },
    } as Partial<Offer>);
    expect(classifyFoodDecision(withWeakCanonical)).toBe('uncertain');
  });
});

describe('Problem D — echte Lebensmittel bleiben nicht im Filter', () => {
  // Test 8: Karottini mit Dip → Food, ein isoliertes Modell-Non-Food-Flag darf die
  // strukturellen Food-Belege (Frischkäse/Dip) nicht überstimmen. „Schnell und
  // einfach" ist neutral/Food-nah, kein Non-Food-Beleg.
  it('Karottini mit Frischkäse-Lauch-Dip ist Food trotz foodFlag=nonfood', () => {
    const karottini = offer('Karottini mit Frischkäse-Lauch-Dip', {
      sourceCategoryRaw: 'Schnell und einfach',
      foodFlag: 'nonfood',
      reviewReason: 'rule_conflict,low_confidence',
    } as Partial<Offer>);
    expect(classifyFoodDecision(karottini)).toBe('confirmed_food');
  });

  // Test 9: Spritzring (Gebäck-vs-Gegenstand) wird nicht blind Non-Food.
  it('Spritzring wird nicht blind Non-Food (mind. uncertain, Phase-2-fähig)', () => {
    expect(classifyFoodDecision(offer('Spritzring'))).not.toBe('confirmed_non_food');
  });

  // Test 10: ein eindeutiger Gegenstands-Ring (Quellabteilung Haushalt) bleibt Non-Food.
  it('Serviettenring aus der Abteilung Haushalt bleibt Non-Food', () => {
    const ring = offer('Serviettenring 4er', {
      sourceCategoryRaw: 'Haushalt & Wohnen',
    } as Partial<Offer>);
    expect(classifyFoodDecision(ring)).toBe('confirmed_non_food');
  });
});
