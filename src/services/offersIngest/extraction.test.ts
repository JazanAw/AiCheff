import { describe, expect, it } from 'vitest';
import { extractOffersFromChunk } from './extraction';
import { RawSourceDocument } from './types';

describe('extractOffersFromChunk', () => {
  it('extrahiert Angebotszeilen aus Fixture-Format ohne LLM', async () => {
    const chunk = `
- Bio Bananen | 1,29 EUR/kg | Obst/Gemüse | 03.02.2026-09.02.2026 | tags vegan,bio
- Haferdrink Natur | 1,19 EUR/L | Milchalternativen | 03.02.2026-09.02.2026 | tags vegan
    `.trim();

    const source: RawSourceDocument = {
      connectorId: 'fixture',
      sourceUrl: 'https://example.org/fixture',
      sourceLabel: 'Fixture',
      storeChain: 'Aldi',
      region: '80 München',
      postalCode: '80331',
      latitude: 48.137154,
      longitude: 11.576124,
      contentType: 'text',
      content: chunk,
      fetchedAt: new Date().toISOString(),
    };

    const offers = await extractOffersFromChunk(chunk, source, false);
    expect(offers).toHaveLength(2);
    expect(offers[0].name).toBe('Bio Bananen');
    expect(offers[0].storeChain).toBe('Aldi');
    expect(offers[0].tags).toEqual(['vegan', 'bio']);
    expect(offers[1].category).toBe('Milchalternativen');
  });
});
