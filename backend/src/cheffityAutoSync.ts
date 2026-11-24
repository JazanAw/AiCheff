// Cheffity Auto-Sync decision logic (pure, testable).
//
// After a scan/import has SUCCESSFULLY committed a new snapshot, Cheffity must be
// brought up to date with the exact same sync+matcher that the manual
// `/api/offers/sync-supabase` endpoint runs. The *where* and *how* live in
// server.ts (it owns `snapshot`, Supabase config and the matcher); the *whether*
// decisions are extracted here so they can be unit-tested without booting the
// Express app or touching Supabase.
//
// Invariants encoded here:
//  • Sync runs only after a successful snapshot COMMIT — never on a quality-gate
//    failure (the gate throws before saveSnapshot, so the hook is never reached).
//  • phase1_phase2 must sync exactly ONCE, after Phase 2 — never after Phase 1.
//  • A REWE import that kicked off a background Phase-2 scan defers its sync to
//    that scan's done-hook, so the import never double-syncs.

import type { Offer } from '../../src/types/models';
import { modeIncludesPhase2, type ScanV2Mode } from './offersScanV2';

/**
 * Whether the Cheffity auto-sync should run after a successful Phase-1 commit.
 *
 * Only a Phase-1-ONLY run (`phase1`) syncs here. In `phase1_phase2` Phase 2 still
 * follows, so syncing now would (a) push un-enriched data and (b) double-sync
 * once Phase 2 also commits — both are wrong, hence `false`.
 */
export function shouldSyncAfterPhase1Commit(mode: ScanV2Mode): boolean {
  return !modeIncludesPhase2(mode);
}

/**
 * Whether the Cheffity auto-sync should run after a successful Phase-2 commit.
 *
 * True for every mode that includes Phase 2 (`phase2` and `phase1_phase2`). For
 * `phase1_phase2` this is the single sync point — Phase 1 deliberately skipped
 * syncing (see {@link shouldSyncAfterPhase1Commit}).
 */
export function shouldSyncAfterPhase2Commit(mode: ScanV2Mode): boolean {
  return modeIncludesPhase2(mode);
}

/**
 * Whether to run the Cheffity auto-sync INLINE after a successful REWE import
 * commit.
 *
 *  • `committed=false` (quality-gate reject / empty import) → never sync.
 *  • `committed=true` + a background Phase-2 scan was started → defer to that
 *    scan's Phase-2 done-hook (avoids a double sync). Returns `false`.
 *  • `committed=true` + Phase 2 was NOT started (Ollama down, checkpoint busy)
 *    → sync inline now. Returns `true`.
 */
export function shouldSyncAfterReweImport(input: {
  committed: boolean;
  phase2Started: boolean;
}): boolean {
  return input.committed && !input.phase2Started;
}

export interface CheffitySyncInput {
  /** current (live) + next-week offers, deduped by the caller's buckets. */
  combinedOffers: Offer[];
  /** ids of the next-week offers, so the sync keeps them in the FUTURE bucket. */
  nextWeekOfferIds: Set<string>;
}

/**
 * Build the deals-sync payload from the live snapshot buckets. Current + next
 * week are combined into one list; the next-week ids are tracked separately so
 * `syncDealsToSupabase` routes them into the FUTURE bucket instead of forcing
 * them live today.
 */
export function buildCheffitySyncInput(snapshot: {
  offers: Offer[];
  nextWeekOffers: Offer[];
}): CheffitySyncInput {
  return {
    combinedOffers: [...snapshot.offers, ...snapshot.nextWeekOffers],
    nextWeekOfferIds: new Set(snapshot.nextWeekOffers.map((offer) => offer.id)),
  };
}
