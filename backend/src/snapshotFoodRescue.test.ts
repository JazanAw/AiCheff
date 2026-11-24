import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import { isStrongNonFoodLeak } from './snapshotNonFoodGate';
import {
  applyFoodRescuePass,
  classifyFilteredOfferForRescue,
  partitionFilteredOffersForCompleteness,
  FOOD_RESCUE_REASON,
  FOOD_RESCUE_REVIEW_REASON,
  FOOD_RESCUE_TAG,
} from './snapshotFoodRescue';

// Finaler Food-Rescue-Pass (Gegenstück zum Non-Food-Gate): echte Lebensmittel,
// die das Modell fälschlich als Non-Food in `filteredOffers` einsortiert hat,
// werden regelbasiert zurück in die sichtbaren Buckets verschoben. Klares
// Non-Food bleibt gefiltert; unsichere Fälle werden NIE blind gerettet, sondern
// reviewNeeded markiert. Produktnamen hier sind reine Reproduktions-Fixtures
// (z. B. die real beobachteten Kaufland-Fälle), keine Produktivlisten.

const NOW = new Date('2026-06-10T12:00:00.000Z');

function offer(overrides: Partial<Offer> & { id: string; name: string }): Offer {
  return {
    normalizedName: overrides.name.toLowerCase(),
    storeChain: 'Kaufland',
    category: 'Sonstiges',
    price: 2.99,
    currency: 'EUR',
    unit: 'Stk',
    validityStart: '2026-06-08T00:00:00.000Z',
    validityEnd: '2026-06-13T23:59:59.000Z',
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-06-08T00:00:00.000Z',
    ...overrides,
  } as Offer;
}

/** Das reale Fehlerbild: echtes Food mit halluziniertem Modell-Non-Food-Verdikt. */
function modelNonFood(
  id: string,
  name: string,
  extra: Partial<Offer> = {},
): Offer {
  return offer({
    id,
    name,
    ...({
      foodFlag: 'nonfood',
      canonicalCategory: { isNonFood: true, confidence: 0.7 },
    } as Partial<Offer>),
    ...extra,
  });
}

