import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { applyFinalNonFoodGate, findNonFoodLeaks } from './snapshotNonFoodGate';
import { applyFoodRescuePass } from './snapshotFoodRescue';
import { evaluateFoodReconciliation } from './foodDecision';
import { evaluateSnapshotSafety } from './snapshotSafetyGate';

// Integration der neuen generischen Non-Food-Produktklassen (Task A) mit dem
// Final-Gate, Food-Rescue, Reconciliation, Report-Leak-Zähler und Safety-Gate
// (Tasks G + #11–#15). Produktnamen sind ausschließlich Reproduktions-Fixtures.

function offer(name: string, extra: Partial<Offer> = {}): Offer {
  return {
    id: `id_${name}`,
    name,
    normalizedName: name.toLowerCase(),
    storeChain: 'Lidl',
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

const NOW = new Date('2026-06-10T08:00:00.000Z');

describe('Task #11 — Final-Gate verschiebt sichtbares confirmed_non_food nach filtered', () => {
  it('Eisschale/Kopfhörer im sichtbaren Feed wandern in den Filter', () => {
    const result = applyFinalNonFoodGate({
      offers: [offer('Eisschale'), offer('Bratwurst grob')],
      nextWeekOffers: [offer('In-Ear-Kopfhörer')],
      filteredOffers: [],
    });
    expect(result.offers.map((o) => o.name)).toEqual(['Bratwurst grob']);
    expect(result.nextWeekOffers).toHaveLength(0);
    expect(result.movedCount).toBe(2);
    expect(result.filteredOffers.map((o) => o.name).sort()).toEqual(
      ['Eisschale', 'In-Ear-Kopfhörer'].sort(),
    );
  });
});

describe('Task #12/#13 — Food-Rescue holt confirmed_non_food nicht zurück; idempotent', () => {
  it('eine Produktklasse mit schwachem Food-Wort bleibt gefiltert', () => {
    const buckets = {
      offers: [] as Offer[],
      nextWeekOffers: [] as Offer[],
      filteredOffers: [
        offer('Flexibler Wasserhahnanschluss'), // „Wasser", aber Armatur
        offer('WEINBERGER Schrank-Schiebekorb'), // „Wein", aber Korb
        offer('Papier-Trinkhalme'), // plain Halme ohne Food-Kontext bleiben Non-Food
      ],
    };
    const first = applyFoodRescuePass(buckets, { now: NOW });
    expect(first.rescuedCount).toBe(0);
    expect(first.filteredOffers).toHaveLength(3);
    // Idempotenz: ein zweiter Lauf verschiebt nichts mehr.
    const second = applyFoodRescuePass(
      { offers: first.offers, nextWeekOffers: first.nextWeekOffers, filteredOffers: first.filteredOffers },
      { now: NOW },
    );
    expect(second.rescuedCount).toBe(0);
    expect(second.offers).toHaveLength(0);
    expect(second.filteredOffers).toHaveLength(3);
  });

  it('Final-Gate + Food-Rescue zusammen sind stabil (kein Ping-Pong)', () => {
    const start = {
      offers: [offer('Eiswürfelform'), offer('Joghurt natur')],
      nextWeekOffers: [] as Offer[],
      filteredOffers: [] as Offer[],
    };
    const gated = applyFinalNonFoodGate(start);
    const rescued = applyFoodRescuePass(gated, { now: NOW });
    const reGated = applyFinalNonFoodGate(rescued);
    expect(reGated.movedCount).toBe(0); // nichts mehr zu verschieben
    expect(reGated.offers.map((o) => o.name)).toEqual(['Joghurt natur']);
    expect(reGated.filteredOffers.map((o) => o.name)).toEqual(['Eiswürfelform']);
  });
});

describe('Task #14/#15/G — Report-Leak und Safety-Gate erkennen dieselben Fälle', () => {
  const visible = [offer('Eisschale'), offer('Kinder-Cap'), offer('Bratwurst grob')];

  it('findNonFoodLeaks zählt sichtbares confirmed_non_food', () => {
    const leaks = findNonFoodLeaks(visible);
    expect(leaks.count).toBe(2);
    expect(leaks.examples.sort()).toEqual(['Eisschale', 'Kinder-Cap'].sort());
  });

  it('Safety-Gate blockiert dieselben sichtbaren confirmed_non_food (echte Beispiele)', () => {
    const candidate = { offers: visible, nextWeekOffers: [], filteredOffers: [] };
    const previous = { offers: [offer('Vollmilch 3,5%')], nextWeekOffers: [], filteredOffers: [] };
    const result = evaluateSnapshotSafety({ previous, candidate, now: NOW });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('nonFoodLive');
    expect(result.examplesByCheck.nonFoodLive?.sort()).toEqual(['Eisschale', 'Kinder-Cap'].sort());
  });

  it('confirmed_food im Filter blockiert die Reconciliation (wrongFoodFiltered)', () => {
    const result = evaluateFoodReconciliation({ filteredOffers: [offer('Bratwurst grob')] });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('foodLeftInFilter');
    expect(result.wrongFoodFilteredExamples).toContain('Bratwurst grob');
  });

  it('uncertain blockiert NICHT (nur Warnung)', () => {
    const result = evaluateFoodReconciliation({ filteredOffers: [offer('Celebrations')] });
    expect(result.ok).toBe(true);
    expect(result.uncertainFilteredCount).toBe(1);
  });
});
