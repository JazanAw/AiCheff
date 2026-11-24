import { describe, expect, it } from 'vitest';
import { Offer } from '../../src/types/models';
import {
  addStrictBlockedKeyword,
  hasStrongFoodSourceSignal,
  filterOffersStrictFood,
  getStrictFoodFilterList,
  hasRuleConfirmedNonFoodSignal,
  hasStrongFoodSignal,
  hasStrongNonFoodSignal,
  hasHardNonFoodSignal,
  isStrictNonFoodOffer,
  learnStrictFoodFeedback,
  removeStrictBlockedKeyword,
  resetStrictFoodFilterRules,
  isStrictFoodOffer,
} from './offersStrictFoodFilter';

function createOffer(overrides: Partial<Offer>): Offer {
  return {
    id: 'offer_test',
    name: 'Bio Bananen',
    normalizedName: 'bio bananen',
    storeChain: 'REWE',
    category: 'Obst/Gemuese',
    price: 1.99,
    currency: 'EUR',
    unit: 'kg',
    validityStart: '2026-02-08T23:00:00.000Z',
    validityEnd: '2026-02-14T22:59:59.000Z',
    sourceUrl: 'https://example.org',
    tags: ['bio'],
    createdAt: '2026-02-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('isStrictFoodOffer', () => {
  it('laesst Lebensmittel durch', () => {
    const offer = createOffer({});
    expect(isStrictFoodOffer(offer)).toBe(true);
  });

  it('filtert Geraete, Motoroel und Haustiernahrung aus', () => {
    const kettle = createOffer({
      name: 'Premium Wasserkocher',
      normalizedName: 'premium wasserkocher',
      category: 'Haushalt',
      tags: [],
    });
    const motorOil = createOffer({
      name: 'Motoroel 5W-30',
      normalizedName: 'motoroel 5w 30',
      category: 'Auto',
      unit: '1l',
      tags: [],
    });
    const petFood = createOffer({
      name: 'Hundefutter Rind',
      normalizedName: 'hundefutter rind',
      category: 'Tiernahrung',
      tags: [],
    });

    expect(isStrictFoodOffer(kettle)).toBe(false);
    expect(isStrictFoodOffer(motorOil)).toBe(false);
    expect(isStrictFoodOffer(petFood)).toBe(false);
  });

  it('respektiert ein explizites "nonfood"-Tag (z. B. Kaufland Non-Food-Kategorie)', () => {
    // Innocuous-looking name, no blocked keyword — only the connector's honest
    // "nonfood" tag (set for non-food SSR categories) marks it as non-food.
    const tagged = createOffer({
      name: 'XXL Sortiment Box',
      normalizedName: 'xxl sortiment box',
      storeChain: 'Kaufland',
      category: 'Sonstiges',
      unit: 'Stk',
      tags: ['filiale', 'nonfood'],
    });
    expect(isStrictNonFoodOffer(tagged)).toBe(true);
    expect(isStrictFoodOffer(tagged)).toBe(false);
  });

  it('filtert eine Bierzeltgarnitur (Möbel) aus, obwohl "Bier" im Namen steht', () => {
    // ALDI SUED "Bierzeltgarnitur" 49,99 € wurde als Alkohol live gestellt —
    // es ist Gartenmöbel, kein Lebensmittel, und muss nach filtered/non-food.
    const beerTentSet = createOffer({
      name: 'Bierzeltgarnitur',
      normalizedName: 'bierzeltgarnitur',
      storeChain: 'ALDI SUED',
      category: 'Alkohol',
      price: 49.99,
      unit: 'Set',
      tags: [],
    });
    const beerBench = createOffer({
      name: 'Bierbank klappbar',
      normalizedName: 'bierbank klappbar',
      category: 'Sonstiges',
      unit: 'Stk',
      tags: [],
    });

    expect(isStrictNonFoodOffer(beerTentSet)).toBe(true);
    expect(isStrictFoodOffer(beerTentSet)).toBe(false);
    expect(isStrictFoodOffer(beerBench)).toBe(false);
    // Echtes Bier bleibt Lebensmittel.
    expect(
      isStrictFoodOffer(
        createOffer({
          name: 'Krombacher Pils Kasten',
          normalizedName: 'krombacher pils kasten',
          category: 'Alkohol',
          unit: '20x0,5l',
          tags: [],
        }),
      ),
    ).toBe(true);
  });

  it('filtert die zuletzt gefundenen Leaks (Duschgel, Motorenoel, Purina) aus', () => {
    const bodyCare = createOffer({
      name: 'Tesori dOriente Body Mist',
      normalizedName: 'tesori doriente body mist',
      category: 'Korperpflege/Badeprodukte',
      tags: [],
    });
    const engineOil = createOffer({
      name: 'Liqui Moly Motorenoel 5W30 Longlife',
      normalizedName: 'liqui moly motorenoel 5w30 longlife',
      category: 'Oel',
      tags: [],
    });
    const petFoodBrand = createOffer({
      name: 'Purina Adventuros Nuggets',
      normalizedName: 'purina adventuros nuggets',
      category: 'Fleischwaren',
      tags: [],
    });

    expect(isStrictFoodOffer(bodyCare)).toBe(false);
    expect(isStrictFoodOffer(engineOil)).toBe(false);
    expect(isStrictFoodOffer(petFoodBrand)).toBe(false);
  });

  it('filtert aktuelle Live-Leaks (Hygienestreu, Kuechenmaschine, Kaffeepadmaschine) aus', () => {
    const catLitter = createOffer({
      name: 'Catsan Hygienestreu',
      normalizedName: 'catsan hygienestreu',
      category: 'Sonstiges',
      unit: '18l',
      tags: [],
    });
    const kitchenMachine = createOffer({
      name: 'Bergner KÃ¼chenmaschine BG-51571-CR',
      normalizedName: 'bergner ka14chenmaschine bg-51571-cr',
      category: 'Backwaren',
      unit: 'stk',
      tags: [],
    });
    const coffeePadMachine = createOffer({
      name: 'Philips Senseo Original Eco Kaffeepadmaschine HD7806/50',
      normalizedName: 'philips senseo original eco kaffeepadmaschine hd7806 50',
      category: 'Getraenke Alkoholfrei',
      unit: 'stk',
      tags: [],
    });

    expect(isStrictFoodOffer(catLitter)).toBe(false);
    expect(isStrictFoodOffer(kitchenMachine)).toBe(false);
    expect(isStrictFoodOffer(coffeePadMachine)).toBe(false);
  });

  it('filtert die neuen Live-Leaks (Saemereien, Zwiebelpflanzen, Duenger, Vase, Kerzen) aus', () => {
    const seeds = createOffer({
      name: 'Gardenline Saemereien Gemuesespezialitaet',
      normalizedName: 'gardenline saemereien gemuesespezialitaet',
      category: 'Obst/Gemuese',
      unit: 'stk',
      tags: [],
    });
    const onionPlants = createOffer({
      name: 'thisisnobrand123 Zwiebelpflanzen',
      normalizedName: 'thisisnobrand123 zwiebelpflanzen',
      category: 'Obst/Gemuese',
      unit: 'stk',
      tags: [],
    });
    const fertilizer = createOffer({
      name: 'Garten Magie Universaldunger',
      normalizedName: 'garten magie universaldunger',
      category: 'Sonstiges',
      unit: '1kg',
      tags: [],
    });
    const vase = createOffer({
      name: 'thisisnobrand123 Eisrose in Glasvase',
      normalizedName: 'thisisnobrand123 eisrose in glasvase',
      category: 'Snacks/Suesses',
      unit: 'stk',
      tags: [],
    });
    const candle = createOffer({
      name: 'Schneemann Hexen-Kerze',
      normalizedName: 'schneemann hexen-kerze',
      category: 'Getraenke Alkoholfrei',
      unit: 'stk',
      tags: [],
    });

    expect(isStrictFoodOffer(seeds)).toBe(false);
    expect(isStrictFoodOffer(onionPlants)).toBe(false);
    expect(isStrictFoodOffer(fertilizer)).toBe(false);
    expect(isStrictFoodOffer(vase)).toBe(false);
    expect(isStrictFoodOffer(candle)).toBe(false);
  });

  it('filtert aktuelle Live-Nonfood-Leaks trotz Food-Kategorie aus', () => {
    const tomatoPlant = createOffer({
      name: 'Tomaten-Ampel',
      normalizedName: 'tomaten-ampel',
      category: 'Obst/Gemuese',
      unit: 'pflanze',
      tags: [],
    });
    const soil = createOffer({
      name: 'Torffreie Erde',
      normalizedName: 'torffreie erde',
      category: 'Sonstiges',
      unit: '16-l-packung',
      tags: [],
    });
    const flowerPot = createOffer({
      name: 'Blumentopf Teetasse Weiss',
      normalizedName: 'blumentopf teetasse weiss',
      category: 'Getraenke Alkoholfrei',
      unit: 'stk',
      tags: [],
    });
    const vacuum = createOffer({
      name: 'Unterwasser Handstaubsauger',
      normalizedName: 'unterwasser handstaubsauger',
      category: 'Sonstiges',
      unit: 'stk',
      tags: [],
    });
    const noodleMachine = createOffer({
      name: 'SILVERCREST Nudelmaschine',
      normalizedName: 'silvercrest nudelmaschine',
      category: 'Trockenware',
      unit: 'je',
      tags: [],
    });
    const teaGlasses = createOffer({
      name: 'SPICE&SOUL Thermoglaser fuer Tee',
      normalizedName: 'spice soul thermoglaser fuer tee',
      category: 'Getraenke Alkoholfrei',
      unit: '2-st-packg',
      tags: [],
    });
    const petSnacks = createOffer({
      name: 'VITAKRAFT Katzen-Snacks',
      normalizedName: 'vitakraft katzen-snacks',
      category: 'Sonstiges',
      unit: '75-g-packg',
      tags: [],
    });
    const rinseAid = createOffer({
      name: 'FINISH Klarspuler',
      normalizedName: 'finish klarspuler',
      category: 'Sonstiges',
      unit: '800-ml-fl',
      tags: [],
    });
    const bikeBag = createOffer({
      name: 'Wasserdichte Fahrradtasche 2in1',
      normalizedName: 'wasserdichte fahrradtasche 2in1',
      category: 'Getraenke Alkoholfrei',
      unit: '25liter',
      tags: [],
    });
    const detergent = createOffer({
      name: 'Kraft-Gel Universal',
      brand: 'PERSIL',
      normalizedName: 'kraft-gel universal',
      category: 'Sonstiges',
      unit: '900-ml-flasche',
      tags: [],
    });
    const washingPowder = createOffer({
      name: 'Waschpulver Color',
      brand: 'PERSIL',
      normalizedName: 'waschpulver color',
      category: 'Sonstiges',
      unit: '1,26-kg-packung',
      tags: [],
    });
    const waterToy = createOffer({
      name: 'Poolsitz / Wasserhaengematte',
      normalizedName: 'poolsitz wasserhaengematte',
      category: 'Getraenke Alkoholfrei',
      unit: 'stueck',
      tags: [],
    });
    const sunscreen = createOffer({
      name: 'Sonnencreme Ultra Sensitive LSF50 75ml',
      normalizedName: 'sonnencreme ultra sensitive lsf50 75ml',
      category: 'Sonstiges',
      unit: '75ml',
      tags: [],
    });
    const cosmetics = createOffer({
      name: 'GARNIER Tuchmaske',
      normalizedName: 'garnier tuchmaske',
      category: 'Sonstiges',
      unit: '28-g-stueck',
      tags: [],
    });
    const laundryPerfume = createOffer({
      name: 'LENOR Waescheparfuem',
      normalizedName: 'lenor waescheparfuem',
      category: 'Sonstiges',
      unit: '280-g-fl',
      tags: [],
    });
    const kitchenWare = createOffer({
      name: 'SILVERCREST Fruchtsaftkrug',
      normalizedName: 'silvercrest fruchtsaftkrug',
      category: 'Sonstiges',
      unit: 'je',
      tags: [],
    });
    const catLitter = createOffer({
      name: 'K-CLASSIC Ultra-Klumpstreu',
      normalizedName: 'k-classic ultra-klumpstreu',
      category: 'Sonstiges',
      unit: '6-l-packg',
      tags: [],
    });

    expect(isStrictFoodOffer(tomatoPlant)).toBe(false);
    expect(isStrictFoodOffer(soil)).toBe(false);
    expect(isStrictFoodOffer(flowerPot)).toBe(false);
    expect(isStrictFoodOffer(vacuum)).toBe(false);
    expect(isStrictFoodOffer(noodleMachine)).toBe(false);
    expect(isStrictFoodOffer(teaGlasses)).toBe(false);
    expect(isStrictFoodOffer(petSnacks)).toBe(false);
    expect(isStrictFoodOffer(rinseAid)).toBe(false);
    expect(isStrictFoodOffer(bikeBag)).toBe(false);
    expect(isStrictFoodOffer(detergent)).toBe(false);
    expect(isStrictFoodOffer(washingPowder)).toBe(false);
    expect(isStrictFoodOffer(waterToy)).toBe(false);
    expect(isStrictFoodOffer(sunscreen)).toBe(false);
    expect(isStrictFoodOffer(cosmetics)).toBe(false);
    expect(isStrictFoodOffer(laundryPerfume)).toBe(false);
    expect(isStrictFoodOffer(kitchenWare)).toBe(false);
    expect(isStrictFoodOffer(catLitter)).toBe(false);
  });

  it('filtert Geschenksets, Reinigungsmittel und Whiskas sicher aus', () => {
    const giftSet = createOffer({
      name: 'Kneipp Geschenkset Wellness Liebling',
      normalizedName: 'kneipp geschenkset wellness liebling',
      category: 'Wellness',
      tags: [],
    });
    const cleaner = createOffer({
      name: 'Febreze 3Volution Nachfuellflakon',
      normalizedName: 'febreze 3volution nachfuellflakon',
      category: 'Reinigungsmittel',
      tags: [],
    });
    const catFood = createOffer({
      name: 'Whiskas Classic Meals',
      normalizedName: 'whiskas classic meals',
      category: 'Fertiggerichte',
      tags: [],
    });
    const handCream = createOffer({
      name: 'Kamill Handcreme',
      normalizedName: 'kamill handcreme',
      category: 'Getraenke Alkoholfrei',
      unit: 'l',
      tags: [],
    });
    const kitchenScale = createOffer({
      name: 'Blaumann Kuechenwaage',
      normalizedName: 'blaumann kuechenwaage',
      category: 'Backwaren',
      unit: 'stk',
      tags: [],
    });
    const bubbleBath = createOffer({
      name: 'Tetesept Kids Schaumbad',
      normalizedName: 'tetesept kids schaumbad',
      category: 'Sonstiges',
      unit: 'stk',
      tags: [],
    });
    const kitchenTowels = createOffer({
      name: 'Floralys Kuechentuecher XXL',
      normalizedName: 'floralys kuechentuecher xxl',
      category: 'Backwaren',
      unit: 'stk',
      tags: [],
    });
    const bodyMilk = createOffer({
      name: 'Nivea Bodymilk',
      normalizedName: 'nivea bodymilk',
      category: 'Sonstiges',
      unit: 'stk',
      tags: [],
    });
    const immuneShot = createOffer({
      name: 'Tetesept Immun Aktiv Shot',
      normalizedName: 'tetesept immun aktiv shot',
      category: 'Sonstiges',
      unit: '60ml',
      tags: [],
    });
    const airFreshener = createOffer({
      name: 'Lufterfrischer-Nachfueller',
      normalizedName: 'lufterfrischer-nachfueller',
      category: 'Sonstiges',
      unit: '250-ml-flasche',
      tags: [],
    });
    const dogFood = createOffer({
      name: 'JOSI DOG Hundenahrung',
      normalizedName: 'josi dog hundenahrung',
      category: 'Sonstiges',
      unit: '10-kg-packung',
      tags: [],
    });
    const hairStyling = createOffer({
      name: 'SCHWARZKOPF Got2b Strand-Matte',
      normalizedName: 'schwarzkopf got2b strand-matte',
      category: 'Sonstiges',
      unit: '100-ml-dose',
      tags: [],
    });

    expect(isStrictFoodOffer(giftSet)).toBe(false);
    expect(isStrictFoodOffer(cleaner)).toBe(false);
    expect(isStrictFoodOffer(catFood)).toBe(false);
    expect(isStrictFoodOffer(handCream)).toBe(false);
    expect(isStrictFoodOffer(kitchenScale)).toBe(false);
    expect(isStrictFoodOffer(bubbleBath)).toBe(false);
    expect(isStrictFoodOffer(kitchenTowels)).toBe(false);
    expect(isStrictFoodOffer(bodyMilk)).toBe(false);
    expect(isStrictFoodOffer(immuneShot)).toBe(true);
    expect(isStrictFoodOffer(airFreshener)).toBe(false);
    expect(isStrictFoodOffer(dogFood)).toBe(false);
    expect(isStrictFoodOffer(hairStyling)).toBe(false);
  });

  it('filtert WC-Reiniger auch mit Liter-Einheit aus', () => {
    const wcCleaner = createOffer({
      name: '00 WC Aktiv Gel',
      normalizedName: '00 wc aktiv gel',
      category: 'Sonstiges',
      unit: 'l',
      tags: [],
    });

    expect(isStrictFoodOffer(wcCleaner)).toBe(false);
  });

  it('filtert Wasserbomben-Spielzeug aus', () => {
    const waterBalloons = createOffer({
      name: 'Zuru Wasserbomben-Set Bunch O Balloons',
      normalizedName: 'zuru wasserbomben set bunch o balloons',
      category: 'Sonstiges',
      unit: 'stk',
      tags: [],
    });

    expect(isStrictFoodOffer(waterBalloons)).toBe(false);
  });

  it('laesst Kaffee und Tee auch bei Sonstiges-Kategorie durch', () => {
    const dallmayr = createOffer({
      name: 'DALLMAYR Home Barista Caffe Crema',
      normalizedName: 'dallmayr home barista caffe crema',
      category: 'Sonstiges',
      tags: [],
    });
    const lavazza = createOffer({
      name: 'LAVAZZA Caffe Crema',
      normalizedName: 'lavazza caffe crema',
      category: 'Sonstiges',
      tags: [],
    });
    const lipton = createOffer({
      name: 'LIPTON Sensations',
      normalizedName: 'lipton sensations',
      category: 'Sonstiges',
      tags: [],
    });

    expect(isStrictFoodOffer(dallmayr)).toBe(true);
    expect(isStrictFoodOffer(lavazza)).toBe(true);
    expect(isStrictFoodOffer(lipton)).toBe(true);
  });

  it('laesst Whiskey mit Cask Finish weiter als Lebensmittel/Alkohol durch', () => {
    const whiskey = createOffer({
      name: 'Dundalgan Single Malt IPA Cask Finish Irish Whiskey 42% vol',
      normalizedName: 'dundalgan single malt ipa cask finish irish whiskey 42 vol',
      category: 'Alkohol',
      unit: 'stk',
      tags: [],
    });

    expect(isStrictFoodOffer(whiskey)).toBe(true);
  });

  it('laesst Lebensmittel mit aehnlichen Nonfood-Wortteilen durch', () => {
    const sunflowerSeeds = createOffer({
      name: 'K-CLASSIC Sonnenblumenkerne',
      normalizedName: 'k-classic sonnenblumenkerne',
      category: 'Sonstiges',
      unit: '400-g-packg',
      tags: [],
    });
    const trailMix = createOffer({
      name: 'SEEBERGER Studentenfutter',
      normalizedName: 'seeberger studentenfutter',
      category: 'Sonstiges',
      unit: '150-g-packg',
      tags: [],
    });
    const pastry = createOffer({
      name: 'Quarktasche',
      normalizedName: 'quarktasche',
      category: 'Milchprodukte',
      unit: 'stueck',
      tags: [],
    });

    expect(isStrictFoodOffer(sunflowerSeeds)).toBe(true);
    expect(isStrictFoodOffer(trailMix)).toBe(true);
    expect(isStrictFoodOffer(pastry)).toBe(true);
  });

  it('blockiert Haushaltspapier auch mit Food-Hints oder falscher Kategorie', () => {
    const kitchenRoll = createOffer({
      name: 'Cafe Royal Kuechenrolle Crema',
      normalizedName: 'cafe royal kuechenrolle crema',
      category: 'Backwaren',
      unit: '3 Rollen',
      tags: [],
    });
    const paperTowels = createOffer({
      name: 'HAPPY END Kuechentuecher',
      normalizedName: 'happy end kuechentuecher',
      category: 'Lebensmittel',
      unit: '2 Stueck',
      tags: [],
    });
    const serviettes = createOffer({
      name: 'Deko Servietten',
      normalizedName: 'deko servietten',
      category: 'Sonstiges',
      unit: '20 Stueck',
      tags: [],
    });

    expect(isStrictFoodOffer(kitchenRoll)).toBe(false);
    expect(isStrictFoodOffer(paperTowels)).toBe(false);
    expect(isStrictFoodOffer(serviettes)).toBe(false);
  });

  it('laesst aktuelle Sonstiges-Lebensmittel aus Live-Angeboten durch', () => {
    const sauce = createOffer({
      name: 'Mojo-Sauce / Aioli',
      normalizedName: 'mojo-sauce aioli',
      category: 'Sonstiges',
      unit: '250-ml-glas',
      tags: [],
    });
    const spargel = createOffer({
      name: 'Spargel',
      normalizedName: 'spargel',
      category: 'Sonstiges',
      unit: '500-g-bund',
      tags: [],
    });
    const artichokes = createOffer({
      name: 'Artischockenviertel Mix 370 ml, Mariniert',
      normalizedName: 'artischockenviertel mix 370 ml mariniert',
      category: 'Sonstiges',
      unit: '0,2kg/atg',
      tags: [],
    });
    const milkAlternative = createOffer({
      name: 'Not M*lk Drink',
      normalizedName: 'not mlk drink',
      category: 'Sonstiges',
      unit: '1-l-packung',
      tags: [],
    });
    const wine = createOffer({
      name: 'Gewuerztraminer Weissburgunder Pfalz QbA',
      normalizedName: 'gewuerztraminer weissburgunder pfalz qba',
      category: 'Sonstiges',
      unit: '0,75-l-flasche',
      tags: [],
    });
    const pastry = createOffer({
      name: 'Superberliner',
      normalizedName: 'superberliner',
      category: 'Sonstiges',
      unit: 'Stueck',
      tags: [],
    });
    const passionFruit = createOffer({
      name: 'Passionsfruechte',
      normalizedName: 'passionsfruechte',
      category: 'Sonstiges',
      unit: '3er-Schale',
      tags: [],
    });
    const radishes = createOffer({
      name: 'Radieschen',
      normalizedName: 'radieschen',
      category: 'Sonstiges',
      unit: 'Bund',
      tags: [],
    });
    const avocado = createOffer({
      name: 'Bio Avocado',
      normalizedName: 'bio avocado',
      category: 'Sonstiges',
      unit: 'Stueck',
      tags: [],
    });
    const lemons = createOffer({
      name: 'Bio Zitronen',
      normalizedName: 'bio zitronen',
      category: 'Sonstiges',
      unit: 'Stueck',
      tags: [],
    });
    const garlic = createOffer({
      name: 'Bio HIT Knoblauch',
      normalizedName: 'bio hit knoblauch',
      category: 'Sonstiges',
      unit: '200gnetz',
      tags: [],
    });
    const beef = createOffer({
      name: 'Rinderkotelett vom irischen Weideochsen',
      normalizedName: 'rinderkotelett vom irischen weideochsen',
      category: 'Fleisch',
      unit: 'kg',
      tags: [],
    });
    const champagne = createOffer({
      name: 'Pommery Brut Royal Champagner',
      normalizedName: 'pommery brut royal champagner',
      category: 'Sonstiges',
      unit: 'Stueck',
      tags: [],
    });
    const bakery = createOffer({
      name: 'Laugenstange mit Saaten',
      normalizedName: 'laugenstange mit saaten',
      category: 'Sonstiges',
      unit: '2 Stueck',
      tags: [],
    });

    expect(isStrictFoodOffer(sauce)).toBe(true);
    expect(isStrictFoodOffer(spargel)).toBe(true);
    expect(isStrictFoodOffer(artichokes)).toBe(true);
    expect(isStrictFoodOffer(milkAlternative)).toBe(true);
    expect(isStrictFoodOffer(wine)).toBe(true);
    expect(isStrictFoodOffer(pastry)).toBe(true);
    expect(isStrictFoodOffer(passionFruit)).toBe(true);
    expect(isStrictFoodOffer(radishes)).toBe(true);
    expect(isStrictFoodOffer(avocado)).toBe(true);
    expect(isStrictFoodOffer(lemons)).toBe(true);
    expect(isStrictFoodOffer(garlic)).toBe(true);
    expect(isStrictFoodOffer(beef)).toBe(true);
    expect(isStrictFoodOffer(champagne)).toBe(true);
    expect(isStrictFoodOffer(bakery)).toBe(true);
  });

  it('erkennt kompakte Lebensmittel-Einheiten und Oel/Eistee als Food', () => {
    const oliveOil = createOffer({
      name: 'EDEKA Bio Natives Olivenol Extra',
      normalizedName: 'edeka bio natives olivenol extra',
      category: 'Sonstiges',
      unit: '1l',
      baseUnit: '1l',
      tags: [],
    });
    const iceTea = createOffer({
      name: 'HERZSTUECKE Ice Tea',
      normalizedName: 'herzstuecke ice tea',
      category: 'Sonstiges',
      unit: '1,5l',
      tags: [],
    });
    const alcoholFreeBeer = createOffer({
      name: '0,0 %',
      brand: 'KROMBACHER',
      normalizedName: '0 0 krombacher',
      category: 'Sonstiges',
      unit: '0,5-l-dose',
      tags: [],
    });
    const alcoholFreeSpirit = createOffer({
      name: "GORDON'S 0,0 % Vol alkoholfrei",
      normalizedName: 'gordons 0 0 vol alkoholfrei',
      category: 'Sonstiges',
      unit: 'Stueck',
      tags: [],
    });

    expect(isStrictFoodOffer(oliveOil)).toBe(true);
    expect(isStrictFoodOffer(iceTea)).toBe(true);
    expect(isStrictFoodOffer(alcoholFreeBeer)).toBe(true);
    expect(isStrictFoodOffer(alcoholFreeSpirit)).toBe(true);
  });

  it('laesst aktuelle Obst- und Backwaren ohne kg/ml-Einheit durch', () => {
    const mango = createOffer({
      name: 'Mango',
      normalizedName: 'mango',
      category: 'Sonstiges',
      unit: 'Stueck',
      tags: [],
    });
    const kiwi = createOffer({
      name: 'Zespri Kiwi gold',
      normalizedName: 'zespri kiwi gold',
      category: 'Sonstiges',
      unit: 'Stueck',
      tags: [],
    });
    const pastry = createOffer({
      name: 'Kirschtasche',
      normalizedName: 'kirschtasche',
      category: 'Sonstiges',
      unit: '2 Stueck',
      tags: [],
    });

    expect(isStrictFoodOffer(mango)).toBe(true);
    expect(isStrictFoodOffer(kiwi)).toBe(true);
    expect(isStrictFoodOffer(pastry)).toBe(true);
  });

  it('blockiert Drogerie und Technik trotz ml- oder Stueck-Einheit', () => {
    const lotion = createOffer({
      name: 'Mixa Koerperlotion',
      normalizedName: 'mixa koerperlotion',
      category: 'Sonstiges',
      unit: '250ml',
      tags: [],
    });
    const phone = createOffer({
      name: 'Apple iPhone',
      normalizedName: 'apple iphone',
      category: 'Sonstiges',
      unit: 'Stk',
      tags: [],
    });

    expect(isStrictFoodOffer(lotion)).toBe(false);
    expect(isStrictFoodOffer(phone)).toBe(false);
  });

  it('filtert Nicht-Lebensmittel aus REWE-PDF-Angeboten aus', () => {
    const nivea = createOffer({
      name: 'NIVEA Soft Creme',
      normalizedName: 'nivea soft creme',
      category: 'Obst und Gemuese',
      unit: '200ml',
      tags: [],
    });
    const flowers = createOffer({
      name: 'Blutenpoesie Bluhpflanzen in Zinkschale',
      normalizedName: 'blutenpoesie bluhpflanzen in zinkschale',
      category: 'Obst und Gemuese',
      unit: 'Stueck',
      tags: [],
    });

    expect(isStrictFoodOffer(nivea)).toBe(false);
    expect(isStrictFoodOffer(flowers)).toBe(false);
  });
});

