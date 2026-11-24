// Angebots-Scan 2.0 — explicit store SCOPE model.
//
// The quality gate (snapshotSafetyGate) used to apply GLOBAL store rules — Lidl
// minimum, nahkauf "must be present", large-shop-zero-current — to EVERY run,
// regardless of which stores the run actually touched. A REWE-only Phase-2 run
// (enrich the manually imported REWE offers, no web scrape at all) was therefore
// wrongly discarded because Lidl/nahkauf had 0 offers — stores that were never
// part of this run.
//
// This module makes the scope EXPLICIT so the gate, the checkpoint and the
// status all agree on which stores a run is responsible for. It distinguishes:
//
//   • all_stores      — a full web scan; every required shop is checked.
//   • { stores: […] } — an explicit shop set (e.g. ["REWE"]); only those shops
//                        trigger store-specific gate rules.
//
// An EMPTY explicit store set means "no shop in scope" — it is NEVER silently
// reinterpreted as "all shops". That ambiguity is the bug we are removing.
//
// Pure + dependency-free (no Offer import beyond a structural { storeChain })
// so it is trivially unit-testable and importable from both server.ts and the
// gate without any cycle.

/** all_stores = full web scan; stores = an explicit, named shop set. */
export type ScanV2ScopeType = 'all_stores' | 'stores';

export interface ScanV2Scope {
  type: ScanV2ScopeType;
  /** Normalized canonical chain keys. ALWAYS empty for `all_stores`; for
   *  `stores` it is the explicit (possibly empty = "no shop") set. */
  stores: string[];
}

/**
 * Normalize a store chain into a canonical comparison key: trim + lowercase and
 * fold the German umlauts so "ALDI SÜD" / "ALDI SUED" / "aldi süd" all collapse
 * to one key. This is the single source of truth for store identity across the
 * scope model AND the safety gate.
 */
export function normalizeChainKey(value: string | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/ü/g, 'ue')
    .replace(/ö/g, 'oe')
    .replace(/ä/g, 'ae')
    .replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ');
}

/** The full-web-scan scope: every required shop is in scope. */
export function allStoresScope(): ScanV2Scope {
  return { type: 'all_stores', stores: [] };
}

/**
 * Build an explicit store scope from raw chain names. Names are normalized,
 * de-duplicated and emptied entries dropped. An empty result is a legitimate
 * "no shop in scope" — the caller decides whether that is actionable; it is
 * never coerced to all_stores here.
 */
export function scopeFromStores(stores: Iterable<string | undefined>): ScanV2Scope {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of stores) {
    const key = normalizeChainKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return { type: 'stores', stores: out };
}

/** Derive an explicit scope from the stores actually present in a set of offers
 *  (Phase-2-only on an existing snapshot derives its scope from the snapshot). */
export function deriveScopeFromOffers(
  offers: Iterable<{ storeChain?: string }>,
): ScanV2Scope {
  return scopeFromStores([...offers].map((offer) => offer.storeChain));
}

/** Whether a (raw or normalized) chain is inside the active scope. all_stores
 *  contains every chain; an explicit set contains only its listed chains. */
export function isChainInScope(scope: ScanV2Scope, chain: string | undefined): boolean {
  if (scope.type === 'all_stores') return true;
  return scope.stores.includes(normalizeChainKey(chain));
}

/**
 * Defensively normalize an arbitrary (e.g. JSON-parsed checkpoint) value into a
 * valid ScanV2Scope. Anything unrecognised degrades to all_stores ONLY when it
 * is explicitly typed that way; an explicit-but-malformed store list becomes an
 * empty store scope rather than silently widening to "all shops".
 */
export function normalizeScope(raw: unknown): ScanV2Scope {
  if (raw && typeof raw === 'object') {
    const value = raw as { type?: unknown; stores?: unknown };
    if (value.type === 'stores') {
      const stores = Array.isArray(value.stores) ? (value.stores as unknown[]) : [];
      return scopeFromStores(stores.map((entry) => String(entry ?? '')));
    }
    if (value.type === 'all_stores') return allStoresScope();
  }
  return allStoresScope();
}

/** A compact, human/diagnostic description of a scope for status + logs. */
export function describeScope(scope: ScanV2Scope): string {
  if (scope.type === 'all_stores') return 'all_stores (alle Shops)';
  if (scope.stores.length === 0) return 'stores (leer — kein Shop)';
  return `stores [${scope.stores.join(', ')}]`;
}
