import { Offer } from '../../src/types/models';
import { normalizeText } from '../../src/utils/offers';
import {
  FilterRulesState,
  loadFilterRulesState,
  saveFilterRulesState,
} from './store/filterRulesStore';

export interface StrictFoodFilterResult {
  offers: Offer[];
  removedOffers: Offer[];
  removedCount: number;
  removedExamples: string[];
}

export interface StrictFoodFilterList {
  blockedKeywords: string[];
  blockedCategoryKeywords: string[];
  allowedCategoryKeywords: string[];
  allowedKeywords: string[];
  allowedTags: string[];
  customBlockedKeywords: string[];
  removedBlockedKeywords: string[];
  envBlockedKeywords: string[];
  learnedAllowedOfferNames: string[];
  learnedBlockedOfferNames: string[];
}

// Starke, eindeutige Non-Food-Signale (Marken + Begriffe), die in Scan 1.0 UND
// Scan 2.0 zuverlässig nach `filtered` müssen — auch wenn die KI nur
// foodFlag="unsure" / isNonFood=false geliefert hat. Bewusst HOCHPRÄZISE
// gehalten (Lidl-Non-Food-Eigenmarken + Insektenschutz/Schädlingsbekämpfung),
// damit nie echte Lebensmittel versehentlich rausfliegen. Geteilt mit dem
// Categorizer-Bridge-Repair über `hasStrongNonFoodSignal`.
export const STRONG_NON_FOOD_KEYWORDS = [
  // Bierzelt-/Garten-Möbel: enthalten "Bier", sind aber Möbel, kein Lebensmittel
  // (ALDI SUED "Bierzeltgarnitur" 49,99 € landete fälschlich als Alkohol live).
  'bierzeltgarnitur',
  'bierzeltgarnituren',
  'bierzeltbank',
  'festzeltgarnitur',
  'bierbank',
  'bierbankgarnitur',
  'biertisch',
  'biergarnitur',
  // Lidl Non-Food-Eigenmarken (nie Lebensmittel)
  'livarno',
  'parkside',
  'crivit',
  'esmara',
  'silvercrest',
  'powerfix',
  'florabest',
  'ernesto', // Lidl Haushalt/Küchenwaren (Geschirr/Töpfe) — kein Lebensmittel
  'gardena', // Garten-Geräte-Marke (Schläuche/Anschlüsse) — nie Lebensmittel
  'gardenline', // ALDI Garten-Eigenmarke (Pflanzen/Geräte/Deko) — nie Lebensmittel.
  // So bleibt eine „Gardenline Curcuma Siam" (Zierpflanze) Non-Food, während
  // „Kurkuma/Curcuma" als Gewürz aus einer Gewürz-Quelle Food bleibt.
  // Insektenschutz / Schädlingsbekämpfung
  'insektenschutz',
  'insektenschutzmittel',
  'insektenvernichter',
  'insektenfalle',
  'insektenfallen',
  'insektenspray',
  'insektenlampe',
  'insektenstich', // Stichheiler/Kühlgel — Drogerie, nie Lebensmittel
  'insektenabwehr',
  'uv-insektenfalle',
  'fliegengitter',
  'fliegenklatsche',
  'fliegenfaenger',
  'fliegenfalle',
  'mueckenstecker',
  'mueckenschutz',
  'moskitonetz',
  'moskito',
  'ungezieferspray',
  'maeusefalle',
  'rattenkoeder',
  // ── Domänen-Vokabular (KW-unabhängig): klares Non-Food, das vom Modell
  // wiederholt eine Food-Kategorie ("Grundnahrungsmittel") bekam. Bewusst
  // präzise Komposita/Marken — KEINE Einzelwörter wie 'ball'/'grill'/'top',
  // die echte Lebensmittel (Grillkäse, Burger-Topping) treffen könnten.
  // Kleidung/Wäsche/Schuhe
  'jeans',
  'culotte',
  'kleid', // Kleid/Kleidung/Sommerkleid — kein deutsches Lebensmittel enthält 'kleid'
  'unterwaesche',
  'unterwasche',
  'unterhose',
  'boxershorts',
  'socken',
  'struempfe',
  'strumpfe',
  'strumpfhose',
  'leggings',
  'bh-top',
  'bh', // ≤3 Zeichen ⇒ Wortgrenzen-Match ("Damen BH-Top", nie Teilwort)
  'pullover',
  'sweatshirt',
  'sweatjacke',
  'jogginghose',
  'bademantel',
  'badeanzug',
  'badehose',
  'badeshorts',
  'badeponcho',
  'poncho', // Regen-/Strand-/Badeponcho — Kleidung, nie ein Lebensmittel
  'bademode',
  'bikini',
  'tankini', // zweiteilige Badebekleidung (wie Bikini) — Textil, nie Lebensmittel
  'pyjama',
  'schlafanzug',
  'nachthemd',
  'sneaker',
  'sandalen',
  'pantoletten',
  'hausschuhe',
  'badeschuhe',
  'turnschuhe',
  // Spielzeug/Sport (Marken sind nie Lebensmittel)
  'puppe',
  'kuscheltier',
  'plueschtier',
  'pluschtier',
  'planschbecken',
  'wasserspielcenter',
  'sandkasten',
  'brettspiel',
  'puzzle',
  'lego',
  'playmobil',
  'playtive',
  'lupilu',
  'pepperts',
  'adidas',
  'baby born',
  'bestway',
  'intex',
  'yogamatte',
  'gymnastikmatte',
  'hantel',
  // Möbel/Heimtextil
  'matratze',
  'teppich',
  'beistelltisch',
  'picknicktisch',
  'klapptisch',
  'gartentisch',
  'gartenstuhl',
  'sonnenliege',
  'sonnenschirm',
  'hollywoodschaukel',
  // Autozubehör
  'auto-organizer',
  'autoorganizer',
  'auto-sonnenschutz',
  'auto-interieur',
  'autozubehoer',
  'autozubehor',
  'autositz',
  'kindersitz',
  'dachbox',
  'dachtraeger',
  'dachtrager',
  'scheibenwischer',
  'autobatterie',
  // Drogerie/Sonnenschutz (Sonnencreme wie Auto-Blende: beides Non-Food)
  'sonnenschutz',
  // Reinigung/Hygiene (Domänen-Vokabular, keine Produktliste): muss als HARTES
  // Regel-Signal auch den Food-Rescue blocken — der PENNY-Fall "VISS
  // Scheuermilch" wurde sonst über den 'milch'-Substring gerettet. 'reiniger'
  // deckt Allzweck-/Glas-/Bad-/WC-Reiniger ab; kein Lebensmittel enthält es.
  'scheuermilch',
  'scheuerpulver',
  'scheuermittel',
  'spuelmittel',
  'spulmittel',
  'weichspueler',
  'weichspuler',
  'hygienespueler',
  'hygienespuler',
  'hygiene-spueler',
  'hygiene-spuler',
  'reinigungsmittel',
  'reiniger',
  'putzmittel',
  'entkalker',
  // Drogerie-"Milch"-Komposita (Pflege, nie Lebensmittel) — Voll-/Butter-/
  // Kokosmilch bleiben unberührt, weil nur diese Komposita matchen.
  'reinigungsmilch',
  'sonnenmilch',
  'koerpermilch',
  'korpermilch',
  'putzmilch',
  // Haushalts-/Gartengeräte (Komposita — nie 'grill' allein: Grillkäse bleibt Food)
  'trockensauger',
  'nasssauger',
  'saugroboter',
  'standgrill',
  'elektrogrill',
  'gasgrill',
  'holzkohlegrill',
  'kontaktgrill',
  'tischgrill',
  'kugelgrill',
  'grillwagen',
  'waschmaschine',
  'waeschetrockner',
  'waschetrockner',
  'geschirrspueler',
  'geschirrspuler',
  'buegeleisen',
  'bugeleisen',
  'ventilator',
  'klimageraet',
  'klimagerat',
  'heizluefter',
  'heizlufter',
  'maehroboter',
  'mahroboter',
  // Pool/Wasserspielzeug
  'swimmingpool',
  'whirlpool',
  'schwimmbecken',
  'schwimmring',
  'schwimmfluegel',
  'schwimmflugel',
] as const;

const defaultNonFoodKeywords = [
  ...STRONG_NON_FOOD_KEYWORDS,
  'wasserkocher',
  'kaffeemaschine',
  'kaffeepadmaschine',
  // Kapsel-Kaffeemaschinen: das Gerät trägt den Getränkenamen im Produktnamen
  // ("KRUPS Kaffeekapselmaschine Nescafé Dolce Gusto") und wurde ohne diesen
  // Beleg über das Food-Keyword 'kaffee' zum Lebensmittel.
  'kaffeekapselmaschine',
  'kapselmaschine',
  'espressomaschine',
  'toaster',
  'mikrowelle',
  'fritteuse',
  // Saft-/Mixgeräte — dieselbe Falle über den Getränke-Substring.
  'entsafter',
  'saftpresse',
  'standmixer',
  'kuechenmaschine',
  'kuchenmaschine',
  'kuechenwaage',
  'kuchenwaage',
  // Backzubehör und Wasseraufbereitung: Geräte/Zubehör, deren Name ein
  // Lebensmittelwort ('back', 'pizza', 'wasser') enthält.
  'backblech',
  'pizzablech',
  'wasserenthaerter',
  'motoroel',
  'motorol',
  'motor oel',
  'motor ol',
  'motorenoel',
  'motorenol',
  '5w30',
  '5w-30',
  'liqui moly',
  'adblue',
  'kuehlmittel',
  'bremsfluessigkeit',
  'bremsflussigkeit',
  'scheibenfrostschutz',
  'haustier',
  'heimtier',
  'tiernahrung',
  'hundefutter',
  'hunde-futter',
  'hundenahrung',
  'hundenassfutter',
  'hundevollnahrung',
  'hundesnack',
  'hundesnacks',
  'katzenfutter',
  'katzen-futter',
  'tierfutter',
  'futtermittel',
  'katzenstreu',
  'hygienestreu',
  // Katzen-/Tierbedarf (kein Futter): Kissen/Klo/Kratzbaum bleiben non-food,
  // auch wenn die KI eine Food-Kategorie (Snacks/Sonstiges) geraten hat.
  'katzenkissen',
  'tierkissen',
  'hundekissen',
  'katzentoilette',
  'katzenklo',
  'kratzbaum',
  'katzenbaum',
  'katzennahrung',
  'katzensnack',
  'katzen-snack',
  'katzen-snacks',
  'katzensnacks',
  'klumpstreu',
  'ultra-klumpstreu',
  'catsan',
  'vogelfutter',
  'vitakraft',
  'purina',
  'pedigree',
  'beneful',
  'josi cat',
  'josi dog',
  'josi',
  'whiskas',
  'wow hundenahrung',
  'shampoo',
  'spuelung',
  'spulung',
  'duschgel',
  'dusche',
  'schaumbad',
  'badeschaum',
  'cremedusche',
  'handcreme',
  'hand creme',
  'handcream',
  'hand cream',
  'handlotion',
  'hand lotion',
  'sonnencreme',
  'body mist',
  'bodymist',
  'bodymilk',
  'body milk',
  'bodylotion',
  'body lotion',
  'koerperlotion',
  'korperlotion',
  'nivea',
  'mixa',
  'lacura',
  'dove',
  'deo',
  'deodorant',
  'deospray',
  'zahnpasta',
  'kosmetik',
  'koerperpflege',
  'korperpflege',
  'parfum',
  'got2b',
  'garnier',
  'loreal',
  'gesichtspflege',
  'duschcreme',
  'seife',
  'mizellen-reinigungswasser',
  'mizellen reinigungswasser',
  'reinigungswasser',
  'tuchmaske',
  'strand matte',
  'strand-matte',
  'strandmatte',
  'eau de parfum',
  'eau de toilette',
  'edp',
  'edt',
  'makeup',
  'haarspray',
  'nagellack',
  'waschmittel',
  'lenor',
  'waescheparfuem',
  'waescheparfum',
  'wascheparfuem',
  'wascheparfum',
  'persil',
  'waschpulver',
  'kraft-gel',
  'kraft gel',
  '4-in-1-discs',
  '4 in 1 discs',
  'discs color',
  'weichspueler',
  'weichspuler',
  'wc aktiv',
  'wc-aktiv',
  'wc gel',
  'wc-gel',
  'wc reiniger',
  'wc-reiniger',
  'wc frisch',
  'wc-frisch',
  'reiniger',
  'reinigungsmittel',
  'klarspueler',
  'klarspuler',
  'glanz- und klarspueler',
  'glanz- und klarspuler',
  'maschinenpfleger',
  'finish klarspueler',
  'finish klarspuler',
  'finish maschinenpfleger',
  'finish powerball',
  'finish ultimate',
  'toilettenreiniger',
  'toiletten-reiniger',
  'febreze',
  'lufterfrischer',
  'luftentfeuchter',
  // BEWUSST KEIN bare 'nachfueller'/'nachfuellbeutel'/'nachfuellflakon': das ist
  // eine VERPACKUNGSFORM, keine Produktklasse. Ein Gewürz-/Lebensmittel-
  // Nachfüllbeutel ("Kräuter und Gewürze im Nachfüllbeutel") ist Food. Drogerie-
  // Refills tragen ihr eigenes Non-Food-Wort (Weichspüler/Lenor/Febreze/
  // Lufterfrischer) und werden weiterhin geblockt.
  'putzmittel',
  'toilettenpapier',
  'kuechentuch',
  'kuchentuch',
  'kuechentuecher',
  'kuchentucher',
  'kuchenpapier',
  'kuechenpapier',
  'kuechenrolle',
  'kuchenrolle',
  'kuechenrollen',
  'kuchenrollen',
  'haushaltstuecher',
  'haushaltstucher',
  'putztuecher',
  'putztucher',
  'papierhandtuecher',
  'papierhandtucher',
  'serviette',
  'servietten',
  'bohrmaschine',
  'werkzeug',
  // ── Generische Non-Food-Produktklassen (Domänen-Vokabular, KEINE Marken/
  // Produktliste), die aus generischen Quellabteilungen ("Sonstiges") wiederholt
  // eine Food-Kategorie geraten bekamen. Bewusst PRÄZISE Komposita — KEINE
  // mehrdeutigen Einzelwörter: 'pumpe' träfe „Pumpernickel", 'buch' träfe
  // „Buchweizen", 'block' träfe „Blockmalz", 'matte' träfe „Backmatte". Daher
  // nur eindeutige Komposita/Längen-Wörter ohne Food-Teilstring.
  // Werkzeug
  'bohrer',
  'bit-set',
  'bit set',
  'bitset',
  'schraubendreher',
  'schraubenschluessel',
  'akkuschrauber',
  'bohrschrauber',
  'zange',
  'saege',
  // Pumpen / Vakuum (nie bare 'pumpe' → „Pumpernickel")
  'luftpumpe',
  'handpumpe',
  'fahrradpumpe',
  'vakuumpumpe',
  'elektrische pumpe',
  'vakuumbeutel',
  'vakuumierer',
  'vakuumiergeraet',
  // Matten/Beläge (nie bare 'matte' → „Backmatte"; Back-/Strandmatte separat)
  'fussmatte',
  'fussmatten',
  'sauberlaufmatte',
  'bodenmatte',
  'tuermatte',
  // Bücher/Blöcke/Hefte (Beschäftigung/Rätsel/Malen) — nie bare 'buch'/'block'/
  // 'heft': „Buchweizen"/„Blockmalz" bleiben Food.
  'beschaeftigungsbuch',
  'beschaeftigungsblock',
  'raetselbuch',
  'raetselblock',
  'raetselheft',
  'malbuch',
  'malblock',
  'malheft',
  'ausmalbuch',
  'bastelbuch',
  'bastelblock',
  'stickerbuch',
  'stickerheft',
  'vorlesebuch',
  'wimmelbuch',
  'kinderbuch',
  'notizbuch',
  'notizblock',
  'schreibblock',
  'reisekoffer',
  'koffer',
  'trolley',
  'akku',
  'batterie',
  'gluehbirne',
  'gluhbirne',
  'lampe',
  'kleidung',
  'schuhe',
  'jacke',
  'hose',
  'guertel', // Ledergürtel etc. — kein Lebensmittel enthält 'gürtel'
  'shirt',
  't-shirt',
  't shirt',
  'spielzeug',
  'crivit',
  'poolsitz',
  'wasserhaengematte',
  'wasserhangematte',
  'wasserspielmatte',
  'wassermattensortiment',
  'springmatte',
  'smartphone',
  'iphone',
  'paddle board',
  'stand up paddle',
  'carport',
  'gartenbank',
  'balkonkraftwerk',
  'photovoltaik',
  'eismaschine',
  'silvercrest',
  'nudelmaschine',
  'handstaubsauger',
  'staubsauger',
  'fruchtsaftkrug',
  'pizzaschneidebrett',
  'schneidebrett',
  'wasserkaraffe',
  'karaffe',
  'bierkastenkuehltasche',
  'bierkastenkuhltasche',
  'kuehltasche',
  'kuhltasche',
  'reifenpflege',
  'reiskocher',
  'pizza-ofen',
  'pizzaofen',
  'wasserbomben',
  'wasserbomben-set',
  'wasserball', // Spielzeug; deckt auch 'wasserballons' als Teilstring ab
  'water balloons',
  'bunch o balloons',
  'balloons',
  'wasserfilter',
  'wasserfilterkanne',
  'wasserfilter-kartuschen',
  'filterkartusche',
  'filter-kartusche',
  'kartusche',
  'wassersprudler',
  'sprudler',
  'kaffeevollautomat',
  'kaffeebereiter',
  'teelicht',
  'teelichte',
  'duft-teelichte',
  'duftkerze',
  'duft kerze',
  'nasendusche',
  'nasenspray',
  'nasen spray',
  'zahncreme',
  'zahnpflege',
  'heilsalbe',
  'geschenkset',
  'badefee',
  'tesori d oriente',
  'tesori doriente',
  'reiseartikel',
  'reisebett',
  'reisetasche',
  'anzuchterde',
  'krautererde',
  'kraeutererde',
  'blumenerde',
  'pflanzenerde',
  'pflanzerde',
  'tomatenerde',
  'gemueseerde',
  'kubelpflanzenerde',
  'kuebelpflanzenerde',
  'torffreie erde',
  'torffrei',
  'samereien',
  'saemereien',
  'saatgut',
  'zwiebelpflanzen',
  'blumenzwiebeln',
  'gemuesepflanze',
  'gemuesepflanzen',
  'tomaten-ampel',
  'tomatenampel',
  'salatpflanzen',
  'mediterrane pflanzen',
  'orchidee',
  'passionsblume',
  'hortensie',
  'bornholm-margerite',
  'bornholm margerite',
  'margerite',
  'margeritenbusch',
  'lavendel',
  'rispenhortensie',
  'katzengras',
  'blumentopf',
  'beet-und balkonpflanze',
  'balkonpflanze',
  'bluhpflanzen',
  'bluetenpoesie',
  'blutenpoesie',
  'dipladenia',
  'schleierkraut',
  'zinkschale',
  'duenger',
  'dunger',
  'universaldunger',
  'eisrose',
  'glasvase',
  'vase',
  'kerze',
  'kerzen',
  'hexenkerze',
  'hexen-kerze',
  'hexenkerzen',
  'fahrradtasche',
  'geschirr',
  'wasserglas',
  'glaserset',
  'thermoglaser',
  'thermoglaeser',
  'trinkglaser',
  'trinkglaeser',
  // ── Harte Non-Food-Komposita, die trotz (falscher) Food-Kategorie gewinnen
  // muessen. BEWUSST keine Einzelwoerter wie 'dose'/'box'/'muschel'/'messer'/
  // 'nelke' — die koennen echtes Lebensmittel sein (Tomatendose, Gewuerznelken).
  // Outdoor/Camping
  'strandmuschel',
  'beachshell',
  'beach shell',
  'pop-up beach',
  'popup beach',
  'strandzelt',
  'partyzelt',
  'pavillon',
  'luftmatratze',
  'campingbett',
  'campingliege',
  'campingstuhl',
  'campingtisch',
  // Aufbewahrung/Behaelter
  'cerealiendose',
  'cerealien-dose',
  'muesli-dose',
  'aufbewahrungsbox',
  'aufbewahrungs-box',
  'aufbewahrungsdose',
  'aufbewahrungs-dose',
  'aufbewahrungsbehaelter',
  'vorratsdose',
  'vorratsbox',
  'vorratsbehaelter',
  'frischhaltedose',
  'frischhaltebehaelter',
  // Spielzeug/Basteln
  'wasserspritzpistole',
  'wasserspritzpistolen',
  'spritzpistole',
  'wasserpistole',
  'stealth soaker',
  'kreativ-set',
  'kreativset',
  'bastelset',
  'bastel-set',
  'malset',
  'mal-set',
  'knetset',
  'knet-set',
  'loops spass box',
  'spass box',
  'spassbox',
  // Werkzeug/Garten-Werkzeug
  'freischneidmesser',
  'freischneider',
  'rasentrimmer',
  'motorsense',
  'heckenschere',
  'gartenschere',
  'astschere',
  'kettensaege',
  'stielstaubsauger',
  'akkusauger',
  // Haushalt/Reinigung
  'microfaser',
  'mikrofaser',
  'spezialschwamm',
  'spezialschwaemme',
  'putzschwamm',
  'topfschwamm',
  'microfaserschwamm',
  'mikrofaserschwamm',
  'microfasertuch',
  'mikrofasertuch',
  'wischmop',
  'wischbezug',
  'wischtuch',
  'bodentuch',
  'spuelmittel',
  'spulmittel',
  // Pflanzen/Blumen (NICHT bare 'nelke')
  'pink kisses',
  'kapmargerite',
  'topfpflanze',
  'zimmerpflanze',
  'gruenpflanze',
  'beetpflanze',
  'kuebelpflanze',
  'kubelpflanze',
  'bluetenstaude',
  'staudensortiment',
];

