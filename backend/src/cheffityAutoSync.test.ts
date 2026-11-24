import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  buildCheffitySyncInput,
  shouldSyncAfterPhase1Commit,
  shouldSyncAfterPhase2Commit,
  shouldSyncAfterReweImport,
} from './cheffityAutoSync';

function makeOffer(id: string): Offer {
  return {
    id,
    name: `Offer ${id}`,
    normalizedName: `offer ${id}`,
    storeChain: 'REWE',
    category: 'dairy',
    price: 1.29,
    currency: 'EUR',
    unit: '1l',
    validityStart: '2026-06-22T00:00:00.000Z',
    validityEnd: '2026-06-28T23:59:59.999Z',
    imageUrl: 'https://example.com/x.png',
    sourceUrl: 'https://example.com/offer',
    tags: [],
    createdAt: '2026-06-22T08:00:00.000Z',
  } as Offer;
}

describe('shouldSyncAfterPhase1Commit', () => {
  it('syncs after a phase1-only commit', () => {
    expect(shouldSyncAfterPhase1Commit('phase1')).toBe(true);
  });

  it('does NOT sync after Phase 1 of a phase1_phase2 run (Phase 2 owns the sync)', () => {
    expect(shouldSyncAfterPhase1Commit('phase1_phase2')).toBe(false);
  });

  it('does not apply to a phase2-only run (Phase 1 never runs)', () => {
    expect(shouldSyncAfterPhase1Commit('phase2')).toBe(false);
  });
});

describe('shouldSyncAfterPhase2Commit', () => {
  it('syncs after a phase2-only commit', () => {
    expect(shouldSyncAfterPhase2Commit('phase2')).toBe(true);
  });

  it('syncs after Phase 2 of a phase1_phase2 run', () => {
    expect(shouldSyncAfterPhase2Commit('phase1_phase2')).toBe(true);
  });

  it('does not apply to a phase1-only run (Phase 2 never runs)', () => {
    expect(shouldSyncAfterPhase2Commit('phase1')).toBe(false);
  });
});

describe('phase1_phase2 syncs exactly once, after Phase 2', () => {
  it('counts a single sync across both phase commits', () => {
    const mode = 'phase1_phase2' as const;
    let syncCount = 0;
    // Simulate the two commit points of a full scan in order.
    if (shouldSyncAfterPhase1Commit(mode)) syncCount += 1; // Phase 1 commit
    if (shouldSyncAfterPhase2Commit(mode)) syncCount += 1; // Phase 2 commit
    expect(syncCount).toBe(1);
  });
});

describe('shouldSyncAfterReweImport', () => {
  it('syncs inline when the import committed and no Phase-2 scan was started', () => {
    expect(shouldSyncAfterReweImport({ committed: true, phase2Started: false })).toBe(true);
  });

  it('defers (no inline sync) when a background Phase-2 scan was started', () => {
    expect(shouldSyncAfterReweImport({ committed: true, phase2Started: true })).toBe(false);
  });

  it('never syncs when the import did not commit (quality-gate reject / empty)', () => {
    expect(shouldSyncAfterReweImport({ committed: false, phase2Started: false })).toBe(false);
    expect(shouldSyncAfterReweImport({ committed: false, phase2Started: true })).toBe(false);
  });
});

describe('buildCheffitySyncInput', () => {
  it('combines current + next week and tracks next-week ids as FUTURE', () => {
    const snapshot = {
      offers: [makeOffer('c1'), makeOffer('c2')],
      nextWeekOffers: [makeOffer('n1')],
    };
    const input = buildCheffitySyncInput(snapshot);
    expect(input.combinedOffers.map((o) => o.id)).toEqual(['c1', 'c2', 'n1']);
    expect([...input.nextWeekOfferIds]).toEqual(['n1']);
    // Current offers must NOT be flagged as future.
    expect(input.nextWeekOfferIds.has('c1')).toBe(false);
    expect(input.nextWeekOfferIds.has('c2')).toBe(false);
  });

  it('handles an empty next-week bucket (no future ids)', () => {
    const snapshot = { offers: [makeOffer('c1')], nextWeekOffers: [] as Offer[] };
    const input = buildCheffitySyncInput(snapshot);
    expect(input.combinedOffers).toHaveLength(1);
    expect(input.nextWeekOfferIds.size).toBe(0);
  });
});
