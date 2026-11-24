import { describe, expect, it } from 'vitest';
import {
  officialSupermarketTestApi,
  type AldiSuedFetchResult,
  type AldiSuedPageFetcher,
} from './officialSupermarketConnector';

const {
  parseAldiSuedPage,
  aggregateAldiSuedPages,
  collectAldiSuedPaginatedOffers,
  aldiSuedPageUrl,
  parseAldiSuedSaleDate,
} = officialSupermarketTestApi;

const STORE = {
  storeChain: 'ALDI SUED',
  url: 'https://www.aldi-sued.de/angebote',
  parser: 'aldi' as const,
};

// Die zentrale Wochenangebote-Sammelseite (Seite 1 = Basis-URL ohne page-Param).
const COLLECTION_URL =
  'https://www.aldi-sued.de/produkte/wochenangebote/k/1588161426582123';
// Die ALTEN 3 Kategorie-Links — dürfen NICHT mehr abgerufen werden.
const LEGACY_SLUGS = [
  'frischeprodukte-im-angebot',
  'eigenmarken-im-angebot',
  'markenprodukte-im-angebot',
];
const LABEL = 'Wochenangebote';

// „Heute" für deterministische current/future-Tests.
const NOW = new Date('2026-06-27T10:00:00.000Z');

// ── Fixture-Builder: ein echtes Nuxt-3-__NUXT_DATA__-devalue-Array bauen ──────
// devalue serialisiert ein flaches Array; Objekt-/Array-Felder sind Indizes
// (Referenzen) in dasselbe Array, primitive Werte stehen als eigene Zellen. Der
// Builder spiegelt exakt diese Struktur, damit der echte Resolver getestet wird —
// keine vereinfachte Attrappe.
interface ProductSpec {
  sku: string;
  name: string;
  brandName: string;
  sellingSize?: string;
  urlSlugText?: string;
  onSaleDateDisplay?: string | null;
  amount?: number;
  amountRelevant?: number;
  amountRelevantDisplay?: string;
  bottleDeposit?: number;
  bottleDepositType?: string;
  comparisonDisplay?: string;
  wasPriceDisplay?: string | null;
  images?: string[];
  categories?: string[];
}

function buildNuxtHtml(products: ProductSpec[]): string {
  const arr: unknown[] = [{ data: 1 }]; // index 0 = Nuxt-Root-Platzhalter
  const ref = (value: unknown): number => {
    arr.push(value);
    return arr.length - 1;
  };

  for (const product of products) {
    const priceObj: Record<string, number> = {};
    if (product.amount !== undefined) priceObj.amount = ref(product.amount);
    if (product.amountRelevant !== undefined)
      priceObj.amountRelevant = ref(product.amountRelevant);
    if (product.amountRelevantDisplay !== undefined)
      priceObj.amountRelevantDisplay = ref(product.amountRelevantDisplay);
    if (product.bottleDeposit !== undefined)
      priceObj.bottleDeposit = ref(product.bottleDeposit);
    if (product.bottleDepositType !== undefined)
      priceObj.bottleDepositType = ref(product.bottleDepositType);
    if (product.comparisonDisplay !== undefined)
      priceObj.comparisonDisplay = ref(product.comparisonDisplay);
    if (product.wasPriceDisplay !== undefined && product.wasPriceDisplay !== null)
      priceObj.wasPriceDisplay = ref(product.wasPriceDisplay);
    const priceIdx = ref(priceObj);

    const assetIdxs = (product.images ?? []).map((url) => ref({ url: ref(url) }));
    const assetsIdx = ref(assetIdxs);

    const categoryIdxs = (product.categories ?? []).map((name) =>
      ref({ name: ref(name) }),
    );
    const categoriesIdx = ref(categoryIdxs);

    const productObj: Record<string, number> = {
      sku: ref(product.sku),
      abstractSku: ref(`${product.sku}A`),
      name: ref(product.name),
      brandName: ref(product.brandName),
      price: priceIdx,
      assets: assetsIdx,
      categories: categoriesIdx,
    };
    if (product.sellingSize !== undefined)
      productObj.sellingSize = ref(product.sellingSize);
    if (product.urlSlugText !== undefined)
      productObj.urlSlugText = ref(product.urlSlugText);
    if (product.onSaleDateDisplay !== undefined)
      productObj.onSaleDateDisplay = ref(product.onSaleDateDisplay ?? null);
    ref(productObj);
  }

  const payload = JSON.stringify(arr).replace(/</g, '\\u003C');
  return `<!doctype html><html><head><title>ALDI SÜD</title></head><body>
    <div class="product-listing-viewer"><div class="product-grid"></div></div>
    <script type="application/json" id="__NUXT_DATA__">${payload}</script>
  </body></html>`;
}

