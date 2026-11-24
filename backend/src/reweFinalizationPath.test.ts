import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { classifyFoodDecision } from './foodDecision';
import { hasRuleConfirmedNonFoodSignal } from './offersStrictFoodFilter';
import { applyFinalNonFoodGate } from './snapshotNonFoodGate';
import { applyFoodRescuePass, revertStaleRescues } from './snapshotFoodRescue';

// End-to-End-Regression über den REALEN Finalisierungspfad (Task P1), nicht nur
// den isolierten Klassifikator: ein Angebot durchläuft exakt die Pass-Reihenfolge
// aus saveSnapshot (revertStaleRescues → applyFinalNonFoodGate → applyFoodRescuePass)
// und muss am Ende als Food sichtbar bleiben. Konkrete Produktnamen sind reine
// Reproduktions-Fixtures — kein Produktivcode-Allowlist.

const NOW = new Date('2026-06-10T08:00:00.000Z');

function offer(name: string, extra: Partial<Offer> & Record<string, unknown> = {}): Offer {
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
    tags: ['rewe', 'browser-import'],
    createdAt: '2026-06-08T00:00:00.000Z',
    ...extra,
  } as Offer;
}

/** Repliziert die saveSnapshot-Pass-Reihenfolge (rein, ohne IO). */
function runFinalizationPasses(buckets: {
  offers: Offer[];
  nextWeekOffers: Offer[];
  filteredOffers: Offer[];
}): { offers: Offer[]; nextWeekOffers: Offer[]; filteredOffers: Offer[] } {
  const reverted = revertStaleRescues(buckets);
  const gate = applyFinalNonFoodGate(reverted);
  const rescue = applyFoodRescuePass(gate, { now: NOW });
  return {
    offers: rescue.offers,
    nextWeekOffers: rescue.nextWeekOffers,
    filteredOffers: rescue.filteredOffers,
  };
}

describe('P1 — Karottini überlebt den realen Finalisierungspfad als Food', () => {
  // Realer Offer-Shape NACH der Python-Konfliktkorrektur (rule_conflict:cheese):
  // der Name trägt ein Frischkäse-Food-Wort, und die `conflict_kw:*`-Reasons
  // markieren GENAU die FOOD-Keywords, die die Kategorie Richtung Käse korrigiert
  // haben — ein richtungsagnostisches Audit-Signal, KEIN Non-Food-Beleg.
  const realKarottini = (): Offer =>
    offer('Karottini mit Frischkäse-Lauch-Dip', {
      sourceCategoryRaw: 'Schnell und einfach',
      reviewNeeded: true,
      reviewReason: 'rule_conflict,low_confidence',
      foodFlag: 'food',
      canonicalCategory: {
        main: 'Milchprodukte & Eier',
        sub: 'Käse',
        isNonFood: false,
        confidence: 0.5,
        reasons: [
          'rule_conflict:cheese',
          'conflict_kw:kaese',
          'conflict_kw:frischkaese',
          'repair_kw:dip',
          'repair:sauce_keyword',
        ],
      },
    } as Partial<Offer>);

  it('ein conflict_kw:*-Reason ist KEIN regelbestätigtes Non-Food-Signal', () => {
    // conflict_kw markiert das KONFLIKTIERENDE Keyword (hier Food-Richtung Käse) —
    // es darf das Angebot nicht zu Non-Food machen.
    expect(hasRuleConfirmedNonFoodSignal(realKarottini())).toBe(false);
    expect(classifyFoodDecision(realKarottini())).toBe('confirmed_food');
  });

  it('Karottini bleibt nach Gate+Rescue im sichtbaren Feed (nicht filtered)', () => {
    const result = runFinalizationPasses({
      offers: [realKarottini()],
      nextWeekOffers: [],
      filteredOffers: [],
    });
    const visibleNames = [...result.offers, ...result.nextWeekOffers].map((o) => o.name);
    expect(visibleNames).toContain('Karottini mit Frischkäse-Lauch-Dip');
    expect(result.filteredOffers.map((o) => o.name)).not.toContain(
      'Karottini mit Frischkäse-Lauch-Dip',
    );
  });

  it('ein finaler Reparaturschritt darf das bestätigte Food-Signal nicht überschreiben (idempotent)', () => {
    // Selbst wenn ein früherer Lauf das Angebot fälschlich nach filtered geschoben
    // hat (mit nonfood-Tag + repair:final_gate-Stempel), holt der Rescue es zurück,
    // weil das Food-Signal (Frischkäse) bestätigt bleibt.
    const wronglyFiltered = offer('Karottini mit Frischkäse-Lauch-Dip', {
      tags: ['rewe', 'browser-import', 'nonfood'],
      foodFlag: 'nonfood',
      sourceCategoryRaw: 'Schnell und einfach',
      canonicalCategory: {
        main: undefined,
        isNonFood: true,
        reasons: [
          'rule_conflict:cheese',
          'conflict_kw:kaese',
          'conflict_kw:frischkaese',
          'repair:final_gate',
        ],
      },
    } as Partial<Offer>);
    const result = runFinalizationPasses({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [wronglyFiltered],
    });
    const visibleNames = [...result.offers, ...result.nextWeekOffers].map((o) => o.name);
    expect(visibleNames).toContain('Karottini mit Frischkäse-Lauch-Dip');

    // Idempotenz: ein zweiter Durchlauf bewegt nichts mehr.
    const second = runFinalizationPasses(result);
    expect([...second.offers, ...second.nextWeekOffers].map((o) => o.name)).toContain(
      'Karottini mit Frischkäse-Lauch-Dip',
    );
  });

  it('genuines Non-Food über den non_food-Konflikt bleibt nach dem Fix gefiltert (keine Regression)', () => {
    // Der einzige Non-Food-Richtungs-Konflikt: das Keyword ("Reiniger") ist selbst
    // ein strukturelles Non-Food-Wort und wird unabhängig vom conflict_kw-Audit-Tag
    // erkannt.
    const cleaner = offer('Allzweck Reiniger Zitrone', {
      sourceCategoryRaw: 'Haushalt',
      foodFlag: 'nonfood',
      canonicalCategory: {
        main: 'Non-Food',
        sub: 'Haushalt',
        isNonFood: true,
        reasons: ['rule_conflict:non_food', 'conflict_kw:reiniger'],
      },
    } as Partial<Offer>);
    expect(hasRuleConfirmedNonFoodSignal(cleaner)).toBe(true);
    expect(classifyFoodDecision(cleaner)).toBe('confirmed_non_food');
    const result = runFinalizationPasses({
      offers: [cleaner],
      nextWeekOffers: [],
      filteredOffers: [],
    });
    expect([...result.offers, ...result.nextWeekOffers].map((o) => o.name)).not.toContain(
      'Allzweck Reiniger Zitrone',
    );
  });
});