describe('filterOffersStrictFood', () => {
  it('liefert entfernte Anzahl und Beispiele', () => {
    const offers = [
      createOffer({ id: 'food_1', name: 'Vollkornbrot', normalizedName: 'vollkornbrot' }),
      createOffer({
        id: 'non_food_1',
        name: 'Kaffeemaschine',
        normalizedName: 'kaffeemaschine',
        category: 'Technik',
      }),
    ];

    const result = filterOffersStrictFood(offers);
    expect(result.offers).toHaveLength(1);
    expect(result.removedCount).toBe(1);
    expect(result.removedExamples[0]).toContain('Kaffeemaschine');
  });
});

describe('getStrictFoodFilterList', () => {
  it('liefert die aktive Backend-Filterliste', () => {
    const list = getStrictFoodFilterList();

    expect(list.blockedKeywords).toContain('wasserkocher');
    expect(list.blockedKeywords).toContain('hundefutter');
    expect(list.blockedKeywords).toContain('whiskas');
    expect(list.blockedKeywords).toContain('geschenkset');
    expect(list.blockedKeywords).toContain('samereien');
    expect(list.blockedKeywords).toContain('kerze');
    expect(list.blockedCategoryKeywords).toContain('tierbedarf');
    expect(list.allowedCategoryKeywords).toContain('lebensmittel');
    expect(list.allowedTags).toContain('vegan');
  });
});

