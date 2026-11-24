import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  PHASE2_RECHECK_TAG,
  selectUncertainFilteredForPhase2,
  stripPhase2RecheckTag,
} from './offersScanV2';
import { reassemblePhase2Buckets } from './phase2Reassembly';
import { applyFinalNonFoodGate } from './snapshotNonFoodGate';
import { applyFoodRescuePass, revertStaleRescues } from './snapshotFoodRescue';
import { classifyFoodDecision } from './foodDecision';
import {
  hasHardNonFoodSignal,
  hasUntrustworthyCacheNonFood,
} from './offersStrictFoodFilter';

// Task P1 — „Spritzring bleibt falsch im Filter". Ein veralteter/schwacher
// Cache-Hit (cache:hit) markiert „Spritzring" als Küchenutensil (Non-Food),
// während der Feed Food-nahe Signale liefert (category Getränke Alkoholfrei,
// foodFlag=food, Filialangebote). Der Cache-Hit darf eine plausiblere neue
// Food-Entscheidung NICHT hart überschreiben: er blockt weder die Phase-2-
// Reanalyse (hasHardNonFoodSignal) noch wird er als confirmed Non-Food
// persistiert. Ohne Food-Evidenz bleibt das Item ehrlich „uncertain review",
// NIE confirmed Non-Food aus Cache.
//
// Produktnamen sind reine Reproduktions-Fixtures — KEIN Produktivcode kennt eine
// Produkt-/Marken-Allowlist und keine shop-/kalenderwochenabhängige Sonderregel.

const NOW = new Date('2026-06-16T12:00:00.000Z');
const CURRENT = { validityStart: '2026-06-14T00:00:00.000Z', validityEnd: '2026-06-21T23:59:59.000Z' };

