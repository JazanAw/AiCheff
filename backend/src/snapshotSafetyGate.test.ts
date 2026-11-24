import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  evaluateSnapshotSafety,
  preserveBlockedStoreOffers,
  SCAN_STORE_MINIMUMS,
} from './snapshotSafetyGate';
import { findNonFoodLeaks, isStrongNonFoodLeak } from './snapshotNonFoodGate';
import { classifyFoodDecision } from './foodDecision';
import { allStoresScope, scopeFromStores } from './scanV2Scope';

// Scan-2.0 Datenqualität #5: ein Scan darf den produktiven Snapshot NICHT
// ersetzen, wenn er REWE verliert, mehrere große Shops 0 current haben, oder die
// Live-Liste praktisch nur noch aus Zukunfts-/Upcoming-Angeboten besteht.

const NOW = new Date('2026-06-07T04:12:49.000Z'); // Sonntag

function offer(overrides: Partial<Offer> & { id: string; storeChain: string }): Offer {
  return {
    name: overrides.id,
    normalizedName: overrides.id,
    category: 'Sonstiges',
    price: 1.99,
    currency: 'EUR',
    unit: 'Stk',
    // standardmäßig heute gültig (01.06–09.06)
    validityStart: '2026-06-01',
    validityEnd: '2026-06-09',
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  } as Offer;
}

function buckets(offers: Offer[], next: Offer[] = [], filtered: Offer[] = []) {
  return { offers, nextWeekOffers: next, filteredOffers: filtered };
}

/** A believable healthy snapshot: several shops with current live offers. */
function healthy(): Offer[] {
  const out: Offer[] = [];
  for (const chain of ['ALDI NORD', 'ALDI SUED', 'Kaufland', 'Lidl', 'NORMA', 'PENNY']) {
    for (let i = 0; i < 12; i += 1) out.push(offer({ id: `${chain}_${i}`, storeChain: chain }));
  }
  return out;
}