// Datenqualität #3: ganze Non-Food-Abteilungen, erkannt am Source-Kontext
// (sourceUrl / Roh-Kategorie / Department / Kontext), NICHT am Produktnamen. So
// fliegt ein NORMA "Multisnacks"/"Kau Donuts" aus der Abteilung „tierisch gut"
// raus, ein menschlicher „Multisnack" ohne diesen Kontext bleibt Food.
export const NON_FOOD_CONTEXT_KEYWORDS = [
  'tierisch-gut',
  'tierisch gut',
  'tierbedarf',
  'tiernahrung',
  'tierfutter',
  'haustier',
  'heimtier',
  'zooartikel',
  'zoobedarf',
] as const;

// Hochpräzise Non-Food-Produktbegriffe (sichere Teilstrings), die real als
// fälschlich live beobachtet wurden. Bewusst spezifische Komposita, keine
// generischen Einzelwörter.
export const HARD_NON_FOOD_NAME_KEYWORDS = [
  'crelando', // Kaufland Bastel-/Kreativmarke
  'pailletten',
  'paillette',
  'glockenblume',
  // Schnitt-/Topfpflanzen aus gemischten "Obst, Gemüse, Pflanzen"-Kategorien
  // (präzise Namen — 'Gewürznelken' ist EIN Wort und bleibt unberührt).
  'orchidee',
  'bluehpflanze',
  'gartenpflanze',
  'zimmerpflanze',
  'schnittblume',
  'weinrebe',
  // Reine Tierfutter-Marke (PURINA GOURMET Katzenfutter).
  'purina',
  'kaurollen',
  'kau-rollen',
  'kau donuts',
  'kau-donuts',
  'kaudonuts',
  'kausnack',
  'kau-snack',
  'kaustange',
  'kaustangen',
  'kauknochen',
  'kaustreifen',
  'katzenassnahrung',
  'katzennassnahrung',
  'blumen-beiwerk',
  'blumenbeiwerk',
  // Elektrische Gewürz-/Salz-/Pfeffermühle = Küchengerät (Non-Food), muss das
  // Gewürz-Food-Vokabular ('pfeffer'/'gewuerz') schlagen. Präzise Komposita —
  // 'pfeffer'/'salz' allein bleiben Food.
  'pfeffermuehle',
  'salzmuehle',
  'gewuerzmuehle',
  'pfefferspray', // Abwehrspray (Drogerie), nie das Lebensmittel "Pfeffer".
  // HINWEIS: „Kräutertopf"/„Topfkräuter" sind bewusst NICHT mehr hart Non-Food —
  // essbare Küchenkräuter im Topf sind Food (siehe foodKeywords). Eine LEBENDE
  // „...-pflanze" (Kräuterpflanze im Topf) bleibt über LIVING_PLANT_SUFFIX_PATTERN
  // Non-Food, Zierkräuter über den Zier-Präfix.
  // Leerer Kunststoff-/Plastikbecher = Behälter (Non-Food), nicht "Obst im Becher".
  'kunststoffbecher',
  'plastikbecher',
] as const;

// Botanische/tierische Wörter, die NUR an einer Wortgrenze Non-Food sind: so
// trifft 'blumen' auf "Blumen-Beiwerk"/"Blumen Deko", aber NIE auf
// "Sonnenblumenkerne"/"Blumenkohl"; 'pflanze' trifft "Pflanze", aber nicht
// "Pflanzenöl"/"pflanzlich".
export const WORD_BOUNDARY_NON_FOOD_KEYWORDS = [
  'blume',
  'blumen',
  'pflanze',
  'pflanzen',
  // Schnittblume; 'Gewürznelken' ist EIN Wort und matcht an der Wortgrenze nie.
  'nelken',
] as const;

// Schnittblumen/Zierblumen als generische Produktklasse (Domänen-Vokabular, KEINE
// Wochen-Produktliste). Werden NUR am Produktnamen mit Wortgrenze geprüft, damit
// 'rosen' NIE "Rosenkohl"/"Rosenwasser"/"Rosé"/"Rosmarin" trifft und die
// Kompositum-Formen ("Blumenstrauß"/"Rosenstrauß"/"Schnittblumen") trotzdem
// greifen. So entscheidet in der Mischabteilung "Obst, Gemüse, Pflanzen" der
// NAME — eine Chrysantheme fliegt raus, die Erdbeere daneben bleibt Food.
export const ORNAMENTAL_FLOWER_KEYWORDS = [
  'blumenstrauss',
  'blumengruss',
  'blumengesteck',
  'gesteck',
  'schnittblume',
  'schnittblumen',
  'schnittrose',
  'schnittrosen',
  'rosen',
  'rosenstrauss',
  'hortensie',
  'hortensien',
  'chrysantheme',
  'chrysanthemen',
  'tulpe',
  'tulpen',
  'narzisse',
  'narzissen',
  'freesie',
  'freesien',
  'gerbera',
  'gerberas',
  'ranunkel',
  'ranunkeln',
  'lilie',
  'lilien',
  // Trockenblumen/Floristik (Strauß/Bund getrockneter Blumen) = Deko, kein
  // Lebensmittel — generische Floristik-Klasse, keine Wochen-Produktliste.
  'trockenblume',
  'trockenblumen',
] as const;

// Zier-Präfix als generische Deko-Klasse: „Zier" heißt im Deutschen „dekorativ"
// — jedes „Zier-X" (Ziersalbei, Zierkürbis, Zierlauch, Ziergras, Zierstrauch)
// ist eine Zierpflanze/Deko = Non-Food, auch wenn der Stamm (Salbei/Kürbis/Lauch)
// ein essbares Lebensmittel ist. Wortanfang/-grenze, damit kein Food-Teilwort
// getroffen wird; mindestens ein Folgebuchstabe, damit „Zier" allein (selten)
// nicht hart greift.
const ORNAMENTAL_PREFIX_PATTERN = /(^|[\s-])zier[a-z]{2,}/;

// Strauß-/Rosen-Komposita als SUFFIX (Mixstrauß, Sprayrosen, Schnittrosen): das
// Floristik-Wort steht am Wortende. Wortgrenze am Anfang + harte Grenze am Ende,
// damit „Rosenkohl"/„Rosenwasser"/„Rosinen"/„Straußenei" (kein Trenner nach dem
// Stamm) NIE getroffen werden. Generische Klasse, keine Wochen-Produktliste.
const ORNAMENTAL_BOUQUET_SUFFIX_PATTERN = /(^|[\s-])[a-z]*(strauss|rosen)($|[\s-])/;

// Blumen-Kompositum als SUFFIX („Sommerblumen", „Trockenblumen", „Sonnenblumen",
// „Beetblumen"): das Blumenwort steht am WORTENDE. Der Präfix-Fall bleibt Food,
// weil nach „blume(n)" dort keine Wortgrenze folgt — „Blumenkohl", „Blumenerde"
// (eigenes Non-Food-Wort) und „Sonnenblumenkerne"/„Sonnenblumenöl" werden NICHT
// getroffen. Ersetzt die Abteilungs-Heuristik, die vorher „Sommerblumen" nur
// über das Wort „Pflanzen" in Kauflands gemischter Abteilung erwischte.
const ORNAMENTAL_BLOOM_SUFFIX_PATTERN = /(^|[\s-])[a-z]{2,}blumen?($|[\s-])/;

// Lebende Topf-/Zierpflanze als generische Klasse: ein Kompositum, das auf
// "-pflanze"/"-pflanzen" ENDET (Kräuterpflanze, Tomatenpflanze, Zierpflanze,
// Chilipflanze), ist eine lebende Pflanze = Non-Food — auch wenn der Wortstamm
// (Kräuter/Tomate/Chili) ein Lebensmittel ist. Pflanzen-DERIVATE als PRÄFIX
// bleiben Food, weil nach "pflanze(n)" keine Wortgrenze folgt: "Pflanzenöl",
// "Pflanzendrink", "pflanzlich".
const LIVING_PLANT_SUFFIX_PATTERN = /(^|[\s-])[a-z]*pflanzen?($|[\s-])/;

// „Pflanzen" als ZAEHLBARE Ware statt als Zutat: Auswahl/Sortiment/Trio/Schale/
// Korb/Kasten dahinter machen daraus ein Gebinde lebender Pflanzen. Der
// Suffix-Pattern oben greift dort nicht, weil das Wort weiterlaeuft
// („Pflanzenauswahl" ist EIN Token) — genau so stand „Pflanzenauswahl im
// Pottburri" (Lauf 2026-08-17) als Gemuese im sichtbaren Feed.
// Bewusst NUR diese Gebinde-Woerter, damit Pflanzenoel, Pflanzendrink,
// Pflanzenmargarine und „100 % pflanzlich" Lebensmittel bleiben.
const PLANT_ASSORTMENT_PATTERN =
  /(^|[\s-])[a-z]*pflanzen(auswahl|sortiment|mix|set|trio|duo|schale|korb|kasten|beet)/;

// Tiernahrung als KLASSE statt als Wortliste. Die frueher aufgezaehlten
// Komposita waren zwangslaeufig unvollstaendig: „hundenassfutter" stand drin,
// „katzennassfutter" nicht — deshalb rutschte „Sheba Katzennassfutter Filets"
// (Lauf 2026-08-17) als Grundnahrungsmittel in den sichtbaren Feed, waehrend
// „Felix Katzennahrung" korrekt gefiltert wurde.
// Ein Tier-Praefix PLUS Futter-/Nahrungs-Suffix deckt jede Kompositum-Variante
// ab. Der Praefix ist zwingend, damit „Grundnahrungsmittel" nie trifft.
const PET_FOOD_COMPOUND_PATTERN =
  /(katzen|kater|hunde|welpen|nager|vogel|kaninchen|meerschweinchen|hamster|wellensittich|zierfisch|aquarien)[a-z-]*(futter|nahrung|snack|snacks|leckerli|leckerchen)/;

const nonFoodCategoryKeywords = [
  'haushalt',
  'drogerie',
  'kosmetik',
  'parfum',
  'technik',
  'elektro',
  'werkzeug',
  'auto',
  'gartenartikel',
  'gartenbedarf',
  'spielwaren',
  'tierbedarf',
  'haustier',
  'tiernahrung',
  'katzennahrung',
  'zahnpasta',
  'koerperpflege',
  'korperpflege',
  'zahncreme',
  'zahnpflege',
  'hunde-futter',
  'hundevollnahrung',
  'hundenassfutter',
  'duschgel',
  'dusche',
  'duschprodukte',
  'badeprodukte',
  'reinigungsmittel',
  'trockenfutter',
  'geschenkset',
  'wellness',
  'wasserfilter',
  'wassersprudler',
  'kaffeevollautomat',
  'reiseartikel',
  'haushaltswaren',
  'garten und hauswaren',
  'pflanzen',
  'blumen',
  'saatgut',
  'duenger',
  'kerzen',
  'geschirr',
  'nahrungserganzungsmittel',
  'haushaltspapier',
  'hygienepapier',
  'papierwaren',
];

const foodCategoryKeywords = [
  'obst',
  'gemuese',
  'gemuse',
  'fleisch',
  'fisch',
  'milchprodukte',
  'milchalternativen',
  'backwaren',
  'trockenware',
  'konserven',
  'getraenke',
  'alkoholfrei',
  'alkohol',
  'tiefkuehl',
  'tiefkuhl',
  'lebensmittel',
  'bier',
  'wein',
  'sekt',
  'schaumwein',
  'likoer',
  'spirituose',
  'vodka',
  'whiskey',
  'rum',
  'gin',
  'snacks',
  'chips',
  'suessigkeiten',
  'sussigkeiten',
  'schokolade',
  'kekse',
  'kuchen',
  'gebaeck',
  'brot',
  'wurst',
  'wurstwaren',
  'fleischwaren',
  'fruchtsaft',
  'saft',
  'mineralwasser',
  'limonade',
  'softdrink',
  'fischwaren',
  'eiscreme',
  'dessert',
  'fertiggerichte',
  'nudeln',
  'nuesse',
  'samen',
  'eier',
  'feinkost',
  'kuehlung',
  'kuhlung',
  'gewuerze',
  'gewurze',
  'saucen',
  'sauce',
  'dips',
  'aufstrich',
  'aufstriche',
  'oel',
  'ol',
];

