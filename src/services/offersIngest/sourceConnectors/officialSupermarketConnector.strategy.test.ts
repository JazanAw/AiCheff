import { describe, expect, it } from 'vitest';
import { officialSupermarketTestApi } from './officialSupermarketConnector';

describe('official stores carry an explicit import strategy', () => {
  it('stamps every store config with a resolved strategy', () => {
    const stores = officialSupermarketTestApi.selectOfficialStores();
    expect(stores.length).toBeGreaterThan(0);
    for (const store of stores) {
      expect(store.strategy).toBeTruthy();
    }
  });

  it('marks REWE as browser_required and nahkauf as Storyblok api_endpoint', () => {
    const stores = officialSupermarketTestApi.selectOfficialStores();
    const rewe = stores.find((store) => store.storeChain === 'REWE');
    const nahkauf = stores.find((store) => store.storeChain === 'nahkauf');
    expect(rewe?.strategy).toBe('browser_required');
    expect(nahkauf?.strategy).toBe('api_endpoint');
  });

  it('uses embedded_json for the SSR stores', () => {
    const stores = officialSupermarketTestApi.selectOfficialStores();
    expect(stores.find((store) => store.storeChain === 'Kaufland')?.strategy).toBe('embedded_json');
  });
});
