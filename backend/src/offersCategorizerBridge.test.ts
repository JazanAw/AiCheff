import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  applyTrustedSourceCategory,
  cleanupStaleCategorizerRuns,
  parseOllamaRunDiagnostics,
  repairCanonicalAlcoholConflict,
  repairCanonicalVeganMeatConflict,
  rescueStrongFoodOffers,
  PipelineCancelledError,
  repairStrongNonFoodOffers,
  runOffersCategorizerPipeline,
} from './offersCategorizerBridge';
import { mapCanonicalToSimpleCategory } from '../../src/utils/offerCategory';

describe('applyTrustedSourceCategory — Quellenpriorität repariert die finale Kategorie (P3)', () => {
  type CatOffer = Offer & {
    sourceCategoryRaw?: string;
    canonicalCategory?: { main?: string; isNonFood?: boolean; confidence?: number; reasons?: string[] };
  };
  function catOffer(name: string, category: string, extra: Partial<CatOffer> = {}): CatOffer {
    return { ...makeOffer(name), name, category, ...extra } as CatOffer;
  }

  it('Iglo Tagliatelle Pilzpfanne (Quelle Tiefkühl) bleibt Tiefkühl, wird nicht Trockenware', () => {
    // Vorzustand = falsche finale Kategorie nach Name/Keyword-Pfad ("Tagliatelle" → Trockenware).
    const offer = catOffer('Iglo Tagliatelle Pilzpfanne', 'Trockenware', {
      sourceCategoryRaw: 'Tiefkühl',
      canonicalCategory: { main: 'Grundnahrungsmittel', isNonFood: false, confidence: 0.9, reasons: [] },
    });
    const result = applyTrustedSourceCategory(offer) as CatOffer;
    expect(result.category).toBe('Tiefkühl');
    expect(result.canonicalCategory?.main).toBe('Tiefkühl');
    expect(result.canonicalCategory?.reasons).toContain('repair:trusted_source_category');
  });

  it('Iglo Pasta Carbonara (Quelle Tiefkühl) bleibt Tiefkühl', () => {
    const offer = catOffer('Iglo Pasta Carbonara', 'Trockenware', { sourceCategoryRaw: 'Tiefkühl' });
    expect((applyTrustedSourceCategory(offer) as CatOffer).category).toBe('Tiefkühl');
  });

  it('Trollinger Qualitätswein (Quelle Wein und Spirituosen) bleibt Alkohol, wird nicht Snacks/Süßes', () => {
    const offer = catOffer('Süss & Fruchtig oder Trollinger Qualitätswein', 'Snacks/Süßes', {
      sourceCategoryRaw: 'Wein und Spirituosen',
    });
    expect((applyTrustedSourceCategory(offer) as CatOffer).category).toBe('Alkohol');
  });

  it('Gerät "Pizzamaker" wird wegen hartem Non-Food-Signal NIE zu Food/Tiefkühl gezogen', () => {
    const offer = catOffer('Pizzamaker', 'Sonstiges', { sourceCategoryRaw: 'Tiefkühl' });
    expect((applyTrustedSourceCategory(offer) as CatOffer).category).toBe('Sonstiges');
  });

  it('"GIN TONIC Damen-Slipper" wird wegen hartem Non-Food-Signal nie zu Alkohol', () => {
    const offer = catOffer('GIN TONIC Damen-Slipper', 'Sonstiges', { sourceCategoryRaw: 'Wein und Spirituosen' });
    expect((applyTrustedSourceCategory(offer) as CatOffer).category).toBe('Sonstiges');
  });

  it('neutrale Quellabteilung erzwingt nichts (Kategorie bleibt unverändert)', () => {
    const offer = catOffer('Markenprodukt', 'Milchprodukte', { sourceCategoryRaw: 'Bonus-Aktionen' });
    expect((applyTrustedSourceCategory(offer) as CatOffer).category).toBe('Milchprodukte');
  });
});

function makeOffer(id: string): Offer {
  return {
    id,
    name: `Testprodukt ${id}`,
    normalizedName: `testprodukt ${id}`,
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
  };
}

