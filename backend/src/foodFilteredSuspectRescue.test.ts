import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { classifyFoodDecision } from './foodDecision';
import { classifyFilteredOfferForRescue } from './snapshotFoodRescue';
import { classifyReviewQueueClass, summarizeReviewQueue } from './reviewReductionClasses';
import { hasSuspectFoodEvidence } from './offersStrictFoodFilter';

// Strukturelle Food-Rescue-/Food-Verdachts-Wahrheit im gefilterten Bucket.
// Produktnamen sind AUSSCHLIESSLICH Reproduktions-Fixtures aus dem Live-Snapshot —
// der Produktivcode kennt KEINE Produkt-/Marken-Allowlist und KEINE KW-/Shop-
// Sonderregel. Geprüft wird die ZENTRALE classifyFoodDecision (Single Source of
// Truth) plus die abgeleiteten Rescue-/Review-Klassen.

function offer(name: string, extra: Partial<Offer> & Record<string, unknown> = {}): Offer {
  return {
    id: `id_${name}`,
    name,
    normalizedName: name.toLowerCase(),
    storeChain: 'REWE',
    category: '',
    price: 1.99,
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

describe('Repro — offensichtliche Lebensmittel im Filter werden gerettet (confirmed_food)', () => {
  const rescuable: Array<[string, Partial<Offer> & Record<string, unknown>]> = [
    ['Cerealien Pokémon', {}], // Frühstückscerealien
    ['BEBIVITA Glaskost, Quetschen und Maissnacks', {}], // Babykost-Vokabular
    ['Magic Milk Mix Milchtrink-Halme', {}], // aromatisierende Milch-Halme
    ['Bioland dtsch. Kräutertopf', {}], // essbare Küchenkräuter im Topf
    ['Topfkräuter Schnittlauch', {}], // essbare Topfkräuter
    ['CLUSS Export', { unit: '0,5 l', category: 'Getränke' }], // Bierstil + Getränke-Kontext
  ];
  for (const [name, extra] of rescuable) {
    it(`„${name}" → confirmed_food und Rescue-Verdikt`, () => {
      const o = offer(name, extra);
      expect(classifyFoodDecision(o), name).toBe('confirmed_food');
      expect(classifyFilteredOfferForRescue(o), name).toBe('rescue');
    });
  }
});

describe('Repro — schwache Food-Verdachtsfälle bleiben sichtbar als food_like (kein Blind-Rescue)', () => {
  const suspects: Array<[string, Partial<Offer> & Record<string, unknown>]> = [
    // Dessert/Milchprodukt mit eigenem Food-Votum, aber zu schwachem Namen.
    ['Top Cup', { foodFlag: 'food' }],
    // Bierstil OHNE Getränke-Kontext: Verdacht, nie blind gerettet.
    ['CLUSS Export', {}],
    // Spritzring im Gebäck-/Backwaren-Kontext (foodFlag=food), aber zu wenig für Rescue.
    ['Spritzring', { foodFlag: 'food', category: 'Backwaren' }],
  ];
  for (const [name, extra] of suspects) {
    it(`„${name}" → uncertain, Verdacht sichtbar (food_like, kein Rescue)`, () => {
      const o = offer(name, extra);
      expect(classifyFoodDecision(o), name).toBe('uncertain');
      expect(hasSuspectFoodEvidence(o), name).toBe(true);
      expect(classifyReviewQueueClass(o), name).toBe('food_like');
      expect(classifyFilteredOfferForRescue(o), name).toBe('review');
    });
  }
});

describe('Gegentests — generische Klassen treffen kein echtes Food / retten kein echtes Non-Food', () => {
  it('PLAINE Trinkhalme/Strohhalme ohne Food-Kontext bleiben Non-Food', () => {
    for (const name of ['Trinkhalme 100 Stück', 'Papier-Strohhalme', 'Strohhalm Edelstahl']) {
      expect(classifyFoodDecision(offer(name)), name).toBe('confirmed_non_food');
    }
  });

  it('Zierpflanzen/Blumen bleiben Non-Food — auch mit (falschem) foodFlag=food / Obst-Kategorie', () => {
    for (const name of [
      'Rosen',
      'Hortensie',
      'Glockenblume',
      'Premium Rosenstrauß',
      'Sprayrosen Mixstrauß',
    ]) {
      const o = offer(name, { foodFlag: 'food', category: 'Obst/Gemüse' });
      expect(classifyFoodDecision(o), name).toBe('confirmed_non_food');
      expect(classifyReviewQueueClass(o), name).toBeNull();
    }
  });

  it('lebende Kräuterpflanze im Topf / Zierkräuter bleiben Non-Food (nur essbare Topfkräuter sind Food)', () => {
    for (const name of ['Kräuterpflanze im Topf', 'Ziersalbei', 'Zierkürbis']) {
      expect(classifyFoodDecision(offer(name)), name).toBe('confirmed_non_food');
    }
  });

  it('Rosenkohl/Rosmarin/Sonnenblumenkerne bleiben Food (nie Blumen-Non-Food)', () => {
    for (const name of ['Rosenkohl', 'Rosmarin geschnitten', 'Sonnenblumenkerne 500 g']) {
      expect(classifyFoodDecision(offer(name)), name).not.toBe('confirmed_non_food');
    }
  });

  it('„Export" ohne Alkohol-/Getränke-Kontext wird NICHT blind Food (uncertain, nur Verdacht)', () => {
    const o = offer('Export Sonderposten');
    expect(classifyFoodDecision(o)).toBe('uncertain');
    expect(classifyFilteredOfferForRescue(o)).toBe('review');
  });

  it('Cerealien-/Müsli-DOSE (Behälter) bleibt Non-Food trotz Cerealien-Stamm', () => {
    for (const name of ['Cerealiendose', 'Müsli-Dose 2er']) {
      expect(classifyFoodDecision(offer(name)), name).toBe('confirmed_non_food');
    }
  });
});

describe('Report-Effekt — Food-Verdacht ist nicht mehr fälschlich „alles ok"', () => {
  it('foodLikeReview zählt die Verdachtsfälle, confirmed_food sind Rescue-Verdikte', () => {
    const filtered = [
      offer('Cerealien Pokémon'), // confirmed_food → rescue
      offer('Top Cup', { foodFlag: 'food' }), // uncertain → food_like
      offer('CLUSS Export'), // uncertain → food_like
      offer('Papier-Trinkhalme'), // confirmed_non_food
      offer('Rosen', { foodFlag: 'food' }), // confirmed_non_food (Blume)
    ];
    const queue = summarizeReviewQueue(filtered);
    expect(queue.foodLikeReview.count).toBe(2);
    expect(queue.foodLikeReview.examples).toEqual(expect.arrayContaining(['Top Cup', 'CLUSS Export']));
    const rescues = filtered.filter((o) => classifyFilteredOfferForRescue(o) === 'rescue');
    expect(rescues.map((o) => o.name)).toEqual(['Cerealien Pokémon']);
  });
});