describe('custom blocked keyword rules', () => {
  it('kann keyword hinzufuegen und wieder entfernen', async () => {
    await resetStrictFoodFilterRules();

    const added = await addStrictBlockedKeyword('testprodukt');
    expect(added.changed).toBe(true);
    expect(added.list.blockedKeywords).toContain('testprodukt');

    const removed = await removeStrictBlockedKeyword('testprodukt');
    expect(removed.changed).toBe(true);
    expect(removed.list.blockedKeywords).not.toContain('testprodukt');
  });
});

describe('Hard-Block: Non-Food gewinnt trotz Food-Kategorie', () => {
  // Regression: the KI/rule categorizer gave these non-food items a FOOD simple
  // category (Fisch/Trockenware/Getränke/Snacks), which previously leaked them
  // into Live/NextWeek. The hard name-block / canonical-flag / unit signals must
  // now win regardless of the (wrong) category.
  it('blockt die konkreten Live-/NextWeek-Leaks', () => {
    const cases: Partial<Offer>[] = [
      { name: 'Strandmuschel', normalizedName: 'strandmuschel', category: 'Fisch', unit: 'stück', tags: [] },
      { name: 'Cerealiendose', normalizedName: 'cerealiendose', category: 'Trockenware', unit: 'je', tags: [] },
      { name: 'Nelke Sorte „Pink Kisses“', normalizedName: 'nelke sorte pink kisses', category: 'Trockenware', unit: 'stück', tags: [] },
      { name: 'Wasserspritzpistolen, Stealth Soaker', normalizedName: 'wasserspritzpistolen stealth soaker', category: 'Getränke Alkoholfrei', unit: 'stk', tags: [] },
      { name: 'Bunte Microfaser Spezialschwämme', normalizedName: 'bunte microfaser spezialschwaemme', category: 'Getränke Alkoholfrei', unit: 'stk', tags: [] },
      { name: 'Kreativ-Set für Kinder, Loops Spaß Box', normalizedName: 'kreativ-set fuer kinder loops spass box', category: 'Snacks/Süßes', unit: 'stk', tags: [] },
      { name: '3-Zahn-Freischneidmesser', normalizedName: '3-zahn-freischneidmesser', category: 'Sonstiges', unit: 'stk', tags: [] },
      { name: 'Aufbewahrungs-Box', normalizedName: 'aufbewahrungs-box', category: 'Sonstiges', unit: 'ca.310l', tags: [] },
    ];
    for (const c of cases) {
      expect(isStrictFoodOffer(createOffer(c))).toBe(false);
    }
  });

  it('blockt per canonicalCategory.isNonFood, auch bei Food-Kategorie', () => {
    const offer = {
      ...createOffer({ name: 'Loops Spaß Box', normalizedName: 'loops spass box', category: 'Snacks/Süßes', unit: 'stk', tags: [] }),
      canonicalCategory: { isNonFood: true },
    } as Offer;
    expect(isStrictFoodOffer(offer)).toBe(false);
  });

  it('blockt Pflanzen anhand der Einheit "pflanze" (z. B. Nelken-Pflanze)', () => {
    const plant = createOffer({ name: 'Nelken', normalizedName: 'nelken', category: 'Trockenware', unit: 'pflanze', tags: [] });
    expect(isStrictFoodOffer(plant)).toBe(false);
  });

  it('laesst echte Lebensmittel weiter durch (keine Übersperrung)', () => {
    const foods: Partial<Offer>[] = [
      { name: 'Ananas', normalizedName: 'ananas', category: 'Obst/Gemüse', unit: 'stück' },
      { name: 'Zimtschnecke', normalizedName: 'zimtschnecke', category: 'Backwaren', unit: 'stück' },
      { name: 'Brasil. Limetten', normalizedName: 'brasil limetten', category: 'Obst/Gemüse', unit: '500g' },
      { name: 'Geflügelrolle', normalizedName: 'gefluegelrolle', category: 'Fleisch', unit: '100g' },
      { name: 'Airfryer Pizza', normalizedName: 'airfryer pizza', category: 'Tiefkühl', unit: 'stück' },
      { name: 'Burger mit Gouda', normalizedName: 'burger mit gouda', category: 'Fleisch', unit: 'stück' },
      // Echte Gewürz-Nelken: Gewürz-Kontext + g-Einheit (kein "pflanze"/Sortenname).
      { name: 'Gewürznelken ganz', normalizedName: 'gewuerznelken ganz', category: 'Gewürze', unit: '20g', tags: ['bio'] },
    ];
    for (const f of foods) {
      expect(isStrictFoodOffer(createOffer(f))).toBe(true);
    }
  });
});

