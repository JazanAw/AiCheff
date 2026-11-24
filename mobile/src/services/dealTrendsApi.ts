import { supabase } from '../config/supabase';
import { fetchProductTrends } from './trendsApi';

// Maps the anonymous, aggregated `product_trend_30d` view onto live deals so the
// "Trend-Angebote" section reflects what people actually add/buy — without ever
// exposing a single user. Only fully aggregated counts cross this boundary.
//
// Qualification threshold (anonymity + signal strength): a trending term must
// have unique_users >= 3 OR added_count >= 5. The view itself already requires
// added_count >= 2; this raises the bar before anything is shown as a "trend".
const MIN_UNIQUE_USERS = 3;
const MIN_ADDED_COUNT = 5;

// A trend term must be at least this long to be matched against a deal name —
// short tokens ("ei", "tee") would over-match and create false trends.
const MIN_TERM_LENGTH = 4;

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fetch the set of qualifying, normalized trend terms. Returns an empty set on
 * any failure or data shortage — the caller treats "no trends" as a non-error
 * (the section just falls back to discount-derived trends or hides).
 */
export async function fetchTrendingTerms(): Promise<Set<string>> {
  // RLS-guarded read; `product_trend_30d` is granted to authenticated.
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Set();

  const rows = await fetchProductTrends(60);
  const terms = new Set<string>();
  for (const row of rows) {
    const qualifies = row.uniqueUsers >= MIN_UNIQUE_USERS || row.addedCount >= MIN_ADDED_COUNT;
    if (!qualifies) continue;
    const term = normalize(row.sampleName || row.nameKey);
    if (term.length >= MIN_TERM_LENGTH) terms.add(term);
  }
  return terms;
}

/**
 * Conservative match between a deal name and the trending terms. A deal trends
 * when a trend term appears as a whole word/substring inside its (normalized)
 * name, e.g. term "bergkaese" ⊂ "allgaeuer bergkaese 250g". No fuzzy scoring —
 * we'd rather miss a trend than fabricate one.
 */
export function isTrendingDealName(dealName: string, terms: Set<string>): boolean {
  if (terms.size === 0) return false;
  const name = normalize(dealName);
  if (!name) return false;
  for (const term of terms) {
    if (name.includes(term)) return true;
  }
  return false;
}