describe('classifyFilteredOfferForRescue', () => {
  it('rettet echte Lebensmittel trotz Modell-Non-Food-Verdikt', () => {
    const cases: Array<[string, Partial<Offer>]> = [
      ['Surimi Sticks', {}],
      ['Garnelen geschält', {}],
      ['Bratmaxe Saftige Bratwurst', {}],
      ['Burger Patties vom Rind', {}],
      ['Cottage Cheese körnig', {}],
      ['Körniger Frischkäse', {}],
      ['Steinofen-Pizza Salami', {}],
      ['Spirelli Nudeln', {}],
      ['Konfitüre Erdbeere', {}],
      ['Brotaufstrich Paprika', {}],
      ['Dallmayr Kaffeepads Classic', {}],
      // Kompositum-Regression: echter Sekt/Reis bleibt rettbar, obwohl
      // 'sekt'/'reis' in Insekt/Preis/Reise NICHT mehr treffen dürfen.
      ['Winzersekt halbtrocken', {}],
      ['Milchreis Vanille', {}],
      // 'milch' bleibt als echtes Food-Signal rettbar (Voll-/Buttermilch),
      // obwohl Drogerie-Komposita (Scheuer-/Sonnenmilch) hart blocken.
      ['Frische Vollmilch 3,8 %', {}],
      ['Buttermilch Natur', {}],
    ];
    for (const [name, extra] of cases) {
      expect(
        classifyFilteredOfferForRescue(modelNonFood(`r_${name}`, name, extra)),
        name,
      ).toBe('rescue');
    }
  });

  it('laesst klares Non-Food gefiltert (Regel-Signale gewinnen)', () => {
    for (const name of [
      'Spülmittel Ultra',
      'Weichspüler April-Frisch',
      'Deospray Sensitive',
      'Kinder-Sweatshirt',
      'BABY BORN Puppe',
      'ADIDAS WM 2026 Match Ball',
      'Wasserkocher Edelstahl',
      'Akku-Staubsauger',
      '7-Zonen-Komfortschaummatratze',
      'Hochflor-Teppich',
      'Auto-Organizer',
      'Kinder-Badeshorts »Sonic«',
      'Kinder-Badeponcho, Rosa, 122/128',
      'GARDENA Wasserstop 1/2 bis 5/8 Zoll',
      // Deutsche Komposita, die Food-Substrings enthalten (sekt/wasser/rind):
      'ECOMED Insektenstichheiler »IB-50E«',
      'Insektenabwehrfalle',
      'Insektenstich Kühlgel',
      'Wasserball »Paw Patrol«',
      'IMAGINEW Silikon-Wasserballons',
      'Vollrind-Ledergürtel',
    ]) {
      expect(classifyFilteredOfferForRescue(modelNonFood(`k_${name}`, name)), name).toBe('keep');
    }
  });

  it('blockt Reinigungs-/Drogerie-Domäne hart (Scheuermilch-Fall, nie rescue)', () => {
    // Real beobachtet: PENNY "VISS Scheuermilch" wurde über den 'milch'-Substring
    // gerettet. Drogerie-/Haushalts-Signale müssen den Food-Rescue blocken.
    for (const name of [
      'VISS Scheuermilch',
      'Scheuermilch Zitrone',
      'Scheuerpulver Classic',
      'Spülmittel Ultra Konzentrat',
      'Weichspüler Frühlingsfrische',
      'Hygiene-Spüler Eukalyptus',
      'Hygienespüler Sensitive',
      'Sonnenmilch LSF 50',
      'Reinigungsmilch Sensitive',
      'Allzweckreiniger Citrus',
    ]) {
      expect(classifyFilteredOfferForRescue(modelNonFood(`clean_${name}`, name)), name).toBe(
        'keep',
      );
    }
  });

  it('hartes Non-Food gewinnt auch gegen eine Food-Quellabteilung', () => {
    const misfiled = modelNonFood('hardsrc1', 'VISS Scheuermilch', {
      sourceCategoryRaw: 'Kühlung',
    } as Partial<Offer>);
    expect(classifyFilteredOfferForRescue(misfiled)).toBe('keep');
  });

  it('rettet Fragment-/Promo-/Beschreibungsnamen nie, auch nicht per Quellabteilung', () => {
    // Real beobachtet: REWE "individuell kombinierbar kernlos" (Beschreibungszeile
    // einer Trauben-Karte) und "l-Dose" (Verpackungs-OCR-Fragment).
    for (const name of [
      'individuell kombinierbar kernlos',
      'l-Dose',
      'Liter',
      'Tiefpreis',
      'Märkte & Angebote',
    ]) {
      const fragment = modelNonFood(`frag_${name}`, name, {
        sourceCategoryRaw: 'Obst & Gemüse',
      } as Partial<Offer>);
      expect(classifyFilteredOfferForRescue(fragment), name).toBe('keep');
    }
  });

  it('vertraut nie dem einfachen category-Feld (Scraper-Reste retten nicht)', () => {
    // Real beobachtet: Non-Food mit übrig gebliebener Food-Kategorie aus dem
    // Scrape ("Snacks/Süßes" auf Badeshorts, "Trockenware" auf Packtaschen).
    const junkCategory = modelNonFood('jc1', 'Reise-Packtaschen-Set, Beutelset, Schwarz', {
      category: 'Trockenware',
    });
    // Die übrig gebliebene Food-Kategorie "Trockenware" darf das Angebot NIE
    // retten. „Packtaschen-Set" ist zudem eine generische Non-Food-Produktklasse
    // (Task A) ⇒ confirmed_non_food ⇒ 'keep'; nie 'rescue'.
    expect(classifyFilteredOfferForRescue(junkCategory)).not.toBe('rescue');
    expect(classifyFilteredOfferForRescue(junkCategory)).toBe('keep');
  });

  it('rettet ueber die Haendler-Quellabteilung (sourceCategoryRaw)', () => {
    // Echter Produktname ohne Keyword-Treffer — nur die Quellabteilung rettet.
    const fromKuehlung = modelNonFood('src1', 'GAZi Sucuk', {
      sourceCategoryRaw: 'Kühlung',
    } as Partial<Offer>);
    expect(classifyFilteredOfferForRescue(fromKuehlung)).toBe('rescue');
  });

  it('rettet Fragment-Namen ohne Produktidentitaet nie ("Liter")', () => {
    const fragmentName = modelNonFood('fragname1', 'Liter', {
      sourceCategoryRaw: 'Kühlung',
    } as Partial<Offer>);
    expect(classifyFilteredOfferForRescue(fragmentName)).toBe('keep');
  });

  it('respektiert den Connector-nonfood-Tag auch ohne Keyword-Treffer', () => {
    const tagged = modelNonFood('tag1', 'Fußball Gr. 5', { tags: ['nonfood'] });
    expect(classifyFilteredOfferForRescue(tagged)).toBe('keep');
  });

  it('markiert signal-lose Faelle als review statt blind zu retten', () => {
    expect(classifyFilteredOfferForRescue(modelNonFood('u1', 'Mystery Artikel 3000'))).toBe(
      'review',
    );
  });

  it('verschiebt editorial gesperrte/manuell geprüfte Angebote nie', () => {
    const locked = modelNonFood('lock1', 'Bratmaxe Saftige Bratwurst', {
      manualOverride: true,
    } as Partial<Offer>);
    expect(classifyFilteredOfferForRescue(locked)).toBe('keep');
  });

  it('rettet Fragment-Quarantäne nie (name_fragment bleibt filtered)', () => {
    const fragment = modelNonFood('frag1', 'Joghurt', {
      tags: ['name_fragment', 'reviewNeeded'],
    });
    expect(classifyFilteredOfferForRescue(fragment)).toBe('keep');
  });
});

