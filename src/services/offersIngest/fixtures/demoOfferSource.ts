export interface DemoFixture {
  sourceUrl: string;
  sourceLabel: string;
  storeChain: string;
  region: string;
  postalCode: string;
  latitude: number;
  longitude: number;
  content: string;
}

interface MarketSeed {
  storeChain: string;
  region: string;
  postalCode: string;
  latitude: number;
  longitude: number;
  priceFactor: number;
}

interface CatalogItem {
  name: string;
  category: string;
  unit: string;
  price: number;
  basePrice?: number;
  baseUnit?: string;
  tags: string[];
}

const marketSeeds: MarketSeed[] = [
  {
    storeChain: 'Aldi',
    region: '80 Muenchen',
    postalCode: '80331',
    latitude: 48.137154,
    longitude: 11.576124,
    priceFactor: 0.97,
  },
  {
    storeChain: 'Rewe',
    region: '50 Koeln',
    postalCode: '50667',
    latitude: 50.941278,
    longitude: 6.958281,
    priceFactor: 1.04,
  },
  {
    storeChain: 'Lidl',
    region: '10 Berlin',
    postalCode: '10115',
    latitude: 52.520008,
    longitude: 13.404954,
    priceFactor: 0.95,
  },
  {
    storeChain: 'Edeka',
    region: '20 Hamburg',
    postalCode: '20095',
    latitude: 53.551086,
    longitude: 9.993682,
    priceFactor: 1.06,
  },
  {
    storeChain: 'Kaufland',
    region: '04 Leipzig',
    postalCode: '04109',
    latitude: 51.339695,
    longitude: 12.373075,
    priceFactor: 0.94,
  },
  {
    storeChain: 'Penny',
    region: '60 Frankfurt',
    postalCode: '60311',
    latitude: 50.110924,
    longitude: 8.682127,
    priceFactor: 0.96,
  },
  {
    storeChain: 'Netto',
    region: '30 Hannover',
    postalCode: '30159',
    latitude: 52.375892,
    longitude: 9.73201,
    priceFactor: 0.93,
  },
  {
    storeChain: 'Norma',
    region: '90 Nuernberg',
    postalCode: '90403',
    latitude: 49.45203,
    longitude: 11.07675,
    priceFactor: 0.92,
  },
];

const catalog: CatalogItem[] = [
  { name: 'Bio Bananen', category: 'Obst/Gemuese', unit: 'kg', price: 1.69, basePrice: 1.69, baseUnit: 'kg', tags: ['vegan', 'bio'] },
  { name: 'Aepfel Mix', category: 'Obst/Gemuese', unit: 'kg', price: 2.39, basePrice: 2.39, baseUnit: 'kg', tags: ['vegan'] },
  { name: 'Birnen', category: 'Obst/Gemuese', unit: 'kg', price: 2.59, basePrice: 2.59, baseUnit: 'kg', tags: ['vegan'] },
  { name: 'Paprika Mix', category: 'Obst/Gemuese', unit: '500g', price: 1.89, basePrice: 3.78, baseUnit: 'kg', tags: ['vegan'] },
  { name: 'Cherrytomaten', category: 'Obst/Gemuese', unit: '500g', price: 2.19, basePrice: 4.38, baseUnit: 'kg', tags: ['vegan'] },
  { name: 'Brokkoli', category: 'Obst/Gemuese', unit: '500g', price: 1.69, basePrice: 3.38, baseUnit: 'kg', tags: ['vegan'] },
  { name: 'Kartoffeln', category: 'Obst/Gemuese', unit: '2kg', price: 2.99, basePrice: 1.50, baseUnit: 'kg', tags: ['vegan'] },
  { name: 'Zwiebeln', category: 'Obst/Gemuese', unit: '1kg', price: 1.39, basePrice: 1.39, baseUnit: 'kg', tags: ['vegan'] },
  { name: 'Haehnchenbrust', category: 'Fleisch', unit: '500g', price: 4.79, basePrice: 9.58, baseUnit: 'kg', tags: ['halal-option'] },
  { name: 'Rinderhack', category: 'Fleisch', unit: '500g', price: 4.49, basePrice: 8.98, baseUnit: 'kg', tags: ['protein'] },
  { name: 'Putenbrust', category: 'Fleisch', unit: '400g', price: 4.19, basePrice: 10.48, baseUnit: 'kg', tags: ['protein'] },
  { name: 'Lachsfilet', category: 'Fisch', unit: '300g', price: 5.89, basePrice: 19.63, baseUnit: 'kg', tags: ['omega3'] },
  { name: 'Thunfisch Dose', category: 'Konserven', unit: '185g', price: 1.39, basePrice: 7.51, baseUnit: 'kg', tags: ['protein', 'halal'] },
  { name: 'Eier Bodenhaltung', category: 'Milchprodukte', unit: '10Stk', price: 2.29, tags: ['vegetarisch'] },
  { name: 'Frische Vollmilch', category: 'Milchprodukte', unit: '1L', price: 1.19, basePrice: 1.19, baseUnit: 'L', tags: ['vegetarisch'] },
  { name: 'Joghurt mild', category: 'Milchprodukte', unit: '500g', price: 0.99, basePrice: 1.98, baseUnit: 'kg', tags: ['vegetarisch'] },
  { name: 'Gouda jung', category: 'Milchprodukte', unit: '400g', price: 2.49, basePrice: 6.23, baseUnit: 'kg', tags: ['vegetarisch'] },
  { name: 'Mozzarella', category: 'Milchprodukte', unit: '125g', price: 0.99, basePrice: 7.92, baseUnit: 'kg', tags: ['vegetarisch'] },
  { name: 'Haferdrink Natur', category: 'Milchalternativen', unit: '1L', price: 1.29, basePrice: 1.29, baseUnit: 'L', tags: ['vegan', 'laktosefrei'] },
  { name: 'Sojajoghurt', category: 'Milchalternativen', unit: '400g', price: 1.49, basePrice: 3.73, baseUnit: 'kg', tags: ['vegan'] },
  { name: 'Tofu natur', category: 'Milchalternativen', unit: '400g', price: 2.29, basePrice: 5.73, baseUnit: 'kg', tags: ['vegan', 'halal'] },
  { name: 'Basmatireis', category: 'Trockenware', unit: '1kg', price: 2.79, basePrice: 2.79, baseUnit: 'kg', tags: ['vegan', 'halal'] },
  { name: 'Vollkornnudeln', category: 'Trockenware', unit: '500g', price: 1.19, basePrice: 2.38, baseUnit: 'kg', tags: ['vegan'] },
  { name: 'Rote Linsen', category: 'Trockenware', unit: '500g', price: 1.79, basePrice: 3.58, baseUnit: 'kg', tags: ['vegan', 'halal'] },
  { name: 'Kichererbsen Dose', category: 'Konserven', unit: '400g', price: 0.99, basePrice: 2.48, baseUnit: 'kg', tags: ['vegan', 'halal'] },
  { name: 'Passierte Tomaten', category: 'Konserven', unit: '500g', price: 0.89, basePrice: 1.78, baseUnit: 'kg', tags: ['vegan'] },
  { name: 'Tomatenmark', category: 'Konserven', unit: '200g', price: 0.59, basePrice: 2.95, baseUnit: 'kg', tags: ['vegan'] },
  { name: 'Olivenoel', category: 'Trockenware', unit: '750ml', price: 4.99, basePrice: 6.65, baseUnit: 'L', tags: ['vegan'] },
  { name: 'Hummus Classic', category: 'Milchalternativen', unit: '200g', price: 1.49, basePrice: 7.45, baseUnit: 'kg', tags: ['vegan', 'halal'] },
  { name: 'Fladenbrot', category: 'Backwaren', unit: '400g', price: 1.69, basePrice: 4.23, baseUnit: 'kg', tags: ['vegan', 'halal'] },
];

