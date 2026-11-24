import { describe, expect, it } from 'vitest';
import { officialSupermarketTestApi } from './officialSupermarketConnector';

const store = {
  storeChain: 'Kaufland',
  url: 'https://filiale.kaufland.de/angebote/aktuelle-woche.html',
  parser: 'kaufland' as const,
};

const now = new Date('2026-06-03T13:00:00.000Z'); // Wed of ISO week Mon 06-01 .. Sun 06-07

// SSR with TWO cycles: the current week and the next week. "EHRMANN Almighurt"
// is offered in BOTH weeks — the old name+url dedup collapsed it to a single
// offer (keeping the future variant), which dropped the current one from live.
function buildSsrHtml(): string {
  const ssr = {
    component: 'OfferTemplate',
    props: {
      offerData: {
        cycles: [
          {
            categories: [
              {
                displayName: 'Molkereiprodukte',
                offers: [
                  {
                    offerId: 'cur-1',
                    dateFrom: '2026-06-01',
                    dateTo: '2026-06-06',
                    title: 'EHRMANN',
                    subtitle: 'Almighurt',
                    price: 0.29,
                    listImage: 'https://kaufland.media.schwarz/is/image/schwarz/1',
                  },
                  {
                    offerId: 'cur-2',
                    dateFrom: '2026-06-01',
                    dateTo: '2026-06-06',
                    title: 'K-CLASSIC',
                    subtitle: 'Kondensmilch XXL 4 % Fett',
                    price: 0.79,
                  },
                ],
              },
              {
                displayName: 'Drogerie',
                offers: [
                  {
                    offerId: 'cur-3',
                    dateFrom: '2026-06-01',
                    dateTo: '2026-06-06',
                    title: 'NIVEA',
                    subtitle: 'Duschgel',
                    price: 1.49,
                  },
                ],
              },
            ],
          },
          {
            categories: [
              {
                displayName: 'Molkereiprodukte',
                offers: [
                  {
                    offerId: 'next-1',
                    dateFrom: '2026-06-08',
                    dateTo: '2026-06-13',
                    title: 'EHRMANN',
                    subtitle: 'Almighurt',
                    price: 0.29,
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  };
  return `<script>window.SSR = window.SSR || {}; window.SSR['x'] = ${JSON.stringify(ssr)}</script>`;
}

describe('parseKauflandOffersFromHtml — validity-aware ids + non-food tagging', () => {
  it('keeps the same product in the current AND next week as two distinct offers', () => {
    const offers = officialSupermarketTestApi.parseKauflandOffersFromHtml(buildSsrHtml(), store);
    const almighurt = offers.filter((o) => o.name === 'EHRMANN Almighurt');
    expect(almighurt).toHaveLength(2);
    const ids = new Set(almighurt.map((o) => o.id));
    expect(ids.size).toBe(2); // not collapsed by the name+url dedup
    const starts = almighurt.map((o) => o.validityStart).sort();
    expect(starts[0]).toContain('2026-06-01');
    expect(starts[1]).toContain('2026-06-08');
  });

  it('preserves the raw source category (sourceCategoryRaw) for the KI', () => {
    const offers = officialSupermarketTestApi.parseKauflandOffersFromHtml(buildSsrHtml(), store);
    const almighurt = offers.find((o) => o.name === 'EHRMANN Almighurt');
    const duschgel = offers.find((o) => o.name.includes('Duschgel'));
    // The simple `category` is collapsed, but the raw department survives.
    expect(almighurt?.sourceCategoryRaw).toBe('Molkereiprodukte');
    expect(duschgel?.sourceCategoryRaw).toBe('Drogerie');
  });

  it('tags offers from non-food categories (Drogerie) with a "nonfood" tag', () => {
    const offers = officialSupermarketTestApi.parseKauflandOffersFromHtml(buildSsrHtml(), store);
    const duschgel = offers.find((o) => o.name.includes('Duschgel'));
    expect(duschgel).toBeDefined();
    expect(duschgel?.tags).toContain('nonfood');
    // A genuine food offer is NOT tagged nonfood.
    const food = offers.find((o) => o.name === 'EHRMANN Almighurt');
    expect(food?.tags ?? []).not.toContain('nonfood');
  });
});

// Der Card-Promo-Anker "*Mit Kaufland Card <Produkt>" ist Preis-Kontext, kein
// Produktname: im Namen verschmutzt er die Phase-2-KI (belegt: "…Card
// Bacon-Scheiben" → "Süßwaren & Snacks"), den produktstabilen Key und die
// Anzeige. Er wird beim Parsen abgetrennt und als Tag 'kaufland-card' erhalten.
describe('splitKauflandCardPrefix — Card-Anker raus aus dem Produktnamen', () => {
  const split = officialSupermarketTestApi.splitKauflandCardPrefix;

  it('trennt den Anker ab und markiert das Angebot als Card-Angebot', () => {
    expect(split('*Mit Kaufland Card Bacon-Scheiben')).toEqual({
      name: 'Bacon-Scheiben',
      kauflandCard: true,
    });
    // case-insensitiv + ohne führenden Stern
    expect(split('mit kaufland card Aperitif')).toEqual({ name: 'Aperitif', kauflandCard: true });
  });

  it('lässt Namen ohne Anker unverändert (auch "Mit..." mitten im Namen)', () => {
    expect(split('EHRMANN Almighurt')).toEqual({ name: 'EHRMANN Almighurt', kauflandCard: false });
    expect(split('Grillkäse mit Kräutern')).toEqual({
      name: 'Grillkäse mit Kräutern',
      kauflandCard: false,
    });
  });

  it('erzeugt nie einen leeren Namen (reiner Card-Teaser behält das Original)', () => {
    expect(split('*Mit Kaufland Card')).toEqual({
      name: '*Mit Kaufland Card',
      kauflandCard: true,
    });
  });

  it('Parser: Name sauber, Tag kaufland-card gesetzt, nonfood-Logik unberührt', () => {
    const ssr = {
      component: 'OfferTemplate',
      props: {
        offerData: {
          cycles: [
            {
              categories: [
                {
                  displayName: 'Fleisch & Wurst',
                  offers: [
                    {
                      offerId: 'card-1',
                      dateFrom: '2026-06-01',
                      dateTo: '2026-06-06',
                      title: '*Mit Kaufland Card',
                      subtitle: 'Bacon-Scheiben',
                      price: 1.99,
                      formattedOldPrice: '2,49',
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    };
    const html = `<script>window.SSR = window.SSR || {}; window.SSR['x'] = ${JSON.stringify(ssr)}</script>`;
    const offers = officialSupermarketTestApi.parseKauflandOffersFromHtml(html, store);
    expect(offers).toHaveLength(1);
    expect(offers[0].name).toBe('Bacon-Scheiben');
    expect(offers[0].tags).toContain('kaufland-card');
    expect(offers[0].tags).toContain('reduziert');
    expect(offers[0].tags).not.toContain('nonfood');
  });

  it('analyzeKauflandSsr führt die offiziellen Food-Namen ohne Card-Anker', () => {
    const ssr = {
      component: 'OfferTemplate',
      props: {
        offerData: {
          cycles: [
            {
              categories: [
                {
                  displayName: 'Fleisch & Wurst',
                  offers: [
                    {
                      offerId: 'card-2',
                      dateFrom: '2026-06-01',
                      dateTo: '2026-06-06',
                      title: '*Mit Kaufland Card',
                      subtitle: 'Kabanossi',
                      price: 2.79,
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    };
    const html = `<script>window.SSR = window.SSR || {}; window.SSR['x'] = ${JSON.stringify(ssr)}</script>`;
    const analysis = officialSupermarketTestApi.analyzeKauflandSsr(html, now);
    expect(analysis.currentFoodOffers.map((o) => o.name)).toEqual(['Kabanossi']);
  });
});

describe('analyzeKauflandSsr — completeness metric', () => {
  it('separates current/upcoming and food/non-food and reports honest counts', () => {
    const analysis = officialSupermarketTestApi.analyzeKauflandSsr(buildSsrHtml(), now);
    expect(analysis.officialTotalCount).toBe(4); // cur-1, cur-2, cur-3, next-1
    expect(analysis.officialCurrentCount).toBe(3); // cur-1, cur-2, cur-3
    expect(analysis.officialFoodishCount).toBe(2); // cur-1, cur-2 (Drogerie is non-food)
    expect(analysis.upcomingCount).toBe(1); // next-1
    expect(analysis.nonFoodCount).toBe(1); // cur-3 Drogerie
    const foodNames = analysis.currentFoodOffers.map((o) => o.name).sort();
    expect(foodNames).toEqual([
      'EHRMANN Almighurt',
      'K-CLASSIC Kondensmilch XXL 4 % Fett',
    ]);
  });

  it('computes a missing estimate against the offers actually imported', () => {
    const analysis = officialSupermarketTestApi.analyzeKauflandSsr(buildSsrHtml(), now);
    // We imported only the Ehrmann Almighurt → Kondensmilch is missing.
    const completeness = officialSupermarketTestApi.buildKauflandCompleteness(analysis, {
      currentNames: ['EHRMANN Almighurt'],
    });
    expect(completeness.officialFoodishCount).toBe(2);
    expect(completeness.officialDistinctFoodCount).toBe(2);
    expect(completeness.matchedCount).toBe(1);
    expect(completeness.importedCurrentCount).toBe(1); // deprecated Alias
    expect(completeness.missingEstimate).toBe(1);
    expect(completeness.missingExamples).toContain('K-CLASSIC Kondensmilch XXL 4 % Fett');
    // Invariante: distinct = matched + matchedFiltered + missing.
    expect(
      completeness.matchedCount +
        completeness.matchedFilteredCount +
        completeness.matchedFilteredNonFoodCount +
        completeness.missingEstimate,
    ).toBe(completeness.officialDistinctFoodCount);
    expect(completeness.comparisonScope).toMatch(/aktuellen/i);
  });

  it('zaehlt offizielle Food-Angebote im Filtered-Bucket als matchedFiltered, nicht als missing', () => {
    const analysis = officialSupermarketTestApi.analyzeKauflandSsr(buildSsrHtml(), now);
    const completeness = officialSupermarketTestApi.buildKauflandCompleteness(analysis, {
      currentNames: ['EHRMANN Almighurt'],
      filteredNames: ['K-CLASSIC Kondensmilch XXL 4 % Fett'],
    });
    expect(completeness.matchedCount).toBe(1);
    expect(completeness.matchedFilteredCount).toBe(1);
    expect(completeness.missingEstimate).toBe(0);
  });

  it('trennt regelbestätigtes Non-Food (gemischte Kategorie) vom Food-Verdacht', () => {
    const analysis = officialSupermarketTestApi.analyzeKauflandSsr(buildSsrHtml(), now);
    const completeness = officialSupermarketTestApi.buildKauflandCompleteness(analysis, {
      currentNames: [],
      filteredNames: ['EHRMANN Almighurt'], // ohne Non-Food-Beleg => Verdacht
      filteredNonFoodNames: ['K-CLASSIC Kondensmilch XXL 4 % Fett'], // regelbestätigt
    });
    expect(completeness.matchedFilteredCount).toBe(1);
    expect(completeness.matchedFilteredNonFoodCount).toBe(1);
    expect(completeness.missingEstimate).toBe(0);
    expect(
      completeness.matchedCount +
        completeness.matchedFilteredCount +
        completeness.matchedFilteredNonFoodCount +
        completeness.missingEstimate,
    ).toBe(completeness.officialDistinctFoodCount);
  });

  it('matcht den "*Mit Kaufland Card"-Prefix und Kurznamen-Containment (Aperitivo-Fall)', () => {
    // Reproduktionsbeispiel: das offizielle Card-Teaser-Objekt heisst nur
    // "*Mit Kaufland Card&#x2028;Aperitivo", importiert ist der Langname.
    const ssr = {
      offerData: {
        cycles: [
          {
            categories: [
              {
                displayName: 'Getränke',
                offers: [
                  {
                    offerId: 'card-1',
                    dateFrom: '2026-06-08',
                    dateTo: '2026-06-13',
                    title: '*Mit Kaufland Card&#x2028;Aperitivo',
                    price: 4.99,
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const html = `<script>window.SSR = window.SSR || {}; window.SSR['x'] = ${JSON.stringify(ssr)}</script>`;
    const analysis = officialSupermarketTestApi.analyzeKauflandSsr(
      html,
      new Date('2026-06-10T12:00:00.000Z'),
    );
    const completeness = officialSupermarketTestApi.buildKauflandCompleteness(analysis, {
      currentNames: ['*Mit Kaufland Card Prosecco DOC Treviso oder Orange Spritz Aperitivo'],
    });
    expect(completeness.missingEstimate).toBe(0);
    expect(completeness.matchedCount).toBe(1);
  });

  it('normalisiert Card-Prefix, Sternchen und &#x2028; identisch auf beiden Seiten', () => {
    const { normalizeKauflandMatchName } = officialSupermarketTestApi;
    expect(normalizeKauflandMatchName('*Mit Kaufland Card&#x2028;Aperitivo')).toBe(
      normalizeKauflandMatchName('Aperitivo'),
    );
    expect(normalizeKauflandMatchName('K-WERTSCHÄTZE&#x2028;Hüftsteak')).toBe(
      normalizeKauflandMatchName('K-WERTSCHÄTZE Hüftsteak'),
    );
  });
});

describe('kaufland names with the &#x2028; entity (line separator)', () => {
  // The real SSR JSON carries U+2028 BOTH as a literal char and as the raw HTML
  // entity inside the JSON string ("K-WERTSCHÄTZE&#x2028;Hüftsteak"). The
  // analyzer and the import parser must normalize it identically, otherwise the
  // ~270 Fleisch/Wurst offers are wrongly reported as missing.
  function entitySsrHtml(): string {
    const ssr = {
      offerData: {
        cycles: [
          {
            categories: [
              {
                displayName: 'Fleisch & Wurst',
                offers: [
                  {
                    offerId: 'cur-1',
                    dateFrom: '2026-06-08',
                    dateTo: '2026-06-13',
                    title: 'K-WERTSCHÄTZE&#x2028;Hüftsteak',
                    subtitle: 'Schweinehüftsteak mariniert',
                    price: 0.99,
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    return `<script>window.SSR = window.SSR || {}; window.SSR['x'] = ${JSON.stringify(ssr)}</script>`;
  }
  const entityNow = new Date('2026-06-10T12:00:00.000Z');

  it('normalizes the entity to a space in the analyzer names', () => {
    const analysis = officialSupermarketTestApi.analyzeKauflandSsr(entitySsrHtml(), entityNow);
    expect(analysis.currentFoodOffers).toHaveLength(1);
    expect(analysis.currentFoodOffers[0].name).toBe(
      'K-WERTSCHÄTZE Hüftsteak Schweinehüftsteak mariniert',
    );
    expect(analysis.currentFoodOffers[0].name).not.toContain('&#x2028;');
  });

  it('matches the imported offer so the missing estimate stays 0', () => {
    const html = entitySsrHtml();
    const analysis = officialSupermarketTestApi.analyzeKauflandSsr(html, entityNow);
    const imported = officialSupermarketTestApi.parseKauflandOffersFromHtml(html, store);
    expect(imported).toHaveLength(1);
    const completeness = officialSupermarketTestApi.buildKauflandCompleteness(analysis, {
      currentNames: imported.map((offer) => offer.name),
    });
    expect(completeness.missingEstimate).toBe(0);
    expect(completeness.matchedCount).toBe(1);
  });
});

describe('buildKauflandCompleteness — gemischte Promo-Kategorien (Review-Fälle)', () => {
  // Reproduktion des Live-Falls (KW 2026-06): Kaufland listet echtes Non-Food
  // (Tankini, Grill-Holzkohle) in gemischten Promo-Kategorien ("Badespaß für
  // die Kleinen", "Spar€n wie die Weltmeister!"), die der Kategorien-Check
  // weder als Food noch als Non-Food erkennt. Liegt so ein Angebot OHNE Beleg
  // in beide Richtungen im Filtered-Bucket (Rescue-Verdict 'review'), ist das
  // KEIN Food-Verlust-Indiz — es zählt als matchedFilteredUnconfirmed, nicht
  // als Verdacht. Namen sind reine Reproduktions-Fixtures.
  function promoSsrHtml(): string {
    const ssr = {
      offerData: {
        cycles: [
          {
            categories: [
              {
                displayName: 'Badespaß für die Kleinen',
                offers: [
                  {
                    offerId: 'p1',
                    dateFrom: '2026-06-01',
                    dateTo: '2026-06-06',
                    title: 'Kinder-Tankini »Stitch«',
                    price: 4.99,
                  },
                ],
              },
              {
                displayName: 'Molkereiprodukte',
                offers: [
                  {
                    offerId: 'f1',
                    dateFrom: '2026-06-01',
                    dateTo: '2026-06-06',
                    title: 'EHRMANN',
                    subtitle: 'Almighurt',
                    price: 0.29,
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    return `<script>window.SSR = window.SSR || {}; window.SSR['x'] = ${JSON.stringify(ssr)}</script>`;
  }

  it('markiert Food-Kategorien als foodCategoryConfirmed, Promo-Kategorien nicht', () => {
    const analysis = officialSupermarketTestApi.analyzeKauflandSsr(promoSsrHtml(), now);
    const byName = new Map(analysis.currentFoodOffers.map((o) => [o.name, o]));
    expect(byName.get('EHRMANN Almighurt')?.foodCategoryConfirmed).toBe(true);
    expect(byName.get('Kinder-Tankini »Stitch«')?.foodCategoryConfirmed).toBe(false);
  });

  it('zaehlt Review-Faelle aus Promo-Kategorien als matchedFilteredUnconfirmed, nicht als Verdacht', () => {
    const analysis = officialSupermarketTestApi.analyzeKauflandSsr(promoSsrHtml(), now);
    const completeness = officialSupermarketTestApi.buildKauflandCompleteness(analysis, {
      currentNames: ['EHRMANN Almighurt'],
      filteredUnconfirmedNames: ['Kinder-Tankini »Stitch«'],
    });
    expect(completeness.matchedCount).toBe(1);
    expect(completeness.matchedFilteredCount).toBe(0);
    expect(completeness.matchedFilteredUnconfirmedCount).toBe(1);
    expect(completeness.missingEstimate).toBe(0);
    expect(
      completeness.matchedCount +
        completeness.matchedFilteredCount +
        completeness.matchedFilteredNonFoodCount +
        completeness.matchedFilteredUnconfirmedCount +
        completeness.missingEstimate,
    ).toBe(completeness.officialDistinctFoodCount);
  });

  it('Review-Fall aus ECHTER Food-Kategorie bleibt Food-Verdacht (keine Schönung)', () => {
    const analysis = officialSupermarketTestApi.analyzeKauflandSsr(promoSsrHtml(), now);
    const completeness = officialSupermarketTestApi.buildKauflandCompleteness(analysis, {
      currentNames: [],
      filteredUnconfirmedNames: ['EHRMANN Almighurt', 'Kinder-Tankini »Stitch«'],
    });
    // Almighurt kommt aus "Molkereiprodukte" (food-bestätigt) → bleibt Verdacht.
    expect(completeness.matchedFilteredCount).toBe(1);
    expect(completeness.matchedFilteredUnconfirmedCount).toBe(1);
    expect(completeness.missingEstimate).toBe(0);
  });

  it('explizit als Verdacht übergebene Filtered-Namen bleiben Verdacht (auch aus Promo-Kategorie)', () => {
    const analysis = officialSupermarketTestApi.analyzeKauflandSsr(promoSsrHtml(), now);
    const completeness = officialSupermarketTestApi.buildKauflandCompleteness(analysis, {
      currentNames: ['EHRMANN Almighurt'],
      filteredNames: ['Kinder-Tankini »Stitch«'],
    });
    expect(completeness.matchedFilteredCount).toBe(1);
    expect(completeness.matchedFilteredUnconfirmedCount).toBe(0);
  });

  it('dedupliziert über Kategorieblöcke mit Food-Kategorie-Vorrang (OR)', () => {
    // Dasselbe Produkt in Promo- UND Food-Kategorie → foodCategoryConfirmed=true.
    const ssr = {
      offerData: {
        cycles: [
          {
            categories: [
              {
                displayName: 'Spar€n wie die Weltmeister!',
                offers: [
                  {
                    offerId: 'd1',
                    dateFrom: '2026-06-01',
                    dateTo: '2026-06-06',
                    title: 'K-CLASSIC Eis Vanille',
                    price: 1.99,
                  },
                ],
              },
              {
                displayName: 'Tiefkühl',
                offers: [
                  {
                    offerId: 'd2',
                    dateFrom: '2026-06-01',
                    dateTo: '2026-06-06',
                    title: 'K-CLASSIC Eis Vanille',
                    price: 1.99,
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const html = `<script>window.SSR = window.SSR || {}; window.SSR['x'] = ${JSON.stringify(ssr)}</script>`;
    const analysis = officialSupermarketTestApi.analyzeKauflandSsr(html, now);
    expect(analysis.currentFoodOffers).toHaveLength(1);
    expect(analysis.currentFoodOffers[0].foodCategoryConfirmed).toBe(true);
  });
});

describe('buildKauflandCompleteness — gemischte Food+Non-Food-Abteilung (Obst, Gemüse, Pflanzen)', () => {
  // Reproduktion des Live-Falls (KW 2026-06): Kaufland listet Zierpflanzen
  // (Edelweiss, Enzian, Kalanchoe, Chrysantheme) gemeinsam mit echtem Obst/
  // Gemüse in der EINEN Abteilung "Obst, Gemüse, Pflanzen". Der Kategorie-Check
  // bestätigte sie wegen "obst" als KLAR Lebensmittel — dadurch zählte eine
  // korrekt gefilterte, aber unsichere Zierpflanze (Rescue-Verdict 'review')
  // fälschlich als matchedFiltered ("falsch als Non-Food einsortiertes Food")
  // und ließ StoreImportHealth auf 'warning' eskalieren, obwohl nichts fehlt.
  // Namen sind reine Reproduktions-Fixtures.
  function mixedDepartmentSsrHtml(): string {
    const ssr = {
      offerData: {
        cycles: [
          {
            categories: [
              {
                displayName: 'Obst, Gemüse, Pflanzen',
                offers: [
                  {
                    offerId: 'plant',
                    dateFrom: '2026-06-01',
                    dateTo: '2026-06-06',
                    title: 'Kalanchoe im Übertopf',
                    price: 3.49,
                  },
                  {
                    offerId: 'veg',
                    dateFrom: '2026-06-01',
                    dateTo: '2026-06-06',
                    title: 'Lauchzwiebeln',
                    price: 0.79,
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    return `<script>window.SSR = window.SSR || {}; window.SSR['x'] = ${JSON.stringify(ssr)}</script>`;
  }

  it('markiert die Mischabteilung NICHT als foodCategoryConfirmed', () => {
    const analysis = officialSupermarketTestApi.analyzeKauflandSsr(mixedDepartmentSsrHtml(), now);
    const byName = new Map(analysis.currentFoodOffers.map((o) => [o.name, o]));
    // Beide bleiben offizielles Food (officialFoodish), aber die Abteilung ist
    // gemischt → nicht KLAR bestätigt.
    expect(byName.get('Kalanchoe im Übertopf')?.foodCategoryConfirmed).toBe(false);
    expect(byName.get('Lauchzwiebeln')?.foodCategoryConfirmed).toBe(false);
  });

  it('zählt eine unsichere, gefilterte Zierpflanze aus der Mischabteilung NICHT als matchedFiltered', () => {
    const analysis = officialSupermarketTestApi.analyzeKauflandSsr(mixedDepartmentSsrHtml(), now);
    const completeness = officialSupermarketTestApi.buildKauflandCompleteness(analysis, {
      currentNames: ['Lauchzwiebeln'],
      // Kalanchoe liegt ohne Beleg in beide Richtungen im Filter (Verdict 'review').
      filteredUnconfirmedNames: ['Kalanchoe im Übertopf'],
    });
    expect(completeness.matchedFilteredCount).toBe(0); // KEINE Food-in-Filter-Warnung
    expect(completeness.matchedFilteredUnconfirmedCount).toBe(1); // transparent erklärt
    expect(completeness.missingEstimate).toBe(0);
    expect(
      completeness.matchedCount +
        completeness.matchedFilteredCount +
        completeness.matchedFilteredNonFoodCount +
        completeness.matchedFilteredUnconfirmedCount +
        completeness.missingEstimate,
    ).toBe(completeness.officialDistinctFoodCount);
  });

  it('echtes Food mit hartem Beleg aus der Mischabteilung bleibt Verdacht (keine Schönung)', () => {
    const analysis = officialSupermarketTestApi.analyzeKauflandSsr(mixedDepartmentSsrHtml(), now);
    const completeness = officialSupermarketTestApi.buildKauflandCompleteness(analysis, {
      currentNames: [],
      // Lauchzwiebeln als 'rescue'-Verdacht übergeben (starkes Food-Signal) →
      // bleibt matchedFiltered, kategorie-unabhängig.
      filteredNames: ['Lauchzwiebeln'],
      filteredUnconfirmedNames: ['Kalanchoe im Übertopf'],
    });
    expect(completeness.matchedFilteredCount).toBe(1); // Lauchzwiebeln-Verdacht bleibt
    expect(completeness.matchedFilteredUnconfirmedCount).toBe(1); // Kalanchoe erklärt
  });
});

describe('isKauflandFoodCategory', () => {
  it('bestätigt klare Food-Kategorien', () => {
    for (const name of ['Molkereiprodukte', 'Obst & Gemüse', 'Fleisch & Wurst', 'Tiefkühl', 'Getränke']) {
      expect(officialSupermarketTestApi.isKauflandFoodCategory(name)).toBe(true);
    }
  });

  it('bestätigt gemischte Promo-/Aktionskategorien NICHT', () => {
    for (const name of [
      'Spar€n wie die Weltmeister!',
      'Badespaß für die Kleinen',
      'Mega Insektenschutz',
      'Jetzt sparen mit Kaufland Card XTRA',
      'Angebote zum Wochenstart',
    ]) {
      expect(officialSupermarketTestApi.isKauflandFoodCategory(name)).toBe(false);
    }
  });

  it('bestätigt eine gemischte Food+Non-Food-Abteilung NICHT (Obst, Gemüse, Pflanzen)', () => {
    // Food-Stichwort "obst" + Non-Food-Stichwort "pflanze" → gemischt, nicht KLAR.
    for (const name of ['Obst, Gemüse, Pflanzen', 'Obst & Gemüse / Blumen', 'Gemüse & Gartenpflanzen']) {
      expect(officialSupermarketTestApi.isKauflandFoodCategory(name)).toBe(false);
    }
    // Reines Obst/Gemüse ohne Non-Food-Stichwort bleibt bestätigt.
    expect(officialSupermarketTestApi.isKauflandFoodCategory('Obst, Gemüse')).toBe(true);
  });

  it('hält die Mischabteilung trotzdem aus dem Non-Food-Tagging heraus (Food-Vorrang)', () => {
    // Sicherheitsnetz: echtes Obst/Gemüse aus der Mischabteilung darf NIE als
    // Non-Food getaggt/weggefiltert werden — der Non-Food-Check gibt dem
    // Food-Stichwort weiter Vorrang.
    expect(officialSupermarketTestApi.isKauflandNonFoodCategory('Obst, Gemüse, Pflanzen')).toBe(false);
  });
});

describe('isKauflandNonFoodCategory', () => {
  it('flags obvious non-food category names', () => {
    for (const name of [
      'Drogerie',
      'Bekleidung',
      'Haushalt',
      'Küchen-Highlights',
      'Technik',
      'Spielwaren',
      'Pflanzen & Blumen',
      'NIKE',
    ]) {
      expect(officialSupermarketTestApi.isKauflandNonFoodCategory(name)).toBe(true);
    }
  });

  it('does not flag food category names', () => {
    for (const name of [
      'Molkereiprodukte',
      'Obst & Gemüse',
      'Fleisch & Wurst',
      'Tiefkühl',
      'Getränke',
      'Backwaren',
    ]) {
      expect(officialSupermarketTestApi.isKauflandNonFoodCategory(name)).toBe(false);
    }
  });
});
