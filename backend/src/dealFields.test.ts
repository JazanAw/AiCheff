import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { deriveDealEnrichment } from './dealFields';

function makeOffer(overrides: Partial<Offer> & Record<string, unknown> = {}): Offer & Record<string, unknown> {
  return {
    id: 'o1',
    name: 'Testprodukt',
    normalizedName: 'testprodukt',
    storeChain: 'REWE',
    category: 'other',
    price: 1.99,
    currency: 'EUR',
    unit: '1 St',
    validityStart: '2026-05-26T00:00:00.000Z',
    validityEnd: '2026-06-01T23:59:59.999Z',
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-05-26T08:00:00.000Z',
    ...overrides,
  } as Offer & Record<string, unknown>;
}

describe('deriveDealEnrichment — nutritionStatus', () => {
  it('is "unknown" when no nutrition is present', () => {
    expect(deriveDealEnrichment(makeOffer()).nutritionStatus).toBe('unknown');
  });

  it('is "verified" for OpenFoodFacts-sourced values', () => {
    const offer = makeOffer({ nutrition: { source: 'openfoodfacts', per_100g: { kcal: 50 } } });
    const e = deriveDealEnrichment(offer);
    expect(e.nutritionStatus).toBe('verified');
    expect(e.nutritionEstimated).toBe(false);
  });

  it('is "estimated" for rule-based / non-OFF sources', () => {
    const offer = makeOffer({ nutrition: { source: 'bls', per_100g: { kcal: 50 } } });
    const e = deriveDealEnrichment(offer);
    expect(e.nutritionStatus).toBe('estimated');
    expect(e.nutritionEstimated).toBe(true);
  });
});

describe('deriveDealEnrichment — halalStatus', () => {
  it('is "halal" when dietFlags.halal.status is yes', () => {
    const offer = makeOffer({ dietFlags: { halal: { status: 'yes' } } });
    expect(deriveDealEnrichment(offer).halalStatus).toBe('halal');
  });

  it('is "not_halal" when dietFlags.halal.status is no', () => {
    const offer = makeOffer({ dietFlags: { halal: { status: 'no' } } });
    expect(deriveDealEnrichment(offer).halalStatus).toBe('not_halal');
  });

  it('is "not_halal" when halal is unknown but alcohol is present', () => {
    const offer = makeOffer({ dietFlags: { alcohol: { present: true } } });
    const e = deriveDealEnrichment(offer);
    expect(e.containsAlcohol).toBe(true);
    expect(e.halalStatus).toBe('not_halal');
  });

  it('is "unknown" when nothing is known (never silently "halal")', () => {
    expect(deriveDealEnrichment(makeOffer()).halalStatus).toBe('unknown');
  });

  it('surfaces "doubtful" from the ProductAnalysisV2 status (statusV2)', () => {
    const offer = makeOffer({ dietFlags: { halal: { status: 'unknown', statusV2: 'doubtful' } } });
    expect(deriveDealEnrichment(offer).halalStatus).toBe('doubtful');
  });

  it('prefers a definitive productAnalysis.halal.status over the legacy derivation', () => {
    const offer = makeOffer({ productAnalysis: { halal: { status: 'not_halal' } } });
    expect(deriveDealEnrichment(offer).halalStatus).toBe('not_halal');
  });

  it('never claims "halal" just because no pork/alcohol was detected', () => {
    const offer = makeOffer({ name: 'Rindersalami', category: 'Fleisch' });
    expect(deriveDealEnrichment(offer).halalStatus).toBe('unknown');
  });
});

describe('deriveDealEnrichment — alcohol detection (honest)', () => {
  it('flags alcohol from the "Alkohol" category and marks not_halal', () => {
    for (const name of ['Pils Bier', 'Riesling Wein', 'Sekt trocken']) {
      const e = deriveDealEnrichment(makeOffer({ name, category: 'Alkohol' }));
      expect(e.containsAlcohol).toBe(true);
      expect(e.halalStatus).toBe('not_halal');
    }
  });

  it('flags alcohol from unambiguous name keywords even without the category', () => {
    const e = deriveDealEnrichment(makeOffer({ name: 'Krombacher Pils', category: 'other' }));
    expect(e.containsAlcohol).toBe(true);
  });

  it('does NOT flag alcohol for a non-alcoholic Red Bull', () => {
    const e = deriveDealEnrichment(makeOffer({ name: 'Red Bull Energy Drink', category: 'Getränke Alkoholfrei' }));
    // Honest: no alcohol signal -> stays unknown (null), never fabricated false.
    expect(e.containsAlcohol).toBeNull();
    expect(e.halalStatus).toBe('unknown');
  });

  it('does NOT mistake grapes/Rumkugeln/Weingummi for alcohol', () => {
    expect(deriveDealEnrichment(makeOffer({ name: 'Weintrauben hell', category: 'Obst/Gemüse' })).containsAlcohol).toBeNull();
    expect(deriveDealEnrichment(makeOffer({ name: 'Rumkugeln', category: 'Snacks/Süßes' })).containsAlcohol).toBeNull();
  });
});

