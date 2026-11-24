import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  createReweDomCollector,
  pickReweCardPrice,
  reweAttributePriceLines,
  reweReassembleSplitPrices,
  type ReweCollectedOffer,
  type ReweDomDocument,
  type ReweDomElement,
} from './reweBrowserImport';

// P1 — strukturelle Preisextraktion: Verkaufspreis aus getrennten Euro-/Cent-
// DOM-Knoten zusammensetzen und aus semantischen Attributen lesen, ohne je einen
// Grundpreis als Angebotspreis zu verwenden oder einen Preis zu erfinden.
// Konkrete Produktnamen kommen ausschließlich hier in den Fixtures vor.

function collect(html: string): ReweCollectedOffer[] {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: 'https://www.rewe.de/angebote/nationale-angebote/',
  });
  const doc = dom.window.document as unknown as ReweDomDocument;
  const collector = createReweDomCollector({
    isVisible: () => true,
    pageUrl: 'https://www.rewe.de/angebote/nationale-angebote/',
  });
  collector.collect(doc);
  return collector.result().offers;
}

describe('reweReassembleSplitPrices — getrennte Euro/Cent-Knoten (P1)', () => {
  it('setzt "6" / "99" / "€" zu 6,99 zusammen, ignoriert den Grundpreis', () => {
    const lines = ['Senseo Pads', '6', '99', '€', '(1 kg = 22,43 €)'];
    expect(pickReweCardPrice(reweReassembleSplitPrices(lines).join('\n'))).toBe('6,99');
  });

  it('setzt eine einzeilige "5 49 €"-Form zusammen', () => {
    expect(pickReweCardPrice('Jacobs Krönung\n5 49 €')).toBe('5,49');
  });

  it('ein getrennter Streichpreis wird nicht zum Angebot — der Aktionspreis gewinnt', () => {
    const lines = ['Philadelphia', 'statt', '2', '99', '€', '1', '99', '€'];
    expect(pickReweCardPrice(reweReassembleSplitPrices(lines).join('\n'))).toBe('1,99');
  });

  it('ohne Währungsnachweis werden zwei nackte Zahlen NICHT zu einem Preis', () => {
    // "6" (Packungsgröße) und "99" (Gramm) ohne € dürfen nichts erfinden.
    expect(reweReassembleSplitPrices(['Dr. Oetker', '6', '99', '250 g'])).toEqual([
      'Dr. Oetker',
      '6',
      '99',
      '250 g',
    ]);
  });

  it('nur ein Grundpreis bleibt ehrlich ohne Angebotspreis', () => {
    expect(pickReweCardPrice('Le Gruyère AOP\n(100 g = 2,49 €)')).toBe('');
  });
});

describe('reweAttributePriceLines — Preis nur im aria-label/data-Attribut (P1)', () => {
  it('liest den Verkaufspreis aus aria-label, überspringt den Grundpreis', () => {
    const dom = new JSDOM(
      '<body><article aria-label="Philadelphia Frischkäse jetzt 2,49 €">' +
        '<div>Philadelphia Frischkäse</div><span>(100 g = 1,66 €)</span></article></body>',
    );
    const article = dom.window.document.querySelector('article') as unknown as ReweDomElement;
    expect(reweAttributePriceLines(article)).toEqual(['2,49 €']);
  });

  it('ein Grundpreis im Attribut wird nicht als Angebotspreis gelesen', () => {
    const dom = new JSDOM(
      '<body><article aria-label="Butter (1 kg = 22,43 €)"><div>Butter</div></article></body>',
    );
    const article = dom.window.document.querySelector('article') as unknown as ReweDomElement;
    expect(reweAttributePriceLines(article)).toEqual([]);
  });
});

describe('createReweDomCollector — Preis strukturell zugeordnet (P1)', () => {
  it('Verkaufspreis in einem Geschwisterelement', () => {
    const offers = collect(
      '<section><h2>Kühlung</h2><article><a href="/p/a"><img alt="A"></a>' +
        '<div>Senseo Pads</div><div class="price-wrap"><span>6,99 €</span></div>' +
        '<span>(1 kg = 22,43 €)</span></article></section>',
    );
    expect(offers.map((o) => o.name)).toEqual(['Senseo Pads']);
    expect(offers[0].price).toBe('6,99');
  });

  it('getrennte Euro-/Cent-Elemente → ein Angebot mit zusammengesetztem Preis', () => {
    const offers = collect(
      '<section><h2>Kühlung</h2><article><a href="/p/b"><img alt="B"></a>' +
        '<div>Jacobs Krönung</div><span>5</span><span>49</span><span>€</span>' +
        '<span>(1 kg = 11,98 €)</span></article></section>',
    );
    expect(offers.map((o) => o.name)).toEqual(['Jacobs Krönung']);
    expect(offers[0].price).toBe('5,49');
  });

  it('Verkaufspreis nur im aria-label, sichtbar nur der Grundpreis', () => {
    const offers = collect(
      '<section><h2>Kühlung</h2><article aria-label="Philadelphia Frischkäse 2,49 €">' +
        '<a href="/p/c"><img alt="C"></a><div>Philadelphia Frischkäse</div>' +
        '<span>(100 g = 1,66 €)</span></article></section>',
    );
    expect(offers.map((o) => o.name)).toEqual(['Philadelphia Frischkäse']);
    expect(offers[0].price).toBe('2,49');
  });

  it('echte Karte mit ausschließlich Grundpreis bleibt ehrlich no_price', () => {
    const dom = new JSDOM(
      '<!doctype html><html><body><section><h2>Käse</h2>' +
        '<article><a href="/p/d"><img alt="D"></a><div>Dr. Oetker Pizza</div>' +
        '<span>(1 kg = 7,12 €)</span></article></section></body></html>',
      { url: 'https://www.rewe.de/angebote/nationale-angebote/' },
    );
    const doc = dom.window.document as unknown as ReweDomDocument;
    const collector = createReweDomCollector({ isVisible: () => true });
    collector.collect(doc);
    const { offers, diagnostics } = collector.result();
    expect(offers).toHaveLength(0);
    expect(diagnostics.rejected.noPrice).toBe(1);
  });
});
