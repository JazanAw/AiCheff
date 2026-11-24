import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { reassemblePhase2Buckets } from './phase2Reassembly';
import {
  PHASE2_RECHECK_TAG,
  selectUncertainFilteredForPhase2,
  stripPhase2RecheckTag,
} from './offersScanV2';

// Phase-2-Recovery End-to-End (Task P2). Produktnamen sind AUSSCHLIESSLICH
// Reproduktions-Fixtures — kein Produktivcode kennt eine Produkt-/Marken-Allowlist.

const NOW = new Date('2026-06-10T12:00:00.000Z');
const CURRENT = { validityStart: '2026-06-08T00:00:00.000Z', validityEnd: '2026-06-13T23:59:59.000Z' };
const NEXT = { validityStart: '2026-06-15T00:00:00.000Z', validityEnd: '2026-06-20T23:59:59.000Z' };

type FoodVerdict = 'food' | 'nonfood';

function offer(
  id: string,
  name: string,
  verdict: FoodVerdict,
  when = CURRENT,
  extra: Partial<Offer> = {},
): Offer {
  return {
    id,
    name,
    normalizedName: name.toLowerCase(),
    storeChain: 'REWE',
    category: verdict === 'food' ? 'Milchprodukte' : 'Sonstiges',
    price: 1.99,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: when.validityStart,
    validityEnd: when.validityEnd,
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-06-08T00:00:00.000Z',
    ...({
      foodFlag: verdict,
      canonicalCategory: { isNonFood: verdict === 'nonfood' },
    } as Partial<Offer>),
    ...extra,
  } as Offer;
}

function recheck(o: Offer): Offer {
  return { ...o, tags: [...new Set([...(o.tags ?? []), PHASE2_RECHECK_TAG])] };
}

const allIds = (r: { offers: Offer[]; nextWeekOffers: Offer[]; filteredOffers: Offer[] }): string[] => [
  ...r.offers.map((o) => o.id),
  ...r.nextWeekOffers.map((o) => o.id),
  ...r.filteredOffers.map((o) => o.id),
];

const baseInput = {
  now: NOW,
  weekBucketOf: () => 'current' as const,
  isPreserved: () => false,
  maxValidityDays: 21,
};

