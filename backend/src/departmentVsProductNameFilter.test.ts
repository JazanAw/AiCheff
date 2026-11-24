import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { classifyFoodDecision } from './foodDecision';
import {
  hasHardNonFoodSignal,
  hasRuleConfirmedNonFoodSignal,
  hasStrongFoodSignal,
  isStrictNonFoodOffer,
} from './offersStrictFoodFilter';

// Audit des Snapshots vom 2026-08-17 (1287 live / 78 nächste Woche / 942
// gefiltert). Auf BEIDEN Seiten des Food-/Non-Food-Filters lagen falsche
// Einträge. Vier unabhängige Ursachen — alle im selben Muster: ein SCHWACHER
// Beleg (Teilstring, Händler-Abteilung) schlug einen STARKEN (den Produktnamen).
//
//   A) Teilstring-Keywords trafen mitten in echten Lebensmittelnamen:
//        'regal'      → „CHIVAS REGAL Blended Scotch Whisky"  (Möbelstück)
//        'dusch'      → „EDUSCHO Lieblingskaffee"             (e-DUSCH-o)
//        'mikrowelle' → „¡QUE VIVA ESPAÑA! Mikrowellengericht"(Gerät)
//   B) Das Botanik-Kombi-Signal (Blütenwort + Topf/Bund) las das Blütenwort aus
//      Kauflands GEMISCHTER Abteilung „Obst, Gemüse, Pflanzen". Jedes bundweise
//      verkaufte Gemüse wurde damit zur Zierpflanze → „Dtsch. Lauchzwiebeln"
//      (Bund, 0,59 €) lag im Non-Food-Bucket.
//   C) Der Python-Categorizer matchte Non-Food-Keywords auf Titel + Marke +
//      Abteilung ZUSAMMEN. Kauflands kombinierte Abteilung „Drogerie,
//      Tiernahrung" belegte damit ALLE 47 Angebote des Regals mit
//      `nonfood_kw:tiernahrung` (Konfidenz 0,99) — auch „ESN Isoclear
//      Whey-Protein", „KORO Proteinriegel" und „APTAMIL Folgemilch 2 oder 3".
//   D) Umgekehrte Richtung: echte Zierpflanzen und ein Malspielzeug standen live
//      im Food-Feed („Rose" 14,99 €, „Korbmaranthe", „Glattblattaster Trio",
//      „Wasser-/ Zaubermalspaß").
//
// Produktnamen sind reine Reproduktions-Fixtures aus dem echten Lauf — der
// Produktivcode kennt keine Produkt-/Marken-Allowlist.

function offer(name: string, extra: Partial<Offer> & Record<string, unknown> = {}): Offer {
  return {
    id: `fixture_${name.replace(/\W+/g, '_').toLowerCase()}`,
    name,
    normalizedName: name.toLowerCase(),
    storeChain: 'Kaufland',
    category: 'Sonstiges',
    price: 1.99,
    currency: 'EUR',
    unit: 'stk',
    validityStart: '2026-08-17T00:00:00.000Z',
    validityEnd: '2026-08-23T23:59:59.999Z',
    sourceUrl: 'https://filiale.kaufland.de/angebote/aktuelle-woche.html',
    tags: [],
    createdAt: '2026-08-17T04:41:48.972Z',
    ...extra,
  } as Offer;
}

