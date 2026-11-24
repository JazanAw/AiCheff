import { describe, it, expect } from 'vitest';
import {
  officialSupermarketTestApi,
  parseEdekaOffers,
} from './officialSupermarketConnector';

// EDEKA-Store-Konfiguration wie im Produktivcode (keine Markt-ID hardcodiert).
const EDEKA_STORE = {
  storeChain: 'EDEKA',
  url: 'https://www.edeka.de/angebote',
  parser: 'edeka' as const,
};

// ── Fixture-Bausteine: serverseitig gerendertes "edeka_neu"-HTML ─────────────
// Jede <dialog>-Karte ist ein Angebot mit maschinenlesbaren sr-only Preis-Labels
// (so wie die echte Seite es ausliefert; verifiziert per Live-Probe 2026-06).

/** Festpreis-Angebot (z. B. Salatgurke 0,49 €) — ein einziger fixer Preis. */
const festpreisCard = `
<dialog id="dialog-angebot-4f7f61f2-cf9f-44bc-bc7f-da6b99a67a4c">
  <header><h2 id="dialog-headline"></h2></header>
  <h3 class="font-display text-4xl">
    <span class="sr-only">Angebot:</span>
    Salatgurke
  </h3>
  <strong class="text-sm text-grey">Gültig ab 15.06.2026</strong>
  <ul><li>
    <div class="sr-only">Festpreis von 0.49 €</div>
  </li></ul>
  <p class="line-clamp-2"><span class="inline-block">aus den Niederlanden oder Spanien, Klasse I, Stück</span></p>
  <img src="https://offer-images.api.edeka/728cf6b6-prod.png" class="w-full object-contain aspect-square" alt="" aria-hidden="true">
</dialog>`;

/** App-Preis + regulärer Rabattpreis + Grundpreis (Weihenstephan Butter). */
const appPlusRabattCard = `
<dialog id="dialog-angebot-1f997e0d-1111-2222-3333-444444444444">
  <h3 class="font-display"><span class="sr-only">Angebot:</span> Weihenstephan Tafelbutter</h3>
  <strong>Gültig ab 15.06.2026</strong>
  <ul>
    <li><div class="sr-only">App-Preis von 0.99 €</div></li>
    <li><div class="sr-only">Rabattierter Preis von 1.29 € (Insgesamt -50 % Rabatt)</div></li>
  </ul>
  <p class="line-clamp-2"><span>versch. Sorten, 250g</span></p>
  <div>Grundpreis mit App: 1kg = € 3,96</div>
  <div>Grundpreis ohne App: 1kg = € 5,16</div>
  <div>Niedrigster Gesamtpreis der letzten 30 Tage: 1,11 €</div>
  <ul><li><img src="https://offer-images.api.edeka/aaa-logo.png" class="max-w-20" height="80"></li></ul>
  <img src="https://offer-images.api.edeka/472f7b50-prod.png" class="aspect-square">
</dialog>`;

/** Reiner Rabattpreis + Grundpreis (FRoSTA), kein App-Preis. */
const rabattCard = `
<dialog id="dialog-angebot-a8c0bdbc-aaaa-bbbb-cccc-dddddddddddd">
  <h3><span class="sr-only">Angebot:</span> FRoSTA Pfannengericht</h3>
  <strong>Gültig ab 15.06.2026</strong>
  <ul><li><div class="sr-only">Rabattierter Preis von 2.22 € (Insgesamt -10 % Rabatt)</div></li></ul>
  <p class="line-clamp-2"><span>tiefgefroren, versch. Sorten, 375g - 500g</span></p>
  <div>Grundpreis: 1kg = € 5,92</div>
  <img src="https://offer-images.api.edeka/9a852dcc-prod.png" class="aspect-square">
</dialog>`;

/** PAYBACK-Punkte-"Angebot": NUR Normalpreis, kein reduzierter Preis (Toastbrot). */
const paybackOnlyCard = `
<dialog id="dialog-angebot-bbbbbbbb-0000-0000-0000-000000000000">
  <h3><span class="sr-only">Angebot:</span> Toastbrot</h3>
  <strong>Gültig ab 15.06.2026</strong>
  <p class="line-clamp-2"><span>versch. Sorten, 500g, Normalpreis: € 0,79, 1kg = € 1,58</span></p>
  <div>15 Extra°Punkte Mit PAYBACK 15 Extra Punkte sammeln.</div>
  <img src="https://offer-images.api.edeka/cccc-prod.png" class="aspect-square">
</dialog>`;

