import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  classifyFoodDecision,
  summarizeFoodDecisions,
  summarizeReviewDimension,
} from './foodDecision';
import { hasRuleConfirmedNonFoodSignal } from './offersStrictFoodFilter';
import {
  applyFoodRescuePass,
  revertStaleRescues,
  FOOD_RESCUE_TAG,
  RESCUE_REVERTED_REVIEW_REASON,
} from './snapshotFoodRescue';

// Finaler Korrekturpass Phase 1 (P1–P4). Konkrete Produktnamen sind
// AUSSCHLIESSLICH Reproduktions-Fixtures — der Produktivcode kennt keine
// Produkt-/Marken-Allowlist und keine Shop-Sonderregel.

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

const NOW = new Date('2026-06-10T08:00:00.000Z');

// ── P1: Provenienz des nonfood-Tags ─────────────────────────────────────────
describe('P1 — generisches nonfood-Tag ist nur aus vertrauenswürdiger Quelle hart', () => {
  it('Test 1+4: isoliertes Modell-/Legacy-nonfood-Tag + starke Food-Belege wird repariert', () => {
    // Karottini-Fall: Tag + Modell-Flags, aber neutrale Quelle „Schnell und
    // einfach" und starke Food-Belege (Frischkäse/Lauch/Dip).
    const karottini = offer('Karottini mit Frischkäse-Lauch-Dip', {
      tags: ['rewe', 'browser-import', 'nonfood'],
      reviewNeeded: true,
      reviewReason: 'rule_conflict,low_confidence',
      sourceCategoryRaw: 'Schnell und einfach',
      foodFlag: 'nonfood',
      canonicalCategory: { isNonFood: true, main: 'Non-Food' },
    } as Partial<Offer>);
    expect(hasRuleConfirmedNonFoodSignal(karottini)).toBe(false);
    expect(classifyFoodDecision(karottini)).toBe('confirmed_food');
  });

  it('Test 2: strukturell vertrauenswürdiges Connector-nonfood-Tag bleibt hart (auch gegen Food-Wort)', () => {
    // Nicht-Food-Quellabteilung belegt das Tag strukturell — es gewinnt gegen ein
    // Food-Wort im Namen.
    const connector = offer('Frischkäse-Box Aufbewahrung', {
      tags: ['nonfood'],
      sourceCategoryRaw: 'Drogerie',
    } as Partial<Offer>);
    expect(hasRuleConfirmedNonFoodSignal(connector)).toBe(true);
    expect(classifyFoodDecision(connector)).toBe('confirmed_non_food');
  });

  it('Test 3: manuelles Learned-Block bleibt hart (separate Lernliste, hier strukturelles Keyword als Stellvertreter)', () => {
    // Strukturelles Non-Food-Keyword (Drogerie-Vokabular) bleibt hart, auch ohne Tag.
    const blocked = offer('Viss Scheuermilch');
    expect(hasRuleConfirmedNonFoodSignal(blocked)).toBe(true);
    expect(classifyFoodDecision(blocked)).toBe('confirmed_non_food');
  });

  it('neutrale Quelle erzwingt weder Food noch Non-Food (bleibt uncertain)', () => {
    const neutral = offer('Markenprodukt', { sourceCategoryRaw: 'Filialangebote' } as Partial<Offer>);
    expect(classifyFoodDecision(neutral)).toBe('uncertain');
  });

  it('isoliertes nonfood-Tag OHNE jedes Food-Signal bleibt konservativ confirmed_non_food', () => {
    expect(classifyFoodDecision(offer('Irgendwas', { tags: ['nonfood'] }))).toBe(
      'confirmed_non_food',
    );
  });

  it('Rescue bereinigt die Non-Food-Artefakte und ist idempotent (Karottini)', () => {
    const karottini = offer('Karottini mit Frischkäse-Lauch-Dip', {
      tags: ['rewe', 'browser-import', 'nonfood'],
      foodFlag: 'nonfood',
      canonicalCategory: { isNonFood: true, main: 'Non-Food' },
    } as Partial<Offer>);
    const first = applyFoodRescuePass(
      { offers: [], nextWeekOffers: [], filteredOffers: [karottini] },
      { now: NOW },
    );
    expect(first.rescuedCount).toBe(1);
    const rescued = [...first.offers, ...first.nextWeekOffers][0] as Offer & {
      foodFlag?: string;
      canonicalCategory?: { isNonFood?: boolean };
    };
    expect(rescued.tags).not.toContain('nonfood');
    expect(rescued.tags).toContain(FOOD_RESCUE_TAG);
    expect(rescued.foodFlag).toBe('food');
    expect(rescued.canonicalCategory?.isNonFood).toBe(false);
    expect(classifyFoodDecision(rescued)).toBe('confirmed_food');
    // Idempotenz: ein zweiter Lauf rettet nichts mehr.
    const second = applyFoodRescuePass(
      { offers: first.offers, nextWeekOffers: first.nextWeekOffers, filteredOffers: first.filteredOffers },
      { now: NOW },
    );
    expect(second.rescuedCount).toBe(0);
  });
});

