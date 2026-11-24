import { LocationFilter, Offer } from '../types/models';

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function normalizeText(input: string): string {
  const repaired = input
    // Repair common UTF-8/Latin-1 mojibake sequences (e.g. "KÃ¼che").
    .replace(/\u00c3\u00a4/g, '\u00e4')
    .replace(/\u00c3\u0084/g, '\u00c4')
    .replace(/\u00c3\u00b6/g, '\u00f6')
    .replace(/\u00c3\u0096/g, '\u00d6')
    .replace(/\u00c3\u00bc/g, '\u00fc')
    .replace(/\u00c3\u009c/g, '\u00dc')
    .replace(/\u00c3\u009f/g, '\u00df');

  const transliterated = repaired
    .replace(/ä/g, 'ae')
    .replace(/Ä/g, 'Ae')
    .replace(/ö/g, 'oe')
    .replace(/Ö/g, 'Oe')
    .replace(/ü/g, 'ue')
    .replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss');

  return transliterated
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

const foodCategoryHints = [
  'obst',
  'gemuse',
  'fleisch',
  'fisch',
  'milch',
  'milchalternativen',
  'backwaren',
  'trockenware',
  'konserven',
  'getranke',
  'getraenke',
  'alkoholfrei',
  'alkohol',
  'tiefkuehl',
  'tiefkuhl',
  'snacks',
  'suess',
  'suss',
  'lebensmittel',
  'eier',
  'feinkost',
  'saucen',
  'sauce',
  'aufstrich',
  'gewuerze',
  'gewurze',
  'oel',
  'ol',
];

const foodKeywordHints = [
  'brot',
  'banane',
  'apfel',
  'birne',
  'tomate',
  'kartoffel',
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
  'reis',
  'nudel',
  'linsen',
  'kichererbsen',
  'milch',
  'joghurt',
  'kaese',
  'milchreis',
  'pudding',
  'not mlk',
  'tofu',
  'hummus',
  'wurst',
  'weisswurst',
  'bratwurst',
  'schinken',
  'speck',
  'salami',
  'steak',
  'fisch',
  'lachs',
  'thunfisch',
  'pizza',
  'sauce',
  'saucen',
  'aioli',
  'ketchup',
  'senf',
  'mayonnaise',
  'pesto',
  'dressing',
  'dip',
  'berliner',
  'superberliner',
  'ruehrkuchen',
  'ruhrkuchen',
  'magdalenas',
  'culinesse',
  'olivenoel',
  'sonnenblumenoel',
  'pflanzenoel',
  'rapsoel',
  'weisswein',
  'weissburgunder',
  'gewurztraminer',
  'gewuerztraminer',
  'riesling',
  'grauburgunder',
  'chardonnay',
  'sauvignon',
  'alkoholfrei',
  'krombacher',
  'likor',
  'likoer',
  'sanddornlikor',
  'champagner',
  'pommery',
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
  'naturelle',
  'kaffee',
  'tee',
  'saft',
  'cola',
  'wasser',
];

const nonFoodKeywordHints = [
  'wasserkocher',
  'kaffeemaschine',
  'kaffeepadmaschine',
  'espressomaschine',
  'kuechenmaschine',
  'kuchenmaschine',
  'kuechenwaage',
  'kuchenwaage',
  'toaster',
  'motoroel',
  'motorol',
  'motor oel',
  'motor ol',
  'motorenoel',
  'motorenol',
  '5w30',
  '5w-30',
  'liqui moly',
  'scheibenfrostschutz',
  'shampoo',
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
  'bodymilk',
  'body milk',
  'body mist',
  'bodymist',
  'deo',
  'deodorant',
  'deospray',
  'zahnpasta',
  'zahncreme',
  'zahnpflege',
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
  'weichspuler',
  'kuechentuch',
  'kuchentuch',
  'kuechentuecher',
  'kuchentucher',
  'kuchenpapier',
  'kuechenpapier',
  'kuechenrolle',
  'reiniger',
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
  'putzmittel',
  'toilettenpapier',
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
  'windeln',
  'batterie',
  'akku',
  'gluhbirne',
  'kleidung',
  'schuhe',
  'reisekoffer',
  'koffer',
  'trolley',
  'bohrmaschine',
  'werkzeug',
  'moebel',
  'kissen',
  'bettwasche',
  'kosmetik',
  'koerperpflege',
  'korperpflege',
  'lacura',
  'dove',
  'garnier',
  'loreal',
  'gesichtspflege',
  'duschcreme',
  'seife',
  'mizellen-reinigungswasser',
  'mizellen reinigungswasser',
  'reinigungswasser',
  'tuchmaske',
  'makeup',
  'haarspray',
  'nagellack',
  'spielzeug',
  'crivit',
  'poolsitz',
  'wasserhaengematte',
  'wasserhangematte',
  'wasserspielmatte',
  'wassermattensortiment',
  'springmatte',
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
  'katzensnack',
  'katzen-snack',
  'katzen-snacks',
  'katzensnacks',
  'klumpstreu',
  'ultra-klumpstreu',
  'tierfutter',
  'vitakraft',
  'purina',
  'pedigree',
  'beneful',
  'josi cat',
  'josi dog',
  'josi',
  'whiskas',
  'katzenstreu',
  'hygienestreu',
  'catsan',
  'reinigungsmittel',
  'febreze',
  'lufterfrischer',
  'luftentfeuchter',
  'nachfueller',
  'nachfuller',
  'nachfuellbeutel',
  'nachfullbeutel',
  'nachfuellflakon',
  'nachfullflakon',
  'kerze',
  'kerzen',
  'hexenkerze',
  'hexen-kerze',
  'hexenkerzen',
  'samereien',
  'saemereien',
  'saatgut',
  'zwiebelpflanzen',
  'blumenzwiebeln',
  'pflanzenerde',
  'kubelpflanzenerde',
  'kuebelpflanzenerde',
  'torffreie erde',
  'torffrei',
  'gemuesepflanze',
  'gemuesepflanzen',
  'tomaten-ampel',
  'tomatenampel',
  'salatpflanzen',
  'mediterrane pflanzen',
  'orchidee',
  'hortensie',
  'bornholm-margerite',
  'bornholm margerite',
  'margerite',
  'margeritenbusch',
  'lavendel',
  'rispenhortensie',
  'katzengras',
  'blumentopf',
  'duenger',
  'dunger',
  'universaldunger',
  'eisrose',
  'glasvase',
  'vase',
  'geschenkset',
  'badefee',
  'tesori d oriente',
  'tesori doriente',
  'got2b',
  'strand matte',
  'strand-matte',
  'strandmatte',
  'nudelmaschine',
  'handstaubsauger',
  'staubsauger',
  'silvercrest',
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
  'fahrradtasche',
  'thermoglaser',
  'thermoglaeser',
  'trinkglaser',
  'trinkglaeser',
  'reiskocher',
  'pizza-ofen',
  'pizzaofen',
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordMatches(source: string, keywordRaw: string): boolean {
  const keyword = normalizeText(keywordRaw);
  if (!keyword) {
    return false;
  }

  if (keyword.length <= 3 && /^[a-z0-9]+$/.test(keyword)) {
    return new RegExp(`(^|[\\s-])${escapeRegExp(keyword)}($|[\\s-])`).test(source);
  }

  return source.includes(keyword);
}

function containsKeywordHint(source: string, keywords: string[]): boolean {
  return keywords.some((keyword) => keywordMatches(source, keyword));
}

export function parseDateInput(value: string): string | null {
  const trimmed = value.trim();
  const germanMatch = trimmed.match(
    /^(?<day>\d{2})\.(?<month>\d{2})\.(?<year>\d{4})$/,
  );
  if (germanMatch?.groups) {
    const normalized = `${germanMatch.groups.year}-${germanMatch.groups.month}-${germanMatch.groups.day}T00:00:00.000Z`;
    const date = new Date(normalized);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }

  const isoCandidate = new Date(trimmed);
  if (!Number.isNaN(isoCandidate.valueOf())) {
    return isoCandidate.toISOString();
  }

  return null;
}

export function isOfferInCurrentWeek(offer: Offer, now = new Date()): boolean {
  const start = new Date(offer.validityStart);
  const end = new Date(offer.validityEnd);

  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) {
    return false;
  }

  const nowUtcDay = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const startUtcDay = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate(),
  );
  const endUtcDay = Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate(),
  );

  return startUtcDay <= nowUtcDay && nowUtcDay <= endUtcDay;
}

