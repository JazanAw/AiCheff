import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { classifyFoodDecision, summarizeFoodDecisions } from './foodDecision';
import { hasRuleConfirmedNonFoodSignal } from './offersStrictFoodFilter';

// False-Live-Angebote: Non-Food (Kinder-Textil/Sommer-Set, Zierpflanzen) lag im
// current/live-Bucket, obwohl der Report nonFoodLeakCount=0 meldete — die zentrale
// {@link classifyFoodDecision} erkannte die Klasse strukturell nicht als
// confirmed_non_food. Drei strukturelle Klassen, KEINE Produkt-/Marken-Allowlist,
// kein KW-/Shop-/Wochen-Sonderfall:
//   1. Kinder-Textil/Sommer-Set über das Konfektionsgrößen-Paar (z. B. „98/104").
//   2. Garten-/Zierpflanze über die Garten-Eigenmarke (Gardenline, wie Florabest).
//   3. Zierpflanzen-Arten (Kalanchoe/Edelweiss/Enzian) als Botanik-Vokabular —
//      mit Getränke-/Alkohol-Veto, damit „Edelweiss"-Weißbier/„Enzian"-Schnaps
//      Food bleiben.
//
// Produktnamen sind reine Reproduktions-Fixtures.

const CURRENT = {
  validityStart: '2026-06-18T00:00:00.000Z',
  validityEnd: '2026-06-24T23:59:59.999Z',
};

function offer(name: string, extra: Partial<Offer> & Record<string, unknown> = {}): Offer {
  return {
    id: `o_${name}`,
    name,
    normalizedName: name.toLowerCase(),
    storeChain: 'ALDI SUED',
    category: 'Sonstiges',
    price: 4.99,
    currency: 'EUR',
    unit: 'stk',
    validityStart: CURRENT.validityStart,
    validityEnd: CURRENT.validityEnd,
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-06-22T01:00:00.000Z',
    ...extra,
  } as Offer;
}

// Exakte ALDI-Shape: das Modell halluzinierte eine Food-Kategorie (Snacks/Süßes)
// und foodFlag=food, also blieb der Fall fälschlich live statt confirmed_non_food.
function kinderSommerSet(name: string): Offer {
  return offer(name, {
    category: 'Snacks/Süßes',
    foodFlag: 'food',
    canonicalCategory: { isNonFood: false, confidence: 0.8, reasons: ['cache:hit'] },
  } as Partial<Offer>);
}

describe('False-Live Non-Food — Kinder-Textil/Sommer-Set (Konfektionsgröße)', () => {
  const repro = [
    'Kinder Sommer-Set Paw Patrol Türkis/Floral 98/104',
    'Kinder Sommer-Set Spiderman Rot/Schwarz 98/104',
    'Kinder Sommer-Set Vaiana Creme/Türkis 98/104',
  ];
  for (const name of repro) {
    it(`„${name}" ⇒ confirmed_non_food (nicht live)`, () => {
      const o = kinderSommerSet(name);
      expect(hasRuleConfirmedNonFoodSignal(o)).toBe(true);
      expect(classifyFoodDecision(o)).toBe('confirmed_non_food');
    });
  }

  it('generisch (keine Allowlist): auch ohne „Kinder"/Lizenzfigur, auch getrennt geschrieben', () => {
    for (const name of ['Sommer-Set 98/104', 'Mädchen T-Shirt Set 110 116', 'Jungen Shorts 122/128']) {
      expect(classifyFoodDecision(offer(name)), name).toBe('confirmed_non_food');
    }
  });

  it('Regression: Kinderlebensmittel bleibt Food (nicht wegen „Kinder" geblockt)', () => {
    expect(classifyFoodDecision(offer('Kinder Schokolade', { category: 'Snacks/Süßes' }))).toBe(
      'confirmed_food',
    );
    expect(classifyFoodDecision(offer('Kinder Pingui', { category: 'Snacks/Süßes' }))).not.toBe(
      'confirmed_non_food',
    );
  });
});