// ── P2: Spritzring ──────────────────────────────────────────────────────────
describe('P2 — mehrdeutiger Spritzring ohne Gegenstandsbeleg', () => {
  it('Test 5: Spritzring (neutrale Quelle, Modell-isNonFood) ist NICHT confirmed_non_food', () => {
    const spritzring = offer('Spritzring', {
      sourceCategoryRaw: 'Filialangebote',
      category: 'Getränke Alkoholfrei',
      foodFlag: 'food',
      canonicalCategory: { isNonFood: true, main: 'Non-Food' },
    } as Partial<Offer>);
    expect(classifyFoodDecision(spritzring)).toBe('uncertain');
  });

  it('Test 6: echter Gegenstandsring mit Haushalts-/Technik-Abteilung bleibt Non-Food', () => {
    const haushalt = offer('Spritzring', { sourceCategoryRaw: 'Haushalt' } as Partial<Offer>);
    expect(classifyFoodDecision(haushalt)).toBe('confirmed_non_food');
  });

  it('Test 7: Phase 2 / Food-Metadaten (Backwaren-Quelle) lösen Spritzring aus filtered', () => {
    const withFood = offer('Spritzring', {
      sourceCategoryRaw: 'Backwaren',
      foodFlag: 'food',
      canonicalCategory: { isNonFood: true, main: 'Non-Food' },
    } as Partial<Offer>);
    expect(classifyFoodDecision(withFood)).toBe('confirmed_food');
    const rescue = applyFoodRescuePass(
      { offers: [], nextWeekOffers: [], filteredOffers: [withFood] },
      { now: NOW },
    );
    expect(rescue.rescuedCount).toBe(1);
  });
});

