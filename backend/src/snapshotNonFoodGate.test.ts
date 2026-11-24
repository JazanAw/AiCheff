import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  applyFinalNonFoodGate,
  findNonFoodLeaks,
  isStrongNonFoodLeak,
  NON_FOOD_GATE_REASON,
} from './snapshotNonFoodGate';

// Finaler Snapshot-Gate/Repair (globaler Datenqualitäts-Fix): Non-Food darf nie
// in `offers` oder `nextWeekOffers` live bleiben — auch nicht, wenn die KI
// fälschlich eine Food-Kategorie ("Grundnahrungsmittel") vergeben hat. Der Gate
// läuft über ALLE Buckets und verschiebt starke Non-Food-Signale nach
// `filteredOffers`. Produktnamen hier sind reine Reproduktions-Fixtures.

function offer(overrides: Partial<Offer> & { id: string; name: string }): Offer {
  return {
    normalizedName: overrides.name.toLowerCase(),
    storeChain: 'Kaufland',
    category: 'Grundnahrungsmittel',
    price: 9.99,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: '2026-06-08T00:00:00.000Z',
    validityEnd: '2026-06-13T23:59:59.000Z',
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-06-08T00:00:00.000Z',
    ...overrides,
  } as Offer;
}

/** Das reale Fehlerbild: klares Non-Food mit falschem KI-Food-Verdikt. */
const wrongFoodVerdict = {
  canonicalCategory: { main: 'Grundnahrungsmittel', isNonFood: false, confidence: 0.8 },
} as Partial<Offer>;

function leak(id: string, name: string, storeChain = 'Kaufland'): Offer {
  return offer({ id, name, storeChain, ...wrongFoodVerdict });
}

function food(id: string, name: string, storeChain = 'Kaufland'): Offer {
  return offer({ id, name, storeChain, category: 'Sonstiges' });
}

describe('isStrongNonFoodLeak', () => {
  it('erkennt klares Non-Food trotz falschem KI-Food-Verdikt', () => {
    for (const name of [
      'BABY BORN Puppe',
      'ADIDAS WM 2026 Match Ball',
      'Damen BH-Top',
      '7-Zonen-Komfortschaummatratze',
      'Auto-Organizer',
      'Nass-/Trockensauger',
    ]) {
      expect(isStrongNonFoodLeak(leak(`l_${name}`, name)), name).toBe(true);
    }
  });

  it('laesst Food in Ruhe (Grillkäse, Bratwurst, Pizza, Kaffee, Brotaufstrich)', () => {
    for (const name of [
      'Grillkäse Natur',
      'Bratwurst grob',
      'Steinofen-Pizza Salami',
      'Dallmayr Kaffeepads Classic',
      'Brotaufstrich Paprika',
    ]) {
      expect(isStrongNonFoodLeak(food(`f_${name}`, name)), name).toBe(false);
    }
  });

  it('respektiert editorial gesperrte/manuell geprüfte Angebote', () => {
    const locked = {
      ...leak('locked1', 'BABY BORN Puppe'),
      manualOverride: true,
    } as Offer;
    expect(isStrongNonFoodLeak(locked)).toBe(false);
  });
});

describe('applyFinalNonFoodGate', () => {
  it('verschiebt Non-Food aus offers UND nextWeekOffers nach filteredOffers', () => {
    const result = applyFinalNonFoodGate({
      offers: [leak('c1', 'Damen BH-Top', 'ALDI SUED'), food('c2', 'Grillkäse Natur')],
      nextWeekOffers: [leak('n1', 'BABY BORN Puppe'), food('n2', 'Bratwurst grob')],
      filteredOffers: [],
    });

    expect(result.offers.map((o) => o.id)).toEqual(['c2']);
    expect(result.nextWeekOffers.map((o) => o.id)).toEqual(['n2']);
    expect(result.filteredOffers.map((o) => o.id).sort()).toEqual(['c1', 'n1']);
    expect(result.movedCount).toBe(2);
    expect(result.movedExamples).toContain('Damen BH-Top');
    expect(result.movedExamples).toContain('BABY BORN Puppe');
  });

  it('markiert verschobene Angebote ehrlich (foodFlag, isNonFood, Grund, Tag, Review)', () => {
    const result = applyFinalNonFoodGate({
      offers: [leak('c1', 'ADIDAS WM 2026 Match Ball')],
      nextWeekOffers: [],
      filteredOffers: [],
    });
    const moved = result.filteredOffers[0] as Offer & {
      foodFlag?: string;
      reviewNeeded?: boolean;
      canonicalCategory?: { main?: string; isNonFood?: boolean; reasons?: string[] };
    };
    expect(moved.foodFlag).toBe('nonfood');
    expect(moved.canonicalCategory?.isNonFood).toBe(true);
    // Die falsche Food-Hauptkategorie darf nicht stehen bleiben.
    expect(moved.canonicalCategory?.main).not.toBe('Grundnahrungsmittel');
    expect(moved.canonicalCategory?.reasons).toContain(NON_FOOD_GATE_REASON);
    expect(moved.tags).toContain('nonfood');
    // Modell sagte Food, Regel sagt Non-Food → Konflikt ist reviewwürdig.
    expect(moved.reviewNeeded).toBe(true);
  });

  it('laesst editorial gesperrte Angebote unangetastet', () => {
    const locked = { ...leak('locked1', 'BABY BORN Puppe'), manualOverride: true } as Offer;
    const result = applyFinalNonFoodGate({
      offers: [locked],
      nextWeekOffers: [],
      filteredOffers: [],
    });
    expect(result.offers.map((o) => o.id)).toEqual(['locked1']);
    expect(result.movedCount).toBe(0);
  });

  it('dedupliziert nach id, wenn das Angebot bereits im Filtered-Bucket liegt', () => {
    const result = applyFinalNonFoodGate({
      offers: [leak('dup1', 'Damen Capri-Jeans')],
      nextWeekOffers: [],
      filteredOffers: [leak('dup1', 'Damen Capri-Jeans')],
    });
    expect(result.filteredOffers.filter((o) => o.id === 'dup1')).toHaveLength(1);
    expect(result.movedCount).toBe(1);
  });

  it('ist idempotent (zweiter Lauf verschiebt nichts mehr)', () => {
    const first = applyFinalNonFoodGate({
      offers: [leak('c1', 'Beistelltisch in Steinoptik'), food('c2', 'Grillkäse Natur')],
      nextWeekOffers: [leak('n1', 'LUPILU Kinder-Planschbecken')],
      filteredOffers: [],
    });
    const second = applyFinalNonFoodGate({
      offers: first.offers,
      nextWeekOffers: first.nextWeekOffers,
      filteredOffers: first.filteredOffers,
    });
    expect(second.movedCount).toBe(0);
    expect(second.offers.map((o) => o.id)).toEqual(['c2']);
    expect(second.filteredOffers).toHaveLength(2);
  });
});