describe('parseOllamaRunDiagnostics', () => {
  it('reads ai_classified / ai_timeouts / ai_conflict_rejected / last_* from stats.base', () => {
    const diag = parseOllamaRunDiagnostics({
      base: {
        ai_classified: 180,
        ai_timeouts: 20,
        ai_review_timeout: 18,
        ai_conflict_rejected: 7,
        last_timeout_offer: 'Rinderhack 500g',
        last_ollama_error: 'timed out',
        unique_offers: 200,
      },
    });
    expect(diag).toEqual({
      classifiedByAi: 180,
      timedOut: 20,
      reviewNeededFromTimeout: 18,
      conflictRejected: 7,
      lastTimedOutOfferName: 'Rinderhack 500g',
      lastOllamaError: 'timed out',
    });
  });

  it('defaults to zero/null for older pipeline output (no diagnostics)', () => {
    expect(parseOllamaRunDiagnostics({ base: { unique_offers: 5 } })).toEqual({
      classifiedByAi: 0,
      timedOut: 0,
      reviewNeededFromTimeout: 0,
      conflictRejected: 0,
      lastTimedOutOfferName: null,
      lastOllamaError: null,
    });
    expect(parseOllamaRunDiagnostics(null)).toEqual({
      classifiedByAi: 0,
      timedOut: 0,
      reviewNeededFromTimeout: 0,
      conflictRejected: 0,
      lastTimedOutOfferName: null,
      lastOllamaError: null,
    });
  });

  it('ignores blank strings and non-finite numbers', () => {
    const diag = parseOllamaRunDiagnostics({
      base: { ai_timeouts: 'x', last_timeout_offer: '   ', last_ollama_error: '' },
    });
    expect(diag.timedOut).toBe(0);
    expect(diag.lastTimedOutOfferName).toBeNull();
    expect(diag.lastOllamaError).toBeNull();
  });
});

describe('repairStrongNonFoodOffers (shared Scan 1.0 + 2.0 non-food repair)', () => {
  function withName(id: string, name: string, extra: Record<string, unknown> = {}): Offer {
    return { ...makeOffer(id), name, normalizedName: name.toLowerCase(), ...extra } as Offer;
  }

  it('moves a LIVARNO/Insektenschutz offer from live → filtered and marks it non-food', () => {
    const live = [
      withName('food', 'Bio Vollmilch 1,5%'),
      withName('livarno', 'LIVARNO Elektrischer Insektenvernichter', {
        foodFlag: 'unsure',
        canonicalCategory: { isNonFood: false, reasons: ['repair:sonstiges_nonfood_unverified'] },
      }),
    ];
    const { live: keptLive, filtered, repaired } = repairStrongNonFoodOffers(live, []);

    expect(repaired).toBe(1);
    expect(keptLive.map((o) => o.id)).toEqual(['food']);
    const moved = filtered.find((o) => o.id === 'livarno') as Offer & {
      foodFlag?: string;
      canonicalCategory?: { isNonFood?: boolean; reasons?: string[] };
    };
    expect(moved).toBeDefined();
    expect(moved.foodFlag).toBe('nonfood');
    expect(moved.canonicalCategory?.isNonFood).toBe(true);
    expect(moved.canonicalCategory?.reasons).toContain('repair:strong_nonfood');
  });

  it('does not mutate the input arrays and leaves real food untouched', () => {
    const live = [withName('a', 'Gouda jung 48%'), withName('b', 'Bananen')];
    const result = repairStrongNonFoodOffers(live, []);
    expect(result.repaired).toBe(0);
    expect(result.live).toHaveLength(2);
    expect(live).toHaveLength(2); // input untouched
  });
});

