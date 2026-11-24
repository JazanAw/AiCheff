import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  PHASE2_RECHECK_TAG,
  selectUncertainFilteredForPhase2,
  stripPhase2RecheckTag,
} from './offersScanV2';
import { applyProductAnalysis } from './offerProductIntelligence';
import { reassemblePhase2Buckets } from './phase2Reassembly';
import { applyFinalNonFoodGate } from './snapshotNonFoodGate';
import { applyFoodRescuePass, revertStaleRescues } from './snapshotFoodRescue';
import { evaluateSnapshotSafety } from './snapshotSafetyGate';
import { classifyFoodDecision, evaluateFoodReconciliation } from './foodDecision';

// Task P2 — Integrationstest über den ECHTEN Phase-2-Reassembly-Pfad (nicht nur
// classifyFoodDecision/applyFoodRescuePass isoliert):
//   filtered Snapshot
//   → Phase-2-Kandidatenauswahl (selectUncertainFilteredForPhase2)
//   → neues Phase-2-Ergebnis / Ergebnisübernahme (applyProductAnalysis)
//   → reassemblePhase2Buckets
//   → finales Gate/Rescue (evaluateSnapshotSafety + saveSnapshot-Pass-Reihenfolge)
//   → Snapshot-Kandidat VOR dem Commit (evaluateFoodReconciliation)
// Produktnamen sind reine Reproduktions-Fixtures — KEIN Produktivcode kennt eine
// Produkt-/Marken-Allowlist.

const NOW = new Date('2026-06-10T12:00:00.000Z');
const CURRENT = { validityStart: '2026-06-08T00:00:00.000Z', validityEnd: '2026-06-13T23:59:59.000Z' };

function offer(id: string, name: string, extra: Partial<Offer> & Record<string, unknown> = {}): Offer {
  return {
    id,
    name,
    normalizedName: name.toLowerCase(),
    storeChain: 'REWE',
    category: 'Sonstiges',
    price: 1.99,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: CURRENT.validityStart,
    validityEnd: CURRENT.validityEnd,
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-06-08T00:00:00.000Z',
    ...extra,
  } as Offer;
}

/** Replicates the server.ts Phase-2 finalize: reassembly → safety-gate →
 *  saveSnapshot pass order (revert → non-food-gate → food-rescue) → pre-commit
 *  reconciliation. Pure, no IO. */
function runRealPhase2Path(input: {
  previousFiltered: Offer[];
  restored: Offer[];
  skippedNonFood: Offer[];
  previousVisible?: { offers: Offer[]; nextWeekOffers: Offer[] };
}): {
  offers: Offer[];
  nextWeekOffers: Offer[];
  filteredOffers: Offer[];
  safe: ReturnType<typeof evaluateSnapshotSafety>;
  reconciliation: ReturnType<typeof evaluateFoodReconciliation>;
} {
  const reassembly = reassemblePhase2Buckets({
    restored: input.restored,
    previousFiltered: input.previousFiltered,
    skippedNonFood: input.skippedNonFood,
    now: NOW,
    weekBucketOf: () => 'current',
    isPreserved: () => false,
    maxValidityDays: 21,
  });
  const previous = {
    offers: input.previousVisible?.offers ?? [],
    nextWeekOffers: input.previousVisible?.nextWeekOffers ?? [],
    filteredOffers: input.previousFiltered,
  };
  const candidate = {
    offers: reassembly.offers,
    nextWeekOffers: reassembly.nextWeekOffers,
    filteredOffers: reassembly.filteredOffers,
  };
  const safe = evaluateSnapshotSafety({ previous, candidate, now: NOW });

  // saveSnapshot-Pass-Reihenfolge (Recheck-Tag wird vor dem Persistieren entfernt).
  const stripped = {
    offers: candidate.offers.map(stripPhase2RecheckTag),
    nextWeekOffers: candidate.nextWeekOffers.map(stripPhase2RecheckTag),
    filteredOffers: candidate.filteredOffers.map(stripPhase2RecheckTag),
  };
  const reverted = revertStaleRescues(stripped);
  const gate = applyFinalNonFoodGate(reverted);
  const rescue = applyFoodRescuePass(gate, { now: NOW, weekBucketOf: () => 'current' });
  const reconciliation = evaluateFoodReconciliation(
    { filteredOffers: rescue.filteredOffers },
    { isTimeValid: () => true },
  );
  return {
    offers: rescue.offers,
    nextWeekOffers: rescue.nextWeekOffers,
    filteredOffers: rescue.filteredOffers,
    safe,
    reconciliation,
  };
}

