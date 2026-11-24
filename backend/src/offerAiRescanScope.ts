// Store-scoped KI-Rescan helpers.
//
// The Datenqualität "KI prüfen & verbessern" button can optionally target one
// or more supermarket chains instead of the whole snapshot. These pure helpers
// do the list bookkeeping so server.ts can keep the heavy lifting (python
// pipeline, strict-food filter, week split) and stay free of scope branching.
//
// Contract:
//   - normalizeStoreChains(): trim + lowercase + dedupe; [] means "all stores".
//   - partitionOffersForScope(): split snapshot buckets into the offers that
//     belong to the selected chains (→ get re-categorized) and the offers that
//     must be preserved untouched in their original bucket.
//   - mergeScopedRescan(): fold the freshly re-categorized selected offers back
//     together with the retained ones, deduped by id.

import type { Offer } from '../../src/types/models';

/** Snapshot's three offer buckets, by reference (live / next-week / filtered). */
export interface SnapshotBuckets {
  current: Offer[];
  next: Offer[];
  filtered: Offer[];
}

export interface ScopePartition {
  /** Offers belonging to the selected chains, gathered from all buckets. */
  selected: Offer[];
  /** Offers of the NON-selected chains, kept in their original bucket. */
  retained: SnapshotBuckets;
}

/**
 * Normalize a requested list of store chains: trim, lowercase, drop empties and
 * duplicates. An empty/absent list means "all stores" (caller decides).
 */
export function normalizeStoreChains(chains?: readonly unknown[] | null): string[] {
  if (!Array.isArray(chains)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const chain of chains) {
    if (typeof chain !== 'string') {
      continue;
    }
    const norm = chain.trim().toLowerCase();
    if (!norm || seen.has(norm)) {
      continue;
    }
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

/** Whether an offer belongs to one of the selected chains (case-insensitive). */
export function offerMatchesStoreChains(
  offer: Offer,
  normalizedChains: readonly string[],
): boolean {
  if (normalizedChains.length === 0) {
    return true; // empty scope = all stores
  }
  const chain = (offer.storeChain ?? '').trim().toLowerCase();
  if (!chain) {
    return false;
  }
  return normalizedChains.includes(chain);
}

function dedupeById(offers: Offer[]): Offer[] {
  const seen = new Set<string>();
  const out: Offer[] = [];
  for (const offer of offers) {
    if (seen.has(offer.id)) {
      continue;
    }
    seen.add(offer.id);
    out.push(offer);
  }
  return out;
}

/**
 * Split the snapshot buckets into selected (to re-categorize) and retained
 * (preserved as-is). With an empty scope every offer is selected and nothing is
 * retained — i.e. it degrades to the whole-snapshot behaviour.
 */
export function partitionOffersForScope(
  buckets: SnapshotBuckets,
  normalizedChains: readonly string[],
): ScopePartition {
  const selected: Offer[] = [];
  const retained: SnapshotBuckets = { current: [], next: [], filtered: [] };

  const sort = (offers: Offer[], bucket: keyof SnapshotBuckets): void => {
    for (const offer of offers) {
      if (offerMatchesStoreChains(offer, normalizedChains)) {
        selected.push(offer);
      } else {
        retained[bucket].push(offer);
      }
    }
  };

  sort(buckets.current, 'current');
  sort(buckets.next, 'next');
  sort(buckets.filtered, 'filtered');

  return { selected: dedupeById(selected), retained };
}

/**
 * Re-combine retained (untouched) offers with the freshly re-categorized
 * selected offers. The caller has already strict-filtered + week-split the
 * selected offers into the three buckets; this only concatenates and dedupes.
 * Retained offers always survive — unselected stores never vanish.
 */
export function mergeScopedRescan(
  retained: SnapshotBuckets,
  recategorized: SnapshotBuckets,
): SnapshotBuckets {
  return {
    current: dedupeById([...retained.current, ...recategorized.current]),
    next: dedupeById([...retained.next, ...recategorized.next]),
    filtered: dedupeById([...retained.filtered, ...recategorized.filtered]),
  };
}

/** Distinct store chains present in the given offers, in first-seen order. */
export function listStoreChains(offers: Offer[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const offer of offers) {
    const chain = (offer.storeChain ?? '').trim();
    if (!chain) {
      continue;
    }
    const key = chain.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(chain);
  }
  return out;
}