describe('reassemblePhase2Buckets — Phase-2-Recovery End-to-End', () => {
  it('Szenario 2: KI=confirmed_food (gültig) verschwindet aus filtered und landet GENAU EINMAL in current', () => {
    const oldCopy = offer('cand1', 'Bratwurst grob', 'nonfood'); // alte Filter-Kopie
    const recovered = recheck(offer('cand1', 'Bratwurst grob', 'food', CURRENT)); // KI: Food
    const result = reassemblePhase2Buckets({
      ...baseInput,
      restored: [recovered],
      previousFiltered: [oldCopy],
      skippedNonFood: [],
    });
    expect(result.offers.map((o) => o.id)).toEqual(['cand1']);
    expect(result.nextWeekOffers).toHaveLength(0);
    expect(result.filteredOffers.find((o) => o.id === 'cand1')).toBeUndefined();
    expect(result.phase2RecoveredFoodCount).toBe(1);
  });

  it('Szenario 2b: KI=confirmed_food (nächste Woche) landet GENAU EINMAL in nextWeek', () => {
    const recovered = recheck(offer('cand2', 'Käse Gouda', 'food', NEXT));
    const result = reassemblePhase2Buckets({
      ...baseInput,
      restored: [recovered],
      previousFiltered: [offer('cand2', 'Käse Gouda', 'nonfood')],
      skippedNonFood: [],
    });
    expect(result.nextWeekOffers.map((o) => o.id)).toEqual(['cand2']);
    expect(result.offers).toHaveLength(0);
    expect(result.filteredOffers).toHaveLength(0);
  });

  it('Szenario 3: KI=confirmed_non_food bleibt GENAU EINMAL in filtered und wird nicht sichtbar', () => {
    const confirmed = recheck(offer('cand3', 'Spülmaschinen-Tabs', 'nonfood'));
    const result = reassemblePhase2Buckets({
      ...baseInput,
      restored: [confirmed],
      previousFiltered: [offer('cand3', 'Spülmaschinen-Tabs', 'nonfood')],
      skippedNonFood: [],
    });
    expect(result.filteredOffers.map((o) => o.id)).toEqual(['cand3']);
    expect([...result.offers, ...result.nextWeekOffers]).toHaveLength(0);
    expect(result.phase2ConfirmedNonFoodCount).toBe(1);
  });

  it('Szenario 4: weiterhin uncertain (KI hielt es gefiltert) bleibt EINMAL in filtered mit Review-Grund', () => {
    const stillReview = recheck(
      offer('cand4', 'Unklarer Artikel', 'nonfood', CURRENT, {
        reviewNeeded: true,
        reviewReason: 'ai_uncertain',
      } as Partial<Offer>),
    );
    const result = reassemblePhase2Buckets({
      ...baseInput,
      restored: [stillReview],
      previousFiltered: [offer('cand4', 'Unklarer Artikel', 'nonfood')],
      skippedNonFood: [],
    });
    const inFiltered = result.filteredOffers.filter((o) => o.id === 'cand4');
    expect(inFiltered).toHaveLength(1);
    expect((inFiltered[0] as Offer & { reviewReason?: string }).reviewReason).toBe('ai_uncertain');
  });

  it('Szenario 5: kein Angebot liegt gleichzeitig in mehreren Buckets', () => {
    const result = reassemblePhase2Buckets({
      ...baseInput,
      restored: [
        recheck(offer('a', 'Bratwurst', 'food', CURRENT)),
        recheck(offer('b', 'Wein Riesling', 'food', NEXT)),
        recheck(offer('c', 'Putzmittel', 'nonfood')),
      ],
      previousFiltered: [offer('a', 'Bratwurst', 'nonfood'), offer('c', 'Putzmittel', 'nonfood')],
      skippedNonFood: [offer('d', 'Batterien', 'nonfood')],
    });
    const ids = allIds(result);
    expect(new Set(ids).size).toBe(ids.length); // keine Dublette über Buckets
  });

  it('Szenario 6: Produkt-Key-Follower werden korrekt übernommen (kein Verlust, je einmal)', () => {
    // Repräsentant + Follower (gleiches Produkt, andere id) — beide Food, beide gültig.
    const result = reassemblePhase2Buckets({
      ...baseInput,
      restored: [
        recheck(offer('rep', 'Joghurt Natur 500g', 'food', CURRENT)),
        recheck(offer('follower', 'Joghurt Natur 500g', 'food', CURRENT)),
      ],
      previousFiltered: [],
      skippedNonFood: [],
    });
    expect(result.offers.map((o) => o.id).sort()).toEqual(['follower', 'rep']);
  });

  it('Szenario 7: Resume-Duplikate (gleiche id mehrfach in restored) erzeugen keine Dubletten', () => {
    const dup = recheck(offer('cand7', 'Milch frisch', 'food', CURRENT));
    const result = reassemblePhase2Buckets({
      ...baseInput,
      restored: [dup, { ...dup }], // dieselbe id zweimal (Batch-Überlappung beim Resume)
      previousFiltered: [offer('cand7', 'Milch frisch', 'nonfood')],
      skippedNonFood: [],
    });
    expect(result.offers.filter((o) => o.id === 'cand7')).toHaveLength(1);
    expect(allIds(result)).toEqual(['cand7']);
  });

  it('Szenario 8: Reconciliation ist bei erneutem Lauf idempotent', () => {
    const first = reassemblePhase2Buckets({
      ...baseInput,
      restored: [
        recheck(offer('x', 'Bratwurst', 'food', CURRENT)),
        recheck(offer('y', 'Putzmittel', 'nonfood')),
      ],
      previousFiltered: [offer('x', 'Bratwurst', 'nonfood'), offer('y', 'Putzmittel', 'nonfood')],
      skippedNonFood: [],
    });
    // Wie server.ts: Recheck-Tag vor dem Persistieren entfernen, dann erneut laufen.
    const second = reassemblePhase2Buckets({
      ...baseInput,
      restored: [...first.offers, ...first.nextWeekOffers].map(stripPhase2RecheckTag),
      previousFiltered: first.filteredOffers.map(stripPhase2RecheckTag),
      skippedNonFood: [],
    });
    expect(second.offers.map((o) => o.id).sort()).toEqual(first.offers.map((o) => o.id).sort());
    expect(second.filteredOffers.map((o) => o.id).sort()).toEqual(
      first.filteredOffers.map((o) => o.id).sort(),
    );
    expect(allIds(second).sort()).toEqual(allIds(first).sort());
  });
});