// Erreichbare, aber produktlose Seite (keine __NUXT_DATA__, keine Kacheln).
const EMPTY_HTML =
  '<!doctype html><html><body><div class="product-grid"></div></body></html>';

// ── Red-Bull-Regressionsfixture (Seite 2) ────────────────────────────────────
// Red Bull liegt strukturiert NUR auf ?page=2 — der Pagination-Pfad muss es
// finden. Preis 0,99 €, Pfand 0,25 € EINWEG, Grundpreis 3,96 €/l, Bild vorhanden.
const RED_BULL: ProductSpec = {
  sku: '000000000000444184',
  name: 'Energy Drink 250 ml',
  brandName: 'RED BULL',
  sellingSize: '0,25 l',
  urlSlugText: 'red-bull-energy-drink-250-ml',
  onSaleDateDisplay: null,
  amount: 99,
  amountRelevant: 99,
  amountRelevantDisplay: '0,99 €',
  bottleDeposit: 25,
  bottleDepositType: 'EINWEG',
  comparisonDisplay: '3,96 €/1 l',
  wasPriceDisplay: null,
  images: [
    'https://dm.emea.cms.aldi.cx/is/image/aldiprodeu/product/jpg/scaleWidth/{width}/91200731-e202-45f0-94f9-954a2b8ea057/{slug}',
  ],
  categories: ['Getränke', 'Energydrinks'],
};

function product(sku: string, name: string, brandName = 'MARKE'): ProductSpec {
  return {
    sku,
    name,
    brandName,
    sellingSize: '1 Stk',
    amount: 199,
    amountRelevant: 199,
    amountRelevantDisplay: '1,99 €',
    images: ['https://dm.emea.cms.aldi.cx/is/image/x/{width}/uuid/{slug}'],
    categories: ['Sonstiges'],
    onSaleDateDisplay: null,
  };
}

// ── Mock-Page-Fetcher (kein Netzwerk) ────────────────────────────────────────
type PagePlan =
  | { kind: 'products'; products: ProductSpec[] }
  | { kind: 'empty' }
  | { kind: 'blocked'; status?: number; reason?: string };

function planFetcher(
  plans: Record<number, PagePlan>,
  requested: string[],
): AldiSuedPageFetcher {
  return async (url, page) => {
    requested.push(url);
    const plan = plans[page] ?? { kind: 'empty' };
    if (plan.kind === 'blocked') {
      return {
        url,
        label: LABEL,
        ok: false,
        status: plan.status ?? 403,
        blockReason: plan.reason ?? '403 Forbidden (Captcha/Anti-Bot)',
      };
    }
    const html = plan.kind === 'empty' ? EMPTY_HTML : buildNuxtHtml(plan.products);
    return {
      url,
      label: LABEL,
      ok: true,
      status: 200,
      contentType: 'text/html;charset=utf-8',
      html,
    };
  };
}