// ── P3: mehrdeutige Einwortnamen + food_rescue-Audit-Tag ─────────────────────
describe('P3 — mehrdeutige Einwortnamen werden nicht blind gerettet', () => {
  it('Test 8: mehrdeutiger Einwortname + neutrale Quelle + niedrige Confidence → uncertain', () => {
    for (const name of ['Gold', 'Auslese']) {
      const o = offer(name, {
        sourceCategoryRaw: 'Filialangebote',
        canonicalCategory: { isNonFood: false, main: 'Sonstiges', sub: 'unknown_sub', confidence: 0.2 },
      } as Partial<Offer>);
      expect(classifyFoodDecision(o), name).toBe('uncertain');
    }
  });

  it('Test 9: ein bestehendes food_rescue-Audit-Tag verändert das Verdikt nicht', () => {
    const o = offer('Gold', {
      tags: [FOOD_RESCUE_TAG],
      foodFlag: 'food',
      sourceCategoryRaw: 'Filialangebote',
    } as Partial<Offer>);
    expect(classifyFoodDecision(o)).toBe('uncertain');
  });

  it('Test 10: ein früher falsch geretteter Einwortname wird wieder Review/filtered', () => {
    const rescuedGold = offer('Gold', {
      tags: [FOOD_RESCUE_TAG],
      foodFlag: 'food',
      sourceCategoryRaw: 'Filialangebote',
    } as Partial<Offer>);
    const result = revertStaleRescues({
      offers: [rescuedGold, offer('Bratwurst grob')],
      nextWeekOffers: [],
      filteredOffers: [],
    });
    expect(result.revertedCount).toBe(1);
    expect(result.offers.map((o) => o.name)).toEqual(['Bratwurst grob']);
    const reverted = result.filteredOffers[0] as Offer & { reviewNeeded?: boolean; reviewReason?: string };
    expect(reverted.name).toBe('Gold');
    expect(reverted.reviewNeeded).toBe(true);
    expect(reverted.reviewReason).toBe(RESCUE_REVERTED_REVIEW_REASON);
    expect(reverted.tags).not.toContain(FOOD_RESCUE_TAG);
    // Idempotenz: ein zweiter Lauf bewegt nichts mehr.
    const second = revertStaleRescues(result);
    expect(second.revertedCount).toBe(0);
  });

  it('eine LEGITIM gerettete confirmed_food behält ihren food_rescue-Tag und bleibt sichtbar', () => {
    const rescuedFood = offer('Bratwurst grob', { tags: [FOOD_RESCUE_TAG] } as Partial<Offer>);
    const result = revertStaleRescues({
      offers: [rescuedFood],
      nextWeekOffers: [],
      filteredOffers: [],
    });
    expect(result.revertedCount).toBe(0);
    expect(result.offers.map((o) => o.name)).toEqual(['Bratwurst grob']);
  });

  it('Test 11: eindeutiger Food-Einwortname mit starkem Quellsignal bleibt Food', () => {
    const riesling = offer('Riesling', { sourceCategoryRaw: 'Wein' } as Partial<Offer>);
    expect(classifyFoodDecision(riesling)).toBe('confirmed_food');
    const stillRescued = offer('Riesling', {
      tags: [FOOD_RESCUE_TAG],
      sourceCategoryRaw: 'Wein',
    } as Partial<Offer>);
    const result = revertStaleRescues({ offers: [stillRescued], nextWeekOffers: [], filteredOffers: [] });
    expect(result.revertedCount).toBe(0);
  });
});

// ── P4: Report-Counter-Konsistenz ────────────────────────────────────────────
describe('P4 — Report-Uncertain-Counter sind identisch', () => {
  it('Test 12+13: reviewDimension.uncertain* === foodDecisionSummary.uncertain* (auch mit Lock/Fragment)', () => {
    const buckets = {
      offers: [offer('Grillkäse Natur'), offer('Celebrations', { reviewNeeded: true } as Partial<Offer>)],
      nextWeekOffers: [],
      filteredOffers: [
        offer('Damen BH-Top'), // confirmed_non_food
        offer('Rama'), // uncertain
        offer('Gold'), // uncertain
        // Ein gesperrtes uncertain-Angebot: zählt NICHT als uncertain (Bewegungs-Guard),
        // muss in beiden Dimensionen identisch behandelt werden.
        offer('Celebrations', { aiLocked: true } as Partial<Offer>),
        // Ein Fragment-Quarantäne-Angebot: ebenfalls kein uncertain.
        offer('Tiefpreis', { tags: ['name_fragment'] } as Partial<Offer>),
      ],
    };
    const fd = summarizeFoodDecisions(buckets);
    const rv = summarizeReviewDimension(buckets);
    expect(rv.uncertainFilteredCount).toBe(fd.uncertainFilteredCount);
    expect(rv.uncertainVisibleCount).toBe(fd.uncertainVisibleCount);
    // Konkret: Rama + Gold = 2 uncertain gefiltert; das gesperrte/fragmentierte
    // Angebot zählt in KEINER Dimension als uncertain.
    expect(fd.uncertainFilteredCount).toBe(2);
    expect(fd.uncertainVisibleCount).toBe(1); // Celebrations sichtbar
    // Review-Flag bleibt eine getrennte Dimension.
    expect(rv.unresolvedVisibleReviewCount).toBe(1); // Celebrations sichtbar
  });
});