const foodKeywords = [
  'banane',
  'apfel',
  'birne',
  'tomate',
  'kartoffel',
  'paprika',
  'gurke',
  'spargel',
  'artischocke',
  'artischocken',
  'passionsfrucht',
  'passionsfruechte',
  'maracuja',
  'radieschen',
  'avocado',
  'zitrone',
  'zitronen',
  'knoblauch',
  'mango',
  'kiwi',
  'salat',
  'brokkoli',
  'zwiebel',
  'brot',
  'broetchen',
  'reis',
  'nudel',
  'linsen',
  'kichererbsen',
  'bohnen',
  'mehl',
  'zucker',
  'milch',
  'joghurt',
  'kaese',
  'mozzarella',
  'gouda',
  'quark',
  'sahne',
  'butter',
  'milchreis',
  'pudding',
  'not mlk',
  'tofu',
  'hummus',
  'haferdrink',
  'sojadrink',
  'sojajoghurt',
  'wurst',
  'weisswurst',
  'bratwurst',
  'schinken',
  'speck',
  'salami',
  'hackfleisch',
  'steak',
  'haehnchen',
  'huhn',
  'rind',
  'schwein',
  'lachs',
  'thunfisch',
  'kaffee',
  'tee',
  'saft',
  'cola',
  'wasser',
  'limonade',
  'bier',
  'alkoholfrei',
  'krombacher',
  'weissbier',
  'pils',
  'radler',
  'wein',
  'weisswein',
  'weissburgunder',
  'gewurztraminer',
  'gewuerztraminer',
  'riesling',
  'grauburgunder',
  'chardonnay',
  'sauvignon',
  'tempranillo',
  'sekt',
  'prosecco',
  'champagner',
  'pommery',
  'vodka',
  'whiskey',
  'whisky',
  'rum',
  'gin',
  'likoer',
  'likor',
  'sanddornlikor',
  'sanddornlikoer',
  'spirituose',
  'tequila',
  'cider',
  'schnaps',
  'snack',
  'chips',
  'keks',
  'schokolade',
  'bonbon',
  'praline',
  'honig',
  'fruchtsaft',
  'eis',
  'dessert',
  'pizza',
  'fischfilet',
  // Generisches Food-Vokabular (KW-unabhängig), das beim Food-Rescue aus dem
  // Filtered-Bucket bisher fehlte — Domänenwörter, keine Produktnamen.
  'surimi',
  'garnelen',
  'cottage',
  'patties',
  // Suppen/Fertiggerichte (Maggi Guten Appetit Suppe wurde sonst gefiltert):
  // generisches Gericht-Vokabular, keine Marken/Produktnamen.
  'suppe',
  'suppen',
  'eintopf',
  'bruehe',
  'fertiggericht',
  'fertiggerichte',
  // Käsesorten (Vokabular, keine Wochen-Produkte): Le Gruyère AOP & Co. werden
  // sonst nur über die Bedientheke gerettet — diese Sortennamen tragen das
  // Food-Signal auch ohne Theken-Kontext.
  'gruyere',
  'greyerzer',
  'emmentaler',
  'bergkaese',
  'raclette',
  'appenzeller',
  'comte',
  'pecorino',
  'konfituere',
  'marmelade',
  'aufstrich',
  'kirschtasche',
  'berliner',
  'superberliner',
  'ruehrkuchen',
  'ruhrkuchen',
  'magdalenas',
  'muffin',
  'laugenstange',
  'gourmetlaugenstange',
  'weckli',
  'rustipani',
  'ofenbrot',
  'tex-mex-swirl',
  'saaten-rusti',
  'saaten rusti',
  'vollkorn-saaten',
  'olivenol',
  'sonnenblumenol',
  'pflanzenol',
  'rapsol',
  'culinesse',
  'eistee',
  'ice tea',
  'sauce',
  'saucen',
  'aioli',
  'ketchup',
  'senf',
  'mayonnaise',
  'mayo',
  'pesto',
  'dressing',
  'marinade',
  'dip',
  'dips',
  'wrap',
  'wraps',
  'tortilla',
  'tortillas',
  'burger bun',
  'burger buns',
  'naturelle',
  // Getrocknete Küchenkräuter & Gewürze (generisches Vokabular, KEINE Produkt-
  // liste): "Basilikum gerebelt", "Dillspitzen", "Pfeffer schwarz gemahlen",
  // "Rosmarin geschnitten" landeten sonst ohne Food-Signal im Filtered-Bucket.
  // Lebende Pflanzen (X-pflanze) und die Gewürzmühle blocken vorher hart, der
  // Wortstamm rettet sie also nicht.
  'basilikum',
  'dill',
  'dillspitzen',
  'koriander',
  'majoran',
  'rosmarin',
  'thymian',
  'oregano',
  'petersilie',
  'schnittlauch',
  'estragon',
  'salbei',
  'bohnenkraut',
  'kuemmel',
  'kreuzkuemmel',
  'pfeffer',
  'muskat',
  'zimt',
  'kurkuma',
  'curry',
  'gewuerzmischung',
  'kraeutermischung',
  'kraeuter der provence',
  // Speisepilze (Vokabular): "Kräuterseitlinge"/"Speisepilze" sind Food.
  'seitling',
  'champignon',
  'champignons',
  'speisepilz',
  'austernpilz',
  'steinpilz',
  'pfifferling',
  'shiitake',
  'pilze',
  // Nüsse/Erdnüsse & salzige Knabber-Snacks (generisches Vokabular, KEINE Marken):
  // "ja! Erdnüsse"/"Erdnuss-Flips" landeten sonst ohne Food-Signal im Filtered-
  // Bucket. Bewusst eindeutige Komposita — 'nuss' allein bliebe in 'Nussknacker'
  // hängen, daher die Wortgrenzen-Liste unten für die kurzen/mehrdeutigen Begriffe.
  'erdnuss',
  'erdnuesse',
  'haselnuss',
  'walnuss',
  'cashew',
  'cashews',
  'pistazie',
  'pistazien',
  'mandeln',
  'studentenfutter',
  'nussmischung',
  'salzstangen',
  'salzbrezel',
  'erdnussflips',
  // Brot-/Backwarentypen (Ciabatta, Laugengebäck) — generische Gattungswörter.
  'ciabatta',
  'laugengebaeck',
  'laugenbrezel',
  'laugenbroetchen',
  'laugenecke',
  'laugencroissant',
  'laugenbreze',
  // Essbarer Mais / Grillgemüse (Grillmais, Maiskolben, Zuckermais).
  'grillmais',
  'maiskolben',
  'zuckermais',
  // Frühstückscerealien (generisches Gattungsvokabular, KEINE Marken/Produkte):
  // "Cerealien Pokémon"/"Knuspermüsli"/"Cornflakes" landeten sonst ohne Food-
  // Signal im Filtered-Bucket. Die Cerealien-/Müsli-DOSE (Behälter) trägt ihr
  // eigenes Non-Food-Kompositum (cerealiendose/muesli-dose) und wird vorher hart
  // geblockt — die Behälter-Klasse schlägt den Wortstamm.
  'cerealien',
  'cerealie',
  'muesli',
  'knuspermuesli',
  'cornflakes',
  'haferflocken',
  'porridge',
  'granola',
  'fruehstuecksflocken',
  // Baby-/Kindernahrung (generisches Vokabular, KEINE Marken): "Glaskost",
  // "Quetschbeutel", "Maissnacks", "Folgemilch". Babykost ist Lebensmittel;
  // reine Behälter/Geräte tragen ihr eigenes Non-Food-Wort.
  'glaskost',
  'beikost',
  'babynahrung',
  'saeuglingsnahrung',
  'babybrei',
  'milchbrei',
  'quetschbeutel',
  'quetschie',
  'fruchtmus',
  'maissnack',
  'maissnacks',
  // Essbare Küchenkräuter im Topf (Bioland Kräutertopf / Topfkräuter): Speise-
  // kräuter, kein Zierpflanzen-Topf. Zier-/Blühpflanzen tragen den Zier-Präfix
  // bzw. ein Blumen-/„...-pflanze"-Suffix und bleiben über die Botanik-Regeln
  // (hasRuleConfirmedNonFoodSignal läuft VOR diesem Food-Stamm) Non-Food.
  'kraeutertopf',
  'topfkraeuter',
  'topfkraut',
];

// Food-Vokabular, das NUR an einer Wortgrenze ein Food-Signal ist (regardless of
// length): so trifft 'mais' auf "Mais"/"Grill Mais", aber nie auf ein Teilwort;
// 'flips' auf "Erdnuss-Flips"/"Flips", aber nie auf "Flip-Flops"; die englischen
// Getränkebegriffe 'beer'/'lager'/'ale' auf "Heineken Lager Beer"/"Pale Ale",
// aber nie auf "Erdbeere"/"Lagerung"; 'laugen' auf "Laugen-Mix"/"Laugen Brezel"
// (Laugengebäck deckt das Kompositum oben ab), aber nie auf "Natronlauge".
export const FOOD_WORD_BOUNDARY_KEYWORDS = [
  'mais',
  'flips',
  'beer',
  'lager',
  'ale',
  'laugen',
] as const;

const foodTags = [
  'bio',
  'vegan',
  'vegetarisch',
  'halal',
  'laktosefrei',
];

// Generische Food-Produktdeskriptoren (Café/Caffè/Crema/Barista): beschreiben
// das Produkt SELBST und sind ein eigenständiger struktureller Food-Beleg —
// KEINE Marke. Werden mit Wortgrenze geprüft, damit 'cafe' NICHT als Teilstring
// in der Marke 'nescafe' steckt (eine Marke allein darf einen mehrdeutigen
// Kurznamen nicht retten, Task P3).
const FOOD_DESCRIPTOR_TOKENS = ['cafe', 'caffe', 'crema', 'barista'] as const;

// Bier-/Bierstil-Vokabular, das ALLEIN zu generisch für ein Food-Verdikt ist
// („Export"/„Märzen" können auch Nicht-Getränke meinen) und daher NIE blind
// rettet. MIT Getränke-Kontext (Liter-Einheit, Getränke-/Bier-/Alkohol-Kategorie
// oder -Quellabteilung) belegt es ein Alkoholgetränk = Food (CLUSS Export 0,5 l).
// OHNE Kontext bleibt es ein Food-VERDACHT (Review, hasSuspectFoodEvidence) —
// generische Stilklasse, KEINE Marken-/Produktliste. Wortgrenze, damit „export"
// nie als Teilstring in einem Nicht-Bierwort greift.
const ALCOHOL_STYLE_WORDS = [
  'export',
  'maerzen',
  'marzen',
  'bockbier',
  'doppelbock',
  'festbier',
  'kellerbier',
  'zwickelbier',
  'landbier',
] as const;

// Kaffee-/Tee-/Süßwaren-MARKEN. Eine Marke ALLEIN ist KEIN starkes Food-Signal
// (Task P3): „Jacobs Gold"/„Melitta Auslese" aus neutraler Quelle bleiben
// uncertain. Eine Marke zählt erst ZUSAMMEN mit einem unabhängigen strukturellen
// Food-Beleg (Food-Quellabteilung, konkreter Kaffee-Deskriptor, belastbare
// Food-Einheit/Grundpreis) — siehe hasBrandWithIndependentFoodEvidence. Bewusst
// KEINE Produkt-/Marken-Allowlist im Entscheidungssinn: die Marke kann nie allein
// entscheiden.
const FOOD_BRAND_TOKENS = [
  'tic tac',
  'dallmayr',
  'lavazza',
  'lipton',
  'melitta',
  'jacobs',
  'eduscho',
  'nescafe',
  'tchibo',
] as const;

// Konkrete Kaffee-/Zubereitungs-Deskriptoren, die ein Marken-Angebot strukturell
// als Food belegen, aber ALLEIN zu mehrdeutig sind ("gemahlen" könnte auch ein
// Gewürz, "Kapsel" ein Waschmittel sein). Zählen NUR in Kombination mit einer
// Marke (Task P3) — Domänen-Vokabular, keine Produktliste.
const BRAND_SUPPORTING_FOOD_DESCRIPTORS = [
  'gemahlen',
  'instant',
  'instantkaffee',
  'instantgetraenk',
  'loeslich',
  'loslich',
  'roestkaffee',
  'filterkaffee',
  'kaffeebohnen',
  'ganze bohne',
  'ganze bohnen',
  'pad',
  'pads',
  'kapsel',
  'kapseln',
] as const;

let rulesState: FilterRulesState = {
  addBlockedKeywords: [],
  removeBlockedKeywords: [],
  learnedAllowedOfferNames: [],
  learnedBlockedOfferNames: [],
};

function parseCsvList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((value) => normalizeText(value))
    .filter((value) => value.length > 0);
}

function mergeOrderedUnique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }

  return result;
}

function sanitizeRuleState(state: FilterRulesState): FilterRulesState {
  const addBlockedKeywords = mergeOrderedUnique(
    state.addBlockedKeywords.map((keyword) => normalizeText(keyword)),
  );
  const removeBlockedKeywords = mergeOrderedUnique(
    state.removeBlockedKeywords.map((keyword) => normalizeText(keyword)),
  ).filter((keyword) => !addBlockedKeywords.includes(keyword));
  const learnedAllowedOfferNames = mergeOrderedUnique(
    state.learnedAllowedOfferNames.map((offerName) => normalizeText(offerName)),
  );
  const learnedBlockedOfferNames = mergeOrderedUnique(
    state.learnedBlockedOfferNames.map((offerName) => normalizeText(offerName)),
  ).filter((offerName) => !learnedAllowedOfferNames.includes(offerName));

  return {
    addBlockedKeywords,
    removeBlockedKeywords,
    learnedAllowedOfferNames,
    learnedBlockedOfferNames,
  };
}

function getEnvBlockedKeywords(): string[] {
  return parseCsvList(process.env.AICHEF_EXTRA_BLOCKED_KEYWORDS);
}

function getDefaultBlockedKeywordSet(): Set<string> {
  return new Set(mergeOrderedUnique([...defaultNonFoodKeywords, ...getEnvBlockedKeywords()]));
}

function getEffectiveBlockedKeywords(): string[] {
  const base = mergeOrderedUnique([
    ...defaultNonFoodKeywords,
    ...getEnvBlockedKeywords(),
    ...rulesState.addBlockedKeywords,
  ]);
  const removedSet = new Set(rulesState.removeBlockedKeywords);
  return base.filter((keyword) => !removedSet.has(keyword));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Performance: die Food-/Non-Food-Klassifikation prüft pro Angebot mehrere
// hundert KONSTANTE Keywords, und der Report klassifiziert jedes Angebot mehrfach
// (~18k Klassifikationen je Build). Ohne Memoisierung normalisierte jeder Aufruf
// dieselben konstanten Keywords neu und kompilierte für Wortgrenzen-Keywords
// jedes Mal ein frisches `new RegExp` — das blockierte den Event-Loop ~18 s je
// Cold-Build und ließ /api/health auslaufen (Prozess wirkte „weg"). Die beiden
// Caches geben EXAKT dasselbe Ergebnis (gleiches normalizeText, gleiches
// RegExp), berechnen es aber nur einmal pro eindeutigem Keyword statt pro
// Angebot. Reine Memoisierung über unveränderliche Keyword-Konstanten — keine
// fachliche Änderung.
const normalizedKeywordCache = new Map<string, string>();
function normalizeKeyword(keywordRaw: string): string {
  let normalized = normalizedKeywordCache.get(keywordRaw);
  if (normalized === undefined) {
    normalized = normalizeText(keywordRaw);
    normalizedKeywordCache.set(keywordRaw, normalized);
  }
  return normalized;
}

const wordBoundaryRegexCache = new Map<string, RegExp>();
function wordBoundaryRegex(normalizedKeyword: string): RegExp {
  let regex = wordBoundaryRegexCache.get(normalizedKeyword);
  if (regex === undefined) {
    regex = new RegExp(`(^|[\\s-])${escapeRegExp(normalizedKeyword)}($|[\\s-])`);
    wordBoundaryRegexCache.set(normalizedKeyword, regex);
  }
  return regex;
}

function keywordMatches(source: string, keywordRaw: string): boolean {
  const keyword = normalizeKeyword(keywordRaw);
  if (!keyword) {
    return false;
  }

  if (keyword.length <= 3 && /^[a-z0-9]+$/.test(keyword)) {
    return wordBoundaryRegex(keyword).test(source);
  }

  return source.includes(keyword);
}

function containsAny(source: string, keywords: string[]): boolean {
  return keywords.some((keyword) => keywordMatches(source, keyword));
}

function hasFoodUnit(offer: Offer): boolean {
  const units = normalizeText(`${offer.unit ?? ''} ${offer.baseUnit ?? ''}`);
  return /(^|[\s\d.,/-])(kg|g|mg|l|ml|cl)(\b|$)/.test(units);
}

export async function initializeStrictFoodFilterRules(): Promise<void> {
  const loaded = await loadFilterRulesState();
  rulesState = sanitizeRuleState(loaded);
}

async function saveCurrentRulesState(): Promise<void> {
  rulesState = sanitizeRuleState(rulesState);
  await saveFilterRulesState(rulesState);
}

export function getStrictFoodFilterList(): StrictFoodFilterList {
  const envBlockedKeywords = getEnvBlockedKeywords();

  return {
    blockedKeywords: getEffectiveBlockedKeywords(),
    blockedCategoryKeywords: [...nonFoodCategoryKeywords],
    allowedCategoryKeywords: [...foodCategoryKeywords],
    allowedKeywords: [...foodKeywords],
    allowedTags: [...foodTags],
    customBlockedKeywords: [...rulesState.addBlockedKeywords],
    removedBlockedKeywords: [...rulesState.removeBlockedKeywords],
    envBlockedKeywords,
    learnedAllowedOfferNames: [...rulesState.learnedAllowedOfferNames],
    learnedBlockedOfferNames: [...rulesState.learnedBlockedOfferNames],
  };
}

function getOfferLearningName(offer: Offer): string {
  return normalizeText(offer.normalizedName || offer.name || '');
}

function buildOfferSignals(offer: Offer): {
  category: string;
  source: string;
  learningName: string;
} {
  return {
    category: normalizeText(offer.category ?? ''),
    source: normalizeText(
      `${offer.name} ${offer.brand ?? ''} ${offer.category ?? ''} ${(offer.tags ?? []).join(' ')}`,
    ),
    learningName: getOfferLearningName(offer),
  };
}

/** Raw source context (URL + Roh-Kategorie/Department/Kontext/Tags). Used for the
 *  Datenqualität-#3 department signals so a whole Tierbedarf/Drogerie aisle is
 *  filtered regardless of the bare product name. */
function buildOfferContext(offer: Offer): string {
  const o = offer as Offer & {
    sourceCategoryRaw?: unknown;
    sourceDepartmentRaw?: unknown;
    sourceContextRaw?: unknown;
    sourceTagsRaw?: unknown;
  };
  const tagsRaw = Array.isArray(o.sourceTagsRaw) ? o.sourceTagsRaw.join(' ') : '';
  return normalizeText(
    `${offer.sourceUrl ?? ''} ${String(o.sourceCategoryRaw ?? '')} ${String(
      o.sourceDepartmentRaw ?? '',
    )} ${String(o.sourceContextRaw ?? '')} ${tagsRaw}`,
  );
}

/** Word-boundary match (regardless of keyword length) — keeps 'blumen' off
 *  "Sonnenblumenkerne" while still catching standalone "Blumen". normalizeText
 *  uses hyphens as separators, so "-" counts as a boundary. */
function matchesWordBoundary(source: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => {
    const norm = normalizeKeyword(keyword);
    if (!norm) return false;
    return wordBoundaryRegex(norm).test(source);
  });
}