describe('deriveDealEnrichment — allergen risk (honest, never "allergen-free")', () => {
  const riskOf = (name: string) => deriveDealEnrichment(makeOffer({ name })).allergenRisks;

  it('detects lactose risk for dairy', () => {
    for (const name of ['Vollmilch 3,5%', 'Gouda Käse', 'Naturjoghurt', 'Schlagsahne']) {
      expect(riskOf(name)).toContain('lactose');
    }
  });

  it('detects gluten risk for bread/pasta/cake', () => {
    for (const name of ['Bauernbrot', 'Spaghetti No. 5', 'Marmorkuchen']) {
      expect(riskOf(name)).toContain('gluten');
    }
  });

  it('detects nuts/peanut risk', () => {
    expect(riskOf('Haselnuss Mischung')).toContain('nuts');
    expect(riskOf('Erdnüsse geröstet')).toContain('nuts');
  });

  it('detects fish/seafood/soy/egg risks', () => {
    expect(riskOf('Räucherlachs')).toContain('fish');
    expect(riskOf('Thunfisch in Öl')).toContain('fish');
    expect(riskOf('Tofu natur')).toContain('soy');
    expect(riskOf('Eier Bodenhaltung')).toContain('eggs');
  });

  it('stays "unknown" (empty risks) for a neutral non-food name', () => {
    const e = deriveDealEnrichment(makeOffer({ name: 'Toilettenpapier 10er' }));
    expect(e.allergenRisks).toEqual([]);
    expect(e.allergenStatus).toBe('unknown');
  });

  it('prefers verified allergens (known) over name-based risk', () => {
    const offer = makeOffer({ name: 'Vollmilch', allergens: { contains: ['lactose'] } });
    const e = deriveDealEnrichment(offer);
    expect(e.allergens).toEqual(['lactose']);
    expect(e.allergenStatus).toBe('known');
  });
});

describe('deriveDealEnrichment — Haribo/Katjes gelatine caution', () => {
  it('Haribo without ingredients stays vegan/vegetarian/halal UNKNOWN (no blanket claim)', () => {
    const e = deriveDealEnrichment(makeOffer({ name: 'Haribo Goldbären', category: 'Snacks/Süßes' }));
    expect(e.isVegan).toBeNull();
    expect(e.isVegetarian).toBeNull();
    expect(e.halalStatus).toBe('unknown');
  });

  it('Katjes is only vegan/vegetarian when the pipeline explicitly says so', () => {
    // No explicit flag -> stays null, never assumed from the brand name.
    const plain = deriveDealEnrichment(makeOffer({ name: 'Katjes Fruchtgummi', category: 'Snacks/Süßes' }));
    expect(plain.isVegetarian).toBeNull();
    // Explicit flag from pipeline -> trusted.
    const flagged = deriveDealEnrichment(
      makeOffer({ name: 'Katjes Veggie', category: 'Snacks/Süßes', dietFlags: { vegetarian: { status: 'yes' } } }),
    );
    expect(flagged.isVegetarian).toBe(true);
  });
});

describe('deriveDealEnrichment — analyzed + no fake verified', () => {
  it('marks every offer productInfoAnalyzed, even when everything is unknown', () => {
    const e = deriveDealEnrichment(makeOffer({ name: 'Zxqwerty Mystery 500' }));
    expect(e.productInfoAnalyzed).toBe(true);
    expect(e.nutritionStatus).toBe('unknown');
    expect(e.halalStatus).toBe('unknown');
    expect(e.allergenStatus).toBe('unknown');
  });

  it('an estimated nutrition source is never upgraded to "verified"', () => {
    const e = deriveDealEnrichment(makeOffer({ nutrition: { source: 'heuristic', per_100g: { kcal: 120 } } }));
    expect(e.nutritionStatus).toBe('estimated');
    expect(e.nutritionStatus).not.toBe('verified');
  });
});

