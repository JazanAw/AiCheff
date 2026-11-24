import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  hasStrongFoodSignal,
  hasRuleConfirmedNonFoodSignal,
  isStrictFoodOffer,
  isStrictNonFoodOffer,
} from './offersStrictFoodFilter';
import {
  applyFoodRescuePass,
  classifyFilteredOfferForRescue,
  partitionFilteredOffersForCompleteness,
} from './snapshotFoodRescue';

// Strukturelle Regression für die REWE-Lebensmittelfilterung. ALLE konkreten
// Produktnamen/-zahlen hier sind reine Reproduktions-Fixtures (real beobachtet
// nach einem frischen REWE-Browserimport) — KEINE Produktivliste. Der Fix muss
// generisch über Vokabular/Abteilungs-Signale wirken, nicht über eine Allowlist.

const NOW = new Date('2026-06-10T12:00:00.000Z');

function offer(overrides: Partial<Offer> & { name: string } & Record<string, unknown>): Offer {
  return {
    id: overrides.name,
    normalizedName: overrides.name.toLowerCase(),
    storeChain: 'REWE',
    category: 'Sonstiges',
    price: 1.99,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: '2026-06-08T00:00:00.000Z',
    validityEnd: '2026-06-13T23:59:59.000Z',
    sourceUrl: 'https://www.rewe.de/angebote/nationale-angebote/',
    tags: ['rewe', 'browser-import'],
    createdAt: '2026-06-08T00:00:00.000Z',
    ...overrides,
  } as Offer;
}

// ── ZIEL 1: Food-Erkennung strukturell erweitert ────────────────────────────
describe('REWE — falsch gefilterte Lebensmittel werden als Food erkannt', () => {
  // Nüsse/Erdnüsse, salzige Snacks/Flips, Brot-/Backwaren (Ciabatta/Laugen),
  // essbarer Mais/Grillgemüse, englische Getränkebegriffe (Beer/Lager).
  const foodRepros: Array<[string, string]> = [
    ['REWE Beste Wahl Mini Laugen-Mix', 'Fan-Momente zum Angrillen!'],
    ['REWE Feine Welt Ciabatta Königliche Olive', 'Fan-Momente zum Angrillen!'],
    ['Heineken Lager Beer', 'Fan-Momente zum Angrillen!'],
    ['ja! Erdnuss-Flips', 'Fan-Momente zum Angrillen!'],
    ['ja! Erdnüsse', 'Fan-Momente zum Angrillen!'],
    ["Butcher's Barbecue Grillmais", 'Schnell und einfach'],
  ];

  it.each(foodRepros)('%s trägt ein starkes Food-Signal und wird gerettet', (name, src) => {
    const o = offer({ name, sourceCategoryRaw: src });
    expect(hasStrongFoodSignal(o)).toBe(true);
    expect(hasRuleConfirmedNonFoodSignal(o)).toBe(false);
    expect(classifyFilteredOfferForRescue(o)).toBe('rescue');
  });

  // Generische Backwaren-Komposita (KW-unabhängig, nicht die Wochenprodukte).
  it.each([
    'Laugengebäck herzhaft',
    'Steinofen-Ciabatta Rosmarin',
    'Erdnüsse geröstet gesalzen',
    'Käse-Flips Maissnack',
    'Grillmais im Vakuum',
    'Pale Ale Craft Beer',
  ])('generisches Food-Vokabular erkennt %s', (name) => {
    expect(hasStrongFoodSignal(offer({ name }))).toBe(true);
  });
});

// ── ZIEL 2: Klare Non-Food-Fälle bleiben keep, nicht review ─────────────────
describe('REWE — klare Non-Food-Abteilungen werden regelbestätigt (keep)', () => {
  const nonFoodRepros: Array<[string, Partial<Offer> & Record<string, unknown>]> = [
    ['Pampers Sparpack Premium Protection', { sourceCategoryRaw: 'Drogerie', unit: '48-St.-Pckg' }],
    ['Pampers Sparpack Baby Dry', { sourceCategoryRaw: 'Drogerie', unit: '39-St.-Pckg' }],
    ['Viss Scheuermilch', { sourceCategoryRaw: 'Haushalt' }],
    ['Persil Universal Megaperls', { sourceCategoryRaw: 'Drogerie' }],
    ['Colgate Total Zahncreme', { sourceCategoryRaw: 'Drogerie' }],
    ['Whiskas Knuspertaschen', { sourceCategoryRaw: 'Tier' }],
    ['Whiskas Katzennahrung', { sourceCategoryRaw: 'Tier' }],
    [
      'Vitakraft Bonas Kaustangen mit Huhn',
      { category: 'Fleisch', sourceCategoryRaw: 'Tier' },
    ],
    ['Blumenstrauß »Flower Festival«', { sourceCategoryRaw: 'Freizeit und Mode' }],
    ['Zauberglöckchen', { sourceCategoryRaw: 'Freizeit und Mode', unit: '1-Topf' }],
    ['»Urlaubsfeeling«', { sourceCategoryRaw: 'Freizeit und Mode', unit: '1-Topf' }],
  ];

  it.each(nonFoodRepros)('%s ist regelbestätigtes Non-Food (keep)', (name, extra) => {
    const o = offer({ name, ...extra });
    expect(hasRuleConfirmedNonFoodSignal(o)).toBe(true);
    expect(classifyFilteredOfferForRescue(o)).toBe('keep');
  });

  it('botanisches Kombi-Signal (Blüten + 1-Topf) erkennt eine Topfpflanze', () => {
    const o = offer({
      name: 'Zauberglöckchen',
      sourceCategoryRaw: 'Garten & Pflanzen',
      sourceContextRaw: 'Blüten, je 1-Topf',
      unit: '1-Topf',
    });
    expect(hasRuleConfirmedNonFoodSignal(o)).toBe(true);
  });
});