describe('ALDI SÜD — strukturierter __NUXT_DATA__-Connector (Einzelseite)', () => {
  it('extrahiert Red Bull aus echter Struktur: Name/Marke/Preis/Pfand/Grundpreis/Bild/Gültigkeit', () => {
    const html = buildNuxtHtml([RED_BULL]);
    const { offers, sourceCheck } = parseAldiSuedPage(
      html,
      COLLECTION_URL,
      LABEL,
      STORE,
      NOW,
    );

    expect(sourceCheck.embeddedJsonFound).toBe(true);
    expect(sourceCheck.blocked).toBe(false);
    expect(offers).toHaveLength(1);

    const offer = offers[0];
    expect(offer.name).toBe('RED BULL Energy Drink 250 ml');
    expect(offer.brand).toBe('RED BULL');
    // Angebotspreis aus price.amount (Cent) → 0,99 €.
    expect(offer.price).toBe(0.99);
    // Grundpreis getrennt (NIE Preis).
    expect(offer.basePrice).toBe(3.96);
    expect(offer.baseUnit).toBe('1 l');
    expect(offer.unit).toBe('0,25 l');
    expect(offer.imageUrl).toContain('dm.emea.cms.aldi.cx');
    expect(offer.imageUrl).not.toContain('{width}');
    expect(offer.imageUrl).not.toContain('{slug}');
    // Pfand NUR im Roh-Kontext, NIE als Preis.
    expect(offer.sourceContextRaw).toContain('Pfand: 0.25 EUR');
    expect(offer.sourceContextRaw).toContain('EINWEG');
    expect(offer.sourceId).toBe('000000000000444184');
    expect(offer.sourceUrl).toContain('/produkt/red-bull-energy-drink-250-ml-000000000000444184');
    expect(offer.validityStart).toBeTruthy();
  });

  it('Pfand und Grundpreis werden NIE als Angebotspreis übernommen', () => {
    const html = buildNuxtHtml([RED_BULL]);
    const { offers } = parseAldiSuedPage(html, COLLECTION_URL, LABEL, STORE, NOW);
    const offer = offers[0];
    expect(offer.price).not.toBe(0.25); // Pfand
    expect(offer.price).not.toBe(3.96); // Grundpreis
    expect(offer.price).toBe(0.99);
  });

  it('ein Produkt OHNE Angebotspreis (nur Pfand) wird NICHT importiert', () => {
    const depositOnly: ProductSpec = {
      ...RED_BULL,
      sku: '000000000000999999',
      amount: undefined,
      amountRelevant: undefined,
      amountRelevantDisplay: undefined,
      bottleDeposit: 25,
    };
    const html = buildNuxtHtml([depositOnly]);
    const { offers, sourceCheck } = parseAldiSuedPage(html, COLLECTION_URL, LABEL, STORE, NOW);
    expect(offers).toHaveLength(0);
    expect(sourceCheck.productsParsed).toBe(0);
  });

  it('UVP/Streichpreis (wasPriceDisplay) wird originalPrice + reduziert-Tag, nie der Angebotspreis', () => {
    const reduced: ProductSpec = {
      sku: '000000000000123456',
      name: 'Hackfleisch gemischt 800 g',
      brandName: 'FAIR & GUT',
      sellingSize: '800 g',
      amount: 679,
      amountRelevant: 679,
      amountRelevantDisplay: '6,79 €',
      comparisonDisplay: '8,49 €/1 kg',
      wasPriceDisplay: '7,99 €',
      images: ['https://dm.emea.cms.aldi.cx/is/image/x/{width}/uuid/{slug}'],
      categories: ['Fleisch'],
      onSaleDateDisplay: null,
    };
    const html = buildNuxtHtml([reduced]);
    const { offers } = parseAldiSuedPage(html, COLLECTION_URL, LABEL, STORE, NOW);
    const offer = offers[0];
    expect(offer.price).toBe(6.79);
    expect(offer.originalPrice).toBe(7.99);
    expect(offer.price).not.toBe(7.99);
    expect(offer.tags).toContain('reduziert');
  });

  it('DOM-Kachel-Fallback NUR bei echtem HTML 200 ohne __NUXT_DATA__', () => {
    const domHtml = `<!doctype html><html><body>
      <div id="product-tile-0001" class="product-teaser-item">
        <div class="product-tile" data-test="product-tile" title="Bio-Hackfleisch Rind 800 g">
          <a href="/produkt/bio-hack-800-000111"></a>
          <img class="base-image" src="https://dm.emea.cms.aldi.cx/is/image/x/bio.jpg" />
          <div class="product-tile__brandname"><p>BIO</p></div>
          <div data-test="product-tile__comparison-price" class="product-tile__comparison-price"><p>(8,49 €/1 kg)</p></div>
          <div class="base-price" data-test="product-tile__price"><span class="base-price__regular"><span>6,79 €</span></span></div>
        </div>
      </div>
    </body></html>`;
    const { offers, sourceCheck } = parseAldiSuedPage(domHtml, COLLECTION_URL, LABEL, STORE, NOW);
    expect(sourceCheck.embeddedJsonFound).toBe(false);
    expect(sourceCheck.htmlProductCards).toBe(1);
    expect(offers.length).toBeGreaterThanOrEqual(1);
    expect(offers[0].price).toBe(6.79);
  });
});