function formatGermanDate(value: Date): string {
  const day = String(value.getUTCDate()).padStart(2, '0');
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const year = value.getUTCFullYear();
  return `${day}.${month}.${year}`;
}

function getCurrentWeekRange(): { start: string; end: string } {
  const today = new Date();
  const utcDate = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  const dayOfWeek = utcDate.getUTCDay();
  const diffToMonday = (dayOfWeek + 6) % 7;

  const monday = new Date(utcDate);
  monday.setUTCDate(utcDate.getUTCDate() - diffToMonday);

  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);

  return {
    start: formatGermanDate(monday),
    end: formatGermanDate(sunday),
  };
}

function formatPrice(value: number): string {
  return value.toFixed(2).replace('.', ',');
}

function toLine(
  item: CatalogItem,
  priceFactor: number,
  start: string,
  end: string,
  lineIndex: number,
): string {
  const factor = priceFactor + ((lineIndex % 5) - 2) * 0.01;
  const price = Math.max(0.39, item.price * factor);
  const basePrice = item.basePrice ? Math.max(0.39, item.basePrice * factor) : null;

  const segments: string[] = [
    `- ${item.name}`,
    `${formatPrice(price)} EUR/${item.unit}`,
    item.category,
    `${start}-${end}`,
  ];

  if (basePrice && item.baseUnit) {
    segments.push(`grundpreis ${formatPrice(basePrice)} EUR/${item.baseUnit}`);
  }

  if (item.tags.length > 0) {
    segments.push(`tags ${item.tags.join(',')}`);
  }

  return segments.join(' | ');
}

function slug(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '-');
}

function toFixture(seed: MarketSeed): DemoFixture {
  const weekRange = getCurrentWeekRange();
  const lines = catalog.map((item, lineIndex) =>
    toLine(item, seed.priceFactor, weekRange.start, weekRange.end, lineIndex),
  );

  return {
    sourceUrl: `https://example.org/${slug(seed.storeChain)}-wochenangebote`,
    sourceLabel: `${seed.storeChain} Wochenangebote`,
    storeChain: seed.storeChain,
    region: seed.region,
    postalCode: seed.postalCode,
    latitude: seed.latitude,
    longitude: seed.longitude,
    content: [`KW Angebote ${seed.storeChain}`, ...lines].join('\n'),
  };
}

export const demoOfferFixtures: DemoFixture[] = marketSeeds.map((seed) =>
  toFixture(seed),
);