describe('strong non-food repair (LIVARNO / Insektenschutz)', () => {
  // Reasons mirror the real snapshot leak: model said "unsure", isNonFood=false.
  const lidlNonFood: Partial<Offer>[] = [
    { name: 'LIVARNO Alu-Insektenschutz-Fenster', normalizedName: 'livarno alu insektenschutz fenster', brand: 'LIVARNO', category: 'Sonstiges', unit: 'Stk', tags: [] },
    { name: 'LIVARNO Alu-Insektenschutz-Tür', normalizedName: 'livarno alu insektenschutz tuer', brand: 'LIVARNO', category: 'Sonstiges', unit: 'Stk', tags: [] },
    { name: 'LIVARNO Elektrischer Insektenvernichter', normalizedName: 'livarno elektrischer insektenvernichter', brand: 'LIVARNO', category: 'Sonstiges', unit: 'Stk', tags: [] },
    { name: 'LIVARNO UV-Insektenfalle', normalizedName: 'livarno uv insektenfalle', brand: 'LIVARNO', category: 'Sonstiges', unit: 'Stk', tags: [] },
    { name: 'PARKSIDE Akku-Bohrschrauber', normalizedName: 'parkside akku bohrschrauber', brand: 'PARKSIDE', category: 'Sonstiges', unit: 'Stk', tags: [] },
  ];

  it('hasStrongNonFoodSignal erkennt LIVARNO/Insektenschutz', () => {
    for (const c of lidlNonFood) {
      expect(hasStrongNonFoodSignal(createOffer(c))).toBe(true);
    }
  });

  it('markiert sie als strikt Non-Food (auch bei unsure/isNonFood=false)', () => {
    for (const c of lidlNonFood) {
      const offer = {
        ...createOffer(c),
        foodFlag: 'unsure',
        canonicalCategory: { isNonFood: false, reasons: ['repair:sonstiges_nonfood_unverified'] },
      } as Offer;
      expect(isStrictNonFoodOffer(offer)).toBe(true);
      expect(isStrictFoodOffer(offer)).toBe(false);
    }
  });

  it('filterOffersStrictFood schiebt sie nach removed/filtered, Food bleibt', () => {
    const offers = [
      ...lidlNonFood.map((c) => createOffer(c)),
      createOffer({ id: 'food_milk', name: 'Bio Vollmilch', normalizedName: 'bio vollmilch', category: 'Milchprodukte', unit: '1l' }),
      createOffer({ id: 'food_banana', name: 'Bio Bananen', normalizedName: 'bio bananen', category: 'Obst/Gemüse', unit: 'kg' }),
    ];
    const result = filterOffersStrictFood(offers);
    expect(result.removedCount).toBe(lidlNonFood.length);
    expect(result.offers.map((o) => o.id).sort()).toEqual(['food_banana', 'food_milk']);
  });

  it('lässt echte Lebensmittel unangetastet (keine Übersperrung)', () => {
    const foods: Partial<Offer>[] = [
      { name: 'Insalata Caprese', normalizedName: 'insalata caprese', category: 'Milchprodukte', unit: '200g' },
      { name: 'Mozzarella di Bufala', normalizedName: 'mozzarella di bufala', category: 'Milchprodukte', unit: '125g' },
    ];
    for (const f of foods) {
      expect(hasStrongNonFoodSignal(createOffer(f))).toBe(false);
      expect(isStrictFoodOffer(createOffer(f))).toBe(true);
    }
  });
});