const wordStartRegexCache = new Map<string, RegExp>();
function wordStartRegex(normalizedKeyword: string): RegExp {
  let regex = wordStartRegexCache.get(normalizedKeyword);
  if (regex === undefined) {
    regex = new RegExp(`(^|[\\s-])${escapeRegExp(normalizedKeyword)}`);
    wordStartRegexCache.set(normalizedKeyword, regex);
  }
  return regex;
}

/** Treffer nur am WORTANFANG (Wortgrenze davor, beliebige Fortsetzung danach) —
 *  für Stämme, die als Präfix eindeutig sind, in der Wortmitte aber echte
 *  Lebensmittelmarken treffen ("dusch" in "EDUSCHO"). */
function matchesWordStart(source: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => {
    const norm = normalizeKeyword(keyword);
    if (!norm) return false;
    return wordStartRegex(norm).test(source);
  });
}

/** Generic ornamental-flower / living-plant signal on the PRODUCT NAME only
 *  (never the whole department): cut flowers/bouquets and "...-pflanze"
 *  compounds are Non-Food. Word boundaries keep it off Rosenkohl/Blumenkohl/
 *  Sonnenblumenkerne, and the suffix rule keeps it off Pflanzenöl/pflanzlich.
 *  Used via hasContextNonFoodSignal so gate + report + rescue share the truth. */
function hasOrnamentalPlantName(nameSource: string): boolean {
  if (matchesWordBoundary(nameSource, ORNAMENTAL_FLOWER_KEYWORDS)) {
    return true;
  }
  if (ORNAMENTAL_PREFIX_PATTERN.test(nameSource)) {
    return true;
  }
  if (ORNAMENTAL_BOUQUET_SUFFIX_PATTERN.test(nameSource)) {
    return true;
  }
  if (ORNAMENTAL_BLOOM_SUFFIX_PATTERN.test(nameSource)) {
    return true;
  }
  if (PLANT_ASSORTMENT_PATTERN.test(nameSource)) {
    return true;
  }
  return LIVING_PLANT_SUFFIX_PATTERN.test(nameSource);
}

/** Tiernahrung am PRODUKTNAMEN — deckt jede Kompositum-Variante ab, statt sie
 *  einzeln aufzuzaehlen. Siehe {@link PET_FOOD_COMPOUND_PATTERN}. */
function hasPetFoodName(nameSource: string): boolean {
  return PET_FOOD_COMPOUND_PATTERN.test(nameSource);
}

// Schuhwerk/Bekleidung als generische Non-Food-Klasse (Wortgrenze, damit kein
// Food-Teilwort getroffen wird). „GIN TONIC Damen-Slipper" darf nie wegen
// „gin/tonic" zu Alkohol/Food werden — ein Schuh ist Non-Food. Bewusst nur
// eindeutige Schuh-/Bekleidungswörter, keine Produktliste.
const APPAREL_FOOTWEAR_KEYWORDS = [
  'slipper',
  'sneaker',
  'sneakers',
  'sandale',
  'sandalen',
  'pantoffel',
  'pantoffeln',
  'hausschuh',
  'hausschuhe',
  'stiefel',
  'stiefelette',
  'stiefeletten',
  'halbschuh',
  'halbschuhe',
] as const;

// Kinder-/Erwachsenen-Konfektionsgrößen (DE/EU). Ein PAAR benachbarter Größen
// („98/104", „110 116") ist die typische Textil-Etikettierung und damit ein
// eindeutiges Bekleidungssignal (Sommer-Set/Shirt/Shorts) = Non-Food — generische
// Klasse, KEINE Produkt-/Marken-Allowlist. Bewusst nur ein PAAR benachbarter
// Größen, nie eine einzelne Zahl, damit kein Mengen-/Stückwert ein Lebensmittel
// trifft. normalizeText entfernt den „/“ („98/104" → „98104"), daher werden BEIDE
// Schreibweisen erkannt: das zusammengezogene Token und zwei getrennte Tokens.
const CLOTHING_SIZES = [
  '50', '56', '62', '68', '74', '80', '86', '92', '98', '104', '110', '116',
  '122', '128', '134', '140', '146', '152', '158', '164', '170', '176',
] as const;
const CLOTHING_SIZE_INDEX = new Map<string, number>(CLOTHING_SIZES.map((s, i) => [s, i]));
const CLOTHING_SIZE_PAIR_TOKENS = new Set<string>(
  CLOTHING_SIZES.slice(0, -1).map((s, i) => `${s}${CLOTHING_SIZES[i + 1]}`),
);

/** True when the name carries a clothing-size PAIR of adjacent konfektionsgrößen
 *  ("98/104" → "98104", or split "110 116") — an unambiguous textile signal.
 *  A single size never triggers (too ambiguous against quantities). */
function hasClothingSizePair(nameSource: string): boolean {
  const tokens = nameSource.split(/[\s-]/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    if (CLOTHING_SIZE_PAIR_TOKENS.has(tokens[i])) {
      return true;
    }
    const a = CLOTHING_SIZE_INDEX.get(tokens[i]);
    const b = CLOTHING_SIZE_INDEX.get(tokens[i + 1]);
    if (a !== undefined && b !== undefined && Math.abs(a - b) === 1) {
      return true;
    }
  }
  return false;
}

// Zierpflanzen-/Zimmerpflanzen-ARTEN als generisches Botanik-Vokabular (KEINE
// Wochen-Produktliste, analog zu ORNAMENTAL_FLOWER_KEYWORDS). Werden NUR an einer
// Wortgrenze geprüft und über ein Getränke-/Alkohol-Veto entschärft: „Edelweiss"
// (Weißbier) und „Enzian" (Schnaps) mit Getränke-Kontext bleiben Food; eine
// Zierpflanze gleichen Namens (Topf, keine Getränke-Einheit) ist Non-Food.
const ORNAMENTAL_PLANT_SPECIES = [
  'kalanchoe',
  'edelweiss',
  'enzian',
  'geranie',
  'geranien',
  'begonie',
  'begonien',
  'petunie',
  'petunien',
  'fuchsie',
  'fuchsien',
  'alpenveilchen',
  'usambaraveilchen',
  // Weitere Zier-/Zimmerpflanzen-Gattungen (Live-Befund 2026-08-17: „Korbmaranthe"
  // 5,99 € und „Rose" 14,99 € lagen in Kauflands gemischter Abteilung
  // „Obst, Gemüse, Pflanzen" als Obst im sichtbaren Feed).
  'orchidee',
  'orchideen',
  'azalee',
  'azaleen',
  'primel',
  'primeln',
  'marante',
  'maranthe',
  'sukkulente',
  'sukkulenten',
  'gruenpflanze',
  'gruenpflanzen',
  'zimmerpflanze',
  'zimmerpflanzen',
  'sempervivum',
  // Einzelne Schnittblume: „Rose" als eigenes Wort ist eine Blume. Bewusst NUR
  // als Wortgrenze und NUR ohne Getränke-Kontext, damit „Roséwein"/„Rosé" und
  // „Rosenkohl"/„Rosenwasser"/„Rosinen"/„Rosette" Lebensmittel bleiben.
  // Bewusst NICHT aufgenommen: „Nelke(n)" (Gewürznelken sind ein Gewürz) und
  // „Wacholder" (Wacholderbeeren/Gin) — dort überwiegt die essbare Lesart.
  'rose',
  'gladiole',
  'gladiolen',
] as const;

// Botanische Gattungs-ENDUNGEN als generische Zierpflanzen-Klasse: ein Name, der
// auf „…aster" (Herbstaster, Glattblattaster, Kissenaster), „…marante" (Korb-
// marante), „…veilchen", „…primel" oder „…azalee" ENDET, ist eine Zierpflanze.
// Mindestens drei Buchstaben davor, damit „Toaster" (to+aster) nicht getroffen
// wird; die alleinstehenden Gattungen deckt ORNAMENTAL_PLANT_SPECIES ab.
const ORNAMENTAL_GENUS_SUFFIX_PATTERN =
  /(^|[\s-])[a-z]{3,}(aster|astern|marante|maranthe|veilchen|primel|primeln|azalee|azaleen)($|[\s-])/;

// Küchen-/Haushaltsgerät als generische Non-Food-Klasse: ein Name, der auf
// „...maker" ENDET (Pizzamaker, Sandwichmaker, Eismaker, Waffelmaker), ist ein
// Gerät — der Food-Stamm davor („Pizza"/„Eis") darf es nie zu Food machen.
// Plus eindeutige Gerätewörter. Keine Produktliste.
const APPLIANCE_MAKER_PATTERN = /[a-z]{2,}maker(s)?($|[\s-])/;
const APPLIANCE_DEVICE_KEYWORDS = [
  'toaster',
  'fritteuse',
  'heissluftfritteuse',
  'kontaktgrill',
  'sandwichtoaster',
  'waffeleisen',
  'eismaschine',
] as const;

// Generische Non-Food-Produktklassen als eindeutige Komposita (Domänen-
// Vokabular, KEINE Marken-/Produktliste). Bewusst nur Komposita, die NIE in
// einem essbaren Wort vorkommen — „Quarktasche"/„Maultaschen"/„Cappuccino"/
// „Eintopf" tragen keines dieser Wörter. Diese Liste wird per Substring geprüft
// (alle Einträge > 3 Zeichen), die kurzen/mehrdeutigen Klassenwörter stehen in
// NON_FOOD_PRODUCT_CLASS_WORD_BOUNDARY.
const NON_FOOD_PRODUCT_CLASS_KEYWORDS = [
  // Technik/Elektro: Steckdosen, Kopfhörer, Drucker, Leuchten
  'steckdose',
  'steckdosen',
  'steckdosenleiste',
  'steckdosenadapter',
  'steckdosensaeule',
  'steckdosenrondell',
  'mehrfachsteckdose',
  'verlaengerungskabel',
  'kopfhoerer',
  'ohrhoerer',
  'headset',
  'in-ear',
  'drucker',
  'druckerpatrone',
  'druckerpatronen',
  'tintenpatrone',
  'tintenpatronen',
  'multifunktionsdrucker',
  'tischleuchte',
  'stehleuchte',
  'deckenleuchte',
  'wandleuchte',
  'solarleuchte',
  'solarleuchten',
  'taschenlampe',
  'gluehlampe',
  'leuchtmittel',
  // Einrichtung/Heimtextil: Kissen, Bettwäsche
  'kopfkissen',
  'kopfkissenbezug',
  'kissenbezug',
  'kissenbezuege',
  'kissenhuelle',
  'nackenkissen',
  'dekokissen',
  'bettwaesche',
  'bettlaken',
  'spannbettlaken',
  'bettbezug',
  'bettdecke',
  // Taschen/Rucksäcke als Gegenstand (NICHT bare „tasche" — Quarktasche bleibt Food)
  'rucksack',
  'roll-top-rucksack',
  'sporttasche',
  'packtasche',
  'packtaschen',
  'reisetasche',
  'umhaengetasche',
  'schultertasche',
  'handtasche',
  'gepaecktasche',
  // Haushaltsgeräte/Bürsten
  'grillbuerste',
  'spuelbuerste',
  'reinigungsbuerste',
  'haushaltsbuerste',
  'drahtbuerste',
  // Küchen-Gegenstände (NICHT bare „topf"/„schale"/„form" — Eintopf bleibt Food)
  'eiswuerfelform',
  'eiswuerfelbereiter',
  'eiswuerfelschale',
  'eiswuerfelbehaelter',
  'eisschale',
  'kochtopf',
  'bratentopf',
  'schmortopf',
  'topfset',
  'kochtopfset',
  'kochgeschirr',
  'bratpfanne',
  'stielpfanne',
  'schmorpfanne',
  'salatschuessel',
  'ruehrschuessel',
  'schuesselset',
  'ruehrschale',
  // Aufbewahrung: Schrank-/Schiebekörbe (WEINBERGER Schrank-Schiebekorb)
  'schiebekorb',
  'schrankkorb',
  'drahtkorb',
  'aufbewahrungskorb',
  'waeschekorb',
  'einkaufskorb',
  // Sanitär/Armatur: Wasserhahnanschluss (Flexibler Wasserhahnanschluss)
  'wasserhahn',
  'wasserhahnanschluss',
  'schlauchanschluss',
  'schlauchverbinder',
  'armatur',
  // Sanitär/Bad: Wasserspar-/Dusch-/Brause-Produkte (Live-Befund 2026-06-29:
  // „PUREGREEN Dusch-Wassersparer" wurde über das Food-Wort „Wasser" fälschlich als
  // food_like/likelyFoodWronglyFiltered gemeldet). Eindeutige Sanitär-Komposita —
  // KEIN essbares Wasser-Produkt (Mineral-/Tafel-/Trink-/Kokoswasser, Wasser mit
  // Geschmack, Wassermelone) trägt „wasserspar"/„dusch"/„sanitaer"/„wasserstop".
  // Bewusst KEIN bare „wasser"/„sparer"/„brause"/„bad": „Brausepulver"/-tablette und
  // „Bad Reichenhaller" (Salz) sind Food — nur die eindeutigen Brause-Komposita.
  'wasserspar', // Wassersparer, wassersparend, Wasserspardusche, Wasserspar-Set
  'wasserstop', // Wasserstop, Wasserstopp
  'spardusche',
  'duschkopf',
  'duscharmatur',
  'duschbrause',
  'sparbrause',
  // 'dusch' steht bewusst NICHT hier: als blanker Teilstring traf es die
  // Kaffeemarke „EDUSCHO" (e-DUSCH-o) und filterte „EDUSCHO Lieblingskaffee"
  // als Sanitärartikel. Es gilt jetzt nur am WORTANFANG, s.
  // WORD_START_NON_FOOD_KEYWORDS.
  'sanitaer', // „Sanitär-Armatur" (normalizeText → „sanitaer")
  // Garten: Pflanzgefäße/Übertopf, Vlies, Schmierstoffe
  'uebertopf',
  'pflanztopf',
  'keramiktopf',
  'pflanzkuebel',
  'pflanzgefaess',
  'unkrautvlies',
  'mulchvlies',
  'gartenvlies',
  'unkrautfolie',
  'schmierstoff',
  'schmierfett',
  'schmieroel',
  'kriechoel',
  'kettenoel',
  // Körperpflege/Hygiene als generische Klasse. Live-Befund 2026-08-17:
  // „ORAL-B Elektrische Zahnbürste Vitality Pro" und „ALWAYS Damenbinden" lagen
  // ohne jeden Regel-Beleg als `uncertain` in der Review-Queue, obwohl beide
  // eindeutig Non-Food sind. Kein essbares Wort enthält diese Komposita.
  'zahnbuerste',
  'zahnbuersten',
  'buerstenkopf',
  'buerstenkoepfe',
  'zahnseide',
  'mundspuelung',
  'haftcreme',
  'damenbinde',
  'damenbinden',
  'slipeinlage',
  'slipeinlagen',
  'inkontinenz',
  'wattestaebchen',
  'rasierklinge',
  'rasierklingen',
  'rasierschaum',
  'haarfarbe',
  'haarcoloration',
  'haarspray',
  'haarlack',
  'schaumfestiger',
  // Mal-/Bastelartikel als generische Klasse. Live-Befund 2026-08-17:
  // „Wasser-/ Zaubermalspaß" (Stück, 5,99 €) wurde über den Getränke-Rescue auf
  // das Wort „Wasser" als alkoholfreies Getränk live gestellt. Ein „…malspaß"/
  // „…malbuch"/„…malset" ist ein Bastelartikel — kein essbares Wort enthält sie.
  'malspass',
  'malbuch',
  'malbuecher',
  'malblock',
  'malset',
  'malvorlage',
  'malvorlagen',
  'malstift',
  'malstifte',
  'bastelset',
  'bastelbedarf',
  // Spielzeug/Wassersport-Gegenstände
  'schwimmbrett',
  'schwimmbretter',
  'schwimmnudel',
  'schwimmsitz',
  'schwimmreifen',
  'badeinsel',
  'wasserbrett',
  // Bekleidung: Caps/Mützen als Komposita
  'basecap',
  'schirmmuetze',
  'strickmuetze',
  'wollmuetze',
  'beanie',
  // Möbel/Einrichtung (Live-Befund 2026-06-22: „Anbau-Regal" wurde fälschlich als
  // food_like gemeldet). Eindeutige Einrichtungs-Komposita — KEIN essbares Wort
  // enthält „schrank"/„kommode"/„sideboard"/„vitrine".
  // 'regal' steht bewusst NICHT hier: als blanker Teilstring machte es aus
  // „CHIVAS REGAL Blended Scotch Whisky" ein Möbelstück. Das Kompositum
  // („Wandregal", „Korbregal") deckt SHELF_COMPOUND_PATTERN ab, das alleinstehende
  // Wort AMBIGUOUS_FURNITURE_WORDS mit Getränke-Veto.
  'schrank',
  'kommode',
  'sideboard',
  'vitrine',
  'garderobe',
  'rollcontainer',
  'schubladenbox',
  // Autozubehör/Autopflege als generische Klasse (Live-Befund: „Auto-Accessoires",
  // „Autopflege"). Bewusst präzise Komposita — NIE bare 'auto' (Substring-Risiko).
  'autopflege',
  'auto-accessoire',
  'auto-accessoires',
  'autoaccessoire',
  'autoaccessoires',
  'autoreiniger',
  'autoshampoo',
  'autowachs',
  'autopolitur',
  'autoteppich',
  'autofussmatte',
  'autofussmatten',
  'felgenreiniger',
  'cockpitspray',
  'lackpflege',
  'lackreiniger',
  'scheibenreiniger',
  // Schuhwerk: Bade-/Haus-Schlappen, Latschen, Zehentrenner (Live-Befund:
  // „Badeschlappen"). Substring, damit „Bade-/Dusch-/Hausschlappen" alle greifen;
  // kein Lebensmittel enthält „schlappen"/„latschen"/„zehentrenner".
  'schlappen',
  'latschen',
  'zehentrenner',
  'gummistiefel',
  'badeschuh',
  'flip-flop',
  'flipflop',
  // Werkzeug/Garten-Geräte (generische Klasse; 'werkzeug'/'bohrmaschine' decken
  // bereits viel ab — hier die fehlenden eindeutigen Geräte-Komposita).
  'akkuschrauber',
  'bohrhammer',
  'winkelschleifer',
  'gartenschlauch',
  'schlauchwagen',
  'giesskanne',
  'gieskanne',
  'rasenmaeher',
  'rasenmaher',
  'laubblaeser',
  'laubblaser',
  // HINWEIS: Trinkhalme/Strohhalme werden NICHT mehr pauschal hier geblockt —
  // ein Milch-/Aroma-/Mix-Kontext macht „Milchtrink-Halme" essbar. Siehe
  // {@link hasPlainStrawNonFood} (nur PLAINE Halme ohne Food-Kontext sind Non-Food).
] as const;