describe('reassemblePhase2Buckets — NextWeek läuft NICHT durch Phase 2', () => {
  it('preservedNextWeek bleibt deep-equal (gleiche Referenz) im NextWeek-Bucket erhalten', () => {
    // NextWeek-Angebot mit bereits vorhandener ProductAnalysis aus einem früheren
    // Scan — Phase 2 darf es NICHT neu anfassen.
    const nw = offer('nw1', 'Käse Gouda', 'food', NEXT, {
      productAnalysis: { halal: true, vegan: false },
    } as Partial<Offer>);
    const result = reassemblePhase2Buckets({
      ...baseInput,
      restored: [recheck(offer('cur1', 'Bratwurst grob', 'food', CURRENT))],
      previousFiltered: [],
      skippedNonFood: [],
      preservedNextWeek: [nw],
    });
    // current wurde verarbeitet, nextWeek nur durchgereicht (gleiche Referenz).
    expect(result.offers.map((o) => o.id)).toEqual(['cur1']);
    expect(result.nextWeekOffers).toHaveLength(1);
    expect(result.nextWeekOffers[0]).toBe(nw); // identische Referenz → deep-equal
    expect(result.nextWeekOffers[0]).toEqual(nw);
    // NextWeek bekommt KEIN phase2_recheck-Tag und landet nie im Filter.
    expect(result.nextWeekOffers[0].tags).not.toContain(PHASE2_RECHECK_TAG);
    expect(result.filteredOffers.find((o) => o.id === 'nw1')).toBeUndefined();
  });

  it('Non-Food im NextWeek-Bucket wird NICHT durch den Phase-2-Non-Food-Gate gefiltert', () => {
    // Selbst ein als nonfood markiertes NextWeek-Angebot bleibt unverändert — der
    // Bucket wird in Phase 2 grundsätzlich nicht neu bewertet.
    const nwNonFood = offer('nw-nf', 'Putzmittel', 'nonfood', NEXT);
    const result = reassemblePhase2Buckets({
      ...baseInput,
      restored: [],
      previousFiltered: [],
      skippedNonFood: [],
      preservedNextWeek: [nwNonFood],
    });
    expect(result.nextWeekOffers.map((o) => o.id)).toEqual(['nw-nf']);
    expect(result.nextWeekOffers[0]).toBe(nwNonFood);
    expect(result.filteredOffers).toHaveLength(0);
  });

  it('Scan mit NUR NextWeek ist für Phase 2 ein No-op (current/filtered leer, NextWeek erhalten)', () => {
    const nw = [
      offer('nwA', 'Joghurt Natur', 'food', NEXT),
      offer('nwB', 'Apfelsaft', 'food', NEXT),
    ];
    const result = reassemblePhase2Buckets({
      ...baseInput,
      restored: [],
      previousFiltered: [],
      skippedNonFood: [],
      preservedNextWeek: nw,
    });
    expect(result.offers).toHaveLength(0);
    expect(result.filteredOffers).toHaveLength(0);
    expect(result.nextWeekOffers).toEqual(nw); // deep-equal, nichts verloren
    expect(result.phase2RecoveredFoodCount).toBe(0);
    expect(result.phase2ConfirmedNonFoodCount).toBe(0);
  });

  it('current/filtered-Recovery läuft weiter, NextWeek getrennt erhalten (keine Bucket-Kollision)', () => {
    const nw = offer('nw9', 'Wein Riesling', 'food', NEXT);
    const recovered = recheck(offer('f1', 'Bratwurst grob', 'food', CURRENT));
    const result = reassemblePhase2Buckets({
      ...baseInput,
      restored: [recovered],
      previousFiltered: [offer('f1', 'Bratwurst grob', 'nonfood')],
      skippedNonFood: [],
      preservedNextWeek: [nw],
    });
    expect(result.offers.map((o) => o.id)).toEqual(['f1']); // filtered gerettet
    expect(result.nextWeekOffers.map((o) => o.id)).toEqual(['nw9']);
    expect(result.phase2RecoveredFoodCount).toBe(1);
    const ids = allIds(result);
    expect(new Set(ids).size).toBe(ids.length); // keine Dublette über Buckets
  });

  it('preserved Manuell-Import: abgelaufenes current wird entfernt, gültiges + NextWeek bleiben', () => {
    // Realer Drift: ein manueller Import (nahkauf NUR als Fixture) hat ein
    // abgelaufenes (valid_to gestern) und ein gültiges current-Angebot. Phase 2
    // darf das abgelaufene NICHT als current zurückgeben, das gültige + das
    // unveränderte NextWeek aber behalten.
    const EXPIRED = { validityStart: '2026-06-01T00:00:00.000Z', validityEnd: '2026-06-09T00:00:00.000Z' };
    const expired = offer('nk_expired', 'Hähnchenbrust', 'food', EXPIRED, {
      storeChain: 'nahkauf',
    } as Partial<Offer>);
    const valid = offer('nk_valid', 'Rinderhack', 'food', CURRENT, {
      storeChain: 'nahkauf',
    } as Partial<Offer>);
    const nw = offer('nk_next', 'Lachsfilet', 'food', NEXT, {
      storeChain: 'nahkauf',
    } as Partial<Offer>);
    const result = reassemblePhase2Buckets({
      ...baseInput,
      isPreserved: (o) => o.storeChain.toLowerCase() === 'nahkauf',
      restored: [expired, valid],
      previousFiltered: [],
      skippedNonFood: [],
      preservedNextWeek: [nw],
    });
    // abgelaufenes Angebot ist aus ALLEN aktiven Buckets verschwunden.
    expect(result.offers.map((o) => o.id)).toEqual(['nk_valid']);
    expect(allIds(result)).not.toContain('nk_expired');
    // NextWeek unverändert (gleiche Referenz, nicht durch Phase 2 angefasst).
    expect(result.nextWeekOffers).toEqual([nw]);
    expect(result.nextWeekOffers[0]).toBe(nw);
  });
});

