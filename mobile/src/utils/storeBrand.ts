// Store/supermarket brand normalisation for the deals screen filter.
//
// Backend `storeName` (mapped from `storeChain` in offersApi) is a free string
// that can vary in casing/suffix ("REWE", "REWE Markt GmbH", "rewe city"). This
// module groups those into stable brand keys so the store filter shows ONE chip
// per chain with a clean display label + a combined count. Kept free of
// react-native imports so it stays unit-testable.

export interface StoreBrand {
  /** Stable grouping key (e.g. 'rewe'). Unknown brands → `raw:<normalized>`. */
  key: string;
  /** Display label (canonical for known brands, shortened original otherwise). */
  label: string;
}

export interface StoreFilterOption {
  key: string;
  label: string;
  count: number;
}

/** Max characters for an unknown store's display label before ellipsis. */
const MAX_LABEL_LENGTH = 18;

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

// Known German grocery chains. `test` runs against the normalized string and
// its tokens. Substring match for chains ≥4 chars; short brands like "dm" must
// match a standalone token so they never trigger inside unrelated words
// (e.g. "Admiral").
const KNOWN_BRANDS: {
  key: string;
  label: string;
  test: (norm: string, tokens: string[]) => boolean;
}[] = [
  { key: 'rewe', label: 'REWE', test: (n) => n.includes('rewe') },
  { key: 'lidl', label: 'Lidl', test: (n) => n.includes('lidl') },
  { key: 'aldi', label: 'Aldi', test: (n) => n.includes('aldi') },
  { key: 'edeka', label: 'Edeka', test: (n) => n.includes('edeka') },
  { key: 'kaufland', label: 'Kaufland', test: (n) => n.includes('kaufland') },
  { key: 'netto', label: 'Netto', test: (n) => n.includes('netto') },
  { key: 'penny', label: 'Penny', test: (n) => n.includes('penny') },
  { key: 'dm', label: 'dm', test: (_n, tokens) => tokens.includes('dm') },
];

function shorten(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_LABEL_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_LABEL_LENGTH - 1).trimEnd()}…`;
}

/**
 * Map a raw store name to its brand group. Empty/whitespace names return an
 * empty label under the shared `__none__` key (callers skip these — no crash on
 * missing storeName).
 */
export function normalizeStoreBrand(raw?: string | null): StoreBrand {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { key: '__none__', label: '' };

  const norm = normalize(trimmed);
  const tokens = norm.split(/[^a-z0-9]+/).filter(Boolean);
  for (const brand of KNOWN_BRANDS) {
    if (brand.test(norm, tokens)) return { key: brand.key, label: brand.label };
  }
  // Unknown chain: keep the original (shortened) name, grouped case-insensitively.
  return { key: `raw:${norm}`, label: shorten(trimmed) };
}

/** True when a deal belongs to the given brand key. Tolerates missing names. */
export function dealMatchesStore(storeName: string | null | undefined, key: string): boolean {
  return normalizeStoreBrand(storeName).key === key;
}

/**
 * Build the store filter options from a set of deals — one entry per brand that
 * actually has deals, with a combined count, sorted by count desc then label.
 * For unknown chains the most frequent original display label wins.
 */
export function buildStoreFilters(deals: { storeName?: string | null }[]): StoreFilterOption[] {
  const groups = new Map<string, { count: number; labelCounts: Map<string, number> }>();

  for (const deal of deals) {
    const name = (deal.storeName ?? '').trim();
    if (!name) continue; // skip deals without a store — never crash, just omit
    const { key, label } = normalizeStoreBrand(name);
    const entry = groups.get(key) ?? { count: 0, labelCounts: new Map<string, number>() };
    entry.count += 1;
    entry.labelCounts.set(label, (entry.labelCounts.get(label) ?? 0) + 1);
    groups.set(key, entry);
  }

  return [...groups.entries()]
    .map(([key, entry]) => {
      let label = '';
      let best = -1;
      for (const [candidate, n] of entry.labelCounts) {
        if (n > best) {
          best = n;
          label = candidate;
        }
      }
      return { key, label, count: entry.count };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'de'));
}