// Kurze/mehrdeutige Produktklassenwörter NUR an der Wortgrenze: „Cap" trifft
// „Kinder-Cap", nie „Cappuccino" (kein Folge-Trenner); „Mütze"/„Kappe" treffen
// nie ein Food-Teilwort. (Halme werden separat über hasPlainStrawNonFood
// behandelt, weil ein Milch-/Aroma-Kontext sie essbar macht.)
const NON_FOOD_PRODUCT_CLASS_WORD_BOUNDARY = [
  'cap',
  'caps',
  'kappe',
  'muetze',
] as const;

// Non-Food-Wortstämme, die am WORTANFANG eindeutig sind, als blanker Teilstring
// aber echte Lebensmittelmarken treffen. Live-Befund 2026-08-17: „EDUSCHO
// Lieblingskaffee" (Kaffee, 500-g-Packung) wurde als Sanitärartikel gefiltert,
// weil „e-DUSCH-o" den Teilstring 'dusch' enthält. Am Wortanfang bleibt die
// Klasse vollständig ("Dusch-Wassersparer", "Duschsystem", "Duschgel"),
// Wortmitten-Treffer entfallen. Komposita mit dem Stamm am ENDE ("Pflegedusche")
// decken die eigenen Einträge 'dusche'/'duschgel' in STRONG_NON_FOOD_KEYWORDS ab.
const WORD_START_NON_FOOD_KEYWORDS = ['dusch'] as const;

// Möbel-Kompositum: ein Name, der auf „…regal(e)" ENDET (Wandregal, Weinregal,
// Korbregal, Anbauregal), ist immer ein Möbelstück. Mindestens zwei Buchstaben
// davor, damit das alleinstehende Wort hier NICHT greift — dafür gibt es das
// Getränke-Veto unten.
const SHELF_COMPOUND_PATTERN = /(^|[\s-])[a-z]{2,}regale?($|[\s-])/;

// Mehrdeutige Einrichtungs-/Möbelwörter: als eigenes Wort ein Möbelstück
// („Anbau-Regal", „Regal 4 Böden"), im Markennamen eines Getränks aber
// bedeutungslos („CHIVAS REGAL"). Sie entscheiden daher NUR ohne Getränke-Kontext
// — dieselbe Konstruktion wie bei ORNAMENTAL_PLANT_SPECIES („Edelweiss"-Weißbier).
const AMBIGUOUS_FURNITURE_WORDS = ['regal', 'regale'] as const;

// Geräte-Wort als BESTIMMUNGSWORT vor einem Speisen-Kopf. Deutsche
// Kompositum-Regel: der KOPF am Wortende bestimmt die Warenart. „Mikrowelle" ist
// ein Gerät, „Mikrowellen-GERICHT"/„Mikrowellen-POPCORN"/„Mikrowellen-REIS" sind
// SPEISEN. Live-Befund 2026-08-17: „¡QUE VIVA ESPAÑA! Mikrowellengericht" (280 g,
// 1,99 €) lag über den Teilstring 'mikrowelle' im Non-Food-Bucket.
// Bewusst nur Geräte-Stämme, die überhaupt als Zubereitungsart vor einer Speise
// stehen können — „Pfannenwender"/„Grillbürste" tragen keinen Speisen-Kopf.
const APPLIANCE_PREPARED_DISH_PATTERN =
  /(^|[\s-])(mikrowellen?|ofen|backofen|grill|pfannen?|wok|airfryer|heissluft|dampfgar)[\s-]?(gericht|gerichte|menue|menu|mahlzeit|mahlzeiten|popcorn|reis|nudeln?|pasta|suppen?|snack|snacks|pommes|frites|kaese|wurst|brot|broetchen|kuchen|teig|kartoffeln?|gemuese|dessert|pizza)/;

/** True, wenn der Name ein Geräte-Wort NUR als Zubereitungs-Bestimmungswort vor
 *  einem Speisen-Kopf trägt ("Mikrowellengericht", "Ofenkäse", "Grillwurst").
 *  Solche Namen dürfen NIE über das Geräte-Keyword zu Non-Food werden. */
function hasPreparedDishName(nameSource: string): boolean {
  return APPLIANCE_PREPARED_DISH_PATTERN.test(nameSource);
}

// Geräte-Keywords, die durch hasPreparedDishName neutralisiert werden. Nur
// Stämme, die als Zubereitungsart vor einer Speise stehen können — alle anderen
// Non-Food-Keywords bleiben unangetastet, damit der Veto nie echtes Non-Food
// rettet ("Mikrowellengeschirr" trägt keinen Speisen-Kopf und bleibt Non-Food).
const APPLIANCE_MODIFIER_KEYWORDS = new Set([
  'mikrowelle',
  'mikrowellen',
  'backofen',
  'ofen',
  'grill',
  'standgrill',
  'elektrogrill',
  'gasgrill',
  'kontaktgrill',
  'wok',
  'dampfgarer',
]);

/** Entfernt Geräte-Keywords aus einer Non-Food-Keywordliste, wenn der Name das
 *  Gerätewort nachweislich als Bestimmungswort einer SPEISE führt. */
function withoutNeutralizedApplianceKeywords(
  keywords: readonly string[],
  nameSource: string,
): string[] {
  if (!hasPreparedDishName(nameSource)) {
    return [...keywords];
  }
  return keywords.filter((keyword) => !APPLIANCE_MODIFIER_KEYWORDS.has(normalizeKeyword(keyword)));
}

// Trinkhalme/Strohhalme sind als Gegenstand Non-Food — ABER ein Milch-/Aroma-/
// Mix-/Dessert-/Pulver-Kontext macht „Milchtrink-Halme"/„Aroma-Trinkhalme" zu
// einem essbaren/aromatisierenden Lebensmittel(zubehör). Generische Klasse, KEINE
// Produktliste. Wortgrenze, damit „halm(e)" nie ein Food-Teilwort trifft.
const STRAW_WORDS = ['trinkhalm', 'trinkhalme', 'strohhalm', 'strohhalme', 'halm', 'halme'] as const;
const FLAVORED_STRAW_FOOD_CONTEXT = [
  'milch',
  'milk',
  'aroma',
  'geschmack',
  'kakao',
  'schoko',
  'dessert',
  'pulver',
  'mix',
  'erdbeer',
  'vanille',
  'sirup',
] as const;

/** True only for a PLAIN drinking-straw object (Non-Food). A flavored/milk/aroma
 *  straw context ("Magic Milk Mix Milchtrink-Halme") is NOT plain and stays food. */
function hasPlainStrawNonFood(nameSource: string): boolean {
  if (!matchesWordBoundary(nameSource, STRAW_WORDS)) {
    return false;
  }
  return !containsAny(nameSource, [...FLAVORED_STRAW_FOOD_CONTEXT]);
}

// Generische Behälter-/Geschirr-/Aufbewahrungs-Klasse (Domänen-Vokabular, KEINE
// Marken-/Produktliste). Ein Trinkbecher/Lunchbehälter/Brotdose ist ein GEGENSTAND
// (Non-Food), auch wenn der Name Food-Wörter wie „Getränke"/„Lunch"/„Trink" trägt.
// Live-Befund 2026-06-22: „Getränke- / Lunchbehälter, Trinkbecher, Blau" wurde als
// food_like gemeldet, weil keine Regel den Behälter erkannte und „Getränke" als
// Food-Verdacht gewann. Bewusst ZWEISTUFIG, damit echte Lebensmittel im Becher/in
// der Dose (Joghurt-/Pudding-/Sahne-/Eisbecher, Tomatendose) NIE getroffen werden:
//   1. Eindeutige Behälter-Komposita als Substring — der PRÄFIX benennt ein Gefäß/
//      Material (Trink-/Thermo-/Isolier-/Vakuum-/Reise-/Mehrweg-), nie ein
//      Lebensmittel; kein essbares Wort enthält diese Komposita.
//   2. Ein MEHRDEUTIGES Behälter-Kopfnomen (becher/behaelter/flasche/dose/box) wird
//      NUR dann Non-Food, wenn ein eindeutiger Behälter-/Aufbewahrungs-Kontext
//      (trink/lunch/getraenke/aufbewahr/vorrat/thermo/isolier/vakuum/reise) DANEBEN
//      steht. „Joghurtbecher"/„Puddingbecher"/„Eisbecher"/„Tomatendose" tragen einen
//      FOOD-Modifikator, KEINEN Behälter-Kontext, und bleiben Food. Geprüft nur am
//      Namen+Brand (nie der Kategorie), damit ein Getränk mit Kategorie „Getränke"
//      und name „Cola Dose" nicht fälschlich als Behälter gilt.
const CONTAINER_OBJECT_KEYWORDS = [
  'trinkbecher',
  'thermobecher',
  'isolierbecher',
  'vakuumbecher',
  'reisebecher',
  'mehrwegbecher',
  'lunchbecher',
  'lunchbehaelter',
  'getraenkebehaelter',
  'getraenkebox',
  'lunchbox',
  'brotdose',
  'brotbox',
  'trinkflasche',
  'thermoflasche',
  'isolierflasche',
  'edelstahlflasche',
  'sportflasche',
  'thermobehaelter',
  'isolierbehaelter',
] as const;
const CONTAINER_HEAD_WORDS = ['becher', 'behaelter', 'flasche', 'dose', 'box'] as const;
const CONTAINER_CONTEXT_WORDS = [
  'trink',
  'lunch',
  'getraenke',
  'aufbewahr',
  'vorrat',
  'thermo',
  'isolier',
  'vakuum',
  'reise',
] as const;

/** Generic container/drinkware object signal (Non-Food). Step 1: unambiguous
 *  container compounds. Step 2: an ambiguous container head noun ONLY together
 *  with a clear container/storage context word — so "Trinkbecher"/"Lunchbehälter"/
 *  "Getränke-Behälter" are Non-Food while "Joghurtbecher"/"Eisbecher"/"Tomatendose"
 *  (food modifier, no container context) stay Food. nameSource is name+brand. */
function hasContainerObjectNonFood(nameSource: string): boolean {
  if (containsAny(nameSource, [...CONTAINER_OBJECT_KEYWORDS])) {
    return true;
  }
  const hasHead = CONTAINER_HEAD_WORDS.some((head) => nameSource.includes(head));
  if (!hasHead) {
    return false;
  }
  return CONTAINER_CONTEXT_WORDS.some((context) => nameSource.includes(context));
}

// Leuchten/Lampen als generische Klasse: ein Name, der auf „...leuchte(n)" ENDET
// (Tischleuchte, Solarleuchte, LED-Stehleuchte) bzw. auf „...lampe", ist eine
// Leuchte = Non-Food. Kein essbares Wort endet so.
const LIGHT_FIXTURE_SUFFIX_PATTERN = /(^|[\s-])[a-z]{2,}(leuchten?|lampe)($|[\s-])/;

/** Generic non-food product CLASS signals on the name (footwear/apparel +
 *  kitchen appliances + the broad structural classes above). Word boundaries /
 *  suffix patterns keep them off real food. „GIN TONIC Damen-Slipper" → Schuh,
 *  „Pizzamaker" → Gerät, „LED-Tischleuchte" → Leuchte, „Kopfkissen" → Textil. */
function hasNonFoodProductClassName(nameSource: string): boolean {
  if (matchesWordBoundary(nameSource, APPAREL_FOOTWEAR_KEYWORDS)) {
    return true;
  }
  if (APPLIANCE_MAKER_PATTERN.test(nameSource)) {
    return true;
  }
  // Ein Gerätewort, das nachweislich nur eine SPEISE bestimmt
  // ("Mikrowellengericht"), darf keine Geräte-Klasse auslösen.
  if (
    matchesWordBoundary(
      nameSource,
      withoutNeutralizedApplianceKeywords(APPLIANCE_DEVICE_KEYWORDS, nameSource),
    )
  ) {
    return true;
  }
  if (containsAny(nameSource, [...NON_FOOD_PRODUCT_CLASS_KEYWORDS])) {
    return true;
  }
  if (matchesWordStart(nameSource, WORD_START_NON_FOOD_KEYWORDS)) {
    return true;
  }
  if (SHELF_COMPOUND_PATTERN.test(nameSource)) {
    return true;
  }
  if (LIGHT_FIXTURE_SUFFIX_PATTERN.test(nameSource)) {
    return true;
  }
  if (hasPlainStrawNonFood(nameSource)) {
    return true;
  }
  if (hasContainerObjectNonFood(nameSource)) {
    return true;
  }
  // Kinder-/Erwachsenen-Textil über ein Konfektionsgrößen-Paar („98/104").
  if (hasClothingSizePair(nameSource)) {
    return true;
  }
  return matchesWordBoundary(nameSource, NON_FOOD_PRODUCT_CLASS_WORD_BOUNDARY);
}

// Eindeutig ESSBARE Warenarten im PRODUKTNAMEN. Bewusst eine eigene, enge Liste
// statt des vollen Food-Vokabulars: sie ist das einzige Signal, das eine
// eindeutige Non-Food-ABTEILUNG überstimmen darf, und muss deshalb frei von
// Wörtern sein, die auch auf Drogerie-/Tier-/Haushaltsartikeln stehen
// ('creme' → Handcreme/Zahncreme, 'salz' → Fleckensalz/Spülmaschinensalz,
// 'milch' → Körpermilch/Reinigungsmilch). Alle Einträge > 3 Zeichen, daher
// Teilstring-Match (Komposita wie „Molkenprotein"/„Müsliriegel" sind gewollt).
const EDIBLE_PRODUCT_NAME_KEYWORDS = [
  // Sport-/Ergänzungsnahrung (Kaufland/Netto führen sie in „Drogerie")
  'protein',
  'proteine',
  'whey',
  'molke',
  'eiweisspulver',
  'kreatin',
  'creatine',
  // Riegel/Snack-Formate
  'muesliriegel',
  'proteinriegel',
  'schokoriegel',
  'nussriegel',
  'fruchtriegel',
  'haferriegel',
  // Säuglings-/Kindernahrung
  'folgemilch',
  'anfangsmilch',
  'saeuglingsmilch',
  'saeuglingsnahrung',
  'babynahrung',
  'babybrei',
  'milchbrei',
  'beikost',
  'glaskost',
  // Eindeutige Lebensmittel-Warenarten
  'schokolade',
  'kaffee',
  'espresso',
  'fruchtsaft',
  'limonade',
  'joghurt',
  'nudeln',
  'haferflocken',
  'knaeckebrot',
  'trockenfruechte',
] as const;

/**
 * Reines NAMENS-Food-Signal aus eindeutig essbarem Warenart-Vokabular — OHNE
 * Kategorie, Quellabteilung, Einheit und ohne jedes Modell-Flag. Gegengewicht zum
 * reinen ABTEILUNGS-Non-Food-Signal (siehe hasContextNonFoodSignal).
 *
 * Wird von jedem NAMENS-Non-Food-Signal vetoed, damit „Felix Katzennahrung"
 * (Tiernahrung), „Kräuterpflanze" (Zierpflanze) oder „Proteinshaker" (Behälter)
 * nie über dieses Fenster zurückkommen. Pure.
 */
function hasEdibleProductNameSignal(offer: Offer): boolean {
  const nameSource = normalizeText(`${offer.name} ${offer.brand ?? ''}`);
  if (!nameSource.trim()) return false;
  if (hasPetFoodName(nameSource)) return false;
  if (hasOrnamentalPlantName(nameSource)) return false;
  if (hasNonFoodProductClassName(nameSource)) return false;
  if (containsAny(nameSource, [...STRONG_NON_FOOD_KEYWORDS])) return false;
  if (containsAny(nameSource, [...HARD_NON_FOOD_NAME_KEYWORDS])) return false;
  return containsAny(nameSource, [...EDIBLE_PRODUCT_NAME_KEYWORDS]);
}

