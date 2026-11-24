// Admin-controlled kill-switches for the three AI-enrichment categories shown
// as coverage KPIs in the admin dashboard (Nutrition/Halal/Allergene). When a
// category is off, the backend keeps computing it internally (nothing here
// touches the AI pipeline) — only the data the Cheffity app receives over
// /api/offers gets suppressed, via deriveDealEnrichment (dealFields.ts).
//
// Persisted the same way as the Ollama model switch (server.ts's
// `/api/admin/ollama/config` + `upsertDotEnvValue`): written into `.env` on
// disk AND `process.env` in the same moment, so a toggle takes effect
// immediately without a server restart. Deliberately read fresh from
// `process.env` on every call (never through the frozen `appConfig` snapshot
// in `src/config/env.ts`, which is only built once at module load) — that
// frozen-snapshot mistake is why `appConfig.offersDisabledStores` requires a
// restart to change today; this module avoids repeating it.

export type EnrichmentCategory = 'nutrition' | 'halal' | 'allergens';

export const ENRICHMENT_CATEGORIES: readonly EnrichmentCategory[] = ['nutrition', 'halal', 'allergens'];

const ENV_KEYS: Record<EnrichmentCategory, string> = {
  nutrition: 'ENRICHMENT_NUTRITION_ENABLED',
  halal: 'ENRICHMENT_HALAL_ENABLED',
  allergens: 'ENRICHMENT_ALLERGENS_ENABLED',
};

/** Env key for a given category — exported so server.ts can persist a toggle
 *  via `upsertDotEnvValue(enrichmentFlagEnvKey(category), ...)`. */
export function enrichmentFlagEnvKey(category: EnrichmentCategory): string {
  return ENV_KEYS[category];
}

/** Lenient boolean parse: only an explicit "false"/"0"/"off" (case-insensitive)
 *  disables a category. Anything else — unset, "true", garbage — stays
 *  enabled, so existing installations without these vars keep today's
 *  behavior unchanged. */
function isExplicitlyDisabled(raw: string | undefined): boolean {
  const value = String(raw ?? '').trim().toLowerCase();
  return value === 'false' || value === '0' || value === 'off';
}

/**
 * Current on/off state of all three categories, read fresh from `process.env`
 * (or an injected env bag for tests). Pure, no I/O.
 */
export function resolveEnrichmentFlags(env: NodeJS.ProcessEnv = process.env): Record<EnrichmentCategory, boolean> {
  return {
    nutrition: !isExplicitlyDisabled(env[ENV_KEYS.nutrition]),
    halal: !isExplicitlyDisabled(env[ENV_KEYS.halal]),
    allergens: !isExplicitlyDisabled(env[ENV_KEYS.allergens]),
  };
}
