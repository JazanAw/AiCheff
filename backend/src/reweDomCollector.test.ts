import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  createReweDomCollector,
  findReweCardElements,
  reweSplitElementLines,
  type ReweDomDocument,
  type ReweCollectedOffer,
} from './reweBrowserImport';

// EXECUTABLE DOM tests for the SHARED collector that the bookmarklet injects
// verbatim. jsdom does not implement innerText (returns undefined) and rects are
// 0×0, so these tests exercise the real fallback path (block-walker line split)
// and pass `isVisible: () => true`. No CSS class or product name is hardcoded in
// the collector — the fixtures here are test data only.

function collect(html: string, passes = 1): {
  offers: ReweCollectedOffer[];
  diagnostics: ReturnType<ReturnType<typeof createReweDomCollector>['result']>['diagnostics'];
} {
  // A real base URL so relative product links resolve to https (as on the live
  // REWE page) — otherwise jsdom's about:blank base makes link.href non-http and
  // the P6 safe-URL guard would collapse distinct identities.
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: 'https://www.rewe.de/angebote/nationale-angebote/',
  });
  const doc = dom.window.document as unknown as ReweDomDocument;
  const collector = createReweDomCollector({
    isVisible: () => true,
    pageUrl: 'https://www.rewe.de/angebote/nationale-angebote/',
  });
  for (let i = 0; i < passes; i += 1) {
    collector.collect(doc);
  }
  return collector.result();
}

function names(offers: ReweCollectedOffer[]): string[] {
  return offers.map((offer) => offer.name);
}

/** Every browser-side balance equation must hold for a healthy collection. */
function expectBalanced(diag: { consistent: boolean }): void {
  expect(diag.consistent).toBe(true);
}

describe('reweSplitElementLines — Zeilen gehen nicht verloren (Problem 1)', () => {
  it('teilt eine Karte mit name/desc/preis in getrennten Knoten in echte Zeilen', () => {
    const dom = new JSDOM(
      '<body><article><div>Bananen</div><div>Klasse I</div><span>1,79 €</span></article></body>',
    );
    const article = dom.window.document.querySelector('article')!;
    // textContent kollabiert alles ("Bananen…1,79 €") — der Block-Walker rettet
    // die Zeilen, sodass der Name nicht in der Preiszeile verschwindet.
    expect(reweSplitElementLines(article as never)).toEqual(['Bananen', 'Klasse I', '1,79 €']);
  });
});

describe('findReweCardElements — strukturelle Kartenabgrenzung (Problem 2)', () => {
  it('zwei benachbarte Karten in einem Elterncontainer werden nie zusammengeführt', () => {
    const dom = new JSDOM(
      '<body><div class="tiles">' +
        '<article><a href="/p/a"><img alt="A"></a><div>Produkt A</div><span>2,99 €</span></article>' +
        '<article><a href="/p/b"><img alt="B"></a><div>Produkt B</div><span>1,49 €</span></article>' +
        '</div></body>',
    );
    const doc = dom.window.document as unknown as ReweDomDocument;
    const cards = findReweCardElements(doc, { isVisible: () => true });
    expect(cards).toHaveLength(2);
    // jede Karte hat genau eine Produktidentität, keine umschließt die andere
    for (const card of cards) {
      expect(cards.some((other) => other !== card && card.contains(other))).toBe(false);
    }
  });
});