describe('runOffersCategorizerPipeline — cancellation', () => {
  it('rejects with PipelineCancelledError when the signal is already aborted (no Python spawned)', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runOffersCategorizerPipeline([makeOffer('o1')], {
        tryOllama: false,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(PipelineCancelledError);
  });
});

describe('cleanupStaleCategorizerRuns', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    for (const root of tempRoots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeRun(root: string, name: string, ageMs: number): Promise<string> {
    const dir = path.join(root, 'backend', 'data', 'categorizer-runs', name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'marker.txt'), 'x', 'utf8');
    const when = new Date(Date.now() - ageMs);
    await fs.utimes(dir, when, when);
    return dir;
  }

  it('removes only run dirs older than the cutoff, keeps fresh ones', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aichef-runs-'));
    tempRoots.push(root);

    const oldDir = await makeRun(root, 'old-run', 48 * 60 * 60 * 1000); // 48h old
    const freshDir = await makeRun(root, 'fresh-run', 5 * 60 * 1000); // 5 min old

    const removed = await cleanupStaleCategorizerRuns(24 * 60 * 60 * 1000, root); // 24h cutoff

    expect(removed).toContain('old-run');
    expect(removed).not.toContain('fresh-run');
    await expect(fs.stat(oldDir)).rejects.toBeTruthy();
    await expect(fs.stat(freshDir)).resolves.toBeTruthy();
  });

  it('is a no-op for a disabled cutoff (<= 0) and never throws on a missing tree', async () => {
    expect(await cleanupStaleCategorizerRuns(0)).toEqual([]);
    expect(
      await cleanupStaleCategorizerRuns(1000, path.join(os.tmpdir(), 'aichef-nope-xyz')),
    ).toEqual([]);
  });
});

describe('rescueStrongFoodOffers — Modell-Fehlklassifikation per Quellkategorie korrigieren', () => {
  const base = {
    normalizedName: 'x',
    storeChain: 'nahkauf',
    category: 'Sonstiges',
    price: 1.99,
    currency: 'EUR',
    unit: 'Stk',
    sourceUrl: 'https://www.nahkauf.de/angebote-im-markt/',
    tags: ['nahkauf-storyblok', 'national'],
    createdAt: '2026-06-01T00:00:00.000Z',
  };
  const modelNonFood = (name: string, sourceCategoryRaw: string): Offer =>
    ({
      ...base,
      id: `nf_${name}`,
      name,
      sourceCategoryRaw,
      foodFlag: 'nonfood',
      canonicalCategory: { main: 'Non-Food', isNonFood: true, reasons: ['model'] },
    }) as never;

  it('holt Kaffee-Pads/Wurst mit Food-Quellkategorie zurück in den Live-Bucket', () => {
    const filtered = [
      modelNonFood('Jacobs Crema Pads', 'Frühstück'),
      modelNonFood('Meica Bratmaxe', 'Frische & Convenience'),
      modelNonFood('Rexona Deospray', 'Drogerie'),
      modelNonFood('Fit Spülmittel', 'Haushalt'),
    ];
    const result = rescueStrongFoodOffers([], filtered);
    expect(result.rescued).toBe(2);
    expect(result.live.map((offer) => offer.name).sort()).toEqual([
      'Jacobs Crema Pads',
      'Meica Bratmaxe',
    ]);
    // Drogerie/Haushalt bleibt gefiltert.
    expect(result.filtered.map((offer) => offer.name).sort()).toEqual([
      'Fit Spülmittel',
      'Rexona Deospray',
    ]);
    // Das Modell-Verdikt wird nachvollziehbar überschrieben.
    for (const offer of result.live) {
      const o = offer as Offer & { foodFlag?: string; canonicalCategory?: { isNonFood?: boolean; main?: string; reasons?: string[] } };
      expect(o.foodFlag).toBe('food');
      expect(o.canonicalCategory?.isNonFood).toBe(false);
      expect(o.canonicalCategory?.main).toBeUndefined();
      expect(o.canonicalCategory?.reasons).toContain('repair:food_source_category');
    }
  });

  it('fasst regulär gefilterte Angebote ohne Modell-Nonfood-Verdikt nicht an', () => {
    const strictFiltered = {
      ...base,
      id: 'sf_1',
      name: 'Toilettenpapier',
      sourceCategoryRaw: 'Frische & Convenience', // absurde Quellkategorie —
      // ohne Modell-Nonfood-Flag wird trotzdem nichts verschoben (der Rescue
      // korrigiert NUR Modell-Verdikte, nie den Regel-Filter).
    } as never;
    const result = rescueStrongFoodOffers([], [strictFiltered]);
    expect(result.rescued).toBe(0);
    expect(result.filtered).toHaveLength(1);
  });
});