describe('Reinigungs-/Drogerie-Domäne — hartes Regel-Signal (Scheuermilch-Fall)', () => {
  // Real beobachtet: PENNY "VISS Scheuermilch" wurde vom Food-Rescue über den
  // 'milch'-Substring gerettet. Reinigungs-/Hygiene-/Drogerie-Vokabular muss
  // ein STARKES, nicht editierbares Regel-Signal sein — Domänenwörter, keine
  // Produktliste.
  const cleaningNames = [
    'VISS Scheuermilch',
    'Scheuermilch Zitrone',
    'Scheuerpulver Classic',
    'Spülmittel Ultra Konzentrat',
    'Weichspüler Frühlingsfrische',
    'Hygiene-Spüler Eukalyptus',
    'Hygienespüler Sensitive',
    'Sonnenmilch LSF 50',
    'Reinigungsmilch Sensitive',
    'Allzweckreiniger Citrus',
  ];

  it('hasStrongNonFoodSignal erkennt Reinigungs-/Drogerie-Vokabular', () => {
    for (const name of cleaningNames) {
      const offer = createOffer({
        id: `clean_${name}`,
        name,
        normalizedName: name.toLowerCase(),
        category: 'Sonstiges',
        unit: 'Stk',
        tags: [],
      });
      expect(hasStrongNonFoodSignal(offer), name).toBe(true);
      expect(hasRuleConfirmedNonFoodSignal(offer), name).toBe(true);
    }
  });

  it('echte Milchprodukte tragen kein starkes Non-Food-Signal', () => {
    for (const name of [
      'Frische Vollmilch 3,8 %',
      'Buttermilch Natur',
      'Kokosmilch ungesüßt',
      'Milchreis Vanille',
      'H-Milch 1,5 %',
    ]) {
      const offer = createOffer({
        id: `milk_${name}`,
        name,
        normalizedName: name.toLowerCase(),
        category: 'Sonstiges',
        unit: 'Stk',
        tags: [],
      });
      expect(hasStrongNonFoodSignal(offer), name).toBe(false);
      expect(hasRuleConfirmedNonFoodSignal(offer), name).toBe(false);
      expect(hasStrongFoodSignal(offer), name).toBe(true);
    }
  });
});

describe('hasHardNonFoodSignal — alle harten Non-Food-Signale gewinnen', () => {
  it('greift bei foodFlag=nonfood', () => {
    expect(hasHardNonFoodSignal({ ...createOffer({}), foodFlag: 'nonfood' } as Offer)).toBe(true);
  });

  it('greift bei canonicalCategory.isNonFood=true (trotz Food-Kategorie)', () => {
    const offer = {
      ...createOffer({ category: 'Milchprodukte' }),
      canonicalCategory: { isNonFood: true },
    } as Offer;
    expect(hasHardNonFoodSignal(offer)).toBe(true);
  });

  it('greift beim "nonfood"-Tag (Kaufland Non-Food-Kategorie)', () => {
    const offer = createOffer({
      name: 'NIVEA Duschgel',
      normalizedName: 'nivea duschgel',
      category: 'Sonstiges',
      tags: ['filiale', 'nonfood'],
    });
    expect(hasHardNonFoodSignal(offer)).toBe(true);
  });

  it('greift bei harten Keywords (LIVARNO/Insektenschutz)', () => {
    expect(
      hasHardNonFoodSignal(
        createOffer({ name: 'LIVARNO UV-Insektenfalle', normalizedName: 'livarno uv insektenfalle', category: 'Sonstiges' }),
      ),
    ).toBe(true);
  });

  it('greift bei Non-Food-Kategorienamen (Drogerie)', () => {
    expect(hasHardNonFoodSignal(createOffer({ category: 'Drogerie' }))).toBe(true);
  });

  it('lässt echte Lebensmittel in Ruhe — auch internationale', () => {
    const foods: Partial<Offer>[] = [
      { name: 'Bio Vollmilch', normalizedName: 'bio vollmilch', category: 'Milchprodukte', unit: '1l' },
      { name: 'Sriracha Hot Chili Sauce', normalizedName: 'sriracha hot chili sauce', category: 'Sonstiges', unit: '435ml' },
      { name: 'Sojasauce', normalizedName: 'sojasauce', category: 'Sonstiges', unit: '150ml' },
      { name: 'Ayran', normalizedName: 'ayran', category: 'Milchprodukte', unit: '250ml' },
      { name: 'Basmati Reis', normalizedName: 'basmati reis', category: 'Sonstiges', unit: '1kg' },
    ];
    for (const f of foods) {
      expect(hasHardNonFoodSignal(createOffer(f))).toBe(false);
    }
  });
});

describe('learning feedback', () => {
  it('lernt aus manueller Rueckverschiebung und blockiert bei Gegenfeedback', async () => {
    await resetStrictFoodFilterRules();

    const kettle = createOffer({
      id: 'learn_offer_1',
      name: 'Premium Wasserkocher',
      normalizedName: 'premium wasserkocher',
      category: 'Haushalt',
      tags: [],
    });

    expect(isStrictFoodOffer(kettle)).toBe(false);

    const allowChanges = await learnStrictFoodFeedback([kettle], 'allow');
    expect(allowChanges).toBe(1);
    expect(isStrictFoodOffer(kettle)).toBe(true);

    const blockChanges = await learnStrictFoodFeedback([kettle], 'block');
    expect(blockChanges).toBe(1);
    expect(isStrictFoodOffer(kettle)).toBe(false);
  });
});

