import { describe, expect, it } from 'vitest';
import { officialSupermarketTestApi } from './officialSupermarketConnector';

const { selectOfficialStores } = officialSupermarketTestApi;

function chains(exclude: string[] = []): string[] {
  return selectOfficialStores(exclude).map((store) => store.storeChain);
}

describe('selectOfficialStores — weekly auto-scan exclusion', () => {
  it('includes REWE + nahkauf by default (no exclusion)', () => {
    const all = chains();
    expect(all).toContain('REWE');
    expect(all).toContain('nahkauf');
    expect(all.length).toBeGreaterThan(5);
  });

  it('excludes REWE + nahkauf (case-insensitive) but keeps the other chains', () => {
    const kept = chains(['REWE', 'nahkauf']);
    expect(kept).not.toContain('REWE');
    expect(kept).not.toContain('nahkauf');
    // Everyone else is still scraped.
    expect(kept).toEqual(expect.arrayContaining(['Lidl', 'ALDI SUED', 'EDEKA', 'Kaufland', 'PENNY']));
  });

  it('matches store chains case-insensitively', () => {
    expect(chains(['rewe'])).not.toContain('REWE');
    expect(chains(['NAHKAUF'])).not.toContain('nahkauf');
  });
});