describe('ALDI SÜD — aldiSuedPageUrl (Pagination-URLs)', () => {
  it('Seite 1 = Basis-URL ohne page-Parameter, danach ?page=N', () => {
    expect(aldiSuedPageUrl(COLLECTION_URL, 1)).toBe(COLLECTION_URL);
    expect(aldiSuedPageUrl(COLLECTION_URL, 2)).toBe(`${COLLECTION_URL}?page=2`);
    expect(aldiSuedPageUrl(COLLECTION_URL, 3)).toBe(`${COLLECTION_URL}?page=3`);
    // Vorhandene Query-Parameter bleiben erhalten, page wird ergänzt/ersetzt.
    expect(aldiSuedPageUrl(`${COLLECTION_URL}?sort=neu`, 2)).toContain('page=2');
    expect(aldiSuedPageUrl(`${COLLECTION_URL}?sort=neu`, 2)).toContain('sort=neu');
  });
});

describe('ALDI SÜD — aggregateAldiSuedPages (reine Seiten-Aggregation)', () => {
  it('Seite 1 + Seite 2 aggregieren korrekt, dedupe über sku', () => {
    const pages: AldiSuedFetchResult[] = [
      okPage(`${COLLECTION_URL}`, [RED_BULL, product('A1', 'Apfel 1 kg')]),
      okPage(`${COLLECTION_URL}?page=2`, [RED_BULL, product('B1', 'Brot 500 g')]),
      okPage(`${COLLECTION_URL}?page=3`, []), // leere Seite → Stop
    ];
    const { offers, diagnostics } = aggregateAldiSuedPages(pages, STORE, NOW);
    // RedBull (dup über sku) + A1 + B1 = 3 distinct.
    expect(offers).toHaveLength(3);
    expect(diagnostics.importedDistinct).toBe(3);
    expect(diagnostics.duplicatesMerged).toBe(1);
    expect(diagnostics.verdict).toBe('ok');
    expect(diagnostics.pagesChecked).toBe(3);
    expect(diagnostics.pagesWithProducts).toBe(2);
    // page-Nummern korrekt in der Diagnose.
    expect(diagnostics.sourceUrlsChecked.map((s) => s.page)).toEqual([1, 2, 3]);
  });

  it('Future-Angebote (onSaleDateDisplay > heute) bleiben upcoming und werden gezählt', () => {
    const future: ProductSpec = {
      ...RED_BULL,
      sku: '000000000000777777',
      name: 'Grillkäse 200 g',
      brandName: 'BBQ',
      onSaleDateDisplay: '2026-07-03',
    };
    const { offers, diagnostics } = aggregateAldiSuedPages(
      [okPage(COLLECTION_URL, [RED_BULL, future])],
      STORE,
      NOW,
    );
    expect(offers).toHaveLength(2);
    expect(diagnostics.futureProducts).toBe(1);
    expect(diagnostics.currentProducts).toBe(1);
    const futureOffer = offers.find((o) => o.sourceId === '000000000000777777');
    expect(futureOffer?.validityStart).toBe('2026-07-03T00:00:00.000Z');
  });
});