describe('Garten-/Tier-/Deko-Non-Food gewinnt trotz Food-Kategorie', () => {
  // Reale Live-Leaks (Angebotscan 2.0): Garten-Erde, Zierpflanzen und Tierbedarf
  // bekamen eine Food-Kategorie (Obst/Gemüse, Getränke, Snacks) und blieben live.
  // Sie müssen nach filtered/non-food — auch wenn die (falsche) Kategorie Food ist.
  it('blockt Tomaten-/Gemüseerde, Passionsblume und Katzen-/Tierbedarf', () => {
    const cases: Partial<Offer>[] = [
      { name: 'Tomaten- und Gemüseerde', normalizedName: 'tomaten- und gemueseerde', category: 'Obst/Gemuese', unit: '40-l-sack', tags: [] },
      { name: 'Bio Tomatenerde', normalizedName: 'bio tomatenerde', category: 'Obst/Gemuese', unit: '20l', tags: [] },
      { name: 'Passionsblume Blau', normalizedName: 'passionsblume blau', category: 'Obst/Gemuese', unit: 'stück', tags: [] },
      { name: 'Kuscheliges Katzenkissen', normalizedName: 'kuscheliges katzenkissen', category: 'Snacks/Süßes', unit: 'stück', tags: [] },
      { name: 'Katzentoilette mit Haube', normalizedName: 'katzentoilette mit haube', category: 'Sonstiges', unit: 'stück', tags: [] },
      { name: 'XXL Kratzbaum', normalizedName: 'xxl kratzbaum', category: 'Sonstiges', unit: 'stück', tags: [] },
    ];
    for (const c of cases) {
      expect(isStrictNonFoodOffer(createOffer(c))).toBe(true);
      expect(isStrictFoodOffer(createOffer(c))).toBe(false);
    }
  });

  it('lässt echte Tomaten/Passionsfrüchte unangetastet (keine Übersperrung)', () => {
    const foods: Partial<Offer>[] = [
      { name: 'Bio Strauchtomaten', normalizedName: 'bio strauchtomaten', category: 'Obst/Gemüse', unit: '500g' },
      { name: 'Passionsfrüchte', normalizedName: 'passionsfruechte', category: 'Obst/Gemüse', unit: '3er-Schale' },
    ];
    for (const f of foods) {
      expect(isStrictFoodOffer(createOffer(f))).toBe(true);
    }
  });
});

// Scan-2.0 Datenqualität #3: Non-Food-Ausreißer (Blumen/Pailletten/Tierbedarf)
// müssen gefiltert werden — auch über Source-URL/Roh-Kategorie/Kontext, nicht nur
// über den Namen. Gleichzeitig dürfen echte Lebensmittel mit Teilstrings
// (Sonnenblumenkerne, Eintopf, Grill- und Pfannenkäse) NICHT herausfliegen.
describe('isStrictNonFoodOffer — Datenqualität #3 (Kontext + Wortgrenzen)', () => {
  it('filtert die real beobachteten Non-Food-Ausreißer', () => {
    const cases: Partial<Offer>[] = [
      { name: 'Blumen-Beiwerk', normalizedName: 'blumen-beiwerk', category: 'Sonstiges', unit: 'Bund', tags: [] },
      { name: 'Glockenblume', normalizedName: 'glockenblume', category: 'Sonstiges', unit: 'Topf', tags: [] },
      { name: 'CRELANDO® Pailletten', normalizedName: 'crelando pailletten', category: 'Sonstiges', unit: 'Pck', tags: [] },
      { name: 'Katzenassnahrung', normalizedName: 'katzenassnahrung', category: 'Sonstiges', unit: 'Beutel', tags: [] },
    ];
    for (const c of cases) {
      expect(isStrictNonFoodOffer(createOffer(c))).toBe(true);
      expect(isStrictFoodOffer(createOffer(c))).toBe(false);
    }
  });

  it('filtert NORMA-Tierbedarf über den tierisch-gut/Tierbedarf-Kontext (Name allein harmlos)', () => {
    const cases: Partial<Offer>[] = [
      {
        name: 'Kau Donuts XXL',
        normalizedName: 'kau donuts xxl',
        category: 'Snacks/Süßes',
        sourceUrl: 'https://norma.de/angebote/tierisch-gut/kau-donuts-xxl',
        tags: [],
      },
      {
        name: 'Kaurollen',
        normalizedName: 'kaurollen',
        category: 'Snacks/Süßes',
        sourceCategoryRaw: 'Tierisch gut',
        tags: [],
      },
      {
        name: 'Multisnacks',
        normalizedName: 'multisnacks',
        category: 'Snacks/Süßes',
        sourceContextRaw: 'Tierbedarf · tierisch gut',
        tags: [],
      },
    ];
    for (const c of cases) {
      expect(isStrictNonFoodOffer(createOffer(c))).toBe(true);
    }
  });

  it('lässt echte Lebensmittel mit Teilstring-Treffern in Ruhe (keine False Positives)', () => {
    const foods: Partial<Offer>[] = [
      { name: 'Sonnenblumenkerne', normalizedName: 'sonnenblumenkerne', category: 'Trockenware', unit: '200g', tags: [] },
      { name: 'Bauer Eintopf Linsen', normalizedName: 'bauer eintopf linsen', category: 'Konserven', unit: '800g', tags: [] },
      { name: 'Grill- und Pfannenkäse', normalizedName: 'grill und pfannenkaese', category: 'Milchprodukte', unit: '200g', tags: [] },
      { name: 'Blumenkohl', normalizedName: 'blumenkohl', category: 'Obst/Gemüse', unit: 'Stück', tags: [] },
    ];
    for (const f of foods) {
      expect(isStrictNonFoodOffer(createOffer(f))).toBe(false);
      expect(isStrictFoodOffer(createOffer(f))).toBe(true);
    }
  });

  it('hasHardNonFoodSignal greift ebenfalls (Phase-2-/Bridge-Schutz)', () => {
    expect(hasHardNonFoodSignal(createOffer({ name: 'Glockenblume', normalizedName: 'glockenblume', category: 'Sonstiges', tags: [] }))).toBe(true);
    expect(hasHardNonFoodSignal(createOffer({ name: 'Sonnenblumenkerne', normalizedName: 'sonnenblumenkerne', category: 'Trockenware', tags: [] }))).toBe(false);
  });
});

describe('Netto-Filialangebote — Non-Food gefiltert, Food bleibt sichtbar', () => {
  const nettoOffer = (name: string): Offer =>
    createOffer({
      id: `netto_${name}`,
      name,
      normalizedName: name.toLowerCase(),
      storeChain: 'Netto',
      category: 'Sonstiges',
      sourceUrl: 'https://www.netto-online.de/online-wochenangebote/c-N0794',
      tags: ['filiale'],
    });

  it('filtert die Netto-Non-Food-Beispiele (Toilettenpapier, Katzennahrung)', () => {
    for (const name of ['Glücksblatt Toilettenpapier', 'Premiere Katzennahrung']) {
      expect(isStrictNonFoodOffer(nettoOffer(name))).toBe(true);
    }
  });

  it('laesst die Netto-Food-Beispiele sichtbar', () => {
    for (const name of [
      'Almette Frischkäse/-zubereitung',
      'Bananen',
      'iglo Fischstäbchen oder Backfischstäbchen',
      'Patros Feta',
      'Haribo Fruchtgummi',
      'Fußball Laugenbrötchen',
    ]) {
      expect(isStrictNonFoodOffer(nettoOffer(name))).toBe(false);
    }
  });
});

describe('hasStrongFoodSourceSignal — Händler-Quellkategorie schlägt Modell-Halluzination', () => {
  const nahkaufOffer = (name: string, sourceCategoryRaw: string, extra: Partial<Offer> = {}): Offer =>
    createOffer({
      id: `nk_${name}`,
      name,
      normalizedName: name.toLowerCase(),
      storeChain: 'nahkauf',
      category: 'Sonstiges',
      sourceUrl: 'https://www.nahkauf.de/angebote-im-markt/',
      tags: ['nahkauf-storyblok', 'national'],
      ...( { sourceCategoryRaw } as Partial<Offer>),
      ...extra,
    });

  it('erkennt Food-Quellkategorien (Frühstück, Frische & Convenience)', () => {
    // Reproduktionsbeispiele: das Modell hielt Kaffee-Pads für Non-Food und
    // Bratmaxe für eine Pfanne — die REWE_CATEGORY sagt eindeutig Food.
    expect(hasStrongFoodSourceSignal(nahkaufOffer('Jacobs Crema Pads', 'Frühstück'))).toBe(true);
    expect(
      hasStrongFoodSourceSignal(nahkaufOffer('Meica Bratmaxe', 'Frische & Convenience')),
    ).toBe(true);
    expect(hasStrongFoodSourceSignal(nahkaufOffer('Oberdorfer Helles', 'Bier'))).toBe(true);
  });

  it('vetoet Non-Food-Quellkategorien (Drogerie/Haushalt) und harte Non-Food-Signale', () => {
    expect(hasStrongFoodSourceSignal(nahkaufOffer('Rexona Deospray', 'Drogerie'))).toBe(false);
    expect(hasStrongFoodSourceSignal(nahkaufOffer('Fit Spülmittel', 'Haushalt'))).toBe(false);
    expect(hasStrongFoodSourceSignal(nahkaufOffer('Kuschelweich Weichspüler', 'Drogerie'))).toBe(false);
    // nonfood-Tag (Connector-Hartsignal) gewinnt selbst gegen eine Food-Kategorie.
    expect(
      hasStrongFoodSourceSignal(
        nahkaufOffer('Geschenkkorb', 'Feinkost', { tags: ['nonfood'] }),
      ),
    ).toBe(false);
  });

  it('liefert false ohne Quellkategorie (kein blindes Retten)', () => {
    expect(
      hasStrongFoodSourceSignal(createOffer({ name: 'Unbekannt', category: 'Sonstiges' })),
    ).toBe(false);
  });
});

