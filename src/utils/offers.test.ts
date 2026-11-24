import { describe, expect, it } from 'vitest';
import { Offer } from '../types/models';
import {
  dedupeOffersByBestPrice,
  isLikelyFoodOffer,
  isOfferInCurrentWeek,
  normalizeText,
} from './offers';

function baseOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: 'offer_test',
    name: 'Test',
    normalizedName: 'test',
    storeChain: 'Aldi',
    category: 'Trockenware',
    price: 1,
    currency: 'EUR',
    unit: 'stk',
    validityStart: '2026-02-02T00:00:00.000Z',
    validityEnd: '2026-02-08T00:00:00.000Z',
    sourceUrl: 'https://example.org',
    tags: [],
    createdAt: '2026-02-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('isOfferInCurrentWeek', () => {
  it('behandelt den validityEnd Tag inklusiv', () => {
    const offer = baseOffer();
    const onEndDateAfternoon = new Date('2026-02-08T15:30:00.000Z');

    expect(isOfferInCurrentWeek(offer, onEndDateAfternoon)).toBe(true);
  });

  it('filtert Tage nach dem validityEnd korrekt aus', () => {
    const offer = baseOffer();
    const afterRange = new Date('2026-02-09T00:00:00.000Z');

    expect(isOfferInCurrentWeek(offer, afterRange)).toBe(false);
  });
});

describe('normalizeText', () => {
  it('repariert haeufige mojibake Sequenzen fuer Umlaute', () => {
    expect(normalizeText('Bergner KÃ¼chenmaschine')).toContain('kuechenmaschine');
  });
});

describe('dedupeOffersByBestPrice', () => {
  it('zeigt bei gleichen Produkten nur das guenstigste Angebot', () => {
    const offers = [
      baseOffer({
        id: 'offer_a',
        storeChain: 'Aldi',
        normalizedName: 'tomatenmark',
        name: 'Tomatenmark',
        unit: '200g',
        price: 0.59,
      }),
      baseOffer({
        id: 'offer_b',
        storeChain: 'Rewe',
        normalizedName: 'tomatenmark',
        name: 'Tomatenmark',
        unit: '200g',
        price: 0.69,
      }),
      baseOffer({
        id: 'offer_c',
        storeChain: 'Lidl',
        normalizedName: 'tomatenmark',
        name: 'Tomatenmark',
        unit: '200g',
        price: 0.55,
      }),
      baseOffer({
        id: 'offer_d',
        storeChain: 'Aldi',
        normalizedName: 'basmatireis',
        name: 'Basmatireis',
        unit: '1kg',
        price: 2.79,
      }),
    ];

    const deduped = dedupeOffersByBestPrice(offers);
    expect(deduped).toHaveLength(2);
    const tomato = deduped.find((offer) => offer.normalizedName === 'tomatenmark');
    expect(tomato?.price).toBe(0.55);
    expect(tomato?.storeChain).toBe('Lidl');
  });
});

