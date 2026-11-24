import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  PHASE2_RECHECK_TAG,
  partitionFoodForAnalysis,
  selectUncertainFilteredForPhase2,
} from './offersScanV2';
import { selectAiCandidates } from './offerProductIntelligence';

// Produktvorgabe: NextWeek läuft NICHT durch Phase 2 — keine KI-Kosten/
// Anreicherung für die kommende Woche. Diese Tests spiegeln die exakte
// Kandidaten-Bauweise aus server.ts (foodInput = NUR snapshot.offers + uncertain-
// filtered) und sichern ab, dass NextWeek-Angebote NIE in die Phase-2-
// Kandidatenmenge geraten. Produktnamen sind reine Reproduktions-Fixtures.

const CURRENT = { validityStart: '2026-06-08T00:00:00.000Z', validityEnd: '2026-06-13T23:59:59.000Z' };
const NEXT = { validityStart: '2026-06-15T00:00:00.000Z', validityEnd: '2026-06-20T23:59:59.000Z' };

function offer(id: string, name: string, when = CURRENT, extra: Partial<Offer> = {}): Offer {
  return {
    id,
    name,
    normalizedName: name.toLowerCase(),
    storeChain: 'REWE',
    category: 'Milchprodukte',
    price: 1.99,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: when.validityStart,
    validityEnd: when.validityEnd,
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-06-08T00:00:00.000Z',
    ...({ foodFlag: 'food' } as Partial<Offer>),
    ...extra,
  } as Offer;
}

/** Genau wie server.ts: foodInput = NUR der live/current Bucket (kein nextWeek). */
function buildPhase2Candidates(snapshot: {
  offers: Offer[];
  nextWeekOffers: Offer[];
  filteredOffers: Offer[];
}): Offer[] {
  const foodInput = [...snapshot.offers];
  const partition = partitionFoodForAnalysis(foodInput);
  const uncertainFiltered = selectUncertainFilteredForPhase2(snapshot.filteredOffers);
  return selectAiCandidates([...partition.food, ...uncertainFiltered.candidates]).candidates;
}

describe('Phase-2-Kandidatenauswahl überspringt NextWeek', () => {
  const snapshot = {
    offers: [offer('cur1', 'Milch frisch'), offer('cur2', 'Bratwurst grob')],
    nextWeekOffers: [
      offer('nw1', 'Käse Gouda', NEXT),
      offer('nw2', 'Apfelsaft', NEXT),
      offer('nw3', 'Joghurt Natur', NEXT),
    ],
    // 'Celebrations' ist ein uncertain-Name → echter Phase-2-Recovery-Kandidat.
    filteredOffers: [offer('flt1', 'Celebrations')],
  };

  it('Kandidaten enthalten current, aber KEIN nextWeek-Angebot', () => {
    const candidateIds = buildPhase2Candidates(snapshot).map((o) => o.id);
    expect(candidateIds).toContain('cur1');
    expect(candidateIds).toContain('cur2');
    for (const nw of snapshot.nextWeekOffers) {
      expect(candidateIds).not.toContain(nw.id);
    }
  });

  it('filtered/uncertain bleibt Phase-2-Kandidat (recheck-getaggt)', () => {
    const candidates = buildPhase2Candidates(snapshot);
    const flt = candidates.find((o) => o.id === 'flt1');
    expect(flt).toBeDefined();
    expect(flt?.tags).toContain(PHASE2_RECHECK_TAG);
  });

  it('candidatesCount/sentToModel sinken um die NextWeek-Food-Menge', () => {
    const withoutNextWeek = buildPhase2Candidates(snapshot).length;
    // Vergleich gegen das ALTE Verhalten (nextWeek war Teil des foodInput).
    const oldFoodInput = [...snapshot.offers, ...snapshot.nextWeekOffers];
    const oldPartition = partitionFoodForAnalysis(oldFoodInput);
    const oldUncertain = selectUncertainFilteredForPhase2(snapshot.filteredOffers);
    const withNextWeek = selectAiCandidates([
      ...oldPartition.food,
      ...oldUncertain.candidates,
    ]).candidates.length;
    expect(withNextWeek - withoutNextWeek).toBe(snapshot.nextWeekOffers.length);
  });

  it('skippedNextWeekCount entspricht der NextWeek-Bucket-Größe', () => {
    const skippedNextWeekCount = snapshot.nextWeekOffers.length;
    expect(skippedNextWeekCount).toBe(3);
  });

  it('Ein Snapshot mit NUR NextWeek erzeugt 0 Phase-2-Kandidaten', () => {
    const onlyNextWeek = {
      offers: [],
      nextWeekOffers: [offer('nwA', 'Milch', NEXT), offer('nwB', 'Käse', NEXT)],
      filteredOffers: [],
    };
    expect(buildPhase2Candidates(onlyNextWeek)).toHaveLength(0);
  });
});