/** True when the retailer's RAW category/department (sourceCategoryRaw /
 *  sourceDepartmentRaw) names an unambiguous Non-Food aisle (Drogerie, Haushalt,
 *  Tier, Freizeit und Mode, …). This is the structural fix for the REWE case
 *  where Pampers (Drogerie) / Zierpflanzen (Freizeit und Mode) carried no
 *  product-name keyword and were left as `food_filtered_unconfirmed`. Mirrors
 *  the veto list used by hasStrongFoodSourceSignal so gate, rescue and report
 *  judge the aisle identically. Only consults the raw category fields (never the
 *  sourceUrl), so a food URL can never mask a food offer as non-food. */
function hasNonFoodSourceCategory(offer: Offer): boolean {
  const o = offer as Offer & { sourceCategoryRaw?: unknown; sourceDepartmentRaw?: unknown };
  const raw = normalizeText(
    `${String(o.sourceCategoryRaw ?? '')} ${String(o.sourceDepartmentRaw ?? '')}`,
  );
  if (!raw.trim()) return false;
  if (containsAny(raw, [...NON_FOOD_SOURCE_CATEGORY_KEYWORDS])) return true;
  return matchesWordBoundary(raw, NON_FOOD_SOURCE_CATEGORY_WORD_BOUNDARY);
}

/** Generic botanical signal: a bloom/plant word at a word boundary COMBINED with
 *  a pot/bundle sale context (unit/name/context) is a living ornamental plant =
 *  Non-Food. Word boundaries keep it off edible foods (Sonnenblumenkerne,
 *  Blumenkohl, Blütenhonig) and the combo requirement keeps it off a bare
 *  "Pflanzenöl"/"Pflanzendrink" with no pot context. */
function hasBotanicalPotSignal(offer: Offer): boolean {
  const o = offer as Offer & { unit?: unknown };
  const nameBlob = normalizeText(`${offer.name} ${offer.brand ?? ''} ${String(o.unit ?? '')}`);
  const context = buildOfferContext(offer);
  const bloomInName = matchesWordBoundary(nameBlob, BOTANICAL_BLOOM_WORDS);
  if (!bloomInName) {
    if (!matchesWordBoundary(context, BOTANICAL_BLOOM_WORDS)) return false;
    // Ein Blütenwort, das AUSSCHLIESSLICH aus einer gemischten Quellabteilung
    // stammt, die zugleich eine Food-Abteilung nennt, ist zu schwach. Kauflands
    // „Obst, Gemüse, Pflanzen" machte sonst jedes bundweise verkaufte Gemüse zur
    // Zierpflanze — Live-Befund 2026-08-17: „Dtsch. Lauchzwiebeln" (Bund, 0,59 €)
    // lag im Non-Food-Bucket, weil 'pflanzen' aus der Abteilung mit der Einheit
    // „Bund" kombiniert wurde. Echte Zierpflanzen fängt die Namens-Botanik
    // (hasOrnamentalPlantName / ORNAMENTAL_PLANT_SPECIES) ab.
    if (containsAny(context, [...FOOD_SOURCE_CATEGORY_KEYWORDS])) return false;
  }
  return BOTANICAL_SALE_CONTEXT_PATTERN.test(`${nameBlob} ${context}`);
}

/** Datenqualität #3: hard non-food signal from the source context or a precise
 *  product token, with word-boundary handling for botanical words. */
function hasContextNonFoodSignal(offer: Offer): boolean {
  const { source } = buildOfferSignals(offer);
  const context = buildOfferContext(offer);
  // Eindeutige Non-Food-Roh-Abteilung (Drogerie/Haushalt/Tier/Freizeit und Mode).
  // ABER: eine Abteilung ist eine REGALZUORDNUNG, keine Warenart. Kaufland führt
  // Sportnahrung, Proteinriegel und Säuglingsmilch in der KOMBINIERTEN Abteilung
  // „Drogerie, Tiernahrung" — Live-Befund 2026-08-17: „ESN Isoclear Whey-Protein",
  // „KORO Proteinriegel" und „APTAMIL Folgemilch" wurden allein deshalb als
  // Non-Food gefiltert. Nennt der PRODUKTNAME selbst ein Lebensmittel, entscheidet
  // die Abteilung nicht mehr allein; die Namens-Signale unten (Tiernahrung,
  // Zierpflanze, Produktklasse) laufen weiter und fangen echtes Non-Food ab.
  const edibleName = hasEdibleProductNameSignal(offer);
  if (hasNonFoodSourceCategory(offer) && !edibleName) return true;
  // Generisches Botanik-Kombi-Signal (Blüte/Pflanze + Topf/Bund).
  if (hasBotanicalPotSignal(offer)) return true;
  // Tier-/Zoo-Abteilungswörter im KONTEXT — dieselbe Abteilungs-Ausnahme wie oben:
  // sie stammen aus der Regalzuordnung, nicht aus der Warenart.
  if (containsAny(context, [...NON_FOOD_CONTEXT_KEYWORDS]) && !edibleName) return true;
  const both = `${source} ${context}`;
  if (containsAny(both, [...HARD_NON_FOOD_NAME_KEYWORDS])) return true;
  // Schnittblumen/Zierpflanzen am NAMEN (nicht der Abteilung): "Chrysantheme",
  // "Rosen", "Blumenstrauß", "Kräuterpflanze". Entscheidet auch in der
  // gemischten Abteilung "Obst, Gemüse, Pflanzen", ohne die Frische-Abteilung
  // pauschal zu treffen.
  const nameSource = normalizeText(`${offer.name} ${offer.brand ?? ''}`);
  if (hasOrnamentalPlantName(nameSource)) return true;
  if (hasPetFoodName(nameSource)) return true;
  // Zierpflanzen-/Zimmerpflanzen-Arten (Kalanchoe/Edelweiss/Enzian …) am Namen —
  // mit Getränke-/Alkohol-Veto, damit „Edelweiss"-Weißbier/„Enzian"-Schnaps Food
  // bleiben, die gleichnamige Topf-Zierpflanze aber Non-Food ist.
  if (matchesWordBoundary(nameSource, ORNAMENTAL_PLANT_SPECIES) && !hasBeverageContext(offer)) {
    return true;
  }
  // Botanische Gattungs-ENDUNG (Glattblatt-ASTER, Korb-MARANTE): dieselbe
  // Zierpflanzen-Klasse, nur als Kompositum-Kopf statt als eigenes Wort.
  if (ORNAMENTAL_GENUS_SUFFIX_PATTERN.test(nameSource) && !hasBeverageContext(offer)) {
    return true;
  }
  // Alleinstehendes Möbelwort („Anbau-Regal") ist ein Möbelstück — im
  // Getränkenamen („CHIVAS REGAL") dagegen bedeutungslos.
  if (matchesWordBoundary(nameSource, AMBIGUOUS_FURNITURE_WORDS) && !hasBeverageContext(offer)) {
    return true;
  }
  // Schuhwerk/Bekleidung + Küchengeräte am Namen (Damen-Slipper, Pizzamaker).
  if (hasNonFoodProductClassName(nameSource)) return true;
  // Botanik-Wortgrenzen-Signal: im NAMEN immer ("Blumen-Beiwerk"), im KONTEXT
  // nur, wenn die Quellkategorie NICHT zugleich eine Food-Abteilung nennt.
  // Kauflands gemischte Abteilung "Obst, Gemüse, Pflanzen" machte sonst die
  // komplette Frische-Abteilung (Erdbeeren/Spargel/Tomaten) zu Non-Food;
  // echte Pflanzen (Nelken/Orchidee/Blühpflanzen) fängt die präzise
  // Namens-Keywordliste oben.
  if (matchesWordBoundary(source, WORD_BOUNDARY_NON_FOOD_KEYWORDS)) return true;
  const contextNamesFoodDepartment = containsAny(context, [...FOOD_SOURCE_CATEGORY_KEYWORDS]);
  if (!contextNamesFoodDepartment && matchesWordBoundary(context, WORD_BOUNDARY_NON_FOOD_KEYWORDS)) {
    return true;
  }
  return false;
}

/** True when the KI/rule categorizer explicitly flagged the offer as Non-Food.
 *  This is a strong, structured signal that must win even when the (possibly
 *  wrong) simple category looks like food. */
export function hasCanonicalNonFoodFlag(offer: Offer): boolean {
  const canonical = (offer as Offer & { canonicalCategory?: unknown }).canonicalCategory;
  if (!canonical || typeof canonical !== 'object') {
    return false;
  }
  return (canonical as { isNonFood?: unknown }).isNonFood === true;
}

/** Reason token the Python pipeline stamps onto a cached classification. */
const CACHE_HIT_REASON = 'cache:hit';

/** Below this canonical confidence a non-food verdict counts as weak/stale. */
const WEAK_CACHE_NON_FOOD_CONFIDENCE = 0.6;

/** Lowercased canonical reason strings (for cache:hit provenance detection). */
function canonicalReasonStrings(offer: Offer): string[] {
  const reasons = (offer as Offer & { canonicalCategory?: { reasons?: unknown } }).canonicalCategory
    ?.reasons;
  return Array.isArray(reasons)
    ? reasons.filter((r): r is string => typeof r === 'string').map((r) => r.toLowerCase())
    : [];
}

/** Any "non-food" spelling inside a canonical reason — matched generically (the
 *  pipeline's `repair:sonstiges_nonfood_unverified` marker AND the model's own
 *  free-text "…classified under Non-Food"), so the rule survives marker/phrasing
 *  changes instead of pinning a single literal. */
const NON_FOOD_REASON_PATTERN = /(nonfood|non-food|non_food|non food)/;

/**
 * Task — INKONSISTENTE canonicalCategory. Ein `isNonFood===false` / Food-`main`
 * ist KEIN positives Food-Verdikt, wenn die EIGENEN Gründe der canonical-Kategorie
 * das Angebot als Non-Food erklären. Genau das passiert beim Pipeline-Repair
 * `repair:sonstiges_nonfood_unverified` (core.py): ein Modell-Non-Food-Verdikt
 * über eine generische „Sonstiges"-Quelle wird mangels hartem Regel-Beleg
 * vorläufig auf `main=Grundnahrungsmittel` / `isNonFood=false` (conf ≤ 0.66)
 * umgeschrieben — die ursprünglichen Non-Food-Gründe ("…is a tool, classified
 * under Non-Food") bleiben aber erhalten. Ein solcher Food-Flag ist ein
 * UNGEPRÜFTER Platzhalter über einem Non-Food-Verdikt, kein Beleg.
 *
 * Bewusst NUR NEUTRALISIEREND: er entzieht dem Fall den food_like-Status
 * (→ nonfood_like), wird aber NIE selbst zum harten Non-Food-Beleg — ein
 * schwacher Modelltext bleibt ein schwacher Modelltext und macht KEIN
 * confirmed_non_food (das tun nur Regel-/Keyword-Signale). Symmetrisches
 * Gegenstück zu {@link hasUntrustworthyCacheNonFood} (schwacher Non-Food-Cache),
 * hier für den schwachen, repariert-en Food-Flag. Pure.
 */
export function hasInconsistentCanonicalFoodFlag(offer: Offer): boolean {
  const canonical = (offer as Offer & { canonicalCategory?: unknown }).canonicalCategory;
  if (!canonical || typeof canonical !== 'object') {
    return false;
  }
  // Nur relevant, wenn die canonical AKTUELL Food behauptet; ein echtes
  // Non-Food-Flag deckt hasCanonicalNonFoodFlag ab.
  if ((canonical as { isNonFood?: unknown }).isNonFood === true) {
    return false;
  }
  return canonicalReasonStrings(offer).some((reason) => NON_FOOD_REASON_PATTERN.test(reason));
}

/** Independent, rule-based non-food evidence that stands on its OWN — separate
 *  from the model/cache canonical flag and the offer's foodFlag. Mirrors the
 *  non-canonical hard signals in {@link hasHardNonFoodSignal} so the two stay in
 *  lockstep. Pure + high-precision. */
function hasIndependentRuleNonFoodEvidence(offer: Offer): boolean {
  if (hasNonFoodTag(offer)) return true;
  if (hasNonFoodUnit(offer)) return true;
  if (hasStrongNonFoodSignal(offer)) return true;
  if (hasContextNonFoodSignal(offer)) return true;
  const category = normalizeText(offer.category ?? '');
  return containsAny(category, nonFoodCategoryKeywords);
}

/**
 * Task P1 — Cache-Trust / Evidenzpriorität. Ein `canonicalCategory.isNonFood===true`-
 * Verdikt ist UNVERTRAUENSWÜRDIG (veraltet/schwach), wenn es
 *   (a) aus einem `cache:hit` stammt ODER niedrig-konfident ist,
 *   (b) dem EIGENEN `foodFlag==='food'` des Angebots DIREKT widerspricht, und
 *   (c) KEINEN unabhängigen regelbasierten Non-Food-Beleg trägt (keine Non-Food-
 *       Quellabteilung, kein starkes Keyword, keine Pflanzen-Einheit, kein
 *       Kontext-/Kategorie-Signal).
 * Ein solcher Hit darf eine plausiblere neue Food-Entscheidung NICHT hart
 * überschreiben: er blockt weder die Phase-2-Reanalyse (hasHardNonFoodSignal)
 * noch wird er als confirmed Non-Food persistiert (phase2Reassembly). Ein
 * strukturell echtes Non-Food (Haushalt/Küche/Werkzeug-Quelle, starkes Keyword,
 * Pflanzen-Einheit …) behält JEDES unabhängige Signal und bleibt Non-Food.
 * Bewusst KEINE Produkt-/Marken-Allowlist und kein KW-/Shop-Sonderfall. Pure.
 */
export function hasUntrustworthyCacheNonFood(offer: Offer): boolean {
  if (!hasCanonicalNonFoodFlag(offer)) {
    return false;
  }
  const o = offer as Offer & { foodFlag?: unknown; canonicalCategory?: { confidence?: unknown } };
  // (b) Ohne direkten foodFlag-Widerspruch greift die Distrust-Regel nie.
  if (o.foodFlag !== 'food') {
    return false;
  }
  // (a) cache:hit-Provenienz ODER niedrige Konfidenz.
  const conf = Number(o.canonicalCategory?.confidence);
  const weakOrStale =
    canonicalReasonStrings(offer).some((reason) => reason.includes(CACHE_HIT_REASON)) ||
    (Number.isFinite(conf) && conf < WEAK_CACHE_NON_FOOD_CONFIDENCE);
  if (!weakOrStale) {
    return false;
  }
  // (c) Kein unabhängiger Non-Food-Beleg.
  return !hasIndependentRuleNonFoodEvidence(offer);
}

/** A "pflanze"/"pflanzen" UNIT is an unambiguous plant signal (e.g. "Nelken"
 *  sold per plant), regardless of how the category was guessed. */
function hasNonFoodUnit(offer: Offer): boolean {
  const unit = normalizeText(offer.unit ?? '');
  return /(^|\s)pflanzen?(\s|$)/.test(unit);
}

/** Das generische `nonfood`-Tag. Provenienz (Task P1): das blanke Tag allein ist
 *  KEIN harter Regelbeleg — ein Connector mit eindeutigem Non-Food-Bereich,
 *  ein Learned-Block oder der finale Regel-Gate belegen sich strukturell
 *  zusätzlich (Quellabteilung/Einheit/Keyword/Lernliste); ein vom Modell oder
 *  einem früheren Browser-Import abgeleitetes Tag tut das nicht. */
export const NON_FOOD_TAG = 'nonfood';

/** True when the offer carries the generic `nonfood` tag (connector category,
 *  model/legacy verdict or a final-gate stamp). NOTE: the tag alone is NOT a
 *  rule-confirmed non-food signal anymore — see {@link hasRuleConfirmedNonFoodSignal}.
 *  Strukturell vertrauenswürdige Quellen (Connector-Bereich, Learned-Block,
 *  finaler Gate) belegen sich unabhängig vom Tag. */
export function hasNonFoodTag(offer: Offer): boolean {
  return (offer.tags ?? []).some((tag) => normalizeText(tag) === NON_FOOD_TAG);
}

/** True when a HUMAN explicitly allowed this offer as food (learned allow-list).
 *  Manual allow always wins — also over hard non-food signals, so the final
 *  snapshot gate never re-moves an offer a human already rescued. */
export function isManuallyAllowedFoodOffer(offer: Offer): boolean {
  const learningName = getOfferLearningName(offer);
  return learningName.length > 0 && rulesState.learnedAllowedOfferNames.includes(learningName);
}

export function isStrictNonFoodOffer(offer: Offer): boolean {
  const { category, source, learningName } = buildOfferSignals(offer);

  // Manual allow always wins (human override).
  if (learningName && rulesState.learnedAllowedOfferNames.includes(learningName)) {
    return false;
  }
  if (learningName && rulesState.learnedBlockedOfferNames.includes(learningName)) {
    return true;
  }

  // Hard non-food signals — these win over any (possibly wrong) food category.
  if (hasCanonicalNonFoodFlag(offer)) {
    return true;
  }
  if (hasNonFoodTag(offer)) {
    return true;
  }
  if (hasNonFoodUnit(offer)) {
    return true;
  }

  // Datenqualität #3: Source-Kontext (Tierbedarf/tierisch gut) + präzise
  // Produkt-/Botanik-Signale (Pailletten/Glockenblume/Blumen an Wortgrenze).
  if (hasContextNonFoodSignal(offer)) {
    return true;
  }

  if (containsAny(category, nonFoodCategoryKeywords)) {
    return true;
  }

  // Geräte-Keywords zählen nicht, wenn der NAME das Gerätewort nur als
  // Bestimmungswort einer Speise führt ("Mikrowellengericht" ist ein Fertig-
  // gericht, keine Mikrowelle).
  const nameSource = normalizeText(`${offer.name} ${offer.brand ?? ''}`);
  if (containsAny(source, withoutNeutralizedApplianceKeywords(getEffectiveBlockedKeywords(), nameSource))) {
    return true;
  }

  return false;
}

