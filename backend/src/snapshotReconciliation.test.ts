import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { applyFragmentQuarantineGate } from './offersScanV2';
import { applyFinalNonFoodGate } from './snapshotNonFoodGate';
import { applyFoodRescuePass } from './snapshotFoodRescue';

// Reconciliation = die feste, nachweislich stabile Reihenfolge, die saveSnapshot
// vor jedem Persistieren fährt: Fragment-Gate → Non-Food-Gate → Food-Rescue.
// Seit Gate und Rescue dieselbe zentrale classifyFoodDecision nutzen, arbeiten
// sie nicht mehr gegeneinander (kein Pingpong): ein Angebot ist genau EINES von
// confirmed_food / confirmed_non_food / uncertain, und die Bewegungen sind
// gerichtet (non_food → filtered, food → live). Produktnamen sind Fixtures.

interface Buckets {
  offers: Offer[];
  nextWeekOffers: Offer[];
  filteredOffers: Offer[];
}

function offer(overrides: Partial<Offer> & { id: string; name: string }): Offer {
  return {
    normalizedName: overrides.name.toLowerCase(),
    storeChain: 'Kaufland',
    category: 'Sonstiges',
    price: 1.99,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: '2026-06-08T00:00:00.000Z',
    validityEnd: '2026-06-30T23:59:59.000Z',
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-06-08T00:00:00.000Z',
    ...overrides,
  } as Offer;
}

/** Ein Reconciliation-Durchlauf in der saveSnapshot-Reihenfolge. */
function reconcile(buckets: Buckets): Buckets & { movedNonFood: number; rescued: number; fragments: number } {
  const frag = applyFragmentQuarantineGate(buckets);
  const gate = applyFinalNonFoodGate({
    offers: frag.offers,
    nextWeekOffers: frag.nextWeekOffers,
    filteredOffers: frag.filteredOffers,
  });
  const rescue = applyFoodRescuePass(
    {
      offers: gate.offers,
      nextWeekOffers: gate.nextWeekOffers,
      filteredOffers: gate.filteredOffers,
    },
    { now: new Date('2026-06-10T12:00:00.000Z'), maxValidityDays: 60 },
  );
  return {
    offers: rescue.offers,
    nextWeekOffers: rescue.nextWeekOffers,
    filteredOffers: rescue.filteredOffers,
    movedNonFood: gate.movedCount,
    rescued: rescue.rescuedCount,
    fragments: frag.movedCount,
  };
}

describe('Reconciliation (Fragment-Gate → Non-Food-Gate → Food-Rescue)', () => {
  const start: Buckets = {
    offers: [
      offer({ id: 'live_food', name: 'Grillkäse Natur' }),
      offer({ id: 'live_nonfood', name: 'Damen BH-Top' }), // confirmed_non_food → filtered
      offer({ id: 'live_frag', name: 'Tiefpreis' }), // Fragment → Quarantäne
    ],
    nextWeekOffers: [offer({ id: 'next_food', name: 'Bratwurst grob' })],
    filteredOffers: [
      offer({ id: 'filt_food', name: 'Steinofen-Pizza Salami' }), // confirmed_food → live
      offer({ id: 'filt_nonfood', name: 'Pizzamaker' }), // Gerät → bleibt gefiltert
      offer({ id: 'filt_uncertain', name: 'Celebrations' }), // uncertain → bleibt Review
    ],
  };

  it('sortiert jedes Angebot in genau einen Bucket (gerichtet, kein Konflikt)', () => {
    const r = reconcile(start);
    const ids = (list: Offer[]): string[] => list.map((o) => o.id).sort();
    // confirmed_food (live + gerettet) sichtbar:
    expect(ids([...r.offers, ...r.nextWeekOffers])).toContain('filt_food');
    expect(ids([...r.offers, ...r.nextWeekOffers])).toContain('live_food');
    // confirmed_non_food + Fragment + uncertain gefiltert:
    expect(ids(r.filteredOffers)).toEqual(
      ['filt_nonfood', 'filt_uncertain', 'live_frag', 'live_nonfood'].sort(),
    );
  });

  it('Test 10: Reconciliation ist idempotent (zweiter Lauf bewegt nichts)', () => {
    const first = reconcile(start);
    const second = reconcile(first);
    expect(second.movedNonFood).toBe(0);
    expect(second.rescued).toBe(0);
    expect(second.fragments).toBe(0);
    // Bucket-Mitgliedschaft bleibt stabil.
    expect(second.offers.map((o) => o.id).sort()).toEqual(first.offers.map((o) => o.id).sort());
    expect(second.nextWeekOffers.map((o) => o.id).sort()).toEqual(
      first.nextWeekOffers.map((o) => o.id).sort(),
    );
    expect(second.filteredOffers.map((o) => o.id).sort()).toEqual(
      first.filteredOffers.map((o) => o.id).sort(),
    );
  });

  it('ein harter Non-Food-Beleg wird nicht durch ein schwaches Food-Signal zurückgeholt', () => {
    // Ziersalbei trägt das Food-Wort „salbei", bleibt aber Non-Food (Ordnung).
    const r = reconcile({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [offer({ id: 'zier', name: 'Ziersalbei' })],
    });
    expect(r.rescued).toBe(0);
    expect(r.filteredOffers.map((o) => o.id)).toContain('zier');
  });
});