describe('deriveDealEnrichment — allergenStatus', () => {
  it('is "known" when the pipeline supplied allergens', () => {
    const offer = makeOffer({ allergens: { contains: ['gluten', 'lactose'] } });
    const e = deriveDealEnrichment(offer);
    expect(e.allergens).toEqual(['gluten', 'lactose']);
    expect(e.allergenStatus).toBe('known');
  });

  it('is "risk" when the name hints an allergen but none were verified', () => {
    const offer = makeOffer({ name: 'Frische Vollmilch 3,5%' });
    const e = deriveDealEnrichment(offer);
    expect(e.allergens).toEqual([]);
    expect(e.allergenStatus).toBe('risk');
  });

  it('is "unknown" for a neutral product with no allergens and no risk hint', () => {
    const offer = makeOffer({ name: 'Toilettenpapier 10er' });
    expect(deriveDealEnrichment(offer).allergenStatus).toBe('unknown');
  });
});

describe('deriveDealEnrichment — allergen alias mapping (aichef_offers / OFF)', () => {
  const allergensOf = (codes: string[]) =>
    deriveDealEnrichment(makeOffer({ name: 'Produkt', allergens: { contains: codes } })).allergens;

  it('maps the EU-14 codes aichef_offers emits onto the app slugs', () => {
    expect(allergensOf(['milk'])).toEqual(['lactose']);
    expect(allergensOf(['gluten_cereals'])).toEqual(['gluten']);
    expect(allergensOf(['soybeans'])).toEqual(['soy']);
    expect(allergensOf(['peanuts'])).toEqual(['nuts']);
    expect(allergensOf(['crustaceans'])).toEqual(['seafood']);
    expect(allergensOf(['molluscs'])).toEqual(['seafood']);
    expect(allergensOf(['eggs'])).toEqual(['eggs']);
    expect(allergensOf(['fish'])).toEqual(['fish']);
    expect(allergensOf(['sesame'])).toEqual(['sesame']);
  });

  it('strips raw OpenFoodFacts locale prefixes (en:/de:)', () => {
    expect(allergensOf(['en:milk'])).toEqual(['lactose']);
    expect(allergensOf(['en:tree-nuts'])).toEqual(['nuts']);
    expect(allergensOf(['de:gluten'])).toEqual(['gluten']);
  });

  it('dedupes when several codes collapse to one app slug', () => {
    expect(allergensOf(['milk', 'lactose', 'dairy'])).toEqual(['lactose']);
    expect(allergensOf(['peanuts', 'hazelnut', 'almond'])).toEqual(['nuts']);
  });

  it('drops EU-14 allergens the app has no bucket for (no wrong bucket)', () => {
    // celery / mustard / sulphites / lupin are intentionally unmapped.
    expect(allergensOf(['celery', 'mustard', 'sulphites', 'lupin'])).toEqual([]);
  });

  it('a real verified allergen list yields allergenStatus "known" (over name risk)', () => {
    const e = deriveDealEnrichment(
      makeOffer({ name: 'Müsliriegel', allergens: { contains: ['gluten_cereals', 'milk'] } }),
    );
    expect(e.allergens).toEqual(['gluten', 'lactose']);
    expect(e.allergenStatus).toBe('known');
  });

  it('never invents "allergen-free": empty contains stays unknown/risk, not known', () => {
    const e = deriveDealEnrichment(makeOffer({ name: 'Mineralwasser', allergens: { contains: [] } }));
    expect(e.allergens).toEqual([]);
    expect(e.allergenStatus).not.toBe('known');
  });
});

describe('deriveDealEnrichment — nutrition source (verified vs estimated)', () => {
  it('OpenFoodFacts -> verified', () => {
    const e = deriveDealEnrichment(makeOffer({ nutrition: { source: 'openfoodfacts', per_100g: { kcal: 64 } } }));
    expect(e.nutritionStatus).toBe('verified');
    expect(e.nutritionEstimated).toBe(false);
  });

  it('BLS -> estimated (never verified)', () => {
    const e = deriveDealEnrichment(makeOffer({ nutrition: { source: 'bls', per_100g: { kcal: 64 } } }));
    expect(e.nutritionStatus).toBe('estimated');
    expect(e.nutritionEstimated).toBe(true);
  });

  it('an all-null per_100g (no real values) is treated as no nutrition / unknown', () => {
    const e = deriveDealEnrichment(makeOffer({
      nutrition: { source: 'openfoodfacts', per_100g: { kcal: null, protein_g: null } },
    }));
    expect(e.nutrition).toBeNull();
    expect(e.nutritionStatus).toBe('unknown');
  });
});

