import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { evaluateFoodReconciliation } from './foodDecision';
import { allStoresScope, scopeFromStores } from './scanV2Scope';

// Blockierendes Qualitäts-Gate (Task P1). Produktnamen sind AUSSCHLIESSLICH
// Reproduktions-Fixtures — der Produktivcode kennt keine Produkt-/Marken-Allowlist.

function offer(name: string, extra: Partial<Offer> = {}): Offer {
  return {
    id: `id_${name}_${extra.storeChain ?? 'REWE'}`,
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

describe('evaluateFoodReconciliation — blockierendes Pre-Commit-Gate', () => {
  it('Test 1: zeitlich gültiges confirmed_food im Filter blockiert den Commit', () => {
    const result = evaluateFoodReconciliation({ filteredOffers: [offer('Bratwurst grob')] });
    expect(result.ok).toBe(false);
    expect(result.wrongFoodFilteredCount).toBe(1);
    expect(result.failedChecks).toEqual(['foodLeftInFilter']);
  });

  it('Test 2: die Eingabe-Buckets werden nicht mutiert (alter Snapshot bleibt unverändert)', () => {
    const filteredOffers = [offer('Bratwurst grob')];
    const snapshot = [...filteredOffers];
    const result = evaluateFoodReconciliation({ filteredOffers });
    expect(result.ok).toBe(false);
    // Keine In-Place-Mutation: das Gate verschiebt nichts, es meldet nur.
    expect(filteredOffers).toEqual(snapshot);
    expect(filteredOffers).toHaveLength(1);
  });

  it('Test 3: uncertain im Filter blockiert NICHT (nur Diagnose)', () => {
    const result = evaluateFoodReconciliation({
      filteredOffers: [offer('Celebrations'), offer('Rama')],
    });
    expect(result.ok).toBe(true);
    expect(result.wrongFoodFilteredCount).toBe(0);
    expect(result.uncertainFilteredCount).toBe(2);
  });

  it('Test 4: confirmed_non_food im Filter blockiert NICHT (korrekt gefiltert)', () => {
    const result = evaluateFoodReconciliation({
      filteredOffers: [offer('Ziersalbei'), offer('GIN TONIC Damen-Slipper'), offer('Pizzamaker')],
    });
    expect(result.ok).toBe(true);
    expect(result.wrongFoodFilteredCount).toBe(0);
  });

  it('Test 5: abgelaufenes confirmed_food blockiert NICHT (nie reanimiert)', () => {
    const result = evaluateFoodReconciliation(
      { filteredOffers: [offer('Bratwurst grob')] },
      { isTimeValid: () => false },
    );
    expect(result.ok).toBe(true);
    expect(result.wrongFoodFilteredCount).toBe(0);
  });

  it('Fragment-Quarantäne und menschliche Locks blockieren NICHT', () => {
    const fragment = offer('Tiefpreis', { tags: ['name_fragment'] });
    const locked = offer('Bratwurst grob', { aiLocked: true } as Partial<Offer>);
    const result = evaluateFoodReconciliation({ filteredOffers: [fragment, locked] });
    expect(result.ok).toBe(true);
  });

  it('Test 6: expliziter Shop-Scope berücksichtigt nur diesen Shop', () => {
    const filteredOffers = [
      offer('Bratwurst grob', { storeChain: 'Lidl' }), // gültiges Food bei Lidl
    ];
    // REWE-only-Scope: Lidl ist out-of-scope ⇒ nicht geprüft ⇒ Commit erlaubt.
    const reweOnly = evaluateFoodReconciliation({ filteredOffers }, { scope: scopeFromStores(['REWE']) });
    expect(reweOnly.ok).toBe(true);
    // Lidl-Scope: jetzt in-scope ⇒ blockiert.
    const lidlScope = evaluateFoodReconciliation({ filteredOffers }, { scope: scopeFromStores(['Lidl']) });
    expect(lidlScope.ok).toBe(false);
    expect(lidlScope.wrongFoodFilteredCount).toBe(1);
  });

  it('Test 7: all_stores prüft alle Shops', () => {
    const result = evaluateFoodReconciliation(
      {
        filteredOffers: [
          offer('Bratwurst grob', { storeChain: 'Lidl' }),
          offer('Grillkäse Natur', { storeChain: 'REWE' }),
        ],
      },
      { scope: allStoresScope() },
    );
    expect(result.ok).toBe(false);
    expect(result.wrongFoodFilteredCount).toBe(2);
  });

  it('Test 8: Fehlerdiagnose enthält Count und begrenzte Beispiele', () => {
    const filteredOffers = Array.from({ length: 20 }, (_, i) =>
      offer(`Bratwurst grob ${i}`, { id: `bw_${i}` } as Partial<Offer>),
    );
    const result = evaluateFoodReconciliation({ filteredOffers }, { maxExamples: 5 });
    expect(result.ok).toBe(false);
    expect(result.wrongFoodFilteredCount).toBe(20);
    expect(result.wrongFoodFilteredExamples).toHaveLength(5); // begrenzt
    expect(result.reasons[0]).toContain('20');
  });
});