describe('applyFoodRescuePass', () => {
  it('verschiebt gerettete aktuelle Angebote nach offers, kommende nach nextWeekOffers', () => {
    const current = modelNonFood('cur1', 'Surimi Sticks');
    const upcoming = modelNonFood('next1', 'Steinofen-Pizza Salami', {
      validityStart: '2026-06-15T00:00:00.000Z',
      validityEnd: '2026-06-20T23:59:59.000Z',
    });
    const nonFood = modelNonFood('keep1', 'Spülmittel Ultra');

    const result = applyFoodRescuePass(
      { offers: [], nextWeekOffers: [], filteredOffers: [current, upcoming, nonFood] },
      { now: NOW },
    );

    expect(result.offers.map((o) => o.id)).toEqual(['cur1']);
    expect(result.nextWeekOffers.map((o) => o.id)).toEqual(['next1']);
    expect(result.filteredOffers.map((o) => o.id)).toEqual(['keep1']);
    expect(result.rescuedCount).toBe(2);
    expect(result.rescuedToCurrentCount).toBe(1);
    expect(result.rescuedToNextCount).toBe(1);
    expect(result.rescuedExamples).toContain('Surimi Sticks');
    expect(result.rescuedExamples).toContain('Steinofen-Pizza Salami');
  });

  it('nutzt bei fehlenden Datums-Signalen die injizierte Wochenlogik', () => {
    const dateless = modelNonFood('dl1', 'Konfitüre Erdbeere', {
      validityStart: undefined,
      validityEnd: undefined,
    });

    const result = applyFoodRescuePass(
      { offers: [], nextWeekOffers: [], filteredOffers: [dateless] },
      { now: NOW, weekBucketOf: () => 'next' },
    );

    expect(result.offers).toHaveLength(0);
    expect(result.nextWeekOffers.map((o) => o.id)).toEqual(['dl1']);
  });

  it('reanimiert abgelaufene Angebote nicht (bleiben filtered)', () => {
    const expired = modelNonFood('exp1', 'Surimi Sticks', {
      validityStart: '2026-05-25T00:00:00.000Z',
      validityEnd: '2026-06-01T23:59:59.000Z',
    });

    const result = applyFoodRescuePass(
      { offers: [], nextWeekOffers: [], filteredOffers: [expired] },
      { now: NOW },
    );

    expect(result.offers).toHaveLength(0);
    expect(result.nextWeekOffers).toHaveLength(0);
    expect(result.filteredOffers.map((o) => o.id)).toEqual(['exp1']);
    expect(result.rescuedCount).toBe(0);
  });

  it('markiert gerettete Angebote ehrlich und ohne Ping-Pong mit dem Non-Food-Gate', () => {
    const rescuedSource = modelNonFood('mark1', 'Bratmaxe Saftige Bratwurst');

    const result = applyFoodRescuePass(
      { offers: [], nextWeekOffers: [], filteredOffers: [rescuedSource] },
      { now: NOW },
    );

    const rescued = result.offers[0] as Offer & {
      foodFlag?: string;
      canonicalCategory?: { isNonFood?: boolean; main?: string; reasons?: unknown[] };
    };
    expect(rescued.foodFlag).toBe('food');
    expect(rescued.tags).toContain(FOOD_RESCUE_TAG);
    expect(rescued.tags).not.toContain('nonfood');
    expect(rescued.canonicalCategory?.isNonFood).toBe(false);
    expect(rescued.canonicalCategory?.reasons).toContain(FOOD_RESCUE_REASON);
    // Kein Ping-Pong: der finale Non-Food-Gate darf das gerettete Angebot nie
    // wieder nach filtered verschieben.
    expect(isStrongNonFoodLeak(rescued)).toBe(false);
  });

  it('stempelt unsichere Faelle reviewNeeded statt sie zu verschieben', () => {
    const unsure = modelNonFood('rev1', 'Mystery Artikel 3000');

    const result = applyFoodRescuePass(
      { offers: [], nextWeekOffers: [], filteredOffers: [unsure] },
      { now: NOW },
    );

    expect(result.offers).toHaveLength(0);
    const flagged = result.filteredOffers[0] as Offer & {
      reviewNeeded?: boolean;
      reviewReason?: string;
    };
    expect(flagged.reviewNeeded).toBe(true);
    expect(flagged.reviewReason).toBe(FOOD_RESCUE_REVIEW_REASON);
    expect(result.reviewNeededCount).toBe(1);
    expect(result.reviewNeededExamples).toContain('Mystery Artikel 3000');
  });

  it('ueberschreibt einen vorhandenen reviewReason nicht', () => {
    const alreadyFlagged = modelNonFood('rev2', 'Mystery Artikel 3000', {
      reviewNeeded: true,
      reviewReason: 'nonfood_gate_conflict',
    } as Partial<Offer>);

    const result = applyFoodRescuePass(
      { offers: [], nextWeekOffers: [], filteredOffers: [alreadyFlagged] },
      { now: NOW },
    );

    const kept = result.filteredOffers[0] as Offer & { reviewReason?: string };
    expect(kept.reviewReason).toBe('nonfood_gate_conflict');
    expect(result.reviewNeededCount).toBe(1);
  });

  it('dedupliziert nach id, wenn das Angebot bereits sichtbar ist', () => {
    const alreadyLive = offer({ id: 'dup1', name: 'Surimi Sticks' });
    const filteredCopy = modelNonFood('dup1', 'Surimi Sticks');

    const result = applyFoodRescuePass(
      { offers: [alreadyLive], nextWeekOffers: [], filteredOffers: [filteredCopy] },
      { now: NOW },
    );

    expect(result.offers.map((o) => o.id)).toEqual(['dup1']);
    expect(result.filteredOffers).toHaveLength(0);
  });

  it('rescuedExamples enthält nie Non-Food- oder Fragmentnamen', () => {
    const result = applyFoodRescuePass(
      {
        offers: [],
        nextWeekOffers: [],
        filteredOffers: [
          modelNonFood('ex1', 'Surimi Sticks'),
          modelNonFood('ex2', 'VISS Scheuermilch'),
          modelNonFood('ex3', 'individuell kombinierbar kernlos', {
            sourceCategoryRaw: 'Obst & Gemüse',
          } as Partial<Offer>),
          modelNonFood('ex4', 'l-Dose'),
        ],
      },
      { now: NOW },
    );

    expect(result.rescuedExamples).toEqual(['Surimi Sticks']);
    expect(result.offers.map((o) => o.id)).toEqual(['ex1']);
    expect(result.filteredOffers.map((o) => o.id).sort()).toEqual(['ex2', 'ex3', 'ex4']);
  });

  it('ist idempotent: ein zweiter Lauf verschiebt nichts mehr', () => {
    const first = applyFoodRescuePass(
      {
        offers: [],
        nextWeekOffers: [],
        filteredOffers: [
          modelNonFood('i1', 'Surimi Sticks'),
          modelNonFood('i2', 'Spülmittel Ultra'),
          modelNonFood('i3', 'Mystery Artikel 3000'),
          modelNonFood('i4', 'VISS Scheuermilch'),
          modelNonFood('i5', 'l-Dose'),
        ],
      },
      { now: NOW },
    );

    const second = applyFoodRescuePass(
      {
        offers: first.offers,
        nextWeekOffers: first.nextWeekOffers,
        filteredOffers: first.filteredOffers,
      },
      { now: NOW },
    );

    expect(second.rescuedCount).toBe(0);
    expect(second.offers).toHaveLength(first.offers.length);
    expect(second.filteredOffers).toHaveLength(first.filteredOffers.length);
  });

  it('mutiert die Eingabe-Buckets nicht', () => {
    const filtered = [modelNonFood('p1', 'Surimi Sticks')];
    const buckets = { offers: [] as Offer[], nextWeekOffers: [] as Offer[], filteredOffers: filtered };

    applyFoodRescuePass(buckets, { now: NOW });

    expect(buckets.offers).toHaveLength(0);
    expect(buckets.filteredOffers).toHaveLength(1);
    expect((buckets.filteredOffers[0] as Offer & { foodFlag?: string }).foodFlag).toBe('nonfood');
  });
});

