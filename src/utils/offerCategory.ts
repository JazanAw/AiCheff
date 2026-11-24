import { normalizeText } from './offers';

export const SIMPLE_OFFER_CATEGORIES = [
  'Obst/Gem\u00fcse',
  'Fleisch',
  'Fisch',
  'Milchprodukte',
  'Milchalternativen',
  'Backwaren',
  'Trockenware',
  'Konserven',
  'Tiefk\u00fchl',
  'Getr\u00e4nke Alkoholfrei',
  'Alkohol',
  'Snacks/S\u00fc\u00dfes',
  'Sonstiges',
] as const;

export type SimpleOfferCategory = (typeof SIMPLE_OFFER_CATEGORIES)[number];

interface CategoryRule {
  category: SimpleOfferCategory;
  keywords: string[];
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Keywords, die NIE als Präfix eines längeren, anders bedeutenden Wortes
// matchen dürfen: 'nektar' (Getränk) traf sonst 'Nektarine' (Obst). Solche
// Wörter zählen nur als ganzes Token; ihren Kompositum-Kopf am Wortende
// ("Fruchtnektar") fängt separat die DRINK_SUFFIXES-Prüfung ab.
const WHOLE_WORD_ONLY_KEYWORDS = new Set(['nektar']);

function hasKeyword(source: string, keyword: string): boolean {
  const normalizedKeyword = keyword.trim();
  if (!normalizedKeyword) {
    return false;
  }

  if (normalizedKeyword.includes(' ')) {
    const pattern = new RegExp(`(^|\\s)${escapeRegExp(normalizedKeyword)}(?=$|\\s)`);
    return pattern.test(source);
  }

  const tokens = source.split(' ').filter(Boolean);
  if (WHOLE_WORD_ONLY_KEYWORDS.has(normalizedKeyword)) {
    return tokens.some((token) => token === normalizedKeyword);
  }
  return tokens.some(
    (token) => token === normalizedKeyword || token.startsWith(normalizedKeyword),
  );
}

function normalizeCategorySource(input: string): string {
  const fixedEncoding = input
    // Handle occasional mojibake sequences.
    .replace(/\u00c3\u00a4/gi, '\u00e4')
    .replace(/\u00c3\u00b6/gi, '\u00f6')
    .replace(/\u00c3\u00bc/gi, '\u00fc')
    .replace(/\u00c3\u009f/gi, '\u00df');

  return normalizeText(fixedEncoding);
}

const categoryRules: CategoryRule[] = [
  {
    category: 'Obst/Gem\u00fcse',
    keywords: [
      'obst',
      'gemuse',
      'gemuese',
      'gemse',
      'salat',
      'brokkoli',
      'tomate',
      'paprika',
      'gurke',
      'zwiebel',
      'kartoffel',
      'apfel',
      'banane',
      'birne',
      // konservative Erg\u00e4nzungen: eindeutige Frischeprodukte, die selten in
      // Getr\u00e4nke-/Milch-Komposita auftauchen (kein 'orange' \u2192 Orangensaft!).
      'moehre',
      'karotte',
      'spinat',
      'zucchini',
      'champignon',
      'avocado',
      'blumenkohl',
      'aubergine',
      'kohlrabi',
      'rucola',
      'feldsalat',
      'lauch',
      // Salat-Komposita ('salat' am Wortanfang w\u00fcrde "Kopfsalat" nicht treffen)
      'kopfsalat',
      'eisbergsalat',
      'blattsalat',
      'pfluecksalat',
      'romanasalat',
      'eichblattsalat',
    ],
  },
  {
    category: 'Tiefk\u00fchl',
    keywords: [
      'tiefkuehl',
      'tiefkuhl',
      'gefroren',
      'frozen',
      'tk',
      'speiseeis',
      'eiscreme',
      // Speiseeis: "Ice Cream" als PHRASE (nie bare 'ice' \u2192 "Ice Tea" ist Getr\u00e4nk)
      'ice cream',
      'icecream',
      // eindeutige Tiefkuehl-/Eis-Marken
      'iglo',
      'frosta',
      'ben jerry',
      'haagen',
      'cornetto',
      'langnese',
    ],
  },
  {
    category: 'Fleisch',
    keywords: [
      'fleisch',
      'wurst',
      'salami',
      'schinken',
      'steak',
      'rind',
      'schwein',
      'haehnchen',
      'huhn',
      'pute',
      'geflugel',
      'hack',
      'mettwurst',
      'mortadella',
      'gulasch',
      'bratwurst',
      'leberkaese',
      'cabanossi',
      'frikadelle',
      'schnitzel',
    ],
  },
  {
    category: 'Fisch',
    keywords: ['fisch', 'lachs', 'thunfisch', 'garnelen', 'pangasius'],
  },
  {
    category: 'Milchalternativen',
    keywords: [
      'milchalternativen',
      'haferdrink',
      'sojadrink',
      'sojajoghurt',
      'mandeldrink',
      'kokosdrink',
      'reisdrink',
      'tofu',
      'hummus',
    ],
  },
  {
    category: 'Milchprodukte',
    keywords: [
      'milchprodukte',
      'milch',
      'joghurt',
      'kaese',
      'quark',
      'sahne',
      'butter',
      'skyr',
      'mozzarella',
      'gouda',
      'frischkase',
      'kaesescheiben',
      'eier',
      'schmand',
      'kefir',
      'buttermilch',
      'camembert',
      'edamer',
      'feta',
      'parmesan',
    ],
  },
  {
    category: 'Backwaren',
    keywords: [
      'backwaren',
      'brot',
      'broetchen',
      'fladenbrot',
      'toast',
      'croissant',
      'baguette',
      'kuchen',
      'gebaeck',
      'maultaschen',
    ],
  },
  {
    category: 'Trockenware',
    keywords: [
      'trockenware',
      'reis',
      'nudel',
      'pasta',
      'spaghetti',
      'penne',
      'fusilli',
      'farfalle',
      'rigatoni',
      'maccheroni',
      'makkaroni',
      'tagliatelle',
      'tortellini',
      'tortelloni',
      'gnocchi',
      'linsen',
      'kichererbsen',
      'bohnen',
      'mehl',
      'zucker',
      'olivenoel',
      'oel',
      'essig',
      'gewuerze',
      'samen',
      'nuesse',
      'nusse',
      // Saucen/Pesto + Pasta-Marke (REWE "Barilla …") — Trockenware/Saucen
      'pesto',
      'sugo',
      'passata',
      'barilla',
    ],
  },
  {
    category: 'Konserven',
    keywords: [
      'konserve',
      'konserven',
      'dose',
      'dosen',
      'tomatenmark',
      'passierte tomaten',
      'eingemacht',
    ],
  },
  {
    category: 'Alkohol',
    keywords: [
      'bier',
      'wein',
      'sekt',
      'radler',
      'vodka',
      'wodka',
      'whiskey',
      'whisky',
      'rum',
      'gin',
      'likoer',
      'likor',
      'spirituose',
      'tequila',
      'aperol',
      'aperitivo',
      'schnaps',
      'cognac',
      'weinbrand',
      // eindeutig alkoholische Produkte/Marken, die bisher fehlten
      'limoncello',
      'limoncino',
      'grappa',
      'ouzo',
      'sangria',
      'gluehwein',
      'prosecco',
      'amaretto',
      'jaegermeister',
      'wermut',
      'portwein',
    ],
  },
  {
    category: 'Getr\u00e4nke Alkoholfrei',
    keywords: [
      'getranke',
      'getraenke',
      'wasser',
      'mineralwasser',
      'cola',
      'limonade',
      'saft',
      'tee',
      'kaffee',
      'energy',
      'softdrink',
      'schorle',
      'smoothie',
      'nektar',
      'eistee',
      'kakao',
      'spritz',
      // gängige alkoholfreie Marken/Begriffe
      'redbull',
      'red bull',
      'monster',
      'coca',
      'cocacola',
      'pepsi',
      'fanta',
      'sprite',
      'spezi',
      'mezzomix',
      'gerolsteiner',
      'volvic',
    ],
  },
  {
    category: 'Snacks/S\u00fc\u00dfes',
    keywords: [
      'snack',
      'chips',
      'schokolade',
      'keks',
      'kekse',
      'bonbon',
      'praline',
      'sussigkeiten',
      'suessigkeiten',
      'suigkeiten',
      'sssigkeiten',
      'sigkeiten',
      'fruchtgummi',
      'gummibaer',
      'kaugummi',
      'popcorn',
      'riegel',
      'dessert',
      'eis',
      // gängige Snack-/Süßwaren-Marken
      'haribo',
      'milka',
      'lindt',
      'rittersport',
      'nutella',
      'oreo',
      'kinder',
      'duplo',
      'snickers',
      'twix',
      'kitkat',
      'pringles',
      'toffifee',
      'merci',
      'salzstange',
      'flips',
      // weitere gängige Süßwaren-/Snack-Marken
      'katjes',
      'trolli',
      'ferrero',
    ],
  },
];

// Getränke-Komposita, deren Grundwort am Wort-ENDE steht ("Apfelsaft",
// "Orangensaft", "Traubenschorle"). Die Präfix-Regeln oben greifen dort nicht,
// weil sie nur Wortanfänge prüfen — deshalb diese gezielte Suffix-Prüfung.
const DRINK_SUFFIXES = ['saft', 'schorle', 'nektar'] as const;

function endsWithDrinkSuffix(tokens: string[]): boolean {
  return tokens.some((token) =>
    DRINK_SUFFIXES.some(
      (suffix) => token.length > suffix.length && token.endsWith(suffix),
    ),
  );
}

function matchesAlcohol(source: string): boolean {
  const rule = categoryRules.find((entry) => entry.category === 'Alkohol');
  return !!rule && rule.keywords.some((keyword) => hasKeyword(source, keyword));
}

// "alkoholfrei" explizit ist ein hartes Signal: ein alkoholfreies Bier/Weizen
// darf NIE als Alkohol klassifiziert werden, auch wenn "Bier"/"Wein" im Namen
// steht. normalizeText() lässt das Wort intakt (keine Sonderzeichen).
function isExplicitNonAlcoholic(source: string): boolean {
  return /(^|\s)alkoholfrei/.test(source);
}

// Alkohol-an-Volumenangabe: "6,9% Vol", "4.9 % Vol.", "40 vol" … normalizeText()
// entfernt das '%' und Dezimaltrenner, übrig bleibt eine Ziffer gefolgt von
// "vol" (nicht weiter zu einem Wort wie "volvic"/"vollmilch" gehörend).
const ALCOHOL_BY_VOLUME = /\d\s*vol(?![a-z])/;

function hasAlcoholByVolume(source: string): boolean {
  return ALCOHOL_BY_VOLUME.test(source);
}

// Hochpräzise Snack-Signale, die einen Gemüse-/Obst-GESCHMACK im Produktnamen
// schlagen müssen ("Crunchips Paprika", "Kartoffelchips Paprika"). Ein Token,
// das auf "chips" endet, ist praktisch immer ein Snack; dazu eindeutige Marken-
// /Produktbegriffe. Bewusst KEIN bare 'chips'-Substring (würde sonst auch in
// Komposita wie "Microchips" greifen — die fängt der Non-Food-Filter ab).
const SNACK_PRODUCT_KEYWORDS = [
  'crunchips',
  'kesselchips',
  'kartoffelchips',
  'tortillachips',
  'riffels',
  'pommels',
  'nachos',
  'cracker',
  'crackers',
];

function endsWithChips(tokens: string[]): boolean {
  return tokens.some((token) => token.length > 4 && token.endsWith('chips'));
}

function matchesSnackProduct(source: string, tokens: string[]): boolean {
  if (endsWithChips(tokens)) {
    return true;
  }
  return SNACK_PRODUCT_KEYWORDS.some((keyword) => hasKeyword(source, keyword));
}

// Trockenware-Signale, die eine (oft falsche) Obst/Gemüse-Roh-Kategorie schlagen
// müssen ("Noodles Teriyaki", "Spaghetti No.5"). Fertig-/Asia-Nudeln und Pasta
// sind Trockenware, kein frisches Gemüse.
const DRY_PRODUCT_KEYWORDS = [
  'noodles',
  'noodle',
  'teriyaki',
  'ramen',
  'nudel',
  'pasta',
  'spaghetti',
  'penne',
  'maccaroni',
  'makkaroni',
  'maccheroni',
  'fusilli',
  'farfalle',
  'rigatoni',
  'tagliatelle',
  'tortellini',
  'tortelloni',
  'gnocchi',
];

function matchesDryProduct(source: string): boolean {
  return DRY_PRODUCT_KEYWORDS.some((keyword) => hasKeyword(source, keyword));
}

// Frische-Grundwörter, die als KOPF (Wortende) eines deutschen Kompositums ein
// Obst/Gemüse belegen: "Rispentomaten"/"Strauchtomaten"/"Cherrytomaten",
// "Gelbfleischige Nektarinen". Die Präfix-Regeln oben greifen dort nicht
// (das Grundwort steht am Wort-ENDE), und ein nackter Substring würde wieder
// 'mate' in "Tomate" o. Ä. treffen. Flexionsendungen (-n/-s/-en) toleriert.
// Bewusst Vokabular, keine Produkt-Sollwerte. Alkohol/Snack/Trockenware/
// Getränke-Suffix werden VORHER geprüft, daher kann 'tomatensaft' o. Ä. hier
// nicht fälschlich als Frische gewinnen.
const PRODUCE_COMPOUND_HEADS = [
  'tomate',
  'nektarine',
  'paprika',
  'gurke',
  'zwiebel',
  'kartoffel',
  'karotte',
  'moehre',
  'apfel',
  // Umlaut-Plural "Äpfel" → normalize ae; ohne diesen Kopf gewinnt ein
  // Marketingwort wie "Snack" über das echte Obst ("Snack Äpfel" → Obst/Gemüse).
  'aepfel',
  'birne',
] as const;

function endsWithProduceHead(tokens: string[]): boolean {
  return tokens.some((token) =>
    PRODUCE_COMPOUND_HEADS.some((stem) => {
      if (token.length <= stem.length) {
        return token === stem;
      }
      return (
        token.endsWith(stem) ||
        token.endsWith(`${stem}n`) ||
        token.endsWith(`${stem}s`) ||
        token.endsWith(`${stem}en`)
      );
    }),
  );
}

export function toSimpleOfferCategory(
  rawCategory: string | undefined,
  hintText = '',
): SimpleOfferCategory {
  const source = normalizeCategorySource(`${rawCategory ?? ''} ${hintText}`);
  if (!source) {
    return 'Sonstiges';
  }

  const tokens = source.split(' ').filter(Boolean);

  // 1) "alkoholfrei" im PRODUKTNAMEN gewinnt immer (auch über "Bier"/"Wein").
  //    Bewusst nur am Namen geprüft: eine (oft falsche) Roh-Kategorie
  //    "Getränke Alkoholfrei" darf einen klar alkoholischen Artikel wie
  //    "Limoncello Spritz 6,9% Vol" NICHT als alkoholfrei umdeuten.
  if (isExplicitNonAlcoholic(normalizeCategorySource(hintText))) {
    return 'Getränke Alkoholfrei';
  }

  // 2) Alkohol an Stichwort ODER %-Vol-Angabe — schlägt die "Spritz"-Heuristik
  //    der alkoholfreien Getränke (z. B. "Limoncello Spritz 6,9% Vol").
  if (matchesAlcohol(source) || hasAlcoholByVolume(source)) {
    return 'Alkohol';
  }

  // 3) Hochpräzise Snack-/Trockenware-Signale schlagen einen Obst/Gemüse-
  //    Geschmack bzw. eine falsche Roh-Kategorie (Crunchips Paprika, Noodles).
  if (matchesSnackProduct(source, tokens)) {
    return 'Snacks/Süßes';
  }
  if (matchesDryProduct(source)) {
    return 'Trockenware';
  }

  // 4) "Apfelsaft"/"Orangensaft" sind Getränke, kein Obst (Alkohol ist bereits
  //    oben abgehandelt, daher hier kein Alkohol-Guard mehr nötig).
  if (endsWithDrinkSuffix(tokens)) {
    return 'Getränke Alkoholfrei';
  }

  // 5) Frische-Kompositum-Köpfe ("Rispentomaten", "Gelbfleischige Nektarinen")
  //    erst NACH den Getränke-/Snack-/Alkohol-Prüfungen, damit "Tomatensaft"
  //    oder "Paprikachips" nicht fälschlich als Frische gewinnen.
  if (endsWithProduceHead(tokens)) {
    return 'Obst/Gemüse';
  }

  for (const rule of categoryRules) {
    if (rule.keywords.some((keyword) => hasKeyword(source, keyword))) {
      return rule.category;
    }
  }

  return 'Sonstiges';
}

// Gezielte Kategorie-Reparatur (Datenqualität): wenige, HOCHPRÄZISE Produkt-
// signale, die eine offensichtlich falsche (oder leere "Sonstiges"-) Kategorie
// allein anhand des PRODUKTNAMENS korrigieren. Bewusst NICHT generisch
// "Name schlägt Kategorie" (das würde korrekte KI-Kategorien zerstören, z. B.
// "Thunfisch Pizza" → Fisch). Nur die im Snapshot real beobachteten Fehlgriffe.
const SIMPLE_CATEGORY_REPAIR_RULES: { category: SimpleOfferCategory; keywords: string[] }[] = [
  // Gefüllte Weinblätter sind Konserven/Feinkost (das 'wein'-Substring machte
  // sie fälschlich zu Alkohol); Maultaschen sind ein Fertiggericht aus der
  // Kühlung (das 'taschen'-Substring machte sie zu Backwaren). Die einfache
  // Taxonomie bündelt beides unter 'Konserven' (= Konserven & Fertiggerichte).
  {
    category: 'Konserven',
    keywords: ['weinblaetter', 'maultaschen'],
  },
  // Grillkäse(mix)/Halloumi/Milchreis sind Milchprodukte — nie Getränke/Obst.
  // Datenqualität #4: + Grilltaler, Reibekäse, „Der Große Bauer" (Molkerei),
  // (Protein-)Pudding/Monte-Drink/Skyr-Desserts → Milchprodukte.
  {
    category: 'Milchprodukte',
    keywords: [
      'grillkaese',
      'grillkaesemix',
      'halloumi',
      'milchreis',
      'grilltaler',
      'reibekaese',
      'der grosse bauer',
      'protein pudding',
      'milchpudding',
      'sahnepudding',
      'griespudding',
      'zott monte',
      'monte drink',
      'monte maxi',
    ],
  },
  // Pesto/Pasta-Sauce/Knorr Fix/Barilla gehören in die Trockenware.
  // Datenqualität #4: + (Imker-)Honig (NIE bare 'honig' → Honigmelone bleibt Obst).
  {
    category: 'Trockenware',
    keywords: [
      'pesto',
      'barilla',
      'knorr fix',
      'pastasauce',
      'pasta sauce',
      'sugo',
      'passata',
      'kretischer honig',
      'bienenhonig',
      'bluetenhonig',
      'waldhonig',
      'akazienhonig',
      'imkerhonig',
    ],
  },
  // Gummi-/Lakritz-Süßwaren (z. B. Nimm 2 Lachgummi) sind Snacks/Süßes.
  // Datenqualität #4: + Götterspeise, Bueno/Knoppers (Riegel) → Snacks/Süßes.
  {
    category: 'Snacks/Süßes',
    keywords: [
      'lachgummi',
      'weingummi',
      'fruchtgummi',
      'nimm 2',
      'nimm2',
      'lakritz',
      'goetterspeise',
      'bueno',
      'knoppers',
    ],
  },
  // Falafel/Gemüsebällchen sind Fertiggericht (Konserven), nie frisches Gemüse.
  // Datenqualität #4: + Wachs-/Brechbohnen (Konserve) → Konserven.
  {
    category: 'Konserven',
    keywords: [
      'falafel',
      'gemuesebaellchen',
      'gemuesebratlinge',
      'gemueselaibchen',
      'wachsbrechbohnen',
      'brechbohnen',
      'wachsbohnen',
    ],
  },
  // Grill-/Bratwurst-Spezialitäten → Fleisch. Bewusst KEIN bare 'griller'
  // (Grillgerät), nur die eindeutigen Wurst-Produktnamen.
  { category: 'Fleisch', keywords: ['deutschland-griller', 'deutschland griller'] },
  // Fisch-Fertiggerichte, die oft als Sonstiges hängenbleiben.
  { category: 'Fisch', keywords: ['kibbeling', 'schlemmerfilet'] },
  // Tiefkühl-Mini-Pizza (Wagner Piccolinis) → Tiefkühl.
  { category: 'Tiefkühl', keywords: ['piccolini'] },
  // Backwaren: Pita-Taschen, Knäckebrot (Wasa & Co.) → Backwaren. Bewusst KEIN
  // bare 'pita' (→ "Pitaya"/Drachenfrucht) und KEIN bare 'wasa' (→ "Wasabi").
  {
    category: 'Backwaren',
    keywords: ['pita-taschen', 'pitataschen', 'pita taschen', 'pitabrot', 'knaeckebrot', 'knaecke'],
  },
  // Frisches Obst/Gemüse, das oft als Sonstiges hängenbleibt.
  { category: 'Obst/Gemüse', keywords: ['spargel', 'kiwi'] },
];

/**
 * Korrigiert eine offensichtlich falsche einfache Kategorie anhand des
 * Produktnamens (+ Marke). Greift nur bei den hochpräzisen Reparatur-Stichwörtern
 * oben; sonst bleibt die übergebene Kategorie unverändert. Getränke-/Alkohol-/
 * Snack-Signale schlagen die Obst/Gemüse-Reparatur, damit z. B. eine
 * "Kiwi-Apfel-Schorle" ein Getränk bleibt und nicht zu Obst/Gemüse wird.
 */
export function repairSimpleOfferCategory(input: {
  name?: string;
  brand?: string;
  category: string;
}): string {
  const current = input.category;
  const source = normalizeCategorySource(`${input.name ?? ''} ${input.brand ?? ''}`);
  if (!source) {
    return current;
  }
  const tokens = source.split(' ').filter(Boolean);
  const looksDrinkOrAlcohol =
    isExplicitNonAlcoholic(source) ||
    matchesAlcohol(source) ||
    hasAlcoholByVolume(source) ||
    endsWithDrinkSuffix(tokens) ||
    matchesSnackProduct(source, tokens);

  for (const rule of SIMPLE_CATEGORY_REPAIR_RULES) {
    // Eine Frischeprodukt-Reparatur darf ein klares Getränk/Snack nicht umdeuten.
    if (rule.category === 'Obst/Gemüse' && looksDrinkOrAlcohol) {
      continue;
    }
    if (rule.keywords.some((keyword) => hasKeyword(source, keyword))) {
      return rule.category;
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// Vertrauenswürdige Quellabteilung → finale Kategorie (Task P3)
// ---------------------------------------------------------------------------
//
// Die Händler-eigene Roh-Abteilung (sourceCategoryRaw/sourceDepartmentRaw) ist
// eine HARTE, vertrauenswürdige Quelle für die finale Hauptkategorie und muss
// gegen schwache Produktnamen-, Keyword-, Cache- und Modell-Signale gewinnen:
// "Iglo Tagliatelle Pilzpfanne" in der Abteilung Tiefkühl ist Tiefkühl (nicht
// Trockenware, nur weil der Name "Tagliatelle" enthält); "… Trollinger
// Qualitätswein" in "Wein und Spirituosen" ist Alkohol (nicht Snacks).
//
// Bewusst NUR EINDEUTIGE Abteilungen (Abteilungs-Vokabular, KEINE Produkt-/
// Marken-Allowlist). Neutrale Abteilungen (Angebote, Bonus-Aktionen,
// Markenartikel, Filialangebote) und gemischte Abteilungen erzwingen NICHTS
// (→ null), damit weitere Signale entscheiden. Non-Food-Abteilungen erzwingen
// ebenfalls keine (Food-)Kategorie — die besitzt der Non-Food-Gate.

// Eindeutige Non-Food-Abteilungswörter: eine solche Abteilung erzwingt nie eine
// Food-Kategorie (gespiegelt zur Veto-Liste im Strict-Food-Filter).
const NON_FOOD_DEPARTMENT_VETO = [
  'drogerie',
  'haushalt',
  'koerperpflege',
  'kosmetik',
  'hygiene',
  'tierbedarf',
  'tiernahrung',
  'garten',
  'technik',
  'elektro',
  'textil',
  'bekleidung',
  'spielware',
  'non-food',
  'nonfood',
  'freizeit',
] as const;

// Eindeutige, vertrauenswürdige FOOD-Abteilungen → finale einfache Kategorie.
// Reihenfolge = Priorität (spezifisch vor allgemein).
const TRUSTED_SOURCE_DEPARTMENT_RULES: {
  category: SimpleOfferCategory;
  keywords: string[];
  /** Wörter, die dieselbe Abteilung als GEMISCHT ausweisen: steht eines davon im
   *  Abteilungstext, deckt die Abteilung mehr als eine Kategorie ab und darf die
   *  Hauptkategorie nicht mehr erzwingen (siehe Kontrakt oben). */
  mixedMarkers: string[];
}[] = [
  {
    category: 'Tiefkühl',
    keywords: ['tiefkuehl', 'tiefkuhl', 'tiefgekuehlt', 'frozen', 'gefroren'],
    // "Gekühlte & tiefgekühlte Produkte" ist ein kombinierter Gang: Frische UND
    // TK. Er darf nichts erzwingen, sonst wird jeder Frischartikel Tiefkühl.
    mixedMarkers: ['gekuehlt', 'gekuhlt', 'frische', 'frischen', 'chilled'],
  },
  {
    category: 'Alkohol',
    // NUR Abteilungsvokabular. 'aperitif'/'longdrink' sind ANLASS-Wörter aus der
    // Werbung, keine Abteilungen — der reale Kaufland-Gang "Zeit für einen
    // Aperitif" enthielt Physalis und Passionsfrucht und machte daraus Alkohol.
    keywords: ['spirituosen', 'wein', 'bier', 'sekt', 'schnaps'],
    // Kombinierte Getränkegänge wie "Getränke, Spirituosen" führen alkoholfreie
    // UND alkoholische Ware. Dort stempelte die Regel Cola, Eistee, Energy-
    // Drinks und Mineralwasser als Alkohol.
    mixedMarkers: [
      'alkoholfrei',
      'getraenke',
      'getranke',
      'softdrink',
      'softdrinks',
      'limonade',
      'saefte',
      'safte',
      'wasser',
    ],
  },
  {
    category: 'Obst/Gemüse',
    keywords: ['obst', 'gemuese', 'gemuse'],
    mixedMarkers: [],
  },
];

/**
 * Leitet die finale einfache Kategorie aus einer VERTRAUENSWÜRDIGEN, eindeutigen
 * Quellabteilung ab — oder `null`, wenn die Abteilung neutral, gemischt, leer,
 * Non-Food oder nicht eindeutig zuordenbar ist (dann entscheiden andere Signale).
 * Pure; nur Abteilungs-Vokabular, keine Produktnamen.
 */
export function categoryFromTrustedSourceDepartment(
  rawDepartmentText: string | undefined,
): SimpleOfferCategory | null {
  const raw = normalizeCategorySource(rawDepartmentText ?? '');
  if (!raw.trim()) {
    return null;
  }
  // Non-Food-Abteilung erzwingt nie eine Food-Kategorie.
  if (NON_FOOD_DEPARTMENT_VETO.some((keyword) => raw.includes(keyword))) {
    return null;
  }
  const tokens = raw.split(' ').filter(Boolean);
  for (const rule of TRUSTED_SOURCE_DEPARTMENT_RULES) {
    // Gemischte Abteilung → erzwingt NICHTS (Kontrakt oben). Ersetzt den
    // früheren Sonderfall, der nur "alkoholfrei" kannte: dieselbe Falle trat
    // ebenso bei "Getränke, Spirituosen" und "Gekühlte & tiefgekühlte Produkte"
    // auf, nur ohne eigenen Sonderfall.
    if (rule.mixedMarkers.some((marker) => raw.includes(marker))) {
      continue;
    }
    if (rule.keywords.some((keyword) => hasKeyword(raw, keyword) || tokens.includes(keyword))) {
      return rule.category;
    }
  }
  return null;
}

/** Inverses Mapping der einfachen Kategorie auf die kanonische Hauptkategorie —
 *  nur für die vertrauenswürdigen Quellabteilungen, damit ein späterer Cache-/
 *  Python-Pass die feste Quellkategorie nicht über canonicalCategory.main
 *  zurückdrehen kann. */
export function simpleToCanonicalMain(category: SimpleOfferCategory): string | null {
  for (const [main, simple] of Object.entries(CANONICAL_MAIN_TO_SIMPLE)) {
    if (simple === category) {
      return main;
    }
  }
  return null;
}

// Mapping der reichhaltigen Python-Hauptkategorien (offers_categorizer /
// aichef_offers taxonomy.yaml) auf die einfache Backend-/Admin-Taxonomie.
// WICHTIG: Die KI/Regel-Pipeline (Python) bestimmt main/sub — wir übernehmen
// das nur, statt es zu verwerfen. Nicht gemappte oder unsichere Fälle bleiben
// bewusst offen (null → Aufrufer behält "Sonstiges"/Review).
const CANONICAL_MAIN_TO_SIMPLE: Record<string, SimpleOfferCategory> = {
  'Fleisch & Wurst': 'Fleisch',
  'Fisch & Meeresfrüchte': 'Fisch',
  'Milchprodukte & Eier': 'Milchprodukte',
  'Obst & Gemüse': 'Obst/Gemüse',
  Backwaren: 'Backwaren',
  'Getränke alkoholfrei': 'Getränke Alkoholfrei',
  Alkohol: 'Alkohol',
  'Süßwaren & Snacks': 'Snacks/Süßes',
  Grundnahrungsmittel: 'Trockenware',
  Tiefkühl: 'Tiefkühl',
  'Konserven & Fertiggerichte': 'Konserven',
  'Gewürze/Saucen/Aufstriche': 'Trockenware',
};

export interface CanonicalCategoryLike {
  main?: string | null;
  sub?: string | null;
  isNonFood?: boolean | null;
  confidence?: number | null;
}

/**
 * Übersetzt eine kanonische Kategorie (aus der Python-Pipeline) in die einfache
 * Backend-Kategorie. Gibt `null` zurück, wenn die Klassifizierung Non-Food,
 * unsicher (Confidence unter `minConfidence`) oder nicht eindeutig mappbar ist —
 * der Aufrufer behält dann seine bisherige (ehrliche) Kategorie/Review.
 */
export function mapCanonicalToSimpleCategory(
  canonical: CanonicalCategoryLike | null | undefined,
  minConfidence = 0.7,
): SimpleOfferCategory | null {
  if (!canonical || canonical.isNonFood) {
    return null;
  }

  const confidence = Number(canonical.confidence);
  if (!Number.isFinite(confidence) || confidence < minConfidence) {
    return null;
  }

  const main = String(canonical.main ?? '').trim().normalize('NFC');
  const sub = String(canonical.sub ?? '').trim().normalize('NFC');
  if (!main) {
    return null;
  }

  // Sub-genaue Verfeinerungen, bevor wir auf die Hauptkategorie zurückfallen.
  if (main === 'Milchprodukte & Eier' && sub === 'Milchalternativen') {
    return 'Milchalternativen';
  }
  if (main === 'Feinkost & Kühlung') {
    // Gemischtes Kühlregal: nur Tofu/Veggie eindeutig, sonst ehrlich offen.
    if (sub === 'Tofu & Veggie') {
      return 'Milchalternativen';
    }
    return null;
  }

  return CANONICAL_MAIN_TO_SIMPLE[main] ?? null;
}