describe('deriveDealEnrichment — vegan/vegetarian', () => {
  it('exposes diet flags only when the source explicitly answered', () => {
    const offer = makeOffer({ dietFlags: { vegan: true, vegetarian: { status: 'yes' } } });
    const e = deriveDealEnrichment(offer);
    expect(e.isVegan).toBe(true);
    expect(e.isVegetarian).toBe(true);
  });

  it('is null (never fabricated) when diet flags are absent', () => {
    const e = deriveDealEnrichment(makeOffer());
    expect(e.isVegan).toBeNull();
    expect(e.isVegetarian).toBeNull();
  });
});

describe('deriveDealEnrichment — productAnalysis projection (transport-only)', () => {
  const v2Offer = (over: Record<string, unknown> = {}) =>
    makeOffer({
      productAnalysis: {
        analysisVersion: 'pa-v2',
        sourceFingerprint: 'sf1:0123456789abcdef',
        vegan: { status: 'no', source: 'name_category_rule', confidence: 0.8, reasons: ['conflict:vegan_claim_vs_dairy:milch'] },
        vegetarian: { status: 'yes', source: 'barcode_database', confidence: 0.85, reasons: ['off:analysis_vegetarian'] },
        halal: { status: 'doubtful', source: 'name_category_rule', confidence: 0.5, reasons: ['evidence:meat_no_halal_proof'] },
        reviewNeeded: true,
        reviewReasons: ['meat:no_halal_proof'],
        allergens: {
          milk: { status: 'contains', source: 'barcode_database', confidence: 0.92, reasons: ['off:allergens_tags'] },
          nuts: { status: 'may_contain', source: 'barcode_database', confidence: 0.85, reasons: ['off:traces_tags'] },
          gluten_cereals: { status: 'free_from_claim', source: 'barcode_database', confidence: 0.6, reasons: ['claim:free_from'] },
          eggs: { status: 'unknown', source: 'unknown', confidence: 0, reasons: [] },
        },
        nutrition: { quality: 'barcode_database', basis: 'per_100g', source: 'barcode_database', plausibility: { ok: true, violations: [] } },
        ...over,
      },
    });

  it('is null when the offer was never analysed by V2', () => {
    expect(deriveDealEnrichment(makeOffer()).productAnalysis).toBeNull();
  });

  it('projects the V2 verdicts verbatim (status/confidence/reasonCode) — no re-decision', () => {
    const e = deriveDealEnrichment(v2Offer());
    const pa = e.productAnalysis!;
    expect(pa.version).toBe('pa-v2');
    expect(pa.sourceFingerprint).toBe('sf1:0123456789abcdef');
    expect(pa.vegan).toEqual({ status: 'no', confidence: 0.8, reasonCode: 'conflict:vegan_claim_vs_dairy:milch' });
    expect(pa.vegetarian.status).toBe('yes');
    expect(pa.halal).toEqual({ status: 'doubtful', confidence: 0.5, reasonCode: 'evidence:meat_no_halal_proof' });
    expect(pa.reviewNeeded).toBe(true);
    expect(pa.reviewReasons).toEqual(['meat:no_halal_proof']);
  });

  it('groups EU-14 allergens into contains / may_contain / free_from buckets', () => {
    const pa = deriveDealEnrichment(v2Offer()).productAnalysis!;
    expect(pa.allergens.contains).toEqual(['milk']);
    expect(pa.allergens.mayContain).toEqual(['nuts']);
    expect(pa.allergens.freeFrom).toEqual(['gluten_cereals']);
  });

  it('exposes nutrition quality + plausibility and the used evidence sources', () => {
    const pa = deriveDealEnrichment(v2Offer()).productAnalysis!;
    expect(pa.nutrition).toEqual({ quality: 'barcode_database', basis: 'per_100g', plausible: true });
    expect(pa.sources).toContain('barcode_database');
    expect(pa.sources).toContain('name_category_rule');
  });

  it('does not invent verdicts the V2 object did not state', () => {
    const pa = deriveDealEnrichment(v2Offer({ vegan: undefined })).productAnalysis!;
    expect(pa.vegan).toEqual({ status: 'unknown', confidence: null, reasonCode: null });
  });
});

