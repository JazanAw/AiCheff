import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getLastNahkaufDiagnostics,
  officialSupermarketTestApi,
} from './officialSupermarketConnector';

// nahkauf-Importer (eigener Flow, NICHT wie REWE): die Angebotsseite liefert
// einen öffentlichen Storyblok-Token, die CDN-API liefert `offer`-Stories mit
// Cent-Preisen, Validity und Markt-IDs. Ohne Markt-ID nur national_all.

const store = {
  storeChain: 'nahkauf',
  url: 'https://www.nahkauf.de/angebote-im-markt/',
  parser: 'nahkauf' as const,
};

function story(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { content: contentOverrides, ...rest } = overrides;
  return {
    uuid: 'u-1',
    full_slug: 'import-objects/offers/offer-19207227',
    ...rest,
    content: {
      advertising_product_name: 'Oberdorfer Helles',
      brand: 'MW OBERDORFER',
      amount: 'je 20 x 0,5-l-Fl.-Kasten',
      promotion_price: 1499,
      cross_out_price: 1799,
      base_price: '1 l = 1,50 €',
      national_all: false,
      market_ids: '320593,540624',
      market_ids_array: [320593, 540624],
      valid_from: '2026-06-08',
      valid_to: '2026-06-13',
      images: [
        {
          component: 'offer_image',
          image_url: ' https://img.rewe-static.de/NAHKAUF_HZ24_2026/8412099/img.png',
        },
      ],
      features: [
        { key: 'REWE_CATEGORY', value: 'Bier', component: 'offer_feature' },
        { key: 'advertFrom', value: '2026-06-06', component: 'offer_feature' },
      ],
      ...((contentOverrides as Record<string, unknown>) ?? {}),
    },
  };
}

describe('parseNahkaufStoryblokOffers', () => {
  it('importiert nationale Angebote mit Cent-Preisen, Validity und Bild', () => {
    const offers = officialSupermarketTestApi.parseNahkaufStoryblokOffers(
      { stories: [story({ content: { national_all: true } })] },
      store,
    );
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      name: 'Oberdorfer Helles',
      storeChain: 'nahkauf',
      price: 14.99,
      originalPrice: 17.99,
      imageUrl: 'https://img.rewe-static.de/NAHKAUF_HZ24_2026/8412099/img.png',
      validityStart: '2026-06-08T00:00:00.000Z',
      validityEnd: '2026-06-13T23:59:59.999Z',
    });
  });

  it('verwirft lokale Angebote ohne Markt-Kontext (kein blindes Importieren)', () => {
    const offers = officialSupermarketTestApi.parseNahkaufStoryblokOffers(
      { stories: [story()] }, // national_all: false, nur market_ids
      store,
    );
    expect(offers).toHaveLength(0);
  });

  it('importiert lokale Angebote, wenn die konfigurierte Markt-ID passt', () => {
    const matching = officialSupermarketTestApi.parseNahkaufStoryblokOffers(
      { stories: [story()] },
      store,
      { marketId: '540624' },
    );
    expect(matching).toHaveLength(1);

    const notMatching = officialSupermarketTestApi.parseNahkaufStoryblokOffers(
      { stories: [story()] },
      store,
      { marketId: '999999' },
    );
    expect(notMatching).toHaveLength(0);
  });

  it('taggt lokale Markt-Angebote als nahkauf-local mit sourceScope local (Marktbezug erhalten)', () => {
    const offers = officialSupermarketTestApi.parseNahkaufStoryblokOffers(
      { stories: [story()] }, // national_all: false, importiert NUR wegen Markt-Match
      store,
      { marketId: '540624' },
    );
    expect(offers).toHaveLength(1);
    expect(offers[0].tags).toContain('nahkauf-local');
    expect(offers[0].tags).not.toContain('national');
    expect(offers[0].sourceScope).toBe('local');
  });

  it('taggt national_all-Angebote weiterhin als national, auch wenn die Markt-ID passt', () => {
    const offers = officialSupermarketTestApi.parseNahkaufStoryblokOffers(
      { stories: [story({ content: { national_all: true } })] },
      store,
      { marketId: '540624' },
    );
    expect(offers).toHaveLength(1);
    expect(offers[0].tags).toContain('national');
    expect(offers[0].tags).not.toContain('nahkauf-local');
    expect(offers[0].sourceScope).toBe('national');
  });

  it('nutzt die REWE_CATEGORY-Feature als Kategorie-Hinweis (Roh-Kategorie bleibt erhalten)', () => {
    const offers = officialSupermarketTestApi.parseNahkaufStoryblokOffers(
      { stories: [story({ content: { national_all: true } })] },
      store,
    );
    expect(offers[0].sourceCategoryRaw).toBe('Bier');
  });
});