describe('evaluateSnapshotSafety', () => {
  it('lässt einen gesunden Snapshot durch (ok)', () => {
    const previous = buckets(healthy(), [], [offer({ id: 'rewe1', storeChain: 'REWE' })]);
    const candidate = buckets(healthy(), [], [offer({ id: 'rewe1', storeChain: 'REWE' })]);
    const result = evaluateSnapshotSafety({ previous, candidate, now: NOW });
    expect(result.ok).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it('blockt, wenn REWE vorher vorhanden war und danach 0 ist', () => {
    const previous = buckets(
      [...healthy(), offer({ id: 'rewe1', storeChain: 'REWE' }), offer({ id: 'rewe2', storeChain: 'REWE' })],
    );
    const candidate = buckets(healthy()); // REWE komplett weg
    const result = evaluateSnapshotSafety({ previous, candidate, now: NOW });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('excludedStoreLost');
  });

  it('blockt, wenn mehrere große Shops 0 current haben (alles in next)', () => {
    // Kandidat: alle großen Shops haben nur Zukunftsangebote → live leer.
    const future = (chain: string, i: number) =>
      offer({ id: `${chain}_${i}`, storeChain: chain, validityStart: '2026-06-10', validityEnd: '2026-06-16' });
    const futureOffers: Offer[] = [];
    for (const chain of ['ALDI NORD', 'ALDI SUED', 'Kaufland', 'Lidl', 'NORMA', 'PENNY']) {
      for (let i = 0; i < 12; i += 1) futureOffers.push(future(chain, i));
    }
    const previous = buckets(healthy());
    // genau der reale Bug: 765 "live", aber 0 current pro Shop
    const candidate = buckets(futureOffers);
    const result = evaluateSnapshotSafety({ previous, candidate, now: NOW });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('manyLargeShopsZeroCurrent');
  });

  it('blockt, wenn die Live-Liste stark einbricht', () => {
    const previous = buckets(healthy()); // 72 live
    const candidate = buckets([offer({ id: 'x1', storeChain: 'Lidl' })]); // 1 live
    const result = evaluateSnapshotSafety({ previous, candidate, now: NOW });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('liveCollapse');
  });

  it('blockt, wenn preservedExcluded leer ist obwohl vorher REWE existierte (gleicher Check)', () => {
    const previous = buckets([offer({ id: 'rewe1', storeChain: 'nahkauf' }), ...healthy()]);
    const candidate = buckets(healthy());
    const result = evaluateSnapshotSafety({ previous, candidate, now: NOW });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('excludedStoreLost');
  });

  it('meldet keinen Fehlalarm, wenn vorher gar kein REWE existierte', () => {
    const previous = buckets(healthy());
    const candidate = buckets(healthy());
    const result = evaluateSnapshotSafety({ previous, candidate, now: NOW });
    expect(result.failedChecks).not.toContain('excludedStoreLost');
  });
});

describe('evaluateSnapshotSafety — harte Datenqualitaets-Gates (Task 7)', () => {
  const excludedReweOnly = ['REWE'];

  it('blockt, wenn Lidl unter der Mindestmenge liegt (1-Angebot-Scrape)', () => {
    const candidate = buckets([...healthy().filter((o) => o.storeChain !== 'Lidl')]);
    // Lidl hat nur 12 healthy()-Angebote — unter SCAN_STORE_MINIMUMS.lidl faellt
    // erst recht der 1-Angebot-Fall:
    candidate.offers.push(offer({ id: 'lidl_only', storeChain: 'Lidl' }));
    const result = evaluateSnapshotSafety({
      previous: buckets(healthy()),
      candidate,
      now: NOW,
      storeMinimums: SCAN_STORE_MINIMUMS,
      excludedStores: excludedReweOnly,
      requiredStores: [],
    });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('storeBelowMinimum');
  });

  it('laesst Lidl mit genug Angeboten durch', () => {
    const lidlFull: ReturnType<typeof healthy> = [];
    for (let i = 0; i < 80; i += 1) lidlFull.push(offer({ id: `lidl_${i}`, storeChain: 'Lidl' }));
    const candidate = buckets([...healthy(), ...lidlFull]);
    const result = evaluateSnapshotSafety({
      previous: buckets(healthy()),
      candidate,
      now: NOW,
      storeMinimums: SCAN_STORE_MINIMUMS,
      excludedStores: excludedReweOnly,
      requiredStores: [],
    });
    expect(result.failedChecks).not.toContain('storeBelowMinimum');
  });

  it('blockt nahkauf=0 ohne ehrlichen Grund, akzeptiert nahkauf=0 MIT Scrape-Warnung', () => {
    const previous = buckets(healthy());
    const candidate = buckets(healthy()); // kein nahkauf
    const silent = evaluateSnapshotSafety({
      previous,
      candidate,
      now: NOW,
      excludedStores: excludedReweOnly,
      requiredStores: ['nahkauf'],
    });
    expect(silent.ok).toBe(false);
    expect(silent.failedChecks).toContain('requiredStoreEmptyWithoutReason');

    const honest = evaluateSnapshotSafety({
      previous,
      candidate,
      now: NOW,
      excludedStores: excludedReweOnly,
      requiredStores: ['nahkauf'],
      scrapeWarnings: ['nahkauf: Storyblok-Angebote (Seite 1) konnten nicht gelesen werden (403).'],
    });
    expect(honest.failedChecks).not.toContain('requiredStoreEmptyWithoutReason');
  });

  it('blockt, wenn der letzte REWE-Import critical ist', () => {
    const result = evaluateSnapshotSafety({
      previous: buckets(healthy()),
      candidate: buckets(healthy()),
      now: NOW,
      reweImportHealth: 'critical',
    });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('reweImportCritical');
  });

  it('blockt Fragment-Angebote ("Tiefpreis", "Fl.") im sichtbaren Feed', () => {
    const candidate = buckets([
      ...healthy(),
      offer({ id: 'frag1', storeChain: 'REWE', name: 'Tiefpreis' } as never),
      offer({ id: 'frag2', storeChain: 'REWE', name: 'Fl.' } as never),
    ]);
    const result = evaluateSnapshotSafety({
      previous: buckets(healthy()),
      candidate,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('fragmentOffersLive');
    expect(result.reasons.join(' ')).toContain('Tiefpreis');
  });

  it('blockt harte Non-Food-Signale im sichtbaren Feed, plausibles Food bleibt ok', () => {
    const candidate = buckets([
      ...healthy(),
      offer({
        id: 'nf1',
        storeChain: 'Lidl',
        name: 'CRIVIT Allround-SUP, aufblasbar',
        tags: ['nonfood'],
      } as never),
    ]);
    const result = evaluateSnapshotSafety({
      previous: buckets(healthy()),
      candidate,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('nonFoodLive');

    // Plausibles Food (Sonnenblumenkerne) triggert das Gate NICHT.
    const foodCandidate = buckets([
      ...healthy(),
      offer({ id: 'food1', storeChain: 'Lidl', name: 'Sonnenblumenkerne 500 g' } as never),
    ]);
    const foodResult = evaluateSnapshotSafety({
      previous: buckets(healthy()),
      candidate: foodCandidate,
      now: NOW,
    });
    expect(foodResult.failedChecks).not.toContain('nonFoodLive');
  });

  it('blockt klares Non-Food trotz falschem KI-Food-Verdikt (Puppe/Matratze als "Grundnahrungsmittel")', () => {
    // Reproduktions-Fixture: das Modell vergab canonicalCategory.main =
    // "Grundnahrungsmittel" (isNonFood:false) an klares Non-Food — der Gate
    // muss das Domänen-Vokabular (Spielzeug/Möbel) trotzdem erkennen.
    const wrongVerdict = {
      canonicalCategory: { main: 'Grundnahrungsmittel', isNonFood: false, confidence: 0.9 },
    };
    const candidate = buckets([
      ...healthy(),
      offer({ id: 'leak1', storeChain: 'Kaufland', name: 'BABY BORN Puppe', ...wrongVerdict } as never),
      offer({
        id: 'leak2',
        storeChain: 'ALDI SUED',
        name: '7-Zonen-Komfortschaummatratze',
        ...wrongVerdict,
      } as never),
    ]);
    const result = evaluateSnapshotSafety({
      previous: buckets(healthy()),
      candidate,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('nonFoodLive');
    expect(result.reasons.join(' ')).toContain('BABY BORN Puppe');
  });
});

// ---------------------------------------------------------------------------
// nonFoodLive über die ZENTRALE Food-Wahrheit (Task P1/P2/P3): das Safety-Gate
// muss für denselben Kandidaten exakt wie der finale Non-Food-Gate
// (findNonFoodLeaks/isStrongNonFoodLeak → classifyFoodDecision) urteilen. Die
// konkreten Produktnamen sind AUSSCHLIESSLICH Test-Fixtures (Live-Vorfall mit 23
// falsch blockierten Angeboten), KEINE Produktiv-Allowlist.
// ---------------------------------------------------------------------------
describe('evaluateSnapshotSafety — nonFoodLive nutzt die zentrale Wahrheit (P1/P2/P3)', () => {
  // Ein falsches Modell-Verdikt (KI nannte Non-Food "Grundnahrungsmittel" und
  // setzte canonicalCategory.isNonFood=true) — exakt der Live-Auslöser.
  const modelFlag = {
    canonicalCategory: { main: 'Grundnahrungsmittel', isNonFood: true, confidence: 0.9 },
  };

  // Fälle, die NUR wegen falscher KI-Kategorie/Modell-Flag blockiert wurden,
  // aber zentral uncertain sind (KEIN struktureller Regel-Beleg) → dürfen den
  // Gate NICHT mehr auslösen. Bewusst mehrdeutige Namen ohne Produktklassen-
  // Signal — Artikel mit struktureller Non-Food-Klasse (Eisschale/Packtaschen/
  // Kinder-Cap, Task A) sind jetzt confirmed_non_food und blocken korrekt.
  // Bewusst mehrdeutige Namen OHNE strukturelles Food-/Non-Food-Signal — nur ein
  // Modell-Non-Food-Flag. (NICHT „Cerealien Pokémon": das trägt jetzt ein echtes
  // Food-Vokabular-Signal und ist zentral confirmed_food, kein Uncertain-Fall mehr.)
  const FALSE_POSITIVE_NAMES = [
    'Celebrations',
    'Rama',
    'Sonderposten',
    'Gold',
    'Auslese',
    'Markenprodukt',
  ];

  it('blockt NICHT, wenn nur ein Modell-Non-Food-Flag vorliegt (zentral uncertain)', () => {
    const leaks = FALSE_POSITIVE_NAMES.map((name, i) =>
      offer({ id: `fp_${i}`, storeChain: 'Lidl', name, ...modelFlag } as never),
    );
    // Vorbedingung der Fixtures: zentral uncertain (kein Regel-Beleg) — sonst
    // testen wir nicht den Modell-Flag-Fall.
    for (const l of leaks) {
      expect(classifyFoodDecision(l)).toBe('uncertain');
      expect(isStrongNonFoodLeak(l)).toBe(false);
    }
    const candidate = buckets([...healthy(), ...leaks]);
    const result = evaluateSnapshotSafety({ previous: buckets(healthy()), candidate, now: NOW });
    expect(result.failedChecks).not.toContain('nonFoodLive');
    // Parität: der zentrale Final-Gate meldet für dieselben Angebote 0 Leaks.
    expect(findNonFoodLeaks([...healthy(), ...leaks]).count).toBe(0);
    expect(result.examplesByCheck.nonFoodLive).toBeUndefined();
  });

  it('blockt weiterhin, wenn die zentrale Entscheidung confirmed_non_food ist (Regel-Beleg)', () => {
    // Dieselben Namen, aber MIT regelbestätigtem Non-Food-Signal (nonfood-Tag,
    // wie ihn ein Connector setzt) → zentral confirmed_non_food → blockt.
    const confirmed = ['Anti-Mücken-Armbänder »Citronelle«', 'Terra-Schale »Citronella«', 'Terra-Topf »Citronella«']
      .map((name, i) => offer({ id: `cnf_${i}`, storeChain: 'Lidl', name, tags: ['nonfood'] } as never));
    for (const c of confirmed) {
      expect(classifyFoodDecision(c)).toBe('confirmed_non_food');
      expect(isStrongNonFoodLeak(c)).toBe(true);
    }
    const candidate = buckets([...healthy(), ...confirmed]);
    const result = evaluateSnapshotSafety({ previous: buckets(healthy()), candidate, now: NOW });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('nonFoodLive');
    expect(findNonFoodLeaks([...healthy(), ...confirmed]).count).toBe(3);
  });

  it('Safety-Gate und findNonFoodLeaks/isStrongNonFoodLeak urteilen für dieselben Angebote identisch', () => {
    const flagged = offer({ id: 'm1', storeChain: 'Lidl', name: 'Celebrations', ...modelFlag } as never); // uncertain (nur Modell-Flag)
    const confirmed = offer({ id: 'm2', storeChain: 'Lidl', name: 'Terra-Topf »Citronella«', tags: ['nonfood'] } as never);
    const food = offer({ id: 'm3', storeChain: 'Lidl', name: 'Sonnenblumenkerne 500 g' } as never);
    const visible = [flagged, confirmed, food];
    const candidate = buckets([...healthy(), ...visible]);
    const result = evaluateSnapshotSafety({ previous: buckets(healthy()), candidate, now: NOW });
    const central = findNonFoodLeaks([...healthy(), ...visible]);
    // Gate-Verdikt == Final-Gate-Verdikt (nonFoodLive feuert genau dann, wenn der
    // zentrale Gate einen Leak sieht).
    expect(result.failedChecks.includes('nonFoodLive')).toBe(central.count > 0);
    expect(central.count).toBe(1);
    expect(visible.filter(isStrongNonFoodLeak).map((o) => o.id)).toEqual(['m2']);
  });

  it('liefert begrenzte nonFoodLive-Beispiele (direkt gesammelt) und keine bei Erfolg (Task P3)', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      offer({ id: `nf_${i}`, storeChain: 'Lidl', name: `Non-Food Artikel ${i}`, tags: ['nonfood'] } as never),
    );
    const result = evaluateSnapshotSafety({
      previous: buckets(healthy()),
      candidate: buckets([...healthy(), ...many]),
      now: NOW,
    });
    expect(result.failedChecks).toContain('nonFoodLive');
    // Begrenzt (6–8) und direkt aus den blockierenden Angeboten — kein Reparsen.
    expect(result.examplesByCheck.nonFoodLive?.length).toBeGreaterThan(0);
    expect(result.examplesByCheck.nonFoodLive?.length).toBeLessThanOrEqual(8);
    expect(result.examples.length).toBeLessThanOrEqual(8);
    expect(result.examples.every((name) => name.startsWith('Non-Food Artikel'))).toBe(true);

    const okRun = evaluateSnapshotSafety({
      previous: buckets(healthy()),
      candidate: buckets(healthy()),
      now: NOW,
    });
    expect(okRun.ok).toBe(true);
    expect(okRun.examples).toEqual([]);
    expect(okRun.examplesByCheck).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Scope-aware gate (Angebots-Scan 2.0): ein REWE-only-Phase-2-Lauf darf nicht
// an fehlenden Lidl-/nahkauf-Daten scheitern, ein echter All-Store-Scan aber
// weiterhin schon. excludedStores spiegelt die Produktionskonfiguration: nur
// REWE ist manueller Import; nahkauf gilt als web-gescannter Pflicht-Shop.
// ---------------------------------------------------------------------------
describe('evaluateSnapshotSafety — scope-aware (Scan V2)', () => {
  const PROD_EXCLUDED = ['REWE']; // wie WEEKLY_SCAN_EXCLUDED_STORES default
  const reweScope = scopeFromStores(['REWE']);

  function rewe(n: number, prefix: string): Offer[] {
    return Array.from({ length: n }, (_, i) =>
      offer({ id: `${prefix}_${i}`, storeChain: 'REWE', name: `REWE Produkt ${prefix} ${i}` } as never),
    );
  }
  function lidl(n: number): Offer[] {
    return Array.from({ length: n }, (_, i) =>
      offer({ id: `lidl_${i}`, storeChain: 'Lidl', name: `Lidl Produkt ${i}` } as never),
    );
  }

  const gateArgs = {
    now: NOW,
    excludedStores: PROD_EXCLUDED,
    storeMinimums: SCAN_STORE_MINIMUMS, // { lidl: 40 }
    requiredStores: ['nahkauf'],
  };

  it('1) REWE-only Phase 2 mit 105 REWE-Angeboten: Lidl/nahkauf fehlen → Gate besteht', () => {
    const previous = buckets(rewe(89, 'live'), [], rewe(16, 'filt'));
    // Bucket-Verschiebung: 90 live + 15 gefiltert, scoped Gesamtmenge bleibt 105.
    const candidate = buckets(
      [...rewe(89, 'live'), offer({ id: 'filt_0', storeChain: 'REWE', name: 'REWE X' } as never)],
      [],
      rewe(15, 'filt2'),
    );
    const result = evaluateSnapshotSafety({ ...gateArgs, previous, candidate, scope: reweScope });
    expect(result.ok).toBe(true);
    expect(result.failedChecks).toEqual([]);
    expect(result.scope.checkedStores).toEqual(['rewe']);
  });

  it('2) REWE-only Phase 2 mit echtem REWE-Verlust → Gate schlägt fehl (scopedOfferLoss)', () => {
    const previous = buckets(rewe(89, 'live'), [], rewe(16, 'filt')); // 105
    const candidate = buckets(rewe(60, 'live')); // 60 — stiller Verlust
    const result = evaluateSnapshotSafety({ ...gateArgs, previous, candidate, scope: reweScope });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('scopedOfferLoss');
  });

  it('3) All-Store-Scan mit Lidl unter Minimum → Gate schlägt weiterhin fehl', () => {
    const candidate = buckets([...healthy().filter((o) => o.storeChain !== 'Lidl'), ...lidl(1)]);
    const result = evaluateSnapshotSafety({
      ...gateArgs,
      previous: buckets(healthy()),
      candidate,
      scope: allStoresScope(),
    });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('storeBelowMinimum');
  });

  it('4) All-Store-Scan mit nahkauf=0 ohne Grund → Gate schlägt weiterhin fehl', () => {
    const candidate = buckets([...healthy(), ...lidl(80)]); // genug Lidl, aber kein nahkauf
    const result = evaluateSnapshotSafety({
      ...gateArgs,
      previous: buckets(healthy()),
      candidate,
      scope: allStoresScope(),
    });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('requiredStoreEmptyWithoutReason');
  });

  it('5) Expliziter Scope ["REWE","Lidl"]: beide geprüft, nahkauf nicht', () => {
    const scope = scopeFromStores(['REWE', 'Lidl']);
    // genug Lidl + REWE, kein nahkauf → besteht (nahkauf out of scope).
    const okResult = evaluateSnapshotSafety({
      ...gateArgs,
      previous: buckets([...rewe(20, 'p'), ...lidl(80)]),
      candidate: buckets([...rewe(20, 'p'), ...lidl(80)]),
      scope,
    });
    expect(okResult.ok).toBe(true);
    expect(okResult.failedChecks).not.toContain('requiredStoreEmptyWithoutReason');

    // Lidl im Scope unter Minimum → storeBelowMinimum feuert (Lidl WIRD geprüft).
    const lidlLow = evaluateSnapshotSafety({
      ...gateArgs,
      previous: buckets([...rewe(20, 'p'), ...lidl(80)]),
      candidate: buckets([...rewe(20, 'p'), ...lidl(1)]),
      scope,
    });
    expect(lidlLow.failedChecks).toContain('storeBelowMinimum');
  });

  it('6) Gemischter Snapshot, Phase 2 nur für REWE: fremde Shops unverändert, Gate prüft REWE', () => {
    const previous = buckets([...rewe(89, 'live'), ...lidl(50)], [], rewe(16, 'filt'));
    // REWE bucket-shift (Gesamt 105 bleibt), Lidl unverändert mitgeführt.
    const candidate = buckets(
      [...rewe(90, 'live2'), ...lidl(50)],
      [],
      rewe(15, 'filt2'),
    );
    const result = evaluateSnapshotSafety({ ...gateArgs, previous, candidate, scope: reweScope });
    expect(result.ok).toBe(true);
    expect(result.scope.checkedStores).toEqual(['rewe']);
    expect(result.scope.skippedStores).toContain('lidl');
  });

  it('9) Leerer Kandidaten-Snapshot innerhalb des REWE-Scopes → Gate schlägt fehl', () => {
    const previous = buckets(rewe(89, 'live'), [], rewe(16, 'filt'));
    const candidate = buckets([], [], []);
    const result = evaluateSnapshotSafety({ ...gateArgs, previous, candidate, scope: reweScope });
    expect(result.ok).toBe(false);
    // sowohl der manuelle-Import-Verlust als auch der scoped Gesamtverlust greifen.
    expect(result.failedChecks).toContain('excludedStoreLost');
    expect(result.failedChecks).toContain('scopedOfferLoss');
  });

  it('10) Bucket-Verschiebung ohne Mengenverlust → Gate besteht', () => {
    const previous = buckets(rewe(50, 'live'), rewe(30, 'next'), rewe(25, 'filt')); // 105
    const candidate = buckets(rewe(70, 'live'), rewe(10, 'next'), rewe(25, 'filt')); // 105
    const result = evaluateSnapshotSafety({ ...gateArgs, previous, candidate, scope: reweScope });
    expect(result.ok).toBe(true);
    expect(result.failedChecks).toEqual([]);
  });

  it('12) Mindestwerte/Pflicht-Shops außerhalb des Scopes beeinflussen das Ergebnis nicht', () => {
    const previous = buckets(rewe(89, 'live'), [], rewe(16, 'filt'));
    const candidate = buckets(rewe(89, 'live'), [], rewe(16, 'filt'));
    const result = evaluateSnapshotSafety({
      ...gateArgs,
      previous,
      candidate,
      scope: reweScope,
      storeMinimums: { lidl: 40, kaufland: 40, penny: 30 },
      requiredStores: ['nahkauf', 'penny'],
    });
    expect(result.ok).toBe(true);
    expect(result.failedChecks).toEqual([]);
  });

  it('13) Das Safety-Gate mutiert weder vorherigen noch Kandidaten-Snapshot', () => {
    const previous = buckets(rewe(89, 'live'), [], rewe(16, 'filt'));
    const candidate = buckets(rewe(60, 'live')); // löst Verlust aus, prüft Mutation
    const prevSnapshot = structuredClone(previous);
    const candSnapshot = structuredClone(candidate);
    evaluateSnapshotSafety({ ...gateArgs, previous, candidate, scope: reweScope });
    expect(previous).toEqual(prevSnapshot);
    expect(candidate).toEqual(candSnapshot);
  });
});

describe('preserveBlockedStoreOffers (EDEKA-Schutz P4)', () => {
  it('behält vorhandenen EDEKA-Bestand, wenn die Quelle blockiert war und 0 lieferte', () => {
    const previous = buckets(
      [offer({ id: 'e1', storeChain: 'EDEKA' }), offer({ id: 'e2', storeChain: 'EDEKA' })],
      [offer({ id: 'e3', storeChain: 'EDEKA' })],
      [offer({ id: 'e4', storeChain: 'EDEKA' })],
    );
    const candidate = buckets(
      [offer({ id: 'k1', storeChain: 'Kaufland' })],
      [],
      [],
    );
    const result = preserveBlockedStoreOffers({
      previous,
      candidate,
      storeChain: 'EDEKA',
      blocked: true,
    });
    expect(result.preserved).toBe(true);
    expect(result.preservedCount).toBe(4);
    expect(result.buckets.offers.map((o) => o.id).sort()).toEqual(['e1', 'e2', 'k1']);
    expect(result.buckets.nextWeekOffers.map((o) => o.id)).toEqual(['e3']);
    expect(result.buckets.filteredOffers.map((o) => o.id)).toEqual(['e4']);
  });

  it('lässt den Kandidaten unverändert, wenn EDEKA NICHT blockiert war (echter Leerstand bleibt 0)', () => {
    const previous = buckets([offer({ id: 'e1', storeChain: 'EDEKA' })]);
    const candidate = buckets([offer({ id: 'k1', storeChain: 'Kaufland' })]);
    const result = preserveBlockedStoreOffers({
      previous,
      candidate,
      storeChain: 'EDEKA',
      blocked: false,
    });
    expect(result.preserved).toBe(false);
    expect(result.buckets).toBe(candidate);
  });

  it('greift nicht, wenn der neue Lauf EDEKA-Angebote geliefert hat', () => {
    const previous = buckets([offer({ id: 'e1', storeChain: 'EDEKA' })]);
    const candidate = buckets([offer({ id: 'e2', storeChain: 'EDEKA' })]);
    const result = preserveBlockedStoreOffers({
      previous,
      candidate,
      storeChain: 'EDEKA',
      blocked: true,
    });
    expect(result.preserved).toBe(false);
    expect(result.buckets.offers.map((o) => o.id)).toEqual(['e2']);
  });
});

describe('evaluateSnapshotSafety — deaktivierte Shops (ALDI SÜD/NORD, Lidl, EDEKA)', () => {
  const DISABLED = ['ALDI SÜD', 'ALDI NORD', 'Lidl', 'EDEKA'];

  // Ein gesunder Snapshot OHNE die deaktivierten Shops (nur weiterlaufende Quellen).
  function healthyWithoutDisabled(): Offer[] {
    const out: Offer[] = [];
    for (const chain of ['Kaufland', 'NORMA', 'PENNY', 'Netto']) {
      for (let i = 0; i < 12; i += 1) out.push(offer({ id: `${chain}_${i}`, storeChain: chain }));
    }
    return out;
  }

  // Bestand der deaktivierten Shops (inkl. EDEKA), der beim Scan entfernt wird.
  function disabledStock(): Offer[] {
    const out: Offer[] = [];
    for (const chain of ['EDEKA']) {
      for (let i = 0; i < 12; i += 1) out.push(offer({ id: `${chain}_${i}`, storeChain: chain }));
    }
    return out;
  }

  it('blockt NICHT, wenn ein Scan ALDI SÜD/NORD + Lidl + EDEKA entfernt (per Policy deaktiviert)', () => {
    // Vorher: gesunder Snapshot inkl. ALDI/Lidl/EDEKA-Bestand. Nachher: dieselben
    // weiterlaufenden Shops ohne ALDI/Lidl/EDEKA (bewusst deaktiviert + gepurged).
    const previous = buckets([...healthyWithoutDisabled(), ...disabledStock(), ...healthy()]);
    const candidate = buckets(healthyWithoutDisabled());
    const result = evaluateSnapshotSafety({ previous, candidate, now: NOW, disabledStores: DISABLED });
    expect(result.ok).toBe(true);
    expect(result.failedChecks).not.toContain('manyLargeShopsZeroCurrent');
    expect(result.failedChecks).not.toContain('storeBelowMinimum');
    expect(result.failedChecks).not.toContain('liveCollapse');
    // Die deaktivierten Shops tauchen weder als checked noch als skipped auf —
    // sie existieren für das Gate nicht mehr.
    expect(result.scope.checkedStores).not.toContain('lidl');
    expect(result.scope.skippedStores).not.toContain('lidl');
    // EDEKA darf nicht als kritischer/geprüfter Shop auftauchen.
    expect(result.scope.checkedStores).not.toContain('edeka');
    expect(result.scope.skippedStores).not.toContain('edeka');
  });

  it('löst KEIN storeBelowMinimum für Lidl aus, auch wenn ein Lidl-Minimum gesetzt ist', () => {
    const previous = buckets([...healthyWithoutDisabled(), ...healthy()]);
    const candidate = buckets(healthyWithoutDisabled());
    const result = evaluateSnapshotSafety({
      previous,
      candidate,
      now: NOW,
      disabledStores: DISABLED,
      storeMinimums: SCAN_STORE_MINIMUMS, // { lidl: 40 }
    });
    expect(result.ok).toBe(true);
    expect(result.failedChecks).not.toContain('storeBelowMinimum');
  });

  it('schützt weiterlaufende Shops weiterhin: REWE-Verlust blockt unverändert', () => {
    const previous = buckets(healthyWithoutDisabled(), [], [offer({ id: 'rewe1', storeChain: 'REWE' })]);
    // Kandidat verliert REWE (kein Preserve) — muss weiterhin blocken.
    const candidate = buckets(healthyWithoutDisabled());
    const result = evaluateSnapshotSafety({ previous, candidate, now: NOW, disabledStores: DISABLED });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('excludedStoreLost');
  });
});