describe('createReweDomCollector — DOM-Fixtures', () => {
  it('Produktname liegt NICHT in h2/h3/h4 (sondern in einem div)', () => {
    const { offers } = collect(
      '<section><h2>Obst und Gemüse</h2><article><a href="/p/banane"><img alt="Bananen"></a>' +
        '<div>Bananen</div><span>1,79 €</span></article></section>',
    );
    expect(names(offers)).toEqual(['Bananen']);
    expect(offers[0].price).toBe('1,79');
    expect(offers[0].category).toBe('Obst und Gemüse');
  });

  it('Name, Beschreibung und Preis auf getrennten Zeilen', () => {
    const { offers } = collect(
      '<section><h2>Kühlung</h2><article><a href="/p/x"><img alt="Weihenstephan"></a>' +
        '<div>Weihenstephan Butter</div><div>versch. Sorten, je 250-g-Pckg.</div><span>1,19 €</span></article></section>',
    );
    expect(names(offers)).toEqual(['Weihenstephan Butter']);
    expect(offers[0].price).toBe('1,19');
    expect(offers[0].description).toContain('versch. Sorten');
  });

  it('Aktionspreis plus Grundpreis → ein Angebot mit Aktionspreis', () => {
    const { offers } = collect(
      '<section><h2>Obst und Gemüse</h2><article><a href="/p/banane"><img alt="Bananen"></a>' +
        '<div>Bananen</div><span>1,79 €</span><span>(1 kg = 1,79 €)</span></article></section>',
    );
    expect(names(offers)).toEqual(['Bananen']);
    expect(offers[0].price).toBe('1,79');
  });

  it('Aktionspreis plus Streichpreis plus Pfand → ein Angebot mit Aktionspreis', () => {
    const { offers } = collect(
      '<section><h2>Getränke</h2><article><a href="/p/cola"><img alt="Cola"></a>' +
        '<div>Coca-Cola</div><span>0,99 €</span><span>statt 1,49 €</span><span>zzgl. 0,25 € Pfand</span></article></section>',
    );
    expect(names(offers)).toEqual(['Coca-Cola']);
    expect(offers[0].price).toBe('0,99');
  });

  it('reiner Bonus-/Couponpreis wird kein Angebot', () => {
    const { offers, diagnostics } = collect(
      '<section><h2>Bonus</h2><article><div>Treuepunkte mit der App</div><span>0,50 €</span></article></section>',
    );
    expect(offers).toHaveLength(0);
    expect(diagnostics.rejected.noPrice).toBe(1);
  });

  it('Sektionsüberschrift oberhalb einer echten Karte: Karte kommt, Überschrift nur als Kategorie', () => {
    const { offers } = collect(
      '<section><h2>An der Bedientheke</h2><article><a href="/p/g"><img alt="Gruyère"></a>' +
        '<div>Le Gruyère AOP</div><span>2,49 €</span></article></section>',
    );
    expect(names(offers)).toEqual(['Le Gruyère AOP']);
    expect(offers[0].category).toBe('An der Bedientheke');
  });

  it('reine Sektionsüberschrift mit fremdem Preis wird kein Angebot', () => {
    const { offers } = collect('<section><h2>An der Bedientheke</h2><span>2,49 €</span></section>');
    expect(offers).toHaveLength(0);
  });

  it('Karte ohne Namen → no_name, kein Angebot', () => {
    const { offers, diagnostics } = collect(
      '<section><h2>Snacks</h2><article><a href="/p/x"><img alt="X"></a><span>0,99 €</span></article></section>',
    );
    expect(offers).toHaveLength(0);
    expect(diagnostics.rejected.noName).toBe(1);
  });

  it('Karte ohne gültigen Angebotspreis (nur Grundpreis) → no_price, kein Angebot', () => {
    const { offers, diagnostics } = collect(
      '<section><h2>Käse</h2><article><a href="/p/y"><img alt="Gruyère"></a>' +
        '<div>Le Gruyère AOP</div><span>(100 g = 2,49 €)</span></article></section>',
    );
    expect(offers).toHaveLength(0);
    expect(diagnostics.rejected.noPrice).toBe(1);
  });

  it('wiederholt sichtbare Karte beim Scrollen wird nur einmal übernommen', () => {
    const { offers, diagnostics } = collect(
      '<section><h2>Obst</h2><article><a href="/p/banane"><img alt="Bananen"></a>' +
        '<div>Bananen</div><span>1,79 €</span></article></section>',
      3, // drei Scroll-Durchläufe
    );
    expect(names(offers)).toEqual(['Bananen']);
    expect(diagnostics.observedCardOccurrences).toBe(3);
    expect(diagnostics.uniqueCardCandidates).toBe(1);
    expect(diagnostics.repeatedCardObservations).toBe(2);
    expectBalanced(diagnostics);
  });

  it('virtualisierte Karten mit gleichem Text, aber unterschiedlicher Identität bleiben getrennt', () => {
    const { offers } = collect(
      '<section><h2>Obst</h2>' +
        '<article><a href="/p/apfel-rot"><img alt="Apfel"></a><div>Äpfel</div><span>1,99 €</span></article>' +
        '<article><a href="/p/apfel-gruen"><img alt="Apfel"></a><div>Äpfel</div><span>1,99 €</span></article>' +
        '</section>',
    );
    // gleicher Text, aber zwei verschiedene Produkt-Links → zwei Kandidaten
    expect(offers).toHaveLength(2);
    expect(offers[0].sourceUrl).not.toBe(offers[1].sourceUrl);
  });

  it('Dedupe derselben Karte (identischer Text + Identität) → eine Karte, als Wiederholung gezählt', () => {
    const { offers, diagnostics } = collect(
      '<section><h2>Obst</h2>' +
        '<article><a href="/p/banane"><img alt="Bananen"></a><div>Bananen</div><span>1,79 €</span></article>' +
        '<article><a href="/p/banane"><img alt="Bananen"></a><div>Bananen</div><span>1,79 €</span></article>' +
        '</section>',
    );
    // identischer Text + identische Identität ⇒ dieselbe Karte (Wiederholung),
    // kein Angebots-Duplikat.
    expect(names(offers)).toEqual(['Bananen']);
    expect(diagnostics.repeatedCardObservations).toBe(1);
    expect(diagnostics.uniqueCardCandidates).toBe(1);
    expectBalanced(diagnostics);
  });

  it('Angebots-Duplikat: gleiches Produkt, anderes Markup (Promo-Badge) → ein Angebot, 1 offerDuplicate', () => {
    const { offers, diagnostics } = collect(
      '<section><h2>Obst</h2>' +
        '<article><a href="/p/banane"><img alt="Bananen"></a><div>Bananen</div><span>1,79 €</span></article>' +
        '<article><a href="/p/banane"><img alt="Bananen"></a><div>Knaller</div><div>Bananen</div><span>1,79 €</span></article>' +
        '</section>',
    );
    // zwei verschiedene Karten (unterschiedlicher Text), aber dasselbe Angebot
    // (Name/Preis/Identität) ⇒ ein Offer, ein offerDuplicate.
    expect(names(offers)).toEqual(['Bananen']);
    expect(diagnostics.uniqueCardCandidates).toBe(2);
    expect(diagnostics.browserOfferDuplicates).toBe(1);
    expectBalanced(diagnostics);
  });

  it('P2: ein Produkt-h3 ist KEINE Section-Kategorie (Nachbarprodukt bleibt aus)', () => {
    // Beide Produktnamen sind h3 (wie auf der echten REWE-Seite). Der h3 des
    // ersten Produkts darf nicht zur Kategorie des zweiten werden.
    const { offers } = collect(
      '<section><h3>Mars m&amp;m’s</h3><span>1,99 €</span></section>' +
        '<section><h3>Butcher’s Sauce</h3><span>2,49 €</span></section>',
    );
    const byName = new Map(offers.map((o) => [o.name, o.category]));
    expect(byName.get('Butcher’s Sauce')).toBe(''); // NICHT "Mars m&m’s"
    expect(byName.get('Mars m&m’s')).toBe('');
  });

  it('P2: echte Section-Überschrift wird korrekt zugeordnet, Produkt-h3 ignoriert', () => {
    const { offers } = collect(
      '<section><h2>Tiefkühl</h2>' +
        '<article><a href="/p/pizza"><img alt="Pizza"></a><h3>Dr. Oetker Pizza</h3><span>2,99 €</span></article>' +
        '<article><a href="/p/eis"><img alt="Eis"></a><h3>Ben &amp; Jerry’s</h3><span>3,49 €</span></article>' +
        '</section>',
    );
    const byName = new Map(offers.map((o) => [o.name, o.category]));
    // beide bekommen die echte Section, nicht den Namen des Nachbarprodukts
    expect(byName.get('Dr. Oetker Pizza')).toBe('Tiefkühl');
    expect(byName.get('Ben & Jerry’s')).toBe('Tiefkühl');
  });

  it('P2: keine sichere Section über der Karte → leere Kategorie (kein Nachbar)', () => {
    const { offers } = collect(
      '<div><article><a href="/p/x"><img alt="X"></a><div>Frosta Pfanne</div><span>2,99 €</span></article></div>',
    );
    expect(offers).toHaveLength(1);
    expect(offers[0].category).toBe('');
  });

  it('P6: javascript:-Produktlink wird NICHT als sourceUrl gespeichert (Fallback pageUrl)', () => {
    const dom = new JSDOM(
      '<!doctype html><html><body><section><h2>Obst</h2>' +
        '<article><a href="javascript:;"><img alt="Bananen"></a><div>Bananen</div><span>1,79 €</span></article>' +
        '</section></body></html>',
      { url: 'https://www.rewe.de/angebote/nationale-angebote/' },
    );
    const collector = createReweDomCollector({
      isVisible: () => true,
      pageUrl: 'https://www.rewe.de/angebote/nationale-angebote/',
    });
    collector.collect(dom.window.document as unknown as ReweDomDocument);
    const { offers } = collector.result();
    expect(offers).toHaveLength(1);
    expect(offers[0].sourceUrl).toBe('https://www.rewe.de/angebote/nationale-angebote/');
    expect(offers[0].sourceUrl).not.toMatch(/javascript:/);
  });

  it('vollständige Zählbilanzen über eine gemischte Seite', () => {
    const { offers, diagnostics } = collect(
      '<main>' +
        // Sektion mit echten Karten
        '<section><h2>Obst und Gemüse</h2><div class="tiles">' +
        '<article><a href="/p/banane"><img alt="Bananen"></a><div>Bananen</div><span>1,79 €</span><span>(1 kg = 1,79 €)</span></article>' +
        '<article><a href="/p/tomate"><img alt="Tomaten"></a><div>Rispentomaten</div><span>0,99 €</span></article>' +
        '</div></section>' +
        // Bonus-Tile ohne echten Preis (no_price)
        '<section><h2>Bonus</h2><article><div>Treuepunkte App</div><span>0,50 €</span></article></section>' +
        // Karte ohne Namen (no_name)
        '<section><h2>Snacks</h2><article><a href="/p/z"><img alt="Z"></a><span>2,49 €</span></article></section>' +
        '</main>',
      2,
    );
    expect(names(offers).sort()).toEqual(['Bananen', 'Rispentomaten']);

    const d = diagnostics;
    const rejectedTotal =
      d.rejected.noPrice + d.rejected.noName + d.rejected.sectionHeading + d.rejected.extractionError;
    // observed = unique + repeated
    expect(d.observedCardOccurrences).toBe(d.uniqueCardCandidates + d.repeatedCardObservations);
    // unique = acceptedBeforeDedupe + rejected
    expect(d.uniqueCardCandidates).toBe(d.browserAcceptedBeforeDedupe + rejectedTotal);
    // acceptedBeforeDedupe = payloadOffers + offerDuplicates
    expect(d.browserAcceptedBeforeDedupe).toBe(d.payloadOffers + d.browserOfferDuplicates);
    // payloadOffers entspricht den tatsächlich emittierten Offers
    expect(d.payloadOffers).toBe(offers.length);
    // webCardCount = einzigartige strukturelle Kandidaten
    expect(d.domPriceCards).toBe(d.uniqueCardCandidates);
    expectBalanced(d);
    // mind. ein no_price (Bonus) und ein no_name (Karte ohne Namen)
    expect(d.rejected.noPrice).toBeGreaterThanOrEqual(1);
    expect(d.rejected.noName).toBeGreaterThanOrEqual(1);
  });
});