describe('dedupeNahkaufOffers — nationale/lokale Dubletten', () => {
  it('verschmilzt dasselbe Produkt aus nationaler und lokaler Story zu einem Angebot mit beiden Scope-Tags', () => {
    const national = officialSupermarketTestApi.parseNahkaufStoryblokOffers(
      {
        stories: [
          story({ uuid: 'u-nat', full_slug: 'import-objects/offers/offer-national', content: { national_all: true } }),
        ],
      },
      store,
      { marketId: '540624' },
    );
    const local = officialSupermarketTestApi.parseNahkaufStoryblokOffers(
      { stories: [story({ uuid: 'u-loc', full_slug: 'import-objects/offers/offer-local' })] },
      store,
      { marketId: '540624' },
    );
    expect(national).toHaveLength(1);
    expect(local).toHaveLength(1);

    const deduped = officialSupermarketTestApi.dedupeNahkaufOffers([...national, ...local]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].tags).toEqual(expect.arrayContaining(['national', 'nahkauf-local']));
  });

  it('laesst unterschiedliche Produkte unangetastet', () => {
    const offers = officialSupermarketTestApi.parseNahkaufStoryblokOffers(
      {
        stories: [
          story({ uuid: 'u-a', full_slug: 'import-objects/offers/offer-a', content: { national_all: true } }),
          story({
            uuid: 'u-b',
            full_slug: 'import-objects/offers/offer-b',
            content: { national_all: true, advertising_product_name: 'Gouda jung', promotion_price: 599 },
          }),
        ],
      },
      store,
    );
    expect(officialSupermarketTestApi.dedupeNahkaufOffers(offers)).toHaveLength(2);
  });
});

describe('nahkauf Gueltigkeit — immer aus der Quelle, nie aus der Kalenderwoche', () => {
  it('faellt ohne valid_from/valid_to auf die advertFrom/advertTo-Features zurueck', () => {
    const offers = officialSupermarketTestApi.parseNahkaufStoryblokOffers(
      {
        stories: [
          story({
            content: {
              national_all: true,
              valid_from: undefined,
              valid_to: undefined,
              features: [
                { key: 'advertFrom', value: '2026-07-06', component: 'offer_feature' },
                { key: 'advertTo', value: '2026-07-11', component: 'offer_feature' },
              ],
            },
          }),
        ],
      },
      store,
    );
    expect(offers).toHaveLength(1);
    expect(offers[0].validityStart).toBe('2026-07-06T00:00:00.000Z');
    expect(offers[0].validityEnd).toBe('2026-07-11T23:59:59.999Z');
  });
});