// ── Gemischte Aktionssektion ────────────────────────────────────────────────
describe('REWE — gemischte Aktionssektion entscheidet nach Name/Kontext', () => {
  it('„Fan-Momente zum Angrillen!" gilt NICHT pauschal als Food-Abteilung', () => {
    // Ein hartes Non-Food in derselben Aktionssektion bleibt Non-Food.
    const grillTool = offer({
      name: 'Gasgrill Edelstahl 3 Brenner',
      sourceCategoryRaw: 'Fan-Momente zum Angrillen!',
    });
    expect(isStrictFoodOffer(grillTool)).toBe(false);
    expect(classifyFilteredOfferForRescue(grillTool)).toBe('keep');

    // Food in derselben Sektion wird über den NAMEN gerettet.
    const food = offer({
      name: 'ja! Erdnüsse',
      sourceCategoryRaw: 'Fan-Momente zum Angrillen!',
    });
    expect(classifyFilteredOfferForRescue(food)).toBe('rescue');
  });

  it('Mars m&m’s bleibt ohne generisches Food-Wort ein ehrlicher Review-Fall', () => {
    // Keine Marken-Allowlist: ohne generisches Vokabular ist es weder rettbar
    // noch regelbestätigtes Non-Food → review (sichtbar, nie still gefiltert).
    const o = offer({ name: 'Mars m&m’s', sourceCategoryRaw: 'Fan-Momente zum Angrillen!' });
    expect(hasStrongFoodSignal(o)).toBe(false);
    expect(hasRuleConfirmedNonFoodSignal(o)).toBe(false);
    expect(classifyFilteredOfferForRescue(o)).toBe('review');
  });
});

// ── ZIEL 4: Keine Regressionen + Wortgrenzen/Komposita ──────────────────────
describe('REWE — Wortgrenzen/Komposita, keine Regressionen', () => {
  it('echte Lebensmittel mit Food-Vokabular bleiben Food', () => {
    for (const name of [
      'REWE Bio Grillkäse natur',
      'Kräuter der Provence gerebelt',
      'Rosmarin frisch geschnitten',
    ]) {
      expect(isStrictNonFoodOffer(offer({ name }))).toBe(false);
      expect(isStrictFoodOffer(offer({ name }))).toBe(true);
    }
  });

  it('Sonnenblumenkerne/Beeren werden NICHT fälschlich als Non-Food gefiltert', () => {
    // Regression für die Wortgrenzen: 'blume(n)' darf "Sonnenblumenkerne" nie
    // treffen; mit Food-Quellabteilung bleiben sie sauber Food.
    for (const name of ['Sonnenblumenkerne geschält', 'Erdbeeren 500g Schale', 'Himbeeren 250g']) {
      expect(isStrictNonFoodOffer(offer({ name }))).toBe(false);
      expect(isStrictFoodOffer(offer({ name, sourceCategoryRaw: 'Obst & Gemüse' }))).toBe(true);
    }
  });

  it('Wortgrenzen verhindern Substring-False-Positives', () => {
    // 'flips' rettet keine Flip-Flops; 'lager'/'beer' keine Lagerung/Erdbeere-Deko;
    // 'mais' keine Maische-Reste; 'laugen' keine Reinigungs-Lauge.
    expect(hasStrongFoodSignal(offer({ name: 'Flip-Flops Damen Gr. 38' }))).toBe(false);
    expect(hasStrongFoodSignal(offer({ name: 'Aufbewahrungsbox für Lagerung' }))).toBe(false);
    // Non-Food bleibt Non-Food (harte Signale gewinnen).
    expect(isStrictNonFoodOffer(offer({ name: 'Viss Scheuermilch' }))).toBe(true);
    expect(isStrictNonFoodOffer(offer({ name: 'Pampers Baby Dry', sourceCategoryRaw: 'Drogerie' }))).toBe(true);
  });

  it('„tierische" Food-Quellkategorie wird nicht als Tier-Abteilung gewertet', () => {
    const o = offer({ name: 'Bratwurst grob', sourceCategoryRaw: 'Tierische Lebensmittel' });
    expect(hasRuleConfirmedNonFoodSignal(o)).toBe(false);
  });
});

