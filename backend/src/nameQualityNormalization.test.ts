import { describe, expect, it } from 'vitest';
import type { Offer } from '../../src/types/models';
import {
  isNameQualityFragment,
  isNameQualityNormalized,
  markNameQualityFragment,
  NAME_QUALITY_QUARANTINE_REASON,
  NAME_QUALITY_REVIEW_REASON,
  NAME_QUALITY_TAG,
} from './nameQualityQuarantine';
import {
  applyFragmentQuarantineGate,
  quarantineFragmentOffers,
} from './offersScanV2';
import { classifyFoodDecision, isFragmentOrSectionHeader } from './foodDecision';
import { summarizeReviewQueue } from './reviewReductionClasses';

// Strukturelle Korrektur der Name-Quality-Quarantäne: der Report erkennt „kernarm"
// korrekt als name_quality, der PERSISTIERTE Offer blieb aber unsauber (Non-Food-
// canonicalCategory, generischer reviewReason, kein name_quality-Tag). Konkrete
// Namen sind reine Reproduktions-Fixtures — KEINE Allow-/Blocklist im Produktivcode.

function offer(name: string, extra: Partial<Offer> & Record<string, unknown> = {}): Offer {
  return {
    id: name,
    name,
    normalizedName: name.toLowerCase(),
    storeChain: 'REWE',
    category: 'Getränke Alkoholfrei',
    price: 1.11,
    currency: 'EUR',
    unit: '1-kg',
    sourceUrl: 'https://example.com',
    tags: [],
    createdAt: '2026-06-14T00:00:00.000Z',
    ...extra,
  } as Offer;
}

/** Die exakte persistierte REWE-„kernarm"-Repro-Shape aus dem Phase-2-Snapshot
 *  vom 2026-06-16: liegt bereits im filtered-Bucket, sieht aber wie Non-Food aus. */
function kernarmPersisted(): Offer {
  return offer('kernarm', {
    id: 'rewe_browser_1fxs7x',
    foodFlag: 'unsure',
    reviewNeeded: true,
    reviewReason: 'unknown_sub,low_confidence',
    sourceCategoryRaw: 'Angebote im Markt',
    tags: ['rewe', 'browser-import'],
    canonicalCategory: {
      main: 'Non-Food',
      sub: 'unknown',
      isNonFood: true,
      confidence: 0.3,
      reasons: [
        "Product name 'kernarm' does not indicate a food item.",
        'cache:hit',
      ],
    },
  });
}

interface PersistedOffer extends Offer {
  foodFlag?: string;
  reviewNeeded?: boolean;
  reviewReason?: string;
  canonicalCategory?: { main?: unknown; sub?: unknown; isNonFood?: unknown; reasons?: unknown };
}

