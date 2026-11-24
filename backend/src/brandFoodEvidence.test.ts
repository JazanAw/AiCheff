import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { classifyFoodDecision } from './foodDecision';
import { hasStrongFoodSignal } from './offersStrictFoodFilter';
import { applyFinalNonFoodGate } from './snapshotNonFoodGate';
import {
  FOOD_RESCUE_TAG,
  RESCUE_REVERTED_REVIEW_REASON,
  applyFoodRescuePass,
  revertStaleRescues,
} from './snapshotFoodRescue';

// Task P3 — eine MARKE allein (Kaffee-/Tee-Marke) darf einen mehrdeutigen
// Kurznamen ("Gold"/"Auslese") NICHT als confirmed_food retten. confirmed_food
// ist erst zulässig, wenn ZUSÄTZLICH ein unabhängiger struktureller Food-Beleg
// vorhanden ist (zuverlässige Kaffee-Abteilung, konkreter Kaffee-Deskriptor,
// belastbare Food-Einheit/Grundpreis). Konkrete Namen sind reine Reproduktions-
// Fixtures, KEINE Produktiv-Allowlist. Getestet wird auch der REALE
// Finalisierungspfad (revertStaleRescues → Non-Food-Gate → Food-Rescue), nicht
// nur classifyFoodDecision.

const NOW = new Date('2026-06-10T08:00:00.000Z');

function offer(name: string, extra: Partial<Offer> & Record<string, unknown> = {}): Offer {
  return {
    id: `id_${name}_${JSON.stringify(extra).length}`,
    name,
    normalizedName: name.toLowerCase(),
    storeChain: 'PENNY',
    category: 'Sonstiges',
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

describe('P3 — Marke allein rettet mehrdeutigen Kurznamen nicht', () => {
  it('brand=Jacobs, name=Gold, neutrale Quelle, keine Einheit/Grundpreis → uncertain', () => {
    const o = offer('Gold', { brand: 'Jacobs', unit: 'Stk' });
    expect(hasStrongFoodSignal(o)).toBe(false);
    expect(classifyFoodDecision(o)).toBe('uncertain');
  });

  it('brand=Melitta, name=Auslese, neutrale Quelle → uncertain', () => {
    const o = offer('Auslese', { brand: 'Melitta', unit: 'Stk' });
    expect(hasStrongFoodSignal(o)).toBe(false);
    expect(classifyFoodDecision(o)).toBe('uncertain');
  });

  it('Jacobs/Gold + zuverlässige Kaffee-Abteilung → confirmed_food', () => {
    const o = offer('Gold', { brand: 'Jacobs', sourceCategoryRaw: 'Kaffee' } as Partial<Offer>);
    expect(hasStrongFoodSignal(o)).toBe(true);
    expect(classifyFoodDecision(o)).toBe('confirmed_food');
  });

  it('Melitta/Auslese + zuverlässige Kaffee-Abteilung → confirmed_food', () => {
    const o = offer('Auslese', { brand: 'Melitta', sourceDepartmentRaw: 'Kaffee & Tee' } as Partial<Offer>);
    expect(hasStrongFoodSignal(o)).toBe(true);
    expect(classifyFoodDecision(o)).toBe('confirmed_food');
  });

  it('Jacobs/Gold + konkreter Kaffee-Deskriptor (gemahlen) → confirmed_food', () => {
    const o = offer('Gold gemahlen', { brand: 'Jacobs', unit: 'Stk' });
    expect(hasStrongFoodSignal(o)).toBe(true);
    expect(classifyFoodDecision(o)).toBe('confirmed_food');
  });

  it('Jacobs/Gold + belastbare Food-Einheit (g) → confirmed_food', () => {
    const o = offer('Gold', { brand: 'Jacobs', unit: '500 g' });
    expect(hasStrongFoodSignal(o)).toBe(true);
    expect(classifyFoodDecision(o)).toBe('confirmed_food');
  });

  it('eindeutige Food-Namen regressieren nicht', () => {
    for (const name of ['Frische Vollmilch 3,8 %', 'Bio Bananen', 'Gouda jung am Stück']) {
      expect(hasStrongFoodSignal(offer(name, { unit: 'Stk' })), name).toBe(true);
    }
  });
});

/** Repliziert die saveSnapshot-Pass-Reihenfolge (rein, ohne IO). */
function runFinalizationPasses(buckets: {
  offers: Offer[];
  nextWeekOffers: Offer[];
  filteredOffers: Offer[];
}): { offers: Offer[]; nextWeekOffers: Offer[]; filteredOffers: Offer[] } {
  const reverted = revertStaleRescues(buckets);
  const gate = applyFinalNonFoodGate(reverted);
  const rescue = applyFoodRescuePass(gate, { now: NOW, weekBucketOf: () => 'current' });
  return {
    offers: rescue.offers,
    nextWeekOffers: rescue.nextWeekOffers,
    filteredOffers: rescue.filteredOffers,
  };
}

describe('P3 — realer Finalisierungspfad behandelt Marken-only-Rescues korrekt', () => {
  it('food_rescue-Tag ohne neue Evidenz → zurück nach filtered/review', () => {
    const stale = offer('Gold', {
      brand: 'Jacobs',
      unit: 'Stk',
      tags: [FOOD_RESCUE_TAG],
    });
    const result = runFinalizationPasses({
      offers: [stale],
      nextWeekOffers: [],
      filteredOffers: [],
    });
    expect(result.offers.map((o) => o.id)).not.toContain(stale.id);
    const inFilter = result.filteredOffers.find((o) => o.id === stale.id) as
      | (Offer & { reviewNeeded?: boolean; reviewReason?: string })
      | undefined;
    expect(inFilter).toBeDefined();
    expect(inFilter?.reviewNeeded).toBe(true);
    expect(inFilter?.reviewReason).toBe(RESCUE_REVERTED_REVIEW_REASON);
    expect((inFilter?.tags ?? []).includes(FOOD_RESCUE_TAG)).toBe(false);
  });

  it('Marke + Kaffee-Abteilung im Filter wird über den Rescue sichtbar', () => {
    const filtered = offer('Gold', {
      brand: 'Jacobs',
      unit: 'Stk',
      sourceCategoryRaw: 'Kaffee',
      tags: [],
    });
    const result = runFinalizationPasses({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [filtered],
    });
    expect(result.offers.map((o) => o.id)).toContain(filtered.id);
    expect(result.filteredOffers.map((o) => o.id)).not.toContain(filtered.id);
  });

  it('mehrdeutiger Marken-Kurzname ohne Evidenz im Filter wird NICHT blind sichtbar', () => {
    const filtered = offer('Auslese', { brand: 'Melitta', unit: 'Stk', tags: [] });
    const result = runFinalizationPasses({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [filtered],
    });
    expect(result.offers.map((o) => o.id)).not.toContain(filtered.id);
    expect(result.filteredOffers.map((o) => o.id)).toContain(filtered.id);
  });
});