describe('ALDI SÜD — collectAldiSuedPaginatedOffers (Pagination-Treiber)', () => {
  it('läuft Seite 1 → Seite 2 und stoppt sauber an der leeren Seite 3', async () => {
    const requested: string[] = [];
    const fetcher = planFetcher(
      {
        1: { kind: 'products', products: [product('A1', 'Apfel'), product('A2', 'Birne')] },
        2: { kind: 'products', products: [product('B1', 'Brot')] },
        3: { kind: 'empty' },
      },
      requested,
    );
    const { offers, diagnostics } = await collectAldiSuedPaginatedOffers(fetcher, STORE, NOW);
    expect(offers).toHaveLength(3);
    // Seite 3 (leer) wird zwar abgerufen, danach STOP — Seite 4 nie.
    expect(requested).toEqual([
      COLLECTION_URL,
      `${COLLECTION_URL}?page=2`,
      `${COLLECTION_URL}?page=3`,
    ]);
    expect(diagnostics.pagesChecked).toBe(3);
    expect(diagnostics.pagesWithProducts).toBe(2);
    expect(diagnostics.verdict).toBe('ok');
  });

  it('Seite 1 = Basis-URL ohne page-Param, alte 3 Kategorie-Links werden NICHT mehr genutzt', async () => {
    const requested: string[] = [];
    const fetcher = planFetcher(
      { 1: { kind: 'products', products: [RED_BULL] }, 2: { kind: 'empty' } },
      requested,
    );
    await collectAldiSuedPaginatedOffers(fetcher, STORE, NOW);
    expect(requested[0]).toBe(COLLECTION_URL);
    for (const url of requested) {
      for (const slug of LEGACY_SLUGS) {
        expect(url).not.toContain(slug);
      }
    }
  });

  it('Dedupe über sku/object id: gleiche Produkte über mehrere Seiten → 1× importiert', async () => {
    const requested: string[] = [];
    const fetcher = planFetcher(
      {
        1: { kind: 'products', products: [RED_BULL, product('A1', 'Apfel')] },
        2: { kind: 'products', products: [RED_BULL, product('A1', 'Apfel')] }, // alles Dubletten
      },
      requested,
    );
    const { offers, diagnostics } = await collectAldiSuedPaginatedOffers(fetcher, STORE, NOW);
    expect(offers).toHaveLength(2);
    expect(diagnostics.importedDistinct).toBe(2);
    expect(diagnostics.duplicatesMerged).toBe(2);
  });

  it('Stop bei reiner Dubletten-Seite: Seite 2 bringt nichts Neues → keine Seite 3', async () => {
    const requested: string[] = [];
    const fetcher = planFetcher(
      {
        1: { kind: 'products', products: [product('A1', 'Apfel'), product('A2', 'Birne')] },
        2: { kind: 'products', products: [product('A1', 'Apfel'), product('A2', 'Birne')] },
        3: { kind: 'products', products: [product('C1', 'Käse')] }, // darf NIE erreicht werden
      },
      requested,
    );
    const { offers, diagnostics } = await collectAldiSuedPaginatedOffers(fetcher, STORE, NOW);
    expect(offers).toHaveLength(2);
    expect(requested).toEqual([COLLECTION_URL, `${COLLECTION_URL}?page=2`]);
    expect(diagnostics.sourceUrlsChecked[1].newProducts).toBe(0);
    expect(offers.find((o) => o.sourceId === 'C1')).toBeUndefined();
  });

  it('Stop bei leerer Seite: Seite 2 leer → keine Seite 3', async () => {
    const requested: string[] = [];
    const fetcher = planFetcher(
      {
        1: { kind: 'products', products: [product('A1', 'Apfel')] },
        2: { kind: 'empty' },
        3: { kind: 'products', products: [product('C1', 'Käse')] }, // nie erreicht
      },
      requested,
    );
    const { offers, diagnostics } = await collectAldiSuedPaginatedOffers(fetcher, STORE, NOW);
    expect(offers).toHaveLength(1);
    expect(requested).toEqual([COLLECTION_URL, `${COLLECTION_URL}?page=2`]);
    expect(diagnostics.pagesWithProducts).toBe(1);
  });

  it('Seite 1 blockiert ⇒ verdict blocked, 0 Angebote, kein stilles „0", keine Seite 2', async () => {
    const requested: string[] = [];
    const fetcher = planFetcher({ 1: { kind: 'blocked', status: 403 } }, requested);
    const { offers, diagnostics } = await collectAldiSuedPaginatedOffers(fetcher, STORE, NOW);
    expect(offers).toHaveLength(0);
    expect(diagnostics.verdict).toBe('blocked');
    expect(diagnostics.blocked).toBe(true);
    expect(diagnostics.blockReason).toContain('403');
    expect(requested).toEqual([COLLECTION_URL]);
  });

  it('Seite 2 blockiert nach erfolgreicher Seite 1 ⇒ verdict warning + Teilimport (kein Hard-Fail)', async () => {
    const requested: string[] = [];
    const fetcher = planFetcher(
      {
        1: { kind: 'products', products: [RED_BULL, product('A1', 'Apfel')] },
        2: { kind: 'blocked', status: 403 },
      },
      requested,
    );
    const { offers, diagnostics } = await collectAldiSuedPaginatedOffers(fetcher, STORE, NOW);
    expect(offers).toHaveLength(2); // Teilimport aus Seite 1
    expect(diagnostics.verdict).toBe('warning');
    expect(diagnostics.blocked).toBe(false);
    expect(diagnostics.sourceUrlsChecked.filter((s) => s.blocked)).toHaveLength(1);
    expect(requested).toEqual([COLLECTION_URL, `${COLLECTION_URL}?page=2`]);
  });

  it('REGRESSION: Red Bull liegt strukturiert auf Seite 2 und wird gefunden', async () => {
    const requested: string[] = [];
    const fetcher = planFetcher(
      {
        1: { kind: 'products', products: [product('A1', 'Apfel'), product('A2', 'Birne')] },
        2: { kind: 'products', products: [RED_BULL, product('B1', 'Brot')] },
        3: { kind: 'empty' },
      },
      requested,
    );
    const { offers } = await collectAldiSuedPaginatedOffers(fetcher, STORE, NOW);
    const redBull = offers.find((o) => o.sourceId === '000000000000444184');
    expect(redBull).toBeDefined();
    // Preis 0,99 €.
    expect(redBull?.price).toBe(0.99);
    // Pfand 0,25 und Grundpreis 3,96 landen NIE im Preis.
    expect(redBull?.price).not.toBe(0.25);
    expect(redBull?.price).not.toBe(3.96);
    expect(redBull?.basePrice).toBe(3.96);
    expect(redBull?.sourceContextRaw).toContain('Pfand: 0.25 EUR');
    // storeChain konsistent (ALDI SUED).
    expect(redBull?.storeChain).toBe(STORE.storeChain);
    // Bild vorhanden, ohne Platzhalter.
    expect(redBull?.imageUrl).toContain('dm.emea.cms.aldi.cx');
    expect(redBull?.imageUrl).not.toContain('{width}');
  });

  it('harte Obergrenze: Pagination läuft nie über ALDI_SUED_MAX_PAGES (10) hinaus', async () => {
    const requested: string[] = [];
    // Jede Seite liefert ein NEUES Produkt → ohne Cap würde es endlos laufen.
    const fetcher: AldiSuedPageFetcher = async (url, page) => {
      requested.push(url);
      return {
        url,
        label: LABEL,
        ok: true,
        status: 200,
        contentType: 'text/html;charset=utf-8',
        html: buildNuxtHtml([product(`P${page}`, `Produkt ${page}`)]),
      };
    };
    const { offers } = await collectAldiSuedPaginatedOffers(fetcher, STORE, NOW);
    expect(requested).toHaveLength(10);
    expect(offers).toHaveLength(10);
  });

  it('Sammelseite erreichbar (200), aber 0 strukturierte Produkte ⇒ verdict unavailable', async () => {
    const requested: string[] = [];
    const fetcher = planFetcher({ 1: { kind: 'empty' } }, requested);
    const { offers, diagnostics } = await collectAldiSuedPaginatedOffers(fetcher, STORE, NOW);
    expect(offers).toHaveLength(0);
    expect(diagnostics.verdict).toBe('unavailable');
    expect(diagnostics.blocked).toBe(false);
    expect(requested).toEqual([COLLECTION_URL]);
  });
});

describe('ALDI SÜD — parseAldiSuedSaleDate', () => {
  it('parst ISO, dd.mm.yyyy und „Ab Montag, 29. Juni"', () => {
    expect(parseAldiSuedSaleDate('2026-07-03', NOW)).toBe('2026-07-03T00:00:00.000Z');
    expect(parseAldiSuedSaleDate('03.07.2026', NOW)).toBe('2026-07-03T00:00:00.000Z');
    expect(parseAldiSuedSaleDate('Ab Montag, 29. Juni', NOW)).toBe('2026-06-29T00:00:00.000Z');
    expect(parseAldiSuedSaleDate(undefined, NOW)).toBeUndefined();
    expect(parseAldiSuedSaleDate('', NOW)).toBeUndefined();
  });
});

function okPage(url: string, products: ProductSpec[]): AldiSuedFetchResult {
  return {
    url,
    label: LABEL,
    ok: true,
    status: 200,
    contentType: 'text/html;charset=utf-8',
    html: products.length === 0 ? EMPTY_HTML : buildNuxtHtml(products),
  };
}