describe('repairCanonicalAlcoholConflict — Grappa ist nicht alkoholfrei', () => {
  const mk = (name: string, main: string) =>
    ({
      id: 'x',
      name,
      normalizedName: name.toLowerCase(),
      storeChain: 'Kaufland',
      category: 'Alkohol',
      price: 9.99,
      currency: 'EUR',
      unit: 'Stk',
      sourceUrl: 'https://filiale.kaufland.de/',
      tags: [],
      createdAt: '2026-06-01T00:00:00.000Z',
      canonicalCategory: { main, isNonFood: false, reasons: ['model'] },
    }) as never;

  it('korrigiert "Getränke alkoholfrei" auf "Alkohol", wenn der Name eindeutig Alkohol ist', () => {
    const repaired = repairCanonicalAlcoholConflict(mk('CELLINI Grappa Oro oder Cru', 'Getränke alkoholfrei')) as {
      canonicalCategory?: { main?: string; reasons?: string[] };
    };
    expect(repaired.canonicalCategory?.main).toBe('Alkohol');
    expect(repaired.canonicalCategory?.reasons).toContain('repair:alcohol_conflict');
  });

  it('laesst echte alkoholfreie Getränke und korrekte Alkohol-Verdikte unangetastet', () => {
    const water = repairCanonicalAlcoholConflict(mk('Mineralwasser Classic', 'Getränke alkoholfrei')) as {
      canonicalCategory?: { main?: string };
    };
    expect(water.canonicalCategory?.main).toBe('Getränke alkoholfrei');
    const correct = repairCanonicalAlcoholConflict(mk('CELLINI Grappa Oro', 'Alkohol')) as {
      canonicalCategory?: { main?: string; reasons?: string[] };
    };
    expect(correct.canonicalCategory?.main).toBe('Alkohol');
    expect(correct.canonicalCategory?.reasons).not.toContain('repair:alcohol_conflict');
  });
});

describe('repairCanonicalVeganMeatConflict — vegane Wurst ist kein Fleisch (P3)', () => {
  const mk = (name: string, main: string) =>
    ({
      id: 'x',
      name,
      normalizedName: name.toLowerCase(),
      storeChain: 'REWE',
      category: 'Sonstiges',
      price: 2.99,
      currency: 'EUR',
      unit: 'Stk',
      sourceUrl: 'https://www.rewe.de/',
      tags: [],
      createdAt: '2026-06-01T00:00:00.000Z',
      canonicalCategory: { main, sub: 'Wurst', isNonFood: false, confidence: 0.9, reasons: ['model'] },
    }) as never;

  it('verschiebt vegane Fleisch-/Fisch-Treffer in den Pflanzen-Bucket + Review', () => {
    const repaired = repairCanonicalVeganMeatConflict(
      mk('Rügenwalder Vegane Mühlen Rostbratwürstchen', 'Fleisch & Wurst'),
    ) as {
      reviewNeeded?: boolean;
      reviewReason?: string;
      canonicalCategory?: { main?: string; sub?: string; reasons?: string[] };
    };
    expect(repaired.canonicalCategory?.main).toBe('Feinkost & Kühlung');
    expect(repaired.canonicalCategory?.sub).toBe('Tofu & Veggie');
    expect(repaired.canonicalCategory?.reasons).toContain('repair:vegan_meat_conflict');
    expect(repaired.reviewNeeded).toBe(true);
    expect(repaired.reviewReason).toContain('vegan_meat_conflict');
    expect(mapCanonicalToSimpleCategory(repaired.canonicalCategory as never)).toBe('Milchalternativen');

    const fish = repairCanonicalVeganMeatConflict(
      mk('Veganer Räucherlachs', 'Fisch & Meeresfrüchte'),
    ) as { canonicalCategory?: { main?: string } };
    expect(fish.canonicalCategory?.main).toBe('Feinkost & Kühlung');
  });

  it('lässt echtes Fleisch/Fisch unangetastet (kein vegan-Signal)', () => {
    const meat = repairCanonicalVeganMeatConflict(mk('Herta Saftige Fleischwurst', 'Fleisch & Wurst')) as {
      reviewNeeded?: boolean;
      canonicalCategory?: { main?: string; reasons?: string[] };
    };
    expect(meat.canonicalCategory?.main).toBe('Fleisch & Wurst');
    expect(meat.canonicalCategory?.reasons).not.toContain('repair:vegan_meat_conflict');
    expect(meat.reviewNeeded).toBeUndefined();
  });
});

