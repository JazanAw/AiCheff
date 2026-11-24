import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLidlLeafletOffers, officialSupermarketTestApi } from './officialSupermarketConnector';
import type { SubSourceDiagnostic } from '../subSourceDiagnostics';
import {
  fakeHtmlBytes,
  fakeJpegBytes,
  fakePngBytes,
  LIDL_FLYER_PAGES_FIXTURE,
} from './lidlProspect.fixture';

describe('OfficialSupermarketSourceConnector parser', () => {
  it('extrahiert Lidl-Grid-Daten von der Startseite', () => {
    const gridData = JSON.stringify({
      fullTitle: 'Bauerngurken 750 g',
      price: {
        price: 2.22,
        recommendedPrice: 2.99,
        endDate: '2026-05-09T22:00',
      },
      store: true,
      image: 'https://www.lidl.de/assets/gurken.jpg',
      canonicalUrl: '/p/bauerngurken/p1001',
      brand: { name: 'Lidl' },
      category: 'Kategorien/Essen & Trinken/Obst & Gemuese',
    }).replace(/"/g, '&quot;');
    const html = `<div data-grid-data="${gridData}"></div>`;

    const offers = officialSupermarketTestApi.parseLidlProductGridData(html, {
      storeChain: 'Lidl',
      url: 'https://www.lidl.de/',
      parser: 'lidl',
    });

    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      name: 'Bauerngurken 750 g',
      brand: 'Lidl',
      storeChain: 'Lidl',
      price: 2.22,
      unit: '750g',
      sourceUrl: 'https://www.lidl.de/p/bauerngurken/p1001',
      tags: ['filiale', 'reduziert'],
    });
  });

  it('liest Lebensmittel-Angebote aus Lidl-Bild-Alternativtexten', () => {
    const html = `
      <img
        src="/assets/eistee.jpg"
        alt="Tiefpreis-Garantie – PFANNER Eistee, verschiedene Sorten, je 2 l -49% für 1.11 €* (1 l = -.56 €)"
      >
      <img
        src="/assets/kaffee.jpg"
        alt="Bellarom Caff\u00e8 Crema Gustoso. Ganze Bohnen. Je 1 kg. 50 Cent g\u00fcnstiger f\u00fcr 10.49*."
      >
      <img
        src="/assets/gurken.jpg"
        alt="Deutschlands günstigster Preis – Bauerngurken, Ursprung: Deutschland/Spanien, Klasse I, je 750 g -25% für nur 2.22 €* (1 kg = 2.96 €)"
      >
      <img
        src="/assets/sessel.jpg"
        alt="Überzeugender Sitzkomfort: LIVARNO Aluminium-Relaxsessel, je Stück für 44.99 €*."
      >
    `;

    const offers = officialSupermarketTestApi.parseOfficialOffersFromHtml(html, {
      storeChain: 'Lidl',
      url: 'https://www.lidl.de/',
      parser: 'lidl',
    });

    expect(offers).toHaveLength(3);
    expect(offers[0]).toMatchObject({
      name: 'PFANNER Eistee',
      storeChain: 'Lidl',
      price: 1.11,
      unit: '2 l',
      basePrice: 0.56,
      baseUnit: '1 l',
      sourceUrl: 'https://www.lidl.de/',
      tags: ['lidl-teaser', 'reduziert'],
    });
    expect(offers[1]).toMatchObject({
      name: 'Bellarom Caff\u00e8 Crema Gustoso. Ganze Bohnen',
      price: 10.49,
      unit: '1 kg',
    });
    expect(offers[2]).toMatchObject({
      name: 'Bauerngurken',
      price: 2.22,
      unit: '750 g',
    });
  });

  it('liest strukturierte Lidl-Prospektprodukte aus dem offiziellen Leaflet-JSON', () => {
    const offers = officialSupermarketTestApi.parseLidlLeafletProducts(
      {
        flyer: {
          offerStartDate: '2026-05-11',
          offerEndDate: '2026-05-16',
          products: {
            '1': {
              productId: '1',
              title: 'Asbach URALT Weinbrand 36% Vol',
              brand: 'Asbach',
              price: '13.99',
              image: 'https://www.lidl.de/assets/asbach.jpg',
              canonicalUrl: '/p/asbach/p1',
              wonCategoryPrimary: 'Bedürfniswelten/Wein & Spirituosen/Spirituosen',
            },
            '2': {
              productId: '2',
              title: 'SILVERCREST Wasserkocher',
              price: '19.99',
              image: 'https://www.lidl.de/assets/wasserkocher.jpg',
              canonicalUrl: '/p/wasserkocher/p2',
              wonCategoryPrimary: 'Bedürfniswelten/Küche & Haushalt/Küchengeräte',
            },
          },
        },
      },
      {
        storeChain: 'Lidl',
        url: 'https://www.lidl.de/',
        parser: 'lidl',
      },
    );

    // ALLE Prospektprodukte MIT Bild werden importiert; Food/Non-Food trennt der
    // Kategoriepfad: Spirituosen bleiben Food, das SILVERCREST-Küchengerät
    // bekommt das harte "nonfood"-Tag (→ strict filter → filtered bucket).
    expect(offers).toHaveLength(2);
    expect(offers[0]).toMatchObject({
      name: 'Asbach URALT Weinbrand 36% Vol',
      storeChain: 'Lidl',
      price: 13.99,
      sourceUrl: 'https://www.lidl.de/p/asbach/p1',
      validityStart: '2026-05-11T00:00:00.000Z',
      validityEnd: '2026-05-16T23:59:59.999Z',
    });
    expect(offers[0].tags).not.toContain('nonfood');
    expect(offers[1]).toMatchObject({ name: 'SILVERCREST Wasserkocher', price: 19.99 });
    expect(offers[1].tags).toContain('nonfood');
  });

  it('ueberspringt strukturierte Lidl-Produkte OHNE Bild (nie ohne Belegbild live)', () => {
    // Hartes Auto-Live-Kriterium: fehlt das Produktfoto, entsteht KEIN
    // Live-Kandidat — das Produkt bleibt dem Review-Import (Hotspots/
    // PDF-Textebene mit Seitenbild) überlassen. Gemessen via diagnosticsSink.
    const sink = { skippedNoImage: 0 };
    const offers = officialSupermarketTestApi.parseLidlLeafletProducts(
      {
        flyer: {
          offerStartDate: '2026-05-11',
          offerEndDate: '2026-05-16',
          products: {
            '1': {
              productId: '1',
              title: 'Bio Joghurt 500 g',
              price: '0.99',
              canonicalUrl: '/p/joghurt/p1',
            },
            '2': {
              productId: '2',
              title: 'Butter 250 g',
              price: '1.79',
              image: 'https://www.lidl.de/assets/butter.jpg',
              canonicalUrl: '/p/butter/p2',
            },
          },
        },
      },
      { storeChain: 'Lidl', url: 'https://www.lidl.de/', parser: 'lidl' },
      sink,
    );
    expect(offers).toHaveLength(1);
    expect(offers[0].name).toBe('Butter 250 g');
    expect(sink.skippedNoImage).toBe(1);
  });

  it('haelt dasselbe Lidl-Produkt aus zwei Prospektwochen als getrennte Angebote', () => {
    const product = {
      productId: '1',
      title: 'Asbach URALT Weinbrand 36% Vol',
      price: '13.99',
      image: 'https://www.lidl.de/assets/asbach.jpg',
      canonicalUrl: '/p/asbach/p1',
      wonCategoryPrimary: 'Bedürfniswelten/Wein & Spirituosen/Spirituosen',
    };
    const store = { storeChain: 'Lidl', url: 'https://www.lidl.de/', parser: 'lidl' as const };
    const week1 = officialSupermarketTestApi.parseLidlLeafletProducts(
      { flyer: { offerStartDate: '2026-06-08', offerEndDate: '2026-06-13', products: { '1': product } } },
      store,
    );
    const week2 = officialSupermarketTestApi.parseLidlLeafletProducts(
      { flyer: { offerStartDate: '2026-06-15', offerEndDate: '2026-06-20', products: { '1': product } } },
      store,
    );
    expect(week1[0].id).not.toBe(week2[0].id);
  });

  it('wertet einen Prospekt mit 0 Produkten als Failure, nie als stillen Erfolg', () => {
    // Der historische latest-leaflet-Fall: Endpoint antwortet, aber ohne
    // Produkte. Der Parser liefert [] und der Connector erzeugt die explizite
    // Failure-Warnung (kein leeres Weiter-so).
    const store = { storeChain: 'Lidl', url: 'https://www.lidl.de/', parser: 'lidl' as const };
    expect(
      officialSupermarketTestApi.parseLidlLeafletProducts({ flyer: { products: {} } }, store),
    ).toEqual([]);
    expect(
      officialSupermarketTestApi.parseLidlLeafletProducts({ flyer: {} }, store),
    ).toEqual([]);
    const warning = officialSupermarketTestApi.lidlLeafletEmptyWarning(
      'Lidl',
      'latest-leaflet-f5771509-f19a-11e9-b196-005056ab0fb6',
    );
    expect(warning).toMatch(/0 Produkte/);
    expect(warning).toContain('latest-leaflet-f5771509');
  });

  it('bevorzugt konkrete Lidl-Aktionsprospekte vor latest-leaflet Teasern', () => {
    const html = `
      <a href="/l/prospekte/latest-leaflet-f5771509-f19a-11e9-b196-005056ab0fb6/view/flyer/page/6">App-Punkte</a>
      <a href="/l/prospekte/aktionsprospekt-08-06-2026-13-06-2026-d22b0e/ar/0?_ab=1&lf=HHZ">Aktionsprospekt</a>
      <a href="/l/prospekte/aktionsprospekt-15-06-2026-20-06-2026-6068ab/ar/0?_ab=1&lf=HHZ">Naechste Woche</a>
    `;

    expect(officialSupermarketTestApi.extractLidlLeafletIdentifier(html)).toBe(
      'aktionsprospekt-08-06-2026-13-06-2026-d22b0e',
    );
  });

  it('liefert ALLE Aktionsprospekt-Identifier nach Startdatum sortiert (aktuelle Woche zuerst)', () => {
    const html = `
      <a href="/l/prospekte/aktionsprospekt-15-06-2026-20-06-2026-6068ab/ar/0?_ab=1&lf=HHZ">Naechste Woche</a>
      <a href="/l/prospekte/latest-leaflet-f5771509-f19a-11e9-b196-005056ab0fb6/view/flyer/page/6">App-Punkte</a>
      <a href="/l/prospekte/aktionsprospekt-08-06-2026-13-06-2026-d22b0e/ar/0?_ab=1&lf=HHZ">Aktionsprospekt</a>
    `;

    expect(officialSupermarketTestApi.extractLidlLeafletIdentifiers(html)).toEqual([
      'aktionsprospekt-08-06-2026-13-06-2026-d22b0e',
      'aktionsprospekt-15-06-2026-20-06-2026-6068ab',
    ]);
  });

  // Slug-Schema-Wechsel bei Lidl: Die Prospektseite trägt Links, aber KEINEN
  // datierten Aktionsprospekt mehr. Vorher griff dann ein Fallback auf den
  // ersten beliebigen Nicht-latest-leaflet-Link — der Wochenscan hätte damit
  // ein Rezeptemagazin oder den Dauer-Preisführer als Wochenangebote gelesen.
  // Jetzt: permanenter latest-leaflet-Identifier, der den laufenden Prospekt
  // auflöst (2026-08-17 verifiziert: 72 Seiten / 180 Produkte).
  it('faellt ohne datierten Aktionsprospekt auf den permanenten Identifier zurueck', () => {
    const html = `
      <a href="/l/prospekte/paw-patrol-rezeptemagazin-starte-deine-kochmission/ar/0">Rezeptemagazin</a>
      <a href="/l/prospekte/der-preisfuehrer-macht-deutschland-dauerhaft-guenstiger/ar/0">Preisfuehrer</a>
    `;

    expect(officialSupermarketTestApi.extractLidlLeafletIdentifiers(html)).toEqual([
      'latest-leaflet-f5771509-f19a-11e9-b196-005056ab0fb6',
    ]);
  });

  // Gegenprobe: Ein leeres/unlesbares Dokument darf NIE einen Netzwerk-Abruf
  // ausloesen, sondern muss als Quellfehler sichtbar werden.
  it('liefert ohne jeden Prospekt-Link eine leere Liste (kein Fallback-Abruf)', () => {
    expect(
      officialSupermarketTestApi.extractLidlLeafletIdentifiers(
        '<html><body>keine Prospekt-Links hier</body></html>',
      ),
    ).toEqual([]);
  });

  // Der permanente Identifier ist die Quelle, die auch die Lidl-Viewer-App
  // abruft (im Browser mitgeschnitten: seine EINZIGE Datenanfrage). Er ist
  // deshalb gesetzt und nicht mehr nur Notnagel — die datierten Slugs haengen
  // an Lidls HTML-Markup und duerfen den Wochenscan nicht allein tragen.
  const PERMANENT = 'latest-leaflet-f5771509-f19a-11e9-b196-005056ab0fb6';

  it('stellt den permanenten Identifier immer voran', () => {
    expect(
      officialSupermarketTestApi.resolveLidlLeafletIdentifiers([
        'aktionsprospekt-24-08-2026-29-08-2026-bf1570',
        'aktionsprospekt-31-08-2026-05-09-2026-aeefec',
      ]),
    ).toEqual([
      PERMANENT,
      'aktionsprospekt-24-08-2026-29-08-2026-bf1570',
      'aktionsprospekt-31-08-2026-05-09-2026-aeefec',
    ]);
  });

  it('traegt die laufende Woche auch bei voellig leerer Discovery', () => {
    expect(officialSupermarketTestApi.resolveLidlLeafletIdentifiers([])).toEqual([PERMANENT]);
  });

  it('nimmt den permanenten Identifier nicht doppelt auf', () => {
    expect(
      officialSupermarketTestApi.resolveLidlLeafletIdentifiers([
        PERMANENT,
        'aktionsprospekt-31-08-2026-05-09-2026-aeefec',
      ]),
    ).toEqual([PERMANENT, 'aktionsprospekt-31-08-2026-05-09-2026-aeefec']);
  });

  // Das Limit waechst um genau eins, damit der garantierte Eintrag die
  // Folgewoche nicht aus der Liste draengt.
  it('verdraengt die Folgewoche nicht aus der Liste', () => {
    const aufgeloest = officialSupermarketTestApi.resolveLidlLeafletIdentifiers([
      'aktionsprospekt-24-08-2026-29-08-2026-bf1570',
      'aktionsprospekt-31-08-2026-05-09-2026-aeefec',
      'aktionsprospekt-07-09-2026-12-09-2026-058d37',
    ]);
    expect(aufgeloest).toContain('aktionsprospekt-31-08-2026-05-09-2026-aeefec');
    expect(aufgeloest).toHaveLength(3);
  });

  // Permanenter und datierter Identifier loesen in der laufenden Woche auf
  // DENSELBEN Flyer auf (verifiziert: identische flyer.id, 71 Seiten,
  // 175 Produkte). Die Identitaet verhindert den doppelten Durchlauf.
  it('liest die Flyer-Identitaet aus dem v4-JSON', () => {
    expect(
      officialSupermarketTestApi.readLidlFlyerId({
        flyer: { id: '01a03e75-939b-789e-a65f-225052c6ad7b', pages: [] },
      }),
    ).toBe('01a03e75-939b-789e-a65f-225052c6ad7b');
  });

  it('liefert ohne verwertbare Flyer-Identitaet null (kein Rateversuch)', () => {
    expect(officialSupermarketTestApi.readLidlFlyerId(null)).toBeNull();
    expect(officialSupermarketTestApi.readLidlFlyerId({})).toBeNull();
    expect(officialSupermarketTestApi.readLidlFlyerId({ flyer: {} })).toBeNull();
    expect(officialSupermarketTestApi.readLidlFlyerId({ flyer: { id: '  ' } })).toBeNull();
  });

  it('bilanziert die Viewer-Hotspots ehrlich (priced importierbar, preislos pending, nie geraten)', () => {
    // Realistische v4/flyer-Struktur: 2 Produkt-Hotspots (einer mit priced
    // products-Map-Eintrag, einer ohne), 1 Rezept-Link (Frische ohne Preis),
    // 1 standard-Link (App-Fläche), 1 reiner Seiten-Navigationslink.
    const parsed = {
      flyer: {
        pages: [
          {
            number: 1,
            links: [
              { id: 'l1', displayType: 'product' },
              { id: 'l2', displayType: 'product' },
              { id: 'l3', displayType: 'recipe' },
              { id: 'l4', displayType: 'standard' },
              { id: 'l5', type: 'page' },
            ],
          },
          { number: 2, links: [] },
        ],
        products: {
          l1: { productId: '100', title: 'Rotwein Cuvée', price: '4.99' },
          // Eintrag OHNE plausiblen Preis zählt NICHT als strukturiert bepreist.
          l2: { productId: '101', title: 'Grillzange', price: '0' },
        },
      },
    };
    const summary = officialSupermarketTestApi.summarizeLidlViewerHotspots(parsed);
    expect(summary).toEqual({
      pageCount: 2,
      linksFound: 5,
      productHotspots: 2,
      structuredPricedCandidates: 1,
      pricelessProductHotspots: 1,
      recipeLinks: 1,
      standardLinks: 1,
    });

    // Die Diagnose-Zeile ist reine Bilanz (status empty, 0 Angebote) und nennt
    // die pending-Mengen — sie blockiert nie und schaltet nie etwas live.
    const diagnostic = officialSupermarketTestApi.buildLidlViewerHotspotDiagnostic({
      store: { storeChain: 'Lidl', url: 'https://www.lidl.de/', parser: 'lidl' },
      identifier: 'aktionsprospekt-29-06-2026-04-07-2026-1c4951',
      sourceId: 'lidl:aktionsprospekt-29-06-2026-04-07-2026-1c4951',
      summary,
    });
    expect(diagnostic).toMatchObject({
      storeChain: 'Lidl',
      sourceId: 'lidl:aktionsprospekt-29-06-2026-04-07-2026-1c4951:viewer_hotspots',
      status: 'empty',
      rawCount: 5,
      resultCount: 0,
    });
    expect(diagnostic?.note).toMatch(/2 Seiten/);
    expect(diagnostic?.note).toMatch(/1 mit strukturiertem Preis/);
    expect(diagnostic?.note).toMatch(/pending/);
    expect(diagnostic?.note).toMatch(/nie geraten/);

    // Ohne Links keine Bilanzzeile (kein leeres Rauschen im Report).
    expect(
      officialSupermarketTestApi.buildLidlViewerHotspotDiagnostic({
        store: { storeChain: 'Lidl', url: 'https://www.lidl.de/', parser: 'lidl' },
        identifier: 'leer',
        sourceId: 'lidl:leer',
        summary: officialSupermarketTestApi.summarizeLidlViewerHotspots({ flyer: { pages: [] } }),
      }),
    ).toBeNull();
  });

  it('preislose Viewer-Hotspots erzeugen NIE ein Angebot (Preise werden nicht geraten)', () => {
    // Dieselbe Flyer-Struktur durch den ECHTEN Produkt-Parser: nur der priced
    // products-Map-Eintrag wird ein Kandidat; Hotspots ohne Preis (Frische/
    // Rezept) tauchen ausschliesslich in der Bilanz auf, nie als Angebot.
    const store = { storeChain: 'Lidl', url: 'https://www.lidl.de/', parser: 'lidl' as const };
    const offers = officialSupermarketTestApi.parseLidlLeafletProducts(
      {
        flyer: {
          offerStartDate: '2026-06-29',
          offerEndDate: '2026-07-04',
          pages: [{ number: 1, links: [{ id: 'l1', displayType: 'product' }, { id: 'l9', displayType: 'recipe' }] }],
          products: {
            l1: { productId: '100', title: 'Rotwein Cuvée', price: '4.99', image: 'https://www.lidl.de/assets/rotwein.jpg', wonCategoryPrimary: 'Bedürfniswelten/Wein, Bier und Spirituosen/Wein' },
            l2: { productId: '101', title: 'Frische Erdbeeren 500 g', image: 'https://www.lidl.de/assets/erdbeeren.jpg' /* kein Preis */ },
          },
        },
      },
      store,
    );
    expect(offers).toHaveLength(1);
    expect(offers[0].name).toBe('Rotwein Cuvée');
    expect(offers[0].price).toBe(4.99);
  });

  it('klassifiziert Lidl-Prospekt-Kategoriepfade in Food/Non-Food', () => {
    const { isLidlLeafletNonFoodCategory } = officialSupermarketTestApi;
    expect(isLidlLeafletNonFoodCategory('Bedürfniswelten/Sport & Freizeit/Wassersport')).toBe(true);
    expect(isLidlLeafletNonFoodCategory('Bedürfniswelten/Baumarkt & Garten/Akkuwerkzeuge')).toBe(true);
    expect(isLidlLeafletNonFoodCategory('Bedürfniswelten/Mode & Accessoires/Damenmode')).toBe(true);
    expect(isLidlLeafletNonFoodCategory('Bedürfniswelten/Wein & Spirituosen/Wein/Rotwein')).toBe(false);
    expect(isLidlLeafletNonFoodCategory('Kategorien/Weinwelt/Weinart/Rotwein')).toBe(false);
    // Unbekannte Pfade bleiben "unsicher" (sichtbar, Phase 2 entscheidet).
    expect(isLidlLeafletNonFoodCategory('Bedürfniswelten/Neuheiten')).toBe(false);
  });

  it('zählt Lidl-Prospekt-Bildseiten als strukturellen OCR-Beleg (flyer.pages)', () => {
    const { detectLidlProspectPages } = officialSupermarketTestApi;
    // Reproduktions-Fixture der Schwarz-Leaflet-v4-Form: flyer.pages tragen
    // gescannte Prospekt-Bildseiten (Frische-/Lebensmittelseiten) — strukturell
    // OHNE Produktdaten. Genau diese Seiten sind die OCR-Kandidaten.
    const flyer = {
      flyer: {
        products: {},
        pages: [
          { pageNumber: 1, imageList: ['https://leaflet.cdn.schwarz/p1-lg.jpg'] },
          {
            pageNumber: 2,
            renditions: {
              thumb: 'https://leaflet.cdn.schwarz/p2-thumb.webp',
              full: 'https://leaflet.cdn.schwarz/p2-lg.jpg',
            },
          },
        ],
      },
    };
    const evidence = detectLidlProspectPages(flyer);
    expect(evidence.pageCount).toBe(2);
    expect(evidence.imageCount).toBe(3);
    expect(evidence.imageExamples.length).toBeGreaterThan(0);
    expect(evidence.imageExamples.every((url) => url.startsWith('https://'))).toBe(true);
  });

  it('meldet keine Prospektseiten, wenn das Flyer-JSON keine Bildseiten trägt', () => {
    const { detectLidlProspectPages } = officialSupermarketTestApi;
    expect(detectLidlProspectPages({ flyer: { products: {} } })).toMatchObject({
      pageCount: 0,
      imageCount: 0,
    });
    // Produktbilder (unter flyer.products) sind KEINE Prospekt-Bildseiten und
    // dürfen den Seiten-/Asset-Beleg nicht aufblähen.
    expect(
      detectLidlProspectPages({
        flyer: { products: { '1': { image: 'https://www.lidl.de/assets/wein.jpg' } } },
      }),
    ).toMatchObject({ pageCount: 0, imageCount: 0 });
    expect(detectLidlProspectPages(null)).toMatchObject({ pageCount: 0, imageCount: 0 });
  });

  it('detectLidlProspectPages liefert begrenzte imageUrls für den OCR-Pfad', () => {
    const { detectLidlProspectPages } = officialSupermarketTestApi;
    const flyer = {
      flyer: {
        products: {},
        pages: [{ imageList: ['https://leaflet.cdn.schwarz/p1-lg.jpg'] }],
      },
    };
    const evidence = detectLidlProspectPages(flyer);
    expect(evidence.imageUrls).toEqual(['https://leaflet.cdn.schwarz/p1-lg.jpg']);
  });

  it('detectLidlProspectPages extrahiert shape-tolerant verschachtelte/endungslose Bild-URLs', () => {
    const { detectLidlProspectPages } = officialSupermarketTestApi;
    // Reproduktions-Fixture der unterschiedlichen Leaflet-Layouts: Renditions
    // liegen verschachtelt unter media/src bzw. image/variants, teils OHNE
    // Datei-Endung (CDN-Render-Endpoint). Generisch, kein Produkt-/KW-Wissen.
    const flyer = {
      flyer: {
        // Produktbilder unter products sind KEINE Prospekt-Bildseiten.
        products: { '1': { image: 'https://www.lidl.de/assets/wein.jpg' } },
        pages: [
          {
            pageNumber: 1,
            media: [
              { src: 'https://leaflet-cdn.schwarz/render/p1?w=1080', width: 1080 },
              { src: 'https://leaflet-cdn.schwarz/render/p1?w=540', width: 540 },
            ],
          },
          {
            pageNumber: 2,
            image: {
              variants: [
                'https://leaflet-cdn.schwarz/render/p2-hi', // endungslos, unter Bildfeld
                'https://leaflet-cdn.schwarz/p2-lg.webp', // klassisch mit Endung
              ],
              // Nicht-Bild-Link unter einem Bildfeld → muss verworfen werden.
              trackingUrl: 'https://track.schwarz/api/hit.json',
            },
          },
        ],
      },
    };
    const evidence = detectLidlProspectPages(flyer);
    expect(evidence.pageCount).toBe(2);
    // 2 media-Renditions + 2 Varianten = 4 echte Bild-URLs; das .json-Tracking und
    // das Produktbild zählen NICHT.
    expect(evidence.imageCount).toBe(4);
    expect(evidence.imageUrls).toContain('https://leaflet-cdn.schwarz/render/p1?w=1080');
    expect(evidence.imageUrls).toContain('https://leaflet-cdn.schwarz/render/p2-hi');
    expect(evidence.imageUrls).not.toContain('https://track.schwarz/api/hit.json');
    expect(evidence.imageUrls.every((u) => !u.endsWith('.json'))).toBe(true);
  });

  it('detectLidlProspectPages: realistisches flyer.pages-Fixture liefert >0 Bild-URLs, Endungs-URLs zuerst, ohne Navigations-/Tracking-Links', () => {
    const { detectLidlProspectPages } = officialSupermarketTestApi;
    const evidence = detectLidlProspectPages(LIDL_FLYER_PAGES_FIXTURE);
    expect(evidence.pageCount).toBe(2);
    // Reproduktions-Fixture: 2 Render-Endpunkte (endungslos) + 1 jpg + 2 webp = 5
    // echte Bildassets. Das Produktbild, der `links.self`-Navigations-Link und der
    // `.json`-Tracking-Link zählen NICHT.
    expect(evidence.imageCount).toBe(5);
    expect(evidence.imageUrls.length).toBeGreaterThan(0);
    // Navigations-/Tracking-Links sind raus (kein Produktbild, kein self-Link).
    expect(evidence.imageUrls).not.toContain('https://www.lidl.de/c/online-prospekte/s10005610');
    expect(evidence.imageUrls).not.toContain('https://www.lidl.de/assets/wein.jpg');
    expect(evidence.imageUrls.some((u) => u.endsWith('.json'))).toBe(false);
    // Ordering: klar renderbare Endungs-URLs zuerst, damit das OCR-Budget nicht an
    // ambivalente endungslose Render-Endpunkte verschwendet wird.
    const firstExtensionless = evidence.imageUrls.findIndex((u) => /render\/p1\?/.test(u));
    const lastExtension = Math.max(
      evidence.imageUrls.indexOf('https://leaflet-cdn.schwarz/v4/pages/p1-lg.jpg'),
      evidence.imageUrls.indexOf('https://leaflet-cdn.schwarz/v4/pages/p2-lg.webp'),
    );
    expect(lastExtension).toBeGreaterThanOrEqual(0);
    expect(lastExtension).toBeLessThan(firstExtensionless);
  });

  it('runLidlLeafletOcr (live) auf dem realistischen Fixture: dekodiert Bild, gibt sicheren Food-Kandidaten frei', async () => {
    const { runLidlLeafletOcr } = officialSupermarketTestApi;
    const out = await runLidlLeafletOcr({
      parsedFlyer: LIDL_FLYER_PAGES_FIXTURE,
      store: { storeChain: 'Lidl', url: 'https://www.lidl.de/c/online-prospekte/s10005610', parser: 'lidl' },
      sourceId: 'lidl:aktionsprospekt-15-06-2026',
      structuredOffers: [],
      mode: 'live',
      imageLimit: 1,
      ocrImage: async () => ['Rispentomaten', '500 g', '1,49 €'].join('\n'),
      fetchBinary: async () => fakePngBytes(),
    });
    expect(out).not.toBeNull();
    expect(out!.counters.prospectPages).toBe(2);
    expect(out!.counters.imageDecoded).toBe(1);
    expect(out!.emittedOffers).toHaveLength(1);
    expect(out!.emittedOffers[0].name.toLowerCase()).toContain('tomaten');
    // Aus dem Flyer abgeleitete Gültigkeit (nicht geraten).
    expect(out!.emittedOffers[0].validityStart).toBe('2026-06-15T00:00:00.000Z');
  });

  it('runLidlLeafletOcr (live): eine HTML-Antwort wird als notAnImage gezählt, NICHTS geht live', async () => {
    const { runLidlLeafletOcr } = officialSupermarketTestApi;
    const out = await runLidlLeafletOcr({
      parsedFlyer: LIDL_FLYER_PAGES_FIXTURE,
      store: { storeChain: 'Lidl', url: 'https://www.lidl.de', parser: 'lidl' },
      sourceId: 'lidl:aktionsprospekt-15-06-2026',
      structuredOffers: [],
      mode: 'live',
      imageLimit: 1,
      ocrImage: async () => ['Rispentomaten', '1,49 €'].join('\n'),
      fetchBinary: async () => fakeHtmlBytes(),
    });
    expect(out!.failures.notAnImage).toBe(1);
    expect(out!.counters.imageDecoded).toBe(0);
    expect(out!.emittedOffers).toHaveLength(0);
    expect(out!.primaryReason).toMatch(/keine dekodierbaren Bilder/i);
  });

  it('runLidlLeafletOcr (diagnostic) bilanziert OCR ohne Live-Angebote; dedupliziert gegen strukturierte', async () => {
    const { runLidlLeafletOcr } = officialSupermarketTestApi;
    const parsedFlyer = {
      flyer: {
        products: {},
        offerStartDate: '2026-06-15',
        offerEndDate: '2026-06-20',
        pages: [{ imageList: ['https://leaflet.cdn.schwarz/p3-lg.jpg'] }],
      },
    };
    const ocrText = ['Rispentomaten', '1,49 €', 'Bio Bananen', '1,79 €', 'Fahrrad', '79,99 €'].join('\n');
    const out = await runLidlLeafletOcr({
      parsedFlyer,
      store: { storeChain: 'Lidl', url: 'https://www.lidl.de/c/online-prospekte/s10005610', parser: 'lidl' },
      sourceId: 'lidl:aktionsprospekt-15-06-2026',
      // Strukturierter Treffer "Bio Bananen" → der OCR-Treffer muss dedupliziert werden.
      structuredOffers: [{ name: 'Bio Bananen', storeChain: 'Lidl' }],
      mode: 'diagnostic',
      ocrImage: async () => ocrText,
      fetchBinary: async () => fakePngBytes(),
    });
    expect(out).not.toBeNull();
    // Diagnose schaltet NICHTS live.
    expect(out!.emittedOffers).toHaveLength(0);
    expect(out!.diagnostic.sourceId).toBe('lidl:aktionsprospekt-15-06-2026:prospektseiten:ocr');
    // Fahrrad → nonFood (bestehende Keywordliste), Bio Bananen → duplicate.
    expect(out!.result.rejections.nonFood).toBe(1);
    expect(out!.result.rejections.duplicate).toBeGreaterThanOrEqual(1);
    // Übrig bleibt nur die sichere Food-Extraktion (Rispentomaten) — mit Flyer-Gültigkeit.
    expect(out!.result.offers).toHaveLength(1);
    expect(out!.result.offers[0].name.toLowerCase()).toContain('tomaten');
    expect(out!.result.offers[0].validityStart).toBe('2026-06-15T00:00:00.000Z');
  });

  it('runLidlLeafletOcr (live) gibt sichere Kandidaten frei', async () => {
    const { runLidlLeafletOcr } = officialSupermarketTestApi;
    const parsedFlyer = {
      flyer: {
        products: {},
        offerStartDate: '2026-06-15',
        offerEndDate: '2026-06-20',
        pages: [{ imageList: ['https://leaflet.cdn.schwarz/p3-lg.jpg'] }],
      },
    };
    const out = await runLidlLeafletOcr({
      parsedFlyer,
      store: { storeChain: 'Lidl', url: 'https://www.lidl.de/c/online-prospekte/s10005610', parser: 'lidl' },
      sourceId: 'lidl:aktionsprospekt-15-06-2026',
      structuredOffers: [],
      mode: 'live',
      ocrImage: async () => ['Rispentomaten', '1,49 €'].join('\n'),
      fetchBinary: async () => fakeJpegBytes(),
    });
    expect(out!.emittedOffers).toHaveLength(1);
    expect(out!.emittedOffers[0].tags).toContain('lidl-prospekt-ocr');
  });

  it('runLidlLeafletOcr gibt null zurück, wenn der Flyer keine Bildseiten trägt', async () => {
    const { runLidlLeafletOcr } = officialSupermarketTestApi;
    const out = await runLidlLeafletOcr({
      parsedFlyer: { flyer: { products: {} } },
      store: { storeChain: 'Lidl', url: 'https://www.lidl.de', parser: 'lidl' },
      sourceId: 'lidl:x',
      structuredOffers: [],
      mode: 'diagnostic',
      ocrImage: async () => '',
      fetchBinary: async () => new Uint8Array(),
    });
    expect(out).toBeNull();
  });

  it('runLidlLeafletOcr (diagnostic) bilanziert auch, wenn die Prospektseiten keine ladbaren Bild-URLs tragen', async () => {
    // Root-Cause-Reproduktion: der reale Flyer trägt Prospekt-BILDSEITEN
    // (pageCount > 0 → :prospektseiten-Beleg), aber KEINE direkt ladbaren
    // CDN-Bild-URL-Strings (die Extraktion findet 0 URLs). Vorher wurde der
    // OCR-Pfad still übersprungen (kein :prospektseiten:ocr im Report). Jetzt
    // muss eine ehrliche OCR-Bilanzzeile erscheinen: versucht 0, freigegeben 0,
    // mit Übersprungen-Grund — und NICHTS geht live.
    const { runLidlLeafletOcr } = officialSupermarketTestApi;
    let ocrCalls = 0;
    const out = await runLidlLeafletOcr({
      parsedFlyer: { flyer: { products: {}, pages: [{ pageNumber: 1 }, { pageNumber: 2 }] } },
      store: { storeChain: 'Lidl', url: 'https://www.lidl.de', parser: 'lidl' },
      sourceId: 'lidl:aktionsprospekt-15-06-2026',
      structuredOffers: [],
      mode: 'diagnostic',
      ocrImage: async () => {
        ocrCalls += 1;
        return '';
      },
      fetchBinary: async () => new Uint8Array(),
    });
    expect(out).not.toBeNull();
    // Es gibt keine ladbaren Bild-URLs → OCR wurde gar nicht erst versucht.
    expect(ocrCalls).toBe(0);
    expect(out!.result.ocrAttempted).toBe(0);
    expect(out!.emittedOffers).toHaveLength(0);
    expect(out!.diagnostic.sourceId).toBe('lidl:aktionsprospekt-15-06-2026:prospektseiten:ocr');
    expect(out!.diagnostic.note).toMatch(/diagnostic/i);
    // Ehrlicher Übersprungen-Grund statt stillem Verschwinden.
    expect(out!.diagnostic.note).toMatch(/Bild-URL/i);
  });

  // ── Verdrahtung: :prospektseiten + :prospektseiten:ocr GEMEINSAM ──────────
  // Regressionsschutz für den Live-Befund "nur :prospektseiten, kein
  // :prospektseiten:ocr im Report". Der OCR-Modus wird EXPLIZIT übergeben (nicht
  // aus dem beim Import eingefrorenen appConfig gelesen), damit dieser kritische
  // Pfad überhaupt testbar ist — genau diese fehlende Testbarkeit hat die
  // Verdrahtung still 'off' werden lassen können, während :prospektseiten blieb.
  describe('assembleLidlProspectDiagnostics (Connector-Verdrahtung)', () => {
    const { assembleLidlProspectDiagnostics, detectLidlProspectPages } = officialSupermarketTestApi;
    const store = {
      storeChain: 'Lidl',
      url: 'https://www.lidl.de/c/online-prospekte/s10005610',
      parser: 'lidl' as const,
    };

    it('diagnostic + pageCount>0 + imageUrls=[] → BEIDE Zeilen; OCR-Zeile resultCount 0, nichts live', async () => {
      // Reale Reproduktion: Bildseiten vorhanden, aber keine ladbare CDN-Bild-URL.
      const parsedFlyer = { flyer: { products: {}, pages: [{ pageNumber: 1 }, { pageNumber: 2 }] } };
      const prospectPages = detectLidlProspectPages(parsedFlyer);
      expect(prospectPages.pageCount).toBe(2);
      expect(prospectPages.imageUrls).toEqual([]);
      const warnings: string[] = [];
      const { diagnostics, emittedOffers } = await assembleLidlProspectDiagnostics({
        store,
        identifier: 'aktionsprospekt-15-06-2026',
        parsedFlyer,
        prospectPages,
        leafletOffers: [],
        ocrMode: 'diagnostic',
        warnings,
      });
      const ids = diagnostics.map((d) => d.sourceId);
      expect(ids).toContain('lidl:aktionsprospekt-15-06-2026:prospektseiten');
      expect(ids).toContain('lidl:aktionsprospekt-15-06-2026:prospektseiten:ocr');
      const ocr = diagnostics.find((d) => d.sourceId.endsWith(':prospektseiten:ocr'));
      expect(ocr?.status).toBe('empty');
      expect(ocr?.resultCount).toBe(0);
      // Die OCR-Note trägt die Zählkette + die EINE primaryReason ("Ursache: …"),
      // damit ein raw=0 im Report erklärbar ist (nicht null).
      expect(ocr?.note).toBeTruthy();
      expect(ocr?.note).toMatch(/Ursache:/);
      // Diagnostic schaltet NICHTS live + kein OCR-Fehler.
      expect(emittedOffers).toHaveLength(0);
      expect(warnings).toHaveLength(0);
    });

    it('off → NUR :prospektseiten, KEINE :prospektseiten:ocr-Zeile (Verhalten unverändert)', async () => {
      const parsedFlyer = { flyer: { products: {}, pages: [{ pageNumber: 1 }] } };
      const { diagnostics, emittedOffers } = await assembleLidlProspectDiagnostics({
        store,
        identifier: 'aktionsprospekt-15-06-2026',
        parsedFlyer,
        prospectPages: detectLidlProspectPages(parsedFlyer),
        leafletOffers: [],
        ocrMode: 'off',
        warnings: [],
      });
      const ids = diagnostics.map((d) => d.sourceId);
      expect(ids).toEqual(['lidl:aktionsprospekt-15-06-2026:prospektseiten']);
      expect(ids).not.toContain('lidl:aktionsprospekt-15-06-2026:prospektseiten:ocr');
      expect(emittedOffers).toHaveLength(0);
    });

    it('pageCount 0 → gar keine Prospekt-Belegzeile', async () => {
      const parsedFlyer = { flyer: { products: {} } };
      const { diagnostics } = await assembleLidlProspectDiagnostics({
        store,
        identifier: 'aktionsprospekt-15-06-2026',
        parsedFlyer,
        prospectPages: detectLidlProspectPages(parsedFlyer),
        leafletOffers: [],
        ocrMode: 'diagnostic',
        warnings: [],
      });
      expect(diagnostics).toHaveLength(0);
    });

    it('diagnostic + ladbare Bild-URLs → OCR-Runner wird genutzt, keine Live-Angebote', async () => {
      const parsedFlyer = {
        flyer: {
          products: {},
          offerStartDate: '2026-06-15',
          offerEndDate: '2026-06-20',
          pages: [{ imageList: ['https://leaflet.cdn.schwarz/p1-lg.jpg'] }],
        },
      };
      let ocrCalls = 0;
      const { diagnostics, emittedOffers } = await assembleLidlProspectDiagnostics({
        store,
        identifier: 'aktionsprospekt-15-06-2026',
        parsedFlyer,
        prospectPages: detectLidlProspectPages(parsedFlyer),
        leafletOffers: [],
        ocrMode: 'diagnostic',
        warnings: [],
        ocrImage: async () => {
          ocrCalls += 1;
          return ['Rispentomaten', '1,49 €'].join('\n');
        },
        fetchBinary: async () => fakePngBytes(),
      });
      expect(ocrCalls).toBe(1);
      const ocr = diagnostics.find((d) => d.sourceId.endsWith(':prospektseiten:ocr'));
      expect(ocr).toBeDefined();
      // diagnostic: gelesen + bilanziert, aber NICHTS live.
      expect(emittedOffers).toHaveLength(0);
    });

    it('live + sicherer Kandidat → wird durchgereicht (emittedOffers)', async () => {
      const parsedFlyer = {
        flyer: {
          products: {},
          offerStartDate: '2026-06-15',
          offerEndDate: '2026-06-20',
          pages: [{ imageList: ['https://leaflet.cdn.schwarz/p1-lg.jpg'] }],
        },
      };
      const { diagnostics, emittedOffers } = await assembleLidlProspectDiagnostics({
        store,
        identifier: 'aktionsprospekt-15-06-2026',
        parsedFlyer,
        prospectPages: detectLidlProspectPages(parsedFlyer),
        leafletOffers: [],
        ocrMode: 'live',
        warnings: [],
        ocrImage: async () => ['Rispentomaten', '1,49 €'].join('\n'),
        fetchBinary: async () => fakePngBytes(),
      });
      expect(diagnostics.some((d) => d.sourceId.endsWith(':prospektseiten:ocr'))).toBe(true);
      expect(emittedOffers).toHaveLength(1);
      expect(emittedOffers[0].tags).toContain('lidl-prospekt-ocr');
    });
  });

  // ── fetchLidlLeafletOffers: jetzt exportiert + optionaler 5. Parameter ────
  // (fuer den separaten, manuellen Lidl-Bildseiten-Import, lidlPageOfferImport.ts).
  // Der reale Live-Scan-Call bleibt beim 4-Argument-Aufruf (ocrMode/visionMode
  // weiterhin 'off'/'off') — diese Tests belegen, dass das 5. Argument rein
  // additiv ist und in beiden Aufrufvarianten identisch bleibt.
  //
  // Frueher hielt sich der Block ohne Stub vom Netz fern, weil eine Seite ohne
  // Prospekt-Identifier den Abruf gar nicht erst ausloeste. Seit der permanente
  // Identifier GESETZT ist, gibt es diesen Kurzschluss nicht mehr — der Abruf
  // wird deshalb hier gestubbt statt sich auf ein Quellverhalten zu verlassen.
  describe('fetchLidlLeafletOffers (Export + optionale prospectModes)', () => {
    const store = {
      storeChain: 'Lidl',
      url: 'https://www.lidl.de/c/online-prospekte/s10005610',
      parser: 'lidl' as const,
    };
    const htmlWithoutIdentifier = '<html><body>keine Prospekt-Links hier</body></html>';

    /** Leerer, aber strukturell gueltiger v4/flyer — haelt den Block hermetisch. */
    const stubLeererFlyer = (): void => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ flyer: { id: 'flyer-test', pages: [], products: {} } }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
        ),
      );
    };
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('ist als echte Funktion exportiert und ohne 5. Argument aufrufbar', async () => {
      stubLeererFlyer();
      const warnings: string[] = [];
      const diagnostics: SubSourceDiagnostic[] = [];
      const offers = await fetchLidlLeafletOffers(htmlWithoutIdentifier, store, warnings, diagnostics);
      expect(offers).toEqual([]);
      expect(warnings.some((w) => w.includes('kein Aktionsprospekt-Identifier'))).toBe(true);
    });

    // Kernzusage der Umstellung: eine unlesbare Prospektseite laesst Lidl NICHT
    // mehr auf null fallen — der permanente Identifier wird trotzdem abgerufen,
    // und der Discovery-Fehler bleibt als Warnung sichtbar.
    it('ruft auch ohne Discovery-Treffer den permanenten Identifier ab', async () => {
      stubLeererFlyer();
      const warnings: string[] = [];
      const diagnostics: SubSourceDiagnostic[] = [];
      await fetchLidlLeafletOffers(htmlWithoutIdentifier, store, warnings, diagnostics);
      const gerufen = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
        (args) => String(args[0]),
      );
      // Der permanente Prospekt-Identifier muss auch dann abgerufen werden,
      // wenn die Discovery-Seite nichts hergibt.
      expect(gerufen).toHaveLength(1);
      expect(gerufen[0]).toContain(
        'flyer_identifier=latest-leaflet-f5771509-f19a-11e9-b196-005056ab0fb6',
      );
      expect(warnings.some((w) => w.includes('kein Aktionsprospekt-Identifier'))).toBe(true);
    });

    it('mit explizitem prospectModes verhaelt es sich identisch zum 4-Argument-Aufruf', async () => {
      stubLeererFlyer();
      const warningsWithout: string[] = [];
      const diagnosticsWithout: SubSourceDiagnostic[] = [];
      const offersWithout = await fetchLidlLeafletOffers(
        htmlWithoutIdentifier,
        store,
        warningsWithout,
        diagnosticsWithout,
      );

      const warningsWith: string[] = [];
      const diagnosticsWith: SubSourceDiagnostic[] = [];
      const offersWith = await fetchLidlLeafletOffers(
        htmlWithoutIdentifier,
        store,
        warningsWith,
        diagnosticsWith,
        { ocrMode: 'live', visionMode: 'diagnostic', imageLimit: 5 },
      );

      expect(offersWith).toEqual(offersWithout);
      expect(warningsWith).toEqual(warningsWithout);
      expect(diagnosticsWith).toEqual(diagnosticsWithout);
    });
  });

  it('extrahiert ALDI-Produktkacheln aus offiziellem HTML', () => {
    const html = `
      <div id="product-tile-0001" class="product-teaser-item">
        <div class="product-tile" data-test="product-tile" title="Bio-Hackfleisch Rind 800 g">
          <a href="/produkt/bio-hackfleisch-rind-800-g-0001">
            <img src="https://example.org/hack.jpg" alt="Bio-Hackfleisch Rind 800 g">
            <div class="product-tile__brandname"><p>BIO</p></div>
            <div class="product-tile__name"><p>Bio-Hackfleisch Rind 800 g</p></div>
            <div data-test="product-tile__unit-of-measurement" class="product-tile__unit-of-measurement">
              <p>0,8 kg</p>
            </div>
            <div data-test="product-tile__comparison-price" class="product-tile__comparison-price">
              <p>(11,86 \u20ac/1 kg)</p>
            </div>
            <div class="base-price" data-test="product-tile__price">
              <ins class="base-price__discounted" aria-label="Reduzierter Preis: 9,49 \u20ac">9,49 \u20ac</ins>
              <del aria-label="Originalpreis: 11,99 \u20ac">11,99 \u20ac</del>
            </div>
          </a>
        </div>
      </div>
    `;

    const offers = officialSupermarketTestApi.parseOfficialOffersFromHtml(html, {
      storeChain: 'ALDI SUED',
      url: 'https://www.aldi-sued.de/de/angebote.html',
      parser: 'aldi',
    });

    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      name: 'Bio-Hackfleisch Rind 800 g',
      brand: 'BIO',
      storeChain: 'ALDI SUED',
      price: 9.49,
      basePrice: 11.86,
      baseUnit: '1 kg',
      unit: '0,8 kg',
      sourceUrl: 'https://www.aldi-sued.de/produkt/bio-hackfleisch-rind-800-g-0001',
    });
  });

  it('findet ALDI-Sued-Tages- und Lebensmittel-Themenseiten', () => {
    const urls = officialSupermarketTestApi.extractAldiSuedOfferPageUrls(
      `
        <a href="/angebote/2026-05-11"></a>
        <a href="/angebote/2026-05-15?theme=Gek%C3%BChlte+Produkte"></a>
        <a href="/angebote/2026-05-15?theme=Bekleidung"></a>
      `,
      {
        storeChain: 'ALDI SUED',
        url: 'https://www.aldi-sued.de/angebote',
        parser: 'aldi',
      },
    );

    expect(urls).toEqual([
      'https://www.aldi-sued.de/angebote/2026-05-11',
      'https://www.aldi-sued.de/angebote/2026-05-15?theme=Gek%C3%BChlte+Produkte',
    ]);
  });

  it('liest ALDI-Nord-Angebote aus eingebettetem API-JSON', () => {
    const apiData = JSON.stringify([
      [
        'OFFER_GET',
        {
          res: {
            algoliaDataMap: {
              '1001246': {
                brandName: 'LANDFREUDE',
                currentPrice: {
                  priceValue: 1.19,
                  basePrice: [{ basePriceValue: 2.38, basePriceScale: 'kg' }],
                  validFrom: 1778450400,
                  validUntil: 1778968799,
                },
                productSlug: 'gabelspaghetti-1001246',
                salesUnit: '500-g-Beutel',
                name: 'Gabelspaghetti',
                mainCategoryID: 'Angebote',
                assets: [
                  {
                    type: 'primary',
                    url: 'https://s7g10.scene7.com/is/image/aldinord/gabelspaghetti',
                  },
                ],
                objectID: '1001246',
              },
            },
          },
        },
      ],
    ]).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const html = `<script>self.__next_f.push(["apiData":"${apiData}"])</script>`;

    const offers = officialSupermarketTestApi.parseAldiNordApiData(html, {
      storeChain: 'ALDI NORD',
      url: 'https://www.aldi-nord.de/angebote.html',
      parser: 'aldiNord',
    });

    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      // name = Marke + Name (Marke nicht bereits im Namen enthalten).
      name: 'LANDFREUDE Gabelspaghetti',
      brand: 'LANDFREUDE',
      storeChain: 'ALDI NORD',
      price: 1.19,
      unit: '500-g-Beutel',
      basePrice: 2.38,
      baseUnit: 'kg',
    });
    expect(offers[0].tags).toContain('aldi-nord-structured');
  });

  // EDEKA-Angebote werden jetzt aus dem serverseitig gerenderten "edeka_neu"-
  // HTML (<dialog>-Karten) gelesen \u2014 siehe officialSupermarketConnector.edeka.test.ts.

  it('extrahiert Netto-Produktkacheln aus dem Wochenangebote-HTML', () => {
    const html = `
      <div class="product-list__item tc-store-product-tile js-store-product-tile">
        <a href="/youcook-fertiggerichte/p-438773">
          <h3 class="product__title tc-product-name">YouCook Fertiggerichte</h3>
          <span class="product-property product-property__bundle-text">420 g</span>
          <span class="product-property product-property__base-price">9.02 &#47; kg</span>
          <ins class="product__current-price tc-product-price">
            3.<span class="product__current-price--digits-after-comma">79</span>
          </ins>
          <img class="tc-product-image" data-src="/media_nfs/youcook.webp" />
        </a>
      </div>
      <li class="product-list__item tc-product-tile">
        <a href="/iphone/p-1">
          <h3 class="product__title tc-product-name">Apple iPhone</h3>
          <ins class="product__current-price tc-product-price">599.<span>00</span></ins>
        </a>
      </li>
    `;

    const offers = officialSupermarketTestApi.parseNettoProductTiles(html, {
      storeChain: 'Netto',
      url: 'https://www.netto-online.de/online-wochenangebote/c-N0794',
      parser: 'netto',
    });

    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      name: 'YouCook Fertiggerichte',
      storeChain: 'Netto',
      price: 3.79,
      unit: '420 g',
      basePrice: 9.02,
      baseUnit: 'kg',
      sourceUrl: 'https://www.netto-online.de/youcook-fertiggerichte/p-438773',
    });
  });

  it('liest Preis, echte Gueltigkeit und Bild aus dem Netto-Wishlist-Link der Kachel', () => {
    // Realistische Netto-Kachel (Struktur der Live-Seite): der
    // ViewMMPWishlist-AddStoreArticle-Link traegt Price/ValidTo/ValidityPeriod/
    // Image/BundleText strukturiert in der Query.
    const html = `
      <div class="product-list__item box__glow tc-store-product-tile js-store-product-tile" data-ff-id="447469">
        <img class="image-transition tc-product-image" data-src="https://www.netto-online.de/media_nfs/images/447469-450x450-n.webp" />
        <h3 class="product__title tc-product-name">Fußball Laugenbrötchen</h3>
        <span class="product-property product-property__bundle-text">St&uuml;ck</span>
        <span class="product__action">Aktion</span>
        <ins class="product__current-price tc-product-price">0.<span class="product__current-price--digits-after-comma">22</span></ins>
        <a class="js-add-to-wishlist" href="https://www.netto-online.de/INTERSHOP/web/WFS/Plus-NettoDE-Site/de_DE/-/EUR/ViewMMPWishlist-AddStoreArticle?SKU=447469&amp;Name=Fu%C3%9Fball+Laugenbr%C3%B6tchen&amp;Price=0.22&amp;BasePrice=&amp;ValidTo=2026-06-13+20%3A00%3A00&amp;Image=https%3A%2F%2Fwww.netto-online.de%2Fmedia_nfs%2Fimages%2F447469-450x450-n.webp&amp;ValidityPeriod=g%C3%BCltig+von+Montag%2C+08.06.26+-+Samstag%2C+13.06.26&amp;BundleText=St%C3%BCck&amp;AjaxRequestMarker=true" rel="nofollow"></a>
      </div>
    `;

    const offers = officialSupermarketTestApi.parseNettoProductTiles(html, {
      storeChain: 'Netto',
      url: 'https://www.netto-online.de/online-wochenangebote/c-N0794',
      parser: 'netto',
    });

    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      name: 'Fußball Laugenbrötchen',
      storeChain: 'Netto',
      price: 0.22,
      unit: 'Stück',
      imageUrl: 'https://www.netto-online.de/media_nfs/images/447469-450x450-n.webp',
      // ECHTE Gueltigkeit aus ValidityPeriod statt "jetzt + 7 Tage".
      validityStart: '2026-06-08T00:00:00.000Z',
      validityEnd: '2026-06-13T23:59:59.999Z',
    });
  });

  it('haelt dasselbe Netto-Produkt aus zwei Gueltigkeitsfenstern als getrennte Angebote', () => {
    const tile = (period: string) => `
      <div class="tc-store-product-tile js-store-product-tile">
        <h3 class="tc-product-name">Bananen</h3>
        <ins class="product__current-price tc-product-price">1.<span>11</span></ins>
        <a class="js-add-to-wishlist" href="https://www.netto-online.de/INTERSHOP/web/WFS/Plus-NettoDE-Site/de_DE/-/EUR/ViewMMPWishlist-AddStoreArticle?Name=Bananen&amp;Price=1.11&amp;ValidityPeriod=${period}"></a>
      </div>
    `;
    const store = {
      storeChain: 'Netto',
      url: 'https://www.netto-online.de/online-wochenangebote/c-N0794',
      parser: 'netto' as const,
    };
    const week1 = officialSupermarketTestApi.parseNettoProductTiles(
      tile('g%C3%BCltig+von+Montag%2C+08.06.26+-+Samstag%2C+13.06.26'),
      store,
    );
    const week2 = officialSupermarketTestApi.parseNettoProductTiles(
      tile('g%C3%BCltig+von+Montag%2C+15.06.26+-+Samstag%2C+20.06.26'),
      store,
    );
    expect(week1).toHaveLength(1);
    expect(week2).toHaveLength(1);
    expect(week1[0].id).not.toBe(week2[0].id);
  });

  it('extrahiert Kaufland-Angebote aus SSR-Daten', () => {
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
                      offerId: 'ART.59011_KAV.3415255',
                      dateFrom: '2026-05-07',
                      dateTo: '2026-05-13',
                      title: 'EHRMANN',
                      subtitle: 'Almighurt',
                      price: 0.29,
                      discount: 67,
                      basePrice: '(1 kg = 1.94)',
                      unit: 'je 150-g-Becher',
                      detailTitle: 'EHRMANN\u2028Almighurt',
                      listImage: 'https://kaufland.media.schwarz/is/image/schwarz/00427732',
                      formattedOldPrice: '0.89',
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

    const offers = officialSupermarketTestApi.parseKauflandOffersFromHtml(html, {
      storeChain: 'Kaufland',
      url: 'https://filiale.kaufland.de/angebote/aktuelle-woche.html',
      parser: 'kaufland',
    });

    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      name: 'EHRMANN Almighurt',
      storeChain: 'Kaufland',
      price: 0.29,
      basePrice: 1.94,
      baseUnit: '1 kg',
      unit: '150-g-Becher',
      tags: ['reduziert'],
    });
  });

  it('extrahiert NORMA-Produktkacheln aus Angebots-HTML', () => {
    const html = `
      <article class="b463 produktBoxContainer" id="of_367454">
        <a href="/de/angebote/ab-montag,-11.05.26/asia-genuss-t-366733/sriracha-chilisauce-i-367454/">
          <div class="produktBox-img produktBox-img--center">
            <img src="/ext/img/product/angebote/26_05_11/900_sriracha-chilisauce_wo.png" alt="Produktbild »Sriracha Chilisauce«"/>
          </div>
          <div class="produktBox-txt">
            <strong class="supplier">Flying Goose Brand</strong>
            <h3 class="produktBox-txt-headline">Sriracha Chilisauce</h3>
            <ul>
              <li class="produktBox-txt-inh">je 455 ml</li>
              <li class="produktBox-txt-price">(1 l = 6,57)</li>
            </ul>
          </div>
          <div class="produktBox-cont-wrapper">
            <ul>
              <li class="produktBox-cont-wrapper-uvp">UVP 4,49</li>
              <li class="produktBox-cont-wrapper-price"><span aria-label="2,99 Euro">2,99<sup>*</sup></span></li>
            </ul>
          </div>
        </a>
      </article>
    `;

    const offers = officialSupermarketTestApi.parseNormaProductBoxes(html, {
      storeChain: 'NORMA',
      url: 'https://www.norma-online.de/de/angebote/',
      parser: 'norma',
    });

    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      name: 'Sriracha Chilisauce',
      brand: 'Flying Goose Brand',
      price: 2.99,
      unit: '455 ml',
      basePrice: 6.57,
      baseUnit: '1 l',
      tags: ['reduziert'],
    });
  });

  it('findet NORMA-Tagesuebersichten fuer den Nachlade-Abruf', () => {
    const urls = officialSupermarketTestApi.extractNormaOverviewPageUrls(
      `
        <a href="/de/angebote/ab-montag,-11.05.26/"></a>
        <a href="/de/angebote/ab-montag,-11.05.26/fruehlings-genuss-t-366731/"></a>
        <a href="/de/angebote/ab-mittwoch,-13.05.26/?pk_campaign=Slider"></a>
      `,
      {
        storeChain: 'NORMA',
        url: 'https://www.norma-online.de/de/angebote/',
        parser: 'norma',
      },
    );

    expect(urls).toEqual([
      'https://www.norma-online.de/de/angebote/ab-montag,-11.05.26/',
      'https://www.norma-online.de/de/angebote/ab-mittwoch,-13.05.26/',
    ]);
  });

  it('liest Penny-Kategorien aus dem offiziellen Angebots-HTML', () => {
    const html = `
      <span class="js-weeks" data-current-week="2026-19" data-next-week="2026-20"></span>
      <div class="tabs__content--current-week">
        <section class="page-sector js-category-section" data-category-type="food" data-period-category="false" data-category-name="top-angebote"></section>
        <section class="page-sector js-category-section" data-category-type="nonfood" data-period-category="false" data-category-name="haushalt"></section>
      </div>
      <div class="tabs__content--next-week">
        <section class="page-sector js-category-section" data-category-type="food" data-period-category="false" data-category-name="obst-und-gemuese"></section>
      </div>
    `;

    const categories = officialSupermarketTestApi.extractPennyCategories(html);

    expect(categories).toEqual([
      { week: '2026-19', categoryName: 'top-angebote', categoryType: 'food' },
      { week: '2026-20', categoryName: 'obst-und-gemuese', categoryType: 'food' },
    ]);
  });

  it('ordnet Penny-Sektionen der richtigen Woche zu, wenn ein Kategorie-Sprungmenü vor dem Wochen-Content steht', () => {
    // Reale Seitenstruktur: VOR den echten Wochen-Containern liegt ein
    // Kategorie-Sprungmenü, dessen Container die Klassen
    // `tabs__content--current-week-menu` / `tabs__content--next-week-menu`
    // tragen. Ein Substring-Match (indexOf) findet zuerst das MENÜ; der
    // Current-Slice ist dann leer und ALLE Sektionen (auch die der aktuellen
    // Woche) landen in der nächsten Woche → PENNY current=0, alles nextWeek.
    const html = `
      <span class="js-weeks" data-current-week="2026-19" data-next-week="2026-20"></span>
      <div class="category-menu__periods tabs__content-area">
        <div class="tabs__content--weeks-menu">
          <div class="current-week-category-menu tabs__content tabs__content--current-week-menu">
            <input type="radio" id="ab-montag-period" data-week="ab-montag_period_menu">
          </div>
          <div class="next-week-category-menu tabs__content tabs__content--next-week-menu">
            <input type="radio" id="ab-naechsten-montag-period" data-week="ab-naechsten-montag_period_menu">
          </div>
        </div>
      </div>
      <div class="tabs__content--weeks">
        <div class="week-offers tabs__content tabs__content--current-week" data-week="current">
          <section class="page-sector js-category-section" data-category-type="food" data-period-category="false" data-category-name="top-angebote"></section>
          <section class="page-sector js-category-section" data-category-type="food" data-period-category="false" data-category-name="gemeinsam-jubeln-gemeinsam-sparen"></section>
        </div>
        <div class="week-offers tabs__content tabs__content--next-week" data-week="next">
          <section class="page-sector js-category-section" data-category-type="food" data-period-category="false" data-category-name="top-angebote"></section>
        </div>
      </div>
    `;

    const categories = officialSupermarketTestApi.extractPennyCategories(html);

    expect(categories).toEqual([
      { week: '2026-19', categoryName: 'top-angebote', categoryType: 'food' },
      { week: '2026-19', categoryName: 'gemeinsam-jubeln-gemeinsam-sparen', categoryType: 'food' },
      { week: '2026-20', categoryName: 'top-angebote', categoryType: 'food' },
    ]);
  });

  it('stempelt Penny-Validity aus dem ISO-Wochen-Token (Montag-Start, Ende inklusiv)', () => {
    // Die PENNY-REST-Antwort liefert pro Tile KEINE Datumsfelder — das einzige
    // Datums-Signal ist der ISO-Wochen-Token (YYYY-WW) der Seite. Daraus muss
    // ein inklusiver Wochenzeitraum (Mo 00:00 bis So End-of-Day) entstehen.
    const offer = officialSupermarketTestApi.parsePennyOfferTile(
      { title: 'Wochen-Angebot', price: '1.00' },
      { storeChain: 'PENNY', url: 'https://www.penny.de/angebote', parser: 'penny' },
      { week: '2026-24', categoryName: 'top-angebote', categoryType: 'food' },
    );

    expect(offer?.validityStart).toBe('2026-06-08T00:00:00.000Z');
    expect(offer?.validityEnd).toBe('2026-06-14T23:59:59.999Z');
  });

  it('mappt Penny-Angebote aus der offiziellen REST-Antwort', () => {
    const offer = officialSupermarketTestApi.parsePennyOfferTile(
      {
        title: 'PHILADELPHIA Frischkaesezubereitung',
        type: 'food',
        quantity: 'je 195 g',
        price: '1.11',
        originalPrice: '2.29',
        basePrice: '(1 kg = 5.69)',
        imageRendition: {
          tileMd: 'https://cdn.penny.de/example.png',
        },
        linkHref: '/angebote/top-angebote/philadelphia-frischkaesezubereitung',
        productData:
          '{"id":"abc","name":"philadelphia-frischkaesezubereitung","category":"top-angebote"}',
      },
      {
        storeChain: 'PENNY',
        url: 'https://www.penny.de/angebote',
        parser: 'penny',
      },
      {
        week: '2026-19',
        categoryName: 'top-angebote',
        categoryType: 'food',
      },
    );

    expect(offer).toMatchObject({
      name: 'PHILADELPHIA Frischkaesezubereitung',
      storeChain: 'PENNY',
      price: 1.11,
      basePrice: 5.69,
      baseUnit: '1 kg',
      unit: '195 g',
      sourceUrl:
        'https://www.penny.de/angebote/top-angebote/philadelphia-frischkaesezubereitung',
      tags: ['reduziert'],
    });
  });
});
