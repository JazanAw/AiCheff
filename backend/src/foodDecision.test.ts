import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  classifyFoodDecision,
  isFragmentOrSectionHeader,
  summarizeFoodDecisions,
  summarizeReviewDimension,
  computeChainSnapshotStatus,
} from './foodDecision';

// Zentrale Drei-Wege-Food-Entscheidung. Produktnamen hier sind AUSSCHLIESSLICH
// Reproduktions-Fixtures (Task: konkrete Namen nur in Tests) — der Produktivcode
// kennt keine Produkt-/Marken-Allowlist und keinen KW-/Shop-Sonderfall.

function offer(name: string, extra: Partial<Offer> = {}): Offer {
  return {
    id: `id_${name}`,
    name,
    normalizedName: name.toLowerCase(),
    storeChain: 'REWE',
    category: '',
    price: 1.99,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: '2026-06-08T00:00:00.000Z',
    validityEnd: '2026-06-13T23:59:59.000Z',
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-06-08T00:00:00.000Z',
    ...extra,
  } as Offer;
}

describe('classifyFoodDecision — Reproduktionsfälle', () => {
  it('Test 4: Ziersalbei, Trockenblumen und Damen-Slipper werden NICHT gerettet (confirmed_non_food)', () => {
    for (const name of [
      'Ziersalbei',
      'Trockenblumen Mono Bunches Buttercup',
      'GIN TONIC Damen-Slipper',
    ]) {
      expect(classifyFoodDecision(offer(name)), name).toBe('confirmed_non_food');
    }
  });

  it('Gerätebegriff: Pizzamaker ist Non-Food trotz „Pizza"', () => {
    expect(classifyFoodDecision(offer('Pizzamaker'))).toBe('confirmed_non_food');
  });

  it('Zierpflanze gewinnt gegen essbares Kräuter-/Gemüse-Signal (Ordnung Non-Food vor Food)', () => {
    // „salbei" ist ein Food-Keyword — der Zier-Präfix muss trotzdem gewinnen.
    expect(classifyFoodDecision(offer('Ziersalbei'))).toBe('confirmed_non_food');
    // Zierkürbis ist Deko, kein Speisekürbis.
    expect(classifyFoodDecision(offer('Zierkürbis'))).toBe('confirmed_non_food');
  });

  it('Test 5: mehrdeutige Einwortnamen (Gold, Auslese) werden NICHT blind gerettet (uncertain)', () => {
    for (const name of ['Gold', 'Auslese']) {
      expect(classifyFoodDecision(offer(name)), name).toBe('uncertain');
    }
  });

  it('Test 3: echte Lebensmittel ohne Keyword werden NICHT allein deshalb Non-Food', () => {
    // Diese realen Fehlfilter dürfen nie confirmed_non_food sein (uncertain/food ok),
    // damit Phase 2 sie erneut prüfen bzw. der Rescue sie holen kann.
    for (const name of [
      'Celebrations',
      'Rama',
      'Cerealien Pokémon',
      'Spritzring',
      'BEBIVITA Glaskost',
      'Exquisa Der Sahnige',
      'Mirée Französische Kräuter',
      'Salakis Marinierte Würfel',
      'Schweppes Bittergetränk',
      'Campari Bitter Aperitif',
      'Havana Club Añejo 3 Años',
      'Thomas Henry Tonic Water',
      'La Gioiosa Vino Frizzante Bianco',
    ]) {
      expect(classifyFoodDecision(offer(name)), name).not.toBe('confirmed_non_food');
    }
  });

  it('Test 6: Tiefkühl- und Alkohol-Quellkategorien behalten Vorrang (confirmed_food)', () => {
    expect(
      classifyFoodDecision(
        offer('Iglo Tagliatelle Pilzpfanne', { sourceCategoryRaw: 'Tiefkühl' } as Partial<Offer>),
      ),
    ).toBe('confirmed_food');
    expect(
      classifyFoodDecision(
        offer('La Gioiosa', { sourceCategoryRaw: 'Wein & Spirituosen' } as Partial<Offer>),
      ),
    ).toBe('confirmed_food');
  });

  it('Test 2: neutrale Quellabteilung ist kein Non-Food-Beweis', () => {
    for (const dept of [
      'Angebote',
      'Filialangebote',
      'Angebote im Markt',
      'Bonus-Aktionen',
      'Markenartikel',
      'Aktionen & Angebote',
      'NORMA Angebote',
    ]) {
      // Ein neutraler Name in einer neutralen Abteilung bleibt unklar, nie Non-Food.
      expect(
        classifyFoodDecision(offer('Markenprodukt', { sourceCategoryRaw: dept } as Partial<Offer>)),
        dept,
      ).not.toBe('confirmed_non_food');
    }
  });

  it('Test 1: REWE Bonus-Aktionen mit Käse/Soja/Obst/alkoholfrei/Alkohol bleiben Food', () => {
    const bonus = { sourceCategoryRaw: 'Bonus-Aktionen' } as Partial<Offer>;
    for (const name of [
      'Kerrygold Cheddar gerieben', // Käse
      'Alpro Soja Natur', // Soja
      'Limetten', // Obst
      'Thomas Henry Tonic Water', // alkoholfreies Getränk
      'Bacardi Carta Blanca Superior', // Alkohol (Food mit Alkohol-Flag)
    ]) {
      expect(classifyFoodDecision(offer(name, bonus)), name).not.toBe('confirmed_non_food');
    }
  });
});