// Admin kill-switches (enrichmentFlags.ts): a disabled category must degrade to
// the exact same "unknown" shape as an offer that was never analyzed for it —
// both the raw field AND every field derived from it (incl. inside
// productAnalysis, which would otherwise re-expose the same verdict twice).
describe('deriveDealEnrichment — enrichment flags (admin kill-switch)', () => {
  const fullyEnrichedOffer = () =>
    makeOffer({
      nutrition: { source: 'openfoodfacts', per_100g: { kcal: 120, protein_g: 5 } },
      allergens: { contains: ['milk', 'nuts'] },
      dietFlags: { halal: { status: 'no' } },
      productAnalysis: {
        analysisVersion: 'pa-v2',
        vegan: { status: 'no', source: 'rule', confidence: 0.8, reasons: [] },
        vegetarian: { status: 'yes', source: 'rule', confidence: 0.8, reasons: [] },
        halal: { status: 'not_halal', source: 'rule', confidence: 0.9, reasons: ['contains:pork'] },
        allergens: {
          milk: { status: 'contains', source: 'rule', confidence: 0.9, reasons: [] },
        },
        nutrition: { quality: 'good', basis: 'per_100g', source: 'openfoodfacts', plausibility: { ok: true, violations: [] } },
      },
    });

  it('defaults to all-enabled when no flags are passed (existing callers unaffected)', () => {
    const e = deriveDealEnrichment(fullyEnrichedOffer());
    expect(e.nutrition).not.toBeNull();
    expect(e.isHalal).toBe(false);
    expect(e.allergens).toEqual(expect.arrayContaining(['lactose', 'nuts']));
  });

  it('nutrition off: nulls the raw field, resets nutritionStatus, and clears productAnalysis.nutrition', () => {
    const e = deriveDealEnrichment(fullyEnrichedOffer(), { nutrition: false, halal: true, allergens: true });
    expect(e.nutrition).toBeNull();
    expect(e.nutritionEstimated).toBe(false);
    expect(e.nutritionStatus).toBe('unknown');
    expect(e.productAnalysis!.nutrition).toEqual({ quality: null, basis: null, plausible: null });
    // Unaffected categories stay untouched.
    expect(e.isHalal).toBe(false);
    expect(e.allergens.length).toBeGreaterThan(0);
  });

  it('halal off: nulls isHalal, resets halalStatus, and clears productAnalysis.halal', () => {
    const e = deriveDealEnrichment(fullyEnrichedOffer(), { nutrition: true, halal: false, allergens: true });
    expect(e.isHalal).toBeNull();
    expect(e.halalStatus).toBe('unknown');
    expect(e.productAnalysis!.halal).toEqual({ status: 'unknown', confidence: null, reasonCode: null });
    // Unaffected categories stay untouched.
    expect(e.nutrition).not.toBeNull();
    expect(e.allergens.length).toBeGreaterThan(0);
  });

  it('allergens off: clears allergens + allergenRisks, resets allergenStatus, and clears productAnalysis.allergens', () => {
    const e = deriveDealEnrichment(fullyEnrichedOffer(), { nutrition: true, halal: true, allergens: false });
    expect(e.allergens).toEqual([]);
    expect(e.allergenRisks).toEqual([]);
    expect(e.allergenStatus).toBe('unknown');
    expect(e.productAnalysis!.allergens).toEqual({ contains: [], mayContain: [], freeFrom: [] });
    // Unaffected categories stay untouched.
    expect(e.nutrition).not.toBeNull();
    expect(e.isHalal).toBe(false);
  });

  it('all three off at once fully degrades to the "never analyzed" shape', () => {
    const e = deriveDealEnrichment(fullyEnrichedOffer(), { nutrition: false, halal: false, allergens: false });
    expect(e.nutrition).toBeNull();
    expect(e.isHalal).toBeNull();
    expect(e.allergens).toEqual([]);
    expect(e.nutritionStatus).toBe('unknown');
    expect(e.halalStatus).toBe('unknown');
    expect(e.allergenStatus).toBe('unknown');
  });

  it('suppressing a category on an offer with no productAnalysis does not throw', () => {
    const e = deriveDealEnrichment(makeOffer(), { nutrition: false, halal: false, allergens: false });
    expect(e.productAnalysis).toBeNull();
    expect(e.nutritionStatus).toBe('unknown');
  });
});