describe('partitionFilteredOffersForCompleteness', () => {
  it('teilt den Filtered-Bucket exakt nach dem Rescue-Verdict (Report == Rescue)', () => {
    const filtered = [
      // rescue-wuerdig (starkes Food-Signal ohne Non-Food-Beleg) => Verdacht.
      modelNonFood('s1', 'Bratmaxe Saftige Bratwurst'),
      // keep (Regel-Non-Food: Drogerie-/Haushaltssignal) => regelbestaetigt.
      modelNonFood('n1', 'Spuelmittel Ultra'),
      // review (kein Beleg in beide Richtungen) => unconfirmed. Real beobachtete
      // Kaufland-Promo-Faelle (reine Reproduktions-Fixtures).
      modelNonFood('u1', 'COUNTRYSIDE® Grill-Holzkohle'),
      // „Tankini" ist jetzt generisches Badebekleidungs-Vokabular ⇒ Regel-Non-Food
      // (keep), kein offener Review-Fall mehr.
      modelNonFood('n2', 'Kinder-Tankini »Stitch«'),
    ];

    const partition = partitionFilteredOffersForCompleteness(filtered);

    expect(partition.suspectNames).toEqual(['Bratmaxe Saftige Bratwurst']);
    expect(partition.ruleNonFoodNames).toEqual(['Spuelmittel Ultra', 'Kinder-Tankini »Stitch«']);
    expect(partition.unconfirmedNames).toEqual(['COUNTRYSIDE® Grill-Holzkohle']);
  });
});