describe('isLikelyFoodOffer', () => {
  it('erkennt klassische Lebensmittel sicher', () => {
    const offer = baseOffer({
      name: 'Bio Bananen',
      normalizedName: 'bio bananen',
      category: 'Obst/Gemuese',
      unit: 'kg',
    });

    expect(isLikelyFoodOffer(offer)).toBe(true);
  });

  it('filtert offensichtliche Nicht-Lebensmittel aus', () => {
    const offer = baseOffer({
      name: 'Anti-Schuppen Shampoo',
      normalizedName: 'anti schuppen shampoo',
      category: 'Sonstiges',
      unit: '250ml',
    });

    expect(isLikelyFoodOffer(offer)).toBe(false);
  });

  it('filtert auch Geraete und Auto-Produkte aus', () => {
    const kettle = baseOffer({
      name: 'Premium Wasserkocher',
      normalizedName: 'premium wasserkocher',
      category: 'Sonstiges',
      unit: 'stk',
    });
    const motorOil = baseOffer({
      name: 'Motoroel 5W-30',
      normalizedName: 'motoroel 5w 30',
      category: 'Sonstiges',
      unit: '1l',
    });
    const petFood = baseOffer({
      name: 'Hundefutter Rind',
      normalizedName: 'hundefutter rind',
      category: 'Tiernahrung',
      unit: '1kg',
    });

    expect(isLikelyFoodOffer(kettle)).toBe(false);
    expect(isLikelyFoodOffer(motorOil)).toBe(false);
    expect(isLikelyFoodOffer(petFood)).toBe(false);
  });

  it('filtert auch konkrete Leaks aus dem Live-Export', () => {
    const bodyCare = baseOffer({
      name: 'Nivea Dusche',
      normalizedName: 'nivea dusche',
      category: 'Koerperpflege/Duschprodukte',
      unit: '250ml',
    });
    const engineOil = baseOffer({
      name: 'Liqui Moly Motorenoel 5W30 Nr. 1 Longlife III',
      normalizedName: 'liqui moly motorenoel 5w30 nr 1 longlife iii',
      category: 'Oel',
      unit: '1l',
    });
    const petFoodBrand = baseOffer({
      name: 'Purina Beneful Hundevollnahrung',
      normalizedName: 'purina beneful hundevollnahrung',
      category: 'Fleischwaren',
      unit: '1kg',
    });
    const giftSet = baseOffer({
      name: 'Kneipp Geschenkset Wellness Liebling',
      normalizedName: 'kneipp geschenkset wellness liebling',
      category: 'Wellness',
      unit: 'stk',
    });
    const cleaner = baseOffer({
      name: 'Febreze 3Volution Nachfuellflakon',
      normalizedName: 'febreze 3volution nachfuellflakon',
      category: 'Reinigungsmittel',
      unit: 'stk',
    });
    const catFood = baseOffer({
      name: 'Whiskas Classic Meals',
      normalizedName: 'whiskas classic meals',
      category: 'Fertiggerichte',
      unit: '85g',
    });
    const kitchenScale = baseOffer({
      name: 'Blaumann Kuechenwaage',
      normalizedName: 'blaumann kuechenwaage',
      category: 'Backwaren',
      unit: 'stk',
    });
    const bubbleBath = baseOffer({
      name: 'Tetesept Kids Schaumbad',
      normalizedName: 'tetesept kids schaumbad',
      category: 'Sonstiges',
      unit: 'stk',
    });
    const kitchenTowels = baseOffer({
      name: 'Floralys Kuechentuecher XXL',
      normalizedName: 'floralys kuechentuecher xxl',
      category: 'Backwaren',
      unit: 'stk',
    });
    const bodyMilk = baseOffer({
      name: 'Nivea Bodymilk',
      normalizedName: 'nivea bodymilk',
      category: 'Sonstiges',
      unit: 'stk',
    });
    const immuneShot = baseOffer({
      name: 'Tetesept Immun Aktiv Shot',
      normalizedName: 'tetesept immun aktiv shot',
      category: 'Sonstiges',
      unit: '60ml',
    });

    expect(isLikelyFoodOffer(bodyCare)).toBe(false);
    expect(isLikelyFoodOffer(engineOil)).toBe(false);
    expect(isLikelyFoodOffer(petFoodBrand)).toBe(false);
    expect(isLikelyFoodOffer(giftSet)).toBe(false);
    expect(isLikelyFoodOffer(cleaner)).toBe(false);
    expect(isLikelyFoodOffer(catFood)).toBe(false);
    expect(isLikelyFoodOffer(kitchenScale)).toBe(false);
    expect(isLikelyFoodOffer(bubbleBath)).toBe(false);
    expect(isLikelyFoodOffer(kitchenTowels)).toBe(false);
    expect(isLikelyFoodOffer(bodyMilk)).toBe(false);
    expect(isLikelyFoodOffer(immuneShot)).toBe(false);
  });

  it('filtert aktuelle Live-Leaks (Hygienestreu, Kuechenmaschine, Kaffeepadmaschine) aus', () => {
    const catLitter = baseOffer({
      name: 'Catsan Hygienestreu',
      normalizedName: 'catsan hygienestreu',
      category: 'Sonstiges',
      unit: '18l',
    });
    const kitchenMachine = baseOffer({
      name: 'Bergner KÃ¼chenmaschine BG-51571-CR',
      normalizedName: 'bergner ka14chenmaschine bg-51571-cr',
      category: 'Backwaren',
      unit: 'stk',
    });
    const coffeePadMachine = baseOffer({
      name: 'Philips Senseo Original Eco Kaffeepadmaschine HD7806/50',
      normalizedName: 'philips senseo original eco kaffeepadmaschine hd7806 50',
      category: 'Getraenke Alkoholfrei',
      unit: 'stk',
    });
    const airFreshener = baseOffer({
      name: 'Lufterfrischer-Nachfueller',
      normalizedName: 'lufterfrischer-nachfueller',
      category: 'Sonstiges',
      unit: '250-ml-flasche',
    });
    const dogFood = baseOffer({
      name: 'JOSI DOG Hundenahrung',
      normalizedName: 'josi dog hundenahrung',
      category: 'Sonstiges',
      unit: '10-kg-packung',
    });

    expect(isLikelyFoodOffer(catLitter)).toBe(false);
    expect(isLikelyFoodOffer(kitchenMachine)).toBe(false);
    expect(isLikelyFoodOffer(coffeePadMachine)).toBe(false);
    expect(isLikelyFoodOffer(airFreshener)).toBe(false);
    expect(isLikelyFoodOffer(dogFood)).toBe(false);
  });

  it('filtert Haushaltspapier trotz Food-Hints aus', () => {
    const kitchenRoll = baseOffer({
      name: 'Cafe Royal Kuechenrolle Crema',
      normalizedName: 'cafe royal kuechenrolle crema',
      category: 'Backwaren',
      unit: '3 Rollen',
    });
    const serviettes = baseOffer({
      name: 'Deko Servietten',
      normalizedName: 'deko servietten',
      category: 'Sonstiges',
      unit: '20 Stueck',
    });

    expect(isLikelyFoodOffer(kitchenRoll)).toBe(false);
    expect(isLikelyFoodOffer(serviettes)).toBe(false);
  });

  it('laesst aktuelle Sonstiges-Lebensmittel durch', () => {
    const sauce = baseOffer({
      name: 'Mojo-Sauce / Aioli',
      normalizedName: 'mojo-sauce aioli',
      category: 'Sonstiges',
      unit: '250-ml-glas',
    });
    const spargel = baseOffer({
      name: 'Spargel',
      normalizedName: 'spargel',
      category: 'Sonstiges',
      unit: '500-g-bund',
    });
    const artichokes = baseOffer({
      name: 'Artischockenviertel Mix 370 ml, Mariniert',
      normalizedName: 'artischockenviertel mix 370 ml mariniert',
      category: 'Sonstiges',
      unit: '0,2kg/atg',
    });
    const milkAlternative = baseOffer({
      name: 'Not M*lk Drink',
      normalizedName: 'not mlk drink',
      category: 'Sonstiges',
      unit: '1-l-packung',
    });
    const wine = baseOffer({
      name: 'Gewuerztraminer Weissburgunder Pfalz QbA',
      normalizedName: 'gewuerztraminer weissburgunder pfalz qba',
      category: 'Sonstiges',
      unit: '0,75-l-flasche',
    });
    const alcoholFreeBeer = baseOffer({
      name: '0,0 %',
      brand: 'KROMBACHER',
      normalizedName: '0 0 krombacher',
      category: 'Sonstiges',
      unit: '0,5-l-dose',
    });
    const passionFruit = baseOffer({
      name: 'Passionsfruechte',
      normalizedName: 'passionsfruechte',
      category: 'Sonstiges',
      unit: '3er-Schale',
    });
    const radishes = baseOffer({
      name: 'Radieschen',
      normalizedName: 'radieschen',
      category: 'Sonstiges',
      unit: 'Bund',
    });
    const beef = baseOffer({
      name: 'Rinderkotelett vom irischen Weideochsen',
      normalizedName: 'rinderkotelett vom irischen weideochsen',
      category: 'Fleisch',
      unit: 'kg',
    });

    expect(isLikelyFoodOffer(sauce)).toBe(true);
    expect(isLikelyFoodOffer(spargel)).toBe(true);
    expect(isLikelyFoodOffer(artichokes)).toBe(true);
    expect(isLikelyFoodOffer(milkAlternative)).toBe(true);
    expect(isLikelyFoodOffer(wine)).toBe(true);
    expect(isLikelyFoodOffer(alcoholFreeBeer)).toBe(true);
    expect(isLikelyFoodOffer(passionFruit)).toBe(true);
    expect(isLikelyFoodOffer(radishes)).toBe(true);
    expect(isLikelyFoodOffer(beef)).toBe(true);
  });

  it('filtert Handcreme auch bei falscher Kategorie aus', () => {
    const handCream = baseOffer({
      name: 'Kamill Handcreme',
      normalizedName: 'kamill handcreme',
      category: 'Getraenke Alkoholfrei',
      unit: 'l',
    });

    expect(isLikelyFoodOffer(handCream)).toBe(false);
  });

  it('filtert neue Live-Leaks (Saemereien, Zwiebelpflanzen, Duenger, Vase, Kerzen) aus', () => {
    const seeds = baseOffer({
      name: 'Gardenline Saemereien Gemuesespezialitaet',
      normalizedName: 'gardenline saemereien gemuesespezialitaet',
      category: 'Obst/Gemuese',
      unit: 'stk',
    });
    const onionPlants = baseOffer({
      name: 'thisisnobrand123 Zwiebelpflanzen',
      normalizedName: 'thisisnobrand123 zwiebelpflanzen',
      category: 'Obst/Gemuese',
      unit: 'stk',
    });
    const fertilizer = baseOffer({
      name: 'Garten Magie Universaldunger',
      normalizedName: 'garten magie universaldunger',
      category: 'Sonstiges',
      unit: '1kg',
    });
    const vase = baseOffer({
      name: 'thisisnobrand123 Eisrose in Glasvase',
      normalizedName: 'thisisnobrand123 eisrose in glasvase',
      category: 'Snacks/Suesses',
      unit: 'stk',
    });
    const candle = baseOffer({
      name: 'Schneemann Hexen-Kerze',
      normalizedName: 'schneemann hexen-kerze',
      category: 'Getraenke Alkoholfrei',
      unit: 'stk',
    });

    expect(isLikelyFoodOffer(seeds)).toBe(false);
    expect(isLikelyFoodOffer(onionPlants)).toBe(false);
    expect(isLikelyFoodOffer(fertilizer)).toBe(false);
    expect(isLikelyFoodOffer(vase)).toBe(false);
    expect(isLikelyFoodOffer(candle)).toBe(false);
  });

  it('filtert aktuelle Live-Nonfood-Leaks trotz Food-Hints aus', () => {
    const tomatoPlant = baseOffer({
      name: 'Tomaten-Ampel',
      normalizedName: 'tomaten-ampel',
      category: 'Obst/Gemuese',
      unit: 'pflanze',
    });
    const soil = baseOffer({
      name: 'Torffreie Erde',
      normalizedName: 'torffreie erde',
      category: 'Sonstiges',
      unit: '16-l-packung',
    });
    const flowerPot = baseOffer({
      name: 'Blumentopf Teetasse Weiss',
      normalizedName: 'blumentopf teetasse weiss',
      category: 'Getraenke Alkoholfrei',
      unit: 'stk',
    });
    const vacuum = baseOffer({
      name: 'Unterwasser Handstaubsauger',
      normalizedName: 'unterwasser handstaubsauger',
      category: 'Sonstiges',
      unit: 'stk',
    });
    const noodleMachine = baseOffer({
      name: 'SILVERCREST Nudelmaschine',
      normalizedName: 'silvercrest nudelmaschine',
      category: 'Trockenware',
      unit: 'je',
    });
    const teaGlasses = baseOffer({
      name: 'SPICE&SOUL Thermoglaser fuer Tee',
      normalizedName: 'spice soul thermoglaser fuer tee',
      category: 'Getraenke Alkoholfrei',
      unit: '2-st-packg',
    });
    const petSnacks = baseOffer({
      name: 'VITAKRAFT Katzen-Snacks',
      normalizedName: 'vitakraft katzen-snacks',
      category: 'Sonstiges',
      unit: '75-g-packg',
    });
    const rinseAid = baseOffer({
      name: 'FINISH Klarspuler',
      normalizedName: 'finish klarspuler',
      category: 'Sonstiges',
      unit: '800-ml-fl',
    });
    const bikeBag = baseOffer({
      name: 'Wasserdichte Fahrradtasche 2in1',
      normalizedName: 'wasserdichte fahrradtasche 2in1',
      category: 'Getraenke Alkoholfrei',
      unit: '25liter',
    });
    const detergent = baseOffer({
      name: 'Kraft-Gel Universal',
      brand: 'PERSIL',
      normalizedName: 'kraft-gel universal',
      category: 'Sonstiges',
      unit: '900-ml-flasche',
    });
    const washingPowder = baseOffer({
      name: 'Waschpulver Color',
      brand: 'PERSIL',
      normalizedName: 'waschpulver color',
      category: 'Sonstiges',
      unit: '1,26-kg-packung',
    });
    const waterToy = baseOffer({
      name: 'Poolsitz / Wasserhaengematte',
      normalizedName: 'poolsitz wasserhaengematte',
      category: 'Getraenke Alkoholfrei',
      unit: 'stueck',
    });
    const sunscreen = baseOffer({
      name: 'Sonnencreme Ultra Sensitive LSF50 75ml',
      normalizedName: 'sonnencreme ultra sensitive lsf50 75ml',
      category: 'Sonstiges',
      unit: '75ml',
    });
    const cosmetics = baseOffer({
      name: 'GARNIER Tuchmaske',
      normalizedName: 'garnier tuchmaske',
      category: 'Sonstiges',
      unit: '28-g-stueck',
    });
    const laundryPerfume = baseOffer({
      name: 'LENOR Waescheparfuem',
      normalizedName: 'lenor waescheparfuem',
      category: 'Sonstiges',
      unit: '280-g-fl',
    });
    const kitchenWare = baseOffer({
      name: 'SILVERCREST Fruchtsaftkrug',
      normalizedName: 'silvercrest fruchtsaftkrug',
      category: 'Sonstiges',
      unit: 'je',
    });
    const catLitter = baseOffer({
      name: 'K-CLASSIC Ultra-Klumpstreu',
      normalizedName: 'k-classic ultra-klumpstreu',
      category: 'Sonstiges',
      unit: '6-l-packg',
    });

    expect(isLikelyFoodOffer(tomatoPlant)).toBe(false);
    expect(isLikelyFoodOffer(soil)).toBe(false);
    expect(isLikelyFoodOffer(flowerPot)).toBe(false);
    expect(isLikelyFoodOffer(vacuum)).toBe(false);
    expect(isLikelyFoodOffer(noodleMachine)).toBe(false);
    expect(isLikelyFoodOffer(teaGlasses)).toBe(false);
    expect(isLikelyFoodOffer(petSnacks)).toBe(false);
    expect(isLikelyFoodOffer(rinseAid)).toBe(false);
    expect(isLikelyFoodOffer(bikeBag)).toBe(false);
    expect(isLikelyFoodOffer(detergent)).toBe(false);
    expect(isLikelyFoodOffer(washingPowder)).toBe(false);
    expect(isLikelyFoodOffer(waterToy)).toBe(false);
    expect(isLikelyFoodOffer(sunscreen)).toBe(false);
    expect(isLikelyFoodOffer(cosmetics)).toBe(false);
    expect(isLikelyFoodOffer(laundryPerfume)).toBe(false);
    expect(isLikelyFoodOffer(kitchenWare)).toBe(false);
    expect(isLikelyFoodOffer(catLitter)).toBe(false);
  });

  it('laesst Whiskey mit Cask Finish weiter durch', () => {
    const whiskey = baseOffer({
      name: 'Dundalgan Single Malt IPA Cask Finish Irish Whiskey 42% vol',
      normalizedName: 'dundalgan single malt ipa cask finish irish whiskey 42 vol',
      category: 'Alkohol',
      unit: 'stk',
    });

    expect(isLikelyFoodOffer(whiskey)).toBe(true);
  });

  it('laesst Lebensmittel mit aehnlichen Nonfood-Wortteilen durch', () => {
    const sunflowerSeeds = baseOffer({
      name: 'K-CLASSIC Sonnenblumenkerne',
      normalizedName: 'k-classic sonnenblumenkerne',
      category: 'Sonstiges',
      unit: '400-g-packg',
    });
    const trailMix = baseOffer({
      name: 'SEEBERGER Studentenfutter',
      normalizedName: 'seeberger studentenfutter',
      category: 'Sonstiges',
      unit: '150-g-packg',
    });
    const pastry = baseOffer({
      name: 'Quarktasche',
      normalizedName: 'quarktasche',
      category: 'Milchprodukte',
      unit: 'stueck',
    });

    expect(isLikelyFoodOffer(sunflowerSeeds)).toBe(true);
    expect(isLikelyFoodOffer(trailMix)).toBe(true);
    expect(isLikelyFoodOffer(pastry)).toBe(true);
  });

  it('erkennt Lebensmittel auch bei Sonstiges ueber Name', () => {
    const offer = baseOffer({
      name: 'Vollkornbrot',
      normalizedName: 'vollkornbrot',
      category: 'Sonstiges',
      unit: '500g',
    });

    expect(isLikelyFoodOffer(offer)).toBe(true);
  });
});
