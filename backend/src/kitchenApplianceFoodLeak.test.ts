import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { classifyFoodDecision } from './foodDecision';
import { applyFoodRescuePass } from './snapshotFoodRescue';

// Küchengeräte im Live-Feed (Lauf 2026-08-17). Der Scan lieferte SECHS sichtbare
// Angebote ohne `canonicalCategory.main`, alle mit `food_rescue`-Tag — darunter
// ein Entsafter, zwei Kaffeekapselmaschinen, ein Pizzablech und ein
// Wasserenthärter. Sie gingen mit `is_food=true` nach Supabase und in den
// Rezept-Matcher.
//
// ROOT CAUSE (zwei unabhängige Lücken, beide im Filter):
//   1. `keywordMatches` matcht Keywords > 3 Zeichen als nackten SUBSTRING. Das
//      Food-Keyword 'saft' traf damit in "Ent-saft-er"; dieselbe Falle bei
//      'back'/'pizza' → Pizzablech und 'wasser' → Wasserenthärter.
//   2. Die Non-Food-Blockliste kannte 'kaffeemaschine' und 'kaffeepadmaschine',
//      aber NICHT 'kaffeekapselmaschine' — das Food-Keyword 'kaffee' gewann.
//
// Weil daraus `confirmed_food` wurde (das STÄRKSTE Verdikt), griff danach nichts
// mehr: Der Non-Food-Gate vertraut ihm, und der Food-Rescue holte die Geräte
// aktiv aus dem Filtered-Bucket zurück — er überschrieb damit ein KORREKTES
// Modell-Urteil ("classified under Non-Food as it is a household device").
//
// Produktnamen sind reine Reproduktions-Fixtures aus dem echten Lauf — der
// Produktivcode kennt keine Produkt-/Marken-Allowlist.

const CURRENT = {
  validityStart: '2026-08-16T00:00:00.000Z',
  validityEnd: '2026-08-23T23:59:59.999Z',
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
    price: 39.99,
    currency: 'EUR',
    unit: 'stk',
    validityStart: CURRENT.validityStart,
    validityEnd: CURRENT.validityEnd,
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-08-17T01:01:05.610Z',
    ...extra,
  } as Offer;
}

/** Die exakten Namen, die im Lauf 2026-08-17 sichtbar wurden. */
const LEAKED_APPLIANCES: ReadonlyArray<[string, Partial<Offer>]> = [
  ['AMBIANO Elektrischer Entsafter / Standmixer', { storeChain: 'ALDI NORD', sourceCategoryRaw: 'Küche' }],
  ['KRUPS Kaffeekapselmaschine Nescafé Dolce Gusto Piccolo XS', { sourceCategoryRaw: 'Deine Küchenhelfer' }],
  ['Back- und Pizzablech', {}],
  ['Wasserenthärter 4 in 1', {}],
];

describe('Küchengeräte dürfen nie als Lebensmittel gelten', () => {
  it.each(LEAKED_APPLIANCES)('%s ist confirmed_non_food', (name, extra) => {
    expect(classifyFoodDecision(offer('leak', name, extra))).toBe('confirmed_non_food');
  });

  it.each([
    'Entsafter',
    'Saftpresse',
    'Standmixer',
    'Kaffeekapselmaschine',
    'Kapselmaschine',
    'Backblech',
    'Pizzablech',
  ])('Gerätename "%s" allein ist confirmed_non_food', (name) => {
    expect(classifyFoodDecision(offer('bare', name))).toBe('confirmed_non_food');
  });

  // Der strukturelle Teil: 'saft' darf als Kompositum-Kopf weiter greifen — der
  // Fix ist Präzision, keine Abschaltung des Getränke-Vokabulars.
  it.each([
    'Orangensaft 1l',
    'Fruchtsaft Multivitamin',
    'Apfelsaft naturtrüb',
    'Saft des Monats',
  ])('Getränk "%s" bleibt confirmed_food', (name) => {
    expect(classifyFoodDecision(offer('drink', name, { unit: '1 l' }))).toBe('confirmed_food');
  });

  // Regression gegen die bereits abgesicherten Nachbarfälle — die neue
  // 'saft'-Präzision darf 'reis'/'sekt' nicht beschädigen.
  it('bestehende Kompositum-Präzision bleibt intakt', () => {
    expect(classifyFoodDecision(offer('r', 'Basmatireis 1kg'))).toBe('confirmed_food');
    expect(classifyFoodDecision(offer('s', 'Winzersekt trocken'))).toBe('confirmed_food');
  });
});

describe('Food-Rescue holt keine Küchengeräte zurück', () => {
  it('lässt die Geräte des 2026-08-17-Laufs im Filtered-Bucket', () => {
    const filteredOffers = LEAKED_APPLIANCES.map(([name, extra], index) =>
      offer(`appliance-${index}`, name, extra),
    );

    const result = applyFoodRescuePass({
      offers: [],
      nextWeekOffers: [],
      filteredOffers,
    });

    expect(result.rescuedCount).toBe(0);
    expect(result.offers).toHaveLength(0);
    expect(result.nextWeekOffers).toHaveLength(0);
    expect(result.filteredOffers).toHaveLength(filteredOffers.length);
  });
});