describe('Gewürze/Kräuter & Convenience-Obst aus Filtered retten (Problem B)', () => {
  it('rettet getrocknete Küchenkräuter, Gewürze und verzehrfertiges Obst', () => {
    for (const name of [
      'Kräuter und Gewürze im Nachfüllbeutel Paprika edelsüß',
      'Basilikum gerebelt',
      'Dillspitzen',
      'Pfeffer schwarz gemahlen',
      'Rosmarin geschnitten',
      'Obst im Becher',
    ]) {
      expect(classifyFilteredOfferForRescue(modelNonFood(`r_${name}`, name)), name).toBe('rescue');
    }
  });

  it('behält Gegenbeispiele gefiltert: elektr. Gewürzmühle, lebende Kräuterpflanze', () => {
    for (const name of ['Elektrische Salz- oder Pfeffermühle', 'Kräuterpflanze im Topf', 'Pfefferspray Abwehr']) {
      expect(classifyFilteredOfferForRescue(modelNonFood(`k_${name}`, name)), name).toBe('keep');
    }
  });

  it('verschiebt geretteten Gewürz-Nachfüllbeutel zurück in die sichtbaren Buckets', () => {
    const buckets = applyFoodRescuePass(
      {
        offers: [],
        nextWeekOffers: [],
        filteredOffers: [modelNonFood('spice1', 'Basilikum gerebelt')],
      },
      { now: NOW },
    );
    expect(buckets.rescuedCount).toBe(1);
    expect(buckets.offers.map((o) => o.id)).toContain('spice1');
    expect((buckets.offers[0] as Offer & { foodFlag?: string }).foodFlag).toBe('food');
    expect(buckets.offers[0].tags).toContain(FOOD_RESCUE_TAG);
  });
});