describe('isStrictFoodOffer — strukturierte Food-Verdikte schlagen die Keyword-Allowlist', () => {
  it('behaelt Food, das die KI explizit als Food eingestuft hat (Maggi-Suppe-Fall)', () => {
    // Reproduktionsbeispiel: "Suppe" steht in keiner Keyword-Liste; die
    // Allowlist warf das Angebot trotz KI-Verdikt isNonFood:false weg.
    const maggi = createOffer({
      id: 'nk_maggi',
      name: 'Maggi Guten Appetit Suppe',
      normalizedName: 'maggi guten appetit suppe',
      storeChain: 'nahkauf',
      category: 'Sonstiges',
      ...( {
        sourceCategoryRaw: 'Kochen & Backen',
        canonicalCategory: { main: 'Konserven & Fertiggerichte', sub: 'Suppen', isNonFood: false },
      } as Partial<Offer>),
    });
    expect(isStrictFoodOffer(maggi)).toBe(true);
    const result = filterOffersStrictFood([maggi]);
    expect(result.offers).toHaveLength(1);
    expect(result.removedCount).toBe(0);
  });

  it('behaelt Food mit eindeutiger Haendler-Quellkategorie auch ohne KI-Verdikt', () => {
    const offerWithSource = createOffer({
      id: 'nk_src',
      name: 'Bratmaxe Spezial',
      normalizedName: 'bratmaxe spezial',
      category: 'Sonstiges',
      ...( { sourceCategoryRaw: 'Frische & Convenience' } as Partial<Offer>),
    });
    expect(isStrictFoodOffer(offerWithSource)).toBe(true);
  });

  it('laesst hartes Non-Food trotz (falschem) KI-Food-Verdikt nicht durch', () => {
    const fake = createOffer({
      id: 'nk_fake',
      name: 'CRELANDO Pailletten-Set',
      normalizedName: 'crelando pailletten-set',
      category: 'Sonstiges',
      ...( {
        canonicalCategory: { main: 'Konserven & Fertiggerichte', isNonFood: false },
      } as Partial<Offer>),
    });
    // isStrictNonFoodOffer-Veto (hartes Keyword) laeuft VOR dem Food-Verdikt.
    expect(isStrictFoodOffer(fake)).toBe(false);
  });
});

describe('Kaufland Non-Food-Regressionen — Substring-Fallen (Sekt/Bier/Eier/Wein)', () => {
  const kl = (name: string): Offer =>
    createOffer({
      id: `kl_${name}`,
      name,
      normalizedName: name.toLowerCase(),
      storeChain: 'Kaufland',
      category: 'Sonstiges',
      sourceUrl: 'https://filiale.kaufland.de/angebote/aktuelle-woche.html',
      tags: [],
    });

  it('haelt Geschirr/Geraete/Haushalt trotz Food-Substrings im Filtered-Bucket', () => {
    for (const name of [
      'SILVERCREST Sektgläser',
      'EASYMAXX Bierzeltgarnitur',
      'SILVERCREST Eierkocher',
      'Wasserkocher Edelstahl',
      'WC-Gel Zitrus',
    ]) {
      expect(isStrictNonFoodOffer(kl(name))).toBe(true);
      expect(isStrictFoodOffer(kl(name))).toBe(false);
    }
  });

  it('laesst echte Lebensmittel mit denselben Substrings durch (Sekt, Bier, Eier, Weinblätter)', () => {
    for (const name of ['Rotkäppchen Sekt halbtrocken', 'Oberdorfer Helles Bier', 'Eier Freilandhaltung 10er', 'Weinblätter gefüllt']) {
      expect(isStrictNonFoodOffer(kl(name))).toBe(false);
    }
  });
});

describe('Gemischte Kategorie "Obst, Gemüse, Pflanzen" — Frische bleibt Food, Pflanzen nicht', () => {
  const klMixed = (name: string): Offer =>
    createOffer({
      id: `klm_${name}`,
      name,
      normalizedName: name.toLowerCase(),
      storeChain: 'Kaufland',
      category: 'Sonstiges',
      sourceUrl: 'https://filiale.kaufland.de/angebote/aktuelle-woche.html',
      tags: [],
      ...( { sourceCategoryRaw: 'Obst, Gemüse, Pflanzen' } as Partial<Offer>),
    });

  it('laesst Frische-Angebote trotz "Pflanzen" im Kategorienamen durch', () => {
    // Reproduktionsbeispiele: das Kontext-Wortgrenzen-Signal "pflanzen" warf
    // die KOMPLETTE Kaufland-Frische-Abteilung in den Filtered-Bucket.
    for (const name of [
      'Dtsch. Erdbeeren',
      'Span./ital. Spargel',
      'Dtsch. Rispentomaten',
      'Neuseel. Kiwi gold',
      'Kenian./peruan. Bio-Avocados',
      'Dtsch. Basilikum XXL',
    ]) {
      expect(isStrictNonFoodOffer(klMixed(name))).toBe(false);
    }
  });

  it('filtert echte Pflanzen/Blumen aus derselben Kategorie weiterhin', () => {
    for (const name of ['Nelken', 'Orchidee', 'Blühpflanzen', 'Gartenpflanzen', 'Bio-Weinrebe']) {
      expect(isStrictNonFoodOffer(klMixed(name))).toBe(true);
    }
  });

  it('Gewürznelken und Sonnenblumenkerne bleiben Food (Wortgrenzen-Schutz)', () => {
    expect(isStrictNonFoodOffer(klMixed('Gewürznelken gemahlen'))).toBe(false);
    expect(isStrictNonFoodOffer(klMixed('Sonnenblumenkerne 500 g'))).toBe(false);
  });

  it('PURINA Tierfutter bleibt Non-Food', () => {
    expect(isStrictNonFoodOffer(klMixed('PURINA GOURMET Gold'))).toBe(true);
  });
});

describe('Starke Non-Food-Signale — Kleidung/Spielzeug/Möbel/Auto/Geräte schlagen falsches KI-Food-Verdikt', () => {
  // Reproduktionsbeispiele aus einem realen Snapshot (nur Test-Fixtures, keine
  // Produktliste im Produktivcode): klares Non-Food bekam
  // canonicalCategory.main="Grundnahrungsmittel" (isNonFood:false) und blieb
  // dadurch live. Der starke Non-Food-Signalpfad muss solche Modell-Fehler
  // überschreiben — KW-unabhängig, rein über Domänen-Vokabular/Marken.
  const liveLeak = (name: string, storeChain = 'Kaufland'): Offer =>
    createOffer({
      id: `leak_${name}`,
      name,
      normalizedName: name.toLowerCase(),
      storeChain,
      category: 'Grundnahrungsmittel',
      unit: 'Stk',
      tags: [],
      ...({
        canonicalCategory: { main: 'Grundnahrungsmittel', isNonFood: false, confidence: 0.9 },
      } as Partial<Offer>),
    });

  const kauflandNextWeekLeaks = [
    '3D-Teppich',
    'ADIDAS WM 2026 Match Ball',
    'BABY BORN Puppe',
    'BESTWAY Wasserspielcenter',
    'Kinder-Picknicktisch',
    'LUPILU Kinder-Planschbecken',
    'Elektrischer BBQ-Standgrill',
    'Fußballsocken',
    'Nass-/Trockensauger',
  ];

  const aldiSuedLeaks = [
    'Beistelltisch in Steinoptik',
    'Damen BH-Top',
    'Damen Capri-Jeans',
    'Damen Culotte',
    'Damen Kleid',
    'Damen Komfort-Unterwäsche',
    'Auto-Interieur-Accessoires',
    'Auto-Organizer',
    'Auto-Sonnenschutz',
    '7-Zonen-Komfortschaummatratze',
  ];

  it('erkennt die Kaufland-nextWeek-Leaks als hartes Non-Food trotz Food-Kategorie', () => {
    for (const name of kauflandNextWeekLeaks) {
      const leaked = liveLeak(name);
      expect(isStrictNonFoodOffer(leaked), name).toBe(true);
      expect(hasHardNonFoodSignal(leaked), name).toBe(true);
      expect(isStrictFoodOffer(leaked), name).toBe(false);
    }
  });

  it('erkennt die ALDI-SUED-Leaks als hartes Non-Food trotz Food-Kategorie', () => {
    for (const name of aldiSuedLeaks) {
      const leaked = liveLeak(name, 'ALDI SUED');
      expect(isStrictNonFoodOffer(leaked), name).toBe(true);
      expect(hasHardNonFoodSignal(leaked), name).toBe(true);
      expect(isStrictFoodOffer(leaked), name).toBe(false);
    }
  });

  it('laesst doppeldeutiges Food (Grill/Pfanne/Brot/Kaffee/Wein) weiterhin ohne Hartsignal', () => {
    for (const name of [
      'Grillkäse Natur',
      'Pfannenkäse Kräuter',
      'Rostbratwurst vom Grill',
      'Steinofen-Pizza Salami',
      'Dallmayr Kaffeepads Classic',
      'Brotaufstrich Paprika',
      'Funny-frisch Chips Paprika',
      'Rotkäppchen Sekt halbtrocken',
      'Balsamico di Modena',
      'Salatkrönung Gartenkräuter',
    ]) {
      const food = createOffer({
        id: `food_${name}`,
        name,
        normalizedName: name.toLowerCase(),
        category: 'Sonstiges',
        unit: 'Stk',
        tags: [],
      });
      expect(isStrictNonFoodOffer(food), name).toBe(false);
      expect(hasHardNonFoodSignal(food), name).toBe(false);
      expect(hasStrongNonFoodSignal(food), name).toBe(false);
    }
  });

  it('Food mit KI-Food-Verdikt bleibt Food (kein Keyword-Overkill)', () => {
    for (const name of ['Grillkäse Natur', 'Rostbratwurst vom Grill', 'Dallmayr Kaffeepads Classic']) {
      const food = createOffer({
        id: `foodki_${name}`,
        name,
        normalizedName: name.toLowerCase(),
        category: 'Sonstiges',
        unit: 'Stk',
        tags: [],
        ...({
          canonicalCategory: { main: 'Milchprodukte', isNonFood: false, confidence: 0.9 },
        } as Partial<Offer>),
      });
      expect(isStrictFoodOffer(food), name).toBe(true);
    }
  });
});