describe('Name-Quality-Normalisierung — kernarm im echten Finalisierungspfad', () => {
  it('markNameQualityFragment normalisiert die persistierten Felder', () => {
    const out = markNameQualityFragment(kernarmPersisted()) as PersistedOffer;
    expect(out.tags).toContain(NAME_QUALITY_TAG);
    expect(out.reviewNeeded).toBe(true);
    expect(String(out.reviewReason).split(',')).toContain(NAME_QUALITY_REVIEW_REASON);
    // bestehende Gründe bleiben erhalten
    expect(String(out.reviewReason)).toContain('unknown_sub');
    expect(out.foodFlag).toBe('unsure');
    expect(out.canonicalCategory?.isNonFood).not.toBe(true);
    expect(out.canonicalCategory?.main).not.toBe('Non-Food');
    expect(out.canonicalCategory?.reasons).toContain(NAME_QUALITY_QUARANTINE_REASON);
  });

  it('wird im saveSnapshot-Gate (applyFragmentQuarantineGate) auch IM Filter normalisiert', () => {
    const result = applyFragmentQuarantineGate({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [kernarmPersisted()],
    });
    const persisted = result.filteredOffers.find((o) => o.id === 'rewe_browser_1fxs7x') as
      | PersistedOffer
      | undefined;
    expect(persisted).toBeDefined();
    expect(persisted?.tags).toContain(NAME_QUALITY_TAG);
    expect(String(persisted?.reviewReason).split(',')).toContain(NAME_QUALITY_REVIEW_REASON);
    expect(persisted?.canonicalCategory?.isNonFood).not.toBe(true);
    expect(persisted?.canonicalCategory?.main).not.toBe('Non-Food');
    expect(result.normalizedCount).toBe(1);
  });

  it('das normalisierte Ergebnis wird weiter als Fragment erkannt', () => {
    const out = markNameQualityFragment(kernarmPersisted());
    expect(isFragmentOrSectionHeader(out)).toBe(true);
    expect(isNameQualityFragment(out)).toBe(true);
    expect(isNameQualityNormalized(out)).toBe(true);
  });

  it('ist idempotent: ein zweiter Pass dupliziert/bewegt nichts', () => {
    const once = applyFragmentQuarantineGate({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [kernarmPersisted()],
    });
    const twice = applyFragmentQuarantineGate({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: once.filteredOffers,
    });
    expect(twice.normalizedCount).toBe(0);
    const a = once.filteredOffers[0] as PersistedOffer;
    const b = twice.filteredOffers[0] as PersistedOffer;
    expect(b.tags?.filter((t) => t === NAME_QUALITY_TAG)).toHaveLength(1);
    expect(String(a.reviewReason)).toBe(String(b.reviewReason));
    expect((b.canonicalCategory?.reasons as string[]).filter((r) => r === NAME_QUALITY_QUARANTINE_REASON)).toHaveLength(1);
  });

  it('der move-Pfad (quarantineFragmentOffers) liefert dieselbe normalisierte Shape', () => {
    const { quarantined } = quarantineFragmentOffers([kernarmPersisted()]);
    const q = quarantined[0] as PersistedOffer;
    expect(q.tags).toContain(NAME_QUALITY_TAG);
    expect(String(q.reviewReason).split(',')).toContain(NAME_QUALITY_REVIEW_REASON);
    expect(q.canonicalCategory?.isNonFood).not.toBe(true);
    expect(q.foodFlag).toBe('unsure');
  });

  it('Report reviewQueue.name_quality erkennt das normalisierte Item', () => {
    const normalized = markNameQualityFragment(kernarmPersisted());
    const summary = summarizeReviewQueue([normalized]);
    expect(summary.nameQualityReview.count).toBe(1);
    expect(summary.foodLikeReview.count).toBe(0);
    expect(summary.nonFoodLikeReview.count).toBe(0);
    expect(summary.cacheConflictReview.count).toBe(0);
  });
});

describe('Name-Quality-Normalisierung — Regressionen / Trennschärfe', () => {
  it('echtes Non-Food mit kurzem Namen bleibt Non-Food, nicht name_quality', () => {
    const livarno = offer('Livarno', { canonicalCategory: { main: 'Non-Food', isNonFood: true } });
    expect(isNameQualityFragment(livarno)).toBe(false);
    expect(classifyFoodDecision(livarno)).toBe('confirmed_non_food');
    const result = applyFragmentQuarantineGate({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [livarno],
    });
    const out = result.filteredOffers[0] as PersistedOffer;
    expect(out.tags ?? []).not.toContain(NAME_QUALITY_TAG);
    expect(result.normalizedCount).toBe(0);
  });

  it('Spritzring bleibt Cache-/Food-Review, nicht name_quality', () => {
    const spritzring = offer('Spritzring', {
      foodFlag: 'food',
      unit: 'stück',
      sourceCategoryRaw: 'Filialangebote',
      canonicalCategory: {
        main: 'Non-Food',
        isNonFood: true,
        confidence: 0.8,
        reasons: ['Küchenutensil', 'cache:hit'],
      },
    });
    expect(isNameQualityFragment(spritzring)).toBe(false);
    const result = applyFragmentQuarantineGate({
      offers: [],
      nextWeekOffers: [],
      filteredOffers: [spritzring],
    });
    const out = result.filteredOffers[0] as PersistedOffer;
    expect(out.tags ?? []).not.toContain(NAME_QUALITY_TAG);
  });

  it('kurzer echter Food-Name (Cola) bleibt Food, nie normalisiert', () => {
    const cola = offer('Cola', {});
    expect(isNameQualityFragment(cola)).toBe(false);
    const result = applyFragmentQuarantineGate({
      offers: [cola],
      nextWeekOffers: [],
      filteredOffers: [],
    });
    expect(result.offers.map((o) => o.name)).toContain('Cola');
  });

  it('editorial gesperrtes Angebot wird nie überschrieben', () => {
    const locked = {
      ...kernarmPersisted(),
      manualReviewed: true,
    } as Offer & { manualReviewed: boolean };
    const out = markNameQualityFragment(locked) as PersistedOffer;
    // Lock-Guard: unverändert (kein name_quality-Tag erzwungen, Non-Food-Flag bleibt
    // wie es war — eine menschliche Entscheidung wird respektiert).
    expect(out.tags ?? []).not.toContain(NAME_QUALITY_TAG);
    expect(out.canonicalCategory?.isNonFood).toBe(true);
  });
});