describe('A) Teilstring-Keywords dürfen nicht in Lebensmittelnamen treffen', () => {
  it('„CHIVAS REGAL" ist ein Whisky, kein Regal', () => {
    const whisky = offer('CHIVAS REGAL Blended Scotch Whisky', {
      category: 'Alkohol',
      unit: '0,7-l-fl.',
      price: 22.99,
      sourceCategoryRaw: 'Getränke, Spirituosen',
      canonicalCategory: {
        main: 'Alkohol',
        sub: 'Spirituosen',
        isNonFood: false,
        confidence: 0.93,
        reasons: ['rescue_kw:whisky', 'rescue:alcohol'],
      },
    });
    expect(hasRuleConfirmedNonFoodSignal(whisky)).toBe(false);
    expect(classifyFoodDecision(whisky)).toBe('confirmed_food');
  });

  it('das Möbel-Kompositum bleibt Non-Food', () => {
    for (const name of ['LIV&BO® Badezimmer-Korbregal', 'Anbau-Regal', 'Steckregal 5 Böden']) {
      expect(isStrictNonFoodOffer(offer(name))).toBe(true);
    }
  });

  it('ein Weinregal bleibt trotz Getränke-Kontext ein Möbelstück', () => {
    const shelf = offer('Weinregal für 12 Flaschen', { category: 'Alkohol', unit: '0,75-l-fl.' });
    expect(isStrictNonFoodOffer(shelf)).toBe(true);
  });

  it('„EDUSCHO" ist eine Kaffeemarke, kein Duschprodukt', () => {
    const coffee = offer('EDUSCHO Lieblingskaffee', {
      category: 'Getränke Alkoholfrei',
      unit: '500-g-packg.',
      price: 5.49,
      sourceCategoryRaw: 'Kaffee, Tee, Süßwaren, Knabberartikel',
      canonicalCategory: {
        main: 'Getränke alkoholfrei',
        sub: 'Kaffee & Tee',
        isNonFood: false,
        confidence: 0.93,
        reasons: ['rescue_kw:kaffee', 'rescue:drinks'],
      },
    });
    expect(hasRuleConfirmedNonFoodSignal(coffee)).toBe(false);
    expect(classifyFoodDecision(coffee)).toBe('confirmed_food');
  });

  it('„dusch" am Wortanfang bleibt Non-Food', () => {
    for (const name of ['Dusch-Wassersparer', 'Duschsystem Premium', 'DUSCHDAS Duschgel XXXL']) {
      expect(isStrictNonFoodOffer(offer(name))).toBe(true);
    }
  });

  it('ein Gerätewort vor einem Speisen-Kopf beschreibt eine SPEISE', () => {
    const dish = offer('¡QUE VIVA ESPAÑA! Mikrowellengericht', {
      storeChain: 'PENNY',
      category: 'Konserven',
      unit: '280g',
      sourceCategoryRaw: 'que-viva-espana',
    });
    expect(isStrictNonFoodOffer(dish)).toBe(false);
    expect(hasStrongFoodSignal(dish)).toBe(true);
    expect(classifyFoodDecision(dish)).toBe('confirmed_food');
  });

  it('das Gerät selbst bleibt Non-Food', () => {
    for (const name of ['SILVERCREST® Mikrowelle', 'SWITCH ON® Mikrowelle »SMWH 700«']) {
      expect(isStrictNonFoodOffer(offer(name))).toBe(true);
    }
  });
});

describe('B) Eine gemischte Abteilung macht Gemüse nicht zur Zierpflanze', () => {
  const producePlantsAisle = {
    category: 'Obst/Gemüse',
    sourceCategoryRaw: 'Obst, Gemüse, Pflanzen',
  };

  it('bundweise verkauftes Gemüse bleibt Food', () => {
    const springOnions = offer('Dtsch. Lauchzwiebeln', {
      ...producePlantsAisle,
      unit: 'bund',
      price: 0.59,
      canonicalCategory: {
        main: 'Obst & Gemüse',
        sub: 'Gemüse',
        isNonFood: false,
        confidence: 0.9,
        reasons: ['llm'],
      },
    });
    expect(hasRuleConfirmedNonFoodSignal(springOnions)).toBe(false);
    expect(classifyFoodDecision(springOnions)).toBe('confirmed_food');
  });

  it('echte Zierpflanzen in derselben Abteilung bleiben Non-Food', () => {
    for (const name of [
      'Rose',
      'Korbmaranthe',
      'Glattblattaster Trio',
      'Sommerblumen',
      'Rispen Hortensie',
      'Chrysantheme',
      'Blumenstrauß »My Time«',
      'Orchidee',
      'Pflanzenauswahl im Pottburri',
    ]) {
      const plant = offer(name, { ...producePlantsAisle, unit: 'je', price: 5.99 });
      expect(classifyFoodDecision(plant), name).toBe('confirmed_non_food');
    }
  });

  it('essbare Wortstämme mit Blumen-/Rosen-Präfix bleiben Food', () => {
    for (const name of ['Rosenkohl', 'Blumenkohl', 'Sonnenblumenöl', 'Sonnenblumenkerne', 'Rosinen']) {
      const food = offer(name, { ...producePlantsAisle, unit: '500g' });
      expect(hasRuleConfirmedNonFoodSignal(food), name).toBe(false);
    }
  });

  it('„Rosé" im Getränke-Kontext bleibt Alkohol', () => {
    const wine = offer('Rosé', { category: 'Alkohol', unit: '0,75-l-fl.', price: 4.99 });
    expect(hasRuleConfirmedNonFoodSignal(wine)).toBe(false);
  });
});