/**
 * True when an offer carries a STRONG, unambiguous non-food signal (a Lidl
 * non-food house brand like LIVARNO/PARKSIDE or a pest-control term like
 * Insektenschutz/Insektenvernichter). High-precision on purpose: used by the
 * categorizer bridge to "repair" offers the model left as foodFlag="unsure" so
 * they are marked non-food and dropped from the live feed in BOTH scan versions.
 * Pure — does not consult the editable rules state, so it is safe to call before
 * `initializeStrictFoodFilterRules()`.
 */
export function hasStrongNonFoodSignal(offer: Offer): boolean {
  const { source } = buildOfferSignals(offer);
  const nameSource = normalizeText(`${offer.name} ${offer.brand ?? ''}`);
  return containsAny(source, withoutNeutralizedApplianceKeywords(STRONG_NON_FOOD_KEYWORDS, nameSource));
}

// Händler-Quellkategorien/-Abteilungen (sourceCategoryRaw/sourceDepartmentRaw),
// die EINDEUTIG Lebensmittel führen — Abteilungs-Vokabular, keine Produktliste.
// Quelle: reale Werte wie REWE_CATEGORY "Frühstück"/"Frische & Convenience".
const FOOD_SOURCE_CATEGORY_KEYWORDS = [
  'obst',
  'gemuese',
  'fleisch',
  'wurst',
  'fisch',
  'frische',
  'convenience',
  'fruehstueck',
  'kaffee',
  'molkerei',
  'milchprodukt',
  'kaese',
  'joghurt',
  'kuehlregal',
  'kuehlung',
  'tiefkuehl',
  'getraenke',
  'suesswaren',
  'suessigkeiten',
  'snack',
  'backwaren',
  'brot',
  'baeckerei',
  'grundnahrung',
  'nahrungsmittel',
  'lebensmittel',
  'feinkost',
  'konserven',
  // REWE flyer food departments that were missing — generic section labels, not
  // a product list: "Süßes und Salziges", "Vorratskammer". Keep alcohol/longdrink
  // as a food beverage department (it is Food with an alcohol/halal flag, never
  // Non-Food). Only KEEPS clearly-food sections; non-food vetoes still win above.
  'suesses',
  'salziges',
  'vorratskammer',
  'vorrat',
  'bier',
  'wein',
  'spirituosen',
  'longdrink',
  'aperitif',
  'alkoholfrei',
  // Bedien-/Frische-Theke ist immer eine Lebensmittel-Theke (Fleisch/Wurst/
  // Käse/Fisch/Feinkost) — der REWE-Abschnitt "An der Bedientheke" rettet so
  // Le Gruyère AOP/Neuburger ohne Produkt-Allowlist. Bewusst KEIN bare 'theke'
  // (träfe 'Apotheke'); nur die eindeutigen Theken-Komposita.
  'bedientheke',
  'bedienungstheke',
  'frischetheke',
  'kaesetheke',
  'fleischtheke',
  'wursttheke',
  'fischtheke',
  'feinkosttheke',
] as const;

// Quellkategorien, die das Food-Signal VETOEN (eine "Drogerie"-Abteilung bleibt
// Non-Food, selbst wenn künftig ein Kombiname ein Food-Wort enthielte).
const NON_FOOD_SOURCE_CATEGORY_KEYWORDS = [
  'drogerie',
  'haushalt',
  'non-food',
  'nonfood',
  'koerperpflege',
  'kosmetik',
  'hygiene',
  'wasch',
  'putz',
  'reinig',
  'tierbedarf',
  'tiernahrung',
  'garten',
  'technik',
  'elektro',
  'textil',
  'bekleidung',
  'spielware',
  // Generische Non-Food-Abteilungen (stärken die Produktklassen-Entscheidung,
  // Task A.4): Einrichtung/Wohnen/Möbel/Deko/Heimtextil + Insektenschutz.
  'einrichtung',
  'wohnen',
  'moebel',
  'heimtext',
  'deko',
  'insektenschutz',
  // REWE-Roh-Abteilungen, die als ganze Abteilung Non-Food sind: "Freizeit und
  // Mode" (Pflanzen/Blumen/Deko), "Drogerie" (Pampers/Persil), "Tier"
  // (Whiskas/Vitakraft). 'freizeit' ist als Substring eindeutig; 'tier'/'mode'
  // brauchen Wortgrenzen (s. NON_FOOD_SOURCE_CATEGORY_WORD_BOUNDARY), damit sie
  // nie ein Food-Wort als Teilstring treffen ("tierische"/"à la mode").
  'freizeit',
] as const;

// Kurze, mehrdeutige Roh-Abteilungswörter, die NUR an einer Wortgrenze Non-Food
// sind: 'tier' trifft die REWE-Abteilung "Tier", aber nie "tierische Produkte";
// 'mode' trifft "Freizeit und Mode", aber nie ein Food-Teilwort.
const NON_FOOD_SOURCE_CATEGORY_WORD_BOUNDARY = ['tier', 'mode'] as const;

// Botanik-Kombi-Signal: ein Blüten-/Pflanzenwort am Wortrand KOMBINIERT mit
// einem Topf-/Bund-Verkaufskontext (Einheit/Name/Kontext) ist eine lebende
// Zierpflanze = Non-Food — generisch, ohne essbare Lebensmittel zu treffen:
// "Sonnenblumenkerne"/"Blumenkohl"/"Blütenhonig" tragen keine Wortgrenze nach
// dem Stamm, "Kräuter im Topf" trägt kein Blüten-/Pflanzenwort (und wird separat
// über die Topfkräuter-Komposita behandelt).
const BOTANICAL_BLOOM_WORDS = [
  'bluete',
  'blueten',
  'blume',
  'blumen',
  'pflanze',
  'pflanzen',
] as const;
const BOTANICAL_SALE_CONTEXT_PATTERN = /(^|[\s-])(topf|bund)(\b|en\b|pflanze)/;

/**
 * True when the RETAILER's own raw category/department says the offer is food
 * ("Frühstück", "Frische & Convenience", "Wurst", …) and no rule-based
 * non-food signal contradicts it. Deliberately ignores the MODEL verdict
 * (foodFlag/canonicalCategory) — this function exists so the categorizer
 * bridge can rescue offers the model hallucinated into Non-Food ("Bratmaxe is
 * a pan", "coffee pads are non-food") without ever resurrecting Drogerie/
 * Haushalt items. Pure, no product names involved.
 */
export function hasStrongFoodSourceSignal(offer: Offer): boolean {
  const o = offer as Offer & { sourceCategoryRaw?: unknown; sourceDepartmentRaw?: unknown };
  const raw = normalizeText(
    `${String(o.sourceCategoryRaw ?? '')} ${String(o.sourceDepartmentRaw ?? '')}`,
  );
  if (!raw.trim()) {
    return false;
  }
  if (containsAny(raw, [...NON_FOOD_SOURCE_CATEGORY_KEYWORDS])) {
    return false;
  }
  // Rule-based vetoes only (never the model flags we are about to override).
  if (hasStrongNonFoodSignal(offer) || hasNonFoodTag(offer) || hasNonFoodUnit(offer)) {
    return false;
  }
  return containsAny(raw, [...FOOD_SOURCE_CATEGORY_KEYWORDS]);
}

/**
 * True when a REGEL (nie das Modell, nie ein blankes Tag) das Angebot als
 * Non-Food belegt:
 *   - starkes Non-Food-Keyword/Brand-Signal,
 *   - keyword-basierte Non-Food-Reasons der Python-Pipeline
 *     ("nonfood_kw:crivit", "nonfood_department:drogerie") — deterministische
 *     Non-Food-Regeln, kein Modell-Freitext. Bewusst NICHT `conflict_kw:*`
 *     (Task P1): ein Konflikt-Keyword ist RICHTUNGSAGNOSTISCH — von fünf
 *     Konfliktregeln korrigieren vier Richtung Food (cheese/meat/fish/
 *     pasta_sauce), nur eine Richtung Non-Food. `conflict_kw:frischkaese`
 *     (Karottini) ist also ein FOOD-Beleg, kein Non-Food-Beleg; es ist ein
 *     Diagnose-/Audit-Marker und darf die Entscheidung nicht treiben. Ein echtes
 *     Non-Food über den `non_food`-Konflikt (Reiniger/Batterie/Waschmittel)
 *     trägt das Keyword selbst im Namen und wird vom strukturellen TS-Check unten
 *     unabhängig erkannt,
 *   - der reine TS-Regel-Check OHNE Modell-Flags UND OHNE das generische
 *     `nonfood`-Tag (canonicalCategory/foodFlag und das Tag werden vor der
 *     Prüfung entfernt, damit weder ein halluziniertes Modell-Verdikt — der
 *     Bratmaxe-Fall — noch ein vom Modell/Legacy/Browser-Import gesetztes Tag
 *     sich selbst als harter Beleg bestätigt — der Karottini-Fall, Task P1).
 *
 * PROVENIENZ (Task P1): ein vertrauenswürdiges Non-Food-Tag belegt sich IMMER
 * zusätzlich strukturell und wird hier weiterhin hart erkannt — ein Connector
 * mit eindeutigem Non-Food-Bereich über seine Non-Food-Quellabteilung/Einheit,
 * ein Learned-Block über die Lernliste. Nur ein ISOLIERTES Tag ohne jeden
 * weiteren strukturellen Beleg ist kein harter Regelbeleg mehr; starke
 * Food-Belege können es dann reparieren (classifyFoodDecision).
 *
 * Gemeinsame Basis für die Kaufland-Vollständigkeits-Partition (server.ts) und
 * den finalen Food-Rescue-Pass, damit beide identisch urteilen.
 */
export function hasRuleConfirmedNonFoodSignal(offer: Offer): boolean {
  if (hasStrongNonFoodSignal(offer)) {
    return true;
  }
  const reasons = (offer as Offer & { canonicalCategory?: { reasons?: unknown } })
    .canonicalCategory?.reasons;
  // Ein `nonfood_kw:`-Beleg des Python-Categorizers zählt NUR, wenn das Keyword
  // wirklich im PRODUKTNAMEN steht. Der Categorizer matchte es bis 2026-08-17 auf
  // dem zusammengesetzten Body inkl. Händler-Abteilung — Kauflands kombinierte
  // Abteilung „Drogerie, Tiernahrung" belegte damit JEDES ihrer 47 Angebote mit
  // `nonfood_kw:tiernahrung` (Konfidenz 0,99), auch „ESN Isoclear Whey-Protein",
  // „KORO Proteinriegel" und „APTAMIL Folgemilch". Steht das Keyword nur in der
  // Abteilung, ist es ein ABTEILUNGS-Hinweis: den wertet hasNonFoodSourceCategory
  // aus (mit Ausnahme für eindeutig essbare Warenarten im Namen).
  // `nonfood_department:` ist per Definition abteilungsbasiert und zählt weiter.
  if (Array.isArray(reasons)) {
    const nameSource = normalizeText(`${offer.name} ${offer.brand ?? ''}`);
    const hasNameBackedKeywordReason = reasons.some((reason) => {
      if (typeof reason !== 'string') return false;
      if (reason.startsWith('nonfood_department:')) return true;
      if (!reason.startsWith('nonfood_kw:')) return false;
      const keyword = normalizeText(reason.slice('nonfood_kw:'.length));
      return keyword.length > 0 && keywordMatches(nameSource, keyword);
    });
    if (hasNameBackedKeywordReason) {
      return true;
    }
  }
  const stripped = { ...offer } as Offer & { canonicalCategory?: unknown; foodFlag?: unknown };
  delete stripped.canonicalCategory;
  delete stripped.foodFlag;
  stripped.tags = (offer.tags ?? []).filter((tag) => normalizeText(tag) !== NON_FOOD_TAG);
  return isStrictNonFoodOffer(stripped as Offer);
}

/**
 * True when an offer carries a STRONG, rule-based food signal: Food-Domänen-
 * vokabular im Namen/Brand, ein Food-Marken-Token (Kaffee-Marken), ein
 * Food-Tag (bio/vegan/…) oder die eindeutige Händler-Quellabteilung. Bewusst
 * OHNE das einfache `category`-Feld (im Filtered-Bucket nachweislich
 * unzuverlässig — Scraper-Reste wie "Snacks/Süßes" auf einem Badeponcho dürfen
 * kein korrektes Non-Food-Verdikt überstimmen), ohne die Einheiten-Heuristik
 * (`hasFoodUnit`) und ohne Modell-Verdikte — wird vom Food-Rescue genutzt, der
 * unsichere Fälle nie blind retten darf. Vetos prüft der Aufrufer
 * (hasRuleConfirmedNonFoodSignal) vorab.
 */
// Kurze Food-Keywords, die als nackter Substring deutsche Non-Food-Komposita
// treffen, brauchen Kompositum-Präzision:
//   'reis' — Food: Milchreis/Reisdrink/Basmatireis; NICHT "Preis"/"Tiefpreis"
//            (p davor), "Kreis" (k davor), "Reise…"/"Reissverschluss" (e/s danach)
//   'sekt' — Food: Sekt/Winzersekt; NICHT "Insekt(en)…" (in davor), "Sektion"
//   'saft' — Food: Saft/Orangensaft/Fruchtsaft; NICHT "Entsafter" (ent davor,
//            er danach) — ein Küchengerät darf nie über den Getränke-Substring
//            zum Food-Beleg werden.
const PRECISE_FOOD_KEYWORD_PATTERNS: ReadonlyArray<{ keyword: string; pattern: RegExp }> = [
  { keyword: 'reis', pattern: /(?<![pk])reis(?![es])/ },
  { keyword: 'sekt', pattern: /(?<!in)sekt(?!ion)/ },
  { keyword: 'saft', pattern: /(?<!ent)saft(?!er)/ },
];
const PRECISE_FOOD_KEYWORDS = new Set(
  PRECISE_FOOD_KEYWORD_PATTERNS.map((entry) => entry.keyword),
);

// Verzehrfertiges/geschnittenes Obst als generische Klasse (KEINE Allowlist für
// ein konkretes Testprodukt): ein Obst-/Frucht-Kopf am Wortanfang KOMBINIERT mit
// einem Convenience-/Verzehr-Indikator ("Obst im Becher", "Obst-Snack", "Frische
// Obst Mischung"). Reine Behälter/Utensilien (Kunststoffbecher, Obstschale,
// Obstmesser) tragen keinen Obst-KOPF am Wortanfang bzw. keinen Verzehr-Kontext
// und bleiben Non-Food.
const READY_TO_EAT_FRUIT_HEADS = ['obst', 'fruechte', 'frucht'];
const READY_TO_EAT_FRUIT_CONTEXT = [
  'becher',
  'snack',
  'mix',
  'mischung',
  'geschnitten',
  'verzehrfertig',
  'portion',
  'to go',
  'to-go',
  'schnitz',
  'spiess',
];
function hasReadyToEatFruitName(nameSource: string): boolean {
  if (!matchesWordBoundary(nameSource, READY_TO_EAT_FRUIT_HEADS)) {
    return false;
  }
  return READY_TO_EAT_FRUIT_CONTEXT.some((token) => nameSource.includes(token));
}

/**
 * True, wenn ein MARKEN-Hinweis (Kaffee-/Tee-/Süßwarenmarke) zusätzlich von einem
 * UNABHÄNGIGEN strukturellen Food-Beleg gestützt wird (Task P3). Eine Marke allein
 * reicht NIE — „Jacobs Gold"/„Melitta Auslese" aus neutraler Quelle bleiben
 * uncertain. Erst eine zweite, marken-unabhängige Evidenzklasse macht das Angebot
 * zu confirmed_food:
 *   - vertrauenswürdige Food-/Kaffee-Quellabteilung (hasStrongFoodSourceSignal),
 *   - konkreter Kaffee-/Zubereitungs-Deskriptor (gemahlen/instant/Pads/Bohne/…),
 *   - belastbare Food-Einheit/Grundpreis (kg/g/l/ml über hasFoodUnit).
 */
function hasBrandWithIndependentFoodEvidence(offer: Offer, nameSource: string): boolean {
  if (!containsAny(nameSource, [...FOOD_BRAND_TOKENS])) {
    return false;
  }
  if (hasStrongFoodSourceSignal(offer)) {
    return true;
  }
  if (containsAny(nameSource, [...BRAND_SUPPORTING_FOOD_DESCRIPTORS])) {
    return true;
  }
  return hasFoodUnit(offer);
}

/** Beverage context that upgrades an ambiguous beer-style word to confirmed food:
 *  a liter unit/base-unit, or a drink/alcohol category or source department. Never
 *  consults the model verdict. Generic — keine Produktliste. */
function hasBeverageContext(offer: Offer): boolean {
  const o = offer as Offer & {
    baseUnit?: unknown;
    sourceCategoryRaw?: unknown;
    sourceDepartmentRaw?: unknown;
  };
  const units = normalizeText(`${offer.unit ?? ''} ${String(o.baseUnit ?? '')}`);
  if (/(^|[\s\d.,/-])(l|ml|cl)(\b|$)/.test(units)) {
    return true;
  }
  const cat = normalizeText(offer.category ?? '');
  if (/(getraenk|\bbier\b|alkohol|\bwein\b|spirituos|pils|radler)/.test(cat)) {
    return true;
  }
  const raw = normalizeText(`${String(o.sourceCategoryRaw ?? '')} ${String(o.sourceDepartmentRaw ?? '')}`);
  return /(getraenk|\bbier\b|alkohol|\bwein\b|spirituos|longdrink|aperitif)/.test(raw);
}