describe('classifyFoodDecision — Prioritäten', () => {
  it('expliziter nonfood-Tag ⇒ confirmed_non_food', () => {
    expect(classifyFoodDecision(offer('Irgendwas', { tags: ['nonfood'] }))).toBe(
      'confirmed_non_food',
    );
  });

  it('Fragment/Section-Header wird erkannt (Bewegungs-Guard, kein Food-Verdikt)', () => {
    expect(isFragmentOrSectionHeader(offer('Tiefpreis'))).toBe(true);
    expect(isFragmentOrSectionHeader(offer('Grillkäse Natur'))).toBe(false);
  });
});

describe('summarizeFoodDecisions — ehrliche Diagnostik', () => {
  it('trennt confirmed_non_food und uncertain im Filter (kein „filtered = Non-Food")', () => {
    const summary = summarizeFoodDecisions({
      offers: [offer('Grillkäse Natur')],
      nextWeekOffers: [],
      filteredOffers: [
        offer('Damen BH-Top'), // confirmed_non_food (Regel)
        offer('Celebrations'), // uncertain (Review-Fall)
        offer('Rama'), // uncertain
      ],
    });
    expect(summary.confirmedFoodVisibleCount).toBe(1);
    expect(summary.confirmedNonFoodFilteredCount).toBe(1);
    expect(summary.uncertainFilteredCount).toBe(2);
    expect(summary.uncertainFilteredExamples).toContain('Celebrations');
  });

  it('meldet wrongFoodFiltered (zeitlich gültiges confirmed_food im Filter)', () => {
    const summary = summarizeFoodDecisions({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [offer('Bratwurst grob')],
    });
    expect(summary.wrongFoodFilteredCount).toBe(1);
    expect(summary.wrongFoodFilteredExamples).toContain('Bratwurst grob');
  });

  it('abgelaufenes confirmed_food zählt nicht als wrongFoodFiltered', () => {
    const summary = summarizeFoodDecisions(
      { offers: [], nextWeekOffers: [], filteredOffers: [offer('Bratwurst grob')] },
      { isTimeValid: () => false },
    );
    expect(summary.wrongFoodFilteredCount).toBe(0);
    expect(summary.confirmedNonFoodFilteredCount).toBe(1);
  });
});

describe('summarizeReviewDimension — Task F: Review-Flag ≠ FoodDecision', () => {
  // Test 18: Review- und FoodDecision-Counter sind getrennt und rechnerisch konsistent.
  it('trennt das reviewNeeded-Flag von der FoodDecision-Dimension', () => {
    const review = summarizeReviewDimension({
      offers: [
        offer('Grillkäse Natur', { reviewNeeded: true } as Partial<Offer>), // confirmed_food + review
        offer('Bratwurst grob'), // confirmed_food, kein review
        offer('Celebrations', { reviewNeeded: true } as Partial<Offer>), // uncertain + review (sichtbar)
      ],
      nextWeekOffers: [],
      filteredOffers: [
        offer('Damen BH-Top', { reviewNeeded: true } as Partial<Offer>), // confirmed_non_food + review
        offer('Rama'), // uncertain, kein review
        offer('Gold', { reviewNeeded: true } as Partial<Offer>), // uncertain + review (gefiltert)
      ],
    });
    expect(review.confirmedFoodWithReviewCount).toBe(1);
    expect(review.confirmedNonFoodWithReviewCount).toBe(1);
    expect(review.uncertainVisibleCount).toBe(1); // Celebrations
    expect(review.uncertainFilteredCount).toBe(2); // Rama, Gold
    expect(review.unresolvedVisibleReviewCount).toBe(2); // Grillkäse, Celebrations
    expect(review.unresolvedFilteredReviewCount).toBe(2); // BH-Top, Gold
  });
});

describe('computeChainSnapshotStatus — Task E: aktueller Snapshot ≠ Import-Zählkette', () => {
  // Test 16: aktueller REWE-Snapshotstatus wird nach Phase 2 frisch berechnet.
  it('berechnet den aktuellen REWE-Zustand frisch aus den Buckets', () => {
    const status = computeChainSnapshotStatus(
      {
        offers: [offer('Bratwurst grob'), offer('Edeka Käse', { storeChain: 'EDEKA' })],
        nextWeekOffers: [offer('Joghurt natur')],
        filteredOffers: [
          offer('Damen BH-Top'), // confirmed_non_food
          offer('Eiswürfelform'), // confirmed_non_food (neue Produktklasse)
          offer('Celebrations', { reviewNeeded: true } as Partial<Offer>), // uncertain + review
        ],
      },
      'REWE',
    );
    expect(status.current).toBe(1); // nur REWE-Bratwurst (EDEKA zählt nicht)
    expect(status.nextWeek).toBe(1);
    expect(status.confirmedNonFoodFiltered).toBe(2);
    expect(status.uncertainFiltered).toBe(1);
    expect(status.unresolvedReview).toBe(1);
    expect(status.wrongFoodFiltered).toBe(0);
  });

  it('meldet wrongFoodFiltered, wenn zeitlich gültiges confirmed_food im REWE-Filter liegt', () => {
    const status = computeChainSnapshotStatus({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [offer('Bratwurst grob')],
    }, 'REWE');
    expect(status.wrongFoodFiltered).toBe(1);
  });
});