describe('C) Eine Händler-Abteilung ist eine Regalzuordnung, keine Warenart', () => {
  const drugstoreAisle = {
    category: 'Sonstiges',
    sourceCategoryRaw: 'Drogerie, Tiernahrung',
    tags: ['reduziert', 'nonfood'],
  };

  // Der Python-Categorizer belegte JEDES Angebot dieses Regals mit
  // `nonfood_kw:tiernahrung` — das Keyword steht nirgends im Produktnamen.
  const departmentOnlyVerdict = {
    main: 'Non-Food',
    sub: 'Haustier',
    isNonFood: true,
    confidence: 0.99,
    reasons: ['nonfood_kw:tiernahrung'],
  };

  it('eindeutig essbare Warenarten überstimmen die Abteilung', () => {
    for (const [name, unit] of [
      ['ESN Isoclear Whey-Protein', '300-g-packg.'],
      ['KORO Proteinriegel', '55-g-riegel'],
      ['APTAMIL Folgemilch 2 oder 3', '800-g-packg.'],
    ] as const) {
      const food = offer(name, {
        ...drugstoreAisle,
        unit,
        canonicalCategory: departmentOnlyVerdict,
      });
      expect(hasRuleConfirmedNonFoodSignal(food), name).toBe(false);
      expect(classifyFoodDecision(food), name).toBe('confirmed_food');
    }
  });

  it('der Rest desselben Regals bleibt Non-Food', () => {
    for (const name of [
      'PANTENE PRO-V Shampoo',
      'ODOL-MED3 Zahncreme XXL',
      'ALWAYS Slipeinlagen',
      'ANIMONDA »GranCarno« Hundenahrung',
      'VITAKRAFT Hundesnack',
      'DREAMIES oder WHISKAS Katzensnack',
      'MEISTER PROPER Allzweckreiniger',
      'ORAL-B Elektrische Zahnbürste iO Series 2',
    ]) {
      const nonFood = offer(name, {
        ...drugstoreAisle,
        canonicalCategory: departmentOnlyVerdict,
      });
      expect(classifyFoodDecision(nonFood), name).toBe('confirmed_non_food');
    }
  });

  it('ein Keyword, das WIRKLICH im Namen steht, entscheidet weiterhin hart', () => {
    const petFood = offer('Felix Katzennahrung', {
      category: 'Sonstiges',
      sourceCategoryRaw: 'Bonus-Aktionen',
      canonicalCategory: {
        main: 'Non-Food',
        sub: 'Haustier',
        isNonFood: true,
        confidence: 0.99,
        reasons: ['nonfood_kw:katzennahrung'],
      },
    });
    expect(hasRuleConfirmedNonFoodSignal(petFood)).toBe(true);
    expect(classifyFoodDecision(petFood)).toBe('confirmed_non_food');
  });

  it('Tiernahrung im Namen schlägt das essbare Vokabular', () => {
    const petFood = offer('Katzen-Trockenfutter mit Schokolade', {
      sourceCategoryRaw: 'Drogerie, Tiernahrung',
    });
    expect(hasHardNonFoodSignal(petFood)).toBe(true);
  });
});

describe('D) Non-Food im sichtbaren Food-Feed', () => {
  it('ein Malspielzeug wird nicht über das Wort „Wasser" zum Getränk', () => {
    const toy = offer('Wasser-/ Zaubermalspaß', {
      storeChain: 'NORMA',
      category: 'Getränke Alkoholfrei',
      unit: 'stk',
      price: 5.99,
      sourceCategoryRaw: 'NORMA Angebote',
      canonicalCategory: {
        main: 'Getränke alkoholfrei',
        sub: 'Wasser',
        isNonFood: false,
        confidence: 0.93,
        reasons: ['rescue_kw:wasser', 'rescue:drinks'],
      },
    });
    expect(classifyFoodDecision(toy)).toBe('confirmed_non_food');
  });

  it('echtes Wasser bleibt ein Getränk', () => {
    const water = offer('LÖWENSTEINER SPORT Mineralwasser', {
      category: 'Getränke Alkoholfrei',
      unit: '12x0,7l',
    });
    expect(hasRuleConfirmedNonFoodSignal(water)).toBe(false);
    expect(hasStrongFoodSignal(water)).toBe(true);
  });

  it('Körperpflege-Klassen werden ohne Abteilungs-Beleg erkannt', () => {
    for (const name of [
      'ORAL-B Elektrische Zahnbürste Vitality Pro',
      'ALWAYS Damenbinden',
      'LISTERINE Mundspülung',
      'BLEND-A-DENT Haftcreme Extra Stark',
      'GARNIER Olia dauerhafte Haarfarbe',
    ]) {
      const careItem = offer(name, { sourceCategoryRaw: 'Alles für deine Pflege' });
      expect(isStrictNonFoodOffer(careItem), name).toBe(true);
    }
  });
});