function offer(id: string, name: string, extra: Partial<Offer> & Record<string, unknown> = {}): Offer {
  return {
    id,
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

/** The exact live Netto shape from the 2026-06-16 scan: foodFlag=food while a
 *  cache:hit canonical (confidence 0.8) claims Non-Food/Küche & Geräte. */
function spritzringConflict(id = 'spritzring'): Offer {
  return offer(id, 'Spritzring', {
    category: 'Getränke Alkoholfrei',
    price: 0.49,
    unit: 'stück',
    sourceCategoryRaw: 'Filialangebote',
    foodFlag: 'food',
    canonicalCategory: {
      main: 'Non-Food',
      sub: 'Küche & Geräte',
      isNonFood: true,
      confidence: 0.8,
      reasons: [
        'Spritzring ist ein Küchenutensil',
        'Produkttyp entspricht nicht einer Nahrungsmittelkategorie',
        'cache:hit',
      ],
    },
  } as Partial<Offer>);
}

/** Replicates the server.ts saveSnapshot finalize order over the Phase-2
 *  reassembly: reassembly → (strip recheck tag) → revert stale rescues →
 *  final non-food gate → food rescue. Pure, no IO. */
function runRealPhase2Path(input: {
  previousFiltered: Offer[];
  restored: Offer[];
  skippedNonFood: Offer[];
}): { offers: Offer[]; nextWeekOffers: Offer[]; filteredOffers: Offer[] } {
  const reassembly = reassemblePhase2Buckets({
    restored: input.restored,
    previousFiltered: input.previousFiltered,
    skippedNonFood: input.skippedNonFood,
    now: NOW,
    weekBucketOf: () => 'current',
    isPreserved: () => false,
    maxValidityDays: 21,
  });
  const stripped = {
    offers: reassembly.offers.map(stripPhase2RecheckTag),
    nextWeekOffers: reassembly.nextWeekOffers.map(stripPhase2RecheckTag),
    filteredOffers: reassembly.filteredOffers.map(stripPhase2RecheckTag),
  };
  const reverted = revertStaleRescues(stripped);
  const gate = applyFinalNonFoodGate(reverted);
  const rescue = applyFoodRescuePass(gate, { now: NOW, weekBucketOf: () => 'current' });
  return {
    offers: rescue.offers,
    nextWeekOffers: rescue.nextWeekOffers,
    filteredOffers: rescue.filteredOffers,
  };
}

describe('P1 — Spritzring-Food-Konflikt (Netto-Shape)', () => {
  it('die zentrale Entscheidung ist uncertain, NICHT confirmed_non_food', () => {
    // Getränke Alkoholfrei + foodFlag=food + kein hartes Non-Food-Quellsignal:
    // mindestens uncertain, nie aus dem Cache confirmed_non_food.
    expect(classifyFoodDecision(spritzringConflict())).toBe('uncertain');
  });

  it('der widersprüchliche cache:hit-Non-Food-Hit ist NICHT hart (blockt Phase 2 nicht)', () => {
    const sr = spritzringConflict();
    expect(hasUntrustworthyCacheNonFood(sr)).toBe(true);
    expect(hasHardNonFoodSignal(sr)).toBe(false);
  });

  it('die Kandidatenauswahl zieht den Konfliktfall in die Phase-2-Reanalyse', () => {
    const selection = selectUncertainFilteredForPhase2([spritzringConflict()]);
    expect(selection.candidates.map((o) => o.id)).toEqual(['spritzring']);
    expect(selection.candidates[0].tags).toContain(PHASE2_RECHECK_TAG);
  });

  it('über den echten Pfad bleibt er ehrlich review/filtered — NIE confirmed Non-Food aus Cache', () => {
    const original = spritzringConflict();
    const [picked] = selectUncertainFilteredForPhase2([original]).candidates;
    // Phase 2 schickt ihn ans Modell — der Cache liefert exakt dieselbe Non-Food-
    // Antwort zurück (cache:hit), der phase2_recheck-Tag bleibt erhalten.
    const reanalyzed = {
      ...spritzringConflict(),
      tags: [...new Set([...(picked.tags ?? []), PHASE2_RECHECK_TAG])],
    } as Offer;

    const result = runRealPhase2Path({
      previousFiltered: [original],
      restored: [reanalyzed],
      skippedNonFood: [],
    });

    // Nicht blind sichtbar.
    expect([...result.offers, ...result.nextWeekOffers].map((o) => o.id)).not.toContain('spritzring');
    const inFilter = result.filteredOffers.find((o) => o.id === 'spritzring') as
      | (Offer & {
          reviewNeeded?: boolean;
          foodFlag?: string;
          canonicalCategory?: { isNonFood?: boolean };
        })
      | undefined;
    expect(inFilter).toBeDefined();
    // Ehrlich als Review markiert.
    expect(inFilter?.reviewNeeded).toBe(true);
    // Der stale Cache-Non-Food-Hit ist NICHT mehr als confirmed Non-Food persistiert.
    expect(inFilter?.canonicalCategory?.isNonFood).not.toBe(true);
    expect(classifyFoodDecision(inFilter as Offer)).not.toBe('confirmed_non_food');
  });
});

describe('P1 — strukturell echter Non-Food-Spritzring bleibt Non-Food', () => {
  it('Spritzring aus einer eindeutigen Non-Food-Abteilung (Haushaltswaren) bleibt confirmed_non_food', () => {
    const sr = spritzringConflict('spritzring_hh');
    const household = {
      ...sr,
      sourceCategoryRaw: 'Haushaltswaren',
      category: 'Haushalt',
    } as Offer;
    // Unabhängiges Non-Food-Quellsignal ⇒ der Cache-Hit ist NICHT untrustworthy.
    expect(hasUntrustworthyCacheNonFood(household)).toBe(false);
    expect(hasHardNonFoodSignal(household)).toBe(true);
    expect(classifyFoodDecision(household)).toBe('confirmed_non_food');

    const result = runRealPhase2Path({
      previousFiltered: [household],
      restored: [{ ...household, tags: [...(household.tags ?? []), PHASE2_RECHECK_TAG] } as Offer],
      skippedNonFood: [],
    });
    expect([...result.offers, ...result.nextWeekOffers].map((o) => o.id)).not.toContain('spritzring_hh');
    expect(result.filteredOffers.map((o) => o.id)).toContain('spritzring_hh');
  });
});

describe('P1 — veralteter Cache-Hit wird bei starkem Widerspruch nicht hart', () => {
  it('generisch: foodFlag=food + cache:hit-isNonFood + kein unabhängiger Beleg ⇒ nicht hart, uncertain', () => {
    const o = offer('mystery', 'Hausmarke Aktion', {
      foodFlag: 'food',
      canonicalCategory: { main: 'Non-Food', isNonFood: true, confidence: 0.55, reasons: ['cache:hit'] },
    } as Partial<Offer>);
    expect(hasUntrustworthyCacheNonFood(o)).toBe(true);
    expect(hasHardNonFoodSignal(o)).toBe(false);
    expect(classifyFoodDecision(o)).toBe('uncertain');
  });

  it('ein frischer (nicht-cache), hochkonfidenter Non-Food-Hit ohne foodFlag-Konflikt bleibt hart', () => {
    const o = offer('fresh_nf', 'Irgendein Artikel', {
      canonicalCategory: { main: 'Non-Food', isNonFood: true, confidence: 0.95, reasons: ['llm'] },
    } as Partial<Offer>);
    expect(hasUntrustworthyCacheNonFood(o)).toBe(false);
    expect(hasHardNonFoodSignal(o)).toBe(true);
  });
});