// Unmögliche (main, sub)-Paare aus dem Lauf 2026-08-17. Python beendet
// apply_auto_repair mit einer Gültigkeitsprüfung (sub muss zur main gehören);
// applyTrustedSourceCategory läuft DANACH, hat die Taxonomie nicht und
// überschrieb bisher nur die main. Ergebnis waren Paare, die es in der
// Taxonomie nicht gibt: Tiefkühl/Milch, Tiefkühl/Obst, Tiefkühl/Käse.
// Produktnamen sind Reproduktions-Fixtures aus dem echten Lauf.
describe('applyTrustedSourceCategory — erzeugt keine unmöglichen main/sub-Paare', () => {
  type CatOffer = Offer & {
    sourceCategoryRaw?: string;
    canonicalCategory?: {
      main?: string;
      sub?: string;
      isNonFood?: boolean;
      confidence?: number;
      reasons?: string[];
    };
  };

  function offer(name: string, category: string, extra: Partial<CatOffer>): CatOffer {
    return { ...makeOffer(name), name, category, ...extra } as CatOffer;
  }

  it.each([
    ['ja! Reine Buttermilch', 'Milchprodukte & Eier', 'Milch'],
    ['Zitronen', 'Obst & Gemüse', 'Obst'],
    ['K-CLASSIC Back-Camembert', 'Milchprodukte & Eier', 'Käse'],
  ])(
    'wechselt die main (%s), verwirft die für die alte main abgeleitete sub',
    (name, priorMain, priorSub) => {
      const result = applyTrustedSourceCategory(
        offer(name, 'Milchprodukte', {
          sourceCategoryRaw: 'Tiefkühl',
          canonicalCategory: { main: priorMain, sub: priorSub, isNonFood: false, confidence: 0.9, reasons: [] },
        }),
      ) as CatOffer;

      expect(result.canonicalCategory?.main).toBe('Tiefkühl');
      expect(result.canonicalCategory?.sub).toBe('unknown');
    },
  );

  it('behält die sub, wenn die main unverändert bleibt', () => {
    const result = applyTrustedSourceCategory(
      offer('Iglo Rahm-Spinat', 'Trockenware', {
        sourceCategoryRaw: 'Tiefkühl',
        canonicalCategory: { main: 'Tiefkühl', sub: 'Gemüse', isNonFood: false, confidence: 0.9, reasons: [] },
      }),
    ) as CatOffer;

    expect(result.canonicalCategory?.main).toBe('Tiefkühl');
    expect(result.canonicalCategory?.sub).toBe('Gemüse');
  });

  // Die gemischte Abteilung darf gar nicht erst greifen — sonst wurden Cola,
  // Mineralwasser und Energy Drinks mit Konfidenz 0.95 zu Alkohol.
  it.each([
    ['COCA-COLA Original oder Zero', 'Softdrinks'],
    ['VILSA Mineralwasser', 'Wasser'],
    ['ROCKSTAR Mocktail Energy Drink', 'Energy'],
  ])('%s bleibt in "Getränke, Spirituosen" unangetastet', (name, sub) => {
    const input = offer(name, 'Getränke Alkoholfrei', {
      sourceCategoryRaw: 'Getränke, Spirituosen',
      canonicalCategory: {
        main: 'Getränke alkoholfrei',
        sub,
        isNonFood: false,
        confidence: 0.9,
        reasons: [],
      },
    });
    const result = applyTrustedSourceCategory(input) as CatOffer;

    expect(result.canonicalCategory?.main).toBe('Getränke alkoholfrei');
    expect(result.canonicalCategory?.sub).toBe(sub);
    expect(result.category).toBe('Getränke Alkoholfrei');
  });
});