describe('False-Live Non-Food — Garten-/Zierpflanze (Gardenline) vs. Gewürz', () => {
  for (const name of ['Curcuma Siam Salsa', 'Curcuma Siam Sisto', 'Curcuma Siam Splash']) {
    it(`„${name}" (Gardenline) ⇒ confirmed_non_food`, () => {
      const o = offer(name, { brand: 'Gardenline', category: 'Obst/Gemüse' });
      expect(classifyFoodDecision(o)).toBe('confirmed_non_food');
    });
  }

  it('Regression: Kurkuma/Curcuma als Gewürz bleibt Food', () => {
    expect(
      classifyFoodDecision(offer('Kurkuma gemahlen', { brand: 'Ja!', category: 'Gewürze', unit: '50g' })),
    ).toBe('confirmed_food');
  });

  it('Regression: essbarer Kräutertopf/Topfkräuter bleibt Food', () => {
    expect(classifyFoodDecision(offer('Bioland Kräutertopf', { category: 'Obst/Gemüse' }))).toBe(
      'confirmed_food',
    );
    expect(classifyFoodDecision(offer('Topfkräuter Basilikum', { category: 'Obst/Gemüse' }))).toBe(
      'confirmed_food',
    );
  });
});

describe('False-Live Non-Food — Zierpflanzen-Arten mit Getränke-/Alkohol-Veto', () => {
  for (const name of ['Edelweiss', 'Enzian', 'Kalanchoe']) {
    it(`Kaufland Zierpflanze „${name}" ⇒ confirmed_non_food`, () => {
      const o = offer(name, { storeChain: 'Kaufland', category: 'Pflanzen', unit: 'Topf' });
      expect(classifyFoodDecision(o)).toBe('confirmed_non_food');
    });
  }

  it('Regression: „Edelweiss" Weißbier / „Enzian" Schnaps mit Getränke-Kontext bleiben NICHT Non-Food', () => {
    const beer = offer('Edelweiss Weissbier', {
      storeChain: 'Kaufland',
      category: 'Getränke Alkohol',
      unit: '0,5 l',
    });
    expect(hasRuleConfirmedNonFoodSignal(beer)).toBe(false);
    expect(classifyFoodDecision(beer)).toBe('confirmed_food');

    const schnaps = offer('Enzian', {
      storeChain: 'Kaufland',
      category: 'Spirituosen',
      unit: '0,7 l',
    });
    expect(hasRuleConfirmedNonFoodSignal(schnaps)).toBe(false);
    expect(classifyFoodDecision(schnaps)).not.toBe('confirmed_non_food');
  });

  it('Regression: Sonnenblumenkerne/Rosenkohl/Blumenkohl/Rosmarin werden nie Non-Food', () => {
    for (const name of ['Sonnenblumenkerne', 'Rosenkohl', 'Blumenkohl', 'Rosmarin geschnitten']) {
      expect(classifyFoodDecision(offer(name, { category: 'Obst/Gemüse' })), name).not.toBe(
        'confirmed_non_food',
      );
    }
  });
});

describe('Report zählt die False-Live-Fälle (nonFoodLeakCount)', () => {
  it('die Repro-Fälle erhöhen nonFoodLeakCount, echte Food-Fälle nicht', () => {
    const live = [
      kinderSommerSet('Kinder Sommer-Set Paw Patrol Türkis/Floral 98/104'),
      offer('Curcuma Siam Salsa', { brand: 'Gardenline', category: 'Obst/Gemüse' }),
      offer('Kalanchoe', { storeChain: 'Kaufland', category: 'Pflanzen', unit: 'Topf' }),
      offer('Frische Vollmilch 3,8 %', { category: 'Milchprodukte', unit: '1l' }),
    ];
    const summary = summarizeFoodDecisions({ offers: live, nextWeekOffers: [], filteredOffers: [] });
    expect(summary.nonFoodLeakCount).toBe(3);
    expect(summary.confirmedFoodVisibleCount).toBe(1);
    expect(summary.wrongFoodFilteredCount).toBe(0);
  });
});
