import { describe, expect, it } from 'vitest';
import { enrichmentFlagEnvKey, ENRICHMENT_CATEGORIES, resolveEnrichmentFlags } from './enrichmentFlags';

describe('resolveEnrichmentFlags', () => {
  it('defaults every category to enabled when unset (unchanged behavior for existing installs)', () => {
    expect(resolveEnrichmentFlags({} as NodeJS.ProcessEnv)).toEqual({
      nutrition: true,
      halal: true,
      allergens: true,
    });
  });

  it('an explicit "false" disables a category', () => {
    expect(
      resolveEnrichmentFlags({ ENRICHMENT_HALAL_ENABLED: 'false' } as NodeJS.ProcessEnv).halal,
    ).toBe(false);
  });

  it('accepts "0" and "off" as disabling values too', () => {
    expect(resolveEnrichmentFlags({ ENRICHMENT_NUTRITION_ENABLED: '0' } as NodeJS.ProcessEnv).nutrition).toBe(false);
    expect(resolveEnrichmentFlags({ ENRICHMENT_ALLERGENS_ENABLED: 'off' } as NodeJS.ProcessEnv).allergens).toBe(false);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(resolveEnrichmentFlags({ ENRICHMENT_HALAL_ENABLED: '  FALSE  ' } as NodeJS.ProcessEnv).halal).toBe(false);
  });

  it('an unrecognized value stays enabled (never silently disables on garbage input)', () => {
    expect(resolveEnrichmentFlags({ ENRICHMENT_HALAL_ENABLED: 'nope' } as NodeJS.ProcessEnv).halal).toBe(true);
  });

  it('each category is independent — disabling one leaves the others untouched', () => {
    const flags = resolveEnrichmentFlags({ ENRICHMENT_ALLERGENS_ENABLED: 'false' } as NodeJS.ProcessEnv);
    expect(flags).toEqual({ nutrition: true, halal: true, allergens: false });
  });
});

describe('enrichmentFlagEnvKey / ENRICHMENT_CATEGORIES', () => {
  it('maps every category to a distinct env key', () => {
    const keys = ENRICHMENT_CATEGORIES.map(enrichmentFlagEnvKey);
    expect(keys).toEqual(['ENRICHMENT_NUTRITION_ENABLED', 'ENRICHMENT_HALAL_ENABLED', 'ENRICHMENT_ALLERGENS_ENABLED']);
    expect(new Set(keys).size).toBe(3);
  });
});