export function getDistanceKm(
  fromLatitude: number,
  fromLongitude: number,
  toLatitude: number,
  toLongitude: number,
): number {
  const earthRadiusKm = 6371;
  const deltaLat = toRadians(toLatitude - fromLatitude);
  const deltaLon = toRadians(toLongitude - fromLongitude);
  const lat1 = toRadians(fromLatitude);
  const lat2 = toRadians(toLatitude);

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.sin(deltaLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

export function isOfferMatchingLocation(
  offer: Offer,
  locationFilter: LocationFilter,
): boolean {
  if (locationFilter.mode === 'none') {
    return true;
  }

  if (offer.sourceScope === 'national') {
    return true;
  }

  const hasLocationMetadata =
    Boolean(offer.postalCode || offer.region) ||
    (offer.latitude !== undefined && offer.longitude !== undefined);
  if (!hasLocationMetadata) {
    return true;
  }

  if (locationFilter.mode === 'postalCode' && locationFilter.postalCode) {
    if (offer.postalCode && offer.postalCode.startsWith(locationFilter.postalCode.slice(0, 2))) {
      return true;
    }
    if (offer.region) {
      const normalizedRegion = normalizeText(offer.region);
      return normalizedRegion.includes(locationFilter.postalCode.slice(0, 2));
    }
    return false;
  }

  if (
    locationFilter.mode === 'gps' &&
    locationFilter.latitude !== null &&
    locationFilter.longitude !== null &&
    offer.latitude !== undefined &&
    offer.longitude !== undefined
  ) {
    const distanceKm = getDistanceKm(
      locationFilter.latitude,
      locationFilter.longitude,
      offer.latitude,
      offer.longitude,
    );
    return distanceKm <= locationFilter.radiusKm;
  }

  return true;
}

export function isLikelyFoodOffer(offer: Offer): boolean {
  const category = normalizeText(offer.category);
  const source = normalizeText(
    `${offer.name} ${offer.category} ${offer.tags.join(' ')}`,
  );
  const units = normalizeText(`${offer.unit} ${offer.baseUnit ?? ''}`);

  if (containsKeywordHint(source, nonFoodKeywordHints)) {
    return false;
  }

  if (containsKeywordHint(category, foodCategoryHints)) {
    return true;
  }

  if (containsKeywordHint(source, foodKeywordHints)) {
    return true;
  }

  if (/\b(kg|g|mg|l|ml|cl)\b/.test(units)) {
    return true;
  }

  return false;
}

function offerProductKey(offer: Offer): string {
  return `${offer.normalizedName}|${offer.unit}|${offer.validityStart}|${offer.validityEnd}`;
}

export function dedupeOffersByBestPrice(offers: Offer[]): Offer[] {
  const bestByProduct = new Map<string, Offer>();

  for (const offer of offers) {
    const key = offerProductKey(offer);
    const existing = bestByProduct.get(key);

    if (!existing) {
      bestByProduct.set(key, offer);
      continue;
    }

    if (offer.price < existing.price) {
      bestByProduct.set(key, offer);
      continue;
    }

    if (offer.price === existing.price) {
      const preferByStoreName =
        offer.storeChain.localeCompare(existing.storeChain, 'de') < 0;
      if (preferByStoreName) {
        bestByProduct.set(key, offer);
      }
    }
  }

  return [...bestByProduct.values()];
}