describe('findNonFoodLeaks', () => {
  it('zaehlt Leaks und begrenzt die Beispiele', () => {
    const leaks = Array.from({ length: 12 }, (_, i) => leak(`x${i}`, `Damen Kleid ${i}`));
    const result = findNonFoodLeaks(leaks);
    expect(result.count).toBe(12);
    expect(result.examples.length).toBeLessThanOrEqual(8);
  });

  it('liefert 0 für einen sauberen Food-Feed', () => {
    const result = findNonFoodLeaks([
      food('f1', 'Grillkäse Natur'),
      food('f2', 'Steinofen-Pizza Salami'),
    ]);
    expect(result.count).toBe(0);
    expect(result.examples).toHaveLength(0);
  });
});

describe('Sichtbare Blumen-/Pflanzen-Leaks (Problem A) — Gate und Report nutzen dieselbe Wahrheit', () => {
  // Realer Snapshot: Blumen aus der gemischten Abteilung "Obst, Gemüse,
  // Pflanzen" lagen mit Food-Kategorie live. Reproduktions-Fixtures, keine Liste.
  const flower = (id: string, name: string, storeChain = 'Kaufland'): Offer =>
    offer({
      id,
      name,
      storeChain,
      category: 'Obst/Gemuese',
      ...({
        sourceCategoryRaw: 'Obst, Gemüse, Pflanzen',
        canonicalCategory: { main: 'Obst/Gemüse', isNonFood: false, confidence: 0.8 },
      } as Partial<Offer>),
    });

  it('verschiebt sichtbare Blumen aus current/next nach filtered', () => {
    const result = applyFinalNonFoodGate({
      offers: [flower('c1', 'Chrysantheme'), food('c2', 'Dtsch. Erdbeeren')],
      nextWeekOffers: [flower('n1', 'Großköpfige Hochland Rosen', 'Netto'), flower('n2', 'Hortensie')],
      filteredOffers: [],
    });
    expect(result.offers.map((o) => o.id)).toEqual(['c2']);
    expect(result.nextWeekOffers).toHaveLength(0);
    expect(result.filteredOffers.map((o) => o.id).sort()).toEqual(['c1', 'n1', 'n2']);
    expect(result.movedCount).toBe(3);
  });

  it('nonFoodLeakCount erkennt die Blumen, BEVOR der Gate sie entfernt (gleiche Wahrheit)', () => {
    const visible = [
      flower('c1', 'Chrysantheme'),
      flower('c2', 'Rosen'),
      flower('n1', 'Großköpfige Hochland Rosen', 'Netto'),
      food('c3', 'Dtsch. Erdbeeren'),
    ];
    const leaks = findNonFoodLeaks(visible);
    expect(leaks.count).toBe(3);

    // Der Gate verschiebt exakt so viele, wie der Report als Leak meldet.
    const gate = applyFinalNonFoodGate({
      offers: visible,
      nextWeekOffers: [],
      filteredOffers: [],
    });
    expect(gate.movedCount).toBe(leaks.count);
  });

  it('echtes Obst/Gemüse derselben Abteilung bleibt live (kein Overkill)', () => {
    for (const name of ['Sonnenblumenkerne 500 g', 'Rosenkohl', 'Blumenkohl', 'Pflücksalat']) {
      expect(isStrongNonFoodLeak(flower('x', name)), name).toBe(false);
    }
  });

  it('ist idempotent für Blumen-Leaks', () => {
    const first = applyFinalNonFoodGate({
      offers: [flower('c1', 'Chrysantheme'), food('c2', 'Dtsch. Erdbeeren')],
      nextWeekOffers: [flower('n1', 'Rosen')],
      filteredOffers: [],
    });
    const second = applyFinalNonFoodGate({
      offers: first.offers,
      nextWeekOffers: first.nextWeekOffers,
      filteredOffers: first.filteredOffers,
    });
    expect(second.movedCount).toBe(0);
  });
});