describe('selectUncertainFilteredForPhase2 — Kandidatenauswahl (P2 Szenario 1 + 9)', () => {
  function filteredOffer(id: string, name: string, extra: Partial<Offer> = {}): Offer {
    return {
      id,
      name,
      normalizedName: name.toLowerCase(),
      storeChain: 'REWE',
      category: '',
      price: 1.99,
      currency: 'EUR',
      unit: 'Stk',
      validityStart: CURRENT.validityStart,
      validityEnd: CURRENT.validityEnd,
      sourceUrl: 'https://example.com',
      tags: [],
      createdAt: '2026-06-08T00:00:00.000Z',
      ...extra,
    } as Offer;
  }

  it('Szenario 1: uncertain-filtered wird als Phase-2-Kandidat ausgewählt (recheck-getaggt)', () => {
    const selection = selectUncertainFilteredForPhase2([
      filteredOffer('u1', 'Celebrations'), // uncertain
      filteredOffer('nf1', 'Ziersalbei'), // confirmed_non_food → skip
    ]);
    expect(selection.candidates.map((o) => o.id)).toEqual(['u1']);
    expect(selection.candidates[0].tags).toContain(PHASE2_RECHECK_TAG);
    expect(selection.skipped.map((o) => o.id)).toContain('nf1');
  });

  it('Szenario 9: menschliche Locks und Learned-Allow behalten Priorität (nie Kandidat)', () => {
    const selection = selectUncertainFilteredForPhase2([
      filteredOffer('locked', 'Celebrations', { aiLocked: true } as Partial<Offer>),
      filteredOffer('allow', 'Rama', { manualOverride: true } as Partial<Offer>),
      filteredOffer('u2', 'Auslese'), // uncertain → echter Kandidat
    ]);
    expect(selection.candidates.map((o) => o.id)).toEqual(['u2']);
    expect(selection.skipped.map((o) => o.id).sort()).toEqual(['allow', 'locked']);
  });
});
