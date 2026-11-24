import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  PRODUCT_ANALYSIS_FINGERPRINT_PREFIX,
  PRODUCT_ANALYSIS_RULES_VERSION,
  PRODUCT_INTELLIGENCE_VERSION,
  applyProductAnalysis,
  buildProductAnalysisIndex,
  classifyReuse,
  countUncertain,
  dedupeByProductKey,
  evaluateOffer,
  isLockedOrManual,
  planIncrementalScan,
  productKeyForOffer,
  reuseProductAnalysis,
  selectAiCandidates,
  splitFoodAndNonFood,
  stampAiMeta,
  stampAnalysisMeta,
  wasAiClassified,
} from './offerProductIntelligence';

/** A current (sf5/pa-v6) ProductAnalysisV2 stub carrying just the Python
 *  `sourceFingerprint` + rules version — the only thing reuse may trust (P4). */
function pa(fingerprint: string): Record<string, unknown> {
  return { productAnalysis: { sourceFingerprint: fingerprint, rulesVersion: PRODUCT_ANALYSIS_RULES_VERSION } };
}
const FP_A = 'sf5:aaaaaaaaaaaaaaaa';
const FP_B = 'sf5:bbbbbbbbbbbbbbbb';

// Read dynamic AI fields (canonicalCategory/nutrition/aiMeta…) that ride along on
// an Offer but aren't part of the base type.
const rec = (o: unknown): Record<string, unknown> => o as Record<string, unknown>;

// Minimal Offer factory; extra AI fields are layered on per test via `over`.
function offer(over: Partial<Offer> & Record<string, unknown> = {}): Offer {
  return {
    id: 'id-' + Math.random().toString(36).slice(2),
    name: 'Ananas',
    normalizedName: 'ananas',
    storeChain: 'ALDI NORD',
    category: 'Obst/Gemüse',
    price: 1.79,
    currency: 'EUR',
    unit: 'stück',
    validityStart: '2026-06-01T00:00:00.000Z',
    validityEnd: '2026-06-06T23:59:59.999Z',
    sourceUrl: 'https://example.test',
    tags: [],
    createdAt: '2026-05-31T00:00:00.000Z',
    ...over,
  } as Offer;
}

/** A fully-analysed, confident, current offer (an up-to-date donor). Trägt wie
 *  jedes real von aichef_offers verarbeitete Angebot auch die ProductAnalysisV2
 *  (Python schreibt sie unconditional) — ohne sie ist ein Angebot Kandidat. */
function analyzed(over: Partial<Offer> & Record<string, unknown> = {}): Offer {
  return offer({
    canonicalCategory: { main: 'Obst & Gemüse', sub: 'Obst', confidence: 0.98, isNonFood: false },
    nutrition: { source: 'none', per_100g: {}, confidence: 0 },
    allergens: { source: 'none', contains: [], confidence: 0.2 },
    dietFlags: { vegan: null, vegetarian: null, confidence: 0 },
    ...pa(FP_A),
    reviewNeeded: false,
    ...over,
  });
}