describe('P2 — veralteter Cache-Hit überstimmt belastbare Phase-2-Food-Entscheidung nicht', () => {
  it('Kandidatenauswahl wählt das uncertain-Angebot, überspringt confirmed_non_food', () => {
    const selection = selectUncertainFilteredForPhase2([
      offer('cand', 'Hausmarke Spezial Edition'), // uncertain (kein Food-Keyword)
      offer('nf', 'WC-Reiniger Kraft'), // confirmed_non_food → skip
    ]);
    expect(selection.candidates.map((o) => o.id)).toEqual(['cand']);
    expect(selection.candidates[0].tags).toContain(PHASE2_RECHECK_TAG);
  });

  it('belastbares Phase-2-Ergebnis (Food-Quellabteilung) gewinnt gegen Cache-isNonFood → sichtbar + bereinigt', () => {
    // Phase-1-uncertain-Angebot, das im Filter lag.
    const original = offer('cand', 'Hausmarke Spezial Edition');
    // Phase-2-Kandidatenauswahl (echter Produktionsschritt).
    const [picked] = selectUncertainFilteredForPhase2([original]).candidates;
    expect(classifyFoodDecision(picked)).toBe('uncertain');

    // VERALTETER Cache-Hit (sibling) sagt isNonFood — wird per applyProductAnalysis
    // (echte Ergebnisübernahme) auf den Kandidaten kopiert.
    const staleDonor = offer('donor', 'Hausmarke Spezial Edition', {
      foodFlag: 'nonfood',
      canonicalCategory: { isNonFood: true, main: 'Haushalt', confidence: 0.4 },
      tags: ['nonfood'],
    });
    const afterCacheHit = applyProductAnalysis(picked, staleDonor, { now: NOW.toISOString() });
    // Das NEUE belastbare Phase-2-Ergebnis liefert eine vertrauenswürdige
    // Food-Quellabteilung (strukturell, von classifyFoodDecision gelesen).
    const reanalyzed = {
      ...(afterCacheHit as Offer),
      sourceCategoryRaw: 'Molkerei',
      tags: [...new Set([...(afterCacheHit.tags ?? []), PHASE2_RECHECK_TAG])],
    } as Offer;
    expect(classifyFoodDecision(reanalyzed)).toBe('confirmed_food');

    const result = runRealPhase2Path({
      previousFiltered: [original],
      restored: [reanalyzed],
      skippedNonFood: [],
    });

    // Das Item landet im sichtbaren Bucket — der Cache-isNonFood überstimmt nicht.
    expect(result.offers.map((o) => o.id)).toContain('cand');
    expect(result.filteredOffers.map((o) => o.id)).not.toContain('cand');
    // Alte Non-Food-Artefakte konsistent bereinigt.
    const visible = result.offers.find((o) => o.id === 'cand') as
      | (Offer & { foodFlag?: string; canonicalCategory?: { isNonFood?: boolean } })
      | undefined;
    expect(visible?.foodFlag).not.toBe('nonfood');
    expect(visible?.canonicalCategory?.isNonFood).not.toBe(true);
    expect((visible?.tags ?? []).some((t) => t.toLowerCase() === 'nonfood')).toBe(false);
    // Gate + Pre-Commit-Reconciliation sind grün.
    expect(result.safe.ok).toBe(true);
    expect(result.reconciliation.ok).toBe(true);
  });

  it('ohne belastbares neues Ergebnis bleibt ein mehrdeutiges Item filtered/review (nicht blind sichtbar)', () => {
    const original = offer('amb', 'Mysteriöser Markenartikel');
    const [picked] = selectUncertainFilteredForPhase2([original]).candidates;
    // Cache-Hit liefert ebenfalls nur ein schwaches/unklares Verdikt (unsure).
    const weakDonor = offer('donor2', 'Mysteriöser Markenartikel', {
      foodFlag: 'unsure',
      canonicalCategory: { isNonFood: false, confidence: 0.2 },
    });
    const reanalyzed = applyProductAnalysis(picked, weakDonor, { now: NOW.toISOString() });
    expect(classifyFoodDecision(reanalyzed)).toBe('uncertain');

    const result = runRealPhase2Path({
      previousFiltered: [original],
      restored: [reanalyzed],
      skippedNonFood: [],
    });
    expect(result.offers.map((o) => o.id)).not.toContain('amb');
    expect(result.nextWeekOffers.map((o) => o.id)).not.toContain('amb');
    const inFilter = result.filteredOffers.find((o) => o.id === 'amb') as
      | (Offer & { reviewNeeded?: boolean })
      | undefined;
    expect(inFilter).toBeDefined();
    expect(inFilter?.reviewNeeded).toBe(true);
    expect(result.safe.ok).toBe(true);
    expect(result.reconciliation.ok).toBe(true);
  });

  it('strukturell bestätigter Haushaltsgegenstand bleibt Non-Food (gefiltert)', () => {
    const household = {
      ...offer('hh', 'WC-Reiniger Kraft-Gel'),
      tags: [PHASE2_RECHECK_TAG],
    } as Offer;
    expect(classifyFoodDecision(household)).toBe('confirmed_non_food');
    const result = runRealPhase2Path({
      previousFiltered: [offer('hh', 'WC-Reiniger Kraft-Gel')],
      restored: [household],
      skippedNonFood: [],
    });
    expect([...result.offers, ...result.nextWeekOffers].map((o) => o.id)).not.toContain('hh');
    expect(result.filteredOffers.map((o) => o.id)).toContain('hh');
    expect(result.safe.ok).toBe(true);
  });
});
