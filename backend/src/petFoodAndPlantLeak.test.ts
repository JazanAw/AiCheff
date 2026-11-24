import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { classifyFoodDecision } from './foodDecision';

// Non-Food im sichtbaren Feed (Lauf 2026-08-17). Zwei Leckstellen, beide
// verursacht durch AUFGEZAEHLTE Wortlisten statt Klassenregeln:
//
//   1. "Sheba Katzennassfutter Filets" stand als Grundnahrungsmittel live.
//      Die Non-Food-Liste kannte 'hundenassfutter', aber nicht
//      'katzennassfutter' — eine Asymmetrie, die bei handgepflegten
//      Komposita zwangslaeufig entsteht. "Felix Katzennahrung" wurde im selben
//      Lauf korrekt gefiltert, weil dieses Kompositum zufaellig auf der Liste
//      stand.
//   2. "Pflanzenauswahl im Pottburri" (lebende Pflanzen) stand als Gemuese
//      live. LIVING_PLANT_SUFFIX_PATTERN verlangt "pflanze(n)" am Wortende;
//      "Pflanzenauswahl" ist EIN Token und lief durch.
//
// Produktnamen sind Reproduktions-Fixtures aus dem echten Lauf.
const base = {
  id: 'x',
  normalizedName: '',
  storeChain: 'Kaufland',
  category: 'Sonstiges',
  price: 2.99,
  currency: 'EUR',
  unit: 'stk',
  validityStart: '2026-08-17',
  validityEnd: '2026-08-22',
  sourceUrl: '',
  tags: [],
  createdAt: '2026-08-17T00:00:00.000Z',
} as unknown as Offer;

const offer = (name: string, extra: Partial<Offer> = {}): Offer =>
  ({ ...base, ...extra, name }) as Offer;

describe('Tiernahrung ist Non-Food — als Klasse, nicht als Wortliste', () => {
  it('der echte Leck-Fall aus dem Lauf', () => {
    expect(
      classifyFoodDecision(
        offer('Sheba Katzennassfutter Filets', { sourceCategoryRaw: 'Bonus-Aktionen' }),
      ),
    ).toBe('confirmed_non_food');
  });

  it.each([
    'Katzennassfutter',
    'Katzentrockenfutter',
    'Welpenfutter',
    'Nagerfutter',
    'Kaninchennahrung',
    'Hunde-Leckerli',
    'Wellensittichfutter',
    'Hamsterfutter',
  ])('%s ist confirmed_non_food', (name) => {
    expect(classifyFoodDecision(offer(name))).toBe('confirmed_non_food');
  });

  // Der Tier-Praefix ist zwingend — sonst wuerde "Grundnahrungsmittel" selbst
  // ueber das Suffix "nahrung" zu Non-Food.
  it.each([
    ['Grundnahrungsmittel Sonderposten'],
    ['Katzenzungen Schokolade'],
    ['Fischfilet'],
    ['Vogelbeere Likör'],
  ])('%s bleibt Lebensmittel', (name) => {
    expect(classifyFoodDecision(offer(name))).not.toBe('confirmed_non_food');
  });
});

describe('Lebende Pflanzen als Gebinde sind Non-Food', () => {
  it('der echte Leck-Fall aus dem Lauf', () => {
    expect(
      classifyFoodDecision(
        offer('Pflanzenauswahl im Pottburri', { sourceCategoryRaw: 'Obst, Gemüse, Pflanzen' }),
      ),
    ).toBe('confirmed_non_food');
  });

  it.each(['Pflanzensortiment', 'Pflanzenschale', 'Pflanzentrio', 'Pflanzenkorb'])(
    '%s ist confirmed_non_food',
    (name) => {
      expect(classifyFoodDecision(offer(name))).toBe('confirmed_non_food');
    },
  );

  // Gegenprobe: "Pflanzen-" als ZUTAT muss Lebensmittel bleiben. Genau deshalb
  // greift die Regel nur bei Gebinde-Woertern.
  it.each([
    ['Pflanzenöl'],
    ['Pflanzendrink Hafer'],
    ['Pflanzenmargarine'],
    ['Rama Cremefine 100% Pflanzlich'],
    ['Blumenkohl'],
    ['Sonnenblumenöl'],
  ])('%s bleibt Lebensmittel', (name) => {
    expect(classifyFoodDecision(offer(name))).not.toBe('confirmed_non_food');
  });
});