describe('productKeyForOffer', () => {
  it('is identical for the same product in different stores / prices / weeks', () => {
    const a = offer({ storeChain: 'ALDI NORD', price: 1.79, validityStart: 'w1' });
    const b = offer({ storeChain: 'REWE', price: 2.49, validityStart: 'w2' });
    expect(productKeyForOffer(a)).toBe(productKeyForOffer(b));
  });

  it('differs for different products', () => {
    expect(productKeyForOffer(offer({ name: 'Ananas', normalizedName: 'ananas' }))).not.toBe(
      productKeyForOffer(offer({ name: 'Banane', normalizedName: 'banane' })),
    );
  });

  it('separates products by brand and size', () => {
    const k1 = productKeyForOffer(offer({ brand: 'Müller', unit: '500 g' }));
    const k2 = productKeyForOffer(offer({ brand: 'Müller', unit: '1 kg' }));
    const k3 = productKeyForOffer(offer({ brand: 'Andechser', unit: '500 g' }));
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it('uses the barcode alone when present (most stable, cross-store)', () => {
    const a = offer({ name: 'X', normalizedName: 'x', barcode: '4012345678901' } as Record<string, unknown>);
    const b = offer({ name: 'Y', normalizedName: 'y', brand: 'other', barcode: '4012345678901' } as Record<string, unknown>);
    expect(productKeyForOffer(a)).toBe('bc:4012345678901');
    expect(productKeyForOffer(a)).toBe(productKeyForOffer(b));
  });

  it('collapses diacritics so Müller == Mueller-form', () => {
    expect(productKeyForOffer(offer({ normalizedName: 'müller milch' }))).toBe(
      productKeyForOffer(offer({ normalizedName: 'muller milch' })),
    );
  });
});

describe('evaluateOffer / selectAiCandidates (missing_or_uncertain)', () => {
  it('marks a fully-analysed confident offer up_to_date', () => {
    expect(evaluateOffer(analyzed()).status).toBe('up_to_date');
  });

  it('flags a never-analysed offer as candidate with missing-field reasons', () => {
    const e = evaluateOffer(offer());
    expect(e.status).toBe('candidate');
    expect(e.reasons).toEqual(
      expect.arrayContaining([
        'nutrition_missing',
        'allergens_missing',
        'diet_missing',
        'product_analysis_missing',
      ]),
    );
  });

  it('flags an offer WITHOUT ProductAnalysisV2 as candidate (Phase-1-/Legacy-Analyse)', () => {
    // Legacy-Zustand: kanonische Kategorie + nutrition/allergens/dietFlags da
    // (alter Voll-Lauf vor ProductAnalysisV2), aber keine productAnalysis — muss
    // nachgezogen werden und darf NIE als up_to_date/Donor durchgehen.
    const legacy = analyzed({ productAnalysis: undefined });
    const e = evaluateOffer(legacy);
    expect(e.status).toBe('candidate');
    expect(e.reasons).toEqual(['product_analysis_missing']);
    expect(buildProductAnalysisIndex([legacy]).size).toBe(0);
  });

  it('flags low category confidence', () => {
    const e = evaluateOffer(analyzed({ canonicalCategory: { main: 'Obst', confidence: 0.3 } }));
    expect(e.reasons).toContain('category_low_confidence');
  });

  it('flags missing/fallback category', () => {
    expect(evaluateOffer(analyzed({ canonicalCategory: undefined, category: 'Sonstiges' })).reasons).toContain(
      'category_missing',
    );
  });

  it('flags review_needed offers', () => {
    expect(evaluateOffer(analyzed({ reviewNeeded: true })).reasons).toContain('review_needed');
  });

  it('flags a stale version stamp', () => {
    const e = evaluateOffer(
      analyzed({ aiMeta: { productKey: productKeyForOffer(offer()), version: 'pi-OLD', analyzedAt: '', source: 'ai' } }),
    );
    expect(e.reasons).toContain('stale_version');
  });

  it('flags a changed product key (invalidated analysis)', () => {
    const e = evaluateOffer(
      analyzed({ aiMeta: { productKey: 'nm:something-else', version: PRODUCT_INTELLIGENCE_VERSION, analyzedAt: '', source: 'ai' } }),
    );
    expect(e.reasons).toContain('product_changed');
  });

  it('treats a current matching stamp as up_to_date', () => {
    const base = offer();
    const stamped = analyzed({
      aiMeta: { productKey: productKeyForOffer(base), version: PRODUCT_INTELLIGENCE_VERSION, analyzedAt: '', source: 'ai' },
    });
    expect(evaluateOffer(stamped).status).toBe('up_to_date');
  });

  it('partitions a mixed set correctly', () => {
    const sel = selectAiCandidates([analyzed(), offer({ id: 'bare' }), offer({ id: 'lk', aiLocked: true } as Record<string, unknown>)]);
    expect(sel.upToDate).toHaveLength(1);
    expect(sel.candidates.map((c) => c.id)).toEqual(['bare']);
    expect(sel.locked.map((c) => c.id)).toEqual(['lk']);
    expect(sel.reasons.get('bare')).toBeTruthy();
  });
});

describe('locked / manual protection', () => {
  it('detects each editorial-lock convention field', () => {
    expect(isLockedOrManual(offer({ aiLocked: true } as Record<string, unknown>))).toBe(true);
    expect(isLockedOrManual(offer({ manualOverride: true } as Record<string, unknown>))).toBe(true);
    expect(isLockedOrManual(offer({ manualReviewed: true } as Record<string, unknown>))).toBe(true);
    expect(isLockedOrManual(offer({ reviewLocked: true } as Record<string, unknown>))).toBe(true);
    expect(isLockedOrManual(offer())).toBe(false);
  });

  it('does NOT treat an availability time-lock as an editorial lock', () => {
    expect(isLockedOrManual(offer({ offerAvailability: { status: 'locked' } } as Record<string, unknown>))).toBe(false);
  });

  it('never selects a locked offer as a candidate (so it is never overwritten)', () => {
    const locked = analyzed({ id: 'lk', aiLocked: true, reviewNeeded: true } as Record<string, unknown>);
    // Even though reviewNeeded would normally make it a candidate, the lock wins.
    expect(evaluateOffer(locked).status).toBe('locked');
    const sel = selectAiCandidates([locked]);
    expect(sel.candidates).toHaveLength(0);
    expect(sel.locked).toHaveLength(1);
  });
});

describe('product-analysis reuse (cross-store / cross-offer)', () => {
  it('copies product fields from a donor while keeping per-offer identity/price/validity', () => {
    const donor = analyzed({ id: 'donor', storeChain: 'ALDI NORD', price: 1.79 });
    const target = offer({ id: 'target', storeChain: 'REWE', price: 2.49, validityStart: 'other-week' });
    const out = applyProductAnalysis(target, donor, { now: 'NOW', model: 'qwen3:14b' });

    // product-level fields copied
    expect(out.category).toBe(donor.category);
    expect(rec(out).canonicalCategory).toEqual(rec(donor).canonicalCategory);
    expect(rec(out).nutrition).toEqual(rec(donor).nutrition);
    // per-offer fields preserved
    expect(out.id).toBe('target');
    expect(out.storeChain).toBe('REWE');
    expect(out.price).toBe(2.49);
    expect(out.validityStart).toBe('other-week');
    // stamped as reuse
    expect(rec(out).aiMeta).toMatchObject({ source: 'reuse', version: PRODUCT_INTELLIGENCE_VERSION });
  });

  it('reuses an existing analysis for a candidate of the same product, model untouched', () => {
    // Both sides carry the SAME current Python fingerprint (computed in the
    // Python step before the model run) — only then is reuse allowed.
    const donor = analyzed({ id: 'donor', ...pa(FP_A) });
    const candidate = offer({ id: 'c', storeChain: 'REWE', price: 9, ...pa(FP_A) });
    const index = buildProductAnalysisIndex([donor]);
    const result = reuseProductAnalysis([candidate], index, { now: 'NOW' });
    expect(result.reused).toHaveLength(1);
    expect(result.stillNeedAi).toHaveLength(0);
    expect(result.reused[0].category).toBe(donor.category);
  });

  it('leaves candidates without a donor for the model', () => {
    const index = buildProductAnalysisIndex([analyzed({ normalizedName: 'ananas', ...pa(FP_A) })]);
    const banana = offer({ name: 'Banane', normalizedName: 'banane' });
    const result = reuseProductAnalysis([banana], index);
    expect(result.reused).toHaveLength(0);
    expect(result.stillNeedAi.map((o) => o.id)).toEqual([banana.id]);
  });

  it('the index only contains confident donors (never uncertain ones)', () => {
    const uncertain = analyzed({ normalizedName: 'apfel', reviewNeeded: true });
    const index = buildProductAnalysisIndex([uncertain]);
    expect(index.size).toBe(0);
  });

  it('picks the highest-confidence donor per product key', () => {
    const low = analyzed({ id: 'low', canonicalCategory: { main: 'Obst', confidence: 0.7 } });
    const high = analyzed({ id: 'high', canonicalCategory: { main: 'Obst', confidence: 0.95 } });
    const index = buildProductAnalysisIndex([low, high]);
    expect(index.get(productKeyForOffer(low))?.id).toBe('high');
  });

  // --- P4: cross-shop reuse needs a verifiable, compatible Python fingerprint ---

  it('reuses only when donor + candidate share the exact same current fingerprint', () => {
    const donor = analyzed({ id: 'donor', barcode: '4012345678901', ...pa(FP_A) });
    const candidate = offer({ id: 'c', barcode: '4012345678901', storeChain: 'REWE', ...pa(FP_A) });
    const index = buildProductAnalysisIndex([donor]);
    const result = reuseProductAnalysis([candidate], index);
    expect(result.reused.map((o) => o.id)).toEqual(['c']);
    expect(result.rejected).toHaveLength(0);
  });

  it('same productKey but DIFFERENT fingerprint (category/vegan-tag/nutrition change) → no reuse', () => {
    // The Python source_fingerprint folds in category, vegan tags and nutrition
    // (proven in tests/test_product_analysis_v2_sources.py); a divergence there
    // yields a different fingerprint here → mismatch, never a copied verdict.
    const donor = analyzed({ id: 'donor', barcode: '4012345678901', ...pa(FP_A) });
    const candidate = offer({ id: 'c', barcode: '4012345678901', storeChain: 'REWE', ...pa(FP_B) });
    const index = buildProductAnalysisIndex([donor]);
    const result = reuseProductAnalysis([candidate], index);
    expect(result.reused).toHaveLength(0);
    expect(result.stillNeedAi.map((o) => o.id)).toEqual(['c']);
    expect(result.rejected.map((r) => r.reason)).toEqual(['fingerprint_mismatch']);
  });

  it('missing candidate fingerprint → no reuse (fingerprint_missing), same key is not enough', () => {
    const donor = analyzed({ id: 'donor', barcode: '4012345678901', ...pa(FP_A) });
    const candidate = offer({ id: 'c', barcode: '4012345678901', storeChain: 'REWE' }); // no productAnalysis
    const index = buildProductAnalysisIndex([donor]);
    const result = reuseProductAnalysis([candidate], index);
    expect(result.reused).toHaveLength(0);
    expect(result.rejected.map((r) => r.reason)).toEqual(['fingerprint_missing']);
  });

  it('stale fingerprint generation (sf1/pa-v2) → no reuse (fingerprint_version_mismatch)', () => {
    const donor = analyzed({ id: 'donor', barcode: '4012345678901', ...pa(FP_A) });
    const candidate = offer({
      id: 'c',
      barcode: '4012345678901',
      storeChain: 'REWE',
      productAnalysis: { sourceFingerprint: 'sf1:aaaaaaaaaaaaaaaa', rulesVersion: 'pa-v2' },
    } as Record<string, unknown>);
    const index = buildProductAnalysisIndex([donor]);
    const result = reuseProductAnalysis([candidate], index);
    expect(result.reused).toHaveLength(0);
    expect(result.rejected.map((r) => r.reason)).toEqual(['fingerprint_version_mismatch']);
  });

  it('the previous generation sf4/pa-v5 is no longer current → version_mismatch', () => {
    // pa-v6/sf5 invalidates the immediately-preceding sf4/pa-v5 generation too.
    const cur = (fp: string) => offer({ ...pa(fp) });
    const prevGen = offer({ productAnalysis: { sourceFingerprint: 'sf4:aaaaaaaaaaaaaaaa', rulesVersion: 'pa-v5' } } as Record<string, unknown>);
    expect(classifyReuse(cur(FP_A), prevGen)).toBe('fingerprint_version_mismatch');
    const index = buildProductAnalysisIndex([analyzed({ id: 'donor', barcode: '4012345678901', ...pa(FP_A) })]);
    const candidate = offer({
      id: 'c',
      barcode: '4012345678901',
      storeChain: 'REWE',
      productAnalysis: { sourceFingerprint: 'sf4:aaaaaaaaaaaaaaaa', rulesVersion: 'pa-v5' },
    } as Record<string, unknown>);
    const result = reuseProductAnalysis([candidate], index);
    expect(result.reused).toHaveLength(0);
    expect(result.rejected.map((r) => r.reason)).toEqual(['fingerprint_version_mismatch']);
  });

  it('classifyReuse distinguishes reuse / missing / mismatch / version_mismatch', () => {
    const cur = (fp: string) => offer({ ...pa(fp) });
    const stale = offer({ productAnalysis: { sourceFingerprint: 'sf1:x', rulesVersion: 'pa-v2' } } as Record<string, unknown>);
    const none = offer();
    expect(classifyReuse(cur(FP_A), cur(FP_A))).toBe('reuse');
    expect(classifyReuse(cur(FP_A), cur(FP_B))).toBe('fingerprint_mismatch');
    expect(classifyReuse(cur(FP_A), none)).toBe('fingerprint_missing');
    expect(classifyReuse(none, cur(FP_A))).toBe('fingerprint_missing');
    expect(classifyReuse(cur(FP_A), stale)).toBe('fingerprint_version_mismatch');
  });

  it('reuse leaves donor and candidate unchanged and is idempotent', () => {
    const donor = analyzed({ id: 'donor', barcode: '4012345678901', ...pa(FP_A) });
    const candidate = offer({ id: 'c', barcode: '4012345678901', storeChain: 'REWE', price: 9, ...pa(FP_A) });
    const donorSnapshot = JSON.stringify(donor);
    const candidateSnapshot = JSON.stringify(candidate);
    const index = buildProductAnalysisIndex([donor]);
    const run1 = reuseProductAnalysis([candidate], index, { now: 'NOW', model: 'qwen3:14b' });
    const run2 = reuseProductAnalysis([candidate], index, { now: 'NOW', model: 'qwen3:14b' });
    // inputs untouched
    expect(JSON.stringify(donor)).toBe(donorSnapshot);
    expect(JSON.stringify(candidate)).toBe(candidateSnapshot);
    // candidate per-offer identity preserved on the reused clone
    expect(run1.reused[0].id).toBe('c');
    expect(run1.reused[0].storeChain).toBe('REWE');
    expect(run1.reused[0].price).toBe(9);
    // repeated run is idempotent
    expect(JSON.stringify(run1.reused[0])).toBe(JSON.stringify(run2.reused[0]));
  });
});

describe('dedupeByProductKey (analyse each product once)', () => {
  it('keeps one representative per product key and lists the rest as followers', () => {
    const a = offer({ id: 'a', storeChain: 'ALDI' });
    const b = offer({ id: 'b', storeChain: 'REWE', price: 9 }); // same product as a
    const c = offer({ id: 'c', name: 'Banane', normalizedName: 'banane' });
    const { representatives, followers } = dedupeByProductKey([a, b, c]);
    expect(representatives.map((o) => o.id).sort()).toEqual(['a', 'c']);
    expect(followers.map((o) => o.id)).toEqual(['b']);
  });
});

describe('forceAll / classic mode is unaffected', () => {
  it('selection does not drop or mutate offers — candidates+upToDate+locked == input', () => {
    const offers = [analyzed(), offer({ id: 'x' }), offer({ id: 'y', aiLocked: true } as Record<string, unknown>)];
    const sel = selectAiCandidates(offers);
    expect(sel.candidates.length + sel.upToDate.length + sel.locked.length).toBe(offers.length);
    // classic "all" mode sends every offer; selection is purely additive metadata.
    const allIds = [...sel.candidates, ...sel.upToDate, ...sel.locked].map((o) => o.id).sort();
    expect(allIds).toEqual(offers.map((o) => o.id).sort());
  });
});

describe('splitFoodAndNonFood + countUncertain', () => {
  it('splits by foodFlag / isNonFood', () => {
    const food = analyzed({ id: 'f', foodFlag: 'food' });
    const nonfood = analyzed({ id: 'n', foodFlag: 'nonfood' });
    const nonfood2 = analyzed({ id: 'n2', canonicalCategory: { main: 'Drogerie', confidence: 0.9, isNonFood: true } });
    const split = splitFoodAndNonFood([food, nonfood, nonfood2]);
    expect(split.food.map((o) => o.id)).toEqual(['f']);
    expect(split.nonFood.map((o) => o.id).sort()).toEqual(['n', 'n2']);
  });

  it('counts offers still uncertain after a run', () => {
    expect(countUncertain([analyzed(), offer({ id: 'bare' }), analyzed({ reviewNeeded: true })])).toBe(2);
  });
});

describe('full incremental pipeline (mirrors computeSelectiveCategorization)', () => {
  it('only one offer per product hits the model; siblings + up-to-date are reused/skipped', () => {
    // Universe: 1 up-to-date Ananas (ALDI), 2 bare Ananas (REWE/Lidl, same product),
    // 1 bare Banane, 1 locked offer. Classic "all" would send all 5 to the model.
    // The Python step stamps the same fingerprint on identical products, so the
    // bare ANANAS siblings carry the donor's fingerprint and may be reused.
    const upToDateAnanas = analyzed({ id: 'ananas-aldi', storeChain: 'ALDI', normalizedName: 'ananas', ...pa(FP_A) });
    const bareAnanasRewe = offer({ id: 'ananas-rewe', storeChain: 'REWE', normalizedName: 'ananas', price: 2.49, ...pa(FP_A) });
    const bareAnanasLidl = offer({ id: 'ananas-lidl', storeChain: 'Lidl', normalizedName: 'ananas', price: 1.99, ...pa(FP_A) });
    const bareBanane = offer({ id: 'banane', normalizedName: 'banane', name: 'Banane' });
    const lockedApfel = analyzed({ id: 'apfel-locked', normalizedName: 'apfel', aiLocked: true } as Record<string, unknown>);
    const universe = [upToDateAnanas, bareAnanasRewe, bareAnanasLidl, bareBanane, lockedApfel];

    // 1) selection
    const sel = selectAiCandidates(universe);
    expect(sel.upToDate.map((o) => o.id)).toEqual(['ananas-aldi']);
    expect(sel.locked.map((o) => o.id)).toEqual(['apfel-locked']);
    expect(sel.candidates.map((o) => o.id).sort()).toEqual(['ananas-lidl', 'ananas-rewe', 'banane']);

    // 2) reuse from existing good donors (ANANAS already analysed at ALDI)
    const existingIndex = buildProductAnalysisIndex([...sel.upToDate, ...sel.locked]);
    const phaseA = reuseProductAnalysis(sel.candidates, existingIndex);
    // both bare Ananas reuse the ALDI analysis → only Banane still needs AI
    expect(phaseA.reused.map((o) => o.id).sort()).toEqual(['ananas-lidl', 'ananas-rewe']);
    expect(phaseA.stillNeedAi.map((o) => o.id)).toEqual(['banane']);

    // 3) dedupe remaining by product key → representatives to the model
    const { representatives, followers } = dedupeByProductKey(phaseA.stillNeedAi);
    expect(representatives.map((o) => o.id)).toEqual(['banane']); // 1 model call
    expect(followers).toHaveLength(0);

    // The model would run on exactly 1 of 5 offers; reused 2, skipped 1, locked 1.
    expect(representatives.length).toBe(1);
    expect(phaseA.reused.length).toBe(2);
    expect(sel.upToDate.length).toBe(1);
    expect(sel.locked.length).toBe(1);
  });
});

describe('planIncrementalScan (dryRun / guard sizing)', () => {
  it('reports candidates, cache-reuse, sentToModel, skipped — no IO', () => {
    const plan = planIncrementalScan([
      analyzed({ id: 'ananas-aldi', normalizedName: 'ananas', ...pa(FP_A) }), // up-to-date donor
      offer({ id: 'ananas-rewe', normalizedName: 'ananas', storeChain: 'REWE', ...pa(FP_A) }), // reuse from donor
      offer({ id: 'banane', normalizedName: 'banane', name: 'Banane' }), // → model
      offer({ id: 'apfel-1', normalizedName: 'apfel', name: 'Apfel', storeChain: 'A' }), // → model (rep)
      offer({ id: 'apfel-2', normalizedName: 'apfel', name: 'Apfel', storeChain: 'B' }), // follower of apfel
      analyzed({ id: 'lk', normalizedName: 'milch', aiLocked: true } as Record<string, unknown>), // locked
    ]);
    expect(plan.candidatesSelected).toBe(4); // 2 ananas-rewe? no: ananas-rewe + banane + apfel-1 + apfel-2
    expect(plan.reusableFromCache).toBe(1); // ananas-rewe reuses the ALDI donor
    expect(plan.sentToModel).toBe(2); // banane + one apfel representative
    expect(plan.skippedUpToDate).toBe(1); // ananas-aldi
    expect(plan.skippedLocked).toBe(1); // milch (locked)
  });

  it('sentToModel is 0 when everything is already up-to-date (fast no-op)', () => {
    const plan = planIncrementalScan([analyzed({ id: 'a' }), analyzed({ id: 'b', normalizedName: 'banane' })]);
    expect(plan.sentToModel).toBe(0);
    expect(plan.candidatesSelected).toBe(0);
  });
});

describe('wasAiClassified / stampAnalysisMeta (honest source)', () => {
  const withReasons = (reasons: string[]) =>
    offer({ canonicalCategory: { main: 'Obst & Gemüse', confidence: 0.9, reasons } });

  it('treats a fresh "llm" reason as AI-classified', () => {
    expect(wasAiClassified(withReasons(['llm', 'cache:miss']))).toBe(true);
  });

  it('treats a versioned "cache:hit" as AI-classified', () => {
    expect(wasAiClassified(withReasons(['cache:hit']))).toBe(true);
  });

  it('treats rule/fallback + conflict-corrected results as NOT AI', () => {
    expect(wasAiClassified(withReasons(['rule:category_food']))).toBe(false);
    expect(wasAiClassified(withReasons(['rule_conflict:cheese', 'conflict_kw:gruenlaender']))).toBe(false);
    expect(wasAiClassified(offer())).toBe(false); // no canonicalCategory at all
  });

  it('stamps source:"ai" only for real model hits, otherwise source:"rule"', () => {
    const ai = stampAnalysisMeta(withReasons(['llm']), { now: 'NOW' });
    const rule = stampAnalysisMeta(withReasons(['rule:category_food']), { now: 'NOW' });
    expect(rec(ai).aiMeta).toMatchObject({ source: 'ai' });
    expect(rec(rule).aiMeta).toMatchObject({ source: 'rule' });
  });

  it('never stamps a conflict-corrected fallback as source:"ai"', () => {
    const corrected = stampAnalysisMeta(withReasons(['rule_conflict:non_food']), { now: 'NOW' });
    expect((rec(corrected).aiMeta as Record<string, unknown>).source).toBe('rule');
  });
});

describe('stampAiMeta', () => {
  it('marks a model-classified offer current so the next run skips it', () => {
    const stamped = stampAiMeta(analyzed(), { now: 'NOW', model: 'qwen3:14b' });
    expect(rec(stamped).aiMeta).toMatchObject({
      source: 'ai',
      version: PRODUCT_INTELLIGENCE_VERSION,
    });
    expect(evaluateOffer(stamped).status).toBe('up_to_date');
  });
});

describe('PRODUCT_ANALYSIS_RULES_VERSION — Drift-Guard gegen die Python-Quelle', () => {
  // Der pa-v7-Bump in product_analysis.py wurde hier nicht mitgezogen — dadurch
  // galt JEDE aktuelle Analyse als fingerprint_version_mismatch und der
  // Cross-Store-Reuse war komplett tot (jeder Kandidat ging ans Modell). Dieser
  // Test liest die Python-Quelle und erzwingt, dass beide Seiten synchron sind.
  it('spiegelt exakt RULES_VERSION + Fingerprint-Präfix aus aichef_offers/product_analysis.py', () => {
    const pyPath = fileURLToPath(
      new URL('../../aichef_offers/product_analysis.py', import.meta.url),
    );
    const source = readFileSync(pyPath, 'utf8');
    const version = source.match(/^RULES_VERSION\s*=\s*"([^"]+)"/m)?.[1];
    expect(version).toBe(PRODUCT_ANALYSIS_RULES_VERSION);
    const prefix = source.match(/return f"(sf\d+):\{digest/)?.[1];
    expect(`${prefix}:`).toBe(PRODUCT_ANALYSIS_FINGERPRINT_PREFIX);
  });

  it('eine aktuelle pa-v7/sf5-Analyse ist reusable (der Drift hatte Reuse abgeschaltet)', () => {
    const donor = analyzed({ id: 'donor', barcode: '4012345678901', ...pa(FP_A) });
    const candidate = offer({ id: 'c', barcode: '4012345678901', storeChain: 'REWE', ...pa(FP_A) });
    expect(classifyReuse(donor, candidate)).toBe('reuse');
  });
});