// ── ZIEL 3: gemeinsame Wahrheit + ehrliche Aufteilung + Idempotenz ──────────
describe('REWE — gemeinsame Rescue-/Report-Wahrheit und ehrliche Completeness', () => {
  // Die 22 real gefilterten REWE-Angebote als Fixture-Bucket.
  const filtered: Offer[] = [
    offer({ name: 'Mars m&m’s', sourceCategoryRaw: 'Fan-Momente zum Angrillen!' }),
    offer({ name: 'REWE Beste Wahl Mini Laugen-Mix', sourceCategoryRaw: 'Fan-Momente zum Angrillen!' }),
    offer({ name: 'REWE Feine Welt Ciabatta Königliche Olive', sourceCategoryRaw: 'Fan-Momente zum Angrillen!' }),
    offer({ name: 'Heineken Lager Beer', sourceCategoryRaw: 'Fan-Momente zum Angrillen!' }),
    offer({ name: 'ja! Erdnuss-Flips', sourceCategoryRaw: 'Fan-Momente zum Angrillen!' }),
    offer({ name: 'ja! Erdnüsse', sourceCategoryRaw: 'Fan-Momente zum Angrillen!' }),
    offer({ name: "Butcher's Barbecue Grillmais", sourceCategoryRaw: 'Schnell und einfach' }),
    offer({ name: 'Viss Scheuermilch', sourceCategoryRaw: 'Haushalt' }),
    offer({ name: 'Persil Universal Megaperls', sourceCategoryRaw: 'Drogerie' }),
    offer({ name: 'Persil Colorwaschmittel Kraft Gel', sourceCategoryRaw: 'Drogerie' }),
    offer({ name: 'Garnier Wahre Schätze Shampoo', sourceCategoryRaw: 'Drogerie' }),
    offer({ name: 'Pampers Sparpack Premium Protection', sourceCategoryRaw: 'Drogerie', unit: '48-St.-Pckg' }),
    offer({ name: 'Colgate Total Zahncreme', sourceCategoryRaw: 'Drogerie' }),
    offer({ name: 'Pampers Sparpack Baby Dry', sourceCategoryRaw: 'Drogerie', unit: '39-St.-Pckg' }),
    offer({ name: 'Whiskas Knuspertaschen', sourceCategoryRaw: 'Tier' }),
    offer({ name: 'Whiskas Katzentrockenfutter', sourceCategoryRaw: 'Tier' }),
    offer({ name: 'Whiskas Katzennahrung', sourceCategoryRaw: 'Tier' }),
    offer({ name: 'Vitakraft Bonas Kaustangen mit Huhn', category: 'Fleisch', sourceCategoryRaw: 'Tier' }),
    offer({ name: 'Flammendes Käthchen Topf', sourceCategoryRaw: 'Freizeit und Mode', unit: '1-Topf' }),
    offer({ name: 'Blumenstrauß »Flower Festival«', sourceCategoryRaw: 'Freizeit und Mode' }),
    offer({ name: '»Urlaubsfeeling« Pflanze', sourceCategoryRaw: 'Freizeit und Mode', unit: '1-Topf' }),
    offer({ name: 'Zauberglöckchen', sourceCategoryRaw: 'Freizeit und Mode', unit: '1-Topf' }),
  ];

  it('Partition (Report/Completeness) deckt sich exakt mit dem Rescue-Verdict', () => {
    const part = partitionFilteredOffersForCompleteness(filtered);
    expect(part.suspectNames).toHaveLength(6); // rescue
    expect(part.unconfirmedNames).toEqual(['Mars m&m’s']); // review = nur m&m’s
    expect(part.ruleNonFoodNames).toHaveLength(15); // keep
    expect(
      part.suspectNames.length + part.unconfirmedNames.length + part.ruleNonFoodNames.length,
    ).toBe(filtered.length);

    // Dieselbe Wahrheit pro Angebot.
    for (const o of filtered) {
      const v = classifyFilteredOfferForRescue(o);
      if (v === 'rescue') expect(part.suspectNames).toContain(o.name);
      else if (v === 'review') expect(part.unconfirmedNames).toContain(o.name);
      else expect(part.ruleNonFoodNames).toContain(o.name);
    }
  });

  it('Rescue-Pass verschiebt nur die 6 Food-Angebote und ist idempotent', () => {
    const buckets = { offers: [] as Offer[], nextWeekOffers: [] as Offer[], filteredOffers: filtered };
    const first = applyFoodRescuePass(buckets, { now: NOW });
    expect(first.rescuedCount).toBe(6);
    expect(first.reviewNeededCount).toBe(1);
    expect(first.offers).toHaveLength(6);
    expect(first.filteredOffers).toHaveLength(16);

    // Idempotenz: zweiter Lauf bewegt nichts mehr.
    const second = applyFoodRescuePass(
      { offers: first.offers, nextWeekOffers: first.nextWeekOffers, filteredOffers: first.filteredOffers },
      { now: NOW },
    );
    expect(second.rescuedCount).toBe(0);
    expect(second.offers).toHaveLength(6);
    expect(second.filteredOffers).toHaveLength(16);
  });
});