/** A beer-style word ("Export"/"Märzen") WITH beverage context is an alcohol food
 *  beverage. Without context it is only a food SUSPECT (hasSuspectFoodEvidence). */
function hasAlcoholBeverageSignal(offer: Offer): boolean {
  const nameSource = normalizeText(`${offer.name} ${offer.brand ?? ''}`);
  if (!matchesWordBoundary(nameSource, ALCOHOL_STYLE_WORDS)) {
    return false;
  }
  return hasBeverageContext(offer);
}

export function hasStrongFoodSignal(offer: Offer): boolean {
  const nameSource = normalizeText(`${offer.name} ${offer.brand ?? ''}`);
  // Bierstil + Getränke-Kontext (Export/Märzen mit Liter/Getränke-Abteilung) ist
  // ein Alkoholgetränk = Food. Ohne Kontext greift nur der Verdacht (s. u.).
  if (hasAlcoholBeverageSignal(offer)) {
    return true;
  }
  // Generische Food-Deskriptoren (Café/Caffè/Crema/Barista) — Produktbeschreibung,
  // KEINE Marke; Wortgrenze, damit 'cafe' nicht in der Marke 'nescafe' steckt.
  if (matchesWordBoundary(nameSource, FOOD_DESCRIPTOR_TOKENS)) {
    return true;
  }
  if (hasReadyToEatFruitName(nameSource)) {
    return true;
  }
  // Zubereitungsart + Speisen-Kopf („Mikrowellengericht", „Ofenkäse",
  // „Grillwurst", „Pfannengericht") ist per Kompositum-Kopf eine SPEISE.
  if (hasPreparedDishName(nameSource)) {
    return true;
  }
  if (
    foodKeywords.some(
      (keyword) => !PRECISE_FOOD_KEYWORDS.has(keyword) && keywordMatches(nameSource, keyword),
    )
  ) {
    return true;
  }
  if (PRECISE_FOOD_KEYWORD_PATTERNS.some((entry) => entry.pattern.test(nameSource))) {
    return true;
  }
  // Wortgrenzen-Food-Vokabular (Mais/Flips/Beer/Lager/Ale/Laugen).
  if (matchesWordBoundary(nameSource, FOOD_WORD_BOUNDARY_KEYWORDS)) {
    return true;
  }
  // Eindeutig essbare Warenarten (Sport-/Säuglings-/Riegel-Vokabular) — dieselbe
  // Liste, die auch eine Non-Food-ABTEILUNG überstimmt, damit Gate, Rescue und
  // Report identisch urteilen.
  if (hasEdibleProductNameSignal(offer)) {
    return true;
  }
  if ((offer.tags ?? []).some((tag) => foodTags.includes(normalizeText(tag)))) {
    return true;
  }
  if (hasStrongFoodSourceSignal(offer)) {
    return true;
  }
  // Marken-Hinweis (Kaffee-/Tee-/Süßwarenmarke) zählt NUR mit unabhängigem
  // strukturellem Food-Beleg — eine Marke allein rettet keinen mehrdeutigen
  // Kurznamen („Jacobs Gold"/„Melitta Auslese") (Task P3).
  return hasBrandWithIndependentFoodEvidence(offer, nameSource);
}

/** True when the offer's SIMPLE category names a food department AND no non-food
 *  category keyword contradicts it. Deliberately ONE of several independent
 *  signals (never decisive alone) — the simple `category` field is unreliable in
 *  the filtered bucket, so it only counts as supporting evidence inside
 *  {@link hasMultiSignalFoodEvidence}. */
function hasFoodCategoryKeyword(offer: Offer): boolean {
  const category = normalizeText(offer.category ?? '');
  if (!category.trim()) {
    return false;
  }
  if (containsAny(category, nonFoodCategoryKeywords)) {
    return false;
  }
  return containsAny(category, foodCategoryKeywords);
}

/**
 * Task P1 — strukturelle Mehrsignal-Evidenz für einen gefilterten Review-Fall.
 * Der Aufrufer ({@link classifyFoodDecision}) hat bereits ausgeschlossen, dass ein
 * REGEL-Beleg Non-Food sagt UND dass ein einzelnes hartes Food-Signal greift; hier
 * wird ein gefilterter UNSICHERER Fall NUR dann zu confirmed_food, wenn MEHRERE
 * UNABHÄNGIGE Signale zusammenkommen — nie das Modell-Flag allein:
 *   1. das Modell selbst stimmt für Food (`foodFlag==='food'`), UND
 *   2. mindestens ZWEI marken-/modell-unabhängige strukturelle Belege:
 *        - eine Lebensmittel-typische Mengeneinheit (kg/g/l/ml),
 *        - eine vertrauenswürdige Food-Quellabteilung,
 *        - eine Food-Kategorie ohne widersprechende Non-Food-Kategorie.
 * Bewusst KEINE Produkt-/Marken-Allowlist, kein KW-/Shop-Sonderfall. Ein
 * mehrdeutiger Stück-Artikel mit nur Food-Kategorie + foodFlag (der Spritzring-
 * Fall) erreicht die Schwelle NICHT und bleibt ehrlich uncertain/Review. Pure.
 */
export function hasMultiSignalFoodEvidence(offer: Offer): boolean {
  if ((offer as Offer & { foodFlag?: unknown }).foodFlag !== 'food') {
    return false;
  }
  let independentSignals = 0;
  if (hasFoodUnit(offer)) independentSignals += 1;
  if (hasStrongFoodSourceSignal(offer)) independentSignals += 1;
  if (hasFoodCategoryKeyword(offer)) independentSignals += 1;
  return independentSignals >= 2;
}

/**
 * Food-VERDACHT im Filter (Task): ein zentral UNSICHERER, NICHT non-food belegter
 * gefilterter Fall (classifyFoodDecision=uncertain — der Aufrufer hat das geprüft)
 * trägt dennoch ein TEILWEISES, nicht entscheidendes Food-Indiz. Solche Fälle
 * gehören nicht still in den „eher Non-Food"-Review, sondern sichtbar als
 * Food-Verdacht (foodLikeReview), damit der Report nicht fälschlich „alles ok"
 * meldet. Das ist NIE eine Rettung — nur Sichtbarkeit:
 *   - das Modell stimmt selbst für Food (`foodFlag==='food'`),
 *   - ein veralteter/schwacher Non-Food-Cache widerspricht dem eigenen foodFlag
 *     (hasUntrustworthyCacheNonFood — der Spritzring-Cache-Konflikt),
 *   - die KI hat es positiv als Food eingestuft (canonical isNonFood=false + main),
 *   - eine Kaffee-/Tee-/Süßwarenmarke ALLEIN (Top-Cup/Zott-Monte-Verdacht — eine
 *     Marke belegt hier nur den VERDACHT, nie das Verdikt, Task P3),
 *   - ein Bierstil-Wort ALLEIN ohne Getränke-Kontext (CLUSS Export ohne 0,5 l),
 *   - eine Food-Einheit (kg/g/l/ml) zusammen mit einer Food-Kategorie.
 * Bewusst KEINE Produkt-/Marken-Allowlist im Entscheidungssinn. Pure.
 */
export function hasSuspectFoodEvidence(offer: Offer): boolean {
  if ((offer as Offer & { foodFlag?: unknown }).foodFlag === 'food') {
    return true;
  }
  if (hasUntrustworthyCacheNonFood(offer)) {
    return true;
  }
  if (hasCanonicalFoodFlag(offer)) {
    return true;
  }
  const nameSource = normalizeText(`${offer.name} ${offer.brand ?? ''}`);
  if (containsAny(nameSource, [...FOOD_BRAND_TOKENS])) {
    return true;
  }
  if (matchesWordBoundary(nameSource, ALCOHOL_STYLE_WORDS)) {
    return true;
  }
  return hasFoodUnit(offer) && hasFoodCategoryKeyword(offer);
}

/**
 * True when an offer carries ANY hard, unambiguous non-food signal — used as the
 * single defense-in-depth gate that keeps non-food out of Phase 2 deep analysis.
 * It ORs every strong structured + textual signal so none can be missed:
 *   - `foodFlag === 'nonfood'` (model/pipeline verdict)
 *   - `canonicalCategory.isNonFood === true` (structured KI flag)
 *   - an explicit `nonfood` tag (e.g. the Kaufland SSR non-food categories)
 *   - a plant ("pflanze") unit
 *   - a STRONG non-food keyword/brand (LIVARNO/Insektenschutz/…)
 *   - an obvious non-food category name (Drogerie/Haushalt/…)
 * Pure + high-precision (does NOT consult the editable rules state), so it is
 * safe to call before `initializeStrictFoodFilterRules()` and never drops real
 * food — including international foods like Sriracha/Ayran/Basmati.
 */
export function hasHardNonFoodSignal(offer: Offer): boolean {
  const foodFlag = (offer as Offer & { foodFlag?: unknown }).foodFlag;
  if (typeof foodFlag === 'string' && foodFlag === 'nonfood') {
    return true;
  }
  // Task P1: ein veralteter/schwacher Cache-Hit (cache:hit / low-confidence), der
  // dem eigenen foodFlag='food' widerspricht und KEINEN unabhängigen Non-Food-
  // Beleg trägt, ist KEIN harter Non-Food-Beleg — er darf die Phase-2-Reanalyse
  // nicht blockieren. Strukturell echtes Non-Food behält jedes andere Signal.
  if (hasCanonicalNonFoodFlag(offer) && !hasUntrustworthyCacheNonFood(offer)) {
    return true;
  }
  if (hasNonFoodTag(offer)) {
    return true;
  }
  if (hasNonFoodUnit(offer)) {
    return true;
  }
  if (hasStrongNonFoodSignal(offer)) {
    return true;
  }
  // Datenqualität #3: dieselben Kontext-/Botanik-Signale auch hier, damit Phase 2
  // + Categorizer-Bridge die Ausreißer (Blumen/Pailletten/Tierbedarf) droppen.
  if (hasContextNonFoodSignal(offer)) {
    return true;
  }
  const category = normalizeText(offer.category ?? '');
  if (containsAny(category, nonFoodCategoryKeywords)) {
    return true;
  }
  return false;
}

export async function learnStrictFoodFeedback(
  offers: Offer[],
  decision: 'allow' | 'block',
): Promise<number> {
  if (offers.length === 0) {
    return 0;
  }

  const learnedAllowedSet = new Set(rulesState.learnedAllowedOfferNames);
  const learnedBlockedSet = new Set(rulesState.learnedBlockedOfferNames);
  let changed = false;
  let affected = 0;

  for (const offer of offers) {
    const learningName = getOfferLearningName(offer);
    if (!learningName) {
      continue;
    }

    if (decision === 'allow') {
      const added = !learnedAllowedSet.has(learningName);
      const removed = learnedBlockedSet.delete(learningName);
      if (added || removed) {
        learnedAllowedSet.add(learningName);
        changed = true;
        affected += 1;
      }
      continue;
    }

    const added = !learnedBlockedSet.has(learningName);
    const removed = learnedAllowedSet.delete(learningName);
    if (added || removed) {
      learnedBlockedSet.add(learningName);
      changed = true;
      affected += 1;
    }
  }

  if (!changed) {
    return 0;
  }

  rulesState.learnedAllowedOfferNames = [...learnedAllowedSet];
  rulesState.learnedBlockedOfferNames = [...learnedBlockedSet];
  await saveCurrentRulesState();
  return affected;
}

export async function addStrictBlockedKeyword(
  keywordRaw: string,
): Promise<{ changed: boolean; list: StrictFoodFilterList; keyword: string | null }> {
  const keyword = normalizeText(keywordRaw);
  if (!keyword) {
    return {
      changed: false,
      list: getStrictFoodFilterList(),
      keyword: null,
    };
  }

  const defaultSet = getDefaultBlockedKeywordSet();
  const removeSet = new Set(rulesState.removeBlockedKeywords);
  const addSet = new Set(rulesState.addBlockedKeywords);

  let changed = false;

  if (removeSet.has(keyword)) {
    rulesState.removeBlockedKeywords = rulesState.removeBlockedKeywords.filter(
      (entry) => entry !== keyword,
    );
    changed = true;
  } else if (!defaultSet.has(keyword) && !addSet.has(keyword)) {
    rulesState.addBlockedKeywords = [...rulesState.addBlockedKeywords, keyword];
    changed = true;
  }

  if (changed) {
    await saveCurrentRulesState();
  }

  return {
    changed,
    list: getStrictFoodFilterList(),
    keyword,
  };
}

export async function removeStrictBlockedKeyword(
  keywordRaw: string,
): Promise<{ changed: boolean; list: StrictFoodFilterList; keyword: string | null }> {
  const keyword = normalizeText(keywordRaw);
  if (!keyword) {
    return {
      changed: false,
      list: getStrictFoodFilterList(),
      keyword: null,
    };
  }

  const defaultSet = getDefaultBlockedKeywordSet();
  const addSet = new Set(rulesState.addBlockedKeywords);
  const removeSet = new Set(rulesState.removeBlockedKeywords);

  let changed = false;

  if (addSet.has(keyword)) {
    rulesState.addBlockedKeywords = rulesState.addBlockedKeywords.filter(
      (entry) => entry !== keyword,
    );
    changed = true;
  } else if (defaultSet.has(keyword) && !removeSet.has(keyword)) {
    rulesState.removeBlockedKeywords = [...rulesState.removeBlockedKeywords, keyword];
    changed = true;
  }

  if (changed) {
    await saveCurrentRulesState();
  }

  return {
    changed,
    list: getStrictFoodFilterList(),
    keyword,
  };
}

export async function resetStrictFoodFilterRules(): Promise<StrictFoodFilterList> {
  rulesState = {
    addBlockedKeywords: [],
    removeBlockedKeywords: [],
    learnedAllowedOfferNames: [],
    learnedBlockedOfferNames: [],
  };
  await saveCurrentRulesState();
  return getStrictFoodFilterList();
}

/** True when the KI/rule categorizer explicitly examined the offer and judged
 *  it FOOD (isNonFood === false with a real canonical main). The symmetric
 *  counterpart to {@link hasCanonicalNonFoodFlag}: without it the keyword
 *  allowlist below silently dropped clear food the lists do not know
 *  ("Maggi Guten Appetit Suppe" → Konserven & Fertiggerichte, but no 'suppe'
 *  keyword). The hard non-food veto in isStrictNonFoodOffer always runs first. */
function hasCanonicalFoodFlag(offer: Offer): boolean {
  const canonical = (offer as Offer & { canonicalCategory?: unknown }).canonicalCategory;
  if (!canonical || typeof canonical !== 'object') {
    return false;
  }
  const c = canonical as { isNonFood?: unknown; main?: unknown };
  if (!(c.isNonFood === false && typeof c.main === 'string' && c.main.trim().length > 0)) {
    return false;
  }
  // Ein inkonsistenter (repariert-er) Food-Flag, dessen eigene Gründe Non-Food
  // erklären, ist ein ungeprüfter Platzhalter — kein positives Food-Verdikt.
  return !hasInconsistentCanonicalFoodFlag(offer);
}

export function isStrictFoodOffer(offer: Offer): boolean {
  const { category, source, learningName } = buildOfferSignals(offer);
  if (learningName && rulesState.learnedAllowedOfferNames.includes(learningName)) {
    return true;
  }
  if (learningName && rulesState.learnedBlockedOfferNames.includes(learningName)) {
    return false;
  }

  if (isStrictNonFoodOffer(offer)) {
    return false;
  }

  // Strukturierte Food-Verdikte: die KI hat das Angebot geprüft und explizit
  // als Food eingestuft, oder die Händler-Quellkategorie ist eindeutig Food —
  // beides schlägt die (zwangsläufig unvollständige) Keyword-Allowlist.
  if (hasCanonicalFoodFlag(offer) || hasStrongFoodSourceSignal(offer)) {
    return true;
  }

  const nameSource = normalizeText(`${offer.name} ${offer.brand ?? ''}`);
  // Generische Food-Deskriptoren (Café/Caffè/Crema/Barista). Eine Marke allein
  // rettet einen mehrdeutigen Kurznamen NICHT — sie zählt nur mit unabhängigem
  // strukturellem Food-Beleg (Task P3).
  if (
    matchesWordBoundary(nameSource, FOOD_DESCRIPTOR_TOKENS) ||
    hasBrandWithIndependentFoodEvidence(offer, nameSource)
  ) {
    return true;
  }

  // Verzehrfertiges Obst ("Obst im Becher") — generische Klasse, kein Allowlist-
  // Einzelprodukt. Leere Behälter (Kunststoffbecher) tragen keinen Obst-Kopf.
  if (hasReadyToEatFruitName(nameSource)) {
    return true;
  }

  if (containsAny(category, foodCategoryKeywords)) {
    return true;
  }

  if (containsAny(source, foodKeywords)) {
    return true;
  }

  if (matchesWordBoundary(source, FOOD_WORD_BOUNDARY_KEYWORDS)) {
    return true;
  }

  if ((offer.tags ?? []).some((tag) => foodTags.includes(normalizeText(tag)))) {
    return true;
  }

  if (hasFoodUnit(offer)) {
    return true;
  }

  return false;
}

export function filterOffersStrictFood(offers: Offer[]): StrictFoodFilterResult {
  const kept: Offer[] = [];
  const removed: Offer[] = [];

  for (const offer of offers) {
    if (isStrictFoodOffer(offer)) {
      kept.push(offer);
    } else {
      removed.push(offer);
    }
  }

  return {
    offers: kept,
    removedOffers: removed,
    removedCount: removed.length,
    removedExamples: removed.slice(0, 8).map((offer) => offer.name),
  };
}