function htmlPage(...cards: string[]): string {
  return `<!DOCTYPE html><html><head><title>EDEKA: Angebote der Woche</title></head>
  <body class="edeka_neu"><main id="national-offers-header">${cards.join('\n')}</main></body></html>`;
}

describe('EDEKA edeka_neu HTML-Karten-Parser', () => {
  it('Fall 1: liest mehrere Produkte aus gültigem HTML', () => {
    const { offers, diagnostics } = parseEdekaOffers(htmlPage(festpreisCard, rabattCard), EDEKA_STORE);
    expect(offers).toHaveLength(2);
    expect(offers.map((o) => o.name).sort()).toEqual(['FRoSTA Pfannengericht', 'Salatgurke']);
    expect(diagnostics.offerBlocks).toBe(2);
    expect(diagnostics.importedDistinct).toBe(2);
    expect(diagnostics.marketScope).toBe('national');
  });

  it('Fall 2: toleriert geänderte Attribut-Reihenfolge / Zusatzklassen', () => {
    const reordered = festpreisCard
      .replace('class="sr-only">Angebot:', 'data-x="1" class="visually-hidden sr-only extra">Angebot:')
      .replace('class="sr-only">Festpreis', 'data-test class="extra sr-only">Festpreis');
    const { offers } = parseEdekaOffers(htmlPage(reordered), EDEKA_STORE);
    expect(offers).toHaveLength(1);
    expect(offers[0].name).toBe('Salatgurke');
    expect(offers[0].price).toBe(0.49);
  });

  it('Fall 3: dekodiert HTML-Entities und Unicode im Namen', () => {
    const card = festpreisCard.replace('Salatgurke', 'Nuss &amp; M&uuml;sli – Knäcke');
    const { offers } = parseEdekaOffers(htmlPage(card), EDEKA_STORE);
    expect(offers[0].name).toBe('Nuss & Müsli – Knäcke');
  });

  it('Fall 4: Verkaufspreis + Grundpreis werden getrennt', () => {
    const { offers } = parseEdekaOffers(htmlPage(rabattCard), EDEKA_STORE);
    expect(offers[0].price).toBe(2.22);
    expect(offers[0].basePrice).toBe(5.92);
    expect(offers[0].baseUnit).toBe('1kg');
  });

  it('Fall 5+6: App-Preis ist Bonus, regulärer Angebotspreis bleibt der Rabattpreis (nie Normal-/Grundpreis)', () => {
    const { offers } = parseEdekaOffers(htmlPage(appPlusRabattCard), EDEKA_STORE);
    const offer = offers[0];
    // Angebotspreis = der für ALLE geltende Rabattpreis (1,29), NICHT der
    // App-exklusive Bonus (0,99) und NICHT der Grundpreis (3,96/5,16).
    expect(offer.price).toBe(1.29);
    expect(offer.price).not.toBe(3.96);
    expect(offer.price).not.toBe(5.16);
    // Grundpreis zum regulären Preis (ohne App).
    expect(offer.basePrice).toBe(5.16);
    expect(offer.tags).toContain('edeka-app-preis');
    expect(offer.tags).toContain('national');
  });

  it('Fall 6: PAYBACK-Punkte-Angebot (nur Normalpreis) wird mit Grund abgelehnt', () => {
    const { offers, diagnostics } = parseEdekaOffers(htmlPage(paybackOnlyCard), EDEKA_STORE);
    expect(offers).toHaveLength(0);
    expect(diagnostics.rejectedByReason.kein_angebotspreis).toBe(1);
    expect(diagnostics.candidates).toBe(0);
  });

  it('Fall 8: Karte ohne Namen → kein_name, Karte ohne Preis → kein_preis', () => {
    const noName = `<dialog id="dialog-angebot-eeee0000-0000-0000-0000-000000000000">
      <h3>kein Angebot-Label</h3><strong>Gültig ab 15.06.2026</strong>
      <div class="sr-only">Festpreis von 1.00 €</div></dialog>`;
    const noPrice = `<dialog id="dialog-angebot-ffff0000-0000-0000-0000-000000000000">
      <h3><span class="sr-only">Angebot:</span> Ware ohne Preis</h3>
      <strong>Gültig ab 15.06.2026</strong><p><span>500g</span></p></dialog>`;
    const { offers, diagnostics } = parseEdekaOffers(htmlPage(noName, noPrice), EDEKA_STORE);
    expect(offers).toHaveLength(0);
    expect(diagnostics.rejectedByReason.kein_name).toBe(1);
    expect(diagnostics.rejectedByReason.kein_preis).toBe(1);
  });

  it('Fall 9: fehlende Gültigkeit → Angebot bleibt erhalten (Default-Gültigkeit)', () => {
    const card = festpreisCard.replace('<strong class="text-sm text-grey">Gültig ab 15.06.2026</strong>', '');
    const { offers } = parseEdekaOffers(htmlPage(card), EDEKA_STORE);
    expect(offers).toHaveLength(1);
    expect(offers[0].validityStart).toBeTruthy();
    expect(offers[0].validityEnd).toBeTruthy();
  });

  it('Fall 9b: "Gültig ab" setzt Start (Mo) und Ende (+5 Tage, Sa)', () => {
    const { offers } = parseEdekaOffers(htmlPage(festpreisCard), EDEKA_STORE);
    expect(offers[0].validityStart).toBe('2026-06-15T00:00:00.000Z');
    expect(offers[0].validityEnd).toBe('2026-06-20T23:59:59.999Z');
  });

  it('Fall 10 + 16: gleiche Produkt-Dublette wird zusammengeführt (kein doppeltes Angebot)', () => {
    const { offers, diagnostics } = parseEdekaOffers(
      htmlPage(festpreisCard, festpreisCard.replace('4f7f61f2', 'aaaaaaaa')),
      EDEKA_STORE,
    );
    expect(offers).toHaveLength(1);
    expect(diagnostics.duplicatesMerged).toBe(1);
  });

  it('Fall 11: keine Markt-ID — Angebote sind national getaggt (sourceScope national)', () => {
    const { offers } = parseEdekaOffers(htmlPage(festpreisCard), EDEKA_STORE);
    expect(offers[0].sourceScope).toBe('national');
    expect(offers[0].tags).toContain('national');
    // Keine Markt-/Filial-IDs im Produktivimport: die URL bleibt die nationale Seite.
    expect(offers[0].sourceUrl).toBe('https://www.edeka.de/angebote');
  });

  it('Fall 12+13: HTTP-200-Block-/Captcha-Seite → blocked, keine erfundenen Angebote', () => {
    const blockHtml = `<!DOCTYPE html><html><body>
      <h1>Bitte bestätigen Sie, dass Sie ein Mensch sind</h1>
      <div id="px-captcha">Are you a robot? Access denied.</div></body></html>`;
    const { offers, diagnostics } = parseEdekaOffers(blockHtml, EDEKA_STORE, { httpStatus: 200 });
    expect(offers).toHaveLength(0);
    expect(diagnostics.blocked).toBe(true);
    expect(diagnostics.pageLooksLikeOffers).toBe(false);
    expect(diagnostics.httpStatus).toBe(200);
  });

  it('Fall 14: erreichbare Seite ohne Angebote → nicht blocked, ehrlich leer', () => {
    const emptyHtml = `<!DOCTYPE html><html><body class="edeka_neu">
      <main id="national-offers-header"><p>Aktuell keine Angebote.</p></main></body></html>`;
    const { offers, diagnostics } = parseEdekaOffers(emptyHtml, EDEKA_STORE);
    expect(offers).toHaveLength(0);
    expect(diagnostics.blocked).toBe(false);
    expect(diagnostics.pageLooksLikeOffers).toBe(true);
    expect(diagnostics.offerBlocks).toBe(0);
  });

  it('Zählkette ist vollständig und konsistent', () => {
    const { diagnostics } = parseEdekaOffers(
      htmlPage(festpreisCard, appPlusRabattCard, rabattCard, paybackOnlyCard),
      EDEKA_STORE,
    );
    expect(diagnostics.offerBlocks).toBe(4);
    expect(diagnostics.candidates).toBe(3); // 3 mit echtem Preis, PAYBACK abgelehnt
    expect(diagnostics.withOfferPrice).toBe(3);
    expect(diagnostics.importedDistinct).toBe(3);
    expect(diagnostics.rejectedByReason.kein_angebotspreis).toBe(1);
    expect(diagnostics.lastSuccessfulAt).toBeTruthy();
    expect(diagnostics.validityStartSeen).toBe('2026-06-15T00:00:00.000Z');
  });

  it('Fall 17: parseOfficialOffersFromHtml für EDEKA liefert die Karten-Angebote', () => {
    const offers = officialSupermarketTestApi.parseOfficialOffersFromHtml(
      htmlPage(festpreisCard, rabattCard),
      EDEKA_STORE,
    );
    expect(offers.map((o) => o.name).sort()).toEqual(['FRoSTA Pfannengericht', 'Salatgurke']);
  });
});
