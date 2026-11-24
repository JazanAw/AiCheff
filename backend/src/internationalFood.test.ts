import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  classifyInternationalFood,
  classifyInternationalFoodWithLlm,
  buildInternationalFoodLlmRequest,
  parseInternationalFoodLlmResponse,
  INTERNATIONAL_FOOD_SCHEMA,
  type CuisineRegion,
  type InternationalFoodClassification,
} from './internationalFood';

function makeOffer(overrides: Partial<Offer> & Record<string, unknown> = {}): Offer {
  const name = (overrides.name as string) ?? 'Produkt';
  return {
    id: 'o1',
    name,
    normalizedName: name.toLowerCase(),
    storeChain: 'REWE',
    category: 'Sonstiges',
    price: 1.99,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: '2026-05-26T00:00:00.000Z',
    validityEnd: '2026-06-01T23:59:59.999Z',
    sourceUrl: 'https://example.com/offer',
    tags: [],
    createdAt: '2026-05-26T08:00:00.000Z',
    ...overrides,
  } as Offer;
}

describe('classifyInternationalFood — klare internationale Lebensmittel', () => {
  const cases: Array<[string, CuisineRegion]> = [
    ['Ayran', 'turkish'],
    ['Egetürk Sucuk', 'turkish'],
    ['Basmati Reis', 'indian'],
    ['Tahini Sesampaste', 'arabic'],
    ['Hummus Klassik', 'arabic'],
    ['Sriracha Hot Chili Sauce', 'asian'],
    ['Kimchi', 'asian'],
    ['Sojasauce', 'asian'],
  ];

  for (const [name, region] of cases) {
    it(`markiert "${name}" als international (${region}), sicher (kein Review)`, () => {
      const result = classifyInternationalFood(makeOffer({ name }));
      expect(result.isInternational).toBe(true);
      expect(result.cuisineRegion).toBe(region);
      expect(result.needsReview).toBe(false);
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
      expect(result.reasons.length).toBeGreaterThan(0);
    });
  }
});

describe('classifyInternationalFood — normale Lebensmittel sind NICHT international', () => {
  for (const name of ['Frische Vollmilch', 'Deutsche Markenbutter', 'Pizza Margherita', 'Coca-Cola', 'Gouda jung', 'Bananen']) {
    it(`lässt "${name}" als nicht-international (kein Review, keine falsche Sicherheit)`, () => {
      const result = classifyInternationalFood(makeOffer({ name }));
      expect(result.isInternational).toBe(false);
      expect(result.cuisineRegion).toBe('unknown');
      expect(result.needsReview).toBe(false);
    });
  }
});

describe('classifyInternationalFood — unklare Fälle bekommen needsReview', () => {
  it('markiert mehrdeutige Begriffe (Tortilla Wraps) als reviewbedürftig statt falscher Sicherheit', () => {
    const result = classifyInternationalFood(makeOffer({ name: 'Tortilla Wraps' }));
    expect(result.needsReview).toBe(true);
    expect(result.confidence).toBeLessThan(0.8);
  });

  it('markiert "Curry Gewürzmischung" als reviewbedürftig (asiatisch vs. indisch unklar)', () => {
    const result = classifyInternationalFood(makeOffer({ name: 'Curry Gewürzmischung' }));
    expect(result.needsReview).toBe(true);
  });
});

describe('classifyInternationalFood — läuft nicht auf Non-Food', () => {
  it('überspringt Non-Food (LIVARNO Insektenfalle) sauber', () => {
    const result = classifyInternationalFood(
      makeOffer({ name: 'LIVARNO UV-Insektenfalle', normalizedName: 'livarno uv insektenfalle', tags: ['nonfood'] }),
    );
    expect(result.isInternational).toBe(false);
    expect(result.needsReview).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/nonfood|non-food/i);
  });
});

describe('classifyInternationalFood — nutzt Rohsignale (sourceCategoryRaw)', () => {
  it('erkennt eine türkische Quell-Abteilung auch bei neutralem Namen', () => {
    const result = classifyInternationalFood(
      makeOffer({ name: 'Joghurtgetränk', sourceDepartmentRaw: 'Türkische Spezialitäten' } as Partial<Offer>),
    );
    expect(result.isInternational).toBe(true);
    expect(result.cuisineRegion).toBe('turkish');
  });
});

describe('Qwen3 structured-output scaffold', () => {
  it('builds an Ollama request with JSON schema, temperature 0, think false', () => {
    const req = buildInternationalFoodLlmRequest(makeOffer({ name: 'Manti' }), 'qwen3:14b');
    expect(req.model).toBe('qwen3:14b');
    expect(req.think).toBe(false);
    expect(req.options.temperature).toBe(0);
    expect(req.format).toEqual(INTERNATIONAL_FOOD_SCHEMA);
    expect(req.stream).toBe(false);
  });

  it('parses a valid structured response', () => {
    const parsed = parseInternationalFoodLlmResponse({
      isInternational: true,
      cuisineRegion: 'turkish',
      confidence: 0.82,
      reasons: ['manti is a turkish dumpling'],
      needsReview: false,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.cuisineRegion).toBe('turkish');
    expect(parsed?.isInternational).toBe(true);
  });

  it('rejects an out-of-enum region', () => {
    expect(parseInternationalFoodLlmResponse({ isInternational: true, cuisineRegion: 'klingon', confidence: 1 })).toBeNull();
  });
});

describe('classifyInternationalFoodWithLlm — LLM nur bei unklaren Fällen', () => {
  it('ruft den LLM NICHT auf, wenn die Regel sicher ist', async () => {
    let called = 0;
    const llm = async (): Promise<InternationalFoodClassification | null> => {
      called += 1;
      return { isInternational: false, cuisineRegion: 'unknown', confidence: 1, reasons: ['llm'], needsReview: false };
    };
    const result = await classifyInternationalFoodWithLlm(makeOffer({ name: 'Ayran' }), { llm });
    expect(called).toBe(0); // rule was confident → no model call
    expect(result.cuisineRegion).toBe('turkish');
  });

  it('ruft den LLM bei needsReview auf und übernimmt dessen Ergebnis', async () => {
    let called = 0;
    const llm = async (): Promise<InternationalFoodClassification> => {
      called += 1;
      return { isInternational: true, cuisineRegion: 'latin', confidence: 0.9, reasons: ['llm:tortilla mexican'], needsReview: false };
    };
    const result = await classifyInternationalFoodWithLlm(makeOffer({ name: 'Tortilla Wraps' }), { llm });
    expect(called).toBe(1);
    expect(result.cuisineRegion).toBe('latin');
    expect(result.needsReview).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/llm/);
  });

  it('fällt auf das Regelergebnis zurück, wenn kein LLM injiziert ist', async () => {
    const result = await classifyInternationalFoodWithLlm(makeOffer({ name: 'Tortilla Wraps' }));
    expect(result.needsReview).toBe(true); // unchanged rule result, honest uncertainty
  });
});