describe('isStrictFoodOffer — REWE Bedientheke/Suppe/Käse (Shop-Prompt 4)', () => {
  // Generische Regeln, KEINE Produkt-Allowlist: Bedientheke = Food-Quelle,
  // 'suppe' = Gericht-Vokabular, Käsesorten = Milchprodukt-Vokabular.
  function reweOffer(name: string, sourceCategoryRaw: string): Offer {
    return createOffer({
      id: name,
      name,
      normalizedName: name.toLowerCase(),
      category: 'Sonstiges',
      tags: ['rewe', 'browser-import'],
      unit: 'Stk',
      ...( { sourceCategoryRaw } as Partial<Offer> ),
    });
  }

  it('lässt Bedientheken-Artikel (Le Gruyère AOP, Neuburger) als Food durch', () => {
    expect(isStrictFoodOffer(reweOffer('Le Gruyère AOP', 'An der Bedientheke'))).toBe(true);
    expect(isStrictFoodOffer(reweOffer('Neuburger', 'An der Bedientheke'))).toBe(true);
  });

  it('lässt Suppen/Fertiggerichte (Maggi Guten Appetit Suppe) als Food durch', () => {
    expect(isStrictFoodOffer(reweOffer('Maggi Guten Appetit Suppe', 'Bonus-Aktionen'))).toBe(true);
  });

  it('erkennt Käsesorten auch ohne Theken-Kontext als Food', () => {
    expect(isStrictFoodOffer(reweOffer('Gruyère gerieben', 'Bonus-Aktionen'))).toBe(true);
    expect(isStrictFoodOffer(reweOffer('Raclette Scheiben', 'Bonus-Aktionen'))).toBe(true);
  });

  it('filtert klares Non-Food weiterhin heraus (Pampers, Blumen, Drogerie)', () => {
    expect(isStrictFoodOffer(reweOffer('Pampers Windeln', 'Drogerie'))).toBe(false);
    expect(isStrictFoodOffer(reweOffer('Blumen-Beiwerk', 'Bonus-Aktionen'))).toBe(false);
    expect(isStrictFoodOffer(reweOffer('NIVEA Duschgel', 'Bonus-Aktionen'))).toBe(false);
  });
});

describe('Schnittblumen/Zierpflanzen — der Produktname entscheidet (Problem A: sichtbare Blumen-Leaks)', () => {
  // Reproduktions-Fixtures aus einem realen Snapshot (KEINE Produktliste im
  // Produktivcode): Blumen lagen in der gemischten Abteilung "Obst, Gemüse,
  // Pflanzen" und wurden als Obst/Gemüse live gezeigt. Der Produktname muss
  // entscheiden, nicht die ganze Abteilung.
  const mixed = (name: string, storeChain = 'Kaufland'): Offer =>
    createOffer({
      id: `flower_${name}`,
      name,
      normalizedName: name.toLowerCase(),
      storeChain,
      category: 'Obst/Gemuese',
      sourceUrl: 'https://filiale.kaufland.de/angebote/aktuelle-woche.html',
      unit: 'Stk',
      tags: [],
      ...({ sourceCategoryRaw: 'Obst, Gemüse, Pflanzen' } as Partial<Offer>),
    });

  it('erkennt sichtbare Blumen/Schnittblumen als hartes Non-Food trotz Food-Abteilung', () => {
    const fixtures: Array<[string, string]> = [
      ['Chrysantheme', 'Kaufland'],
      ['Rosen', 'Kaufland'],
      ['Großköpfige Hochland Rosen', 'Netto'],
      ['Hortensie', 'Kaufland'],
      ['Bunter Blumenstrauß', 'Kaufland'],
      ['Schnittblumen gemischt', 'Kaufland'],
      ['Rosenstrauß rot', 'Kaufland'],
    ];
    for (const [name, store] of fixtures) {
      const o = mixed(name, store);
      expect(isStrictNonFoodOffer(o), name).toBe(true);
      expect(hasHardNonFoodSignal(o), name).toBe(true);
      expect(isStrictFoodOffer(o), name).toBe(false);
    }
  });

  it('lässt echtes Obst/Gemüse, Kohl, Kerne und Speisepilze in derselben Abteilung Food', () => {
    for (const name of [
      'Sonnenblumenkerne 500 g',
      'Rosenkohl',
      'Blumenkohl',
      'Pflücksalat',
      'Kräuterseitlinge',
      'Speisepilze gemischt',
      'Dtsch. Erdbeeren',
    ]) {
      const o = mixed(name);
      expect(isStrictNonFoodOffer(o), name).toBe(false);
      expect(hasHardNonFoodSignal(o), name).toBe(false);
    }
  });

  it('lebende "...-pflanze" ist Non-Food, pflanzliche Lebensmittel (Präfix) bleiben Food', () => {
    for (const name of ['Kräuterpflanze im Topf', 'Tomatenpflanze', 'Chilipflanze']) {
      expect(isStrictNonFoodOffer(mixed(name)), name).toBe(true);
    }
    for (const name of ['Pflanzenöl', 'Pflanzendrink Natur', 'Pflanzliche Margarine']) {
      expect(isStrictNonFoodOffer(mixed(name)), name).toBe(false);
    }
  });
});

describe('Gewürze/Küchenkräuter & Convenience-Obst werden nicht falsch gefiltert (Problem B)', () => {
  // Reproduktions-Fixtures: ALDI-Gewürz-Nachfüllbeutel + verzehrfertiges Obst
  // landeten im Filtered-Bucket. Strukturelle Regeln, KEINE Produkt-Allowlist.
  const item = (name: string, extra: Partial<Offer> = {}): Offer =>
    createOffer({
      id: `b_${name}`,
      name,
      normalizedName: name.toLowerCase(),
      storeChain: 'ALDI SUED',
      category: 'Sonstiges',
      unit: 'Stk',
      tags: [],
      ...extra,
    });

  it('erkennt Gewürze & getrocknete Küchenkräuter als Food (auch im Nachfüllbeutel)', () => {
    for (const name of [
      'Kräuter und Gewürze im Nachfüllbeutel Paprika edelsüß',
      'Basilikum gerebelt',
      'Dillspitzen',
      'Pfeffer schwarz gemahlen',
      'Rosmarin geschnitten',
      'Thymian gerebelt',
      'Koriander gemahlen',
      'Majoran',
    ]) {
      const o = item(name);
      expect(isStrictNonFoodOffer(o), name).toBe(false);
      expect(hasStrongFoodSignal(o), name).toBe(true);
      expect(isStrictFoodOffer(o), name).toBe(true);
    }
  });

  it('schützt Gegenbeispiele: elektr. Gewürzmühle, lebende Kräuterpflanze, Pfefferspray', () => {
    for (const name of [
      'Elektrische Salz- oder Pfeffermühle',
      'Gewürzmühle Edelstahl',
      'Kräuterpflanze im Topf',
      'Pfefferspray Abwehr',
    ]) {
      const o = item(name);
      expect(isStrictNonFoodOffer(o), name).toBe(true);
      expect(hasRuleConfirmedNonFoodSignal(o), name).toBe(true);
      expect(isStrictFoodOffer(o), name).toBe(false);
    }
  });

  it('rettet verzehrfertiges Obst, lässt Kunststoff-/Plastikbecher Non-Food', () => {
    for (const name of ['Obst im Becher', 'Obstsalat', 'Frische Obst Mischung']) {
      const o = item(name);
      expect(hasStrongFoodSignal(o), name).toBe(true);
      expect(isStrictFoodOffer(o), name).toBe(true);
    }
    for (const name of ['Kunststoffbecher 4er', 'Plastikbecher']) {
      const o = item(name);
      expect(isStrictFoodOffer(o), name).toBe(false);
    }
  });
});