// Die frühere Angebotsseite ist entfallen (404, „Angebote" verlinkt auf
// rewe.de); der öffentliche Storyblok-Token liegt weiterhin auf der Startseite.
// Der Import darf daran nicht hart scheitern, sondern fällt auf die Startseite
// zurück und diagnostiziert einen leeren Offer-Space ehrlich als source-gap.
describe('nahkauf Angebotsseite-404 — Startseiten-Fallback + ehrliche Diagnose', () => {
  const homeHtml =
    '<a href="https://www.rewe.de/angebote/nationale-angebote/">Angebote</a>' +
    'storyblok:{accessToken:"tok-123",enableSudoMode:false}';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(routes: Record<string, { status: number; body: string }>): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
        if (!route) {
          throw new Error(`Unerwarteter fetch im Test: ${url}`);
        }
        const [, { status, body }] = route;
        return new Response(body, { status });
      }),
    );
  }

  it('faellt bei 404 der Angebotsseite auf die Startseite zurueck (Warning, HTML der Startseite)', async () => {
    stubFetch({
      'https://www.nahkauf.de/angebote-im-markt/': { status: 404, body: 'Not Found' },
      'https://www.nahkauf.de/': { status: 200, body: homeHtml },
    });
    const warnings: string[] = [];
    const html = await officialSupermarketTestApi.fetchNahkaufHtmlWithFallback(store, warnings);
    expect(html).toBe(homeHtml);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Angebotsseite nicht erreichbar (404');
    expect(warnings[0]).toContain('Startseite');
  });

  it('wirft den urspruenglichen Fehler, wenn auch die Startseite nicht lesbar ist', async () => {
    stubFetch({
      'https://www.nahkauf.de/angebote-im-markt/': { status: 404, body: 'Not Found' },
      'https://www.nahkauf.de/': { status: 500, body: 'kaputt' },
    });
    const warnings: string[] = [];
    await expect(
      officialSupermarketTestApi.fetchNahkaufHtmlWithFallback(store, warnings),
    ).rejects.toThrow(/404/);
    expect(warnings).toHaveLength(0);
  });

  it('meldet 0 Offer-Stories + rewe.de-Angebote-Link ehrlich als source-gap (kein Parser-Defekt)', async () => {
    stubFetch({
      'https://api.storyblok.com/v2/cdn/stories': { status: 200, body: '{"stories":[]}' },
    });
    const warnings: string[] = [];
    const offers = await officialSupermarketTestApi.fetchNahkaufOffers(homeHtml, store, warnings);
    expect(offers).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('source-gap');
    expect(warnings[0]).toContain('rewe.de');
    // Strukturierte Diagnose für den Scan-Report: belegter source-gap.
    const diag = getLastNahkaufDiagnostics();
    expect(diag).toMatchObject({
      tokenFound: true,
      offerStoryCount: 0,
      importedDistinct: 0,
      offersLinkToRewe: true,
      sourceGap: true,
      blocked: false,
    });
  });
});

describe('buildNahkaufZeroOffersWarning — ehrliche 0-Angebote-Diagnose', () => {
  const reweLinkHtml = '<a href="https://www.rewe.de/angebote/nationale-angebote/">Angebote</a>';

  it('belegter source-gap: 0 Stories UND Angebote-Link auf rewe.de', () => {
    const warning = officialSupermarketTestApi.buildNahkaufZeroOffersWarning(
      store,
      '',
      reweLinkHtml,
      0,
    );
    expect(warning).toContain('source-gap');
    expect(warning).toContain('rewe.de');
  });

  it('kein source-gap-Verdacht, wenn Stories existieren (Markt-ID-Hinweis bleibt)', () => {
    const warning = officialSupermarketTestApi.buildNahkaufZeroOffersWarning(
      store,
      '999999',
      reweLinkHtml,
      120,
    );
    expect(warning).toContain('Markt-ID prüfen');
    expect(warning).not.toContain('source-gap');
  });

  it('ohne rewe.de-Link bleibt die bestehende national-only-Erklaerung', () => {
    const warning = officialSupermarketTestApi.buildNahkaufZeroOffersWarning(
      store,
      '',
      '<html>keine Links</html>',
      0,
    );
    expect(warning).toContain('NAHKAUF_MARKET_ID');
    expect(warning).not.toContain('source-gap');
  });
});

describe('extractNahkaufStoryblokToken', () => {
  it('liest den öffentlichen Storyblok-Token aus der Angebotsseite', () => {
    const html =
      'APS_API_KEY:"x",DEV_VIEW:false,storyblok:{accessToken:"4uTQaOKzvALZunptFcpOjwtt",enableSudoMode:false}';
    expect(officialSupermarketTestApi.extractNahkaufStoryblokToken(html)).toBe(
      '4uTQaOKzvALZunptFcpOjwtt',
    );
  });

  it('gibt undefined zurück, wenn kein Token vorhanden ist (ehrlicher Failure)', () => {
    expect(officialSupermarketTestApi.extractNahkaufStoryblokToken('<html></html>')).toBeUndefined();
  });
});
